'use client';

import type { ArchiveProgress } from './archiveFormat';
import { deferArchiveCheck, archiveWarmNow, type ArchiveWarmTrigger } from './archiveWarmStart';
import type { ArchiveRecoveryVerification, ArchiveVerificationCollector } from './workspaceArchive';
import { ArchiveCheckUnavailableError, ArchiveCleanupNeededError, recoverInterruptedWorkspaceArchiveImport, discoverInterruptedWorkspaceArchiveImport, certifyArchiveRecoveryPlan, recoverArchiveFenceJob } from './workspaceArchive';
import { recoverInterruptedPersonalArchiveImport, discoverInterruptedPersonalArchiveImport } from './personalArchive';
import { ArchiveLockBusyError, ArchiveLockUnavailableError, ArchiveCoordinationError, withUserArchiveLock, captureArchiveRecoveryGeneration, assertArchiveRecoveryGeneration, isArchiveAuthIntent, ARCHIVE_AUTH_EPOCH_PREFIX, canResumeArchiveSession, currentArchiveRecoveryGeneration } from './archiveJobLock';

import { type ArchiveOwnerContext, createArchiveOwnerContext, awaitArchiveOwner, ArchiveContextExpiredError } from './importFenceClient';

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
  uid: string;
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
  notice?: boolean;
}

export interface ArchiveSettledSnapshot {
  uid: string;
  jobId: string;
  kind: ArchiveKind;
  scope: ArchiveScope;
  status: 'failed' | 'cleanup-needed';
  message: string;
  settledAt: number;
  dismissed: boolean;
  notice?: boolean;
  cause?: string;
  elapsedCheckingMs?: number;
}

export interface ArchiveCheckDiagnostic {
  cause: string;
  elapsedCheckingMs: number;
  aborted: boolean;
  at: number;
}

declare global {
  interface Window {
    __dropsyncArchiveCheckDiag?: ArchiveCheckDiagnostic | null;
    __dropsyncArchiveCheckSchedule?: { phase: 'deferred' | 'checking' | 'settled' | 'cancelled';
      trigger: ArchiveWarmTrigger | null; deferredMs: number; at: number } | null;
  }
}

export interface ArchiveDisplayStore {
  active: ArchiveDisplaySnapshot | null;
  settled: ArchiveSettledSnapshot[];
}

type Runner = (signal: AbortSignal, onProgress: (progress: ArchiveProgress) => void, onFinalClose: () => void) => Promise<string>;
const COMPLETE_FLASH_MS = 500;
const PROGRESS_INTERVAL_MS = 175;


interface CleanupRequirement {
  uid: string;
  jobId: string;
  revision: number;
  required: Set<string>;
  verified: Set<string>;
}

interface RecoveryRun {
  uid: string;
  controller: AbortController;
  invalid: boolean;
  phase: 'deferred' | 'checking' | 'mutating';
  serial: number;
  origin?: number;
  trigger: ArchiveWarmTrigger | null;
  deferredMs: number;
  activate?: (trigger: ArchiveWarmTrigger) => void;
  cancelWarm?: () => void;
  setWarmReady?: (ready: boolean, epoch: number) => void;
  finishDeferred?: () => void;
  deadline?: ReturnType<typeof setTimeout>;
  retry?: ReturnType<typeof setTimeout>;
  done: Promise<void>;
}

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
  private noticeJobId: string | null = null;
  private noticeHandler: ((notice: string, jobId: string) => void) | null = null;


  private sessionUid: string | null = null;
  private authSession: unknown;
  private visible: ArchiveDisplayStore = { active: null, settled: [] };
  private mutating = new Set<string>();
  private routines = new Map<string, RecoveryRun>();
  private recoveryOwners = new Map<string, Set<symbol>>();
  private cleanupRequirements = new Map<string, CleanupRequirement>();
  private cleanupRevision = 0;
  private scheduleSerial = 0;
  private graceOrigin: number | undefined;
  private firstCheckStarted = false;
  private routineCheckFailures = new Map<string, number>();
  private readinessEpoch = 0;
  private warmOwners = new Map<symbol, { uid: string; serial: number; ready: boolean; scope?: number }>();

  private schedule(run: RecoveryRun, phase: 'deferred' | 'checking' | 'settled' | 'cancelled') {
    if (typeof window === 'undefined' || this.sessionUid !== run.uid
      || run.serial !== this.scheduleSerial || this.routines.get(run.uid) !== run) return;
    window.__dropsyncArchiveCheckSchedule = { phase, trigger: run.trigger,
      deferredMs: run.phase === 'deferred' && run.origin !== undefined ? Math.max(0, archiveWarmNow() - run.origin) : run.deferredMs,
      at: Date.now() };
  }
  private updateWarmReady(uid: string) {
    const run = this.routines.get(uid);
    if (run?.phase !== 'deferred') return;
    const tokens = [...(this.recoveryOwners.get(uid) || [])];
    const ready = tokens.length > 0 && tokens.every((token) => {
      const vote = this.warmOwners.get(token);
      return vote?.serial === this.scheduleSerial && vote.ready;
    });
    run.setWarmReady?.(ready, this.readinessEpoch);
  }

  private cleanupKey(uid: string, jobId: string) { return JSON.stringify([uid, jobId]); }
  private rememberCleanup(uid: string, jobId: string, target: string) {
    const key = this.cleanupKey(uid, jobId);
    let record = this.cleanupRequirements.get(key);
    if (!record) {
      record = { uid, jobId, revision: 0, required: new Set(), verified: new Set() };
      this.cleanupRequirements.set(key, record);
    }
    record.revision = ++this.cleanupRevision;
    record.required.add(target);
    record.verified.delete(target);
  }
  private verificationCollector(uid: string, owner: ArchiveOwnerContext): (proof: ArchiveRecoveryVerification, proofOwner?: ArchiveOwnerContext) => void {
    const captured = [...this.cleanupRequirements.values()].filter((record) => record.uid === uid)
      .map((record) => ({ record, revision: record.revision }));
    return (proof: ArchiveRecoveryVerification, proofOwner = owner) => {
      proofOwner.check();
      const target = proof.kind === 'fence' ? 'fence:' + proof.jobId : 'legacy:' + proof.revision;
      for (const { record, revision } of captured) {
        if (this.cleanupRequirements.get(this.cleanupKey(uid, record.jobId)) === record
          && record.revision === revision && record.required.has(target)) record.verified.add(target);
      }
    };
  }
  private cleanupVerified(uid: string, jobId: string, revision?: number): boolean {
    const record = this.cleanupRequirements.get(this.cleanupKey(uid, jobId));
    return !!record && record.revision === revision && record.required.size > 0
      && [...record.required].every((target) => record.verified.has(target));
  }

  constructor() {
    if (typeof window !== 'undefined') window.addEventListener('storage', (event) => {
      if (!event.key?.startsWith(ARCHIVE_AUTH_EPOCH_PREFIX)) return;
      const uid = event.key.slice(ARCHIVE_AUTH_EPOCH_PREFIX.length);
      this.pauseRoutine(uid);
      if (canResumeArchiveSession(uid)) this.resumeRoutine(uid);
    });
  }

  setSessionUid(uid: string | null, session?: unknown) {
    if (this.sessionUid === uid && (session === undefined || session === this.authSession)) return;
    this.authSession = session;
    if (this.sessionUid) this.pauseRoutine(this.sessionUid);
    this.routineCheckFailures.clear();
    this.scheduleSerial++;
    this.graceOrigin = undefined;
    this.firstCheckStarted = false;
    if (typeof window !== 'undefined') window.__dropsyncArchiveCheckSchedule = null;
    this.sessionUid = uid;
    this.publish(this.snapshot);
    if (uid) this.resumeRoutine(uid);
  }
  foregroundOwner(uid: string): ArchiveOwnerContext {
    const generation = currentArchiveRecoveryGeneration(uid);
    return createArchiveOwnerContext(uid, generation, () => assertArchiveRecoveryGeneration(uid, generation));
  }
  authBlockReason(uid: string): 'archive' | 'cleanup' | 'cleanup-needed' | null {
    if (this.reservation?.uid === uid || this.snapshot.active?.uid === uid) return 'archive';
    if (this.mutating.has(uid)) return 'cleanup';
    if (this.snapshot.settled.some((item) => item.uid === uid && item.status === 'cleanup-needed' && !item.dismissed)) return 'cleanup-needed';
    return null;
  }
  pauseRoutine(uid: string) {
    const run = this.routines.get(uid);
    if (!run) return;
    this.clearRoutineNotice(uid);
    run.invalid = true;
    if (run.retry) clearTimeout(run.retry);
    if (run.deadline) clearTimeout(run.deadline);
    if (run.phase === 'deferred') {
      run.cancelWarm?.();
      run.finishDeferred?.();
    }
    this.schedule(run, 'cancelled');
    if (run.phase !== 'mutating') {
      run.controller.abort();
      this.routines.delete(uid);
      this.pending.delete(uid);
    }
  }
  resumeRoutine(uid: string) {
    if (this.sessionUid !== uid || !this.recoveryOwners.get(uid)?.size) return;
    const run = this.routines.get(uid);
    if (run?.phase === 'mutating') return;
    if (run) this.pauseRoutine(uid);
    void this.ensureRoutine(uid);
  }
  attachRecovery(uid: string): { setReady: (ready: boolean, scopeEpoch: number) => void; dispose: () => void } {
    const token = Symbol(uid);
    const serial = this.scheduleSerial;
    let disposed = false;
    let owners = this.recoveryOwners.get(uid);
    if (!owners) { owners = new Set(); this.recoveryOwners.set(uid, owners); }
    owners.add(token);
    this.warmOwners.set(token, { uid, serial, ready: false });
    this.readinessEpoch++;
    void this.ensureRoutine(uid);
    this.updateWarmReady(uid);
    return {
      setReady: (ready, scope) => {
        if (disposed || serial !== this.scheduleSerial || uid !== this.sessionUid) return;
        const vote = this.warmOwners.get(token);
        if (!vote || (vote.ready === ready && vote.scope === scope)) return;
        vote.ready = ready;
        vote.scope = scope;
        this.readinessEpoch++;
        this.updateWarmReady(uid);
      },
      dispose: () => {
        if (disposed) return;
        disposed = true;
        owners!.delete(token);
        this.warmOwners.delete(token);
        this.readinessEpoch++;
        this.updateWarmReady(uid);
        // React's synchronous effect replay can reacquire before disposal runs.
        queueMicrotask(() => {
          if (!this.recoveryOwners.get(uid)?.size) {
            this.recoveryOwners.delete(uid);
            this.pauseRoutine(uid);
          }
        });
      },
    };
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  getSnapshot = (): ArchiveDisplayStore => this.visible;
  private publish(next: ArchiveDisplayStore) {
    this.snapshot = next;
    this.visible = { active: next.active?.uid === this.sessionUid ? next.active : null, settled: next.settled.filter((item) => item.uid === this.sessionUid) };
    this.listeners.forEach((listener) => listener());
  }
  setNoticeHandler(handler: ((notice: string, jobId: string) => void) | null) { this.noticeHandler = handler; }

  private notify(uid: string, notice: string, jobId: string) {
    if (this.sessionUid !== uid) return;
    this.noticeJobId = notice ? jobId : null;
    this.noticeHandler?.(notice, jobId);
  }
  private clearRoutineNotice(uid: string) {
    const jobId = 'recovery-' + uid;
    if (this.noticeJobId === jobId) this.notify(uid, '', jobId);
  }

  markRecoveryPending(uid: string) {
    this.pending.add(uid);
    if (uid === this.sessionUid && this.graceOrigin === undefined) this.graceOrigin = archiveWarmNow();
  }
  kickRecoveryIfPending(uid: string) {
    if (uid !== this.sessionUid || isArchiveAuthIntent(uid)) return;
    if (this.pending.has(uid) || this.routines.get(uid)?.phase === 'deferred') void this.ensureRoutine(uid, true);
  }
  isRecoveryPending(uid: string): boolean { return this.pending.has(uid); }
  isBusyForUid(uid: string): boolean {
    return !!this.authBlockReason(uid) || this.pending.has(uid) || this.remoteActive.has(uid) || isArchiveAuthIntent(uid);
  }

  reserveForStart(descriptor: ArchiveJobDescriptor): void {
    if (this.reservation || this.snapshot.active) throw new Error('An archive is already running. Open its progress chip.');
    if (isArchiveAuthIntent(descriptor.uid)) throw new Error('An account change is in progress.');
    if (this.pending.has(descriptor.uid)) {
      this.kickRecoveryIfPending(descriptor.uid);
      throw new Error('Archive recovery is still being checked. Try again shortly.');
    }
    if (this.remoteActive.has(descriptor.uid)) throw new Error('A backup is active on another device. Try again when it finishes.');
    if (this.snapshot.settled.some((item) => item.uid === descriptor.uid && item.status === 'cleanup-needed' && !item.dismissed)) {
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
      uid: descriptor.uid, jobId: descriptor.jobId, kind: descriptor.kind, scope: descriptor.scope,
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
        if (this.sessionUid === descriptor.uid) this.notify(descriptor.uid, notice, descriptor.jobId);
      });
    } catch (error) {
      if (this.publishTimer) { clearTimeout(this.publishTimer); this.publishTimer = null; }
      const cleanup = error instanceof ArchiveCleanupNeededError;
      const cancelled = controller.signal.aborted && !cleanup && !(error instanceof ArchiveLockBusyError);
      if (!cancelled) {
        const item: ArchiveSettledSnapshot = {
          uid: descriptor.uid, jobId: descriptor.jobId, kind: descriptor.kind, scope: descriptor.scope,
          status: cleanup ? 'cleanup-needed' : 'failed',
          message: error instanceof Error ? error.message : 'The archive failed.',
          settledAt: Date.now(), dismissed: false,
        };
        if (cleanup) this.rememberCleanup(descriptor.uid, descriptor.jobId, 'fence:' + descriptor.jobId);
        this.publish({ active: null, settled: [...this.snapshot.settled, item] });
      } else {
        this.publish({ ...this.snapshot, active: null });
        if (this.sessionUid === descriptor.uid) this.notify(descriptor.uid, descriptor.kind === 'import' ? 'Import cancelled. No imported items remain.' : 'Export cancelled.', descriptor.jobId);
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

  async recoverUnderHeldLock(uid: string, forceOwnedFences = false, owner = this.foregroundOwner(uid), collect?: ArchiveVerificationCollector): Promise<boolean> {
    let remote = false;
    let checkUnavailable: ArchiveCheckUnavailableError | null = null;
    try {
      if (await recoverInterruptedWorkspaceArchiveImport(uid, forceOwnedFences, owner, collect)) remote = true;
    } catch (error) {
      if (!(error instanceof ArchiveCheckUnavailableError)) throw error;
      checkUnavailable = error;
    }
    try {
      if (await recoverInterruptedPersonalArchiveImport(uid, forceOwnedFences, owner, collect)) remote = true;
    } catch (error) {
      if (!(error instanceof ArchiveCheckUnavailableError)) throw error;
      if (!checkUnavailable) checkUnavailable = error;
    }
    owner.check();
    if (remote) this.remoteActive.add(uid); else this.remoteActive.delete(uid);
    if (checkUnavailable) throw checkUnavailable;
    return remote;
  }

  // New-job admission tolerates an unavailable cross-device check (the fence list
  // can be denied while the updated rules are not deployed); same-browser locks still guard.
  private async recoverForAdmission(uid: string): Promise<boolean> {
    try { return await this.recoverUnderHeldLock(uid); }
    catch (error) { if (error instanceof ArchiveCheckUnavailableError) return false; throw error; }
  }

  recoverForUser(uid: string): Promise<void> { return this.ensureRoutine(uid, true); }

  private ensureRoutine(uid: string, immediate = false, trigger: ArchiveWarmTrigger = 'foreground'): Promise<void> {
    if (this.sessionUid !== uid) return Promise.resolve();
    const existing = this.routines.get(uid);
    if (existing) {
      if (immediate && existing.phase === 'deferred' && !isArchiveAuthIntent(uid)) existing.activate?.(trigger);
      return existing.done;
    }
    if (isArchiveAuthIntent(uid)) return Promise.resolve();
    const mayDefer = !immediate && !this.firstCheckStarted
      && !this.snapshot.settled.some((item) => item.uid === uid && item.status === 'cleanup-needed');
    if (this.graceOrigin === undefined) this.graceOrigin = archiveWarmNow();
    const run: RecoveryRun = { uid, controller: new AbortController(), invalid: false,
      phase: 'deferred', serial: this.scheduleSerial, trigger: null, deferredMs: 0,
      origin: mayDefer ? this.graceOrigin : undefined, done: Promise.resolve() };
    let finish!: () => void;
    let fail!: (reason: unknown) => void;
    run.done = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
    run.finishDeferred = finish;
    this.routines.set(uid, run);
    this.pending.add(uid);
    run.activate = (reason) => {
      if (run.invalid || run.phase !== 'deferred' || this.routines.get(uid) !== run
        || run.serial !== this.scheduleSerial || this.sessionUid !== uid) return;
      if (isArchiveAuthIntent(uid)) { this.pauseRoutine(uid); return; }
      run.cancelWarm?.();
      run.deferredMs = run.origin === undefined ? 0 : Math.max(0, archiveWarmNow() - run.origin);
      run.trigger = reason;
      run.phase = 'checking';
      run.finishDeferred = undefined;
      this.firstCheckStarted = true;
      this.schedule(run, 'checking');
      void this.runRoutine(run).then(finish, fail);
    };
    if (mayDefer) {
      this.schedule(run, 'deferred');
      const lease = deferArchiveCheck(run.origin!, (reason) => run.activate?.(reason));
      if (run.phase === 'deferred') {
        run.cancelWarm = lease.cancel;
        run.setWarmReady = lease.setReady;
        this.updateWarmReady(uid);
      } else lease.cancel();
    } else run.activate(trigger);
    return run.done;
  }

  private async runRoutine(run: RecoveryRun): Promise<void> {
    const uid = run.uid;
    const recoveryJobId = 'recovery-' + uid;
    const cleanupRevision = this.cleanupRequirements.get(this.cleanupKey(uid, recoveryJobId))?.revision;
    let dirty = false;
    let cleanupFailure = false;
    let budget = 5000;
    let checkStarted = Date.now();
    const armDeadline = () => {
      checkStarted = Date.now();
      run.deadline = setTimeout(() => run.controller.abort(), Math.max(0, budget));
    };
    const current = () => this.sessionUid === uid && this.routines.get(uid) === run && !run.invalid;
    this.pending.add(uid);
    armDeadline();
    try {
      let owner = createArchiveOwnerContext(uid, 'initializing', () => {
        if (!current() || isArchiveAuthIntent(uid)) throw new ArchiveContextExpiredError();
      }, run.controller.signal);
      const generation = await awaitArchiveOwner(owner, () => captureArchiveRecoveryGeneration(uid), true);
      const validate = () => assertArchiveRecoveryGeneration(uid, generation);
      owner = createArchiveOwnerContext(uid, generation, () => {
        if (!current() || isArchiveAuthIntent(uid)) throw new ArchiveContextExpiredError();
        validate();
      }, run.controller.signal);
      const collect = this.verificationCollector(uid, owner);
      const plans = [
        await awaitArchiveOwner(owner, () => discoverInterruptedWorkspaceArchiveImport(uid, owner), true),
        await awaitArchiveOwner(owner, () => discoverInterruptedPersonalArchiveImport(uid, owner), true),
      ];
      if (plans.some((plan) => plan.journals.length || plan.legacy || plan.checkUnavailable)) {
        this.notify(uid, 'Checking for interrupted imports. You can sign out while this check runs.', 'recovery-' + uid);
      }
      let remote = false;
      const mutate = async (execute: (context: ArchiveOwnerContext) => Promise<unknown>, target: string) => {
        await withUserArchiveLock(uid, 'recovery', async () => {
          owner.check();
          if (isArchiveAuthIntent(uid)) throw new ArchiveContextExpiredError();
          budget -= Date.now() - checkStarted;
          if (budget <= 0) { run.controller.abort(); throw new ArchiveContextExpiredError(); }
          if (run.deadline) clearTimeout(run.deadline);
          run.phase = 'mutating';
          this.mutating.add(uid);
          this.notify(uid, 'Cleaning up an interrupted import. Wait for cleanup before signing out.', 'recovery-' + uid);
          try {
            // No routine abort signal: never abandon a live mutation's promise.
            const mutationOwner = createArchiveOwnerContext(uid, generation, validate);
            await execute(mutationOwner);
          } catch (error) {
            cleanupFailure = true;
            this.rememberCleanup(uid, recoveryJobId, target);
            throw error;
          }
          finally {
            this.mutating.delete(uid);
            run.phase = 'checking';
            if (current()) {
              armDeadline();
              this.notify(uid, 'Checking for interrupted imports. You can sign out while this check runs.', 'recovery-' + uid);
            }
          }
        }, owner.signal);
        owner.check();
      };
      for (const original of plans) {
        const plan = await awaitArchiveOwner(owner, () => certifyArchiveRecoveryPlan(original, owner), true);
        for (const jobId of plan.verifiedJobIds || []) collect({ kind: 'fence', jobId });
        for (const journal of plan.journals) {
          if (plan.remoteJobIds.includes(journal.jobId)) { remote = true; continue; }
          await mutate(async (context) => {
            const result = await recoverArchiveFenceJob(journal, !!journal.journalKey, context);
            context.check();
            if (result === 'remote-active') remote = true;
            else if (result === 'adopted' || result === 'cancelled') collect({ kind: 'fence', jobId: journal.jobId }, context);
          }, 'fence:' + journal.jobId);
        }
        if (plan.legacy) await mutate(async (context) => {
          await plan.legacy!(context);
          context.check();
          if (plan.legacyRevision !== undefined) collect({ kind: 'legacy', revision: plan.legacyRevision }, context);
        }, plan.legacyRevision === undefined ? 'unknown-legacy' : 'legacy:' + plan.legacyRevision);
        if (plan.checkUnavailable) dirty = true;
      }
      owner.check();
      if (remote) this.remoteActive.add(uid); else this.remoteActive.delete(uid);
      if (dirty) throw new ArchiveCheckUnavailableError();
      if (current()) {
        const sticky = this.snapshot.settled.some((item) => item.uid === uid && item.jobId === recoveryJobId && item.status === 'cleanup-needed');
        if (sticky && !this.cleanupVerified(uid, recoveryJobId, cleanupRevision)) throw new ArchiveCheckUnavailableError();
        this.cleanupRequirements.delete(this.cleanupKey(uid, recoveryJobId));
        this.routineCheckFailures.delete(uid);
        this.publish({ ...this.snapshot, settled: this.snapshot.settled.filter((item) => item.uid !== uid || item.jobId !== 'recovery-' + uid) });
        if (typeof window !== 'undefined') window.__dropsyncArchiveCheckDiag = null;
      }
    } catch (error) {
      // An interrupted real cleanup remains owned and fail-closed, even after auth displacement.
      if (cleanupFailure) {
        this.publishRecoveryFailure(uid, 'cleanup-needed', error instanceof Error ? error.message : 'Import cleanup is incomplete.');
      } else if (current() && !(error instanceof ArchiveContextExpiredError && !run.controller.signal.aborted)) {
        dirty = true;
        const aborted = run.controller.signal.aborted;
        const elapsedCheckingMs = Date.now() - checkStarted;
        const cause = aborted ? 'deadline'
          : error instanceof ArchiveCheckUnavailableError ? 'check-unavailable'
            : [ArchiveLockUnavailableError, ArchiveLockBusyError, ArchiveCoordinationError]
              .some((ErrorType) => typeof ErrorType === 'function' && error instanceof ErrorType) ? 'coordination'
              : 'other';
        if (typeof window !== 'undefined') {
          window.__dropsyncArchiveCheckDiag = { cause, elapsedCheckingMs, aborted, at: Date.now() };
        }
        const failures = (this.routineCheckFailures.get(uid) || 0) + 1;
        this.routineCheckFailures.set(uid, failures);
        if (failures >= 2) {
        this.publishRecoveryFailure(uid, 'failed', 'Could not finish checking interrupted imports. We will retry in the background. You can still sign out.', { notice: true, cause, elapsedCheckingMs });
        }
      }
    } finally {
      this.schedule(run, run.invalid ? 'cancelled' : 'settled');
      this.clearRoutineNotice(uid);
      if (run.deadline) clearTimeout(run.deadline);
      if (this.routines.get(uid) === run) this.pending.delete(uid);
      if (dirty && current() && !isArchiveAuthIntent(uid)) {
        run.retry = setTimeout(() => {
          if (!current() || isArchiveAuthIntent(uid)) return;
          this.routines.delete(uid);
          void this.ensureRoutine(uid, true, 'retry');
        }, 30000);
        run.retry.unref?.();
      } else if (run.invalid && this.routines.get(uid) === run) {
        this.routines.delete(uid);
      }
    }
  }

  private publishRecoveryFailure(
    uid: string, status: 'failed' | 'cleanup-needed', message: string,
    diagnostics?: Pick<ArchiveSettledSnapshot, 'notice' | 'cause' | 'elapsedCheckingMs'>
  ) {
    const existing = this.snapshot.settled.find((item) => item.uid === uid && item.jobId === 'recovery-' + uid);
    if (existing?.status === 'cleanup-needed' && status === 'failed') return;
    if (status === 'cleanup-needed' && !this.cleanupRequirements.has(this.cleanupKey(uid, 'recovery-' + uid))) {
      this.rememberCleanup(uid, 'recovery-' + uid, 'unknown');
    }
    const preserveDismissal = status === 'failed' && existing?.status === 'failed' && existing.dismissed === true;
    this.publish({ ...this.snapshot, settled: [
      ...this.snapshot.settled.filter((item) => item.uid !== uid || item.jobId !== 'recovery-' + uid),
      { uid, jobId: 'recovery-' + uid, kind: 'import', scope: 'workspace', status, message, settledAt: Date.now(), dismissed: preserveDismissal,
        ...(status === 'failed' ? diagnostics : {}) },
    ] });
  }

  async retryCleanup(uid: string, jobId: string): Promise<void> {
    const revision = this.cleanupRequirements.get(this.cleanupKey(uid, jobId))?.revision;
    await withUserArchiveLock(uid, 'admission', async () => {
      const owner = this.foregroundOwner(uid);
      const remote = await this.recoverUnderHeldLock(uid, false, owner, this.verificationCollector(uid, owner));
      if (remote) throw new Error('A backup is active on another device.');
      owner.check();
      const sticky = this.snapshot.settled.some((item) => item.uid === uid && item.jobId === jobId && item.status === 'cleanup-needed');
      if (sticky && !this.cleanupVerified(uid, jobId, revision)) throw new Error('Import cleanup completion could not be verified. Retry cleanup.');
      this.cleanupRequirements.delete(this.cleanupKey(uid, jobId));
      this.publish({ ...this.snapshot, settled: this.snapshot.settled.filter((item) => item.uid !== uid || item.jobId !== jobId) });
      if (this.sessionUid === uid) this.notify(uid, 'Import cleanup completed.', jobId);
    });
  }
}

let singleton: ArchiveTaskManager | null = null;
export function getArchiveTaskManager(): ArchiveTaskManager {
  if (!singleton) singleton = new ArchiveTaskManager();
  return singleton;
}
