// Order 67: dev-only calibration policy and plain metadata store.
// No React, browser reads, timers, persistence or I/O at module initialization.
import { EDITORIAL_WINDOW_ROW_BUDGET } from '@/lib/editorialWindowModel';

export interface EditorialWindowPolicy {
  requested: number | null;
  effectiveBudget: number;
  source: 'default' | 'override';
}

const TRIAL_VALUES = new Set(['60', '48', '36', '24', '16', '12']);

const DEFAULT_POLICY: EditorialWindowPolicy = Object.freeze({
  requested: null,
  effectiveBudget: EDITORIAL_WINDOW_ROW_BUDGET,
  source: 'default',
});

function isLoopback(host?: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}

export function resolveEditorialWindowPolicy(input?: {
  host?: string;
  search?: string;
  isDev?: boolean;
}): EditorialWindowPolicy {
  // The test seam cannot enable an override in an actual production build.
  if (process.env.NODE_ENV === 'production') return DEFAULT_POLICY;
  if (!(input?.isDev ?? (process.env.NODE_ENV === 'development')) || !isLoopback(input?.host)) {
    return DEFAULT_POLICY;
  }
  const values = new URLSearchParams(input?.search ?? '').getAll('editorialWindowBudget');
  if (values.length !== 1 || !TRIAL_VALUES.has(values[0])) return DEFAULT_POLICY;
  const requested = Number(values[0]);
  return { requested, effectiveBudget: requested, source: 'override' };
}

export type EditorialWindowBranch =
  | 'window-animated' | 'window-plain' | 'window-drag'
  | 'legacy-animated' | 'legacy-plain' | 'legacy-drag'
  | 'loading' | 'empty' | 'filtered-empty';

export interface EditorialWindowRowsReadout {
  // Counts DOM row occurrences, not unique IDs; exiting rows may still exist.
  mountedRowIdsCount: number | null;
  retainedRowCount: number;
  exitingRowCount: number | null;
  // UW's existing height-measurement publication counter; legacy has none.
  geometryVersion: number | null;
  rowsSampleReady: boolean;
}

export interface EditorialWindowReadoutMetadata extends EditorialWindowPolicy {
  // Null when no window is mounted (including the legacy renderer).
  appliedBudget: number | null;
  userReady: boolean;
  spaceReady: boolean;
  N: number;
  F: number;
  filters: Readonly<{ search: boolean; motionFiltered: boolean; category: string; mention: boolean }>;
  sort: string;
  manualOrderIdsCount: number;
  reducedMotion: boolean | null;
  enableDrag: boolean;
  animate: boolean;
  branch: EditorialWindowBranch;
}

export type EditorialWindowReadoutSample = EditorialWindowRowsReadout & {
  viewportWidth: number;
  mediaQueryMatches: boolean;
};

export type EditorialWindowReadoutSnapshot = Readonly<EditorialWindowReadoutMetadata
  & EditorialWindowReadoutSample & { epoch: number; scope: string }>;

export interface EditorialWindowReadoutLease {
  publish: (metadata: EditorialWindowReadoutMetadata, sample: () => EditorialWindowReadoutSample) => void;
  dispose: () => void;
}

// Samplers are replaced after commit, without publishing a frame or React state.
// An old branch's cleanup cannot erase the new branch's sampler.
export function createEditorialWindowProbe() {
  let current: (() => EditorialWindowRowsReadout) | null = null;
  return Object.freeze({
    bind(sample: () => EditorialWindowRowsReadout) {
      current = sample;
      return () => { if (current === sample) current = null; };
    },
    read(): EditorialWindowRowsReadout | null {
      return current?.() ?? null;
    },
  });
}
export type EditorialWindowProbe = ReturnType<typeof createEditorialWindowProbe>;

type ReadoutRecord = {
  epoch: number;
  scope: string;
  metadata: EditorialWindowReadoutMetadata | null;
  sample: (() => EditorialWindowReadoutSample) | null;
};
let nextEpoch = 0;
let active: ReadoutRecord | null = null;
const listeners = new Set<() => void>();

export function getEditorialWindowReadoutSnapshot(): EditorialWindowReadoutSnapshot | null {
  if (process.env.NODE_ENV !== 'development' || !active?.metadata || !active.sample) return null;
  // Explicit reads pull current committed rows/viewport; no frame publisher.
  return Object.freeze({
    ...active.metadata,
    ...active.sample(),
    epoch: active.epoch,
    scope: active.scope,
  });
}

export function subscribeEditorialWindowReadout(listener: () => void): () => void {
  if (process.env.NODE_ENV !== 'development') return () => {};
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function notify() {
  for (const listener of listeners) {
    try { listener(); } catch { /* A measuring callback must never affect the app. */ }
  }
}

export function registerEditorialWindowReadout(host: string, scope: string): EditorialWindowReadoutLease | null {
  if (process.env.NODE_ENV !== 'development' || !isLoopback(host)) return null;
  const record: ReadoutRecord = { epoch: ++nextEpoch, scope, metadata: null, sample: null };
  active = record;
  notify();
  return {
    publish(metadata, sample) {
      if (process.env.NODE_ENV !== 'development' || active !== record) return;
      record.metadata = Object.freeze({ ...metadata, filters: Object.freeze({ ...metadata.filters }) });
      record.sample = sample;
      notify();
    },
    dispose() {
      if (active !== record) return;
      active = null;
      record.metadata = null;
      record.sample = null;
      notify();
    },
  };
}
