import { NextRequest, NextResponse } from 'next/server';
import { Timestamp, type Firestore, type QueryDocumentSnapshot } from 'firebase-admin/firestore';
import { getAdminDb } from '@/lib/firebase-admin';
import {
  ABANDONED_CALL_GRACE_MS,
  CALL_PRESENCE_STALE_MS,
  cascadeCallSubcollectionsIfGeneration,
  enforceExpiredCall,
  getCallParticipantJoinedAtMap,
  getCallTrustedReliefUids,
  getCallUsageStatesInTransaction,
  getLiveKitRoomService,
  getLiveKitRoomParticipantCount,
  getTrustedStatusMapInTransaction,
  isPendingCallStale,
  refreshCallLimitState,
  releaseReservationForCallInTransaction,
  releaseReservationsForCallInTransaction,
  settleCallUsageInTransaction,
} from '../_lib';

export const runtime = 'nodejs';
export const maxDuration = 30;
export const dynamic = 'force-dynamic';

const TERMINAL_RETENTION_MS = 2 * 60 * 1000;

function isAuthorizedCron(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return request.headers.get('authorization') === `Bearer ${secret}`;
}

function timestampMs(value: unknown): number | null {
  if (!value || typeof value !== 'object') return null;
  const toMillis = (value as { toMillis?: unknown }).toMillis;
  return typeof toMillis === 'function'
    ? (value as { toMillis: () => number }).toMillis()
    : null;
}

async function endAbandonedCall(
  db: Firestore,
  callDoc: QueryDocumentSnapshot,
  nowMs: number,
): Promise<boolean> {
  const data = callDoc.data();
  const startedAtMs = timestampMs(data.callStartedAt);
  const expectedRoomSid = typeof data.livekitRoomSid === 'string' ? data.livekitRoomSid : null;
  const roomName =
    typeof data.livekitRoomName === 'string' && data.livekitRoomName
      ? data.livekitRoomName
      : callDoc.id;
  // Covers legacy live ghosts WITH a deadline too (the old pass excluded them): a live call whose
  // room has been empty for the grace period with no fresh presence is abandoned regardless of the
  // no-trusted deadline. Confirmed new calls are filtered out upstream (callConfirmedAt set), and a
  // genuinely-connected call always has participants + presence.
  if (
    data.type !== 'call' ||
    data.callState !== 'live' ||
    startedAtMs == null ||
    expectedRoomSid == null ||
    startedAtMs > nowMs - ABANDONED_CALL_GRACE_MS
  ) {
    return false;
  }

  const roomParticipantCount = await getLiveKitRoomParticipantCount(roomName);
  if (roomParticipantCount == null || roomParticipantCount > 0) return false;

  const presenceSnap = await callDoc.ref.collection('callPresence').get();
  const presenceDocs = presenceSnap.docs;
  const hasFreshPresence = presenceDocs.some((presenceDoc) => {
    const lastSeenMs = timestampMs(presenceDoc.data().lastSeen);
    return lastSeenMs != null && nowMs - lastSeenMs <= CALL_PRESENCE_STALE_MS;
  });
  if (hasFreshPresence) return false;
  // No presence doc EVER = nobody ever heartbeated = a legacy never-joined ghost. Release its
  // reservation with ZERO charge instead of billing the host for time they never spent in the room.
  const neverJoined = presenceDocs.length === 0;

  const ended = await db.runTransaction(async (txn) => {
    const snap = await txn.get(callDoc.ref);
    const current = snap.data();
    if (
      !snap.exists ||
      current?.type !== 'call' ||
      current.callState !== 'live' ||
      current.livekitRoomSid !== expectedRoomSid ||
      timestampMs(current.callStartedAt) !== startedAtMs
    ) {
      return false;
    }
    const participantUids = Array.isArray(current?.callParticipantUids)
      ? current.callParticipantUids.filter((uid): uid is string => typeof uid === 'string')
      : [];
    const trustedByUid = await getTrustedStatusMapInTransaction(txn, db, participantUids);
    const usageStates = await getCallUsageStatesInTransaction(txn, db, participantUids, nowMs);
    if (neverJoined) {
      // Batch release (all reads before all writes — Firestore transaction contract).
      await releaseReservationsForCallInTransaction(txn, db, participantUids, callDoc.id);
      txn.delete(callDoc.ref);
      return true;
    }
    await settleCallUsageInTransaction(
      txn,
      db,
      participantUids,
      trustedByUid,
      callDoc.id,
      getCallParticipantJoinedAtMap(current || {}, participantUids),
      new Set(getCallTrustedReliefUids(current || {}, participantUids, trustedByUid)),
      nowMs,
      usageStates,
    );
    txn.update(callDoc.ref, {
      callState: 'ended',
      callEndReason: 'room_abandoned',
      callEndedAt: Timestamp.fromMillis(nowMs),
      updatedAt: Timestamp.fromMillis(nowMs),
    });
    return true;
  });

  if (!ended) return false;

  if (neverJoined) {
    // Doc was deleted by the txn — clean its subcollections explicitly. Generation-aware: a newer
    // call reusing the slot is never touched.
    await cascadeCallSubcollectionsIfGeneration(db, callDoc.id, roomName).catch((error) => {
      console.warn(`[call/enforce] ghost cascade failed for ${callDoc.id}`, error);
    });
  }

  // The webhook normally removes the room and terminal document. This best-effort delete covers a
  // LiveKit webhook outage; the terminal retention pass removes the Firestore document later.
  const roomService = getLiveKitRoomService();
  if (roomService) {
    try {
      await roomService.deleteRoom(roomName);
    } catch (error) {
      console.warn(`[call/enforce] failed to close abandoned room ${roomName}`, error);
    }
  }
  return true;
}

/**
 * Daily-cron sweep for stale PENDING (created-but-never-confirmed) calls — the tab-close ghost call
 * safety net. The host's browser died before /api/call/confirm: the doc is invisible to members and
 * nothing was ever charged, so this just releases the reservation with zero charge, deletes the doc
 * + subcollections, and closes the never-joined LiveKit room. Lazy release (start/access routes)
 * handles the user-facing unblock between runs; this is the final mop-up.
 */
async function sweepStalePendingCalls(db: Firestore, nowMs: number): Promise<number> {
  const pendingSnap = await db.collection('drops').where('callState', '==', 'pending').get();
  let cleaned = 0;
  for (const callDoc of pendingSnap.docs) {
    const data = callDoc.data();
    if (data.type !== 'call') continue;
    if (!isPendingCallStale(data, nowMs)) continue;
    const roomName =
      typeof data.livekitRoomName === 'string' && data.livekitRoomName
        ? data.livekitRoomName
        : callDoc.id;
    const released = await db.runTransaction(async (txn) => {
      const snap = await txn.get(callDoc.ref);
      const current = snap.data();
      if (!snap.exists || current?.type !== 'call' || current.callState !== 'pending') return false;
      // Re-check staleness atomically (the pre-filter can race the grace boundary).
      if (!isPendingCallStale(current, nowMs)) {
        return false;
      }
      // Generation guard: only delete the doc that still owns the room we are about to close.
      const currentRoomName =
        typeof current.livekitRoomName === 'string' && current.livekitRoomName
          ? current.livekitRoomName
          : callDoc.id;
      if (currentRoomName !== roomName) return false;
      const hostUid = typeof current.callHostUid === 'string' ? current.callHostUid : null;
      if (hostUid) {
        // Raw read: normalization drops reservedCallId for a stale pending, which would skip the
        // release and leave a persisted reservation that resurrects when the slot is reused.
        await releaseReservationForCallInTransaction(txn, db, hostUid, callDoc.id);
      }
      txn.delete(callDoc.ref);
      return true;
    });
    if (!released) continue;
    await cascadeCallSubcollectionsIfGeneration(db, callDoc.id, roomName).catch((error) => {
      console.warn(`[call/enforce] pending cascade failed for ${callDoc.id}`, error);
    });
    const roomService = getLiveKitRoomService();
    if (roomService) {
      try {
        await roomService.deleteRoom(roomName);
      } catch (error) {
        console.warn(`[call/enforce] failed to close stale pending room ${roomName}`, error);
      }
    }
    cleaned += 1;
  }
  return cleaned;
}

// GET /api/call/enforce — Vercel Cron backstop. The browser timer gives users an accurate display;
// this route is the server authority that ends calls even when every browser is backgrounded.
export async function GET(request: NextRequest) {
  if (!isAuthorizedCron(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const db = getAdminDb();
    const nowMs = Date.now();
    // Use the existing single-field callState index. Filtering the deadline in memory keeps this
    // route deployable before a separate Firebase index deployment and the call count is bounded by
    // one active call per workspace.
    const liveSnap = await db.collection('drops').where('callState', '==', 'live').get();
    // Deadline-expired live calls (ANY confirmation state): the LEGACY ghost case must take the
    // no-charge abandoned path FIRST (empty room + no presence ever → no billing), so unconfirmed
    // docs get the ghost check before the billing settle below; a legacy REAL call (room occupied)
    // falls through to the normal enforce + charge, exactly as before this lifecycle change.
    const expiredDocs = liveSnap.docs.filter((callDoc) => {
      const data = callDoc.data();
      const deadline = data.callLimitDeadlineAt;
      return (
        data.type === 'call' &&
        deadline &&
        typeof deadline.toMillis === 'function' &&
        deadline.toMillis() <= nowMs
      );
    });
    // Abandoned candidates: (a) unconfirmed live docs (no callConfirmedAt — legacy pre-lifecycle
    // docs; the neverJoined heuristic inside endAbandonedCall decides charge vs no-charge) and
    // (b) confirmed trusted-host calls (deadline null — the old pass's scope). A genuinely-connected
    // call always has LiveKit participants + fresh presence, so it is skipped by endAbandonedCall.
    const abandonedDocs = liveSnap.docs.filter((callDoc) => {
      const data = callDoc.data();
      return (
        data.type === 'call' &&
        (data.callConfirmedAt == null || data.callLimitDeadlineAt == null)
      );
    });

    let ended = 0;
    for (const callDoc of expiredDocs) {
      const callData = callDoc.data();
      if (callData.callConfirmedAt == null && (await endAbandonedCall(db, callDoc, nowMs))) {
        ended += 1;
        continue; // legacy never-joined ghost — released with zero charge
      }
      // Re-read trust status immediately before ending. This catches a promotion to trusted even if
      // the participant's browser has not sent its next heartbeat yet.
      const state = await refreshCallLimitState(db, callDoc.id, nowMs);
      const result = state.expired
        ? await enforceExpiredCall(db, callDoc.id, nowMs)
        : { ended: false, participantUids: [] };
      if (result.ended) ended += 1;
    }

    for (const callDoc of abandonedDocs) {
      if (await endAbandonedCall(db, callDoc, nowMs)) ended += 1;
    }

    // Stale never-confirmed pending calls (tab-close ghost calls): invisible, never charged — the
    // sweep releases reservations with zero charge and deletes docs + rooms.
    const pendingCleaned = await sweepStalePendingCalls(db, nowMs);

    // room_finished normally removes terminal docs. This second pass handles a LiveKit outage or a
    // delayed webhook without leaving ended call metadata in the workspace list. The delete is
    // transactionally guarded (state must still be 'ended' + past retention) so a NEWER call that
    // reused the deterministic slot is never removed.
    const terminalBefore = Timestamp.fromMillis(nowMs - TERMINAL_RETENTION_MS);
    const endedSnap = await db.collection('drops').where('callState', '==', 'ended').get();
    const terminalDocs = endedSnap.docs.filter((callDoc) => {
      const data = callDoc.data();
      const endedAt = data.callEndedAt;
      return data.type === 'call' && endedAt && typeof endedAt.toMillis === 'function' && endedAt.toMillis() <= terminalBefore.toMillis();
    });
    let cleaned = 0;
    for (const callDoc of terminalDocs) {
      const data = callDoc.data();
      const roomName =
        typeof data.livekitRoomName === 'string' && data.livekitRoomName
          ? data.livekitRoomName
          : callDoc.id;
      const deleted = await db
        .runTransaction(async (txn) => {
          const snap = await txn.get(callDoc.ref);
          if (!snap.exists || snap.data()?.callState !== 'ended') return false;
          // Generation guard: only delete the exact ended generation we captured (a newer call that
          // reused the slot and somehow reached 'ended' must not be removed by this pass).
          const currentRoom =
            typeof snap.data()?.livekitRoomName === 'string' && snap.data()?.livekitRoomName
              ? snap.data()?.livekitRoomName
              : callDoc.id;
          if (currentRoom !== roomName) return false;
          const endedAt = snap.data()?.callEndedAt;
          if (!endedAt || typeof endedAt.toMillis !== 'function' || endedAt.toMillis() > terminalBefore.toMillis()) {
            return false;
          }
          txn.delete(callDoc.ref);
          return true;
        })
        .catch((error) => {
          console.warn(`[call/enforce] terminal delete failed for ${callDoc.id}`, error);
          return false;
        });
      if (!deleted) continue;
      await cascadeCallSubcollectionsIfGeneration(db, callDoc.id, roomName).catch((error) => {
        console.warn(`[call/enforce] cascade failed for ${callDoc.id}`, error);
      });
      cleaned += 1;
    }

    return NextResponse.json({ ok: true, ended, cleaned, pendingCleaned });
  } catch (error) {
    console.error('[call/enforce] failed:', error);
    return NextResponse.json({ error: 'Call enforcement failed' }, { status: 500 });
  }
}
