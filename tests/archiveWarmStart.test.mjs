import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ts = require('typescript');
const read = (file) => fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8');
const flush = async () => { for (let i = 0; i < 160; i++) await Promise.resolve(); };
const empty = () => ({ journals: [], cancelledJobIds: [], remoteJobIds: [], checkUnavailable: false });
function clockFixture() {
  let now = 0, serial = 0;
  const timers = new Map(), frames = new Map();
  const clock = {
    now: () => now, timers, frames,
    Date: class extends Date { static now() { return now; } },
    setTimer(fn, delay) { const id = { id: ++serial, unref() {} }; timers.set(id, { fn, at: now + delay }); return id; },
    clearTimer: (id) => timers.delete(id),
    requestFrame(fn) { const id = ++serial; frames.set(id, fn); return id; },
    cancelFrame: (id) => frames.delete(id),
    jump(ms) { now += ms; },
    async frame(ms = 25) {
      now += ms;
      const pending = [...frames.values()]; frames.clear();
      for (const fn of pending) fn();
      await flush();
    },
    async tick(ms) {
      const until = now + ms;
      for (;;) {
        const due = [...timers].filter(([, x]) => x.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]); now = Math.max(now, due[1].at);
        due[1].fn(); await flush();
      }
      now = Math.max(now, until); await flush();
    },
  };
  return clock;
}
function load(file, deps, globals) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(read(file), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText, { exports, Error, console, AbortController, queueMicrotask,
    require: (id) => { assert.ok(Object.hasOwn(deps, id), id); return deps[id]; }, ...globals });
  return exports;
}
function warmFixture() {
  const clock = clockFixture();
  const warm = load('src/lib/archiveWarmStart.ts', {}, {
    performance: { now: clock.now }, Date: clock.Date,
    setTimeout: clock.setTimer, clearTimeout: clock.clearTimer,
    requestAnimationFrame: clock.requestFrame, cancelAnimationFrame: clock.cancelFrame,
  });
  return { clock, warm };
}
function appFixture(t, { withoutWindow = false } = {}) {
  const { clock, warm } = warmFixture();
  const auth = { currentUser: { uid: 'owner', getIdToken: async () => 'owner-token' } };
  const client = load('src/lib/importFenceClient.ts', { 'firebase/auth': { getAuth: () => auth } }, {});
  class CheckError extends Error {}
  class CleanupError extends Error {}
  class CoordinationError extends Error {}
  const state = { reads: [], locks: [], captures: 0, intent: false, generation: 'g1',
    discover: async () => empty(), personal: async () => empty(), execute: async () => 'cancelled',
    certify: async (plan) => plan, storage: [], locked: false, queued: [], mutations: 0 };
  const lock = (uid, mode, callback, signal) => new Promise((resolve, reject) => {
    state.locks.push([uid, mode]);
    const enter = () => {
      if (signal?.aborted) { reject(new client.ArchiveContextExpiredError()); return; }
      state.locked = true;
      Promise.resolve().then(callback).then(resolve, reject).finally(() => {
        state.locked = false; state.queued.shift()?.();
      });
    };
    if (!state.locked) enter();
    else {
      state.queued.push(enter);
      signal?.addEventListener('abort', () => {
        state.queued = state.queued.filter((x) => x !== enter);
        reject(new client.ArchiveContextExpiredError());
      }, { once: true });
    }
  });
  const window = withoutWindow ? undefined : { addEventListener: (_name, fn) => state.storage.push(fn) };
  const workspace = { ArchiveCheckUnavailableError: CheckError, ArchiveCleanupNeededError: CleanupError,
    discoverInterruptedWorkspaceArchiveImport: (...args) => { state.reads.push(args[0]); return state.discover(...args); },
    certifyArchiveRecoveryPlan: (...args) => state.certify(...args),
    recoverArchiveFenceJob: (...args) => { state.mutations++; return state.execute(...args); },
    recoverInterruptedWorkspaceArchiveImport: async () => false };
  const modules = load('src/lib/archiveTaskManager.ts', {
    './archiveWarmStart': warm, './importFenceClient': client, './workspaceArchive': workspace,
    './personalArchive': { discoverInterruptedPersonalArchiveImport: (...args) => state.personal(...args),
      recoverInterruptedPersonalArchiveImport: async () => false },
    './archiveJobLock': { ArchiveLockBusyError: CoordinationError, ArchiveLockUnavailableError: CoordinationError,
      ArchiveCoordinationError: CoordinationError, ARCHIVE_AUTH_EPOCH_PREFIX: 'epoch_',
      isArchiveAuthIntent: () => state.intent, canResumeArchiveSession: () => true,
      currentArchiveRecoveryGeneration: () => state.generation,
      captureArchiveRecoveryGeneration: async () => { state.captures++; return state.generation; },
      assertArchiveRecoveryGeneration: (_uid, value) => {
        if (value !== state.generation) throw new client.ArchiveContextExpiredError();
      }, withUserArchiveLock: lock },
  }, { window, Date: clock.Date, performance: { now: clock.now },
    setTimeout: clock.setTimer, clearTimeout: clock.clearTimer });
  const manager = new modules.ArchiveTaskManager();
  manager.setSessionUid('owner', auth.currentUser);
  manager.markRecoveryPending('owner');
  const handles = [];
  const attach = (uid = auth.currentUser.uid) => { const h = manager.attachRecovery(uid); handles.push(h); return h; };
  t.after(async () => { for (const h of handles) h.dispose(); await flush();
    manager.pauseRoutine('owner'); manager.pauseRoutine('peer'); await flush(); });
  return { clock, manager, state, window, auth, attach, CheckError, client };
}
const quiet = async (clock, count = 11) => { for (let i = 0; i < count; i++) await clock.frame(); };
const descriptor = () => ({ uid: 'owner', jobId: 'requested', kind: 'import', scope: 'workspace', sourceDropIds: [], startedAt: 0 });

test('helper constants are the locked policy', () => {
  const { warm } = warmFixture();
  assert.deepEqual([warm.ARCHIVE_STARTUP_GRACE_MS, warm.ARCHIVE_QUIET_MS,
    warm.ARCHIVE_MAX_FRAME_GAP_MS, warm.ARCHIVE_MIN_FRAMES], [8000, 250, 50, 3]);
});
test('helper needs readiness, full quiet span and frames, then activates once', async () => {
  const { clock, warm } = warmFixture(), starts = [];
  const lease = warm.deferArchiveCheck(0, (reason) => starts.push(reason), clock);
  await quiet(clock); assert.deepEqual(starts, []);
  lease.setReady(true, 0);
  await quiet(clock, 10); assert.deepEqual(starts, []);
  await clock.frame(); assert.deepEqual(starts, ['warm']);
  assert.equal(clock.timers.size, 0); assert.equal(clock.frames.size, 0);
  lease.setReady(true, 1); await clock.tick(9000); assert.deepEqual(starts, ['warm']);
});
test('helper long gap, false readiness and scope changes reset only quiet sampling', async () => {
  const { clock, warm } = warmFixture(), starts = [];
  const lease = warm.deferArchiveCheck(0, (reason) => starts.push(reason), clock);
  lease.setReady(true, 0);
  await quiet(clock, 8);
  await clock.frame(51); await quiet(clock, 8); assert.deepEqual(starts, []);
  lease.setReady(true, 1); await quiet(clock, 8); assert.deepEqual(starts, []);
  lease.setReady(false, 1); assert.equal(clock.frames.size, 0);
  lease.setReady(true, 1); await quiet(clock);
  assert.deepEqual(starts, ['warm']);
});
test('helper has one absolute fallback even without frames/readiness and after late delivery', async () => {
  for (const late of [false, true]) {
    const { clock, warm } = warmFixture(), starts = [];
    const lease = warm.deferArchiveCheck(0, (reason) => starts.push([reason, clock.now()]), { ...clock, requestFrame: undefined });
    lease.setReady(false, 10);
    assert.equal(clock.timers.size, 1);
    if (late) { clock.jump(9000); await clock.tick(0); }
    else { await clock.tick(7999); assert.deepEqual(starts, []); await clock.tick(1); }
    assert.deepEqual(starts, [['bound', late ? 9000 : 8000]]);
    assert.equal(clock.timers.size, 0);
  }
});
test('helper rechecks early timeout delivery without moving the absolute bound', async () => {
  const { clock, warm } = warmFixture(), starts = [];
  warm.deferArchiveCheck(0, (reason) => starts.push(reason), clock);
  const [id, timer] = [...clock.timers][0];
  clock.timers.delete(id); timer.fn();
  assert.deepEqual(starts, []);
  await clock.tick(8000); assert.deepEqual(starts, ['bound']);
});
test('helper cancellation clears both callbacks and ignores late callback delivery', async () => {
  const { clock, warm } = warmFixture(), starts = [];
  const lease = warm.deferArchiveCheck(0, (reason) => starts.push(reason), clock);
  lease.setReady(true, 0);
  const timer = [...clock.timers.values()][0].fn;
  const frame = [...clock.frames.values()][0];
  lease.cancel();
  assert.equal(clock.timers.size + clock.frames.size, 0);
  clock.jump(9000); timer(); frame(); lease.setReady(true, 1);
  assert.deepEqual(starts, []);
});

test('manager deferral is silent, lock-free and not an auth blocker; bound is unavoidable', async (t) => {
  const app = appFixture(t);
  app.attach();
  await app.clock.tick(7999);
  assert.equal(app.state.reads.length, 0); assert.equal(app.state.captures, 0);
  assert.equal(app.state.locks.length, 0); assert.equal(app.manager.getSnapshot().settled.length, 0);
  assert.equal(app.manager.isRecoveryPending('owner'), true);
  assert.equal(app.manager.authBlockReason('owner'), null);
  assert.equal(app.manager.isBusyForUid('owner'), true);
  assert.equal(app.window.__dropsyncArchiveCheckDiag, undefined);
  assert.equal(app.window.__dropsyncArchiveCheckSchedule.phase, 'deferred');
  await app.clock.tick(1);
  assert.deepEqual(app.state.reads, ['owner']);
  assert.equal(app.window.__dropsyncArchiveCheckSchedule.phase, 'settled');
  assert.equal(app.window.__dropsyncArchiveCheckSchedule.trigger, 'bound');
  assert.equal(app.window.__dropsyncArchiveCheckSchedule.deferredMs, 8000);
  assert.equal(app.window.__dropsyncArchiveCheckDiag, null);
});
test('manager combines all ready votes and same-value updates do not reset quiet time', async (t) => {
  const app = appFixture(t), a = app.attach(), b = app.attach();
  a.setReady(true, 0); await quiet(app.clock); assert.equal(app.state.reads.length, 0);
  b.setReady(true, 0);
  await quiet(app.clock, 8); a.setReady(true, 0); b.setReady(true, 0);
  await quiet(app.clock, 3);
  assert.equal(app.state.reads.length, 1);
  assert.equal(app.window.__dropsyncArchiveCheckSchedule.trigger, 'warm');
  a.setReady(false, 1); await app.clock.tick(8000); assert.equal(app.state.reads.length, 1);
});
test('manager readiness scope resets quiet time but cannot restart grace', async (t) => {
  const app = appFixture(t), h = app.attach();
  h.setReady(true, 0); await quiet(app.clock, 8);
  h.setReady(true, 1); await quiet(app.clock, 8); assert.equal(app.state.reads.length, 0);
  h.setReady(false, 2);
  await app.clock.tick(8000 - app.clock.now());
  assert.equal(app.state.reads.length, 1);
  assert.equal(app.window.__dropsyncArchiveCheckSchedule.trigger, 'bound');
});
test('pending origin predates owner attachment and no-owner pending starts no work', async (t) => {
  const app = appFixture(t);
  await app.clock.tick(3000);
  assert.equal(app.clock.timers.size, 0); assert.equal(app.state.reads.length, 0);
  app.attach();
  await app.clock.tick(4999); assert.equal(app.state.reads.length, 0);
  await app.clock.tick(1); assert.equal(app.state.reads.length, 1);
  assert.equal(app.window.__dropsyncArchiveCheckSchedule.deferredMs, 8000);
});
test('expired pending origin activates immediately on late Home attachment', async (t) => {
  const app = appFixture(t);
  await app.clock.tick(9000); app.attach(); await flush();
  assert.equal(app.state.reads.length, 1);
  assert.equal(app.window.__dropsyncArchiveCheckSchedule.trigger, 'bound');
  assert.equal(app.window.__dropsyncArchiveCheckSchedule.deferredMs, 9000);
});
test('StrictMode reacquisition keeps run promise and original deadline', async (t) => {
  const app = appFixture(t), one = app.attach();
  const done = app.manager.routines.get('owner').done;
  await app.clock.tick(2000); one.dispose(); app.attach(); await flush();
  assert.equal(app.manager.routines.get('owner').done, done);
  await app.clock.tick(5999); assert.equal(app.state.reads.length, 0);
  await app.clock.tick(1); await done;
  assert.equal(app.state.reads.length, 1);
});
test('last-owner cancellation settles waiters and removes pending/timers/frames', async (t) => {
  const app = appFixture(t), h = app.attach(); h.setReady(true, 0);
  let ended = false;
  app.manager.routines.get('owner').done.then(() => { ended = true; });
  h.dispose(); await flush();
  assert.equal(ended, true); assert.equal(app.manager.isRecoveryPending('owner'), false);
  assert.equal(app.clock.timers.size + app.clock.frames.size, 0);
  assert.equal(app.window.__dropsyncArchiveCheckSchedule.phase, 'cancelled');
  await app.clock.tick(5000); app.attach(); await app.clock.tick(3000);
  assert.equal(app.state.reads.length, 1, 'reacquisition cannot get a fresh grace');
});
test('stale handles and activation callbacks cannot affect a new session', async (t) => {
  const app = appFixture(t), old = app.attach();
  const oldActivate = app.manager.routines.get('owner').activate;
  await app.clock.tick(1000);
  app.auth.currentUser = { uid: 'peer', getIdToken: async () => 'peer-token' };
  app.manager.setSessionUid('peer', app.auth.currentUser); app.manager.markRecoveryPending('peer');
  const fresh = app.attach('peer');
  old.setReady(true, 50); oldActivate('bound'); await quiet(app.clock);
  assert.equal(app.state.reads.length, 0); assert.equal(app.manager.isRecoveryPending('peer'), true);
  fresh.setReady(true, 0); await quiet(app.clock);
  assert.deepEqual(app.state.reads, ['peer']);
  assert.equal(app.window.__dropsyncArchiveCheckSchedule.trigger, 'warm');
});
test('pending foreground kick before attachment is idempotent and owner-bound', async (t) => {
  const app = appFixture(t); let finish;
  app.state.discover = () => new Promise((resolve) => { finish = resolve; });
  app.manager.kickRecoveryIfPending('peer'); assert.equal(app.state.reads.length, 0);
  app.manager.kickRecoveryIfPending('owner'); app.manager.kickRecoveryIfPending('owner');
  const one = app.manager.recoverForUser('owner'), two = app.manager.recoverForUser('owner');
  assert.equal(one, two); await flush();
  assert.equal(app.state.reads.length, 1); app.attach();
  assert.equal(app.window.__dropsyncArchiveCheckSchedule.trigger, 'foreground');
  finish(empty()); await one;
  app.manager.kickRecoveryIfPending('owner'); assert.equal(app.state.reads.length, 1);
});
test('archive admission kicks and refuses without reservation or deferred replay', async (t) => {
  const app = appFixture(t); app.attach(); let finish;
  app.state.discover = () => new Promise((resolve) => { finish = resolve; });
  assert.throws(() => app.manager.reserveForStart(descriptor()), /Archive recovery is still being checked. Try again shortly./);
  await flush();
  assert.equal(app.state.reads.length, 1); assert.equal(app.manager.reservation, null);
  assert.equal(app.manager.getSnapshot().active, null);
  assert.throws(() => app.manager.reserveForStart(descriptor()), /still being checked/);
  assert.equal(app.state.reads.length, 1);
  finish(empty()); await flush();
  assert.equal(app.manager.reservation, null);
  app.manager.reserveForStart(descriptor()); app.manager.releaseReservation('requested');
});
test('explicit check expedites same promise and gets 5000ms after activation', async (t) => {
  const app = appFixture(t); app.attach();
  const original = app.manager.routines.get('owner').done;
  await app.clock.tick(3000);
  app.state.discover = () => new Promise(() => {});
  assert.equal(app.manager.recoverForUser('owner'), original); await flush();
  await app.clock.tick(4999); assert.equal(app.manager.isRecoveryPending('owner'), true);
  await app.clock.tick(1); await original;
  assert.equal(app.window.__dropsyncArchiveCheckDiag.cause, 'deadline');
  assert.equal(app.window.__dropsyncArchiveCheckDiag.elapsedCheckingMs, 5000);
  assert.equal(app.window.__dropsyncArchiveCheckSchedule.deferredMs, 3000);
});
test('dirty retry has exactly one 30-second timer, no grace, and clears on success', async (t) => {
  const app = appFixture(t);
  app.state.discover = async () => { throw new app.CheckError(); };
  app.attach(); await app.clock.tick(8000);
  assert.equal(app.state.reads.length, 1); assert.equal(app.clock.timers.size, 1);
  await app.clock.tick(29999); assert.equal(app.state.reads.length, 1);
  await app.clock.tick(1); assert.equal(app.state.reads.length, 2);
  assert.equal(app.window.__dropsyncArchiveCheckSchedule.trigger, 'retry');
  assert.equal(app.window.__dropsyncArchiveCheckSchedule.deferredMs, 0);
  app.state.discover = async () => empty(); await app.clock.tick(30000);
  assert.equal(app.state.reads.length, 3); assert.equal(app.clock.timers.size, 0);
  assert.equal(app.window.__dropsyncArchiveCheckDiag, null);
});
test('known cleanup bypasses startup grace and retains Error without proof', async (t) => {
  const app = appFixture(t);
  app.manager.publishRecoveryFailure('owner', 'cleanup-needed', 'known cleanup');
  app.attach(); await flush();
  assert.equal(app.state.reads.length, 1);
  assert.equal(app.manager.getSnapshot().settled[0].status, 'cleanup-needed');
  assert.equal(app.manager.authBlockReason('owner'), 'cleanup-needed');
});
test('queued promotion deadline aborts before cleanup starts', async (t) => {
  const app = appFixture(t);
  app.state.locked = true;
  app.state.discover = async () => ({ ...empty(), journals: [{ jobId: 'known', userId: 'owner' }] });
  const done = app.manager.recoverForUser('owner'); await flush();
  assert.equal(app.state.queued.length, 1);
  await app.clock.tick(5000); await done;
  assert.equal(app.state.mutations, 0); assert.equal(app.state.queued.length, 0);
});
test('live mutation remains awaited beyond both windows and owner disposal', async (t) => {
  const app = appFixture(t); let finish;
  app.state.discover = async () => ({ ...empty(), journals: [{ jobId: 'known', userId: 'owner' }] });
  app.state.execute = () => new Promise((resolve) => { finish = resolve; });
  const h = app.attach(); const done = app.manager.recoverForUser('owner'); await flush();
  assert.equal(app.manager.authBlockReason('owner'), 'cleanup');
  h.dispose(); await flush(); await app.clock.tick(20000);
  assert.equal(app.state.locked, true); assert.equal(app.manager.authBlockReason('owner'), 'cleanup');
  finish('cancelled'); await done; await flush();
  assert.equal(app.state.locked, false); assert.equal(app.manager.authBlockReason('owner'), null);
});
test('readouts expose only four coarse fields each, with no owner or scope data', async (t) => {
  const app = appFixture(t);
  app.state.discover = async () => { throw new app.CheckError(); };
  await app.manager.recoverForUser('owner');
  assert.deepEqual(Object.keys(app.window.__dropsyncArchiveCheckSchedule).sort(), ['at', 'deferredMs', 'phase', 'trigger']);
  assert.deepEqual(Object.keys(app.window.__dropsyncArchiveCheckDiag).sort(), ['aborted', 'at', 'cause', 'elapsedCheckingMs']);
  assert.equal(JSON.stringify(app.window.__dropsyncArchiveCheckSchedule).includes('owner'), false);
  assert.equal(Object.keys(app.manager.getSnapshot()).includes('routineCheckFailures'), false);
});
test('manager is safe without window', async (t) => {
  const app = appFixture(t, { withoutWindow: true });
  await app.manager.recoverForUser('owner');
  app.state.discover = async () => { throw Error('read failure'); };
  app.manager.pauseRoutine('owner'); await app.manager.recoverForUser('owner');
  assert.equal(app.manager.authBlockReason('owner'), null);
});

test('epoch restart preserves the startup bound and ignores the cancelled lease', async (t) => {
  const app = appFixture(t), handle = app.attach();
  const old = app.manager.routines.get('owner');
  let ended = false; old.done.then(() => { ended = true; });
  await app.clock.tick(3000);
  app.state.generation = 'g2';
  app.state.storage[0]({ key: 'epoch_owner' }); await flush();
  assert.equal(ended, true);
  old.activate('bound'); assert.equal(app.state.reads.length, 0);
  handle.setReady(false, 2);
  await app.clock.tick(4999); assert.equal(app.state.reads.length, 0);
  await app.clock.tick(1); assert.equal(app.state.reads.length, 1);
  assert.equal(app.window.__dropsyncArchiveCheckSchedule.deferredMs, 8000);
});
test('pre-mutation budget guard catches late lock delivery before a delayed timeout', async (t) => {
  const app = appFixture(t);
  app.state.locked = true;
  app.state.discover = async () => ({ ...empty(), journals: [{ jobId: 'known', userId: 'owner' }] });
  const done = app.manager.recoverForUser('owner'); await flush();
  app.clock.jump(6000);
  const enter = app.state.queued.shift(); enter(); await done; await flush();
  assert.equal(app.state.mutations, 0);
  assert.equal(app.window.__dropsyncArchiveCheckDiag.cause, 'deadline');
});
test('cancelling an actual checking read settles without a failure diagnostic', async (t) => {
  const app = appFixture(t), h = app.attach();
  app.state.discover = () => new Promise(() => {});
  const done = app.manager.recoverForUser('owner'); await flush();
  h.dispose(); await done; await flush();
  assert.equal(app.window.__dropsyncArchiveCheckDiag, undefined);
  assert.equal(app.window.__dropsyncArchiveCheckSchedule.phase, 'cancelled');
  assert.equal(app.manager.isRecoveryPending('owner'), false);
});
test('auth intent at warm/bound activation cancels rather than stranding a consumed lease', async (t) => {
  for (const bound of [false, true]) {
    const app = appFixture(t), h = app.attach();
    const original = app.manager.routines.get('owner').done;
    app.state.intent = true;
    assert.equal(app.manager.recoverForUser('owner'), original);
    app.manager.kickRecoveryIfPending('owner');
    if (bound) await app.clock.tick(8000);
    else { h.setReady(true, 0); await quiet(app.clock); }
    await original;
    assert.equal(app.state.reads.length, 0);
    assert.equal(app.manager.isRecoveryPending('owner'), false);
    assert.equal(app.window.__dropsyncArchiveCheckSchedule.phase, 'cancelled');
    app.state.intent = false;
    app.manager.resumeRoutine('owner');
    await app.clock.tick(Math.max(0, 8000 - app.clock.now()));
    assert.equal(app.state.reads.length, 1);
  }
});
test('wall-clock jumps do not restart monotonic startup grace', async (t) => {
  const app = appFixture(t); app.attach();
  app.clock.Date.now = () => -100000;
  await app.clock.tick(8000);
  assert.equal(app.state.reads.length, 1);
  assert.equal(app.window.__dropsyncArchiveCheckSchedule.deferredMs, 8000);
});
