import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const root = path.resolve(import.meta.dirname, '..');
const source = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const descriptor = (jobId, kind = 'import') => ({ jobId, uid: 'owner', kind, scope: 'workspace', sourceDropIds: [], startedAt: Date.now() });

const emptyPlan = () => ({ journals: [], cancelledJobIds: [], remoteJobIds: [], checkUnavailable: false });
function makeManager({ locked = false, recovery = async () => false, personal = async () => false,
  discovery = async () => emptyPlan(), personalDiscovery = async () => emptyPlan(),
  execute = async () => 'cancelled', certify = async (plan) => plan, clock } = {}) {
  const events = [];
  class CleanupError extends Error {}
  class CheckUnavailableError extends Error {}
  class LockBusyError extends Error {}
  class LockUnavailableError extends Error {}
  const auth = { currentUser: { uid: 'owner', getIdToken: async () => 'token' } };
  const client = {};
  vm.runInNewContext(ts.transpileModule(source('src/lib/importFenceClient.ts'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports: client, require: () => ({ getAuth: () => auth }), AbortController, Error });
  const shared = { generation: 'g1', intent: false, locked, queued: [] };
  const withLock = (uid, mode, callback, signal) => new Promise((resolve, reject) => {
    events.push('lock:' + mode);
    const enter = () => {
      if (signal?.aborted) { reject(new client.ArchiveContextExpiredError()); return; }
      shared.locked = true;
      Promise.resolve().then(callback).then(resolve, reject).finally(() => {
        shared.locked = false;
        shared.queued.shift()?.();
      });
    };
    if (shared.locked) {
      if (mode !== 'recovery') { reject(new LockBusyError('another tab owns the lock')); return; }
      shared.queued.push(enter);
      signal?.addEventListener('abort', () => {
        shared.queued = shared.queued.filter((item) => item !== enter);
        reject(new client.ArchiveContextExpiredError());
      }, { once: true });
    } else enter();
  });
  const dependencies = {
    './importFenceClient': client,
    './workspaceArchive': { ArchiveCleanupNeededError: CleanupError, ArchiveCheckUnavailableError: CheckUnavailableError,
      recoverInterruptedWorkspaceArchiveImport: recovery, discoverInterruptedWorkspaceArchiveImport: discovery,
      certifyArchiveRecoveryPlan: certify, recoverArchiveFenceJob: execute },
    './personalArchive': { recoverInterruptedPersonalArchiveImport: personal, discoverInterruptedPersonalArchiveImport: personalDiscovery },
    './archiveJobLock': {
      ArchiveLockBusyError: LockBusyError, ArchiveLockUnavailableError: LockUnavailableError,
      captureArchiveRecoveryGeneration: async () => shared.generation,
      currentArchiveRecoveryGeneration: () => shared.generation,
      canResumeArchiveSession: () => false,
      ARCHIVE_AUTH_EPOCH_PREFIX: 'dropsync_archive_auth_epoch_',
      assertArchiveRecoveryGeneration: (_uid, generation) => { if (generation !== shared.generation) throw new client.ArchiveContextExpiredError(); },
      isArchiveAuthIntent: () => shared.intent, withUserArchiveLock: withLock,
    },
  };
  const exports = {};
  vm.runInNewContext(ts.transpileModule(source('src/lib/archiveTaskManager.ts'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, require: (id) => dependencies[id],
    setTimeout: clock?.setTimeout || setTimeout, clearTimeout: clock?.clearTimeout || clearTimeout,
    Date: clock?.Date || Date, queueMicrotask, AbortController, Error, console });
  const manager = new exports.ArchiveTaskManager();
  manager.setSessionUid('owner');
  return { manager, events, CleanupError, CheckUnavailableError, LockBusyError, shared, auth };
}
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
function fakeClock() {
  let now = 0, next = 0;
  const timers = new Map();
  class ClockDate extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  return {
    Date: ClockDate, timers,
    setTimeout: (callback, delay) => { const id = { id: ++next, unref() {} }; timers.set(id, { callback, at: now + delay }); return id; },
    clearTimeout: (id) => timers.delete(id),
    tick: async (duration) => {
      const end = now + duration;
      for (;;) {
        const due = [...timers].filter(([, item]) => item.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        now = due[1].at; timers.delete(due[0]); due[1].callback(); await flush();
      }
      now = end; await flush();
    },
  };
}

test('synchronous reservation admits only one job and releases a cancelled picker', () => {
  const { manager } = makeManager();
  manager.reserveForStart(descriptor('one'));
  assert.throws(() => manager.reserveForStart(descriptor('two')), /already running/);
  manager.releaseReservation('one');
  manager.reserveForStart(descriptor('two'));
});

test('lock refusal prevents runner and leaves a verified error entry', async () => {
  const { manager, LockBusyError } = makeManager({ locked: true });
  let ran = false;
  manager.reserveForStart(descriptor('one'));
  await assert.rejects(manager.startUnderLock(descriptor('one'), async () => { ran = true; return 'done'; }), LockBusyError);
  assert.equal(ran, false);
  assert.equal(manager.getSnapshot().settled[0].status, 'failed');
  manager.reserveForStart(descriptor('two'));
});

test('recovery finishes under the lock before any new runner side effect', async () => {
  const { manager, events } = makeManager({ recovery: async () => { events.push('recover'); return false; } });
  const job = descriptor('one');
  manager.reserveForStart(job);
  await manager.startUnderLock(job, async () => { events.push('run'); return 'done'; });
  assert.deepEqual(events.slice(0, 3), ['lock:admission', 'recover', 'run']);
});

test('remote live fence refuses a new import before the runner', async () => {
  const { manager } = makeManager({ recovery: async () => true });
  const job = descriptor('one');
  let ran = false;
  manager.reserveForStart(job);
  await manager.startUnderLock(job, async () => { ran = true; return 'done'; });
  assert.equal(ran, false);
  assert.match(manager.getSnapshot().settled[0].message, /another device/);
});

test('success notice follows the visible checkmark and is not settled', async () => {
  const { manager } = makeManager();
  const events = [];
  manager.subscribe(() => { if (manager.getSnapshot().active?.status === 'succeeded') events.push('checkmark'); });
  manager.setNoticeHandler(() => events.push('notice'));
  const job = descriptor('one', 'export');
  manager.reserveForStart(job);
  await manager.startUnderLock(job, async () => 'saved');
  assert.deepEqual(events, ['checkmark', 'notice']);
  assert.equal(manager.getSnapshot().settled.length, 0);
});

test('item progress never moves backward and stops below 100 before commit', async () => {
  const { manager } = makeManager();
  const job = descriptor('one');
  const seen = [];
  manager.subscribe(() => { const value = manager.getSnapshot().active?.percent; if (value !== null && value !== undefined) seen.push(value); });
  manager.reserveForStart(job);
  await manager.startUnderLock(job, async (_signal, progress, close) => {
    progress({ phase: 'import', completedItems: 8, totalItems: 10 });
    progress({ phase: 'import', completedItems: 3, totalItems: 10 });
    progress({ phase: 'finalizing', completedItems: 10, totalItems: 10 });
    close();
    return 'done';
  });
  assert.ok(seen.every((value, index) => index === 0 || value >= seen[index - 1]));
  assert.equal(seen.at(-1), 100);
});

test('zero-item finalization stays indeterminate until the commit completes', async () => {
  const { manager } = makeManager();
  const job = descriptor('empty');
  let finish;
  const waiting = new Promise((resolve) => { finish = resolve; });
  manager.reserveForStart(job);
  const run = manager.startUnderLock(job, async (_signal, progress, close) => {
    progress({ phase: 'finalizing', completedItems: 0, totalItems: 0 });
    close();
    await waiting;
    return 'saved';
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(manager.getSnapshot().active.percent, 99);
  assert.equal(manager.getSnapshot().active.canCancel, false);
  finish();
  await run;
  assert.equal(manager.getSnapshot().active, null);
});

test('cancel aborts work before commit, while final close disallows late cancel', async () => {
  const { manager } = makeManager();
  const early = descriptor('early');
  let abortObserved = false;
  manager.reserveForStart(early);
  await manager.startUnderLock(early, async (signal) => {
    manager.requestCancel('early');
    abortObserved = signal.aborted;
    throw new Error('cancelled');
  });
  assert.equal(abortObserved, true);
  assert.equal(manager.getSnapshot().active, null);
  assert.equal(manager.getSnapshot().settled.length, 0);

  const late = descriptor('late', 'export');
  manager.reserveForStart(late);
  await manager.startUnderLock(late, async (signal, _progress, close) => {
    close();
    manager.requestCancel('late');
    assert.equal(signal.aborted, false);
    return 'saved';
  });
  assert.equal(manager.getSnapshot().settled.length, 0);
});

test('failed cleanup is non-dismissable until retry confirms recovery', async () => {
  const { manager, CleanupError } = makeManager();
  const job = descriptor('one');
  manager.reserveForStart(job);
  await manager.startUnderLock(job, async () => { throw new CleanupError('ledger remains'); });
  assert.equal(manager.getSnapshot().settled[0].status, 'cleanup-needed');
  manager.dismissVerifiedError('one');
  assert.equal(manager.getSnapshot().settled[0].dismissed, false);
  assert.throws(() => manager.reserveForStart(descriptor('two')), /cleanup is incomplete/);
  await manager.retryCleanup('owner', 'one');
  manager.reserveForStart(descriptor('two'));
});
test('an unavailable cross-device check settles as a dismissible error and never blocks', async () => {
  const ran = [];
  const { manager } = makeManager({
    discovery: async () => ({ ...emptyPlan(), checkUnavailable: true }),
    personalDiscovery: async () => { ran.push('personal'); return emptyPlan(); },
  });
  await manager.recoverForUser('owner');
  const card = manager.getSnapshot().settled[0];
  assert.equal(card.status, 'failed');
  assert.match(card.message, /Could not finish checking interrupted imports/);
  assert.deepEqual(ran, ['personal']);
  manager.reserveForStart(descriptor('two'));
  manager.dismissVerifiedError(card.jobId);
  assert.equal(manager.getSnapshot().settled[0].dismissed, true);
});

test('admission proceeds when the cross-device check is unavailable', async () => {
  const { manager, CheckUnavailableError } = makeManager({ recovery: async () => { throw new CheckUnavailableError('denied'); } });
  const job = descriptor('one');
  let ran = false;
  manager.reserveForStart(job);
  await manager.startUnderLock(job, async () => { ran = true; return 'done'; });
  assert.equal(ran, true);
  assert.equal(manager.getSnapshot().settled.length, 0);
});

test('an empty routine check does not acquire or depend on the account lock', async () => {
  const { manager, events } = makeManager({ locked: true });
  await manager.recoverForUser('owner');
  assert.equal(manager.getSnapshot().settled.length, 0);
  assert.deepEqual(events, []);
  manager.reserveForStart(descriptor('two'));
});

test('a real recovery failure still settles as cleanup-needed and blocks', async () => {
  const { manager } = makeManager({ discovery: async () => ({ ...emptyPlan(), journals: [{ jobId: 'job', userId: 'owner' }] }), execute: async () => { throw new Error('ledger remains'); } });
  await manager.recoverForUser('owner');
  assert.equal(manager.getSnapshot().settled[0].status, 'cleanup-needed');
  assert.throws(() => manager.reserveForStart(descriptor('two')), /cleanup is incomplete/);
});

// Discovery/local-journal execution is exercised with real transpiled libraries in archiveFenceSettlement.test.mjs.

test('bulk move/copy and delete pre-checks are batched, not per-item serial', () => {
  for (const file of ['src/components/MoveDropModal.tsx', 'src/components/editorial/EditorialMoveDropModal.tsx']) {
    const body = source(file);
    assert.ok(body.includes('await assertDropsWritableBatch(dropList.map((drop) => drop.id));'));
    assert.ok(!body.includes('for (const drop of dropList) await assertDropWritableById'));
    const loading = body.indexOf('setLoading(true);');
    const guard = body.indexOf('await assertDropsWritableBatch(');
    assert.ok(loading > 0 && guard > loading, file);
  }
  const dropsSource = source('src/lib/drops.ts');
  const entry = dropsSource.indexOf('export async function deleteDrop(');
  const nextFn = dropsSource.indexOf('export async function', entry + 10);
  const deleteBody = dropsSource.slice(entry, nextFn);
  assert.equal((deleteBody.match(/assertDropWritableById/g) || []).length, 1);
  assert.ok(source('src/lib/archiveJournalVisibility.ts').includes('export async function assertDropsWritableBatch'));
});

test('import source records register obligations before writes and cancel before rollback', () => {
  for (const file of ['src/lib/workspaceArchive.ts', 'src/lib/personalArchive.ts']) {
    const body = source(file);
    assert.ok(body.includes('persistJournal();'));
    assert.ok(body.includes("registerItems([{ kind: 'drop', id" ) || body.includes("registerItems(Array.from(sourceToNewId.values())"));
    assert.ok(body.includes('recoverArchiveFenceJob('));
  }
  const recovery = source('src/lib/workspaceArchive.ts');
  const close = recovery.indexOf('await cancelImportFence(journal.jobId, localInterrupted, owner)');
  const deletes = recovery.indexOf('for (const id of obligationIds)', close);
  const ack = recovery.indexOf('await ackImportItems(journal.jobId', deletes);
  assert.ok(close > 0 && deletes > close && ack > deletes);
  const keyAck = recovery.indexOf("await ackImportItems(journal.jobId, ['key:' + journal.workspaceId], owner)");
  const parentDelete = recovery.indexOf('startWorkspaceDeletion(journal.workspaceId', keyAck);
  assert.ok(keyAck > 0 && parentDelete > keyAck);
  const account = source('src/lib/accountDeletion.ts');
  // Account-deletion ordering is verified through execution in the P6 behavior test.
  assert.ok(account.includes('status.outstandingItems !== 0'));
});

test('recovery existence probes go through the Admin fence route, never bare client gets', () => {
  const route = source('src/app/api/archive/import-fence/route.ts');
  const probeOp = route.indexOf("if (op === 'probe-items')");
  const shared = route.indexOf('// ---------- shared: the fence must belong to the caller ----------');
  assert.ok(probeOp > 0 && shared > probeOp);
  const client = source('src/lib/importFenceClient.ts');
  assert.ok(client.includes('export async function probeImportItems('));
  const recovery = source('src/lib/workspaceArchive.ts');
  assert.ok(recovery.includes('export async function purgeOwnedDocObligations('));
  assert.ok(!recovery.includes('async function confirmedDelete('));
  assert.ok(!recovery.includes('getDocFromServer'));
  const fenceProbeAt = recovery.indexOf('const fenceProbe = await probeImportItems(journal.jobId, [fenceProbeId], owner);');
  const ledgerAt = recovery.indexOf('const ledger = await awaitArchiveOwner(', fenceProbeAt);
  assert.ok(fenceProbeAt > 0 && ledgerAt > fenceProbeAt);
  const personal = source('src/lib/personalArchive.ts');
  assert.ok(personal.includes("await purgeOwnedDocObligations('legacy-personal'"));
  assert.ok(!personal.includes('getDocFromServer'));
  assert.ok(!source('src/lib/archiveTaskManager.ts').includes('archive-recovery-probe'));
});

test('staged preview Move/Edit/Share render faded tooltip stand-ins, not silent disabled buttons', () => {
  const body = source('src/components/editorial/EditorialPreviewModal.tsx');
  assert.ok(body.includes("import { Tooltip } from '../Tooltip';"));
  for (const [action, message] of [
    ['MOVE', 'move'],
    ['EDIT', 'edit'],
    ['SHARE', 'share'],
  ]) {
    assert.ok(body.includes(`const STAGED_${action}_MESSAGE = 'Staged while importing — you can ${message} this drop once the import finishes.';`));
    assert.ok(body.includes(`<Tooltip content={STAGED_${action}_MESSAGE}>`));
    assert.ok(body.includes(`aria-label={STAGED_${action}_MESSAGE}`));
  }
  assert.ok(!body.includes('you can change this drop'));
  assert.equal((body.match(/opacity-40 cursor-not-allowed/g) || []).length, 3);
  assert.equal((body.match(/aria-disabled="true"/g) || []).length, 3);
  assert.ok(!body.includes('disabled={editPreparing || !!drop.isStaged}'));
  assert.ok(!body.includes('disabled={isSharing || !!drop.isStaged}'));
  assert.ok(body.includes('disabled={isSharing}'));
  assert.ok(!body.includes('onClick={() => !drop.isStaged && onMove(drop)}'));
});

test('P4 routine checking is single-flight, lock-free and not an auth blocker', async () => {
  let calls = 0, finish;
  const { manager, events } = makeManager({ discovery: () => { calls++; return new Promise((done) => { finish = done; }); } });
  const one = manager.attachRecovery('owner');
  const two = manager.attachRecovery('owner');
  const pending = manager.recoverForUser('owner');
  await flush();
  assert.equal(calls, 1);
  assert.equal(manager.isRecoveryPending('owner'), true);
  assert.equal(manager.authBlockReason('owner'), null);
  assert.equal(manager.isBusyForUid('owner'), true, 'archive/account admission still sees pending');
  assert.deepEqual(events, []);
  one.dispose(); await flush();
  assert.equal(manager.isRecoveryPending('owner'), true);
  finish(emptyPlan()); await pending;
  two.dispose(); await flush();
});

test('P4 five-second deadline abandons late discovery; one dirty retry clears on a clean pass', async () => {
  const clock = fakeClock();
  let finish, calls = 0;
  const { manager } = makeManager({ clock, discovery: () => {
    calls++; return calls === 1 ? new Promise((done) => { finish = done; }) : Promise.resolve(emptyPlan());
  } });
  const handle = manager.attachRecovery('owner');
  await flush();
  await clock.tick(4999);
  assert.equal(manager.isRecoveryPending('owner'), true);
  await clock.tick(1);
  assert.equal(manager.isRecoveryPending('owner'), false);
  assert.equal(manager.authBlockReason('owner'), null);
  assert.equal(clock.timers.size, 1);
  assert.match(manager.getSnapshot().settled[0].message, /You can still sign out/);
  finish({ ...emptyPlan(), journals: [{ jobId: 'late' }] });
  await flush();
  assert.equal(manager.authBlockReason('owner'), null);
  await clock.tick(30000);
  assert.equal(calls, 2);
  assert.equal(clock.timers.size, 0, 'clean retry schedules no timer');
  handle.dispose(); await flush();
});

test('P4 checking deadline includes queued promotion lock; no cleanup begins after timeout', async () => {
  const clock = fakeClock();
  let runs = 0;
  const { manager, shared } = makeManager({ clock, locked: true,
    discovery: async () => ({ ...emptyPlan(), journals: [{ jobId: 'job', userId: 'owner' }] }),
    execute: async () => { runs++; },
  });
  const handle = manager.attachRecovery('owner');
  await flush();
  assert.equal(shared.queued.length, 1);
  await clock.tick(5000);
  assert.equal(shared.queued.length, 0);
  assert.equal(runs, 0);
  handle.dispose(); await flush();
});

test('P4 real mutation ignores routine deadline and disposal until its promise settles', async () => {
  const clock = fakeClock();
  let finish;
  const { manager, shared } = makeManager({ clock,
    discovery: async () => ({ ...emptyPlan(), journals: [{ jobId: 'job', userId: 'owner' }] }),
    execute: () => new Promise((done) => { finish = done; }),
  });
  const handle = manager.attachRecovery('owner');
  const pending = manager.recoverForUser('owner');
  await flush();
  assert.equal(manager.authBlockReason('owner'), 'cleanup');
  handle.dispose(); await flush();
  await clock.tick(20000);
  assert.equal(shared.locked, true);
  assert.equal(manager.authBlockReason('owner'), 'cleanup');
  finish('cancelled'); await pending; await flush();
  assert.equal(shared.locked, false);
  assert.equal(manager.authBlockReason('owner'), null);
});

test('P4 failed mutating recovery remains uid-owned cleanup-needed after account displacement', async () => {
  let fail;
  const { manager, auth } = makeManager({
    discovery: async () => ({ ...emptyPlan(), journals: [{ jobId: 'job', userId: 'owner' }] }),
    execute: () => new Promise((_, reject) => { fail = reject; }),
  });
  const pending = manager.recoverForUser('owner'); await flush();
  auth.currentUser = { uid: 'peer', getIdToken: async () => 'peer-token' };
  manager.setSessionUid('peer');
  fail(Error('real cleanup failed')); await pending; await flush();
  assert.equal(manager.getSnapshot().settled.length, 0);
  assert.equal(manager.authBlockReason('peer'), null);
  assert.equal(manager.authBlockReason('owner'), 'cleanup-needed');
});

function gateFixture() {
  const stored = new Map();
  const held = new Map();
  const queues = new Map();
  const locks = { request: (name, options, callback) => new Promise((resolve, reject) => {
    const enter = () => {
      if (options.signal?.aborted) { reject(Error('aborted')); return; }
      held.set(name, true);
      Promise.resolve().then(() => callback({ name })).then(resolve, reject).finally(() => {
        held.delete(name); queues.get(name)?.shift()?.();
      });
    };
    if (!held.has(name)) enter();
    else if (options.ifAvailable) Promise.resolve(callback(null)).then(resolve, reject);
    else {
      const queue = queues.get(name) || []; queues.set(name, queue); queue.push(enter);
      options.signal?.addEventListener('abort', () => { const i = queue.indexOf(enter); if (i >= 0) queue.splice(i, 1); reject(Error('aborted')); }, { once: true });
    }
  }) };
  let serial = 0;
  const tab = () => {
    const auth = { currentUser: { uid: 'owner', getIdToken: async () => 'token' } };
    const manager = { reason: null, paused: [], resumed: [],
      authBlockReason: () => manager.reason,
      pauseRoutine: (uid) => manager.paused.push(uid),
      resumeRoutine: (uid) => manager.resumed.push(uid),
      setSessionUid: (uid) => { manager.uid = uid; },
      isBusyForUid: () => { throw Error('general busy predicate must not gate auth'); },
    };
    const client = {};
    vm.runInNewContext(ts.transpileModule(source('src/lib/importFenceClient.ts'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
      { exports: client, require: () => ({ getAuth: () => auth }), AbortController, Error });
    const exports = {};
    const storage = {
      get length() { return stored.size; }, key: (i) => [...stored.keys()][i] ?? null,
      getItem: (key) => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value),
    };
    vm.runInNewContext(ts.transpileModule(source('src/lib/archiveJobLock.ts'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
      { exports, require: (id) => {
        if (id === 'firebase/auth') return { getAuth: () => auth };
        if (id === './importFenceClient') return client;
        if (id === './archiveTaskManager') return { getArchiveTaskManager: () => manager };
        throw Error(id);
      }, localStorage: storage, navigator: { locks }, crypto: { randomUUID: () => 'generation-' + (++serial) }, Error });
    return { ...exports, auth, manager, storage, client };
  };
  return { tab, stored, held, queues };
}

test('P5 routine/general pending does not gate auth; typed real blockers do', async () => {
  const app = gateFixture().tab();
  for (const reason of ['archive', 'cleanup', 'cleanup-needed']) {
    app.manager.reason = reason;
    let ran = false;
    const result = await app.tryAuthChange('owner', async () => { ran = true; });
    assert.equal(result.accepted, false);
    assert.equal(result.reason, reason);
    assert.equal(result.message, app.ARCHIVE_AUTH_MESSAGES[reason]);
    assert.equal(ran, false);
    assert.equal(app.isArchiveAuthIntent('owner'), false);
  }
  app.manager.reason = null;
  const pending = app.tryAuthChange('owner', async () => { app.auth.currentUser = null; });
  assert.equal(app.isArchiveAuthIntent('owner'), true, 'intent precedes the first async gap');
  assert.equal((await pending).accepted, true);
  assert.ok(app.manager.paused.includes('owner'));
});

test('P5 local legacy/malformed/storage uncertainty retains a distinct fail-closed refusal', async () => {
  for (const raw of ['', '{bad', JSON.stringify({}), JSON.stringify({ userId: 'owner' })]) {
    const env = gateFixture(), app = env.tab();
    env.stored.set('dropsync_personal_archive_import_journal', raw);
    let ran = false;
    const result = await app.tryAuthChange('owner', async () => { ran = true; });
    assert.equal(result.reason, 'local'); assert.equal(ran, false);
  }
  const app = gateFixture().tab();
  app.storage.getItem = () => { throw Error('storage denied'); };
  assert.equal((await app.tryAuthChange('owner', async () => { throw Error('must not run'); })).reason, 'local');
});

test('P5 auth wins: old-tab generations cannot promote or overwrite the new resulting uid', async () => {
  const env = gateFixture(), a = env.tab(), b = env.tab();
  const old = await a.captureArchiveRecoveryGeneration('owner');
  assert.equal(await b.captureArchiveRecoveryGeneration('owner'), old);
  assert.equal((await a.tryAuthChange('owner', async () => { a.auth.currentUser = { uid: 'peer', getIdToken: async () => 'peer-token' }; })).accepted, true);
  assert.throws(() => b.assertArchiveRecoveryGeneration('owner', old), b.client.ArchiveContextExpiredError);
  await assert.rejects(b.captureArchiveRecoveryGeneration('owner'), b.client.ArchiveContextExpiredError);
  const epoch = JSON.parse(env.stored.get(b.ARCHIVE_AUTH_EPOCH_PREFIX + 'owner'));
  assert.equal(epoch.resultUid, 'peer');
  const next = await a.captureArchiveRecoveryGeneration('peer');
  a.assertArchiveRecoveryGeneration('peer', next);
});

test('P5 actual held mutation lock refuses auth; failed callback releases intent and records actual uid', async () => {
  const env = gateFixture(), app = env.tab();
  let release;
  const mutation = app.withUserArchiveLock('owner', 'admission', () => new Promise((done) => { release = done; }));
  await flush();
  assert.equal((await app.tryAuthChange('owner', async () => { throw Error('must not run'); })).reason, 'lock');
  release(); await mutation; await flush();
  await assert.rejects(app.tryAuthChange('owner', async () => { throw Error('cancelled popup'); }), /cancelled popup/);
  assert.equal(app.isArchiveAuthIntent('owner'), false);
  assert.ok(app.manager.resumed.includes('owner'));
  const generation = await app.captureArchiveRecoveryGeneration('owner');
  app.assertArchiveRecoveryGeneration('owner', generation);
});

test('P5 crashed auth-phase marker heals under a free lock; idle foreign result is never healed by stale callback', async () => {
  const env = gateFixture(), app = env.tab(), key = app.ARCHIVE_AUTH_EPOCH_PREFIX + 'owner';
  env.stored.set(key, JSON.stringify({ generation: 'crashed', phase: 'auth', resultUid: 'owner' }));
  assert.notEqual(await app.captureArchiveRecoveryGeneration('owner'), 'crashed');
  env.stored.set(key, JSON.stringify({ generation: 'signed-out', phase: 'idle', resultUid: null }));
  await assert.rejects(app.captureArchiveRecoveryGeneration('owner'), app.client.ArchiveContextExpiredError);
  app.auth.currentUser = null;
  assert.equal((await app.tryAuthChange(null, async () => { app.auth.currentUser = { uid: 'owner', getIdToken: async () => 'new-token' }; })).accepted, true);
  app.assertArchiveRecoveryGeneration('owner', await app.captureArchiveRecoveryGeneration('owner'));
});

test('P5 real cleanup is not invalidated by a refused auth attempt', async () => {
  const app = gateFixture().tab();
  const generation = await app.captureArchiveRecoveryGeneration('owner');
  const owner = app.client.createArchiveOwnerContext('owner', generation, () => app.assertArchiveRecoveryGeneration('owner', generation));
  app.manager.reason = 'cleanup';
  const refusal = app.tryAuthChange('owner', async () => { throw Error('must not run'); });
  owner.check();
  assert.equal((await refusal).reason, 'cleanup');
  owner.check();
});

test('P6 StrictMode dispose/reacquire does not duplicate a routine pass', async () => {
  let calls = 0, finish;
  const { manager } = makeManager({ discovery: () => { calls++; return new Promise((done) => { finish = done; }); } });
  const first = manager.attachRecovery('owner'); first.dispose();
  const replay = manager.attachRecovery('owner'); await flush();
  assert.equal(calls, 1);
  finish(emptyPlan()); await manager.recoverForUser('owner');
  replay.dispose(); await flush();
});

function accountFixture({ priorState = 'none', remote = false, finalizing = false, outstanding = 0, busyAt = 0 } = {}) {
  const events = [];
  let checks = 0;
  const owner = { uid: 'owner', generation: 'foreground', check() {} };
  const auth = { currentUser: { uid: 'owner', delete: async () => events.push('auth-delete') } };
  const manager = {
    isBusyForUid: () => { events.push('busy'); return ++checks === busyAt; },
    foregroundOwner: (uid) => { assert.equal(uid, 'owner'); return owner; },
    recoverUnderHeldLock: async (uid, force, context) => {
      assert.equal(uid, 'owner'); assert.equal(context, owner); events.push('recover:' + force); return remote;
    },
  };
  const exports = {};
  const firestore = {
    doc: (_db, collection) => ({ path: collection }),
    collection: (_db, name) => ({ path: name }),
    query: (value) => value, where: () => ({}),
    getDocFromServer: async () => { events.push('barrier-read'); return { exists: () => priorState !== 'none', get: () => priorState }; },
    getDocs: async () => ({ docs: [] }),
    getDocsFromServer: async () => ({ docs: outstanding ? [{ data: () => ({ state: 'closed-cancelled', jobId: 'job' }) }] : [] }),
    deleteDoc: async () => { throw Error('must not delete product data in this scenario'); },
  };
  const modules = {
    'firebase/firestore': firestore,
    './firebase': { auth, db: {} },
    './archiveTaskManager': { getArchiveTaskManager: () => manager },
    './archiveJobLock': { withUserArchiveLock: async (uid, mode, callback) => { assert.equal(uid, 'owner'); events.push('lock:' + mode); return callback(); } },
    './accountBarriers': {
      acquireAccountBarrier: async () => { events.push('barrier-acquire'); return { ok: true, state: finalizing ? 'finalizing' : 'active' }; },
      abortAccountBarrier: async () => events.push('barrier-abort'),
    },
    './importFenceClient': { getImportFenceOutstanding: async (_job, context) => { assert.equal(context, owner); events.push('drain'); return { state: 'closed-cancelled', outstandingItems: outstanding }; } },
  };
  vm.runInNewContext(ts.transpileModule(source('src/lib/accountDeletion.ts'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { exports, require: (id) => modules[id] || {}, Error, console });
  return { events, run: () => exports.deleteAccount('owner') };
}

test('P6 account deletion keeps both busy checks, same lock and forced active-barrier foreground context', async () => {
  for (const busyAt of [1, 2]) {
    const app = accountFixture({ busyAt }); assert.equal((await app.run()).success, false);
    assert.equal(app.events.includes('recover:true'), false);
  }
  const app = accountFixture({ priorState: 'active', remote: true });
  assert.equal((await app.run()).success, false);
  assert.deepEqual(app.events, ['busy', 'lock:account', 'busy', 'barrier-read', 'recover:true']);
});

test('P6 account deletion recovers before barrier, retains finalizing resume, and rejects nonempty re-drain', async () => {
  const tail = accountFixture({ finalizing: true });
  assert.equal((await tail.run()).success, true);
  assert.deepEqual(tail.events, ['busy', 'lock:account', 'busy', 'barrier-read', 'recover:false', 'barrier-acquire', 'auth-delete']);
  const dirty = accountFixture({ outstanding: 1 });
  assert.equal((await dirty.run()).success, false);
  assert.deepEqual(dirty.events, ['busy', 'lock:account', 'busy', 'barrier-read', 'recover:false', 'barrier-acquire', 'drain', 'barrier-abort']);
});

function cleanupFixture({ deferredOwnerRead = false, ownerReadCount = 0, status = 'deleting' } = {}) {
  const app = gateFixture().tab();
  const calls = [];
  const reads = [];
  const runner = {};
  const modules = {
    'firebase/auth': { getAuth: () => app.auth },
    './importFenceClient': app.client,
    'firebase/firestore': {
      doc: () => ({}),
      getDoc: () => {
        const count = ++ownerReadCount;
        if (deferredOwnerRead && count === 1) return new Promise((done) => reads.push(done));
        return Promise.resolve({ exists: () => false });
      },
    },
  };
  vm.runInNewContext(ts.transpileModule(source('src/lib/workspaceDeletion.ts'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    exports: runner, require: (id) => modules[id] || {}, Error, console: { error() {} },
    fetch: async (url, init) => {
      calls.push({ url, authorization: init.headers.Authorization });
      return { ok: true, json: async () => url.endsWith('delete-status')
        ? { status, outstandingAttempts: [{ callDropId: 'old-call', attemptKey: 'old-attempt' }] }
        : { status: 'unresolved' } };
    },
  });
  return { ...app, runner, calls, reads };
}

test('scope amendment: deferred owner read cannot send the next request with switched-user credentials', async () => {
  const app = cleanupFixture({ deferredOwnerRead: true });
  const owner = app.client.createArchiveOwnerContext('owner', 'g1');
  const pending = app.client.awaitArchiveOwner(owner, () => app.runner.runDeletionJob('workspace', owner));
  const rejected = assert.rejects(pending, app.client.ArchiveContextExpiredError);
  await flush(); assert.equal(app.reads.length, 1);
  app.auth.currentUser = { uid: 'peer', getIdToken: async () => { throw Error('must never acquire peer credentials'); } };
  app.reads[0]({ exists: () => true, data: () => ({ deleting: true, deletingOwner: 'owner' }) });
  await rejected;
  assert.deepEqual(app.calls.map((call) => call.url), ['/api/workspaces/delete-status']);
});

test('scope amendment: coordinator waits out an incompatible generation then requeries with its own context', async () => {
  const app = cleanupFixture({ deferredOwnerRead: true });
  let generation = 'g1';
  const owner = (id) => app.client.createArchiveOwnerContext('owner', id, () => {
    if (generation !== id) throw new app.client.ArchiveContextExpiredError();
  });
  const old = app.runner.runDeletionJob('workspace', owner('g1'));
  const oldFailure = assert.rejects(old, app.client.ArchiveContextExpiredError);
  await flush();
  generation = 'g2';
  const next = app.runner.runDeletionJob('workspace', owner('g2'));
  assert.equal(app.calls.length, 1, 'new generation does not race the live old runner');
  app.reads[0]({ exists: () => true, data: () => ({ deleting: true, deletingOwner: 'owner' }) });
  await oldFailure; await next;
  assert.equal(app.calls.length, 2, 'new generation performs its own server requery');
});

test('scope amendment: existing unscoped runner caller still works', async () => {
  const app = cleanupFixture({ status: 'completed' });
  await app.runner.runDeletionJob('workspace');
  assert.equal(app.calls.length, 1);
});

test('scope amendment: checked share cleanup binds the owner across a token wait; optional caller stays compatible', async () => {
  const app = gateFixture().tab();
  let finish;
  app.auth.currentUser.getIdToken = () => new Promise((done) => { finish = done; });
  const exports = {}, calls = [];
  vm.runInNewContext(ts.transpileModule(source('src/lib/shares.ts'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { exports, Error, console: { error() {} }, require: (id) => id === './firebase' ? { auth: app.auth } : id === './importFenceClient' ? app.client : {},
      fetch: async (_url, init) => { calls.push(init.headers.Authorization); return { ok: true }; } });
  const pending = exports.deleteSharesForDropChecked('old-drop', app.client.createArchiveOwnerContext('owner'));
  app.auth.currentUser = { uid: 'peer', getIdToken: async () => 'PEER_TOKEN' };
  finish('OWNER_TOKEN');
  assert.equal(await pending, false); assert.equal(calls.length, 0);
  assert.equal(await exports.deleteSharesForDropChecked('peer-drop'), true);
  assert.deepEqual(calls, ['Bearer PEER_TOKEN']);
});

test('scope amendment: sticker cleanup keeps its original owner across pages, including optional callers', async () => {
  const app = gateFixture().tab(), exports = {}, calls = [];
  vm.runInNewContext(ts.transpileModule(source('src/lib/stickers.ts'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { exports, Error, DOMException, console, require: (id) => id === './firebase' ? { auth: app.auth } : id === './importFenceClient' ? app.client : {},
      fetch: async (_url, init) => {
        calls.push(init.headers.Authorization);
        return { ok: true, json: async () => ({ ok: true, get status() {
          app.auth.currentUser = { uid: 'peer', getIdToken: async () => { throw Error('must never acquire next-page peer token'); } };
          return 'more';
        } }) };
      } });
  await assert.rejects(exports.cleanupWorkspaceStickers('workspace'), app.client.ArchiveContextExpiredError);
  assert.deepEqual(calls, ['Bearer token']);
});

test('post-auth activation replaces a finished stale checking generation and starts a new pass', async () => {
  let calls = 0;
  const { manager } = makeManager({ discovery: async () => { calls++; return emptyPlan(); } });
  const handle = manager.attachRecovery('owner');
  await manager.recoverForUser('owner');
  assert.equal(calls, 1);
  manager.resumeRoutine('owner');
  await manager.recoverForUser('owner');
  assert.equal(calls, 2);
  handle.dispose(); await flush();
});

test('routine notices use the exact text and clear without publishing into another account', async () => {
  const notices = [];
  const { manager } = makeManager({ discovery: async () => ({ ...emptyPlan(), checkUnavailable: true }) });
  manager.setNoticeHandler((message) => notices.push(message));
  await manager.recoverForUser('owner');
  assert.ok(notices.includes('Checking for interrupted imports. You can sign out while this check runs.'));
  assert.equal(notices.at(-1), '');
  manager.setSessionUid('peer');
  assert.equal(manager.getSnapshot().settled.length, 0);
  manager.pauseRoutine('owner');
});
