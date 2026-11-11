'use client';

import { createContext, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject, type CSSProperties, type Ref } from 'react';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import type { EditorialWindowProbe } from '@/lib/editorialWindowPolicy';
import { motion } from 'motion/react';
import type { Drop } from '@/types';
import { classifyNewIds } from '@/lib/editorialWindowModel';
import { useNarrowEditorialWindow } from '@/hooks/useNarrowEditorialWindow';
import { registerNarrowWindowReadout, resolveEditorialWindowPolicy, type NarrowReadout, type NarrowSample } from '@/lib/editorialNarrowWindowReadout';
import { editorialCardCache } from '@/lib/editorialCardCache';

export const NarrowMediaContext = createContext<Map<string, { source: string; thumbnail: string }> | null>(null);

interface Props {
  drops: Drop[];
  presenceIds: string[];
  scrollerRef: RefObject<HTMLDivElement | null>;
  scope: string;
  userId: string | null;
  view: 'drops' | 'search' | 'middle';
  theme: string;
  N: number;
  animate: boolean;
  hidden?: boolean;
  requestedTab?: string;
  displayedTab?: string;
  preparing?: boolean;
  onReady?: () => void;
  effectiveBudget?: number;
  calibrationProbe?: EditorialWindowProbe;
  sortableIds?: string[];
  activeDragId?: string | null;
  renderRow: (drop: Drop, retain: (value: boolean) => void, handle?: Record<string, unknown>) => ReactNode;
}
type RowFact = { id: string; top: number; node: ReactNode };
const history = new Map<symbol, { scope: string; ids: Set<string>; presence: Set<string>; rows: RowFact[] }>();
const transition = { duration: 0.2, ease: [0.4, 0, 0.2, 1] as [number, number, number, number] };
const focusables = 'button:not([disabled]),a[href],input:not([disabled]),textarea:not([disabled]),[tabindex="0"]';

function Row({ id, top, children, enter, exit, animated, inset, retain, mounted, done, nodeRef, dragStyle }: {
  id: string; top: number; children: (retain: (value: boolean) => void) => ReactNode;
  enter: boolean; exit?: boolean; animated: boolean; inset: number;
  retain: (id: string) => () => void; mounted: () => void; done?: () => void; nodeRef?: Ref<HTMLDivElement>; dragStyle?: CSSProperties;
}) {
  const held = useRef<(() => void) | null>(null);
  const counted = useRef(false);
  const pin = useCallback((value: boolean) => {
    if (value && !held.current) held.current = retain(id);
    if (!value && held.current) { held.current(); held.current = null; }
  }, [id, retain]);
  useLayoutEffect(() => { if (!counted.current) { counted.current = true; mounted(); } }, [mounted]);
  useEffect(() => () => { held.current?.(); held.current = null; }, []);
  const style = { position: 'absolute' as const, top, left: inset, right: inset, ...dragStyle };
  // The factory receives an event-only lease callback; it does not read the ref.
  /* eslint-disable react-hooks/refs */
  return animated ? (
    <motion.div data-row-id={id} layout initial={enter ? { opacity: 0, scale: 0.97 } : false}
      animate={exit ? { opacity: 0, scale: 0.9 } : { opacity: 1, scale: 1 }}
      transition={transition} onAnimationComplete={exit ? done : undefined} style={style}>
      {children(pin)}
    </motion.div>
  ) : <div ref={nodeRef} data-row-id={id} style={style}>{children(pin)}</div>;
  /* eslint-enable react-hooks/refs */
}

function SortableRow({ id, render, ...props }: Omit<Parameters<typeof Row>[0], 'children'> & {
  render: (pin: (value: boolean) => void, handle: Record<string, unknown>) => ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  const handle = useMemo(() => ({ ...attributes, ...listeners }), [attributes, listeners]);
  return <Row {...props} id={id} nodeRef={setNodeRef} dragStyle={{
    transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
    transition: transition ?? undefined, zIndex: isDragging ? 50 : undefined,
    opacity: isDragging ? 0.85 : undefined,
  }}>{pin => render(pin, handle)}</Row>;
}

export const NarrowEditorialWindowList = memo(function NarrowEditorialWindowList({
  drops, presenceIds, scrollerRef, scope, userId, view, theme, N, animate, hidden = false,
  requestedTab = view, displayedTab = view, preparing = false, onReady, renderRow, effectiveBudget, calibrationProbe, sortableIds, activeDragId,
}: Props) {
  const [identity] = useState(() => Symbol('narrow-view'));
  const [policy, setPolicy] = useState(() => resolveEditorialWindowPolicy());
  useEffect(() => {
    if (process.env.NODE_ENV !== 'development') return;
    const resolved = resolveEditorialWindowPolicy({ host: window.location.hostname, search: window.location.search });
    // Resolve the loopback-only override after the default hydration commit.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (resolved.source === 'override') setPolicy(resolved);
  }, []);
  const accessGeneration = editorialCardCache.scopeGeneration(scope);
  const media = useMemo(() => {
    void userId; void scope; void accessGeneration;
    return new Map<string, { source: string; thumbnail: string }>();
  }, [userId, scope, accessGeneration]);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const ids = useMemo(() => drops.map(drop => drop.id), [drops]);
  const byId = useMemo(() => new Map(drops.map(drop => [drop.id, drop])), [drops]);
  const retained = useMemo(() => activeDragId ? new Set([activeDragId]) : undefined, [activeDragId]);
  const appliedBudget = effectiveBudget ?? policy.effectiveBudget;
  const win = useNarrowEditorialWindow(scope + ':' + view, ids, stageRef, retained, appliedBudget, {
    scrollerRef, padding: view === 'middle' ? 12 : 0, face: view + ':' + theme,
    session: userId ?? 'anonymous', accessGeneration: editorialCardCache.scopeGeneration(scope),
  });
  const edgeScroll = win.edgeScroll;
  useEffect(() => {
    if (!activeDragId || !ids.includes(activeDragId)) return;
    const move = (event: PointerEvent) => edgeScroll(event.clientY);
    window.addEventListener('pointermove', move, { passive: true });
    return () => { window.removeEventListener('pointermove', move); edgeScroll(null); };
  }, [activeDragId, ids, edgeScroll]);
  useLayoutEffect(() => {
    if (!calibrationProbe) return;
    return calibrationProbe.bind(() => ({
      mountedRowIdsCount: stageRef.current ? stageRef.current.children.length : null,
      retainedRowCount: win.retainedRowCount, exitingRowCount: Math.max(0, (stageRef.current?.children.length ?? 0) - win.rows.length),
      geometryVersion: win.geometryVersion, rowsSampleReady: win.ready,
    }));
  }, [calibrationProbe, win.rows, win.retainedRowCount, win.geometryVersion, win.ready]);
  const [exits, setExits] = useState<RowFact[]>([]);
  const [focusTarget, setFocusTarget] = useState<{ id: string; backwards: boolean } | null>(null);
  const focused = useRef<(() => void) | null>(null);
  const pressed = useRef<(() => void) | null>(null);
  const lifecycleKey = JSON.stringify([userId, scope, view]);
  const lifecycleRef = useRef({ key: lifecycleKey, mounts: 0, prepareStartedAt: null as number | null, preparedAt: null as number | null, measuredAt: null as number | null, revealedAt: null as number | null });
  const getLifecycle = useCallback(() => {
    if (lifecycleRef.current.key !== lifecycleKey) lifecycleRef.current = { key: lifecycleKey, mounts: 0, prepareStartedAt: null, preparedAt: null, measuredAt: null, revealedAt: null };
    return lifecycleRef.current;
  }, [lifecycleKey]);
  const lease = useRef<ReturnType<typeof registerNarrowWindowReadout>>(null);
  const sample = useRef<(() => NarrowSample) | null>(null);
  const countMount = useCallback(() => { if (process.env.NODE_ENV === 'development') getLifecycle().mounts++; }, [getLifecycle]);
  const previous = history.get(identity);
  const newIds = classifyNewIds(previous?.ids ?? null, !!previous && previous.scope !== scope, ids);

  useLayoutEffect(() => {
    const lifecycle = getLifecycle();
    if (process.env.NODE_ENV === 'development' && preparing && lifecycle.prepareStartedAt === null) lifecycle.prepareStartedAt = Date.now();
    const old = history.get(identity);
    if (old && old.scope === scope && animate) {
      const present = new Set(presenceIds);
      const removed = old.rows.filter(row => old.presence.has(row.id) && !present.has(row.id));
      // Preserve a truly deleted mounted row for the existing pre-paint exit transaction.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (removed.length) setExits(current => [...current.filter(row => !present.has(row.id)), ...removed.filter(row => !current.some(item => item.id === row.id))]);
    } else if (exits.length) setExits([]);
    history.set(identity, { scope, ids: new Set(ids), presence: new Set(presenceIds), rows: win.rows.flatMap(({ id, top }) => {
      const drop = byId.get(id);
      return drop ? [{ id, top, node: renderRow(drop, () => {}) }] : [];
    }) });
    if (win.ready) {
      if (process.env.NODE_ENV === 'development' && preparing && lifecycle.preparedAt === null) lifecycle.preparedAt = Date.now();
      if (process.env.NODE_ENV === 'development' && lifecycle.measuredAt === null) lifecycle.measuredAt = Date.now();
      if (process.env.NODE_ENV === 'development' && !hidden && lifecycle.revealedAt === null) lifecycle.revealedAt = Date.now();
      onReady?.();
    }
    if (process.env.NODE_ENV === 'development') sample.current = () => ({
      mountedRowIdsCount: stageRef.current ? Array.from(stageRef.current.children).filter(el => (el as HTMLElement).dataset.rowId).length : null,
      retainedRowCount: win.retainedRowCount, exitingRowCount: exits.length,
      geometryVersion: win.geometryVersion, ready: win.ready, stageOrigin: win.metrics.origin,
      stageWidth: win.metrics.width, viewportWidth: window.innerWidth,
      scrollTop: scrollerRef.current?.scrollTop ?? null, viewportHeight: scrollerRef.current?.clientHeight ?? null,
      mounts: lifecycle.mounts, prepareStartedAt: lifecycle.prepareStartedAt, preparedAt: lifecycle.preparedAt, measuredAt: lifecycle.measuredAt, revealedAt: lifecycle.revealedAt,
    });
  }, [identity, scope, animate, exits.length, ids, presenceIds, win.rows, win.ready, win.retainedRowCount, win.geometryVersion, win.metrics.origin, win.metrics.width, byId, renderRow, getLifecycle, hidden, preparing, onReady, scrollerRef]);

  useEffect(() => {
    if (process.env.NODE_ENV !== 'development') return;
    lease.current = registerNarrowWindowReadout(window.location.hostname, JSON.stringify([userId, scope, view]));
    return () => { lease.current?.dispose(); lease.current = null; };
  }, [userId, scope, view]);
  useEffect(() => {
    if (process.env.NODE_ENV !== 'development') return;
    const lifecycle = getLifecycle();
    const metadata: NarrowReadout = { view, mounted: true, requestedTab, displayedTab, preparing, hidden,
      N, F: drops.length, policy, appliedBudget, branch: sortableIds ? 'window-drag' : animate ? 'window-animated' : 'window-plain',
      mounts: lifecycle.mounts, prepareStartedAt: lifecycle.prepareStartedAt, preparedAt: lifecycle.preparedAt, measuredAt: lifecycle.measuredAt, revealedAt: lifecycle.revealedAt };
    lease.current?.publish(metadata, () => sample.current!());
  }, [view, userId, scope, requestedTab, displayedTab, preparing, hidden, N, drops.length, policy, animate, appliedBudget, sortableIds, getLifecycle]);

  useEffect(() => {
    const release = () => { pressed.current?.(); pressed.current = null; };
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', release);
    return () => { window.removeEventListener('pointerup', release); window.removeEventListener('pointercancel', release); release(); focused.current?.(); history.delete(identity); };
  }, [identity]);
  useLayoutEffect(() => {
    if (!focusTarget) return;
    const row = Array.from(stageRef.current?.children ?? []).find(el => (el as HTMLElement).dataset.rowId === focusTarget.id);
    const controls = row?.querySelectorAll<HTMLElement>(focusables);
    const target = controls?.[focusTarget.backwards ? controls.length - 1 : 0];
    // Clear this one-shot request only after its newly mounted DOM control receives focus.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (target) { target.focus(); setFocusTarget(null); }
  }, [focusTarget, win.rows]);
  const inset = view === 'middle' ? 12 : 0;
  return <NarrowMediaContext.Provider value={media}><div ref={stageRef} style={{ position: 'relative', height: win.totalHeight }}
    onPointerDownCapture={event => {
      const id = (event.target as HTMLElement).closest<HTMLElement>('[data-row-id]')?.dataset.rowId;
      pressed.current?.(); pressed.current = id ? win.retain(id) : null;
    }}
    onFocusCapture={event => {
      const id = (event.target as HTMLElement).closest<HTMLElement>('[data-row-id]')?.dataset.rowId;
      focused.current?.(); focused.current = id ? win.retain(id) : null;
    }}
    onBlurCapture={event => {
      if (!event.currentTarget.contains(event.relatedTarget as Node)) { focused.current?.(); focused.current = null; }
    }}
    onKeyDownCapture={event => {
      if (event.key !== 'Tab') return;
      const target = event.target as HTMLElement, row = target.closest<HTMLElement>('[data-row-id]');
      if (!row?.dataset.rowId) return;
      const controls = Array.from(row.querySelectorAll<HTMLElement>(focusables));
      if (target !== controls[event.shiftKey ? 0 : controls.length - 1]) return;
      const index = ids.indexOf(row.dataset.rowId), next = ids[index + (event.shiftKey ? -1 : 1)];
      if (!next || Array.from(stageRef.current?.children ?? []).some(el => (el as HTMLElement).dataset.rowId === next)) return;
      event.preventDefault(); focused.current?.(); focused.current = win.retain(next);
      setFocusTarget({ id: next, backwards: event.shiftKey });
    }}>
    <SortableContext items={sortableIds ?? []} strategy={verticalListSortingStrategy}>
    {win.rows.map(({ id, top }) => {
      const drop = byId.get(id);
      if (!drop) return null;
      if (sortableIds?.includes(id)) return <SortableRow key={id} id={id} top={top} enter={false} animated={false} inset={inset}
        retain={win.retain} mounted={countMount} render={(pin, handle) => renderRow(drop, pin, handle)} />;
      return <Row key={id} id={id} top={top} enter={animate && newIds.has(id)} animated={animate} inset={inset}
        retain={win.retain} mounted={countMount}>{pin => renderRow(drop, pin)}</Row>;
    })}
    </SortableContext>
    {animate && exits.filter(row => !byId.has(row.id)).map(row => <Row key={row.id} id={row.id} top={row.top} enter={false}
      exit animated inset={inset} retain={win.retain} mounted={countMount}
      done={() => setExits(current => current.filter(item => item.id !== row.id))}>{() => row.node}</Row>)}
  </div></NarrowMediaContext.Provider>;
});
