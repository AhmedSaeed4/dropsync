// Shared helpers for the /api/call/* routes (NOT a route itself — Next.js only treats `route.ts`
// in an api segment as a handler). Keeps the auth preamble + the subcollection cascade out of the
// 4 route files.

import { NextRequest, NextResponse } from 'next/server';
import {
  FieldValue,
  Timestamp,
  type DocumentData,
  type Firestore,
  type Transaction,
} from 'firebase-admin/firestore';
import { RoomServiceClient } from 'livekit-server-sdk';
import { getAdminAuth } from '@/lib/firebase-admin';

export const CALL_LIMIT_MS = 30 * 60 * 1000;
export const CALL_TOTAL_MINUTES = CALL_LIMIT_MS / 60_000;
export const CALL_PRESENCE_STALE_MS = 60_000;
export const ABANDONED_CALL_GRACE_MS = 10 * 60 * 1000;
// A pending (created-but-never-confirmed) call is a server-side reservation. If the host's browser
// dies before its LiveKit join confirms, the doc is invisible (the drop listener only shows 'live')
// and must be swept after this grace. 3 min = enough for a throttled-but-legit connect to confirm,
// short enough that an abandoned pending never lingers long.
export const PENDING_CALL_GRACE_MS = 3 * 60 * 1000;
export const CALL_LIMIT_MESSAGE =
  'Your 30-minute daily call allowance has been used. You can still join a call with a trusted user.';

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

// Exported so routes can read pending timestamps without duplicating the guard.
export { timestampMs };

/**
 * A reservation is ACTIVE while its call is live, OR while the call is a FRESH pending (created but
 * not yet confirmed — the host is mid-connect). A STALE pending (past the grace, nobody confirmed)
 * is an abandoned start: the reservation no longer blocks anything, so the user can start/join
 * again. The lazy-release paths (start/access) clear such reservations explicitly, and the daily
 * sweep deletes the docs.
 */
export function isCallReservationActive(data: DocumentData | undefined, nowMs: number): boolean {
  if (data?.callState === 'live') return true;
  if (data?.callState !== 'pending') return false;
  return !isPendingCallStale(data, nowMs);
}

/**
 * A pending call is STALE when it is past its grace: callPendingExpiresAt (server-written at start =
 * pendingAt + grace) is authoritative when present; legacy/partial docs fall back to the age of
 * callPendingAt (or createdAt). Single source of truth for the start quick-path, the start txn, the
 * confirm/token gates, and the daily sweep — all use the same rule.
 */
export function isPendingCallStale(data: DocumentData | undefined, nowMs: number): boolean {
  if (!data || data.callState !== 'pending') return false;
  const expiresMs = timestampMs(data.callPendingExpiresAt);
  if (expiresMs != null) return nowMs >= expiresMs;
  const pendingAtMs = timestampMs(data.callPendingAt) ?? timestampMs(data.createdAt);
  if (pendingAtMs == null) return false; // unknown age → fail open (not stale yet)
  return nowMs - pendingAtMs >= PENDING_CALL_GRACE_MS;
}

export type CallLimitFields = {
  trustedParticipantCount: number;
  deadlineMs: number | null;
  callLimitDeadlineAt: Timestamp | null;
};

export type CallUsageState = {
  limited: boolean;
  resetAtMs: number;
  minutesUsedToday: number;
  minutesRemaining: number;
  reservedCallId: string | null;
  minutesReservedToday: number;
};

export type CallUsageTransactionState = CallUsageState & {
  minutesReservedToday: number;
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
  remainingMinutesByUid?: Map<string, number>,
): CallLimitFields {
  const trustedParticipantCount = participantUids.filter(
    (uid) => trustedByUid.get(uid) === true,
  ).length;
  const participantDeadlines = participantUids
    .filter((uid) => trustedByUid.get(uid) !== true)
    .map((uid) => {
      const remainingMinutes = remainingMinutesByUid?.get(uid);
      return nowMs + (remainingMinutes == null ? CALL_LIMIT_MS : Math.max(0, remainingMinutes * 60_000));
    });
  const deadlineCandidates = [
    ...(existingDeadlineMs == null ? [] : [existingDeadlineMs]),
    ...participantDeadlines,
  ];
  const deadlineMs =
    trustedParticipantCount > 0
      ? null
      : Math.min(...(deadlineCandidates.length > 0 ? deadlineCandidates : [nowMs + CALL_LIMIT_MS]));

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

function roundMinutes(minutes: number): number {
  return Math.round(minutes * 1000) / 1000;
}

export function normalizeCallUsage(
  data: DocumentData | undefined,
  nowMs: number,
): CallUsageTransactionState {
  const dayKey = utcDayKey(nowMs);
  const isToday = data?.dayKey === dayKey;
  // A legacy dayKey without minutesUsedToday represented a fully consumed day.
  const legacyLocked = isToday && typeof data?.minutesUsedToday !== 'number';
  const minutesUsedToday = isToday
    ? Math.min(CALL_TOTAL_MINUTES, Math.max(0, legacyLocked ? CALL_TOTAL_MINUTES : Number(data?.minutesUsedToday) || 0))
    : 0;
  // Keep an active reservation across midnight. Clearing it here would let a participant start a
  // second call while the first call is still active, effectively granting a second allowance.
  const minutesReservedToday = typeof data?.reservedCallId === 'string'
    ? Math.max(0, Number(data?.minutesReservedToday) || 0)
    : 0;
  const reservedCallId = typeof data?.reservedCallId === 'string' ? data.reservedCallId : null;
  const minutesRemaining = Math.max(0, CALL_TOTAL_MINUTES - minutesUsedToday);

  return {
    limited: minutesRemaining <= 0 || reservedCallId !== null,
    resetAtMs: nextUtcMidnightMs(nowMs),
    minutesUsedToday,
    minutesRemaining,
    reservedCallId,
    minutesReservedToday,
  };
}

/** Read the current user's server-only daily call usage and active reservation. */
export async function getCallUsageState(
  db: Firestore,
  uid: string,
  nowMs = Date.now(),
): Promise<CallUsageState> {
  const snap = await db.collection('callUsage').doc(uid).get();
  const state = normalizeCallUsage(snap.data(), nowMs);
  if (!state.reservedCallId) return state;
  const reservationCall = await db.collection('drops').doc(state.reservedCallId).get();
  if (reservationCall.exists && isCallReservationActive(reservationCall.data(), nowMs)) return state;
  return {
    ...state,
    limited: state.minutesRemaining <= 0,
    minutesReservedToday: 0,
    reservedCallId: null,
  };
}

/** Read usage documents before any transaction writes are issued. */
export async function getCallUsageStatesInTransaction(
  txn: Transaction,
  db: Firestore,
  uids: string[],
  nowMs = Date.now(),
): Promise<Map<string, CallUsageTransactionState>> {
  const states = new Map<string, CallUsageTransactionState>();
  for (const uid of [...new Set(uids)]) {
    const snap = await txn.get(db.collection('callUsage').doc(uid));
    const state = normalizeCallUsage(snap.data(), nowMs);
    if (state.reservedCallId) {
      const reservationCall = await txn.get(db.collection('drops').doc(state.reservedCallId));
      if (!reservationCall.exists || !isCallReservationActive(reservationCall.data(), nowMs)) {
        states.set(uid, {
          ...state,
          limited: state.minutesRemaining <= 0,
          minutesReservedToday: 0,
          reservedCallId: null,
        });
        continue;
      }
    }
    states.set(uid, state);
  }
  return states;
}

/**
 * Clear a PERSISTED reservation for a specific call, reading the raw usage doc inside the txn.
 * Cleanup paths (sweep, pending leave, webhook, legacy ghosts) must use this, NOT the normalized
 * state: normalization drops `reservedCallId` for a stale/deleted pending call, which would make
 * the state-based release a silent no-op and leave `reservedCallId`/`minutesReservedToday`/
 * `reservedAt` persisted — resurrecting a false "active" reservation when the deterministic call
 * doc is later reused. minutesUsedToday is untouched — never-joined time is never billed.
 *
 * ONLY for transactions where no write happened before this call (it reads then writes). For
 * multiple releases in one transaction use releaseReservationsForCallInTransaction (Firestore
 * requires all reads to precede all writes).
 */
export async function releaseReservationForCallInTransaction(
  txn: Transaction,
  db: Firestore,
  uid: string,
  callDropId: string,
): Promise<boolean> {
  const usageSnap = await txn.get(db.collection('callUsage').doc(uid));
  const raw = usageSnap.data();
  if (!raw || raw.reservedCallId !== callDropId) return false;
  txn.set(
    db.collection('callUsage').doc(uid),
    { minutesReservedToday: 0, reservedCallId: null, reservedAt: null },
    { merge: true },
  );
  return true;
}

/**
 * Write-only reservation release. The caller must ALREADY have read the usage doc in this
 * transaction (e.g. via the preloaded states) and verified the reservation — this only issues the
 * clearing write, so it is safe anywhere in the write phase.
 */
export function releaseReservationWrite(
  txn: Transaction,
  db: Firestore,
  uid: string,
): void {
  txn.set(
    db.collection('callUsage').doc(uid),
    { minutesReservedToday: 0, reservedCallId: null, reservedAt: null },
    { merge: true },
  );
}

/**
 * Batch release: read EVERY candidate's usage doc first, then write the clearing updates — the
 * Firestore transaction contract (all reads before all writes) forbids read-after-write, which the
 * single-uid helper would violate when called in a loop. Returns the uids whose reservation for
 * callDropId was actually released. minutesUsedToday is untouched in every case.
 */
export async function releaseReservationsForCallInTransaction(
  txn: Transaction,
  db: Firestore,
  uids: string[],
  callDropId: string,
): Promise<string[]> {
  const uniqueUids = [...new Set(uids)];
  const usageSnaps = new Map<string, DocumentData | undefined>();
  for (const uid of uniqueUids) {
    usageSnaps.set(uid, (await txn.get(db.collection('callUsage').doc(uid))).data());
  }
  const released: string[] = [];
  for (const uid of uniqueUids) {
    const raw = usageSnaps.get(uid);
    if (!raw || raw.reservedCallId !== callDropId) continue;
    txn.set(
      db.collection('callUsage').doc(uid),
      { minutesReservedToday: 0, reservedCallId: null, reservedAt: null },
      { merge: true },
    );
    released.push(uid);
  }
  return released;
}

/**
 * Lazy release OUTSIDE a transaction (non-cron routes): if the user's reservation points at a
 * never-confirmed pending call, clear it with zero charge. This is load-bearing — a user whose tab
 * died mid-start must NEVER be blocked from starting again, even before the daily sweep runs.
 * Runs in a transaction so a concurrent confirm that promotes the call to live conflicts with it:
 * after the retry the call is 'live' and the reservation is NOT released (no double-booking).
 */
export async function releaseNeverConfirmedReservation(
  db: Firestore,
  uid: string,
): Promise<boolean> {
  return db
    .runTransaction(async (txn): Promise<boolean> => {
      const usageSnap = await txn.get(db.collection('callUsage').doc(uid));
      const raw = usageSnap.data();
      if (!raw || typeof raw.reservedCallId !== 'string') return false;
      const callSnap = await txn.get(db.collection('drops').doc(raw.reservedCallId));
      if (!callSnap.exists) {
        // Reservation points at a call that no longer exists (swept pending / cleaned ended call):
        // an orphan — clear the persisted fields so they never resurrect on slot reuse.
        txn.set(
          db.collection('callUsage').doc(uid),
          { minutesReservedToday: 0, reservedCallId: null, reservedAt: null },
          { merge: true },
        );
        return true;
      }
      if (callSnap.data()?.callState !== 'pending') return false;
      txn.set(
        db.collection('callUsage').doc(uid),
        { minutesReservedToday: 0, reservedCallId: null, reservedAt: null },
        { merge: true },
      );
      return true;
    })
    .catch(() => false);
}

/** Reserve the user's remaining daily allowance for one active call atomically. */
export function reserveCallUsageInTransaction(
  txn: Transaction,
  db: Firestore,
  uid: string,
  callDropId: string,
  state: CallUsageTransactionState,
  nowMs = Date.now(),
): number | null {
  if (state.reservedCallId !== null && state.reservedCallId !== callDropId) return null;
  const remainingMinutes = state.reservedCallId === callDropId && state.minutesReservedToday > 0
    ? state.minutesReservedToday
    : state.minutesRemaining;
  if (remainingMinutes <= 0) return null;

  if (state.reservedCallId !== callDropId) {
    txn.set(
      db.collection('callUsage').doc(uid),
      {
        dayKey: utcDayKey(nowMs),
        minutesUsedToday: state.minutesUsedToday,
        minutesReservedToday: remainingMinutes,
        reservedCallId: callDropId,
        reservedAt: Timestamp.fromMillis(nowMs),
        resetAt: Timestamp.fromMillis(nextUtcMidnightMs(nowMs)),
      },
      { merge: true },
    );
  }
  return remainingMinutes;
}

export function getCallParticipantJoinedAtMap(
  data: DocumentData,
  participantUids: string[],
): Map<string, number> {
  const joinedAt = data.callParticipantJoinedAt && typeof data.callParticipantJoinedAt === 'object'
    ? data.callParticipantJoinedAt as Record<string, unknown>
    : {};
  const fallback = timestampMs(data.callStartedAt) ?? timestampMs(data.createdAt) ?? Date.now();
  return new Map(
    participantUids.map((uid) => [uid, timestampMs(joinedAt[uid]) ?? fallback]),
  );
}

export function getCallParticipantJoinedAtRecord(
  joinedAtByUid: Map<string, number>,
  participantUids: string[],
): Record<string, Timestamp> {
  const joinedAt: Record<string, Timestamp> = {};
  for (const uid of participantUids) {
    const joinedAtMs = joinedAtByUid.get(uid);
    if (joinedAtMs != null) joinedAt[uid] = Timestamp.fromMillis(joinedAtMs);
  }
  return joinedAt;
}

function getStoredCallTrustedReliefUids(data: DocumentData, participantUids: string[]): string[] {
  return Array.isArray(data.callTrustedReliefUids)
    ? data.callTrustedReliefUids.filter(
        (uid): uid is string => typeof uid === 'string' && participantUids.includes(uid),
      )
    : [];
}

export function getCallTrustedReliefUids(
  data: DocumentData,
  participantUids: string[],
  trustedByUid: Map<string, boolean>,
): string[] {
  const trustedPresent = participantUids.some((uid) => trustedByUid.get(uid) === true);
  if (!trustedPresent) return [];
  const existing = getStoredCallTrustedReliefUids(data, participantUids);
  const currentNonTrusted = participantUids.filter((uid) => trustedByUid.get(uid) !== true);
  return [...new Set([...existing, ...currentNonTrusted])];
}

/**
 * Reconcile billing when trusted presence changes. Standard time before a trusted user arrives is
 * settled immediately; time while trusted presence is active is free; and billing restarts from
 * the instant the last trusted participant leaves. The usage map is mutated by settlement so the
 * caller can safely reserve the post-transition balance in the same transaction.
 */
export async function reconcileTrustedCallTransitionInTransaction(
  txn: Transaction,
  db: Firestore,
  callDropId: string,
  data: DocumentData,
  currentParticipantUids: string[],
  nextParticipantUids: string[],
  trustedByUid: Map<string, boolean>,
  usageStates: Map<string, CallUsageTransactionState>,
  joinedAtByUid: Map<string, number>,
  nowMs = Date.now(),
  previousTrustedPresent = currentParticipantUids.some((uid) => trustedByUid.get(uid) === true),
): Promise<{ joinedAtByUid: Map<string, number>; trustedReliefUids: string[] }> {
  const nextJoinedAtByUid = new Map(joinedAtByUid);
  const nextTrustedPresent = nextParticipantUids.some((uid) => trustedByUid.get(uid) === true);
  const storedReliefUids = getStoredCallTrustedReliefUids(data, currentParticipantUids);

  if (!previousTrustedPresent && nextTrustedPresent) {
    // A stale relief list can only describe a prior trusted overlap. Do not charge that period when
    // repairing an old live call; all newly billable time starts at this transition.
    const preTrustedJoinedAtByUid = new Map(joinedAtByUid);
    for (const uid of storedReliefUids) preTrustedJoinedAtByUid.set(uid, nowMs);
    await settleCallUsageInTransaction(
      txn,
      db,
      currentParticipantUids,
      trustedByUid,
      callDropId,
      preTrustedJoinedAtByUid,
      new Set(),
      nowMs,
      usageStates,
      false,
    );
    for (const uid of nextParticipantUids) {
      if (trustedByUid.get(uid) !== true) nextJoinedAtByUid.set(uid, nowMs);
    }
  } else if (previousTrustedPresent && !nextTrustedPresent) {
    // The trusted overlap has ended. Preserve the already-settled usage and start a new billable
    // interval for every standard participant still in the room.
    for (const uid of nextParticipantUids) {
      if (trustedByUid.get(uid) !== true) nextJoinedAtByUid.set(uid, nowMs);
    }
  } else if (!previousTrustedPresent && !nextTrustedPresent && storedReliefUids.length > 0) {
    // Repair calls written by the old implementation: relief must not survive without trusted
    // presence. We can only bill reliably from this repair point because the old exit time was not
    // stored.
    for (const uid of storedReliefUids) nextJoinedAtByUid.set(uid, nowMs);
  }

  return {
    joinedAtByUid: nextJoinedAtByUid,
    trustedReliefUids: nextTrustedPresent
      ? getCallTrustedReliefUids(data, nextParticipantUids, trustedByUid)
      : [],
  };
}

/** Charge each participant for their own joined interval and release their reservation. */
export async function settleCallUsageInTransaction(
  txn: Transaction,
  db: Firestore,
  participantUids: string[],
  trustedByUid: Map<string, boolean>,
  callDropId: string,
  joinedAtByUid: Map<string, number>,
  trustedReliefUids: Set<string>,
  nowMs = Date.now(),
  preloadedUsageStates?: Map<string, CallUsageTransactionState>,
  releaseReservation = true,
): Promise<void> {
  const dayKey = utcDayKey(nowMs);
  const usageStates = preloadedUsageStates ?? await getCallUsageStatesInTransaction(txn, db, participantUids, nowMs);
  for (const uid of [...new Set(participantUids)]) {
    const state = usageStates.get(uid);
    if (!state) continue;
    if (trustedByUid.get(uid) === true || trustedReliefUids.has(uid)) {
      if (state.reservedCallId === callDropId) {
        txn.set(
          db.collection('callUsage').doc(uid),
          { minutesReservedToday: 0, reservedCallId: null, reservedAt: null },
          { merge: true },
        );
        if (preloadedUsageStates) {
          preloadedUsageStates.set(uid, {
            ...state,
            limited: state.minutesRemaining <= 0,
            reservedCallId: null,
            minutesReservedToday: 0,
          });
        }
      }
      continue;
    }
    const joinedAtMs = joinedAtByUid.get(uid) ?? nowMs;
    const chargeMinutes = roundMinutes(Math.max(0, nowMs - joinedAtMs) / 60_000);
    const nextUsed = Math.min(CALL_TOTAL_MINUTES, roundMinutes(state.minutesUsedToday + chargeMinutes));
    const nextRemaining = Math.max(0, CALL_TOTAL_MINUTES - nextUsed);
    const hasCallReservation = state.reservedCallId === callDropId;
    const keepCallReservation = hasCallReservation && !releaseReservation && nextRemaining > 0;
    const usage: Record<string, unknown> = {
      dayKey,
      minutesUsedToday: nextUsed,
      resetAt: Timestamp.fromMillis(nextUtcMidnightMs(nowMs)),
      limitedAt: nextUsed >= CALL_TOTAL_MINUTES ? Timestamp.fromMillis(nowMs) : null,
    };
    if (hasCallReservation) {
      usage.minutesReservedToday = keepCallReservation ? nextRemaining : 0;
      usage.reservedCallId = keepCallReservation ? callDropId : null;
      if (!keepCallReservation) usage.reservedAt = null;
    }
    txn.set(
      db.collection('callUsage').doc(uid),
      usage,
      { merge: true },
    );
    if (preloadedUsageStates) {
      const released = hasCallReservation && !keepCallReservation;
      preloadedUsageStates.set(uid, {
        ...state,
        limited: nextRemaining <= 0 || (keepCallReservation ? true : !released && state.reservedCallId !== null),
        minutesUsedToday: nextUsed,
        minutesRemaining: nextRemaining,
        reservedCallId: keepCallReservation ? callDropId : released ? null : state.reservedCallId,
        minutesReservedToday: keepCallReservation ? nextRemaining : released ? 0 : state.minutesReservedToday,
      });
    }
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
    const usageStates = await getCallUsageStatesInTransaction(txn, db, participantUids, nowMs);
    const joinedAtByUid = getCallParticipantJoinedAtMap(data, participantUids);
    const previousTrustedPresent = Number(data.trustedParticipantCount) > 0;
    const trustedTransition = await reconcileTrustedCallTransitionInTransaction(
      txn,
      db,
      callDropId,
      data,
      participantUids,
      participantUids,
      trustedByUid,
      usageStates,
      joinedAtByUid,
      nowMs,
      previousTrustedPresent,
    );
    const remainingMinutesByUid = new Map<string, number>();
    for (const uid of participantUids) {
      if (trustedByUid.get(uid) === true) continue;
      const state = usageStates.get(uid);
      const reservedMinutes = state
        ? reserveCallUsageInTransaction(txn, db, uid, callDropId, state, nowMs)
        : null;
      if (reservedMinutes != null) {
        remainingMinutesByUid.set(uid, reservedMinutes);
      } else if (!state || state.reservedCallId === null) {
        remainingMinutesByUid.set(uid, 0);
      }
    }
    const limitFields = deriveCallLimitFields(
      participantUids,
      trustedByUid,
      timestampMs(data.callLimitDeadlineAt),
      nowMs,
      remainingMinutesByUid,
    );
    txn.update(callRef, {
      trustedParticipantCount: limitFields.trustedParticipantCount,
      callLimitDeadlineAt: limitFields.callLimitDeadlineAt,
      callParticipantJoinedAt: getCallParticipantJoinedAtRecord(
        trustedTransition.joinedAtByUid,
        participantUids,
      ),
      callTrustedReliefUids: trustedTransition.trustedReliefUids,
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
  // Room names are generation-unique now (livekitRoomName); legacy docs fall back to the doc id.
  const preSnap = await callRef.get();
  const preData = preSnap.exists ? preSnap.data() : null;
  const roomName =
    typeof preData?.livekitRoomName === 'string' && preData.livekitRoomName
      ? preData.livekitRoomName
      : callDropId;
  const expectedSid = typeof preData?.livekitRoomSid === 'string' ? preData.livekitRoomSid : null;
  // Legacy never-joined ghost detection (queries are not allowed inside transactions, so the
  // checks happen before the txn): an UNCONFIRMED live call (no callConfirmedAt — only
  // pre-lifecycle docs) with NO presence docs ever AND an EMPTY LiveKit room means nobody ever
  // connected. Such ghosts are released with ZERO charge and deleted instead of billed — centralized
  // here so EVERY caller of enforceExpiredCall (start/join/token/leave/sync/webhook/reap + cron)
  // uses the same rule. The LiveKit-emptiness requirement makes the heuristic fail-safe: a real
  // legacy call whose heartbeats all failed is still protected by having participants in the room.
  let neverJoinedGhost = false;
  if (preData?.type === 'call' && preData.callState === 'live' && preData.callConfirmedAt == null) {
    const presenceSnap = await callRef.collection('callPresence').get();
    if (presenceSnap.empty) {
      const participantCount = await getLiveKitRoomParticipantCount(roomName);
      neverJoinedGhost = participantCount === 0;
    }
  }
  const decision = await db.runTransaction(async (txn) => {
    const snap = await txn.get(callRef);
    if (!snap.exists || snap.data()?.type !== 'call' || snap.data()?.callState !== 'live') {
      return { ended: false, participantUids: [] };
    }
    // Generation guard: the deterministic slot may have been reused between the pre-read and this
    // txn (a new pending start overwrites the doc). Never act on or close the room of a newer call.
    if (expectedSid != null && snap.data()?.livekitRoomSid !== expectedSid) {
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
    if (neverJoinedGhost) {
      // Legacy ghost: full refund — clear every roster member's reservation (batch release: reads
      // first, then writes, per the Firestore transaction contract) and delete the doc.
      // minutesUsedToday is untouched: never-joined time is never billed.
      await releaseReservationsForCallInTransaction(txn, db, participantUids, callDropId);
      txn.delete(callRef);
      return { ended: true, participantUids };
    }
    const callData = snap.data() || {};
    const trustedByUid = await getTrustedStatusMapInTransaction(txn, db, participantUids);
    const limitTrustedByUid = new Map(
      participantUids.map((uid) => [uid, trustedByUid.get(uid) === true]),
    );
    const limitFields = deriveCallLimitFields(participantUids, limitTrustedByUid, deadlineMs, nowMs);
    if (limitFields.deadlineMs == null || limitFields.deadlineMs > nowMs) {
      txn.update(callRef, {
        trustedParticipantCount: limitFields.trustedParticipantCount,
        callLimitDeadlineAt: limitFields.callLimitDeadlineAt,
        callTrustedReliefUids: getCallTrustedReliefUids(callData, participantUids, trustedByUid),
      });
      return { ended: false, participantUids: [] };
    }
    await settleCallUsageInTransaction(
      txn,
      db,
      participantUids,
      trustedByUid,
      callDropId,
      getCallParticipantJoinedAtMap(callData, participantUids),
      new Set(getCallTrustedReliefUids(callData, participantUids, trustedByUid)),
      nowMs,
    );
    txn.update(callRef, {
      callState: 'ended',
      callEndReason: 'untrusted_time_limit',
      callEndedAt: Timestamp.fromMillis(nowMs),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return { ended: true, participantUids };
  });

  if (!decision.ended) return decision;
  if (neverJoinedGhost) {
    // The doc was deleted by the txn — clean its subcollections explicitly (generation-aware).
    await cascadeCallSubcollectionsIfGeneration(db, callDropId, roomName).catch((error) => {
      console.warn(`[call] ghost cascade failed for ${callDropId}`, error);
    });
  }
  const roomService = getLiveKitRoomService();
  if (roomService) {
    try {
      await roomService.deleteRoom(roomName);
    } catch (error) {
      console.warn(`[call] failed to close expired LiveKit room ${roomName}`, error);
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

/**
 * Generation-aware variant: cascade the subcollections ONLY if the deterministic doc slot still
 * holds the same generation (same livekitRoomName), or the doc is already gone entirely. Prevents
 * a cleanup that started for an OLD generation from deleting a NEWER call's presence/signals after
 * the slot was reused (`call-{workspaceId}` is deterministic). Legacy docs have no livekitRoomName —
 * for them the generation token IS the doc id, so the match falls back to `callDropId`.
 */
export async function cascadeCallSubcollectionsIfGeneration(
  db: Firestore,
  callDropId: string,
  expectedRoomName: string,
): Promise<void> {
  const snap = await db.collection('drops').doc(callDropId).get();
  if (snap.exists) {
    const room = snap.data()?.livekitRoomName;
    const matches =
      typeof room === 'string' ? room === expectedRoomName : callDropId === expectedRoomName;
    if (!matches) return; // slot reused by a newer generation — never touch its subcollections
  }
  await cascadeCallSubcollections(db, callDropId);
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
