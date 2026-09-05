'use client';

import { getEditorialThemeColors } from '../editorialTheme';
import { AnimatePresence, motion } from 'motion/react';

type Theme = 'light' | 'dark' | 'minimal';

interface MobileBulkBarProps {
  theme: Theme;
  selectedCount: number;
  // Label logic from EditorialDropList :1024 — "Deselect" when everything is selected.
  allSelected: boolean;
  onSelectAllToggle: () => void;
  onCancel: () => void;
  onMove: () => void;
  // Two-tap label-only delete: first tap arms ("Confirm delete N"), second tap fires.
  confirmDelete: boolean;
  deleting: boolean;
  onDeleteClick: () => void;
  // Outside-press disarm needs to ignore presses on the delete button itself — the view's
  // pointerdown listener checks this node (same as EditorialDropList's bulkDeleteRef).
  deleteButtonRef?: React.RefObject<HTMLButtonElement | null>;
}

// The selection-mode bar (#4/#21): a floating centered pill (prototype `.bulkbar`) that hovers
// 14px + safe-area above the bottom with a shadow — the view's AnimatePresence mounts/unmounts
// it and the exit here plays the slide-down while the navbar slides away in step. Delete arms
// label-only (no pulse/ring/fill); the view owns the 3s auto-disarm, outside-press disarm, and
// disarm on empty/Cancel.
export function MobileBulkBar({
  theme,
  selectedCount,
  allSelected,
  onSelectAllToggle,
  onCancel,
  onMove,
  confirmDelete,
  deleting,
  onDeleteClick,
  deleteButtonRef,
}: MobileBulkBarProps) {
  const tc = getEditorialThemeColors(theme);
  const font = tc.fontClass;

  // Pills INSIDE the ink-inverted bar: inverse-outline for the neutral actions, solid theme-ink
  // for Move, red for Delete (owner lock: red stays). "Similar, not exact" per the owner.
  const neutralBtn = `shrink-0 rounded-full border border-current/30 px-3.5 py-2 text-xs font-medium ${font}`;
  const countChip = `shrink-0 rounded-full border border-current/30 px-2.5 py-1 text-[11px] font-bold ${font}`;

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
        <div className="flex items-center gap-1 overflow-x-auto px-0.5 editorial-scroll-hide">
          <span className={countChip}>{selectedCount}</span>
          <button type="button" onClick={onSelectAllToggle} className={neutralBtn}>
            {allSelected ? 'Deselect' : 'Select all'}
          </button>
          <button type="button" onClick={onCancel} className={neutralBtn}>
            Cancel
          </button>
          {/* R5(b): the actions grow/pop in and animate out with the count — scale+opacity
              only (GPU-composited; no width animation). AnimatePresence plays the exit. */}
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
                  className={`ml-1 shrink-0 rounded-full px-3.5 py-2 text-xs font-medium ${font} ${tc.text} ${tc.bg} transition-opacity hover:opacity-90`}
                >
                  Move {selectedCount}
                </button>
                <button
                  type="button"
                  ref={deleteButtonRef}
                  onClick={onDeleteClick}
                  disabled={deleting}
                  className={`ml-1 shrink-0 rounded-full bg-red-500 px-3.5 py-2 text-xs font-medium text-white hover:bg-red-600 disabled:opacity-50 ${font}`}
                >
                  {deleting ? 'Deleting...' : confirmDelete ? `Confirm delete ${selectedCount}` : `Delete ${selectedCount}`}
                </button>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </motion.div>
    </div>
  );
}
