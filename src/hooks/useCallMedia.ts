'use client';

// useCallMedia — the SHARED media-acquisition layer for live calls. Generalizes useVoiceTranscribe's
// discipline to camera/mic/screen and is consumed by BOTH the create-modal preview (useCallPreview)
// AND the page-level mesh (useCallMesh), so there are never un-guarded inline media copies (the
// "split-brain" that bit the text-drop mic — an extracted hook left inline copies un-guarded).
//
// THREE guards (the chat-hook's two + a third for the in-flight-unmount leak):
//   1. startingRef double-click guard — a 2nd acquire() while the 1st is still awaiting the
//      permission prompt is ignored (else it orphans the 1st stream + leaks its tracks).
//   2. unmount-cleanup — on unmount, stop every OWNED track (OS camera/mic indicators off) UNLESS
//      ownership was released (releaseOwnership) for the preview→mesh handoff.
//   3. AbortController on the in-flight getUserMedia/getDisplayMedia — if the hook unmounts WHILE
//      the permission prompt is still open, the post-await check stops the just-resolved stream so
//      it doesn't leak with no owner (the leak the text-modal mic STILL has, narrowly out of scope
//      there but closed here).
//
// Camera-OPTIONAL acquire: first try getUserMedia({video,audio}); on a HARDWARE-unavailable error
// (NotReadableError / NotFoundError / OverconstrainedError — NOT a denial) fall back to a second,
// separate atomic getUserMedia({audio}) so a no-camera participant joins AUDIO-ONLY. A genuine denial
// (NotAllowedError / SecurityError) is respected — no audio-only retry (it would fail identically and
// flicker a re-prompt). Each getUserMedia call is still atomic, so there is never a partial stream to
// clean up. `cameraAvailable` tracks whether the FINAL stream has a video track (false on audio-only),
// and drives the Camera-toggle disabled state in the modal.

import { useCallback, useEffect, useRef, useState } from 'react';

export interface UseCallMediaResult {
  stream: MediaStream | null;
  screenStream: MediaStream | null;
  micEnabled: boolean;
  cameraEnabled: boolean;
  /** True only when the acquired stream actually has a video track (audio-only join → false). */
  cameraAvailable: boolean;
  screenSharing: boolean;
  error: string | null;
  /** Acquire camera+mic. No-op on re-entry while another acquire is in flight (startingRef guard). */
  acquire: () => Promise<MediaStream | null>;
  /** Start screen-share via getDisplayMedia (guarded the same way). */
  startScreenShare: () => Promise<MediaStream | null>;
  stopScreenShare: () => void;
  /** Take ownership of an externally-acquired stream (the preview→mesh handoff). */
  adoptStream: (s: MediaStream) => void;
  /** Detach WITHOUT stopping — the unmount cleanup will skip this stream (handoff out to the mesh). */
  releaseOwnership: () => void;
  /** Stop owned tracks AND clear the ref so the next acquire() captures FRESH tracks (full teardown). */
  releaseStream: () => void;
  toggleMic: () => void;
  toggleCamera: () => void;
}

// Classify a getUserMedia failure into an accurate, user-facing message. THE distinction this fixes:
// a hardware-unavailable error (NotReadableError / NotFoundError / OverconstrainedError) must NEVER
// read "access was denied" — the user denied nothing. Only NotAllowedError / SecurityError are real
// denials. This is surfaced ONLY when the audio-only fallback ALSO fails; a successful audio-only join
// shows NO error at all.
function classifyMediaError(err: unknown): string {
  const name = (err as DOMException | undefined)?.name ?? '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Camera or microphone access was denied. Allow access in your browser or system settings and try again.';
    case 'NotReadableError':
      return 'Your camera or microphone is unavailable — it may be in use by another app.';
    case 'NotFoundError':
      return 'No camera or microphone was found. Connect a device and try again.';
    case 'OverconstrainedError':
      return 'Your camera or microphone cannot satisfy the requested settings.';
    default:
      return 'Could not access camera or microphone. Check your devices and try again.';
  }
}

export function useCallMedia(): UseCallMediaResult {
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [screenStream, setScreenStream] = useState<MediaStream | null>(null);
  const [micEnabled, setMicEnabled] = useState(true);
  const [cameraEnabled, setCameraEnabled] = useState(true);
  const [cameraAvailable, setCameraAvailable] = useState(false);
  const [screenSharing, setScreenSharing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Refs mirror the state so the unmount cleanup (a [] effect) reads the always-current streams, and
  // so re-entrant calls see the live ownership without stale closures.
  const streamRef = useRef<MediaStream | null>(null);
  const screenRef = useRef<MediaStream | null>(null);
  const startingRef = useRef(false);
  const startingScreenRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const abortScreenRef = useRef<AbortController | null>(null);

  const acquire = useCallback(async (): Promise<MediaStream | null> => {
    if (startingRef.current) return null; // double-click guard
    if (streamRef.current) return streamRef.current; // already acquired
    startingRef.current = true;
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      let s: MediaStream | null = null;
      try {
        // First choice: camera + mic together. Explicit 720p ideal (NOT the bare `video:true`, which
        // the browser often defaults to ~640×480 → soft/low-quality video once LiveKit encodes it).
        // `ideal` lets the camera pick the closest supported resolution, so this never causes an
        // OverconstrainedError that would spuriously trip the audio-only fallback below.
        s = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
          audio: true,
        });
      } catch (err) {
        const name = (err as DOMException | undefined)?.name ?? '';
        // Genuine PERMISSION denial — respect it (audio-only would fail identically and flicker a
        // re-prompt). Surface the accurate "denied" message; the caller aborts. NOT retried.
        if (name === 'NotAllowedError' || name === 'SecurityError') {
          console.error('Call media denied:', err);
          setError(classifyMediaError(err));
          return null;
        }
        // Hardware-unavailable / not-present / overconstrained (NOT a denial) → audio-only fallback so
        // a no-camera participant can still join. This second request is a SEPARATE atomic getUserMedia,
        // still inside the same double-click guard + AbortController. If unmounted mid-acquire, bail
        // without starting a second permission prompt. If the fallback ALSO fails, the outer catch
        // classifies THAT failure accurately (never blanket-"denied").
        if (ac.signal.aborted) return null;
        s = await navigator.mediaDevices.getUserMedia({ audio: true });
      }
      if (!s) return null;
      if (ac.signal.aborted) {
        // Unmounted/handed-off while the permission prompt was open — release immediately so the
        // camera/mic don't stay grabbed with no owner (the in-flight-unmount leak, guard #3).
        s.getTracks().forEach((t) => t.stop());
        return null;
      }
      streamRef.current = s;
      setStream(s);
      const hasVideo = s.getVideoTracks().length > 0;
      setCameraAvailable(hasVideo);
      setMicEnabled(s.getAudioTracks().some((t) => t.enabled));
      // An audio-only join starts with the camera toggle already OFF (no camera to turn on); a camera
      // join starts reflecting the track's live enabled state.
      setCameraEnabled(hasVideo ? s.getVideoTracks().some((t) => t.enabled) : false);
      setError(null);
      return s;
    } catch (err) {
      // Reached only when the audio-only fallback threw (the combined attempt's denial was handled
      // above with an early return). Classify that failure accurately.
      console.error('Call media acquire failed:', err);
      setError(classifyMediaError(err));
      return null;
    } finally {
      startingRef.current = false;
      abortRef.current = null;
    }
  }, []);

  const stopScreenShare = useCallback(() => {
    const s = screenRef.current;
    if (s) s.getTracks().forEach((t) => t.stop());
    screenRef.current = null;
    setScreenStream(null);
    setScreenSharing(false);
  }, []);

  const startScreenShare = useCallback(async (): Promise<MediaStream | null> => {
    if (startingScreenRef.current || screenRef.current) return null;
    startingScreenRef.current = true;
    const ac = new AbortController();
    abortScreenRef.current = ac;
    try {
      // audio lets the user opt-in to tab/system audio in the picker (YouTube, Spotify, any source).
      // Chrome's picker shows "Share tab audio" / "Share system audio" checkboxes; Firefox's support is
      // more limited. When audio IS captured it arrives as a 2nd track on the stream and useCallMesh
      // wires it as a separate screen-audio transceiver (so the local MIC keeps working).
      //
      // [BUG B] DISABLE the browser's VOICE-processing pipeline (echoCancellation / noiseSuppression /
      // AUTO GAIN CONTROL) for the captured MEDIA audio. Those processors are built for SPEECH and wreck
      // music/media: AGC compresses the dynamic range ("downgraded"/flat, with the level riding up and
      // down — louder one moment, dimmer the next) and noiseSuppression carves out the highs ("boxed-
      // in"). Screen-share audio is MEDIA — it must pass through UNPROCESSED. We pass the constraints at
      // capture AND re-apply them on the track afterward (belt-and-suspenders — some Chrome configs
      // apply AGC/NS to getDisplayMedia audio regardless of the request constraints).
      const s = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      if (ac.signal.aborted) {
        s.getTracks().forEach((t) => t.stop());
        return null;
      }
      s.getAudioTracks().forEach((t) =>
        t
          .applyConstraints({ echoCancellation: false, noiseSuppression: false, autoGainControl: false })
          .catch(() => {}),
      );
      // If the user stops sharing via the browser's native "Stop sharing" bar, drop our handle too
      // (inline — avoids a forward-reference to stopScreenShare). Listen on EVERY track (video AND
      // audio) — either may fire "ended" when the user clicks the browser UI to stop.
      s.getTracks().forEach((t) =>
        t.addEventListener('ended', () => {
          screenRef.current?.getTracks().forEach((tr) => tr.stop());
          screenRef.current = null;
          setScreenStream(null);
          setScreenSharing(false);
        }),
      );
      console.log(`[callmedia] screen share acquired tracks=${s.getTracks().length} video=${s.getVideoTracks().length} audio=${s.getAudioTracks().length}`);
      screenRef.current = s;
      setScreenStream(s);
      setScreenSharing(true);
      return s;
    } catch (err) {
      // Cancellation (user dismissed the picker) is benign — don't surface a scary error.
      console.warn('Screen share cancelled/denied:', err);
      return null;
    } finally {
      startingScreenRef.current = false;
      abortScreenRef.current = null;
    }
  }, []);

  const adoptStream = useCallback((s: MediaStream) => {
    // If we somehow already own a different one, stop it first (normal flow never hits this).
    if (streamRef.current && streamRef.current !== s) {
      streamRef.current.getTracks().forEach((t) => t.stop());
    }
    streamRef.current = s;
    setStream(s);
    const hasVideo = s.getVideoTracks().length > 0;
    setCameraAvailable(hasVideo);
    setMicEnabled(s.getAudioTracks().some((t) => t.enabled));
    setCameraEnabled(hasVideo ? s.getVideoTracks().some((t) => t.enabled) : false);
    setError(null);
  }, []);

  const releaseOwnership = useCallback(() => {
    // Detach OWNERSHIP (the ref) without stopping the tracks and WITHOUT clearing `stream` state:
    // the unmount cleanup reads the ref and will no-op (won't stop the handed-off tracks), and the
    // preview <video> keeps rendering from `stream` until the modal actually closes — so there's no
    // blank flash during the startCall round-trip. The mesh takes ownership via adoptStream.
    streamRef.current = null;
  }, []);

  const releaseStream = useCallback(() => {
    // Stop the owned camera+mic AND clear the stream reference so the NEXT acquire() captures FRESH
    // tracks. The page-level mesh hook is mounted ONCE (it lives above the call modal so minimize
    // never drops media), so its useCallMedia instance PERSISTS across calls. If teardown only stops
    // the old tracks (as it used to), streamRef still points at the now-ended stream and acquire()'s
    // `if (streamRef.current) return streamRef.current` short-circuit hands that DEAD stream to every
    // subsequent call → the mic/camera ship ended tracks → no audio/video → "the call works once, then
    // every call after is dead until a hard refresh" (a refresh zeroes streamRef — exactly the reset
    // this performs). Distinct from releaseOwnership (the no-stop preview→mesh handoff): this is the
    // full teardown reset, so it stops the tracks too.
    const s = streamRef.current;
    if (s) s.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setStream(null);
    setCameraAvailable(false);
    setMicEnabled(true);
    setCameraEnabled(true);
  }, []);

  const toggleMic = useCallback(() => {
    const s = streamRef.current;
    if (!s) return;
    const next = !s.getAudioTracks().some((t) => t.enabled);
    s.getAudioTracks().forEach((t) => (t.enabled = next));
    setMicEnabled(next);
  }, []);

  const toggleCamera = useCallback(() => {
    const s = streamRef.current;
    // No-op with no video track (audio-only join) — the Camera button is disabled in that state too,
    // but guard the action so a stale handler can't flip a meaningless toggle "on".
    if (!s || s.getVideoTracks().length === 0) return;
    const next = !s.getVideoTracks().some((t) => t.enabled);
    s.getVideoTracks().forEach((t) => (t.enabled = next));
    setCameraEnabled(next);
  }, []);

  // Unmount cleanup (guards #2 + #3): abort any in-flight acquisition AND stop every OWNED track.
  // releaseOwnership() detaches the stream first, so a handed-off stream survives this cleanup.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      abortScreenRef.current?.abort();
      const s = streamRef.current;
      if (s) s.getTracks().forEach((t) => t.stop());
      const sc = screenRef.current;
      if (sc) sc.getTracks().forEach((t) => t.stop());
    };
  }, []);

  return {
    stream, screenStream, micEnabled, cameraEnabled, cameraAvailable, screenSharing, error,
    acquire, startScreenShare, stopScreenShare, adoptStream, releaseOwnership, releaseStream,
    toggleMic, toggleCamera,
  };
}
