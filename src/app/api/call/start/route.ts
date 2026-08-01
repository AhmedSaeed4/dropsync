import { NextRequest, NextResponse } from 'next/server';
import { getAdminDb } from '@/lib/firebase-admin';
import { Timestamp, FieldValue } from 'firebase-admin/firestore';
import { authUid, cascadeCallSubcollections, getLiveKitRoomService } from '../_lib';

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
    const expiresAt = Timestamp.fromDate(new Date(Date.now() + 4 * 60 * 60 * 1000)); // STATIC 4h backstop — NEVER refreshed

    // Avoid creating a second LiveKit room when this request is simply joining an already-live call.
    // New calls explicitly create the room here so its server-issued SID can be bound to the call doc;
    // the webhook uses that binding to reject delayed events from an older call in this reused slot.
    const currentSnap = await callRef.get();
    if (currentSnap.exists) {
      const currentData = currentSnap.data() as {
        callState?: string;
        expiresAt?: { toMillis?: () => number } | null;
      };
      const currentExpired =
        currentData.expiresAt != null &&
        typeof currentData.expiresAt.toMillis === 'function' &&
        currentData.expiresAt.toMillis() <= Date.now();
      if (currentData.callState === 'live' && !currentExpired) {
        return NextResponse.json({ callDropId: callDocId });
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
      return NextResponse.json({ error: 'Failed to start call' }, { status: 500 });
    }

    let joinedExisting = false;
    try {
      joinedExisting = await db.runTransaction(async (txn) => {
        const snap = await txn.get(callRef);
        if (snap.exists) {
          const data = snap.data() as {
            callState?: string;
            expiresAt?: { toMillis?: () => number } | null;
          };
          const expired =
            data.expiresAt != null &&
            typeof data.expiresAt.toMillis === 'function' &&
            data.expiresAt.toMillis() <= Date.now();
          if (data.callState === 'live' && !expired) {
            return true; // a live call already exists → starting another just joins it
          }
          // stale/dead call in the slot → fall through; set() below overwrites it wholesale
        }
        txn.set(callRef, {
          type: 'call',
          userId: uid,
          name: 'Live call',
          creatorName: hostDisplayName,
          callHostUid: uid,
          callParticipantUids: [uid],
          workspaceId,
          callState: 'live',
          callStartedAt: FieldValue.serverTimestamp(),
          createdAt: FieldValue.serverTimestamp(),
          expiresAt, // STATIC — heartbeats NEVER refresh this (§5)
          expirationOption: '4h', // not 'forever' → avoids isForeverWrite() → no trusted-tier gate
          livekitRoomSid,
          });
        return false;
      });
    } catch (err) {
      console.error('call/start transaction failed:', err);
      return NextResponse.json({ error: 'Failed to start call' }, { status: 500 });
    }

    if (!joinedExisting) {
      // We (re)created the call. Cascade clears any subcollection leftovers from a replaced stale
      // call (the new call has none yet, so this is a no-op for a clean create). Best-effort.
      cascadeCallSubcollections(db, callDocId).catch(() => {});
    }

    return NextResponse.json({ callDropId: callDocId });
  } catch (error) {
    console.error('call/start error:', error);
    return NextResponse.json({ error: 'Failed to start call' }, { status: 500 });
  }
}
