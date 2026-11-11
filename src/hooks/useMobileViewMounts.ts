'use client';
import { useCallback, useEffect, useLayoutEffect, useMemo, useState, useSyncExternalStore } from 'react';
const REVEAL_BOUND_MS = 350;
type Tab = 'drops' | 'create' | 'search';
const visible = () => typeof document !== 'undefined' && !document.hidden;
function subscribe(fn: () => void) { document.addEventListener('visibilitychange', fn); return () => document.removeEventListener('visibilitychange', fn); }
const serverVisible = () => false;
export function useMobileViewMounts(scope: string, reduced: boolean) {
  const [state, setState] = useState(() => ({ scope, requested: 'drops' as Tab, displayed: 'drops' as Tab,
    opened: new Set<Tab>(['drops']), shown: new Set<Tab>(['drops']), preparing: null as Tab | null, generation: 0, ready: false }));
  const documentVisible = useSyncExternalStore(subscribe, visible, serverVisible);
  const request = useCallback((tab: Tab) => {
    setState(old => {
      if (old.requested === tab) return old;
      const first = !old.shown.has(tab);
      return { ...old, requested: tab, displayed: first ? old.displayed : tab,
        opened: new Set([...old.opened, tab]), preparing: first ? tab : null,
        generation: old.generation + 1, ready: false };
    });
  }, []);
  const acknowledge = useCallback((tab: Tab, generation: number) => {
    setState(old => old.generation !== generation || old.preparing !== tab || old.ready ? old : { ...old, ready: true });
  }, []);
  const ack = useMemo(() => ({
    drops: () => acknowledge('drops', state.generation),
    create: () => acknowledge('create', state.generation),
    search: () => acknowledge('search', state.generation),
  }), [acknowledge, state.generation]);
  useLayoutEffect(() => {
    // Invalidate prior-scope readiness synchronously before a reveal can paint.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (state.scope !== scope) setState(old => ({ ...old, scope, generation: old.generation + 1, ready: false }));
  }, [scope, state.scope]);
  useLayoutEffect(() => {
    if (!reduced || !documentVisible || !state.preparing || !state.ready) return;
    // The reduced-motion contract requires reveal in this measured pre-paint commit.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setState(old => old.generation !== state.generation ? old : { ...old, displayed: old.requested, shown: new Set([...old.shown, old.requested]), preparing: null });
  }, [reduced, documentVisible, state.preparing, state.ready, state.generation]);
  useEffect(() => {
    if (reduced || !documentVisible || state.scope !== scope || !state.preparing || !state.ready) return;
    let active = true;
    let second: number | undefined;
    const cancel = () => {
      active = false;
      cancelAnimationFrame(first);
      if (second !== undefined) cancelAnimationFrame(second);
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', reveal);
    };
    const reveal = () => {
      if (!active) return;
      if (!visible()) {
        // A delayed visibility notification must not lose an expired bound.
        document.addEventListener('visibilitychange', reveal);
        return;
      }
      cancel();
      setState(old => old.generation !== state.generation || old.scope !== scope
        || old.requested !== state.requested || old.preparing !== state.preparing || !old.ready || !visible() ? old
        : { ...old, displayed: old.requested, shown: new Set([...old.shown, old.requested]), preparing: null });
    };
    const timer = setTimeout(reveal, REVEAL_BOUND_MS);
    const first = requestAnimationFrame(() => {
      if (active) second = requestAnimationFrame(reveal);
    });
    return cancel;
  }, [reduced, documentVisible, scope, state.scope, state.requested, state.preparing, state.ready, state.generation]);
  return { requestedTab: state.requested, displayedTab: state.displayed, opened: state.opened,
    preparing: state.preparing, request, ack };
}
