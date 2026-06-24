import { NextRequest, NextResponse } from 'next/server';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

export const runtime = 'nodejs';
export const maxDuration = 30;
export const dynamic = 'force-dynamic';

// Initialize Firebase Admin (only once). Safe to duplicate alongside the sibling share
// routes — getApps() guards double-init. This route is READ-ONLY: it returns share CONTENT,
// so it is authenticated + authorized exactly like /api/share/sync-expiry (caller must own
// the personal drop or be a member of the drop's workspace). It never writes, never touches
// R2, never mutates a share doc.
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

// Minimal shape of a stored share doc — the fields createShare() reads back to decide reuse.
// createdAt / expiresAt are Firestore Timestamps (have a toDate()).
interface StoredShare {
  id: string;
  name?: string;
  content?: string;
  type: string;
  mimeType?: string;
  fileSize?: number;
  youtubeVideoId?: string;
  imageUrl?: string;
  fileUrl?: string;
  createdAt?: { toDate: () => Date };
  expiresAt?: { toDate: () => Date } | null;
}

// GET /api/share/active?dropId=<id> — return the latest NON-EXPIRED share for a drop, or null.
// Used by createShare() to REUSE an existing active link when the drop's content is unchanged,
// skipping a redundant R2 upload + Firestore write. Authenticated + authorized against the DROP
// (not the share): only the drop's owner (personal drop) or a member of the drop's workspace may
// read it. Returns share content, hence the auth requirement.
export async function GET(request: NextRequest) {
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

    // ---- PARSE dropId ----
    const dropId = request.nextUrl.searchParams.get('dropId');
    if (!dropId) {
      return NextResponse.json({ error: 'Missing dropId' }, { status: 400 });
    }

    // ---- AUTHORIZE: caller must own (personal) or be a member (workspace) of the DROP ----
    // Mirrors /api/share/sync-expiry exactly.
    const dropDoc = await adminDb.collection('drops').doc(dropId).get();
    if (!dropDoc.exists) {
      return NextResponse.json({ error: 'Drop not found' }, { status: 404 });
    }
    const dropData = dropDoc.data()!;
    const workspaceId = dropData.workspaceId || null;

    if (workspaceId) {
      const wsDoc = await adminDb.collection('workspaces').doc(workspaceId).get();
      if (!wsDoc.exists) {
        return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
      }
      const members = wsDoc.data()?.members || [];
      if (!members.includes(uid)) {
        return NextResponse.json({ error: 'Not a workspace member' }, { status: 403 });
      }
    } else {
      if (dropData.userId !== uid) {
        return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
      }
    }

    // ---- Find the latest NON-EXPIRED share for this drop ----
    // Fetch all shares for the drop (matches DELETE / sync-expiry), then filter in JS: a share
    // is active when expiresAt is null (forever) OR in the future. Expired shares are skipped —
    // treated as "no active share" so the caller creates a fresh link. Expired shares are NOT
    // touched here (they stay frozen for their recipients; lazy-delete happens in GET /api/share).
    // Picking the latest by createdAt handles the "multiple active shares" case.
    const snap = await adminDb.collection('shares').where('dropId', '==', dropId).get();
    const now = new Date();
    let latest: StoredShare | null = null;
    let latestAt = new Date(0);
    for (const doc of snap.docs) {
      const data = doc.data() as StoredShare;
      const exp = data.expiresAt;
      if (exp && typeof exp.toDate === 'function' && exp.toDate() <= now) continue; // expired
      const at =
        data.createdAt && typeof data.createdAt.toDate === 'function'
          ? data.createdAt.toDate()
          : new Date(0);
      if (!latest || at > latestAt) {
        latest = data;
        latestAt = at;
      }
    }

    if (!latest) {
      return NextResponse.json(null);
    }

    // Return the fields createShare() compares identity against. shareId = the doc's stored `id`.
    return NextResponse.json({
      shareId: latest.id,
      name: latest.name ?? '',
      content: latest.content ?? '',
      type: latest.type,
      mimeType: latest.mimeType ?? '',
      fileSize: latest.fileSize ?? 0,
      youtubeVideoId: latest.youtubeVideoId ?? '',
      hasImage: !!latest.imageUrl,
      hasFile: !!latest.fileUrl,
    });
  } catch (error) {
    console.error('Share active GET error:', error);
    return NextResponse.json({ error: 'Failed to fetch active share' }, { status: 500 });
  }
}
