'use client';

import { useEffect, useRef } from 'react';

/**
 * Press-and-hold destructive button — DropSync's in-repo implementation of the
 * "hold to confirm" pattern (visual reference: Spectrum UI; no external install).
 *
 * Gesture: press and hold — the ring around the trash icon fills over HOLD_MS;
 * release early and the ring drains back with nothing happening; hold to the end
 * and the button flashes green "Deleted ✓", then fires onHoldComplete() so the
 * parent performs the deletion. Holding Enter or Space is the same gesture for
 * keyboards. Red stays red in every theme (owner lock).
 */

const HOLD_MS = 1500;
const RING_R = 9;
const RING_C = 2 * Math.PI * RING_R; // ring circumference (stroke-dasharray)

type HoldToDeleteButtonProps = {
  /** Selected-drop count — shown in the full variant's label and the aria-label. */
  count: number;
  /** full = "Hold to delete N" (desktop toolbar) · compact = "Hold" (mobile bulk bar). */
  variant: 'full' | 'compact';
    /** Parent's delete is in flight — shows "Deleting..." and ignores new presses. */
    deleting?: boolean;
    /** Parent finished deleting — green "Deleted ✓" confirmation moment. */
    done?: boolean;
    /** Fired the moment the ring completes — the parent starts the deletion. */
    onHoldComplete: () => void;
  /** Shape/theme classes from the parent (padding, rounding, font, margins, hover). */
  className?: string;
};

export default function HoldToDeleteButton({
    count,
    variant,
    deleting = false,
    done = false,
    onHoldComplete,
    className = '',
  }: HoldToDeleteButtonProps) {
  const fillRef = useRef<SVGCircleElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const startRef = useRef(0);

  const setProgress = (p: number) => {
    if (fillRef.current) fillRef.current.style.strokeDashoffset = String(RING_C * (1 - p));
  };

  // Release early (or key-up): stop the fill and drain the ring back. No-op unless a
  // fill is actually running, so presses after `done`/`deleting` can't cancel anything.
  const cancel = () => {
    if (rafRef.current === null) return;
    cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    const el = fillRef.current;
    if (el) {
      el.style.transition = 'stroke-dashoffset 0.3s ease-out';
      el.style.strokeDashoffset = String(RING_C);
      window.setTimeout(() => { el.style.transition = ''; }, 320);
    }
  };

  const begin = () => {
    if (done || deleting || rafRef.current !== null) return;
    const el = fillRef.current;
    if (el) el.style.transition = '';
    setProgress(0);
    startRef.current = performance.now();
    const tick = (now: number) => {
      const p = Math.min(1, (now - startRef.current) / HOLD_MS);
      setProgress(p);
      if (p >= 1) {
        rafRef.current = null;
        onHoldComplete();
      } else {
        rafRef.current = requestAnimationFrame(tick);
      }
    };
    rafRef.current = requestAnimationFrame(tick);
  };

  // Unmount mid-hold: stop the loop so it can't tick on a dead tree.
  useEffect(() => () => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
  }, []);

  const label =
    deleting ? 'Deleting...' : done ? 'Deleted ✓' : variant === 'full' ? `Hold to delete ${count}` : 'Hold';

  return (
    <button
      type="button"
      disabled={deleting || done}
      aria-label={`Hold to delete ${count} selected ${count === 1 ? 'drop' : 'drops'}`}
      onPointerDown={begin}
      onPointerUp={cancel}
      onPointerLeave={cancel}
      onPointerCancel={cancel}
      onKeyDown={(e) => {
        if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) {
          e.preventDefault();
          begin();
        }
      }}
      onKeyUp={(e) => { if (e.key === 'Enter' || e.key === ' ') cancel(); }}
      onContextMenu={(e) => e.preventDefault()}
      style={{ touchAction: 'none', backgroundColor: done ? '#30a46c' : undefined }}
      className={`shrink-0 flex items-center gap-[7px] bg-red-500 text-xs font-medium text-white select-none transition-colors disabled:opacity-50 ${className}`}
    >
      <span className="relative block h-5 w-5">
        <svg viewBox="0 0 22 22" className="absolute inset-0 h-full w-full -rotate-90" aria-hidden="true">
          <circle cx="11" cy="11" r={RING_R} fill="none" strokeWidth="2.4" className="stroke-white/35" />
          <circle
            ref={fillRef}
            cx="11"
            cy="11"
            r={RING_R}
            fill="none"
            strokeWidth="2.4"
            strokeLinecap="round"
            className="stroke-white"
            strokeDasharray={RING_C}
            strokeDashoffset={RING_C}
          />
        </svg>
        <span className="absolute inset-0 flex items-center justify-center" aria-hidden="true">
          <svg className="h-2.5 w-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 6h18" />
            <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
            <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
          </svg>
        </span>
      </span>
      <span className="whitespace-nowrap">{label}</span>
    </button>
  );
}
