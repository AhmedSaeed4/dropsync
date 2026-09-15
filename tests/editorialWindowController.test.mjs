// Order 16 Stage A — controller transaction-sequence tests (node --test).
// The DOM hook is thin glue; every decision it makes runs through the pure
// model, so the full transaction lifecycle is driven here against fakes:
// publish → plan → single correction write → ack → quiescence.
// Run: node --test tests/editorialWindowController.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyMeasurements,
  computeGeometry,
  CorrectionTracker,
  planAnchorCorrection,
  visibleRange,
  bufferedRange,
  EDITORIAL_WINDOW_ROW_BUDGET,
} from '../src/lib/editorialWindowModel.ts';

const VIEWPORT = 500;

// A tiny fake of the controller's publication cycle: exactly what
// useEditorialWindow does per geometry publication, minus the DOM.
function makeController(ids) {
  const store = new Map();
  const state = {
    store,
    scrollTop: 0,
    writes: 0,
    geo: computeGeometry(ids, () => undefined),
    tracker: new CorrectionTracker(),
    lastWriteTarget: null,
  };
  state.geo = computeGeometry(ids, (id) => state.store.get(id));
  state.measure = (id, h) => {
    const batch = new Map([[id, h]]);
    const { changed } = applyMeasurements(state.store, batch);
    if (!changed) return false; // quiescence: no version, no correction, no write
    const prev = state.geo;
    const next = computeGeometry(ids, (id2) => state.store.get(id2));
    state.geo = next;
    // correction step — reads the LATEST actual offset at apply time
    const st = state.scrollTop;
    const atBottom = st > 0 && st + VIEWPORT >= prev.total - 4;
    let target = null;
    const plan = planAnchorCorrection(prev, next, st, VIEWPORT);
    if (plan) target = plan.target;
    if (atBottom) target = Math.max(0, next.total - VIEWPORT);
    if (target === null) return true;
    const maxScroll = Math.max(0, next.total - VIEWPORT);
    const clamped = Math.min(maxScroll, Math.max(0, target));
    if (Math.abs(clamped - st) <= 1) return true; // rounding tolerance: no write
    state.scrollTop = clamped;
    state.writes += 1;
    state.lastWriteTarget = clamped;
    state.tracker.arm(clamped);
    return true;
  };
  state.scroll = (offset) => {
    const kind = state.tracker.classify(offset);
    state.scrollTop = offset;
    if (kind === 'ack') return 'ack';
    // input: recompute the mounted range only (never writes geometry)
    const vis = visibleRange(state.geo, offset, VIEWPORT);
    return bufferedRange(vis.first, vis.last, state.geo.ids.length, EDITORIAL_WINDOW_ROW_BUDGET, 'down');
  };
  return state;
}

test('stable data + stable sizes reach quiescence: no writes, no pending work', () => {
  const c = makeController(Array.from({ length: 80 }, (_, i) => `r${i}`));
  c.scroll(400);
  // a FIRST measurement is a state transition (estimate → measured) even when
  // the value matches the estimate; re-measuring the same value is a no-op.
  assert.equal(c.measure('r0', 160), true);
  assert.equal(c.measure('r0', 160), false);
  assert.equal(c.measure('r1', 160), true);
  assert.equal(c.measure('r1', 160), false);
  // heights equal to the estimate move nothing: zero correction writes
  assert.equal(c.writes, 0);
  assert.equal(c.tracker.armed, false);
});

test('a correction is written once, acknowledged once, and cannot cascade', () => {
  const c = makeController(Array.from({ length: 200 }, (_, i) => `r${i}`));
  c.scroll(c.geo.tops[30]);
  const before = c.writes;
  // a row ABOVE the reading point gets measured taller → the anchor shifts
  assert.equal(c.measure('r29', 600), true);
  assert.equal(c.writes, before + 1);
  assert.ok(c.tracker.armed);
  // the correction's own scroll event (the browser reports the new offset)
  assert.equal(c.scroll(c.lastWriteTarget), 'ack');
  assert.equal(c.tracker.armed, false);
  // and it must not cause another correction: re-measuring → no-op
  assert.equal(c.measure('r29', 600), false);
  assert.equal(c.writes, before + 1);
});

test('genuine input during a pending correction is never overwritten', () => {
  const c = makeController(Array.from({ length: 200 }, (_, i) => `r${i}`));
  c.scroll(c.geo.tops[10]);
  c.measure('r5', 700); // a row ABOVE the reading point grows
  assert.ok(c.tracker.armed);
  const pendingTarget = c.lastWriteTarget;
  assert.equal(c.scrollTop, pendingTarget); // the write already moved the offset
  // the user scrolls UP before any echo acknowledges the write
  const userOffset = pendingTarget - 120;
  const range = c.scroll(userOffset);
  assert.notEqual(range, 'ack');
  assert.equal(c.scrollTop, userOffset);
  assert.equal(c.tracker.armed, false);
  // a later event at the old target is plain input, never a re-yank
  assert.notEqual(c.scroll(pendingTarget), 'ack');
  assert.equal(c.scrollTop, pendingTarget);
});

test('removing many rows above the viewport keeps the reading row steady', () => {
  const ids = Array.from({ length: 100 }, (_, i) => `r${i}`);
  const c = makeController(ids);
  c.scroll(c.geo.tops[50]);
  // rows 0..9 deleted from the data
  const after = computeGeometry(ids.slice(10), (id) => c.store.get(id));
  const plan = planAnchorCorrection(c.geo, after, c.scrollTop, VIEWPORT);
  assert.ok(plan);
  assert.equal(plan.anchorId, 'r50');
  assert.equal(after.ids[plan.anchorIndex], 'r50');
  assert.equal(plan.target, after.tops[40]); // r50 is now index 40
});

test('bottom intent: pin to the new bottom while last-row measurements settle', () => {
  const ids = Array.from({ length: 60 }, (_, i) => `r${i}`);
  const c = makeController(ids);
  // the reader sits at the bottom of the OLD extent
  c.scrollTop = Math.max(0, c.geo.total - VIEWPORT);
  // the last row's real height arrives late and grows the extent
  c.measure('r59', 800);
  assert.equal(c.scrollTop, Math.max(0, c.geo.total - VIEWPORT));
});

test('fast jump to an uncovered destination recomputes a full-budget range', () => {
  const ids = Array.from({ length: 400 }, (_, i) => `r${i}`);
  const c = makeController(ids);
  c.scroll(0);
  const targetTop = c.geo.tops[300];
  const range = c.scroll(targetTop);
  const vis = visibleRange(c.geo, targetTop, VIEWPORT);
  assert.ok(vis.first >= range.start && vis.last <= range.end);
  assert.equal(range.end - range.start + 1, EDITORIAL_WINDOW_ROW_BUDGET);
});
