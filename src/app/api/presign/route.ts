import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { NextRequest, NextResponse } from 'next/server';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

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
    // Verify Firebase ID token
    const authHeader = request.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return NextResponse.json({ error: 'Unauthorized - no token' }, { status: 401 });
    }

    const idToken = authHeader.substring(7);

    try {
      await getAuth().verifyIdToken(idToken);
    } catch {
      return NextResponse.json({ error: 'Unauthorized - invalid token' }, { status: 401 });
    }

    // Generate unique R2 key
    const timestamp = Date.now();
    const randomId = crypto.randomUUID();
    const key = `drops/${timestamp}-${randomId}`;

    // Create presigned PUT URL (expires in 5 minutes)
    const command = new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME!,
      Key: key,
      ContentType: 'application/octet-stream',
    });

    const presignedUrl = await getSignedUrl(r2, command, { expiresIn: 300 });

    // Construct public URL
    const publicUrl = process.env.R2_PUBLIC_URL;
    const fileUrl = publicUrl
      ? `${publicUrl}/${key}`
      : `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${process.env.R2_BUCKET_NAME}/${key}`;

    return NextResponse.json({
      presignedUrl,
      key,
      fileUrl,
    });
  } catch (error) {
    console.error('Presign error:', error);
    return NextResponse.json(
      { error: 'Failed to generate upload URL' },
      { status: 500 }
    );
  }
}
