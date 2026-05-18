'use client';

import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Drop, Workspace, Category } from '@/types';
import { DropItem } from './DropItem';
import { UndoToast } from './UndoToast';
import { Toast } from './Toast';
import { CategoryFilter } from './CategoryFilter';
import { deleteDrop, moveDrop, pinDrop, unpinDrop } from '@/lib/drops';
import { MoveDropModal } from '@/components/MoveDropModal';
import { MemberInfo } from '@/lib/workspaces';

interface DropListProps {
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
  currentWorkspace?: Workspace | null;
  workspaceMembers?: MemberInfo[];
}

interface PendingDeletion {
  drop: Drop;
  timeoutId: NodeJS.Timeout;
}

export function DropList({ drops, loading, onDelete, onPreview, onEdit, workspaces = [], theme = 'light', currentUserId, categories = [], onDeleteCategory, currentWorkspace, workspaceMembers }: DropListProps) {
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
  const isDark = theme === 'dark';
  const isMinimal = theme === 'minimal';

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
    // Set up new pending deletion with 30 second timeout
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

    // Add custom category counts
    categories.forEach(cat => {
      counts[cat.name] = visibleDrops.filter(d => hasCategory(d, cat.name)).length;
    });

    return counts;
  }, [visibleDrops, categories]);

  // Filter drops based on category, search, and mention
  const filteredDrops = useMemo(() => {
    return visibleDrops.filter(drop => {
      // Search filter
      if (searchQuery && !drop.name.toLowerCase().includes(searchQuery.toLowerCase())) {
        return false;
      }

      // Mention filter
      if (mentionFilter && drop.userId !== mentionFilter.uid) {
        return false;
      }

      // Category filter
      if (selectedCategory === 'all') return true;
      if (selectedCategory === 'files') return drop.type === 'file';
      if (selectedCategory === 'uncategorized') return drop.type === 'text' && getCategories(drop).length === 0;
      return hasCategory(drop, selectedCategory);
    });
  }, [visibleDrops, selectedCategory, searchQuery, mentionFilter]);

  // Theme colors
  const getThemeColors = () => {
    if (isMinimal) {
      return {
        bgColor: 'bg-[#D4D8C8]',
        borderColor: 'border-[#1A1A1A]/20',
        textMuted: 'text-[#1A1A1A]/50',
        headerBg: 'bg-[#1A1A1A]/5',
        textColor: 'text-[#1A1A1A]',
        fontClass: 'font-sans tracking-wide text-xs',
        roundedClass: 'rounded-lg',
        inputBg: 'bg-[#C5C9B8]',
        placeholderColor: 'placeholder:text-[#1A1A1A]/30',
      };
    }
    return {
      bgColor: isDark ? 'bg-[#1A1A1A]' : 'bg-[#FAF7F2]',
      borderColor: isDark ? 'border-white/10' : 'border-[#1A1A1A]',
      textMuted: isDark ? 'text-white/50' : 'text-[#1A1A1A]/50',
      headerBg: isDark ? 'bg-[#0D0D0D]' : 'bg-[#1A1A1A]',
      textColor: isDark ? 'text-white' : 'text-[#1A1A1A]',
      fontClass: 'font-mono uppercase tracking-wider text-[10px]',
      roundedClass: '',
      inputBg: isDark ? 'bg-[#0D0D0D]' : 'bg-white',
      placeholderColor: isDark ? 'placeholder:text-white/30' : 'placeholder:text-[#1A1A1A]/30',
    };
  };

  const tc = getThemeColors();

  if (loading) {
    return (
      <div className={`border ${tc.borderColor} ${tc.bgColor} ${tc.roundedClass} p-12 flex flex-col items-center justify-center transition-colors duration-300`}>
        {isMinimal ? (
          <div className="w-8 h-8 border border-[#1A1A1A]/30 border-t-[#1A1A1A] animate-spin rounded-full" />
        ) : (
          <div className={`w-8 h-8 border-2 ${isDark ? 'border-white' : 'border-[#1A1A1A]'} border-t-transparent animate-spin`} />
        )}
        <p className={`${tc.fontClass} ${tc.textMuted} mt-4`}>
          {isMinimal ? 'Loading...' : 'LOADING_DATA...'}
        </p>
      </div>
    );
  }

  if (visibleDrops.length === 0 && pendingDeletions.size === 0) {
    return (
      <div className={`border ${tc.borderColor} ${tc.bgColor} ${tc.roundedClass} p-12 text-center transition-colors duration-300`}>
        <div className={`w-20 h-20 mx-auto border ${tc.borderColor} flex items-center justify-center mb-4 relative ${tc.roundedClass}`}>
          <div className={`absolute inset-2 border ${isMinimal ? 'border-[#1A1A1A]/10' : isDark ? 'border-white/20' : 'border-[#1A1A1A]/20'} ${tc.roundedClass}`} />
          <svg className={`w-8 h-8 ${isMinimal ? 'text-[#1A1A1A]/20' : isDark ? 'text-white/30' : 'text-[#1A1A1A]/30'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1">
            <path d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4" />
          </svg>
        </div>
        <p className={`${isMinimal ? 'text-sm font-medium tracking-wide' : 'text-xs font-semibold uppercase tracking-wider'} ${tc.textColor}`}>
          {isMinimal ? 'No drops yet' : 'NO_DROPS_ACTIVE'}
        </p>
        <p className={`${tc.fontClass} ${tc.textMuted} mt-2`}>
          {isMinimal ? 'Upload files to get started' : 'DROP_FILES_ABOVE_TO_BEGIN'}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-0">
      <div className={`border ${tc.borderColor} ${tc.bgColor} ${tc.roundedClass} transition-colors duration-300 ${isMinimal ? 'rounded-lg' : ''} overflow-hidden`}>
        {/* Category Filter */}
        <CategoryFilter
          categories={categories}
          selectedCategory={selectedCategory}
          onSelectCategory={setSelectedCategory}
          dropCounts={dropCounts}
          onDeleteCategory={onDeleteCategory}
          theme={theme}
        />

        {/* Search Bar */}
        <div className={`border-b ${tc.borderColor} px-4 py-3 ${tc.bgColor} transition-colors duration-300`}>
          <div className="relative">
            <svg className={`absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 ${tc.textMuted}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
            </svg>
            {/* Mention chip + input container */}
            <div ref={searchContainerRef} className={`flex items-center w-full ${tc.inputBg} border ${tc.borderColor} ${tc.textColor} pl-10 pr-4 py-2 text-sm ${tc.placeholderColor} focus-within:outline-none focus-within:ring-1 focus-within:ring-[#1A1A1A] transition-colors duration-300 ${isMinimal ? 'rounded-lg' : ''}`}>
              {mentionFilter && (
                <span className={`inline-flex items-center gap-1 mr-2 flex-shrink-0 ${isMinimal ? 'text-[11px]' : `${tc.fontClass} ${isDark ? 'text-white' : 'text-[#FF5A47]'}`}`}>
                  @{mentionFilter.displayName}{mentionFilter.isOwner ? (isMinimal ? '' : ' ★') : ''}
                  <button onClick={() => { setMentionFilter(null); setMentionSearch(''); searchInputRef.current?.focus(); }} className="ml-0.5 opacity-60 hover:opacity-100 transition-opacity">
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
                  if (isWorkspace) {
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
                  if (!mentionDropdownOpen || filteredMembers.length === 0) return;
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
                placeholder={isMinimal ? 'Search drops...' : 'SEARCH_DROPS...'}
                className={`w-full bg-transparent border-none outline-none text-sm ${tc.textColor} ${tc.placeholderColor} placeholder:font-inherit`}
              />
            </div>
            {mentionDropdownOpen && filteredMembers.length > 0 && dropdownPos && createPortal(
              <>
              <div
                className={`border shadow-lg z-[100] max-h-48 overflow-y-auto ${isMinimal ? 'bg-[#D4D8C8] border-[#1A1A1A]/20 rounded-lg' : isDark ? 'bg-[#1A1A1A] border-white/10' : 'bg-white border-[#1A1A1A]'}`}
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
                      idx === highlightedIndex
                        ? (isMinimal ? 'bg-[#1A1A1A]/10' : isDark ? 'bg-white/10' : 'bg-[#F5F2ED]')
                        : (isMinimal ? 'hover:bg-[#1A1A1A]/5' : isDark ? 'hover:bg-white/5' : 'hover:bg-[#f5f5f5]')
                    }`}
                  >
                    <div className={`w-6 h-6 flex items-center justify-center flex-shrink-0 ${isMinimal ? 'bg-[#1A1A1A]/10 rounded-full' : isDark ? 'bg-white/10' : 'bg-[#1A1A1A]/5'} ${isMinimal ? 'rounded-full' : ''}`}>
                      <span className="text-[10px] font-medium">{(member.displayName || '?').charAt(0).toUpperCase()}</span>
                    </div>
                    <span className={`${tc.textColor} text-sm flex-1 truncate`}>{member.displayName}</span>
                    {member.isOwner && (
                      <span className={`text-[10px] ${tc.textMuted}`}>{isMinimal ? 'owner' : 'OWNER'}</span>
                    )}
                  </button>
                ))}
              </div>
              <div className="fixed inset-0 z-[99]" onClick={() => setMentionDropdownOpen(false)} />
              </>,
              document.body
            )}
            {!mentionFilter && searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className={`absolute right-3 top-1/2 -translate-y-1/2 ${tc.textMuted} hover:${tc.textColor} transition-colors`}
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>
        </div>

        {/* Header with actions */}
        <div className={`border-b ${tc.borderColor} ${tc.headerBg} px-4 py-3 flex items-center justify-between transition-colors duration-300`}>
          <div className="flex items-center gap-3">
            <span className={`${tc.fontClass} ${isMinimal ? 'text-[#1A1A1A]/60' : 'text-white/60'}`}>
              {isMinimal ? 'Active drops' : 'ACTIVE/DROPS'}
            </span>
            <span className={`${tc.fontClass} ${isMinimal ? 'text-[#1A1A1A]/40' : 'text-[#FF5A47]'}`}>
              {isMinimal ? `${filteredDrops.length}/${visibleDrops.length}` : `${filteredDrops.length.toString().padStart(2, '0')}/${visibleDrops.length}`}
            </span>
          </div>

          {/* Action buttons */}
          {!selectionMode ? (
            <button
              onClick={() => setSelectionMode(true)}
              className={`${tc.fontClass} ${isMinimal ? 'text-[#1A1A1A]/50 hover:text-[#1A1A1A]' : 'text-white/60 hover:text-white'} transition-colors flex items-center gap-2`}
            >
              {!isMinimal && <span className="w-3 h-3 border border-white/30" />}
              {isMinimal ? 'Select' : 'SELECT'}
            </button>
          ) : (
            <div className="flex items-center gap-3">
              <button
                onClick={selectAll}
                className={`${tc.fontClass} ${isMinimal ? 'text-[#1A1A1A]/50 hover:text-[#1A1A1A]' : 'text-white/60 hover:text-white'} transition-colors`}
              >
                {selectedIds.size === filteredDrops.length ? (isMinimal ? 'Deselect all' : 'DESELECT_ALL') : (isMinimal ? 'Select all' : 'SELECT_ALL')}
              </button>
              {!isMinimal && <span className="text-white/30">|</span>}
              <button
                onClick={cancelSelection}
                className={`${tc.fontClass} ${isMinimal ? 'text-[#1A1A1A]/50 hover:text-[#1A1A1A]' : 'text-white/60 hover:text-white'} transition-colors`}
              >
                {isMinimal ? 'Cancel' : 'CANCEL'}
              </button>
              {selectedIds.size > 0 && (
                <>
                  <button
                    onClick={() => {
                      const selectedDrops = drops.filter(d => selectedIds.has(d.id));
                      setBulkMoveDrops(selectedDrops);
                    }}
                    className={`${tc.fontClass} ${isMinimal ? 'text-white hover:text-white' : 'text-white hover:text-white'} transition-colors flex items-center gap-2`}
                  >
                    {!isMinimal && <span className="w-2 h-2 bg-white" />}
                    {isMinimal ? `Move ${selectedIds.size}` : `MOVE_${selectedIds.size}`}
                  </button>
                  <button
                    onClick={handleBulkDelete}
                    disabled={deleting}
                    className={`${tc.fontClass} ${isMinimal ? 'text-[#FF5A47] hover:text-[#1A1A1A]' : 'text-[#FF5A47] hover:text-white'} transition-colors disabled:opacity-50 flex items-center gap-2`}
                  >
                    {!isMinimal && <span className="w-2 h-2 bg-[#FF5A47]" />}
                    {deleting ? (isMinimal ? 'Deleting...' : 'DELETING...') : (isMinimal ? `Delete ${selectedIds.size}` : `DELETE_${selectedIds.size}`)}
                  </button>
                </>
              )}
            </div>
          )}
        </div>

        {/* Drop items */}
        <div className={`transition-colors duration-300`}>
          {filteredDrops.length === 0 ? (
            <div className="p-8 text-center">
              <p className={`${tc.fontClass} ${tc.textMuted}`}>
                {mentionFilter
                  ? (isMinimal ? `No drops by ${mentionFilter.displayName}` : `NO_DROPS_BY_${mentionFilter.displayName.toUpperCase()}`)
                  : searchQuery
                  ? (isMinimal ? 'No drops found' : 'NO_MATCHES_FOUND')
                  : (isMinimal ? 'No drops in this category' : 'NO_DROPS_IN_CATEGORY')
                }
              </p>
            </div>
          ) : (
            filteredDrops.map((drop, index) => (
              <div key={drop.id} className={`overflow-hidden ${index > 0 ? `border-t ${tc.borderColor}` : ''}`}>
                <DropItem
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
              </div>
            ))
          )}
        </div>
      </div>

      {/* Undo Toasts - one per pending deletion */}
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
        />
      ))}

      {/* Pin limit toast */}
      {pinLimitToast && (
        <Toast
          message="Max 2 pinned drops per space. Unpin another drop first."
          duration={3}
          theme={theme}
          onDone={() => setPinLimitToast(false)}
        />
      )}

      {/* Bulk Move Modal */}
      {bulkMoveDrops && bulkMoveDrops.length > 0 && (
        <MoveDropModal
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