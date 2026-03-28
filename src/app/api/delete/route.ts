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
    const { key, workspaceId } = await request.json();

    if (!key) {
      return NextResponse.json({ error: 'No key provided' }, { status: 400 });
    }

    // =============================================
    // SECURITY CHECK 2: Verify ownership
    // Query Firestore to ensure user owns a drop with this r2Key
    // =============================================
    const dropsRef = adminDb.collection('drops');
    const snapshot = await dropsRef.where('r2Key', '==', key).limit(1).get();

    if (snapshot.empty) {
      // No matching drop found
      return NextResponse.json({ error: 'Drop not found' }, { status: 404 });
    }

    const dropData = snapshot.docs[0].data();
    const dropWorkspaceId = dropData.workspaceId || null;
    const dropUserId = dropData.userId;

    if (workspaceId || dropWorkspaceId) {
      // Workspace drop - verify user is a member
      const wsId = workspaceId || dropWorkspaceId;
      const workspaceDoc = await adminDb.collection('workspaces').doc(wsId).get();
      if (!workspaceDoc.exists) {
        return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
      }
      const members = workspaceDoc.data()?.members || [];
      if (!members.includes(userId)) {
        return NextResponse.json({ error: 'Not a workspace member' }, { status: 403 });
      }
    } else {
      // Personal drop - verify ownership
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