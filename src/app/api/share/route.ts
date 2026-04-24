import { NextRequest, NextResponse } from 'next/server';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';

export const runtime = 'nodejs';
export const maxDuration = 30;
export const dynamic = 'force-dynamic';

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

async function deleteShareR2Image(shareData: Record<string, unknown>) {
  if (shareData.imageR2Key) {
    try {
      await r2.send(new DeleteObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME!,
        Key: shareData.imageR2Key as string,
      }));
    } catch (error) {
      console.error('Failed to delete share image from R2:', error);
    }
  }
}

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

    if (data.expiresAt) {
      const expiresAt = data.expiresAt.toDate();
      if (expiresAt <= new Date()) {
        await deleteShareR2Image(data);
        await adminDb.collection('shares').doc(snapshot.docs[0].id).delete();
        return NextResponse.json({ error: 'Share expired' }, { status: 410 });
      }
    }

    return NextResponse.json({
      type: data.type,
      name: data.name,
      content: data.content || null,
      mimeType: data.mimeType || null,
      fileSize: data.fileSize || null,
      imageUrl: data.imageUrl || null,
      youtubeVideoId: data.youtubeVideoId || null,
      expiresAt: data.expiresAt ? data.expiresAt.toDate().toISOString() : null,
    });
  } catch (error) {
    console.error('Share GET error:', error);
    return NextResponse.json({ error: 'Failed to fetch share' }, { status: 500 });
  }
}

// PUT /api/share — upload share image to R2 (auth required, receives base64)
export async function PUT(request: NextRequest) {
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

    const body = await request.text();
    const parsed = JSON.parse(body);
    const { imageData } = parsed;

    if (!imageData) {
      return NextResponse.json({ error: 'Missing image data' }, { status: 400 });
    }

    const matches = imageData.match(/^data:(image\/[\w+]+);base64,(.+)$/);
    const contentType = matches?.[1] || 'image/png';
    const base64Data = matches?.[2] || imageData;
    const buffer = Buffer.from(base64Data, 'base64');

    const key = `shares/${Date.now()}-${crypto.randomUUID()}`;
    const publicUrl = process.env.R2_PUBLIC_URL;
    const imageUrl = publicUrl
      ? `${publicUrl}/${key}`
      : `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${process.env.R2_BUCKET_NAME}/${key}`;

    await r2.send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME!,
      Key: key,
      Body: buffer,
      ContentType: contentType,
    }));

    return NextResponse.json({ imageUrl, imageR2Key: key });
  } catch (error) {
    console.error('Share image upload error:', error);
    return NextResponse.json({ error: 'Failed to upload image' }, { status: 500 });
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
    const { shareId, dropId, type, name, content, mimeType, fileSize, imageUrl, imageR2Key, youtubeVideoId, expiresAt } = body;

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
    if (imageUrl) docData.imageUrl = imageUrl;
    if (imageR2Key) docData.imageR2Key = imageR2Key;
    if (youtubeVideoId) docData.youtubeVideoId = youtubeVideoId;

    await adminDb.collection('shares').add(docData);

    return NextResponse.json({ success: true, shareId });
  } catch (error) {
    console.error('Share POST error:', error);
    return NextResponse.json({ error: 'Failed to create share' }, { status: 500 });
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
    const deletes = snapshot.docs.map(async (d) => {
      const data = d.data();
      await deleteShareR2Image(data);
      await adminDb.collection('shares').doc(d.id).delete();
    });
    await Promise.allSettled(deletes);

    return NextResponse.json({ success: true, deleted: snapshot.size });
  } catch (error) {
    console.error('Share DELETE error:', error);
    return NextResponse.json({ error: 'Failed to delete shares' }, { status: 500 });
  }
}
