'use client';

import { useState, useCallback, useMemo } from 'react';
import { Drop } from '@/types';
import { DropItem } from './DropItem';
import { UndoToast } from './UndoToast';
import { CategoryFilter } from './CategoryFilter';
import { deleteDrop } from '@/lib/drops';
import { Category } from '@/types';

interface DropListProps {
  drops: Drop[];
  loading: boolean;
  onDelete: () => void;
  onPreview: (drop: Drop) => void;
  theme?: 'light' | 'dark' | 'minimal';
  currentUserId?: string;
  categories?: Category[];
  onDeleteCategory?: (categoryId: string, categoryName: string) => void;
}

interface PendingDeletion {
  drop: Drop;
  timeoutId: NodeJS.Timeout;
}

export function DropList({ drops, loading, onDelete, onPreview, theme = 'light', currentUserId, categories = [], onDeleteCategory }: DropListProps) {
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);
  const [pendingDeletions, setPendingDeletions] = useState<Map<string, PendingDeletion>>(new Map());
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const isDark = theme === 'dark';
  const isMinimal = theme === 'minimal';

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

  // Calculate drop counts for categories
  const dropCounts = useMemo(() => {
    const counts: { [key: string]: number } = {
      all: visibleDrops.length,
      files: visibleDrops.filter(d => d.type === 'file').length,
      password: visibleDrops.filter(d => d.category === 'password').length,
      link: visibleDrops.filter(d => d.category === 'link').length,
      uncategorized: visibleDrops.filter(d => d.type === 'text' && !d.category).length,
    };

    // Add custom category counts
    categories.forEach(cat => {
      counts[cat.name] = visibleDrops.filter(d => d.category === cat.name).length;
    });

    return counts;
  }, [visibleDrops, categories]);

  // Filter drops based on category and search
  const filteredDrops = useMemo(() => {
    return visibleDrops.filter(drop => {
      // Search filter
      if (searchQuery && !drop.name.toLowerCase().includes(searchQuery.toLowerCase())) {
        return false;
      }

      // Category filter
      if (selectedCategory === 'all') return true;
      if (selectedCategory === 'files') return drop.type === 'file';
      if (selectedCategory === 'uncategorized') return drop.type === 'text' && !drop.category;
      return drop.category === selectedCategory;
    });
  }, [visibleDrops, selectedCategory, searchQuery]);

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
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={isMinimal ? 'Search drops...' : 'SEARCH_DROPS...'}
              className={`w-full ${tc.inputBg} border ${tc.borderColor} ${tc.textColor} pl-10 pr-4 py-2 text-sm ${tc.placeholderColor} focus:outline-none focus:ring-1 focus:ring-[#1A1A1A] transition-colors duration-300 ${isMinimal ? 'rounded-lg' : ''}`}
            />
            {searchQuery && (
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
                <button
                  onClick={handleBulkDelete}
                  disabled={deleting}
                  className={`${tc.fontClass} ${isMinimal ? 'text-[#FF5A47] hover:text-[#1A1A1A]' : 'text-[#FF5A47] hover:text-white'} transition-colors disabled:opacity-50 flex items-center gap-2`}
                >
                  {!isMinimal && <span className="w-2 h-2 bg-[#FF5A47]" />}
                  {deleting ? (isMinimal ? 'Deleting...' : 'DELETING...') : (isMinimal ? `Delete ${selectedIds.size}` : `DELETE_${selectedIds.size}`)}
                </button>
              )}
            </div>
          )}
        </div>

        {/* Drop items */}
        <div className={`transition-colors duration-300`}>
          {filteredDrops.length === 0 ? (
            <div className="p-8 text-center">
              <p className={`${tc.fontClass} ${tc.textMuted}`}>
                {searchQuery
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
                  selected={selectedIds.has(drop.id)}
                  onSelect={toggleSelect}
                  selectionMode={selectionMode}
                  theme={theme}
                  currentUserId={currentUserId}
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
    </div>
  );
}