'use client';

import { useEffect, useRef, useState } from 'react';
import { useReducedMotion } from 'motion/react';
import { getLenis } from '@/components/SmoothScrollProvider';
import { useScrollSpy } from '@/hooks/useScrollSpy';
import { useIsMobile } from '@/hooks/useIsMobile';
import { useDelayedUnmount } from '@/hooks/useDelayedUnmount';
import { docsSections, HEADER_OFFSET } from './sections';

/**
 * The `/docs` table of contents — the page's only interactive island. Rendered in TWO places
 * (see `src/app/docs/page.tsx`):
 *   - `<DocsSidebar variant="mobile" />` in the sticky header → the `Contents ▾` dropdown (`<lg`).
 *   - `<DocsSidebar />` (desktop, the default) in the grid's left column → the sticky 2-level TOC.
 *
 * Anchors + titles come from `sections.ts` (single source of truth — shared with `DocsContent` and
 * `useScrollSpy`), so the TOC, the click targets, and the scroll-spy highlight can never drift.
 *
 * Click-to-scroll routes through `getLenis()` because Lenis wraps every route from the root layout
 * — a raw `#hash` jump would desync Lenis (a latent bug elsewhere we do not repeat). `scroll-mt-24`
 * on each section is the no-JS / direct-hash / reduced-motion fallback. Under reduced-motion
 * `getLenis()` is `null` (SmoothScrollProvider skips Lenis), so we fall back to native
 * `scrollIntoView({ behavior: 'auto' })` = an instant jump.
 */

// Footer/editorial signature transition: 350ms / cubic-bezier(0.4,0,0.2,1).
const SIG = 'transition-all duration-[350ms] ease-[cubic-bezier(0.4,0,0.2,1)]';

// Every section + subsection id, in document order. Fed to useScrollSpy. Built once at module
// scope so the array identity is stable across renders (useScrollSpy keys on its joined content
// anyway, but a stable ref is cleaner).
const ALL_IDS = docsSections.flatMap((s) => [s.anchor, ...s.subsections.map((sub) => sub.anchor)]);

// Shared scroll helper. `reduce` is useReducedMotion()'s `boolean | null` (truthy = reduced).
function jumpTo(anchor: string, reduce: boolean | null) {
  const el = document.getElementById(anchor);
  if (!el) return;
  const lenis = getLenis();
  if (lenis && !reduce) {
    // offset: -HEADER_OFFSET lands the heading just below the sticky header (matches scroll-mt-24).
    lenis.scrollTo(el, { offset: -HEADER_OFFSET });
  } else {
    el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
  }
  // Keep the URL in sync without adding a history entry (no back-button trap).
  history.replaceState(null, '', `#${anchor}`);
}

export function DocsSidebar({
  variant = 'desktop',
  layout = 'editorial',
}: {
  variant?: 'desktop' | 'mobile';
  layout?: 'editorial' | 'classic';
}) {
  return variant === 'mobile' ? <MobileToc layout={layout} /> : <DesktopAside layout={layout} />;
}

/** Desktop: sticky 2-level TOC with scroll-spy active highlight. */
function DesktopAside({ layout = 'editorial' }: { layout?: 'editorial' | 'classic' }) {
  const reduce = useReducedMotion();
  const active = useScrollSpy(ALL_IDS);
  const isClassic = layout === 'classic';
  // Classic swaps the active-highlight bar to the coral accent; editorial keeps border-[var(--text)].
  // Body text colors still use var(--text)/var(--muted) (the PREPAINT sets them to classic values).
  const activeBorder = isClassic ? 'border-[#FF5A47]' : 'border-[var(--text)]';

  return (
    // top-24 = 96px = HEADER_OFFSET (sticky clears the header). self-start so it doesn't stretch.
    <aside className={`thin-scrollbar sticky top-24 hidden self-start pb-8 lg:block max-h-[calc(100dvh-7rem)] overflow-y-auto ${isClassic ? 'font-mono' : ''}`}>
      <nav aria-label="Documentation contents">
        <p className="mb-4 text-[0.75rem] uppercase tracking-[0.15em] text-[var(--muted)]">Contents</p>
        <ul>
          {docsSections.map((s) => {
            const secActive = active === s.anchor;
            return (
              <li key={s.anchor}>
                <a
                  href={`#${s.anchor}`}
                  onClick={(e) => {
                    e.preventDefault();
                    jumpTo(s.anchor, reduce);
                  }}
                  className={`block border-l-2 py-1.5 pl-3 text-sm ${SIG} ${
                    secActive
                      ? `${activeBorder} font-medium text-[var(--text)]`
                      : 'border-transparent text-[var(--muted)] hover:text-[var(--text)]'
                  }`}
                >
                  {s.title}
                </a>
                {s.subsections.length > 0 && (
                  <div className="mb-1">
                    {s.subsections.map((sub) => {
                      const subActive = active === sub.anchor;
                      return (
                        <a
                          key={sub.anchor}
                          href={`#${sub.anchor}`}
                          onClick={(e) => {
                            e.preventDefault();
                            jumpTo(sub.anchor, reduce);
                          }}
                          className={`block ml-3 border-l-2 py-1 pl-3 text-[0.8125rem] ${SIG} ${
                            subActive
                              ? `${activeBorder} text-[var(--text)]`
                              : 'border-transparent text-[var(--muted)] hover:text-[var(--text)]'
                          }`}
                        >
                          {sub.title}
                        </a>
                      );
                    })}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </nav>
    </aside>
  );
}

/** Mobile: a `Contents ▾` button in the header that opens a fading dropdown of the same TOC. */
function MobileToc({ layout = 'editorial' }: { layout?: 'editorial' | 'classic' }) {
  const reduce = useReducedMotion();
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);
  // useDelayedUnmount keeps the panel mounted briefly on close so a fade-OUT can play. `open &&
  // isMobile` gates it so the dropdown logic is inert on desktop (the button is lg:hidden anyway).
  const { shouldRender, isExiting } = useDelayedUnmount(open && isMobile, 200);
  const [shown, setShown] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const isClassic = layout === 'classic';

  // Fade-IN: mount at opacity-0, flip to opacity-100 next frame so the open transition animates.
  // Reset on unmount so each open fades in fresh.
  useEffect(() => {
    if (!shouldRender) {
      // Reset `shown` so the next open fades in fresh. Deferred to a rAF callback (NOT synchronous
      // in the effect body) to satisfy react-hooks/set-state-in-effect — the panel is unmounted
      // while !shouldRender, so the one-frame deferral is invisible. Behavior-identical to the
      // prior synchronous reset. (Pre-existing latent lint error in HEAD; fixed here because this
      // file must pass eslint and the deferral is behavior-neutral.)
      const id = requestAnimationFrame(() => setShown(false));
      return () => cancelAnimationFrame(id);
    }
    if (isExiting) return; // leaving — let the exit fade play out
    const id = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(id);
  }, [shouldRender, isExiting]);

  // Dismiss on outside pointer-down or Escape (standard disclosure-menu pattern). Listeners exist
  // only while `open`. pointerdown (not click) fires before the trigger's own onClick, so a trigger
  // re-click still toggles correctly (its target is inside rootRef -> not dismissed here); only a
  // tap OUTSIDE the wrapper closes via this path. Closing flows through setOpen(false) ->
  // useDelayedUnmount, so the fade-OUT still plays. Escape also returns focus to the trigger.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const choose = (anchor: string) => {
    jumpTo(anchor, reduce);
    setOpen(false); // clicking an item scrolls and closes the panel
  };

  return (
    <div ref={rootRef} className="relative lg:hidden">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label="Table of contents"
        className={`flex items-center gap-1 text-sm text-[var(--text)] ${isClassic ? 'font-mono text-xs uppercase tracking-widest' : ''}`}
      >
        Contents
        <svg
          className={`h-3 w-3 ${SIG} ${open ? 'rotate-180' : ''}`}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden="true"
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {shouldRender && (
        <div
          className={`thin-scrollbar absolute right-0 top-full z-50 mt-2 max-h-[60dvh] w-64 overflow-y-auto ${isClassic ? 'rounded-none' : 'rounded-lg shadow-lg'} border border-[var(--border)] bg-[var(--bg)] p-2 opacity-0 transition-opacity duration-200 ease-[cubic-bezier(0.4,0,0.2,1)] ${isClassic ? 'font-mono' : ''} ${
            shown && !isExiting ? 'opacity-100' : 'opacity-0'
          }`}
        >
          {docsSections.map((s) => (
            <div key={s.anchor} className="py-0.5">
              <button
                type="button"
                onClick={() => choose(s.anchor)}
                className="block w-full rounded px-3 py-1.5 text-left text-sm text-[var(--text)] transition-colors duration-200 hover:bg-[var(--border)]"
              >
                {s.title}
              </button>
              {s.subsections.map((sub) => (
                <button
                  key={sub.anchor}
                  type="button"
                  onClick={() => choose(sub.anchor)}
                  className="block w-full rounded px-5 py-1 text-left text-[0.8125rem] text-[var(--muted)] transition-colors duration-200 hover:bg-[var(--border)] hover:text-[var(--text)]"
                >
                  {sub.title}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
