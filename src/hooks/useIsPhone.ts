'use client';

import { useState, useEffect } from 'react';

// True on phones only — the Editorial mobile redesign's gate (decision #2: ≤767px).
// Distinct from useIsMobile (1023px, the stacked-chat behavior) — never conflate them.
// SSR-safe (defaults false, settles on mount); reactive to resize.
const PHONE_QUERY = '(max-width: 767px)';

export function useIsPhone(): boolean {
  const [isPhone, setIsPhone] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mql = window.matchMedia(PHONE_QUERY);
    const update = () => setIsPhone(mql.matches);
    update();
    mql.addEventListener('change', update);
    return () => mql.removeEventListener('change', update);
  }, []);
  return isPhone;
}
