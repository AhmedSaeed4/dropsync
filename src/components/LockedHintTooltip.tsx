'use client';

import { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';

// Gap between the gesture point and the hint, and the margin kept from the viewport edges.
const TOOLTIP_GAP = 8;
const EDGE_MARGIN = 8;
const AUTO_DISMISS_MS = 2500;
const MESSAGE = 'This drop is locked — only its creator can change it.';

interface LockedHintTooltipProps {
  /** The gesture point (right-click / long-press coords) to anchor the hint above. */
  x: number;
  y: number;
  onClose: () => void;
}

/**
 * Auto-dismissing "locked" hint, shown at the context-menu gesture point when a non-creator
 * right-clicks (desktop) or long-presses (mobile) a locked drop. Replaces the silent dead-end
 * where the context menu simply doesn't open.
 *
 * The bubble is portaled to document.body with position: fixed so it can't be clipped by an
 * ancestor's overflow container — the same approach as Tooltip.tsx / LockedActionButton.tsx. It
 * starts off-screen + opacity-0 until measured, then fades in (no flash), centered above the
 * (x, y) gesture point and clamped horizontally to the viewport. The bubble is pointer-events-none
 * (purely informational), so a full-screen click/tap-away overlay is the sole event handler: any
 * pointer interaction anywhere dismisses the hint. It also self-dismisses after AUTO_DISMISS_MS.
 *
 * z-index mirrors the context menu: overlay z-[200], bubble z-[201].
 */
export function LockedHintTooltip({ x, y, onClose }: LockedHintTooltipProps) {
  const bubbleRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  // Once mounted, measure the bubble and place it centered above the gesture point, clamped to the
  // viewport so it never runs off-screen at the edges. Runs after it's in the DOM (ref attached).
  useEffect(() => {
    if (!bubbleRef.current) return;
    const bubbleRect = bubbleRef.current.getBoundingClientRect();
    const halfW = bubbleRect.width / 2;
    const left = Math.min(
      Math.max(x, halfW + EDGE_MARGIN),
      window.innerWidth - halfW - EDGE_MARGIN
    );
    // translate(-50%, -100%) centers the bubble on `left` and lifts it above `top` by its own
    // height, so `top` is the bubble's bottom edge (TOOLTIP_GAP above the gesture point).
    const top = y - TOOLTIP_GAP;
    setPos({ top, left });
  }, [x, y]);

  // Auto-dismiss after a short delay. Cleared on unmount.
  useEffect(() => {
    const id = setTimeout(onClose, AUTO_DISMISS_MS);
    return () => clearTimeout(id);
  }, [onClose]);

  if (typeof document === 'undefined') return null;

  return createPortal(
    <>
      {/* Full-screen click/tap-away overlay (z below the bubble). Sole event handler — dismisses
          on any pointer interaction anywhere on the page. */}
      <div
        onClick={onClose}
        onPointerDown={onClose}
        className="fixed inset-0 z-[200]"
        aria-hidden
      />
      <div
        ref={bubbleRef}
        role="status"
        style={{
          position: 'fixed',
          top: pos?.top ?? -9999,
          left: pos?.left ?? -9999,
          transform: 'translate(-50%, -100%)',
        }}
        className={`pointer-events-none w-max max-w-[220px] text-center px-2.5 py-1.5 rounded-md bg-[#1a1a1a] text-white text-[11px] leading-snug shadow-lg z-[201] transition-opacity duration-150 ${pos ? 'opacity-100' : 'opacity-0'}`}
      >
        {MESSAGE}
      </div>
    </>,
    document.body
  );
}
