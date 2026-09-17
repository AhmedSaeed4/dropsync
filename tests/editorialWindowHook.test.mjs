// Order 20 — REAL-hook tests for the window controller's correction
// transaction (the WV-3 repair). The model and the controller-transaction
// fakes prove the pure math (editorialWindowModel.test.mjs /
// editorialWindowController.test.mjs); THESE tests run the actual
// useEditorialWindow hook in jsdom so the effect wiring — prevGeoRef
// initialization, the ack machine, coverage reconciliation, and the scope
// re-baseline — is exercised for the first time.
//
// jsdom lives OUTSIDE the repo (npm reify must never run on the /mnt/d
// mount); hook-module-loader.mjs maps the bare specifier and the app's
// '@/...' alias to real files.
// Run: node --test tests/editorialWindowHook.test.mjs
import { register } from 'node:module';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeGeometry, planAnchorCorrection } from '../src/lib/editorialWindowModel.ts';

register('./helpers/hook-module-loader.mjs', import.meta.url);

const jsdomMod = await import('jsdom');
const { JSDOM } = jsdomMod.default ?? jsdomMod;
const dom = new JSDOM('<!doctype html><html><body></body></html>');
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.Event = dom.window.Event;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no ResizeObserver and no layout engine. The controller constructs
// one ResizeObserver per measured row; the fake records them. offsetHeight is
// defined per element by the harness.
const roInstances = [];
class FakeResizeObserver {
  constructor(cb) { this.cb = cb; this.observed = new Set(); roInstances.push(this); }
  observe(el) { this.observed.add(el); }
  unobserve(el) { this.observed.delete(el); }
  disconnect() { this.observed.clear(); }
  emit(el) { if (this.observed.has(el)) this.cb([], this); }
}
globalThis.ResizeObserver = FakeResizeObserver;

const rafQueue = [];
globalThis.requestAnimationFrame = (cb) => { rafQueue.push(cb); return rafQueue.length; };
globalThis.cancelAnimationFrame = () => {};

const React = (await import('react')).default;
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { useEditorialWindow } = await import('../src/hooks/useEditorialWindow.ts');

// ---- harness -------------------------------------------------------------
// One jsdom scroller div (the stage's parentElement — the exact relationship
// the app's max-h container has) + one React root rendering the hook. The
// scroller counts scrollTop WRITES (corrections); direct harness sets are
// input, not writes, and bypass the counter.

function makeList({ ids, heights, scope = 'ws-a', viewportH = 500 }) {
  const stageRef = { current: null };
  const scroller = document.createElement('div');
  document.body.appendChild(scroller);
  Object.defineProperty(scroller, 'clientHeight', { value: viewportH, configurable: true });
  const state = { ids, scope, heights, scrollWrites: 0, win: null, scrollTop: 0 };
  Object.defineProperty(scroller, 'scrollTop', {
    get: () => state.scrollTop,
    set: (v) => {
      if (v !== state.scrollTop) state.scrollWrites += 1;
      state.scrollTop = v;
    },
    configurable: true,
  });
  const rowEls = new Map();

  function List() {
    const win = useEditorialWindow(state.scope, state.ids, stageRef, undefined);
    state.win = win;
    return React.createElement(
      'div',
      { ref: stageRef },
      win.rows.map((r) =>
        React.createElement('div', {
          key: r.id,
          'data-row-id': r.id,
          ref: (el) => {
            if (!el) return;
            rowEls.set(el, r.id);
            Object.defineProperty(el, 'offsetHeight', {
              value: state.heights.get(r.id) ?? 160,
              configurable: true,
            });
          },
        })
      )
    );
  }

  const root = createRoot(scroller);
  const renderNow = async () => {
    await act(async () => { root.render(React.createElement(List)); });
  };
  const flushFrames = async () => {
    while (rafQueue.length > 0) {
      const cb = rafQueue.shift();
      await act(async () => { cb(); });
    }
    await act(async () => {});
  };
  const scrollTo = async (offset) => {
    await act(async () => {
      state.scrollTop = offset;
      scroller.dispatchEvent(new Event('scroll'));
    });
  };
  const dispatchScroll = async () => {
    await act(async () => { scroller.dispatchEvent(new Event('scroll')); });
  };
  const rowEl = (id) => {
    for (const [el, v] of rowEls) if (v === id && el.isConnected) return el;
    return null;
  };
  const close = async () => {
    await act(async () => { root.unmount(); });
    scroller.remove();
  };
  return { state, scroller, renderNow, flushFrames, scrollTo, dispatchScroll, rowEl, close };
}

const rangeIds = (prefix, n) => Array.from({ length: n }, (_, i) => `${prefix}${i}`);
const flatHeights = (ids, h) => new Map(ids.map((id) => [id, h]));

test('initial mount: budget rows mount, no correction write at the top', async () => {
  const ids = rangeIds('r', 200);
  const env = makeList({ ids, heights: flatHeights(ids, 160) });
  await env.renderNow();
  await env.flushFrames();
  assert.equal(env.state.win.rows.length, 60);
  assert.equal(env.state.scrollWrites, 0);
  assert.equal(env.state.scrollTop, 0);
  await env.close();
});

test('WV-3 fix: a height change above the anchor writes exactly one compensating correction', async () => {
  const ids = rangeIds('r', 200);
  const heights = flatHeights(ids, 160);
  const env = makeList({ ids, heights });
  await env.renderNow();
  await env.flushFrames();
  const geoWarm = computeGeometry(ids, (id) => heights.get(id));
  const at = geoWarm.tops[50];
  await env.scrollTo(at); // read row 50
  await env.flushFrames();
  assert.equal(env.state.scrollWrites, 0); // plain input never writes
  // a mounted row ABOVE the viewport grows by 300px
  heights.set('r35', 460);
  await env.renderNow(); // a commit re-runs the measurement sweep
  await env.flushFrames();
  const geoGrown = computeGeometry(ids, (id) => heights.get(id));
  const plan = planAnchorCorrection(geoWarm, geoGrown, at, 500);
  assert.ok(plan, 'the anchor plan must exist');
  assert.equal(env.state.scrollWrites, 1);
  assert.equal(env.state.scrollTop, plan.target);
  // the correction's own echo acknowledges and does no further work
  await env.dispatchScroll();
  assert.equal(env.state.scrollWrites, 1);
  // re-measuring the same value is a no-op
  await env.renderNow();
  await env.flushFrames();
  assert.equal(env.state.scrollWrites, 1);
  await env.close();
});

test('coverage reconciliation: a same-length reorder moving the anchor outside the slice is followed', async () => {
  const ids = rangeIds('r', 200);
  const heights = flatHeights(ids, 160);
  const env = makeList({ ids, heights });
  await env.renderNow();
  await env.flushFrames();
  const geoBefore = computeGeometry(ids, (id) => heights.get(id));
  const at = geoBefore.tops[100];
  await env.scrollTo(at);
  await env.flushFrames();
  // move r100 to index 2 — far ABOVE the mounted band
  const reordered = ids.filter((id) => id !== 'r100');
  reordered.splice(2, 0, 'r100');
  env.state.ids = reordered;
  await env.renderNow();
  await env.flushFrames();
  const geoAfter = computeGeometry(reordered, (id) => heights.get(id));
  const plan = planAnchorCorrection(geoBefore, geoAfter, at, 500);
  assert.ok(plan, 'the anchor plan must exist');
  assert.equal(env.state.scrollWrites, 1);
  assert.equal(env.state.scrollTop, plan.target);
  // the mounted slice FOLLOWS the correction: the anchor row is mounted at
  // the new offset (without reconciliation the viewport would be blank)
  assert.ok(env.state.win.rows.some((r) => r.id === 'r100'), 'anchor row must be mounted');
  await env.close();
});

test('workspace switch: re-baseline — no correction write, coverage re-derived for the new scope', async () => {
  const ids = rangeIds('r', 200);
  const heights = flatHeights(ids, 160);
  const env = makeList({ ids, heights });
  await env.renderNow();
  await env.flushFrames();
  const geoBefore = computeGeometry(ids, (id) => heights.get(id));
  await env.scrollTo(geoBefore.tops[40]);
  await env.flushFrames();
  const writesBefore = env.state.scrollWrites;
  const bIds = rangeIds('b', 200);
  env.state.scope = 'ws-b';
  env.state.ids = bIds;
  env.state.heights = flatHeights(bIds, 300);
  await env.renderNow();
  await env.flushFrames();
  assert.equal(env.state.scrollWrites, writesBefore, 'old-scope rows must never anchor the new scope');
  assert.equal(env.state.win.rows.length, 60);
  assert.ok(env.state.win.rows.every((r) => r.id.startsWith('b')));
  await env.close();
});

test('bottom intent through the REAL hook: the view follows the growing last row', async () => {
  const ids = rangeIds('r', 200);
  const heights = flatHeights(ids, 160);
  const env = makeList({ ids, heights });
  await env.renderNow();
  await env.flushFrames();
  const geoWarm = computeGeometry(ids, (id) => heights.get(id));
  await env.scrollTo(Math.max(0, geoWarm.total - 500));
  await env.flushFrames();
  assert.equal(env.state.scrollWrites, 0);
  heights.set('r199', 560);
  await env.renderNow();
  await env.flushFrames();
  const geoGrown = computeGeometry(ids, (id) => heights.get(id));
  assert.equal(env.state.scrollWrites, 1);
  assert.equal(env.state.scrollTop, Math.max(0, geoGrown.total - 500));
  await env.close();
});

test('drastic shrink: the correction clamps to the new scrollable range', async () => {
  const ids = rangeIds('r', 200);
  const heights = flatHeights(ids, 160);
  const env = makeList({ ids, heights });
  await env.renderNow();
  await env.flushFrames();
  const geoWarm = computeGeometry(ids, (id) => heights.get(id));
  await env.scrollTo(geoWarm.tops[197]);
  await env.flushFrames();
  env.state.ids = ids.slice(0, 5);
  await env.renderNow();
  await env.flushFrames();
  const geoSmall = computeGeometry(ids.slice(0, 5), (id) => heights.get(id));
  assert.equal(env.state.scrollWrites, 1);
  assert.equal(env.state.scrollTop, Math.max(0, geoSmall.total - 500));
  await env.close();
});

test('empty list to populated list: the transaction arms without writing', async () => {
  const heights = new Map();
  const env = makeList({ ids: [], heights });
  await env.renderNow();
  await env.flushFrames();
  assert.equal(env.state.win.rows.length, 0);
  const ids = rangeIds('r', 100);
  for (const id of ids) heights.set(id, 160);
  env.state.ids = ids;
  await env.renderNow();
  await env.flushFrames();
  assert.equal(env.state.win.rows.length, 60);
  assert.equal(env.state.scrollWrites, 0);
  await env.close();
});

test('plain covered scrolling never writes geometry', async () => {
  const ids = rangeIds('r', 200);
  const heights = flatHeights(ids, 160);
  const env = makeList({ ids, heights });
  await env.renderNow();
  await env.flushFrames();
  for (let i = 1; i <= 5; i++) {
    await env.scrollTo(i * 400);
    await env.flushFrames();
  }
  assert.equal(env.state.scrollWrites, 0);
  await env.close();
});
