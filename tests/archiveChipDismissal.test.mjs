import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
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
function fixture(t, { withoutWindow = false } = {}) {
  const clock = fakeClock();
  const window = withoutWindow ? undefined : { addEventListener() {} };
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
    passes: 0,
    cleanups: 0,
  };
  const workspace = {
    ArchiveCheckUnavailableError, ArchiveCleanupNeededError,
    discoverInterruptedWorkspaceArchiveImport: (...args) => { state.passes++; return state.discover(...args); },
    discoverInterruptedPersonalArchiveImport: (...args) => state.personal(...args),
    certifyArchiveRecoveryPlan: (...args) => state.certify(...args),
    recoverArchiveFenceJob: (...args) => { state.cleanups++; return state.execute(...args); },
    recoverInterruptedWorkspaceArchiveImport: async () => false,
    recoverInterruptedPersonalArchiveImport: async () => false,
  };
  const modules = load('src/lib/archiveTaskManager.ts', {
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
    manager, state, window, clock, locks, ArchiveCheckUnavailableError,
    item: () => manager.getSnapshot().settled[0],
    async start() { attachment = manager.attachRecovery('owner'); await flush(); },
    async retry() { await clock.tick(30000); },
  };
}

test('fresh routine failure is a dismissible Notice with four-field non-user diagnostics', async (t) => {
  const app = fixture(t);
  app.state.discover = async () => {
    app.clock.elapse(17);
    throw new app.ArchiveCheckUnavailableError('private detail must not be exposed');
  };
  await app.start();
  const item = app.item();
  assert.equal(item.status, 'failed');
  assert.equal(item.dismissed, false);
  assert.equal(item.notice, true);
  assert.equal(item.cause, 'check-unavailable');
  assert.equal(item.elapsedCheckingMs, 17);
  assert.deepEqual(copy(app.window.__dropsyncArchiveCheckDiag), {
    cause: 'check-unavailable', elapsedCheckingMs: 17, aborted: false, at: 17,
  });
  assert.equal(app.manager.authBlockReason('owner'), null);
  assert.deepEqual(app.clock.due(), [30000]);
});

test('dismissal survives real 30-second failed retries while diagnostics keep updating', async (t) => {
  const app = fixture(t);
  await app.start();
  app.manager.dismissVerifiedError(app.item().jobId);
  const firstSettledAt = app.item().settledAt;
  await app.clock.tick(29999);
  assert.equal(app.state.passes, 1);
  assert.equal(app.item().dismissed, true);
  await app.clock.tick(1);
  assert.equal(app.state.passes, 2);
  assert.equal(app.item().dismissed, true);
  assert.equal(app.item().notice, true);
  assert.ok(app.item().settledAt > firstSettledAt);
  assert.equal(app.window.__dropsyncArchiveCheckDiag.at, 30000);
  app.state.discover = async () => { throw Error('changed private failure'); };
  await app.retry();
  assert.equal(app.state.passes, 3);
  assert.equal(app.item().dismissed, true);
  assert.equal(app.item().cause, 'other');
  assert.equal(app.window.__dropsyncArchiveCheckDiag.cause, 'other');
  assert.equal(app.manager.getSnapshot().settled.filter((item) => !item.dismissed).length, 0);
  assert.equal(app.manager.authBlockReason('owner'), null);
});

test('successful retry removes a dismissed item and clears diagnostics; later failure is a new notice', async (t) => {
  const app = fixture(t);
  await app.start();
  app.manager.dismissVerifiedError(app.item().jobId);
  app.state.discover = async () => emptyPlan();
  await app.retry();
  assert.equal(app.manager.getSnapshot().settled.length, 0);
  assert.equal(app.window.__dropsyncArchiveCheckDiag, null);
  assert.deepEqual(app.clock.due(), []);
  app.state.discover = async () => { throw Error('later new event'); };
  app.manager.resumeRoutine('owner');
  await flush();
  assert.equal(app.item().dismissed, false);
  assert.equal(app.item().notice, true);
  assert.equal(app.item().cause, 'other');
});

test('cleanup-needed after dismissed failure stays visible, unmarked, and fail-closed', async (t) => {
  const app = fixture(t);
  await app.start();
  app.manager.dismissVerifiedError(app.item().jobId);
  app.state.discover = async () => ({ ...emptyPlan(), journals: [{ jobId: 'cleanup' }] });
  app.state.execute = async () => { throw Error('cleanup is incomplete'); };
  await app.retry();
  const item = app.item();
  assert.equal(app.state.cleanups, 1);
  assert.equal(item.status, 'cleanup-needed');
  assert.equal(item.dismissed, false);
  assert.equal(Object.hasOwn(item, 'notice'), false);
  assert.equal(Object.hasOwn(item, 'cause'), false);
  assert.equal(Object.hasOwn(item, 'elapsedCheckingMs'), false);
  app.manager.dismissVerifiedError(item.jobId);
  assert.equal(app.item().dismissed, false);
  assert.equal(app.manager.authBlockReason('owner'), 'cleanup-needed');
});

test('new manager (reload) has no dismissal memory', async (t) => {
  const first = fixture(t);
  await first.start();
  first.manager.dismissVerifiedError(first.item().jobId);
  assert.equal(first.item().dismissed, true);
  const reloaded = fixture(t);
  await reloaded.start();
  assert.equal(reloaded.item().dismissed, false);
  assert.equal(reloaded.item().notice, true);
});

test('the unchanged 5000ms deadline classifies an abandoned read as deadline', async (t) => {
  const app = fixture(t);
  app.state.discover = () => new Promise(() => {});
  await app.start();
  await app.clock.tick(4999);
  assert.equal(app.item(), undefined);
  await app.clock.tick(1);
  assert.equal(app.item().cause, 'deadline');
  assert.equal(app.item().elapsedCheckingMs, 5000);
  assert.deepEqual(copy(app.window.__dropsyncArchiveCheckDiag), {
    cause: 'deadline', elapsedCheckingMs: 5000, aborted: true, at: 5000,
  });
  assert.equal(app.manager.authBlockReason('owner'), null);
  assert.deepEqual(app.clock.due(), [30000]);
});

test('abort takes precedence over check-unavailable and every typed coordination error', async (t) => {
  const names = ['ArchiveCheckUnavailableError', 'ArchiveLockUnavailableError', 'ArchiveLockBusyError', 'ArchiveCoordinationError'];
  for (const name of names) {
    const app = fixture(t);
    app.state.discover = async () => {
      app.manager.routines.get('owner').controller.abort();
      const ErrorType = name === 'ArchiveCheckUnavailableError' ? app.ArchiveCheckUnavailableError : app.locks[name];
      throw new ErrorType();
    };
    await app.start();
    assert.equal(app.item().cause, 'deadline', name);
    assert.equal(app.window.__dropsyncArchiveCheckDiag.aborted, true);
  }
});

for (const name of ['ArchiveLockUnavailableError', 'ArchiveLockBusyError', 'ArchiveCoordinationError']) {
  test(name + ' is classified by its real constructor as coordination', async (t) => {
    const app = fixture(t);
    app.state.discover = async () => { throw new app.locks[name](); };
    await app.start();
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
    error.name = 'ArchiveCoordinationError';
    throw error;
  };
  await app.start();
  assert.equal(app.item().cause, 'other');
  assert.equal(app.window.__dropsyncArchiveCheckDiag.cause, 'other');
});

test('elapsed checking time uses the last armed deadline, excluding live cleanup', async (t) => {
  const app = fixture(t);
  let certifications = 0;
  app.state.discover = async () => ({ ...emptyPlan(), journals: [{ jobId: 'cleanup' }] });
  app.state.execute = async () => { app.clock.elapse(12000); };
  app.state.certify = async (plan) => {
    if (++certifications === 2) {
      app.clock.elapse(7);
      throw new app.ArchiveCheckUnavailableError();
    }
    return plan;
  };
  await app.start();
  assert.equal(app.state.cleanups, 1);
  assert.equal(app.item().cause, 'check-unavailable');
  assert.equal(app.item().elapsedCheckingMs, 7);
  assert.equal(app.window.__dropsyncArchiveCheckDiag.at, 12007);
});

test('failure and success are safe without window', async (t) => {
  const app = fixture(t, { withoutWindow: true });
  await app.start();
  assert.equal(app.item().notice, true);
  app.state.discover = async () => emptyPlan();
  await app.retry();
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
  for (const contrast of [false, true]) {
    for (const overflow of [0, 2]) {
      const input = props(app.item(), contrast, overflow);
      const document = new JSDOM(render(Chip, input)).window.document;
      const row = document.querySelector('.archive-chip-row');
      assert.equal(row.getAttribute('role'), 'status');
      assert.equal(row.getAttribute('aria-live'), 'polite');
      assert.equal(row.querySelector('span[aria-hidden]').textContent, 'i');
      assert.equal(row.querySelector('button').textContent, 'Notice');
      assert.ok(row.querySelector('[aria-label="Dismiss archive notice"]'));
      assert.equal(row.textContent.includes('Error'), false);
      assert.equal(document.querySelector('[role="alert"]'), null);
      assert.equal(row.outerHTML.includes('check-unavailable'), false);
      assert.equal(row.outerHTML.includes('elapsedCheckingMs'), false);
      const oldDocument = new JSDOM(render(BaselineChip, input)).window.document;
      assert.deepEqual([...document.querySelectorAll('[class]')].map((node) => node.className),
        [...oldDocument.querySelectorAll('[class]')].map((node) => node.className));
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
