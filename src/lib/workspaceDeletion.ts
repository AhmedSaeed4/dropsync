'use client';

// ROUND 12 — the background workspace deletion runner (client-side; NO server loop).
// One module-level coordinator per workspace (D-e: a second device may run concurrently —
// every stage is an idempotent authoritative requery, and progress writes are transactional
// max-merges). Stage order: STATUS → calls (force-end + attempt resolution) → drops (R2,
// shares per-item ack, doc) → messages → categories → key (checked) → notices PREPARE → SEAL.
// Any stage failure PAUSES the job (the switcher row shows a persistent Retry); the loop
// resumes on app open (resumeDeletionJobs) or on the row-level retry.

import { getAuth } from 'firebase/auth';
import { type ArchiveOwnerContext, createArchiveOwnerContext, archiveOwnerToken, awaitArchiveOwner } from './importFenceClient';
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  limit,
  onSnapshot,
  query,
  runTransaction,
  where,
} from 'firebase/firestore';
import { db } from './firebase';
import { deleteSharesForDropChecked } from './shares';
import { cleanupWorkspaceStickers } from './stickers';

const DELETION_PAGE_SIZE = 20;
const MESSAGE_PAGE_SIZE = 100;
const PROGRESS_EVERY = 5;

type BeginResult =
  | { ok: true; status: 'started' | 'already-deleting' }
  | { ok: false; status: 'confirmation-required' | 'error'; error?: string };

async function authFetch(path: string, init: RequestInit | undefined, owner: ArchiveOwnerContext): Promise<Response> {
  const token = await archiveOwnerToken(owner);
  return awaitArchiveOwner(owner, () => fetch(path, {
    ...init,
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  }));
}

// ---- START (part A/F): the modal calls this. 'confirmation-required' = a call exists and
// the owner has not acknowledged the force-end (D-m) — the modal asks, then re-calls with
// forceEndAck: true.
export async function startWorkspaceDeletion(
  workspaceId: string,
  opts?: { forceEndAck?: boolean },
  context?: ArchiveOwnerContext,
): Promise<BeginResult> {
  try {
    const owner = context ?? createArchiveOwnerContext(getAuth().currentUser?.uid ?? '');
    const res = await awaitArchiveOwner(owner, async () => (authFetch('/api/workspaces/delete-begin', {
      method: 'POST',
      body: JSON.stringify({ workspaceId, forceEndAck: opts?.forceEndAck === true }),
    }, owner)));
    const json = (await awaitArchiveOwner(owner, async () => (res.json().catch(() => ({}))))) as { status?: string; error?: string };
    if (res.ok && json.status === 'started') return { ok: true, status: 'started' };
    if (res.ok && json.status === 'already-deleting') return { ok: true, status: 'already-deleting' };
    if (json.status === 'confirmation-required') {
      return { ok: false, status: 'confirmation-required' };
    }
    return { ok: false, status: 'error', error: json.error ?? 'Failed to begin deletion' };
  } catch (e) {
    console.error('startWorkspaceDeletion failed:', e);
    return { ok: false, status: 'error', error: 'Failed to begin deletion' };
  }
}

// ---- Coordinator + pause markers ----
const runningJobs = new Map<string, { promise: Promise<void>; owner: ArchiveOwnerContext }>();
const pausedJobs = new Set<string>();
type PauseListener = (workspaceId: string) => void;
const pauseListeners = new Set<PauseListener>();

export function onDeletionPaused(listener: PauseListener): () => void {
  pauseListeners.add(listener);
  return () => pauseListeners.delete(listener);
}

export function isDeletionPaused(workspaceId: string): boolean {
  return pausedJobs.has(workspaceId);
}

function markPaused(workspaceId: string): void {
  pausedJobs.add(workspaceId);
  pauseListeners.forEach((l) => l(workspaceId));
}

export function retryPausedDeletion(workspaceId: string): void {
  pausedJobs.delete(workspaceId);
  void runDeletionJob(workspaceId);
}

// ---- Resume on app open (part E): every workspace this user owns that carries a live job.
export function resumeDeletionJobs(
  workspaces: { id: string; deleting?: boolean; deletingOwner?: string }[],
  userId: string,
): void {
  for (const w of workspaces) {
    if (w.deleting === true && w.deletingOwner === userId) {
      void runDeletionJob(w.id);
    }
  }
}

async function requireDeletingOwner(workspaceId: string, owner: ArchiveOwnerContext): Promise<string | null> {
  const user = getAuth().currentUser;
  if (!user) return null;
  const snap = await awaitArchiveOwner(owner, async () => (getDoc(doc(db, 'workspaces', workspaceId))));
  if (!snap.exists()) return null;
  const data = snap.data() ?? {};
  if (data.deleting !== true || data.deletingOwner !== user.uid) return null;
  return user.uid as string;
}

async function maxMergeProgress(workspaceId: string, done: number, owner: ArchiveOwnerContext): Promise<void> {
  const ref = doc(db, 'workspaces', workspaceId);
  await awaitArchiveOwner(owner, async () => (runTransaction(db, async (tx) => {
    const snap = await awaitArchiveOwner(owner, async () => (tx.get(ref)));
    if (!snap.exists || snap.get('deleting') !== true) return;
    const current = typeof snap.get('deleteDone') === 'number' ? snap.get('deleteDone') : 0;
    if (done > current) tx.update(ref, { deleteDone: done });
  })));
}

async function apiDeleteAsset(key: string, workspaceId: string, owner: ArchiveOwnerContext): Promise<boolean> {
  try {
    const res = await awaitArchiveOwner(owner, async () => (authFetch('/api/delete', {
      method: 'POST',
      body: JSON.stringify({ key, workspaceId }),
    }, owner)));
    return res.ok;
  } catch {
    return false;
  }
}

interface DeletionStatus {
  ok: boolean;
  status: 'deleting' | 'completed' | string;
  job?: { deleteTotal: number | null; deleteDone: number };
  outstandingAttempts?: { callDropId: string; attemptKey: string; phase: string; roomName: string | null }[];
  openFences?: number;
  noticesPrepared?: number;
  noticesExpected?: number;
}

async function fetchStatus(workspaceId: string, owner: ArchiveOwnerContext): Promise<DeletionStatus> {
  const res = await awaitArchiveOwner(owner, async () => (authFetch('/api/workspaces/delete-status', {
    method: 'POST',
    body: JSON.stringify({ workspaceId }),
  }, owner)));
  return (await awaitArchiveOwner(owner, async () => (res.json().catch(() => ({ ok: false, status: 'error' }))))) as DeletionStatus;
}

// ---- The job ----
export function runDeletionJob(workspaceId: string, context?: ArchiveOwnerContext): Promise<void> {
  const uid = getAuth().currentUser?.uid;
  if (!context && !uid) return Promise.resolve();
  const owner = context ?? createArchiveOwnerContext(uid!);
  try { owner.check(); } catch (error) { return Promise.reject(error); }
  const existing = runningJobs.get(workspaceId);
  if (existing) {
    let compatible = existing.owner.uid === owner.uid && existing.owner.generation === owner.generation;
    try { existing.owner.check(); } catch { compatible = false; }
    if (compatible) return awaitArchiveOwner(owner, () => existing.promise);
    // Never inherit a different generation's cleanup as this caller's completion proof.
    return existing.promise.catch(() => {}).then(() => {
      owner.check();
      return runDeletionJob(workspaceId, owner);
    });
  }
  const promise = runJob(workspaceId, owner)
    .catch((error) => {
      console.error('deletion job failed:', workspaceId, error);
      markPaused(workspaceId);
      if (context) throw error; // archive caller retains its ledger/cleanup-needed failure
    })
    .finally(() => {
      if (runningJobs.get(workspaceId)?.promise === promise) runningJobs.delete(workspaceId);
    });
  runningJobs.set(workspaceId, { promise, owner });
  return promise;
}

async function runJob(workspaceId: string, owner: ArchiveOwnerContext): Promise<void> {
  // STATUS first (resume authority + server-side counting).
  const status = await awaitArchiveOwner(owner, async () => (fetchStatus(workspaceId, owner).catch(() => null)));
  if (status && (status.status === 'completed' || status.status === 'not-found')) return;

  const uid = await awaitArchiveOwner(owner, async () => (requireDeletingOwner(workspaceId, owner).catch(() => null)));
  if (!uid) return; // gone, not ours, or not deleting — nothing to run

  // ---- Stage: calls (D-m force-end + attempt resolution) ----
  if (status) {
    for (const attempt of status.outstandingAttempts ?? []) {
      const res = await awaitArchiveOwner(owner, async () => (authFetch('/api/call/terminal', {
        method: 'POST',
        body: JSON.stringify({ op: 'resolve', callDropId: attempt.callDropId, attemptKey: attempt.attemptKey }),
      }, owner).catch(() => null)));
      const json = res ? ((await awaitArchiveOwner(owner, async () => (res.json().catch(() => ({}))))) as { status?: string }) : null;
      if (json?.status === 'unresolved') {
        markPaused(workspaceId); // the creation-resolution window has not elapsed — defer
        return;
      }
    }
  }
  const callSnap = await awaitArchiveOwner(owner, async () => (getDocs(
    query(collection(db, 'drops'), where('workspaceId', '==', workspaceId), where('type', '==', 'call'), limit(1)),
  )));
  if (!callSnap.empty) {
    const res = await awaitArchiveOwner(owner, async () => (authFetch('/api/call/terminal', {
      method: 'POST',
      body: JSON.stringify({ op: 'force-end', callDropId: callSnap.docs[0].id }),
    }, owner).catch(() => null)));
    if (!res || !res.ok) {
      markPaused(workspaceId);
      return;
    }
  }

  // ---- Stage: drops (R2 → shares per-item ack → doc; authoritative requery until empty) ----
  let done = status?.job?.deleteDone ?? 0;
  let sinceProgress = 0;
  for (;;) {
    const uidNow = await awaitArchiveOwner(owner, async () => (requireDeletingOwner(workspaceId, owner).catch(() => null)));
    if (!uidNow) return;
    const page = await awaitArchiveOwner(owner, async () => (getDocs(
      query(collection(db, 'drops'), where('workspaceId', '==', workspaceId), limit(DELETION_PAGE_SIZE)),
    )));
    if (page.empty) break;
    for (const dropDoc of page.docs) {
      const data = dropDoc.data();
      if (typeof data.r2Key === 'string' && data.r2Key) {
        if (!(await awaitArchiveOwner(owner, async () => (apiDeleteAsset(data.r2Key, workspaceId, owner))))) {
          markPaused(workspaceId);
          return;
        }
      }
      if (typeof data.imageR2Key === 'string' && data.imageR2Key) {
        if (!(await awaitArchiveOwner(owner, async () => (apiDeleteAsset(data.imageR2Key, workspaceId, owner))))) {
          markPaused(workspaceId);
          return;
        }
      }
      if (!(await awaitArchiveOwner(owner, async () => (deleteSharesForDropChecked(dropDoc.id, owner))))) {
        markPaused(workspaceId);
        return;
      }
      await awaitArchiveOwner(owner, async () => (deleteDoc(dropDoc.ref)));
      done += 1;
      sinceProgress += 1;
      if (sinceProgress >= PROGRESS_EVERY) {
        await awaitArchiveOwner(owner, async () => (maxMergeProgress(workspaceId, done, owner)));
        sinceProgress = 0;
      }
    }
  }
  await awaitArchiveOwner(owner, async () => (maxMergeProgress(workspaceId, done, owner)));

  // Stickers are permanent and live outside drops; never seal with unresolved storage.
  if (!(await awaitArchiveOwner(owner, async () => (cleanupWorkspaceStickers(workspaceId, owner))))) {
    markPaused(workspaceId);
    return;
  }

  // ---- Stage: messages (D-f wipe; owner delete; authoritative requery until empty) ----
  for (;;) {
    const page = await awaitArchiveOwner(owner, async () => (getDocs(
      query(collection(db, 'workspaces', workspaceId, 'messages'), limit(MESSAGE_PAGE_SIZE)),
    )));
    if (page.empty) break;
    for (const m of page.docs) {
      await awaitArchiveOwner(owner, async () => (deleteDoc(m.ref)));
    }
  }

  // ---- Stage: categories (owner cleanup; requery until empty) ----
  for (;;) {
    const page = await awaitArchiveOwner(owner, async () => (getDocs(
      query(collection(db, 'categories'), where('workspaceId', '==', workspaceId), limit(DELETION_PAGE_SIZE)),
    )));
    if (page.empty) break;
    for (const c of page.docs) {
      await awaitArchiveOwner(owner, async () => (deleteDoc(c.ref)));
    }
  }

  // ---- Stage: key (checked idempotent acknowledgment) ----
  const keyRes = await awaitArchiveOwner(owner, async () => (authFetch('/api/cleanup-workspace-key', {
    method: 'POST',
    body: JSON.stringify({ workspaceId }),
  }, owner).catch(() => null)));
  if (!keyRes || !keyRes.ok) {
    // A 404 here means the parent is already gone (a racing SEAL) — verify via STATUS.
    const verify = await awaitArchiveOwner(owner, async () => (fetchStatus(workspaceId, owner).catch(() => null)));
    if (!verify || verify.status !== 'completed') {
      markPaused(workspaceId);
      return;
    }
  }

  // ---- Stage: notices (bounded chunks; the certificate must cover the frozen set) ----
  const wsSnap = await awaitArchiveOwner(owner, async () => (getDoc(doc(db, 'workspaces', workspaceId))));
  if (wsSnap.exists()) {
    const recipients = (wsSnap.get('deletingRecipients') as string[] | undefined) ?? [];
    for (let i = 0; i < recipients.length; i += 100) {
      const chunk = recipients.slice(i, i + 100);
      const res = await awaitArchiveOwner(owner, async () => (authFetch('/api/workspaces/delete-prepare-notices', {
        method: 'POST',
        body: JSON.stringify({ workspaceId, recipients: chunk }),
      }, owner).catch(() => null)));
      if (!res || !res.ok) {
        markPaused(workspaceId);
        return;
      }
    }
  }

  // ---- SEAL ----
  const seal = await awaitArchiveOwner(owner, async () => (authFetch('/api/workspaces/delete-finalize', {
    method: 'POST',
    body: JSON.stringify({ workspaceId }),
  }, owner).catch(() => null)));
  if (!seal || !seal.ok) {
    markPaused(workspaceId);
    return;
  }
}

// ---- Goodbye notices (part I): subscribe to MY pending tombstones. ack() deletes the
// notice doc (cooperative acknowledgment — the CALLER gates it on visibility, so a
// hidden tab keeps the notice queued for the next visit). Deterministic doc ids make
// the subscription idempotent across reconnects (the seen-set double-guards it).
export interface DeletionNoticeView {
  noticeId: string;
  workspaceName: string;
  ownerName: string;
  ack: () => Promise<void>;
}

export function subscribeDeletionNotices(
  userId: string,
  onNotice: (notice: DeletionNoticeView) => void,
): () => void {
  const seen = new Set<string>();
  return onSnapshot(
    query(collection(db, 'deletionNotices'), where('recipientId', '==', userId)),
    (snap) => {
      snap.docChanges().forEach((change) => {
        if (change.type !== 'added') return;
        if (seen.has(change.doc.id)) return;
        seen.add(change.doc.id);
        const data = change.doc.data();
        onNotice({
          noticeId: change.doc.id,
          workspaceName: typeof data.workspaceName === 'string' ? data.workspaceName : 'A workspace',
          ownerName: typeof data.ownerName === 'string' ? data.ownerName : 'its owner',
          ack: async () => {
            try {
              await deleteDoc(doc(db, 'deletionNotices', change.doc.id));
            } catch {
              /* cooperative — the next visit retries */
            }
          },
        });
      });
    },
    () => {},
  );
}
