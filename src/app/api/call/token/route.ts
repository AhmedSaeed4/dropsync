// /api/call/token — mints a short-lived LiveKit access token so the caller can join a call's room.
//
// LiveKit's SFU authorizes a participant by a JWT the client presents on room.connect(url, token).
// The token is minted SERVER-SIDE because it is signed with the project's API SECRET — if that
// secret reached the browser, anyone could forge tokens granting arbitrary publish/subscribe/admin
// rights to any room. So the client never sees the secret; it only ever receives a short-lived token
// minted for ITS verified identity + THIS specific call.
//
// Auth + authorization mirror the other /api/call/* routes exactly (authUid from _lib.ts → verified
// uid; the body is never trusted). ADDITIONALLY this route re-verifies the caller is a CURRENT
// participant of the live call drop before minting: the only way into callParticipantUids is the
// transactional /api/call/join route (which already checked workspace membership + capacity-4), so
// checking the roster here transitively enforces "you may only join a call you were admitted to" — a
// raw authenticated user cannot mint a token for a room they were never let into.
//
// The room name = the call doc's livekitRoomName (generation-unique since the pending-lifecycle
// change; legacy calls fall back to the deterministic doc id). Both ends of a call get the same
// room name from this route. identity = the verified Firebase uid, so LiveKit's participant identity
// mirrors your Firestore identity (the client resolves display names the same way it does today —
// from workspaceMembers by uid, unchanged).

import { NextRequest, NextResponse } from 'next/server';
import { AccessToken } from 'livekit-server-sdk';
import {
  CALL_LIMIT_MESSAGE,
  authUid,
  enforceExpiredCall,
  isPendingCallStale,
  refreshCallLimitState,
} from '../_lib';
import { getAdminDb } from '@/lib/firebase-admin';

export const runtime = 'nodejs'; // livekit-server-sdk uses Node crypto (never edge)

export async function POST(request: NextRequest) {
  // 1. Verify identity (Bearer → verifyIdToken → uid). 401 if missing/invalid.
  const uidOrResp = await authUid(request);
  if (typeof uidOrResp !== 'string') return uidOrResp;
  const uid = uidOrResp;

  // 2. Parse + validate the requested call drop id.
  const body = (await request.json().catch(() => ({}))) as { callDropId?: unknown };
  const callDropId = typeof body.callDropId === 'string' ? body.callDropId : '';
  if (!callDropId) {
    return NextResponse.json({ error: 'Missing callDropId' }, { status: 400 });
  }

  // 3. Re-verify the caller may connect to THIS call's room (defense-in-depth on top of
  //    /api/call/join). A token is minted ONLY for a call the verified uid is actually in:
  //    - live call → the caller must be in the roster (join route enforces membership + capacity);
  //    - pending call → ONLY the host (the pending roster holds just the host); no other member can
  //      connect before confirmation, which is what keeps a pending call invisible + private.
  const db = getAdminDb();
  const dropSnap = await db.collection('drops').doc(callDropId).get();
  if (!dropSnap.exists) {
    return NextResponse.json({ error: 'Call not found' }, { status: 404 });
  }
  const drop = dropSnap.data() as {
    type?: string;
    callState?: string;
    callHostUid?: unknown;
    callParticipantUids?: unknown;
    workspaceId?: unknown;
    livekitRoomName?: unknown;
    callPendingAt?: unknown;
    callPendingExpiresAt?: unknown;
    createdAt?: unknown;
  };
  if (drop.type !== 'call') {
    return NextResponse.json({ error: 'Call not found' }, { status: 404 });
  }
  const pendingHost = drop.callState === 'pending';
  if (pendingHost) {
    if (drop.callHostUid !== uid) {
      return NextResponse.json({ error: 'Call is not ready yet' }, { status: 403 });
    }
    // A pending call past its grace is an abandoned start (swept daily) — never mint a token that
    // could revive it or connect to its soon-deleted room.
    if (isPendingCallStale(drop, Date.now())) {
      return NextResponse.json(
        { error: 'This call start has expired. Please try starting again.' },
        { status: 410 },
      );
    }
  } else if (drop.callState !== 'live') {
    return NextResponse.json({ error: 'Call is not live' }, { status: 404 });
  } else if (
    !Array.isArray(drop.callParticipantUids) ||
    !(drop.callParticipantUids as string[]).includes(uid)
  ) {
    return NextResponse.json({ error: 'Not a participant of this call' }, { status: 403 });
  }
  if (typeof drop.workspaceId !== 'string' || !drop.workspaceId) {
    return NextResponse.json({ error: 'Call is not attached to a workspace' }, { status: 403 });
  }
  const workspaceSnap = await db.collection('workspaces').doc(drop.workspaceId).get();
  const workspaceMembers = workspaceSnap.data()?.members;
  if (!workspaceSnap.exists || !Array.isArray(workspaceMembers) || !workspaceMembers.includes(uid)) {
    return NextResponse.json({ error: 'Not a member of this workspace' }, { status: 403 });
  }

  // The room name is the generation-unique livekitRoomName when present (new calls); legacy calls
  // fall back to the deterministic doc id. Either way, the token's room grant matches the room the
  // start route created and the client connects to.
  const roomName =
    typeof drop.livekitRoomName === 'string' && drop.livekitRoomName
      ? drop.livekitRoomName
      : callDropId;

  if (!pendingHost) {
    const limitState = await refreshCallLimitState(db, callDropId);
    if (limitState.expired) {
      await enforceExpiredCall(db, callDropId);
      return NextResponse.json({ error: CALL_LIMIT_MESSAGE }, { status: 410 });
    }
  }

  // 4. Server-only LiveKit config (all three must be set; the SECRET must NEVER be NEXT_PUBLIC_).
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  const url = process.env.LIVEKIT_URL;
  if (!apiKey || !apiSecret || !url) {
    // Misconfiguration, not a user error — log server-side, return a generic 500.
    console.error('[call/token] LiveKit env not configured (LIVEKIT_URL/API_KEY/API_SECRET)');
    return NextResponse.json({ error: 'LiveKit is not configured' }, { status: 500 });
  }

  // 5. Mint a short-lived token: identity = verified uid, room = the call's LiveKit room name
  //    (generation-unique for new calls, deterministic doc id for legacy calls). Grants allow the
  //    participant to publish camera/mic/screen, subscribe to everyone else, and send data-channel
  //    messages (for future in-call signaling/controls). TTL is bounded so a leaked token is short-
  //    lived; a rejoin mints a fresh one.
  //
  //    SAME-UID / TWO-DEVICE BEHAVIOR (owner-approved: allow, with this documented caveat): LiveKit
  //    identities are unique per room, so a SECOND connection with the same uid REPLACES the first —
  //    LiveKit disconnects the older connection. Firestore admission stays idempotent (the roster is
  //    a uid set), so the second device can join and operate. Known limitation (pre-existing, out of
  //    scope for the pending-lifecycle fix): webhook/leave cleanup keys on the uid, not the session,
  //    so an exit event for the replaced first connection may remove the uid from the roster while
  //    the second device is still connected. The second device continues until IT leaves, and any
  //    reconnect mints a fresh token. Fully session-aware identities would be a follow-up change.
  const at = new AccessToken(apiKey, apiSecret, {
    identity: uid,
    // 2h TTL — longer than any test call, short enough to limit blast radius. The client mints a
    // fresh token on every join/rejoin, so this is an upper bound, not the session length.
    ttl: 60 * 60 * 2,
  });
  at.addGrant({
    room: roomName,
    roomJoin: true,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
    canUpdateOwnMetadata: true,
  });
  const token = await at.toJwt();

  // Return the token + the server URL + room name so the client can room.connect(url, token) without
  // needing the URL as a NEXT_PUBLIC_ env var (keeps ALL LiveKit config server-side).
  return NextResponse.json({ token, url, roomName });
}
