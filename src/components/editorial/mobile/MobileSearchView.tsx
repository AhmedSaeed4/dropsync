'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Drop, Workspace } from '@/types';
import { isReminderFiredShared, isReminderGlowingForViewer, pinDrop, unpinDrop } from '@/lib/drops';
import { usePendingDeletions, requestDelete, undo, dismiss } from '@/lib/pendingDeletions';
import { getEditorialThemeColors } from '../editorialTheme';
import { dropMatchesSearchQuery } from '@/lib/youtubeLabels';
import { getDropSortPrefs } from '@/lib/auth';
import type { DropSortMode } from '@/lib/auth';
import type { MemberInfo } from '@/lib/workspaces';
import { MobileDropCard } from './MobileDropCard';
import { MobileActionSheet } from './MobileActionSheet';
import { Toast } from '@/components/Toast';
import { UndoToast } from '@/components/UndoToast';
import { AnimatePresence } from 'motion/react';

type Theme = 'light' | 'dark' | 'minimal';

interface MobileSearchViewProps {
  theme: Theme;
  currentUserId: string | null;
  currentWorkspace: Workspace | null;
  drops: Drop[];
  dropsLoading: boolean;
  refreshDrops: () => void;
  workspaceMembers: MemberInfo[];
  hoverable: boolean;
  // Whether the Search tab is the visible one (D16: views stay mounted). Re-syncs the
  // space's read-only sort prefs on every entry so a Drops-side sort change is picked up.
  active: boolean;
  // The layout's onOpenRootDrop — the real preview-trail entry (same prop the Drops view gets).
  onPreview: (drop: Drop) => void;
  onEditDrop: (drop: Drop) => void;
  // Opens the shell's move modal (the ⋯ sheet's Move row).
  onOpenMoveModal: (drops: Drop[]) => void;
  onJoinCall?: (drop: Drop) => void;
  isReopenCallId?: string;
  // R15: report whether the ⋯ sheet is open — the shell drops the navbar while it is true.
  onOverlayOpenChange?: (open: boolean) => void;
}

// Verbatim port of EditorialDropList :88-115 (same copy MobileDropsView carries) — frozen sort semantics; duplicated intentionally, see order §6.
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

// The Search tab's real view (#5/#12): the desktop's shared name/#-matcher and uid-based
// member picker over the prototype's Search face. Results keep the desktop's full tiering
// and the space's sort order; the view is READ-ONLY over the sort prefs — Drops stays the
// only writer, here they are re-synced on every tab entry.
export function MobileSearchView({
  theme,
  currentUserId,
  currentWorkspace,
  drops,
  dropsLoading,
  refreshDrops,
  workspaceMembers,
  hoverable,
  active,
  onPreview,
  onEditDrop,
  onOpenMoveModal,
  onJoinCall,
  isReopenCallId,
  onOverlayOpenChange,
}: MobileSearchViewProps) {
  const tc = getEditorialThemeColors(theme);
  const font = tc.fontClass;
  const loading = dropsLoading;
  const isWorkspace = !!currentWorkspace;

  const [query, setQuery] = useState('');
  const [mentionFilter, setMentionFilter] = useState<MemberInfo | null>(null);
  const [mentionSearch, setMentionSearch] = useState('');
  const [mentionOpen, setMentionOpen] = useState(false);
  const [sheetDrop, setSheetDrop] = useState<Drop | null>(null);

  // R15: the shell drops the navbar while the ⋯ sheet is open.
  useEffect(() => {
    onOverlayOpenChange?.(!!sheetDrop);
  }, [sheetDrop, onOverlayOpenChange]);
  const [pinLimitToast, setPinLimitToast] = useState(false);
  // "Copied" confirmation for the ⋯ sheet's Copy row — same view-owned pattern as
  // MobileDropsView (this view also hosts MobileActionSheet).
  const [copiedToast, setCopiedToast] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // The shared pending-deletions store — tombstoned drops vanish from Search too (and a
  // deletion made HERE is tombstoned out of Drops as well).
  const { pending: pendingDeletions, tombstone: deletedDropIds } = usePendingDeletions();
  const visibleDrops = drops.filter(d => !pendingDeletions.has(d.id) && !deletedDropIds.has(d.id));

  // Desktop EditorialDropList :227-231, verbatim logic. In a personal space no picker ever
  // opens — `@text` is just a name query.
  const filteredMembers = useMemo(() => {
    if (!isWorkspace || !workspaceMembers?.length) return [];
    if (!mentionSearch) return workspaceMembers;
    return workspaceMembers.filter(m => (m.displayName || '').toLowerCase().includes(mentionSearch.toLowerCase()));
  }, [isWorkspace, workspaceMembers, mentionSearch]);

  // Desktop EditorialDropList :234: a workspace switch clears the member chip and the picker —
  // the new space's members are a different set. The query TEXT survives (desktop parity; the
  // owner's flow: search the same term in another space).
  useEffect(() => {
    setMentionFilter(null);
    setMentionSearch('');
    setMentionOpen(false);
  }, [currentWorkspace]);

  // --- Read-only sort prefs (no sort UI in Search: no setDropSortMode/setDropOrder anywhere) ---
  const spaceKey = currentWorkspace?.id ?? 'personal';
  const [sortMode, setSortMode] = useState<DropSortMode>('newest');
  const [manualOrder, setManualOrder] = useState<string[]>([]);

  // R16: scroll memory is per-workspace — the position survives tab switches (D16) but a
  // workspace switch (any direction) always lands at the top of the new space's results.
  const searchScrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    searchScrollRef.current?.scrollTo({ top: 0 });
  }, [spaceKey]);

  // Read-only sync of the space's sort prefs: on tab entry (active), on space change while
  // here, and at mount when Search is the landing tab. Firestore stays the only authority.
  useEffect(() => {
    if (!active || !currentUserId) return;
    let cancelled = false;
    getDropSortPrefs(currentUserId)
      .then((prefs) => {
        if (cancelled) return;
        setSortMode((prefs.mode[spaceKey] as DropSortMode) ?? 'newest');
        setManualOrder(prefs.order[spaceKey] ?? []);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [active, currentUserId, spaceKey]);

  // Input change (desktop :865-883 minus the dropdown-position machinery): a trailing `@`
  // opens the picker with an empty member filter; text after a mid-query `@` narrows it.
  // While the picker is open the raw query still filters names — exactly the desktop.
  const handleQueryChange = (val: string) => {
    setQuery(val);
    if (isWorkspace && !loading) {
      const atIdx = val.lastIndexOf('@');
      if (atIdx >= 0 && atIdx >= val.length - 1) {
        setMentionSearch('');
        setMentionOpen(true);
      } else if (atIdx >= 0) {
        setMentionSearch(val.slice(atIdx + 1));
        setMentionOpen(true);
      } else {
        setMentionOpen(false);
        setMentionSearch('');
      }
    }
  };

  // Pick a member (desktop :924-931): chip on, the `@…` fragment stripped from the query.
  const pickMember = (member: MemberInfo) => {
    setMentionFilter(member);
    setMentionOpen(false);
    setMentionSearch('');
    const atIdx = query.lastIndexOf('@');
    if (atIdx >= 0) setQuery(query.slice(0, atIdx));
    searchInputRef.current?.focus();
  };

  // --- Single-drop delete-with-undo (the shared store above) — Drops :220-222 verbatim ---
  const handleDeleteWithUndo = useCallback((drop: Drop) => requestDelete(drop, refreshDrops), [refreshDrops]);
  const handleUndoDeletion = useCallback((dropId: string) => undo(dropId), []);
  const handleDismissToast = useCallback((dropId: string) => dismiss(dropId, refreshDrops), [refreshDrops]);

  // --- Pin (Drops :281-292 verbatim; calls never count; 2-limit toast) ---
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

  const canMutateFor = (drop: Drop) =>
    !!currentUserId && (currentUserId === drop.userId || (!!currentWorkspace && currentUserId === currentWorkspace.ownerId));

  // --- The tiering memo — Drops :302-323 with the desktop's :594-600 search + mention
  //     filters ahead of the tiers (no category branch: Search has no category strip). ---
  const filteredDrops = useMemo(() => {
    const now = new Date();
    const filtered = visibleDrops.filter(drop => {
      if (query && !dropMatchesSearchQuery(drop, query)) return false;
      if (mentionFilter && drop.userId !== mentionFilter.uid) return false;
      return true;
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
  }, [visibleDrops, query, mentionFilter, sortMode, manualOrder]);

  const now = new Date();
  const shimmerClass = theme === 'dark' ? 'skeleton-shimmer-dark' : theme === 'minimal' ? 'skeleton-shimmer-minimal' : 'skeleton-shimmer-light';

  return (
    <div className="flex h-full flex-col">
      <div ref={searchScrollRef} className="flex-1 min-h-0 space-y-3 overflow-y-auto overscroll-contain px-4 pb-28 editorial-scroll-hide">
        <p className={`text-[10px] font-semibold uppercase tracking-[0.12em] ${font} ${tc.muted}`}>Search</p>

        {/* The search box — the prototype's .search-box (card bg, 18px radius, in-flow magnifier)
            with the desktop's focus-within darkening and loading dim; the mention chip sits
            inside, before the input (desktop :848-913 arrangement). */}
        <div className={`flex items-center gap-[9px] rounded-[18px] border px-3.5 py-[13px] transition-colors ${tc.cardBg} ${tc.border} ${tc.text} ${theme === 'dark' ? 'focus-within:border-white/70' : 'focus-within:border-[#1A1A1A]'} ${loading ? 'opacity-50' : ''}`}>
          <svg className={`h-4 w-4 shrink-0 ${tc.muted}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
          </svg>
          {mentionFilter && (
            <span className="inline-flex shrink-0 items-center gap-1 text-[11px]">
              <span className={`${tc.activePillBg} ${tc.activePillText} rounded-lg px-2 py-0.5`}>
                @{mentionFilter.displayName}{mentionFilter.isOwner ? ' ★' : ''}
              </span>
              <button type="button" onClick={() => setMentionFilter(null)} aria-label="Clear member filter" className={`ml-0.5 ${tc.muted}`}>
                <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </span>
          )}
          <input
            ref={searchInputRef}
            type="text"
            value={query}
            onChange={(e) => handleQueryChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Backspace' && mentionFilter && !query) {
                e.preventDefault();
                setMentionFilter(null);
              }
            }}
            placeholder="Search drops…"
            disabled={loading}
            aria-label="Search drops"
            autoComplete="off"
            className={`w-full min-w-0 flex-1 bg-transparent text-[15px] font-medium tracking-[-0.1px] ${font} ${tc.text} outline-none ${theme === 'dark' ? 'placeholder:text-white/30' : 'placeholder:text-[#1A1A1A]/30'}`}
          />
          {!mentionFilter && query && !loading && (
            <button type="button" onClick={() => { setQuery(''); setMentionOpen(false); setMentionSearch(''); }} aria-label="Clear search" className={`shrink-0 ${tc.muted}`}>
              <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2.2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          )}
        </div>

        {/* The member picker — the desktop's row design, arranged for touch: an in-flow panel
            below the box, tap rows to pick (no fixed portal, no keyboard navigation). The
            fixed tap-catcher behind the panel closes it. */}
        {mentionOpen && filteredMembers.length > 0 && (
          <>
            <div className="fixed inset-0 z-[99]" onClick={() => setMentionOpen(false)} />
            <div className={`relative z-[100] mt-1 max-h-48 overflow-y-auto rounded-lg border shadow-lg ${tc.cardBg} ${tc.border}`}>
              {filteredMembers.map((member) => (
                <button
                  key={member.uid}
                  type="button"
                  onClick={() => pickMember(member)}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left"
                >
                  <div className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${tc.inactivePillBg}`}>
                    <span className="text-[10px] font-medium">{(member.displayName || '?').charAt(0).toUpperCase()}</span>
                  </div>
                  <span className={`flex-1 truncate text-sm ${tc.text}`}>{member.displayName}</span>
                  {member.isOwner && <span className={`text-[10px] ${tc.muted}`}>owner</span>}
                </button>
              ))}
            </div>
          </>
        )}

        {/* Hint line (prototype :652-654, verbatim) */}
        <div className="flex items-center gap-1.5">
          <svg className={`h-3 w-3 shrink-0 ${tc.muted}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2">
            <circle cx="12" cy="12" r="9" /><path strokeLinecap="round" d="M12 11v5M12 7.5v.01" />
          </svg>
          <span className={`text-[11.5px] ${font} ${tc.muted}`}>Type <b>@</b> to filter by member · <b>#</b> for YouTube titles</span>
        </div>

        {/* Count row (prototype :656 + renderSearch :1090-1091; extended to the mention-only
            state — a filtered state deserves the count) */}
        <p className={`px-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] ${font} ${tc.muted}`}>
          {query || mentionFilter ? `Results · ${filteredDrops.length}` : 'Everything'}
        </p>

        {/* Results area: loading shimmer → empty space → nothing-matches → the plain list
            (no animations — the desktop disables them while filtered, :322/:328). */}
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
        ) : !loading && visibleDrops.length === 0 && pendingDeletions.size === 0 && !query && !mentionFilter ? (
          <div className="p-12 text-center">
            <p className={`text-sm font-medium ${font} ${tc.text}`}>No drops yet</p>
            <p className={`mt-1 text-xs ${font} ${tc.muted}`}>Upload files or paste text to get started</p>
          </div>
        ) : !loading && (query || mentionFilter) && filteredDrops.length === 0 ? (
          <div className={`rounded-[18px] border border-dashed px-[18px] py-[30px] text-center ${tc.border}`}>
            <svg className={`mx-auto h-[22px] w-[22px] ${tc.muted}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.6">
              <circle cx="11" cy="11" r="7" /><path strokeLinecap="round" d="m20 20-3.5-3.5M8.5 11h5" />
            </svg>
            <p className={`mt-2 text-sm font-semibold ${font} ${tc.text}`}>Nothing matches</p>
            <p className={`mt-[3px] text-xs ${font} ${tc.muted}`}>
              {mentionFilter ? `No drops by ${mentionFilter.displayName}` : 'Try a name, a YouTube title, or @member.'}
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {filteredDrops.map((drop) => (
              <MobileDropCard
                key={drop.id}
                drop={drop}
                theme={theme}
                currentUserId={currentUserId}
                currentWorkspaceId={currentWorkspace?.id ?? null}
                currentWorkspace={currentWorkspace}
                allDrops={drops}
                selectionMode={false}
                selected={false}
                onSelect={() => {}}
                onPreview={onPreview}
                onOpenSheet={setSheetDrop}
                reminderGlow={isReminderGlowingForViewer(drop, currentUserId, now)}
                onJoinCall={onJoinCall}
                members={workspaceMembers}
                isReopenCallId={isReopenCallId}
                hoverable={hoverable}
              />
            ))}
          </div>
        )}
      </div>

      {/* D6: AnimatePresence keeps the LAST rendered sheet mounted while it slides back down
          (exit on the panel + backdrop inside MobileActionSheet). The snapshot carries the old
          non-null drop, so the component renders normally during the exit. No manualMove —
          the sheet's Move up / Move down rows are never offered in Search. */}
      <AnimatePresence>
        {sheetDrop && (
          <MobileActionSheet
            key="action-sheet"
            drop={sheetDrop}
            onClose={() => setSheetDrop(null)}
            theme={theme}
            currentUserId={currentUserId}
            onPreview={onPreview}
            onEditDrop={onEditDrop}
            canMutate={sheetDrop ? canMutateFor(sheetDrop) : false}
            onMove={(drop) => onOpenMoveModal([drop])}
            onDelete={handleDeleteWithUndo}
            onPin={handlePinDrop}
            onUnpin={handlePinDrop}
            onCopied={() => setCopiedToast(true)}
          />
        )}
      </AnimatePresence>

      {/* Undo toasts (:1303-1317 port) — the shared store; the hidden Drops view's own toasts
          stay hidden with its subtree */}
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
