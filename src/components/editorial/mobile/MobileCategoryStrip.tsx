'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { Drop, Category } from '@/types';
import { getEditorialThemeColors } from '../editorialTheme';
import { getCategoryCollapsed, setCategoryCollapsed } from '@/lib/auth';

type Theme = 'light' | 'dark' | 'minimal';

interface MobileCategoryStripProps {
  // The space's visible drops (pending deletions already filtered by the view) — counts source.
  drops: Drop[];
  categories: Category[];
  loading: boolean;
  selectedCategory: string;
  onSelectCategory: (value: string) => void;
  theme: Theme;
  currentUserId: string | null;
  // Workspace id, or 'personal' — the per-space collapse key (Firestore, not localStorage, #25).
  spaceKey: string;
  onDeleteCategory?: (categoryId: string, categoryName: string) => void;
}

const BUILT_IN_CATEGORIES = [
  { value: 'all', label: 'All' },
  { value: 'files', label: 'Files' },
  { value: 'password', label: 'Password' },
  { value: 'link', label: 'Link' },
];

type PillItem =
  | { kind: 'builtin'; key: string; value: string; label: string; count: number | undefined }
  | { kind: 'uncategorized'; key: string; value: string; label: string; count: number }
  | { kind: 'custom'; key: string; value: string; label: string; count: number; cat: Category };

// Measure layout before paint without tripping useLayoutEffect's SSR warning (desktop pattern).
const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

const hasCategory = (drop: Drop, cat: string) =>
  (drop.categories && drop.categories.includes(cat)) || drop.category === cat;

const getCategories = (drop: Drop) =>
  drop.categories && drop.categories.length > 0 ? drop.categories : (drop.category ? [drop.category] : []);

// The desktop's collapsible category strip (#25) at phone width: pills wrap, a hidden full-set
// measurer decides overflow + the row-1 boundary, a sentinel ">>" pill toggles collapse, and the
// collapsed state is remembered per space on the user's Firestore doc. No toggle when everything
// fits one row.
export function MobileCategoryStrip({
  drops,
  categories,
  loading,
  selectedCategory,
  onSelectCategory,
  theme,
  currentUserId,
  spaceKey,
  onDeleteCategory,
}: MobileCategoryStripProps) {
  const tc = getEditorialThemeColors(theme);
  const font = tc.fontClass;

  const [confirmDeleteCategory, setConfirmDeleteCategory] = useState<string | null>(null);

  const dropCounts = useMemo(() => {
    const counts: { [key: string]: number } = {
      all: drops.length,
      files: drops.filter(d => d.type === 'file').length,
      password: drops.filter(d => hasCategory(d, 'password')).length,
      link: drops.filter(d => hasCategory(d, 'link')).length,
      uncategorized: drops.filter(d => d.type === 'text' && getCategories(d).length === 0).length,
    };
    categories.forEach(cat => {
      counts[cat.name] = drops.filter(d => hasCategory(d, cat.name)).length;
    });
    return counts;
  }, [drops, categories]);

  const pillItems = useMemo<PillItem[]>(() => {
    const items: PillItem[] = BUILT_IN_CATEGORIES.map((cat) => ({
      kind: 'builtin' as const,
      key: cat.value,
      value: cat.value,
      label: cat.label,
      count: dropCounts[cat.value],
    }));
    if (!loading && (dropCounts['uncategorized'] ?? 0) > 0) {
      items.push({ kind: 'uncategorized', key: 'uncategorized', value: 'uncategorized', label: 'Uncategorized', count: dropCounts['uncategorized'] });
    }
    if (!loading) {
      categories.forEach((cat) => {
        items.push({ kind: 'custom', key: cat.id, value: cat.name, label: cat.name, count: dropCounts[cat.name] || 0, cat });
      });
    }
    return items;
  }, [categories, dropCounts, loading]);

  // --- Measurer + collapse state (ported from EditorialDropList :371-484) ---
  const spaceKeyRef = useRef(spaceKey);
  spaceKeyRef.current = spaceKey;
  const measureRef = useRef<HTMLDivElement>(null);
  const prefsRef = useRef<Record<string, boolean>>({});
  const [overflows, setOverflows] = useState(false);
  const [collapsedHeight, setCollapsedHeight] = useState(0);
  const [expandedHeight, setExpandedHeight] = useState(0);
  const [firstRowCount, setFirstRowCount] = useState(Infinity);
  const [catCollapsed, setCatCollapsed] = useState(true);
  const [animateCollapse, setAnimateCollapse] = useState(false);
  const [animating, setAnimating] = useState(false);

  const measurePillsOverflow = useCallback(() => {
    const el = measureRef.current;
    if (!el) return;
    const children = Array.from(el.children) as HTMLElement[];
    if (children.length === 0) {
      setOverflows(false);
      setCollapsedHeight(0);
      setExpandedHeight(0);
      setFirstRowCount(Infinity);
      return;
    }
    const pillCount = children.length - 1; // last child is the sentinel ">>" pill
    const firstTop = children[0].offsetTop;
    let firstRowBottom = 0;
    let contentBottom = 0;
    let wrapIndex = pillCount;
    let sentinelTop = firstTop;
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      const top = child.offsetTop;
      const bottom = top + child.offsetHeight;
      if (i === pillCount) {
        sentinelTop = top;
      } else if (top > firstTop + 2 && wrapIndex === pillCount) {
        wrapIndex = i; // +2px slack tolerates sub-pixel rounding
      }
      if (top <= firstTop + 2 && bottom > firstRowBottom) firstRowBottom = bottom;
      if (bottom > contentBottom) contentBottom = bottom;
    }
    const overflowPills = wrapIndex < pillCount;
    const count = !overflowPills
      ? Infinity
      : sentinelTop <= firstTop + 2
        ? wrapIndex
        : Math.max(1, wrapIndex - 1);
    setOverflows(overflowPills);
    setCollapsedHeight(firstRowBottom - firstTop);
    setExpandedHeight(contentBottom - firstTop);
    setFirstRowCount(count);
  }, []);

  useIsomorphicLayoutEffect(() => {
    measurePillsOverflow();
    const el = measureRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => measurePillsOverflow());
    ro.observe(el);
    return () => ro.disconnect();
  }, [measurePillsOverflow]);

  useIsomorphicLayoutEffect(() => {
    measurePillsOverflow();
  }, [categories, loading, dropCounts, measurePillsOverflow]);

  // Load the whole catCollapsed map once on mount; default collapsed per space.
  useEffect(() => {
    if (!currentUserId) return;
    let cancelled = false;
    getCategoryCollapsed(currentUserId)
      .then((map) => {
        if (cancelled) return;
        prefsRef.current = map;
        setAnimateCollapse(false);
        setCatCollapsed(map[spaceKeyRef.current] ?? true);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [currentUserId]);

  // Apply this space's preference instantly whenever the space changes.
  useEffect(() => {
    setAnimateCollapse(false);
    setCatCollapsed(prefsRef.current[spaceKey] ?? true);
  }, [spaceKey]);

  const toggleCollapse = useCallback(() => {
    const next = !catCollapsed;
    prefsRef.current = { ...prefsRef.current, [spaceKey]: next };
    setAnimateCollapse(true);
    setAnimating(true);
    setCatCollapsed(next);
    if (currentUserId) {
      setCategoryCollapsed(currentUserId, spaceKey, next); // background write; swallows its own errors
    }
  }, [catCollapsed, spaceKey, currentUserId]);

  const togglePillClasses = `flex items-center gap-1 px-2.5 py-1.5 text-xs ${font} rounded-full transition-colors ${tc.inactivePillBg} ${tc.inactivePillText} ${tc.inactivePillHoverBg}`;

  const showTrimmed = catCollapsed && !animating && overflows;
  const showToggle = overflows && (!catCollapsed || !animating);
  const visibleItems = showTrimmed ? pillItems.slice(0, firstRowCount) : pillItems;

  const handleCategoryDeleteClick = (categoryId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirmDeleteCategory(categoryId);
  };
  const handleCategoryConfirmDelete = (categoryId: string, categoryName: string, e: React.MouseEvent) => {
    e.stopPropagation();
    onDeleteCategory?.(categoryId, categoryName);
    setConfirmDeleteCategory(null);
  };
  const handleCategoryCancelDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirmDeleteCategory(null);
  };

  const renderPill = (item: PillItem) => {
    const isActive = selectedCategory === item.value;
    const stateCls = isActive
      ? `${tc.activePillBg} ${tc.activePillText}`
      : `${tc.inactivePillBg} ${tc.inactivePillText} ${tc.inactivePillHoverBg}`;

    if (item.kind === 'builtin') {
      return (
        <button
          key={item.key}
          type="button"
          onClick={() => onSelectCategory(item.value)}
          className={`flex items-center gap-1.5 px-3 py-1.5 text-xs ${font} rounded-full transition-colors ${stateCls}`}
        >
          <span>{item.label}</span>
          {!loading && item.count !== undefined && (
            <span className={`text-[10px] ${isActive ? tc.activePillCountText : tc.muted}`}>{item.count}</span>
          )}
        </button>
      );
    }

    if (item.kind === 'uncategorized') {
      return (
        <button
          key={item.key}
          type="button"
          onClick={() => onSelectCategory(item.value)}
          className={`flex items-center gap-1.5 px-3 py-1.5 text-xs ${font} rounded-full transition-colors ${stateCls}`}
        >
          <span>Uncategorized</span>
          <span className={`text-[10px] ${isActive ? tc.activePillCountText : tc.muted}`}>{item.count}</span>
        </button>
      );
    }

    // Custom category — zero-count ones get the inline delete confirm (compact port of :739-784).
    const showDelete = item.count === 0 && confirmDeleteCategory !== item.cat.id;
    return (
      <div key={item.key} className="relative flex items-center">
        <button
          type="button"
          onClick={() => onSelectCategory(item.value)}
          className={`flex items-center gap-1.5 px-3 py-1.5 text-xs ${font} rounded-full transition-colors ${stateCls} ${showDelete ? 'pr-1' : ''}`}
        >
          <span>{item.cat.name}</span>
          <span className={`text-[10px] ${isActive ? tc.activePillCountText : tc.muted}`}>{item.count}</span>
        </button>

        {item.count === 0 && confirmDeleteCategory !== item.cat.id && (
          <button
            type="button"
            onClick={(e) => handleCategoryDeleteClick(item.cat.id, e)}
            className={`ml-1 flex h-4 w-4 items-center justify-center ${tc.muted} hover:text-red-500 transition-colors`}
            aria-label={`Delete category ${item.cat.name}`}
          >
            <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        )}

        {confirmDeleteCategory === item.cat.id && (
          <div className="ml-1 flex items-center gap-1">
            <button
              type="button"
              onClick={(e) => handleCategoryConfirmDelete(item.cat.id, item.cat.name, e)}
              className="rounded bg-red-500 px-2 py-1 text-xs text-white transition-colors hover:bg-red-600"
              aria-label="Confirm delete"
            >
              <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            </button>
            <button
              type="button"
              onClick={handleCategoryCancelDelete}
              className={`rounded border border-[#1A1A1A]/20 px-2 py-1 text-xs transition-colors hover:bg-[#1A1A1A]/10 ${tc.text}`}
              aria-label="Cancel"
            >
              <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        )}
      </div>
    );
  };

  return (
    <div>
      {/* Hidden full-set measurer — every pill + the sentinel ">>", clipped to zero height */}
      <div
        ref={measureRef}
        aria-hidden="true"
        className="flex flex-wrap gap-2"
        style={{ height: 0, overflow: 'hidden' }}
      >
        {pillItems.map(renderPill)}
        <span className={togglePillClasses}>{'>>'}</span>
      </div>

      <motion.div
        className="relative flex flex-wrap gap-2"
        initial={false}
        animate={{ height: catCollapsed ? collapsedHeight : expandedHeight }}
        transition={{ duration: animateCollapse ? 0.25 : 0, ease: [0.4, 0, 0.2, 1] }}
        style={{ overflow: 'hidden' }}
        onAnimationComplete={() => setAnimating(false)}
      >
        {visibleItems.map(renderPill)}
        {showToggle && (
          <button
            type="button"
            onClick={toggleCollapse}
            className={togglePillClasses}
            aria-label={catCollapsed ? 'Show all categories' : 'Show fewer categories'}
          >
            <span>{catCollapsed ? '>>' : '<<'}</span>
          </button>
        )}
      </motion.div>
    </div>
  );
}
