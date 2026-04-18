'use client';

import { useEffect } from 'react';

/**
 * Locks body scroll when a modal is open.
 * Prevents background scroll on mobile when scrolling inside a modal.
 */
export function useBodyScrollLock() {
  useEffect(() => {
    const original = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = original;
    };
  }, []);
}
