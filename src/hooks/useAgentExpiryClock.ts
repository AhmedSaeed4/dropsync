'use client';

import { useEffect, useState } from 'react';

// A local one-shot clock for open agent surfaces; no drop-list reads or periodic sort.
export function useAgentExpiryClock(open: boolean, expiresAt: number | null, scopeKey: string, onExpired?: () => void) {
  const [token, setToken] = useState(0);
  useEffect(() => {
    if (!open) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      if (timer !== undefined) clearTimeout(timer);
      if (expiresAt !== null && expiresAt > Date.now()) {
        timer = setTimeout(refresh, Math.min(expiresAt - Date.now() + 1, 2147483647));
      }
    };
    const refresh = () => {
      setToken(value => value + 1);
      if (expiresAt !== null && expiresAt <= Date.now()) onExpired?.();
      schedule();
    };
    const initial = setTimeout(refresh, 0);
    const visibility = () => { if (document.visibilityState === 'visible') refresh(); };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', visibility);
    schedule();
    return () => {
      clearTimeout(initial);
      if (timer !== undefined) clearTimeout(timer);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [open, expiresAt, scopeKey, onExpired]);
  return token;
}
