'use client';
import { useSyncExternalStore } from 'react';

export type EditorialClientTier = 'phone' | 'middle' | 'wide' | 'unknown';
const phone = '(max-width: 767px)';
const wide = '(min-width: 1400px)';
function snapshot(): EditorialClientTier {
  if (typeof window === 'undefined') return 'unknown';
  return window.matchMedia(phone).matches ? 'phone' : window.matchMedia(wide).matches ? 'wide' : 'middle';
}
function subscribe(update: () => void) {
  const queries = [window.matchMedia(phone), window.matchMedia(wide)];
  queries.forEach(query => query.addEventListener('change', update));
  return () => queries.forEach(query => query.removeEventListener('change', update));
}
const serverSnapshot = (): EditorialClientTier => 'unknown';
// Only the post-hydration EditorialLayout consumes this hook.
export function useEditorialClientTier() {
  return useSyncExternalStore(subscribe, snapshot, serverSnapshot);
}
