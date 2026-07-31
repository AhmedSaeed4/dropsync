'use client';

// useCallMesh — PAGE-LEVEL full-mesh WebRTC engine for live calls. Called ONCE in src/app/page.tsx,
// ABOVE all early returns (like usePresence), because the call MODAL unmounts on minimize but the
// media + peer connections must persist. Keyed on callDropId (NOT workspaceId) so a call survives a
// workspace switch.
//
// Perfect negotiation over Firestore signaling (lib/liveCallSignaling): one RTCPeerConnection per
// remote participant; pairId = [me,them].sort().join('__'); deterministic roles (lexicographically
// smaller uid = POLITE, yields/rollback on glare) kill the simultaneous-offer deadlock; ICE
// candidates coalesce via arrayUnion on a 50ms batcher (quota-minimal on the free Spark plan, §13).
// Host-leave does NOT end the call (full mesh self-heals — each pair is independent; callHostUid is
// display-only). The 3 invariants (one-call / capacity-4 / last-leave) are enforced by /api/call/*;
// this hook only joins/leaves + signals.
//
// Teardown is STRICT-ORDER (media before signaling before roster): timers → pc.close() all → stop
// local+screen tracks (indicators off) → unsubscribe all → POST /api/call/leave. A close-tab navigates
// away fires a fire-and-forget leave with keepalive.

import { useCallback, useEffect, useRef, useState } from 'react';
import { auth } from '@/lib/firebase';
import { useCallMedia } from './useCallMedia';
import {
  callPairId,
  callPoliteRole,
  callMySide,
  subscribeToCallSignals,
  subscribeToCallPresence,
  subscribeToCallRoster,
  writeCallOffer,
  writeCallAnswer,
  addCallIceCandidate,
  heartbeatCallPresence,
  resetSignalDoc,
} from '@/lib/liveCallSignaling';
import type { CallSignalDoc } from '@/lib/liveCallSignaling';
import { joinCallRoute, leaveCallRoute, reapStaleCallRoute } from '@/lib/callRoutes';
import type { MemberInfo } from '@/lib/workspaces';

export type CallStatus = 'idle' | 'joining' | 'joined' | 'leaving' | 'ended';

interface UseCallMeshArgs {
  userId: string | null;
  callDropId: string | null;
  workspaceMembers: MemberInfo[];
  isDesktop: boolean;
}

interface PeerState {
  pc: RTCPeerConnection;
  polite: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
  appliedOfferSdp: string | null;
  appliedAnswerSdp: string | null;
  myOfferSdp: string | null;
  appliedCandidateCount: number;
  /** ICE candidates that arrived BEFORE the remote description was set. WebRTC requires the
   *  remote SDP be applied first; without buffering these, addIceCandidate throws
   *  "remote description was null" and the candidate is LOST (we used to mark it applied and move
   *  on, which permanently broke ICE on this pair). Apply them right after setRemoteDescription. */
  pendingCandidates: RTCIceCandidateInit[];
  unsub: () => void;
  iceTimer: ReturnType<typeof setTimeout> | null;
  iceBatch: RTCIceCandidateInit[];
  negotiated: boolean;
  processing: boolean;
  /** Latest snapshot that arrived WHILE another was being processed. We re-process it after the
   *  in-flight handler finishes — without this, a snapshot containing the peer's offer could be
   *  dropped (the `processing` guard used to silently swallow it) and the negotiation stalls. */
  pendingSignal: CallSignalDoc | null;
  callId: string;
  pairId: string;
  mySide: 'A' | 'B';
  /** Transceivers created by toggleScreenShare (one per screen track — video + optional audio).
   *  Tracked so STOP can removeTrack + renegotiate cleanly. EMPTY during a normal camera-only call. */
  screenTransceivers: RTCRtpTransceiver[];
  /** One-shot cap (0 or 1) on the screen-orphan recovery re-offer (Bug A). An answerer whose screen
   *  transceivers were orphaned by a camera-only offer re-offers ONCE to add them; this guarantees the
   *  recovery can never loop even if a browser mis-reports transceiver direction. */
  screenReofferAttempts: number;
  /** False until our OWN first offer is written to Firestore. Because callDropId = call-{workspaceId}
   *  reuses the same signal doc across sessions, the snapshot that fires IMMEDIATELY after
   *  subscribeToCallSignals starts often carries STALE offer/answer/candidates from a PRIOR session.
   *  Applying that stale SDP to a fresh PC causes "Incompatible send direction" / "m-line order"
   *  / "SSL role" crashes. Until we've written our own fresh offer, we DROP incoming snapshots
   *  (stashed to pendingSignal so they re-process once ready). */
  ready: boolean;
  /** Per-peer set of track IDs we've already classified (camera vs screen) and added to a bucket.
   *  The spec says ontrack fires once per transceiver, but Chrome re-fires it on RENEGOTIATION when
   *  the peer bundles the same track under a different MediaStream in the new SDP. Without dedup,
   *  the same audio track gets re-classified as screen on the second fire (different e.streams[0].id)
   *  and ADDED to BOTH remoteStreams AND remoteScreenStreams — double-binding that breaks playback
   *  and routing. Once we've seen a trackId, ignore subsequent fires for it. */
  seenTrackIds: Set<string>;
}

const ICE_BATCH_MS = 50;
const HEARTBEAT_MS = 30_000;
const STALE_PRESENCE_MS = 60_000;

function buildIceServers(): RTCIceServer[] {
  // STUN always; TURN from env only if the owner has configured a free provider (§13 — the only
  // remaining ship gate). STUN-only fallback so calls still connect for the ~80% not behind strict NAT.
  const servers: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];
  const turnUrl = process.env.NEXT_PUBLIC_TURN_URL;
  const turnUser = process.env.NEXT_PUBLIC_TURN_USER;
  const turnPass = process.env.NEXT_PUBLIC_TURN_PASS;
  if (turnUrl) {
    servers.push({ urls: turnUrl, username: turnUser || '', credential: turnPass || '' });
  }
  return servers;
}

/** [BUG B] mids of the screen-share AUDIO m-lines, identified on BOTH the sender AND the receiver
 *  side. Read AFTER setLocalDescription so transceiver.mid is populated. Targets ONLY the screen-audio
 *  m-line for music-mode Opus — the MIC stays in voice mode.
 *
 *  CRITICAL: Opus stereo/usedtx/maxaveragebitrate are RECEIVER-capability declarations, so the sharer's
 *  encoder only goes stereo/high-quality once it sets the VIEWER's munged ANSWER as remoteDescription.
 *  The viewer has NO screenTransceivers of its own (it isn't sharing), so a "tracked transceivers only"
 *  check leaves the viewer's answer UN-munged and the sharer keeps sending mono voice-mode audio — the
 *  first fix attempt had no effect for exactly this reason. On the receiver side the peer's screen audio
 *  is the audio transceiver we only RECEIVE on — our sender for it has NO track (we have no screen audio
 *  to send back) — so we catch it via sender.track == null. Our own MIC transceiver (sender.track = mic)
 *  is excluded, so the mic keeps voice mode. */
function screenAudioMidsOf(st: PeerState): Set<string> {
  const tracked = new Set(st.screenTransceivers);
  const mids = new Set<string>();
  for (const tx of st.pc.getTransceivers()) {
    const senderKind = tx.sender?.track?.kind;
    const recvKind = tx.receiver?.track?.kind;
    if ((senderKind !== 'audio' && recvKind !== 'audio') || tx.mid == null) continue;
    // Screen audio = a screen transceiver WE added (sender side, tracked) OR an audio transceiver we
    // only receive on (sender.track == null = the peer's screen audio we have no mic to answer with).
    if (tracked.has(tx) || tx.sender?.track == null) mids.add(tx.mid);
  }
  return mids;
}

/** [BUG B] Rewrite the screen-share AUDIO m-line's Opus fmtp to MUSIC mode — stereo=1 (keep stereo
 *  width so media isn't boxed-in/mono), usedtx=0 (no discontinuous transmission — kills the "fades out
 *  during quiet parts" dropout), maxaveragebitrate=510000 (lift Opus off its ~32kbps voice default so
 *  music sounds full). Mic audio m-lines are left in voice mode (correct for speech). Operates on the
 *  SDP string we TRANSMIT; the PC's own localDescription is untouched — stereo/usedtx/maxaveragebitrate
 *  are receiver-capability + encoder params resolved from the negotiated remote description, so no
 *  internal re-setLocalDescription is needed (standard SDP-munge pattern). MUST also munge the ANSWER
 *  path: the sharer's encoder only goes stereo once it sets the viewer's munged (stereo=1) answer as
 *  remoteDescription — munging offers alone is a silent no-op. */
function mungeScreenAudioSdp(sdp: string, screenAudioMids: Set<string>): string {
  if (screenAudioMids.size === 0) return sdp;
  const eol = /\r\n/.test(sdp) ? '\r\n' : '\n';
  const lines = sdp.split(/\r?\n/);
  // Detect the Opus payload type (a=rtpmap:<PT> opus/48000/2) — Chrome uses 111, detect for safety.
  let opusPt: string | null = null;
  for (const line of lines) {
    const m = /^a=rtpmap:(\d+)\s+opus\/48000\/2/i.exec(line);
    if (m) {
      opusPt = m[1];
      break;
    }
  }
  if (opusPt == null) return sdp; // no Opus codec present — nothing to munge
  const fmtpRe = new RegExp(`^a=fmtp:${opusPt}\\b`);
  let curMid: string | null = null;
  let curIsAudio = false;
  const out: string[] = [];
  for (const line of lines) {
    if (/^m=audio\b/.test(line)) {
      curIsAudio = true;
      curMid = null;
    } else if (/^m=/.test(line)) {
      curIsAudio = false;
      curMid = null;
    }
    const midM = /^a=mid:(.+)$/.exec(line);
    if (midM) curMid = midM[1];
    if (curIsAudio && curMid != null && screenAudioMids.has(curMid) && fmtpRe.test(line)) {
      out.push(
        line
          .replace(/;?\s*stereo=\d+/gi, '')
          .replace(/;?\s*usedtx=\d+/gi, '')
          .replace(/;?\s*maxaveragebitrate=\d+/gi, '')
          .trim() + ';stereo=1;usedtx=0;maxaveragebitrate=510000',
      );
    } else {
      out.push(line);
    }
  }
  return out.join(eol);
}

/** [BUG B] Raise a screen-share AUDIO sender's bitrate cap off the ~32kbps Opus voice default.
 *  Stereo/usedtx/maxaveragebitrate are enforced via SDP munging; this sender-side maxBitrate is belt-
 *  and-suspenders (the effective Opus cap is the min of both). Fire-and-forget — some browsers throw
 *  if called before the transceiver is negotiated, which is harmless here. */
function raiseScreenAudioBitrate(sender: RTCRtpSender): void {
  try {
    const sp = sender.getParameters();
    if (!sp.encodings || sp.encodings.length === 0) sp.encodings = [{}];
    sp.encodings[0].maxBitrate = 256_000;
    sender.setParameters(sp).catch(() => {});
  } catch {
    /* getParameters can throw pre-negotiation on some browsers — non-fatal */
  }
}

export function useCallMesh({ userId, callDropId, workspaceMembers }: UseCallMeshArgs) {
  const media = useCallMedia();
  const [status, setStatus] = useState<CallStatus>('idle');
  const [participantUids, setParticipantUids] = useState<string[]>([]);
  const [remoteStreams, setRemoteStreams] = useState<Record<string, MediaStream>>({});
  const [remoteScreenStreams, setRemoteScreenStreams] = useState<Record<string, MediaStream>>({});
  const [error, setError] = useState<string | null>(null);

  const peersRef = useRef<Map<string, PeerState>>(new Map());
  const rosterUidsRef = useRef<string[]>([]);
  const heartbeatTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const presenceUnsubRef = useRef<(() => void) | null>(null);
  const rosterUnsubRef = useRef<(() => void) | null>(null);
  const leftRef = useRef(false); // guard against double-leave
  const activeCallDropIdRef = useRef<string | null>(null);
  const adoptedPreviewRef = useRef<MediaStream | null>(null);
  const mediaRef = useRef(media);
  mediaRef.current = media;
  // Tracks the first stream ID received per remote peer. Camera + mic tracks share one stream (the
  // sender's getUserMedia stream — addTrack(t, localStream) uses the same stream object). Screen
  // tracks arrive on a SEPARATE stream (the sender's getDisplayMedia stream — addTransceiver(t,
  // { streams: [sc] }) uses a different stream). So the first stream we see per peer = camera/mic;
  // any track on a DIFFERENT stream = screen. This fixes the audio-only-peer bug where the first
  // (and only) video track is a screen share — position-counting misclassified it as camera and it
  // landed in remoteStreams (camera bucket) instead of remoteScreenStreams, rendering it as a tiny
  // corner tile. Stream-ID routing correctly feeds it to the screen-share layout.
  const firstStreamIdRef = useRef<Map<string, string>>(new Map());

  const memberName = useCallback(
    (uid: string): string => {
      const m = workspaceMembers.find((x) => x.uid === uid);
      return m?.displayName || (uid === userId ? 'You' : 'Participant');
    },
    [workspaceMembers, userId],
  );

  // ---- per-pair teardown ----
  const closePeer = useCallback((them: string) => {
    const p = peersRef.current.get(them);
    if (!p) {
      console.log('[mesh] closePeer: not found', them);
      return;
    }
    console.log('[mesh] closePeer', them);
    try {
      p.pc.close();
    } catch {
      /* already closed */
    }
    if (p.iceTimer) clearTimeout(p.iceTimer);
    p.unsub();
    peersRef.current.delete(them);
    setRemoteStreams((prev) => {
      if (!prev[them]) return prev;
      const n = { ...prev };
      delete n[them];
      return n;
    });
    setRemoteScreenStreams((prev) => {
      if (!prev[them]) return prev;
      const n = { ...prev };
      delete n[them];
      return n;
    });
    firstStreamIdRef.current.delete(them);
    p.seenTrackIds.clear();
  }, []);

  // ---- per-pair setup (perfect negotiation over the shared pair signal doc) ----
  const wirePeer = useCallback(async (them: string, callId: string, me: string) => {
    if (peersRef.current.has(them)) {
      console.log('[mesh] wirePeer: already wired', them);
      return;
    }
    const pairId = callPairId(me, them);
    const polite = callPoliteRole(me, them) === 'polite';
    const mySide = callMySide(me, them);
    console.log(`[mesh] wirePeer them=${them} pairId=${pairId} polite=${polite} mySide=${mySide} callId=${callId}`);
    // AWAIT a clean-slate wipe BEFORE subscribing. Because callDropId = call-{workspaceId} reuses the
    // same pair signal doc across sessions, the doc often carries stale offer/answer/candidates from
    // a prior session whose SDP references the OLD PC's transceiver layout + ICE ufrag. Subscribing
    // first would deliver that stale state as our FIRST snapshot — applying it to a fresh PC crashes
    // with "Incompatible send direction" / "m-line order" / "SSL role". The wipe atomically empties
    // all signaling fields (using only allowlisted fields — no rules change) so the first snapshot
    // after this returns is either the wiped-empty state (no-op) or the peer's FRESH offer.
    await resetSignalDoc(callId, pairId, polite ? 'polite' : 'impolite', mySide);
    console.log(`[mesh] wirePeer — signal doc wiped pairId=${pairId}`);
    const pc = new RTCPeerConnection({ iceServers: buildIceServers() });
    const st: PeerState = {
      pc,
      polite,
      makingOffer: false,
      ignoreOffer: false,
      appliedOfferSdp: null,
      appliedAnswerSdp: null,
      myOfferSdp: null,
      appliedCandidateCount: 0,
      pendingCandidates: [],
      unsub: () => {},
      iceTimer: null,
      iceBatch: [],
      negotiated: false,
      processing: false,
      pendingSignal: null,
      callId,
      pairId,
      mySide,
      screenTransceivers: [],
      screenReofferAttempts: 0,
      ready: true,
      seenTrackIds: new Set(),
    };
    peersRef.current.set(them, st);

    // add local camera+mic tracks to this PC (renegotiates via onnegotiationneeded)
    const local = mediaRef.current.stream;
    console.log(`[mesh] local stream exists=${!!local} audioTracks=${local?.getAudioTracks().length ?? 0} videoTracks=${local?.getVideoTracks().length ?? 0}`);
    if (local) local.getTracks().forEach((t) => pc.addTrack(t, local));
    // Audio-only users add a recvonly video receiver so both sides always have the same
    // m-line layout (m=audio + m=video). Without this, an audio-only offer with only m=audio
    // negotiating against a camera offer with m=audio + m=video causes "order of m-lines in
    // subsequent offer doesn't match" errors.
    if (!local?.getVideoTracks().length) {
      console.log('[mesh] audio-only — adding recvonly video transceiver');
      pc.addTransceiver('video', { direction: 'recvonly' });
    }
    // if a screen-share is already live, add it too (mid-call joiner case). Use addTransceiver and
    // track each one on the PeerState so a future STOP screen share can removeTrack cleanly.
    const screen = mediaRef.current.screenStream;
    // Only adopt a screen stream that still has a LIVE track. A dead/ended stream left over from a
    // prior session must never be re-sent to peers, or they receive a frozen/black screen track.
    if (screen && screen.getTracks().some((t) => t.readyState === 'live')) {
      console.log('[mesh] adopting live screen stream during wirePeer');
      const screenTracks = screen.getTracks();
      const addedTx: RTCRtpTransceiver[] = [];
      for (const t of screenTracks) {
        const tx = pc.addTransceiver(t, { direction: 'sendrecv', streams: [screen] });
        if (t.kind === 'audio') raiseScreenAudioBitrate(tx.sender); // [BUG B] screen audio is media, not voice
        addedTx.push(tx);
        console.log(`[mesh] wirePeer screen adoption — addTransceiver kind=${t.kind} trackId=${t.id}`);
      }
      st.screenTransceivers = addedTx;
    }

    pc.onnegotiationneeded = async () => {
      console.log(`[mesh] onnegotiationneeded them=${them} negotiated=${st.negotiated} makingOffer=${st.makingOffer} sigState=${pc.signalingState}`);
      // SKIP if (a) initial exchange already done, (b) a manual renegotiateNow is in flight
      // (makingOffer guards the queued addTransceiver-scheduled job when toggleScreenShare calls
      // us manually), or (c) signalingState isn't stable (an existing offer/answer round is running).
      if (st.negotiated || st.makingOffer || pc.signalingState !== 'stable') {
        console.log(`[mesh] onnegotiationneeded: SKIPPED (negotiated=${st.negotiated} makingOffer=${st.makingOffer} sigState=${pc.signalingState})`);
        return;
      }
      try {
        st.makingOffer = true;
        await pc.setLocalDescription();
        st.myOfferSdp = pc.localDescription?.sdp ?? null;
        const offSdp = mungeScreenAudioSdp(pc.localDescription?.sdp ?? '', screenAudioMidsOf(st)); // [BUG B] screen audio → music mode
        console.log(`[mesh] onnegotiationneeded: offer written pairId=${pairId} polite=${polite} mySide=${mySide} offerLen=${offSdp.length}`);
        await writeCallOffer(callId, pairId, { type: pc.localDescription!.type, sdp: offSdp }, polite ? 'polite' : 'impolite', mySide);
      } catch (e) {
        console.error('[mesh] onnegotiationneeded failed', e);
      } finally {
        st.makingOffer = false;
      }
    };

    pc.onicecandidate = ({ candidate }) => {
      if (!candidate) return;
      st.iceBatch.push(candidate.toJSON());
      if (st.iceTimer) return; // a flush is already pending — this candidate rides the batch
      st.iceTimer = setTimeout(async () => {
        st.iceTimer = null;
        const batch = st.iceBatch;
        st.iceBatch = [];
        // one arrayUnion write per candidate (setDoc+merge coalesces them server-side too); the 50ms
        // gate cuts the number of writes ~3-5x vs trickling each candidate immediately (§13).
        for (const c of batch) {
          try {
            await addCallIceCandidate(callId, pairId, mySide, c);
          } catch (e) {
            console.warn('ice candidate write failed', e);
          }
        }
      }, ICE_BATCH_MS);
    };

    pc.ontrack = (e) => {
      const track = e.track;
      // Dedup: Chrome re-fires ontrack on renegotiation when the peer re-bundles the same track under
      // a different MediaStream in the new SDP. Without this guard, the same track would be
      // re-classified (often as screen, due to the new stream ID) and added to BOTH buckets, double-
      // binding it and breaking playback + routing. Once we've classified a trackId ONCE, ignore
      // subsequent fires for it — its bucket assignment is permanent for the PC's lifetime.
      if (st.seenTrackIds.has(track.id)) {
        console.log(`[mesh] ontrack DUPLICATE them=${them} kind=${track.kind} trackId=${track.id} — already routed, ignoring`);
        return;
      }
      st.seenTrackIds.add(track.id);
      // Stream-ID-based classification: camera + mic tracks share ONE stream (the sender's
      // getUserMedia stream). Screen tracks arrive on a DIFFERENT stream (the sender's
      // getDisplayMedia stream). The first stream we see = camera/mic; any track on a different
      // stream = screen. This fixes the audio-only-peer bug (first video is screen share, not
      // camera) and correctly routes screen audio to the screen tile (plays from the same stream).
      const streamId = e.streams[0]?.id ?? null;
      let isScreen = false;
      if (streamId) {
        const firstId = firstStreamIdRef.current.get(them);
        if (!firstId) {
          firstStreamIdRef.current.set(them, streamId);
          isScreen = false;
        } else {
          isScreen = streamId !== firstId;
        }
      } else {
        // No stream associated — unlikely in our code, but guard: classify as screen if there's
        // already a first stream (any new track without a stream is a renegotiation addition).
        isScreen = firstStreamIdRef.current.has(them);
      }
      console.log(`[mesh] ontrack them=${them} kind=${track.kind} isScreen=${isScreen} trackId=${track.id} readyState=${track.readyState} muted=${track.muted} streams=${e.streams.length}`);
      const setter = isScreen ? setRemoteScreenStreams : setRemoteStreams;
      setter((prev) => {
        const existing = prev[them];
        if (existing && existing.getTracks().includes(track)) return prev;
        const s = existing ?? new MediaStream();
        s.addTrack(track);
        return { ...prev, [them]: s };
      });
      // When the sender stops sharing (removeTrack) or closes the PC, this receiver track ENDS.
      // Without this handler the bucket keeps a frozen/muted track forever, leaving a stale
      // "screen-share" tile even after the share has actually stopped.
      track.addEventListener('ended', () => {
        console.log(`[mesh] track ENDED them=${them} kind=${track.kind} isScreen=${isScreen} trackId=${track.id}`);
        setter((prev) => {
          const existing = prev[them];
          if (!existing || !existing.getTracks().includes(track)) return prev;
          const remaining = existing.getTracks().filter((t) => t !== track);
          const next = { ...prev };
          if (remaining.length === 0) delete next[them];
          else next[them] = new MediaStream(remaining);
          return next;
        });
      });
    };

    pc.onconnectionstatechange = () => {
      console.log(`[mesh] connectionstatechange them=${them} state=${pc.connectionState}`);
      if (pc.connectionState === 'failed') {
        console.warn(`[mesh] peer connection FAILED: them=${them} — closing`);
        closePeer(them);
      }
    };

    pc.oniceconnectionstatechange = () => {
      console.log(`[mesh] iceconnectionstatechange them=${them} state=${pc.iceConnectionState}`);
      // ICE failed → real network death. Restarts are rare with full-mesh; safer to close so the
      // roster doc doesn't list a half-dead peer. (Roster subscription will NOT re-wire unless the
      // roster doc changes again — closePeer deletes the peer entry so a re-join is required.)
      if (pc.iceConnectionState === 'failed') {
        console.warn(`[mesh] ICE failed — closing peer them=${them}`);
        closePeer(them);
      }
    };

    st.unsub = subscribeToCallSignals(callId, pairId, (sig) => {
      console.log(`[mesh] signal arrived them=${them} pairId=${pairId} offerA=${!!sig.offerA} offerB=${!!sig.offerB} answerA=${!!sig.answerA} answerB=${!!sig.answerB} candsA=${(sig.candidatesFromA ?? []).length} candsB=${(sig.candidatesFromB ?? []).length} mySide=${mySide} processing=${st.processing} sigState=${pc.signalingState}`);
      // Serialize signal processing: Firestore onSnapshot fires bursts when offers/candidates
      // stream in. We DON'T drop snapshots during processing — we STASH the latest one and re-
      // process it after the in-flight handler finishes. The old "return on processing" guard
      // silently swallowed the snapshot containing the peer's offer if it landed during a
      // candidate-apply loop, stalling negotiation forever.
      if (st.processing) {
        console.log('[mesh] signal handler: STASHED (already processing) — will reprocess after current finishes');
        st.pendingSignal = sig;
        return;
      }
      st.processing = true;
      void (async () => {
        const drainPendingCandidates = async () => {
          if (st.pendingCandidates.length === 0) return;
          const batch = st.pendingCandidates;
          st.pendingCandidates = [];
          console.log(`[mesh] draining ${batch.length} buffered ICE candidates them=${them}`);
          for (const c of batch) {
            try {
              await pc.addIceCandidate(c);
            } catch (e) {
              if (!st.ignoreOffer) console.warn('[mesh] addIceCandidate (drained) failed', e);
            }
          }
        };
        const processSignal = async (sig: CallSignalDoc) => {
          // PER-SIDE signaling: each peer writes its OWN side's offer/answer and reads the OTHER
          // side's. So the peer's offer/answer live in the field I did NOT write. This is the glare
          // fix — two simultaneous offers land in offerA + offerB (never one shared field), so
          // perfect negotiation's polite-rollback always has the peer's offer available to apply and
          // the leave/rejoin deadlock can't happen. The field NAME encodes who wrote it, so there is
          // no separate offerFrom/answerFrom guard: a doc field I did NOT write is, by definition,
          // the peer's — a stale own-written offer can't reach this branch.
          const peerOffer = mySide === 'A' ? sig.offerB : sig.offerA;
          const peerOfferSdp = peerOffer?.sdp ?? null;
          // OFFER — apply the PEER's offer if it's new.
          if (peerOfferSdp && peerOfferSdp !== st.appliedOfferSdp) {
            console.log(`[mesh] applying REMOTE OFFER them=${them} offerLen=${peerOfferSdp.length} side=${mySide === 'A' ? 'B' : 'A'} sigState=${pc.signalingState}`);
            st.appliedOfferSdp = peerOfferSdp;
            const collision = st.makingOffer || pc.signalingState !== 'stable';
            st.ignoreOffer = !polite && collision; // impolite ignores a colliding offer
            if (st.ignoreOffer) {
              console.log('[mesh] ignoring colliding offer (impolite)');
              return;
            }
            if (collision) {
              console.log('[mesh] rolling back in-flight offer (polite)');
              try {
                await pc.setLocalDescription({ type: 'rollback' }); // polite yields its in-flight offer
              } catch {
                /* no-op if already stable */
              }
            }
            // Defense-in-depth: a malformed/incompatible offer MUST NOT brick the entire session.
            // Catch, log, and skip — peer will try again on the next offer cycle. Without this, a
            // single bad setRemoteDescription threw out of the whole handler and the processing
            // lock was released but the peer never advanced past negotiation.
            try {
              await pc.setRemoteDescription(peerOffer!);
            } catch (e) {
              console.warn(`[mesh] setRemoteDescription(offer) SKIPPED — incompatible SDP them=${them} sigState=${pc.signalingState}:`, (e as Error)?.message ?? e);
              return;
            }
            // Apply any ICE candidates that arrived BEFORE the offer (they were buffered in
            // pendingCandidates because addIceCandidate requires a remote description first).
            await drainPendingCandidates();
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            st.negotiated = true; // Set BEFORE writeCallAnswer so the spurious renegotiationneeded can't slip past the guard
            st.appliedAnswerSdp = answer.sdp ?? null; // don't reprocess our own answer below
            const ansSdp = mungeScreenAudioSdp(pc.localDescription?.sdp ?? '', screenAudioMidsOf(st)); // [BUG B] screen audio → music mode
            console.log(`[mesh] answer written to Firestore pairId=${pairId} answerLen=${ansSdp.length} mySide=${mySide}`);
            await writeCallAnswer(callId, pairId, { type: pc.localDescription!.type, sdp: ansSdp }, mySide);
            // [BUG A] Screen-orphan recovery. If WE are screen-sharing but just ANSWERED a camera-only
            // offer (the rejoin-glare case, or the viewer's offer simply landed first), our screen
            // transceivers had no m-line to bind to and were silently dropped from this answer — they
            // never reach the peer. negotiated=true would then permanently suppress the renegotiation
            // that adds them, so the rejoined viewer never sees the still-live share. Re-offer ONCE to
            // put the screen back in the SDP; the peer is now stable + cooperative and will answer,
            // firing its ontrack for the screen. The currentDirection==null gate flips false once the
            // peer's answer assigns a direction, and screenReofferAttempts<1 hard-caps it — no loop.
            if (
              mediaRef.current.screenSharing &&
              st.screenReofferAttempts < 1 &&
              st.screenTransceivers.some((tx) => tx.currentDirection == null)
            ) {
              st.screenReofferAttempts++;
              try {
                st.negotiated = false;
                st.makingOffer = true;
                await pc.setLocalDescription();
                st.myOfferSdp = pc.localDescription?.sdp ?? null;
                const reoffSdp = mungeScreenAudioSdp(pc.localDescription?.sdp ?? '', screenAudioMidsOf(st));
                console.log(`[mesh] screen-orphan recovery re-offer them=${them} pairId=${pairId} offerLen=${reoffSdp.length}`);
                await writeCallOffer(callId, pairId, { type: pc.localDescription!.type, sdp: reoffSdp }, polite ? 'polite' : 'impolite', mySide);
                st.negotiated = true; // close the have-local-offer window until the peer's answer re-confirms
              } catch (e) {
                console.error('[mesh] screen-orphan recovery re-offer failed', e);
              } finally {
                st.makingOffer = false;
              }
            }
          }
          // ANSWER to my offer — the PEER's answer lives in the side I did NOT write. Same own-side
          // guarantee as the offer: I only ever read the other side's answer, so I can never re-apply
          // my own. Dedup via appliedAnswerSdp + the have-local-offer (non-stable) guard.
          const peerAnswer = mySide === 'A' ? sig.answerB : sig.answerA;
          const peerAnswerSdp = peerAnswer?.sdp ?? null;
          if (
            peerAnswerSdp &&
            peerAnswerSdp !== st.appliedAnswerSdp &&
            pc.signalingState !== 'stable'
          ) {
            console.log(`[mesh] applying REMOTE ANSWER them=${them} answerLen=${peerAnswerSdp.length} side=${mySide === 'A' ? 'B' : 'A'} sigState=${pc.signalingState}`);
            st.appliedAnswerSdp = peerAnswerSdp;
            try {
              await pc.setRemoteDescription(peerAnswer!);
            } catch (e) {
              console.warn(`[mesh] setRemoteDescription(answer) SKIPPED — incompatible SDP them=${them} sigState=${pc.signalingState}:`, (e as Error)?.message ?? e);
              // Roll myPC back to stable so the NEXT offer (real) can succeed. Without this we'd
              // be stuck in have-local-offer forever unable to accept any future answer.
              try {
                await pc.setLocalDescription({ type: 'rollback' });
              } catch {
                /* already stable or wrong state — no-op */
              }
              return;
            }
            st.negotiated = true; // initial exchange complete — suppress spurious renegotiationneeded
            console.log(`[mesh] remote answer applied — negotiated=true them=${them}`);
            // Answer landed → drain any ICE candidates buffered while in have-local-offer.
            await drainPendingCandidates();
          }
          // ICE candidates from the peer's side (the array I did NOT write).
          const peerCandidates = (mySide === 'A' ? sig.candidatesFromB : sig.candidatesFromA) ?? [];
          const newCount = peerCandidates.length - st.appliedCandidateCount;
          if (newCount > 0) {
            console.log(`[mesh] applying ICE candidates them=${them} new=${newCount} total=${peerCandidates.length} hasRemoteDesc=${pc.remoteDescription != null}`);
          }
          for (let i = st.appliedCandidateCount; i < peerCandidates.length; i++) {
            try {
              await pc.addIceCandidate(peerCandidates[i]);
            } catch (e) {
              const msg = (e as Error)?.message ?? '';
              // No remote description yet — buffer for after setRemoteDescription. The OLD behavior
              // marked these as "applied" and moved on, losing them PERMANENTLY — ICE then never
              // completed even after the offer later landed. Drained at offer/answer-apply above.
              if (pc.remoteDescription == null || /remote description/i.test(msg)) {
                st.pendingCandidates.push(peerCandidates[i]);
              } else if (!st.ignoreOffer) {
                console.warn('[mesh] addIceCandidate failed', e);
              }
            }
          }
          st.appliedCandidateCount = peerCandidates.length;
        };
        try {
          await processSignal(sig);
          // Re-process any snapshot that was stashed while we were busy. We loop in case the
          // stashed snapshot itself triggered writes that produced another stashed snapshot.
          while (st.pendingSignal) {
            const next = st.pendingSignal;
            st.pendingSignal = null;
            console.log(`[mesh] re-processing STASHED signal them=${them} offerA=${!!next.offerA} offerB=${!!next.offerB} answerA=${!!next.answerA} answerB=${!!next.answerB} sigState=${pc.signalingState}`);
            await processSignal(next);
          }
        } catch (e) {
          console.error('[mesh] signal handler failed', e);
        } finally {
          st.processing = false;
        }
      })();
    });
  }, []);

  // ---- roster subscription: wire new peers, close departed ones ----
  useEffect(() => {
    if (!userId || !callDropId || status !== 'joined') return;
    activeCallDropIdRef.current = callDropId;
    const me = userId;
    const unsub = subscribeToCallRoster(callDropId, (roster) => {
      if (!roster.exists || roster.callState !== 'live') {
        console.log(`[mesh] roster: call not live exists=${roster.exists} callState=${roster.callState}`);
        // The call ended (last-leave cascade deleted the doc, or state flipped). Tear down locally.
        return;
      }
      const uids = roster.participantUids.filter((u) => u !== me);
      console.log(`[mesh] roster updated participants=[${roster.participantUids.join(',')}] others=[${uids.join(',')}] existingPeers=[${Array.from(peersRef.current.keys()).join(',')}]`);
      const previous = rosterUidsRef.current;
      rosterUidsRef.current = uids;
      setParticipantUids(uids);
      // CLOSE peers that VANISHED from the roster. The previous code deliberately skipped this to
      // avoid closing+re-wiring during roster flap (60s reap-stale cycle), but it broke leave+rejoin
      // semantics: when a peer INTENTIONALLY leaves, /api/call/leave removes them from
      // callParticipantUids, but their STALE PC stayed in our peersRef with `negotiated=true`. When
      // they rejoined with a FRESH PC + a fresh offer, our stale PC's transceiver layout didn't
      // match the new offer's m-lines, setRemoteDescription was SKIPPED ("m-line order doesn't
      // match"), and the rejoined peer's media never flowed — the call was dead until BOTH peers
      // hung up and recreated the call. Closing on roster removal gives a fresh wirePeer on reap-
      // pearance (new PC, fresh negotiation). The reap-stale flap concern is moot because the
      // reaper only removes uids after 60s of no heartbeat — a true gap, not a transient flap.
      for (const gone of previous) {
        if (!uids.includes(gone)) {
          console.log(`[mesh] roster removed them=${gone} — closing stale peer`);
          closePeer(gone);
        }
      }
      // Wire any NEW peers that appeared in the roster (their wirePeer awaits resetSignalDoc
      // before subscribing, so they always start from a clean slate).
      for (const them of uids) wirePeer(them, callDropId, me);
    });
    rosterUnsubRef.current = unsub;
    return () => {
      unsub();
      rosterUnsubRef.current = null;
    };
  }, [userId, callDropId, status, wirePeer, closePeer]);

  // ---- heartbeat (30s) — serverTimestamp sentinel via heartbeatCallPresence ----
  useEffect(() => {
    if (!userId || !callDropId || status !== 'joined') return;
    void heartbeatCallPresence(callDropId, userId).catch(() => {});
    const t = setInterval(
      () => void heartbeatCallPresence(callDropId, userId).catch(() => {}),
      HEARTBEAT_MS,
    );
    heartbeatTimerRef.current = t;
    return () => {
      clearInterval(t);
      heartbeatTimerRef.current = null;
    };
  }, [userId, callDropId, status]);

  // ---- presence observer → reap stale peers (>60s no heartbeat). Fail-closed server-side. ----
  useEffect(() => {
    if (!userId || !callDropId || status !== 'joined') return;
    const unsub = subscribeToCallPresence(callDropId, (entries) => {
      const now = Date.now();
      for (const e of entries) {
        if (e.uid === userId) continue;
        if (now - e.lastSeenMs > STALE_PRESENCE_MS) {
          void reapStaleCallRoute(callDropId, e.uid).catch(() => {}); // best-effort
        }
      }
    });
    presenceUnsubRef.current = unsub;
    return () => {
      unsub();
      presenceUnsubRef.current = null;
    };
  }, [userId, callDropId, status]);

  // ---- teardown (STRICT ORDER: media before signaling before roster) ----
  const teardown = useCallback(
    async (callId: string) => {
      // 1. stop renegotiation/ICE-write timers + the 30s heartbeat interval
      if (heartbeatTimerRef.current) {
        clearInterval(heartbeatTimerRef.current);
        heartbeatTimerRef.current = null;
      }
      for (const p of peersRef.current.values()) {
        if (p.iceTimer) clearTimeout(p.iceTimer);
      }
      // 2. close every peer connection
      for (const them of Array.from(peersRef.current.keys())) closePeer(them);
      // 3. release local camera+mic (stop tracks AND clear the stream ref) so the NEXT call's
      //    acquire()/adoptStream() captures FRESH tracks. The media hook is mounted ONCE above the
      //    modal (so minimize never drops media) and therefore persists across calls — stopping the
      //    tracks WITHOUT clearing the ref left acquire()'s `if (streamRef.current) return ...`
      //    short-circuit handing the DEAD stream to every call after the first (mic/camera ship ended
      //    tracks → the call works once, then is dead until a hard refresh zeroes the ref).
      mediaRef.current.releaseStream();
      // Stop screen share via the proper helper (not a raw track.stop()) so the screenSharing flag +
      // screenStream reference are ALSO cleared. A bare stop() kills the OS capture but leaves the app
      // believing it's still sharing — on rejoin the dead stream is re-adopted and pushed to peers, the
      // "screen sharing" indicator stays on with no picture, and the call is wedged (the phantom bug).
      mediaRef.current.stopScreenShare();
      // 4. unsubscribe ALL Firestore listeners (per-pair signals are closed inside closePeer; roster
      //    + presence here)
      if (rosterUnsubRef.current) {
        rosterUnsubRef.current();
        rosterUnsubRef.current = null;
      }
      if (presenceUnsubRef.current) {
        presenceUnsubRef.current();
        presenceUnsubRef.current = null;
      }
      setRemoteStreams({});
      setRemoteScreenStreams({});
      setParticipantUids([]);
      // 5. POST /api/call/leave (transactional; may delete the doc if last leaver)
      try {
        await leaveCallRoute(callId);
      } catch (e) {
        console.warn('leave route failed', e);
      }
    },
    [closePeer],
  );

  // ---- unmount / callDropId change → teardown (once) ----
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
        // keepalive lets the request outlive the page tear-down (best-effort; the route is idempotent)
        void fetch('/api/call/leave', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
          body: JSON.stringify({ callDropId: id }),
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
    async (id: string) => {
      if (!userId) {
        setError('Sign in to join the call.');
        throw new Error('Sign in to join the call.');
      }
      setStatus('joining');
      setError(null);
      leftRef.current = false;
      activeCallDropIdRef.current = id;
      // Defensive: guarantee no stale screen-share state leaks into the new call. teardown() clears it
      // on leave; a no-op stopScreenShare() here means screenSharing can never be stuck true on join.
      mediaRef.current.stopScreenShare();
      // local media: the adopted preview stream if the host just handed one off, else acquire fresh
      // (a joiner has no preview).
      if (adoptedPreviewRef.current) {
        media.adoptStream(adoptedPreviewRef.current);
        adoptedPreviewRef.current = null;
      } else {
        const s = await media.acquire();
        if (!s) {
          setStatus('idle'); // error already surfaced by useCallMedia
          activeCallDropIdRef.current = null;
          return;
        }
      }
      try {
        await joinCallRoute(id); // throws 409 with the exact capacity message
        console.log(`[mesh] joined call id=${id}`);
        setStatus('joined');
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Failed to join the call.';
        setError(msg);
        setStatus('idle');
        activeCallDropIdRef.current = null;
        // release the local media we just acquired/adopted (stop + clear ref so a retry acquires fresh)
        mediaRef.current.releaseStream();
        throw e;
      }
    },
    [userId, media],
  );

  const leaveCall = useCallback(
    async (opts?: { minimize?: boolean }) => {
      if (opts?.minimize) return; // minimize is a page-level UI state, not an actual leave
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

  const toggleScreenShare = useCallback(async () => {
    const hasCamera = !!media.stream?.getVideoTracks().length;
    const myUid = userId;
    console.log(`[mesh] toggleScreenShare screenSharing=${media.screenSharing} hasCamera=${hasCamera} peerCount=${peersRef.current.size} myUid=${myUid ?? 'null'}`);
    if (media.screenSharing) {
      // STOP: remove each screen transceiver added during START (or adopted by wirePeer before
      // join). removeTrack makes the receiver's screen tracks END (our onended listener cleans up
      // the remote screen bucket). Then renegotiate to update SDP. The camera transceiver is
      // untouched — camera/mic keep streaming through the original transceiver the whole time.
      if (peersRef.current.size === 0) {
        console.log(`[mesh] STOP screen share — no peers; screen stream will be released`);
      }
      for (const [them, p] of peersRef.current.entries()) {
        if (p.screenTransceivers.length === 0) {
          console.log(`[mesh] STOP screen share them=${them} — no tracked screen transceivers; nothing to remove`);
          continue;
        }
        console.log(`[mesh] STOP screen share them=${them} — removing ${p.screenTransceivers.length} screen transceivers`);
        for (const tx of p.screenTransceivers) {
          try {
            p.pc.removeTrack(tx.sender);
          } catch (e) {
            console.warn(`[mesh] STOP — removeTrack failed them=${them} kind=${tx.receiver?.track?.kind}`, e);
          }
        }
        p.screenTransceivers = [];
        // removeTrack fires onnegotiationneeded — same race-suppression as START: set makingOffer
        // synchronously BEFORE awaiting, so the queued onnegotiationneeded bails and we own the offer.
        // Like START, if we're stuck in have-local-offer from a prior unfinished negotiation we
        // ROLLBACK first so the screen-removal offer can actually be written.
        try {
          if (p.pc.signalingState === 'have-local-offer') {
            console.log(`[mesh] STOP — rolling back in-flight offer to renegotiate screen removal them=${them}`);
            try {
              await p.pc.setLocalDescription({ type: 'rollback' });
              p.myOfferSdp = null;
            } catch {
              /* no-op */
            }
          }
          if (p.pc.signalingState === 'stable' && !p.makingOffer) {
            p.negotiated = false;
            p.makingOffer = true;
            await p.pc.setLocalDescription();
            p.myOfferSdp = p.pc.localDescription?.sdp ?? null;
            const stopSdp = mungeScreenAudioSdp(p.pc.localDescription?.sdp ?? '', screenAudioMidsOf(p)); // [BUG B] screen audio → music mode
            console.log(`[mesh] STOP — offer written pairId=${p.pairId} offerLen=${stopSdp.length} mySide=${p.mySide}`);
            await writeCallOffer(p.callId, p.pairId, { type: p.pc.localDescription!.type, sdp: stopSdp }, p.polite ? 'polite' : 'impolite', p.mySide);
          } else {
            console.log(`[mesh] STOP — manual renegotiate SKIPPED sigState=${p.pc.signalingState} makingOffer=${p.makingOffer}; onnegotiationneeded will handle`);
          }
        } catch (e) {
          console.error(`[mesh] STOP renegotiate failed`, e);
        } finally {
          p.makingOffer = false;
        }
      }
      media.stopScreenShare();
    } else {
      // START: add each screen track (video + any picked-up audio) as a NEW transceiver so the
      // receiver fires ontrack per track and they land in remoteScreenStreams[uid] (NOT replacing
      // the camera transceiver → no shared identity; previous replaceTrack approach put screen
      // pixels into the camera tile and dropped the screen audio on the floor entirely).
      const sc = await media.startScreenShare();
      console.log(`[mesh] startScreenShare returned hasStream=${!!sc} screenTracks=${sc?.getTracks().length ?? 0} video=${sc?.getVideoTracks().length ?? 0} audio=${sc?.getAudioTracks().length ?? 0}`);
      if (sc) {
        if (peersRef.current.size === 0) {
          // No peers yet — store the screen stream; when a peer joins, wirePeer adopts it via
          // pc.addTransceiver(screen) and onnegotiationneeded fires automatically. No manual work here.
          console.log(`[mesh] START screen share — no peers yet; screen stream stored, will be adopted by next wirePeer`);
        }
        for (const [them, p] of peersRef.current.entries()) {
          // addTransceiver schedules onnegotiationneeded asynchronously. Our manual renegotiate
          // block sets makingOffer=true synchronously (before any await), so the queued
          // onnegotiationneeded bails on the makingOffer check and doesn't fire a 2nd duplicate
          // offer. This avoids the race that previously produced wrong-state crashes.
          const screenTracks = sc.getTracks();
          const addedTx: RTCRtpTransceiver[] = [];
          for (const t of screenTracks) {
            const tx = p.pc.addTransceiver(t, { direction: 'sendrecv', streams: [sc] });
            if (t.kind === 'audio') raiseScreenAudioBitrate(tx.sender); // [BUG B] screen audio is media, not voice
            addedTx.push(tx);
            console.log(`[mesh] START — addTransceiver them=${them} kind=${t.kind} mid=${tx.mid ?? 'pending'} trackId=${t.id}`);
          }
          p.screenTransceivers = [...p.screenTransceivers, ...addedTx];
          // Manual renegotiate. If we're stuck in have-local-offer (a prior offer that the peer
          // never answered — common after a collision storm at join), ROLLBACK to stable first so
          // our fresh offer (which includes the new screen transceivers) can be created and sent.
          // Without this, the new offer bails on the `sigState !== 'stable'` guard and the screen
          // tracks never make it to the remote peer.
          try {
            if (p.pc.signalingState === 'have-local-offer') {
              console.log(`[mesh] START — rolling back in-flight offer to renegotiate with screen tracks them=${them}`);
              try {
                await p.pc.setLocalDescription({ type: 'rollback' });
                p.myOfferSdp = null;
              } catch {
                /* no-op */
              }
            }
            if (p.pc.signalingState === 'stable' && !p.makingOffer) {
              p.negotiated = false;
              p.makingOffer = true;
              await p.pc.setLocalDescription();
              p.myOfferSdp = p.pc.localDescription?.sdp ?? null;
              const startSdp = mungeScreenAudioSdp(p.pc.localDescription?.sdp ?? '', screenAudioMidsOf(p)); // [BUG B] screen audio → music mode
              console.log(`[mesh] START — offer written pairId=${p.pairId} offerLen=${startSdp.length} mySide=${p.mySide}`);
              await writeCallOffer(p.callId, p.pairId, { type: p.pc.localDescription!.type, sdp: startSdp }, p.polite ? 'polite' : 'impolite', p.mySide);
            } else {
              console.log(`[mesh] START — manual renegotiate SKIPPED sigState=${p.pc.signalingState} makingOffer=${p.makingOffer}; onnegotiationneeded will handle`);
            }
          } catch (e) {
            console.error(`[mesh] START renegotiate failed`, e);
          } finally {
            p.makingOffer = false;
          }
        }
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
    error: error || media.error,
    memberName,
    adoptPreviewStream,
    joinCall,
    leaveCall,
    toggleMic: media.toggleMic,
    toggleCamera: media.toggleCamera,
    toggleScreenShare,
  };
}

export type CallMeshState = ReturnType<typeof useCallMesh>;
