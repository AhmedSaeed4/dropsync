'use client';

import {
  BlobWriter,
  TextWriter,
  ZipReader,
  type Entry,
  type FileEntry,
} from '@zip.js/zip.js';
import { decryptData } from './crypto';

export const ARCHIVE_ENVELOPE_VERSION = 1;
export const ARCHIVE_EXTENSION = '.dropsync';
export const ARCHIVE_MIME = 'application/vnd.dropsync';
export const ARCHIVE_MAX_MANIFEST_BYTES = 10 * 1024 * 1024;
export const ARCHIVE_MAX_ENTRIES = 100_000;
export const ARCHIVE_MAX_UNCOMPRESSED_BYTES = 20 * 1024 * 1024 * 1024;
export const ARCHIVE_CHUNK_SIZE = 4 * 1024 * 1024;
export const ARCHIVE_KDF_ITERATIONS = 600_000;
export const ARCHIVE_MAX_DROP_FILE_BYTES = 500 * 1024 * 1024;

const MAGIC = 'DROPSYNC';
const MAGIC_BYTES = new TextEncoder().encode(MAGIC);
const ENVELOPE_PREFIX_BYTES = MAGIC_BYTES.length + 4;
const MAX_HEADER_BYTES = 64 * 1024;
const MAX_BLOB_FALLBACK_BYTES = 250 * 1024 * 1024;
const MAX_PASSWORD_LENGTH = 512;

export type ArchiveProgressPhase = 'preflight' | 'export' | 'inspect' | 'import';

export interface ArchiveProgress {
  phase: ArchiveProgressPhase;
  processedBytes: number;
  totalBytes: number;
  currentName?: string;
  message?: string;
}

export interface ArchiveSink {
  writable: WritableStream<Uint8Array>;
  finish: () => Promise<void>;
  abort: (reason?: unknown) => Promise<void>;
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

export interface LoadedArchive<T = unknown> {
  manifest: T;
  entries: Map<string, Entry>;
  reader: ZipReader<Uint8Array>;
  totalPayloadBytes: number;
}

export class ArchiveCancelledError extends Error {
  constructor() {
    super('Archive operation cancelled.');
    this.name = 'ArchiveCancelledError';
  }
}

export class ArchiveValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArchiveValidationError';
  }
}

export function archiveTypeMismatchMessage(
  actualSchema: unknown,
  expectedScope: 'personal' | 'workspace'
): string | null {
  if (expectedScope === 'personal' && actualSchema === 'dropsync.workspace') {
    return "This is a workspace backup, not a personal one. To restore it, close this and use Import from a workspace's options (the gear next to the workspace).";
  }
  if (expectedScope === 'workspace' && actualSchema === 'dropsync.personal') {
    return 'This is a personal backup, not a workspace one. To restore it, close this and use Import from your Personal options (the gear next to Personal).';
  }
  return null;
}

export class ArchiveExpiredDropError extends Error {
  constructor(name: string) {
    super(`Drop "${name}" expired while the archive was being built.`);
    this.name = 'ArchiveExpiredDropError';
  }
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ArchiveCancelledError();
}

export function assertPassword(password: string): void {
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

export function dataUriToBytes(dataUri: string): Uint8Array {
  const comma = dataUri.indexOf(',');
  if (comma < 0 || !/^data:[^;]+;base64,/i.test(dataUri.slice(0, comma + 1))) {
    throw new Error('The stored file is not a valid base64 data URI.');
  }
  return base64Decode(dataUri.slice(comma + 1));
}

export function bytesToDataUri(bytes: Uint8Array, mimeType: string): string {
  return `data:${mimeType || 'application/octet-stream'};base64,${base64Encode(bytes)}`;
}

export function isoDate(date: Date | null | undefined): string | null {
  return date ? date.toISOString() : null;
}

export function parseDate(value: string | null | undefined, field: string): Date | null {
  if (value == null) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid ${field} in the archive.`);
  return date;
}

export function isExpired(
  drop: { expiresAt?: Date | string | null },
  now = new Date()
): boolean {
  const expiresAt = drop.expiresAt instanceof Date
    ? drop.expiresAt
    : typeof drop.expiresAt === 'string'
      ? parseDate(drop.expiresAt, 'expiresAt')
      : null;
  return !!expiresAt && expiresAt.getTime() <= now.getTime();
}

export function isSafeZipPath(path: string): boolean {
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

export function getFileEntry(entries: Map<string, Entry>, path: string): FileEntry {
  if (!isSafeZipPath(path) || path === 'manifest.json') {
    throw new Error('The archive contains an invalid payload path.');
  }
  const entry = entries.get(path);
  if (!entry || entry.directory) throw new Error(`The archive payload is missing: ${path}`);
  return entry as FileEntry;
}

export function emitProgress(
  onProgress: ((progress: ArchiveProgress) => void) | undefined,
  progress: ArchiveProgress
): void {
  onProgress?.(progress);
}

export async function deriveArchiveKey(password: string, header: EnvelopeHeader): Promise<CryptoKey> {
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

export function createEnvelopeEncryptTransform(
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

export function createEnvelopeDecryptTransform(
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

export function prependStream(prefix: Uint8Array, source: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
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

export function makeHeader(): { header: EnvelopeHeader; headerBytes: Uint8Array } {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const noncePrefix = crypto.getRandomValues(new Uint8Array(8));
  const header: EnvelopeHeader = {
    magic: MAGIC,
    version: ARCHIVE_ENVELOPE_VERSION,
    cipher: 'AES-256-GCM-CHUNKED',
    chunkSize: ARCHIVE_CHUNK_SIZE,
    kdf: {
      name: 'PBKDF2-SHA256',
      version: 1,
      iterations: ARCHIVE_KDF_ITERATIONS,
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
    || header.version !== ARCHIVE_ENVELOPE_VERSION
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

export async function createArchiveSink(
  suggestedName: string,
  estimatedBytes: number,
  description = 'DropSync workspace backup'
): Promise<ArchiveSink> {
  const candidateWindow = window as Window & {
    showSaveFilePicker?: (options?: unknown) => Promise<{
      createWritable: () => Promise<WritableStream<Uint8Array>>;
    }>;
  };

  if (typeof candidateWindow.showSaveFilePicker === 'function') {
    const handle = await candidateWindow.showSaveFilePicker({
      suggestedName,
      types: [{ description, accept: { [ARCHIVE_MIME]: [ARCHIVE_EXTENSION] } }],
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
      const blob = new Blob(chunks as BlobPart[], { type: ARCHIVE_MIME });
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

export function countedStream(
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

export async function fetchText(url: string, signal?: AbortSignal): Promise<string> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`R2 fetch failed: ${response.status}`);
  return response.text();
}

export async function fetchRawOrLegacyDataUri(
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

export async function readEncryptedDataUri(
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

export async function extractDrawingScene(bytes: Uint8Array): Promise<unknown> {
  const { loadFromBlob: loadSceneFromBlob } = await import('@excalidraw/excalidraw');
  const scene = await loadSceneFromBlob(new Blob([bytes as BlobPart], { type: 'image/png' }), null, null);
  const serializable = {
    elements: scene.elements,
    appState: scene.appState,
    files: scene.files || undefined,
  };
  return JSON.parse(JSON.stringify(serializable));
}

export function remapDropReferences(
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

export async function readEntryBytes(entry: FileEntry, signal?: AbortSignal): Promise<Uint8Array> {
  throwIfAborted(signal);
  const blob = await entry.getData(new BlobWriter(), { signal });
  return new Uint8Array(await blob.arrayBuffer());
}

export async function loadArchive<T>(
  file: File,
  password: string,
  signal: AbortSignal | undefined,
  validateManifest: (manifest: unknown) => void
): Promise<LoadedArchive<T>> {
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
    if (entries.length > ARCHIVE_MAX_ENTRIES + 1) throw new ArchiveValidationError('The archive contains too many entries.');
    const entryMap = new Map<string, Entry>();
    let totalPayloadBytes = 0;
    for (const entry of entries) {
      if (entryMap.has(entry.filename) || !isSafeZipPath(entry.filename)) {
        throw new ArchiveValidationError('The archive contains an unsafe or duplicate ZIP path.');
      }
      entryMap.set(entry.filename, entry);
      if (!entry.directory) {
        if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0) {
          throw new ArchiveValidationError('The archive contains an invalid ZIP entry size.');
        }
        totalPayloadBytes += entry.uncompressedSize;
        if (totalPayloadBytes > ARCHIVE_MAX_UNCOMPRESSED_BYTES) {
          throw new ArchiveValidationError('The archive is too large to safely process in this browser.');
        }
      }
    }
    const manifestEntry = entryMap.get('manifest.json');
    if (!manifestEntry || manifestEntry.directory || manifestEntry.uncompressedSize > ARCHIVE_MAX_MANIFEST_BYTES) {
      throw new ArchiveValidationError('The archive manifest is missing or too large.');
    }
    const manifestText = await (manifestEntry as FileEntry).getData(new TextWriter(), { signal });
    let manifest: unknown;
    try {
      manifest = JSON.parse(manifestText) as unknown;
    } catch {
      throw new ArchiveValidationError('The archive manifest is invalid or unsupported.');
    }
    validateManifest(manifest);
    const referencedPaths = new Set<string>(['manifest.json']);
    const manifestDrops = (manifest as { drops?: Array<{ payloads?: { file?: string; image?: string } }> }).drops || [];
    for (const drop of manifestDrops) {
      for (const path of [drop.payloads?.file, drop.payloads?.image]) {
        if (path) {
          if (!entryMap.has(path)) throw new ArchiveValidationError(`The archive payload is missing: ${path}`);
          referencedPaths.add(path);
        }
      }
    }
    for (const entry of entries) {
      if (!entry.directory && !referencedPaths.has(entry.filename)) {
        throw new ArchiveValidationError(`The archive contains an unreferenced payload: ${entry.filename}`);
      }
    }
    if (!reader) throw new ArchiveValidationError('The archive reader did not initialize.');
    return { manifest: manifest as T, entries: entryMap, reader, totalPayloadBytes };
  } catch (error) {
    await reader?.close().catch(() => {});
    if (error instanceof ArchiveCancelledError) throw error;
    if (error instanceof ArchiveValidationError) throw error;
    throw new Error('The archive password is wrong, or the archive is damaged.');
  }
}
