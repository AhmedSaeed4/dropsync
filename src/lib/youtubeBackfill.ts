'use client';

import {
  collection,
  documentId,
  getDocs,
  limit,
  orderBy,
  query,
  startAfter,
  where,
  type DocumentData,
  type QueryConstraint,
} from 'firebase/firestore';
import { db } from './firebase';
import { decryptDrop } from './drops';
import type { Drop, Workspace } from '@/types';
import {
  createYouTubeLabelGuard,
  extractYouTubeVideoIds,
  labelDropBestEffort,
  markYoutubeBackfillComplete,
  normalizeYoutubeLabels,
  sourceFromDrop,
} from './youtubeLabels';

const CHECKPOINT_PREFIX = 'dropsync_youtube_backfill_checkpoint_';
const MAX_DROP_RECORDS_PER_RUN = 500;
const MAX_VIDEO_IDS_PER_RUN = 1000;

export interface YoutubeBackfillProgress {
  phase: 'reading' | 'labeling' | 'paused' | 'complete';
  scopeName: string;
  scopeIndex: number;
  totalScopes: number;
  scanned: number;
  processed: number;
  labeled: number;
  skipped: number;
  unresolved: number;
  errors: number;
}

export interface YoutubeBackfillResult {
  completed: boolean;
  processed: number;
  labeled: number;
  skipped: number;
  unresolved: number;
  errors: number;
}

interface BackfillCheckpoint {
  version: 1;
  userId: string;
  scopeIds: string[];
  scopeIndex: number;
  completedDropIds: string[];
  cursorByScope: Record<string, string | null>;
  labelWriteAttempts: Record<string, number>;
  processed: number;
  labeled: number;
  skipped: number;
  unresolved: number;
  errors: number;
}

interface Scope {
  id: string;
  name: string;
  workspaceId: string | null;
}

function checkpointKey(userId: string): string {
  return `${CHECKPOINT_PREFIX}${userId}`;
}

function readCheckpoint(userId: string): BackfillCheckpoint | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(checkpointKey(userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as BackfillCheckpoint;
    if (parsed.version !== 1 || parsed.userId !== userId || !Array.isArray(parsed.scopeIds)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeCheckpoint(checkpoint: BackfillCheckpoint): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(checkpointKey(checkpoint.userId), JSON.stringify(checkpoint));
  } catch {
    // The run remains safe without crash recovery; the modal reports its result.
  }
}

function clearCheckpoint(userId: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(checkpointKey(userId));
  } catch {
    // Best effort.
  }
}

function categoriesFromData(data: DocumentData): string[] {
  const values = Array.isArray(data.categories) ? data.categories : [];
  const legacy = typeof data.category === 'string' ? [data.category] : [];
  return [...values, ...legacy]
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim())
    .filter(Boolean)
    .filter((value, index, all) => all.findIndex((item) => item.toLowerCase() === value.toLowerCase()) === index);
}

function rawTextDrop(dropId: string, data: DocumentData): Drop {
  return {
    id: dropId,
    userId: typeof data.userId === 'string' ? data.userId : '',
    type: data.type === 'text' ? 'text' : 'file',
    name: typeof data.name === 'string' ? data.name : 'untitled',
    content: typeof data.content === 'string' ? data.content : undefined,
    createdAt: data.createdAt?.toDate?.() || new Date(),
    expiresAt: data.expiresAt?.toDate?.() || null,
    expirationOption: typeof data.expirationOption === 'string'
      ? data.expirationOption as Drop['expirationOption']
      : undefined,
    workspaceId: data.workspaceId || null,
    encrypted: data.encrypted === true,
    iv: typeof data.iv === 'string' ? data.iv : undefined,
    encryptedDEK: typeof data.encryptedDEK === 'string' ? data.encryptedDEK : undefined,
    encryptedDEKs: data.encryptedDEKs as Drop['encryptedDEKs'] | undefined,
    category: typeof data.category === 'string' ? data.category : undefined,
    categories: categoriesFromData(data),
    isDrawing: data.isDrawing === true,
    locked: data.locked === true,
    youtubeVideoLabels: normalizeYoutubeLabels(data.youtubeVideoLabels),
  };
}

function makeScopes(userId: string, workspaces: Workspace[]): Scope[] {
  const result: Scope[] = [{ id: '__personal__', name: 'Personal drops', workspaceId: null }];
  const seen = new Set<string>();
  for (const workspace of workspaces) {
    if (!workspace?.id || seen.has(workspace.id)) continue;
    seen.add(workspace.id);
    if (!workspace.members?.includes(userId) && workspace.ownerId !== userId) continue;
    result.push({ id: workspace.id, name: workspace.name || workspace.id, workspaceId: workspace.id });
  }
  return result;
}

function emit(
  onProgress: ((progress: YoutubeBackfillProgress) => void) | undefined,
  progress: YoutubeBackfillProgress,
): void {
  onProgress?.(progress);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runYoutubeBackfill(options: {
  userId: string;
  workspaces: Workspace[];
  signal?: AbortSignal;
  onProgress?: (progress: YoutubeBackfillProgress) => void;
}): Promise<YoutubeBackfillResult> {
  const { userId, signal, onProgress } = options;
  const scopes = makeScopes(userId, options.workspaces);
  const scopeIds = scopes.map((scope) => scope.id);
  const previous = readCheckpoint(userId);
  const checkpoint: BackfillCheckpoint = previous && previous.scopeIds.join('|') === scopeIds.join('|')
    ? previous
    : {
        version: 1,
        userId,
        scopeIds,
        scopeIndex: 0,
        completedDropIds: [],
        cursorByScope: {},
        labelWriteAttempts: {},
        processed: 0,
        labeled: 0,
        skipped: 0,
        unresolved: 0,
        errors: 0,
      };
  checkpoint.cursorByScope = checkpoint.cursorByScope || {};
  checkpoint.labelWriteAttempts = checkpoint.labelWriteAttempts || {};
  const completedDropIds = new Set(checkpoint.completedDropIds);
  // A retry starts a fresh error/unresolved accounting window. Drops that were
  // not completed remain outside completedDropIds and are retried explicitly.
  checkpoint.unresolved = 0;
  checkpoint.errors = 0;
  let newProcessed = 0;
  let videoIdsConsidered = 0;

  for (let scopeIndex = checkpoint.scopeIndex; scopeIndex < scopes.length; scopeIndex += 1) {
    const scope = scopes[scopeIndex];
    if (signal?.aborted) {
      checkpoint.scopeIndex = scopeIndex;
      checkpoint.completedDropIds = [...completedDropIds];
      writeCheckpoint(checkpoint);
      return { completed: false, processed: checkpoint.processed, labeled: checkpoint.labeled, skipped: checkpoint.skipped, unresolved: checkpoint.unresolved, errors: checkpoint.errors };
    }

    emit(onProgress, {
      phase: 'reading',
      scopeName: scope.name,
      scopeIndex,
      totalScopes: scopes.length,
      scanned: 0,
      processed: checkpoint.processed,
      labeled: checkpoint.labeled,
      skipped: checkpoint.skipped,
      unresolved: checkpoint.unresolved,
      errors: checkpoint.errors,
    });

    let snapshot;
    const remainingRecords = Math.max(1, MAX_DROP_RECORDS_PER_RUN - newProcessed);
    const cursor = checkpoint.cursorByScope[scope.id] || null;
    try {
      const constraints: QueryConstraint[] = scope.workspaceId
        ? [where('workspaceId', '==', scope.workspaceId)]
        : [where('userId', '==', userId), where('workspaceId', '==', null)];
      constraints.push(orderBy(documentId(), 'asc'));
      if (cursor) constraints.push(startAfter(cursor));
      constraints.push(limit(remainingRecords));
      snapshot = await getDocs(query(collection(db, 'drops'), ...constraints));
    } catch {
      checkpoint.scopeIndex = scopeIndex;
      checkpoint.errors += 1;
      writeCheckpoint(checkpoint);
      emit(onProgress, {
        phase: 'paused',
        scopeName: scope.name,
        scopeIndex,
        totalScopes: scopes.length,
        scanned: 0,
        processed: checkpoint.processed,
        labeled: checkpoint.labeled,
        skipped: checkpoint.skipped,
        unresolved: checkpoint.unresolved,
        errors: checkpoint.errors,
      });
      return { completed: false, processed: checkpoint.processed, labeled: checkpoint.labeled, skipped: checkpoint.skipped, unresolved: checkpoint.unresolved, errors: checkpoint.errors };
    }

    let scanned = 0;
    for (const document of snapshot.docs) {
      scanned += 1;
      if (completedDropIds.has(document.id)) {
        checkpoint.cursorByScope[scope.id] = document.id;
        continue;
      }
      if (signal?.aborted || newProcessed >= MAX_DROP_RECORDS_PER_RUN || videoIdsConsidered >= MAX_VIDEO_IDS_PER_RUN) {
        checkpoint.scopeIndex = scopeIndex;
        checkpoint.completedDropIds = [...completedDropIds];
        checkpoint.cursorByScope[scope.id] = checkpoint.cursorByScope[scope.id] || null;
        writeCheckpoint(checkpoint);
        emit(onProgress, {
          phase: 'paused',
          scopeName: scope.name,
          scopeIndex,
          totalScopes: scopes.length,
          scanned,
          processed: checkpoint.processed,
          labeled: checkpoint.labeled,
          skipped: checkpoint.skipped,
          unresolved: checkpoint.unresolved,
          errors: checkpoint.errors,
        });
        return { completed: false, processed: checkpoint.processed, labeled: checkpoint.labeled, skipped: checkpoint.skipped, unresolved: checkpoint.unresolved, errors: checkpoint.errors };
      }

      const data = document.data();
      const categories = categoriesFromData(data);
      const expiresAt = data.expiresAt?.toDate?.() || null;
      const type = data.type;
      if (
        type !== 'text' ||
        data.isDrawing === true ||
        categories.some((category) => category.toLowerCase() === 'password') ||
        (expiresAt && expiresAt.getTime() <= Date.now())
      ) {
        completedDropIds.add(document.id);
        checkpoint.cursorByScope[scope.id] = document.id;
        checkpoint.skipped += 1;
        checkpoint.processed += 1;
        newProcessed += 1;
        continue;
      }

      const rawDrop = rawTextDrop(document.id, data);
      const labelDrop = { ...rawDrop, imageUrl: undefined, imageR2Key: undefined, imageIv: undefined };
      const decrypted = await decryptDrop(labelDrop, userId);
      const content = decrypted.content || '';
      const source = sourceFromDrop({ ...decrypted, name: rawDrop.name, categories }, content);
      const guard = createYouTubeLabelGuard({
        type: 'text',
        name: rawDrop.name,
        categories,
        workspaceId: rawDrop.workspaceId,
        isDrawing: false,
        encrypted: data.encrypted === true,
        content: data.encrypted === true ? undefined : (typeof data.content === 'string' ? data.content : content),
        iv: typeof data.iv === 'string' ? data.iv : undefined,
        encryptedDEK: typeof data.encryptedDEK === 'string' ? data.encryptedDEK : undefined,
      });

      emit(onProgress, {
        phase: 'labeling',
        scopeName: scope.name,
        scopeIndex,
        totalScopes: scopes.length,
        scanned,
        processed: checkpoint.processed,
        labeled: checkpoint.labeled,
        skipped: checkpoint.skipped,
        unresolved: checkpoint.unresolved,
        errors: checkpoint.errors,
      });

      const result = await labelDropBestEffort({
        userId,
        dropId: document.id,
        source,
        guard,
        existingLabels: data.youtubeVideoLabels,
        signal,
      });
      if (result.status === 'incomplete') {
        if (result.writeFailed) {
          const attempts = (checkpoint.labelWriteAttempts[document.id] || 0) + 1;
          checkpoint.labelWriteAttempts[document.id] = attempts;
          if (attempts >= 2) {
            // A locked/unauthorized or otherwise permanently failing label
            // write must not trap the cursor forever. Skip only this new
            // metadata operation; the original drop remains untouched.
            completedDropIds.add(document.id);
            checkpoint.cursorByScope[scope.id] = document.id;
            delete checkpoint.labelWriteAttempts[document.id];
            checkpoint.processed += 1;
            checkpoint.skipped += 1;
            newProcessed += 1;
            checkpoint.completedDropIds = [...completedDropIds];
            writeCheckpoint(checkpoint);
            if (result.helperRequested) await sleep(5000);
            continue;
          }
        }

        // Leave the cursor on the previous document so a retryable helper
        // failure or the first failed write is retried by Resume.
        checkpoint.scopeIndex = scopeIndex;
        checkpoint.unresolved += Math.max(1, result.unresolved);
        writeCheckpoint(checkpoint);
        emit(onProgress, {
          phase: 'paused',
          scopeName: scope.name,
          scopeIndex,
          totalScopes: scopes.length,
          scanned,
          processed: checkpoint.processed,
          labeled: checkpoint.labeled,
          skipped: checkpoint.skipped,
          unresolved: checkpoint.unresolved,
          errors: checkpoint.errors,
        });
        return { completed: false, processed: checkpoint.processed, labeled: checkpoint.labeled, skipped: checkpoint.skipped, unresolved: checkpoint.unresolved, errors: checkpoint.errors };
      }

      delete checkpoint.labelWriteAttempts[document.id];
      const idsInSource = extractYouTubeVideoIds(`${source.name}\n${source.content}`);
      videoIdsConsidered += Math.min(50, idsInSource.length);
      completedDropIds.add(document.id);
      checkpoint.cursorByScope[scope.id] = document.id;
      checkpoint.processed += 1;
      checkpoint.labeled += result.labelsWritten > 0 ? 1 : 0;
      checkpoint.skipped += result.status === 'not-applicable' || result.status === 'skipped' ? 1 : 0;
      newProcessed += 1;
      checkpoint.completedDropIds = [...completedDropIds];
      checkpoint.scopeIndex = scopeIndex;
      writeCheckpoint(checkpoint);
      if (result.helperRequested) await sleep(5000);
    }

    checkpoint.completedDropIds = [...completedDropIds];
    if (snapshot.size === remainingRecords) {
      checkpoint.scopeIndex = scopeIndex;
      writeCheckpoint(checkpoint);
      emit(onProgress, {
        phase: 'paused',
        scopeName: scope.name,
        scopeIndex,
        totalScopes: scopes.length,
        scanned,
        processed: checkpoint.processed,
        labeled: checkpoint.labeled,
        skipped: checkpoint.skipped,
        unresolved: checkpoint.unresolved,
        errors: checkpoint.errors,
      });
      return { completed: false, processed: checkpoint.processed, labeled: checkpoint.labeled, skipped: checkpoint.skipped, unresolved: checkpoint.unresolved, errors: checkpoint.errors };
    }
    checkpoint.scopeIndex = scopeIndex + 1;
    delete checkpoint.cursorByScope[scope.id];
    writeCheckpoint(checkpoint);
  }

  if (checkpoint.unresolved > 0 || checkpoint.errors > 0) {
    return { completed: false, processed: checkpoint.processed, labeled: checkpoint.labeled, skipped: checkpoint.skipped, unresolved: checkpoint.unresolved, errors: checkpoint.errors };
  }

  clearCheckpoint(userId);
  markYoutubeBackfillComplete(userId);
  emit(onProgress, {
    phase: 'complete',
    scopeName: 'Finished',
    scopeIndex: scopes.length,
    totalScopes: scopes.length,
    scanned: 0,
    processed: checkpoint.processed,
    labeled: checkpoint.labeled,
    skipped: checkpoint.skipped,
    unresolved: checkpoint.unresolved,
    errors: checkpoint.errors,
  });
  return { completed: true, processed: checkpoint.processed, labeled: checkpoint.labeled, skipped: checkpoint.skipped, unresolved: checkpoint.unresolved, errors: checkpoint.errors };
}
