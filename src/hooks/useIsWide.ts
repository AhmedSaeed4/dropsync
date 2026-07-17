'use client';

import { useState, useEffect } from 'react';

// True on screens at/above the project's `wide` breakpoint (1400px — `--breakpoint-wide` in
// globals.css): large desktops, where the footer + dissolve + magnet are active. Below 1400px the
// footer is not rendered at all, so the dissolve/magnet self-heal polls never find `#footer-shell`
// and stay unattached (plain single-screen app with internal `#app-main` scrolling). SSR-safe
// (defaults `false` so the server render and first client render match — no hydration mismatch),
// then settles to the real value and subscribes to `change`.
const WIDE_QUERY = '(min-width: 1400px)';

export function useIsWide(): boolean {
  const [isWide, setIsWide] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mql = window.matchMedia(WIDE_QUERY);
    const update = () => setIsWide(mql.matches);
    update();
    mql.addEventListener('change', update);
    return () => mql.removeEventListener('change', update);
  }, []);
  return isWide;
}
