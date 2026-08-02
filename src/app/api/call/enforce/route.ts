import { NextRequest, NextResponse } from 'next/server';
import { Timestamp, type Firestore, type QueryDocumentSnapshot } from 'firebase-admin/firestore';
import { getAdminDb } from '@/lib/firebase-admin';
import {
  ABANDONED_CALL_GRACE_MS,
  CALL_PRESENCE_STALE_MS,
  cascadeCallSubcollections,
  enforceExpiredCall,
  getLiveKitRoomService,
  getLiveKitRoomParticipantCount,
  refreshCallLimitState,
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
  if (
    data.type !== 'call' ||
    data.callState !== 'live' ||
    data.callLimitDeadlineAt != null ||
    startedAtMs == null ||
    expectedRoomSid == null ||
    startedAtMs > nowMs - ABANDONED_CALL_GRACE_MS
  ) {
    return false;
  }

  const roomParticipantCount = await getLiveKitRoomParticipantCount(callDoc.id);
  if (roomParticipantCount == null || roomParticipantCount > 0) return false;

  const presenceSnap = await callDoc.ref.collection('callPresence').get();
  const hasFreshPresence = presenceSnap.docs.some((presenceDoc) => {
    const lastSeenMs = timestampMs(presenceDoc.data().lastSeen);
    return lastSeenMs != null && nowMs - lastSeenMs <= CALL_PRESENCE_STALE_MS;
  });
  if (hasFreshPresence) return false;

  const ended = await db.runTransaction(async (txn) => {
    const snap = await txn.get(callDoc.ref);
    const current = snap.data();
    if (
      !snap.exists ||
      current?.type !== 'call' ||
      current.callState !== 'live' ||
      current.callLimitDeadlineAt != null ||
      current.livekitRoomSid !== expectedRoomSid ||
      timestampMs(current.callStartedAt) !== startedAtMs
    ) {
      return false;
    }
    txn.update(callDoc.ref, {
      callState: 'ended',
      callEndReason: 'room_abandoned',
      callEndedAt: Timestamp.fromMillis(nowMs),
      updatedAt: Timestamp.fromMillis(nowMs),
    });
    return true;
  });

  if (!ended) return false;

  // The webhook normally removes the room and terminal document. This best-effort delete covers a
  // LiveKit webhook outage; the terminal retention pass removes the Firestore document later.
  const roomService = getLiveKitRoomService();
  if (roomService) {
    try {
      await roomService.deleteRoom(callDoc.id);
    } catch (error) {
      console.warn(`[call/enforce] failed to close abandoned room ${callDoc.id}`, error);
    }
  }
  return true;
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
    const expiredDocs = liveSnap.docs.filter((callDoc) => {
      const data = callDoc.data();
      const deadline = data.callLimitDeadlineAt;
      return data.type === 'call' && deadline && typeof deadline.toMillis === 'function' && deadline.toMillis() <= nowMs;
    });
    const abandonedDocs = liveSnap.docs.filter((callDoc) => {
      const data = callDoc.data();
      return data.type === 'call' && data.callLimitDeadlineAt == null;
    });

    let ended = 0;
    for (const callDoc of expiredDocs) {
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

    // room_finished normally removes terminal docs. This second pass handles a LiveKit outage or a
    // delayed webhook without leaving ended call metadata in the workspace list.
    const terminalBefore = Timestamp.fromMillis(nowMs - TERMINAL_RETENTION_MS);
    const endedSnap = await db.collection('drops').where('callState', '==', 'ended').get();
    const terminalDocs = endedSnap.docs.filter((callDoc) => {
      const data = callDoc.data();
      const endedAt = data.callEndedAt;
      return data.type === 'call' && endedAt && typeof endedAt.toMillis === 'function' && endedAt.toMillis() <= terminalBefore.toMillis();
    });
    let cleaned = 0;
    for (const callDoc of terminalDocs) {
      await cascadeCallSubcollections(db, callDoc.id).catch((error) => {
        console.warn(`[call/enforce] cascade failed for ${callDoc.id}`, error);
      });
      await callDoc.ref.delete();
      cleaned += 1;
    }

    return NextResponse.json({ ok: true, ended, cleaned });
  } catch (error) {
    console.error('[call/enforce] failed:', error);
    return NextResponse.json({ error: 'Call enforcement failed' }, { status: 500 });
  }
}
