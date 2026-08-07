import { NextRequest, NextResponse } from 'next/server';
import { getAdminDb } from '@/lib/firebase-admin';
import {
  authUid,
  cascadeCallSubcollections,
  cascadeCallSubcollectionsIfGeneration,
  deriveCallLimitFields,
  enforceExpiredCall,
  getCallParticipantJoinedAtMap,
  getCallParticipantJoinedAtRecord,
  getCallTrustedReliefUids,
  getCallUsageStatesInTransaction,
  getLiveKitRoomService,
  getTrustedStatusMapInTransaction,
  reconcileTrustedCallTransitionInTransaction,
  releaseReservationForCallInTransaction,
  reserveCallUsageInTransaction,
  settleCallUsageInTransaction,
} from '../_lib';

export const runtime = 'nodejs';
export const maxDuration = 30;
export const dynamic = 'force-dynamic';

// POST /api/call/leave — body { callDropId }. Enforces LAST-LEAVE-AUTO-DELETE in ONE transaction:
// read; missing → { ok, callEnded:true } (already gone — idempotent); next = roster without me; if
// next is empty → delete the call doc (the subcollection cascade runs after, best-effort) →
// { ok, callEnded:true }; else participantUids = next. The Admin SDK bypasses firestore.rules.
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
    // Optional generation credential: the LiveKit room name THIS client connected to. When present,
    // the route no-ops unless the doc still owns that generation — a stale client (old tab, dead
    // pending) can never delete or mutate a NEWER call that reused the deterministic slot.
    const expectedRoomName = typeof body.expectedRoomName === 'string' ? body.expectedRoomName : null;

    const db = getAdminDb();
    const callRef = db.collection('drops').doc(callDropId);
    const nowMs = Date.now();

    let decision: {
      callEnded: boolean;
      cascade: boolean;
      expired: boolean;
      noOp: boolean;
      roomName: string | null;
      pendingLeave: boolean;
    } = {
      callEnded: false,
      cascade: false,
      expired: false,
      noOp: false,
      roomName: null,
      pendingLeave: false,
    };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        decision = await db.runTransaction(async (txn) => {
        const snap = await txn.get(callRef);
        if (!snap.exists) return { callEnded: true, cascade: false, expired: false, noOp: false, roomName: null, pendingLeave: false }; // already gone — idempotent
        const snapData = snap.data();
        const roomName =
          typeof snapData?.livekitRoomName === 'string' && snapData.livekitRoomName
            ? snapData.livekitRoomName
            : callDropId;
        // Generation guard: a stale client of an OLD generation (expectedRoomName from its own
        // token) must never delete/mutate a NEWER call that reused the deterministic slot.
        if (expectedRoomName != null && expectedRoomName !== roomName) {
          return { callEnded: false, cascade: false, expired: false, noOp: true, roomName, pendingLeave: false };
        }
        // NEVER-CONFIRMED pending call: the host cancels (or their join failed) before promotion.
        // Release the reservation with ZERO charge and delete the pending doc + its room — this is
        // the PR #203 cleanup path, made safe for the pending lifecycle.
        if (snapData?.callState === 'pending') {
          if (snapData.callHostUid !== uid) {
            return { callEnded: false, cascade: false, expired: false, noOp: true, roomName, pendingLeave: false };
          }
          // Raw read: normalization drops reservedCallId for a stale pending, which would skip the
          // release and leave the persisted reservation blocking the host when the slot is reused.
          await releaseReservationForCallInTransaction(txn, db, uid, callDropId);
          txn.delete(callRef);
          return { callEnded: true, cascade: true, expired: false, noOp: false, roomName, pendingLeave: true };
        }
        if (snapData?.callState !== 'live') return { callEnded: true, cascade: false, expired: false, noOp: false, roomName: null, pendingLeave: false };
        const rawDeadline = snap.data()?.callLimitDeadlineAt;
        const currentDeadlineMs =
          rawDeadline && typeof rawDeadline.toMillis === 'function' ? rawDeadline.toMillis() : null;
        if (currentDeadlineMs != null && currentDeadlineMs <= nowMs) {
          return { callEnded: true, cascade: false, expired: true, noOp: false, roomName: null, pendingLeave: false };
        }
        const data = snap.data() as { callParticipantUids?: unknown; callParticipantJoinedAt?: unknown };
        const uids = Array.isArray(data.callParticipantUids)
          ? (data.callParticipantUids as unknown[]).filter((u): u is string => typeof u === 'string')
          : [];
        if (!uids.includes(uid)) {
          return { callEnded: false, cascade: false, expired: false, noOp: true, roomName: null, pendingLeave: false };
        }
        const callData = snap.data() || {};
        const trustedByUid = await getTrustedStatusMapInTransaction(txn, db, uids);
        const usageStates = await getCallUsageStatesInTransaction(txn, db, uids, nowMs);
        const joinedAtByUid = getCallParticipantJoinedAtMap(callData, uids);
        const trustedReliefUids = getCallTrustedReliefUids(callData, uids, trustedByUid);
        const next = uids.filter((u) => u !== uid);
        if (next.length === 0) {
          // last leaver — the call ends. Delete the doc; subcollections cascade after the txn
          // (generation-aware via roomName).
          await settleCallUsageInTransaction(
            txn,
            db,
            uids,
            trustedByUid,
            callDropId,
            joinedAtByUid,
            new Set(trustedReliefUids),
            nowMs,
            usageStates,
          );
          txn.delete(callRef);
          return { callEnded: true, cascade: true, expired: false, noOp: false, roomName, pendingLeave: false };
        }
        const trustedTransition = await reconcileTrustedCallTransitionInTransaction(
          txn,
          db,
          callDropId,
          callData,
          uids,
          next,
          trustedByUid,
          usageStates,
          joinedAtByUid,
          nowMs,
        );
        await settleCallUsageInTransaction(
          txn,
          db,
          [uid],
          trustedByUid,
          callDropId,
          trustedTransition.joinedAtByUid,
          new Set(trustedReliefUids),
          nowMs,
          usageStates,
        );
        const remainingMinutesByUid = new Map<string, number>();
        for (const nextUid of next) {
          if (trustedByUid.get(nextUid) === true) continue;
          const state = usageStates.get(nextUid);
          const reservedMinutes = state
            ? reserveCallUsageInTransaction(txn, db, nextUid, callDropId, state, nowMs)
            : null;
          if (reservedMinutes != null) {
            remainingMinutesByUid.set(nextUid, reservedMinutes);
          } else if (!state || state.reservedCallId === null) {
            remainingMinutesByUid.set(nextUid, 0);
          }
        }
        const limitFields = deriveCallLimitFields(
          next,
          trustedByUid,
          currentDeadlineMs,
          nowMs,
          remainingMinutesByUid,
        );
        txn.delete(callRef.collection('callPresence').doc(uid));
        txn.update(callRef, {
          callParticipantUids: next,
          callParticipantJoinedAt: getCallParticipantJoinedAtRecord(
            trustedTransition.joinedAtByUid,
            next,
          ),
          callTrustedReliefUids: trustedTransition.trustedReliefUids,
          trustedParticipantCount: limitFields.trustedParticipantCount,
          callLimitDeadlineAt: limitFields.callLimitDeadlineAt,
        });
        return { callEnded: false, cascade: false, expired: false, noOp: false, roomName: null, pendingLeave: false };
        });
      } catch (err) {
        console.error('call/leave transaction failed:', err);
        return NextResponse.json({ error: 'Failed to leave call' }, { status: 500 });
      }

      if (!decision.expired) break;
      const enforcement = await enforceExpiredCall(db, callDropId, nowMs);
      if (enforcement.ended) {
        return NextResponse.json({ ok: true, callEnded: true });
      }
    }

    if (decision.expired) {
      return NextResponse.json({ ok: true, callEnded: false });
    }

    if (decision.cascade) {
      // last leaver (or cancelled pending) — cascade the call's subcollections (Firestore doesn't
      // cascade). Best-effort. Generation-aware: if the deterministic slot was already reused by a
      // newer start, its subcollections are never touched.
      if (decision.roomName) {
        cascadeCallSubcollectionsIfGeneration(db, callDropId, decision.roomName).catch(() => {});
      } else {
        cascadeCallSubcollections(db, callDropId).catch(() => {});
      }
    }

    // A cancelled PENDING call has a LiveKit room that no webhook will ever close (nobody joined).
    // Close it explicitly; the doc is already deleted by the txn. LIVE last-leaver rooms are still
    // closed by the LiveKit webhook (room_finished), so only the pending path deletes here.
    if (decision.roomName && decision.callEnded && decision.pendingLeave) {
      const roomService = getLiveKitRoomService();
      if (roomService) {
        try {
          await roomService.deleteRoom(decision.roomName);
        } catch (error) {
          console.warn(`[call/leave] failed to close pending room ${decision.roomName}`, error);
        }
      }
    }

    return NextResponse.json({ ok: true, callEnded: decision.callEnded });
  } catch (error) {
    console.error('call/leave error:', error);
    return NextResponse.json({ error: 'Failed to leave call' }, { status: 500 });
  }
}
