'use client';

import { useEffect } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { getEditorialThemeColors } from '../editorialTheme';
import type { DropSortMode } from '@/lib/auth';

type Theme = 'light' | 'dark' | 'minimal';

interface MobileSortMenuProps {
  open: boolean;
  onClose: () => void;
  sortMode: DropSortMode;
  // The view's sort handler — ports EditorialDropList :523-528 (onSortModeChange +
  // setSortMode + the background setDropSortMode write).
  onSortChange: (mode: DropSortMode) => void;
  theme: Theme;
}

const SORT_OPTIONS: { value: DropSortMode; label: string }[] = [
  { value: 'newest', label: 'Newest' },
  { value: 'manual', label: 'Manual' },
  { value: 'name', label: 'Name (A–Z)' },
  { value: 'size', label: 'Size' },
  { value: 'expiry', label: 'Expiry' },
];

// The sort menu as a bottom sheet: the five SORT_OPTIONS, active = ink inversion + check,
// Esc/backdrop closes. The trigger's label lives in the view's control row.
export function MobileSortMenu({ open, onClose, sortMode, onSortChange, theme }: MobileSortMenuProps) {
  const tc = getEditorialThemeColors(theme);
  const font = tc.fontClass;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  return (
    <>
      <AnimatePresence>
        {open && (
          <motion.div
            key="sort-backdrop"
            className="fixed inset-0 z-50 bg-black/50"
            onClick={onClose}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
          />
        )}
        {open && (
          <motion.div
            key="sort-panel"
            role="menu"
            aria-label="Sort drops"
            initial={{ y: '100%' }}
            animate={{ y: 0 }}
            exit={{ y: '100%' }}
            transition={{ duration: 0.28, ease: [0.4, 0, 0.2, 1] }}
            className={`fixed inset-x-0 bottom-0 z-50 rounded-t-[14px] border-t ${tc.cardBg} ${tc.border}`}
            style={{ maxHeight: 'calc(100dvh - 12px)', overflowY: 'auto', paddingBottom: 'max(env(safe-area-inset-bottom), var(--archive-stack-clearance, 0px))' }}
          >
        <div className="mx-auto mt-2.5 mb-2 h-1 w-9 rounded-full bg-current opacity-20" />
        <p className={`px-5 pb-1.5 text-xs font-medium ${font} ${tc.muted}`}>Sort by</p>
        <div className="pb-2">
          {SORT_OPTIONS.map((o) => {
            const active = o.value === sortMode;
            return (
              <button
                key={o.value}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                onClick={() => { onSortChange(o.value); onClose(); }}
                className={`flex w-full items-center justify-between px-5 py-3 text-left text-sm ${font} transition-colors ${
                  active ? `${tc.activePillBg} ${tc.activePillText}` : `${tc.text} ${tc.inactivePillHoverBg}`
                }`}
              >
                <span>{o.label}</span>
                {active && (
                  <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                )}
              </button>
            );
          })}
        </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
