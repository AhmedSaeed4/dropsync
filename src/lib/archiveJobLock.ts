'use client';

import { getAuth } from 'firebase/auth';
import { ArchiveContextExpiredError } from './importFenceClient';

export class ArchiveLockUnavailableError extends Error {
  constructor() { super('This browser does not support the archive safety lock. Use a browser with Web Locks.'); }
}
export class ArchiveLockBusyError extends Error {
  constructor() { super('An archive or account deletion is active in another tab. Try again when it finishes.'); }
}

function lockApi(): LockManager {
  if (typeof navigator === 'undefined' || !navigator.locks?.request) throw new ArchiveLockUnavailableError();
  return navigator.locks;
}

export function archiveLockName(uid: string): string { return 'dropsync-archive-account-' + uid; }

export async function withUserArchiveLock<T>(
  uid: string,
  mode: 'admission' | 'recovery' | 'account' | 'auth',
  callback: () => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  const locks = lockApi();
  const options: LockOptions = mode === 'recovery' ? { mode: 'exclusive', signal } : { mode: 'exclusive', ifAvailable: true };
  return locks.request(archiveLockName(uid), options, async (lock) => {
    if (!lock) throw new ArchiveLockBusyError();
    return callback();
  });
}

export function hasLocalArchiveObligation(uid: string): boolean {
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key) continue;
      if (key.startsWith('dropsync_archive_import_journal_')
        || key.startsWith('dropsync_personal_archive_import_journal')) {
        const raw = localStorage.getItem(key);
        if (!raw) return true;
        const value = JSON.parse(raw) as { userId?: string };
        if (value.userId === uid || typeof value.userId !== 'string') return true;
      }
    }
    return false;
  } catch { return true; }
}


export const ARCHIVE_AUTH_MESSAGES = {
  archive: 'An archive is running. Finish or cancel it before signing out.',
  cleanup: 'Cleaning up an interrupted import. Wait for cleanup before signing out.',
  'cleanup-needed': 'Import cleanup is incomplete. Open Archive progress and select Retry cleanup.',
  local: 'Local archive recovery could not be verified. Resolve recovery before changing accounts.',
  lock: "An archive or account operation holds this account's safety lock in another tab. Try again when it finishes.",
} as const;
export type ArchiveAuthReason = keyof typeof ARCHIVE_AUTH_MESSAGES;
export type ArchiveAuthResult = { accepted: true } | { accepted: false; reason: ArchiveAuthReason; message: string };
export const ARCHIVE_AUTH_EPOCH_PREFIX = 'dropsync_archive_auth_epoch_';
interface AuthEpoch { generation: string; phase: 'idle' | 'auth'; resultUid: string | null }
class ArchiveCoordinationError extends Error {}
const authIntents = new Set<string>();
export function isArchiveAuthIntent(uid: string): boolean { return authIntents.has(uid); }

function readEpoch(uid: string): AuthEpoch | null {
  try {
    const raw = localStorage.getItem(ARCHIVE_AUTH_EPOCH_PREFIX + uid);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<AuthEpoch>;
    if (typeof value.generation !== 'string' || !value.generation
      || (value.phase !== 'idle' && value.phase !== 'auth')
      || (value.resultUid !== null && typeof value.resultUid !== 'string')) throw new Error('Invalid auth epoch');
    return value as AuthEpoch;
  } catch { throw new ArchiveCoordinationError('Archive session coordination is unavailable.'); }
}
function writeEpoch(uid: string, epoch: AuthEpoch) {
  try {
    const value = JSON.stringify(epoch);
    localStorage.setItem(ARCHIVE_AUTH_EPOCH_PREFIX + uid, value);
    if (localStorage.getItem(ARCHIVE_AUTH_EPOCH_PREFIX + uid) !== value) throw new Error('Epoch write not confirmed');
  } catch { throw new ArchiveCoordinationError('Archive session coordination is unavailable.'); }
}
function idleEpoch(uid: string | null): AuthEpoch {
  return { generation: crypto.randomUUID(), phase: 'idle', resultUid: uid };
}
export function currentArchiveRecoveryGeneration(uid: string): string {
  const epoch = readEpoch(uid);
  if (!epoch || epoch.phase !== 'idle' || epoch.resultUid !== uid) throw new ArchiveContextExpiredError();
  return epoch.generation;
}
export function assertArchiveRecoveryGeneration(uid: string, generation: string) {
  if (currentArchiveRecoveryGeneration(uid) !== generation) throw new ArchiveContextExpiredError();
}
export function canResumeArchiveSession(uid: string): boolean {
  try { return !isArchiveAuthIntent(uid) && getAuth().currentUser?.uid === uid && !!currentArchiveRecoveryGeneration(uid); }
  catch { return false; }
}
export async function captureArchiveRecoveryGeneration(uid: string): Promise<string> {
  if (isArchiveAuthIntent(uid)) throw new ArchiveContextExpiredError();
  return withUserArchiveLock(uid, 'auth', async () => {
    if (isArchiveAuthIntent(uid) || getAuth().currentUser?.uid !== uid) throw new ArchiveContextExpiredError();
    let epoch = readEpoch(uid);
    // Owning the actual lock proves an auth-phase marker no longer has a live owner.
    // An idle result for ANOTHER uid is never overwritten by a stale auth callback.
    if (!epoch || epoch.phase === 'auth') {
      epoch = idleEpoch(uid);
      writeEpoch(uid, epoch);
    }
    if (epoch.resultUid !== uid) throw new ArchiveContextExpiredError();
    return epoch.generation;
  });
}

export async function tryAuthChange(uid: string | null, callback: () => Promise<void>): Promise<ArchiveAuthResult> {
  const refusal = (reason: ArchiveAuthReason): ArchiveAuthResult => ({ accepted: false, reason, message: ARCHIVE_AUTH_MESSAGES[reason] });
  if (uid && isArchiveAuthIntent(uid)) return refusal('lock');
  if (uid) authIntents.add(uid); // synchronous: routine promotion cannot cross this intent
  let completed = false;
  let paused = false;
  let manager: import('./archiveTaskManager').ArchiveTaskManager | undefined;
  try {
    const { getArchiveTaskManager } = await import('./archiveTaskManager');
    manager = getArchiveTaskManager();
    const currentManager = manager;
    if (uid) {
      // Do not invalidate a real cleanup merely because its auth attempt is refused.
      const reason = currentManager.authBlockReason(uid);
      if (reason) return refusal(reason);
      currentManager.pauseRoutine(uid);
      paused = true;
      if (hasLocalArchiveObligation(uid)) return refusal('local');
      const result = await withUserArchiveLock(uid, 'auth', async (): Promise<ArchiveAuthResult> => {
        const inside = currentManager.authBlockReason(uid);
        if (inside) return refusal(inside);
        if (hasLocalArchiveObligation(uid)) return refusal('local');
        readEpoch(uid); // corrupt/unavailable storage must refuse BEFORE changing auth
        const epoch = { ...idleEpoch(uid), phase: 'auth' as const };
        writeEpoch(uid, epoch);
        try {
          await callback();
          completed = true;
        } finally {
          writeEpoch(uid, { ...epoch, phase: 'idle', resultUid: getAuth().currentUser?.uid ?? null });
        }
        return { accepted: true };
      });
      if (!result.accepted) return result;
    } else {
      const actualUid = getAuth().currentUser?.uid;
      if (actualUid) return await tryAuthChange(actualUid, callback);
      await callback(); // signed-out authentication keeps its existing ungated callback
      completed = true;
    }

    const actualUid = getAuth().currentUser?.uid;
    if (actualUid && actualUid !== uid) {
      authIntents.add(actualUid);
      try {
        // Acquire the new account independently AFTER releasing the old account lock.
        // This avoids opposite-direction account-switch lock-order deadlocks.
        await withUserArchiveLock(actualUid, 'recovery', async () => {
          if (getAuth().currentUser?.uid !== actualUid) throw new ArchiveContextExpiredError();
          writeEpoch(actualUid, idleEpoch(actualUid));
        });
      } finally { authIntents.delete(actualUid); }
    }
    return { accepted: true };
  } catch (error) {
    // A completed callback cannot truthfully be reported as an auth refusal.
    // A lost final epoch write remains fail-closed and is reconciled under the lock.
    if (completed && (error instanceof ArchiveCoordinationError || error instanceof ArchiveContextExpiredError)) return { accepted: true };
    if (error instanceof ArchiveCoordinationError) return refusal('local');
    if (error instanceof ArchiveLockBusyError || error instanceof ArchiveLockUnavailableError) return refusal('lock');
    throw error;
  } finally {
    if (uid) authIntents.delete(uid);
    const actualUid = getAuth().currentUser?.uid ?? null;
    manager?.setSessionUid(actualUid);
    if (actualUid && (paused || completed)) manager?.resumeRoutine(actualUid);
  }
}
