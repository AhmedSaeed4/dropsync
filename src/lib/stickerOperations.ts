'use client';

import { useSyncExternalStore } from 'react';

// Parallel notification feed for sticker imports and storage cleanups. This deliberately does
// NOT share state or code with operationCenter.ts: move/copy/delete cards must remain
// byte-untouched. The module-singleton + cached-snapshot + notify pattern mirrors
// operationCenter/pendingDeletions so useSyncExternalStore always receives a stable snapshot
// between notifies.

export type StickerImportStatus = 'running' | 'succeeded' | 'failed';

export interface StickerImportFailure {
  file: File;
  name: string;
  reason: string;
}

export interface StickerImportOperation {
  id: string;
  total: number;
  done: number;
  failed: StickerImportFailure[];
  // 0..1 across the whole batch, including the in-flight file's real upload ratio.
  progress: number;
  status: StickerImportStatus;
  cancelled: boolean;
  // Success cards only: epoch-ms when the module timer removes the card.
  expiresAt: number | null;
}

export type StickerCleanupStatus = 'running' | 'succeeded' | 'failed';

export interface StickerCleanupOperation {
  id: string;
  stickerId: string;
  status: StickerCleanupStatus;
  error: string | null;
  // Success cards only: epoch-ms when the module timer removes the card.
  expiresAt: number | null;
}

export interface StartStickerImportParams {
  total: number;
  // Cancels only files that have not started; the in-flight file is allowed to finish.
  onCancel: () => void;
  // Starts a fresh batch with ONLY the supplied failed files. Return true only when a
  // batch actually started, so a busy hook can leave this failure card intact.
  onRetry: (files: File[]) => boolean;
}

export interface StartStickerCleanupParams {
  stickerId: string;
  // Re-runs the checked delete. Return false only when the owning session is gone.
  onRetry: () => boolean;
  // Stops the hook's auto-retry timer and suppresses re-adoption for this sticker.
  onDismiss: () => void;
}

const SUCCESS_HOLD_MS = 5000;

const operations = new Map<string, StickerImportOperation>();
const paramsById = new Map<string, StartStickerImportParams>();
const cleanups = new Map<string, StickerCleanupOperation>();
const cleanupParams = new Map<string, StartStickerCleanupParams>();
let nextImportId = 1;
let nextCleanupId = 1;

interface Snapshot {
  imports: StickerImportOperation[];
  cleanups: StickerCleanupOperation[];
}

let snapshot: Snapshot = { imports: [], cleanups: [] };
const listeners = new Set<() => void>();

function notify() {
  snapshot = { imports: Array.from(operations.values()), cleanups: Array.from(cleanups.values()) };
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot() {
  return snapshot;
}

export function useStickerImports(): Snapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

function removeStickerImport(id: string) {
  if (!operations.has(id)) return;
  operations.delete(id);
  paramsById.delete(id);
  notify();
}

function removeStickerCleanup(id: string) {
  if (!cleanups.has(id)) return;
  cleanups.delete(id);
  cleanupParams.delete(id);
  notify();
}

export function startStickerImport(params: StartStickerImportParams): string {
  const operation: StickerImportOperation = {
    id: 'sticker-import-' + nextImportId++,
    total: params.total,
    done: 0,
    failed: [],
    progress: 0,
    status: 'running',
    cancelled: false,
    expiresAt: null,
  };
  operations.set(operation.id, operation);
  paramsById.set(operation.id, params);
  notify();
  return operation.id;
}

/** Real combined progress: completed files plus the current file's upload ratio. */
export function updateStickerImportProgress(id: string, ratio: number) {
  const operation = operations.get(id);
  if (!operation || operation.status !== 'running' || operation.total === 0) return;
  const current = Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : 0;
  const next = Math.min(1, (operation.done + operation.failed.length + current) / operation.total);
  if (next <= operation.progress) return;
  operation.progress = next;
  notify();
}

export function stickerImportSucceeded(id: string) {
  const operation = operations.get(id);
  if (!operation || operation.status !== 'running' || operation.total === 0) return;
  operation.done++;
  operation.progress = Math.min(1, (operation.done + operation.failed.length) / operation.total);
  notify();
}

export function stickerImportFailed(id: string, file: File, name: string, reason: string) {
  const operation = operations.get(id);
  if (!operation || operation.status !== 'running') return;
  operation.failed.push({ file, name, reason });
  operation.progress = operation.total === 0
    ? 1
    : Math.min(1, (operation.done + operation.failed.length) / operation.total);
  notify();
}

export function settleStickerImport(id: string) {
  const operation = operations.get(id);
  if (!operation || operation.status !== 'running') return;
  operation.status = operation.failed.length > 0 ? 'failed' : 'succeeded';
  operation.progress = operation.total === 0
    ? 1
    : Math.min(1, (operation.done + operation.failed.length) / operation.total);
  if (operation.status === 'succeeded') {
    operation.expiresAt = Date.now() + SUCCESS_HOLD_MS;
    setTimeout(() => removeStickerImport(id), SUCCESS_HOLD_MS);
  }
  notify();
}

/** Stop files that have not started; the current file settles normally. */
export function cancelStickerImport(id: string) {
  const operation = operations.get(id);
  if (!operation || operation.status !== 'running' || operation.cancelled) return;
  operation.cancelled = true;
  paramsById.get(id)?.onCancel();
  notify();
}

/** Remove the card now. A running batch is cancelled and settles silently. */
export function dismissStickerImport(id: string) {
  const operation = operations.get(id);
  if (operation?.status === 'running') paramsById.get(id)?.onCancel();
  removeStickerImport(id);
}

/** Re-run only the failed files as a fresh batch with fresh ids/cards. */
export function retryStickerImport(id: string) {
  const operation = operations.get(id);
  const params = paramsById.get(id);
  if (!operation || !params || operation.status !== 'failed' || operation.failed.length === 0) return;
  const files = operation.failed.map((failure) => failure.file);
  if (!params.onRetry(files)) return;
  removeStickerImport(id);
}

export function startStickerCleanup(params: StartStickerCleanupParams): string {
  const operation: StickerCleanupOperation = {
    id: 'sticker-cleanup-' + nextCleanupId++,
    stickerId: params.stickerId,
    status: 'running',
    error: null,
    expiresAt: null,
  };
  cleanups.set(operation.id, operation);
  cleanupParams.set(operation.id, params);
  notify();
  return operation.id;
}

/** A tile-triggered retry (or a reused failure card) is attempting again. */
export function markStickerCleanupRunning(id: string) {
  const operation = cleanups.get(id);
  if (!operation || operation.status === 'succeeded' || operation.status === 'running') return;
  operation.status = 'running';
  operation.error = null;
  operation.expiresAt = null;
  notify();
}

/** Still pending after a checked delete; keep the card alive and let the hook re-arm. */
export function markStickerCleanupPending(id: string) {
  const operation = cleanups.get(id);
  if (!operation || operation.status !== 'running') return;
  operation.error = null;
  notify();
}

export function markStickerCleanupFailed(id: string, error: string) {
  const operation = cleanups.get(id);
  if (!operation || operation.status === 'succeeded') return;
  operation.status = 'failed';
  operation.error = error;
  operation.expiresAt = null;
  notify();
}

export function markStickerCleanupSucceeded(id: string) {
  const operation = cleanups.get(id);
  if (!operation || operation.status === 'succeeded') return;
  operation.status = 'succeeded';
  operation.error = null;
  operation.expiresAt = Date.now() + SUCCESS_HOLD_MS;
  setTimeout(() => removeStickerCleanup(id), SUCCESS_HOLD_MS);
  notify();
}

/** Retry works for a failed card and for a pending card whose auto-retry is still waiting. */
export function retryStickerCleanup(id: string): boolean {
  const operation = cleanups.get(id);
  const params = cleanupParams.get(id);
  if (!operation || !params || operation.status === 'succeeded') return false;
  operation.status = 'running';
  operation.error = null;
  notify();
  const started = params.onRetry();
  if (!started && cleanups.get(id) === operation && operation.status === 'running') {
    operation.status = 'failed';
    operation.error = 'Cleanup could not be retried.';
    notify();
  }
  return started;
}

export function dismissStickerCleanup(id: string) {
  if (!cleanups.has(id)) return;
  cleanupParams.get(id)?.onDismiss();
  removeStickerCleanup(id);
}

/** Clear both feeds when their owning sticker session goes away. */
export function clearStickerOperations() {
  if (operations.size === 0 && cleanups.size === 0) return;
  for (const operation of operations.values()) {
    if (operation.status === 'running') paramsById.get(operation.id)?.onCancel();
  }
  for (const operation of cleanups.values()) cleanupParams.get(operation.id)?.onDismiss();
  operations.clear();
  paramsById.clear();
  cleanups.clear();
  cleanupParams.clear();
  notify();
}
