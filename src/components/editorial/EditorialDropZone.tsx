'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import { createFileDrop, createTextDrop } from '@/lib/drops';
import { useAuth } from '@/hooks/useAuth';
import { EditorialTextModal } from './EditorialTextModal';
import { ExpirationOption } from '@/types';
import { getEditorialThemeColors } from './editorialTheme';

interface EditorialDropZoneProps {
  theme?: 'light' | 'dark' | 'minimal';
  workspaceId?: string | null;
  workspaceMembers?: string[];
  customCategories?: string[];
  onCreateCategory?: (name: string) => Promise<string | null>;
  showChat?: boolean;
  editModalOpen?: boolean;
}

const EXPIRATION_OPTIONS: { value: ExpirationOption; label: string }[] = [
  { value: '1h', label: '1h' },
  { value: '2h', label: '2h' },
  { value: '6h', label: '6h' },
  { value: '24h', label: '24h' },
  { value: 'forever', label: '∞' },
];

export function EditorialDropZone({
  theme = 'light',
  workspaceId = null,
  workspaceMembers = [],
  customCategories = [],
  onCreateCategory,
  showChat = false,
  editModalOpen = false,
}: EditorialDropZoneProps) {
  const { user } = useAuth();
  const [isDragging, setIsDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showTextModal, setShowTextModal] = useState(false);
  const [expiration, setExpiration] = useState<ExpirationOption>('2h');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const tc = getEditorialThemeColors(theme);

  // --- File upload helpers ---
  const uploadFiles = useCallback(
    async (files: File[]) => {
      if (!user || files.length === 0) return;
      setError(null);
      setUploading(true);
      const creatorName =
        user.displayName || user.email?.split('@')[0] || undefined;
      for (const file of files) {
        const result = await createFileDrop(
          user.uid,
          file,
          expiration,
          workspaceId,
          workspaceMembers,
          creatorName
        );
        if (result.error) {
          setError(result.error);
        }
      }
      setUploading(false);
    },
    [user, expiration, workspaceId, workspaceMembers]
  );

  // --- Drag & Drop ---
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      const files = Array.from(e.dataTransfer.files);
      await uploadFiles(files);
    },
    [uploadFiles]
  );

  // --- File input ---
  const handleFileSelect = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      if (!e.target.files) return;
      const files = Array.from(e.target.files);
      await uploadFiles(files);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    },
    [uploadFiles]
  );

  // --- Text drop ---
  const handleTextSubmit = async (
    name: string,
    content: string,
    textExpiration: ExpirationOption,
    category?: string,
    imageFile?: File
  ) => {
    if (!user) return;
    const creatorName =
      user.displayName || user.email?.split('@')[0] || undefined;
    setUploading(true);
    await createTextDrop(
      user.uid,
      name,
      content,
      textExpiration,
      workspaceId,
      workspaceMembers,
      category,
      creatorName,
      imageFile
    );
    setUploading(false);
    setShowTextModal(false);
  };

  // --- Clipboard paste ---
  useEffect(() => {
    const handlePaste = async (e: ClipboardEvent) => {
      if (!user || uploading || showTextModal || editModalOpen) return;
      const target = e.target as HTMLElement;
      if (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable
      )
        return;

      const items = e.clipboardData?.items;
      if (!items) return;

      const imageFiles: File[] = [];
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          const blob = item.getAsFile();
          if (blob) {
            const ext = item.type.split('/')[1] || 'png';
            const file = new File([blob], `pasted-image-${Date.now()}.${ext}`, {
              type: item.type,
            });
            imageFiles.push(file);
          }
        }
      }

      if (imageFiles.length > 0) {
        e.preventDefault();
        await uploadFiles(imageFiles);
      }
    };

    document.addEventListener('paste', handlePaste);
    return () => document.removeEventListener('paste', handlePaste);
  }, [user, uploading, showTextModal, uploadFiles]);

  // --- Border/shadow states ---
  const borderClass = isDragging
    ? `${tc.dragBorder} border-2`
    : `${tc.border} ${tc.hoverBorder} border`;

  const shadowClass = isDragging ? 'shadow-lg' : '';

  const bgClass = isDragging ? tc.dragBg : tc.bg;
  const textClass = isDragging ? tc.dragText : tc.text;
  const mutedClass = isDragging ? tc.dragMuted : tc.muted;

  return (
    <>
      {/* Section header */}
      <div className={`flex items-center transition-all duration-[350ms] ease-[cubic-bezier(0.4,0,0.2,1)] ${showChat ? 'gap-2.5 mb-4' : 'gap-3 mb-6'}`}>
        <span className={`rounded-full ${tc.activePillBg} transition-all duration-[350ms] ease-[cubic-bezier(0.4,0,0.2,1)] ${showChat ? 'w-1.5 h-1.5' : 'w-1.5 h-1.5'}`}></span>
        <h2 className={`${tc.fontClass} ${tc.text} font-medium tracking-tight transition-all duration-[350ms] ease-[cubic-bezier(0.4,0,0.2,1)] ${showChat ? 'text-lg' : 'text-xl'}`}>Upload</h2>
      </div>

      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={`${bgClass} ${borderClass} rounded-xl ${shadowClass} text-left transition-all duration-[350ms] ease-[cubic-bezier(0.4,0,0.2,1)] ${showChat ? 'p-8' : 'p-10'}`}
      >
        {/* Hidden file input */}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          onChange={handleFileSelect}
          className="hidden"
        />

        {uploading ? (
          <div className="flex flex-col items-start gap-4">
            <div className="w-8 h-8 border-2 border-current/30 border-t-current animate-spin rounded-full" />
            <p className={`text-sm ${tc.fontClass} ${textClass}`}>
              Uploading...
            </p>
          </div>
        ) : (
          <>
            {/* Clickable area above the expiry line */}
            <div
              onClick={(e) => {
                const target = e.target as HTMLElement;
                if (target.tagName === 'BUTTON' || target.closest('button')) {
                  return;
                }
                setShowTextModal(true);
              }}
              className={`cursor-pointer ${showChat ? 'pb-6' : 'pb-8'}`}
            >
              {/* Title */}
              <h2
                className={`${tc.fontClass} ${textClass} font-medium tracking-tight mb-2 transition-all duration-[350ms] ease-[cubic-bezier(0.4,0,0.2,1)] ${showChat ? 'text-2xl' : 'text-[28px]'}`}
                style={{ fontFamily: 'Raleway, sans-serif' }}
              >
                Drop files here
              </h2>

              {/* Subtitle */}
              <p className={`text-sm ${tc.fontClass} ${mutedClass} mb-6`}>
                Or choose an option below &mdash; Max 500MB
              </p>

              {/* Action buttons */}
              <div className={`flex items-center gap-3 transition-all duration-[350ms] ease-[cubic-bezier(0.4,0,0.2,1)]`}>
                {/* Browse Files - primary */}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                  fileInputRef.current?.click();
                }}
                className={`${tc.fontClass} rounded-lg ${tc.activePillBg} ${tc.activePillText} hover:opacity-90 transition-all duration-[350ms] ease-[cubic-bezier(0.4,0,0.2,1)] ${showChat ? 'px-4 py-2.5 text-sm' : 'px-6 py-3 text-sm'}`}
              >
                Browse Files
              </button>

              {/* Add Text - secondary */}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setShowTextModal(true);
                }}
                className={`${tc.fontClass} rounded-lg border ${tc.border} bg-transparent ${tc.text} ${tc.hoverBorder} transition-all duration-[350ms] ease-[cubic-bezier(0.4,0,0.2,1)] ${showChat ? 'px-4 py-2.5 text-sm' : 'px-6 py-3 text-sm'}`}
              >
                Add Text
              </button>
            </div>
            </div>

            {/* Expiry selector */}
            <div className={`border-t ${tc.border} transition-all duration-[350ms] ease-[cubic-bezier(0.4,0,0.2,1)] ${showChat ? 'pt-4' : 'pt-6'}`}>
              <p className={`text-xs ${tc.fontClass} ${tc.muted} mb-3 tracking-wider uppercase`}>Expires after</p>
              <div className="flex gap-2 flex-wrap">
                {EXPIRATION_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setExpiration(option.value);
                    }}
                    className={`${tc.fontClass} rounded-full border transition-all duration-[350ms] ease-[cubic-bezier(0.4,0,0.2,1)] ${
                      expiration === option.value
                        ? `${tc.activePillBg} ${tc.activePillText} ${tc.border}`
                        : `bg-transparent ${tc.text} ${tc.border} ${tc.hoverBorder}`
                    } ${showChat ? 'px-3 py-1.5 text-xs' : 'px-4 py-2 text-sm'}`}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
          </>
        )}
      </div>

      {/* Error message */}
      {error && (
        <div
          className={`mt-4 border ${tc.border} ${tc.roundedClass} ${tc.bg} px-5 py-3 flex items-center justify-between`}
        >
          <span className={`text-sm ${tc.fontClass} ${tc.text}`}>
            {error}
          </span>
          <button
            onClick={() => setError(null)}
            className={`${tc.text} hover:opacity-60 transition-opacity`}
          >
            <svg
              className="w-4 h-4"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>
      )}

      {/* Text Modal */}
      {showTextModal && (
        <EditorialTextModal
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
