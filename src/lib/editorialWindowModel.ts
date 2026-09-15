// Editorial visible-window geometry model (Round 9, Order 16 Stage A).
// PURE math + pure state machines only: no React, no DOM, no timers, no I/O.
// The DOM half lives in useEditorialWindow.ts; the renderer is
// EditorialWindowList.tsx. Keeping every number decision here makes the
// geometry testable with plain `node --test` (see tests/editorialWindow*.mjs).
//
// Design contract (Order 15 plan §1.4–§1.5):
//  - The window controller is the ONLY geometry-compensation owner. The
//    browser's scroll anchoring is opted out in the DOM; every compensation
//    goes through planAnchorCorrection() + the CorrectionTracker ack machine.
//  - A mounted-set change alone never moves a logical row's top or the total
//    extent (tested invariant) — window boundaries add/remove no layout height.
//  - One geometry version carries AT MOST one scroll correction, and the
//    correction's own scroll event acknowledges it instead of creating new
//    work (tested invariant).

// The single mounted-row budget (owner lock: ~60, owner-tunable in one place).
export const EDITORIAL_WINDOW_ROW_BUDGET = 60;
// Height guess for a row never measured before. Once a row is measured the
// real height is retained across unmount/remount; a guess is never revised
// from a moving average, and a measured row is never put back on a guess.
export const EDITORIAL_WINDOW_EST_ROW_H = 160;
// Explicit vertical gap between rows (replaces the legacy space-y-2 = 8px).
export const EDITORIAL_WINDOW_GAP_PX = 8;
// Stage padding top/bottom (replaces the legacy p-3 = 12px).
export const EDITORIAL_WINDOW_STAGE_PAD_PX = 12;

export interface Geometry {
  ids: string[];
  // tops[i] = stage-space top of logical row i. Strictly increasing.
  tops: number[];
  // Effective height used per row (measured when known, estimate otherwise).
  hs: number[];
  // Full logical extent in px = the stage's explicit height.
  total: number;
  indexById: Map<string, number>;
}

// A never-measured row uses the estimate; a measured row always uses its
// real height (min 1px so the geometry stays strictly increasing).
function effectiveH(measured: number | undefined): number {
  return Math.max(1, measured ?? EDITORIAL_WINDOW_EST_ROW_H);
}

export function computeGeometry(ids: string[], measuredOf: (id: string) => number | undefined): Geometry {
  const n = ids.length;
  const tops: number[] = new Array(n);
  const hs: number[] = new Array(n);
  const indexById = new Map<string, number>();
  let y = EDITORIAL_WINDOW_STAGE_PAD_PX;
  for (let i = 0; i < n; i++) {
    const id = ids[i];
    tops[i] = y;
    hs[i] = effectiveH(measuredOf(id));
    indexById.set(id, i);
    y += hs[i] + EDITORIAL_WINDOW_GAP_PX;
  }
  // Last row contributed a trailing gap that is actually bottom padding.
  const total = n === 0 ? 0 : y - EDITORIAL_WINDOW_GAP_PX + EDITORIAL_WINDOW_STAGE_PAD_PX;
  return { ids, tops, hs, total, indexById };
}

// First visible row for a native offset, counting its clipped part: the row
// whose band [top, top+h) contains `offset`; when `offset` sits in the gap
// below a row (or in the bottom padding) the incoming next row is first.
export function rowAtOffset(geo: Geometry, offset: number): number {
  const n = geo.ids.length;
  if (n === 0) return -1;
  if (offset <= geo.tops[0]) return 0;
  let lo = 0;
  let hi = n - 1;
  let ans = n - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (geo.tops[mid] <= offset) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (ans < n - 1 && offset >= geo.tops[ans] + geo.hs[ans]) return ans + 1;
  return ans;
}

export function visibleRange(geo: Geometry, scrollTop: number, viewportH: number): { first: number; last: number } {
  const n = geo.ids.length;
  if (n === 0) return { first: 0, last: -1 };
  const first = rowAtOffset(geo, scrollTop);
  const bottom = scrollTop + Math.max(1, viewportH);
  let lo = first;
  let hi = n - 1;
  let last = first;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (geo.tops[mid] < bottom) {
      last = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return { first, last };
}

// Mounted range around the visible rows within the row budget, favoring the
// travel direction while retaining a minority buffer behind (plan §1.3).
export function bufferedRange(
  first: number,
  last: number,
  n: number,
  budget: number,
  dir: 'up' | 'down'
): { start: number; end: number } {
  if (n === 0) return { start: 0, end: -1 };
  const visible = Math.max(1, last - first + 1);
  const buf = Math.max(0, budget - visible);
  const behind = Math.floor(buf / 3);
  const ahead = buf - behind;
  const above = dir === 'down' ? behind : ahead;
  const below = dir === 'down' ? ahead : behind;
  const rawStart = Math.max(0, first - above);
  const rawEnd = Math.min(n - 1, last + below);
  const unusedAbove = above - (first - rawStart);
  const unusedBelow = below - (rawEnd - last);
  const start = Math.max(0, rawStart - Math.max(0, unusedBelow));
  const end = Math.min(n - 1, rawEnd + Math.max(0, unusedAbove));
  return { start, end };
}

export interface CorrectionPlan {
  anchorId: string;
  anchorIndex: number;
  // The scrollTop to write for the new geometry (already clamped).
  target: number;
}

// The one geometry-compensation rule. Chooses the surviving anchor row from
// the OLD model at the LATEST actual scrollTop, keeps its viewport-relative
// offset u stable, and computes the clamped new offset. Only a real
// size/data change may call this — never a scroll event.
export function planAnchorCorrection(
  prev: Geometry,
  next: Geometry,
  scrollTop: number,
  viewportH: number
): CorrectionPlan | null {
  if (prev.ids.length === 0 || next.ids.length === 0) return null;
  const oldIndex = rowAtOffset(prev, scrollTop);
  if (oldIndex < 0) return null;
  const anchorId = prev.ids[oldIndex];
  let newIndex = next.indexById.get(anchorId);
  if (newIndex === undefined) {
    // Anchor deleted: nearest surviving neighbor in old order, forward first.
    newIndex = -1;
    for (let j = oldIndex + 1; j < prev.ids.length; j++) {
      const cand = next.indexById.get(prev.ids[j]);
      if (cand !== undefined) {
        newIndex = cand;
        break;
      }
    }
    if (newIndex < 0) {
      for (let j = oldIndex - 1; j >= 0; j--) {
        const cand = next.indexById.get(prev.ids[j]);
        if (cand !== undefined) {
          newIndex = cand;
          break;
        }
      }
    }
    if (newIndex < 0) return null;
  }
  const u = prev.tops[oldIndex] - scrollTop;
  const maxScroll = Math.max(0, next.total - viewportH);
  const target = Math.min(maxScroll, Math.max(0, next.tops[newIndex] - u));
  return { anchorId, anchorIndex: newIndex, target };
}

// Merge one measurement batch into the store. Equal values (within rounding)
// are ignored so re-measuring an unchanged row is a no-op (no new version).
export function applyMeasurements(store: Map<string, number>, batch: Map<string, number>): { changed: boolean } {
  let changed = false;
  batch.forEach((rawH, id) => {
    const h = Math.max(1, Math.round(rawH));
    const old = store.get(id);
    if (old === undefined || Math.abs(old - h) > 0) {
      store.set(id, h);
      changed = true;
    }
  });
  return { changed };
}

// Ack state machine: one armed correction at a time. The scroll event at the
// recorded readback ACKNOWLEDGES the correction; any other offset is genuine
// input and supersedes it. Never time-based, never event-count-based, so no
// genuine input can be discarded.
export const CORRECTION_ACK_TOLERANCE_PX = 2;

export class CorrectionTracker {
  private pending: number | null = null;

  arm(readbackTarget: number): void {
    this.pending = readbackTarget;
  }

  get armed(): boolean {
    return this.pending !== null;
  }

  classify(offset: number): 'ack' | 'input' {
    if (this.pending !== null && Math.abs(offset - this.pending) <= CORRECTION_ACK_TOLERANCE_PX) {
      this.pending = null;
      return 'ack';
    }
    this.pending = null;
    return 'input';
  }
}

// Full-sequence manual-order merge (used by the drag stage; tested here so
// the invariant is locked before any UI uses it): move one id within the
// COMPLETE eligible sequence, preserving every other id exactly once.
export function mergeFullOrder(fullIds: string[], movingId: string, targetId: string | null, placeAfter: boolean): string[] {
  const from = fullIds.indexOf(movingId);
  if (from < 0) return fullIds.slice();
  const next = fullIds.slice();
  next.splice(from, 1);
  let to: number;
  if (targetId === null || targetId === movingId) {
    to = next.length;
  } else {
    const t = next.indexOf(targetId);
    if (t < 0) return fullIds.slice();
    to = placeAfter ? t + 1 : t;
  }
  next.splice(to, 0, movingId);
  return next;
}
