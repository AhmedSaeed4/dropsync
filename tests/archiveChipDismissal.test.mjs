import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire, register } from 'node:module';

register('./helpers/hook-module-loader.mjs', import.meta.url);
const { JSDOM } = await import('jsdom');
const require = createRequire(import.meta.url);
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const read = (name) => fs.readFileSync(new URL('../' + name, import.meta.url), 'utf8');
const copy = (value) => JSON.parse(JSON.stringify(value));
const flush = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };

// Frozen pre-build chip: non-notice output must remain byte-identical.
const baselineChipSource = "'use client';\n\nimport type { ArchiveDisplaySnapshot, ArchiveSettledSnapshot } from '@/lib/archiveTaskManager';\n\nexport function ArchiveProgressChip({ item, overflowCount, contrast, onOpen, onCancel, onDismiss, onOverflow }: {\n  item: ArchiveDisplaySnapshot | ArchiveSettledSnapshot;\n  overflowCount: number;\n  contrast: boolean;\n  onOpen: () => void;\n  onCancel: () => void;\n  onDismiss: () => void;\n  onOverflow: () => void;\n}) {\n  const active = 'currentName' in item ? item : null;\n  const isError = item.status === 'failed' || item.status === 'cleanup-needed';\n  const label = item.status === 'succeeded' ? '✓ Saved'\n    : item.status === 'cancelling' ? 'Cancelling'\n      : item.status === 'finalizing' ? 'Finalizing'\n        : isError ? 'Error'\n          : item.kind === 'import' ? 'Importing' : 'Exporting';\n  const showDismiss = item.status === 'failed';\n  const showCancel = !!active?.canCancel;\n  const control = showDismiss ? onDismiss : showCancel ? onCancel : undefined;\n  const controlLabel = showDismiss ? 'Dismiss archive error' : showCancel ? `Cancel ${item.kind}` : 'Unavailable';\n  return (\n    <div className={`archive-chip-row relative w-[300px] max-[639px]:w-[min(360px,calc(100vw-28px))] h-[26px] max-[639px]:h-11 pointer-events-auto ${contrast ? 'mix-blend-difference text-white' : 'text-current'}`} role={isError ? 'alert' : 'status'} aria-live={isError ? 'assertive' : 'polite'}>\n      <div className=\"grid h-full w-full grid-cols-[11px_68px_64px_30px_60px_26px] gap-[7px] items-center max-[639px]:grid-cols-[9px_66px_minmax(0,52px)_30px_minmax(28px,1fr)_44px] max-[639px]:gap-[6px]\">\n        {isError\n          ? <span className=\"text-[11px]\" aria-hidden>!</span>\n          : item.status === 'succeeded'\n            ? <span className=\"text-[11px]\" aria-hidden>✓</span>\n            : <span className=\"w-[11px] h-[11px] max-[639px]:w-[9px] max-[639px]:h-[9px] border border-current/30 border-t-current rounded-full animate-spin\" aria-hidden />}\n        <button type=\"button\" onClick={onOpen} className=\"min-w-0 text-left text-[11px] font-mono uppercase tracking-tight truncate\" aria-label={`Open ${item.kind} details`}>{label}</button>\n        <button type=\"button\" onClick={onOpen} className=\"min-w-0 text-left text-[11px] truncate\" title={active?.currentName || item.message}>{active?.currentName || ''}</button>\n        <span className=\"text-right text-[10px] tabular-nums\">{active?.percent === null || active?.percent === undefined ? '' : `${active.percent}%`}</span>\n        <div className=\"relative h-[2px] bg-current/25\" aria-hidden>\n          {active?.percent !== null && active?.percent !== undefined && <div className=\"absolute inset-y-0 left-0 bg-current\" style={{ width: `${active.percent}%` }} />}\n          {overflowCount > 0 && <button type=\"button\" onClick={onOverflow} className=\"absolute inset-[-12px] flex items-center justify-center bg-inherit text-[10px] font-mono\" aria-label={`Show ${overflowCount} more archive errors`}>+{overflowCount}</button>}\n        </div>\n        <button type=\"button\" disabled={!control} onClick={control} aria-label={controlLabel} className=\"h-[26px] w-[26px] max-[639px]:h-11 max-[639px]:w-11 text-center text-lg disabled:opacity-0\">×</button>\n      </div>\n    </div>\n  );\n}\n";

function loadSource(source, dependencies, globals = {}) {
  const exports = {};
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  vm.runInNewContext(code, {
    exports, console, Error, AbortController, queueMicrotask,
    require: (id) => {
      if (Object.hasOwn(dependencies, id)) return dependencies[id];
      throw Error('Unexpected dependency: ' + id);
    },
    ...globals,
  });
  return exports;
}
const load = (file, dependencies, globals) => loadSource(read(file), dependencies, globals);

function fakeClock() {
  let now = 0;
  const timers = new Map();
  return {
    Date: class extends Date { static now() { return now; } },
    setTimeout(callback, delay) {
      const handle = { unref() {} };
      timers.set(handle, { callback, at: now + delay });
      return handle;
    },
    clearTimeout(handle) { timers.delete(handle); },
    now: () => now,
    elapse: (ms) => { now += ms; },
    due: () => [...timers.values()].map((timer) => timer.at - now),
    async tick(ms) {
      const target = now + ms;
      for (;;) {
        const next = [...timers.entries()].filter(([, timer]) => timer.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        timers.delete(next[0]);
        now = Math.max(now, next[1].at);
        next[1].callback();
        await flush();
      }
      now = Math.max(now, target);
      await flush();
    },
  };
}

const emptyPlan = () => ({ journals: [], remoteJobIds: [], checkUnavailable: false });
function fixture(t, { withoutWindow = false, managerSource = read('src/lib/archiveTaskManager.ts') } = {}) {
  const clock = fakeClock();
  const storageListeners = [];
  const window = withoutWindow ? undefined : { addEventListener(_name, callback) { storageListeners.push(callback); } };
  const auth = { currentUser: { uid: 'owner', getIdToken: async () => 'test-token' } };
  const owner = load('src/lib/importFenceClient.ts', { 'firebase/auth': { getAuth: () => auth } });
  // Use the real three coordination constructors, including the newly exported one.
  const locks = load('src/lib/archiveJobLock.ts', {
    'firebase/auth': { getAuth: () => auth }, './importFenceClient': owner,
  });
  class ArchiveCheckUnavailableError extends Error {}
  class ArchiveCleanupNeededError extends Error {}
  const state = {
    discover: async () => { throw new ArchiveCheckUnavailableError('test check unavailable'); },
    personal: async () => emptyPlan(),
    certify: async (plan) => plan,
    execute: async () => undefined,
    recover: async () => false,
    recoverPersonal: async () => false,
    passes: 0,
    cleanups: 0,
  };
  const workspace = {
    ArchiveCheckUnavailableError, ArchiveCleanupNeededError,
    discoverInterruptedWorkspaceArchiveImport: (...args) => { state.passes++; return state.discover(...args); },
    discoverInterruptedPersonalArchiveImport: (...args) => state.personal(...args),
    certifyArchiveRecoveryPlan: (...args) => state.certify(...args),
    recoverArchiveFenceJob: (...args) => { state.cleanups++; return state.execute(...args); },
    recoverInterruptedWorkspaceArchiveImport: (...args) => state.recover(...args),
    recoverInterruptedPersonalArchiveImport: (...args) => state.recoverPersonal(...args),
  };
  const warm = load('src/lib/archiveWarmStart.ts', {}, {
    Date: clock.Date, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
  });
  const modules = loadSource(managerSource, {
    './archiveWarmStart': warm,
    './workspaceArchive': workspace,
    './personalArchive': workspace,
    './importFenceClient': owner,
    './archiveJobLock': {
      ...locks,
      captureArchiveRecoveryGeneration: async () => 'generation',
      currentArchiveRecoveryGeneration: () => 'generation',
      assertArchiveRecoveryGeneration() {},
      isArchiveAuthIntent: () => false,
      canResumeArchiveSession: () => true,
      withUserArchiveLock: async (_uid, _mode, callback) => callback(),
    },
  }, {
    window, Date: clock.Date, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
  });
  const manager = new modules.ArchiveTaskManager();
  manager.setSessionUid('owner');
  let attachment;
  t.after(async () => { attachment?.dispose(); await flush(); });
  return {
    manager, state, window, clock, locks, auth, ArchiveCheckUnavailableError,
    item: () => manager.getSnapshot().settled[0],
    stopAttachment() { attachment?.dispose(); attachment = undefined; },
    storage: (key) => storageListeners.forEach((listener) => listener({ key })),
    async start() { attachment = manager.attachRecovery('owner'); void manager.recoverForUser('owner'); await flush(); },
    async retry() { await clock.tick(30000); },
  };
}

test('fresh routine failure is silent with diagnostics; persistent failure is a dismissible Notice', async (t) => {
  const app = fixture(t);
  app.state.discover = async () => {
    app.clock.elapse(17);
    throw new app.ArchiveCheckUnavailableError('private detail must not be exposed');
  };
  await app.start();
  assert.equal(app.item(), undefined);
  assert.deepEqual(copy(app.window.__dropsyncArchiveCheckDiag), {
    cause: 'check-unavailable', elapsedCheckingMs: 17, aborted: false, at: 17,
  });
  assert.equal(app.manager.authBlockReason('owner'), null);
  assert.deepEqual(app.clock.due(), [30000]);
  await app.retry();
  const item = app.item();
  assert.equal(item.status, 'failed'); assert.equal(item.dismissed, false);
  assert.equal(item.notice, true); assert.equal(item.cause, 'check-unavailable');
  assert.equal(item.elapsedCheckingMs, 17);
});

test('dismissal survives real 30-second failed retries while diagnostics keep updating', async (t) => {
  const app = fixture(t);
  await app.start(); assert.equal(app.item(), undefined);
  await app.retry(); app.manager.dismissVerifiedError(app.item().jobId);
  const firstSettledAt = app.item().settledAt;
  await app.clock.tick(29999);
  assert.equal(app.state.passes, 2); assert.equal(app.item().dismissed, true);
  await app.clock.tick(1);
  assert.equal(app.state.passes, 3); assert.equal(app.item().dismissed, true);
  assert.equal(app.item().notice, true); assert.ok(app.item().settledAt > firstSettledAt);
  assert.equal(app.window.__dropsyncArchiveCheckDiag.at, 60000);
  app.state.discover = async () => { throw Error('changed private failure'); };
  await app.retry();
  assert.equal(app.state.passes, 4); assert.equal(app.item().dismissed, true);
  assert.equal(app.item().cause, 'other'); assert.equal(app.window.__dropsyncArchiveCheckDiag.cause, 'other');
  assert.equal(app.manager.getSnapshot().settled.filter((item) => !item.dismissed).length, 0);
  assert.equal(app.manager.authBlockReason('owner'), null);
});

test('successful retry removes a dismissed item and clears diagnostics; later persistent failure is new', async (t) => {
  const app = fixture(t);
  await app.start(); await app.retry();
  app.manager.dismissVerifiedError(app.item().jobId);
  app.state.discover = async () => emptyPlan();
  await app.retry();
  assert.equal(app.manager.getSnapshot().settled.length, 0);
  assert.equal(app.window.__dropsyncArchiveCheckDiag, null);
  assert.deepEqual(app.clock.due(), []);
  app.state.discover = async () => { throw Error('later new event'); };
  app.manager.resumeRoutine('owner'); await flush();
  assert.equal(app.item(), undefined);
  assert.equal(app.window.__dropsyncArchiveCheckDiag.cause, 'other');
  await app.retry();
  assert.equal(app.item().dismissed, false); assert.equal(app.item().notice, true);
  assert.equal(app.item().cause, 'other');
});

test('cleanup-needed after dismissed failure stays visible, unmarked, and fail-closed', async (t) => {
  const app = fixture(t);
  await app.start(); await app.retry();
  app.manager.dismissVerifiedError(app.item().jobId);
  app.state.discover = async () => ({ ...emptyPlan(), journals: [{ jobId: 'cleanup' }] });
  app.state.execute = async () => { throw Error('cleanup is incomplete'); };
  await app.retry();
  const item = app.item();
  assert.equal(app.state.cleanups, 1); assert.equal(item.status, 'cleanup-needed');
  assert.equal(item.dismissed, false);
  for (const key of ['notice', 'cause', 'elapsedCheckingMs']) assert.equal(Object.hasOwn(item, key), false);
  app.manager.dismissVerifiedError(item.jobId);
  assert.equal(app.item().dismissed, false); assert.equal(app.manager.authBlockReason('owner'), 'cleanup-needed');
});

test('new manager (reload) has no dismissal or persistence memory', async (t) => {
  const first = fixture(t);
  await first.start(); await first.retry();
  first.manager.dismissVerifiedError(first.item().jobId);
  assert.equal(first.item().dismissed, true);
  const reloaded = fixture(t);
  await reloaded.start(); assert.equal(reloaded.item(), undefined);
  await reloaded.retry();
  assert.equal(reloaded.item().dismissed, false); assert.equal(reloaded.item().notice, true);
});

test('the unchanged 5000ms deadline records first failure and publishes on persistent failure', async (t) => {
  const app = fixture(t);
  app.state.discover = () => new Promise(() => {});
  await app.start(); await app.clock.tick(4999);
  assert.equal(app.item(), undefined);
  await app.clock.tick(1);
  assert.equal(app.item(), undefined);
  assert.deepEqual(copy(app.window.__dropsyncArchiveCheckDiag), {
    cause: 'deadline', elapsedCheckingMs: 5000, aborted: true, at: 5000,
  });
  assert.equal(app.manager.authBlockReason('owner'), null);
  assert.deepEqual(app.clock.due(), [30000]);
  await app.clock.tick(35000);
  assert.equal(app.item().cause, 'deadline'); assert.equal(app.item().elapsedCheckingMs, 5000);
  assert.equal(app.window.__dropsyncArchiveCheckDiag.at, 40000);
});

test('abort takes precedence over check-unavailable and every typed coordination error', async (t) => {
  for (const name of ['ArchiveCheckUnavailableError', 'ArchiveLockUnavailableError', 'ArchiveLockBusyError', 'ArchiveCoordinationError']) {
    const app = fixture(t);
    app.state.discover = async () => {
      app.manager.routines.get('owner').controller.abort();
      const ErrorType = name === 'ArchiveCheckUnavailableError' ? app.ArchiveCheckUnavailableError : app.locks[name];
      throw new ErrorType();
    };
    await app.start(); assert.equal(app.item(), undefined);
    assert.equal(app.window.__dropsyncArchiveCheckDiag.cause, 'deadline', name);
    assert.equal(app.window.__dropsyncArchiveCheckDiag.aborted, true);
    await app.retry(); assert.equal(app.item().cause, 'deadline', name);
  }
});

for (const name of ['ArchiveLockUnavailableError', 'ArchiveLockBusyError', 'ArchiveCoordinationError']) {
  test(name + ' is classified by its real constructor as coordination', async (t) => {
    const app = fixture(t);
    app.state.discover = async () => { throw new app.locks[name](); };
    await app.start();
    assert.equal(app.item(), undefined);
    assert.equal(app.window.__dropsyncArchiveCheckDiag.cause, 'coordination');
    await app.retry();
    assert.equal(app.item().cause, 'coordination');
    assert.equal(app.item().notice, true);
    assert.equal(app.window.__dropsyncArchiveCheckDiag.cause, 'coordination');
    assert.equal(app.window.__dropsyncArchiveCheckDiag.aborted, false);
  });
}

test('error-name/message lookalikes remain other, never coordination', async (t) => {
  const app = fixture(t);
  app.state.discover = async () => {
    const error = Error('Archive session coordination is unavailable.');
    error.name = 'ArchiveCoordinationError'; throw error;
  };
  await app.start(); assert.equal(app.item(), undefined);
  assert.equal(app.window.__dropsyncArchiveCheckDiag.cause, 'other');
  await app.retry(); assert.equal(app.item().cause, 'other');
});

test('elapsed checking time uses the last armed deadline, excluding live cleanup', async (t) => {
  const app = fixture(t); let certifications = 0;
  app.state.discover = async () => ({ ...emptyPlan(), journals: [{ jobId: 'cleanup' }] });
  app.state.execute = async () => { app.clock.elapse(12000); return 'cancelled'; };
  app.state.certify = async (plan) => {
    if (++certifications === 2) { app.clock.elapse(7); throw new app.ArchiveCheckUnavailableError(); }
    return plan;
  };
  await app.start();
  assert.equal(app.state.cleanups, 1); assert.equal(app.item(), undefined);
  assert.equal(app.window.__dropsyncArchiveCheckDiag.cause, 'check-unavailable');
  assert.equal(app.window.__dropsyncArchiveCheckDiag.elapsedCheckingMs, 7);
  assert.equal(app.window.__dropsyncArchiveCheckDiag.at, 12007);
});

test('failure and success are safe without window', async (t) => {
  const app = fixture(t, { withoutWindow: true });
  await app.start(); assert.equal(app.item(), undefined);
  await app.retry(); assert.equal(app.item().notice, true);
  app.state.discover = async () => emptyPlan(); await app.retry();
  assert.equal(app.manager.getSnapshot().settled.length, 0);
});

const jsxDependencies = { 'react/jsx-runtime': require('react/jsx-runtime') };
const Chip = load('src/components/ArchiveProgressChip.tsx', jsxDependencies).ArchiveProgressChip;
const BaselineChip = loadSource(baselineChipSource, jsxDependencies).ArchiveProgressChip;
const baseItem = {
  uid: 'owner', jobId: 'real-job', kind: 'import', scope: 'workspace',
  status: 'failed', message: 'Real archive failure', settledAt: 0, dismissed: false,
};
const props = (item, contrast, overflowCount) => ({
  item, contrast, overflowCount, onOpen() {}, onCancel() {}, onDismiss() {}, onOverflow() {},
});
const render = (Component, input) => renderToStaticMarkup(React.createElement(Component, input));

test('routine Notice markup is calm on both contrast modes and retains layout and overflow', async (t) => {
  const app = fixture(t);
  await app.start();
  app.manager.publishRecoveryFailure('owner', 'failed', 'Could not finish checking interrupted imports. We will retry in the background. You can still sign out.', { notice: true, cause: 'check-unavailable', elapsedCheckingMs: 0 });
  for (const contrast of [false, true]) {
    for (const overflow of [0, 2]) {
      const input = props(app.item(), contrast, overflow);
      const document = new JSDOM(render(Chip, input)).window.document;
      const row = document.querySelector('.archive-chip-row');
      assert.equal(row.getAttribute('role'), 'status');
      assert.equal(row.getAttribute('aria-live'), 'polite');
      assert.equal(row.querySelector('span[aria-hidden]').textContent, 'i');
      const labelButton = row.querySelector('button');
      assert.equal(labelButton.getAttribute('aria-label'), 'Open background check details');
      assert.deepEqual([...labelButton.children].map((line) => line.textContent.trim()), ['Background', 'check']);
      assert.equal([...labelButton.children].map((line) => line.textContent.trim()).join(' '), 'Background check');
      assert.ok(labelButton.className.includes('text-[10px]'));
      for (const line of labelButton.children) {
        assert.ok(line.className.includes('h-[11px]'));
        assert.ok(line.className.includes('leading-[11px]'));
      }
      assert.ok(row.querySelector('[aria-label="Dismiss background check notice"]'));
      assert.equal(row.textContent.includes('Error'), false);
      assert.equal(document.querySelector('[role="alert"]'), null);
      assert.equal(row.outerHTML.includes('check-unavailable'), false);
      assert.equal(row.outerHTML.includes('elapsedCheckingMs'), false);
      const oldDocument = new JSDOM(render(BaselineChip, input)).window.document;
      assert.equal(row.className, oldDocument.querySelector('.archive-chip-row').className);
      assert.equal(row.firstElementChild.className, oldDocument.querySelector('.archive-chip-row').firstElementChild.className);
      const currentCells = [...row.firstElementChild.children];
      const originalCells = [...oldDocument.querySelector('.archive-chip-row').firstElementChild.children];
      assert.equal(currentCells.length, originalCells.length);
      for (const i of [0, 2, 3, 4, 5]) assert.equal(currentCells[i].className, originalCells[i].className);
      if (overflow) assert.ok(row.querySelector('[aria-label="Show 2 more archive errors"]'));
    }
  }
});

test('all non-notice states render byte-identically to the pre-build chip', () => {
  const active = {
    ...baseItem, currentName: 'Archive item', completedItems: 1, totalItems: 4, percent: 25, canCancel: true,
  };
  const cases = [
    baseItem,
    { ...baseItem, status: 'cleanup-needed' },
    ...['preparing', 'checking', 'working', 'finalizing', 'cancelling', 'succeeded', 'cancelled'].flatMap((status) =>
      ['import', 'export'].flatMap((kind) => [true, false].map((canCancel) => ({ ...active, status, kind, canCancel })))),
  ];
  for (const item of cases) {
    for (const contrast of [false, true]) {
      for (const overflow of [0, 2]) {
        const input = props(item, contrast, overflow);
        assert.equal(render(Chip, input), render(BaselineChip, input), item.status + '/' + item.kind);
      }
    }
  }
});

for (const failure of ['unavailable', 'other', 'coordination', 'deadline']) {
  test('P1 sticky cleanup survives resumed ' + failure + ' checking failure', async (t) => {
    const app = fixture(t);
    app.state.discover = async () => ({ ...emptyPlan(), journals: [{ jobId: 'known-job', userId: 'owner' }] });
    app.state.execute = async () => { throw Error('known ledger remains'); };
    await app.start();
    const original = app.item();
    assert.equal(original.status, 'cleanup-needed');
    app.state.discover = failure === 'deadline' ? () => new Promise(() => {}) : async () => {
      if (failure === 'unavailable') throw new app.ArchiveCheckUnavailableError();
      if (failure === 'coordination') throw new app.locks.ArchiveCoordinationError();
      throw Error('later routine read failed');
    };
    app.manager.resumeRoutine('owner');
    await flush();
    if (failure === 'deadline') await app.clock.tick(5000);
    assert.equal(app.item(), original, 'retain original Error object, message and timestamp');
    assert.equal(app.manager.authBlockReason('owner'), 'cleanup-needed');
    assert.equal(app.item().dismissed, false);
    assert.equal(Object.hasOwn(app.item(), 'notice'), false);
    assert.ok(app.window.__dropsyncArchiveCheckDiag);
    await app.retry();
    if (failure === 'deadline') await app.clock.tick(5000);
    assert.equal(app.item(), original, 'guard still holds when count reaches two');
  });
}
test('P1 empty resumed inventory cannot clear a known cleanup obligation', async (t) => {
  const app = fixture(t);
  app.state.discover = async () => ({ ...emptyPlan(), journals: [{ jobId: 'known-job', userId: 'owner' }] });
  app.state.execute = async () => { throw Error('ledger remains'); };
  await app.start();
  const original = app.item();
  app.state.discover = async () => emptyPlan();
  app.manager.resumeRoutine('owner');
  await flush();
  assert.equal(app.item(), original);
  assert.equal(app.manager.isBusyForUid('owner'), true);
});
test('P1 failed strict Retry retains Error when cross-device checking is unavailable', async (t) => {
  const app = fixture(t);
  app.manager.publishRecoveryFailure('owner', 'cleanup-needed', 'known incomplete cleanup');
  app.state.recover = async () => { throw new app.ArchiveCheckUnavailableError(); };
  await assert.rejects(app.manager.retryCleanup('owner', 'recovery-owner'));
  assert.equal(app.item().status, 'cleanup-needed');
  assert.equal(app.manager.authBlockReason('owner'), 'cleanup-needed');
});
test('P1 vanished legacy revision cannot be inferred complete', async (t) => {
  const app = fixture(t);
  app.state.personal = async () => ({ ...emptyPlan(), legacyRevision: 'revision-a',
    legacy: async () => { throw Error('legacy cleanup remains'); } });
  app.state.discover = async () => emptyPlan();
  await app.start();
  const original = app.item();
  app.state.personal = async () => emptyPlan();
  app.manager.resumeRoutine('owner');
  await flush();
  assert.equal(app.item(), original);
});

for (const proof of ['execute', 'certificate']) {
  test('P1 current exact-job ' + proof + ' proof clears only the synthetic warning', async (t) => {
    const app = fixture(t);
    app.state.discover = async () => ({ ...emptyPlan(), journals: [{ jobId: 'known-job', userId: 'owner' }] });
    app.state.execute = async () => { throw Error('cleanup remains'); };
    await app.start();
    app.state.execute = async () => 'cancelled';
    if (proof === 'certificate') app.state.discover = async () => ({ ...emptyPlan(), verifiedJobIds: ['known-job'] });
    app.manager.resumeRoutine('owner'); await flush();
    assert.equal(app.item(), undefined);
    assert.equal(app.manager.authBlockReason('owner'), null);
    assert.equal(app.window.__dropsyncArchiveCheckDiag, null);
  });
}
test('P1 unrelated proof and known remote-active job do not clear a warning', async (t) => {
  const app = fixture(t);
  app.state.discover = async () => ({ ...emptyPlan(), journals: [{ jobId: 'known-job', userId: 'owner' }] });
  app.state.execute = async () => { throw Error('cleanup remains'); };
  await app.start(); const original = app.item();
  app.state.discover = async () => ({ ...emptyPlan(), verifiedJobIds: ['other-job'],
    journals: [{ jobId: 'known-job', userId: 'owner' }], remoteJobIds: ['known-job'] });
  app.manager.resumeRoutine('owner'); await flush();
  assert.equal(app.item(), original);
});
test('P1 unrelated live job does not negate a valid required-job certificate', async (t) => {
  const app = fixture(t);
  app.state.discover = async () => ({ ...emptyPlan(), journals: [{ jobId: 'known-job', userId: 'owner' }] });
  app.state.execute = async () => { throw Error('cleanup remains'); };
  await app.start();
  app.state.discover = async () => ({ ...emptyPlan(), verifiedJobIds: ['known-job'],
    journals: [{ jobId: 'other-job', userId: 'owner' }], remoteJobIds: ['other-job'] });
  app.manager.resumeRoutine('owner'); await flush();
  assert.equal(app.item(), undefined);
  assert.equal(app.manager.isBusyForUid('owner'), true, 'remote active still gates admission');
});
test('P1 legacy receipts match the failed revision and survive an unrelated later failure', async (t) => {
  const app = fixture(t);
  app.state.discover = async () => emptyPlan();
  app.state.personal = async () => ({ ...emptyPlan(), legacyRevision: 'revision-a',
    legacy: async () => { throw Error('legacy cleanup remains'); } });
  await app.start(); const original = app.item();
  app.state.personal = async () => ({ ...emptyPlan(), legacyRevision: 'revision-a',
    legacy: async () => {}, checkUnavailable: true });
  app.manager.resumeRoutine('owner'); await flush();
  assert.equal(app.item(), original, 'partial pass cannot clear Error');
  app.state.personal = async () => emptyPlan();
  app.manager.resumeRoutine('owner'); await flush();
  assert.equal(app.item(), undefined, 'matching own receipt plus fresh successful pass');
});
test('P1 different legacy revision cannot satisfy a disappeared old obligation', async (t) => {
  const app = fixture(t);
  app.state.discover = async () => emptyPlan();
  app.state.personal = async () => ({ ...emptyPlan(), legacyRevision: 'revision-a',
    legacy: async () => { throw Error('legacy cleanup remains'); } });
  await app.start(); const original = app.item();
  app.state.personal = async () => ({ ...emptyPlan(), legacyRevision: 'revision-b', legacy: async () => {} });
  app.manager.resumeRoutine('owner'); await flush();
  assert.equal(app.item(), original);
});
test('P1 known warning survives A to B to A and never leaks B into A cleanup', async (t) => {
  const app = fixture(t);
  app.state.discover = async () => ({ ...emptyPlan(), journals: [{ jobId: 'known-job', userId: 'owner' }] });
  app.state.execute = async () => { throw Error('cleanup remains'); };
  await app.start(); const original = app.item();
  app.state.discover = async () => emptyPlan();
  app.manager.setSessionUid('peer');
  assert.equal(app.manager.getSnapshot().settled.length, 0);
  assert.equal(app.manager.authBlockReason('peer'), null);
  app.manager.setSessionUid('owner'); await flush();
  assert.equal(app.item(), original);
  const visible = JSON.stringify(app.manager.getSnapshot());
  assert.equal(visible.includes('known-job'), false);
  assert.equal(visible.includes('required'), false);
  assert.equal(visible.includes('verified'), false);
});
for (const result of ['proof', 'missing', 'remote', 'throw', 'stale', 'newer']) {
  test('P1 strict Retry result ' + result + ' respects requirements and revision', async (t) => {
    const app = fixture(t);
    app.state.discover = async () => ({ ...emptyPlan(), journals: [{ jobId: 'known-job', userId: 'owner' }] });
    app.state.execute = async () => { throw Error('cleanup remains'); };
    await app.start();
    app.state.recover = async (_uid, _force, owner, collect) => {
      if (result === 'throw') throw Error('cleanup still incomplete');
      if (result === 'stale') {
        app.auth.currentUser = { uid: 'peer' };
        owner.check();
      }
      if (['proof', 'newer'].includes(result)) collect({ kind: 'fence', jobId: 'known-job' });
      if (result === 'newer') app.manager.rememberCleanup('owner', 'recovery-owner', 'fence:known-job');
      return result === 'remote';
    };
    if (result === 'proof') {
      await app.manager.retryCleanup('owner', 'recovery-owner');
      assert.equal(app.item(), undefined);
    } else {
      await assert.rejects(app.manager.retryCleanup('owner', 'recovery-owner'));
      assert.equal(app.item().status, 'cleanup-needed');
      assert.equal(app.manager.authBlockReason('owner'), 'cleanup-needed');
    }
  });
}

// Test-only immutable baseline mode; no product file is reset or replaced.
const checkpointManagerSource = process.env.ORDER73_CHECKPOINT_RED === '1'
  ? execFileSync('git', ['show', 'f1290e3:src/lib/archiveTaskManager.ts'], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8',
  }) : undefined;
if (checkpointManagerSource) {
  const digest = createHash('sha256').update(checkpointManagerSource).digest('hex');
  assert.equal(digest, '5db525996a488a1b01aae560844490067da9a3af0097ad7516a95ca7b0a2e257');
  console.info('Immutable checkpoint manager SHA-256: ' + digest);
}

const n2Fixture = (t) => fixture(t, { managerSource: checkpointManagerSource });
test('P4 N=2 checkpoint first failure is silent, second publishes Background check', async (t) => {
  const app = n2Fixture(t);
  await app.start();
  assert.equal(app.item(), undefined, 'first failure must not publish');
  assert.equal(app.window.__dropsyncArchiveCheckDiag.cause, 'check-unavailable');
  await app.retry();
  assert.equal(app.item().notice, true);
  assert.equal(app.item().dismissed, false);
  const doc = new JSDOM(render(Chip, props(app.item(), false, 0))).window.document;
  assert.ok(doc.querySelector('[aria-label="Open background check details"]'));
  assert.ok(doc.querySelector('[aria-label="Dismiss background check notice"]'));
});
test('P4 N=2 checkpoint success between failures resets persistence', async (t) => {
  const app = n2Fixture(t);
  await app.start(); assert.equal(app.item(), undefined);
  app.state.discover = async () => emptyPlan();
  await app.retry(); assert.equal(app.item(), undefined);
  assert.equal(app.window.__dropsyncArchiveCheckDiag, null);
  app.state.discover = async () => { throw new app.ArchiveCheckUnavailableError(); };
  app.manager.resumeRoutine('owner'); await flush();
  assert.equal(app.item(), undefined, 'new first failure stays silent');
  await app.retry(); assert.equal(app.item().notice, true);
});
test('P4 N=2 checkpoint Dismiss persists through third and later failures', async (t) => {
  const app = n2Fixture(t);
  await app.start(); assert.equal(app.item(), undefined);
  await app.retry(); assert.equal(app.item().notice, true);
  app.manager.dismissVerifiedError(app.item().jobId);
  await app.retry(); assert.equal(app.item().dismissed, true);
  await app.retry(); assert.equal(app.item().dismissed, true);
});
test('P4 N=2 checkpoint pause and refused-auth resume do not reset failures', async (t) => {
  const app = n2Fixture(t);
  await app.start(); assert.equal(app.item(), undefined);
  app.manager.pauseRoutine('owner');
  app.manager.resumeRoutine('owner'); await flush();
  assert.equal(app.item().notice, true, 'second actual failure after pause must publish');
});
test('P4 N=2 checkpoint UID displacement resets persistence', async (t) => {
  const app = n2Fixture(t);
  await app.start(); assert.equal(app.item(), undefined);
  app.auth.currentUser = { uid: 'peer', getIdToken: async () => 'peer-token' };
  app.manager.setSessionUid('peer', app.auth.currentUser);
  app.auth.currentUser = { uid: 'owner', getIdToken: async () => 'owner-token-new' };
  app.manager.setSessionUid('owner', app.auth.currentUser);
  await app.manager.recoverForUser('owner');
  assert.equal(app.item(), undefined);
  await app.retry(); assert.equal(app.item().notice, true);
});
test('P4 N=2 integration same-uid new auth session resets without crossing accounts', async (t) => {
  const app = n2Fixture(t);
  await app.start(); assert.equal(app.item(), undefined);
  app.auth.currentUser = { uid: 'owner', getIdToken: async () => 'new-owner-token' };
  app.manager.setSessionUid('owner', app.auth.currentUser);
  await app.manager.recoverForUser('owner');
  assert.equal(app.item(), undefined);
  await app.retry(); assert.equal(app.item().notice, true);
});
test('P4 N=2 integration cancellation is not a failure; foreground failures do count', async (t) => {
  const app = n2Fixture(t);
  app.state.discover = () => new Promise(() => {});
  await app.start(); app.manager.pauseRoutine('owner'); await flush();
  assert.equal(app.window.__dropsyncArchiveCheckDiag, undefined);
  app.state.discover = async () => { throw new app.ArchiveCheckUnavailableError(); };
  app.manager.markRecoveryPending('owner'); app.manager.kickRecoveryIfPending('owner'); await flush();
  assert.equal(app.item(), undefined);
  assert.equal(app.window.__dropsyncArchiveCheckSchedule.trigger, 'foreground');
  app.manager.pauseRoutine('owner');
  app.manager.markRecoveryPending('owner'); app.manager.kickRecoveryIfPending('owner'); await flush();
  assert.equal(app.item().notice, true);
});
test('P4 N=2 integration cleanup Error is immediate and never suppressed or downgraded', async (t) => {
  const app = n2Fixture(t);
  app.state.discover = async () => ({ ...emptyPlan(), journals: [{ jobId: 'known', userId: 'owner' }] });
  app.state.execute = async () => { throw Error('real cleanup remains'); };
  await app.start(); const original = app.item();
  assert.equal(original.status, 'cleanup-needed');
  app.state.discover = async () => { throw new app.ArchiveCheckUnavailableError(); };
  app.manager.resumeRoutine('owner'); await flush();
  assert.equal(app.item(), original);
  await app.retry(); assert.equal(app.item(), original);
  assert.equal(app.manager.authBlockReason('owner'), 'cleanup-needed');
});
test('P4 N=2 integration counter is invisible and diagnostics populate on each failed pass', async (t) => {
  const app = n2Fixture(t);
  await app.start(); assert.equal(app.item(), undefined);
  assert.deepEqual(Object.keys(app.window.__dropsyncArchiveCheckDiag).sort(), ['aborted', 'at', 'cause', 'elapsedCheckingMs']);
  assert.deepEqual(Object.keys(app.window.__dropsyncArchiveCheckSchedule).sort(), ['at', 'deferredMs', 'phase', 'trigger']);
  const first = app.window.__dropsyncArchiveCheckDiag.at;
  await app.retry();
  assert.ok(app.window.__dropsyncArchiveCheckDiag.at > first);
  const exposed = JSON.stringify([app.manager.getSnapshot(), app.window.__dropsyncArchiveCheckDiag, app.window.__dropsyncArchiveCheckSchedule]);
  assert.equal(exposed.includes('routineCheckFailures'), false);
});

test('P1 strict Retry verifies personal discovery after matching workspace proof', async (t) => {
  const app = fixture(t);
  app.state.discover = async () => ({ ...emptyPlan(), journals: [{ jobId: 'known', userId: 'owner' }] });
  app.state.execute = async () => { throw Error('cleanup remains'); };
  await app.start(); const original = app.item();
  app.state.recover = async (_uid, _force, _owner, collect) => {
    collect({ kind: 'fence', jobId: 'known' }); return false;
  };
  app.state.recoverPersonal = async () => { throw new app.ArchiveCheckUnavailableError(); };
  await assert.rejects(app.manager.retryCleanup('owner', 'recovery-owner'));
  assert.equal(app.item(), original, 'partial verification cannot clear');
  app.state.recover = async () => false;
  app.state.recoverPersonal = async () => false;
  await app.manager.retryCleanup('owner', 'recovery-owner');
  assert.equal(app.item(), undefined, 'own positive receipt plus current full verification');
});
test('P1 sticky Error survives epoch restart, last-owner disposal and StrictMode reacquisition', async (t) => {
  const app = fixture(t);
  app.state.discover = async () => ({ ...emptyPlan(), journals: [{ jobId: 'known', userId: 'owner' }] });
  app.state.execute = async () => { throw Error('cleanup remains'); };
  await app.start(); const original = app.item();
  app.state.discover = async () => emptyPlan();
  app.storage(app.locks.ARCHIVE_AUTH_EPOCH_PREFIX + 'owner'); await flush();
  assert.equal(app.item(), original);
  app.stopAttachment(); await flush();
  const one = app.manager.attachRecovery('owner'); await flush();
  one.dispose();
  const two = app.manager.attachRecovery('owner'); await flush();
  t.after(async () => { two.dispose(); await flush(); });
  assert.equal(app.item(), original);
  app.manager.setSessionUid('owner', app.auth.currentUser); await flush();
  assert.equal(app.item(), original);
  await app.retry();
  assert.equal(app.item(), original);
  assert.equal(app.manager.authBlockReason('owner'), 'cleanup-needed');
});
for (const result of ['invalid', 'not-found', 'remote-active']) {
  test('P1 execution outcome ' + result + ' never supplies a completion receipt', async (t) => {
    const app = fixture(t);
    app.state.discover = async () => ({ ...emptyPlan(), journals: [{ jobId: 'known', userId: 'owner' }] });
    app.state.execute = async () => { throw Error('cleanup remains'); };
    await app.start(); const original = app.item();
    app.state.execute = async () => result;
    app.manager.resumeRoutine('owner'); await flush();
    assert.equal(app.item(), original);
  });
}
