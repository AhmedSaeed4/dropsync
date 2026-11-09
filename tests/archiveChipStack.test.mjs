
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire, register } from 'node:module';
register('./helpers/hook-module-loader.mjs', import.meta.url);
const { JSDOM } = await import('jsdom');
const require = createRequire(import.meta.url);
const React = require('react');
const { createRoot } = require('react-dom/client');
const ts = require('typescript');
function load(file, deps, globals) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { exports, require: (id) => {
    assert.ok(Object.hasOwn(deps, id), id);
    return deps[id];
  }, ...globals });
  return exports;
}
const settled = (id, at, dismissed = false) => ({
  uid: 'owner', jobId: id, kind: 'import', scope: 'workspace', status: 'failed',
  message: id, settledAt: at, dismissed,
});
test('P1 real stack preserves caps, membership, overflow and resize on phone/desktop', async (t) => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' });
  const saved = { window: globalThis.window, document: globalThis.document,
    act: globalThis.IS_REACT_ACT_ENVIRONMENT };
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  let width = 390, height = 300;
  const win = dom.window;
  win.matchMedia = () => ({ matches: width <= 639 });
  Object.defineProperty(win, 'innerHeight', { get: () => height });
  const viewport = new win.EventTarget();
  Object.defineProperty(viewport, 'height', { get: () => height });
  Object.defineProperty(win, 'visualViewport', { value: viewport });
  const listeners = new Set();
  let snapshot = { active: null, settled: [] };
  const manager = { getSnapshot: () => snapshot, subscribe: (fn) => {
    listeners.add(fn); return () => listeners.delete(fn);
  }, requestCancel() {}, dismissVerifiedError() {} };
  const globals = { window: win, document: win.document,
    requestAnimationFrame: (fn) => setTimeout(fn, 0), cancelAnimationFrame: clearTimeout,
    ResizeObserver: class { observe() {} disconnect() {} } };
  const jsx = { 'react/jsx-runtime': require('react/jsx-runtime') };
  const Chip = load('src/components/ArchiveProgressChip.tsx', jsx, globals).ArchiveProgressChip;
  const Stack = load('src/components/ArchiveChipStack.tsx', { ...jsx, react: React,
    '@/lib/archiveTaskManager': { getArchiveTaskManager: () => manager },
    './ArchiveProgressChip': { ArchiveProgressChip: Chip } }, globals).ArchiveChipStack;
  const opened = [];
  const root = createRoot(win.document.getElementById('root'));
  t.after(async () => {
    await React.act(async () => root.unmount());
    dom.window.close();
    globalThis.window = saved.window; globalThis.document = saved.document;
    globalThis.IS_REACT_ACT_ENVIRONMENT = saved.act;
  });
  const active = { ...settled('active', 0), status: 'working', currentName: 'working',
    canCancel: true, percent: 25, completedItems: 1, totalItems: 4 };
  const records = [settled('old', 1), settled('middle', 2), settled('new', 3), settled('dismissed', 4, true)];
  const cases = [
    [390, 300, active, ['active'], 3], [390, 300, null, ['new'], 2],
    [390, 800, active, ['new', 'active'], 2], [390, 800, null, ['middle', 'new'], 1],
    [1600, 900, active, ['middle', 'new', 'active'], 1],
    [1600, 900, null, ['old', 'middle', 'new'], 0],
    [1600, 300, active, ['active'], 3],
  ];
  await React.act(async () => root.render(React.createElement(Stack, {
    editorial: true, callPill: false, onOpen: (id, all) => opened.push([id, !!all]),
  })));
  for (const [w, h, current, expected, overflow] of cases) {
    width = w; height = h; snapshot = { active: current, settled: records };
    await React.act(async () => {
      for (const listener of listeners) listener();
      win.dispatchEvent(new win.Event('resize')); viewport.dispatchEvent(new win.Event('resize'));
    });
    const rows = [...win.document.querySelectorAll('.archive-chip-row')];
    assert.equal(rows.length, expected.length, w + 'x' + h + ' cap');
    opened.length = 0;
    await React.act(async () => { for (const row of rows) row.querySelector('button').click(); });
    assert.deepEqual(opened.map(([id]) => id), expected);
    const button = win.document.querySelector('[aria-label^="Show "]');
    assert.equal(!!button, overflow > 0);
    if (overflow) {
      assert.equal(button.textContent, '+' + overflow);
      await React.act(async () => button.click());
      assert.deepEqual(opened.at(-1), [expected[0], true]);
    }
  }
  snapshot = { active: null, settled: [] };
  await React.act(async () => { for (const listener of listeners) listener(); });
  assert.equal(win.document.querySelectorAll('.archive-chip-row').length, 0);
});
