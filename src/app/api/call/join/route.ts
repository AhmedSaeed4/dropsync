import { NextRequest, NextResponse } from 'next/server';
import { getAdminDb } from '@/lib/firebase-admin';
import {
  CALL_LIMIT_MESSAGE,
  authUid,
  deriveCallLimitFields,
  enforceExpiredCall,
  getLiveCallParticipantIds,
  getTrustedStatusMapInTransaction,
  refreshCallLimitState,
} from '../_lib';

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
    // join on a LiveKit hiccup). Fetched OUTSIDE the txn (network round-trip); used inside it.
    const liveIds = await getLiveCallParticipantIds(callDropId);

    let result:
      | { kind: 'notfound' }
      | { kind: 'notmember' }
      | { kind: 'expired' }
      | { kind: 'already' }
      | { kind: 'full' }
      | { kind: 'joined' };
    try {
      result = await db.runTransaction(async (txn) => {
        const snap = await txn.get(callRef);
        const currentWorkspaceSnap = await txn.get(workspaceRef);
        if (!snap.exists) return { kind: 'notfound' as const };
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
        const data = snap.data() as { callState?: string; callParticipantUids?: unknown };
        if (data.callState !== 'live') return { kind: 'notfound' as const };
        const uids = Array.isArray(data.callParticipantUids)
          ? (data.callParticipantUids as unknown[]).filter((u): u is string => typeof u === 'string')
          : [];
        const updateRoster = async (nextUids: string[]) => {
          const trustedByUid = await getTrustedStatusMapInTransaction(txn, db, nextUids);
          const fields = deriveCallLimitFields(
            nextUids,
            trustedByUid,
            currentDeadlineMs,
            nowMs,
          );
          txn.update(callRef, {
            callParticipantUids: nextUids,
            trustedParticipantCount: fields.trustedParticipantCount,
            callLimitDeadlineAt: fields.callLimitDeadlineAt,
          });
        };
        const updateLimitFields = async (nextUids: string[]) => {
          const trustedByUid = await getTrustedStatusMapInTransaction(txn, db, nextUids);
          const fields = deriveCallLimitFields(nextUids, trustedByUid, currentDeadlineMs, nowMs);
          return {
            trustedParticipantCount: fields.trustedParticipantCount,
            callLimitDeadlineAt: fields.callLimitDeadlineAt,
          };
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
        if (liveIds) {
          const cleaned = uids.filter((u) => liveIds.has(u));
          if (cleaned.length !== uids.length) {
            if (cleaned.includes(uid)) {
              await updateRoster(cleaned);
              return { kind: 'already' as const };
            }
            if (cleaned.length >= CALL_MAX_PARTICIPANTS) {
              await updateRoster(cleaned);
              return { kind: 'full' as const };
            }
            const next = [...cleaned, uid];
            await updateRoster(next);
            return { kind: 'joined' as const };
          }
        }
        if (uids.includes(uid)) {
          txn.update(callRef, await updateLimitFields(uids));
          return { kind: 'already' as const };
        }
        if (uids.length >= CALL_MAX_PARTICIPANTS) return { kind: 'full' as const };
        const next = [...uids, uid];
        await updateRoster(next);
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
    if (result.kind === 'full') {
      return NextResponse.json({ error: CALL_FULL_MESSAGE }, { status: 409 });
    }
    return NextResponse.json({ ok: true, already: result.kind === 'already' });
  } catch (error) {
    console.error('call/join error:', error);
    return NextResponse.json({ error: 'Failed to join call' }, { status: 500 });
  }
}
