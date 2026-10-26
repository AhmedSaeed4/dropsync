import { randomUUID } from 'node:crypto';
import { S3Client, PutObjectCommand, HeadObjectCommand, GetObjectCommand, DeleteObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Timestamp, type DocumentData, type Firestore, type Transaction } from 'firebase-admin/firestore';
import { getAdminDb } from './firebase-admin';
import {
  MAX_STICKER_BYTES, MAX_STICKER_CIPHERTEXT_BYTES, STICKER_MIME_TYPES,
  STICKER_UPLOAD_SECONDS, STICKER_RETIRE_MARGIN_MS, type StickerOperationResult,
} from '@/types/stickers';

type Operation = 'prepare' | 'complete' | 'read' | 'delete' | 'cleanupWorkspace';
export interface StickerRequest { op: Operation; workspaceId: string; stickerId?: string; cursor?: string }
export class StickerRequestError extends Error {
  constructor(public readonly statusCode: number, message: string) { super(message); }
}
type Result = { statusCode: number; body: StickerOperationResult };
const pending = (retryAfterMs = 30_000): Result => ({
  statusCode: 202, body: { ok: false, status: 'pending', retryAfterMs: Math.max(1000, retryAfterMs) },
});
const success = (status = 'complete'): Result => ({ statusCode: 200, body: { ok: true, status } });
const idPattern = /^[A-Za-z0-9_-]{1,128}$/;
let storage: S3Client | undefined;
function r2(): S3Client {
  // One marker attempt only: a lost outcome must be reconciled, NEVER re-seeded.
  storage ??= new S3Client({
    region: 'auto', endpoint: 'https://' + process.env.R2_ACCOUNT_ID + '.r2.cloudflarestorage.com',
    credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID!, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY! },
    maxAttempts: 1, requestChecksumCalculation: 'WHEN_REQUIRED',
  });
  return storage;
}
const bucket = () => process.env.R2_BUCKET_NAME!;
const objectKey = (workspaceId: string, stickerId: string) => 'stickers/' + workspaceId + '/' + stickerId;
const timestampMs = (value: unknown): number | null => value instanceof Timestamp ? value.toMillis() : null;
const blocked = (data?: DocumentData) => !!data && ['active', 'completing', 'finalizing'].includes(data.state);
const denied = (message = 'You no longer have access to these stickers.'): never => { throw new StickerRequestError(403, message); };

export function parseStickerRequest(body: unknown): StickerRequest {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new StickerRequestError(400, 'Invalid sticker request.');
  const data = body as Record<string, unknown>;
  if (!['prepare', 'complete', 'read', 'delete', 'cleanupWorkspace'].includes(String(data.op))
    || typeof data.workspaceId !== 'string' || !idPattern.test(data.workspaceId)
    || Object.keys(data).some(key => !['op', 'workspaceId', 'stickerId', 'cursor'].includes(key))) {
    throw new StickerRequestError(400, 'Invalid sticker request.');
  }
  if ((data.op === 'cleanupWorkspace' && data.stickerId !== undefined)
    || (data.op !== 'cleanupWorkspace' && (typeof data.stickerId !== 'string' || !idPattern.test(data.stickerId)))) {
    throw new StickerRequestError(400, 'Invalid sticker id.');
  }
  if (data.cursor !== undefined && (typeof data.cursor !== 'string' || data.cursor.length > 4096)) {
    throw new StickerRequestError(400, 'Invalid cleanup cursor.');
  }
  return data as unknown as StickerRequest;
}

interface Access {
  parent: DocumentData;
  record?: DocumentData;
  deletingOwner: boolean;
  soloAccountOwner: boolean;
}
async function access(db: Firestore, tx: Transaction, uid: string, request: StickerRequest): Promise<Access> {
  const parentRef = db.collection('workspaces').doc(request.workspaceId);
  const refs = [parentRef, db.collection('accountBarriers').doc(uid)];
  if (request.stickerId) refs.push(parentRef.collection('stickers').doc(request.stickerId));
  const [parentSnap, callerBarrier, recordSnap] = await tx.getAll(...refs);
  if (!parentSnap.exists) throw new StickerRequestError(404, 'The workspace is no longer available.');
  const parent = parentSnap.data()!;
  if (typeof parent.ownerId !== 'string' || !Array.isArray(parent.members)) denied();
  const ownerBarrier = parent.ownerId === uid
    ? callerBarrier : await tx.get(db.collection('accountBarriers').doc(parent.ownerId));
  let freshLocked = false, freshCancelled = false;
  if ('importJobId' in parent) {
    freshLocked = true;
    if (typeof parent.importJobId === 'string') {
      const fence = await tx.get(db.collection('importFences').doc(parent.ownerId + '_' + parent.importJobId));
      const valid = fence.exists && fence.get('userId') === parent.ownerId && fence.get('jobId') === parent.importJobId;
      freshLocked = !(valid && fence.get('state') === 'closed-success');
      freshCancelled = valid && fence.get('state') === 'closed-cancelled';
    }
  }
  const member = parent.members.includes(uid);
  const deletingOwner = parent.deleting === true && parent.deletingOwner === uid;
  const soloAccountOwner = parent.ownerId === uid && parent.deleting !== true
    && callerBarrier.get('state') === 'active'
    && parent.members.every((memberId: unknown) => memberId === uid);
  if (request.op === 'cleanupWorkspace') {
    if (!deletingOwner && !soloAccountOwner) denied('Only the deleting workspace owner can clean up stickers.');
  } else if (request.op === 'delete') {
    if (!deletingOwner && (parent.deleting === true || !member)) denied();
    if (recordSnap?.exists && !deletingOwner
      && recordSnap.get('uploaderId') !== uid && parent.ownerId !== uid) denied('Only the uploader or workspace owner can delete this sticker.');
  } else {
    if (!member || parent.deleting === true) denied();
  }
  if (request.op !== 'read' && freshLocked && !(deletingOwner && freshCancelled)) {
    throw new StickerRequestError(409, 'This workspace is still importing.');
  }
  if ((request.op === 'prepare' || request.op === 'complete')
    && (blocked(callerBarrier.data()) || blocked(ownerBarrier.data()))) {
    throw new StickerRequestError(409, 'Account cleanup is in progress. Try again later.');
  }
  return { parent, record: recordSnap?.data(), deletingOwner, soloAccountOwner };
}
function validateRecord(data: DocumentData, request: StickerRequest): void {
  const required = ['uploaderId','createdAt','mimeType','byteSize','width','height','encrypted','iv','ciphertextBytes','r2Key','status','uploadLeaseUntil'];
  const allowed = new Set([...required, 'reservationEtag', 'prepareToken']);
  if (required.some(field => !(field in data)) || Object.keys(data).some(field => !allowed.has(field))
    || typeof data.uploaderId !== 'string'
    || timestampMs(data.createdAt) === null || timestampMs(data.uploadLeaseUntil) === null
    || !STICKER_MIME_TYPES.includes(data.mimeType)
    || !Number.isSafeInteger(data.byteSize) || data.byteSize < 1 || data.byteSize > MAX_STICKER_BYTES
    || !Number.isSafeInteger(data.ciphertextBytes) || data.ciphertextBytes < 1 || data.ciphertextBytes > MAX_STICKER_CIPHERTEXT_BYTES
    || !Number.isSafeInteger(data.width) || data.width < 1 || !Number.isSafeInteger(data.height) || data.height < 1
    || data.encrypted !== true || typeof data.iv !== 'string' || !/^[A-Za-z0-9+/]{16}$/.test(data.iv)
    || !['uploading','ready','deleting'].includes(data.status)
    || data.r2Key !== objectKey(request.workspaceId, request.stickerId!)
    || (data.prepareToken !== undefined && (typeof data.prepareToken !== 'string' || !idPattern.test(data.prepareToken)))
    || (data.reservationEtag !== undefined && (typeof data.reservationEtag !== 'string' || data.reservationEtag.length > 256))) {
    throw new StickerRequestError(409, 'This sticker has invalid storage metadata.');
  }
}
async function inspect(request: StickerRequest, uid: string): Promise<Access> {
  const db = getAdminDb();
  return db.runTransaction(tx => access(db, tx, uid, request));
}
async function head(key: string) {
  try { return await r2().send(new HeadObjectCommand({ Bucket: bucket(), Key: key })); }
  catch (error) {
    const e = error as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (e.name === 'NotFound' || e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404) return null;
    throw error;
  }
}

async function prepare(uid: string, request: StickerRequest): Promise<Result> {
  const db = getAdminDb(), ref = db.collection('workspaces').doc(request.workspaceId).collection('stickers').doc(request.stickerId!);
  const prepareToken = randomUUID();
  const leaseUntil = Timestamp.fromMillis(Date.now() + STICKER_UPLOAD_SECONDS * 1000);
  const record = await db.runTransaction(async tx => {
    const ctx = await access(db, tx, uid, request);
    if (!ctx.record) throw new StickerRequestError(404, 'Sticker upload reservation not found.');
    validateRecord(ctx.record, request);
    if (ctx.record.uploaderId !== uid) denied();
    if (ctx.record.status !== 'uploading' || ctx.record.prepareToken) {
      throw new StickerRequestError(409, 'This upload was already prepared. Retry the file as a new sticker.');
    }
    tx.update(ref, { prepareToken, uploadLeaseUntil: leaseUntil });
    return ctx.record;
  });
  // Recheck cancellation before starting the one marker attempt. A transport already
  // started when deletion races remains indexed and cannot be retired on a negative HEAD.
  const beforeSeed = await inspect(request,uid);
  if (beforeSeed.record?.status !== 'uploading' || beforeSeed.record.prepareToken !== prepareToken) {
    throw new StickerRequestError(409,'This sticker is being removed.');
  }
  // No retry after a lost result. Its durable prepareToken is the cleanup authority.
  const seed = await r2().send(new PutObjectCommand({
    Bucket: bucket(), Key: objectKey(request.workspaceId, request.stickerId!),
    Body: Buffer.from(prepareToken, 'utf8'), ContentType: 'application/octet-stream',
    Metadata: { 'dropsync-prepare': prepareToken }, IfNoneMatch: '*',
  }));
  if (!seed.ETag) throw new StickerRequestError(503, 'Upload preparation is unresolved. Storage cleanup will retry.');
  await db.runTransaction(async tx => {
    const ctx = await access(db, tx, uid, request);
    if (!ctx.record || ctx.record.status !== 'uploading' || ctx.record.prepareToken !== prepareToken) {
      throw new StickerRequestError(409, 'This sticker is being removed.');
    }
    tx.update(ref, { reservationEtag: seed.ETag });
  });
  // The condition is part of SigV4. Removing it must invalidate the browser PUT.
  const url = await getSignedUrl(r2(), new PutObjectCommand({
    Bucket: bucket(), Key: objectKey(request.workspaceId, request.stickerId!),
    ContentType: 'application/octet-stream', ContentLength: record.ciphertextBytes, IfMatch: seed.ETag,
  }), {
    expiresIn: Math.max(1, Math.floor((leaseUntil.toMillis() - Date.now()) / 1000)),
    signableHeaders: new Set(['if-match', 'content-type', 'content-length']),
  });
  // Do not expose authorization after a concurrent delete/lock/revocation.
  const latest = await inspect(request, uid);
  if (latest.record?.status !== 'uploading' || latest.record.prepareToken !== prepareToken) {
    throw new StickerRequestError(409, 'This sticker is being removed.');
  }
  return { statusCode: 200, body: { ok: true, status: 'prepared', url,
    headers: { 'Content-Type': 'application/octet-stream', 'If-Match': seed.ETag } } };
}
async function complete(uid: string, request: StickerRequest): Promise<Result> {
  const ctx = await inspect(request, uid);
  if (!ctx.record) throw new StickerRequestError(404, 'Sticker upload not found.');
  validateRecord(ctx.record, request);
  if (ctx.record.uploaderId !== uid) denied();
  if (ctx.record.status === 'ready') return success('ready');
  if (ctx.record.status !== 'uploading' || !ctx.record.reservationEtag) throw new StickerRequestError(409, 'This sticker is not ready to finish.');
  const object = await head(objectKey(request.workspaceId, request.stickerId!));
  if (!object || object.ContentLength !== ctx.record.ciphertextBytes || object.ETag === ctx.record.reservationEtag) {
    throw new StickerRequestError(409, 'The encrypted upload has not finished.');
  }
  const db = getAdminDb(), ref = db.collection('workspaces').doc(request.workspaceId).collection('stickers').doc(request.stickerId!);
  await db.runTransaction(async tx => {
    const latest = await access(db, tx, uid, request);
    if (!latest.record || latest.record.status === 'deleting' || latest.record.prepareToken !== ctx.record!.prepareToken) {
      throw new StickerRequestError(409, 'This sticker is being removed.');
    }
    tx.update(ref, { status: 'ready' });
  });
  return success('ready');
}
async function read(uid: string, request: StickerRequest): Promise<Result> {
  const ctx = await inspect(request, uid);
  if (!ctx.record || ctx.record.status !== 'ready') throw new StickerRequestError(404, 'Sticker unavailable');
  validateRecord(ctx.record, request);
  const url = await getSignedUrl(r2(), new GetObjectCommand({
    Bucket: bucket(), Key: objectKey(request.workspaceId, request.stickerId!),
  }), { expiresIn: 60 });
  return { statusCode: 200, body: { ok: true, url } };
}
async function retire(uid: string, request: StickerRequest, cleanup = false): Promise<Result> {
  const db = getAdminDb(), ref = db.collection('workspaces').doc(request.workspaceId).collection('stickers').doc(request.stickerId!);
  const authorization = { ...request, op: cleanup ? 'cleanupWorkspace' : 'delete' } as StickerRequest;
  const record = await db.runTransaction(async tx => {
    const ctx = await access(db, tx, uid, authorization);
    if (!ctx.record) return null;
    validateRecord(ctx.record, request);
    if (ctx.record.status !== 'deleting') tx.update(ref, { status: 'deleting' });
    return ctx.record;
  });
  if (!record) return success('removed');
  const remaining = timestampMs(record.uploadLeaseUntil)! + STICKER_RETIRE_MARGIN_MS - Date.now();
  // complete() only marks ready after HEAD proved the ciphertext length and that its ETag
  // differs from the reservation marker. A late replay PUT still carries the marker as
  // If-Match, so it can never overwrite that committed object. Ready docs therefore have
  // nothing to wait for; uploading/unknown reservations still keep the full lease guard.
  if (record.status !== 'ready' && remaining > 0) return pending(remaining);
  if (record.prepareToken && !record.reservationEtag) {
    const object = await head(objectKey(request.workspaceId, request.stickerId!));
    if (!object?.ETag || object.Metadata?.['dropsync-prepare'] !== record.prepareToken) {
      // Missing object is NOT proof that the single seed write did not start/finish.
      return pending();
    }
    await db.runTransaction(async tx => {
      const latest = await access(db, tx, uid, authorization);
      if (!latest.record || latest.record.prepareToken !== record.prepareToken || latest.record.status !== 'deleting') {
        throw new StickerRequestError(409, 'Sticker cleanup state changed. Retry.');
      }
      tx.update(ref, { reservationEtag: object.ETag });
    });
  }
  await inspect(authorization, uid);
  // Any late browser PUT requires the original marker ETag and atomically fails once this is absent.
  await r2().send(new DeleteObjectCommand({ Bucket: bucket(), Key: objectKey(request.workspaceId, request.stickerId!) }));
  await db.runTransaction(async tx => {
    const ctx = await access(db, tx, uid, authorization);
    if (!ctx.record) return;
    if (ctx.record.prepareToken !== record.prepareToken
      || timestampMs(ctx.record.createdAt) !== timestampMs(record.createdAt)) {
      throw new StickerRequestError(409, 'Sticker cleanup state changed. Retry.');
    }
    tx.delete(ref);
  });
  return success('removed');
}
async function cleanupWorkspace(uid: string, request: StickerRequest): Promise<Result> {
  await inspect(request, uid);
  const db = getAdminDb(), collection = db.collection('workspaces').doc(request.workspaceId).collection('stickers');
  const page = await collection.limit(20).get();
  if (!page.empty) {
    for (const item of page.docs) {
      const result = await retire(uid, { ...request, stickerId: item.id }, true);
      if (!result.body.ok) return result;
    }
    if (!(await collection.limit(1).get()).empty) return { statusCode: 200, body: { ok: false, status: 'more' } };
  }
  // Parent admission is frozen by deleting=true or the verified solo-owner account barrier.
  await inspect(request, uid);
  const prefix = 'stickers/' + request.workspaceId + '/';
  const objects = await r2().send(new ListObjectsV2Command({
    Bucket: bucket(), Prefix: prefix, MaxKeys: 20,
  }));
  for (const object of objects.Contents ?? []) {
    if (!object.Key?.startsWith(prefix)) throw new StickerRequestError(503, 'Unexpected sticker cleanup key.');
    await inspect(request, uid);
    await r2().send(new DeleteObjectCommand({ Bucket: bucket(), Key: object.Key }));
  }
  // Requery rather than trusting a continuation token after destructive pagination.
  const [docs, objectsAfter] = await Promise.all([
    collection.limit(1).get(),
    r2().send(new ListObjectsV2Command({ Bucket: bucket(), Prefix: prefix, MaxKeys: 1 })),
  ]);
  if (!docs.empty || (objectsAfter.Contents?.length ?? 0) > 0) return { statusCode: 200, body: { ok: false, status: 'more' } };
  await inspect(request, uid);
  return success('clean');
}

export async function runStickerOperation(uid: string, request: StickerRequest): Promise<Result> {
  switch (request.op) {
    case 'prepare': return prepare(uid, request);
    case 'complete': return complete(uid, request);
    case 'read': return read(uid, request);
    case 'delete': return retire(uid, request);
    case 'cleanupWorkspace': return cleanupWorkspace(uid, request);
  }
}
