// Order 16 Stage A — pure geometry model tests (node --test, no framework).
// Run: node --test tests/editorialWindowModel.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyMeasurements,
  bufferedRange,
  classifyNewIds,
  computeGeometry,
  CorrectionTracker,
  edgeScrollDelta,
  EDITORIAL_WINDOW_EST_ROW_H,
  EDITORIAL_WINDOW_GAP_PX,
  EDITORIAL_WINDOW_ROW_BUDGET,
  EDITORIAL_WINDOW_STAGE_PAD_PX,
  mergeFullOrder,
  mergeRetainedRows,
  planAnchorCorrection,
  rowAtOffset,
  visibleRange,
} from '../src/lib/editorialWindowModel.ts';

function naiveRange(geo, scrollTop, viewportH) {
  const bottom = scrollTop + viewportH;
  let first = -1;
  let last = -1;
  for (let i = 0; i < geo.ids.length; i++) {
    const top = geo.tops[i];
    const bot = top + geo.hs[i];
    if (bot > scrollTop && top < bottom) {
      if (first < 0) first = i;
      last = i;
    }
  }
  return { first: first < 0 ? 0 : first, last: last < 0 ? 0 : last };
}

test('computeGeometry matches the naive reference (tops/total/gap/padding)', () => {
  const ids = ['a', 'b', 'c'];
  const store = new Map([['a', 100], ['b', 250]]);
  const geo = computeGeometry(ids, (id) => store.get(id));
  assert.deepEqual(geo.tops, [12, 12 + 100 + 8, 12 + 100 + 8 + 250 + 8]);
  const expectedTotal = 12 + (100 + 8) + (250 + 8) + (160 + 8) - 8 + 12;
  assert.equal(geo.total, expectedTotal);
  assert.equal(geo.indexById.get('c'), 2);
});

test('computeGeometry is a pure function of ids + measured heights', () => {
  const store = new Map([['a', 120], ['b', 90]]);
  const g1 = computeGeometry(['a', 'b'], (id) => store.get(id));
  const g2 = computeGeometry(['a', 'b'], (id) => store.get(id));
  assert.deepEqual(g1.tops, g2.tops);
  assert.equal(g1.total, g2.total);
});

test('rowAtOffset: inside a row, in a gap, above the first, below the last', () => {
  const geo = computeGeometry(['a', 'b', 'c'], () => 100);
  assert.equal(rowAtOffset(geo, 50), 0); // inside a
  assert.equal(rowAtOffset(geo, 12 + 100 + 4), 1); // in the gap below a → b is first visible
  assert.equal(rowAtOffset(geo, 0), 0); // top padding
  assert.equal(rowAtOffset(geo, 99999), 2); // bottom padding keeps the last row
});

test('visibleRange agrees with the naive scan at many offsets', () => {
  const hs = [40, 300, 90, 500, 60, 220, 130];
  const ids = hs.map((_, i) => `id${i}`);
  const geo = computeGeometry(ids, (id) => hs[Number(id.slice(2))]);
  for (const vh of [300, 500, 900]) {
    // only real scrollable offsets: a browser can never report scrollTop
    // beyond total - viewport, so the bottom-padding zone is not compared
    const maxScroll = Math.max(0, geo.total - vh);
    for (let off = 0; off <= maxScroll; off += 17) {
      const got = visibleRange(geo, off, vh);
      const want = naiveRange(geo, off, vh);
      assert.deepEqual(got, want, `off=${off} vh=${vh}`);
    }
  }
});

test('bufferedRange honors the row budget and favors travel direction', () => {
  const n = 400;
  const first = 100;
  const last = 103;
  const down = bufferedRange(first, last, n, EDITORIAL_WINDOW_ROW_BUDGET, 'down');
  const up = bufferedRange(first, last, n, EDITORIAL_WINDOW_ROW_BUDGET, 'up');
  assert.equal(down.end - down.start + 1, EDITORIAL_WINDOW_ROW_BUDGET);
  assert.equal(up.end - up.start + 1, EDITORIAL_WINDOW_ROW_BUDGET);
  // travelling down keeps more buffer BELOW the viewport; travelling up, above.
  assert.ok(down.end - last > up.end - last);
  assert.ok(first - down.start < first - up.start);
  // clamped at the top edge: the budget tops up below
  const top = bufferedRange(0, 2, n, EDITORIAL_WINDOW_ROW_BUDGET, 'up');
  assert.equal(top.start, 0);
  assert.equal(top.end - top.start + 1, EDITORIAL_WINDOW_ROW_BUDGET);
  // clamped at the bottom edge
  const bottom = bufferedRange(n - 3, n - 1, n, EDITORIAL_WINDOW_ROW_BUDGET, 'down');
  assert.equal(bottom.end, n - 1);
  assert.equal(bottom.end - bottom.start + 1, EDITORIAL_WINDOW_ROW_BUDGET);
});

test('planAnchorCorrection keeps the anchor viewport-stable when heights refine', () => {
  const store = new Map();
  const ids = Array.from({ length: 50 }, (_, i) => `r${i}`);
  const before = computeGeometry(ids, (id) => store.get(id));
  const scrolledTo = before.tops[20];
  // rows 18-20 get measured much taller
  store.set('r18', 400);
  store.set('r19', 380);
  store.set('r20', 420);
  const after = computeGeometry(ids, (id) => store.get(id));
  const plan = planAnchorCorrection(before, after, scrolledTo, 500);
  assert.ok(plan);
  assert.equal(plan.anchorId, 'r20');
  assert.equal(plan.target, after.tops[20]); // u = 0 → the anchor stays at the top edge
});

test('planAnchorCorrection: deleted anchor falls forward, then backward', () => {
  const ids = Array.from({ length: 30 }, (_, i) => `r${i}`);
  const before = computeGeometry(ids, () => undefined);
  const at = before.tops[10];
  // delete the anchor r10 only: the surviving neighbor r11 takes its place
  const without10 = ids.filter((id) => id !== 'r10');
  const afterF = computeGeometry(without10, () => undefined);
  const planF = planAnchorCorrection(before, afterF, at, 500);
  assert.equal(planF.anchorId, 'r10'); // the original anchor id is reported as-is
  assert.equal(afterF.ids[planF.anchorIndex], 'r11');
  // delete the anchor AND everything after it → falls backward to r9
  const headOnly = ids.slice(0, 10);
  const afterB = computeGeometry(headOnly, () => undefined);
  const planB = planAnchorCorrection(before, afterB, at, 500);
  assert.equal(planB.anchorId, 'r10');
  assert.equal(afterB.ids[planB.anchorIndex], 'r9');
});

test('planAnchorCorrection clamps to the new scrollable range', () => {
  const ids = Array.from({ length: 10 }, (_, i) => `r${i}`);
  const before = computeGeometry(ids, () => undefined);
  const near = computeGeometry(ids.slice(0, 2), () => undefined);
  const plan = planAnchorCorrection(before, near, before.tops[8], 500);
  assert.ok(plan);
  assert.ok(plan.target <= Math.max(0, near.total - 500));
});

test('applyMeasurements: same measurement twice is a no-op', () => {
  const store = new Map([['a', 100]]);
  const b1 = new Map([['a', 100]]);
  assert.equal(applyMeasurements(store, b1).changed, false);
  const b2 = new Map([['a', 101]]);
  assert.equal(applyMeasurements(store, b2).changed, true);
});

test('CorrectionTracker: the correction echo acknowledges, it cannot re-trigger', () => {
  const t = new CorrectionTracker();
  assert.equal(t.armed, false);
  t.arm(417);
  assert.equal(t.classify(418), 'ack'); // within tolerance
  assert.equal(t.armed, false);
  assert.equal(t.classify(418), 'input'); // a second identical event is genuine input
  t.arm(417);
  assert.equal(t.classify(900), 'input'); // genuine input supersedes the pending target
  assert.equal(t.classify(417), 'input'); // the stale target can no longer "ack"
});

test('mergeFullOrder preserves every id exactly once and ineligible slots', () => {
  const full = ['p1', 'p2', 'p3', 'p4', 'p5'];
  assert.deepEqual(mergeFullOrder(full, 'p2', 'p5', true), ['p1', 'p3', 'p4', 'p5', 'p2']);
  assert.deepEqual(mergeFullOrder(full, 'p4', 'p1', false), ['p4', 'p1', 'p2', 'p3', 'p5']);
  // dragging to the end
  assert.deepEqual(mergeFullOrder(full, 'p1', null, true), ['p2', 'p3', 'p4', 'p5', 'p1']);
  // unknown target refuses rather than corrupts
  assert.deepEqual(mergeFullOrder(full, 'p1', 'nope', false), full);
  const result = mergeFullOrder(full, 'p3', 'p2', true);
  assert.deepEqual([...result].sort(), [...full].sort());
  assert.equal(result.length, full.length);
});

test('estimate constant sanity', () => {
  assert.ok(EDITORIAL_WINDOW_EST_ROW_H > 0);
  assert.equal(EDITORIAL_WINDOW_GAP_PX, 8);
  assert.equal(EDITORIAL_WINDOW_STAGE_PAD_PX, 12);
  assert.equal(typeof EDITORIAL_WINDOW_ROW_BUDGET, 'number');
});

// ---- Order 18 (Stages D+E) ----

test('edge autoscroll: zero in the middle, linear ramp in the zones, saturated outside', () => {
  const top = 100;
  const bottom = 600; // a 500px-tall scroller rect
  assert.equal(edgeScrollDelta(350, top, bottom), 0);
  assert.equal(edgeScrollDelta(top + 24, top, bottom), -9); // half a zone deep = half speed
  assert.equal(edgeScrollDelta(top, top, bottom), -18); // at the edge = max speed
  assert.equal(edgeScrollDelta(top - 10, top, bottom), -18); // held past the edge = saturated
  assert.equal(edgeScrollDelta(top + 48, top, bottom), 0); // the zone boundary is outside the zone
  assert.equal(edgeScrollDelta(bottom - 24, top, bottom), 9);
  assert.equal(edgeScrollDelta(bottom, top, bottom), 18);
  assert.equal(edgeScrollDelta(bottom + 10, top, bottom), 18);
});

test('retained rows: the drag source stays mounted at its model top after the window slid past', () => {
  const geo = computeGeometry(Array.from({ length: 40 }, (_, i) => `r${i}`), () => undefined);
  const slice = [];
  for (let i = 10; i <= 20; i++) slice.push({ id: `r${i}`, top: geo.tops[i] });
  // dragging r2, far above the slice: appended at its model top, strict order kept
  const merged = mergeRetainedRows(slice, new Set(['r2']), geo);
  assert.equal(merged.length, 12);
  assert.equal(merged[0].id, 'r2');
  assert.equal(merged[0].top, geo.tops[2]);
  assert.deepEqual(merged.slice(1).map((r) => r.id), slice.map((r) => r.id));
  // retained id already inside the slice: no duplicate, same array
  assert.equal(mergeRetainedRows(slice, new Set(['r15']), geo), slice);
  // retained id missing from the geometry (deleted mid-drag): skipped
  assert.equal(mergeRetainedRows(slice, new Set(['ghost']), geo), slice);
  // no retention: same array
  assert.equal(mergeRetainedRows(slice, undefined, geo), slice);
  // above AND below retained: still one strictly ordered list
  const both = mergeRetainedRows(slice, new Set(['r2', 'r35']), geo);
  assert.deepEqual(both.map((r) => r.id), ['r2', ...slice.map((r) => r.id), 'r35']);
});

test('mutation classification: scroll mounts never animate; adds, undo and scope switches do', () => {
  const full = ['a', 'b', 'c', 'd'];
  // initial load animates nothing
  assert.equal(classifyNewIds(null, false, full).size, 0);
  // scroll mount: the window's row ids were all in the previous commit
  const prev = new Set(full);
  assert.equal(classifyNewIds(prev, false, ['b', 'c']).size, 0);
  // genuine add / undo-restore
  assert.deepEqual([...classifyNewIds(new Set(['a', 'b']), false, ['a', 'b', 'x'])].sort(), ['x']);
  // workspace switch: everything animates in (legacy re-key parity)
  assert.deepEqual([...classifyNewIds(new Set(['a', 'b']), true, ['p', 'q'])].sort(), ['p', 'q']);
});
