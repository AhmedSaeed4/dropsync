'use client';

import { useState, useEffect } from 'react';

// True on screens below Tailwind's lg breakpoint (1024px) — i.e. the mobile/stacked layout
// where the chat panel is NOT a persistent docked column. SSR-safe (defaults false, settles
// on mount); reactive to resize.
const MOBILE_QUERY = '(max-width: 1023px)';

export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mql = window.matchMedia(MOBILE_QUERY);
    const update = () => setIsMobile(mql.matches);
    update();
    mql.addEventListener('change', update);
    return () => mql.removeEventListener('change', update);
  }, []);
  return isMobile;
}
