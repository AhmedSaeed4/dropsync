'use client';

import { useState } from 'react';
import { Drop } from '@/types';
import { DropItem } from './DropItem';
import { deleteDrop } from '@/lib/drops';

interface DropListProps {
  drops: Drop[];
  loading: boolean;
  onDelete: () => void;
  onPreview: (drop: Drop) => void;
  theme?: 'light' | 'dark' | 'minimal';
}

export function DropList({ drops, loading, onDelete, onPreview, theme = 'light' }: DropListProps) {
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);
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
    if (selectedIds.size === drops.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(drops.map(d => d.id)));
    }
  };

  const handleBulkDelete = async () => {
    if (selectedIds.size === 0) return;

    setDeleting(true);
    const selectedDrops = drops.filter(d => selectedIds.has(d.id));

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

  if (drops.length === 0) {
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
      {/* Header with actions */}
      <div className={`border ${tc.borderColor} border-b-0 ${tc.roundedClass} ${tc.headerBg} px-4 py-3 flex items-center justify-between transition-colors duration-300 ${isMinimal ? 'rounded-t-lg' : ''}`}>
        <div className="flex items-center gap-3">
          <span className={`${tc.fontClass} ${isMinimal ? 'text-[#1A1A1A]/60' : 'text-white/60'}`}>
            {isMinimal ? 'Active drops' : 'ACTIVE/DROPS'}
          </span>
          <span className={`${tc.fontClass} ${isMinimal ? 'text-[#1A1A1A]/40' : 'text-[#FF5A47]'}`}>
            {isMinimal ? `${drops.length}/50` : `${drops.length.toString().padStart(2, '0')}/50`}
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
              {selectedIds.size === drops.length ? (isMinimal ? 'Deselect all' : 'DESELECT_ALL') : (isMinimal ? 'Select all' : 'SELECT_ALL')}
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
      <div className={`border ${tc.borderColor} ${tc.roundedClass} transition-colors duration-300 ${isMinimal ? 'rounded-b-lg' : ''}`}>
        {drops.map((drop, index) => (
          <div key={drop.id} className={index > 0 ? `border-t ${tc.borderColor}` : ''}>
            <DropItem
              drop={drop}
              onDelete={onDelete}
              onPreview={onPreview}
              selected={selectedIds.has(drop.id)}
              onSelect={toggleSelect}
              selectionMode={selectionMode}
              theme={theme}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
