'use client';

import { useState, useEffect } from 'react';
import { Category } from '@/types';

interface CategoryFilterProps {
  categories: Category[];
  selectedCategory: string;
  onSelectCategory: (category: string) => void;
  dropCounts: { [category: string]: number };
  onDeleteCategory?: (categoryId: string, categoryName: string) => void;
  theme?: 'light' | 'dark' | 'minimal';
}

const BUILT_IN_CATEGORIES = [
  { value: 'all', label: 'All' },
  { value: 'files', label: 'Files' },
  { value: 'password', label: 'Password' },
  { value: 'link', label: 'Link' },
];

export function CategoryFilter({
  categories,
  selectedCategory,
  onSelectCategory,
  dropCounts,
  onDeleteCategory,
  theme = 'light'
}: CategoryFilterProps) {
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const isDark = theme === 'dark';
  const isMinimal = theme === 'minimal';

  // Theme colors
  const getThemeColors = () => {
    if (isMinimal) {
      return {
        borderColor: 'border-[#1A1A1A]/20',
        bgColor: 'bg-[#D4D8C8]',
        textColor: 'text-[#1A1A1A]',
        textMuted: 'text-[#1A1A1A]/50',
        fontClass: 'font-sans tracking-wide text-xs',
        roundedClass: 'rounded-full',
        pillBg: 'bg-[#1A1A1A]/5',
        activeBg: 'bg-[#1A1A1A]',
        activeText: 'text-white',
      };
    }
    return {
      borderColor: isDark ? 'border-white/10' : 'border-[#1A1A1A]',
      bgColor: isDark ? 'bg-[#1A1A1A]' : 'bg-[#FAF7F2]',
      textColor: isDark ? 'text-white' : 'text-[#1A1A1A]',
      textMuted: isDark ? 'text-white/50' : 'text-[#1A1A1A]/50',
      fontClass: 'font-mono uppercase tracking-wider text-[10px]',
      roundedClass: '',
      pillBg: isDark ? 'bg-white/10' : 'bg-[#1A1A1A]/5',
      activeBg: 'bg-[#FF5A47]',
      activeText: 'text-white',
    };
  };

  const tc = getThemeColors();

  const handleDeleteClick = (categoryId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirmDelete(categoryId);
  };

  const handleConfirmDelete = (categoryId: string, categoryName: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (onDeleteCategory) {
      onDeleteCategory(categoryId, categoryName);
    }
    setConfirmDelete(null);
  };

  const handleCancelDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirmDelete(null);
  };

  return (
    <div className={`border-b ${tc.borderColor} px-4 py-3 ${tc.bgColor} transition-colors duration-300`}>
      <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-hide">
        {/* Built-in categories */}
        {BUILT_IN_CATEGORIES.map((cat) => (
          <button
            key={cat.value}
            onClick={() => onSelectCategory(cat.value)}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-xs whitespace-nowrap transition-colors ${
              selectedCategory === cat.value
                ? `${tc.activeBg} ${tc.activeText}`
                : `${tc.pillBg} ${tc.textColor} hover:bg-[#1A1A1A]/10`
            } ${tc.roundedClass}`}
          >
            <span>{isMinimal ? cat.label : cat.label.toUpperCase()}</span>
            {dropCounts[cat.value] !== undefined && (
              <span className={`text-[10px] ${selectedCategory === cat.value ? 'text-white/70' : tc.textMuted}`}>
                {dropCounts[cat.value]}
              </span>
            )}
          </button>
        ))}

        {/* Uncategorized (only if there are uncategorized drops) */}
        {dropCounts['uncategorized'] > 0 && (
          <button
            onClick={() => onSelectCategory('uncategorized')}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-xs whitespace-nowrap transition-colors ${
              selectedCategory === 'uncategorized'
                ? `${tc.activeBg} ${tc.activeText}`
                : `${tc.pillBg} ${tc.textColor} hover:bg-[#1A1A1A]/10`
            } ${tc.roundedClass}`}
          >
            <span>{isMinimal ? 'Uncategorized' : 'UNCATEGORIZED'}</span>
            <span className={`text-[10px] ${selectedCategory === 'uncategorized' ? 'text-white/70' : tc.textMuted}`}>
              {dropCounts['uncategorized']}
            </span>
          </button>
        )}

        {/* Custom categories */}
        {categories.map((cat) => {
          const count = dropCounts[cat.name] || 0;
          const showDelete = count === 0 && confirmDelete !== cat.id;

          return (
            <div key={cat.id} className="relative flex items-center">
              <button
                onClick={() => onSelectCategory(cat.name)}
                className={`flex items-center gap-1.5 px-3 py-1.5 text-xs whitespace-nowrap transition-colors ${
                  selectedCategory === cat.name
                    ? `${tc.activeBg} ${tc.activeText}`
                    : `${tc.pillBg} ${tc.textColor} hover:bg-[#1A1A1A]/10`
                } ${tc.roundedClass} ${showDelete ? 'pr-1' : ''}`}
              >
                <span>{isMinimal ? cat.name : cat.name.toUpperCase()}</span>
                <span className={`text-[10px] ${selectedCategory === cat.name ? 'text-white/70' : tc.textMuted}`}>
                  {count}
                </span>
              </button>

              {/* Delete button - only show when count is 0 */}
              {count === 0 && confirmDelete !== cat.id && (
                <button
                  onClick={(e) => handleDeleteClick(cat.id, e)}
                  className={`ml-1 w-4 h-4 flex items-center justify-center ${tc.textMuted} hover:text-red-500 transition-colors`}
                  title="Delete category"
                >
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              )}

              {/* Confirm delete */}
              {confirmDelete === cat.id && (
                <div className="flex items-center ml-1 gap-1">
                  <button
                    onClick={(e) => handleConfirmDelete(cat.id, cat.name, e)}
                    className="px-2 py-1 text-xs bg-red-500 text-white hover:bg-red-600 transition-colors rounded"
                    title="Confirm delete"
                  >
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                  </button>
                  <button
                    onClick={handleCancelDelete}
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
  );
}