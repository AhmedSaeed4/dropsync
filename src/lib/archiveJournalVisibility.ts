'use client';

import { collection, doc, getDocFromServer, getDocsFromServer, onSnapshot, query, where } from 'firebase/firestore';
import { db } from './firebase';

type StatusEntry = { success: boolean; listeners: Set<() => void>; release: () => void; refs: number };
const statuses = new Map<string, StatusEntry>();
const successCache = new Set<string>();
const markerEvent = 'dropsync-archive-journal-transition';

function statusKey(ownerId: string, jobId: string): string {
  return ownerId + '_' + jobId;
}

function isVerifiedSuccess(data: Record<string, unknown> | undefined, ownerId: string, jobId: string): boolean {
  return data?.userId === ownerId && data?.jobId === jobId && data?.state === 'closed-success';
}

// A terminal success is monotone. Open, missing, malformed, and permission errors all
// remain staged, including while an exact server read is pending.
export function isArchiveRecordStaged(ownerId?: string, jobId?: string): boolean {
  if (!ownerId || !jobId) return !!jobId;
  const key = statusKey(ownerId, jobId);
  return !successCache.has(key) && !statuses.get(key)?.success;
}

export async function resolveArchiveRecordStaged(ownerId?: string, jobId?: string): Promise<boolean> {
  if (!jobId) return false;
  if (!ownerId) return true;
  const key = statusKey(ownerId, jobId);
  if (successCache.has(key)) return false;
  try {
    const snapshot = await getDocFromServer(doc(db, 'importFences', key));
    const success = snapshot.exists() && isVerifiedSuccess(snapshot.data(), ownerId, jobId);
    if (success) {
      successCache.add(key);
      const entry = statuses.get(key);
      if (entry && !entry.success) {
        entry.success = true;
        entry.listeners.forEach((listener) => listener());
      }
    }
    return !success;
  } catch {
    return true;
  }
}

export async function assertArchiveRecordWritable(ownerId?: string, jobId?: string): Promise<void> {
  if (await resolveArchiveRecordStaged(ownerId, jobId)) throw new Error('This item is still importing.');
}

export async function assertImportWorkspaceWritable(ownerId?: string, jobId?: string): Promise<void> {
  if (await resolveArchiveRecordStaged(ownerId, jobId)) throw new Error('This workspace is still importing.');
}

export async function assertWorkspaceWritableById(workspaceId: string | null | undefined): Promise<void> {
  if (!workspaceId) return;
  const workspace = await getDocFromServer(doc(db, 'workspaces', workspaceId));
  if (!workspace.exists()) throw new Error('The workspace is no longer available.');
  const data = workspace.data();
  if (typeof data.importJobId === 'string') await assertImportWorkspaceWritable(data.ownerId, data.importJobId);
}

export async function assertDropWritableById(dropId: string): Promise<void> {
  const snapshot = await getDocFromServer(doc(db, 'drops', dropId));
  if (!snapshot.exists()) throw new Error('The item is no longer available.');
  const data = snapshot.data();
  if (typeof data.importJobId === 'string') await assertArchiveRecordWritable(data.userId, data.importJobId);
  await assertWorkspaceWritableById(data.workspaceId);
}

// Bulk pre-check for move/copy: one concurrent pass over the drop docs, then ONE pass over
// each DISTINCT workspace and fence — never per-item sequential round-trips.
export async function assertDropsWritableBatch(dropIds: string[]): Promise<void> {
  const ids = Array.from(new Set(dropIds));
  const snapshots = await Promise.all(ids.map((id) => getDocFromServer(doc(db, 'drops', id))));
  const workspaceIds = new Set<string | null | undefined>();
  const fencePairs = new Map<string, { ownerId: string | undefined; jobId: string }>();
  for (const snapshot of snapshots) {
    if (!snapshot.exists()) throw new Error('The item is no longer available.');
    const data = snapshot.data();
    workspaceIds.add(data.workspaceId);
    if (typeof data.importJobId === 'string') {
      const ownerId = typeof data.userId === 'string' ? data.userId : undefined;
      fencePairs.set(ownerId + '_' + data.importJobId, { ownerId, jobId: data.importJobId });
    }
  }
  await Promise.all([
    ...Array.from(workspaceIds).map((workspaceId) => assertWorkspaceWritableById(workspaceId)),
    ...Array.from(fencePairs.values()).map((pair) => assertArchiveRecordWritable(pair.ownerId, pair.jobId)),
  ]);
}

export async function assertCategoryWritableById(categoryId: string): Promise<void> {
  const snapshot = await getDocFromServer(doc(db, 'categories', categoryId));
  if (!snapshot.exists()) throw new Error('The category is no longer available.');
  const data = snapshot.data();
  if (typeof data.importJobId === 'string') await assertArchiveRecordWritable(data.createdBy, data.importJobId);
  await assertWorkspaceWritableById(data.workspaceId);
}

export async function assertCategoryNamesWritable(names: string[], workspaceId: string | null, userId: string): Promise<void> {
  const wanted = names.filter((name) => name && name !== 'password' && name !== 'link');
  if (wanted.length === 0) return;
  const scope = workspaceId
    ? query(collection(db, 'categories'), where('workspaceId', '==', workspaceId))
    : query(collection(db, 'categories'), where('workspaceId', '==', null), where('createdBy', '==', userId));
  const snapshot = await getDocsFromServer(scope);
  for (const name of wanted) {
    const matches = snapshot.docs.filter((item) => item.get('name') === name);
    if (matches.length === 0) throw new Error(`The category "${name}" is no longer available.`);
    let writable = false;
    for (const item of matches) {
      const jobId = item.get('importJobId');
      if (typeof jobId !== 'string' || !(await resolveArchiveRecordStaged(item.get('createdBy'), jobId))) writable = true;
    }
    if (!writable) throw new Error('This category is still importing.');
  }
}

export function subscribeArchiveStatus(ownerId: string, jobId: string, listener: () => void): () => void {
  const key = statusKey(ownerId, jobId);
  if (successCache.has(key)) return () => {};
  let entry = statuses.get(key);
  if (!entry) {
    entry = { success: false, listeners: new Set(), release: () => {}, refs: 0 };
    statuses.set(key, entry);
    const liveEntry = entry;
    entry.release = onSnapshot(doc(db, 'importFences', key), (snapshot) => {
      if (!snapshot.exists()) return;
      if (isVerifiedSuccess(snapshot.data(), ownerId, jobId)) {
        successCache.add(key);
        liveEntry.success = true;
        liveEntry.listeners.forEach((callback) => callback());
      }
    }, () => {
      // Permission errors fail closed. The record stays visible and read-only.
    });
  }
  entry.refs++;
  entry.listeners.add(listener);
  return () => {
    const current = statuses.get(key);
    if (!current) return;
    current.listeners.delete(listener);
    current.refs--;
    if (current.refs <= 0) {
      current.release();
      statuses.delete(key);
    }
  };
}

export function announceArchiveJournalTransition(jobId: string): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(markerEvent, { detail: jobId }));
}

export function subscribeArchiveJournalTransitions(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener(markerEvent, listener);
  window.addEventListener('storage', listener);
  return () => {
    window.removeEventListener(markerEvent, listener);
    window.removeEventListener('storage', listener);
  };
}

export function createArchiveStatusTracker(onChange: () => void): {
  update: (pairs: Array<{ ownerId: string; jobId: string }>) => void;
  close: () => void;
} {
  const active = new Map<string, () => void>();
  const close = () => { active.forEach((release) => release()); active.clear(); };
  return {
    update(pairs) {
      const wanted = new Map(pairs.filter((pair) => pair.ownerId && pair.jobId)
        .map((pair) => [statusKey(pair.ownerId, pair.jobId), pair]));
      for (const [key, release] of active) {
        if (!wanted.has(key)) { release(); active.delete(key); }
      }
      for (const [key, pair] of wanted) {
        if (!active.has(key)) active.set(key, subscribeArchiveStatus(pair.ownerId, pair.jobId, onChange));
      }
    },
    close,
  };
}
