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
  type YouTubeLabelingResult,
} from './youtubeLabels';

const CHECKPOINT_PREFIX = 'dropsync_youtube_backfill_checkpoint_';
const MAX_DROP_RECORDS_PER_RUN = 500;
const MAX_VIDEO_IDS_PER_RUN = 1000;
// Sustained-outage circuit breaker: after this many CONSECUTIVE drops strike
// out, hard-pause and hand control back to the human instead of grinding
// through the whole account unattended.
const MAX_CONSECUTIVE_STRIKE_SKIPS = 8;

export interface YoutubeBackfillProgress {
  phase: 'reading' | 'labeling' | 'waiting' | 'paused' | 'complete';
  scopeName: string;
  scopeIndex: number;
  totalScopes: number;
  scanned: number;
  processed: number;
  labeled: number;
  skipped: number;
  unresolved: number;
  errors: number;
  // Present only while phase is 'waiting': the visible auto-retry countdown
  // and which attempt comes next (a drop gets 3 attempts total).
  waitSecondsRemaining?: number;
  retryAttempt?: number;
  strikeSkipped?: number;
}

export interface YoutubeBackfillResult {
  completed: boolean;
  processed: number;
  labeled: number;
  skipped: number;
  unresolved: number;
  errors: number;
  // Drops given up on after three incomplete attempts. The run still counts
  // as complete; the modal reports the count in the completion message.
  strikeSkipped?: number;
}

interface BackfillCheckpoint {
  version: 1;
  userId: string;
  scopeIds: string[];
  scopeIndex: number;
  completedDropIds: string[];
  cursorByScope: Record<string, string | null>;
  // Consecutive incomplete attempts per drop for ANY reason (slow/unreachable
  // title service, cancelled fetch, throttling, rejected label write). After 3
  // the drop is skipped so the run always converges. labelWriteAttempts is the
  // legacy write-only counter from older checkpoints; counts are migrated.
  labelIncompleteAttempts: Record<string, number>;
  labelWriteAttempts?: Record<string, number>;
  // Cumulative drops skipped by three-strikes, kept across resumes so the
  // completion message stays accurate. Migrated to 0 for older checkpoints.
  strikeSkipped: number;
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

// Wait duration before an auto-retry: the server's throttle hint when it sent
// one (429 Retry-After), otherwise a fixed minute. Clamped to keep a bogus
// hint from stalling the run.
function clampRetrySeconds(retryAfterSeconds?: number | null): number {
  const value = typeof retryAfterSeconds === 'number' && Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
    ? retryAfterSeconds
    : 60;
  return Math.min(300, Math.max(1, Math.round(value)));
}

// Countdown for the auto-retry wait. Resolves 'elapsed' when the wait finishes,
// 'skipped' when the user presses Retry now, 'aborted' when the run is stopped.
// Ticks once per second via onTick; the deadline is computed up front so
// background-tab timer throttling cannot silently stretch the wait.
function waitForRetry(
  seconds: number,
  signal: AbortSignal | undefined,
  skipWaitSignal: AbortSignal | undefined,
  onTick: (secondsRemaining: number) => void,
): Promise<'elapsed' | 'skipped' | 'aborted'> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve('aborted');
      return;
    }
    if (skipWaitSignal?.aborted) {
      resolve('skipped');
      return;
    }
    const deadline = Date.now() + seconds * 1000;
    // The interval callback and the abort listeners below can only fire after
    // this synchronous setup finishes, so they always see an assigned timer.
    const timer = window.setInterval(() => {
      const secondsLeft = Math.ceil((deadline - Date.now()) / 1000);
      if (secondsLeft <= 0) {
        finish('elapsed');
        return;
      }
      onTick(secondsLeft);
    }, 1000);
    const finish = (outcome: 'elapsed' | 'skipped' | 'aborted') => {
      window.clearInterval(timer);
      signal?.removeEventListener('abort', onAbort);
      skipWaitSignal?.removeEventListener('abort', onSkip);
      resolve(outcome);
    };
    const onAbort = () => finish('aborted');
    const onSkip = () => finish('skipped');
    signal?.addEventListener('abort', onAbort, { once: true });
    skipWaitSignal?.addEventListener('abort', onSkip, { once: true });
  });
}

export async function runYoutubeBackfill(options: {
  userId: string;
  workspaces: Workspace[];
  signal?: AbortSignal;
  skipWaitSignal?: AbortSignal;
  onProgress?: (progress: YoutubeBackfillProgress) => void;
}): Promise<YoutubeBackfillResult> {
  const { userId, signal, skipWaitSignal, onProgress } = options;
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
        labelIncompleteAttempts: {},
        strikeSkipped: 0,
        processed: 0,
        labeled: 0,
        skipped: 0,
        unresolved: 0,
        errors: 0,
      };
  checkpoint.cursorByScope = checkpoint.cursorByScope || {};
  checkpoint.labelIncompleteAttempts = checkpoint.labelIncompleteAttempts || checkpoint.labelWriteAttempts || {};
  checkpoint.strikeSkipped = checkpoint.strikeSkipped || 0;
  const completedDropIds = new Set(checkpoint.completedDropIds);
  // A retry starts a fresh error/unresolved accounting window. Drops that were
  // not completed remain outside completedDropIds and are retried explicitly.
  checkpoint.unresolved = 0;
  checkpoint.errors = 0;
  let newProcessed = 0;
  let videoIdsConsidered = 0;
  let consecutiveStrikes = 0;

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

      let result: YouTubeLabelingResult;
      let outcome: 'done' | 'struck' | 'aborted' = 'done';
      let dropUnresolvedAdded = 0;
      for (;;) {
        result = await labelDropBestEffort({
          userId,
          dropId: document.id,
          source,
          guard,
          existingLabels: data.youtubeVideoLabels,
          signal,
        });
        if (result.status !== 'incomplete') break;

        const attempts = (checkpoint.labelIncompleteAttempts[document.id] || 0) + 1;
        checkpoint.labelIncompleteAttempts[document.id] = attempts;
        if (attempts >= 3) {
          // Three strikes: a drop that stays incomplete for ANY reason (slow
          // or unreachable title service, cancelled fetch, throttling, a
          // rejected label write) must not trap the cursor forever. Skip only
          // this new metadata operation; the original drop remains untouched.
          completedDropIds.add(document.id);
          checkpoint.cursorByScope[scope.id] = document.id;
          delete checkpoint.labelIncompleteAttempts[document.id];
          checkpoint.processed += 1;
          checkpoint.skipped += 1;
          checkpoint.strikeSkipped += 1;
          // Reverse this drop's waiting-stat contributions: a struck drop must
          // not leave residue in the unresolved counter.
          checkpoint.unresolved -= dropUnresolvedAdded;
          newProcessed += 1;
          checkpoint.completedDropIds = [...completedDropIds];
          writeCheckpoint(checkpoint);
          consecutiveStrikes += 1;
          outcome = 'struck';
          break;
        }

        // Persist BEFORE the wait so a tab closed mid-countdown leaves exactly
        // the checkpoint today's pause leaves: cursor on the previous document
        // and the strike count recorded. Track the contribution so it can be
        // reversed when the drop later resolves or strikes out.
        const contribution = Math.max(1, result.unresolved);
        checkpoint.scopeIndex = scopeIndex;
        checkpoint.unresolved += contribution;
        dropUnresolvedAdded += contribution;
        writeCheckpoint(checkpoint);

        const waitSeconds = clampRetrySeconds(result.retryAfterSeconds);
        const waitingProgress: YoutubeBackfillProgress = {
          phase: 'waiting',
          scopeName: scope.name,
          scopeIndex,
          totalScopes: scopes.length,
          scanned,
          processed: checkpoint.processed,
          labeled: checkpoint.labeled,
          skipped: checkpoint.skipped,
          unresolved: checkpoint.unresolved,
          errors: checkpoint.errors,
          waitSecondsRemaining: waitSeconds,
          retryAttempt: attempts,
          strikeSkipped: checkpoint.strikeSkipped,
        };
        emit(onProgress, waitingProgress);
        const waited = await waitForRetry(waitSeconds, signal, skipWaitSignal, (secondsLeft) => {
          emit(onProgress, { ...waitingProgress, unresolved: checkpoint.unresolved, waitSecondsRemaining: secondsLeft });
        });
        if (waited === 'aborted') {
          outcome = 'aborted';
          break;
        }
      }

      if (outcome === 'struck') {
        if (consecutiveStrikes >= MAX_CONSECUTIVE_STRIKE_SKIPS) {
          // Sustained outage: every recent drop struck out, so stop and let a
          // human decide instead of grinding through the rest unattended.
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
            strikeSkipped: checkpoint.strikeSkipped,
          });
          return { completed: false, processed: checkpoint.processed, labeled: checkpoint.labeled, skipped: checkpoint.skipped, unresolved: checkpoint.unresolved, errors: checkpoint.errors };
        }
        if (result.helperRequested) await sleep(5000);
        continue;
      }
      if (outcome === 'aborted') {
        // Stop pressed during the countdown: today's exact pause semantics —
        // cursor stays on the previous document, the elevated unresolved count
        // is part of the saved state, and Resume replays this drop with its
        // strike count intact.
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
          strikeSkipped: checkpoint.strikeSkipped,
        });
        return { completed: false, processed: checkpoint.processed, labeled: checkpoint.labeled, skipped: checkpoint.skipped, unresolved: checkpoint.unresolved, errors: checkpoint.errors };
      }
      checkpoint.unresolved -= dropUnresolvedAdded;
      consecutiveStrikes = 0;

      delete checkpoint.labelIncompleteAttempts[document.id];
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

  // Every drop in every scope has now finished: resolved, not-applicable, or
  // skipped by three-strikes. Transient incompletes reverse their unresolved
  // contributions on resolution, so nothing residual blocks completion and
  // strike-skipped drops do not re-show the backfill button.
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
    strikeSkipped: checkpoint.strikeSkipped,
  });
  return { completed: true, processed: checkpoint.processed, labeled: checkpoint.labeled, skipped: checkpoint.skipped, unresolved: checkpoint.unresolved, errors: checkpoint.errors, strikeSkipped: checkpoint.strikeSkipped };
}
