'use client';

import { useState, useRef, useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useIsHoverable } from '@/hooks/useIsHoverable';

// px between the trigger and its tooltip, and kept from the viewport edges when clamping.
const TOOLTIP_GAP = 8;
const EDGE_MARGIN = 8;

interface TooltipProps {
  /** Tooltip body (text or any node). */
  content: ReactNode;
  /** The trigger element. Hovering or focusing it shows the tooltip. */
  children: ReactNode;
  /** Extra classes for the inline-flex wrapper (rarely needed). */
  className?: string;
}

/**
 * Reusable hover/focus tooltip. The bubble is rendered through a React portal to document.body
 * with position: fixed, so it can never be clipped by an ancestor's overflow container. Mirrors
 * the approach proven in LockedActionButton: gated on useIsHoverable (desktop-only, so it never
 * flashes on touch taps), placed centered above the trigger and clamped to the viewport, rendered
 * off-screen + opacity-0 until positioned (no flash), then faded in. The wrapper is inline-flex so
 * it doesn't disturb the trigger's row layout.
 */
export function Tooltip({ content, children, className = '' }: TooltipProps) {
  const hoverable = useIsHoverable();
  const triggerRef = useRef<HTMLSpanElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  // Once the portaled tooltip mounts, measure it and place it centered above the trigger, clamped
  // to the viewport so it never runs off-screen at the edges. Runs only after it's in the DOM
  // (open true), so both refs are attached.
  useEffect(() => {
    if (!open || !triggerRef.current || !tooltipRef.current) return;
    const triggerRect = triggerRef.current.getBoundingClientRect();
    const tooltipRect = tooltipRef.current.getBoundingClientRect();
    const halfW = tooltipRect.width / 2;
    const center = triggerRect.left + triggerRect.width / 2;
    const left = Math.min(
      Math.max(center, halfW + EDGE_MARGIN),
      window.innerWidth - halfW - EDGE_MARGIN
    );
    // translate(-50%, -100%) on the element centers it on `left` and lifts it above `top` by its
    // own height, so `top` ends up as the tooltip's bottom edge (TOOLTIP_GAP above the trigger).
    const top = triggerRect.top - TOOLTIP_GAP;
    setPos({ top, left });
  }, [open]);

  return (
    <>
      <span
        ref={triggerRef}
        className={`inline-flex ${className}`}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
      >
        {children}
      </span>
      {hoverable && open && typeof document !== 'undefined' && createPortal(
        <div
          ref={tooltipRef}
          role="tooltip"
          style={{
            position: 'fixed',
            top: pos?.top ?? -9999,
            left: pos?.left ?? -9999,
            transform: 'translate(-50%, -100%)',
          }}
          className={`pointer-events-none w-max max-w-[220px] text-center px-2.5 py-1.5 rounded-md bg-[#1a1a1a] text-white text-[11px] leading-snug shadow-lg z-[300] transition-opacity duration-150 ${pos ? 'opacity-100' : 'opacity-0'}`}
        >
          {content}
        </div>,
        document.body
      )}
    </>
  );
}
