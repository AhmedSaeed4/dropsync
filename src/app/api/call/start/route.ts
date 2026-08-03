import { NextRequest, NextResponse } from 'next/server';
import { getAdminDb } from '@/lib/firebase-admin';
import { Timestamp, FieldValue } from 'firebase-admin/firestore';
import {
  CALL_LIMIT_MESSAGE,
  CALL_TOTAL_MINUTES,
  authUid,
  cascadeCallSubcollections,
  enforceExpiredCall,
  getCallUsageStatesInTransaction,
  getLiveKitRoomService,
  getTrustedStatusMapInTransaction,
  reserveCallUsageInTransaction,
  refreshCallLimitState,
} from '../_lib';

// Mirror /api/transcribe: Node runtime, 30s headroom under Vercel's timeout, always dynamic. The
// added Firestore transaction (one-call-per-workspace) needs the headroom.
export const runtime = 'nodejs';
export const maxDuration = 30;
export const dynamic = 'force-dynamic';

// POST /api/call/start  — body { workspaceId }. The SOLE creator of a call drop (NEVER client-side;
// firestore.rules block client create of type 'call'). Enforces ONE-CALL-PER-WORKSPACE via a single
// transaction on the DETERMINISTIC doc id `drops/call-{workspaceId}`: concurrent starters collide
// on the same id, the txn retries, the second sees the now-existing live call and JOINS it. Returns
// { callDropId } (created or pre-existing — either way, the id to join).
export async function POST(request: NextRequest) {
  try {
    const uidOrErr = await authUid(request);
    if (typeof uidOrErr !== 'string') return uidOrErr;
    const uid = uidOrErr;

    const body = await request.json().catch(() => ({}));
    const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId : null;
    if (!workspaceId) {
      return NextResponse.json({ error: 'workspaceId is required' }, { status: 400 });
    }

    const db = getAdminDb();

    // (1) Re-derive membership server-side. 403 if the caller isn't a member (NEVER trust a body uid).
    const wsSnap = await db.collection('workspaces').doc(workspaceId).get();
    if (!wsSnap.exists) {
      return NextResponse.json({ error: 'Workspace not found' }, { status: 403 });
    }
    const members: unknown = wsSnap.data()?.members;
    if (!Array.isArray(members) || !members.includes(uid)) {
      return NextResponse.json({ error: 'Not a member of this workspace' }, { status: 403 });
    }

    // Host display name (creatorName) — profiles/{uid}.displayName, else users/{uid}.email prefix.
    // Display-only: the drop card resolves the host name from workspaceMembers by callHostUid.
    let hostDisplayName = 'Host';
    try {
      const prof = await db.collection('profiles').doc(uid).get();
      const profName = prof.exists ? prof.data()?.displayName : null;
      if (typeof profName === 'string' && profName.trim()) {
        hostDisplayName = profName.trim();
      } else {
        const u = await db.collection('users').doc(uid).get();
        const email = u.exists ? u.data()?.email : null;
        if (typeof email === 'string' && email.includes('@')) hostDisplayName = email.split('@')[0];
      }
    } catch {
      /* best-effort — fall back to 'Host' */
    }

    // (2) ONE transaction on the deterministic id. The create is INSIDE the txn so the one-call-
    // per-workspace invariant is atomic. set() overwrites a stale/dead call in the slot (no
    // delete+set conflict); the subcollection leftovers from that stale call are cascaded after.
    const callDocId = `call-${workspaceId}`;
    const callRef = db.collection('drops').doc(callDocId);
    const nowMs = Date.now();

    // Avoid creating a second LiveKit room when this request is simply joining an already-live call.
    // New calls explicitly create the room here so its server-issued SID can be bound to the call doc;
    // the webhook uses that binding to reject delayed events from an older call in this reused slot.
    const currentSnap = await callRef.get();
    if (currentSnap.exists) {
      const currentData = currentSnap.data() as {
        callState?: string;
      };
      if (currentData.callState === 'live') {
        const limitState = await refreshCallLimitState(db, callDocId, nowMs);
        if (limitState.expired) {
          const enforcement = await enforceExpiredCall(db, callDocId, nowMs);
          if (!enforcement.ended) {
            const currentAfterEnforcement = await callRef.get();
            if (currentAfterEnforcement.data()?.callState === 'live') {
              return NextResponse.json({ callDropId: callDocId });
            }
          }
        } else {
          return NextResponse.json({ callDropId: callDocId });
        }
      }
    }

    const roomService = getLiveKitRoomService();
    if (!roomService) {
      console.error('call/start: LiveKit room service is not configured');
      return NextResponse.json({ error: 'LiveKit is not configured' }, { status: 500 });
    }

    let livekitRoomSid: string;
    try {
      const room = await roomService.createRoom({ name: callDocId });
      if (!room.sid) throw new Error('LiveKit returned no room SID');
      livekitRoomSid = room.sid;
    } catch (err) {
      console.error('call/start room creation failed:', err);
      try {
        const current = await callRef.get();
        if (current.data()?.callState !== 'live') await roomService.deleteRoom(callDocId);
      } catch (cleanupError) {
        console.warn('call/start room-creation cleanup failed:', cleanupError);
      }
      return NextResponse.json({ error: 'Failed to start call' }, { status: 500 });
    }

    const cleanupCreatedRoom = async () => {
      const current = await callRef.get();
      const currentData = current.data();
      if (currentData?.callState === 'live') return;
      await roomService.deleteRoom(callDocId);
    };

    let decision:
      | { kind: 'created' }
      | { kind: 'existing' }
      | { kind: 'limited'; resetAtMs: number };
    try {
      decision = await db.runTransaction(async (txn) => {
        const snap = await txn.get(callRef);
        if (snap.exists) {
          const data = snap.data() as {
            callState?: string;
          };
          if (data.callState === 'live') {
            return { kind: 'existing' as const }; // a live call already exists → join it
          }
          // stale/dead call in the slot → fall through; set() below overwrites it wholesale
        }
        const trustedByUid = await getTrustedStatusMapInTransaction(txn, db, [uid]);
        const trustedForCall = trustedByUid.get(uid) === true;
        const usageStates = await getCallUsageStatesInTransaction(txn, db, [uid], nowMs);
        const usage = usageStates.get(uid);
        const remainingMinutes = trustedForCall
          ? CALL_TOTAL_MINUTES
          : usage
            ? reserveCallUsageInTransaction(txn, db, uid, callDocId, usage, nowMs)
            : null;
        if (!trustedForCall && remainingMinutes == null) {
          return { kind: 'limited' as const, resetAtMs: usage?.resetAtMs ?? nowMs };
        }
        txn.set(callRef, {
          type: 'call',
          userId: uid,
           name: 'Live call',
           creatorName: hostDisplayName,
            callHostUid: uid,
            callParticipantUids: [uid],
            callParticipantHistoryUids: [uid],
            callParticipantJoinedAt: { [uid]: Timestamp.fromMillis(nowMs) },
            callTrustedReliefUids: [],
            workspaceId,
           callState: 'live',
           callStartedAt: FieldValue.serverTimestamp(),
           createdAt: FieldValue.serverTimestamp(),
           expiresAt: null,
            expirationOption: 'forever',
            livekitRoomSid,
            trustedParticipantCount: trustedForCall ? 1 : 0,
            callLimitDeadlineAt: trustedForCall
              ? null
              : Timestamp.fromMillis(nowMs + (remainingMinutes as number) * 60_000),
          });
        return { kind: 'created' as const };
      });
    } catch (err) {
      console.error('call/start transaction failed:', err);
      try {
        await cleanupCreatedRoom();
      } catch (cleanupError) {
        console.warn('call/start failed-room cleanup failed:', cleanupError);
      }
      return NextResponse.json({ error: 'Failed to start call' }, { status: 500 });
    }

    if (decision.kind === 'limited') {
      try {
        await cleanupCreatedRoom();
      } catch (cleanupError) {
        console.warn('call/start limited-room cleanup failed:', cleanupError);
      }
      return NextResponse.json(
        { error: CALL_LIMIT_MESSAGE, resetAt: decision.resetAtMs },
        { status: 429 },
      );
    }

    if (decision.kind === 'existing') {
      // The deterministic LiveKit room is already owned by the existing call. The safety check in
      // cleanupCreatedRoom avoids deleting that room if LiveKit returned it for the duplicate start.
      await cleanupCreatedRoom().catch((cleanupError) => {
        console.warn('call/start existing-room cleanup skipped:', cleanupError);
      });
    }

    if (decision.kind === 'created') {
      // We (re)created the call. Cascade clears any subcollection leftovers from a replaced stale
      // call (the new call has none yet, so this is a no-op for a clean create). Best-effort.
      cascadeCallSubcollections(db, callDocId).catch(() => {});
    }

    const currentCall = await callRef.get();
    const currentData = currentCall.data();
    return NextResponse.json({
      callDropId: callDocId,
      created: decision.kind === 'created',
      callHostUid: typeof currentData?.callHostUid === 'string' ? currentData.callHostUid : uid,
      creatorName: typeof currentData?.creatorName === 'string' ? currentData.creatorName : hostDisplayName,
      callParticipantUids: Array.isArray(currentData?.callParticipantUids)
        ? currentData.callParticipantUids.filter((value): value is string => typeof value === 'string')
        : [uid],
    });
  } catch (error) {
    console.error('call/start error:', error);
    return NextResponse.json({ error: 'Failed to start call' }, { status: 500 });
  }
}
