'use client';

import type { ArchiveProgress } from './archiveFormat';
import { ArchiveCheckUnavailableError, ArchiveCleanupNeededError, recoverInterruptedWorkspaceArchiveImport } from './workspaceArchive';
import { recoverInterruptedPersonalArchiveImport } from './personalArchive';
import { ArchiveLockBusyError, ArchiveLockUnavailableError, withUserArchiveLock } from './archiveJobLock';

export type ArchiveKind = 'import' | 'export';
export type ArchiveScope = 'workspace' | 'personal';
export type ArchiveStatus = 'preparing' | 'checking' | 'working' | 'finalizing' | 'cancelling' | 'succeeded' | 'cancelled' | 'failed' | 'cleanup-needed';

export interface ArchiveJobDescriptor {
  jobId: string;
  uid: string;
  kind: ArchiveKind;
  scope: ArchiveScope;
  sourceWorkspaceId?: string | null;
  sourceWorkspaceName?: string;
  destinationMode?: 'new' | 'merge';
  destinationId?: string | null;
  destinationName?: string;
  sourceDropIds: string[];
  startedAt: number;
}

export interface ArchiveDisplaySnapshot {
  jobId: string;
  kind: ArchiveKind;
  scope: ArchiveScope;
  status: ArchiveStatus;
  currentName: string;
  completedItems: number;
  totalItems: number;
  percent: number | null;
  message: string;
  canCancel: boolean;
}

export interface ArchiveSettledSnapshot {
  jobId: string;
  kind: ArchiveKind;
  scope: ArchiveScope;
  status: 'failed' | 'cleanup-needed';
  message: string;
  settledAt: number;
  dismissed: boolean;
}

export interface ArchiveDisplayStore {
  active: ArchiveDisplaySnapshot | null;
  settled: ArchiveSettledSnapshot[];
}

type Runner = (signal: AbortSignal, onProgress: (progress: ArchiveProgress) => void, onFinalClose: () => void) => Promise<string>;
const COMPLETE_FLASH_MS = 500;
const PROGRESS_INTERVAL_MS = 175;

export class ArchiveTaskManager {
  private snapshot: ArchiveDisplayStore = { active: null, settled: [] };
  private listeners = new Set<() => void>();
  private reservation: ArchiveJobDescriptor | null = null;
  private controller: AbortController | null = null;
  private pending = new Set<string>();
  private remoteActive = new Set<string>();
  private latestRaw: ArchiveProgress | null = null;
  private publishTimer: ReturnType<typeof setTimeout> | null = null;
  private lastPercent = 0;
  private noticeHandler: ((notice: string, jobId: string) => void) | null = null;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  getSnapshot = (): ArchiveDisplayStore => this.snapshot;
  private publish(next: ArchiveDisplayStore) { this.snapshot = next; this.listeners.forEach((listener) => listener()); }
  setNoticeHandler(handler: ((notice: string, jobId: string) => void) | null) { this.noticeHandler = handler; }

  markRecoveryPending(uid: string) { this.pending.add(uid); }
  isRecoveryPending(uid: string): boolean { return this.pending.has(uid); }
  isBusyForUid(uid: string): boolean {
    return this.reservation?.uid === uid || this.pending.has(uid) || this.remoteActive.has(uid)
      || this.snapshot.settled.some((item) => item.status === 'cleanup-needed' && !item.dismissed);
  }

  reserveForStart(descriptor: ArchiveJobDescriptor): void {
    if (this.reservation || this.snapshot.active) throw new Error('An archive is already running. Open its progress chip.');
    if (this.pending.has(descriptor.uid)) throw new Error('Archive recovery is still being checked. Try again shortly.');
    if (this.remoteActive.has(descriptor.uid)) throw new Error('A backup is active on another device. Try again when it finishes.');
    if (this.snapshot.settled.some((item) => item.status === 'cleanup-needed' && !item.dismissed)) {
      throw new Error('Import cleanup is incomplete. Open its chip and select Retry.');
    }
    this.reservation = descriptor;
  }

  releaseReservation(jobId: string) {
    if (this.reservation?.jobId === jobId && !this.snapshot.active) this.reservation = null;
  }

  private setActive(patch: Partial<ArchiveDisplaySnapshot>) {
    if (!this.snapshot.active) return;
    this.publish({ ...this.snapshot, active: { ...this.snapshot.active, ...patch } });
  }

  private consumeProgress() {
    this.publishTimer = null;
    const progress = this.latestRaw;
    const active = this.snapshot.active;
    if (!progress || !active || active.status === 'cancelling') return;
    const completedItems = Math.max(active.completedItems, progress.completedItems || 0);
    const totalItems = Math.max(active.totalItems, progress.totalItems || 0);
    const candidate = totalItems > 0 ? Math.min(99, Math.floor(100 * completedItems / totalItems)) : null;
    const percent = candidate === null ? null : Math.max(this.lastPercent, candidate);
    if (percent !== null) this.lastPercent = percent;
    this.setActive({
      status: progress.phase === 'finalizing' ? 'finalizing' : progress.phase === 'inspect' ? 'checking' : progress.phase === 'preflight' ? 'preparing' : 'working',
      currentName: progress.currentName || active.currentName,
      completedItems, totalItems, percent,
      message: progress.message || active.message,
    });
  }

  private onProgress = (progress: ArchiveProgress) => {
    this.latestRaw = progress;
    if (progress.phase === 'finalizing') {
      if (this.publishTimer) clearTimeout(this.publishTimer);
      this.consumeProgress();
    } else if (!this.publishTimer) {
      this.publishTimer = setTimeout(() => this.consumeProgress(), PROGRESS_INTERVAL_MS);
    }
  };

  async startUnderLock(descriptor: ArchiveJobDescriptor, run: Runner): Promise<void> {
    if (this.reservation?.jobId !== descriptor.jobId) throw new Error('The archive Start reservation was lost.');
    const controller = new AbortController();
    this.controller = controller;
    this.lastPercent = 0;
    this.publish({ ...this.snapshot, active: {
      jobId: descriptor.jobId, kind: descriptor.kind, scope: descriptor.scope,
      status: 'preparing', currentName: descriptor.sourceWorkspaceName || descriptor.destinationName || '',
      completedItems: 0, totalItems: 0, percent: null, message: 'Preparing archive…', canCancel: true,
    } });
    try {
      await withUserArchiveLock(descriptor.uid, 'admission', async () => {
        const remote = await this.recoverForAdmission(descriptor.uid);
        if (remote) throw new Error('A backup is active on another device. Try again when it finishes.');
        if (controller.signal.aborted) throw new Error('Archive cancelled before it started.');
        const notice = await run(controller.signal, this.onProgress, () => this.setActive({ status: 'finalizing', canCancel: false, percent: 99 }));
        if (this.publishTimer) { clearTimeout(this.publishTimer); this.publishTimer = null; }
        this.setActive({ status: 'succeeded', percent: 100, canCancel: false, message: 'Archive completed.' });
        await new Promise<void>((resolve) => setTimeout(resolve, COMPLETE_FLASH_MS));
        this.publish({ ...this.snapshot, active: null });
        this.noticeHandler?.(notice, descriptor.jobId);
      });
    } catch (error) {
      if (this.publishTimer) { clearTimeout(this.publishTimer); this.publishTimer = null; }
      const cleanup = error instanceof ArchiveCleanupNeededError;
      const cancelled = controller.signal.aborted && !cleanup && !(error instanceof ArchiveLockBusyError);
      if (!cancelled) {
        const item: ArchiveSettledSnapshot = {
          jobId: descriptor.jobId, kind: descriptor.kind, scope: descriptor.scope,
          status: cleanup ? 'cleanup-needed' : 'failed',
          message: error instanceof Error ? error.message : 'The archive failed.',
          settledAt: Date.now(), dismissed: false,
        };
        this.publish({ active: null, settled: [...this.snapshot.settled, item] });
      } else {
        this.publish({ ...this.snapshot, active: null });
        this.noticeHandler?.(descriptor.kind === 'import' ? 'Import cancelled. No imported items remain.' : 'Export cancelled.', descriptor.jobId);
      }
      if (error instanceof ArchiveLockBusyError) throw error;
    } finally {
      this.reservation = null;
      this.controller = null;
      this.latestRaw = null;
    }
  }

  requestCancel(jobId: string) {
    if (this.snapshot.active?.jobId !== jobId || !this.snapshot.active.canCancel || !this.controller) return;
    this.setActive({ status: 'cancelling', canCancel: false, percent: null, message: 'Cancelling…' });
    this.controller.abort();
  }

  dismissVerifiedError(jobId: string) {
    this.publish({ ...this.snapshot, settled: this.snapshot.settled.map((item) =>
      item.jobId === jobId && item.status === 'failed' ? { ...item, dismissed: true } : item) });
  }

  async recoverUnderHeldLock(uid: string, forceOwnedFences = false): Promise<boolean> {
    let remote = false;
    let checkUnavailable: ArchiveCheckUnavailableError | null = null;
    try {
      if (await recoverInterruptedWorkspaceArchiveImport(uid, forceOwnedFences)) remote = true;
    } catch (error) {
      if (!(error instanceof ArchiveCheckUnavailableError)) throw error;
      checkUnavailable = error;
    }
    try {
      if (await recoverInterruptedPersonalArchiveImport(uid, forceOwnedFences)) remote = true;
    } catch (error) {
      if (!(error instanceof ArchiveCheckUnavailableError)) throw error;
      if (!checkUnavailable) checkUnavailable = error;
    }
    if (remote) this.remoteActive.add(uid); else this.remoteActive.delete(uid);
    if (checkUnavailable) throw checkUnavailable;
    return remote;
  }

  // Admission and cleanup retry tolerate an unavailable cross-device check (the fence list
  // can be denied while the updated rules are not deployed); same-browser locks still guard.
  private async recoverForAdmission(uid: string): Promise<boolean> {
    try { return await this.recoverUnderHeldLock(uid); }
    catch (error) { if (error instanceof ArchiveCheckUnavailableError) return false; throw error; }
  }

  async recoverForUser(uid: string): Promise<void> {
    this.markRecoveryPending(uid);
    try {
      await withUserArchiveLock(uid, 'recovery', () => this.recoverUnderHeldLock(uid));
    } catch (error) {
      const lockBusy = error instanceof ArchiveLockBusyError;
      const checkUnavailable = lockBusy || error instanceof ArchiveLockUnavailableError || error instanceof ArchiveCheckUnavailableError;
      this.publish({ ...this.snapshot, settled: [...this.snapshot.settled, {
        jobId: 'recovery-' + uid, kind: 'import', scope: 'workspace',
        status: checkUnavailable ? 'failed' : 'cleanup-needed',
        message: lockBusy
          ? 'Import recovery is still running in another tab of this browser.'
          : checkUnavailable
            ? 'Could not check for interrupted imports. The app will check again next time it opens.'
            : error instanceof Error ? error.message : 'Import cleanup is incomplete.',
        settledAt: Date.now(), dismissed: false,
      }] });
    } finally { this.pending.delete(uid); }
  }

  async retryCleanup(uid: string, jobId: string): Promise<void> {
    await withUserArchiveLock(uid, 'admission', async () => {
      const remote = await this.recoverForAdmission(uid);
      if (remote) throw new Error('A backup is active on another device.');
      this.publish({ ...this.snapshot, settled: this.snapshot.settled.filter((item) => item.jobId !== jobId) });
      this.noticeHandler?.('Import cleanup completed.', jobId);
    });
  }
}

let singleton: ArchiveTaskManager | null = null;
export function getArchiveTaskManager(): ArchiveTaskManager {
  if (!singleton) singleton = new ArchiveTaskManager();
  return singleton;
}
