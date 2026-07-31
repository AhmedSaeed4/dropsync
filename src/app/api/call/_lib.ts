// Shared helpers for the /api/call/* routes (NOT a route itself — Next.js only treats `route.ts`
// in an api segment as a handler). Keeps the auth preamble + the subcollection cascade out of the
// 4 route files.

import { NextRequest, NextResponse } from 'next/server';
import type { Firestore } from 'firebase-admin/firestore';
import { RoomServiceClient } from 'livekit-server-sdk';
import { getAdminAuth } from '@/lib/firebase-admin';

/**
 * Verify the Firebase Bearer token and return the caller's uid, OR a 401 NextResponse. Mirrors the
 * auth contract of /api/transcribe (the body uid is NEVER trusted — the verified token is the only
 * identity). Callers narrow with `typeof x !== 'string'`.
 */
export async function authUid(request: NextRequest): Promise<string | NextResponse> {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const idToken = authHeader.substring(7);
  try {
    const decoded = await getAdminAuth().verifyIdToken(idToken);
    return decoded.uid;
  } catch {
    return NextResponse.json({ error: 'Invalid token' }, { status: 401 });
  }
}

/**
 * Cascade-delete a call drop's callSignals + callPresence subcollections (Firestore does NOT
 * cascade deletes). ≤6 signal docs + ≤4 presence docs per call → one batched commit each. Best-
 * effort by contract — the caller swallows errors so a cleanup blip never fails the user action.
 */
export async function cascadeCallSubcollections(db: Firestore, callDropId: string): Promise<void> {
  const subs = ['callSignals', 'callPresence'] as const;
  await Promise.all(
    subs.map(async (sub) => {
      const snap = await db.collection('drops').doc(callDropId).collection(sub).get();
      if (snap.empty) return;
      const batch = db.batch();
      snap.docs.forEach((d) => batch.delete(d.ref));
      await batch.commit();
    }),
  );
}

// ---- LiveKit roster reconciliation ----------------------------------------------------------
//
// The Firestore roster (callParticipantUids) is now a CACHE of who's in a call, used only for the
// capacity-4 gate + the "N in call" badge — the call UI itself reads LiveKit's live participant set.
// The single source of truth for who is ACTUALLY connected is LiveKit. A roster uid that LiveKit says
// is NOT connected is a GHOST: a tab that was hard-killed (crash / force-close / laptop sleep / power
// loss) before its leave could fire, so its name stayed on the list and falsely occupies a seat. The
// join/start routes call this to drop ghosts before the capacity check. Fail-open by contract: ANY
// error or missing config returns null, and callers then keep the stale roster — a LiveKit hiccup
// NEVER blocks a legitimate join.

// RoomServiceClient speaks HTTP(S); LIVEKIT_URL is the wss:// connect URL the browser hands to
// room.connect. Normalize wss→https (ws→http) so the server SDK hits the right scheme.
function livekitApiHost(): string | null {
  const url = process.env.LIVEKIT_URL;
  if (!url) return null;
  if (url.startsWith('wss://')) return 'https://' + url.slice('wss://'.length);
  if (url.startsWith('ws://')) return 'http://' + url.slice('ws://'.length);
  return url; // already http(s) or a bare host
}

// Built per call (cheap — a stateless fetch-backed client) rather than module-cached, so a runtime
// LIVEKIT_* rotation is picked up without a process restart.
function getRoomService(): RoomServiceClient | null {
  const host = livekitApiHost();
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  if (!host || !apiKey || !apiSecret) return null; // LiveKit not configured → skip reconcile (no-op)
  return new RoomServiceClient(host, apiKey, apiSecret);
}

/**
 * The set of LiveKit identities CURRENTLY connected to a call's room, or null when the answer CANNOT
 * be treated as trustworthy ground truth (LiveKit unreachable/misconfigured, OR the room reports ZERO
 * connected participants). LiveKit identity = the Firebase uid (the token route sets identity = uid),
 * so these map 1:1 to roster entries. A network round-trip — call OUTSIDE a Firestore transaction.
 *
 * WHY empty ⇒ null (the load-bearing detail): listParticipants returns [] (NOT an error) for a room
 * that exists but has nobody connected yet — the NORMAL ~1-3s after a host clicks Start, before their
 * room.connect completes — and during a simultaneous reconnect. The roster can hold REAL participants
 * in that window, so treating [] as "everyone is a ghost" and pruning to it would evict the host the
 * instant a 2nd person joins a second later. A ghost can only be inferred SAFELY when ≥1 OTHER
 * participant IS connected (positive evidence the room is genuinely live) and a specific uid is not.
 * So empty/absent ⇒ null ⇒ callers fail-open (keep the roster verbatim). Pruning only ever happens on
 * a NON-EMPTY set, which is that positive evidence.
 */
export async function getLiveCallParticipantIds(roomName: string): Promise<Set<string> | null> {
  const svc = getRoomService();
  if (!svc) return null;
  try {
    const participants = await svc.listParticipants(roomName);
    if (participants.length === 0) return null; // see jsdoc: empty is fail-open, NOT "all ghosts"
    const ids = new Set<string>();
    for (const p of participants) if (p.identity) ids.add(p.identity);
    // Defence-in-depth mirroring the empty-list ⇒ null rule above: if every connected participant
    // somehow had a falsy identity (impossible under the token contract, which always sets identity=uid,
    // but guard anyway), we'd hand back a non-null EMPTY Set the join reconcile would treat as "all
    // ghosts" and prune the whole roster. Return null so callers fail-open.
    if (ids.size === 0) return null;
    return ids;
  } catch (e) {
    console.warn(
      `[call] LiveKit listParticipants failed for room ${roomName} — skipping roster reconcile`,
      e,
    );
    return null; // fail-open: caller keeps the stale roster
  }
}
