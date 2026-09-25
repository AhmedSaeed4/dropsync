'use client';

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
  callback: () => Promise<T>
): Promise<T> {
  const locks = lockApi();
  const options: LockOptions = mode === 'recovery' ? { mode: 'exclusive' } : { mode: 'exclusive', ifAvailable: true };
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

export async function tryAuthChange(uid: string | null, callback: () => Promise<void>): Promise<boolean> {
  if (!uid) { await callback(); return true; }
  const { getArchiveTaskManager } = await import('./archiveTaskManager');
  const manager = getArchiveTaskManager();
  if (manager.isBusyForUid(uid) || hasLocalArchiveObligation(uid)) return false;
  if (typeof navigator === 'undefined' || !navigator.locks?.request) {
    await callback();
    return true;
  }
  try {
    await withUserArchiveLock(uid, 'auth', async () => {
      if (manager.isBusyForUid(uid) || hasLocalArchiveObligation(uid)) throw new ArchiveLockBusyError();
      await callback();
    });
    return true;
  } catch (error) {
    if (error instanceof ArchiveLockBusyError || error instanceof ArchiveLockUnavailableError) return false;
    throw error;
  }
}
