'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from 'react';
import { flushSync } from 'react-dom';
import { applyMeasurements, bufferedRange, CorrectionTracker, edgeScrollDelta, EDITORIAL_WINDOW_ROW_BUDGET, mergeRetainedRows, planAnchorCorrection, visibleRange, type Geometry } from '@/lib/editorialWindowModel';
import { createNarrowRetentionLeases, projectNarrowGeometry, type NarrowMetrics } from '@/lib/editorialNarrowWindowGeometry';

interface Options {
  scrollerRef: RefObject<HTMLDivElement | null>;
  prefixRef?: RefObject<HTMLElement | null>;
  padding?: number;
  face?: string;
  session?: string;
  accessGeneration?: number;
}
const owners = new Set<symbol>();
let ownedSession: string | null = null;
const noRetainedRows: ReadonlySet<string> = new Set();
const serverRetainedRows = () => noRetainedRows;
const heights = new Map<string, { width: number; values: Map<string, number> }>();
function storeFor(key: string, width: number) {
  let entry = heights.get(key);
  if (!entry || entry.width !== width) {
    entry = { width, values: new Map() };
    heights.set(key, entry);
  }
  return entry.values;
}

export function useNarrowEditorialWindow(scope: string, ids: string[], stageRef: RefObject<HTMLDivElement | null>, retainedIds: ReadonlySet<string> | undefined, budget = EDITORIAL_WINDOW_ROW_BUDGET, options: Options) {
  const { scrollerRef, prefixRef, padding = 0, face = 'phone', session = scope, accessGeneration = 0 } = options;
  const key = JSON.stringify([session, scope, face, accessGeneration]);
  const leases = useMemo(() => { void key; return createNarrowRetentionLeases(); }, [key]);
  const leased = useSyncExternalStore(leases.subscribe, leases.getSnapshot, serverRetainedRows);
  const retained = useMemo(() => new Set([...(retainedIds ?? []), ...leased]), [retainedIds, leased]);
  useEffect(() => () => leases.clear(), [leases]);
  const [metrics, setMetrics] = useState<NarrowMetrics>({ origin: 0, width: 0, trailing: 0, padding });
  const [version, setVersion] = useState(0);
  const [range, setRange] = useState({ start: 0, end: budget - 1 });
  const store = storeFor(key, metrics.width);
  // version is the publication signal for this mutable, visit-scoped measurement store.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const geometry = useMemo(() => projectNarrowGeometry(ids, id => store.get(id), metrics), [ids, store, metrics, version]);
  const rows = useMemo(() => {
    const base = geometry.stage.ids.slice(Math.max(0, range.start), range.end + 1).map(id => ({ id, top: geometry.stage.tops[geometry.stage.indexById.get(id)!] }));
    return { base, all: mergeRetainedRows(base, retained, geometry.stage) };
  }, [geometry, range, retained]);
  const live = useRef<{ geo: Geometry; key: string; range: typeof range; budget: number; origin: number } | null>(null);
  const previous = useRef<{ geo: Geometry; key: string; origin: number; ready: boolean } | null>(null);
  const tracker = useRef(new CorrectionTracker());
  const direction = useRef(0);
  const frame = useRef<number | null>(null);
  const scrollFrame = useRef<number | null>(null);
  const active = useRef(false);
  const observer = useRef<ResizeObserver | null>(null);
  const observed = useRef(new Set<Element>());
  const queuedMeasure = useRef<() => void>(() => {});
  const pointerY = useRef<number | null>(null);

  const coverage = useCallback((sync: boolean) => {
    const s = scrollerRef.current, facts = live.current;
    if (!s || !facts || !facts.geo.ids.length) return;
    const visible = visibleRange(facts.geo, s.scrollTop, s.clientHeight);
    const next = bufferedRange(visible.first, visible.last, facts.geo.ids.length, facts.budget, s.scrollTop >= direction.current ? 'down' : 'up');
    direction.current = s.scrollTop;
    if (next.start === facts.range.start && next.end === facts.range.end) return;
    const covered = visible.first >= facts.range.start && visible.last <= facts.range.end;
    if (sync && !covered) flushSync(() => setRange(next));
    else setRange(next);
  }, [scrollerRef]);

  const measure = useCallback(() => {
    const stage = stageRef.current, scroller = scrollerRef.current;
    if (!stage || !scroller || !active.current) return;
    const width = scroller.clientWidth;
    const next: NarrowMetrics = {
      width, padding,
      origin: stage.getBoundingClientRect().top - scroller.getBoundingClientRect().top - scroller.clientTop + scroller.scrollTop,
      trailing: parseFloat(getComputedStyle(scroller).paddingBottom) || 0,
    };
    const batch = new Map<string, number>();
    for (const child of Array.from(stage.children)) {
      const row = child as HTMLElement;
      if (row.dataset.rowId && row.offsetHeight > 0) batch.set(row.dataset.rowId, row.offsetHeight);
    }
    const changed = applyMeasurements(storeFor(key, width), batch).changed;
    setMetrics(old => old.width === next.width && old.origin === next.origin && old.trailing === next.trailing && old.padding === next.padding ? old : next);
    if (changed) setVersion(v => v + 1);
  }, [stageRef, scrollerRef, padding, key]);

  useLayoutEffect(() => {
    const stage = stageRef.current, scroller = scrollerRef.current;
    if (!stage || !scroller) return;
    const token = Symbol();
    if (ownedSession !== session) { heights.clear(); ownedSession = session; }
    owners.add(token);
    let disposed = false;
    active.current = true;
    queuedMeasure.current = measure;
    const oldAnchor = scroller.style.overflowAnchor;
    scroller.style.overflowAnchor = 'none';
    const scroll = () => {
      if (disposed) return;
      if (tracker.current.classify(scroller.scrollTop) !== 'ack') coverage(true);
    };
    scroller.addEventListener('scroll', scroll, { passive: true });
    const ro = new ResizeObserver(() => {
      if (disposed || !active.current || frame.current !== null) return;
      frame.current = requestAnimationFrame(() => {
        frame.current = null;
        if (!disposed && active.current) queuedMeasure.current();
      });
    });
    observer.current = ro;
    observed.current.clear();
    measure();
    return () => {
      disposed = true;
      owners.delete(token);
      if (!owners.size) heights.clear();
      active.current = false;
      scroller.removeEventListener('scroll', scroll);
      scroller.style.overflowAnchor = oldAnchor;
      ro.disconnect();
      observed.current.clear();
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current);
      frame.current = scrollFrame.current = null;
      pointerY.current = null;
    };
  }, [stageRef, scrollerRef, coverage, measure, session]);

  useLayoutEffect(() => {
    queuedMeasure.current = measure;
    const stage = stageRef.current, scroller = scrollerRef.current, ro = observer.current;
    if (!stage || !scroller || !ro) return;
    const next = new Set<Element>([scroller, ...Array.from(stage.children)]);
    if (prefixRef?.current) next.add(prefixRef.current);
    // Header siblings affect the stage origin but not the row model.
    for (const sibling of Array.from(stage.parentElement?.children ?? [])) if (sibling !== stage) next.add(sibling);
    for (const el of observed.current) if (!next.has(el)) ro.unobserve(el);
    for (const el of next) if (!observed.current.has(el)) ro.observe(el);
    observed.current = next;
    measure();
  });

  useLayoutEffect(() => {
    const s = scrollerRef.current;
    const geo = geometry.physical;
    const old = previous.current;
    live.current = { geo, key, range, budget, origin: metrics.origin };
    previous.current = { geo, key, origin: metrics.origin, ready: metrics.width > 0 };
    if (!s) return;
    if (!old || !old.ready || old.key !== key) {
      tracker.current = new CorrectionTracker();
      direction.current = s.scrollTop;
    } else if (old.geo !== geo && geo.ids.length && s.scrollTop >= old.origin) {
      const bottom = s.scrollTop > 0 && s.scrollTop + s.clientHeight >= old.geo.total - 4;
      const plan = planAnchorCorrection(old.geo, geo, s.scrollTop, s.clientHeight);
      const target = bottom ? Math.max(0, geo.total - s.clientHeight) : plan?.target;
      if (target !== undefined && target !== null && Math.abs(target - s.scrollTop) > 1) {
        s.scrollTop = Math.max(0, Math.min(Math.max(0, geo.total - s.clientHeight), target));
        tracker.current.arm(s.scrollTop);
      }
    }
    coverage(false);
  }, [geometry, metrics.origin, metrics.width, range, budget, key, coverage, scrollerRef]);

  const edgeScroll = useCallback((y: number | null) => {
    pointerY.current = y;
    if (y === null) {
      if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current);
      scrollFrame.current = null;
      return;
    }
    if (scrollFrame.current !== null) return;
    const tick = () => {
      const s = scrollerRef.current, pointer = pointerY.current;
      if (!active.current || !s || pointer === null) { scrollFrame.current = null; return; }
      const rect = s.getBoundingClientRect();
      const delta = edgeScrollDelta(pointer, rect.top, rect.bottom);
      if (delta) s.scrollTop = Math.max(0, Math.min(Math.max(0, s.scrollHeight - s.clientHeight), s.scrollTop + delta));
      scrollFrame.current = requestAnimationFrame(tick);
    };
    scrollFrame.current = requestAnimationFrame(tick);
  }, [scrollerRef]);

  useEffect(() => {
    // Drop prior access epochs for this scope. Width history is bounded to one bucket.
    const prefix = JSON.stringify([session, scope, face]).slice(0, -1);
    for (const candidate of heights.keys()) if (candidate.startsWith(prefix) && candidate !== key) heights.delete(candidate);
  }, [key, session, scope, face]);

  return { rows: rows.all, totalHeight: geometry.stage.total, geometryVersion: version,
    retain: leases.retain, retainedRowCount: rows.all.length - rows.base.length, edgeScroll, metrics,
    ready: metrics.width > 0 };
}
