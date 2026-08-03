// Live-call signaling — Firestore as the WebRTC signaling bus for full-mesh P2P calls (≤4 people).
//
// Two subcollections under a call drop (drops/{callDropId}/...):
//   callSignals/{pairId}  — per-PAIR SDP offer/answer + coalesced ICE candidates. pairId is
//                           DETERMINISTIC: [uidA, uidB].sort().join('__') — both ends compute the
//                           same id, so a pair shares exactly one doc. Fields:
//                           { offerA, offerB, answerA, answerB, candidatesFromA, candidatesFromB, politeRole, updatedAt }.
//                           PER-SIDE offer/answer: each peer writes its OWN side (offerA/answerA if it
//                           is side A, else offerB/answerB) and reads the OTHER side's. Two simultaneous
//                           offers (perfect-negotiation GLARE) then land in SEPARATE fields and never
//                           overwrite each other — this is what kills the leave/rejoin deadlock. "A" =
//                           the lexicographically-SMALLER uid; "B" = the larger. Each peer
//                           appends its candidates to its OWN side via arrayUnion (NEVER one addDoc
//                           per candidate — quota-minimal on the free Spark plan). politeRole is
//                           also derived from the sort (smaller uid = POLITE) for perfect negotiation.
//   callPresence/{uid}    — per-PARTICIPANT liveness. { lastSeen: serverTimestamp() } SENTINEL,
//                           never a client Date (avoids the cross-device clock-skew bug already
//                           fixed for workspace presence/typing/seen-by).
//
// All listeners use the cancelled-flag + swallowed-error + defensive-field-parse pattern from
// lib/presence.ts: the listener NEVER throws, and malformed docs are skipped silently.

import {
  collection,
  doc,
  onSnapshot,
  setDoc,
  serverTimestamp,
  arrayUnion,
} from 'firebase/firestore';
import { db } from './firebase';

/** Deterministic pair id — both peers compute the same id for their shared signal doc. */
export function callPairId(uidA: string, uidB: string): string {
  return [uidA, uidB].sort().join('__');
}

/**
 * Perfect-negotiation role for a pair: the lexicographically-SMALLER uid is POLITE (yields on
 * negotiation collision / rolls back an in-flight offer); the larger is IMPOLITE. Deterministic, so
 * both ends agree without a handshake — kills "glare" (both peers offering at once).
 */
export function callPoliteRole(uidA: string, uidB: string): 'polite' | 'impolite' {
  return uidA < uidB ? 'polite' : 'impolite';
}

/** Which side-array this peer writes its ICE candidates to: 'A' if it's the smaller uid, else 'B'. */
export function callMySide(me: string, them: string): 'A' | 'B' {
  return me < them ? 'A' : 'B';
}

export interface CallSignalDoc {
  /** Offer written by side A (the lexicographically-SMALLER uid). A peer on side A WRITES this and
   *  reads offerB; a peer on side B writes offerB and reads THIS. Per-side fields mean two
   *  simultaneous offers (perfect-negotiation GLARE) land in different fields and never clobber —
   *  the polite/impolite rollback then always has the peer's offer available to apply. The field
   *  NAME encodes who wrote it, so no separate offerFrom tag is needed. */
  offerA?: RTCSessionDescriptionInit | null;
  offerB?: RTCSessionDescriptionInit | null;
  /** Answer written by side A / side B respectively. A peer writes its OWN side's answer when it is
   *  the ANSWERER, and reads the OTHER side's answer to its own offer. */
  answerA?: RTCSessionDescriptionInit | null;
  answerB?: RTCSessionDescriptionInit | null;
  candidatesFromA?: RTCIceCandidateInit[]; // candidates whose sender is the lexicographically-SMALLER uid
  candidatesFromB?: RTCIceCandidateInit[]; // candidates whose sender is the LARGER uid
  politeRole?: 'polite' | 'impolite';
  updatedAt?: number; // server-time ms (parsed defensively; undefined while pending)
}

/**
 * Subscribe to one pair's signal doc via a PLAIN onSnapshot (no decryption — SDP/ICE aren't secret;
 * the media is end-to-end encrypted by DTLS-SRTP between peers). Defensive parse: a console-injected
 * or future-schema doc can't crash the listener. Returns the empty doc shape when the doc is absent
 * (the pair hasn't negotiated yet) so callers can diff cleanly.
 */
export function subscribeToCallSignals(
  callDropId: string,
  pairId: string,
  cb: (signal: CallSignalDoc) => void,
): () => void {
  let cancelled = false;
  const unsub = onSnapshot(
    doc(db, 'drops', callDropId, 'callSignals', pairId),
    (snap) => {
      if (cancelled) return;
      if (!snap.exists()) {
        cb({});
        return;
      }
      const data = snap.data() as Record<string, unknown>;
      const parseCandidates = (v: unknown): RTCIceCandidateInit[] => {
        if (!Array.isArray(v)) return [];
        return v.filter(
          (c): c is RTCIceCandidateInit =>
            !!c && typeof c === 'object' && typeof (c as RTCIceCandidateInit).candidate === 'string',
        );
      };
      const updatedAtRaw = (data as { updatedAt?: { toMillis?: unknown } }).updatedAt;
      const updatedAt =
        typeof updatedAtRaw?.toMillis === 'function'
          ? (updatedAtRaw as { toMillis: () => number }).toMillis()
          : undefined;
      const politeRaw = (data as { politeRole?: unknown }).politeRole;
      // Parse an offer/answer field defensively: it must be a plain { type, sdp } object (we always
      // normalize to {type, sdp} before writing). A console-injected or future-schema value can't
      // crash the listener — non-objects / missing strings become null.
      const parseSdp = (v: unknown): RTCSessionDescriptionInit | null => {
        if (!v || typeof v !== 'object') return null;
        const o = v as { type?: unknown; sdp?: unknown };
        if (typeof o.type !== 'string' || typeof o.sdp !== 'string') return null;
        return { type: o.type as RTCSessionDescriptionInit['type'], sdp: o.sdp };
      };
      cb({
        offerA: parseSdp((data as { offerA?: unknown }).offerA),
        offerB: parseSdp((data as { offerB?: unknown }).offerB),
        answerA: parseSdp((data as { answerA?: unknown }).answerA),
        answerB: parseSdp((data as { answerB?: unknown }).answerB),
        candidatesFromA: parseCandidates(data.candidatesFromA),
        candidatesFromB: parseCandidates(data.candidatesFromB),
        politeRole: politeRaw === 'polite' || politeRaw === 'impolite' ? politeRaw : undefined,
        updatedAt,
      });
    },
    () => {
      // Swallow listener errors silently — never throw (mirrors lib/presence.ts).
    },
  );
  return () => {
    cancelled = true;
    unsub();
  };
}

/**
 * ATOMIC clean-slate wipe for the start of a new PC session on a reused pair doc. Because callDropId
 * = call-{workspaceId} is FIXED per workspace, every test REUSES the same pair signal doc (same
 * deterministic pairId). A prior session leaves behind a stale offer/answer + this peer's OWN
 * candidate array whose SDP references the OLD PC's ICE ufrag / transceiver layout. If a fresh
 * wirePeer subscribes before its first offer write lands, the FIRST snapshot carries all that stale
 * state — applying it to a fresh PC crashes with "Incompatible send direction" / "order of m-lines"
 * / "SSL role". By wiping FIRST (awaited) and only THEN subscribing + adding tracks, the first
 * snapshot we receive is either the wiped-empty state (no-op) or the peer's fresh offer — never
 * stale SDP.
 *
 * Wipes ONLY this peer's OWN candidate array (never the peer's). ICE gathering is a one-shot sweep
 * per PC — onicecandidate never re-fires — so a both-sides []-wipe here RACES the peer's in-flight
 * arrayUnion candidate writes: if this setDoc-merge lands after the peer just wrote its fresh
 * candidates, those candidates are deleted for the life of the PC and the call connects "on paper"
 * but has no media (the intermittent-silent-audio bug on join/rejoin). The peer's stale candidates
 * are HARMLESS (they fail with a wrong-ufrag error and are caught/dropped by addIceCandidate). We DO
 * keep nulling all four offer/answer fields — that SDP clean-slate is what prevents the crash above.
 *
 * Uses ONLY fields in the callSignals UPDATE allowlist (offerA/offerB/answerA/answerB + the two
 * candidate arrays + politeRole + updatedAt) — see firestore.rules.
 */
export async function resetSignalDoc(
  callDropId: string,
  pairId: string,
  politeRole: 'polite' | 'impolite',
  mySide: 'A' | 'B',
): Promise<void> {
  const myCandidatesField = mySide === 'A' ? 'candidatesFromA' : 'candidatesFromB';
  await setDoc(
    doc(db, 'drops', callDropId, 'callSignals', pairId),
    {
      offerA: null,
      offerB: null,
      answerA: null,
      answerB: null,
      [myCandidatesField]: [],
      politeRole,
      updatedAt: serverTimestamp(),
    },
    { merge: true },
  );
}

/**
 * Write (replace) THIS peer's offer into its OWN side field (offerA if mySide==='A', else offerB),
 * stamping the deterministic politeRole. setDoc+merge so the doc is created if absent and the peer's
 * fields are preserved. Because each peer writes a DIFFERENT field, two simultaneous offers
 * (perfect-negotiation glare) coexist — neither clobbers the other, which is what unblocks the
 * leave/rejoin deadlock the shared single `offer` field caused.
 */
export async function writeCallOffer(
  callDropId: string,
  pairId: string,
  offer: RTCSessionDescriptionInit,
  politeRole: 'polite' | 'impolite',
  mySide: 'A' | 'B',
): Promise<void> {
  // Normalize to a PLAIN object before setDoc. Callers pass pc.localDescription, which is an
  // RTCSessionDescription CLASS INSTANCE — Firestore's serializer only accepts plain maps/primitives and
  // rejects the instance ("Unsupported field value: a custom RTCSessionDescription object"), which blocked
  // every offer/answer write and so ALL call media. {type, sdp} exist on both the instance and the Init
  // type, so this is correct whichever the caller passes. sdp is always defined for a real local description;
  // the ?? '' only satisfies `string | undefined`.
  const plain = { type: offer.type, sdp: offer.sdp ?? '' };
  const offerField = mySide === 'A' ? 'offerA' : 'offerB';
  const myAnswerField = mySide === 'A' ? 'answerA' : 'answerB';
  // A new offer starts a fresh negotiation round, so clear OUR OWN answer field (a stale own-answer
  // from a prior round is meaningless now that we're offering). We do NOT touch the PEER's answer
  // field — the peer overwrites its own answer when it answers this offer, and processSignal dedups
  // (peerAnswerSdp !== appliedAnswerSdp) so a leftover is never re-applied.
  //
  // We deliberately do NOT wipe ANY candidate array here. ICE gathering is a one-shot sweep per PC
  // (onicecandidate never re-fires for a given PC), so a []-wipe of either array RACES the peer's
  // in-flight arrayUnion candidate writes: if this setDoc-merge lands after the peer just wrote its
  // fresh candidates, those candidates are permanently deleted — no ICE pairs form and the call
  // connects "on paper" but has no media (the intermittent-silent-audio bug on join/rejoin). Stale
  // candidates from a prior round are HARMLESS (they fail with a wrong-ufrag error and are caught/
  // dropped by addIceCandidate), and the fresh-PC clean slate is already handled by resetSignalDoc's
  // OWN-side wipe. So offers write only SDP — never candidates.
  await setDoc(
    doc(db, 'drops', callDropId, 'callSignals', pairId),
    {
      [offerField]: plain,
      politeRole,
      [myAnswerField]: null,
      updatedAt: serverTimestamp(),
    },
    { merge: true },
  );
}

/** Write (replace) THIS peer's answer into its OWN side field (answerA if mySide==='A', else
 *  answerB). The peer reads the side it did NOT write to pick up this answer to its offer. */
export async function writeCallAnswer(
  callDropId: string,
  pairId: string,
  answer: RTCSessionDescriptionInit,
  mySide: 'A' | 'B',
): Promise<void> {
  // Same normalization as writeCallOffer — Firestore rejects the RTCSessionDescription class instance;
  // write a plain {type, sdp} object instead.
  const plain = { type: answer.type, sdp: answer.sdp ?? '' };
  const answerField = mySide === 'A' ? 'answerA' : 'answerB';
  await setDoc(
    doc(db, 'drops', callDropId, 'callSignals', pairId),
    { [answerField]: plain, updatedAt: serverTimestamp() },
    { merge: true },
  );
}

/**
 * Append one local ICE candidate to THIS peer's side-array via arrayUnion (NEVER one addDoc per
 * candidate — quota-minimal). `mySide` ('A' = smaller uid, 'B' = larger) picks the field. setDoc+
 * merge (not updateDoc) so this works even if the offer doc hasn't landed yet (no "doc must exist").
 * The 50ms batcher in useCallMesh coalesces these into one write per flush.
 */
export async function addCallIceCandidate(
  callDropId: string,
  pairId: string,
  mySide: 'A' | 'B',
  candidate: RTCIceCandidateInit,
): Promise<void> {
  const field = mySide === 'A' ? 'candidatesFromA' : 'candidatesFromB';
  await setDoc(
    doc(db, 'drops', callDropId, 'callSignals', pairId),
    { [field]: arrayUnion(candidate), updatedAt: serverTimestamp() },
    { merge: true },
  );
}

export interface CallPresenceEntry {
  uid: string;
  lastSeenMs: number;
}

/**
 * Subscribe to ALL participants' liveness docs for a call (PLAIN onSnapshot, defensive parse —
 * lastSeen must be a real serverTimestamp or the doc is skipped). Drives the reap-stale observer
 * (a peer >60s stale gets evicted by a remaining participant's 30s tick via reapStaleCallRoute).
 */
export function subscribeToCallPresence(
  callDropId: string,
  cb: (entries: CallPresenceEntry[]) => void,
): () => void {
  let cancelled = false;
  const unsub = onSnapshot(
    collection(db, 'drops', callDropId, 'callPresence'),
    (snap) => {
      if (cancelled) return;
      const out: CallPresenceEntry[] = [];
      snap.forEach((d) => {
        const data = d.data() as { lastSeen?: { toMillis?: unknown } };
        if (typeof data.lastSeen?.toMillis !== 'function') return;
        out.push({ uid: d.id, lastSeenMs: (data.lastSeen as { toMillis: () => number }).toMillis() });
      });
      cb(out);
    },
    () => {
      // Swallow — never throw.
    },
  );
  return () => {
    cancelled = true;
    unsub();
  };
}

/** Heartbeat: write lastSeen = serverTimestamp() (SENTINEL — never a client Date) to own presence. */
export async function heartbeatCallPresence(callDropId: string, uid: string): Promise<void> {
  await setDoc(
    doc(db, 'drops', callDropId, 'callPresence', uid),
    { lastSeen: serverTimestamp() },
    { merge: true },
  );
}

export interface CallRoster {
  participantUids: string[];
  callState: string | null;
  exists: boolean;
}

/**
 * Subscribe to the call drop doc itself for the LIVE roster (callParticipantUids) + callState. The
 * mesh keys per-pair wiring off this roster and ends the call locally when callState flips off or
 * the doc is deleted (last-leave cascade). Defensive parse of the uid array (console-injected docs
 * can't smuggle a non-string uid into the mesh).
 */
export function subscribeToCallRoster(
  callDropId: string,
  cb: (roster: CallRoster) => void,
): () => void {
  let cancelled = false;
  const unsub = onSnapshot(
    doc(db, 'drops', callDropId),
    (snap) => {
      if (cancelled) return;
      if (!snap.exists()) {
        cb({ participantUids: [], callState: null, exists: false });
        return;
      }
      const data = snap.data() as { callParticipantUids?: unknown; callState?: unknown };
      const uids = Array.isArray(data.callParticipantUids)
        ? data.callParticipantUids.filter((u): u is string => typeof u === 'string')
        : [];
      cb({
        participantUids: uids,
        callState: typeof data.callState === 'string' ? data.callState : null,
        exists: true,
      });
    },
    () => {
      // Swallow — never throw.
    },
  );
  return () => {
    cancelled = true;
    unsub();
  };
}

export interface CallLimitSnapshot {
  exists: boolean;
  callState: string | null;
  trustedParticipantCount: number;
  deadlineAtMs: number | null;
  endReason: string | null;
  participantJoinedAtMs: number | null;
}

/** Subscribe to the server-owned call limit state and terminal end reason. */
export function subscribeToCallLimit(
  callDropId: string,
  uid: string,
  cb: (state: CallLimitSnapshot) => void,
): () => void {
  let cancelled = false;
  const unsub = onSnapshot(
    doc(db, 'drops', callDropId),
    (snap) => {
      if (cancelled) return;
      if (!snap.exists()) {
        cb({ exists: false, callState: null, trustedParticipantCount: 0, deadlineAtMs: null, endReason: null, participantJoinedAtMs: null });
        return;
      }
      const data = snap.data() as {
        callState?: unknown;
        trustedParticipantCount?: unknown;
        callLimitDeadlineAt?: { toMillis?: unknown } | null;
        callEndReason?: unknown;
        callParticipantJoinedAt?: Record<string, { toMillis?: unknown }> | null;
      };
      const joinedAt = data.callParticipantJoinedAt?.[uid];
      cb({
        exists: true,
        callState: typeof data.callState === 'string' ? data.callState : null,
        trustedParticipantCount: typeof data.trustedParticipantCount === 'number' ? data.trustedParticipantCount : 0,
        deadlineAtMs: typeof data.callLimitDeadlineAt?.toMillis === 'function'
          ? data.callLimitDeadlineAt.toMillis()
          : null,
        endReason: typeof data.callEndReason === 'string' ? data.callEndReason : null,
        participantJoinedAtMs: typeof joinedAt?.toMillis === 'function' ? joinedAt.toMillis() : null,
      });
    },
    () => {
      // Swallow listener errors silently — the server routes remain authoritative.
    },
  );
  return () => {
    cancelled = true;
    unsub();
  };
}
