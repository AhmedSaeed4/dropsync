'use client';

import { Drop } from '@/types';
import { formatFileSize, getTimeRemaining, decryptDrop } from '@/lib/drops';
import { useState, useEffect } from 'react';

interface DropItemProps {
  drop: Drop;
  onDelete: (drop: Drop) => void;
  onPreview: (drop: Drop) => void;
  selected: boolean;
  onSelect: (id: string) => void;
  selectionMode: boolean;
  theme?: 'light' | 'dark' | 'minimal';
  currentUserId?: string;
}

function isTextFile(drop: Drop): boolean {
  if (drop.type === 'text') return true;
  const textMimeTypes = ['text/', 'application/json', 'application/xml'];
  const textExtensions = ['.txt', '.md', '.json', '.csv', '.xml', '.html', '.css', '.js', '.ts', '.jsx', '.tsx'];
  return textMimeTypes.some(t => drop.mimeType?.startsWith(t)) ||
         textExtensions.some(ext => drop.name.toLowerCase().endsWith(ext));
}

function getFileContent(drop: Drop): string {
  if (drop.type === 'text' && drop.content) return drop.content;
  if (drop.type === 'file' && drop.fileData) {
    try {
      const base64 = drop.fileData.split(',')[1];
      return atob(base64);
    } catch {
      return '';
    }
  }
  return '';
}

export function DropItem({ drop, onDelete, onPreview, selected, onSelect, selectionMode, theme = 'light', currentUserId }: DropItemProps) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [copied, setCopied] = useState(false);
  const [decryptedContent, setDecryptedContent] = useState<string>('');
  const [decryptedFileData, setDecryptedFileData] = useState<string>('');
  const [decryptError, setDecryptError] = useState(false);
  const isDark = theme === 'dark';
  const isMinimal = theme === 'minimal';

  const isImage = drop.mimeType?.startsWith('image/');

  // Decrypt content if encrypted
  useEffect(() => {
    async function decrypt() {
      if (drop.encrypted && currentUserId) {
        try {
          // decryptDrop handles both workspace and personal drops
          const decrypted = await decryptDrop(drop, currentUserId);

          if (decrypted.type === 'text' && decrypted.content) {
            setDecryptedContent(decrypted.content);
            setDecryptError(false);
          } else if (decrypted.type === 'file' && decrypted.fileData) {
            setDecryptedFileData(decrypted.fileData);
            setDecryptError(false);
          } else {
            setDecryptError(true);
          }
        } catch (error) {
          console.error('Decryption error:', error);
          setDecryptError(true);
          setDecryptedContent('');
          setDecryptedFileData('');
        }
      } else {
        setDecryptedContent(drop.content || '');
        setDecryptedFileData(drop.fileData || '');
        setDecryptError(false);
      }
    }
    decrypt();
  }, [drop, currentUserId]);

  // What to display: decrypted, error message, or original content
  const displayContent = drop.encrypted
    ? (decryptError ? '[Encrypted - cannot decrypt]' : decryptedContent)
    : (drop.content || '');

  // What to display for file data (images)
  const displayFileData = drop.encrypted ? decryptedFileData : (drop.fileData || '');

  const handleDownload = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (drop.type === 'file' && displayFileData) {
      const link = document.createElement('a');
      link.href = displayFileData;
      link.download = drop.name;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    }
  };

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    // Use decrypted content for encrypted drops
    const content = drop.type === 'text' ? displayContent : (displayFileData ? (() => {
      try {
        const base64 = displayFileData.split(',')[1];
        return atob(base64);
      } catch {
        return '';
      }
    })() : '');
    if (content) {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleDeleteClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirmDelete(true);
  };

  const handleConfirmDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    onDelete(drop);
  };

  const handleCancelDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirmDelete(false);
  };

  const handleSelect = (e: React.MouseEvent) => {
    e.stopPropagation();
    onSelect(drop.id);
  };

  const canCopyContent = isTextFile(drop);

  // Theme colors
  const getThemeColors = () => {
    if (isMinimal) {
      return {
        borderColor: 'border-[#1A1A1A]/10',
        bgColor: 'bg-[#D4D8C8]',
        hoverBg: 'hover:bg-[#C5C9B8]',
        iconBg: 'bg-[#1A1A1A]/5',
        textColor: 'text-[#1A1A1A]',
        textMuted: 'text-[#1A1A1A]/50',
        textPreviewBg: 'bg-[#1A1A1A]/5',
        textPreviewColor: 'text-[#1A1A1A]/70',
        selectedBg: 'bg-[#1A1A1A]',
        selectedBorder: 'border-[#1A1A1A]',
      };
    }
    return {
      borderColor: isDark ? 'border-white/10' : 'border-[#1A1A1A]',
      bgColor: isDark ? 'bg-[#1A1A1A]' : 'bg-[#FAF7F2]',
      hoverBg: isDark ? 'hover:bg-[#2A2A2A]' : 'hover:bg-[#F5F2ED]',
      iconBg: isDark ? 'bg-[#0D0D0D]' : 'bg-[#F5F2ED]',
      textColor: isDark ? 'text-white' : 'text-[#1A1A1A]',
      textMuted: isDark ? 'text-white/50' : 'text-[#1A1A1A]/50',
      textPreviewBg: isDark ? 'bg-[#0D0D0D]' : 'bg-[#F5F2ED]',
      textPreviewColor: isDark ? 'text-white/70' : 'text-[#1A1A1A]/70',
      selectedBg: 'bg-[#FF5A47]',
      selectedBorder: 'border-[#FF5A47]',
    };
  };

  const tc = getThemeColors();

  return (
    <div
      onClick={() => selectionMode ? onSelect(drop.id) : onPreview(drop)}
      className={`border ${tc.borderColor} ${tc.bgColor} transition-all cursor-pointer group overflow-hidden ${
        selected ? `${tc.selectedBg} ${tc.selectedBorder}` : tc.hoverBg
      }`}
    >
      <div className="flex items-stretch min-w-0 overflow-hidden">
        {/* Selection checkbox or icon */}
        {selectionMode ? (
          <button
            onClick={handleSelect}
            className={`w-12 flex items-center justify-center border-r ${tc.borderColor} transition-colors ${
              selected ? 'bg-white' : tc.iconBg
            }`}
          >
            {selected && (
              <svg className="w-5 h-5 text-[#1A1A1A]" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="3">
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            )}
          </button>
        ) : (
          <div className={`w-14 flex items-center justify-center border-r ${tc.borderColor} ${tc.iconBg}`}>
            {drop.type === 'text' ? (
              <svg className={`w-5 h-5 ${tc.textColor}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
                <path d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
            ) : isImage && displayFileData ? (
              <img src={displayFileData} alt={drop.name} className="w-full h-full object-cover" />
            ) : (
              <svg className={`w-5 h-5 ${tc.textColor}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
                <path d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
              </svg>
            )}
          </div>
        )}

        {/* Info */}
        <div className="flex-1 min-w-0 px-4 py-3">
          <div className="flex items-center gap-2">
            <h3 className={`text-sm ${isMinimal ? 'font-medium tracking-wide' : 'font-semibold uppercase tracking-wider'} line-clamp-1 ${selected ? 'text-white' : tc.textColor}`} title={drop.name}>
              {drop.name}
            </h3>
            {drop.creatorName && (
              <span className={`text-[10px] px-2 py-0.5 rounded-full ${selected ? 'bg-white/20 text-white' : isMinimal ? 'bg-[#1A1A1A]/10 text-[#1A1A1A]/60' : isDark ? 'bg-white/10 text-white/50' : 'bg-[#1A1A1A]/10 text-[#1A1A1A]/50'}`}>
                {drop.creatorName}
              </span>
            )}
          </div>
          <div className={`flex items-center gap-3 mt-1 ${isMinimal ? 'text-xs tracking-wide' : 'text-[10px] font-mono uppercase tracking-wider'}`}>
            {drop.type === 'file' && drop.fileSize && (
              <span className={selected ? 'text-white/70' : tc.textMuted}>
                {isMinimal ? formatFileSize(drop.fileSize).toLowerCase() : formatFileSize(drop.fileSize)}
              </span>
            )}
            {drop.type === 'text' && (
              <span className={selected ? 'text-white/70' : tc.textMuted}>
                {isMinimal ? `${drop.content?.length || 0} chars` : `${drop.content?.length || 0} CHARS`}
              </span>
            )}
            {!isMinimal && <span className={selected ? 'text-white/40' : isDark ? 'text-white/20' : 'text-[#1A1A1A]/30'}>//</span>}
            <span className={isMinimal ? 'text-[#1A1A1A]/40' : 'text-[#FF5A47]'}>
              {getTimeRemaining(drop.expiresAt)}
            </span>
          </div>
        </div>

        {/* Actions */}
        {!selectionMode && (
          <div className={`flex items-center border-l ${tc.borderColor}`}>
            {canCopyContent && (
              <button
                onClick={handleCopy}
                className={`w-12 h-full flex items-center justify-center border-r ${tc.borderColor} ${tc.textMuted} hover:bg-[#1A1A1A] hover:text-white transition-colors`}
                title={isMinimal ? 'Copy' : 'COPY_CONTENT'}
              >
                {copied ? (
                  <svg className={`w-4 h-4 ${isMinimal ? 'text-[#1A1A1A]' : 'text-[#FF5A47]'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2">
                    <path d="M5 13l4 4L19 7" />
                  </svg>
                ) : (
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
                    <path d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                  </svg>
                )}
              </button>
            )}
            {drop.type === 'file' && (
              <button
                onClick={handleDownload}
                className={`w-12 h-full flex items-center justify-center border-r ${tc.borderColor} ${tc.textMuted} hover:bg-[#1A1A1A] hover:text-white transition-colors`}
                title={isMinimal ? 'Download' : 'DOWNLOAD'}
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
                  <path d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                </svg>
              </button>
            )}
            {/* Delete button with inline confirmation */}
            {confirmDelete ? (
              <div className="flex items-center h-full">
                <button
                  onClick={handleCancelDelete}
                  className={`h-full px-3 flex items-center justify-center ${tc.textMuted} hover:bg-[#1A1A1A]/10 transition-colors`}
                  title="Cancel"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
                <button
                  onClick={handleConfirmDelete}
                  className={`h-full px-3 flex items-center justify-center gap-1 text-white ${isMinimal ? 'bg-[#1A1A1A]' : 'bg-[#FF5A47]'} hover:opacity-80 transition-colors`}
                  title="Confirm delete"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                  <span className={`text-xs ${isMinimal ? 'font-medium' : 'font-mono uppercase'}`}>Delete</span>
                </button>
              </div>
            ) : (
              <button
                onClick={handleDeleteClick}
                className={`w-12 h-full flex items-center justify-center ${tc.textMuted} hover:bg-[${isMinimal ? '#1A1A1A' : '#FF5A47'}] hover:text-white transition-colors`}
                title={isMinimal ? 'Delete' : 'DELETE'}
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
                  <path d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
              </button>
            )}
          </div>
        )}
      </div>

      {/* Text Preview */}
      {!selectionMode && drop.type === 'text' && displayContent && (
        <div className={`border-t ${tc.borderColor} px-4 py-3 ${tc.textPreviewBg} overflow-hidden`}>
          <p className={`${isMinimal ? 'text-sm font-sans tracking-wide' : 'text-xs font-mono'} ${tc.textPreviewColor} line-clamp-3 break-all`}>
            {displayContent}
          </p>
        </div>
      )}
    </div>
  );
}
