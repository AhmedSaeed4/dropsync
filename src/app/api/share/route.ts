import { NextRequest, NextResponse } from 'next/server';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { isAllowedR2Url } from '@/lib/r2Url';

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

// Share-asset upload caps (mirrors /api/upload's 500MB). Real share payloads are far under this
// (encrypted files ≤ ~13MB, normal images < 100MB; ≥10MB binaries use the fileUrl bypass, not this PUT).
const MAX_RAW_BODY = 700 * 1024 * 1024;  // ~700MB raw base64 body
const MAX_DECODED = 500 * 1024 * 1024;   // 500MB decoded (matches /api/upload)

async function sourceStillImporting(dropData: Record<string, unknown>, uid: string, allowCancelledCleanup = false, deletingOwner = false): Promise<boolean> {
  const jobId = dropData.importJobId;
  const ownerId = dropData.userId;
  if (typeof jobId !== 'string') return false;
  if (typeof ownerId !== 'string') return true;
  const fence = await adminDb.collection('importFences').doc(ownerId + '_' + jobId).get();
  if (!fence.exists || fence.get('userId') !== ownerId || fence.get('jobId') !== jobId) return true;
  if (fence.get('state') === 'closed-success') return false;
  return !(allowCancelledCleanup && fence.get('state') === 'closed-cancelled' && (uid === ownerId || deletingOwner));
}

async function freshWorkspaceStillImporting(workspaceId: string | null): Promise<boolean> {
  if (!workspaceId) return false;
  const workspace = await adminDb.collection('workspaces').doc(workspaceId).get();
  if (!workspace.exists) return true;
  const jobId = workspace.get('importJobId');
  const ownerId = workspace.get('ownerId');
  if (typeof jobId !== 'string') return false;
  if (typeof ownerId !== 'string') return true;
  const fence = await adminDb.collection('importFences').doc(ownerId + '_' + jobId).get();
  return !fence.exists || fence.get('userId') !== ownerId || fence.get('jobId') !== jobId
    || fence.get('workspaceId') !== workspaceId || fence.get('mode') !== 'fresh'
    || fence.get('state') !== 'closed-success';
}

// ROUND 12: returns the keys that FAILED so callers can acknowledge per item — a cleanup
// obligation is never silently lost.
async function deleteShareR2Assets(shareData: Record<string, unknown>): Promise<string[]> {
  const keys = [shareData.imageR2Key, shareData.fileR2Key].filter(Boolean) as string[];
  const failed: string[] = [];
  for (const key of keys) {
    try {
      await r2.send(new DeleteObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME!,
        Key: key,
      }));
    } catch (error) {
      console.error('Failed to delete share asset from R2:', error);
      failed.push(key);
    }
  }
  return failed;
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

    // ROUND 12 serving gate (fail-closed): a share of a DELETING workspace stops serving. New
    // shares carry the server-derived sourceWorkspaceId; legacy shares fall back to the drop's
    // workspace, and a legacy zombie (no source AND the drop gone) stops serving too.
    const sourceWorkspaceId = typeof data.sourceWorkspaceId === 'string' ? data.sourceWorkspaceId : null;
    if (sourceWorkspaceId) {
      const wsDoc = await adminDb.collection('workspaces').doc(sourceWorkspaceId).get();
      if (!wsDoc.exists || wsDoc.get('deleting') === true) {
        return NextResponse.json({ error: 'Share expired' }, { status: 410 });
      }
    } else if (typeof data.dropId === 'string' && data.dropId) {
      const dropDoc = await adminDb.collection('drops').doc(data.dropId).get();
      if (dropDoc.exists) {
        const legacyWs = dropDoc.get('workspaceId');
        if (typeof legacyWs === 'string' && legacyWs) {
          const wsDoc = await adminDb.collection('workspaces').doc(legacyWs).get();
          if (!wsDoc.exists || wsDoc.get('deleting') === true) {
            return NextResponse.json({ error: 'Share expired' }, { status: 410 });
          }
        }
      } else {
        // Legacy zombie: the drop is gone and no source scope exists — fail closed.
        return NextResponse.json({ error: 'Share expired' }, { status: 410 });
      }
    }

    if (data.expiresAt) {
      const expiresAt = data.expiresAt.toDate();
      if (expiresAt <= new Date()) {
        const failedAssets = await deleteShareR2Assets(data);
        if (failedAssets.length > 0) {
          // Per-item acknowledgment: keep the record (evidence) and fail the request so the
          // next GET retries — never silently lose a cleanup obligation.
          return NextResponse.json({ error: 'Share expired' }, { status: 500 });
        }
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
      fileUrl: data.fileUrl || null,
      fileFormat: data.fileFormat || null,
      youtubeVideoId: data.youtubeVideoId || null,
      expiresAt: data.expiresAt ? data.expiresAt.toDate().toISOString() : null,
      // Exposed so the public share page can render an accurate expiry-ring fraction
      // (remaining / total). Total = expiresAt - createdAt. Additive field only — the
      // fetch mechanism, encryption, and expiry-cleanup logic are untouched.
      createdAt: data.createdAt ? data.createdAt.toDate().toISOString() : null,
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
    let uid: string;
    try {
      uid = (await getAuth().verifyIdToken(idToken)).uid;
    } catch {
      return NextResponse.json({ error: 'Invalid token' }, { status: 401 });
    }

    // Pre-read size guard: reject a body whose declared Content-Length already exceeds the cap,
    // before buffering it. Chunked requests (no Content-Length) fall through to the decoded guard.
    const contentLength = parseInt(request.headers.get('content-length') || '0', 10);
    if (contentLength && contentLength > MAX_RAW_BODY) {
      return NextResponse.json({ error: 'Payload too large' }, { status: 413 });
    }

    const body = await request.text();
    const parsed = JSON.parse(body);
    const { imageData, fileData, mimeType, dropId } = parsed;
    if (typeof dropId !== 'string' || !dropId) return NextResponse.json({ error: 'Missing drop ID' }, { status: 400 });
    const source = await adminDb.collection('drops').doc(dropId).get();
    if (!source.exists) return NextResponse.json({ error: 'Drop not found' }, { status: 404 });
    const sourceData = source.data()!;
    const sourceWorkspaceId = typeof sourceData.workspaceId === 'string' ? sourceData.workspaceId : null;
    if (sourceWorkspaceId) {
      const workspace = await adminDb.collection('workspaces').doc(sourceWorkspaceId).get();
      if (!workspace.exists || !Array.isArray(workspace.get('members')) || !workspace.get('members').includes(uid)) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }
    } else if (sourceData.userId !== uid) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    if (await sourceStillImporting(sourceData, uid) || await freshWorkspaceStillImporting(sourceWorkspaceId)) {
      return NextResponse.json({ error: 'This item is still importing.' }, { status: 409 });
    }

    // Handle file upload (video, PDF, etc.)
    if (fileData) {
      const matches = fileData.match(/^data:([^;]+);base64,(.+)$/);
      const contentType = matches?.[1] || mimeType || 'application/octet-stream';
      const base64Data = matches?.[2] || fileData;
      const buffer = Buffer.from(base64Data, 'base64');
      if (buffer.length > MAX_DECODED) {
        return NextResponse.json({ error: 'Payload too large' }, { status: 413 });
      }

      const key = `shares/${Date.now()}-${crypto.randomUUID()}`;
      const publicUrl = process.env.R2_PUBLIC_URL;
      const fileUrl = publicUrl
        ? `${publicUrl}/${key}`
        : `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${process.env.R2_BUCKET_NAME}/${key}`;

      await r2.send(new PutObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME!,
        Key: key,
        Body: buffer,
        ContentType: contentType,
      }));

      return NextResponse.json({ fileUrl, fileR2Key: key });
    }

    // Handle image upload
    if (!imageData) {
      return NextResponse.json({ error: 'Missing image or file data' }, { status: 400 });
    }

    const matches = imageData.match(/^data:(image\/[\w+]+);base64,(.+)$/);
    const contentType = matches?.[1] || 'image/png';
    const base64Data = matches?.[2] || imageData;
    const buffer = Buffer.from(base64Data, 'base64');
    if (buffer.length > MAX_DECODED) {
      return NextResponse.json({ error: 'Payload too large' }, { status: 413 });
    }

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
    const { shareId, dropId, type, name, content, mimeType, fileSize, imageUrl, imageR2Key, fileUrl, fileR2Key, fileFormat, youtubeVideoId, expiresAt } = body;

    if (!shareId || !dropId || !type || !name) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    // SSRF guard: imageUrl/fileUrl are stored verbatim from the body, so without this a caller could
    // store an internal/localhost/metadata URL and later have /api/share/download fetch it
    // server-side. Allow R2 storage URLs only (https + origin == R2_PUBLIC_URL origin). Fail-closed
    // when R2_PUBLIC_URL is unset. Legit shares/ and drops/ URLs both live under that origin, so real
    // shares (including binary shares pointing at a drop's R2 URL) are unaffected.
    if (imageUrl && !isAllowedR2Url(imageUrl)) {
      return NextResponse.json({ error: 'Invalid image URL' }, { status: 400 });
    }
    if (fileUrl && !isAllowedR2Url(fileUrl)) {
      return NextResponse.json({ error: 'Invalid file URL' }, { status: 400 });
    }

    // Ownership: caller must own this drop (personal) or be a member of its workspace.
    // Without this, any logged-in user who knows a dropId could create shares against it (and the
    // latest share is returned by /api/share/active → link-hijack). Mirrors the authorize block in
    // src/app/api/share/sync-expiry/route.ts + src/app/api/share/active/route.ts.
    const dropDoc = await adminDb.collection('drops').doc(dropId).get();
    if (!dropDoc.exists) {
      return NextResponse.json({ error: 'Drop not found' }, { status: 404 });
    }
    const dropData = dropDoc.data()!;
    const dropWorkspaceId = dropData.workspaceId || null;
    if (await sourceStillImporting(dropData, decodedToken.uid) || await freshWorkspaceStillImporting(dropWorkspaceId)) {
      return NextResponse.json({ error: 'This item is still importing.' }, { status: 409 });
    }
    if (dropWorkspaceId) {
      const workspaceDoc = await adminDb.collection('workspaces').doc(dropWorkspaceId).get();
      if (!workspaceDoc.exists) {
        return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
      }
      const members = workspaceDoc.data()?.members || [];
      if (!members.includes(decodedToken.uid)) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }
      // ROUND 12: no new public shares for a dying workspace.
      if (workspaceDoc.get('deleting') === true) {
        return NextResponse.json({ error: 'This workspace is being deleted' }, { status: 409 });
      }
    } else if (dropData.userId !== decodedToken.uid) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
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
    // ROUND 12: the server-derived, immutable source scope (never client-supplied) so the
    // serving gate above can fail closed when this workspace deletes.
    if (dropWorkspaceId) docData.sourceWorkspaceId = dropWorkspaceId;

    if (type === 'text' && content) docData.content = content;
    if (mimeType) docData.mimeType = mimeType;
    if (fileSize) docData.fileSize = fileSize;
    if (imageUrl) docData.imageUrl = imageUrl;
    if (imageR2Key) docData.imageR2Key = imageR2Key;
    if (fileUrl) docData.fileUrl = fileUrl;
    if (fileR2Key) docData.fileR2Key = fileR2Key;
    if (fileFormat) docData.fileFormat = fileFormat;
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
    let uid: string;
    try {
      const decoded = await getAuth().verifyIdToken(idToken);
      uid = decoded.uid;
    } catch {
      return NextResponse.json({ error: 'Invalid token' }, { status: 401 });
    }

    const dropId = request.nextUrl.searchParams.get('dropId');
    if (!dropId) {
      return NextResponse.json({ error: 'No drop ID provided' }, { status: 400 });
    }

    // AUTHORIZE: caller must own (personal) or be a member (workspace) of the DROP.
    // Mirrors /api/share/sync-expiry + /api/share/active exactly. The drop doc MUST still
    // exist here — the 4 client callers delete shares BEFORE the drop doc to make this resolve.
    const dropDoc = await adminDb.collection('drops').doc(dropId).get();
    if (!dropDoc.exists) {
      return NextResponse.json({ error: 'Drop not found' }, { status: 404 });
    }
    const dropData = dropDoc.data()!;
    const workspaceId = dropData.workspaceId || null;
    let deletingOwner = false;
    if (workspaceId) {
      const wsDoc = await adminDb.collection('workspaces').doc(workspaceId).get();
      if (!wsDoc.exists) {
        return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
      }
      const members = wsDoc.data()?.members || [];
      if (!members.includes(uid)) {
        // ROUND 12 (R4): the frozen DELETING owner keeps share-cleanup authority.
        const isDeletingOwner =
          wsDoc.get('deleting') === true && wsDoc.get('deletingOwner') === uid;
        deletingOwner = isDeletingOwner;
        if (!isDeletingOwner) {
          return NextResponse.json({ error: 'Not a workspace member' }, { status: 403 });
        }
      }
      deletingOwner = deletingOwner || (wsDoc.get('deleting') === true && wsDoc.get('deletingOwner') === uid);
    } else {
      if (dropData.userId !== uid) {
        return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
      }
    }

    if (await sourceStillImporting(dropData, uid, true, deletingOwner)
      || (await freshWorkspaceStillImporting(workspaceId) && !deletingOwner)) {
      return NextResponse.json({ error: 'This item is still importing.' }, { status: 409 });
    }

    const snapshot = await adminDb.collection('shares').where('dropId', '==', dropId).get();
    // ROUND 12: per-item acknowledgment — a record is deleted ONLY after its assets are
    // confirmed gone; any failure keeps that record and fails the request so the caller
    // (the deletion loop) retries idempotently.
    let deleted = 0;
    let failed = 0;
    for (const d of snapshot.docs) {
      const failedAssets = await deleteShareR2Assets(d.data());
      if (failedAssets.length > 0) {
        failed += 1;
        continue;
      }
      await adminDb.collection('shares').doc(d.id).delete();
      deleted += 1;
    }
    if (failed > 0) {
      return NextResponse.json(
        { error: 'Some shares failed to delete', deleted, failed },
        { status: 500 },
      );
    }

    return NextResponse.json({ success: true, deleted });
  } catch (error) {
    console.error('Share DELETE error:', error);
    return NextResponse.json({ error: 'Failed to delete shares' }, { status: 500 });
  }
}
