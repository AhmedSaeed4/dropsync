'use client';

import { useState, useCallback, useMemo, useEffect, useLayoutEffect, useRef, type ComponentProps } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { DndContext, PointerSensor, useSensor, useSensors, closestCenter, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { Drop, Workspace, Category } from '@/types';
import { EditorialDropItem } from './EditorialDropItem';
import { UndoToast } from '@/components/UndoToast';
import { Toast } from '@/components/Toast';
import { deleteDrop, moveDrop, pinDrop, unpinDrop } from '@/lib/drops';
import { EditorialMoveDropModal } from './EditorialMoveDropModal';
import { getEditorialThemeColors } from './editorialTheme';
import { MemberInfo } from '@/lib/workspaces';
import { getCategoryCollapsed, setCategoryCollapsed, getDropSortPrefs, setDropSortMode, setDropOrder } from '@/lib/auth';

interface EditorialDropListProps {
  drops: Drop[];
  loading: boolean;
  onDelete: () => void;
  onPreview: (drop: Drop) => void;
  onEdit?: (drop: Drop) => void;
  workspaces?: Workspace[];
  theme?: 'light' | 'dark' | 'minimal';
  currentUserId?: string;
  categories?: Category[];
  onDeleteCategory?: (categoryId: string, categoryName: string) => void;
  showChat?: boolean;
  currentWorkspace?: Workspace | null;
  workspaceMembers?: MemberInfo[];
}

interface PendingDeletion {
  drop: Drop;
  timeoutId: NodeJS.Timeout;
}

const BUILT_IN_CATEGORIES = [
  { value: 'all', label: 'All' },
  { value: 'files', label: 'Files' },
  { value: 'password', label: 'Password' },
  { value: 'link', label: 'Link' },
];

// Measure layout before paint without tripping useLayoutEffect's SSR warning.
const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

type SortMode = 'manual' | 'newest' | 'name' | 'size' | 'expiry';

const SORT_OPTIONS: { value: SortMode; label: string }[] = [
  { value: 'newest', label: 'Newest' },
  { value: 'manual', label: 'Manual' },
  { value: 'name', label: 'Name (A–Z)' },
  { value: 'size', label: 'Size' },
  { value: 'expiry', label: 'Expiry' },
];

// Size used for the "Size" sort: files by fileSize, text by content length; -1 = neither (sorts last).
function dropSizeValue(d: Drop): number {
  if (d.type === 'file') return d.fileSize ?? -1;
  if (d.type === 'text') return d.content?.length ?? -1;
  return -1;
}

// Expiry rank for the "Expiry" sort: soonest-expiring first; permanent (null) sorts last.
function dropExpiryRank(d: Drop): number {
  return d.expiresAt ? d.expiresAt.getTime() : Number.MAX_SAFE_INTEGER;
}

// Sort the UNPINNED drops for a mode. Pinned drops are always kept on top (newest-first)
// and sorted separately, so this only orders the unpinned set.
function sortUnpinned(drops: Drop[], mode: SortMode, manualOrder: string[]): Drop[] {
  if (mode === 'manual') {
    // Drops not in the saved order appear first (newest-first); then the saved order.
    // So brand-new drops land on top until the user rearranges.
    const orderSet = new Set(manualOrder);
    const known = manualOrder
      .map((id) => drops.find((d) => d.id === id))
      .filter((d): d is Drop => Boolean(d));
    const unknown = drops
      .filter((d) => !orderSet.has(d.id))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return [...unknown, ...known];
  }
  return [...drops].sort((a, b) => {
    switch (mode) {
      case 'newest':
        return b.createdAt.getTime() - a.createdAt.getTime();
      case 'name':
        return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
      case 'size':
        return dropSizeValue(b) - dropSizeValue(a); // largest first; neither → last
      case 'expiry':
        return dropExpiryRank(a) - dropExpiryRank(b); // soonest first; permanent → last
      default:
        return 0;
    }
  });
}

// Detect a fine pointer (mouse/trackpad) vs coarse (touch): grip+drag on fine, ↑/↓ on coarse.
function useFinePointer(): boolean {
  const [fine, setFine] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(pointer: fine)');
    const update = () => setFine(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);
  return fine;
}

// Sortable wrapper for an editorial drop item (desktop Manual mode). Owns useSortable,
// applies the dnd-kit transform to its node, and forwards the drag listeners to the
// item's grip handle (drag starts only from the grip).
function SortableEditorialDropItem(props: ComponentProps<typeof EditorialDropItem>) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: props.drop.id });
  return (
    <div
      ref={setNodeRef}
      style={{
        transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
        transition: transition ?? undefined,
        zIndex: isDragging ? 50 : undefined,
        opacity: isDragging ? 0.85 : undefined,
      }}
    >
      <EditorialDropItem {...props} showDragHandle dragHandleProps={{ ...attributes, ...listeners }} />
    </div>
  );
}

export function EditorialDropList({
  drops,
  loading,
  onDelete,
  onPreview,
  onEdit,
  workspaces = [],
  theme = 'light',
  currentUserId,
  categories = [],
  onDeleteCategory,
  showChat = false,
  currentWorkspace,
  workspaceMembers,
}: EditorialDropListProps) {
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);
  const [pendingDeletions, setPendingDeletions] = useState<Map<string, PendingDeletion>>(new Map());
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [bulkMoveDrops, setBulkMoveDrops] = useState<Drop[] | null>(null);
  const [moveLoading, setMoveLoading] = useState(false);
  const [pinLimitToast, setPinLimitToast] = useState(false);
  const [mentionFilter, setMentionFilter] = useState<MemberInfo | null>(null);
  const [mentionSearch, setMentionSearch] = useState('');
  const [mentionDropdownOpen, setMentionDropdownOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const [dropdownPos, setDropdownPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const searchContainerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const isWorkspace = !!currentWorkspace;
  const filteredMembers = useMemo(() => {
    if (!isWorkspace || !workspaceMembers?.length) return [];
    if (!mentionSearch) return workspaceMembers;
    return workspaceMembers.filter(m => (m.displayName || '').toLowerCase().includes(mentionSearch.toLowerCase()));
  }, [isWorkspace, workspaceMembers, mentionSearch]);

  useEffect(() => { setSelectedCategory('all'); }, [categories]);
  useEffect(() => { setMentionFilter(null); setMentionSearch(''); setMentionDropdownOpen(false); }, [currentWorkspace]);
  const [confirmDeleteCategory, setConfirmDeleteCategory] = useState<string | null>(null);

  const tc = getEditorialThemeColors(theme);
  const font = tc.fontClass;

  const openDropdown = () => {
    const rect = searchContainerRef.current?.getBoundingClientRect();
    if (rect) {
      setDropdownPos({
        top: rect.bottom + 4,
        left: rect.left,
        width: rect.width,
      });
    }
    setMentionDropdownOpen(true);
  };

  const toggleSelect = (id: string) => {
    const newSelected = new Set(selectedIds);
    if (newSelected.has(id)) {
      newSelected.delete(id);
    } else {
      newSelected.add(id);
    }
    setSelectedIds(newSelected);
  };

  const selectAll = () => {
    if (selectedIds.size === filteredDrops.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filteredDrops.map(d => d.id)));
    }
  };

  const handleBulkDelete = async () => {
    if (selectedIds.size === 0) return;

    setDeleting(true);
    const selectedDrops = filteredDrops.filter(d => selectedIds.has(d.id));

    await Promise.all(selectedDrops.map(drop => deleteDrop(drop)));

    setSelectedIds(new Set());
    setSelectionMode(false);
    onDelete();
    setDeleting(false);
  };

  const cancelSelection = () => {
    setSelectedIds(new Set());
    setSelectionMode(false);
  };

  // Handle single drop deletion with undo
  const handleDeleteWithUndo = useCallback((drop: Drop) => {
    const timeoutId = setTimeout(async () => {
      await deleteDrop(drop);
      setPendingDeletions(prev => {
        const newMap = new Map(prev);
        newMap.delete(drop.id);
        return newMap;
      });
      onDelete();
    }, 30000);

    setPendingDeletions(prev => {
      const newMap = new Map(prev);
      newMap.set(drop.id, { drop, timeoutId });
      return newMap;
    });
  }, [onDelete]);

  // Undo the deletion for a specific drop
  const handleUndoDeletion = useCallback((dropId: string) => {
    setPendingDeletions(prev => {
      const pending = prev.get(dropId);
      if (pending) {
        clearTimeout(pending.timeoutId);
      }
      const newMap = new Map(prev);
      newMap.delete(dropId);
      return newMap;
    });
  }, []);

  // Dismiss the toast (continue with deletion) for a specific drop
  const handleDismissToast = useCallback((dropId: string) => {
    setPendingDeletions(prev => {
      const pending = prev.get(dropId);
      if (pending) {
        clearTimeout(pending.timeoutId);
        deleteDrop(pending.drop).then(() => {
          onDelete();
        });
      }
      const newMap = new Map(prev);
      newMap.delete(dropId);
      return newMap;
    });
  }, [onDelete]);

  // Filter out all pending deletions from displayed drops
  const visibleDrops = drops.filter(d => !pendingDeletions.has(d.id));

  // Respect prefers-reduced-motion: those users get the current instant snap.
  const prefersReducedMotion = useReducedMotion();

  // Only animate add/remove in the default (unfiltered) view. Search/category/
  // mention filtering re-renders the list on every keystroke, so animating there
  // would jank on large lists (hundreds of drops, no virtualization).
  const isFiltered = searchQuery.trim() !== '' || selectedCategory !== 'all' || !!mentionFilter;
  const animateDrops = !prefersReducedMotion && !isFiltered;

  // Desktop drag-to-reorder (fine pointer); touch devices keep the ↑/↓ buttons.
  const finePointer = useFinePointer();
  const dndSensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const handlePinDrop = useCallback(async (drop: Drop) => {
    if (drop.pinned) {
      await unpinDrop(drop.id);
    } else {
      const pinnedCount = visibleDrops.filter(d => d.pinned).length;
      if (pinnedCount >= 2) {
        setPinLimitToast(true);
        return;
      }
      await pinDrop(drop.id);
    }
  }, [visibleDrops]);

  const hasCategory = (drop: Drop, cat: string) =>
    (drop.categories && drop.categories.includes(cat)) || drop.category === cat;

  const getCategories = (drop: Drop) =>
    drop.categories && drop.categories.length > 0 ? drop.categories : (drop.category ? [drop.category] : []);

  // Calculate drop counts for categories
  const dropCounts = useMemo(() => {
    const counts: { [key: string]: number } = {
      all: visibleDrops.length,
      files: visibleDrops.filter(d => d.type === 'file').length,
      password: visibleDrops.filter(d => hasCategory(d, 'password')).length,
      link: visibleDrops.filter(d => hasCategory(d, 'link')).length,
      uncategorized: visibleDrops.filter(d => d.type === 'text' && getCategories(d).length === 0).length,
    };

    categories.forEach(cat => {
      counts[cat.name] = visibleDrops.filter(d => hasCategory(d, cat.name)).length;
    });

    return counts;
  }, [visibleDrops, categories]);

  // --- Collapsible category strip (per-space, remembered across devices) ---
  // spaceKey = workspace id, or 'personal' for the personal space. Each space
  // keeps its own collapsed state on the user's own doc (independent per member).
  const spaceKey = currentWorkspace?.id ?? 'personal';
  const spaceKeyRef = useRef(spaceKey);
  spaceKeyRef.current = spaceKey;

  const pillsRef = useRef<HTMLDivElement>(null);
  const prefsRef = useRef<Record<string, boolean>>({});
  const [overflows, setOverflows] = useState(false);
  const [collapsedHeight, setCollapsedHeight] = useState(0);
  const [catCollapsed, setCatCollapsed] = useState(true); // default collapsed for brand-new users
  const [animateCollapse, setAnimateCollapse] = useState(false); // animate only on user toggle

  const totalCategoryCount =
    BUILT_IN_CATEGORIES.length + categories.length + (!loading && dropCounts['uncategorized'] > 0 ? 1 : 0);
  const shouldCollapsePills = overflows && catCollapsed;

  // Measure whether the pills overflow a single row, and capture one row's height.
  const measurePillsOverflow = useCallback(() => {
    const el = pillsRef.current;
    if (!el) return;
    const children = Array.from(el.children) as HTMLElement[];
    if (children.length === 0) {
      setOverflows(false);
      setCollapsedHeight(0);
      return;
    }
    const firstTop = children[0].offsetTop;
    let firstRowBottom = 0;
    let hasSecondRow = false;
    for (const child of children) {
      const top = child.offsetTop;
      const bottom = top + child.offsetHeight;
      // Tolerate sub-pixel rounding so a 1px difference can't register a phantom second row.
      if (top > firstTop + 2) hasSecondRow = true;
      else if (bottom > firstRowBottom) firstRowBottom = bottom;
    }
    setOverflows(hasSecondRow);
    setCollapsedHeight(firstRowBottom);
  }, []);

  // Initial measure + re-measure on resize (pills re-wrap when the width changes).
  useIsomorphicLayoutEffect(() => {
    measurePillsOverflow();
    const el = pillsRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => measurePillsOverflow());
    ro.observe(el);
    return () => ro.disconnect();
  }, [measurePillsOverflow]);

  // Re-measure whenever the rendered pills or their wrapping can change. The
  // ResizeObserver above only fires on the element's own size change — which it
  // does NOT do while the strip is collapsed (height is clipped to one row) — so
  // without this, switching from a many-category space to a 4-category one would
  // leave `overflows` stale and wrongly keep the toggle button showing.
  useIsomorphicLayoutEffect(() => {
    measurePillsOverflow();
  }, [categories, loading, showChat, dropCounts, measurePillsOverflow]);

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

  // User toggle: optimistic local update + animate; persist in the background.
  const toggleCollapse = useCallback(() => {
    const next = !catCollapsed;
    prefsRef.current = { ...prefsRef.current, [spaceKey]: next };
    setAnimateCollapse(true);
    setCatCollapsed(next);
    if (currentUserId) {
      setCategoryCollapsed(currentUserId, spaceKey, next); // background write; swallows its own errors
    }
  }, [catCollapsed, spaceKey, currentUserId]);

  // --- Drop sort + manual reorder (per-space, remembered across devices) ---
  const [sortMode, setSortMode] = useState<SortMode>('newest'); // default = current behavior
  const [manualOrder, setManualOrder] = useState<string[]>([]);
  const sortPrefsRef = useRef<{ mode: Record<string, string>; order: Record<string, string[]> }>({ mode: {}, order: {} });

  // Load sort prefs once on mount (whole maps); default newest + empty order.
  useEffect(() => {
    if (!currentUserId) return;
    let cancelled = false;
    getDropSortPrefs(currentUserId)
      .then((prefs) => {
        if (cancelled) return;
        sortPrefsRef.current = prefs;
        setSortMode((sortPrefsRef.current.mode[spaceKeyRef.current] as SortMode) ?? 'newest');
        setManualOrder(sortPrefsRef.current.order[spaceKeyRef.current] ?? []);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [currentUserId]);

  // Apply this space's sort prefs instantly whenever the space changes.
  useEffect(() => {
    setSortMode((sortPrefsRef.current.mode[spaceKey] as SortMode) ?? 'newest');
    setManualOrder(sortPrefsRef.current.order[spaceKey] ?? []);
  }, [spaceKey]);

  const handleSortChange = useCallback((mode: SortMode) => {
    setSortMode(mode);
    sortPrefsRef.current.mode = { ...sortPrefsRef.current.mode, [spaceKey]: mode };
    if (currentUserId) setDropSortMode(currentUserId, spaceKey, mode); // background write; swallows its own errors
  }, [spaceKey, currentUserId]);

  // Custom sort dropdown: themed trigger button + portalled menu (mirrors the
  // @-mention dropdown — fixed positioning, click-outside overlay, tc tokens).
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  const [sortMenuPos, setSortMenuPos] = useState<{ top: number; left: number } | null>(null);
  const sortTriggerRef = useRef<HTMLButtonElement>(null);
  const currentSortLabel = SORT_OPTIONS.find((o) => o.value === sortMode)?.label ?? 'Newest';
  const openSortMenu = () => {
    const rect = sortTriggerRef.current?.getBoundingClientRect();
    if (rect) {
      const MENU_WIDTH = 176;
      // Align the menu's right edge to the trigger's so it never overflows the panel right.
      setSortMenuPos({ top: rect.bottom + 4, left: Math.max(8, rect.right - MENU_WIDTH) });
    }
    setSortMenuOpen(true);
  };

  // Commit a new manual order for this space. Shared by ↑/↓ and drag-to-reorder so
  // there's a single source of truth: optimistic local update + background write.
  const commitManualOrder = useCallback((ids: string[]) => {
    sortPrefsRef.current.order = { ...sortPrefsRef.current.order, [spaceKey]: ids };
    setManualOrder(ids);
    if (currentUserId) setDropOrder(currentUserId, spaceKey, ids);
  }, [spaceKey, currentUserId]);

  // The currently-displayed unpinned id order in Manual mode.
  const currentManualIds = useCallback(
    () => sortUnpinned(visibleDrops.filter((d) => !d.pinned), 'manual', manualOrder).map((d) => d.id),
    [visibleDrops, manualOrder]
  );

  // ↑/↓ (touch): move a drop one slot, then commit.
  const moveDropSlot = useCallback((dropId: string, direction: 'up' | 'down') => {
    const ids = currentManualIds();
    const i = ids.indexOf(dropId);
    if (i < 0) return;
    const j = direction === 'up' ? i - 1 : i + 1;
    if (j < 0 || j >= ids.length) return;
    commitManualOrder(arrayMove(ids, i, j));
  }, [currentManualIds, commitManualOrder]);

  // Drag (desktop): reorder on drop, then commit through the same path.
  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const ids = currentManualIds();
    const oldIndex = ids.indexOf(active.id as string);
    const newIndex = ids.indexOf(over.id as string);
    if (oldIndex < 0 || newIndex < 0) return;
    commitManualOrder(arrayMove(ids, oldIndex, newIndex));
  }, [currentManualIds, commitManualOrder]);

  // Filter drops based on category, search, and mention
  // Filter drops based on category, search, and mention, then sort (pins always on top).
  const filteredDrops = useMemo(() => {
    const filtered = visibleDrops.filter(drop => {
      if (searchQuery && !drop.name.toLowerCase().includes(searchQuery.toLowerCase())) {
        return false;
      }
      if (mentionFilter && drop.userId !== mentionFilter.uid) {
        return false;
      }
      if (selectedCategory === 'all') return true;
      if (selectedCategory === 'files') return drop.type === 'file';
      if (selectedCategory === 'uncategorized') return drop.type === 'text' && getCategories(drop).length === 0;
      return hasCategory(drop, selectedCategory);
    });
    // Pinned always on top (newest-first); unpinned follow the selected sort.
    const pinned = filtered
      .filter((d) => d.pinned)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const unpinned = sortUnpinned(filtered.filter((d) => !d.pinned), sortMode, manualOrder);
    return [...pinned, ...unpinned];
  }, [visibleDrops, selectedCategory, searchQuery, mentionFilter, sortMode, manualOrder]);

  // Manual reorder controls: only in Manual mode, not while filtered or selecting.
  const showMoveControls = sortMode === 'manual' && !isFiltered && !selectionMode;
  const enableDrag = showMoveControls && finePointer;
  const manualIndexById = useMemo(() => {
    const m = new Map<string, number>();
    if (showMoveControls) {
      let i = 0;
      for (const d of filteredDrops) {
        if (!d.pinned) m.set(d.id, i++);
      }
    }
    return m;
  }, [showMoveControls, filteredDrops]);
  const manualCount = manualIndexById.size;

  // Category delete handlers
  const handleCategoryDeleteClick = (categoryId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirmDeleteCategory(categoryId);
  };

  const handleCategoryConfirmDelete = (categoryId: string, categoryName: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (onDeleteCategory) {
      onDeleteCategory(categoryId, categoryName);
    }
    setConfirmDeleteCategory(null);
  };

  const handleCategoryCancelDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirmDeleteCategory(null);
  };

  const shimmerClass = theme === 'dark' ? 'skeleton-shimmer-dark' : theme === 'minimal' ? 'skeleton-shimmer-minimal' : 'skeleton-shimmer-light';

  return (
    <div className="space-y-3">
      {/* Section title — always visible */}
      <div className={`flex items-center gap-2 ${showChat ? 'px-1' : 'px-1'}`}>
        <span className={`text-xs ${tc.muted}`}>&#9670;</span>
        <h2 className={`${font} ${tc.text} font-medium tracking-tight ${showChat ? 'text-xs' : 'text-sm'}`}>Your Drops</h2>
        {!loading && (
          <span className={`${font} ${tc.muted} ${showChat ? 'text-xs' : 'text-xs'}`}>
            {filteredDrops.length}/{visibleDrops.length}
          </span>
        )}
      </div>

      <div className={`${tc.bg} border ${tc.border} ${tc.roundedClass} overflow-hidden`}>
        {/* Category filter pills — collapse to one row when they overflow */}
        <div className={`border-b ${tc.border} ${showChat ? 'px-3 py-2' : 'px-4 py-3'}`}>
          <motion.div
            ref={pillsRef}
            className={`relative flex flex-wrap ${showChat ? 'gap-1' : 'gap-2'}`}
            initial={false}
            animate={{ height: shouldCollapsePills ? collapsedHeight : 'auto' }}
            transition={{ duration: animateCollapse ? 0.25 : 0, ease: [0.4, 0, 0.2, 1] }}
            style={{ overflow: 'hidden' }}
          >
            {BUILT_IN_CATEGORIES.map((cat) => (
              <button
                key={cat.value}
                onClick={() => setSelectedCategory(cat.value)}
                className={`flex items-center ${font} ${tc.roundedClass} transition-colors ${
                  selectedCategory === cat.value
                    ? `${tc.activePillBg} ${tc.activePillText}`
                    : `${tc.inactivePillBg} ${tc.inactivePillText} ${tc.inactivePillHoverBg}`
                } ${showChat ? 'gap-1 px-2.5 py-1 text-xs' : 'gap-1.5 px-3 py-1.5 text-xs'}`}
              >
                <span>{cat.label}</span>
                {!loading && dropCounts[cat.value] !== undefined && (
                  <span className={`text-[10px] ${selectedCategory === cat.value ? tc.inactivePillText : tc.muted}`}>
                    {dropCounts[cat.value]}
                  </span>
                )}
              </button>
            ))}

            {/* Uncategorized (only if there are uncategorized drops) */}
            {!loading && dropCounts['uncategorized'] > 0 && (
              <button
                onClick={() => setSelectedCategory('uncategorized')}
                className={`flex items-center gap-1.5 px-3 py-1.5 text-xs ${font} ${tc.roundedClass} transition-colors ${
                  selectedCategory === 'uncategorized'
                    ? `${tc.activePillBg} ${tc.activePillText}`
                    : `${tc.inactivePillBg} ${tc.inactivePillText} ${tc.inactivePillHoverBg}`
                }`}
              >
                <span>Uncategorized</span>
                <span className={`text-[10px] ${selectedCategory === 'uncategorized' ? tc.inactivePillText : tc.muted}`}>
                  {dropCounts['uncategorized']}
                </span>
              </button>
            )}

            {/* Custom categories */}
            {!loading && categories.map((cat) => {
              const count = dropCounts[cat.name] || 0;
              const showDelete = count === 0 && confirmDeleteCategory !== cat.id;

              return (
                <div key={cat.id} className="relative flex items-center">
                  <button
                    onClick={() => setSelectedCategory(cat.name)}
                    className={`flex items-center gap-1.5 px-3 py-1.5 text-xs ${font} ${tc.roundedClass} transition-colors ${
                      selectedCategory === cat.name
                        ? `${tc.activePillBg} ${tc.activePillText}`
                        : `${tc.inactivePillBg} ${tc.inactivePillText} ${tc.inactivePillHoverBg}`
                    } ${showDelete ? 'pr-1' : ''}`}
                  >
                    <span>{cat.name}</span>
                    <span className={`text-[10px] ${selectedCategory === cat.name ? tc.inactivePillText : tc.muted}`}>
                      {count}
                    </span>
                  </button>

                  {count === 0 && confirmDeleteCategory !== cat.id && (
                    <button
                      onClick={(e) => handleCategoryDeleteClick(cat.id, e)}
                      className={`ml-1 w-4 h-4 flex items-center justify-center ${tc.muted} hover:text-red-500 transition-colors`}
                      title="Delete category"
                    >
                      <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  )}

                  {confirmDeleteCategory === cat.id && (
                    <div className="flex items-center ml-1 gap-1">
                      <button
                        onClick={(e) => handleCategoryConfirmDelete(cat.id, cat.name, e)}
                        className="px-2 py-1 text-xs bg-red-500 text-white hover:bg-red-600 transition-colors rounded"
                        title="Confirm delete"
                      >
                        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                        </svg>
                      </button>
                      <button
                        onClick={handleCategoryCancelDelete}
                        className="px-2 py-1 text-xs border border-[#1A1A1A]/20 hover:bg-[#1A1A1A]/10 transition-colors rounded"
                        title="Cancel"
                      >
                        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </motion.div>
          {overflows && (
            <div className="flex justify-center mt-2">
              <button
                type="button"
                onClick={toggleCollapse}
                className={`text-[11px] ${font} ${tc.muted} hover:${tc.text} transition-colors inline-flex items-center gap-1`}
              >
                <span>{catCollapsed ? `Show all (${totalCategoryCount})` : 'Show less'}</span>
                <span className="text-[9px] leading-none">{catCollapsed ? '▼' : '▲'}</span>
              </button>
            </div>
          )}
        </div>

        {/* Search bar — always visible */}
        <div className={`border-b ${tc.border} px-4 py-3`}>
          <div className="relative">
            <svg className={`absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 ${tc.muted}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
            </svg>
            {/* Mention chip + input container */}
            <div ref={searchContainerRef} className={`flex items-center w-full ${tc.cardBg} border ${tc.border} ${tc.text} pl-10 pr-4 py-2 text-sm ${font} focus-within:outline-none focus-within:ring-1 focus-within:ring-[#1A1A1A]/20 transition-colors ${tc.roundedClass} ${loading ? 'opacity-50' : ''}`}>
              {mentionFilter && (
                <span className="inline-flex items-center gap-1 mr-2 flex-shrink-0 text-[11px]">
                  <span className={`${tc.activePillBg} ${tc.activePillText} px-2 py-0.5 ${tc.roundedClass}`}>
                    @{mentionFilter.displayName}{mentionFilter.isOwner ? ' ★' : ''}
                  </span>
                  <button onClick={() => { setMentionFilter(null); setMentionSearch(''); searchInputRef.current?.focus(); }} className={`${tc.muted} hover:${tc.text} transition-colors ml-0.5`}>
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </span>
              )}
              <input
                ref={searchInputRef}
                type="text"
                value={searchQuery}
                onChange={(e) => {
                  const val = e.target.value;
                  setSearchQuery(val);
                  if (isWorkspace && !loading) {
                    const atIdx = val.lastIndexOf('@');
                    if (atIdx >= 0 && atIdx >= val.length - 1) {
                      setMentionSearch('');
                      setHighlightedIndex(0);
                      openDropdown();
                    } else if (atIdx >= 0) {
                      setMentionSearch(val.slice(atIdx + 1));
                      setHighlightedIndex(0);
                      openDropdown();
                    } else {
                      setMentionDropdownOpen(false);
                      setMentionSearch('');
                    }
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Backspace' && mentionFilter && !searchQuery) {
                    e.preventDefault();
                    setMentionFilter(null);
                    return;
                  }
                  if (!mentionDropdownOpen || filteredMembers.length === 0 || loading) return;
                  if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    setHighlightedIndex(prev => Math.min(prev + 1, filteredMembers.length - 1));
                  } else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    setHighlightedIndex(prev => Math.max(prev - 1, 0));
                  } else if (e.key === 'Enter' && filteredMembers[highlightedIndex]) {
                    e.preventDefault();
                    const member = filteredMembers[highlightedIndex];
                    setMentionFilter(member);
                    setMentionDropdownOpen(false);
                    const atIdx = searchQuery.lastIndexOf('@');
                    setSearchQuery(searchQuery.slice(0, atIdx));
                    setMentionSearch('');
                  } else if (e.key === 'Escape') {
                    setMentionDropdownOpen(false);
                  }
                }}
                placeholder="Search drops..."
                disabled={loading}
                className={`w-full bg-transparent border-none outline-none text-sm ${theme === 'dark' ? 'placeholder:text-white/30' : 'placeholder:text-[#1A1A1A]/30'}`}
              />
            </div>
            {/* Member dropdown (portal) */}
            {mentionDropdownOpen && filteredMembers.length > 0 && !loading && dropdownPos && createPortal(
              <>
              <div
                className={`border shadow-lg z-[100] max-h-48 overflow-y-auto ${tc.cardBg} ${tc.border} ${tc.roundedClass}`}
                style={{ position: 'fixed', top: `${dropdownPos.top}px`, left: `${dropdownPos.left}px`, width: `${dropdownPos.width}px` }}
              >
                {filteredMembers.map((member, idx) => (
                  <button
                    key={member.uid}
                    onClick={() => {
                      setMentionFilter(member);
                      setMentionDropdownOpen(false);
                      const atIdx = searchQuery.lastIndexOf('@');
                      setSearchQuery(searchQuery.slice(0, atIdx));
                      setMentionSearch('');
                      searchInputRef.current?.focus();
                    }}
                    onMouseEnter={() => setHighlightedIndex(idx)}
                    className={`w-full px-3 py-2 text-left flex items-center gap-2 transition-colors ${
                      idx === highlightedIndex ? 'bg-[#1a1a1a]/5' : ''
                    }`}
                  >
                    <div className={`w-6 h-6 flex items-center justify-center flex-shrink-0 rounded-full ${tc.inactivePillBg}`}>
                      <span className="text-[10px] font-medium">{(member.displayName || '?').charAt(0).toUpperCase()}</span>
                    </div>
                    <span className={`${tc.text} text-sm flex-1 truncate`}>{member.displayName}</span>
                    {member.isOwner && (
                      <span className={`text-[10px] ${tc.muted}`}>owner</span>
                    )}
                  </button>
                ))}
              </div>
              <div className="fixed inset-0 z-[99]" onClick={() => setMentionDropdownOpen(false)} />
              </>
              ,
              document.body
            )}
            {!mentionFilter && searchQuery && !loading && (
              <button
                onClick={() => setSearchQuery('')}
                className={`absolute right-3 top-1/2 -translate-y-1/2 ${tc.muted} hover:${tc.text} transition-colors`}
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>
        </div>

        {/* Selection mode controls — hidden during loading */}
        {!loading && (
          <div className={`border-b ${tc.border} px-4 py-2 flex items-center justify-between`}>
            {!selectionMode ? (
              <>
              <button
                onClick={() => setSelectionMode(true)}
                className={`text-xs ${font} ${tc.muted} ${tc.inactivePillHoverBg} px-3 py-1.5 ${tc.roundedClass} border ${tc.border} transition-colors flex items-center gap-1.5`}
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
                  <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                </svg>
                Select
              </button>
              <button
                ref={sortTriggerRef}
                type="button"
                onClick={openSortMenu}
                onKeyDown={(e) => { if (e.key === 'Escape') setSortMenuOpen(false); }}
                aria-haspopup="menu"
                aria-expanded={sortMenuOpen}
                className={`text-xs ${font} ${tc.muted} ${tc.inactivePillHoverBg} px-3 py-1.5 ${tc.roundedClass} border ${tc.border} transition-colors flex items-center gap-1.5`}
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 7.5h18M6 12h12M9 16.5h6" />
                </svg>
                <span>{currentSortLabel}</span>
                <svg className={`w-3 h-3 transition-transform ${sortMenuOpen ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                </svg>
              </button>
              </>
            ) : (
              <div className="flex items-center gap-2 w-full">
                <button
                  onClick={selectAll}
                  className={`text-xs ${font} ${tc.muted} ${tc.inactivePillHoverBg} px-3 py-1.5 ${tc.roundedClass} border ${tc.border} transition-colors`}
                >
                  {selectedIds.size === filteredDrops.length ? 'Deselect' : 'Select all'}
                </button>
                <button
                  onClick={cancelSelection}
                  className={`text-xs ${font} ${tc.muted} ${tc.inactivePillHoverBg} px-3 py-1.5 ${tc.roundedClass} border ${tc.border} transition-colors`}
                >
                  Cancel
                </button>
                {selectedIds.size > 0 && (
                  <>
                    <button
                      onClick={() => {
                        const selectedDrops = drops.filter(d => selectedIds.has(d.id));
                        setBulkMoveDrops(selectedDrops);
                      }}
                      className={`text-xs ${font} px-3 py-1.5 ${tc.roundedClass} ${tc.activePillBg} ${tc.activePillText} hover:opacity-90 transition-opacity ml-auto flex items-center gap-1`}
                    >
                      Move {selectedIds.size}
                    </button>
                    <button
                      onClick={handleBulkDelete}
                      disabled={deleting}
                      className={`text-xs ${font} px-3 py-1.5 ${tc.roundedClass} bg-red-500 text-white hover:bg-red-600 transition-colors disabled:opacity-50 flex items-center gap-1`}
                    >
                      {deleting ? 'Deleting...' : `Delete ${selectedIds.size}`}
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        )}

        {/* Sort dropdown menu (portal — mirrors the @-mention dropdown) */}
        {sortMenuOpen && sortMenuPos && createPortal(
          <>
            <div
              className={`border shadow-lg z-[100] py-1 ${tc.cardBg} ${tc.border} ${tc.roundedClass}`}
              style={{ position: 'fixed', top: `${sortMenuPos.top}px`, left: `${sortMenuPos.left}px`, width: '176px' }}
            >
              {SORT_OPTIONS.map((o) => {
                const active = o.value === sortMode;
                return (
                  <button
                    key={o.value}
                    onClick={() => { handleSortChange(o.value); setSortMenuOpen(false); }}
                    className={`w-full px-3 py-1.5 text-left text-xs ${font} flex items-center justify-between gap-2 transition-colors ${
                      active ? `${tc.activePillBg} ${tc.activePillText}` : `${tc.text} ${tc.inactivePillHoverBg}`
                    }`}
                  >
                    <span>{o.label}</span>
                    {active && (
                      <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                      </svg>
                    )}
                  </button>
                );
              })}
            </div>
            <div className="fixed inset-0 z-[99]" onClick={() => setSortMenuOpen(false)} />
          </>,
          document.body
        )}

        {/* Drop list — skeleton while loading, real content otherwise */}
        <div className="max-h-[500px] overflow-y-auto overflow-x-hidden thin-scrollbar">
          {loading ? (
            <div className="p-3 space-y-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className={`border ${tc.border} ${tc.roundedClass} p-3 flex flex-col sm:flex-row sm:items-center gap-3`}>
                  {/* Icon placeholder */}
                  <div className={`w-10 h-10 ${tc.roundedClass} ${shimmerClass} shrink-0`} />
                  {/* Info section */}
                  <div className="flex-1 min-w-0 space-y-2">
                    <div className={`h-4 ${tc.roundedClass} ${shimmerClass} w-3/5`} />
                    <div className={`h-3 ${tc.roundedClass} ${shimmerClass} w-2/5`} />
                  </div>
                  {/* Action buttons placeholder */}
                  <div className="flex items-center gap-1 pt-2 sm:pt-0 border-t sm:border-t-0 w-full sm:w-auto justify-end">
                    <div className={`w-8 h-7 ${tc.roundedClass} ${shimmerClass}`} />
                    <div className={`w-8 h-7 ${tc.roundedClass} ${shimmerClass}`} />
                    <div className={`w-8 h-7 ${tc.roundedClass} ${shimmerClass}`} />
                  </div>
                </div>
              ))}
            </div>
          ) : visibleDrops.length === 0 && pendingDeletions.size === 0 ? (
            <div className="p-12 text-center">
              <div className={`w-16 h-16 mx-auto border ${tc.border} ${tc.roundedClass} flex items-center justify-center mb-4`}>
                <svg className={`w-7 h-7 ${tc.muted}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1">
                  <path d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4" />
                </svg>
              </div>
              <p className={`text-sm ${font} ${tc.text} font-medium`}>No drops yet</p>
              <p className={`text-xs ${font} ${tc.muted} mt-1`}>Upload files or paste text to get started</p>
            </div>
          ) : filteredDrops.length === 0 ? (
            <div className="p-8 text-center">
              <p className={`text-xs ${font} ${tc.muted}`}>
                {mentionFilter
                  ? `No drops by ${mentionFilter.displayName}`
                  : searchQuery
                  ? 'No drops match your search'
                  : 'No drops in this category'}
              </p>
            </div>
          ) : enableDrag ? (
            <DndContext sensors={dndSensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
              <div className="p-3 space-y-2">
                {/* Pinned drops — not draggable, stay on top */}
                {filteredDrops.filter((d) => d.pinned).map((drop) => (
                  <EditorialDropItem
                    key={drop.id}
                    drop={drop}
                    onDelete={handleDeleteWithUndo}
                    onPreview={onPreview}
                    onEdit={onEdit}
                    selected={selectedIds.has(drop.id)}
                    onSelect={toggleSelect}
                    selectionMode={selectionMode}
                    theme={theme}
                    currentUserId={currentUserId}
                    onPin={handlePinDrop}
                    onUnpin={handlePinDrop}
                  />
                ))}
                {/* Unpinned drops — sortable; drag starts from the grip handle */}
                <SortableContext items={filteredDrops.filter((d) => !d.pinned).map((d) => d.id)} strategy={verticalListSortingStrategy}>
                  {filteredDrops.filter((d) => !d.pinned).map((drop) => (
                    <SortableEditorialDropItem
                      key={drop.id}
                      drop={drop}
                      onDelete={handleDeleteWithUndo}
                      onPreview={onPreview}
                      onEdit={onEdit}
                      selected={selectedIds.has(drop.id)}
                      onSelect={toggleSelect}
                      selectionMode={selectionMode}
                      theme={theme}
                      currentUserId={currentUserId}
                      onPin={handlePinDrop}
                      onUnpin={handlePinDrop}
                    />
                  ))}
                </SortableContext>
              </div>
            </DndContext>
          ) : animateDrops ? (
            <div className="relative p-3 space-y-2">
              <AnimatePresence initial={false} mode="popLayout">
                {filteredDrops.map((drop) => {
                  const moveIdx = manualIndexById.get(drop.id);
                  return (
                    <motion.div
                      key={drop.id}
                      layout
                      initial={{ opacity: 0, scale: 0.97 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.9 }}
                      transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
                    >
                      <EditorialDropItem
                        drop={drop}
                        onDelete={handleDeleteWithUndo}
                        onPreview={onPreview}
                        onEdit={onEdit}
                        selected={selectedIds.has(drop.id)}
                        onSelect={toggleSelect}
                        selectionMode={selectionMode}
                        theme={theme}
                        currentUserId={currentUserId}
                        onPin={handlePinDrop}
                        onUnpin={handlePinDrop}
                        showMoveControls={moveIdx !== undefined}
                        canMoveUp={moveIdx !== undefined && moveIdx > 0}
                        canMoveDown={moveIdx !== undefined && moveIdx < manualCount - 1}
                        onMoveUp={() => moveDropSlot(drop.id, 'up')}
                        onMoveDown={() => moveDropSlot(drop.id, 'down')}
                      />
                    </motion.div>
                  );
                })}
              </AnimatePresence>
            </div>
          ) : (
            <div className="p-3 space-y-2">
              {filteredDrops.map((drop) => {
                const moveIdx = manualIndexById.get(drop.id);
                return (
                  <EditorialDropItem
                    key={drop.id}
                    drop={drop}
                    onDelete={handleDeleteWithUndo}
                    onPreview={onPreview}
                    onEdit={onEdit}
                    selected={selectedIds.has(drop.id)}
                    onSelect={toggleSelect}
                    selectionMode={selectionMode}
                    theme={theme}
                    currentUserId={currentUserId}
                    onPin={handlePinDrop}
                    onUnpin={handlePinDrop}
                    showMoveControls={moveIdx !== undefined}
                    canMoveUp={moveIdx !== undefined && moveIdx > 0}
                    canMoveDown={moveIdx !== undefined && moveIdx < manualCount - 1}
                    onMoveUp={() => moveDropSlot(drop.id, 'up')}
                    onMoveDown={() => moveDropSlot(drop.id, 'down')}
                  />
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Undo toasts */}
      {Array.from(pendingDeletions.values()).map((pending, index) => (
        <UndoToast
          key={pending.drop.id}
          message="Drop deleted"
          dropName={pending.drop.name}
          onUndo={() => handleUndoDeletion(pending.drop.id)}
          onDismiss={() => handleDismissToast(pending.drop.id)}
          duration={30}
          theme={theme}
          index={index}
          editorial
        />
      ))}

      {/* Pin limit toast */}
      {pinLimitToast && (
        <Toast
          message="Max 2 pinned drops per space. Unpin another drop first."
          duration={3}
          theme={theme}
          editorial
          onDone={() => setPinLimitToast(false)}
        />
      )}

      {/* Bulk Move Modal */}
      {bulkMoveDrops && bulkMoveDrops.length > 0 && (
        <EditorialMoveDropModal
          drops={bulkMoveDrops}
          workspaces={workspaces}
          currentWorkspaceId={bulkMoveDrops[0].workspaceId}
          onMove={async (selectedDrops, targetWorkspaceId) => {
            if (!currentUserId) return;
            setMoveLoading(true);
            const results = await Promise.all(selectedDrops.map(d => moveDrop(d, targetWorkspaceId, currentUserId!)));
            setMoveLoading(false);
            const failures = results.filter(r => !r.success);
            if (failures.length === 0) {
              setBulkMoveDrops(null);
              setSelectedIds(new Set());
              setSelectionMode(false);
              onDelete();
            } else {
              alert(`${failures.length}/${selectedDrops.length} drops failed to move: ${failures[0].error}`);
            }
          }}
          onClose={() => setBulkMoveDrops(null)}
          theme={theme}
        />
      )}
    </div>
  );
}
