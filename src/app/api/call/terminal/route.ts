import { NextRequest, NextResponse } from 'next/server';
import { getAdminDb } from '@/lib/firebase-admin';
import {
  ackAttemptInTransaction,
  attemptDocRef,
  attemptKeyFromRoomName,
  authUid,
  cascadeCallSubcollectionsIfGeneration,
  getCallParticipantJoinedAtMap,
  getCallTrustedReliefUids,
  getCallUsageStatesInTransaction,
  getLiveKitRoomService,
  getTrustedStatusMapInTransaction,
  releaseReservationForCallInTransaction,
  resolveAttemptByWindow,
  settleCallUsageInTransaction,
} from '../_lib';

export const runtime = 'nodejs';
export const maxDuration = 30;
export const dynamic = 'force-dynamic';

// POST /api/call/terminal — the shared generation-keyed terminal operation (Round 12
// parts D/F). TWO ops:
//   * force-end { callDropId } — the D-m confirm-and-force-end authority. Authorized for
//     the DELETING owner of the call's workspace (the deletion loop) or the call host.
//     Ends the attempt for everyone: pending → zero-charge release + delete; live →
//     settle from frozen inputs + acknowledge + delete, all in ONE transaction, then
//     stop the LiveKit room and cascade the subcollections; ended (retained parent) →
//     acknowledge + delete + stop the room; doc already gone → resolve outstanding
//     attempts via the creation-resolution window.
//   * resolve { callDropId, attemptKey } — window-based resolution of one outstanding
//     attempt (the loop re-runs this on retry/resume while attempts are unresolved).
export async function POST(request: NextRequest) {
  try {
    const uidOrErr = await authUid(request);
    if (typeof uidOrErr !== 'string') return uidOrErr;
    const uid = uidOrErr;

    const body = await request.json().catch(() => ({}));
    const op = typeof body.op === 'string' ? body.op : '';
    const callDropId = typeof body.callDropId === 'string' ? body.callDropId : null;
    if (!callDropId) {
      return NextResponse.json({ error: 'callDropId is required' }, { status: 400 });
    }

    const db = getAdminDb();

    // ---------- op: resolve ----------
    if (op === 'resolve') {
      const attemptKey = typeof body.attemptKey === 'string' ? body.attemptKey : '';
      if (!attemptKey) {
        return NextResponse.json({ error: 'attemptKey is required' }, { status: 400 });
      }
      // Only the workspace's deleting owner drives window resolution from the loop.
      const attemptSnap = await attemptDocRef(db, callDropId, attemptKey).get();
      if (!attemptSnap.exists) {
        return NextResponse.json({ ok: true, status: 'missing' });
      }
      const data = attemptSnap.data()!;
      const wsSnap = await db.collection('workspaces').doc(String(data.workspaceId ?? '')).get();
      const authorized =
        (wsSnap.exists && wsSnap.get('deleting') === true && wsSnap.get('deletingOwner') === uid) ||
        data.registeredBy === uid;
      if (!authorized) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }
      const outcome = await resolveAttemptByWindow(db, {
        callDropId,
        attemptKey,
        roomName: typeof data.roomName === 'string' ? data.roomName : callDropId,
        phase: typeof data.phase === 'string' ? data.phase : 'resolved',
        registeredAt: typeof data.registeredAt === 'number' ? data.registeredAt : Date.now(),
      });
      return NextResponse.json({ ok: true, status: outcome });
    }

    // ---------- op: force-end ----------
    if (op !== 'force-end') {
      return NextResponse.json({ error: 'Unknown op' }, { status: 400 });
    }

    const callRef = db.collection('drops').doc(callDropId);
    const callSnap = await callRef.get();
    if (!callSnap.exists) {
      // Parent gone: resolve any outstanding attempts for this slot via the window.
      const outstanding = await db.collection('callTerminations')
        .where('callDropId', '==', callDropId)
        .where('phase', 'in', ['registered', 'roomCreated', 'creationFailed'])
        .limit(5)
        .get();
      let deferred = 0;
      for (const doc of outstanding.docs) {
        const d = doc.data();
        const outcome = await resolveAttemptByWindow(db, {
          callDropId,
          attemptKey: String(d.attemptKey ?? ''),
          roomName: typeof d.roomName === 'string' ? d.roomName : callDropId,
          phase: String(d.phase ?? 'registered'),
          registeredAt: typeof d.registeredAt === 'number' ? d.registeredAt : Date.now(),
        });
        if (outcome === 'unresolved') deferred += 1;
      }
      return NextResponse.json({ ok: true, status: 'gone', deferred });
    }

    const data = callSnap.data()!;
    if (data.type !== 'call') {
      return NextResponse.json({ error: 'Call not found' }, { status: 404 });
    }
    const workspaceId = typeof data.workspaceId === 'string' ? data.workspaceId : '';
    const wsSnap = await db.collection('workspaces').doc(workspaceId).get();
    const isDeletingOwner = wsSnap.exists && wsSnap.get('deleting') === true && wsSnap.get('deletingOwner') === uid;
    const isHost = data.callHostUid === uid;
    if (!isDeletingOwner && !isHost) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const roomName =
      typeof data.livekitRoomName === 'string' && data.livekitRoomName
        ? data.livekitRoomName
        : callDropId;
    const nowMs = Date.now();

    if (data.callState === 'pending') {
      // Never confirmed: zero-charge release + delete, then stop the room.
      const hostUid = typeof data.callHostUid === 'string' ? data.callHostUid : null;
      await db.runTransaction(async (txn) => {
        const snap = await txn.get(callRef);
        if (!snap.exists || snap.data()?.callState !== 'pending') return;
        if (hostUid) await releaseReservationForCallInTransaction(txn, db, hostUid, callDropId);
        txn.delete(callRef);
      });
    } else if (data.callState === 'live') {
      // Live: settle from frozen inputs + acknowledge + delete — ONE transaction.
      await db.runTransaction(async (txn) => {
        const snap = await txn.get(callRef);
        if (!snap.exists || snap.data()?.callState !== 'live') return;
        const callData = snap.data()!;
        const uids = Array.isArray(callData.callParticipantUids)
          ? callData.callParticipantUids.filter((u): u is string => typeof u === 'string')
          : [];
        const attemptSnap = await txn.get(attemptDocRef(db, callDropId, attemptKeyFromRoomName(callDropId, roomName)));
        const trustedByUid = await getTrustedStatusMapInTransaction(txn, db, uids);
        await getCallUsageStatesInTransaction(txn, db, uids, nowMs);
        const frozenJoinedAt = getCallParticipantJoinedAtMap(callData, uids);
        const frozenRelief = new Set(getCallTrustedReliefUids(callData, uids, trustedByUid));
        await settleCallUsageInTransaction(
          txn,
          db,
          uids,
          trustedByUid,
          callDropId,
          frozenJoinedAt,
          frozenRelief,
          nowMs,
        );
        ackAttemptInTransaction(txn, db, callDropId, roomName, attemptSnap, {
          reason: 'force-end',
          settled: true,
          chargeInputs: {
            uids,
            joinedAtByUid: frozenJoinedAt,
            trustedReliefUids: [...frozenRelief],
            chargeEndMs: nowMs,
          },
          workspaceId,
        });
        txn.delete(callRef);
      });
    } else {
      // ended (retained parent): acknowledge + delete. Usage was already settled by the
      // ordinary expired path; the acknowledgment records the terminal outcome.
      await db.runTransaction(async (txn) => {
        const snap = await txn.get(callRef);
        if (!snap.exists || snap.data()?.callState !== 'ended') return;
        const attemptSnap = await txn.get(attemptDocRef(db, callDropId, attemptKeyFromRoomName(callDropId, roomName)));
        ackAttemptInTransaction(txn, db, callDropId, roomName, attemptSnap, {
          reason: 'force-end-retained',
          settled: true,
          workspaceId,
        });
        txn.delete(callRef);
      });
    }

    // Stop the room (best-effort here; the loop retries while roomResolved stays false),
    // cascade the subcollections, and flip roomResolved when the room stop succeeded.
    const roomService = getLiveKitRoomService();
    let roomStopped = false;
    if (roomService) {
      try {
        await roomService.deleteRoom(roomName);
        roomStopped = true;
      } catch (e) {
        console.warn('[call/terminal] room stop failed', roomName, e);
      }
    }
    await cascadeCallSubcollectionsIfGeneration(db, callDropId, roomName).catch((e) => {
      console.warn('[call/terminal] cascade failed', callDropId, e);
    });
    if (roomStopped) {
      const attemptRef = attemptDocRef(db, callDropId, attemptKeyFromRoomName(callDropId, roomName));
      const snap = await attemptRef.get();
      if (snap.exists && snap.get('phase') === 'resolved' && snap.get('roomResolved') !== true) {
        await attemptRef.update({ roomResolved: true }).catch(() => {});
      }
    }
    return NextResponse.json({ ok: true, status: 'ended', roomStopped });
  } catch (error) {
    console.error('call/terminal error:', error);
    return NextResponse.json({ error: 'Terminal operation failed' }, { status: 500 });
  }
}
