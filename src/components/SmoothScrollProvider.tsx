'use client';

import { useEffect } from 'react';
import Lenis from 'lenis';
import { useReducedMotion } from 'motion/react';

/**
 * App-wide Lenis inertial smooth-scroll (magnetic-scroll foundation — Step 1 of 2).
 *
 * Mounts ONE Lenis instance at the app root (in `layout.tsx`, inside `<Providers>`),
 * running its own rAF loop. Exposes a module-level `getLenis()` singleton so unrelated
 * code (body-scroll-lock, Footer back-to-top, chat mobile scroll-restore) can call
 * `stop()/start()/scrollTo()` without prop-drilling.
 *
 * HEAVY cinematic settings app-wide, matching footer-prototype.html (duration 1.4,
 * wheelMultiplier 0.7). SAFE app-wide because the window scrolls ONLY for the app<->footer
 * transition: #app-shell is `sticky top-0 h-100dvh overflow-y-hidden` (never scrolls itself),
 * and #footer-shell is its normal-flow sibling — the document can only reveal the footer.
 * Every piece of app content (classic #app-main, editorial columns, both chat message lists,
 * contentEditable composers, all modal / dropdown / popover bodies) lives in nested
 * overflow-y-auto containers, and the `prevent: isNestedScroller` predicate makes Lenis YIELD
 * for all of them -> they scroll NATIVELY, untouched by wheelMultiplier / duration. So 0.7 / 1.4
 * only weights wheel-driven WINDOW scrolling at the app<->footer boundary — the intended
 * magnetic feel, matching the prototype. Per-call scrollTo options (Footer back-to-top, chat
 * re-sync {immediate:true}, the magnet commit) override these globals and are unaffected.
 *   duration = 1.4, wheelMultiplier = 0.7, expo-out easing, smoothWheel: true.
 * Touch stays NATIVE: the prototype's `smoothTouch:false` is not a v1.1.14 option —
 * `syncTouch` (the touch-smoothing toggle) defaults to `false`, which is exactly the
 * "native touch" intent, so we leave it unset.
 *
 * prefers-reduced-motion → NO Lenis initialized. `getLenis()` then returns `null` and
 * every caller falls back to native `window.scrollTo` (see Footer back-to-top, etc.).
 *
 * NESTED SCROLLERS: instead of manually tagging ~50 `overflow-y-auto` elements with
 * `data-lenis-prevent`, we pass Lenis a `prevent` predicate that dynamically detects
 * any vertically-scrollable ancestor of the wheel target (overflowY auto/scroll WITH
 * scrollable content). Lenis climbs `event.composedPath` and calls this per node
 * (lenis.mjs ~line 516), and the built-in `data-lenis-prevent` attribute check runs as
 * an OR alongside it — so a manual `data-lenis-prevent` still works as an override if
 * ever needed. This covers every chat panel / drop list / modal body / dropdown /
 * popover / contentEditable composer, current and future, in one place.
 */

// Module-level singleton. Set in the effect, cleared on teardown. Null under
// reduced-motion (Lenis never initialized) or before mount / after unmount.
let lenisInstance: Lenis | null = null;

export function getLenis(): Lenis | null {
  return lenisInstance;
}

/**
 * If the footer is partway up (mid-dissolve), retract it to the top BEFORE a modal/overlay opens,
 * so the overlay (inside #app-shell z-[1], below the footer's z-[2]) isn't trapped behind the
 * risen footer. The window scrolls only to reveal the footer, so scrollY > 0 means it's up.
 * Lenis (not raw window.scrollTo) to stay in sync; immediate so it retracts before the overlay
 * paints. NO-OP when the footer isn't up (scrollY === 0) — safe to call from every open-handler.
 * MUST be called pre-mount (before the setState that mounts the overlay) for a zero-frame retract.
 */
export function retractFooterIfUp() {
  if (typeof window === 'undefined' || window.scrollY <= 0) return;
  const lenis = getLenis();
  if (lenis) lenis.scrollTo(0, { immediate: true });
  else window.scrollTo(0, 0);
}

// Ref-counted scroll lock: stacked overlays (a modal over the chat overlay, or two modals) keep
// the page frozen until the LAST one closes. Lenis's bare stop()/start() are idempotent booleans
// with no depth counter, so without this an inner modal closing would re-enable smooth-scroll while
// an outer one is still open. lockScroll()/unlockScroll() MUST be called in balanced pairs
// (matching the mount/cleanup of the same effect). No-op when Lenis is off (reduced-motion).
let lockDepth = 0;
const lockListeners = new Set<() => void>();
function notifyLockChange(): void {
  lockListeners.forEach((cb) => cb());
}
// Read-only accessor + change subscription — lets the dissolve effect (useDissolve) freeze solid
// the instant a modal opens mid-transition, without polling.
export function isScrollLocked(): boolean {
  return lockDepth > 0;
}
export function onLockChange(cb: () => void): () => void {
  lockListeners.add(cb);
  return () => {
    lockListeners.delete(cb);
  };
}
export function lockScroll(): void {
  if (lockDepth === 0) {
    lenisInstance?.stop();
    notifyLockChange(); // 0 -> 1: effective locked state changed
  }
  lockDepth++;
}
export function unlockScroll(): void {
  if (lockDepth === 0) return; // defensive — never go negative
  lockDepth--;
  if (lockDepth === 0) {
    lenisInstance?.start();
    notifyLockChange(); // 1 -> 0: effective locked state changed
  }
}

// Lenis `prevent` predicate (called per node in the wheel event's composedPath).
// True ⇒ Lenis does NOT hijack the wheel for this event ⇒ the browser scrolls the
// nested container natively and the PAGE does not move (requirement (a)). We only
// prevent when the container actually has scrollable content; a non-overflowed list
// lets the page smooth-scroll normally (no dead zones).
export function isNestedScroller(node: HTMLElement): boolean {
  const cs = getComputedStyle(node);
  const overflowY = cs.overflowY;
  if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight) {
    return true;
  }
  return false;
}

export function SmoothScrollProvider({ children }: { children: React.ReactNode }) {
  const reduce = useReducedMotion();

  useEffect(() => {
    if (reduce) return; // reduced-motion → native scroll, no Lenis

    const lenis = new Lenis({
      duration: 1.4,
      wheelMultiplier: 0.7,
      smoothWheel: true,
      easing: (t: number) => Math.min(1, 1.001 - Math.pow(2, -10 * t)), // expo-out
      prevent: isNestedScroller,
    });
    lenisInstance = lenis;

    let rafId = 0;
    const raf = (time: number) => {
      lenis.raf(time);
      rafId = requestAnimationFrame(raf);
    };
    rafId = requestAnimationFrame(raf);

    return () => {
      cancelAnimationFrame(rafId);
      lenis.destroy();
      lenisInstance = null;
    };
  }, [reduce]);

  return <>{children}</>;
}
