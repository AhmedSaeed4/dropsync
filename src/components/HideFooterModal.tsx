'use client';

import { motion, useReducedMotion, type Variants } from 'motion/react';
import { useBodyScrollLock } from '@/hooks/useBodyScrollLock';
import { useModalBackClose } from '@/hooks/useModalBackClose';

// Mirrors the footer's signature ease + a tagline-style opacity/y entrance (Footer.tsx's
// taglineVariants). The footer's EASE const isn't exported, so power3Out is duplicated here
// verbatim — keep both in sync if the footer's ease ever changes.
const EASE_POWER3OUT = [0.215, 0.61, 0.355, 1] as [number, number, number, number];

const panelVariants: Variants = {
  hidden: { opacity: 0, y: 22 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.6, ease: EASE_POWER3OUT } },
};

// The footer's signature transition (--dur 350ms / --ease cubic-bezier(0.4,0,0.2,1)) on its
// interactive elements — duplicated so this popup shares the footer's hover feel.
const SIG = 'duration-[350ms] ease-[cubic-bezier(0.4,0,0.2,1)]';

/**
 * Confirmation popup for the footer's own "Hide footer" button. Styled like the footer
 * itself — the footer renders its OWN fixed black palette regardless of the app theme (it is
 * theme-blind by design), so this popup matches IT (black, coral accent), not the app's
 * light/dark/minimal variant.
 *
 * Mounting + layering: rendered INSIDE <motion.footer> as `fixed inset-0 z-[60]`. The footer
 * element carries empty containerVariants (no transform/will-change/filter), so it does NOT form
 * a containing block — the panel is viewport-anchored (full-screen). On layering, the panel lives
 * in the FOOTER's stacking context: footer `z-[2]` > `#app-shell` `z-[1]`, and the app's
 * TextModal/PreviewModal are themselves trapped inside #app-shell, so this panel correctly paints
 * above all app content. It is NOT app-topmost against body-portal overlays (Toast, context
 * menus) — none coexist with this hide-footer flow, so that's fine. z-[60] just orders it above
 * the footer's own children.
 */
export function HideFooterModal({ onConfirm, onClose }: { onConfirm: () => void; onClose: () => void }) {
  useBodyScrollLock();
  useModalBackClose(true, onClose);
  const reduce = useReducedMotion();

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm overscroll-contain"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <motion.div
        variants={panelVariants}
        initial={reduce ? 'visible' : 'hidden'}
        animate="visible"
        className="w-full max-w-sm rounded-xl border border-[rgba(255,254,245,0.14)] bg-[#000000] p-6 text-center"
      >
        <h3 className="text-base font-medium text-[#FFFEF5]">Hide the footer?</h3>
        <p className="mt-2 text-sm leading-relaxed text-[rgba(255,254,245,0.55)]">
          You can reopen it anytime from Settings → Layout.
        </p>
        <div className="mt-5 flex items-center justify-center gap-3">
          <button
            type="button"
            onClick={onClose}
            className={`cursor-pointer rounded-lg border border-[rgba(255,254,245,0.14)] bg-transparent px-4 py-2 text-sm text-[rgba(255,254,245,0.55)] transition-colors ${SIG} hover:text-[#FFFEF5]`}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className={`cursor-pointer rounded-lg bg-[#FF5A47] px-4 py-2 text-sm font-medium text-[#FFFEF5] transition-opacity ${SIG} hover:opacity-90`}
          >
            Hide footer
          </button>
        </div>
      </motion.div>
    </div>
  );
}
