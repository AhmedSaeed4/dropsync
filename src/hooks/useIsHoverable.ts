'use client';

import { useEffect, useState } from 'react';

/**
 * Reactive `(hover: hover)` media query — true on pointer devices that can hover (desktop),
 * false on touch-first devices. SSR-safe (defaults false until mounted) and reactive (re-checks
 * when the matchMedia result changes). Used to choose between a hover tooltip (desktop) and a
 * tap popup (mobile) for faded, non-functional action buttons on locked drops.
 */
export function useIsHoverable(): boolean {
  const [hoverable, setHoverable] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia('(hover: hover)');
    const update = () => setHoverable(mql.matches);
    update();
    mql.addEventListener('change', update);
    return () => mql.removeEventListener('change', update);
  }, []);

  return hoverable;
}
