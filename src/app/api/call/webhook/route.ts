import { NextRequest, NextResponse } from 'next/server';
import { WebhookReceiver } from 'livekit-server-sdk';
import { getAdminDb } from '@/lib/firebase-admin';
import {
  cascadeCallSubcollections,
  deriveCallLimitFields,
  enforceExpiredCall,
  getTrustedStatusMapInTransaction,
} from '../_lib';

export const runtime = 'nodejs';
export const maxDuration = 30;
export const dynamic = 'force-dynamic';

const PARTICIPANT_EXIT_EVENTS = new Set([
  'participant_left',
  'participant_connection_aborted',
]);

type CleanupDecision = {
  handled: boolean;
  callEnded: boolean;
  cascade: boolean;
  expired: boolean;
};

function isCallRoom(roomName: string): boolean {
  return roomName.startsWith('call-');
}

/**
 * Remove one participant from the route-owned roster. The transaction makes duplicate LiveKit
 * deliveries harmless and ensures the call is deleted only when this participant was actually the
 * last roster entry.
 */
async function removeParticipant(
  callDropId: string,
  roomSid: string,
  uid: string,
): Promise<CleanupDecision> {
  const db = getAdminDb();
  const callRef = db.collection('drops').doc(callDropId);
  const presenceRef = callRef.collection('callPresence').doc(uid);
  const nowMs = Date.now();

  let decision: CleanupDecision = {
    handled: false,
    callEnded: false,
    cascade: false,
    expired: false,
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    decision = await db.runTransaction(async (txn): Promise<CleanupDecision> => {
    const snap = await txn.get(callRef);
    if (!snap.exists || snap.data()?.type !== 'call' || snap.data()?.callState !== 'live') {
      // A previous delivery may have deleted the call before its subcollection cleanup completed.
      // Retrying the cascade is safe and makes cleanup resilient to that partial failure.
      return { handled: false, callEnded: false, cascade: !snap.exists, expired: false };
    }

    if (snap.data()?.livekitRoomSid !== roomSid) {
      return { handled: false, callEnded: false, cascade: false, expired: false };
    }

    const rawDeadline = snap.data()?.callLimitDeadlineAt;
    const currentDeadlineMs =
      rawDeadline && typeof rawDeadline.toMillis === 'function' ? rawDeadline.toMillis() : null;
    if (currentDeadlineMs != null && currentDeadlineMs <= nowMs) {
      return { handled: true, callEnded: true, cascade: false, expired: true };
    }

    const rawUids = snap.data()?.callParticipantUids;
    const uids = Array.isArray(rawUids)
      ? rawUids.filter((value): value is string => typeof value === 'string')
      : [];

    if (!uids.includes(uid)) {
      // LiveKit retries events, so an already-removed participant is a successful no-op.
      return { handled: true, callEnded: false, cascade: false, expired: false };
    }

    const nextUids = uids.filter((value) => value !== uid);

    if (nextUids.length === 0) {
      txn.delete(presenceRef);
      txn.delete(callRef);
      return { handled: true, callEnded: true, cascade: true, expired: false };
    }

    const trustedByUid = await getTrustedStatusMapInTransaction(txn, db, nextUids);
    const limitFields = deriveCallLimitFields(nextUids, trustedByUid, currentDeadlineMs, nowMs);
    txn.delete(presenceRef);
    txn.update(callRef, {
      callParticipantUids: nextUids,
      trustedParticipantCount: limitFields.trustedParticipantCount,
      callLimitDeadlineAt: limitFields.callLimitDeadlineAt,
    });
    return { handled: true, callEnded: false, cascade: false, expired: false };
    });

    if (!decision.expired) break;
    const enforcement = await enforceExpiredCall(db, callDropId, nowMs);
    if (enforcement.ended) {
      return { handled: true, callEnded: true, cascade: false, expired: true };
    }
  }

  if (decision.expired) {
    return { handled: true, callEnded: false, cascade: false, expired: false };
  }

  if (decision.cascade) {
    await cascadeCallSubcollections(db, callDropId);
  }
  return decision;
}

/**
 * A room_finished event is the authoritative empty-room signal. Delete the call document in a
 * transaction, then clean its Firestore subcollections because Firestore does not cascade deletes.
 */
async function finishRoom(callDropId: string, roomSid: string): Promise<CleanupDecision> {
  const db = getAdminDb();
  const callRef = db.collection('drops').doc(callDropId);

  const decision = await db.runTransaction(async (txn): Promise<CleanupDecision> => {
    const snap = await txn.get(callRef);
    if (!snap.exists || snap.data()?.type !== 'call') {
      // A previous delivery may have deleted the call before its subcollection cleanup completed.
      // Retrying the cascade is safe and makes cleanup resilient to that partial failure.
      return { handled: false, callEnded: false, cascade: !snap.exists, expired: false };
    }

    if (snap.data()?.livekitRoomSid !== roomSid) {
      return { handled: false, callEnded: false, cascade: false, expired: false };
    }

    txn.delete(callRef);
    return { handled: true, callEnded: true, cascade: true, expired: false };
  });

  if (decision.cascade) {
    await cascadeCallSubcollections(db, callDropId);
  }
  return decision;
}

/**
 * POST /api/call/webhook — receives signed LiveKit room events.
 *
 * The body must stay as raw text until WebhookReceiver validates it. Firebase authentication is not
 * used here because LiveKit, not a browser user, is the caller. The LiveKit API key and secret prove
 * that the request came from the configured LiveKit project.
 */
export async function POST(request: NextRequest) {
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  if (!apiKey || !apiSecret) {
    console.error('[call/webhook] LiveKit webhook verification is not configured');
    return NextResponse.json({ error: 'LiveKit webhook is not configured' }, { status: 500 });
  }

  const body = await request.text();
  const authorization = request.headers.get('Authorization') ?? undefined;

  let event: Awaited<ReturnType<WebhookReceiver['receive']>>;
  try {
    const receiver = new WebhookReceiver(apiKey, apiSecret);
    event = await receiver.receive(body, authorization, false, '5s');
  } catch (error) {
    // Do not reveal whether the key, signature, timestamp, or body checksum was invalid.
    console.warn(
      '[call/webhook] verification failed:',
      error instanceof Error ? error.message : error,
    );
    return NextResponse.json({ error: 'Invalid LiveKit webhook' }, { status: 401 });
  }

  const roomName = event.room?.name;
  const roomSid = event.room?.sid;
  if (!roomName || !roomSid || !isCallRoom(roomName)) {
    return NextResponse.json({ ok: true, handled: false });
  }

  try {
    if (event.event === 'room_finished') {
      const decision = await finishRoom(roomName, roomSid);
      return NextResponse.json({ ok: true, ...decision });
    }

    if (PARTICIPANT_EXIT_EVENTS.has(event.event)) {
      const uid = event.participant?.identity;
      if (!uid) return NextResponse.json({ ok: true, handled: false });

      const decision = await removeParticipant(roomName, roomSid, uid);
      return NextResponse.json({ ok: true, ...decision });
    }

    // Valid but unrelated LiveKit events (joins, tracks, egress, and ingress) need no response-side
    // work. Returning 200 prevents LiveKit from retrying events this route intentionally ignores.
    return NextResponse.json({ ok: true, handled: false });
  } catch (error) {
    // A 500 tells LiveKit to retry a transient Firestore or cascade failure.
    console.error('[call/webhook] cleanup failed:', error);
    return NextResponse.json({ error: 'Call cleanup failed' }, { status: 500 });
  }
}
