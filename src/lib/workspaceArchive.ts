'use client';

import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  query,
  setDoc,
  Timestamp,
  where,
} from 'firebase/firestore';
import {
  BlobWriter,
  TextWriter,
  ZipReader,
  ZipWriterStream,
  type Entry,
  type FileEntry,
} from '@zip.js/zip.js';
import { auth, db } from './firebase';
import { decryptData, encryptData } from './crypto';
import {
  createWorkspaceKey,
  getWorkspaceKey,
  hasWorkspaceKey,
} from './keys';
import {
  deleteFromR2,
  uploadBinaryStreamToR2,
  uploadToR2,
} from './drops';
import { deleteWorkspace } from './workspaces';
import { Drop, Workspace, Category, ExpirationOption } from '@/types';
import type { MemberInfo } from './workspaces';

export const WORKSPACE_ARCHIVE_VERSION = 1;
export const WORKSPACE_ARCHIVE_EXTENSION = '.dropsync';
export const WORKSPACE_ARCHIVE_MIME = 'application/vnd.dropsync';
export const WORKSPACE_ARCHIVE_MAX_MANIFEST_BYTES = 10 * 1024 * 1024;
export const WORKSPACE_ARCHIVE_MAX_ENTRIES = 100_000;
export const WORKSPACE_ARCHIVE_MAX_UNCOMPRESSED_BYTES = 20 * 1024 * 1024 * 1024;
export const WORKSPACE_ARCHIVE_CHUNK_SIZE = 4 * 1024 * 1024;
export const WORKSPACE_ARCHIVE_KDF_ITERATIONS = 600_000;

const MAGIC = 'DROPSYNC';
const MAGIC_BYTES = new TextEncoder().encode(MAGIC);
const ENVELOPE_PREFIX_BYTES = MAGIC_BYTES.length + 4;
const MAX_HEADER_BYTES = 64 * 1024;
const MAX_BLOB_FALLBACK_BYTES = 250 * 1024 * 1024;
const MAX_PASSWORD_LENGTH = 512;
const MAX_WORKSPACE_NAME_LENGTH = 120;
const MAX_DROP_FILE_BYTES = 500 * 1024 * 1024;
const IMPORT_JOURNAL_KEY = 'dropsync_archive_import_journal';

interface ImportJournal {
  userId: string;
  workspaceId: string;
  createdWorkspace: boolean;
  createdDropIds: string[];
  createdR2Keys: string[];
  createdCategoryIds: string[];
}

export type ArchiveProgressPhase = 'preflight' | 'export' | 'inspect' | 'import';

export interface WorkspaceArchiveProgress {
  phase: ArchiveProgressPhase;
  processedBytes: number;
  totalBytes: number;
  currentName?: string;
  message?: string;
}

export interface WorkspaceArchiveExportOptions {
  workspace: Workspace;
  drops: Drop[];
  categories: Category[];
  members: MemberInfo[];
  userId: string;
  password: string;
  suggestedName?: string;
  signal?: AbortSignal;
  onProgress?: (progress: WorkspaceArchiveProgress) => void;
}

export interface WorkspaceArchiveInspection {
  manifest: WorkspaceArchiveManifest;
  dropCount: number;
  fileCount: number;
  passwordDropCount: number;
  lockedDropCount: number;
  foreverDropCount: number;
  totalPayloadBytes: number;
  warnings: string[];
}

export interface WorkspaceArchiveImportOptions {
  file: File;
  password: string;
  userId: string;
  destination:
    | { mode: 'new'; workspaceName: string }
    | { mode: 'merge'; workspaceId: string };
  signal?: AbortSignal;
  onProgress?: (progress: WorkspaceArchiveProgress) => void;
}

export interface WorkspaceArchiveImportResult {
  workspaceId: string;
  importedCount: number;
  skippedExpiredCount: number;
  downgradedForeverCount: number;
  unpinnedCount: number;
  warnings: string[];
}

export interface WorkspaceArchiveManifest {
  schema: 'dropsync.workspace';
  schemaVersion: number;
  archiveId: string;
  exportedAt: string;
  sourceWorkspace: {
    id: string;
    name: string;
    createdAt: string;
  };
  members: Array<{
    displayName: string;
    isOwner: boolean;
  }>;
  categories: Array<{
    name: string;
    createdByDisplayName: string;
    createdAt: string;
  }>;
  drops: WorkspaceArchiveDrop[];
}

export interface WorkspaceArchiveDrop {
  sourceId: string;
  type: 'text' | 'file';
  name: string;
  content?: string;
  categories: string[];
  pinned: boolean;
  locked: boolean;
  isDrawing: boolean;
  creatorName?: string;
  createdAt: string;
  expiresAt: string | null;
  expirationOption?: ExpirationOption;
  reminderAt: string | null;
  reminderSetByUid: string | null;
  reminderDismissedBy: string | null;
  fileSize?: number;
  mimeType?: string;
  imageSize?: number;
  imageMimeType?: string;
  sourceFileFormat?: 'binary';
  drawingScene?: unknown;
  payloads?: {
    file?: string;
    image?: string;
  };
}

interface EnvelopeHeader {
  magic: typeof MAGIC;
  version: number;
  cipher: 'AES-256-GCM-CHUNKED';
  chunkSize: number;
  kdf: {
    name: 'PBKDF2-SHA256';
    version: 1;
    iterations: number;
    salt: string;
  };
  noncePrefix: string;
}

interface ParsedEnvelopeHeader {
  header: EnvelopeHeader;
  headerBytes: Uint8Array;
  payloadOffset: number;
}

interface LoadedArchive {
  manifest: WorkspaceArchiveManifest;
  entries: Map<string, Entry>;
  reader: ZipReader<Uint8Array>;
  totalPayloadBytes: number;
}

interface ArchiveSink {
  writable: WritableStream<Uint8Array>;
  finish: () => Promise<void>;
  abort: (reason?: unknown) => Promise<void>;
}

class ArchiveCancelledError extends Error {
  constructor() {
    super('Archive operation cancelled.');
    this.name = 'ArchiveCancelledError';
  }
}

class ArchiveExpiredDropError extends Error {
  constructor(name: string) {
    super(`Drop "${name}" expired while the archive was being built.`);
    this.name = 'ArchiveExpiredDropError';
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ArchiveCancelledError();
}

function saveImportJournal(journal: ImportJournal): void {
  try {
    localStorage.setItem(IMPORT_JOURNAL_KEY, JSON.stringify(journal));
  } catch {
    // Private browsing or disabled storage only removes crash recovery; normal rollback remains active.
  }
}

function clearImportJournal(): void {
  try {
    localStorage.removeItem(IMPORT_JOURNAL_KEY);
  } catch {
    // Best effort.
  }
}

export async function recoverInterruptedWorkspaceArchiveImport(userId: string): Promise<void> {
  let journal: ImportJournal | null = null;
  try {
    const raw = localStorage.getItem(IMPORT_JOURNAL_KEY);
    if (raw) journal = JSON.parse(raw) as ImportJournal;
  } catch {
    clearImportJournal();
    return;
  }
  if (!journal || journal.userId !== userId) return;
  for (const key of journal.createdR2Keys || []) await deleteFromR2(key, journal.workspaceId || null).catch(() => {});
  for (const dropId of journal.createdDropIds || []) await deleteDoc(doc(db, 'drops', dropId)).catch(() => {});
  for (const categoryId of journal.createdCategoryIds || []) await deleteDoc(doc(db, 'categories', categoryId)).catch(() => {});
  if (journal.createdWorkspace && journal.workspaceId) await deleteWorkspace(userId, journal.workspaceId).catch(() => {});
  clearImportJournal();
}

function assertPassword(password: string): void {
  if (typeof password !== 'string' || password.length < 8) {
    throw new Error('Use an archive password with at least 8 characters.');
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw new Error('The archive password is too long.');
  }
}

function concatBytes(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const result = new Uint8Array(new ArrayBuffer(total));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function uint32Bytes(value: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(4));
  new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
  return bytes;
}

function readUint32(bytes: Uint8Array, offset = 0): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
}

function base64Encode(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length));
    for (let i = 0; i < chunk.length; i++) binary += String.fromCharCode(chunk[i]);
  }
  return btoa(binary);
}

function base64Decode(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function copyBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  copy.set(bytes);
  return copy;
}

function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return copyBytes(bytes).buffer;
}

function dataUriToBytes(dataUri: string): Uint8Array {
  const comma = dataUri.indexOf(',');
  if (comma < 0 || !/^data:[^;]+;base64,/i.test(dataUri.slice(0, comma + 1))) {
    throw new Error('The stored file is not a valid base64 data URI.');
  }
  return base64Decode(dataUri.slice(comma + 1));
}

function bytesToDataUri(bytes: Uint8Array, mimeType: string): string {
  return `data:${mimeType || 'application/octet-stream'};base64,${base64Encode(bytes)}`;
}

function isoDate(date: Date | null | undefined): string | null {
  return date ? date.toISOString() : null;
}

function parseDate(value: string | null | undefined, field: string): Date | null {
  if (value == null) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid ${field} in the archive.`);
  return date;
}

function normalizeWorkspaceName(name: string): string {
  const normalized = name.trim().slice(0, MAX_WORKSPACE_NAME_LENGTH);
  return normalized || 'Restored workspace';
}

function getDropCategories(drop: Drop): string[] {
  const values = drop.categories && drop.categories.length > 0
    ? drop.categories
    : drop.category
      ? [drop.category]
      : [];
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function isExpired(drop: WorkspaceArchiveDrop | Drop, now = new Date()): boolean {
  const expiresAt = drop.expiresAt instanceof Date ? drop.expiresAt : parseDate(drop.expiresAt, 'expiresAt');
  return !!expiresAt && expiresAt.getTime() <= now.getTime();
}

function isSafeZipPath(path: string): boolean {
  return path === 'manifest.json'
    || (
      path.startsWith('files/')
      && !path.startsWith('files//')
      && !path.includes('..')
      && !path.includes('\\')
      && !path.includes('\0')
      && !path.endsWith('/')
    );
}

function getFileEntry(entries: Map<string, Entry>, path: string): FileEntry {
  if (!isSafeZipPath(path) || path === 'manifest.json') {
    throw new Error('The archive contains an invalid payload path.');
  }
  const entry = entries.get(path);
  if (!entry || entry.directory) throw new Error(`The archive payload is missing: ${path}`);
  return entry as FileEntry;
}

function emitProgress(
  onProgress: ((progress: WorkspaceArchiveProgress) => void) | undefined,
  progress: WorkspaceArchiveProgress
): void {
  onProgress?.(progress);
}

async function deriveArchiveKey(password: string, header: EnvelopeHeader): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: bytesToArrayBuffer(base64Decode(header.kdf.salt)),
      iterations: header.kdf.iterations,
      hash: 'SHA-256',
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

function nonceForChunk(header: EnvelopeHeader, index: number): Uint8Array<ArrayBuffer> {
  const prefix = base64Decode(header.noncePrefix);
  if (prefix.length !== 8 || index > 0xffffffff) throw new Error('Archive chunk index overflow.');
  return concatBytes(prefix, uint32Bytes(index));
}

function chunkAad(headerBytes: Uint8Array, index: number, plainLength: number): Uint8Array<ArrayBuffer> {
  return concatBytes(headerBytes, uint32Bytes(index), uint32Bytes(plainLength));
}

function createEnvelopeEncryptTransform(
  key: CryptoKey,
  header: EnvelopeHeader,
  headerBytes: Uint8Array,
  signal?: AbortSignal
): TransformStream<Uint8Array, Uint8Array> {
  let pending = new Uint8Array(0);
  let chunkIndex = 0;

  const encryptChunk = async (plain: Uint8Array, controller: TransformStreamDefaultController<Uint8Array>) => {
    throwIfAborted(signal);
    const cipher = await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: bytesToArrayBuffer(nonceForChunk(header, chunkIndex)),
        additionalData: bytesToArrayBuffer(chunkAad(headerBytes, chunkIndex, plain.byteLength)),
      },
      key,
      bytesToArrayBuffer(plain)
    );
    controller.enqueue(concatBytes(uint32Bytes(cipher.byteLength), new Uint8Array(cipher)));
    chunkIndex += 1;
  };

  return new TransformStream<Uint8Array, Uint8Array>({
    async transform(chunk, controller) {
      throwIfAborted(signal);
      pending = concatBytes(pending, copyBytes(chunk));
      while (pending.byteLength >= header.chunkSize) {
        const part = pending.slice(0, header.chunkSize);
        pending = pending.slice(header.chunkSize);
        await encryptChunk(part, controller);
      }
    },
    async flush(controller) {
      if (pending.byteLength > 0) await encryptChunk(pending, controller);
    },
  });
}

function createEnvelopeDecryptTransform(
  key: CryptoKey,
  header: EnvelopeHeader,
  headerBytes: Uint8Array,
  signal?: AbortSignal
): TransformStream<Uint8Array, Uint8Array> {
  let pending = new Uint8Array(0);
  let chunkIndex = 0;

  return new TransformStream<Uint8Array, Uint8Array>({
    async transform(chunk, controller) {
      throwIfAborted(signal);
      pending = concatBytes(pending, copyBytes(chunk));
      while (pending.byteLength >= 4) {
        const cipherLength = readUint32(pending);
        if (cipherLength < 16 || cipherLength > header.chunkSize + 16) {
          throw new Error('The archive contains an invalid encrypted chunk.');
        }
        if (pending.byteLength < cipherLength + 4) return;
        const cipher = pending.slice(4, 4 + cipherLength);
        pending = pending.slice(4 + cipherLength);
        const plainLength = cipherLength - 16;
        const plain = await crypto.subtle.decrypt(
          {
            name: 'AES-GCM',
            iv: bytesToArrayBuffer(nonceForChunk(header, chunkIndex)),
            additionalData: bytesToArrayBuffer(chunkAad(headerBytes, chunkIndex, plainLength)),
          },
          key,
          bytesToArrayBuffer(cipher)
        );
        controller.enqueue(copyBytes(new Uint8Array(plain)));
        chunkIndex += 1;
      }
    },
    flush() {
      if (pending.byteLength !== 0) throw new Error('The archive ended with a truncated encrypted chunk.');
    },
  });
}

function prependStream(prefix: Uint8Array, source: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(prefix);
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          controller.enqueue(copyBytes(next.value));
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

function makeHeader(): { header: EnvelopeHeader; headerBytes: Uint8Array } {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const noncePrefix = crypto.getRandomValues(new Uint8Array(8));
  const header: EnvelopeHeader = {
    magic: MAGIC,
    version: WORKSPACE_ARCHIVE_VERSION,
    cipher: 'AES-256-GCM-CHUNKED',
    chunkSize: WORKSPACE_ARCHIVE_CHUNK_SIZE,
    kdf: {
      name: 'PBKDF2-SHA256',
      version: 1,
      iterations: WORKSPACE_ARCHIVE_KDF_ITERATIONS,
      salt: base64Encode(salt),
    },
    noncePrefix: base64Encode(noncePrefix),
  };
  const jsonBytes = new TextEncoder().encode(JSON.stringify(header));
  const headerBytes = concatBytes(MAGIC_BYTES, uint32Bytes(jsonBytes.byteLength), jsonBytes);
  return { header, headerBytes };
}

async function readEnvelopeHeader(file: File): Promise<ParsedEnvelopeHeader> {
  if (file.size < ENVELOPE_PREFIX_BYTES) throw new Error('This is not a valid .dropsync file.');
  const prefix = new Uint8Array(await file.slice(0, ENVELOPE_PREFIX_BYTES).arrayBuffer());
  const magic = new TextDecoder().decode(prefix.slice(0, MAGIC_BYTES.length));
  if (magic !== MAGIC) throw new Error('This is not a valid .dropsync file.');
  const headerLength = readUint32(prefix, MAGIC_BYTES.length);
  if (headerLength <= 0 || headerLength > MAX_HEADER_BYTES || file.size < ENVELOPE_PREFIX_BYTES + headerLength) {
    throw new Error('The archive header is invalid.');
  }
  const headerBytes = new Uint8Array(await file.slice(0, ENVELOPE_PREFIX_BYTES + headerLength).arrayBuffer());
  let header: EnvelopeHeader;
  try {
    header = JSON.parse(new TextDecoder().decode(headerBytes.slice(ENVELOPE_PREFIX_BYTES))) as EnvelopeHeader;
  } catch {
    throw new Error('The archive header is not valid JSON.');
  }
  if (
    header.magic !== MAGIC
    || header.version !== WORKSPACE_ARCHIVE_VERSION
    || header.cipher !== 'AES-256-GCM-CHUNKED'
    || header.kdf?.name !== 'PBKDF2-SHA256'
    || header.kdf?.version !== 1
    || header.kdf.iterations < 600_000
    || header.kdf.iterations > 2_000_000
    || header.chunkSize < 64 * 1024
    || header.chunkSize > 16 * 1024 * 1024
    || base64Decode(header.kdf.salt).length !== 16
    || base64Decode(header.noncePrefix).length !== 8
  ) {
    throw new Error('The archive header parameters are invalid.');
  }
  return {
    header,
    headerBytes,
    payloadOffset: ENVELOPE_PREFIX_BYTES + headerLength,
  };
}

async function createArchiveSink(suggestedName: string, estimatedBytes: number): Promise<ArchiveSink> {
  const candidateWindow = window as Window & {
    showSaveFilePicker?: (options?: unknown) => Promise<{
      createWritable: () => Promise<WritableStream<Uint8Array>>;
    }>;
  };

  if (typeof candidateWindow.showSaveFilePicker === 'function') {
    const handle = await candidateWindow.showSaveFilePicker({
      suggestedName,
      types: [{ description: 'DropSync workspace backup', accept: { [WORKSPACE_ARCHIVE_MIME]: [WORKSPACE_ARCHIVE_EXTENSION] } }],
    });
    const writable = await handle.createWritable();
    return {
      writable,
      finish: async () => {},
      abort: async (reason) => {
        try {
          await writable.abort(reason);
        } catch {
          // Best effort; the picker may already have closed the stream.
        }
      },
    };
  }

  if (estimatedBytes > MAX_BLOB_FALLBACK_BYTES) {
    throw new Error('This browser cannot safely save an archive of this size. Use a browser with file saving support.');
  }

  const chunks: Uint8Array[] = [];
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      chunks.push(new Uint8Array(chunk));
    },
  });
  return {
    writable,
    finish: async () => {
      const blob = new Blob(chunks as BlobPart[], { type: WORKSPACE_ARCHIVE_MIME });
      const url = URL.createObjectURL(blob);
      try {
        const link = document.createElement('a');
        link.href = url;
        link.download = suggestedName;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
      } finally {
        URL.revokeObjectURL(url);
      }
    },
    abort: async () => {
      chunks.length = 0;
    },
  };
}

function countedStream(
  source: ReadableStream<Uint8Array>,
  onChunk: (count: number) => void
): { stream: ReadableStream<Uint8Array>; getCount: () => number } {
  let count = 0;
  const stream = source.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      count += chunk.byteLength;
      onChunk(count);
      controller.enqueue(chunk);
    },
  }));
  return { stream, getCount: () => count };
}

async function fetchText(url: string, signal?: AbortSignal): Promise<string> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`R2 fetch failed: ${response.status}`);
  return response.text();
}

async function fetchRawOrLegacyDataUri(
  url: string,
  signal?: AbortSignal
): Promise<{ bytes: Uint8Array } | { stream: ReadableStream<Uint8Array> }> {
  const response = await fetch(url, { signal });
  if (!response.ok || !response.body) throw new Error(`R2 fetch failed: ${response.status}`);
  const reader = response.body.getReader();
  const first = await reader.read();
  if (first.done || !first.value) return { bytes: new Uint8Array(new ArrayBuffer(0)) };
  const firstBytes = copyBytes(first.value);
  const isDataUri = firstBytes.length >= 5
    && firstBytes[0] === 0x64
    && firstBytes[1] === 0x61
    && firstBytes[2] === 0x74
    && firstBytes[3] === 0x61
    && firstBytes[4] === 0x3a;
  if (isDataUri) {
    const decoder = new TextDecoder();
    let text = decoder.decode(firstBytes, { stream: true });
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      text += decoder.decode(next.value, { stream: true });
    }
    text += decoder.decode();
    return { bytes: dataUriToBytes(text) };
  }
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(firstBytes);
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          controller.enqueue(copyBytes(next.value));
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return { stream };
}

async function readEncryptedDataUri(
  url: string | undefined,
  fallback: string | undefined,
  key: CryptoKey,
  iv: string | undefined,
  signal?: AbortSignal
): Promise<Uint8Array> {
  const encrypted = url ? await fetchText(url, signal) : fallback;
  if (!encrypted) throw new Error('Encrypted payload is missing.');
  if (!iv) throw new Error('Encrypted payload IV is missing.');
  return dataUriToBytes(await decryptData(encrypted, key, iv));
}

async function readImageBytes(drop: Drop, key: CryptoKey, signal?: AbortSignal): Promise<Uint8Array> {
  if (drop.imageData) return dataUriToBytes(drop.imageData);
  if (!drop.imageUrl) throw new Error(`Drawing/image payload is missing for "${drop.name}".`);
  const encrypted = await fetchText(drop.imageUrl, signal);
  if (drop.imageIv) {
    return dataUriToBytes(await decryptData(encrypted, key, drop.imageIv));
  }
  return dataUriToBytes(encrypted);
}

async function extractDrawingScene(bytes: Uint8Array): Promise<unknown> {
  const { loadFromBlob: loadSceneFromBlob } = await import('@excalidraw/excalidraw');
  const scene = await loadSceneFromBlob(new Blob([bytes as BlobPart]), null, null);
  const serializable = {
    elements: scene.elements,
    appState: scene.appState,
    files: scene.files || undefined,
  };
  return JSON.parse(JSON.stringify(serializable));
}

function sourceDropToManifest(
  drop: Drop,
  payloads: WorkspaceArchiveDrop['payloads'],
  content: string | undefined,
  drawingScene: unknown
): WorkspaceArchiveDrop {
  return {
    sourceId: drop.id,
    type: drop.type === 'file' ? 'file' : 'text',
    name: drop.name,
    content,
    categories: getDropCategories(drop),
    pinned: !!drop.pinned,
    locked: !!drop.locked,
    isDrawing: !!drop.isDrawing,
    creatorName: drop.creatorName,
    createdAt: drop.createdAt.toISOString(),
    expiresAt: isoDate(drop.expiresAt),
    expirationOption: drop.expirationOption,
    reminderAt: isoDate(drop.reminderAt),
    reminderSetByUid: drop.reminderSetByUid ?? null,
    reminderDismissedBy: drop.reminderDismissedBy ?? null,
    fileSize: drop.type === 'file' ? drop.fileSize : undefined,
    mimeType: drop.type === 'file' ? drop.mimeType : undefined,
    imageSize: drop.type === 'text' ? drop.imageSize : undefined,
    imageMimeType: drop.type === 'text' ? drop.imageMimeType : undefined,
    sourceFileFormat: drop.fileFormat,
    drawingScene,
    payloads,
  };
}

function remapDropReferences(
  content: string,
  idMap: Map<string, string>,
  missingIds: Set<string>
): string {
  return content.replace(/#\[([^\]]+)\]\(([^)]+)\)/g, (full, name: string, sourceId: string) => {
    const targetId = idMap.get(sourceId);
    if (!targetId) missingIds.add(sourceId);
    return targetId ? `#[${name}](${targetId})` : full;
  });
}

function validateManifest(manifest: WorkspaceArchiveManifest): void {
  if (
    !manifest
    || manifest.schema !== 'dropsync.workspace'
    || manifest.schemaVersion !== WORKSPACE_ARCHIVE_VERSION
    || typeof manifest.archiveId !== 'string'
    || !manifest.sourceWorkspace
    || !Array.isArray(manifest.drops)
    || !Array.isArray(manifest.members)
    || !Array.isArray(manifest.categories)
  ) {
    throw new Error('The archive manifest is invalid or unsupported.');
  }
  if (manifest.drops.length > WORKSPACE_ARCHIVE_MAX_ENTRIES) throw new Error('The archive contains too many drops.');
  const sourceIds = new Set<string>();
  for (const drop of manifest.drops) {
    if (!drop.sourceId || sourceIds.has(drop.sourceId) || (drop.type !== 'text' && drop.type !== 'file') || !drop.name) {
      throw new Error('The archive contains an invalid or duplicate drop record.');
    }
    sourceIds.add(drop.sourceId);
    if (drop.type === 'file' && (!drop.payloads?.file || !drop.payloads.file.startsWith('files/') || !isSafeZipPath(drop.payloads.file))) {
      throw new Error(`The file payload is missing or unsafe for "${drop.name}".`);
    }
    if (drop.payloads?.image && (!drop.payloads.image.startsWith('files/') || !isSafeZipPath(drop.payloads.image))) {
      throw new Error(`The image payload is unsafe for "${drop.name}".`);
    }
    if (drop.isDrawing && !drop.payloads?.image) {
      throw new Error(`The drawing payload is missing for "${drop.name}".`);
    }
    parseDate(drop.createdAt, 'createdAt');
    parseDate(drop.expiresAt, 'expiresAt');
    parseDate(drop.reminderAt, 'reminderAt');
    if (drop.fileSize != null && (!Number.isSafeInteger(drop.fileSize) || drop.fileSize < 0 || drop.fileSize > MAX_DROP_FILE_BYTES)) {
      throw new Error(`The file size is invalid or exceeds the 500 MB limit for "${drop.name}".`);
    }
    if (drop.imageSize != null && (!Number.isSafeInteger(drop.imageSize) || drop.imageSize < 0 || drop.imageSize > MAX_DROP_FILE_BYTES)) {
      throw new Error(`The attached image size is invalid or exceeds the 500 MB limit for "${drop.name}".`);
    }
  }
}

function summarizeManifest(manifest: WorkspaceArchiveManifest, totalPayloadBytes: number): WorkspaceArchiveInspection {
  return {
    manifest,
    dropCount: manifest.drops.length,
    fileCount: manifest.drops.filter((drop) => drop.type === 'file').length,
    passwordDropCount: manifest.drops.filter((drop) => drop.categories.some((category) => category.toLowerCase() === 'password')).length,
    lockedDropCount: manifest.drops.filter((drop) => drop.locked).length,
    foreverDropCount: manifest.drops.filter((drop) => drop.expiresAt === null).length,
    totalPayloadBytes,
    warnings: manifest.drops.some((drop) => drop.categories.some((category) => category.toLowerCase() === 'password'))
      ? ['This archive includes password-category drops.']
      : [],
  };
}

async function loadArchive(file: File, password: string, signal?: AbortSignal): Promise<LoadedArchive> {
  assertPassword(password);
  throwIfAborted(signal);
  const parsed = await readEnvelopeHeader(file);
  const key = await deriveArchiveKey(password, parsed.header);
  const encryptedStream = file.slice(parsed.payloadOffset).stream() as ReadableStream<Uint8Array>;
  const zipStream = encryptedStream.pipeThrough(
    createEnvelopeDecryptTransform(key, parsed.header, parsed.headerBytes, signal)
  );
  let reader: ZipReader<Uint8Array> | undefined;
  try {
    reader = new ZipReader<Uint8Array>(zipStream, {
      checkAmbiguity: true,
      strictness: 'strict',
    });
    const entries = await reader.getEntries();
    if (entries.length > WORKSPACE_ARCHIVE_MAX_ENTRIES + 1) throw new Error('The archive contains too many entries.');
    const entryMap = new Map<string, Entry>();
    let totalPayloadBytes = 0;
    for (const entry of entries) {
      if (entryMap.has(entry.filename) || !isSafeZipPath(entry.filename)) {
        throw new Error('The archive contains an unsafe or duplicate ZIP path.');
      }
      entryMap.set(entry.filename, entry);
      if (!entry.directory) {
        if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0) {
          throw new Error('The archive contains an invalid ZIP entry size.');
        }
        totalPayloadBytes += entry.uncompressedSize;
        if (totalPayloadBytes > WORKSPACE_ARCHIVE_MAX_UNCOMPRESSED_BYTES) {
          throw new Error('The archive is too large to safely process in this browser.');
        }
      }
    }
    const manifestEntry = entryMap.get('manifest.json');
    if (!manifestEntry || manifestEntry.directory || manifestEntry.uncompressedSize > WORKSPACE_ARCHIVE_MAX_MANIFEST_BYTES) {
      throw new Error('The archive manifest is missing or too large.');
    }
    const manifestText = await (manifestEntry as FileEntry).getData(new TextWriter(), { signal });
    const manifest = JSON.parse(manifestText) as WorkspaceArchiveManifest;
    validateManifest(manifest);
    const referencedPaths = new Set<string>(['manifest.json']);
    for (const drop of manifest.drops) {
      for (const path of [drop.payloads?.file, drop.payloads?.image]) {
        if (path) {
          if (!entryMap.has(path)) throw new Error(`The archive payload is missing: ${path}`);
          referencedPaths.add(path);
        }
      }
    }
    for (const entry of entries) {
      if (!entry.directory && !referencedPaths.has(entry.filename)) {
        throw new Error(`The archive contains an unreferenced payload: ${entry.filename}`);
      }
    }
    if (!reader) throw new Error('The archive reader did not initialize.');
    return { manifest, entries: entryMap, reader, totalPayloadBytes };
  } catch (error) {
    await reader?.close().catch(() => {});
    if (error instanceof ArchiveCancelledError) throw error;
    throw new Error('The archive password is wrong, or the archive is damaged.');
  }
}

export async function inspectWorkspaceArchive(
  file: File,
  password: string,
  signal?: AbortSignal,
  onProgress?: (progress: WorkspaceArchiveProgress) => void
): Promise<WorkspaceArchiveInspection> {
  emitProgress(onProgress, { phase: 'inspect', processedBytes: 0, totalBytes: file.size, message: 'Checking archive…' });
  const loaded = await loadArchive(file, password, signal);
  try {
    return summarizeManifest(loaded.manifest, loaded.totalPayloadBytes);
  } finally {
    await loaded.reader.close();
  }
}

export async function exportWorkspaceArchive(options: WorkspaceArchiveExportOptions): Promise<{ fileName: string; estimatedBytes: number; skippedExpiredCount: number }> {
  const { workspace, drops, categories, members, userId, password, signal, onProgress } = options;
  assertPassword(password);
  throwIfAborted(signal);
  if (!workspace.id || workspace.ownerId !== userId) throw new Error('Only the workspace owner can export this workspace.');

  emitProgress(onProgress, { phase: 'preflight', processedBytes: 0, totalBytes: drops.length, message: 'Preparing workspace backup…' });
  const workspaceKey = await getWorkspaceKey(workspace.id, userId);
  if (!workspaceKey) throw new Error('The workspace encryption key is unavailable.');

  const eligibleDrops: Drop[] = [];
  let skippedExpiredCount = 0;
  for (const drop of drops) {
    if (drop.type === 'call') continue;
    if (isExpired(drop)) {
      skippedExpiredCount += 1;
      continue;
    }
    eligibleDrops.push(drop);
  }

  const archiveDrops: WorkspaceArchiveDrop[] = [];
  let estimatedBytes = 0;
  for (let index = 0; index < eligibleDrops.length; index++) {
    throwIfAborted(signal);
    const drop = eligibleDrops[index];
    if (isExpired(drop)) throw new ArchiveExpiredDropError(drop.name);
    if ((drop.fileSize != null && drop.fileSize > MAX_DROP_FILE_BYTES) || (drop.imageSize != null && drop.imageSize > MAX_DROP_FILE_BYTES)) {
      throw new Error(`The payload for "${drop.name}" exceeds the 500 MB limit.`);
    }
    let content: string | undefined;
    if (drop.type === 'text') {
      if (drop.encrypted) {
        if (!drop.iv) throw new Error(`Encrypted text drop "${drop.name}" has no IV.`);
        content = await decryptData(drop.content || '', workspaceKey, drop.iv);
      } else {
        content = drop.content || '';
      }
      estimatedBytes += new TextEncoder().encode(content).byteLength;
    }

    const payloads: WorkspaceArchiveDrop['payloads'] = {};
    let drawingScene: unknown;
    if (drop.type === 'file') {
      payloads.file = `files/${crypto.randomUUID()}.bin`;
      estimatedBytes += drop.fileSize || 0;
    }
    if (drop.type === 'text' && drop.imageUrl) {
      payloads.image = `files/${crypto.randomUUID()}.img`;
      estimatedBytes += drop.imageSize || 0;
      if (drop.isDrawing) {
        const imageBytes = await readImageBytes(drop, workspaceKey, signal);
        try {
          drawingScene = await extractDrawingScene(imageBytes);
        } catch {
          throw new Error(`The Excalidraw scene could not be extracted for "${drop.name}".`);
        }
      }
    }

    archiveDrops.push(sourceDropToManifest(drop, payloads, content, drawingScene));
    emitProgress(onProgress, {
      phase: 'preflight',
      processedBytes: index + 1,
      totalBytes: eligibleDrops.length,
      currentName: drop.name,
      message: `Preparing ${drop.name}`,
    });
  }

  let exportCategories = categories;
  try {
    const categorySnapshot = await getDocs(query(collection(db, 'categories'), where('workspaceId', '==', workspace.id)));
    exportCategories = categorySnapshot.docs.map((categoryDoc) => {
      const data = categoryDoc.data();
      return {
        id: categoryDoc.id,
        name: data.name,
        workspaceId: workspace.id,
        createdBy: data.createdBy,
        createdAt: data.createdAt?.toDate?.() || new Date(),
      } as Category;
    });
  } catch {
    // The already-loaded category snapshot remains a safe fallback for a transient read failure.
  }

  const manifest: WorkspaceArchiveManifest = {
    schema: 'dropsync.workspace',
    schemaVersion: WORKSPACE_ARCHIVE_VERSION,
    archiveId: crypto.randomUUID(),
    exportedAt: new Date().toISOString(),
    sourceWorkspace: {
      id: workspace.id,
      name: workspace.name,
      createdAt: workspace.createdAt.toISOString(),
    },
    members: members.map((member) => ({
      displayName: member.displayName || member.uid,
      isOwner: member.isOwner,
    })),
    categories: exportCategories.map((category) => ({
      name: category.name,
      createdByDisplayName: members.find((member) => member.uid === category.createdBy)?.displayName || 'Unknown member',
      createdAt: category.createdAt.toISOString(),
    })),
    drops: archiveDrops,
  };

  const { header, headerBytes } = makeHeader();
  const key = await deriveArchiveKey(password, header);
  const jsonBytes = new TextEncoder().encode(JSON.stringify(manifest));
  const estimatedArchiveBytes = estimatedBytes + jsonBytes.byteLength + 4096;
  const safeBaseName = (options.suggestedName || workspace.name || 'workspace')
    .replace(/[^a-z0-9._-]+/gi, '-')
    .replace(/^-+|-+$/g, '') || 'workspace';
  const fileName = `${safeBaseName}-${new Date().toISOString().slice(0, 10)}${WORKSPACE_ARCHIVE_EXTENSION}`;
  const sink = await createArchiveSink(fileName, estimatedArchiveBytes);
  const zipStream = new ZipWriterStream({ level: 0, zip64: true });
  const encryptedZipStream = zipStream.readable.pipeThrough(
    createEnvelopeEncryptTransform(key, header, headerBytes, signal)
  );
  const outputStream = prependStream(headerBytes, encryptedZipStream);
  const pipePromise = outputStream.pipeTo(sink.writable, { signal });
  const sourceDropsById = new Map(eligibleDrops.map((drop) => [drop.id, drop]));
  let processedBytes = 0;

  try {
    await new Blob([jsonBytes as BlobPart]).stream().pipeTo(zipStream.writable('manifest.json'), { signal });
    for (const archiveDrop of archiveDrops) {
      throwIfAborted(signal);
      if (isExpired(archiveDrop)) throw new ArchiveExpiredDropError(archiveDrop.name);
      const sourceDrop = sourceDropsById.get(archiveDrop.sourceId);
      if (!sourceDrop) throw new Error(`The source drop disappeared during export: ${archiveDrop.name}`);

      if (archiveDrop.type === 'text' && archiveDrop.content) {
        processedBytes += new TextEncoder().encode(archiveDrop.content).byteLength;
      }
      if (archiveDrop.payloads?.image) {
        const imageBytes = await readImageBytes(sourceDrop, workspaceKey, signal);
        const counted = countedStream(new Blob([imageBytes as BlobPart]).stream(), (count) => {
          emitProgress(onProgress, {
            phase: 'export',
            processedBytes: processedBytes + count,
            totalBytes: Math.max(estimatedBytes, 1),
            currentName: archiveDrop.name,
            message: `Exporting ${archiveDrop.name}`,
          });
        });
        await counted.stream.pipeTo(zipStream.writable(archiveDrop.payloads.image), { signal });
        processedBytes += counted.getCount();
      }
      if (archiveDrop.payloads?.file) {
        if ((sourceDrop.fileFormat === 'binary' || (sourceDrop.fileSize ?? 0) >= 10 * 1024 * 1024) && sourceDrop.fileUrl) {
          const fetched = await fetchRawOrLegacyDataUri(sourceDrop.fileUrl, signal);
          if ('bytes' in fetched) {
            if (archiveDrop.fileSize != null && fetched.bytes.byteLength !== archiveDrop.fileSize) {
              throw new Error(`The downloaded bytes for "${archiveDrop.name}" do not match its recorded size.`);
            }
            await new Blob([fetched.bytes as BlobPart]).stream().pipeTo(zipStream.writable(archiveDrop.payloads.file), { signal });
            processedBytes += fetched.bytes.byteLength;
          } else {
            const counted = countedStream(fetched.stream, (count) => {
              emitProgress(onProgress, {
                phase: 'export',
                processedBytes: processedBytes + count,
                totalBytes: Math.max(estimatedBytes, 1),
                currentName: archiveDrop.name,
                message: `Exporting ${archiveDrop.name}`,
              });
            });
            await counted.stream.pipeTo(zipStream.writable(archiveDrop.payloads.file), { signal });
            const actualBytes = counted.getCount();
            if (archiveDrop.fileSize != null && actualBytes !== archiveDrop.fileSize) {
              throw new Error(`The downloaded bytes for "${archiveDrop.name}" do not match its recorded size.`);
            }
            processedBytes += actualBytes;
          }
        } else {
          const bytes = sourceDrop.encrypted
            ? await readEncryptedDataUri(sourceDrop.fileUrl, sourceDrop.fileData, workspaceKey, sourceDrop.iv, signal)
            : sourceDrop.fileUrl
              ? dataUriToBytes(await fetchText(sourceDrop.fileUrl, signal))
              : sourceDrop.fileData
                ? dataUriToBytes(sourceDrop.fileData)
                : (() => { throw new Error(`File payload is missing for "${archiveDrop.name}".`); })();
          if (archiveDrop.fileSize != null && bytes.byteLength !== archiveDrop.fileSize) {
            throw new Error(`The decoded bytes for "${archiveDrop.name}" do not match its recorded size.`);
          }
          await new Blob([bytes as BlobPart]).stream().pipeTo(zipStream.writable(archiveDrop.payloads.file), { signal });
          processedBytes += bytes.byteLength;
        }
      }
      emitProgress(onProgress, {
        phase: 'export',
        processedBytes,
        totalBytes: Math.max(estimatedBytes, 1),
        currentName: archiveDrop.name,
        message: `Exported ${archiveDrop.name}`,
      });
    }
    await zipStream.close(undefined, { zip64: true });
    await pipePromise;
    await sink.finish();
    return { fileName, estimatedBytes: estimatedArchiveBytes, skippedExpiredCount };
  } catch (error) {
    await sink.abort(error);
    await pipePromise.catch(() => {});
    throw error;
  }
}

async function readEntryBytes(entry: FileEntry, signal?: AbortSignal): Promise<Uint8Array> {
  throwIfAborted(signal);
  const blob = await entry.getData(new BlobWriter(), { signal });
  return new Uint8Array(await blob.arrayBuffer());
}

async function ensureImportCategories(
  workspaceId: string,
  userId: string,
  manifest: WorkspaceArchiveManifest
): Promise<{ map: Map<string, string>; createdIds: string[] }> {
  const categoriesSnapshot = await getDocs(query(collection(db, 'categories'), where('workspaceId', '==', workspaceId)));
  const map = new Map<string, string>();
  categoriesSnapshot.forEach((categoryDoc) => {
    const name = categoryDoc.data().name as string;
    map.set(name.toLowerCase().trim(), name);
  });
  const createdIds: string[] = [];
  for (const category of manifest.categories) {
    const normalized = category.name.toLowerCase().trim();
    if (!normalized || normalized === 'password' || normalized === 'link' || map.has(normalized)) continue;
    const categoryRef = await addDoc(collection(db, 'categories'), {
      name: category.name.trim(),
      workspaceId,
      createdBy: userId,
      createdAt: Timestamp.fromDate(parseDate(category.createdAt, 'category.createdAt') || new Date()),
    });
    createdIds.push(categoryRef.id);
    map.set(normalized, category.name.trim());
  }
  return { map, createdIds };
}

async function readExistingTargetDrops(workspaceId: string): Promise<Drop[]> {
  const snapshot = await getDocs(query(collection(db, 'drops'), where('workspaceId', '==', workspaceId)));
  return snapshot.docs.map((dropDoc) => {
    const data = dropDoc.data();
    return {
      id: dropDoc.id,
      userId: data.userId,
      type: data.type,
      name: data.name,
      createdAt: data.createdAt?.toDate?.() || new Date(),
      expiresAt: data.expiresAt?.toDate?.() || null,
      workspaceId: data.workspaceId || null,
      pinned: !!data.pinned,
      importedFromArchiveId: data.importedFromArchiveId,
    } as Drop;
  });
}

async function createImportWorkspace(userId: string, name: string, createdAt: Date): Promise<Workspace> {
  const inviteChars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const inviteLimit = Math.floor(256 / inviteChars.length) * inviteChars.length;
  let inviteCode = '';
  while (inviteCode.length < 6) {
    const random = crypto.getRandomValues(new Uint8Array(1))[0];
    if (random < inviteLimit) inviteCode += inviteChars[random % inviteChars.length];
  }
  const workspaceRef = doc(collection(db, 'workspaces'));
  await setDoc(workspaceRef, {
    name,
    ownerId: userId,
    members: [userId],
    inviteCode,
    createdAt: Timestamp.fromDate(createdAt),
  });
  const keyCreated = await createWorkspaceKey(workspaceRef.id, userId);
  if (!keyCreated || !(await hasWorkspaceKey(workspaceRef.id))) {
    await deleteDoc(workspaceRef).catch(() => {});
    throw new Error('The destination workspace encryption key could not be created.');
  }
  return { id: workspaceRef.id, name, ownerId: userId, members: [userId], inviteCode, createdAt };
}

async function uploadArchiveEntryAsBinary(
  entry: FileEntry,
  mimeType: string | undefined,
  expectedBytes: number | undefined,
  signal: AbortSignal | undefined,
  onProgress: (count: number) => void
): Promise<{ url: string; key: string; bytes: number }> {
  let count = 0;
  const counting = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      count += chunk.byteLength;
      onProgress(count);
      controller.enqueue(chunk);
    },
  });
  try {
    const uploadPromise = uploadBinaryStreamToR2(counting.readable, mimeType || 'application/octet-stream', signal);
    await entry.getData(counting.writable, { signal });
    const result = await uploadPromise;
    if (expectedBytes != null && count !== expectedBytes) {
      await deleteFromR2(result.key, null).catch(() => {});
      throw new Error('Imported file bytes do not match the manifest size.');
    }
    return { ...result, bytes: count };
  } catch (error) {
    throw error;
  }
}

export async function importWorkspaceArchive(options: WorkspaceArchiveImportOptions): Promise<WorkspaceArchiveImportResult> {
  const { file, password, userId, destination, signal, onProgress } = options;
  assertPassword(password);
  throwIfAborted(signal);
  if (!auth.currentUser || auth.currentUser.uid !== userId) throw new Error('You must be signed in to import a workspace backup.');

  const loaded = await loadArchive(file, password, signal);
  let destinationWorkspace: Workspace | null = null;
  let createdWorkspace = false;
  const createdDropIds: string[] = [];
  const createdR2Keys: string[] = [];
  const createdCategoryIds: string[] = [];
  const journal: ImportJournal = {
    userId,
    workspaceId: '',
    createdWorkspace: false,
    createdDropIds,
    createdR2Keys,
    createdCategoryIds,
  };
  const persistJournal = () => saveImportJournal(journal);
  const warnings: string[] = [...summarizeManifest(loaded.manifest, loaded.totalPayloadBytes).warnings];
  let importedCount = 0;
  let skippedExpiredCount = 0;
  let downgradedForeverCount = 0;
  let unpinnedCount = 0;

  try {
    if (destination.mode === 'new') {
      destinationWorkspace = await createImportWorkspace(
        userId,
        normalizeWorkspaceName(destination.workspaceName),
        parseDate(loaded.manifest.sourceWorkspace.createdAt, 'sourceWorkspace.createdAt') || new Date()
      );
      createdWorkspace = true;
    } else {
      const targetSnapshot = await getDoc(doc(db, 'workspaces', destination.workspaceId));
      if (!targetSnapshot.exists()) throw new Error('The destination workspace no longer exists.');
      const targetData = targetSnapshot.data();
      if (targetData.ownerId !== userId || !Array.isArray(targetData.members) || !targetData.members.includes(userId)) {
        throw new Error('Only the destination workspace owner can merge this archive.');
      }
      destinationWorkspace = {
        id: destination.workspaceId,
        name: targetData.name,
        ownerId: targetData.ownerId,
        members: targetData.members,
        inviteCode: targetData.inviteCode,
        createdAt: targetData.createdAt?.toDate?.() || new Date(),
      };
      const existingDrops = await readExistingTargetDrops(destination.workspaceId);
      if (existingDrops.some((drop) => (drop as Drop & { importedFromArchiveId?: string }).importedFromArchiveId === loaded.manifest.archiveId)) {
        throw new Error('This archive has already been imported into the selected workspace.');
      }
    }

    journal.workspaceId = destinationWorkspace.id;
    journal.createdWorkspace = createdWorkspace;
    persistJournal();
    const workspaceKey = await getWorkspaceKey(destinationWorkspace.id, userId);
    if (!workspaceKey) throw new Error('The destination workspace encryption key is unavailable.');
    const categoryResult = await ensureImportCategories(destinationWorkspace.id, userId, loaded.manifest);
    createdCategoryIds.push(...categoryResult.createdIds);
    persistJournal();

    const existingDrops = destination.mode === 'merge' ? await readExistingTargetDrops(destinationWorkspace.id) : [];
    let pinnedCount = existingDrops.filter((drop) => drop.pinned && !isExpired(drop)).length;
    const sourceToNewId = new Map<string, string>();
    for (const archiveDrop of loaded.manifest.drops) {
      if (!isExpired(archiveDrop)) sourceToNewId.set(archiveDrop.sourceId, doc(collection(db, 'drops')).id);
    }

    const totalBytes = Math.max(loaded.totalPayloadBytes, 1);
    let processedBytes = 0;
    for (const archiveDrop of loaded.manifest.drops) {
      throwIfAborted(signal);
      if (isExpired(archiveDrop)) {
        sourceToNewId.delete(archiveDrop.sourceId);
        skippedExpiredCount += 1;
        continue;
      }
      const newDropId = sourceToNewId.get(archiveDrop.sourceId);
      if (!newDropId) throw new Error(`Missing destination ID for "${archiveDrop.name}".`);
      const categories = archiveDrop.categories
        .map((name) => categoryResult.map.get(name.toLowerCase().trim()) || (name.toLowerCase().trim() === 'password' || name.toLowerCase().trim() === 'link' ? name.trim() : null))
        .filter((name): name is string => !!name);
      const missingReferenceIds = new Set<string>();
      const content = archiveDrop.content == null ? '' : remapDropReferences(archiveDrop.content, sourceToNewId, missingReferenceIds);
      if (missingReferenceIds.size > 0) {
        warnings.push(`Drop "${archiveDrop.name}" references ${missingReferenceIds.size} excluded or missing drop${missingReferenceIds.size === 1 ? '' : 's'}.`);
      }
      const originalExpiresAt = parseDate(archiveDrop.expiresAt, 'expiresAt');
      let expirationOption: ExpirationOption | undefined = archiveDrop.expirationOption;
      if (!originalExpiresAt) expirationOption = 'forever';
      let expiresAt = originalExpiresAt;

      let pinned = archiveDrop.pinned;
      if (pinned && pinnedCount >= 2) {
        pinned = false;
        unpinnedCount += 1;
      } else if (pinned) {
        pinnedCount += 1;
      }

      const docData: Record<string, unknown> = {
        userId,
        type: archiveDrop.type,
        name: archiveDrop.name,
        createdAt: Timestamp.fromDate(parseDate(archiveDrop.createdAt, 'createdAt') || new Date()),
        expiresAt: expiresAt ? Timestamp.fromDate(expiresAt) : null,
        ...(expirationOption ? { expirationOption } : {}),
        workspaceId: destinationWorkspace.id,
        pinned,
        locked: archiveDrop.locked,
        category: null,
        categories,
        reminderAt: archiveDrop.reminderAt ? Timestamp.fromDate(parseDate(archiveDrop.reminderAt, 'reminderAt')!) : null,
        reminderSetByUid: archiveDrop.reminderSetByUid,
        reminderDismissedBy: archiveDrop.reminderDismissedBy,
        importedFromArchiveId: loaded.manifest.archiveId,
      };

      if (archiveDrop.creatorName) docData.creatorName = archiveDrop.creatorName;
      if (archiveDrop.isDrawing) docData.isDrawing = true;

      if (archiveDrop.type === 'text') {
        const encrypted = await encryptData(content, workspaceKey);
        docData.content = encrypted.encrypted;
        docData.encrypted = true;
        docData.iv = encrypted.iv;
        if (archiveDrop.payloads?.image) {
          const imageEntry = getFileEntry(loaded.entries, archiveDrop.payloads.image);
          const imageBytes = await readEntryBytes(imageEntry, signal);
          if (archiveDrop.imageSize != null && imageBytes.byteLength !== archiveDrop.imageSize) {
            throw new Error(`The drawing/image bytes for "${archiveDrop.name}" do not match the manifest size.`);
          }
          const imageData = bytesToDataUri(imageBytes, archiveDrop.imageMimeType || 'image/png');
          const encryptedImage = await encryptData(imageData, workspaceKey);
          const upload = await uploadToR2(encryptedImage.encrypted);
          createdR2Keys.push(upload.key);
          persistJournal();
          docData.imageUrl = upload.url;
          docData.imageR2Key = upload.key;
          docData.imageSize = imageBytes.byteLength;
          docData.imageMimeType = archiveDrop.imageMimeType || 'image/png';
          docData.imageIv = encryptedImage.iv;
          processedBytes += imageBytes.byteLength;
        }
      } else {
        const fileEntry = getFileEntry(loaded.entries, archiveDrop.payloads!.file!);
        if (archiveDrop.fileSize != null) docData.fileSize = archiveDrop.fileSize;
        docData.mimeType = archiveDrop.mimeType || 'application/octet-stream';
        const isBinary = archiveDrop.sourceFileFormat === 'binary' || (archiveDrop.fileSize ?? 0) >= 10 * 1024 * 1024;
        if (isBinary) {
          const upload = await uploadArchiveEntryAsBinary(
            fileEntry,
            archiveDrop.mimeType,
            archiveDrop.fileSize,
            signal,
            (count) => emitProgress(onProgress, {
              phase: 'import',
              processedBytes: processedBytes + count,
              totalBytes,
              currentName: archiveDrop.name,
              message: `Importing ${archiveDrop.name}`,
            })
          );
          createdR2Keys.push(upload.key);
          persistJournal();
          docData.fileUrl = upload.url;
          docData.r2Key = upload.key;
          docData.fileFormat = 'binary';
          processedBytes += upload.bytes;
        } else {
          const bytes = await readEntryBytes(fileEntry, signal);
          if (archiveDrop.fileSize != null && bytes.byteLength !== archiveDrop.fileSize) {
            throw new Error(`The imported bytes for "${archiveDrop.name}" do not match the manifest size.`);
          }
          const dataUri = bytesToDataUri(bytes, archiveDrop.mimeType || 'application/octet-stream');
          const encrypted = await encryptData(dataUri, workspaceKey);
          const upload = await uploadToR2(encrypted.encrypted);
          createdR2Keys.push(upload.key);
          persistJournal();
          docData.fileUrl = upload.url;
          docData.r2Key = upload.key;
          docData.encrypted = true;
          docData.iv = encrypted.iv;
          processedBytes += bytes.byteLength;
        }
      }

      // Forever writes are enforced by Firestore. If a standard user is denied, retry this one
      // drop as a visible 24-hour downgrade instead of blocking the complete import.
      const dropRef = doc(db, 'drops', newDropId);
      try {
        await setDoc(dropRef, docData);
      } catch (error) {
        const errorCode = (error as { code?: string })?.code;
        if ((errorCode === 'permission-denied' || errorCode === 'PERMISSION_DENIED') && docData.expiresAt === null && expirationOption === 'forever') {
          expirationOption = '24h';
          expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
          docData.expiresAt = Timestamp.fromDate(expiresAt);
          docData.expirationOption = expirationOption;
          downgradedForeverCount += 1;
          await setDoc(dropRef, docData);
        } else {
          throw error;
        }
      }
      createdDropIds.push(newDropId);
      persistJournal();
      importedCount += 1;
      emitProgress(onProgress, {
        phase: 'import',
        processedBytes,
        totalBytes,
        currentName: archiveDrop.name,
        message: `Imported ${archiveDrop.name}`,
      });
    }

    // The final drop has been written, recorded in the journal, and its synchronous progress
    // bookkeeping has completed. From this point on, cleanup must never be allowed to roll back a
    // successful restore.
    clearImportJournal();
    try {
      await loaded.reader.close();
    } catch (error) {
      console.warn('Workspace archive reader cleanup failed after a successful import:', error);
    }
    return {
      workspaceId: destinationWorkspace.id,
      importedCount,
      skippedExpiredCount,
      downgradedForeverCount,
      unpinnedCount,
      warnings,
    };
  } catch (error) {
    await loaded.reader.close().catch(() => {});
    for (const key of createdR2Keys) await deleteFromR2(key, destinationWorkspace?.id || null).catch(() => {});
    for (const dropId of createdDropIds) await deleteDoc(doc(db, 'drops', dropId)).catch(() => {});
    for (const categoryId of createdCategoryIds) await deleteDoc(doc(db, 'categories', categoryId)).catch(() => {});
    if (createdWorkspace && destinationWorkspace) {
      await deleteWorkspace(userId, destinationWorkspace.id).catch(() => {});
    }
    clearImportJournal();
    if (error instanceof ArchiveCancelledError) throw error;
    throw error;
  }
}