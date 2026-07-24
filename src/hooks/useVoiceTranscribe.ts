import { useCallback, useEffect, useRef, useState } from 'react';
import { auth } from '@/lib/firebase';

interface UseVoiceTranscribeOptions {
  /** Called with the transcribed text on a successful transcription (already trimmed). */
  onTranscript: (text: string) => void;
  /** Called with a human-readable message when recording/transcription fails. */
  onError?: (message: string) => void;
}

/**
 * Reusable voice-to-text for chat composers. Captures audio via MediaRecorder
 * (audio/webm), uploads to /api/transcribe (Firebase Bearer auth → Groq Whisper),
 * and delivers the transcript via onTranscript. Extracted from TextModal's
 * toggleRecording so the AI/group chat can reuse it without triplicating the logic.
 *
 * Both callbacks are stabilized via latest-refs: the `onstop` handler is attached at
 * start-time, so without the ref it would capture a stale onTranscript/onError and a
 * mid-recording mode switch would route the transcript to the wrong composer.
 */
export function useVoiceTranscribe({ onTranscript, onError }: UseVoiceTranscribeOptions) {
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  // Guards against a fast double-click during the getUserMedia/permission latency:
  // a 2nd click would start a 2nd recorder and orphan the 1st (leaking its mic stream).
  const startingRef = useRef(false);

  // Latest-callback refs (assigned every render, no dep) keep the long-lived onstop
  // handler pointing at the freshest closures across mode switches / re-renders.
  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const toggle = useCallback(async () => {
    if (isRecording && mediaRecorderRef.current) {
      // Stop recording → fires onstop below (transcribes).
      mediaRecorderRef.current.stop();
      setIsRecording(false);
      return;
    }

    // Ignore a fast 2nd click while the 1st is still acquiring the mic (permission-prompt
    // latency) — otherwise the 2nd getUserMedia orphans the 1st recorder and leaks its stream.
    if (startingRef.current) return;
    startingRef.current = true;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
      mediaRecorderRef.current = mediaRecorder;
      chunksRef.current = [];

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      mediaRecorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunksRef.current, { type: 'audio/webm' });

        setIsTranscribing(true);
        try {
          const token = await auth.currentUser?.getIdToken();
          if (!token) {
            onErrorRef.current?.('Please sign in to use voice.');
          } else {
            const formData = new FormData();
            formData.append('file', blob, 'recording.webm');
            const res = await fetch('/api/transcribe', {
              method: 'POST',
              headers: { Authorization: `Bearer ${token}` },
              body: formData,
            });
            if (!res.ok) {
              // Surface the server's message (the 429 daily-limit/reset text, the 413 size error, or
              // a generic failure) and bail BEFORE reading data.text. setIsTranscribing(false) first —
              // the early return skips the trailing reset at the bottom of onstop.
              const body = await res.json().catch(() => ({}));
              onErrorRef.current?.(body.error || 'Transcription failed. Please try again.');
              setIsTranscribing(false);
              return;
            }
            const data = await res.json();
            const text = typeof data.text === 'string' ? data.text.trim() : '';
            if (text) {
              onTranscriptRef.current?.(text);
            } else {
              onErrorRef.current?.('No speech detected. Try again.');
            }
          }
        } catch (err) {
          console.error('Voice transcription failed:', err);
          onErrorRef.current?.("Couldn't reach transcription. Check your connection.");
        }
        setIsTranscribing(false);
      };

      mediaRecorder.start();
      setIsRecording(true);
    } catch (err) {
      console.error('Mic access denied:', err);
      onErrorRef.current?.('Microphone access denied. Enable mic permissions to use voice.');
    } finally {
      startingRef.current = false;
    }
  }, [isRecording]);

  // If the composer unmounts mid-recording (panel closed), stop the recorder so the
  // OS mic indicator turns off. (onstop may still run; setState on an unmounted
  // component is a harmless no-op in React 18+.)
  useEffect(() => {
    return () => {
      const mr = mediaRecorderRef.current;
      if (mr && mr.state !== 'inactive') {
        try {
          mr.stop();
        } catch {
          /* already stopped */
        }
      }
    };
  }, []);

  return { isRecording, isTranscribing, toggle };
}
