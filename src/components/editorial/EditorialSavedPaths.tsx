'use client';

import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'motion/react';
import { getEditorialThemeColors } from './editorialTheme';

const STORAGE_KEY = 'dropsync_saved_paths';
const COLLAPSED_KEY = 'dropsync_saved_paths_collapsed';

interface EditorialSavedPathsProps {
  theme: 'light' | 'dark' | 'minimal';
  showChat?: boolean;
}

export function EditorialSavedPaths({ theme, showChat = false }: EditorialSavedPathsProps) {
  const tc = getEditorialThemeColors(theme);
  const prefersReduced = useReducedMotion();

  const [paths, setPaths] = useState<string[]>([]);
  const [newPath, setNewPath] = useState('');
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const [showInput, setShowInput] = useState(false);
  const [collapsed, setCollapsed] = useState(false); // collapse-to-2 (only meaningful with >2 paths)
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      try { setPaths(JSON.parse(stored)); } catch { setPaths([]); }
    }
    if (localStorage.getItem(COLLAPSED_KEY) === 'true') setCollapsed(true);
  }, []);

  // The input is always mounted (height-animated via the grid trick), so autoFocus can't be
  // used — it would steal focus on mount. Focus imperatively when the field opens instead.
  useEffect(() => {
    if (showInput) inputRef.current?.focus();
  }, [showInput]);

  const save = (updated: string[]) => {
    setPaths(updated);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
  };

  const setCollapsedPersisted = (value: boolean) => {
    setCollapsed(value);
    localStorage.setItem(COLLAPSED_KEY, String(value));
  };

  const addPath = () => {
    const trimmed = newPath.trim();
    if (!trimmed || paths.includes(trimmed)) return;
    save([...paths, trimmed]);
    setNewPath('');
    setShowInput(false);
    setCollapsedPersisted(false); // auto-expand so the newly added path is immediately visible
  };

  const removePath = (index: number) => {
    save(paths.filter((_, i) => i !== index));
  };

  const copyPath = async (index: number) => {
    await navigator.clipboard.writeText(paths[index]);
    setCopiedIndex(index);
    setTimeout(() => setCopiedIndex(null), 1500);
  };

  // Collapse-to-2: only relevant with 3+ paths. Rows are rendered as paths.slice(0,2) (always
  // visible) + paths.slice(2) (inside the height-slide wrapper), so the row index always equals
  // the paths index — copy/delete stay correct in both groups.
  const canCollapse = paths.length > 2;
  const toggleCollapsed = () => setCollapsedPersisted(!collapsed);

  // A single row — rendered by both the always-visible group (first 2) and the collapsible
  // group (the rest). Keyed by path so real add/remove animates via AnimatePresence.
  const renderRow = (path: string, i: number) => (
    <motion.div
      key={path}
      layout
      initial={prefersReduced ? { opacity: 0 } : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0, transition: { duration: 0.22, ease: [0.4, 0, 0.2, 1], delay: prefersReduced ? 0 : Math.min(i * 0.025, 0.15) } }}
      exit={prefersReduced ? { opacity: 0 } : { opacity: 0, scale: 0.92 }}
      transition={{ duration: 0.22, ease: [0.4, 0, 0.2, 1] }}
      className={`flex items-center justify-between px-4 py-3 ${tc.cardBg} border ${tc.border} rounded-lg transition-colors ${tc.hoverBorder}`}
    >
      <p className={`text-[13px] ${tc.fontClass} ${tc.text} truncate flex-1`} title={path}>
        {path}
      </p>
      <div className="flex items-center gap-2">
        <motion.button
          onClick={() => copyPath(i)}
          whileTap={{ scale: prefersReduced ? 1 : 0.95 }}
          className={`relative w-[64px] h-[28px] text-[12px] ${tc.fontClass} border ${tc.border} ${tc.text} rounded ${tc.btnHoverBg} ${tc.btnHoverText} ${tc.hoverBorder} transition-colors`}
        >
          <AnimatePresence initial={false}>
            {copiedIndex === i ? (
              <motion.span
                key="copied"
                className="absolute inset-0 flex items-center justify-center"
                initial={{ opacity: 0, scale: prefersReduced ? 1 : 0.6 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: prefersReduced ? 1 : 0.6 }}
                transition={prefersReduced ? { duration: 0 } : { duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
              >
                <motion.svg
                  className="w-3.5 h-3.5"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                  strokeWidth={2.5}
                >
                  <motion.path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M5 13l4 4L19 7"
                    initial={{ pathLength: prefersReduced ? 1 : 0 }}
                    animate={{ pathLength: 1 }}
                    transition={prefersReduced ? { duration: 0 } : { duration: 0.22, ease: [0.4, 0, 0.2, 1] }}
                  />
                </motion.svg>
              </motion.span>
            ) : (
              <motion.span
                key="copy"
                className="absolute inset-0 flex items-center justify-center"
                initial={{ opacity: 0, scale: prefersReduced ? 1 : 0.8 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: prefersReduced ? 1 : 0.8 }}
                transition={prefersReduced ? { duration: 0 } : { duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
              >
                Copy
              </motion.span>
            )}
          </AnimatePresence>
        </motion.button>
        <motion.button
          onDoubleClick={() => removePath(i)}
          whileTap={{ scale: prefersReduced ? 1 : 0.95 }}
          className={`p-1.5 border ${tc.border} ${tc.text} rounded hover:border-red-400 hover:text-red-500 transition-colors`}
          title="Double-click to delete"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </motion.button>
      </div>
    </motion.div>
  );

  return (
    <div className="transition-colors duration-300">
      {/* Section title with + button */}
      <div className="flex items-center justify-between mb-4">
        {canCollapse ? (
          <button
            type="button"
            onClick={toggleCollapsed}
            className={`flex items-center gap-1.5 text-[16px] font-medium ${tc.fontClass} ${tc.text} cursor-pointer rounded-md px-1.5 -mx-1.5 ${tc.inactivePillHoverBg} transition-colors`}
            title={collapsed ? `Expand (${paths.length} paths)` : 'Collapse'}
          >
            Saved Paths
            <svg className={`w-3.5 h-3.5 ${tc.muted} transition-transform duration-200 ${collapsed ? '-rotate-90' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
            </svg>
          </button>
        ) : (
          <h4 className={`text-[16px] font-medium ${tc.fontClass} ${tc.text}`}>
            Saved Paths
          </h4>
        )}
        <motion.button
          onClick={(e) => { e.stopPropagation(); setShowInput(!showInput); }}
          whileTap={{ scale: prefersReduced ? 1 : 0.9 }}
          className={`w-6 h-6 flex items-center justify-center border ${tc.border} ${tc.text} rounded ${tc.btnHoverBg} ${tc.btnHoverText} ${tc.hoverBorder} transition-colors`}
          title={showInput ? 'Cancel' : 'Add path'}
        >
          <svg className={`w-3.5 h-3.5 transition-transform duration-200 ${showInput ? 'rotate-45' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
          </svg>
        </motion.button>
      </div>

      {/* Add path input — always mounted, height animated via the grid 0fr↔1fr trick */}
      <div className={`grid ${prefersReduced ? '' : 'transition-[grid-template-rows] duration-300 ease-[cubic-bezier(0.4,0,0.2,1)]'} ${showInput ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
        <div className="overflow-hidden">
          <div className="mb-3 flex gap-2">
            <input
              ref={inputRef}
              type="text"
              value={newPath}
              onChange={(e) => setNewPath(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') addPath(); if (e.key === 'Escape') setShowInput(false); }}
              placeholder="Enter path..."
              className={`flex-1 px-3 py-2 text-[13px] ${tc.fontClass} ${tc.bg} ${tc.text} border ${tc.border} rounded-lg focus:outline-none focus:${tc.border}`}
            />
            <motion.button
              onClick={addPath}
              disabled={!newPath.trim()}
              whileTap={{ scale: prefersReduced ? 1 : 0.95 }}
              className={`px-4 py-2 text-[12px] ${tc.fontClass} ${tc.activePillBg} ${tc.activePillText} rounded-lg ${tc.inactivePillHoverBg} disabled:opacity-50 transition-colors`}
            >
              Add
            </motion.button>
          </div>
        </div>
      </div>

      {/* Paths list — first two rows are always visible; the rest slide open/closed via the
          grid 0fr↔1fr height trick (mounted but clipped when collapsed). Each group keeps its
          own AnimatePresence so real add/remove still animates per-row, independent of collapse. */}
      <div>
        <div className="space-y-2">
          <AnimatePresence mode="popLayout">
            {paths.slice(0, 2).map((path, i) => renderRow(path, i))}
            {paths.length === 0 && (
              <motion.p
                key="empty"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.2 }}
                className={`text-[13px] ${tc.fontClass} ${tc.muted} py-2`}
              >
                No saved paths
              </motion.p>
            )}
          </AnimatePresence>
        </div>

        {paths.length > 2 && (
          <div className={`grid ${prefersReduced ? '' : 'transition-[grid-template-rows] duration-300 ease-[cubic-bezier(0.4,0,0.2,1)]'} ${collapsed ? 'grid-rows-[0fr]' : 'grid-rows-[1fr]'}`}>
            <div className="overflow-hidden">
              {/* pt-2 is the gap below the 2nd row; it lives inside the clipped region so it
                  vanishes when collapsed (no leftover gap under the two visible rows). */}
              <div className="pt-2 space-y-2">
                <AnimatePresence mode="popLayout">
                  {paths.slice(2).map((path, j) => renderRow(path, j + 2))}
                </AnimatePresence>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
