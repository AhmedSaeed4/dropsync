import { S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { NextRequest, NextResponse } from 'next/server';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

// Initialize Firebase Admin (only once)
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

const r2 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID!,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
  },
});

export async function POST(request: NextRequest) {
  try {
    // =============================================
    // SECURITY CHECK 1: Verify Firebase ID token
    // =============================================
    const authHeader = request.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return NextResponse.json({ error: 'Unauthorized - no token' }, { status: 401 });
    }

    const idToken = authHeader.substring(7);
    let decodedToken;

    try {
      decodedToken = await getAuth().verifyIdToken(idToken);
    } catch {
      return NextResponse.json({ error: 'Unauthorized - invalid token' }, { status: 401 });
    }

    const userId = decodedToken.uid;

    // =============================================
    // Get request body
    // =============================================
    // Body shape is { key, workspaceId } (deleteFromR2 still sends workspaceId), but workspaceId is
    // intentionally NOT read here — authorization is derived solely from the drop's own record
    // below. (Hole A: a client-supplied workspaceId could otherwise override the drop's real
    // workspace and bypass the personal-drop ownership branch.)
    const { key } = await request.json();

    if (!key) {
      return NextResponse.json({ error: 'No key provided' }, { status: 400 });
    }

    // =============================================
    // SECURITY CHECK 2: Verify ownership
    // Query Firestore to ensure user owns a drop with this r2Key or imageR2Key
    // =============================================
    const dropsRef = adminDb.collection('drops');

    // Check both r2Key (main file) and imageR2Key (attached image)
    const [mainSnapshot, imageSnapshot] = await Promise.all([
      dropsRef.where('r2Key', '==', key).limit(1).get(),
      dropsRef.where('imageR2Key', '==', key).limit(1).get(),
    ]);

    const snapshot = mainSnapshot.empty ? imageSnapshot : mainSnapshot;

    if (snapshot.empty) {
      // Hole B (IDOR): when no drop matches the key, allow orphan cleanup ONLY of a superseded/old
      // DROP asset. Edit/move/rollback flows delete an old `drops/` key after the doc no longer
      // references it (the doc exists at normal delete time, but these cleanup paths run AFTER the
      // key was already replaced on the doc). REFUSE everything else — notably `shares/` keys
      // (public-share assets), which are derivable from the unauthenticated share URL and must NEVER
      // be deletable here (that was the unauthorized-asset-deletion hole). request.json() can return
      // non-strings, so type-check first. All legitimate drop keys are `drops/` (presign/route.ts:63);
      // share keys are `shares/` (share/route.ts:121,147); no other prefixes exist.
      if (typeof key !== 'string' || !key.startsWith('drops/')) {
        return NextResponse.json({ error: 'Not found' }, { status: 404 });
      }
      try {
        await r2.send(new DeleteObjectCommand({
          Bucket: process.env.R2_BUCKET_NAME!,
          Key: key,
        }));
        return NextResponse.json({ success: true, orphaned: true });
      } catch {
        return NextResponse.json({ error: 'Drop not found' }, { status: 404 });
      }
    }

    const dropData = snapshot.docs[0].data();
    const dropWorkspaceId = dropData.workspaceId || null;
    const dropUserId = dropData.userId;

    // Authorize purely from the DROP's own record (Hole A). The body workspaceId is no longer
    // consulted (see the destructure note above): previously `workspaceId || dropWorkspaceId` let a
    // client-supplied workspaceId override the drop's real workspace, running the membership check
    // against a workspace the caller IS in (not the file's), and any non-null body workspaceId
    // skipped the personal-drop ownership branch entirely.
    if (dropWorkspaceId) {
      // Workspace drop — caller must be a member of THAT workspace.
      const workspaceDoc = await adminDb.collection('workspaces').doc(dropWorkspaceId).get();
      if (!workspaceDoc.exists) {
        return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
      }
      const members = workspaceDoc.data()?.members || [];
      if (!members.includes(userId)) {
        return NextResponse.json({ error: 'Not a workspace member' }, { status: 403 });
      }
    } else {
      // Personal drop — caller must own it.
      if (dropUserId !== userId) {
        return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
      }
    }

    // =============================================
    // Delete from R2
    // =============================================
    await r2.send(new DeleteObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME!,
      Key: key,
    }));

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('R2 delete error:', error);
    return NextResponse.json({ error: 'Failed to delete file' }, { status: 500 });
  }
}