import { useEffect, type RefObject } from "react";
import { resolveEditorialWindowPolicy, type EditorialWindowPolicy } from '@/lib/editorialWindowPolicy';

export interface NarrowReadout {
  prepareStartedAt?: number | null;
  preparedAt?: number | null;
  view: 'drops' | 'search' | 'middle';
  mounted: boolean;
  requestedTab: string;
  displayedTab: string;
  preparing: boolean;
  hidden: boolean;
  N: number;
  F: number;
  policy: EditorialWindowPolicy;
  appliedBudget: number | null;
  branch: string;
  mounts: number;
  measuredAt: number | null;
  revealedAt: number | null;
}
export interface NarrowSample {
  mounts?: number;
  prepareStartedAt?: number | null;
  preparedAt?: number | null;
  measuredAt?: number | null;
  revealedAt?: number | null;
  mountedRowIdsCount: number | null;
  retainedRowCount: number;
  exitingRowCount: number;
  geometryVersion: number | null;
  ready: boolean;
  stageOrigin: number | null;
  stageWidth: number | null;
  viewportWidth: number;
  scrollTop: number | null;
  viewportHeight: number | null;
}
type RecordEntry = { epoch: number; metadata: NarrowReadout | null; sample: (() => NarrowSample) | null };
const records = new Map<string, RecordEntry>();
const listeners = new Set<() => void>();
let epoch = 0;
const allowed = (host: string) => process.env.NODE_ENV === 'development'
  && ['localhost', '127.0.0.1', '[::1]'].includes(host);
function notify() { for (const fn of listeners) { try { fn(); } catch { /* Measurement is observational. */ } } }
export function getNarrowWindowSnapshot() {
  if (process.env.NODE_ENV !== 'development') return null;
  return Object.freeze([...records.values()].flatMap(record => {
    if (!record.metadata || !record.sample) return [];
    const sample = record.sample();
    return [Object.freeze({ prepareStartedAt: null, preparedAt: null, ...record.metadata, ...record.metadata.policy,
      active: !record.metadata.hidden, opened: record.metadata.mounted, ...sample,
      tier: sample.viewportWidth <= 767 ? 'phone' : sample.viewportWidth < 1400 ? 'middle' : 'wide', epoch: record.epoch })];
  }));
}
export function subscribeNarrowWindowReadout(fn: () => void) {
  if (process.env.NODE_ENV !== 'development') return () => {};
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
const api = Object.freeze({ getSnapshot: getNarrowWindowSnapshot, subscribe: subscribeNarrowWindowReadout });
declare global { interface Window { __dropsyncNarrowWindowCalibration?: typeof api } }
export function registerNarrowWindowReadout(host: string, key: string) {
  if (!allowed(host)) return null;
  const record: RecordEntry = { epoch: ++epoch, metadata: null, sample: null };
  records.set(key, record);
  if (typeof window !== 'undefined') window.__dropsyncNarrowWindowCalibration = api;
  return {
    publish(metadata: NarrowReadout, sample: () => NarrowSample) {
      if (!allowed(host) || records.get(key) !== record) return;
      record.metadata = Object.freeze({ ...metadata, policy: Object.freeze({ ...metadata.policy }) });
      record.sample = sample;
      notify();
    },
    dispose() {
      if (records.get(key) !== record) return;
      records.delete(key);
      if (!records.size && typeof window !== 'undefined' && window.__dropsyncNarrowWindowCalibration === api) delete window.__dropsyncNarrowWindowCalibration;
      notify();
    },
  };
}
export { resolveEditorialWindowPolicy };

/** Non-row states own the same view key; stale cleanup cannot erase its real renderer. */
export function useNarrowWindowStatus({
  enabled, view, userId, scope, mounted, requestedTab, displayedTab, preparing, N, F, branch, scrollerRef,
}: {
  enabled: boolean; view: NarrowReadout['view']; userId: string | null; scope: string;
  mounted: boolean; requestedTab: string; displayedTab: string; preparing: boolean;
  N: number; F: number; branch: string; scrollerRef?: RefObject<HTMLDivElement | null>;
}) {
  useEffect(() => {
    if (!enabled || process.env.NODE_ENV !== 'development') return;
    const lease = registerNarrowWindowReadout(window.location.hostname, JSON.stringify([userId, scope, view]));
    if (!lease) return;
    const ready = mounted && !!scrollerRef?.current?.clientWidth;
    const policy = resolveEditorialWindowPolicy({ host: window.location.hostname, search: window.location.search });
    lease.publish({ view, mounted, requestedTab, displayedTab, preparing, hidden: !mounted || displayedTab !== view,
      N, F, policy, appliedBudget: null, branch, mounts: 0,
      measuredAt: ready ? Date.now() : null, revealedAt: ready && displayedTab === view ? Date.now() : null,
    }, () => ({ mountedRowIdsCount: 0, retainedRowCount: 0, exitingRowCount: 0,
      geometryVersion: null, ready, stageOrigin: null, stageWidth: null, viewportWidth: window.innerWidth,
      scrollTop: scrollerRef?.current?.scrollTop ?? null, viewportHeight: scrollerRef?.current?.clientHeight ?? null }));
    return () => lease.dispose();
  }, [enabled, view, userId, scope, mounted, requestedTab, displayedTab, preparing, N, F, branch, scrollerRef]);
}
