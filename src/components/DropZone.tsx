'use client';

import { useState, useRef, useCallback } from 'react';
import { createFileDrop, createTextDrop } from '@/lib/drops';
import { useAuth } from '@/hooks/useAuth';
import { TextModal } from './TextModal';
import { ExpirationOption } from '@/types';

interface DropZoneProps {
  theme?: 'light' | 'dark' | 'minimal';
  workspaceId?: string | null;
  workspaceMembers?: string[];
  customCategories?: string[];
  onCreateCategory?: (name: string) => Promise<string | null>;
}

const EXPIRATION_OPTIONS: { value: ExpirationOption; label: string }[] = [
  { value: '1h', label: '1h' },
  { value: '2h', label: '2h' },
  { value: '6h', label: '6h' },
  { value: '24h', label: '24h' },
  { value: 'forever', label: '∞' },
];

export function DropZone({
  theme = 'light',
  workspaceId = null,
  workspaceMembers = [],
  customCategories = [],
  onCreateCategory
}: DropZoneProps) {
  const { user } = useAuth();
  const [isDragging, setIsDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showTextModal, setShowTextModal] = useState(false);
  const [expiration, setExpiration] = useState<ExpirationOption>('2h');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const isDark = theme === 'dark';
  const isMinimal = theme === 'minimal';

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    setError(null);

    if (!user) return;

    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) {
      setUploading(true);
      for (const file of files) {
        const result = await createFileDrop(user.uid, file, expiration, workspaceId, workspaceMembers);
        if (result.error) {
          setError(result.error);
        }
      }
      setUploading(false);
    }
  }, [user, expiration, workspaceId, workspaceMembers]);

  const handleFileSelect = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!user || !e.target.files) return;
    setError(null);

    const files = Array.from(e.target.files);
    if (files.length > 0) {
      setUploading(true);
      for (const file of files) {
        const result = await createFileDrop(user.uid, file, expiration, workspaceId, workspaceMembers);
        if (result.error) {
          setError(result.error);
        }
      }
      setUploading(false);
    }

    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  }, [user, expiration, workspaceId, workspaceMembers]);

  const handleTextSubmit = async (name: string, content: string, textExpiration: ExpirationOption, category?: string) => {
    if (!user) return;

    setUploading(true);
    await createTextDrop(user.uid, name, content, textExpiration, workspaceId, workspaceMembers, category);
    setUploading(false);
    setShowTextModal(false);
  };

  // Theme colors
  const getThemeColors = () => {
    if (isMinimal) {
      return {
        borderColor: 'border-[#1A1A1A]/20',
        bgColor: 'bg-[#D4D8C8]',
        headerBg: 'bg-[#1A1A1A]/5',
        textColor: 'text-[#1A1A1A]',
        textMuted: 'text-[#1A1A1A]/50',
        textMuted2: 'text-[#1A1A1A]/60',
        dropZoneBg: 'bg-[#D4D8C8]',
        dropZoneHover: 'hover:bg-[#C5C9B8]',
        fontClass: 'font-sans tracking-wide text-xs',
        roundedClass: 'rounded-lg',
        iconBorder: 'border-[#1A1A1A]/30',
        dragBg: 'bg-[#1A1A1A]',
      };
    }
    return {
      borderColor: isDark ? 'border-white/10' : 'border-[#1A1A1A]',
      bgColor: isDark ? 'bg-[#1A1A1A]' : 'bg-[#FAF7F2]',
      headerBg: isDark ? 'bg-[#0D0D0D]' : 'bg-[#F5F2ED]',
      textColor: isDark ? 'text-white' : 'text-[#1A1A1A]',
      textMuted: isDark ? 'text-white/50' : 'text-[#1A1A1A]/50',
      textMuted2: isDark ? 'text-white/70' : 'text-[#1A1A1A]/50',
      dropZoneBg: isDark ? 'bg-[#1A1A1A]' : 'bg-white',
      dropZoneHover: isDark ? 'hover:bg-[#2A2A2A]' : 'hover:bg-[#F5F2ED]',
      fontClass: 'font-mono uppercase tracking-wider text-[10px]',
      roundedClass: '',
      iconBorder: isDark ? 'border-white/30' : 'border-[#1A1A1A]',
      dragBg: 'bg-[#FF5A47]',
    };
  };

  const tc = getThemeColors();

  return (
    <>
      <div className={`border ${tc.borderColor} ${tc.bgColor} ${tc.roundedClass} transition-colors duration-300`}>
        {/* Top bar with specs */}
        <div className={`border-b ${tc.borderColor} px-4 py-3 flex items-center justify-between ${tc.headerBg} transition-colors duration-300 ${isMinimal ? 'rounded-t-lg' : ''}`}>
          <span className={`${tc.fontClass} ${tc.textMuted}`}>
            {isMinimal ? 'Upload files' : 'DROP/INTERFACE // SECURE'}
          </span>
          <span className={`${tc.fontClass} ${isMinimal ? 'text-[#1A1A1A]/70' : 'text-[#FF5A47]'}`}>
            {isMinimal ? 'Max 800KB' : 'MAX: 800KB'}
          </span>
        </div>

        {/* Drop area */}
        <div
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
          className={`
            relative p-12 text-center transition-all duration-200 cursor-pointer
            ${isDragging
              ? tc.dragBg
              : isMinimal ? 'bg-[#D4D8C8] hover:bg-[#C5C9B8]' : isDark ? 'bg-[#1A1A1A] hover:bg-[#2A2A2A]' : 'bg-[#FAF7F2] hover:bg-[#F5F2ED]'
            }
            ${isMinimal ? 'rounded-b-lg' : ''}
          `}
        >
          <input
            ref={fileInputRef}
            type="file"
            multiple
            onChange={handleFileSelect}
            className="hidden"
          />

          {uploading ? (
            <div className="flex flex-col items-center gap-4">
              {isMinimal ? (
                <div className="w-8 h-8 border border-[#1A1A1A]/30 border-t-[#1A1A1A] animate-spin rounded-full" />
              ) : (
                <div className={`w-8 h-8 border-2 ${isDark ? 'border-white' : 'border-[#1A1A1A]'} border-t-transparent animate-spin`} />
              )}
              <p className={`${tc.fontClass} ${isDragging ? 'text-white' : tc.textColor}`}>
                {isMinimal ? 'Uploading...' : 'UPLOADING_DATA...'}
              </p>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-4">
              {/* Geometric upload icon */}
              <div className={`w-16 h-16 ${isMinimal ? '' : 'border'} ${tc.iconBorder} ${isMinimal ? '' : tc.borderColor} flex items-center justify-center relative ${isDragging ? (isMinimal ? 'border-[#1A1A1A]' : 'border-white') : ''}`}>
                {!isMinimal && <div className={`absolute inset-2 border ${tc.iconBorder} ${isDragging ? (isMinimal ? 'border-[#1A1A1A]' : 'border-white') : ''}`} />}
                <svg
                  className={`w-6 h-6 ${isDragging ? (isMinimal ? 'text-[#C5C9B8]' : 'text-white') : tc.textColor}`}
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                  strokeWidth="1.5"
                >
                  <path d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                </svg>
              </div>

              <div>
                <p className={`${isMinimal ? 'text-sm font-medium tracking-wide' : 'text-sm font-semibold uppercase tracking-wider'} ${isDragging ? (isMinimal ? 'text-[#C5C9B8]' : 'text-white') : tc.textColor}`}>
                  {isDragging ? (isMinimal ? 'Drop files here' : 'DROP_FILES_NOW') : (isMinimal ? 'Drag & drop files' : 'DRAG_&_DROP_FILES')}
                </p>
                <p className={`${isMinimal ? 'text-xs tracking-wide mt-2' : 'text-[10px] font-mono uppercase tracking-wider mt-1'} ${isDragging ? (isMinimal ? 'text-[#C5C9B8]/70' : 'text-white/70') : tc.textMuted2}`}>
                  {isMinimal ? 'Or click to browse' : 'OR_CLICK_TO_BROWSE'}
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Expiration selector */}
        <div className={`border-t ${tc.borderColor} px-4 py-3 ${tc.headerBg} transition-colors duration-300`}>
          <div className="flex items-center justify-between gap-4">
            <span className={`${tc.fontClass} ${tc.textMuted}`}>
              {isMinimal ? 'Expires after' : 'EXPIRES_AFTER'}
            </span>
            <div className="flex gap-1">
              {EXPIRATION_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setExpiration(option.value);
                  }}
                  className={`px-2 py-1 text-xs transition-colors ${
                    expiration === option.value
                      ? 'bg-[#1A1A1A] text-white'
                      : `${tc.textColor} hover:bg-[#1A1A1A]/10`
                  } ${isMinimal ? 'rounded-full' : ''}`}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Bottom action bar */}
        <div className={`border-t ${tc.borderColor} flex ${isMinimal ? 'rounded-b-lg' : ''}`}>
          <button
            onClick={(e) => {
              e.stopPropagation();
              setShowTextModal(true);
            }}
            className={`flex-1 border-r ${tc.borderColor} px-4 py-3 text-xs tracking-wider ${tc.textColor} hover:bg-[#1A1A1A] hover:text-white transition-colors flex items-center justify-center gap-2 ${isMinimal ? 'rounded-bl-lg' : ''}`}
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
              <path d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            {isMinimal ? 'Add text' : 'ADD_TEXT_SNIPPET'}
          </button>
          <div className={`px-4 py-3 ${tc.fontClass} ${tc.textMuted} flex items-center gap-2 ${isMinimal ? 'rounded-br-lg' : ''}`}>
            {!isMinimal && <span className="w-1.5 h-1.5 bg-[#FF5A47]" />}
            {isMinimal ? '50 max' : '50_MAX_DROPS'}
          </div>
        </div>
      </div>

      {/* Error message */}
      {error && (
        <div className={`mt-4 border ${isMinimal ? 'border-[#1A1A1A]/20 rounded-lg' : 'border-[#FF5A47]'} ${isMinimal ? 'bg-[#1A1A1A]/5' : 'bg-[#FF5A47]/10'} px-4 py-3 flex items-center justify-between`}>
          <span className={`text-xs ${isMinimal ? 'font-sans tracking-wide' : 'font-mono uppercase tracking-wider'} ${tc.textColor}`}>
            {error}
          </span>
          <button
            onClick={() => setError(null)}
            className={`${tc.textColor} hover:text-[#FF5A47] transition-colors`}
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}

      {/* Text Modal */}
      {showTextModal && (
        <TextModal
          onSubmit={handleTextSubmit}
          onClose={() => setShowTextModal(false)}
          theme={theme}
          customCategories={customCategories}
          onCreateCategory={onCreateCategory}
        />
      )}
    </>
  );
}