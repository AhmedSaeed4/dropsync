'use client';

import { useEffect, useLayoutEffect, useState } from 'react';
import { useReducedMotion } from 'motion/react';
import { isScrollLocked, onLockChange, lockScroll, unlockScroll } from '@/components/SmoothScrollProvider';

// useLayoutEffect on the client (runs synchronously after DOM commit, BEFORE paint) so the freeze
// is airtight across the showChat false→true transition — the chat overlay is never painted under a
// non-'none' transform on <main> (translateY(0%) is still a containing-block trigger). useEffect on
// the server (no-op, avoids the SSR useLayoutEffect warning).
const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

/**
 * Approach-C Part 2 — the dissolve. As the footer (`#footer-shell`) rises over the app, the app
 * FADES (`#app-shell` opacity 1→0) and LIFTS (`#app-main` translateY 0→-6%), scrubbed to the window
 * scroll that Lenis animates — matching `footer-prototype.html` line 253.
 *
 * #1 LANDMINE (load-bearing): a CSS `transform` on an ancestor of a `position:fixed` element
 * re-anchors that element to the ancestor. `#app-shell` is an ancestor of EVERY fixed modal, so it
 * must NEVER carry a transform. Therefore:
 *   - the FADE (opacity) goes on `#app-shell` — opacity is NOT a containing-block trigger;
 *   - the LIFT (translateY) goes on `#app-main` ONLY. `<main>` does not contain the modals (they
 *     are siblings of main); its only fixed/absolute descendants are the chat backdrop + chat
 *     column, which exist ONLY while chat is open — and the dissolve is FROZEN (transform: none)
 *     while chat is open, so they are never present during a lift.
 *
 * Frozen solid (opacity 1, no lift) while chat is open or any modal/overlay holds the scroll lock —
 * a modal opening mid-transition snaps the app back to solid (via the `onLockChange` subscription).
 * OFF entirely under `prefers-reduced-motion` (app stays fully solid).
 *
 * @param showChat true while the chat overlay is open → freeze + lock the window (desktop).
 */
export function useDissolve(showChat: boolean, footerActive: boolean) {
  const reduce = useReducedMotion();
  const [ready, setReady] = useState(false);

  // Self-healing attach. useDissolve also runs during the auth-loading screen, when
  // #app-shell / #app-main / #footer-shell are NOT in the DOM yet. The scrub effect would bail at
  // its null-guard there and never re-run (its deps don't change when auth resolves and the shell
  // mounts), so the dissolve would stay dead until the first chat toggle flipped showChat. This
  // effect polls (rAF) until all three elements exist, then flips `ready` true — which re-runs the
  // scrub effect so it attaches the listener. The dissolve then works on fresh load with no chat
  // toggle required. Skipped under reduced-motion (the dissolve is off then anyway).
  useEffect(() => {
    // footerActive = isWide && footerVisible — bail (and stop the poll) below 1400px OR when the
    // footer is toggled off in Settings or suppressed by Editorial Manual mode, so this self-heal
    // poll never spins forever.
    if (reduce || ready || !footerActive) return;
    let rafId = 0;
    const poll = () => {
      rafId = 0;
      if (
        document.getElementById('app-shell') &&
        document.getElementById('app-main') &&
        document.getElementById('footer-shell')
      ) {
        setReady(true);
        return;
      }
      rafId = requestAnimationFrame(poll);
    };
    rafId = requestAnimationFrame(poll);
    return () => {
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, [reduce, ready, footerActive]);

  // The scrub + freeze. A LAYOUT effect (not passive) so the freeze lands BEFORE paint: on the
  // showChat transition the chat overlay must never be painted under a non-'none' transform on main.
  useIsomorphicLayoutEffect(() => {
    if (reduce) return; // reduced-motion → no dissolve
    if (!ready) return; // wait for the self-heal poll to confirm the shell is in the DOM
    const shell = document.getElementById('app-shell');
    const main = document.getElementById('app-main');
    const footer = document.getElementById('footer-shell');
    // Absent on the login/loading/verify branches (this hook also runs there) — bail, app stays solid.
    if (!shell || !main || !footer) return;

    let rafId = 0;
    const apply = () => {
      rafId = 0;
      // Frozen solid while the chat overlay is open OR any modal/overlay holds the scroll lock.
      if (showChat || isScrollLocked()) {
        shell.style.opacity = '1';
        main.style.transform = 'none';
        return;
      }
      const vh = window.innerHeight;
      const f = document.getElementById('footer-shell');   // LIVE — handles footer unmount on resize <1400px
      if (!f) { shell.style.opacity = '1'; main.style.transform = 'none'; return; }  // no footer -> app stays solid
      const footerTop = f.getBoundingClientRect().top;
      // p = 0 when the footer is fully below the viewport; p = 1 when its top reaches the viewport
      // top. Drives both the fade (1 - p) and the lift (-p * 6%).
      const p = Math.min(1, Math.max(0, (vh - footerTop) / vh));
      shell.style.opacity = String(1 - p);
      main.style.transform = `translateY(${-p * 6}%)`;
    };

    const schedule = () => {
      if (rafId === 0) rafId = requestAnimationFrame(apply);
    };

    apply(); // SYNCHRONOUS initial apply (before paint) — freeze is airtight across the showChat transition
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule, { passive: true });
    // React to modal/overlay lock changes so a modal opening mid-transition snaps back to solid.
    const offLock = onLockChange(schedule);

    return () => {
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      offLock();
      if (rafId) cancelAnimationFrame(rafId);
      // Clear inline styles so the layout-switch fade (`transitionClass` on #app-shell) owns opacity
      // again, and main has no leftover transform.
      shell.style.opacity = '';
      main.style.transform = '';
    };
  }, [showChat, reduce, ready, footerActive]);

  // Desktop chat lock: while chat is open, lock the window so the page can't scroll to the footer
  // (focused mode). Mobile chat already locks via the chat panel; the ref-count makes the resulting
  // double-lock on mobile safe (balanced unlock on close).
  useEffect(() => {
    if (reduce) return;
    if (showChat) {
      lockScroll();
      return () => unlockScroll();
    }
  }, [showChat, reduce]);
}
