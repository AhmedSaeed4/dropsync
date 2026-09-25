'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Drop, Category, Workspace } from '@/types';
import { deleteDrop, pinDrop, unpinDrop, isReminderFiredShared, isReminderGlowingForViewer } from '@/lib/drops';
import { usePendingDeletions, requestDelete, undo, dismiss } from '@/lib/pendingDeletions';
import { getEditorialThemeColors } from '../editorialTheme';
import { EditorialStatusPanel } from '../EditorialStatusPanel';
import { UndoToast } from '@/components/UndoToast';
import { Toast } from '@/components/Toast';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { getDropSortPrefs, setDropSortMode, setDropOrder } from '@/lib/auth';
import type { DropSortMode } from '@/lib/auth';
import type { MemberInfo } from '@/lib/workspaces';
import { MobileDropCard } from './MobileDropCard';
import { MobileCategoryStrip } from './MobileCategoryStrip';
import { MobileSortMenu } from './MobileSortMenu';
import { MobileBulkBar } from './MobileBulkBar';
import { MobileActionSheet } from './MobileActionSheet';

type Theme = 'light' | 'dark' | 'minimal';

interface MobileDropsViewProps {
  theme: Theme;
  currentUserId: string | null;
  currentWorkspace: Workspace | null;
  currentWorkspaceId: string | null;
  drops: Drop[];
  dropsLoading: boolean;
  refreshDrops: () => void;
  categories: Category[];
  onDeleteCategory: (categoryId: string, categoryName: string) => void;
  workspaceMembers: MemberInfo[];
  encryptionInitializing: boolean;
  wordAnimEnabled: boolean;
  wordAnimStyle: string;
  wordAnimHold: number;
  youtubeBackfillVisible: boolean;
  onOpenYoutubeBackfill: () => void;
  onExportWorkspace?: () => void;
  onExportPersonal?: () => void;
  onSortModeChange?: (mode: DropSortMode, spaceKey: string) => void;
  onJoinCall?: (drop: Drop) => void;
  isReopenCallId?: string;
  hoverable: boolean;
  // Preview entry — the layout's handleOpenRootDrop (the real preview trail entry point).
  onPreview: (drop: Drop) => void;
  onEditDrop: (drop: Drop) => void;
  // Opens the shell's move modal (single drop from the sheet, or the bulk selection).
  onOpenMoveModal: (drops: Drop[]) => void;
  // Selection-mode mirror for the shell: slides the navbar away while selecting (OWNER REQUEST #2).
  onSelectionModeChange?: (v: boolean) => void;
  // R15: report whether any Drops overlay is open (⋯ sheet or sort menu) — the shell drops
  // the navbar while it is true.
  onOverlayOpenChange?: (open: boolean) => void;
  // OWNER REQUEST #3: bumped by the shell whenever a header control (chat/settings/theme)
  // fires — those live above this view. Any non-zero bump cancels an open selection.
  deselectSignal?: number;
}

// Sort the UNPINNED drops for a mode (verbatim port of EditorialDropList :88-115). Pinned drops
// are always kept on top (newest-first) and sorted separately; in Manual mode brand-new drops
// land on top until the user rearranges.
function sortUnpinned(drops: Drop[], mode: DropSortMode, manualOrder: string[]): Drop[] {
  if (mode === 'manual') {
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
      case 'size': {
        const sizeOf = (d: Drop) => (d.type === 'file' ? d.fileSize ?? -1 : d.type === 'text' ? d.content?.length ?? -1 : -1);
        return sizeOf(b) - sizeOf(a); // largest first; neither → last
      }
      case 'expiry':
        return (a.expiresAt ? a.expiresAt.getTime() : Number.MAX_SAFE_INTEGER)
          - (b.expiresAt ? b.expiresAt.getTime() : Number.MAX_SAFE_INTEGER); // soonest first
      default:
        return 0;
    }
  });
}

// The Drops tab's state owner: ports EditorialDropList's list logic (selection + two-tap bulk
// delete, per-space sort + manual order, tiering memo, pin limit, pendingDeletions) into the
// mobile arrangement (#11/#12/#23). No search bar, no mention filter (#12 — Search order).
export function MobileDropsView({
  theme,
  currentUserId,
  currentWorkspace,
  drops,
  dropsLoading: loading,
  refreshDrops,
  categories,
  onDeleteCategory,
  workspaceMembers,
  encryptionInitializing,
  wordAnimEnabled,
  wordAnimStyle,
  wordAnimHold,
  youtubeBackfillVisible,
  onOpenYoutubeBackfill,
  onExportWorkspace,
  onExportPersonal,
  onSortModeChange,
  onJoinCall,
  isReopenCallId,
  hoverable,
  onPreview,
  onEditDrop,
  onOpenMoveModal,
  onSelectionModeChange,
  onOverlayOpenChange,
  deselectSignal,
}: MobileDropsViewProps) {
  const tc = getEditorialThemeColors(theme);
  const font = tc.fontClass;

  // --- Selection + two-tap bulk delete (ported :184-303) ---
  const [selectionMode, setSelectionMode] = useState(false);
  // Every selection-mode change flows through here so the shell's navbar mirror stays in sync.
  const applySelectionMode = useCallback((v: boolean) => {
    setSelectionMode(v);
    onSelectionModeChange?.(v);
  }, [onSelectionModeChange]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);
  const [holdDone, setHoldDone] = useState(false);

  const toggleSelect = useCallback((id: string) => {
    if (drops.find((drop) => drop.id === id)?.isStaged) return;
    const next = new Set(selectedIds);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    setSelectedIds(next);
  }, [selectedIds, drops]);

  // --- Single-drop delete-with-undo (shared store) + tombstone visibility filter ---
  const { pending: pendingDeletions, tombstone: deletedDropIds } = usePendingDeletions();
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [pinLimitToast, setPinLimitToast] = useState(false);
  const [sheetDrop, setSheetDrop] = useState<Drop | null>(null);
  const liveSheetDrop = sheetDrop ? drops.find((drop) => drop.id === sheetDrop.id) || null : null;
  // "Copied" confirmation for the ⋯ sheet's Copy row — the sheet unmounts as it closes, so
  // the VIEW owns this toast (it must outlive the sheet's slide-down).
  const [copiedToast, setCopiedToast] = useState(false);
  const [sortMenuOpen, setSortMenuOpen] = useState(false);

  // R15: the shell drops the navbar while any Drops overlay is open (the ⋯ sheet or the
  // sort menu) — the same signal pattern as the selection-mode report above.
  useEffect(() => {
    onOverlayOpenChange?.(!!sheetDrop || sortMenuOpen);
  }, [sheetDrop, sortMenuOpen, onOverlayOpenChange]);

  const visibleDrops = drops.filter(d => !pendingDeletions.has(d.id) && !deletedDropIds.has(d.id));

  useEffect(() => { setSelectedCategory('all'); }, [categories]);
  // Switching workspaces resets selection + category filter (§5); sort/strip prefs re-apply
  // from the Firestore maps below.
  useEffect(() => {
    setSelectedIds(new Set());
    applySelectionMode(false);
    setSheetDrop(null);
  }, [currentWorkspace, applySelectionMode]);

  // D11: the desktop resets selection when a bulk move succeeds with zero failures
  // (EditorialDropList :1356-1360), but the mobile move modal lives in the shell with no
  // path into this view — so the view self-heals: any selected id whose drop no longer
  // exists in `drops` is pruned (a successful move removes exactly those drops; a deletion
  // from another session is covered too). Manual deselects never land here — those drops
  // still exist — so emptying the selection by tapping keeps selection mode ON (prototype
  // semantics: the bar stays with count 0).
  useEffect(() => {
    if (selectedIds.size === 0) return;
    const existing = new Set(drops.filter((d) => !d.isStaged).map((d) => d.id));
    const next = new Set([...selectedIds].filter((id) => existing.has(id)));
    if (next.size === selectedIds.size) return;
    setSelectedIds(next);
    // The selection was emptied underneath it — exit exactly like Cancel: the pill slides
    // down (AnimatePresence exit) and the navbar returns (the shell mirror).
    if (selectionMode && next.size === 0) {
      applySelectionMode(false);
    }
  }, [drops, selectedIds, selectionMode, applySelectionMode]);

  const cancelSelection = () => {
    setSelectedIds(new Set());
    applySelectionMode(false);
  };

  // OWNER REQUEST #3: a header control fired (chat / settings / theme) — cancel the
  // selection exactly like its Cancel button. The bump itself is the signal (value
  // irrelevant); all clears are idempotent, so a bump with nothing selected is a no-op.
  useEffect(() => {
    if (!deselectSignal) return;
    setSelectedIds(new Set());
    applySelectionMode(false);
  }, [deselectSignal, applySelectionMode]);

  const handleDeleteWithUndo = useCallback((drop: Drop) => requestDelete(drop, refreshDrops), [refreshDrops]);
  const handleUndoDeletion = useCallback((dropId: string) => undo(dropId), []);
  const handleDismissToast = useCallback((dropId: string) => dismiss(dropId, refreshDrops), [refreshDrops]);

  // --- Category helpers (shared with the strip) ---
  const hasCategory = (drop: Drop, cat: string) =>
    (drop.categories && drop.categories.includes(cat)) || drop.category === cat;
  const getCategories = (drop: Drop) =>
    drop.categories && drop.categories.length > 0 ? drop.categories : (drop.category ? [drop.category] : []);

  // --- Per-space sort + manual order (ported :486-528) ---
  const spaceKey = currentWorkspace?.id ?? 'personal';
  const spaceKeyRef = useRef(spaceKey);
  spaceKeyRef.current = spaceKey;

  // R16: scroll memory is per-workspace — the position survives tab switches (D16) but a
  // workspace switch (any direction) always lands at the top of the new space's list.
  const dropsScrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    dropsScrollRef.current?.scrollTo({ top: 0 });
  }, [spaceKey]);

  const [sortMode, setSortMode] = useState<DropSortMode>('newest');
  const [manualOrder, setManualOrder] = useState<string[]>([]);
  const sortPrefsRef = useRef<{ mode: Record<string, string>; order: Record<string, string[]> }>({ mode: {}, order: {} });
  const sortPrefsLoadedRef = useRef(false);

  useEffect(() => {
    sortPrefsLoadedRef.current = false;
    if (!currentUserId) {
      onSortModeChange?.('newest', spaceKeyRef.current);
      return;
    }
    let cancelled = false;
    getDropSortPrefs(currentUserId)
      .then((prefs) => {
        if (cancelled) return;
        sortPrefsRef.current = prefs;
        sortPrefsLoadedRef.current = true;
        const nextMode = (sortPrefsRef.current.mode[spaceKeyRef.current] as DropSortMode) ?? 'newest';
        setSortMode(nextMode);
        setManualOrder(sortPrefsRef.current.order[spaceKeyRef.current] ?? []);
        onSortModeChange?.(nextMode, spaceKeyRef.current);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [currentUserId, onSortModeChange]);

  useEffect(() => {
    const nextMode = (sortPrefsRef.current.mode[spaceKey] as DropSortMode) ?? 'newest';
    if (sortPrefsLoadedRef.current) onSortModeChange?.(nextMode, spaceKey);
    setSortMode(nextMode);
    setManualOrder(sortPrefsRef.current.order[spaceKey] ?? []);
  }, [spaceKey, onSortModeChange]);

  const handleSortChange = useCallback((mode: DropSortMode) => {
    onSortModeChange?.(mode, spaceKey);
    setSortMode(mode);
    sortPrefsRef.current.mode = { ...sortPrefsRef.current.mode, [spaceKey]: mode };
    if (currentUserId) setDropSortMode(currentUserId, spaceKey, mode); // background write
  }, [spaceKey, currentUserId, onSortModeChange]);

  const commitManualOrder = useCallback((ids: string[]) => {
    sortPrefsRef.current.order = { ...sortPrefsRef.current.order, [spaceKey]: ids };
    setManualOrder(ids);
    if (currentUserId) setDropOrder(currentUserId, spaceKey, ids);
  }, [spaceKey, currentUserId]);

  // --- Pin (ported :334-346; calls never count; 2-limit toast) ---
  const handlePinDrop = useCallback(async (drop: Drop) => {
    if (drop.pinned) {
      await unpinDrop(drop.id);
    } else {
      const pinnedCount = visibleDrops.filter(d => d.pinned && d.type !== 'call').length;
      if (pinnedCount >= 2) {
        setPinLimitToast(true);
        return;
      }
      await pinDrop(drop.id);
    }
  }, [visibleDrops]);

  // --- Tiering memo (ported :592-623, minus search/mention which are #12/out-of-scope) ---
  const isFiltered = selectedCategory !== 'all';
  // D14: the desktop animates the list — reorder swaps, new-drop entrance, delete exit —
  // unless the user prefers reduced motion or a category filter is active
  // (EditorialDropList :322, :328). Same gate here.
  const prefersReducedMotion = useReducedMotion();
  const animateDrops = !prefersReducedMotion && !isFiltered;

  const filteredDrops = useMemo(() => {
    const now = new Date();
    const filtered = visibleDrops.filter(drop => {
      if (selectedCategory === 'all') return true;
      if (selectedCategory === 'files') return drop.type === 'file';
      if (selectedCategory === 'uncategorized') return drop.type === 'text' && getCategories(drop).length === 0;
      return hasCategory(drop, selectedCategory);
    });
    const live = filtered.filter((d) => d.type === 'call');
    const fired = filtered
      .filter((d) => isReminderFiredShared(d, now) && d.type !== 'call')
      .sort((a, b) => a.reminderAt!.getTime() - b.reminderAt!.getTime());
    const pinned = filtered
      .filter((d) => d.pinned && !isReminderFiredShared(d, now) && d.type !== 'call')
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const unpinned = sortUnpinned(
      filtered.filter((d) => !d.pinned && !isReminderFiredShared(d, now) && d.type !== 'call'),
      sortMode,
      manualOrder
    );
    return [...live, ...fired, ...pinned, ...unpinned];
  }, [visibleDrops, selectedCategory, sortMode, manualOrder]);

  const now = new Date();

  // Manual reorder: only Manual mode, unfiltered, not selecting (desktop :630 semantics).
  const showMoveControls = sortMode === 'manual' && !isFiltered && !selectionMode;
  const manualIndexById = useMemo(() => {
    const m = new Map<string, number>();
    if (showMoveControls) {
      let i = 0;
      for (const d of filteredDrops) {
        if (!d.pinned && d.type !== 'call') m.set(d.id, i++);
      }
    }
    return m;
  }, [showMoveControls, filteredDrops]);
  const manualCount = manualIndexById.size;
  // Live-call tiles are never selectable (#21), so the bulk-bar's all-selected label must
  // compare against the selectable count, not the whole list.
  const selectableCount = filteredDrops.filter(d => d.type !== 'call').length;

  // Subline count (D5): drops whose expiry lapses within the NEXT 24h — the prototype's
  // "expiring soon" (prototype updater :1022; the record locks the 24h window on real data).
  // Already-expired and Forever drops don't count. Sourced from `drops` to match the reused
  // panel's dropsCount semantics.
  const expiringSoonCount = useMemo(
    () =>
      drops.filter((d) => {
        if (!d.expiresAt) return false;
        const ms = d.expiresAt.getTime() - Date.now();
        return ms > 0 && ms <= 24 * 60 * 60 * 1000;
      }).length,
    [drops]
  );

  // The currently-displayed unpinned id order in Manual mode (desktop :555-558): unknown ids
  // first (newest-first), then the saved order.
  const currentManualIds = useCallback(
    (): string[] => {
      const orderSet = new Set(manualOrder);
      const unknown = visibleDrops
        .filter((d) => !d.pinned && !orderSet.has(d.id))
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .map((d) => d.id);
      const known = manualOrder.filter((id) =>
        visibleDrops.some((d) => d.id === id && !d.pinned)
      );
      return [...unknown, ...known];
    },
    [visibleDrops, manualOrder]
  );

  const moveDropSlot = useCallback((dropId: string, direction: 'up' | 'down') => {
    const ids = currentManualIds();
    const i = ids.indexOf(dropId);
    if (i < 0) return;
    const j = direction === 'up' ? i - 1 : i + 1;
    if (j < 0 || j >= ids.length) return;
    const next = [...ids];
    const [moved] = next.splice(i, 1);
    next.splice(j, 0, moved);
    commitManualOrder(next);
  }, [currentManualIds, commitManualOrder]);

  const moveUp = useCallback((id: string) => moveDropSlot(id, 'up'), [moveDropSlot]);
  const moveDown = useCallback((id: string) => moveDropSlot(id, 'down'), [moveDropSlot]);

  // --- Bulk delete — immediate, NO undo. Fired by MobileBulkBar's hold button (D10):
  // "Deleting..." runs while the deletes land, then the green "Deleted ✓" beat, then
  // the bar closes. ---
  const handleBulkDelete = async () => {
    if (selectedIds.size === 0) return;
    setDeleting(true);
    const selectedDrops = filteredDrops.filter(d => selectedIds.has(d.id) && !d.isStaged);
    if (selectedDrops.length !== selectedIds.size) { setDeleting(false); return; }
    await Promise.all(selectedDrops.map(drop => deleteDrop(drop)));
    setDeleting(false);
    setHoldDone(true);
    window.setTimeout(() => {
      setSelectedIds(new Set());
      applySelectionMode(false);
      refreshDrops();
      setHoldDone(false);
    }, 650);
  };

  const selectAll = () => {
    if (selectedIds.size === filteredDrops.length) {
      setSelectedIds(new Set());
    } else {
      // Live-call tiles are never selectable (#21).
      setSelectedIds(new Set(filteredDrops.filter(d => d.type !== 'call' && !d.isStaged).map(d => d.id)));
    }
  };

  const canMutateFor = (drop: Drop) =>
    !!currentUserId && (currentUserId === drop.userId || (!!currentWorkspace && currentUserId === currentWorkspace.ownerId));

  const currentSortLabel = SORT_LABELS[sortMode] ?? 'Newest';
  const shimmerClass = theme === 'dark' ? 'skeleton-shimmer-dark' : theme === 'minimal' ? 'skeleton-shimmer-minimal' : 'skeleton-shimmer-light';

  // The sheeted drop's manual-move bundle (D1 fix): only in Manual mode, unfiltered, not
  // selecting, and only for drops that sit in the manual unpinned order.
  const sheetManualMove = sheetDrop && showMoveControls
    ? (() => {
        const idx = manualIndexById.get(sheetDrop.id);
        return idx === undefined ? undefined : {
          canUp: idx > 0,
          canDown: idx < manualCount - 1,
          onUp: () => moveUp(sheetDrop.id),
          onDown: () => moveDown(sheetDrop.id),
        };
      })()
    : undefined;

  return (
    <div className="flex h-full flex-col">
      <div ref={dropsScrollRef} className="flex-1 min-h-0 space-y-3 overflow-y-auto overscroll-contain px-4 pb-28 editorial-scroll-hide">
        {/* Title block (#11, D5): the real status panel renders only the animated word (count
            moved into the subline), then the prototype's stacked title + whisper subline
            (prototype :442-446; .h1 = 26px/600/−0.5px/1.15) before the control row. */}
        <EditorialStatusPanel
          dropsCount={drops.length}
          encryptionInitializing={encryptionInitializing}
          theme={theme}
          showChat={false}
          showCount={false}
          animEnabled={wordAnimEnabled}
          animStyle={wordAnimStyle}
          animHold={wordAnimHold}
        />
        <div>
          <h1 className={`text-[26px] font-semibold leading-[1.15] tracking-[-0.5px] ${font} ${tc.text}`}>Your drops</h1>
          <p className={`mt-[3px] text-xs ${font} ${tc.muted}`}>
            {drops.length} drops · {expiringSoonCount} expiring soon
          </p>
        </div>

        {/* YouTube backfill entry (#10) — same visibility rule, opens the real modal */}
        {youtubeBackfillVisible && (
          <div className={`rounded-[14px] border p-4 ${tc.cardBg} ${tc.border}`}>
            <p className={`text-xs ${font} ${tc.muted}`}>Saved video labels</p>
            <button
              type="button"
              onClick={() => {
                if (selectionMode) cancelSelection();
                onOpenYoutubeBackfill();
              }}
              className={`mt-3 w-full rounded-full px-4 py-2.5 text-sm font-medium ${font} ${tc.activePillBg} ${tc.activePillText} transition-opacity hover:opacity-90`}
            >
              Find titles
            </button>
          </div>
        )}

        {/* Control row: Select · Export · Sort trigger (ports :965-1017); stays during selection
            (D10) with the Select chip ink-active + toggling off (prototype toggleSelect). */}
        {!loading && (
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  if (selectionMode) {
                    cancelSelection();
                    return;
                  }
                  applySelectionMode(true);
                }}
                aria-pressed={selectionMode}
                className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs ${font} transition-colors ${
                  selectionMode
                    ? `${tc.activePillBg} ${tc.activePillText} border-transparent`
                    : `${tc.muted} ${tc.border} ${tc.inactivePillHoverBg}`
                }`}
              >
                <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
                  <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                </svg>
                Select
              </button>
              {(onExportWorkspace || onExportPersonal) && visibleDrops.length > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    if (selectionMode) cancelSelection();
                    (onExportPersonal || onExportWorkspace)?.();
                  }}
                  className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs ${font} ${tc.muted} ${tc.border} ${tc.inactivePillHoverBg} transition-colors`}
                >
                  <svg className="h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                    <path d="M12 3v12m0 0l-4-4m4 4l4-4M5 21h14" />
                  </svg>
                  Export
                </button>
              )}
            </div>
            <button
              type="button"
              onClick={() => {
                if (selectionMode) cancelSelection();
                setSortMenuOpen(true);
              }}
              aria-haspopup="menu"
              aria-expanded={sortMenuOpen}
              className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs ${font} ${tc.muted} ${tc.border} ${tc.inactivePillHoverBg} transition-colors`}
            >
              <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 7.5h18M6 12h12M9 16.5h6" />
              </svg>
              <span>{currentSortLabel}</span>
            </button>
          </div>
        )}

        {/* Category strip (#25) */}
        <MobileCategoryStrip
          drops={visibleDrops}
          categories={categories}
          loading={loading}
          selectedCategory={selectedCategory}
          onSelectCategory={setSelectedCategory}
          theme={theme}
          currentUserId={currentUserId}
          spaceKey={spaceKey}
          onDeleteCategory={onDeleteCategory}
        />

        {/* The flat card list (#23) — the phone page scrolls; no max-height clamp */}
        {loading ? (
          <div className="space-y-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className={`rounded-[14px] border p-3 ${tc.border}`}>
                <div className={`h-32 w-full rounded-[10px] ${shimmerClass}`} />
                <div className={`mt-3 h-4 w-3/5 ${shimmerClass} rounded-full`} />
                <div className={`mt-2 h-3 w-2/5 ${shimmerClass} rounded-full`} />
              </div>
            ))}
          </div>
        ) : visibleDrops.length === 0 && pendingDeletions.size === 0 ? (
          <div className="p-12 text-center">
            <p className={`text-sm font-medium ${font} ${tc.text}`}>No drops yet</p>
            <p className={`mt-1 text-xs ${font} ${tc.muted}`}>Upload files or paste text to get started</p>
          </div>
        ) : filteredDrops.length === 0 ? (
          <div className="p-8 text-center">
            <p className={`text-xs ${font} ${tc.muted}`}>No drops in this category</p>
          </div>
        ) : animateDrops ? (
          <div className="space-y-2">
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
                    <MobileDropCard
                      key={drop.id}
                      drop={drop}
                      theme={theme}
                      currentUserId={currentUserId}
                      currentWorkspaceId={currentWorkspace?.id ?? null}
                      currentWorkspace={currentWorkspace}
                      allDrops={drops}
                      selectionMode={selectionMode}
                      selected={selectedIds.has(drop.id)}
                      onSelect={toggleSelect}
                      onPreview={onPreview}
                      onOpenSheet={setSheetDrop}
                      reminderGlow={isReminderGlowingForViewer(drop, currentUserId, now)}
                      onJoinCall={onJoinCall}
                      members={workspaceMembers}
                      isReopenCallId={isReopenCallId}
                      hoverable={hoverable}
                      manualMove={showMoveControls && moveIdx !== undefined ? {
                        canUp: moveIdx > 0,
                        canDown: moveIdx < manualCount - 1,
                        onUp: () => moveUp(drop.id),
                        onDown: () => moveDown(drop.id),
                      } : undefined}
                      manualPosition={showMoveControls && moveIdx !== undefined ? moveIdx : undefined}
                    />
                  </motion.div>
                );
              })}
            </AnimatePresence>
          </div>
        ) : (
          <div className="space-y-2">
            {filteredDrops.map((drop) => {
              const moveIdx = manualIndexById.get(drop.id);
              return (
                <MobileDropCard
                  key={drop.id}
                  drop={drop}
                  theme={theme}
                  currentUserId={currentUserId}
                  currentWorkspaceId={currentWorkspace?.id ?? null}
                  currentWorkspace={currentWorkspace}
                  allDrops={drops}
                  selectionMode={selectionMode}
                  selected={selectedIds.has(drop.id)}
                  onSelect={toggleSelect}
                  onPreview={onPreview}
                  onOpenSheet={setSheetDrop}
                  reminderGlow={isReminderGlowingForViewer(drop, currentUserId, now)}
                  onJoinCall={onJoinCall}
                  members={workspaceMembers}
                  isReopenCallId={isReopenCallId}
                  hoverable={hoverable}
                  manualMove={showMoveControls && moveIdx !== undefined ? {
                    canUp: moveIdx > 0,
                    canDown: moveIdx < manualCount - 1,
                    onUp: () => moveUp(drop.id),
                    onDown: () => moveDown(drop.id),
                  } : undefined}
                  manualPosition={showMoveControls && moveIdx !== undefined ? moveIdx : undefined}
                />
              );
            })}
          </div>
        )}
      </div>

      {/* Selection pill replaces the navbar while selecting (#4/#21, OWNER REQUEST #2);
          AnimatePresence plays the slide-down on exit */}
      <AnimatePresence>
        {selectionMode && (
          <MobileBulkBar
            key="bulk-bar"
            theme={theme}
            selectedCount={selectedIds.size}
            allSelected={selectableCount > 0 && selectedIds.size === selectableCount}
            onSelectAllToggle={selectAll}
            onCancel={cancelSelection}
            onMove={() => {
              const selectedDrops = drops.filter(d => selectedIds.has(d.id));
              if (selectedDrops.length > 0) onOpenMoveModal(selectedDrops);
            }}
            deleting={deleting}
            done={holdDone}
            onHoldComplete={handleBulkDelete}
          />
        )}
      </AnimatePresence>

      <MobileSortMenu
        open={sortMenuOpen}
        onClose={() => setSortMenuOpen(false)}
        sortMode={sortMode}
        onSortChange={handleSortChange}
        theme={theme}
      />

      {/* D6: AnimatePresence keeps the LAST rendered sheet mounted while it slides back down
          (exit on the panel + backdrop inside MobileActionSheet). The snapshot carries the old
          non-null drop, so the component renders normally during the exit. */}
      <AnimatePresence>
        {liveSheetDrop && (
          <MobileActionSheet
            key="action-sheet"
            drop={liveSheetDrop}
        onClose={() => setSheetDrop(null)}
        theme={theme}
        currentUserId={currentUserId}
        onPreview={onPreview}
        onEditDrop={onEditDrop}
        canMutate={!liveSheetDrop.isStaged && canMutateFor(liveSheetDrop)}
        onMove={(drop) => onOpenMoveModal([drop])}
        onDelete={handleDeleteWithUndo}
        onPin={handlePinDrop}
        onUnpin={handlePinDrop}
        manualMove={sheetManualMove}
        onCopied={() => setCopiedToast(true)}
          />
        )}
      </AnimatePresence>

      {/* Undo toasts (:1303-1317 port) */}
      {Array.from(pendingDeletions.values()).map((pending, index) => (
        <UndoToast
          key={pending.drop.id}
          message="Drop deleted"
          dropName={pending.drop.name}
          onUndo={() => handleUndoDeletion(pending.drop.id)}
          onDismiss={() => handleDismissToast(pending.drop.id)}
          duration={30}
          expiresAt={pending.expiresAt}
          theme={theme}
          index={index}
          editorial
        />
      ))}

      {pinLimitToast && (
        <Toast
          message="Max 2 pinned drops per space. Unpin another drop first."
          duration={3}
          theme={theme}
          editorial
          onDone={() => setPinLimitToast(false)}
        />
      )}

      {copiedToast && (
        <Toast
          message="Copied"
          duration={2}
          theme={theme}
          editorial
          mobileFloat
          onDone={() => setCopiedToast(false)}
        />
      )}
    </div>
  );
}

const SORT_LABELS: Record<string, string> = {
  newest: 'Newest',
  manual: 'Manual',
  name: 'Name (A–Z)',
  size: 'Size',
  expiry: 'Expiry',
};
