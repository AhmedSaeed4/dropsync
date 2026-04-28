'use client';

import { useEffect } from 'react';

/**
 * Locks body scroll when a modal is open.
 * Prevents background scroll on mobile when scrolling inside a modal.
 * Compensates scrollbar width to prevent layout shift.
 */
export function useBodyScrollLock() {
  useEffect(() => {
    const originalOverflow = document.body.style.overflow;
    const originalPaddingRight = document.body.style.paddingRight;
    const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;
    document.body.style.overflow = 'hidden';
    if (scrollbarWidth > 0) {
      document.body.style.paddingRight = `${scrollbarWidth}px`;
    }
    return () => {
      document.body.style.overflow = originalOverflow;
      document.body.style.paddingRight = originalPaddingRight;
    };
  }, []);
}
