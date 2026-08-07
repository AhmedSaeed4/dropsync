import { NextRequest, NextResponse } from 'next/server';
import { WebhookReceiver } from 'livekit-server-sdk';
import { getAdminDb } from '@/lib/firebase-admin';
import type { DocumentData } from 'firebase-admin/firestore';
import {
  cascadeCallSubcollectionsIfGeneration,
  deriveCallLimitFields,
  enforceExpiredCall,
  getCallParticipantJoinedAtMap,
  getCallParticipantJoinedAtRecord,
  getCallTrustedReliefUids,
  getCallUsageStatesInTransaction,
  getTrustedStatusMapInTransaction,
  reconcileTrustedCallTransitionInTransaction,
  releaseReservationForCallInTransaction,
  releaseReservationsForCallInTransaction,
  reserveCallUsageInTransaction,
  settleCallUsageInTransaction,
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
 * Resolve a LiveKit room name to its Firestore call doc. New calls use generation-unique room names
 * (livekitRoomName on the doc), so the room name is NEVER a document id anymore. The lookup keys on
 * livekitRoomName; a delayed webhook from an OLD generation simply finds nothing (its unique room
 * name cannot match a newer call), which is what makes the webhook generation-safe. Legacy calls
 * (pre-lifecycle rooms named after the doc id) fall back to a direct doc-id read — the SID guard in
 * every handler still rejects any stale event against a newer doc in the reused slot.
 */
async function findCallDropByRoomName(
  roomName: string,
): Promise<{ callDropId: string; data: DocumentData } | null> {
  const db = getAdminDb();
  try {
    const byRoom = await db
      .collection('drops')
      .where('livekitRoomName', '==', roomName)
      .limit(1)
      .get();
    if (!byRoom.empty) {
      return { callDropId: byRoom.docs[0].id, data: byRoom.docs[0].data() };
    }
  } catch (error) {
    console.warn(`[call/webhook] livekitRoomName lookup failed for ${roomName}`, error);
    // Fall through to the legacy doc-id read; the SID guard below still protects against misuse.
  }
  const legacySnap = await db.collection('drops').doc(roomName).get();
  if (legacySnap.exists) {
    return { callDropId: roomName, data: legacySnap.data() as DocumentData };
  }
  return null;
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
  eventRoomName: string,
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
      // A pending call's host disconnecting before confirmation (e.g. the confirm step failed and
      // the browser closed): the LiveKit leave event is the abort signal — release the reservation
      // with zero charge and delete the invisible pending doc. This is a second safety net on top of
      // the leave route + daily sweep.
      if (snap.exists && snap.data()?.type === 'call' && snap.data()?.callState === 'pending') {
        if (snap.data()?.callHostUid === uid && snap.data()?.livekitRoomSid === roomSid) {
          // Raw read: normalization drops reservedCallId for a stale pending, which would skip the
          // release and leave a persisted reservation that resurrects when the slot is reused.
          await releaseReservationForCallInTransaction(txn, db, uid, callDropId);
          txn.delete(callRef);
          return { handled: true, callEnded: true, cascade: true, expired: false };
        }
        return { handled: true, callEnded: false, cascade: false, expired: false };
      }
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

    const callData = snap.data() || {};
    const rawUids = callData.callParticipantUids;
    const uids = Array.isArray(rawUids)
      ? rawUids.filter((value): value is string => typeof value === 'string')
      : [];

    if (!uids.includes(uid)) {
      // LiveKit retries events, so an already-removed participant is a successful no-op.
      return { handled: true, callEnded: false, cascade: false, expired: false };
    }

    const trustedByUid = await getTrustedStatusMapInTransaction(txn, db, uids);
    const usageStates = await getCallUsageStatesInTransaction(txn, db, uids, nowMs);
    const joinedAtByUid = getCallParticipantJoinedAtMap(callData, uids);
    const trustedReliefUids = getCallTrustedReliefUids(callData, uids, trustedByUid);

    const nextUids = uids.filter((value) => value !== uid);

    if (nextUids.length === 0) {
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
      txn.delete(presenceRef);
      txn.delete(callRef);
      return { handled: true, callEnded: true, cascade: true, expired: false };
    }

    const trustedTransition = await reconcileTrustedCallTransitionInTransaction(
      txn,
      db,
      callDropId,
      callData,
      uids,
      nextUids,
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
    for (const nextUid of nextUids) {
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
      nextUids,
      trustedByUid,
      currentDeadlineMs,
      nowMs,
      remainingMinutesByUid,
    );
    txn.delete(presenceRef);
    txn.update(callRef, {
      callParticipantUids: nextUids,
      callParticipantJoinedAt: getCallParticipantJoinedAtRecord(
        trustedTransition.joinedAtByUid,
        nextUids,
      ),
      callTrustedReliefUids: trustedTransition.trustedReliefUids,
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
    // Generation-aware: the slot may have been reused by a newer start before this cascade ran.
    await cascadeCallSubcollectionsIfGeneration(db, callDropId, eventRoomName);
  }
  return decision;
}

/**
 * A room_finished event is the authoritative empty-room signal. Delete the call document in a
 * transaction, then clean its Firestore subcollections because Firestore does not cascade deletes.
 */
async function finishRoom(
  callDropId: string,
  roomSid: string,
  eventRoomName: string,
): Promise<CleanupDecision> {
  const db = getAdminDb();
  const callRef = db.collection('drops').doc(callDropId);
  const nowMs = Date.now();

  // Legacy never-joined ghost detection: a LIVE call that was never confirmed (no callConfirmedAt —
  // pre-lifecycle doc) with NO presence docs ever means nobody actually connected. Such ghosts must
  // be released with ZERO charge, not billed by the settle below. Presence is read before the txn
  // (queries are not allowed inside transactions).
  const previewSnap = await callRef.get();
  const preview = previewSnap.exists ? previewSnap.data() : null;
  let neverJoinedLegacy = false;
  if (preview?.type === 'call' && preview.callState === 'live' && preview.callConfirmedAt == null) {
    const presenceSnap = await callRef.collection('callPresence').get();
    neverJoinedLegacy = presenceSnap.empty;
  }

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

    // A pending (never-confirmed) room that finished: nobody ever joined, so release the host's
    // reservation with zero charge and delete the invisible doc — mirrors the leave/sweep paths.
    if (snap.data()?.callState === 'pending') {
      const hostUid = snap.data()?.callHostUid;
      if (typeof hostUid === 'string') {
        await releaseReservationForCallInTransaction(txn, db, hostUid, callDropId);
      }
      txn.delete(callRef);
      return { handled: true, callEnded: true, cascade: true, expired: false };
    }

    if (snap.data()?.callState !== 'live') {
      // Expired calls keep their terminal reason briefly so clients can show why they ended.
      return { handled: true, callEnded: false, cascade: false, expired: false };
    }

    const callData = snap.data() || {};
    const participantUids = Array.isArray(callData.callParticipantUids)
      ? callData.callParticipantUids.filter((uid): uid is string => typeof uid === 'string')
      : [];
    if (neverJoinedLegacy) {
      // Legacy never-joined ghost: release every roster member's reservation with zero charge and
      // delete — nobody ever spent time in this room, so nobody is billed. Batch release: all
      // reads precede all writes (Firestore transaction contract).
      await releaseReservationsForCallInTransaction(txn, db, participantUids, callDropId);
      txn.delete(callRef);
      return { handled: true, callEnded: true, cascade: true, expired: false };
    }
    const trustedByUid = await getTrustedStatusMapInTransaction(txn, db, participantUids);
    const usageStates = await getCallUsageStatesInTransaction(txn, db, participantUids, nowMs);
    await settleCallUsageInTransaction(
      txn,
      db,
      participantUids,
      trustedByUid,
      callDropId,
      getCallParticipantJoinedAtMap(callData, participantUids),
      new Set(getCallTrustedReliefUids(callData, participantUids, trustedByUid)),
      nowMs,
      usageStates,
    );

    txn.delete(callRef);
    return { handled: true, callEnded: true, cascade: true, expired: false };
  });

  if (decision.cascade) {
    // Generation-aware: the slot may have been reused by a newer start before this cascade ran.
    await cascadeCallSubcollectionsIfGeneration(db, callDropId, eventRoomName);
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
    // Generation-safe resolution: the unique room name maps to exactly one call doc (or none, if
    // the call was already cleaned up). A delayed webhook from an old generation can never cascade
    // a newer call in the reused `call-{workspaceId}` slot.
    const resolved = await findCallDropByRoomName(roomName);
    if (!resolved) {
      return NextResponse.json({ ok: true, handled: false });
    }
    const callDropId = resolved.callDropId;

    if (event.event === 'room_finished') {
      const decision = await finishRoom(callDropId, roomSid, roomName);
      return NextResponse.json({ ok: true, ...decision });
    }

    if (PARTICIPANT_EXIT_EVENTS.has(event.event)) {
      const uid = event.participant?.identity;
      if (!uid) return NextResponse.json({ ok: true, handled: false });

      const decision = await removeParticipant(callDropId, roomSid, uid, roomName);
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
