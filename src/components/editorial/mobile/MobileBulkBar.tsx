'use client';

import { getEditorialThemeColors } from '../editorialTheme';
import { AnimatePresence, motion } from 'motion/react';
import HoldToDeleteButton from '../HoldToDeleteButton';

type Theme = 'light' | 'dark' | 'minimal';

interface MobileBulkBarProps {
  theme: Theme;
  selectedCount: number;
  // Label logic from EditorialDropList :1024 — "Deselect" when everything is selected.
  allSelected: boolean;
  onSelectAllToggle: () => void;
  onCancel: () => void;
  onMove: () => void;
    deleting: boolean;
    // Parent finished deleting — the bar holds the green "Deleted ✓" beat, then unmounts.
    done: boolean;
    // D10: fired by the hold button the moment its ring completes — starts the delete.
    onHoldComplete: () => void;
}

// The selection-mode bar (#4/#21): a floating centered pill (prototype `.bulkbar`) that hovers
// 14px + safe-area above the bottom with a shadow — the view's AnimatePresence mounts/unmounts
// it and the exit here plays the slide-down while the navbar slides away in step. Delete is a
// press-and-hold button (D10) — the old two-tap arm/confirm is gone.
// MB-1 (owner): the count lives ONLY in the left chip, Move lost its number, Cancel is a ✕
// icon, and Delete is a fixed-size hold button — the row's width no longer grows with the
// selection, so Delete can never be pushed off the screen again.
export function MobileBulkBar({
  theme,
  selectedCount,
  allSelected,
  onSelectAllToggle,
  onCancel,
    onMove,
    deleting,
    done,
    onHoldComplete,
  }: MobileBulkBarProps) {
  const tc = getEditorialThemeColors(theme);
  const font = tc.fontClass;
  // Green "Deleted ✓" beat: the fold derives from the live count (no setState-in-effect —
  // repo lint rule) and stays on through "Deleting..." AND the "Deleted ✓" beat, until
  // the view exits selection mode and the bar unmounts.
  const folding = (deleting || done) && selectedCount > 0;

  // Pills INSIDE the ink-inverted bar: inverse-outline for the neutral actions, solid theme-ink
  // for Move, red for Delete (owner lock: red stays). "Similar, not exact" per the owner.
  // transition-all + overflow-hidden are what let a pill fold to zero width during the flash.
  const neutralBtn = `shrink-0 rounded-full border border-current/30 px-3.5 py-2 text-xs font-medium ${font} transition-all duration-300 overflow-hidden whitespace-nowrap`;
  const countChip = `shrink-0 rounded-full border border-current/30 px-2.5 py-1 text-[11px] font-bold ${font}`;
  // Folded state (flash only): clamp to zero width (px-0! must beat the base padding),
  // fade out, and drop the outline.
  const folded = 'max-w-0 opacity-0 border-transparent px-0!';

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-40 flex justify-center pb-[calc(14px+env(safe-area-inset-bottom))]">
      <motion.div
        layout
        initial={{ y: 90, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: 90, opacity: 0 }}
        transition={{ duration: 0.3, ease: [0.4, 0, 0.2, 1] }}
        className={`pointer-events-auto flex max-w-[calc(100%-28px)] items-center rounded-full p-1.5 shadow-lg ${tc.activePillBg} ${tc.activePillText}`}
      >
        <div className={`flex items-center overflow-x-auto px-0.5 editorial-scroll-hide ${folding ? 'gap-0' : 'gap-1'}`}>
          <span className={countChip}>✓ {selectedCount}</span>
          <button type="button" onClick={onSelectAllToggle} className={`${neutralBtn} ${folding ? folded : ''}`}>
            {allSelected ? 'Deselect' : 'Select all'}
          </button>
          <button type="button" onClick={onCancel} aria-label="Cancel selection" className={`${neutralBtn} ${folding ? folded : ''}`}>
            <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
          {/* R5(b): the actions grow/pop in and animate out — scale+opacity only (GPU-composited;
              no width animation). AnimatePresence plays the exit. */}
          <AnimatePresence initial={false} mode="popLayout">
            {selectedCount > 0 && (
              <motion.div
                key="bulk-actions"
                initial={{ opacity: 0, scale: 0.5 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.5 }}
                transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
                className="flex items-center"
              >
                <button
                  type="button"
                  onClick={onMove}
                  className={`ml-1 shrink-0 rounded-full px-3.5 py-2 text-xs font-medium ${font} ${tc.text} ${tc.bg} transition-all duration-300 hover:opacity-90 overflow-hidden whitespace-nowrap ${folding ? folded : ''}`}
                >
                  Move
                </button>
                <HoldToDeleteButton
                  variant="compact"
                  count={selectedCount}
                  deleting={deleting}
                  done={done}
                  onHoldComplete={onHoldComplete}
                  className={`ml-1 h-8 rounded-full px-3.5 hover:bg-red-600 ${font}`}
                />
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </motion.div>
    </div>
  );
}
