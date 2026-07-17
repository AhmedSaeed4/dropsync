'use client';

import { useState, useRef } from 'react';
import Link from 'next/link';
import { motion, useReducedMotion, type Variants } from 'motion/react';
import { getLenis } from './SmoothScrollProvider';
import { HideFooterModal } from './HideFooterModal';

/**
 * DropSync footer — a pixel-perfect port of the standalone `footer-prototype.html`
 * (at the project root). That prototype is the SINGLE SOURCE OF TRUTH for every
 * value: colors, spacing, sizes, SVG paths, hover effects, and transition timing.
 *
 * PORTED: the footer's markup/design, its OWN entrance animation (a content cascade
 * that plays when the footer scrolls into view, built with the already-installed
 * `motion` package), and its hover effects.
 *
 * EXCLUDED (page-level mechanism in the prototype — would change the app's scroll/
 * structure): Lenis smooth-scroll, the wheel "intent-threshold" magnetic gate, the
 * sticky `#app-shell`, and the app cross-fade/dissolve as the footer rises. The app
 * scrolls natively (window.scrollTo); this footer is a normal-flow block placed
 * below the app and reached by scrolling.
 *
 * The footer renders its OWN fixed black palette regardless of the app's
 * light/dark/minimal theme (it does not read the theme). All styling is Tailwind
 * arbitrary values on its elements — NO globals.css / global-stylesheet edits.
 */

// Signature easing curves from the prototype (the GSAP `power3/power4` eases +
// the global --ease cubic-bezier(0.4,0,0.2,1)). Typed as 4-tuples so they satisfy
// motion's `Easing` (BezierDefinition) type.
const EASE = {
  power4Out: [0.16, 1, 0.3, 1] as [number, number, number, number],
  power3Out: [0.215, 0.61, 0.355, 1] as [number, number, number, number],
  power3InOut: [0.65, 0, 0.35, 1] as [number, number, number, number],
};

// The container only orchestrates — it propagates the variant label to its
// descendants; it does not animate itself (empty hidden/visible).
const containerVariants: Variants = { hidden: {}, visible: {} };

// Content-cascade timeline — reproduced from the prototype's GSAP `content` timeline
// (absolute start times in seconds). Each animated element declares its own hidden
// (initial, declarative → no FOUC) + visible (end) variant; the footer container
// propagates the label so children animate with these delays on viewport entry.
const wordmarkVariants: Variants = {
  hidden: { y: '115%' },
  visible: { y: 0, transition: { duration: 0.9, ease: EASE.power4Out } },
};

const taglineVariants: Variants = {
  hidden: { opacity: 0, y: 22 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.6, ease: EASE.power3Out, delay: 0.15 } },
};

const contactVariants: Variants = {
  hidden: { opacity: 0, y: 22 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.6, ease: EASE.power3Out, delay: 0.30 } },
};

const creditVariants: Variants = {
  hidden: { opacity: 0, y: 22 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.6, ease: EASE.power3Out, delay: 0.42 } },
};

// The three link columns stagger 0.12s apart, starting at 0.32s (matches the
// prototype's `.to('.f-col', { stagger:0.12 }, 0.32)`).
const columnVariants: Variants[] = [0, 1, 2].map(
  (i): Variants => ({
    hidden: { opacity: 0, y: 22 },
    visible: { opacity: 1, y: 0, transition: { duration: 0.65, ease: EASE.power3Out, delay: 0.32 + i * 0.12 } },
  }),
);

const ruleVariants: Variants = {
  hidden: { opacity: 0, scaleX: 0 },
  visible: { opacity: 1, scaleX: 1, transition: { duration: 0.7, ease: EASE.power3InOut, delay: 0.60 } },
};

const bottomVariants: Variants = {
  hidden: { opacity: 0, y: 22 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.6, ease: EASE.power3Out, delay: 0.72 } },
};

// --dur(350ms) / --ease cubic-bezier(0.4,0,0.2,1) — the prototype's signature
// transition on every interactive element.
const SIG = 'duration-[350ms] ease-[cubic-bezier(0.4,0,0.2,1)]';

// Column links transition color, opacity, transform (the prototype's explicit list)
// PLUS `translate` — Tailwind v4 implements translate-x via the CSS `translate`
// property, so listing it guarantees the hover nudge animates regardless of which
// transform model the utility emits. Functionally identical to the prototype.
const LINK_TRANSITION = `transition-[color,opacity,transform,translate] ${SIG}`;

const COLUMNS: { title: string; links: { label: string; href: string }[] }[] = [
  {
    title: 'Product',
    links: [
      { label: 'How it works', href: '/docs#getting-started' },
      { label: 'Security', href: '/docs#security' },
      { label: 'Docs', href: '/docs' },
    ],
  },
  {
    title: 'Company',
    links: [
      { label: 'About', href: '/about' },
      { label: 'Contact', href: 'mailto:ahmedsaeed20026@gmail.com' },
    ],
  },
  {
    title: 'Legal',
    links: [
      { label: 'Privacy Policy', href: '/privacy' },
      { label: 'Terms of Service', href: '/privacy' }, // temporary stand-in until a real /terms page exists
    ],
  },
];

// Social icon <path d="…"> strings copied VERBATIM from the prototype (do not
// substitute generic icons). Each carries its prototype width/height.
const SOCIALS = [
  {
    label: 'GitHub',
    href: 'https://github.com/AhmedSaeed4/dropsync',
    width: 17,
    height: 17,
    path: 'M12 .5A11.5 11.5 0 0 0 .5 12a11.5 11.5 0 0 0 7.86 10.92c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.53-1.34-1.3-1.7-1.3-1.7-1.06-.72.08-.71.08-.71 1.17.08 1.79 1.2 1.79 1.2 1.04 1.79 2.73 1.27 3.4.97.1-.76.41-1.27.74-1.56-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11 11 0 0 1 5.8 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.84 1.19 3.1 0 4.42-2.69 5.39-5.25 5.68.42.36.8 1.08.8 2.18v3.23c0 .31.21.67.8.56A11.5 11.5 0 0 0 23.5 12 11.5 11.5 0 0 0 12 .5Z',
  },
  {
    label: 'X',
    href: 'https://x.com/AhmedSaeed27238',
    width: 13,
    height: 13,
    path: 'M18.244 2.25h3.308l-7.227 8.26 8.502 11.24h-6.66l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231 5.45-6.231Zm-1.161 17.52h1.833L7.084 4.126H5.117L17.083 19.77Z',
  },
  {
    label: 'LinkedIn',
    href: 'https://www.linkedin.com/in/ahmed-saeed-0278a12b5/',
    width: 14,
    height: 14,
    path: 'M20.45 20.45h-3.56v-5.57c0-1.33-.02-3.04-1.85-3.04-1.85 0-2.13 1.45-2.13 2.94v5.67H9.35V9h3.42v1.56h.05c.48-.9 1.64-1.85 3.37-1.85 3.6 0 4.27 2.37 4.27 5.46v6.28zM5.34 7.43a2.07 2.07 0 1 1 0-4.14 2.07 2.07 0 0 1 0 4.14zM7.12 20.45H3.55V9h3.57v11.45zM22.22 0H1.77C.79 0 0 .77 0 1.72v20.56C0 23.23.79 24 1.77 24h20.45c.98 0 1.78-.77 1.78-1.72V1.72C24 .77 23.2 0 22.22 0z',
  },
];

export function Footer({ onHideFooter }: { onHideFooter: () => void }) {
  // Honors prefers-reduced-motion: when reduced, render fully visible with NO
  // animation (initial === visible → no transition occurs; no whileInView gate).
  // The hidden initial state is still declared for non-reduced users, so there is
  // never a flash of visible-then-hidden (the prompt's FOUC requirement).
  const reduce = useReducedMotion();
  const [hideOpen, setHideOpen] = useState(false);
  // True once the confirm scroll has started — guards the "Hide footer" button against a re-open
  // click during the ~1.4s retract scroll. A re-click would re-mount HideFooterModal → lockScroll
  // → Lenis stop(), aborting the in-flight scrollTo so its onComplete never fires and the first
  // hide is stranded mid-flight. Set in handleConfirmHide; the Footer unmounts right after
  // onComplete, so it never needs resetting.
  const hidingRef = useRef(false);

  const handleBackToTop = () => {
    // Route through Lenis so it stays in sync (raw window.scrollTo would desync the
    // smooth-scroll target). Falls back to native when Lenis is off (reduced-motion).
    const lenis = getLenis();
    if (lenis) lenis.scrollTo(0);
    else window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  // "Hide footer" confirm sequence — order is load-bearing:
  //  1. Close the modal FIRST (setHideOpen(false)) → HideFooterModal unmounts → its
  //     useBodyScrollLock cleanup runs (unlockScroll → refcount 0 → Lenis resumes). That cleanup
  //     is a PASSIVE useEffect (fires AFTER paint), so a single rAF can land before Lenis has
  //     actually resumed — hence the DOUBLE rAF, which lands firmly in a later frame where the
  //     cleanup has flushed and Lenis is moving again.
  //  2. Smooth-scroll to top so the footer slides back down out of view. force:true is essential,
  //     not optional: if Lenis were somehow still stopped, a plain scrollTo is ignored and
  //     onComplete never fires (the footer would never hide). force makes it scroll + complete
  //     regardless of the stopped flag.
  //  3. On Lenis completion → onHideFooter → persistFooterEnabled(false) → footerActive flips
  //     false → this Footer unmounts (by then it's scrolled out of view, so the unmount is
  //     invisible) and dissolve/magnet disable atomically.
  //  Reduced-motion / no Lenis → hide immediately (no scroll animation), per spec.
  const handleConfirmHide = () => {
    hidingRef.current = true; // block a re-open click during the retract scroll (see hidingRef)
    setHideOpen(false);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const lenis = getLenis();
        if (lenis) lenis.scrollTo(0, { onComplete: onHideFooter, force: true });
        else onHideFooter();
      });
    });
  };

  return (
    <motion.footer
      id="footer-shell"
      variants={containerVariants}
      initial={reduce ? 'visible' : 'hidden'}
      animate={reduce ? 'visible' : undefined}
      whileInView={reduce ? undefined : 'visible'}
      // once:false → reverses cleanly when scrolled back up (matches the prototype's
      // onEnter/onEnterBack: play, onLeaveBack: reverse). amount:0.4 ≈ the prototype's
      // ScrollTrigger `start: 'top 60%'` (footer top at 60% of the viewport).
      viewport={reduce ? undefined : { once: false, amount: 0.4 }}
      className="relative z-[2] flex min-h-[100dvh] flex-col justify-center bg-[#000000] px-10 pb-10 pt-[72px] text-[#FFFEF5] font-[family-name:var(--font-raleway)] max-[640px]:px-5 max-[640px]:pb-7 max-[640px]:pt-[56px]"
    >
      <div className="mx-auto w-full max-w-[1200px]">
        {/* f-top grid: brand block + 3 link columns. Collapses 1.7fr/1fr/1fr/1fr →
            1fr/1fr at max-width:880px (gap 44px → 30px). */}
        <div className="grid grid-cols-[1.7fr_1fr_1fr_1fr] gap-[44px] max-[880px]:grid-cols-2 max-[880px]:gap-[30px]">
          {/* ---- Brand block ---- */}
          <div>
            {/* Wordmark — mask-rise reveal: the overflow-hidden outer clips the inner
                span, which is lifted in from y:115%. padding-bottom:.08em prevents the
                descender from being clipped by the mask. */}
            <div className="inline-flex items-baseline overflow-hidden pb-[0.08em] text-[30px] font-medium tracking-[-0.3px]">
              <motion.span variants={wordmarkVariants} className="inline-block will-change-transform">
                <span className="mr-2.5 text-[#FFFEF5]">◆</span>DropSync
              </motion.span>
            </div>

            <motion.p
              variants={taglineVariants}
              className="mt-4 mb-[18px] max-w-[300px] text-sm leading-[1.6] text-[rgba(255,254,245,0.55)]"
            >
              Secure file transfer. Drop anywhere, pickup anywhere. Files auto-expire.
            </motion.p>

            <motion.div variants={contactVariants} className="text-[13px] text-[#FFFEF5]">
              Contact —{' '}
              <a
                href="mailto:ahmedsaeed20026@gmail.com"
                className={`border-b border-transparent text-[#FF5A47] transition-[border-color] ${SIG} hover:border-[#FF5A47]`}
              >
                ahmedsaeed20026@gmail.com
              </a>
            </motion.div>

            <motion.div variants={creditVariants} className="mt-3.5 text-xs text-[rgba(255,254,245,0.55)]">
              Built &amp; maintained by Ahmed
            </motion.div>
          </div>

          {/* ---- Three link columns ---- */}
          {COLUMNS.map((col, i) => (
            <motion.div key={col.title} variants={columnVariants[i]}>
              <h4 className="mb-4 text-xs font-medium uppercase tracking-[0.12em] text-[rgba(255,254,245,0.55)]">
                {col.title}
              </h4>
              {col.links.map((link) => {
                // Branch by destination type. The footer only shows for logged-in
                // users, so every link opens in a NEW TAB to preserve their active
                // app session (drops, chats, etc.):
                //  - http(s)://… → external <a>  + target=_blank rel=noopener noreferrer
                //  - mailto:…    → plain <a>, no target (opens the mail client)
                //  - /…          → internal <Link> + target=_blank rel=noopener
                // The className + animated underline are byte-identical for all three.
                const linkClassName = `group relative block py-1.5 text-sm text-[#FFFEF5] [opacity:0.82] hover:[opacity:1] hover:text-[#FF5A47] hover:translate-x-1 ${LINK_TRANSITION}`;
                const underline = (
                  <span className={`pointer-events-none absolute bottom-1.5 left-0 h-px w-0 bg-current transition-[width] ${SIG} group-hover:w-full`} />
                );
                const inner = (
                  <>
                    {link.label}
                    {/* Animated underline (Tailwind has no ::after → a child <span>):
                        grows width 0 → 100% on group-hover, bottom-aligned, currentColor
                        so it tracks the coral hover color. */}
                    {underline}
                  </>
                );
                if (link.href.startsWith('http')) {
                  return (
                    <a key={link.label} href={link.href} target="_blank" rel="noopener noreferrer" className={linkClassName}>
                      {inner}
                    </a>
                  );
                }
                if (link.href.startsWith('mailto:')) {
                  return (
                    <a key={link.label} href={link.href} className={linkClassName}>
                      {inner}
                    </a>
                  );
                }
                return (
                  <Link key={link.label} href={link.href} target="_blank" rel="noopener" className={linkClassName}>
                    {inner}
                  </Link>
                );
              })}
            </motion.div>
          ))}
        </div>

        {/* Divider — draws itself in (scaleX 0 → 1, origin left). */}
        <motion.div variants={ruleVariants} className="mt-12 h-px origin-left bg-[rgba(255,254,245,0.14)]" />

        {/* ---- Bottom bar ---- */}
        <motion.div
          variants={bottomVariants}
          className="mt-[22px] flex flex-wrap items-center justify-between gap-4 text-xs text-[rgba(255,254,245,0.55)]"
        >
          <span>© 2026 DropSync. All rights reserved.</span>

          <div className="flex gap-2.5">
            {SOCIALS.map((s) => (
              <a
                key={s.label}
                href={s.href}
                target="_blank"
                rel="noopener noreferrer"
                title={s.label}
                aria-label={s.label}
                className={`grid h-[34px] w-[34px] place-items-center rounded-lg border border-[rgba(255,254,245,0.14)] text-[#FFFEF5] transition-all ${SIG} hover:border-[#FF5A47] hover:text-[#FF5A47]`}
              >
                <svg viewBox="0 0 24 24" width={s.width} height={s.height} fill="currentColor" aria-hidden="true">
                  <path d={s.path} />
                </svg>
              </a>
            ))}
          </div>

          <div className="flex items-center gap-4">
            <button
              type="button"
              onClick={() => { if (hidingRef.current) return; setHideOpen(true); }}
              className={`cursor-pointer border-0 bg-transparent text-xs text-[rgba(255,254,245,0.55)] transition-colors ${SIG} hover:text-[#FFFEF5]`}
            >
              Hide footer
            </button>
            <button
              type="button"
              onClick={handleBackToTop}
              className={`flex cursor-pointer items-center gap-1.5 border-0 bg-transparent text-xs text-[#FF5A47] transition-opacity ${SIG} hover:opacity-70`}
            >
              ↑ Back to top
            </button>
          </div>
        </motion.div>
      </div>

      {hideOpen && (
        <HideFooterModal onConfirm={handleConfirmHide} onClose={() => setHideOpen(false)} />
      )}
    </motion.footer>
  );
}
