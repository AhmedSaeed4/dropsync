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

function makeManager({ locked = false, recovery = async () => false, personal = async () => false } = {}) {
  const events = [];
  class CleanupError extends Error {}
  class CheckUnavailableError extends Error {}
  class LockBusyError extends Error {}
  class LockUnavailableError extends Error {}
  const dependencies = {
    './workspaceArchive': { ArchiveCleanupNeededError: CleanupError, ArchiveCheckUnavailableError: CheckUnavailableError, recoverInterruptedWorkspaceArchiveImport: recovery },
    './personalArchive': { recoverInterruptedPersonalArchiveImport: personal },
    './archiveJobLock': {
      ArchiveLockBusyError: LockBusyError,
      ArchiveLockUnavailableError: LockUnavailableError,
      withUserArchiveLock: async (_uid, mode, callback) => {
        events.push('lock:' + mode);
        if (locked) throw new LockBusyError('another tab owns the lock');
        return callback();
      },
    },
  };
  const js = ts.transpileModule(source('src/lib/archiveTaskManager.ts'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(js, { exports, require: (id) => dependencies[id], setTimeout, clearTimeout, AbortController, Date, Error, console }, { filename: 'archiveTaskManager.ts' });
  return { manager: new exports.ArchiveTaskManager(), events, CleanupError, CheckUnavailableError, LockBusyError };
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
  const { manager, CheckUnavailableError } = makeManager({
    recovery: async () => { throw new CheckUnavailableError('denied'); },
    personal: async () => { ran.push('personal'); return false; },
  });
  await manager.recoverForUser('owner');
  const card = manager.getSnapshot().settled[0];
  assert.equal(card.status, 'failed');
  assert.match(card.message, /Could not check for interrupted imports/);
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

test('a lock held elsewhere during recovery settles as a dismissible error', async () => {
  const { manager } = makeManager({ locked: true });
  await manager.recoverForUser('owner');
  const card = manager.getSnapshot().settled[0];
  assert.equal(card.status, 'failed');
  assert.match(card.message, /another tab/);
  manager.reserveForStart(descriptor('two'));
});

test('a real recovery failure still settles as cleanup-needed and blocks', async () => {
  const { manager } = makeManager({ recovery: async () => { throw new Error('ledger remains'); } });
  await manager.recoverForUser('owner');
  assert.equal(manager.getSnapshot().settled[0].status, 'cleanup-needed');
  assert.throws(() => manager.reserveForStart(descriptor('two')), /cleanup is incomplete/);
});

test('recovery sources still run local journals when the fence list is unavailable', () => {
  for (const file of ['src/lib/workspaceArchive.ts', 'src/lib/personalArchive.ts']) {
    const body = source(file);
    const list = body.indexOf('try { fences = await listOwnedArchiveFences(userId); } catch');
    const work = body.indexOf('await recoverArchiveFenceJob(', list);
    const unavailable = body.indexOf('throw new ArchiveCheckUnavailableError();', work);
    assert.ok(list > 0 && work > list && unavailable > work, file);
  }
});

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
  const close = recovery.indexOf('await cancelImportFence(journal.jobId, localInterrupted)');
  const deletes = recovery.indexOf('for (const id of obligationIds)', close);
  const ack = recovery.indexOf('await ackImportItems(journal.jobId', deletes);
  assert.ok(close > 0 && deletes > close && ack > deletes);
  const keyAck = recovery.indexOf("await ackImportItems(journal.jobId, ['key:' + journal.workspaceId])");
  const parentDelete = recovery.indexOf('await startWorkspaceDeletion(journal.workspaceId', keyAck);
  assert.ok(keyAck > 0 && parentDelete > keyAck);
  const account = source('src/lib/accountDeletion.ts');
  assert.ok(account.indexOf('recoverUnderHeldLock(userId)') < account.indexOf('const barrier = await acquireAccountBarrier()'));
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
  const fenceProbeAt = recovery.indexOf('const fenceProbe = await probeImportItems(journal.jobId, [fenceProbeId]);');
  const ledgerAt = recovery.indexOf('const ledger = await getDocsFromServer(', fenceProbeAt);
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
