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

// GET /api/share?id=abc123 — fetch share data (no auth required)
export async function GET(request: NextRequest) {
  try {
    const shareId = request.nextUrl.searchParams.get('id');
    if (!shareId) {
      return NextResponse.json({ error: 'No share ID provided' }, { status: 400 });
    }

    const snapshot = await adminDb.collection('shares').where('id', '==', shareId).limit(1).get();

    if (snapshot.empty) {
      return NextResponse.json({ error: 'Share not found' }, { status: 404 });
    }

    const data = snapshot.docs[0].data();

    // Check if expired
    if (data.expiresAt) {
      const expiresAt = data.expiresAt.toDate();
      if (expiresAt <= new Date()) {
        // Clean up expired share
        await adminDb.collection('shares').doc(snapshot.docs[0].id).delete();
        return NextResponse.json({ error: 'Share expired' }, { status: 410 });
      }
    }

    // Return share data (exclude internal fields)
    return NextResponse.json({
      type: data.type,
      name: data.name,
      content: data.content || null,
      mimeType: data.mimeType || null,
      fileSize: data.fileSize || null,
      imageData: data.imageData || null,
      youtubeVideoId: data.youtubeVideoId || null,
      expiresAt: data.expiresAt ? data.expiresAt.toDate().toISOString() : null,
    });
  } catch (error) {
    console.error('Share GET error:', error);
    return NextResponse.json({ error: 'Failed to fetch share' }, { status: 500 });
  }
}

// DELETE /api/share?dropId=xyz — delete all shares for a drop (auth required)
export async function DELETE(request: NextRequest) {
  try {
    const authHeader = request.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const idToken = authHeader.substring(7);
    try {
      await getAuth().verifyIdToken(idToken);
    } catch {
      return NextResponse.json({ error: 'Invalid token' }, { status: 401 });
    }

    const dropId = request.nextUrl.searchParams.get('dropId');
    if (!dropId) {
      return NextResponse.json({ error: 'No drop ID provided' }, { status: 400 });
    }

    const snapshot = await adminDb.collection('shares').where('dropId', '==', dropId).get();
    const deletes = snapshot.docs.map(d => adminDb.collection('shares').doc(d.id).delete());
    await Promise.allSettled(deletes);

    return NextResponse.json({ success: true, deleted: snapshot.size });
  } catch (error) {
    console.error('Share DELETE error:', error);
    return NextResponse.json({ error: 'Failed to delete shares' }, { status: 500 });
  }
}

// POST /api/share — create a new share (auth required)
export async function POST(request: NextRequest) {
  try {
    const authHeader = request.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const idToken = authHeader.substring(7);
    let decodedToken;
    try {
      decodedToken = await getAuth().verifyIdToken(idToken);
    } catch {
      return NextResponse.json({ error: 'Invalid token' }, { status: 401 });
    }

    const body = await request.json();
    const { shareId, dropId, type, name, content, mimeType, fileSize, imageData, youtubeVideoId, expiresAt } = body;

    if (!shareId || !dropId || !type || !name) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    const docData: Record<string, unknown> = {
      id: shareId,
      dropId,
      ownerId: decodedToken.uid,
      type,
      name,
      createdAt: new Date(),
      expiresAt: expiresAt ? new Date(expiresAt) : null,
    };

    if (type === 'text' && content) docData.content = content;
    if (mimeType) docData.mimeType = mimeType;
    if (fileSize) docData.fileSize = fileSize;
    if (imageData) docData.imageData = imageData;
    if (youtubeVideoId) docData.youtubeVideoId = youtubeVideoId;

    await adminDb.collection('shares').add(docData);

    return NextResponse.json({ success: true, shareId });
  } catch (error) {
    console.error('Share POST error:', error);
    return NextResponse.json({ error: 'Failed to create share' }, { status: 500 });
  }
}
