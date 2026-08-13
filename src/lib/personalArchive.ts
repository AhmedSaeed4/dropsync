'use client';

import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDocs,
  query,
  setDoc,
  Timestamp,
  where,
} from 'firebase/firestore';
import { ZipWriterStream, type FileEntry } from '@zip.js/zip.js';
import { auth, db } from './firebase';
import {
  ARCHIVE_EXTENSION,
  ARCHIVE_MAX_DROP_FILE_BYTES,
  ARCHIVE_MAX_ENTRIES,
  ArchiveCancelledError,
  ArchiveExpiredDropError,
  ArchiveValidationError,
  archiveTypeMismatchMessage,
  assertPassword,
  bytesToDataUri,
  countedStream,
  createArchiveSink,
  createEnvelopeEncryptTransform,
  dataUriToBytes,
  deriveArchiveKey,
  emitProgress,
  extractDrawingScene,
  fetchRawOrLegacyDataUri,
  getFileEntry,
  isExpired,
  isSafeZipPath,
  loadArchive,
  makeHeader,
  parseDate,
  prependStream,
  readEntryBytes,
  remapDropReferences,
  throwIfAborted,
  type ArchiveProgress,
} from './archiveFormat';
import { decryptPersonalDropForArchive, deleteFromR2, uploadBinaryFileToR2, uploadToR2 } from './drops';
import { generateAESKey, encryptData } from './crypto';
import { encryptDEKForUser, getUserKeys } from './keys';
import type { Category, Drop, ExpirationOption } from '@/types';

export const PERSONAL_ARCHIVE_SCHEMA = 'dropsync.personal' as const;
export const PERSONAL_ARCHIVE_SCHEMA_VERSION = 1;
export const PERSONAL_ARCHIVE_EXTENSION = ARCHIVE_EXTENSION;

const PERSONAL_IMPORT_JOURNAL_KEY = 'dropsync_personal_archive_import_journal';
const MAX_PERSONAL_NAME_LENGTH = 120;
const RAW_FILE_THRESHOLD = 10 * 1024 * 1024;

export type PersonalArchiveProgress = ArchiveProgress;

export interface PersonalArchiveCategory {
  name: string;
  createdAt: string;
}

export interface PersonalArchiveDrop {
  sourceId: string;
  type: 'text' | 'file';
  name: string;
  content?: string;
  categories: string[];
  pinned: boolean;
  locked: boolean;
  isDrawing: boolean;
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

export interface PersonalArchiveManifest {
  schema: typeof PERSONAL_ARCHIVE_SCHEMA;
  schemaVersion: typeof PERSONAL_ARCHIVE_SCHEMA_VERSION;
  archiveId: string;
  exportedAt: string;
  sourceSpace: 'personal';
  sourceUser?: {
    displayName?: string;
  };
  categories: PersonalArchiveCategory[];
  drops: PersonalArchiveDrop[];
}

export interface PersonalArchiveInspection {
  manifest: PersonalArchiveManifest;
  dropCount: number;
  fileCount: number;
  passwordDropCount: number;
  lockedDropCount: number;
  foreverDropCount: number;
  expiredDropCount: number;
  totalPayloadBytes: number;
  warnings: string[];
}

export interface PersonalArchiveSkippedDrop {
  name: string;
  reason: string;
}

export interface PersonalArchiveExportOptions {
  drops: Drop[];
  categories: Category[];
  userId: string;
  sourceDisplayName?: string | null;
  password: string;
  suggestedName?: string;
  signal?: AbortSignal;
  onProgress?: (progress: PersonalArchiveProgress) => void;
}

export interface PersonalArchiveExportResult {
  fileName: string;
  estimatedBytes: number;
  skippedExpiredCount: number;
  skippedDrops: PersonalArchiveSkippedDrop[];
}

export interface PersonalArchiveImportOptions {
  file: File;
  password: string;
  userId: string;
  signal?: AbortSignal;
  onProgress?: (progress: PersonalArchiveProgress) => void;
}

export interface PersonalArchiveImportResult {
  importedCount: number;
  skippedExpiredCount: number;
  downgradedForeverCount: number;
  unpinnedCount: number;
  warnings: string[];
}

interface PersonalImportJournal {
  userId: string;
  archiveId: string;
  createdDropIds: string[];
  createdR2Keys: string[];
  createdCategoryIds: string[];
}

interface PreparedPersonalDrop {
  content?: string;
  fileBytes?: Uint8Array;
  imageBytes?: Uint8Array;
}

function saveImportJournal(journal: PersonalImportJournal): void {
  try {
    localStorage.setItem(PERSONAL_IMPORT_JOURNAL_KEY, JSON.stringify(journal));
  } catch {
    // Private browsing or disabled storage only removes crash recovery; normal rollback remains active.
  }
}

function clearImportJournal(): void {
  try {
    localStorage.removeItem(PERSONAL_IMPORT_JOURNAL_KEY);
  } catch {
    // Best effort.
  }
}

export async function recoverInterruptedPersonalArchiveImport(userId: string): Promise<void> {
  let journal: PersonalImportJournal | null = null;
  try {
    const raw = localStorage.getItem(PERSONAL_IMPORT_JOURNAL_KEY);
    if (raw) journal = JSON.parse(raw) as PersonalImportJournal;
  } catch {
    clearImportJournal();
    return;
  }
  if (!journal || journal.userId !== userId) return;
  for (const key of journal.createdR2Keys || []) await deleteFromR2(key, null).catch(() => {});
  for (const dropId of journal.createdDropIds || []) await deleteDoc(doc(db, 'drops', dropId)).catch(() => {});
  for (const categoryId of journal.createdCategoryIds || []) await deleteDoc(doc(db, 'categories', categoryId)).catch(() => {});
  clearImportJournal();
}

function getDropCategories(drop: Drop): string[] {
  const values = drop.categories && drop.categories.length > 0
    ? drop.categories
    : drop.category
      ? [drop.category]
      : [];
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function normalizeArchiveName(name: string): string {
  const normalized = name.trim().slice(0, MAX_PERSONAL_NAME_LENGTH);
  return normalized || 'personal';
}

function errorReason(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return 'The personal drop could not be decrypted or read.';
}

function sourceDropToManifest(
  drop: Drop,
  payloads: PersonalArchiveDrop['payloads'],
  content: string | undefined,
  drawingScene: unknown
): PersonalArchiveDrop {
  return {
    sourceId: drop.id,
    type: drop.type === 'file' ? 'file' : 'text',
    name: drop.name,
    content,
    categories: getDropCategories(drop),
    pinned: !!drop.pinned,
    locked: !!drop.locked,
    isDrawing: !!drop.isDrawing,
    createdAt: drop.createdAt.toISOString(),
    expiresAt: drop.expiresAt ? drop.expiresAt.toISOString() : null,
    expirationOption: drop.expirationOption,
    reminderAt: drop.reminderAt ? drop.reminderAt.toISOString() : null,
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

function validatePersonalManifest(raw: unknown): void {
  try {
    validatePersonalManifestBody(raw);
  } catch (error) {
    if (error instanceof ArchiveValidationError) throw error;
    throw new ArchiveValidationError(error instanceof Error ? error.message : 'The personal archive manifest is invalid or unsupported.');
  }
}

function validatePersonalManifestBody(raw: unknown): void {
  const manifest = raw as Partial<PersonalArchiveManifest> | null;
  const typeMismatch = archiveTypeMismatchMessage(manifest?.schema, 'personal');
  if (typeMismatch) throw new ArchiveValidationError(typeMismatch);
  if (
    !manifest
    || manifest.schema !== PERSONAL_ARCHIVE_SCHEMA
    || manifest.schemaVersion !== PERSONAL_ARCHIVE_SCHEMA_VERSION
    || typeof manifest.archiveId !== 'string'
    || !manifest.archiveId
    || typeof manifest.exportedAt !== 'string'
    || manifest.sourceSpace !== 'personal'
    || !Array.isArray(manifest.categories)
    || !Array.isArray(manifest.drops)
  ) {
    throw new Error('The personal archive manifest is invalid or unsupported.');
  }
  parseDate(manifest.exportedAt, 'exportedAt');
  if (manifest.drops.length > ARCHIVE_MAX_ENTRIES) throw new Error('The archive contains too many drops.');

  const sourceIds = new Set<string>();
  for (const category of manifest.categories) {
    if (!category || typeof category.name !== 'string' || !category.name.trim()) {
      throw new Error('The personal archive contains an invalid category.');
    }
    parseDate(category.createdAt, 'category.createdAt');
  }

  for (const drop of manifest.drops) {
    if (
      !drop
      || typeof drop.sourceId !== 'string'
      || !drop.sourceId
      || sourceIds.has(drop.sourceId)
      || (drop.type !== 'text' && drop.type !== 'file')
      || typeof drop.name !== 'string'
      || !drop.name
      || !Array.isArray(drop.categories)
    ) {
      throw new Error('The personal archive contains an invalid or duplicate drop record.');
    }
    sourceIds.add(drop.sourceId);
    if (drop.categories.some((category) => typeof category !== 'string')) {
      throw new Error(`The categories are invalid for "${drop.name}".`);
    }
    if (drop.content != null && typeof drop.content !== 'string') {
      throw new Error(`The text content is invalid for "${drop.name}".`);
    }
    if (drop.type === 'file' && (!drop.payloads?.file || !drop.payloads.file.startsWith('files/') || !isSafeZipPath(drop.payloads.file))) {
      throw new Error(`The file payload is missing or unsafe for "${drop.name}".`);
    }
    if (drop.payloads?.image && (!drop.payloads.image.startsWith('files/') || !isSafeZipPath(drop.payloads.image))) {
      throw new Error(`The image payload is unsafe for "${drop.name}".`);
    }
    if (drop.isDrawing && !drop.payloads?.image) {
      throw new Error(`The drawing payload is missing for "${drop.name}".`);
    }
    if (drop.sourceFileFormat !== undefined && drop.sourceFileFormat !== 'binary') {
      throw new Error(`The file format is invalid for "${drop.name}".`);
    }
    parseDate(drop.createdAt, 'createdAt');
    parseDate(drop.expiresAt, 'expiresAt');
    parseDate(drop.reminderAt, 'reminderAt');
    if (drop.fileSize != null && (!Number.isSafeInteger(drop.fileSize) || drop.fileSize < 0 || drop.fileSize > ARCHIVE_MAX_DROP_FILE_BYTES)) {
      throw new Error(`The file size is invalid or exceeds the 500 MB limit for "${drop.name}".`);
    }
    if (drop.imageSize != null && (!Number.isSafeInteger(drop.imageSize) || drop.imageSize < 0 || drop.imageSize > ARCHIVE_MAX_DROP_FILE_BYTES)) {
      throw new Error(`The attached image size is invalid or exceeds the 500 MB limit for "${drop.name}".`);
    }
  }
}

function summarizeManifest(manifest: PersonalArchiveManifest, totalPayloadBytes: number): PersonalArchiveInspection {
  const now = new Date();
  const hasPasswordDrops = manifest.drops.some((drop) => drop.categories.some((category) => category.toLowerCase() === 'password'));
  return {
    manifest,
    dropCount: manifest.drops.length,
    fileCount: manifest.drops.filter((drop) => drop.type === 'file').length,
    passwordDropCount: manifest.drops.filter((drop) => drop.categories.some((category) => category.toLowerCase() === 'password')).length,
    lockedDropCount: manifest.drops.filter((drop) => drop.locked).length,
    foreverDropCount: manifest.drops.filter((drop) => drop.expiresAt === null).length,
    expiredDropCount: manifest.drops.filter((drop) => isExpired(drop, now)).length,
    totalPayloadBytes,
    warnings: hasPasswordDrops ? ['This archive includes password-category drops.'] : [],
  };
}

async function loadPersonalArchive(file: File, password: string, signal?: AbortSignal) {
  return loadArchive<PersonalArchiveManifest>(file, password, signal, validatePersonalManifest);
}

export async function inspectPersonalArchive(
  file: File,
  password: string,
  signal?: AbortSignal,
  onProgress?: (progress: PersonalArchiveProgress) => void
): Promise<PersonalArchiveInspection> {
  emitProgress(onProgress, { phase: 'inspect', processedBytes: 0, totalBytes: file.size, message: 'Checking personal archive…' });
  const loaded = await loadPersonalArchive(file, password, signal);
  try {
    return summarizeManifest(loaded.manifest, loaded.totalPayloadBytes);
  } finally {
    await loaded.reader.close();
  }
}

async function readPersonalCategories(
  userId: string,
  manifest: PersonalArchiveManifest
): Promise<{ map: Map<string, string>; createdIds: string[] }> {
  const snapshot = await getDocs(query(
    collection(db, 'categories'),
    where('createdBy', '==', userId),
    where('workspaceId', '==', null)
  ));
  const map = new Map<string, string>();
  snapshot.forEach((categoryDoc) => {
    const name = categoryDoc.data().name as string;
    map.set(name.toLowerCase().trim(), name);
  });
  const createdIds: string[] = [];
  for (const category of manifest.categories) {
    const normalized = category.name.toLowerCase().trim();
    if (!normalized || normalized === 'password' || normalized === 'link' || map.has(normalized)) continue;
    const categoryRef = await addDoc(collection(db, 'categories'), {
      name: category.name.trim(),
      workspaceId: null,
      createdBy: userId,
      createdAt: Timestamp.fromDate(parseDate(category.createdAt, 'category.createdAt') || new Date()),
    });
    createdIds.push(categoryRef.id);
    map.set(normalized, category.name.trim());
  }
  return { map, createdIds };
}

interface ExistingPersonalDrop {
  id: string;
  expiresAt: Date | null;
  pinned: boolean;
  importedFromArchiveId?: string;
}

async function readExistingPersonalDrops(userId: string): Promise<ExistingPersonalDrop[]> {
  const snapshot = await getDocs(query(
    collection(db, 'drops'),
    where('userId', '==', userId),
    where('workspaceId', '==', null)
  ));
  return snapshot.docs.map((dropDoc) => {
    const data = dropDoc.data();
    return {
      id: dropDoc.id,
      expiresAt: data.expiresAt?.toDate?.() || null,
      pinned: !!data.pinned,
      importedFromArchiveId: data.importedFromArchiveId,
    };
  });
}

async function uploadArchiveEntryAsBinary(
  entry: FileEntry,
  mimeType: string | undefined,
  expectedBytes: number | undefined,
  signal: AbortSignal | undefined,
  onProgress: (count: number) => void
): Promise<{ url: string; key: string; bytes: number }> {
  const declaredBytes = entry.uncompressedSize;
  if (!Number.isSafeInteger(declaredBytes) || declaredBytes < 0) {
    throw new Error('The archive contains an invalid raw file size.');
  }
  if (declaredBytes > ARCHIVE_MAX_DROP_FILE_BYTES) {
    throw new Error('The raw file exceeds the 500 MB limit.');
  }
  if (expectedBytes != null && declaredBytes !== expectedBytes) {
    throw new Error('Imported file bytes do not match the manifest size.');
  }

  throwIfAborted(signal);
  const bytes = await readEntryBytes(entry, signal);
  throwIfAborted(signal);
  if (bytes.byteLength > ARCHIVE_MAX_DROP_FILE_BYTES) {
    throw new Error('The raw file exceeds the 500 MB limit.');
  }
  if (expectedBytes != null && bytes.byteLength !== expectedBytes) {
    throw new Error('Imported file bytes do not match the manifest size.');
  }

  const blob = new Blob([bytes as BlobPart], { type: mimeType || 'application/octet-stream' });
  const result = await uploadBinaryFileToR2(blob, (ratio) => {
    const boundedRatio = Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : 0;
    onProgress(Math.round(boundedRatio * bytes.byteLength));
  });
  onProgress(bytes.byteLength);
  return { ...result, bytes: bytes.byteLength };
}

export async function exportPersonalArchive(
  options: PersonalArchiveExportOptions
): Promise<PersonalArchiveExportResult> {
  const { drops, categories, userId, password, sourceDisplayName, signal, onProgress } = options;
  assertPassword(password);
  throwIfAborted(signal);
  if (!auth.currentUser || auth.currentUser.uid !== userId) throw new Error('You must be signed in to export personal drops.');

  emitProgress(onProgress, { phase: 'preflight', processedBytes: 0, totalBytes: drops.length, message: 'Preparing personal backup…' });

  let userKeys: { publicKey: CryptoKey; privateKey: CryptoKey } | null = null;
  let keyError: string | null = null;
  try {
    userKeys = await getUserKeys(userId);
    if (!userKeys) keyError = 'Personal encryption keys are unavailable.';
  } catch (error) {
    keyError = errorReason(error);
  }

  const archiveDrops: PersonalArchiveDrop[] = [];
  const preparedDrops = new Map<string, PreparedPersonalDrop>();
  const skippedDrops: PersonalArchiveSkippedDrop[] = [];
  let skippedExpiredCount = 0;
  let estimatedBytes = 0;

  for (let index = 0; index < drops.length; index++) {
    throwIfAborted(signal);
    const drop = drops[index];
    if (drop.type === 'call') continue;
    if (drop.workspaceId !== null) continue;
    if (isExpired(drop)) {
      skippedExpiredCount += 1;
      continue;
    }

    try {
      if ((drop.fileSize != null && drop.fileSize > ARCHIVE_MAX_DROP_FILE_BYTES) || (drop.imageSize != null && drop.imageSize > ARCHIVE_MAX_DROP_FILE_BYTES)) {
        throw new Error('The payload exceeds the 500 MB limit.');
      }

      const payloads: PersonalArchiveDrop['payloads'] = {};
      if (drop.type === 'file') payloads.file = `files/${crypto.randomUUID()}.bin`;
      if (drop.type === 'text' && drop.imageUrl) payloads.image = `files/${crypto.randomUUID()}.img`;

      const isRawFile = drop.type === 'file' && (drop.fileFormat === 'binary' || (drop.fileSize ?? 0) >= RAW_FILE_THRESHOLD);
      let prepared: PreparedPersonalDrop = {};
      let content: string | undefined;
      let drawingScene: unknown;

      if (isRawFile) {
        if (!drop.fileUrl && !drop.fileData) throw new Error('The raw file payload is missing.');
        estimatedBytes += drop.fileSize || 0;
      } else {
        if (drop.encrypted && !userKeys) throw new Error(keyError || 'Personal encryption keys are unavailable.');
        const decrypted = await decryptPersonalDropForArchive(drop, userId, userKeys, signal);
        prepared = {
          content: drop.type === 'text' ? decrypted.content ?? '' : undefined,
          fileBytes: drop.type === 'file' && decrypted.fileData ? dataUriToBytes(decrypted.fileData) : undefined,
          imageBytes: decrypted.imageData ? dataUriToBytes(decrypted.imageData) : undefined,
        };
        content = prepared.content;
        if (content !== undefined) estimatedBytes += new TextEncoder().encode(content).byteLength;
        if (prepared.fileBytes) {
          if (drop.fileSize != null && prepared.fileBytes.byteLength !== drop.fileSize) throw new Error('The decoded file bytes do not match the recorded size.');
          estimatedBytes += prepared.fileBytes.byteLength;
        }
        if (prepared.imageBytes) {
          if (drop.imageSize != null && prepared.imageBytes.byteLength !== drop.imageSize) throw new Error('The decoded image bytes do not match the recorded size.');
          estimatedBytes += prepared.imageBytes.byteLength;
        } else if (payloads.image) {
          throw new Error('The attached image payload is missing.');
        }
        if (drop.isDrawing && prepared.imageBytes) {
          try {
            drawingScene = await extractDrawingScene(prepared.imageBytes);
          } catch {
            throw new Error('The Excalidraw scene could not be extracted.');
          }
        }
      }

      archiveDrops.push(sourceDropToManifest(drop, payloads, content, drawingScene));
      preparedDrops.set(drop.id, prepared);
      emitProgress(onProgress, {
        phase: 'preflight',
        processedBytes: index + 1,
        totalBytes: Math.max(drops.length, 1),
        currentName: drop.name,
        message: `Preparing ${drop.name}`,
      });
    } catch (error) {
      if (error instanceof ArchiveCancelledError) throw error;
      skippedDrops.push({ name: drop.name, reason: errorReason(error) });
    }
  }

  let exportCategories = categories;
  try {
    const categorySnapshot = await getDocs(query(
      collection(db, 'categories'),
      where('createdBy', '==', userId),
      where('workspaceId', '==', null)
    ));
    exportCategories = categorySnapshot.docs.map((categoryDoc) => {
      const data = categoryDoc.data();
      return {
        id: categoryDoc.id,
        name: data.name,
        workspaceId: null,
        createdBy: data.createdBy,
        createdAt: data.createdAt?.toDate?.() || new Date(),
      } as Category;
    });
  } catch {
    // The already-loaded category snapshot remains a safe fallback for a transient read failure.
  }

  const manifest: PersonalArchiveManifest = {
    schema: PERSONAL_ARCHIVE_SCHEMA,
    schemaVersion: PERSONAL_ARCHIVE_SCHEMA_VERSION,
    archiveId: crypto.randomUUID(),
    exportedAt: new Date().toISOString(),
    sourceSpace: 'personal',
    sourceUser: sourceDisplayName ? { displayName: sourceDisplayName } : undefined,
    categories: exportCategories.map((category) => ({
      name: category.name,
      createdAt: category.createdAt.toISOString(),
    })),
    drops: archiveDrops,
  };

  const { header, headerBytes } = makeHeader();
  const key = await deriveArchiveKey(password, header);
  const jsonBytes = new TextEncoder().encode(JSON.stringify(manifest));
  const estimatedArchiveBytes = estimatedBytes + jsonBytes.byteLength + 4096;
  const safeBaseName = normalizeArchiveName(options.suggestedName || 'personal')
    .replace(/[^a-z0-9._-]+/gi, '-')
    .replace(/^-+|-+$/g, '') || 'personal';
  const fileName = `${safeBaseName}-${new Date().toISOString().slice(0, 10)}${PERSONAL_ARCHIVE_EXTENSION}`;
  const sink = await createArchiveSink(fileName, estimatedArchiveBytes, 'DropSync personal backup');
  const zipStream = new ZipWriterStream({ level: 0, zip64: true });
  const encryptedZipStream = zipStream.readable.pipeThrough(
    createEnvelopeEncryptTransform(key, header, headerBytes, signal)
  );
  const outputStream = prependStream(headerBytes, encryptedZipStream);
  const pipePromise = outputStream.pipeTo(sink.writable, { signal });
  const sourceDropsById = new Map(drops.map((drop) => [drop.id, drop]));
  let processedBytes = 0;

  try {
    await new Blob([jsonBytes as BlobPart]).stream().pipeTo(zipStream.writable('manifest.json'), { signal });
    for (const archiveDrop of archiveDrops) {
      throwIfAborted(signal);
      const sourceDrop = sourceDropsById.get(archiveDrop.sourceId);
      if (!sourceDrop) throw new Error(`The source drop disappeared during export: ${archiveDrop.name}`);
      if (isExpired(sourceDrop)) throw new ArchiveExpiredDropError(archiveDrop.name);
      const prepared = preparedDrops.get(archiveDrop.sourceId) || {};

      if (archiveDrop.type === 'text') {
        if (archiveDrop.content !== undefined) processedBytes += new TextEncoder().encode(archiveDrop.content).byteLength;
        if (archiveDrop.payloads?.image) {
          if (!prepared.imageBytes) throw new Error(`The image payload is missing for "${archiveDrop.name}".`);
          const counted = countedStream(new Blob([prepared.imageBytes as BlobPart]).stream(), (count) => {
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
      } else if (archiveDrop.payloads?.file) {
        const isBinary = sourceDrop.fileFormat === 'binary' || (sourceDrop.fileSize ?? 0) >= RAW_FILE_THRESHOLD;
        if (isBinary && sourceDrop.fileUrl) {
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
          const bytes = prepared.fileBytes || (sourceDrop.fileData ? dataUriToBytes(sourceDrop.fileData) : (() => { throw new Error(`The file payload is missing for "${archiveDrop.name}".`); })());
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
    return { fileName, estimatedBytes: estimatedArchiveBytes, skippedExpiredCount, skippedDrops };
  } catch (error) {
    await sink.abort(error);
    await pipePromise.catch(() => {});
    throw error;
  }
}

export async function importPersonalArchive(
  options: PersonalArchiveImportOptions
): Promise<PersonalArchiveImportResult> {
  const { file, password, userId, signal, onProgress } = options;
  assertPassword(password);
  throwIfAborted(signal);
  if (!auth.currentUser || auth.currentUser.uid !== userId) throw new Error('You must be signed in to import a personal backup.');

  const userKeys = await getUserKeys(userId);
  if (!userKeys) throw new Error('Your personal encryption keys are unavailable. Sign in again before importing.');

  const loaded = await loadPersonalArchive(file, password, signal);
  const createdDropIds: string[] = [];
  const createdR2Keys: string[] = [];
  const createdCategoryIds: string[] = [];
  const journal: PersonalImportJournal = {
    userId,
    archiveId: loaded.manifest.archiveId,
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
    const existingDrops = await readExistingPersonalDrops(userId);
    if (existingDrops.some((drop) => drop.importedFromArchiveId === loaded.manifest.archiveId)) {
      throw new Error('This personal archive has already been imported.');
    }

    persistJournal();
    const categoryResult = await readPersonalCategories(userId, loaded.manifest);
    createdCategoryIds.push(...categoryResult.createdIds);
    persistJournal();

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
      const content = archiveDrop.type === 'text'
        ? remapDropReferences(archiveDrop.content || '', sourceToNewId, missingReferenceIds)
        : undefined;
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

      const reminderAt = parseDate(archiveDrop.reminderAt, 'reminderAt');
      const docData: Record<string, unknown> = {
        userId,
        type: archiveDrop.type,
        name: archiveDrop.name,
        createdAt: Timestamp.fromDate(parseDate(archiveDrop.createdAt, 'createdAt') || new Date()),
        expiresAt: expiresAt ? Timestamp.fromDate(expiresAt) : null,
        ...(expirationOption ? { expirationOption } : {}),
        workspaceId: null,
        pinned,
        locked: archiveDrop.locked,
        category: null,
        categories,
        reminderAt: reminderAt ? Timestamp.fromDate(reminderAt) : null,
        reminderSetByUid: reminderAt ? userId : null,
        reminderDismissedBy: null,
        importedFromArchiveId: loaded.manifest.archiveId,
      };

      if (archiveDrop.isDrawing) docData.isDrawing = true;

      if (archiveDrop.type === 'text') {
        const dek = await generateAESKey();
        const encryptedContent = await encryptData(content || '', dek);
        const wrappedDek = await encryptDEKForUser(dek, userKeys.publicKey, userKeys.privateKey);
        docData.content = encryptedContent.encrypted;
        docData.encrypted = true;
        docData.iv = encryptedContent.iv;
        docData.encryptedDEK = JSON.stringify(wrappedDek);

        if (archiveDrop.payloads?.image) {
          const imageEntry = getFileEntry(loaded.entries, archiveDrop.payloads.image);
          const imageBytes = await readEntryBytes(imageEntry, signal);
          if (archiveDrop.imageSize != null && imageBytes.byteLength !== archiveDrop.imageSize) {
            throw new Error(`The drawing/image bytes for "${archiveDrop.name}" do not match the manifest size.`);
          }
          const imageData = bytesToDataUri(imageBytes, archiveDrop.imageMimeType || 'image/png');
          const encryptedImage = await encryptData(imageData, dek);
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
        const isBinary = archiveDrop.sourceFileFormat === 'binary' || (archiveDrop.fileSize ?? 0) >= RAW_FILE_THRESHOLD;
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
          // The XHR uploader does not accept an AbortSignal. Journal the returned key first, then
          // honor a cancellation so rollback can delete an upload that finished after Cancel.
          throwIfAborted(signal);
          docData.fileUrl = upload.url;
          docData.r2Key = upload.key;
          docData.fileFormat = 'binary';
          processedBytes += upload.bytes;
        } else {
          const bytes = await readEntryBytes(fileEntry, signal);
          if (archiveDrop.fileSize != null && bytes.byteLength !== archiveDrop.fileSize) {
            throw new Error(`The imported bytes for "${archiveDrop.name}" do not match the manifest size.`);
          }
          const dek = await generateAESKey();
          const dataUri = bytesToDataUri(bytes, archiveDrop.mimeType || 'application/octet-stream');
          const encrypted = await encryptData(dataUri, dek);
          const wrappedDek = await encryptDEKForUser(dek, userKeys.publicKey, userKeys.privateKey);
          const upload = await uploadToR2(encrypted.encrypted);
          createdR2Keys.push(upload.key);
          persistJournal();
          docData.fileUrl = upload.url;
          docData.r2Key = upload.key;
          docData.encrypted = true;
          docData.iv = encrypted.iv;
          docData.encryptedDEK = JSON.stringify(wrappedDek);
          processedBytes += bytes.byteLength;
        }
      }

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
    // bookkeeping has completed. Clear the journal before reader cleanup so cleanup can never
    // roll back a completed restore on a later login.
    clearImportJournal();
    try {
      await loaded.reader.close();
    } catch (error) {
      console.warn('Personal archive reader cleanup failed after a successful import:', error);
    }
    return {
      importedCount,
      skippedExpiredCount,
      downgradedForeverCount,
      unpinnedCount,
      warnings,
    };
  } catch (error) {
    await loaded.reader.close().catch(() => {});
    for (const key of createdR2Keys) await deleteFromR2(key, null).catch(() => {});
    for (const dropId of createdDropIds) await deleteDoc(doc(db, 'drops', dropId)).catch(() => {});
    for (const categoryId of createdCategoryIds) await deleteDoc(doc(db, 'categories', categoryId)).catch(() => {});
    clearImportJournal();
    if (error instanceof ArchiveCancelledError) throw error;
    throw error;
  }
}
