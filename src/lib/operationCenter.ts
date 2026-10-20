import { useSyncExternalStore } from 'react';
import { getDocFromServer, doc } from 'firebase/firestore';
import type { DocumentData } from 'firebase/firestore';
import type { Drop } from '@/types';
import { db } from '@/lib/firebase';
import { moveDrop, copyDrop, deleteDrop } from '@/lib/drops';
import { ensureCategoriesForTarget } from '@/lib/categories';
import { isArchiveRecordStaged } from '@/lib/archiveJournalVisibility';
import { isPasswordCategories, normalizeYoutubeLabels } from '@/lib/youtubeLabels';

// The Firestore collection name is not exported by @/lib/drops — declared here to avoid
// touching that file (Order 53 §5 guarantee). Kept in sync by the typecheck: the Drop
// mapping below mirrors createDropListener exactly (src/lib/drops.ts:229-289).
const DROPS_COLLECTION = 'drops';

// App-level center for BULK drop operations (move / copy / delete): owns the card list the
// OperationsPanel renders and runs each operation's items SEQUENTIALLY so the count is
// honest and Cancel can stop what has not started yet. Per-item safety lives in the lib
// functions themselves (moveDrop/copyDrop/deleteDrop) — this module adds no permission
// logic of its own. Single-drop delete-with-undo deliberately does NOT go through here
// (pendingDeletions owns that flow).
//
// Store pattern copied from pendingDeletions.ts: module-singleton state + ONE cached
// snapshot rebuilt only inside notify() (useSyncExternalStore requires a stable reference
// between notifies). Timers are owned here so they are never orphaned by layout switches.

export type OperationKind = 'move' | 'copy' | 'delete';
export type OperationStatus = 'running' | 'succeeded' | 'failed';

export interface OperationFailure {
  drop: Drop;
  error: string;
}

export interface Operation {
  id: string;
  kind: OperationKind;
  targetName: string;
  total: number;
  done: number;
  failed: OperationFailure[];
  status: OperationStatus;
  cancelled: boolean;
  // Success cards only: epoch-ms when the module timer removes the card.
  expiresAt: number | null;
}

export interface StartParams {
  kind: OperationKind;
  drops: Drop[];
  targetWorkspaceId: string | null;
  targetName: string;
  currentUserId: string;
  // Called once when the operation settles (complete, failed, or cancelled). The lists
  // pass their refresh callback here. Captured at start — pass a stable callback.
  onSettled?: () => void;
}

const SUCCESS_HOLD_MS = 5000;

const operations = new Map<string, Operation>();
const paramsById = new Map<string, StartParams>();
const activeDropIds = new Set<string>();
let nextId = 1;

interface Snapshot {
  operations: Operation[];
}
let snapshot: Snapshot = { operations: [] };

function notify() {
  snapshot = { operations: Array.from(operations.values()) };
  listeners.forEach((listener) => listener());
}

const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot() {
  return snapshot;
}

export function useOperations(): Snapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

function removeOperation(id: string) {
  if (!operations.has(id)) return;
  operations.delete(id);
  paramsById.delete(id);
  notify();
}

function settleOperation(operation: Operation, params: StartParams) {
  operation.status = operation.failed.length > 0 ? 'failed' : 'succeeded';
  if (operation.status === 'succeeded') {
    operation.expiresAt = Date.now() + SUCCESS_HOLD_MS;
    const id = operation.id;
    setTimeout(() => removeOperation(id), SUCCESS_HOLD_MS);
  }
  notify();
  params.onSettled?.();
}

async function runOperation(operation: Operation, items: Drop[], params: StartParams) {
  try {
    let catMap: Map<string, string> | undefined;
    if (params.kind !== 'delete') {
      try {
        const allCatNames = Array.from(new Set(
          items.flatMap(d => d.categories || (d.category ? [d.category] : []))
        ));
        if (allCatNames.length > 0) {
          catMap = await ensureCategoriesForTarget(params.targetWorkspaceId, params.currentUserId, allCatNames);
        }
      } catch {
        for (const drop of items) {
          operation.failed.push({ drop, error: 'Could not prepare the categories for the target space.' });
        }
        return;
      }
    }
    for (const drop of items) {
      if (operation.cancelled) break;
      // Freshness (owner decision 2026-10-20): re-read the CURRENT document before the
      // item's turn so mid-transfer edits/renames survive. Missing doc = the drop was
      // deleted while queued → clean item failure. Unreadable = fall back to the
      // start-time snapshot (pre-amendment behavior) rather than failing the item.
      let current = drop;
      try {
        const snap = await getDocFromServer(doc(db, DROPS_COLLECTION, drop.id));
        if (!snap.exists()) {
          operation.failed.push({ drop, error: 'This item is no longer available.' });
          notify();
          continue;
        }
        current = dropFromSnapshot(snap.id, snap.data() as Record<string, unknown>);
      } catch {
        current = drop;
      }
      if (params.kind === 'delete') {
        const ok = await deleteDrop(current);
        if (ok) operation.done++;
        else operation.failed.push({ drop: current, error: 'This item could not be deleted.' });
      } else {
        const result = params.kind === 'move'
          ? await moveDrop(current, params.targetWorkspaceId, params.currentUserId, catMap)
          : await copyDrop(current, params.targetWorkspaceId, params.currentUserId, catMap);
        if (result.success) operation.done++;
        else operation.failed.push({ drop: current, error: result.error || 'The operation failed.' });
      }
      notify();
    }
  } finally {
    for (const drop of items) activeDropIds.delete(drop.id);
    settleOperation(operation, params);
  }
}

/** Mirror of createDropListener's document→Drop mapping (src/lib/drops.ts:229-289), used
 * for the per-item fresh read. Same expressions field-for-field so any field the move/copy
 * path reads is current by construction. */
function dropFromSnapshot(documentId: string, data: DocumentData): Drop {
  return {
    id: documentId,
    userId: data.userId,
    type: data.type,
    name: data.name,
    content: data.content,
    fileData: data.fileData,
    fileUrl: data.fileUrl,
    r2Key: data.r2Key,
    fileSize: data.fileSize,
    mimeType: data.mimeType,
    createdAt: data.createdAt?.toDate() || new Date(),
    expiresAt: data.expiresAt?.toDate() || null,
    expirationOption: data.expirationOption,
    workspaceId: data.workspaceId || null,
    encrypted: data.encrypted,
    iv: data.iv,
    encryptedDEK: data.encryptedDEK,
    encryptedDEKs: data.encryptedDEKs,
    imageUrl: data.imageUrl || undefined,
    imageR2Key: data.imageR2Key || undefined,
    imageSize: data.imageSize || undefined,
    imageMimeType: data.imageMimeType || undefined,
    imageIv: data.imageIv || undefined,
    category: data.category || undefined,
    categories: data.categories || (data.category ? [data.category] : []),
    creatorName: data.creatorName || undefined,
    pinned: data.pinned || false,
    isDrawing: data.isDrawing || false,
    locked: data.locked || false,
    reminderAt: data.reminderAt?.toDate() || null,
    reminderSetByUid: data.reminderSetByUid || null,
    reminderDismissedBy: data.reminderDismissedBy || null,
    fileFormat: data.fileFormat,
    importedFromArchiveId: data.importedFromArchiveId || undefined,
    importJobId: typeof data.importJobId === 'string' ? data.importJobId : undefined,
    isStaged: typeof data.importJobId === 'string' ? isArchiveRecordStaged(data.userId, data.importJobId) : false,
    youtubeVideoLabels: isPasswordCategories([
      ...(Array.isArray(data.categories) ? data.categories : []),
      ...(typeof data.category === 'string' ? [data.category] : []),
    ]) ? [] : normalizeYoutubeLabels(data.youtubeVideoLabels),
    callHostUid: data.callHostUid || undefined,
    callStartedAt: data.callStartedAt?.toDate() || null,
    callParticipantUids: data.callParticipantUids || undefined,
    callState: data.callState || undefined,
    trustedParticipantCount: typeof data.trustedParticipantCount === 'number' ? data.trustedParticipantCount : undefined,
    callLimitDeadlineAt: data.callLimitDeadlineAt?.toDate() || null,
    callEndedAt: data.callEndedAt?.toDate() || null,
    callEndReason: data.callEndReason || undefined,
  };
}

/** Start a bulk operation. Drops already in another running operation are skipped (they
 * cannot be safely re-acted on mid-flight); if nothing remains, returns null and the
 * caller should treat the action as a no-op. */
export function startDropOperation(params: StartParams): { id: string; started: number } | null {
  const items = params.drops.filter(d => !activeDropIds.has(d.id));
  if (items.length === 0) return null;
  const operation: Operation = {
    id: 'op-' + nextId++,
    kind: params.kind,
    targetName: params.targetName,
    total: items.length,
    done: 0,
    failed: [],
    status: 'running',
    cancelled: false,
    expiresAt: null,
  };
  for (const drop of items) activeDropIds.add(drop.id);
  operations.set(operation.id, operation);
  paramsById.set(operation.id, params);
  notify();
  void runOperation(operation, items, params);
  return { id: operation.id, started: items.length };
}

/** Stop what has not started yet; the item in flight finishes. The card stays until the
 * operation settles (then dismisses normally). */
export function cancelOperation(id: string) {
  const operation = operations.get(id);
  if (operation && operation.status === 'running') {
    operation.cancelled = true;
    notify();
  }
}

/** Remove the card now; a running operation is cancelled and settles silently. */
export function dismissOperation(id: string) {
  const operation = operations.get(id);
  if (operation && operation.status === 'running') operation.cancelled = true;
  removeOperation(id);
}

/** Re-run ONLY the failed items of a settled operation as a fresh one. */
export function retryOperation(id: string) {
  const operation = operations.get(id);
  const params = paramsById.get(id);
  if (!operation || !params || operation.status !== 'failed' || operation.failed.length === 0) return;
  const retryParams: StartParams = { ...params, drops: operation.failed.map(f => f.drop) };
  removeOperation(id);
  startDropOperation(retryParams);
}
