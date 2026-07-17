'use client';
import { useEffect, useState } from 'react';
import { useReducedMotion } from 'motion/react';
import { getLenis, isScrollLocked, isNestedScroller } from '@/components/SmoothScrollProvider';

// Magnetic footer wheel-gate (Approach C, Part 3). Ports footer-prototype.html's "hard magnet".
// At the app<->footer boundary a casual wheel flick is swallowed and "intent" accumulates; a
// deliberate/sustained push (intent>=THRESHOLD) breaks through and Lenis glides to the other
// section. DESKTOP POINTER ONLY (wheel). Touch (Lenis syncTouch:false => native touch) and
// keyboard bypass the magnet BY DESIGN — documented, not a bug.
const THRESHOLD = 320;                        // ~3 wheels at 109px/tick (was 600 -> felt stuck; TUNABLE)
const RESET_MS  = 500;                        // survives a relaxed reading cadence (was 220; TUNABLE)
const COMMIT_S  = 1.4;                        // lenis.scrollTo glide duration (TUNABLE)
const PAUSE_MS  = 300;                        // HTML snap "delay: 0.3" — hold-then-pull beat (TUNABLE)
const EPS       = 80;                         // boundary epsilon, px (TUNABLE)
// GSAP "power3.inOut" == QUARTIC in-out (GSAP: power1=Quad, power2=Cubic, power3=Quart, power4=Quint).
// Drives the commit glide to match footer-prototype.html's snap ease (replaces the old easeOutExpo use).
const power3InOut = (t: number) =>
  t < 0.5 ? 8 * t * t * t * t : 1 - Math.pow(-2 * t + 2, 4) / 2;

export function useMagnet(footerActive: boolean) {
  const reduce = useReducedMotion();
  const [ready, setReady] = useState(false);

  // Effect A — self-heal poll (mirror useDissolve): wait for #footer-shell AND a live Lenis.
  useEffect(() => {
    // footerActive = isWide && footerEnabled — bail (and stop the poll) below 1400px OR when the
    // footer is toggled off in Settings, so this self-heal poll never spins forever.
    if (reduce || ready || !footerActive) return;
    let rafId = 0;
    const poll = () => {
      rafId = 0;
      if (document.getElementById('footer-shell') && getLenis()) { setReady(true); return; }
      rafId = requestAnimationFrame(poll);
    };
    rafId = requestAnimationFrame(poll);
    return () => { if (rafId) cancelAnimationFrame(rafId); };
  }, [reduce, ready, footerActive]);

  // Effect B — attach the wheel gate.
  useEffect(() => {
    if (reduce || !ready) return;
    let crossing = false, committedDown = false, intent = 0;
    let pending = false;                       // PAUSE phase flag: swallow ALL window wheels before the glide
    let resetTimer: ReturnType<typeof setTimeout> | null = null;
    let commitTimer: ReturnType<typeof setTimeout> | null = null;
    let pauseTimer: ReturnType<typeof setTimeout> | null = null;

    const commitTo = (down: boolean) => {
      const lenis = getLenis();
      const fs = document.getElementById('footer-shell');   // presence check only
      if (!lenis || !fs) return;
      // PAUSE phase: hold the page frozen for PAUSE_MS. crossing=true AND pending=true so onWheel
      // swallows ALL window-affecting wheels (nested scrollers already bailed at the top of onWheel)
      // — a same-direction wheel reaching Lenis now would start the glide early and erase the
      // pause-then-pull feel. intent cleared so a stale resetTimer can't fire after the glide.
      crossing = true; committedDown = down; intent = 0; pending = true;
      if (resetTimer) { clearTimeout(resetTimer); resetTimer = null; }
      if (pauseTimer) clearTimeout(pauseTimer);
      pauseTimer = setTimeout(() => {
        pending = false;                       // exit pause -> glide phase (direction-aware guard resumes)
        // Re-resolve LIVE: footer may have unmounted or Lenis destroyed (logout / reduced-motion
        // toggle / teardown) during the pause. Bail cleanly (release crossing) — no dangling scroll.
        const fsNow = document.getElementById('footer-shell');
        const lenisNow = getLenis();
        if (!fsNow || !lenisNow) { crossing = false; committedDown = false; return; }
        const dest = down ? (fsNow.getBoundingClientRect().top + window.scrollY) : 0;
        // Per-call options ONLY. power3.inOut (quartic) = the prototype's snap ease. NO lockScroll
        // (would freeze the dissolve). NO #app-shell transform (landmine).
        lenisNow.scrollTo(dest, { duration: COMMIT_S, easing: power3InOut });
        if (commitTimer) clearTimeout(commitTimer);
        // Release only when an opposite-direction wheel may again reach Lenis: same-direction wheels
        // already pass via the direction-aware guard below. COMMIT_S*1000 is the true glide-end (a
        // programmatic scrollTo flips isScrolling=false at exactly duration-end in Lenis 1.1.14);
        // +80ms (~5 frames) covers Lenis's finalization tick.
        commitTimer = setTimeout(() => { crossing = false; committedDown = false; }, COMMIT_S * 1000 + 80);
      }, PAUSE_MS);
    };

    const onWheel = (e: WheelEvent) => {
      // (1) NESTED SCROLLER — HOISTED to the very top so a wheel inside ANY nested container
      //     (drop list / chat / composer / modal body / dropdown) scrolls NATIVELY regardless of
      //     magnet phase — incl. during the PAUSE below. Mirror Lenis's climb EXACTLY. SKIP
      //     non-HTMLElement (continue, NOT break). Stop at the Lenis root (body/documentElement).
      for (const node of e.composedPath()) {
        if (!(node instanceof HTMLElement)) continue;                       // SVG-safe
        if (node === document.body || node === document.documentElement) break; // Lenis root
        if (isNestedScroller(node)) return;                                 // nested -> bail to native
        if (node.hasAttribute('data-lenis-prevent') || node.hasAttribute('data-lenis-prevent-wheel')) return;
      }
      // (2) PAUSE / CROSSING GUARD (DIRECTION-AWARE) —
      //     PAUSE (pending): swallow ALL window-affecting wheels so the page holds PAUSE_MS before
      //       the pull. A same-direction wheel MUST NOT reach Lenis here — the page is pinned at the
      //       boundary and Lenis would start the glide early, erasing the pause-then-pull beat.
      //     GLIDE (crossing, !pending): same-direction -> let it through to Lenis (reinforce / keep
      //       reading the section just snapped to). Opposite-direction -> swallow (no mid-glide reversal).
      if (pending) {
        e.preventDefault(); e.stopImmediatePropagation(); return;            // pause: hold ALL window wheels
      }
      if (crossing) {
        if ((e.deltaY > 0) === committedDown) return;                       // same-direction -> Lenis handles
        e.preventDefault(); e.stopImmediatePropagation(); return;            // reverse -> swallow
      }
      // (3) LIVE FOOTER PRESENCE — no footer (login/verify, logout-without-reload) -> magnet inert.
      const fs = document.getElementById('footer-shell');
      if (!fs) { intent = 0; return; }
      // (4) LENIS NULL (reduced-motion / pre-mount / destroyed).
      if (!getLenis()) return;
      // (5) SCROLL LOCKED — chat overlay / modal / overlay open. Let the lock own the page.
      if (isScrollLocked()) return;
      // Direction + live geometry.
      const down = e.deltaY > 0, up = e.deltaY < 0;
      if (!down && !up) return;                                             // deltaX-only / zero
      // (6) BOUNDARY — atApp near the top; atFooter when the footer has LANDED (rect.top <= EPS).
      const atApp = window.scrollY < EPS;
      const atFooter = fs.getBoundingClientRect().top <= EPS;
      if (!((down && atApp) || (up && atFooter))) { intent = 0; return; }    // mid-section -> Lenis normal

      // ---- RESIST ----------------------------------------------------------------
      e.preventDefault();                  // freeze native scroll (passive:false allows this)
      e.stopImmediatePropagation();        // block Lenis's wheel listener (capture-phase preemption)
      // deltaMode-aware intent in PIXEL-EQUIVALENT units (lines~16px, pages=vh, pixels=1).
      const norm = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? window.innerHeight : 1);
      intent += Math.abs(norm);
      if (intent >= THRESHOLD) { commitTo(down); return; }
      if (resetTimer) clearTimeout(resetTimer);
      resetTimer = setTimeout(() => { intent = 0; }, RESET_MS);
    };

    window.addEventListener('wheel', onWheel, { capture: true, passive: false });
    return () => {
      window.removeEventListener('wheel', onWheel, { capture: true });   // flags MUST match the add
      if (resetTimer) clearTimeout(resetTimer);
      if (pauseTimer) clearTimeout(pauseTimer);
      if (commitTimer) clearTimeout(commitTimer);
      crossing = false; committedDown = false; pending = false; intent = 0;
    };
  }, [reduce, ready, footerActive]);
}
