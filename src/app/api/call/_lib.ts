// Shared helpers for the /api/call/* routes (NOT a route itself — Next.js only treats `route.ts`
// in an api segment as a handler). Keeps the auth preamble + the subcollection cascade out of the
// 4 route files.

import { NextRequest, NextResponse } from 'next/server';
import { FieldValue, Timestamp, type Firestore, type Transaction } from 'firebase-admin/firestore';
import { RoomServiceClient } from 'livekit-server-sdk';
import { getAdminAuth } from '@/lib/firebase-admin';

export const CALL_LIMIT_MS = 30 * 60 * 1000;
export const CALL_PRESENCE_STALE_MS = 60_000;
export const ABANDONED_CALL_GRACE_MS = 10 * 60 * 1000;
export const CALL_LIMIT_MESSAGE =
  'Your 30-minute call limit has been reached. You can still join a call with a trusted user.';

export type CallLimitState = {
  exists: boolean;
  live: boolean;
  participantUids: string[];
  trustedParticipantCount: number;
  deadlineMs: number | null;
  expired: boolean;
};

/**
 * Verify the Firebase Bearer token and return the caller's uid, OR a 401 NextResponse. Mirrors the
 * auth contract of /api/transcribe (the body uid is NEVER trusted — the verified token is the only
 * identity). Callers narrow with `typeof x !== 'string'`.
 */
export async function authUid(request: NextRequest): Promise<string | NextResponse> {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const idToken = authHeader.substring(7);
  try {
    const decoded = await getAdminAuth().verifyIdToken(idToken);
    return decoded.uid;
  } catch {
    return NextResponse.json({ error: 'Invalid token' }, { status: 401 });
  }
}

/**
 * Trusted-call identity is server-only. The owner is trusted even when their users doc is missing;
 * all other users must have users/{uid}.tier === 'trusted'. Any lookup failure fails closed.
 */
export async function isTrustedCallUser(db: Firestore, uid: string): Promise<boolean> {
  try {
    const ownerSnap = await db.collection('config').doc('owner').get();
    if (ownerSnap.exists && ownerSnap.data()?.uid === uid) return true;
  } catch {
    return false;
  }
  try {
    const userSnap = await db.collection('users').doc(uid).get();
    return userSnap.exists && userSnap.data()?.tier === 'trusted';
  } catch {
    return false;
  }
}

function timestampMs(value: unknown): number | null {
  if (!value || typeof value !== 'object') return null;
  const toMillis = (value as { toMillis?: unknown }).toMillis;
  return typeof toMillis === 'function'
    ? (value as { toMillis: () => number }).toMillis()
    : null;
}

export type CallLimitFields = {
  trustedParticipantCount: number;
  deadlineMs: number | null;
  callLimitDeadlineAt: Timestamp | null;
};

/**
 * Read trusted status from the same transaction snapshot as the call roster. Every read happens
 * before callers issue writes, so a tier or owner change conflicts with the transaction instead of
 * allowing limit fields derived from an older snapshot to commit.
 */
export async function getTrustedStatusMapInTransaction(
  txn: Transaction,
  db: Firestore,
  participantUids: string[],
): Promise<Map<string, boolean>> {
  const uniqueUids = [...new Set(participantUids)];
  if (uniqueUids.length === 0) return new Map();

  const ownerSnap = await txn.get(db.collection('config').doc('owner'));
  const ownerUid = ownerSnap.exists && typeof ownerSnap.data()?.uid === 'string'
    ? ownerSnap.data()?.uid
    : null;
  const statuses = new Map<string, boolean>();

  for (const uid of uniqueUids) {
    if (uid === ownerUid) {
      statuses.set(uid, true);
      continue;
    }
    const userSnap = await txn.get(db.collection('users').doc(uid));
    statuses.set(uid, userSnap.exists && userSnap.data()?.tier === 'trusted');
  }

  return statuses;
}

/**
 * Derive the server-owned limit fields from the current roster. An existing deadline is preserved,
 * including an expired one; callers must enforce an expired deadline rather than replacing it.
 */
export function deriveCallLimitFields(
  participantUids: string[],
  trustedByUid: Map<string, boolean>,
  existingDeadlineMs: number | null,
  nowMs = Date.now(),
): CallLimitFields {
  const trustedParticipantCount = participantUids.filter(
    (uid) => trustedByUid.get(uid) === true,
  ).length;
  const deadlineMs =
    trustedParticipantCount > 0
      ? null
      : existingDeadlineMs == null
        ? nowMs + CALL_LIMIT_MS
        : existingDeadlineMs;

  return {
    trustedParticipantCount,
    deadlineMs,
    callLimitDeadlineAt: deadlineMs == null ? null : Timestamp.fromMillis(deadlineMs),
  };
}

export function utcDayKey(nowMs = Date.now()): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

export function nextUtcMidnightMs(nowMs = Date.now()): number {
  const next = new Date(nowMs);
  next.setUTCHours(24, 0, 0, 0);
  return next.getTime();
}

/** Read the current user's server-only daily call lock. */
export async function getCallUsageState(
  db: Firestore,
  uid: string,
  nowMs = Date.now(),
): Promise<{ limited: boolean; resetAtMs: number }> {
  const snap = await db.collection('callUsage').doc(uid).get();
  const limited = snap.exists && snap.data()?.dayKey === utcDayKey(nowMs);
  return { limited, resetAtMs: nextUtcMidnightMs(nowMs) };
}

/** Add today's usage locks to the same transaction that ends the call. */
export function markCallUsageLimitedInTransaction(
  txn: Transaction,
  db: Firestore,
  participantUids: string[],
  trustedByUid: Map<string, boolean>,
  nowMs = Date.now(),
): void {
  const dayKey = utcDayKey(nowMs);
  const resetAt = Timestamp.fromMillis(nextUtcMidnightMs(nowMs));
  for (const uid of participantUids) {
    if (trustedByUid.get(uid) === true) continue;
    txn.set(
      db.collection('callUsage').doc(uid),
      { dayKey, limitedAt: Timestamp.fromMillis(nowMs), resetAt },
      { merge: true },
    );
  }
}

/**
 * Recalculate trusted presence and start/clear the no-trusted timer. This is intentionally outside
 * the client: tier changes made by the owner are picked up on the next call heartbeat or route call.
 */
export async function refreshCallLimitState(
  db: Firestore,
  callDropId: string,
  nowMs = Date.now(),
): Promise<CallLimitState> {
  const callRef = db.collection('drops').doc(callDropId);
  return db.runTransaction(async (txn): Promise<CallLimitState> => {
    const snap = await txn.get(callRef);
    if (!snap.exists || snap.data()?.type !== 'call') {
      return {
        exists: false,
        live: false,
        participantUids: [],
        trustedParticipantCount: 0,
        deadlineMs: null,
        expired: false,
      };
    }

    const data = snap.data() || {};
    const participantUids = Array.isArray(data.callParticipantUids)
      ? data.callParticipantUids.filter((uid): uid is string => typeof uid === 'string')
      : [];
    const live = data.callState === 'live';
    if (!live) {
      return {
        exists: true,
        live: false,
        participantUids,
        trustedParticipantCount: 0,
        deadlineMs: null,
        expired: false,
      };
    }

    const trustedByUid = await getTrustedStatusMapInTransaction(txn, db, participantUids);
    const limitFields = deriveCallLimitFields(
      participantUids,
      trustedByUid,
      timestampMs(data.callLimitDeadlineAt),
      nowMs,
    );
    txn.update(callRef, {
      trustedParticipantCount: limitFields.trustedParticipantCount,
      callLimitDeadlineAt: limitFields.callLimitDeadlineAt,
    });

    return {
      exists: true,
      live: true,
      participantUids,
      trustedParticipantCount: limitFields.trustedParticipantCount,
      deadlineMs: limitFields.deadlineMs,
      expired: limitFields.deadlineMs != null && limitFields.deadlineMs <= nowMs,
    };
  });
}

/** End an expired call exactly once. Room deletion and the terminal-doc cleanup are best effort. */
export async function enforceExpiredCall(
  db: Firestore,
  callDropId: string,
  nowMs = Date.now(),
): Promise<{ ended: boolean; participantUids: string[] }> {
  const callRef = db.collection('drops').doc(callDropId);
  const decision = await db.runTransaction(async (txn) => {
    const snap = await txn.get(callRef);
    if (!snap.exists || snap.data()?.type !== 'call' || snap.data()?.callState !== 'live') {
      return { ended: false, participantUids: [] };
    }
    const deadlineMs = timestampMs(snap.data()?.callLimitDeadlineAt);
    if (deadlineMs == null || deadlineMs > nowMs) {
      return { ended: false, participantUids: [] };
    }
    const rawUids = snap.data()?.callParticipantUids;
    const participantUids = Array.isArray(rawUids)
      ? rawUids.filter((uid): uid is string => typeof uid === 'string')
      : [];
    const trustedByUid = await getTrustedStatusMapInTransaction(txn, db, participantUids);
    const limitFields = deriveCallLimitFields(participantUids, trustedByUid, deadlineMs, nowMs);
    if (limitFields.deadlineMs == null || limitFields.deadlineMs > nowMs) {
      txn.update(callRef, {
        trustedParticipantCount: limitFields.trustedParticipantCount,
        callLimitDeadlineAt: limitFields.callLimitDeadlineAt,
      });
      return { ended: false, participantUids: [] };
    }
    txn.update(callRef, {
      callState: 'ended',
      callEndReason: 'untrusted_time_limit',
      callEndedAt: Timestamp.fromMillis(nowMs),
      updatedAt: FieldValue.serverTimestamp(),
    });
    markCallUsageLimitedInTransaction(txn, db, participantUids, trustedByUid, nowMs);
    return { ended: true, participantUids };
  });

  if (!decision.ended) return decision;
  const roomService = getLiveKitRoomService();
  if (roomService) {
    try {
      await roomService.deleteRoom(callDropId);
    } catch (error) {
      console.warn(`[call] failed to close expired LiveKit room ${callDropId}`, error);
    }
  }
  return decision;
}

/**
 * Cascade-delete a call drop's callSignals + callPresence subcollections (Firestore does NOT
 * cascade deletes). ≤6 signal docs + ≤4 presence docs per call → one batched commit each. Best-
 * effort by contract — the caller swallows errors so a cleanup blip never fails the user action.
 */
export async function cascadeCallSubcollections(db: Firestore, callDropId: string): Promise<void> {
  const subs = ['callSignals', 'callPresence'] as const;
  await Promise.all(
    subs.map(async (sub) => {
      const snap = await db.collection('drops').doc(callDropId).collection(sub).get();
      if (snap.empty) return;
      const batch = db.batch();
      snap.docs.forEach((d) => batch.delete(d.ref));
      await batch.commit();
    }),
  );
}

// ---- LiveKit roster reconciliation ----------------------------------------------------------
//
// The Firestore roster (callParticipantUids) is now a CACHE of who's in a call, used only for the
// capacity-4 gate + the "N in call" badge — the call UI itself reads LiveKit's live participant set.
// The single source of truth for who is ACTUALLY connected is LiveKit. A roster uid that LiveKit says
// is NOT connected is a GHOST: a tab that was hard-killed (crash / force-close / laptop sleep / power
// loss) before its leave could fire, so its name stayed on the list and falsely occupies a seat. The
// join/start routes call this to drop ghosts before the capacity check. Fail-open by contract: ANY
// error or missing config returns null, and callers then keep the stale roster — a LiveKit hiccup
// NEVER blocks a legitimate join.

// RoomServiceClient speaks HTTP(S); LIVEKIT_URL is the wss:// connect URL the browser hands to
// room.connect. Normalize wss→https (ws→http) so the server SDK hits the right scheme.
function livekitApiHost(): string | null {
  const url = process.env.LIVEKIT_URL;
  if (!url) return null;
  if (url.startsWith('wss://')) return 'https://' + url.slice('wss://'.length);
  if (url.startsWith('ws://')) return 'http://' + url.slice('ws://'.length);
  return url; // already http(s) or a bare host
}

// Built per call (cheap — a stateless fetch-backed client) rather than module-cached, so a runtime
// LIVEKIT_* rotation is picked up without a process restart.
export function getLiveKitRoomService(): RoomServiceClient | null {
  const host = livekitApiHost();
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  if (!host || !apiKey || !apiSecret) return null; // LiveKit not configured → skip reconcile (no-op)
  return new RoomServiceClient(host, apiKey, apiSecret);
}

/**
 * The set of LiveKit identities CURRENTLY connected to a call's room, or null when the answer CANNOT
 * be treated as trustworthy ground truth (LiveKit unreachable/misconfigured, OR the room reports ZERO
 * connected participants). LiveKit identity = the Firebase uid (the token route sets identity = uid),
 * so these map 1:1 to roster entries. A network round-trip — call OUTSIDE a Firestore transaction.
 *
 * WHY empty ⇒ null (the load-bearing detail): listParticipants returns [] (NOT an error) for a room
 * that exists but has nobody connected yet — the NORMAL ~1-3s after a host clicks Start, before their
 * room.connect completes — and during a simultaneous reconnect. The roster can hold REAL participants
 * in that window, so treating [] as "everyone is a ghost" and pruning to it would evict the host the
 * instant a 2nd person joins a second later. A ghost can only be inferred SAFELY when ≥1 OTHER
 * participant IS connected (positive evidence the room is genuinely live) and a specific uid is not.
 * So empty/absent ⇒ null ⇒ callers fail-open (keep the roster verbatim). Pruning only ever happens on
 * a NON-EMPTY set, which is that positive evidence.
 */
export async function getLiveCallParticipantIds(roomName: string): Promise<Set<string> | null> {
  const svc = getLiveKitRoomService();
  if (!svc) return null;
  try {
    const participants = await svc.listParticipants(roomName);
    if (participants.length === 0) return null; // see jsdoc: empty is fail-open, NOT "all ghosts"
    const ids = new Set<string>();
    for (const p of participants) if (p.identity) ids.add(p.identity);
    // Defence-in-depth mirroring the empty-list ⇒ null rule above: if every connected participant
    // somehow had a falsy identity (impossible under the token contract, which always sets identity=uid,
    // but guard anyway), we'd hand back a non-null EMPTY Set the join reconcile would treat as "all
    // ghosts" and prune the whole roster. Return null so callers fail-open.
    if (ids.size === 0) return null;
    return ids;
  } catch (e) {
    console.warn(
      `[call] LiveKit listParticipants failed for room ${roomName} — skipping roster reconcile`,
      e,
    );
    return null; // fail-open: caller keeps the stale roster
  }
}

/** Return the current LiveKit room size, or null when LiveKit cannot be trusted. */
export async function getLiveKitRoomParticipantCount(roomName: string): Promise<number | null> {
  const svc = getLiveKitRoomService();
  if (!svc) return null;
  try {
    const participants = await svc.listParticipants(roomName);
    return participants.length;
  } catch (e) {
    console.warn(`[call] LiveKit room inspection failed for ${roomName}`, e);
    return null;
  }
}
