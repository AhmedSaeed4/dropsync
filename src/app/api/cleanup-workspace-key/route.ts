import { NextRequest, NextResponse } from 'next/server';
import { getAdminAuth, getAdminDb } from '@/lib/firebase-admin';

export const runtime = 'nodejs';
export const maxDuration = 30;
export const dynamic = 'force-dynamic';

// POST /api/cleanup-workspace-key — deletes ONE doc: workspaceKeys/{workspaceId}, the top-level
// collection holding a workspace's shared encryption key. When a workspace is destroyed everything
// else (drops, R2, shares, categories, the workspace doc) is removed but the key doc is NEVER
// deleted client-side — so it orphans forever. The client cannot delete it itself: firestore.rules
// has NO `allow delete` on workspaceKeys (read/create/update only), so a client deleteDoc is
// permission-denied — and once the workspace doc is gone the exists()-gated rules make the key
// unreachable to clients anyway. The Admin SDK bypasses firestore.rules, so this route can. Mirrors
// the already-shipped + already-audited /api/cleanup-fcm-tokens (PR #152).
//
// SECURITY (mirrors /api/cleanup-fcm-tokens + /api/notify-chat-message): the caller identity is
// derived ONLY from the verified ID token (decoded.uid) — NEVER from the request body. The body
// supplies workspaceId ONLY (the key doc is keyed by workspaceId, not uid). The route then
// RE-VERIFIES ownership server-side: it reads workspaces/{workspaceId}.ownerId and REFUSES unless
// it equals the verified caller. This owner re-verification is WHY the caller MUST invoke this
// route BEFORE deleting the workspace doc — once that doc is gone the route has no trust anchor and
// 404s (fail-safe) rather than deleting blindly.
//
// This is the first client-reachable workspaceKeys DELETION. An owner could intentionally soft-brick
// their own LIVE workspace by calling it — accepted because the owner already holds equivalent
// destructive authority (full workspace delete / kicks). DESTRUCTION-ONLY: never wire this route into
// any UI where the workspace SURVIVES (owner-transfer, non-owner leave, kicks).
//
// The response is { ok: true } ONLY — encryptedKey / iv / keySecret are NEVER read or echoed.
export async function POST(request: NextRequest) {
  try {
    // ---- AUTH: verify the Firebase ID token. The caller identity is the VERIFIED uid — nothing else. ----
    const authHeader = request.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const idToken = authHeader.substring(7);
    let uid: string;
    try {
      const decoded = await getAdminAuth().verifyIdToken(idToken);
      uid = decoded.uid;
    } catch {
      return NextResponse.json({ error: 'Invalid token' }, { status: 401 });
    }

    // ---- PARSE body: { workspaceId } ONLY. workspaceId comes from the body (the key doc is keyed by
    // workspaceId, not uid). ----
    const { workspaceId } = (await request.json()) as { workspaceId?: string };
    if (!workspaceId) {
      return NextResponse.json({ error: 'Missing workspaceId' }, { status: 400 });
    }

    // ---- OWNERSHIP (load-bearing): read the workspace doc and assert the verified caller is its
    // owner. If the workspace doc is already gone the route has no trust anchor → 404 (fail-safe: it
    // REFUSES rather than delete blindly). This is why the caller MUST call this BEFORE deleting the
    // workspace doc. ----
    const wsDoc = await getAdminDb().collection('workspaces').doc(workspaceId).get();
    if (!wsDoc.exists) {
      return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
    }
    const ownerId = wsDoc.get('ownerId');
    if (ownerId !== uid) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // ---- DELETE the single key doc. Admin SDK bypasses firestore.rules. Admin delete on an
    // already-missing doc is an idempotent no-op — safe to retry. Key fields are NEVER read. ----
    await getAdminDb().collection('workspaceKeys').doc(workspaceId).delete();

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('cleanup-workspace-key error:', error);
    return NextResponse.json({ error: 'Failed to clean workspace key' }, { status: 500 });
  }
}
