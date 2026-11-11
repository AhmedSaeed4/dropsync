import { computeGeometry, type Geometry } from '@/lib/editorialWindowModel';

export interface NarrowMetrics {
  origin: number;
  width: number;
  trailing: number;
  padding: number;
}
export function projectNarrowGeometry(ids: string[], measured: (id: string) => number | undefined, metrics: NarrowMetrics) {
  const base = computeGeometry(ids, measured);
  const stageHeight = ids.length ? base.total - 24 + 2 * metrics.padding : 0;
  const tops = base.tops.map(top => top - 12 + metrics.padding);
  const stage: Geometry = { ...base, tops, total: stageHeight };
  const physical: Geometry = {
    ...stage, tops: tops.map(top => top + metrics.origin),
    total: metrics.origin + stageHeight + metrics.trailing,
  };
  return { stage, physical };
}

// Token-owned row continuity. Releasing an old token never releases a replacement.
export function createNarrowRetentionLeases() {
  const tokens = new Map<string, Set<symbol>>();
  let snapshot: ReadonlySet<string> = new Set();
  const listeners = new Set<() => void>();
  const publish = () => { snapshot = new Set(tokens.keys()); for (const fn of listeners) fn(); };
  return {
    getSnapshot: () => snapshot,
    subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    retain(id: string) {
      const token = Symbol(id);
      const group = tokens.get(id) ?? new Set<symbol>();
      const first = !tokens.has(id);
      group.add(token); tokens.set(id, group);
      if (first) publish();
      return () => {
        if (tokens.get(id) !== group || !group.delete(token)) return;
        if (!group.size) { tokens.delete(id); publish(); }
      };
    },
    clear() { if (tokens.size) { tokens.clear(); publish(); } },
  };
}
