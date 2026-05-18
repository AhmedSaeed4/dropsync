'use client';

import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Drop, Workspace, Category } from '@/types';
import { EditorialDropItem } from './EditorialDropItem';
import { UndoToast } from '@/components/UndoToast';
import { Toast } from '@/components/Toast';
import { deleteDrop, moveDrop, pinDrop, unpinDrop } from '@/lib/drops';
import { EditorialMoveDropModal } from './EditorialMoveDropModal';
import { getEditorialThemeColors } from './editorialTheme';
import { MemberInfo } from '@/lib/workspaces';

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

  // Filter drops based on category, search, and mention
  const filteredDrops = useMemo(() => {
    return visibleDrops.filter(drop => {
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
  }, [visibleDrops, selectedCategory, searchQuery, mentionFilter]);

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
        {/* Category filter pills — always visible */}
        <div className={`border-b ${tc.border} ${showChat ? 'px-3 py-2' : 'px-4 py-3'}`}>
          <div className={`flex flex-wrap ${showChat ? 'gap-1' : 'gap-2'}`}>
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
          </div>
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
                className="w-full bg-transparent border-none outline-none text-sm placeholder:text-[#1A1A1A]/25"
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
              <button
                onClick={() => setSelectionMode(true)}
                className={`text-xs ${font} ${tc.muted} ${tc.inactivePillHoverBg} px-3 py-1.5 ${tc.roundedClass} border ${tc.border} transition-colors flex items-center gap-1.5`}
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
                  <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                </svg>
                Select
              </button>
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
          ) : (
            <div className="p-3 space-y-2">
              {filteredDrops.map((drop) => (
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
