'use client';

import { type ArchiveOwnerContext, createArchiveOwnerContext, archiveOwnerToken } from './importFenceClient';

import { collection, doc, serverTimestamp, setDoc } from 'firebase/firestore';
import { auth, db } from './firebase';
import { encryptData, decryptData } from './crypto';
import { getWorkspaceKey } from './keys';
import {
  MAX_STICKER_BYTES, MAX_STICKER_CIPHERTEXT_BYTES, STICKER_MIME_TYPES,
  type StickerMimeType, type StickerOperationResult, type StickerImportItem, type WorkspaceSticker, type StickerAsset,
} from '@/types/stickers';

export class StickerOperationError extends Error {
  constructor(message: string, public readonly statusCode: number) { super(message); }
}
/** The reservation id attached to an import failure, for the hook's cleanup card/loop. */
export function failedStickerId(error: unknown): string | null {
  return error && typeof error === 'object' && typeof (error as { stickerId?: unknown }).stickerId === 'string'
    ? (error as { stickerId: string }).stickerId : null;
}
export function assertStickerScope(userId: string, signal?: AbortSignal): void {
  if (signal?.aborted || auth.currentUser?.uid !== userId) throw new DOMException('Cancelled', 'AbortError');
}
export async function stickerOperation(
  request: { op: 'prepare' | 'complete' | 'read' | 'delete' | 'cleanupWorkspace'; workspaceId: string; stickerId?: string },
  signal?: AbortSignal,
  owner?: ArchiveOwnerContext,
): Promise<StickerOperationResult> {
  owner?.check();
  const current = auth.currentUser;
  if (!current) throw new StickerOperationError('Sign in to use workspace stickers.', 401);
  const token = owner ? await archiveOwnerToken(owner) : await current.getIdToken();
  owner?.check();
  assertStickerScope(current.uid, signal);
  const response = await fetch('/api/stickers', {
    method: 'POST', signal, cache: 'no-store',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
  owner?.check();
  assertStickerScope(current.uid, signal);
  const result = await response.json() as StickerOperationResult;
  owner?.check();
  assertStickerScope(current.uid, signal);
  if (!response.ok) throw new StickerOperationError(result.error || "Couldn't finish sticker request. Try again.", response.status);
  return result;
}

export function stickerMimeFromHeader(bytes: Uint8Array): StickerMimeType | null {
  if (bytes.length >= 8 && [137,80,78,71,13,10,26,10].every((value, i) => bytes[i] === value)) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.slice(start, end));
  if (bytes.length >= 12 && ascii(0,4) === 'RIFF' && ascii(8,12) === 'WEBP') return 'image/webp';
  if (bytes.length >= 6 && ['GIF87a','GIF89a'].includes(ascii(0,6))) return 'image/gif';
  return null;
}
export async function validateStickerFile(file: File, signal?: AbortSignal): Promise<StickerMimeType> {
  const header = new Uint8Array(await file.slice(0,16).arrayBuffer());
  if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
  const detected = stickerMimeFromHeader(header);
  const declared = file.type.toLowerCase();
  // Empty supported-type files pass TYPE validation, then receive the precise SIZE error.
  const mime = file.size === 0 && STICKER_MIME_TYPES.includes(declared as StickerMimeType)
    ? declared as StickerMimeType : detected;
  if (!mime || (declared !== '' && declared !== mime)) {
    throw new Error(file.name + ': use a PNG, JPG, WebP, or GIF image.');
  }
  if (file.size > MAX_STICKER_BYTES) throw new Error(file.name + ": this file is over 10 MB. Choose one that's 10 MB or smaller.");
  if (file.size === 0) throw new Error(file.name + ': this file is empty.');
  return mime;
}
async function imageDimensions(blob: Blob, name: string, signal: AbortSignal): Promise<{ width: number; height: number }> {
  const url = URL.createObjectURL(blob);
  try {
    return await new Promise((resolve, reject) => {
      const image = new Image();
      const clean = () => { signal.removeEventListener('abort', abort); image.onload = null; image.onerror = null; };
      const abort = () => { clean(); image.src = ''; reject(new DOMException('Cancelled', 'AbortError')); };
      signal.addEventListener('abort', abort, { once: true });
      image.onload = () => {
        const width = image.naturalWidth, height = image.naturalHeight;
        clean();
        if (Number.isSafeInteger(width) && width > 0 && Number.isSafeInteger(height) && height > 0) resolve({ width, height });
        else reject(new Error(name + ": this image couldn't be opened."));
      };
      image.onerror = () => { clean(); reject(new Error(name + ": this image couldn't be opened.")); };
      if (signal.aborted) { abort(); return; }
      image.src = url;
    });
  } finally { URL.revokeObjectURL(url); }
}
function readDataUrl(blob: Blob, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    const clean = () => { signal.removeEventListener('abort', abort); reader.onload = null; reader.onerror = null; reader.onabort = null; };
    const abort = () => { reader.abort(); clean(); reject(new DOMException('Cancelled', 'AbortError')); };
    signal.addEventListener('abort', abort, { once: true });
    reader.onload = () => { const value = reader.result; clean(); if (typeof value === 'string') resolve(value); else reject(new Error('Image data is unavailable.')); };
    reader.onerror = () => { clean(); reject(new Error('Image data could not be read.')); };
    if (signal.aborted) { abort(); return; }
    reader.readAsDataURL(blob);
  });
}
function putCiphertext(url: string, headers: Record<string,string>, ciphertext: string, signal: AbortSignal, progress: (ratio: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const clean = () => { signal.removeEventListener('abort', abort); xhr.onload = null; xhr.onerror = null; xhr.onabort = null; xhr.upload.onprogress = null; };
    const abort = () => { xhr.abort(); clean(); reject(new DOMException('Cancelled', 'AbortError')); };
    if (!headers['If-Match'] || headers['Content-Type'] !== 'application/octet-stream') {
      reject(new Error('The conditional upload authorization is incomplete.')); return;
    }
    xhr.open('PUT', url);
    for (const [name,value] of Object.entries(headers)) {
      if (name === 'Content-Type' || name === 'If-Match') xhr.setRequestHeader(name,value);
    }
    xhr.upload.onprogress = event => { if (event.lengthComputable) progress(event.loaded / event.total); };
    xhr.onload = () => {
      const status = xhr.status; clean();
      if (status >= 200 && status < 300) resolve();
      else reject(new Error(status === 412 ? 'This upload was already used or removed. Retry the file.' : 'Upload failed. Try this file again.'));
    };
    xhr.onerror = () => { clean(); reject(new Error('Upload failed. Check your connection and try this file again.')); };
    xhr.onabort = () => { clean(); reject(new DOMException('Cancelled','AbortError')); };
    signal.addEventListener('abort',abort,{ once:true });
    if (signal.aborted) { abort(); return; }
    xhr.send(ciphertext);
  });
}

export async function importWorkspaceSticker(
  workspaceId: string, userId: string, file: File, signal: AbortSignal,
  update: (phase: StickerImportItem['phase'], ratio: number) => void,
): Promise<string> {
  assertStickerScope(userId,signal);
  const mimeType = await validateStickerFile(file,signal);
  assertStickerScope(userId,signal);
  const original = file.slice(0,file.size,mimeType);
  const dimensions = await imageDimensions(original,file.name,signal);
  assertStickerScope(userId,signal);
  const workspaceKey = await getWorkspaceKey(workspaceId,userId);
  assertStickerScope(userId,signal);
  if (!workspaceKey) throw new Error("Encryption isn't ready. Try again in a moment.");
  const plain = await readDataUrl(original,signal);
  assertStickerScope(userId,signal);
  const { encrypted,iv } = await encryptData(plain,workspaceKey);
  assertStickerScope(userId,signal);
  if (encrypted.length > MAX_STICKER_CIPHERTEXT_BYTES) throw new Error('The encrypted image is too large.');
  const ref = doc(collection(db,'workspaces',workspaceId,'stickers'));
  let reserved = false;
  try {
    await setDoc(ref,{
      uploaderId:userId,createdAt:serverTimestamp(),mimeType,byteSize:file.size,...dimensions,
      encrypted:true,iv,ciphertextBytes:encrypted.length,r2Key:'stickers/'+workspaceId+'/'+ref.id,
      status:'uploading',uploadLeaseUntil:serverTimestamp(),
    });
    reserved = true;
    assertStickerScope(userId,signal);
    const prepared = await stickerOperation({ op:'prepare',workspaceId,stickerId:ref.id },signal);
    assertStickerScope(userId,signal);
    if (!prepared.url || !prepared.headers) throw new Error('Upload authorization is unavailable.');
    update('uploading',0);
    await putCiphertext(prepared.url,prepared.headers,encrypted,signal,ratio => {
      if (!signal.aborted) update('uploading',ratio);
    });
    assertStickerScope(userId,signal);
    update('finishing',1);
    const completed = await stickerOperation({ op:'complete',workspaceId,stickerId:ref.id },signal);
    assertStickerScope(userId,signal);
    if (!completed.ok) throw new Error('The encrypted upload is still finishing.');
    update('added',1);
    return ref.id;
  } catch (error) {
    if (reserved) {
      // Keep the id with the failure so the hook can start the checked cleanup card/loop.
      // This best-effort call still runs if the hook has already gone away; its 202 is
      // intentionally not treated as completion, the hook's retry loop owns that.
      const failure = error instanceof Error ? error : new Error(String(error));
      try { (failure as Error & { stickerId?: string }).stickerId = ref.id; }
      catch { /* non-extensible error: the catalog's deleting snapshot still gets adopted */ }
      if (auth.currentUser?.uid === userId) {
        void stickerOperation({ op:'delete',workspaceId,stickerId:ref.id }).catch(() => {});
      }
      throw failure;
    }
    throw error;
  }
}

export async function loadStickerAsset(workspaceId: string, userId: string, sticker: WorkspaceSticker, signal: AbortSignal): Promise<StickerAsset> {
  assertStickerScope(userId,signal);
  if (sticker.status !== 'ready') throw new Error('Sticker unavailable');
  const key = await getWorkspaceKey(workspaceId,userId);
  assertStickerScope(userId,signal);
  if (!key) throw new Error("Encryption isn't ready. Try again in a moment.");
  const permission = await stickerOperation({ op:'read',workspaceId,stickerId:sticker.id },signal);
  assertStickerScope(userId,signal);
  if (!permission.url) throw new Error('Sticker unavailable');
  const parsed = new URL(permission.url);
  if (parsed.protocol !== 'https:' || !parsed.hostname.endsWith('.r2.cloudflarestorage.com')) throw new Error('Invalid sticker storage URL.');
  const response = await fetch(permission.url,{ signal,cache:'no-store' });
  assertStickerScope(userId,signal);
  if (!response.ok || Number(response.headers.get('content-length') || 0) > MAX_STICKER_CIPHERTEXT_BYTES) throw new Error("Couldn't load sticker");
  const ciphertext = await response.text();
  assertStickerScope(userId,signal);
  if (ciphertext.length !== sticker.ciphertextBytes) throw new Error("Couldn't load sticker");
  const dataUrl = await decryptData(ciphertext,key,sticker.iv);
  assertStickerScope(userId,signal);
  const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]*={0,2})$/.exec(dataUrl);
  if (!match || match[1] !== sticker.mimeType) throw new Error("Couldn't load sticker");
  const binary = atob(match[2]);
  if (binary.length !== sticker.byteSize) throw new Error("Couldn't load sticker");
  const bytes = Uint8Array.from(binary,character => character.charCodeAt(0));
  if (stickerMimeFromHeader(bytes.subarray(0,16)) !== sticker.mimeType) throw new Error("Couldn't load sticker");
  const blob = new Blob([bytes],{ type:sticker.mimeType });
  assertStickerScope(userId,signal);
  return { blob,url:URL.createObjectURL(blob) };
}

export function saveStickerFile(sticker: WorkspaceSticker, asset: StickerAsset): void {
  const extension = { 'image/png':'png','image/jpeg':'jpg','image/webp':'webp','image/gif':'gif' }[sticker.mimeType];
  const link = document.createElement('a');
  link.href = asset.url;
  link.download = 'sticker-' + sticker.id + '.' + extension;
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  link.remove();
}

export async function cleanupWorkspaceStickers(workspaceId: string, owner?: ArchiveOwnerContext): Promise<boolean> {
  const context = owner ?? (auth.currentUser ? createArchiveOwnerContext(auth.currentUser.uid) : undefined);
  for (;;) {
    context?.check();
    const result = await stickerOperation({ op:'cleanupWorkspace',workspaceId }, undefined, context);
    if (result.ok && result.status === 'clean') return true;
    if (result.status !== 'more') return false; // pending/uncertain never acknowledges completion
  }
}
