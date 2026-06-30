'use client';

import { useState, useRef, useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useIsHoverable } from '@/hooks/useIsHoverable';
import { LockedDropModal, LOCKED_ACTION_MESSAGES, type LockedActionContext } from './LockedDropModal';

// px between the faded button and its tooltip, and kept from the viewport edges when clamping.
const TOOLTIP_GAP = 8;
const EDGE_MARGIN = 8;

interface LockedActionButtonProps {
  /** Which action is gated — picks the message in the tooltip/popup. */
  context: LockedActionContext;
  /** Host layout so the popup matches its surroundings. */
  variant: 'classic' | 'editorial';
  /** Host app theme. */
  theme: 'light' | 'dark' | 'minimal';
  /** The action icon (same icon the real button uses). */
  icon: ReactNode;
  /** Size/shape classes matching the real action button it replaces. */
  className?: string;
}

/**
 * A faded stand-in for an action button (Edit/Move/Delete) on a drop the current user can't
 * mutate (a locked drop they didn't create). It is deliberately NOT html-disabled — a disabled
 * button swallows the hover/click events we need for feedback. Instead, styled faded
 * (opacity-40 + cursor-not-allowed) and:
 *   - Desktop (hover: hover): a hover/focus tooltip explains why; the click is a no-op.
 *   - Touch (no hover): a tap opens LockedDropModal (a hover tooltip can't surface on touch).
 *
 * The tooltip is rendered through a React portal to document.body with position: fixed, computed
 * from the button's rect, so the drop list's overflow container can never clip it (the previous
 * absolutely-positioned span was clipped by the list's overflow).
 */
export function LockedActionButton({ context, variant, theme, icon, className = '' }: LockedActionButtonProps) {
  const hoverable = useIsHoverable();
  const [showModal, setShowModal] = useState(false);
  const message = LOCKED_ACTION_MESSAGES[context];

  const buttonRef = useRef<HTMLButtonElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [tooltipOpen, setTooltipOpen] = useState(false);
  const [tooltipPos, setTooltipPos] = useState<{ top: number; left: number } | null>(null);

  // Once the portaled tooltip mounts, measure it and place it centered above the button, clamped
  // to the viewport so it never runs off-screen at the edges. Runs only after the tooltip is in
  // the DOM (tooltipOpen true), so the refs are attached.
  useEffect(() => {
    if (!tooltipOpen || !buttonRef.current || !tooltipRef.current) return;
    const buttonRect = buttonRef.current.getBoundingClientRect();
    const tooltipRect = tooltipRef.current.getBoundingClientRect();
    const halfW = tooltipRect.width / 2;
    const center = buttonRect.left + buttonRect.width / 2;
    const left = Math.min(
      Math.max(center, halfW + EDGE_MARGIN),
      window.innerWidth - halfW - EDGE_MARGIN
    );
    // translate(-50%, -100%) on the element centers it on `left` and lifts it above `top` by its
    // own height, so `top` ends up as the tooltip's bottom edge (TOOLTIP_GAP above the button).
    const top = buttonRect.top - TOOLTIP_GAP;
    setTooltipPos({ top, left });
  }, [tooltipOpen]);

  const showTooltip = () => { if (hoverable) setTooltipOpen(true); };
  const hideTooltip = () => setTooltipOpen(false);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-label={message}
        aria-disabled="true"
        onMouseEnter={showTooltip}
        onMouseLeave={hideTooltip}
        onFocus={showTooltip}
        onBlur={hideTooltip}
        onClick={(e) => {
          e.stopPropagation();
          // Desktop: the hover/focus tooltip is the feedback — click does nothing.
          // Touch: there's no hover, so a tap surfaces the explanation via the modal.
          if (!hoverable) setShowModal(true);
        }}
        className={`opacity-40 cursor-not-allowed ${className}`}
      >
        {icon}
      </button>

      {hoverable && tooltipOpen && typeof document !== 'undefined' && createPortal(
        <div
          ref={tooltipRef}
          role="tooltip"
          style={{
            position: 'fixed',
            top: tooltipPos?.top ?? -9999,
            left: tooltipPos?.left ?? -9999,
            transform: 'translate(-50%, -100%)',
          }}
          className={`pointer-events-none w-max max-w-[220px] text-center px-2.5 py-1.5 rounded-md bg-[#1a1a1a] text-white text-[11px] leading-snug shadow-lg z-[300] transition-opacity duration-150 ${tooltipPos ? 'opacity-100' : 'opacity-0'}`}
        >
          {message}
        </div>,
        document.body
      )}

      {showModal && (
        <LockedDropModal context={context} variant={variant} theme={theme} onClose={() => setShowModal(false)} />
      )}
    </>
  );
}
