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
import { ZipWriterStream, type FileEntry } from '@zip.js/zip.js';
import { auth, db } from './firebase';
import { decryptData, encryptData } from './crypto';
import {
  ARCHIVE_CHUNK_SIZE,
  ARCHIVE_ENVELOPE_VERSION,
  ARCHIVE_EXTENSION,
  ARCHIVE_KDF_ITERATIONS,
  ARCHIVE_MAX_DROP_FILE_BYTES,
  ARCHIVE_MAX_ENTRIES,
  ARCHIVE_MAX_MANIFEST_BYTES,
  ARCHIVE_MAX_UNCOMPRESSED_BYTES,
  ARCHIVE_MIME,
  ArchiveCancelledError,
  ArchiveExpiredDropError,
  ArchiveValidationError,
  archiveTypeMismatchMessage,
  type ArchiveProgress,
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
  fetchText,
  getFileEntry,
  isExpired,
  isSafeZipPath,
  isoDate,
  loadArchive as loadArchiveFormat,
  makeHeader,
  parseDate,
  prependStream,
  readEncryptedDataUri,
  readEntryBytes,
  remapDropReferences,
  throwIfAborted,
} from './archiveFormat';
import {
  createWorkspaceKey,
  getWorkspaceKey,
  hasWorkspaceKey,
} from './keys';
import {
  deleteFromR2,
  uploadBinaryFileToR2,
  uploadToR2,
} from './drops';
import { deleteWorkspace } from './workspaces';
import { Drop, Workspace, Category, ExpirationOption } from '@/types';
import type { MemberInfo } from './workspaces';

// Keep the shipped workspace constants as public aliases. The underlying envelope/ZIP values are
// shared with personal archives, but the workspace schema and public API remain unchanged.
export const WORKSPACE_ARCHIVE_VERSION = ARCHIVE_ENVELOPE_VERSION;
export const WORKSPACE_ARCHIVE_EXTENSION = ARCHIVE_EXTENSION;
export const WORKSPACE_ARCHIVE_MIME = ARCHIVE_MIME;
export const WORKSPACE_ARCHIVE_MAX_MANIFEST_BYTES = ARCHIVE_MAX_MANIFEST_BYTES;
export const WORKSPACE_ARCHIVE_MAX_ENTRIES = ARCHIVE_MAX_ENTRIES;
export const WORKSPACE_ARCHIVE_MAX_UNCOMPRESSED_BYTES = ARCHIVE_MAX_UNCOMPRESSED_BYTES;
export const WORKSPACE_ARCHIVE_CHUNK_SIZE = ARCHIVE_CHUNK_SIZE;
export const WORKSPACE_ARCHIVE_KDF_ITERATIONS = ARCHIVE_KDF_ITERATIONS;

const MAX_WORKSPACE_NAME_LENGTH = 120;
const IMPORT_JOURNAL_KEY = 'dropsync_archive_import_journal';

interface ImportJournal {
  userId: string;
  workspaceId: string;
  createdWorkspace: boolean;
  createdDropIds: string[];
  createdR2Keys: string[];
  createdCategoryIds: string[];
}

export type ArchiveProgressPhase = ArchiveProgress['phase'];
export type WorkspaceArchiveProgress = ArchiveProgress;

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

async function readImageBytes(drop: Drop, key: CryptoKey, signal?: AbortSignal): Promise<Uint8Array> {
  if (drop.imageData) return dataUriToBytes(drop.imageData);
  if (!drop.imageUrl) throw new Error(`Drawing/image payload is missing for "${drop.name}".`);
  const encrypted = await fetchText(drop.imageUrl, signal);
  if (drop.imageIv) {
    return dataUriToBytes(await decryptData(encrypted, key, drop.imageIv));
  }
  return dataUriToBytes(encrypted);
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

function validateManifest(manifest: WorkspaceArchiveManifest): void {
  try {
    validateManifestBody(manifest);
  } catch (error) {
    if (error instanceof ArchiveValidationError) throw error;
    throw new ArchiveValidationError(error instanceof Error ? error.message : 'The archive manifest is invalid or unsupported.');
  }
}

function validateManifestBody(manifest: WorkspaceArchiveManifest): void {
  const typeMismatch = archiveTypeMismatchMessage(manifest?.schema, 'workspace');
  if (typeMismatch) throw new ArchiveValidationError(typeMismatch);
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
    if (drop.fileSize != null && (!Number.isSafeInteger(drop.fileSize) || drop.fileSize < 0 || drop.fileSize > ARCHIVE_MAX_DROP_FILE_BYTES)) {
      throw new Error(`The file size is invalid or exceeds the 500 MB limit for "${drop.name}".`);
    }
    if (drop.imageSize != null && (!Number.isSafeInteger(drop.imageSize) || drop.imageSize < 0 || drop.imageSize > ARCHIVE_MAX_DROP_FILE_BYTES)) {
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

async function loadArchive(file: File, password: string, signal?: AbortSignal) {
  return loadArchiveFormat<WorkspaceArchiveManifest>(file, password, signal, (manifest) => {
    validateManifest(manifest as WorkspaceArchiveManifest);
  });
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
    if ((drop.fileSize != null && drop.fileSize > ARCHIVE_MAX_DROP_FILE_BYTES) || (drop.imageSize != null && drop.imageSize > ARCHIVE_MAX_DROP_FILE_BYTES)) {
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