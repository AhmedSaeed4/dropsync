import { NextRequest, NextResponse } from 'next/server';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

export const runtime = 'nodejs';
export const maxDuration = 30;
export const dynamic = 'force-dynamic';

// Initialize Firebase Admin (only once). Safe to duplicate alongside the sibling share
// routes — getApps() guards double-init. This route writes ONLY expiresAt on share docs:
// share CONTENT is frozen at creation time and is never touched here.
if (!getApps().length) {
  initializeApp({
    credential: cert({
      projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    }),
  });
}

const adminDb = getFirestore();

// POST /api/share/sync-expiry — re-sync EVERY share link for a drop to the drop's latest
// expiry (shorter OR longer, including forever). This is "always match": an expiry edit on
// the drop propagates to all of that drop's share links so the public page never shows a
// stale expiry. Authenticated + authorized: only the drop's owner (personal drop) or a
// member of the drop's workspace may call it. Additive — the public GET, the create flow,
// encryption, and R2 are all untouched.
export async function POST(request: NextRequest) {
  try {
    // ---- AUTH: verify the Firebase ID token ----
    const authHeader = request.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const idToken = authHeader.substring(7);
    let uid: string;
    try {
      const decoded = await getAuth().verifyIdToken(idToken);
      uid = decoded.uid;
    } catch {
      return NextResponse.json({ error: 'Invalid token' }, { status: 401 });
    }

    // ---- PARSE body: { dropId, expiresAt } ----
    const body = await request.json();
    const { dropId, expiresAt } = body as { dropId?: string; expiresAt?: string | null };

    if (!dropId) {
      return NextResponse.json({ error: 'Missing dropId' }, { status: 400 });
    }

    // Resolve + validate the new expiry. Mirrors POST /api/share's storage shape exactly
    // (`expiresAt: expiresAt ? new Date(expiresAt) : null`): a Date for a timed drop, null
    // for "forever". `null`/`undefined` → null (forever). An unparseable date is rejected
    // (400) so we never write an Invalid Date (which the SDK would reject per-write, leaving
    // all shares un-synced while still reporting success).
    let resolvedExpiresAt: Date | null;
    if (expiresAt === null || expiresAt === undefined) {
      resolvedExpiresAt = null;
    } else {
      const d = new Date(expiresAt);
      if (isNaN(d.getTime())) {
        return NextResponse.json({ error: 'Invalid expiresAt' }, { status: 400 });
      }
      resolvedExpiresAt = d;
    }

    // ---- AUTHORIZE: caller must own (personal) or be a member (workspace) of the DROP ----
    const dropDoc = await adminDb.collection('drops').doc(dropId).get();
    if (!dropDoc.exists) {
      return NextResponse.json({ error: 'Drop not found' }, { status: 404 });
    }
    const dropData = dropDoc.data()!;
    const workspaceId = dropData.workspaceId || null;

    if (workspaceId) {
      // Workspace drop — verify membership. Mirrors /api/delete: read the workspace doc and
      // require the caller's uid in its `members` array. (Editor ≠ share's original owner is
      // fine and intended: any workspace member editing the drop syncs ALL of the drop's
      // shares — the drop's expiry changed, so every share must follow.)
      const wsDoc = await adminDb.collection('workspaces').doc(workspaceId).get();
      if (!wsDoc.exists) {
        return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
      }
      const members = wsDoc.data()?.members || [];
      if (!members.includes(uid)) {
        return NextResponse.json({ error: 'Not a workspace member' }, { status: 403 });
      }
    } else {
      // Personal drop — verify ownership.
      if (dropData.userId !== uid) {
        return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
      }
    }

    // ---- UPDATE every share for this drop (expiresAt ONLY) ----
    const snap = await adminDb.collection('shares').where('dropId', '==', dropId).get();
    const updates = snap.docs.map((d) =>
      adminDb.collection('shares').doc(d.id).update({ expiresAt: resolvedExpiresAt })
    );
    // allSettled so one failure can't abort the rest — mirrors DELETE /api/share.
    await Promise.allSettled(updates);

    return NextResponse.json({ success: true, updated: snap.size });
  } catch (error) {
    console.error('Share sync-expiry error:', error);
    return NextResponse.json({ error: 'Failed to sync share expiry' }, { status: 500 });
  }
}
