'use client';

import { useEffect } from 'react';
import { lockScroll, unlockScroll } from '@/components/SmoothScrollProvider';

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
    // Freeze Lenis while the page is locked so the background doesn't glide behind the modal.
    // Ref-counted so stacked overlays keep it frozen until the last one closes.
    lockScroll();
    return () => {
      document.body.style.overflow = originalOverflow;
      document.body.style.paddingRight = originalPaddingRight;
      unlockScroll();
    };
  }, []);
}
