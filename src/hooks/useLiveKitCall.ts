'use client';

// useLiveKitCall — the LiveKit-backed replacement for useCallMesh. Same React surface (so src/app/
// page.tsx + LiveCallModal are unchanged), but the racy hand-rolled full-mesh WebRTC engine + the
// Firestore signaling bus are GONE: LiveKit's SFU handles peer connections, its own WebSocket
// signaling, ICE/TURN (Cloud includes a relay), automatic reconnection, and mute signaling. That is
// the whole point of the swap — the single-device logic-race flakiness lived in our renegotiation
// code, which no longer exists. Mounted ONCE at the page level (above all early returns), keyed on
// callDropId, so minimizing the call MODAL never tears down the room — the same persistence
// discipline useCallMesh had (minimize = page UI state, not an actual leave).
//
// LOCAL media still flows through useCallMedia (the shared acquisition layer): this PRESERVES the
// camera-OPTIONAL audio-only fallback (a no-camera PC still joins), the preview→room handoff (the
// host's CallStartScreen preview stream is published as-is — no camera blink or re-prompt on Start),
// and the releaseStream() teardown reset (stop tracks AND clear the ref so the persisted hook never
// ships a DEAD stream into the next call — the "works once then dead until refresh" bug). The tracks
// useCallMedia acquires are PUBLISHED to the LiveKit room (not re-acquired), so there is a single
// camera/mic source shared by the local preview tile and the SFU.
//
// REMOTE media: LiveKit delivers RemoteTracks per participant via RoomEvent.TrackSubscribed; we
// SYNTHESIZE a MediaStream per uid (camera/mic bucket + screen bucket) from each track's underlying
// MediaStreamTrack, so LiveCallModal's existing VideoTile — which binds <video>.srcObject = a
// MediaStream — renders them UNCHANGED. No LiveKit component is used in the JSX; the engine swap is
// invisible to the UI.

import { useCallback, useEffect, useRef, useState } from 'react';
import { doc, getDoc, onSnapshot } from 'firebase/firestore';
import {
  Room,
  RoomEvent,
  Track,
  type RemoteTrack,
  type RemoteTrackPublication,
  type RemoteParticipant,
  type LocalTrack,
  type LocalTrackPublication,
} from 'livekit-client';
import { auth } from '@/lib/firebase';
import { db } from '@/lib/firebase';
import { useCallMedia } from './useCallMedia';
import { joinCallRoute, leaveCallRoute, getCallTokenRoute, syncCallLimitRoute, confirmCallRoute } from '@/lib/callRoutes';
import { heartbeatCallPresence, subscribeToCallLimit } from '@/lib/liveCallSignaling';
import type { MemberInfo } from '@/lib/workspaces';

export type CallStatus = 'idle' | 'joining' | 'joined' | 'leaving' | 'ended';

interface UseLiveKitCallArgs {
  userId: string | null;
  callDropId: string | null;
  workspaceMembers: MemberInfo[];
  isDesktop: boolean;
}

// Screen-share sources (video + the optional tab/system audio) → the screen bucket; everything else
// (Camera / Microphone) → the camera/mic bucket. Mirrors the camera-vs-screen routing useCallMesh
// did by stream-id, but here LiveKit tags each track with an explicit source — far more reliable.
function isScreenSource(source: Track.Source): boolean {
  return source === Track.Source.ScreenShare || source === Track.Source.ScreenShareAudio;
}

export function useLiveKitCall({ userId, callDropId, workspaceMembers }: UseLiveKitCallArgs) {
  const media = useCallMedia();
  const [status, setStatus] = useState<CallStatus>('idle');
  const [participantUids, setParticipantUids] = useState<string[]>([]);
  const [remoteStreams, setRemoteStreams] = useState<Record<string, MediaStream>>({});
  const [remoteScreenStreams, setRemoteScreenStreams] = useState<Record<string, MediaStream>>({});
  const [error, setError] = useState<string | null>(null);
  const [trustedParticipantCount, setTrustedParticipantCount] = useState(0);
  const [callLimitDeadlineAt, setCallLimitDeadlineAt] = useState<number | null>(null);
  const [callEndReason, setCallEndReason] = useState<string | null>(null);
  const [callJoinedAtMs, setCallJoinedAtMs] = useState<number | null>(null);
  const [dailyMinutesUsed, setDailyMinutesUsed] = useState<number | null>(null);
  const [callTotalMinutes, setCallTotalMinutes] = useState<number | null>(null);
  const [dailyUsageTrusted, setDailyUsageTrusted] = useState(false);

  // The LiveKit room lives in a ref (NOT state) so it persists across the modal's minimize/unmount
  // cycle — exactly how useCallMesh kept its peer connections alive above the modal.
  const roomRef = useRef<Room | null>(null);
  const joiningRef = useRef(false);
  const leftRef = useRef(false); // guard against double-leave
  const activeCallDropIdRef = useRef<string | null>(null);
  // The LiveKit room name of the CURRENT session's generation — passed to leaveCallRoute as the
  // generation credential so a stale session can never delete/mutate a newer call in the slot.
  const sessionRoomNameRef = useRef<string | null>(null);
  const localJoinStartedAtRef = useRef<number | null>(null);
  const adoptedPreviewRef = useRef<MediaStream | null>(null);
  // Live refs to the always-current media helpers, so stable callbacks (the [] teardown effect, the
  // pagehide handler) read the live methods instead of a stale closure.
  const mediaRef = useRef(media);
  mediaRef.current = media;
  // Published LOCAL track publications — so toggleMic/toggleCamera can set the LiveKit track's mute
  // state (propagates to remotes so their mic/camera indicators update). Screen publications tracked
  // separately so STOP screen-share can unpublish them cleanly.
  const localPubRef = useRef<{
    mic?: LocalTrackPublication;
    cam?: LocalTrackPublication;
    screen: LocalTrackPublication[];
  }>({ screen: [] });
  // Remote tracks per uid — the source of truth. Event handlers mutate this map, then rebuild the
  // state MediaStreams in one pass (avoids per-track React state churn for ≤4 participants).
  const remoteTracksRef = useRef<Map<string, RemoteTrack[]>>(new Map());

  const memberName = useCallback(
    (uid: string): string => {
      const m = workspaceMembers.find((x) => x.uid === uid);
      return m?.displayName || (uid === userId ? 'You' : 'Participant');
    },
    [workspaceMembers, userId],
  );

  // ---- rebuild the remote MediaStream maps from the ref source of truth ----
  const rebuildRemoteStreams = useCallback(() => {
    const cams: Record<string, MediaStream> = {};
    const screens: Record<string, MediaStream> = {};
    for (const [uid, tracks] of remoteTracksRef.current) {
      const cam = tracks.filter((t) => !isScreenSource(t.source));
      const sc = tracks.filter((t) => isScreenSource(t.source));
      if (cam.length) cams[uid] = new MediaStream(cam.map((t) => t.mediaStreamTrack));
      if (sc.length) screens[uid] = new MediaStream(sc.map((t) => t.mediaStreamTrack));
    }
    setRemoteStreams(cams);
    setRemoteScreenStreams(screens);
  }, []);

  const syncParticipantUids = useCallback(() => {
    const room = roomRef.current;
    if (!room) {
      setParticipantUids([]);
      return;
    }
    const uids = Array.from(room.remoteParticipants.values())
      .map((p) => p.identity)
      .filter((id): id is string => !!id && id !== userId);
    setParticipantUids(uids);
  }, [userId]);

  // ---- attach a LiveKit Room's events to our React state ----
  const wireRoom = useCallback(
    (room: Room) => {
      const addTrack = (
        track: RemoteTrack,
        pub: RemoteTrackPublication,
        participant: RemoteParticipant,
      ) => {
        const uid = participant.identity;
        if (!uid) return;
        // If the publisher is ALREADY muted at subscribe time (joined camera-off / mic-muted),
        // TrackMuted won't fire (it only fires on a TRANSITION) — reflect it now so the tile shows the
        // avatar / mic-off instead of a black frame with a stale "on" indicator.
        if (pub.isMuted) track.mediaStreamTrack.enabled = false;
        const arr = remoteTracksRef.current.get(uid) ?? [];
        if (!arr.includes(track)) arr.push(track);
        remoteTracksRef.current.set(uid, arr);
        rebuildRemoteStreams();
        syncParticipantUids();
      };
      const removeTrack = (track: RemoteTrack, participant: RemoteParticipant) => {
        const uid = participant.identity;
        if (!uid) return;
        const arr = remoteTracksRef.current.get(uid);
        if (!arr) return;
        const next = arr.filter((t) => t !== track);
        if (next.length === 0) remoteTracksRef.current.delete(uid);
        else remoteTracksRef.current.set(uid, next);
        rebuildRemoteStreams();
        syncParticipantUids();
      };
      room
        .on(RoomEvent.TrackSubscribed, (track, pub, participant) => addTrack(track, pub, participant))
        .on(RoomEvent.TrackUnsubscribed, (track, _pub, participant) => removeTrack(track, participant))
        .on(RoomEvent.ParticipantConnected, () => syncParticipantUids())
        .on(RoomEvent.ParticipantDisconnected, (p) => {
          remoteTracksRef.current.delete(p.identity);
          rebuildRemoteStreams();
          syncParticipantUids();
        })
        // Reflect a publisher's mute in the synthesized stream so LiveCallModal's mic/camera indicators
        // (derived from the MediaStreamTrack's `enabled`) update. LiveKit flips isMuted; we mirror it
        // onto the underlying mediaStreamTrack.enabled the VideoTile inspects.
        .on(RoomEvent.TrackMuted, (pub) => {
          if (pub.track) pub.track.mediaStreamTrack.enabled = false;
          rebuildRemoteStreams();
        })
        .on(RoomEvent.TrackUnmuted, (pub) => {
          if (pub.track) pub.track.mediaStreamTrack.enabled = true;
          rebuildRemoteStreams();
        })
        .on(RoomEvent.Disconnected, () => {
          // Room dropped (server/network, or our own disconnect on leave). Clear remote state. We do
          // NOT call leaveCallRoute here — on an intentional leave, teardown() already issued it.
          remoteTracksRef.current.clear();
          rebuildRemoteStreams();
          setParticipantUids([]);
          if (!leftRef.current) setStatus('ended');
        });
    },
    [rebuildRemoteStreams, syncParticipantUids],
  );

  // ---- publish the local camera+mic (acquired/adopted via useCallMedia) to the LiveKit room ----
  const publishLocalCameraMic = useCallback(async (room: Room) => {
    const local = mediaRef.current.stream;
    if (!local) return;
    localPubRef.current = { screen: [] };
    for (const t of local.getTracks()) {
      try {
        const pub = await room.localParticipant.publishTrack(t, {
          source: t.kind === 'video' ? Track.Source.Camera : Track.Source.Microphone,
        });
        if (!pub) continue;
        if (t.kind === 'audio') localPubRef.current.mic = pub;
        else if (t.kind === 'video') localPubRef.current.cam = pub;
      } catch (e) {
        // A publish failure for EITHER track is NON-FATAL. A camera or mic grabbed by another app, or
        // a rare publish error, must NOT lock the user out of the call — they can still hear/see
        // others. (A genuine permission DENIAL was already surfaced + aborted by useCallMedia.acquire
        // before we got here; a publish blip degrades to joining without that track.) Mirrors the old
        // mesh, which simply addTrack'd whatever existed and tolerated a locked device.
        console.warn(`[livekit] ${t.kind} publish failed — continuing without it`, e);
      }
    }
  }, []);

  // ---- teardown: disconnect the room, release media, leave the call ----
  const teardown = useCallback(async (callId: string) => {
    // 1. disconnect the LiveKit room (drops every peer connection + clears remote state)
    const room = roomRef.current;
    if (room) {
      try {
        await room.disconnect();
      } catch (e) {
        console.warn('[livekit] room disconnect failed', e);
      }
      roomRef.current = null;
    }
    localPubRef.current = { screen: [] };
    remoteTracksRef.current.clear();
    // 2. release local camera+mic AND screen (stop tracks + clear the ref → the NEXT call's
    //    acquire() captures FRESH tracks). Same releaseStream() reset useCallMesh had: the hook is
    //    mounted ONCE above the modal and persists across calls, so without clearing the ref every
    //    call after the first would ship the DEAD (stopped) stream.
    mediaRef.current.releaseStream();
    mediaRef.current.stopScreenShare();
    setRemoteStreams({});
    setRemoteScreenStreams({});
    setParticipantUids([]);
    localJoinStartedAtRef.current = null;
    setCallJoinedAtMs(null);
    setDailyMinutesUsed(null);
    setCallTotalMinutes(null);
    setDailyUsageTrusted(false);
    // 3. POST /api/call/leave (transactional; deletes the doc if this was the last leaver). The
    //    generation credential ensures a stale session never mutates a newer call in the slot.
    try {
      await leaveCallRoute(callId, { expectedRoomName: sessionRoomNameRef.current });
    } catch (e) {
      console.warn('leave route failed', e);
    }
    sessionRoomNameRef.current = null;
  }, []);

  // ---- unmount / callDropId change → teardown once (the persisted-hook cleanup) ----
  useEffect(() => {
    return () => {
      const id = activeCallDropIdRef.current;
      if (id && !leftRef.current) {
        leftRef.current = true;
        void teardown(id);
      }
    };
  }, [teardown]);

  // ---- close-tab / navigate → leave with keepalive (mirrors usePresence's pagehide path) ----
  useEffect(() => {
    if (status !== 'joined') return;
    const onUnload = () => {
      const id = activeCallDropIdRef.current;
      if (!id || leftRef.current) return;
      leftRef.current = true;
      const token = auth.currentUser
        ? auth.currentUser.getIdToken().catch(() => null)
        : Promise.resolve(null);
      void token.then((tok) => {
        if (!tok) return;
        // keepalive lets the request outlive the page tear-down (best-effort; the route is idempotent).
        // The generation credential keeps a stale page from mutating a newer call in the slot.
        void fetch('/api/call/leave', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
          body: JSON.stringify({
            callDropId: id,
            expectedRoomName: sessionRoomNameRef.current ?? null,
          }),
          keepalive: true,
        }).catch(() => {});
      });
    };
    window.addEventListener('pagehide', onUnload);
    window.addEventListener('beforeunload', onUnload);
    return () => {
      window.removeEventListener('pagehide', onUnload);
      window.removeEventListener('beforeunload', onUnload);
    };
  }, [status]);

  // ---- public actions ----
  const adoptPreviewStream = useCallback((s: MediaStream | null) => {
    adoptedPreviewRef.current = s;
  }, []);

  const joinCall = useCallback(
    async (
      id: string,
      opts?: { skipJoinRoute?: boolean; attemptToken?: string | null; expectedRoomName?: string | null },
    ) => {
      if (joiningRef.current || roomRef.current || status === 'joining' || status === 'joined') return;
      if (!userId) {
        setError('Sign in to join the call.');
        throw new Error('Sign in to join the call.');
      }
      joiningRef.current = true;
      // Fresh session: no generation credential until the token route tells us the room name. The
      // host's start response already knows it (opts.expectedRoomName) — that covers the failures
      // that happen BEFORE the token fetch.
      sessionRoomNameRef.current = null;
      setStatus('joining');
      setError(null);
      setCallEndReason(null);
      setCallLimitDeadlineAt(null);
      setDailyMinutesUsed(null);
      setCallTotalMinutes(null);
      setDailyUsageTrusted(false);
      localJoinStartedAtRef.current = Date.now();
      setCallJoinedAtMs(localJoinStartedAtRef.current);
      setTrustedParticipantCount(0);
      leftRef.current = false;
      activeCallDropIdRef.current = id;
      // No stale screen-share state leaks into the new call (no-op if none).
      mediaRef.current.stopScreenShare();
      let rosterJoined = false;
      let createdRoom: Room | null = null;
      try {
        // Reserve the server-side seat before asking for camera/microphone permission. A full or
        // expired call must never trigger a browser permission prompt. The HOST of a fresh pending
        // call skips this — startCallRoute already admitted them to the pending roster, and the
        // join route only admits members of LIVE calls.
        if (!opts?.skipJoinRoute) {
          await joinCallRoute(id);
        }
        rosterJoined = true;
        // Local media: the adopted preview stream if the host just handed one off (no re-acquire, no
        // camera blink), else acquire fresh (a joiner has no preview).
        if (adoptedPreviewRef.current) {
          media.adoptStream(adoptedPreviewRef.current);
          adoptedPreviewRef.current = null;
        } else {
          const s = await media.acquire();
          if (!s) throw new Error(media.error || 'Could not access camera or microphone.');
        }
        const { token, url, roomName: connectedRoomName } = await getCallTokenRoute(id);
        sessionRoomNameRef.current = connectedRoomName;
        const room = new Room({
          // adaptiveStream OFF. With it ON, LiveKit shrinks the RECEIVED stream to match the tile's
          // rendered size — so a shared screen (even a STILL image) was delivered at a low resolution
          // and looked pixelated. OFF → subscribers always get the full-resolution layer (sharp screen
          // share + camera). Costs more bandwidth (fine for ≤4-person calls), but fixes screen-share
          // pixelation at the root. (LiveKit's own guidance: manually controlling video quality
          // requires adaptiveStream disabled.)
          adaptiveStream: false,
          dynacast: true,
          publishDefaults: {
            // Encode camera video at up to ~2 Mbps / 30fps so the 720p source (raised in
            // useCallMedia.acquire) stays crisp instead of being over-compressed to a soft ~480p look.
            videoEncoding: { maxBitrate: 2_000_000, maxFramerate: 30 },
            simulcast: true,
          },
        });
        createdRoom = room;
        wireRoom(room);
        await room.connect(url, token);
        // Publish our local camera+mic to the room (reuses the preview/acquired tracks).
        await publishLocalCameraMic(room);
        // The host of a fresh pending call CONFIRMS now that the LiveKit connection is up: the
        // server verifies this uid is actually in the room and promotes pending → live (starts the
        // clock, makes the call visible). LiveKit's participant list can lag the connect by a moment,
        // so one short retry covers the propagation race before giving up (on failure the catch path
        // disconnects and leaves, which releases the pending call with zero charge).
        if (opts?.attemptToken) {
          let confirmError: unknown = null;
          for (let attempt = 0; attempt < 2; attempt += 1) {
            if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 1500));
            try {
              await confirmCallRoute(id, opts.attemptToken);
              confirmError = null;
              break;
            } catch (e) {
              const err = e as Error & { status?: number };
              if (err.status === 404) {
                // The doc is no longer pending: either the promotion already committed (response was
                // lost) or the pending was cleaned up. Success ONLY when the doc is live AND still
                // owns THIS session's room generation — a replaced/reused slot is a genuine failure.
                try {
                  const callSnap = await getDoc(doc(db, 'drops', id));
                  const callData = callSnap.exists() ? callSnap.data() : null;
                  if (
                    callData?.callState === 'live' &&
                    (callData.livekitRoomName ?? id) === connectedRoomName
                  ) {
                    confirmError = null;
                    break;
                  }
                } catch {
                  /* fall through to retry/fail */
                }
              }
              confirmError = e;
            }
          }
          if (confirmError) throw confirmError;
        }
        roomRef.current = room;
        // Seed remote state from participants ALREADY present (their tracks arrive via
        // TrackSubscribed, but any already-subscribed publications are picked up here too).
        room.remoteParticipants.forEach((p) => {
          if (!p.identity) return;
          const arr = remoteTracksRef.current.get(p.identity) ?? [];
          p.getTrackPublications().forEach((pub) => {
            // pub.track is typed as the base Track, but on a RemoteParticipant it is a RemoteTrack.
            const tr = pub.track as RemoteTrack | undefined;
            if (!tr || arr.includes(tr)) return;
            if (pub.isMuted) tr.mediaStreamTrack.enabled = false; // already-muted at subscribe
            arr.push(tr);
          });
          remoteTracksRef.current.set(p.identity, arr);
        });
        rebuildRemoteStreams();
        syncParticipantUids();
        setStatus('joined');
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Failed to join the call.';
        setError(msg);
        setStatus('idle');
        // Release everything acquired BEFORE nulling the ref: disconnect any Room we created this
        // attempt that never became the active roomRef (connect/publish threw → it's orphaned), and
        // release the roster seat we took so a FAILED join can't strand a capacity-4 slot as a ghost
        // participant. (leaveCallRoute is idempotent; a retry returns { already: true }.)
        if (createdRoom && roomRef.current !== createdRoom) {
          try {
            await createdRoom.disconnect();
          } catch {
            /* best-effort */
          }
        }
        if (rosterJoined) {
          try {
            // Generation credential: a stale failed attempt must never mutate a newer call in the
            // slot. Prefer the credential known before the token fetch (host start response); the
            // session ref covers failures after it.
            await leaveCallRoute(id, {
              expectedRoomName: opts?.expectedRoomName ?? sessionRoomNameRef.current,
            });
          } catch {
            /* idempotent */
          }
        }
        sessionRoomNameRef.current = null;
        activeCallDropIdRef.current = null;
        localJoinStartedAtRef.current = null;
        setCallJoinedAtMs(null);
        setDailyMinutesUsed(null);
        setCallTotalMinutes(null);
        setDailyUsageTrusted(false);
        // release the media we just acquired/adopted (stop + clear ref so a retry acquires fresh)
        const abandonedPreview = adoptedPreviewRef.current;
        adoptedPreviewRef.current = null;
        abandonedPreview?.getTracks().forEach((track) => track.stop());
        mediaRef.current.releaseStream();
        throw e;
      } finally {
        joiningRef.current = false;
      }
    },
    [userId, status, media, wireRoom, publishLocalCameraMic, rebuildRemoteStreams, syncParticipantUids],
  );

  const leaveCall = useCallback(
    async (opts?: { minimize?: boolean }) => {
      if (opts?.minimize) return; // minimize is page-level UI state, not an actual leave
      const id = activeCallDropIdRef.current;
      if (!id || leftRef.current) return;
      leftRef.current = true;
      setStatus('leaving');
      await teardown(id);
      activeCallDropIdRef.current = null;
      setStatus('idle');
  },
    [teardown],
  );

  const syncCallLimit = useCallback(async (id: string) => {
    const state = await syncCallLimitRoute(id);
    setDailyMinutesUsed(state.minutesUsedToday);
    setCallTotalMinutes(state.callTotalMinutes);
    setDailyUsageTrusted(state.trusted);
    return state;
  }, []);

  // The call document carries the server-owned timer and terminal reason. Keeping this separate from
  // LiveKit's participant events lets the UI explain why a server-enforced call ended.
  useEffect(() => {
    if (!userId || !callDropId || status !== 'joined') return;
    const unsub = subscribeToCallLimit(callDropId, userId, (state) => {
      setTrustedParticipantCount(state.trustedParticipantCount);
      setCallLimitDeadlineAt(state.deadlineAtMs);
      setCallJoinedAtMs(state.participantJoinedAtMs ?? localJoinStartedAtRef.current);
      if (state.endReason) setCallEndReason(state.endReason);
      if (state.callState === 'ended' && !leftRef.current) setStatus('ended');
    });
    return unsub;
  }, [userId, callDropId, status]);

  // Refresh the usage baseline immediately when server accounting resets the local join timestamp,
  // instead of waiting for the next 30-second poll.
  useEffect(() => {
    if (!userId || !callDropId || status !== 'joined' || callJoinedAtMs == null) return;
    void syncCallLimit(callDropId).catch(() => {});
  }, [userId, callDropId, status, callJoinedAtMs, syncCallLimit]);

  // Keep the server-side presence guard active for the LiveKit call path. The older useCallMesh hook
  // owned this heartbeat before LiveKit replaced it, but the current hook must publish it itself.
  useEffect(() => {
    if (!userId || !callDropId || status !== 'joined') return;
    void heartbeatCallPresence(callDropId, userId).catch(() => {});
    const id = setInterval(
      () => void heartbeatCallPresence(callDropId, userId).catch(() => {}),
      30_000,
    );
    return () => clearInterval(id);
  }, [userId, callDropId, status]);

  // Re-read trust status periodically so owner tier changes affect an active call without requiring a
  // leave/rejoin. The server remains authoritative and the client treats failures as best effort.
  useEffect(() => {
    if (!userId || !callDropId || status !== 'joined') return;
    void syncCallLimit(callDropId).catch(() => {});
    const id = setInterval(() => void syncCallLimit(callDropId).catch(() => {}), 30_000);
    return () => clearInterval(id);
  }, [userId, callDropId, status, syncCallLimit]);

  // Ask the server to enforce immediately when the displayed deadline reaches zero. The server
  // remains authoritative; this timer only reduces the overrun when a foreground tab is active.
  useEffect(() => {
    if (
      !userId ||
      !callDropId ||
      status !== 'joined' ||
      callLimitDeadlineAt == null ||
      trustedParticipantCount > 0
    ) return;
    const delayMs = Math.max(0, callLimitDeadlineAt - Date.now());
    const id = setTimeout(() => {
      void syncCallLimit(callDropId).catch(() => {});
    }, delayMs);
    return () => clearTimeout(id);
  }, [userId, callDropId, status, callLimitDeadlineAt, trustedParticipantCount, syncCallLimit]);

  // A tier change is reflected as soon as the participant's own user document changes. The periodic
  // sync and the scheduled server check cover participants whose browser is not active.
  useEffect(() => {
    if (!userId || !callDropId || status !== 'joined') return;
    const unsub = onSnapshot(doc(db, 'users', userId), () => {
      void syncCallLimit(callDropId).catch(() => {});
    }, () => {});
    return unsub;
  }, [userId, callDropId, status, syncCallLimit]);

  // Mute is set BOTH ways: media.toggleMic flips the local track.enabled (your side goes silent +
  // the local button/tile update), AND setting the published LocalTrack's `muted` signals the SFU so
  // remote participants receive TrackMuted and their indicators update. The LocalTrack wraps the SAME
  // MediaStreamTrack useCallMedia just toggled, so its enabled state is the source of truth here.
  const toggleMic = useCallback(() => {
    media.toggleMic();
    // LiveKit v2 mutes via async mute()/unmute() (server-side signaling → remotes see the indicator).
    // The local media.toggleMic above already silenced us; this propagates the mute state. Best-effort.
    const t = localPubRef.current.mic?.track as LocalTrack | undefined;
    if (t) {
      const shouldMute = !t.mediaStreamTrack.enabled;
      void (shouldMute ? t.mute() : t.unmute()).catch(() => {});
    }
  }, [media]);

  const toggleCamera = useCallback(() => {
    media.toggleCamera();
    const t = localPubRef.current.cam?.track as LocalTrack | undefined;
    if (t) {
      const shouldMute = !t.mediaStreamTrack.enabled;
      void (shouldMute ? t.mute() : t.unmute()).catch(() => {});
    }
  }, [media]);

  const toggleScreenShare = useCallback(async () => {
    const room = roomRef.current;
    if (media.screenSharing) {
      // STOP: unpublish each screen publication (don't stop the track here — media.stopScreenShare
      // owns the capture lifecycle), then release the screen capture.
      if (room) {
        for (const pub of localPubRef.current.screen) {
          if (!pub.track) continue;
          try {
            await room.localParticipant.unpublishTrack(pub.track, false);
          } catch (e) {
            console.warn('[livekit] screen unpublish failed', e);
          }
        }
      }
      localPubRef.current.screen = [];
      media.stopScreenShare();
    } else {
      // START: capture screen (+ optional tab/system audio) via useCallMedia (media-mode audio
      // constraints preserved), then publish each track with its ScreenShare / ScreenShareAudio source
      // so remotes route it to the screen bucket.
      const sc = await media.startScreenShare();
      if (sc && room) {
        const pubs: LocalTrackPublication[] = [];
        for (const t of sc.getTracks()) {
          try {
            const pub = await room.localParticipant.publishTrack(t, {
              source: t.kind === 'video' ? Track.Source.ScreenShare : Track.Source.ScreenShareAudio,
            });
            if (pub) pubs.push(pub);
          } catch (e) {
            console.warn('[livekit] screen track publish failed', e);
          }
        }
        localPubRef.current.screen = pubs;
      }
    }
  }, [media]);

  return {
    status,
    participantUids,
    remoteStreams,
    remoteScreenStreams,
    localStream: media.stream,
    localScreenStream: media.screenStream,
    micEnabled: media.micEnabled,
    cameraEnabled: media.cameraEnabled,
    cameraAvailable: media.cameraAvailable,
    screenSharing: media.screenSharing,
    trustedParticipantCount,
    callLimitDeadlineAt,
    callEndReason,
    dailyMinutesUsed,
    callTotalMinutes,
    dailyUsageTrusted,
    callJoinedAtMs,
    error: error || media.error,
    memberName,
    adoptPreviewStream,
    joinCall,
    leaveCall,
    toggleMic,
    toggleCamera,
    toggleScreenShare,
  };
}

// Same exported type name useCallMesh used, so any consumer typed against CallMeshState keeps working.
export type CallMeshState = ReturnType<typeof useLiveKitCall>;
