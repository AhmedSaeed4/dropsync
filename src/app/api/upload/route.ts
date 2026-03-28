import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { NextRequest, NextResponse } from 'next/server';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

// Increase max duration for large file uploads (5 minutes)
export const maxDuration = 300;

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

// Initialize R2 client
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
    // SECURITY CHECK 2: Enforce file size limit
    // =============================================
    const contentLength = request.headers.get('content-length');
    const MAX_SIZE = 500 * 1024 * 1024; // 500MB

    if (contentLength && parseInt(contentLength) > MAX_SIZE) {
      return NextResponse.json(
        { error: 'File too large. Maximum size is 500MB.' },
        { status: 413 }
      );
    }

    // =============================================
    // Get the encrypted file data from request body
    // =============================================
    const encryptedData = await request.text();

    if (!encryptedData) {
      return NextResponse.json(
        { error: 'No file data provided' },
        { status: 400 }
      );
    }

    // Double-check size (in case content-length was spoofed)
    if (encryptedData.length > MAX_SIZE) {
      return NextResponse.json(
        { error: 'File too large. Maximum size is 500MB.' },
        { status: 413 }
      );
    }

    // =============================================
    // Upload to R2
    // =============================================
    const timestamp = Date.now();
    const randomId = crypto.randomUUID();
    const key = `drops/${timestamp}-${randomId}.encrypted`;

    await r2.send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME!,
      Key: key,
      Body: encryptedData,
      ContentType: 'application/octet-stream',
    }));

    // Construct the public URL
    const publicUrl = process.env.R2_PUBLIC_URL;
    const fileUrl = publicUrl
      ? `${publicUrl}/${key}`
      : `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${process.env.R2_BUCKET_NAME}/${key}`;

    return NextResponse.json({ url: fileUrl, key, userId });
  } catch (error) {
    console.error('R2 upload error:', error);
    return NextResponse.json(
      { error: 'Failed to upload file' },
      { status: 500 }
    );
  }
}