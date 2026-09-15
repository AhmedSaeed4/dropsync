'use client';

// DOM half of the editorial visible window (Round 9, Order 16 Stage A).
//
// Scroll law (Order 15 plan §1.4): the native scroll handler NEVER writes
// heights, totals, or scrollTop. Only a real size/data change publishes a
// geometry version; each publication carries AT MOST one pre-paint scroll
// correction, and that correction's own scroll event acknowledges it via
// CorrectionTracker (no "ignore next N events", no timers). The browser's
// scroll anchoring is opted out on the scroller so the controller is the
// single compensation owner.
//
// Ref discipline: the renderer owns the stage ref (a standard object ref on
// its own div) and passes it in; this hook touches refs only inside effects,
// event handlers, or observers — never during render — and returns only
// plain render data.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { flushSync } from 'react-dom';
import {
  applyMeasurements,
  bufferedRange,
  computeGeometry,
  CorrectionTracker,
  EDITORIAL_WINDOW_ROW_BUDGET,
  type Geometry,
  planAnchorCorrection,
  visibleRange,
} from '@/lib/editorialWindowModel';

// Learned heights survive renderer unmounts (e.g. crossing the 1400px
// breakpoint and back) within the page visit, keyed by workspace scope.
const heightStore = new Map<string, Map<string, number>>();

function storeFor(scope: string): Map<string, number> {
  let m = heightStore.get(scope);
  if (!m) {
    m = new Map();
    heightStore.set(scope, m);
  }
  return m;
}

// True at the editorial wide breakpoint (globals.css --breakpoint-wide: 1400px).
// Deliberately false on the server and through hydration; the wide branch
// mounts right after hydration on desktop (one silent flip, no mismatch).
export function useWideEditorial(): boolean {
  const [isWide, setIsWide] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1400px)');
    const sync = () => setIsWide(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);
  return isWide;
}

export interface EditorialWindowState {
  // The mounted slice in logical order with each row's stage-space top.
  rows: Array<{ id: string; top: number }>;
  // Full logical extent in px = the stage's explicit height.
  totalHeight: number;
}

export function useEditorialWindow(
  scope: string,
  ids: string[],
  stageRef: RefObject<HTMLDivElement | null>
): EditorialWindowState {
  const store = storeFor(scope);
  // Event-side indirection so the rAF flush always hits the current scope's
  // store without reading any value during render.
  const storeRef = useRef(store);
  useEffect(() => {
    storeRef.current = store;
  }, [store]);

  const [version, setVersion] = useState(0);
  const [rangeState, setRangeState] = useState({ start: 0, end: EDITORIAL_WINDOW_ROW_BUDGET - 1 });
  // Written only inside setRange (event/observer context), read by the scroll
  // handler — never during render.
  const rangeRef = useRef(rangeState);
  const setRange = useCallback((r: { start: number; end: number }) => {
    rangeRef.current = r;
    setRangeState(r);
  }, []);

  const scrollerRef = useRef<HTMLElement | null>(null);
  const pendingRef = useRef(new Map<string, number>());
  const flushQueuedRef = useRef(false);
  const trackerRef = useRef(new CorrectionTracker());
  const lastOffsetRef = useRef(0);
  const rowObserversRef = useRef(new Map<HTMLElement, { ro: ResizeObserver; id: string }>());
  const scrollerObserverRef = useRef<ResizeObserver | null>(null);
  // Geometry snapshots, written in the correction effect (post-commit):
  // geoRef mirrors the committed model for scroll-time reads; prevGeoRef
  // holds the previous publication for correction planning.
  const geoRef = useRef<Geometry | null>(null);
  const prevGeoRef = useRef<Geometry | null>(null);

  // Geometry is computed IN RENDER from the current ids + learned heights, so
  // a commit never carries tops that disagree with its own ids. `version` is
  // the publication counter: it is the signal that heights changed and the
  // geometry must be recomputed even though `ids` did not (intentional dep).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const geo = useMemo(() => computeGeometry(ids, (id) => store.get(id)), [ids, store, version]);

  const rows = useMemo(() => {
    const out: Array<{ id: string; top: number }> = [];
    const start = Math.max(0, rangeState.start);
    const end = Math.min(geo.ids.length - 1, rangeState.end);
    for (let i = start; i <= end; i++) {
      const id = geo.ids[i];
      if (id !== undefined) out.push({ id, top: geo.tops[i] });
    }
    return out;
  }, [geo, rangeState]);

  const flush = useCallback(() => {
    flushQueuedRef.current = false;
    if (pendingRef.current.size === 0) return;
    const batch = pendingRef.current;
    pendingRef.current = new Map();
    const { changed } = applyMeasurements(storeRef.current, batch);
    if (changed) setVersion((v) => v + 1);
  }, []);

  const queueFlush = useCallback(() => {
    if (flushQueuedRef.current) return;
    flushQueuedRef.current = true;
    requestAnimationFrame(flush);
  }, [flush]);

  // Enqueue a measurement fact. Never writes geometry, never nested-writes
  // the observed element's dimensions (plan §1.4 step 8).
  const measure = useCallback((el: HTMLElement, id: string) => {
    const h = el.offsetHeight;
    if (h > 0) pendingRef.current.set(id, h);
  }, []);

  const recomputeRange = useCallback(
    (allowSync: boolean) => {
      const el = scrollerRef.current;
      const g = geoRef.current;
      if (!el || !g || g.ids.length === 0) return;
      const vis = visibleRange(g, el.scrollTop, el.clientHeight);
      const dir = el.scrollTop >= lastOffsetRef.current ? 'down' : 'up';
      lastOffsetRef.current = el.scrollTop;
      const desired = bufferedRange(vis.first, vis.last, g.ids.length, EDITORIAL_WINDOW_ROW_BUDGET, dir);
      const cur = rangeRef.current;
      if (cur.start === desired.start && cur.end === desired.end) return;
      const covered = vis.first >= cur.start && vis.last <= cur.end;
      if (!covered && allowSync) {
        // Uncovered destination (fast thumb jump): mount synchronously so the
        // rows' layout-effect measurements can refine coverage before paint.
        flushSync(() => setRange(desired));
      } else {
        setRange(desired);
      }
    },
    [setRange]
  );

  // Scroller discovery + listener ownership. The stage's parentElement is the
  // native scroller (EditorialDropList's max-h-[500px] container). Layout
  // effects run after refs attach, so the stage is guaranteed present here.
  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const scroller = stage.parentElement;
    if (!scroller) return;
    scrollerRef.current = scroller;
    // The controller is the ONLY geometry-compensation owner (plan §1.4 step 1).
    scroller.style.overflowAnchor = 'none';
    const onScroll = () => {
      const el = scrollerRef.current;
      if (!el) return;
      // Our own correction's echo acknowledges it; anything else is input.
      if (trackerRef.current.classify(el.scrollTop) === 'ack') return;
      recomputeRange(true);
    };
    scroller.addEventListener('scroll', onScroll, { passive: true });
    const scrollerRo = new ResizeObserver(() => recomputeRange(false));
    scrollerRo.observe(scroller);
    scrollerObserverRef.current = scrollerRo;
    return () => {
      scroller.removeEventListener('scroll', onScroll);
      scrollerRo.disconnect();
      scrollerObserverRef.current = null;
      scroller.style.overflowAnchor = '';
      scrollerRef.current = null;
    };
    // stageRef is a stable object ref; including it is free and honest.
  }, [recomputeRange, stageRef]);

  // Measure newly rendered rows and observe later size changes (decrypt,
  // media, theme, fonts). Runs after every commit; cheap at ≤60 rows.
  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const observers = rowObserversRef.current;
    const seen = new Set<HTMLElement>();
    for (let k = 0; k < stage.children.length; k++) {
      const el = stage.children[k] as HTMLElement;
      const id = el.dataset.rowId;
      if (!id) continue;
      seen.add(el);
      measure(el, id);
      if (!observers.has(el)) {
        const ro = new ResizeObserver(() => {
          if (el.isConnected) {
            measure(el, id);
            queueFlush();
          }
        });
        ro.observe(el);
        observers.set(el, { ro, id });
      }
    }
    observers.forEach((entry, el) => {
      if (!seen.has(el)) {
        entry.ro.disconnect();
        observers.delete(el);
      }
    });
    queueFlush();
  });

  // The single correction writer: after a commit that changed the geometry,
  // read the LATEST actual offset, keep the surviving anchor's viewport
  // offset stable, and write at most one clamped correction before paint.
  useLayoutEffect(() => {
    geoRef.current = geo;
    const prev = prevGeoRef.current;
    if (prev === geo || prev === null || geo.ids.length === 0) return;
    prevGeoRef.current = geo;
    const el = scrollerRef.current;
    if (!el) return;
    const st = el.scrollTop;
    const clientH = el.clientHeight;
    // Bottom intent: the reader held the bottom of the OLD extent — keep the
    // bottom pinned while last-row measurements settle. Released by any
    // upward input, which is ordinary native scrolling (no write involved).
    const atBottom = st > 0 && st + clientH >= prev.total - 4;
    let target: number | null = null;
    const plan = planAnchorCorrection(prev, geo, st, clientH);
    if (plan) target = plan.target;
    if (atBottom) target = Math.max(0, geo.total - clientH);
    if (target === null) return;
    const maxScroll = Math.max(0, geo.total - clientH);
    const clamped = Math.min(maxScroll, Math.max(0, target));
    if (Math.abs(clamped - st) <= 1) return;
    el.scrollTop = clamped;
    trackerRef.current.arm(el.scrollTop);
  }, [geo]);

  // Full teardown: observers, queued facts, no recurring idle work remains.
  useEffect(() => {
    const observers = rowObserversRef.current;
    const pending = pendingRef.current;
    return () => {
      observers.forEach((entry) => entry.ro.disconnect());
      observers.clear();
      pending.clear();
      trackerRef.current = new CorrectionTracker();
    };
  }, []);

  return { rows, totalHeight: geo.total };
}
