import { NextRequest, NextResponse } from 'next/server';
import { getAdminDb } from '@/lib/firebase-admin';
import {
  CALL_LIMIT_MESSAGE,
  authUid,
  deriveCallLimitFields,
  enforceExpiredCall,
  getLiveCallParticipantIds,
  getCallParticipantJoinedAtMap,
  getCallParticipantJoinedAtRecord,
  getCallUsageStatesInTransaction,
  getTrustedStatusMapInTransaction,
  reconcileTrustedCallTransitionInTransaction,
  releaseReservationWrite,
  reserveCallUsageInTransaction,
  refreshCallLimitState,
} from '../_lib';
import type { CallUsageTransactionState } from '../_lib';

export const runtime = 'nodejs';
export const maxDuration = 30;
export const dynamic = 'force-dynamic';

// Exact capacity message (§11) — surfaced verbatim by the client toast.
const CALL_FULL_MESSAGE = 'Call is full — wait for someone to leave, or for the call to end.';
const CALL_MAX_PARTICIPANTS = 4;

// POST /api/call/join — body { callDropId }. Enforces CAPACITY-4 in ONE transaction: read the call;
// missing/!live → 404; already a participant → idempotent { ok, already }; full → 409 with the exact
// capacity message; else append uid. The Admin SDK bypasses firestore.rules (rules are defense-in-
// depth; clients can't mutate call docs at all).
export async function POST(request: NextRequest) {
  try {
    const uidOrErr = await authUid(request);
    if (typeof uidOrErr !== 'string') return uidOrErr;
    const uid = uidOrErr;

    const body = await request.json().catch(() => ({}));
    const callDropId = typeof body.callDropId === 'string' ? body.callDropId : null;
    if (!callDropId) {
      return NextResponse.json({ error: 'callDropId is required' }, { status: 400 });
    }

    const db = getAdminDb();
    const callRef = db.collection('drops').doc(callDropId);
    const callPreview = await callRef.get();
    if (!callPreview.exists || callPreview.data()?.type !== 'call') {
      return NextResponse.json({ error: 'Call not found' }, { status: 404 });
    }
    const workspaceId = callPreview.data()?.workspaceId;
    if (typeof workspaceId !== 'string' || !workspaceId) {
      return NextResponse.json({ error: 'Call is not attached to a workspace' }, { status: 403 });
    }
    const workspaceRef = db.collection('workspaces').doc(workspaceId);
    const workspaceSnap = await workspaceRef.get();
    const workspaceMembers = workspaceSnap.data()?.members;
    if (!workspaceSnap.exists || !Array.isArray(workspaceMembers) || !workspaceMembers.includes(uid)) {
      return NextResponse.json({ error: 'Not a member of this workspace' }, { status: 403 });
    }

    const nowMs = Date.now();
    const limitState = await refreshCallLimitState(db, callDropId, nowMs);
    if (!limitState.exists || !limitState.live) {
      return NextResponse.json({ error: 'Call not found' }, { status: 404 });
    }
    if (limitState.expired) {
      await enforceExpiredCall(db, callDropId, nowMs);
      return NextResponse.json({ error: CALL_LIMIT_MESSAGE }, { status: 410 });
    }
    // Ask LiveKit who is ACTUALLY connected to this call's room, so GHOST roster entries (hard-killed
    // tabs whose leave never fired) can be dropped BEFORE the capacity check instead of falsely
    // holding a seat. Fail-open: null = LiveKit unreachable → keep the roster as-is (never block a real
    // join on a LiveKit hiccup). Fetched OUTSIDE the txn (network round-trip); used inside it. The
    // room name is the generation-unique livekitRoomName (legacy calls fall back to the doc id).
    const previewRoomName = callPreview.data()?.livekitRoomName;
    const liveIds = await getLiveCallParticipantIds(
      typeof previewRoomName === 'string' && previewRoomName ? previewRoomName : callDropId,
    );

    let result:
      | { kind: 'notfound' }
      | { kind: 'notmember' }
      | { kind: 'expired' }
      | { kind: 'limited'; resetAtMs: number }
      | { kind: 'already' }
      | { kind: 'full' }
      | { kind: 'joined' };
    try {
      result = await db.runTransaction(async (txn) => {
        const snap = await txn.get(callRef);
        const currentWorkspaceSnap = await txn.get(workspaceRef);
        if (!snap.exists) return { kind: 'notfound' as const };
        // Generation gate for the LiveKit snapshot: the roster reconcile below used the room name
        // read BEFORE this txn. If the deterministic slot was replaced meanwhile (new generation),
        // that snapshot belongs to the OLD room — ignore it (fail-open) instead of pruning the new
        // call's real participants.
        const txnRoomName = snap.data()?.livekitRoomName;
        const previewRoomMatches =
          typeof previewRoomName === 'string'
            ? txnRoomName === previewRoomName
            : txnRoomName == null;
        const generationLiveIds = previewRoomMatches ? liveIds : null;
        if (
          snap.data()?.workspaceId !== workspaceId ||
          !currentWorkspaceSnap.exists ||
          !Array.isArray(currentWorkspaceSnap.data()?.members) ||
          !currentWorkspaceSnap.data()?.members.includes(uid)
        ) {
          return { kind: 'notmember' as const };
        }
        const rawDeadline = snap.data()?.callLimitDeadlineAt;
        const currentDeadlineMs =
          rawDeadline && typeof rawDeadline.toMillis === 'function' ? rawDeadline.toMillis() : null;
        if (currentDeadlineMs != null && currentDeadlineMs <= nowMs) {
          return { kind: 'expired' as const };
        }
        const data = snap.data() as { callState?: string; callParticipantUids?: unknown; callParticipantJoinedAt?: unknown };
        if (data.callState !== 'live') return { kind: 'notfound' as const };
        const uids = Array.isArray(data.callParticipantUids)
          ? (data.callParticipantUids as unknown[]).filter((u): u is string => typeof u === 'string')
          : [];
        const history = Array.isArray(snap.data()?.callParticipantHistoryUids)
          ? (snap.data()?.callParticipantHistoryUids as unknown[]).filter((u): u is string => typeof u === 'string')
          : [];
        const historyUids = [...new Set([...history, ...uids])];
        const updateRoster = async (nextUids: string[], requiredUid: string | null = null) => {
          const callData = snap.data() || {};
          const trustedByUid = await getTrustedStatusMapInTransaction(txn, db, [...new Set([...historyUids, ...nextUids])]);
          // Include the PRUNED (ghost) uids in the read set so their reservations for THIS call can
          // be released in the same transaction (all reads still precede the writes below).
          const prunedUids = uids.filter((u) => !nextUids.includes(u));
          const usageStates = await getCallUsageStatesInTransaction(
            txn,
            db,
            [...new Set([...nextUids, ...prunedUids])],
            nowMs,
          );
          const joinedAtByUid = getCallParticipantJoinedAtMap(callData, uids);
          for (const nextUid of nextUids) {
            if (!joinedAtByUid.has(nextUid)) joinedAtByUid.set(nextUid, nowMs);
          }
          // PRUNED GHOSTS are EXCLUDED from the trusted-transition settlement below: they were never
          // connected (that is why they were pruned), so they must never be charged or have their
          // reservation re-instated by the transition accounting. The transition is computed over
          // the surviving roster only.
          const transitionCurrentUids = uids.filter((u) => !prunedUids.includes(u));
          const trustedTransition = await reconcileTrustedCallTransitionInTransaction(
            txn,
            db,
            callDropId,
            callData,
            transitionCurrentUids,
            nextUids,
            trustedByUid,
            usageStates,
            joinedAtByUid,
            nowMs,
          );
          // A pruned ghost's reservation for THIS call would otherwise block them (and be orphaned
          // at deletion) — release it with zero charge, AFTER the transition settle (which never
          // touches pruned uids now, but the ordering keeps the intent explicit). Their
          // minutesUsedToday is untouched: the webhook normally settles an exit; the prune is the
          // no-webhook fallback and the release keeps the accounting forgiving rather than blocking.
          for (const prunedUid of prunedUids) {
            const prunedState = usageStates.get(prunedUid);
            if (prunedState?.reservedCallId === callDropId) {
              releaseReservationWrite(txn, db, prunedUid);
            }
          }
          const remainingMinutesByUid = new Map<string, number>();
          const reservations: { uid: string; state: CallUsageTransactionState }[] = [];
          for (const nextUid of nextUids) {
            if (trustedByUid.get(nextUid) === true) continue;
            const state = usageStates.get(nextUid);
            const reservedMinutes = state
              ? state.reservedCallId === callDropId && state.minutesReservedToday > 0
                ? state.minutesReservedToday
                : state.reservedCallId === null
                  ? state.minutesRemaining
                  : null
              : null;
            if (reservedMinutes == null) {
              if (nextUid === requiredUid) return { limited: true, resetAtMs: state?.resetAtMs ?? nowMs };
              if (state && state.reservedCallId === null && state.minutesRemaining <= 0) {
                remainingMinutesByUid.set(nextUid, 0);
              }
              continue;
            }
            remainingMinutesByUid.set(nextUid, reservedMinutes);
            if (state) reservations.push({ uid: nextUid, state });
          }
          for (const reservation of reservations) {
            reserveCallUsageInTransaction(txn, db, reservation.uid, callDropId, reservation.state, nowMs);
          }
          const fields = deriveCallLimitFields(
            nextUids,
            trustedByUid,
            currentDeadlineMs,
            nowMs,
            remainingMinutesByUid,
          );
          txn.update(callRef, {
            callParticipantUids: nextUids,
            callParticipantHistoryUids: [...new Set([...historyUids, ...nextUids])],
            callParticipantJoinedAt: getCallParticipantJoinedAtRecord(
              trustedTransition.joinedAtByUid,
              nextUids,
            ),
            callTrustedReliefUids: trustedTransition.trustedReliefUids,
            trustedParticipantCount: fields.trustedParticipantCount,
            callLimitDeadlineAt: fields.callLimitDeadlineAt,
          });
          return { limited: false, resetAtMs: nowMs };
        };
        // RECONCILE (ghost prune). liveIds non-null means (per getLiveCallParticipantIds) LiveKit is
        // reachable AND ≥1 participant IS connected → the room is genuinely live, so a roster uid that
        // is NOT in liveIds is very likely a true ghost (the "host hasn't connected yet" case returns
        // null and skips this). Prune such ghosts so they stop holding a capacity-4 seat and inflating
        // the "N in call" badge. We persist the pruned roster on every branch that changed it (a single
        // write each — no redundant double-write), then decide against the cleaned set.
        // ACCEPTED RESIDUAL: a participant who is genuinely RECONNECTING (not a ghost) is also briefly
        // absent from a non-empty liveIds and would be pruned here — a single point-in-time sample can't
        // tell "reconnecting" from "ghost". Self-corrects on their next join. The robust fix is a LiveKit
        // room-event webhook (Stage 3) that maintains the roster authoritatively; this one-sample prune
        // is the pragmatic Stage 2 compromise.
        if (generationLiveIds) {
          const cleaned = uids.filter((u) => generationLiveIds.has(u));
          if (cleaned.length !== uids.length) {
            if (cleaned.includes(uid)) {
              const update = await updateRoster(cleaned);
              if (update.limited) return { kind: 'limited' as const, resetAtMs: update.resetAtMs };
              return { kind: 'already' as const };
            }
            if (cleaned.length >= CALL_MAX_PARTICIPANTS) {
              const update = await updateRoster(cleaned);
              if (update.limited) return { kind: 'limited' as const, resetAtMs: update.resetAtMs };
              return { kind: 'full' as const };
            }
            const next = [...cleaned, uid];
            const update = await updateRoster(next, uid);
            if (update.limited) return { kind: 'limited' as const, resetAtMs: update.resetAtMs };
            return { kind: 'joined' as const };
          }
        }
        if (uids.includes(uid)) {
          const update = await updateRoster(uids);
          if (update.limited) return { kind: 'limited' as const, resetAtMs: update.resetAtMs };
          return { kind: 'already' as const };
        }
        if (uids.length >= CALL_MAX_PARTICIPANTS) return { kind: 'full' as const };
        const next = [...uids, uid];
        const update = await updateRoster(next, uid);
        if (update.limited) return { kind: 'limited' as const, resetAtMs: update.resetAtMs };
        return { kind: 'joined' as const };
      });
    } catch (err) {
      console.error('call/join transaction failed:', err);
      return NextResponse.json({ error: 'Failed to join call' }, { status: 500 });
    }

    if (result.kind === 'notfound') {
      return NextResponse.json({ error: 'Call not found' }, { status: 404 });
    }
    if (result.kind === 'notmember') {
      return NextResponse.json({ error: 'Not a member of this workspace' }, { status: 403 });
    }
    if (result.kind === 'expired') {
      await enforceExpiredCall(db, callDropId, nowMs);
      return NextResponse.json({ error: CALL_LIMIT_MESSAGE }, { status: 410 });
    }
    if (result.kind === 'limited') {
      return NextResponse.json(
        { error: CALL_LIMIT_MESSAGE, resetAt: result.resetAtMs },
        { status: 429 },
      );
    }
    if (result.kind === 'full') {
      return NextResponse.json({ error: CALL_FULL_MESSAGE }, { status: 409 });
    }
    return NextResponse.json({ ok: true, already: result.kind === 'already' });
  } catch (error) {
    console.error('call/join error:', error);
    return NextResponse.json({ error: 'Failed to join call' }, { status: 500 });
  }
}
