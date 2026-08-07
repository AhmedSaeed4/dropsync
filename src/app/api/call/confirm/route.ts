import { NextRequest, NextResponse } from 'next/server';
import { getAdminDb } from '@/lib/firebase-admin';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { createHash } from 'node:crypto';
import {
  CALL_LIMIT_MESSAGE,
  CALL_TOTAL_MINUTES,
  authUid,
  getCallUsageStatesInTransaction,
  getLiveKitRoomService,
  getTrustedStatusMapInTransaction,
  isPendingCallStale,
  reserveCallUsageInTransaction,
} from '../_lib';

export const runtime = 'nodejs';
export const maxDuration = 30;
export const dynamic = 'force-dynamic';

// POST /api/call/confirm — body { callDropId, attemptToken }. The host calls this IMMEDIATELY
// AFTER room.connect() succeeds on the pending room. It is the ONLY route that promotes
// pending → live:
//
// 1. Verifies Firebase identity + workspace membership + callHostUid === uid (the pending roster
//    only ever contains the host).
// 2. Verifies the one-time attempt token (sha256 of the token returned by /api/call/start) — a
//    stale browser holding an old token cannot promote a replaced pending doc.
// 3. Verifies the host is ACTUALLY connected in LiveKit (listParticipants on the generation-unique
//    room). This is the ground truth that makes "live" mean "a real participant is in the room".
// 4. Atomically promotes the doc to live, starts the clock (callStartedAt), and writes the
//    time-limit fields. The usage reservation made at start is kept (idempotent re-reserve covers
//    the case where the lazy-release path cleared it).
//
// If the host's browser dies before this call, the pending doc stays invisible and is cleaned by
// the daily sweep / lazy release — never charged, never shown to other members.
export async function POST(request: NextRequest) {
  try {
    const uidOrErr = await authUid(request);
    if (typeof uidOrErr !== 'string') return uidOrErr;
    const uid = uidOrErr;

    const body = await request.json().catch(() => ({}));
    const callDropId = typeof body.callDropId === 'string' ? body.callDropId : null;
    const attemptToken = typeof body.attemptToken === 'string' ? body.attemptToken : null;
    if (!callDropId || !attemptToken) {
      return NextResponse.json({ error: 'callDropId and attemptToken are required' }, { status: 400 });
    }

    const db = getAdminDb();
    const callRef = db.collection('drops').doc(callDropId);
    const nowMs = Date.now();

    // ---- pre-checks (re-verified inside the txn) ----
    const previewSnap = await callRef.get();
    const preview = previewSnap.exists ? previewSnap.data() : null;
    if (!previewSnap.exists || preview?.type !== 'call' || preview.callState !== 'pending') {
      return NextResponse.json({ error: 'Call is not starting' }, { status: 404 });
    }
    if (preview.callHostUid !== uid) {
      return NextResponse.json({ error: 'Only the call host can confirm this call' }, { status: 403 });
    }
    const expectedHash = typeof preview.callPendingAttemptHash === 'string' ? preview.callPendingAttemptHash : null;
    if (!expectedHash || createHash('sha256').update(attemptToken).digest('hex') !== expectedHash) {
      return NextResponse.json({ error: 'Invalid attempt token' }, { status: 403 });
    }
    // A pending call past its grace is an ABANDONED start — the sweep will delete it. Refuse to
    // revive it here: the host gets an error, disconnects, and their retry creates a fresh pending
    // (the leave on cleanup releases the old reservation with zero charge).
    if (isPendingCallStale(preview, nowMs)) {
      return NextResponse.json(
        { error: 'This call start has expired. Please try starting again.' },
        { status: 410 },
      );
    }
    const workspaceId = typeof preview.workspaceId === 'string' ? preview.workspaceId : null;
    if (!workspaceId) {
      return NextResponse.json({ error: 'Call is not attached to a workspace' }, { status: 403 });
    }
    const workspaceSnap = await db.collection('workspaces').doc(workspaceId).get();
    const workspaceMembers = workspaceSnap.data()?.members;
    if (!workspaceSnap.exists || !Array.isArray(workspaceMembers) || !workspaceMembers.includes(uid)) {
      return NextResponse.json({ error: 'Not a member of this workspace' }, { status: 403 });
    }

    // ---- ground-truth: the host must be connected in LiveKit ----
    const roomName =
      typeof preview.livekitRoomName === 'string' && preview.livekitRoomName
        ? preview.livekitRoomName
        : callDropId;
    const roomService = getLiveKitRoomService();
    if (!roomService) {
      console.error('call/confirm: LiveKit room service is not configured');
      return NextResponse.json({ error: 'LiveKit is not configured' }, { status: 500 });
    }
    let hostConnected = false;
    try {
      const participants = await roomService.listParticipants(roomName);
      hostConnected = participants.some((p) => p.identity === uid);
    } catch (error) {
      console.warn('[call/confirm] LiveKit presence check failed — retryable', error);
      return NextResponse.json({ error: 'Could not verify the connection. Retrying…' }, { status: 503 });
    }
    if (!hostConnected) {
      // The client retries for a second or two after connect before giving up.
      return NextResponse.json({ error: 'Not connected to the call yet' }, { status: 409 });
    }

    // ---- atomic promotion ----
    let result:
      | { kind: 'promoted' }
      | { kind: 'stale' }
      | { kind: 'limited'; resetAtMs: number }
      | { kind: 'notfound' };
    try {
      result = await db.runTransaction(async (txn) => {
        const snap = await txn.get(callRef);
        const data = snap.exists ? snap.data() : null;
        if (!snap.exists || data?.type !== 'call' || data.callState !== 'pending') {
          return { kind: 'notfound' as const };
        }
        // Expected-state guards (re-verified atomically): only promote the exact pending generation
        // this attempt token belongs to, and never a stale (abandoned) pending — the pre-check can
        // race the grace boundary, so the transaction re-checks before writing.
        if (data.callHostUid !== uid) return { kind: 'notfound' as const };
        const currentHash = typeof data.callPendingAttemptHash === 'string' ? data.callPendingAttemptHash : null;
        if (!currentHash || createHash('sha256').update(attemptToken).digest('hex') !== currentHash) {
          return { kind: 'notfound' as const };
        }
        if (isPendingCallStale(snap.data(), nowMs)) return { kind: 'stale' as const };
        const trustedByUid = await getTrustedStatusMapInTransaction(txn, db, [uid]);
        const trustedForCall = trustedByUid.get(uid) === true;
        const usageStates = await getCallUsageStatesInTransaction(txn, db, [uid], nowMs);
        const usage = usageStates.get(uid);
        const remainingMinutes = trustedForCall
          ? CALL_TOTAL_MINUTES
          : usage
            ? reserveCallUsageInTransaction(txn, db, uid, callDropId, usage, nowMs)
            : null;
        if (!trustedForCall && remainingMinutes == null) {
          return { kind: 'limited' as const, resetAtMs: usage?.resetAtMs ?? nowMs };
        }
        txn.update(callRef, {
          callState: 'live',
          callStartedAt: FieldValue.serverTimestamp(),
          callConfirmedAt: FieldValue.serverTimestamp(),
          callPendingExpiresAt: null,
          callPendingAttemptHash: FieldValue.delete(),
          callParticipantJoinedAt: { [uid]: Timestamp.fromMillis(nowMs) },
          trustedParticipantCount: trustedForCall ? 1 : 0,
          callLimitDeadlineAt: trustedForCall
            ? null
            : Timestamp.fromMillis(nowMs + (remainingMinutes as number) * 60_000),
        });
        return { kind: 'promoted' as const };
      });
    } catch (err) {
      console.error('call/confirm transaction failed:', err);
      return NextResponse.json({ error: 'Failed to confirm call' }, { status: 500 });
    }

    if (result.kind === 'notfound') {
      return NextResponse.json({ error: 'Call is not starting' }, { status: 404 });
    }
    if (result.kind === 'stale') {
      return NextResponse.json(
        { error: 'This call start has expired. Please try starting again.' },
        { status: 410 },
      );
    }
    if (result.kind === 'limited') {
      return NextResponse.json(
        { error: CALL_LIMIT_MESSAGE, resetAt: result.resetAtMs },
        { status: 429 },
      );
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('call/confirm error:', error);
    return NextResponse.json({ error: 'Failed to confirm call' }, { status: 500 });
  }
}
