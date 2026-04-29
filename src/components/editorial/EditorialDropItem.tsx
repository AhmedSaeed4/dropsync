'use client';

import { Drop } from '@/types';
import { formatFileSize, getTimeRemaining, decryptDrop, getYouTubeVideoId } from '@/lib/drops';
import { createShare } from '@/lib/shares';
import { useState, useEffect } from 'react';
import { getEditorialThemeColors } from './editorialTheme';

interface EditorialDropItemProps {
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

export function EditorialDropItem({
  drop,
  onDelete,
  onPreview,
  selected,
  onSelect,
  selectionMode,
  theme = 'light',
  currentUserId,
}: EditorialDropItemProps) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [copied, setCopied] = useState(false);
  const [decryptedContent, setDecryptedContent] = useState<string>('');
  const [decryptedFileData, setDecryptedFileData] = useState<string>('');
  const [decryptedImageData, setDecryptedImageData] = useState<string>('');
  const [decryptError, setDecryptError] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const [isSharing, setIsSharing] = useState(false);
  const [shareCopied, setShareCopied] = useState(false);

  const tc = getEditorialThemeColors(theme);
  const font = tc.fontClass;

  const isImage = drop.mimeType?.startsWith('image/');
  const hasAttachedImage = drop.type === 'text' && !!drop.imageR2Key;

  // Decrypt content if encrypted
  useEffect(() => {
    async function decrypt() {
      if (drop.encrypted && currentUserId) {
        try {
          const decrypted = await decryptDrop(drop, currentUserId);

          if (decrypted.type === 'text' && decrypted.content) {
            setDecryptedContent(decrypted.content);
            setDecryptError(false);
          } else if (decrypted.type === 'file' && decrypted.fileData) {
            setDecryptedFileData(decrypted.fileData);
            setDecryptError(false);
          } else if (!decrypted.content && !decrypted.fileData) {
            setDecryptError(true);
          }
          if (decrypted.imageData) {
            setDecryptedImageData(decrypted.imageData);
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

  const displayContent = drop.encrypted
    ? (decryptError ? '[Encrypted - cannot decrypt]' : decryptedContent)
    : (drop.content || '');

  const displayFileData = drop.encrypted ? decryptedFileData : (drop.fileData || '');
  const displayImageData = decryptedImageData;

  // YouTube thumbnail detection
  const youtubeVideoId = drop.type === 'text' ? getYouTubeVideoId(displayContent) : null;

  // Determine if this drop has a visual thumbnail
  const hasThumbnail =
    isImage && !!displayFileData ||
    drop.type === 'text' && hasAttachedImage && !!displayImageData ||
    !!youtubeVideoId;

  const handleShare = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsSharing(true);
    try {
      const result = await createShare({
        dropId: drop.id,
        type: drop.type,
        name: drop.name,
        content: drop.type === 'text' ? displayContent : undefined,
        imageData: displayImageData || (isImage ? displayFileData : undefined),
        youtubeVideoId: youtubeVideoId || undefined,
        expiresAt: drop.expiresAt,
      });
      if (result?.url) {
        await navigator.clipboard.writeText(result.url);
        setShareCopied(true);
        setTimeout(() => setShareCopied(false), 2000);
      }
    } catch (error) {
      console.error('Share failed:', error);
    } finally {
      setIsSharing(false);
    }
  };

  const handleDownload = async (e: React.MouseEvent) => {
    e.stopPropagation();

    if (displayFileData) {
      const link = document.createElement('a');
      link.href = displayFileData;
      link.download = drop.name;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      return;
    }

    if (!currentUserId) return;

    setIsDownloading(true);
    try {
      const decrypted = await decryptDrop(drop, currentUserId);
      if (decrypted.fileData) {
        const link = document.createElement('a');
        link.href = decrypted.fileData;
        link.download = drop.name;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        setDecryptedFileData(decrypted.fileData);
      }
    } catch (error) {
      console.error('Download failed:', error);
    } finally {
      setIsDownloading(false);
    }
  };

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
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

  // Get thumbnail src
  const getThumbnailSrc = () => {
    if (isImage && displayFileData) return displayFileData;
    if (drop.type === 'text' && hasAttachedImage && displayImageData) return displayImageData;
    if (youtubeVideoId) return `https://img.youtube.com/vi/${youtubeVideoId}/mqdefault.jpg`;
    return null;
  };

  const thumbnailSrc = getThumbnailSrc();

  return (
    <div
      onClick={() => selectionMode ? onSelect(drop.id) : onPreview(drop)}
      className={`${tc.cardBg} ${tc.roundedClass} border ${tc.border} transition-all cursor-pointer group overflow-hidden ${
        selected ? `${tc.activePillBg} ${tc.activePillText}` : tc.hoverBorder
      }`}
    >
      <div className="flex flex-col sm:flex-row items-stretch min-w-0 overflow-hidden p-3 gap-3">
        {/* Selection checkbox or thumbnail */}
        {selectionMode ? (
          <button
            onClick={handleSelect}
            className={`w-10 h-10 flex-shrink-0 flex items-center justify-center ${tc.roundedClass} border ${
              selected
                ? `border-transparent ${tc.activePillBg} ${tc.activePillText}`
                : `${tc.border} ${tc.inactivePillHoverBg}`
            } transition-colors`}
          >
            {selected && (
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="3">
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            )}
          </button>
        ) : thumbnailSrc ? (
          /* Thumbnail variant: 80x80 rounded image on the left */
          <div className="w-full sm:w-20 h-40 sm:h-20 flex-shrink-0 overflow-hidden rounded-lg">
            <img
              src={thumbnailSrc}
              alt={drop.name}
              className="w-full h-full object-cover"
            />
          </div>
        ) : (
          /* No thumbnail: small icon */
          <div className={`w-10 h-10 flex-shrink-0 flex items-center justify-center ${tc.roundedClass} border ${tc.border} ${tc.inactivePillBg}`}>
            {drop.type === 'text' ? (
              <svg className={`w-4 h-4 ${tc.muted}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
                <path d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
            ) : (
              <svg className={`w-4 h-4 ${tc.muted}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
                <path d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
              </svg>
            )}
          </div>
        )}

        {/* Info section */}
        <div className="flex-1 min-w-0 overflow-hidden flex flex-col justify-center">
          <div className="flex items-center gap-2">
            <h3
              className={`text-sm ${font} font-medium tracking-tight line-clamp-2 ${
                selected ? tc.activePillText : tc.text
              }`}
              title={drop.name}
            >
              {drop.name}
            </h3>
            {drop.creatorName && (
              <span className={`text-[10px] px-2 py-0.5 ${tc.roundedClass} ${tc.inactivePillBg} ${tc.inactivePillText} flex-shrink-0`}>
                {drop.creatorName}
              </span>
            )}
          </div>
          <div className={`flex flex-wrap items-center gap-x-2 gap-y-1 mt-1 text-xs ${font} ${selected ? tc.inactivePillText : tc.muted}`}>
            {drop.type === 'file' && drop.fileSize && (
              <span>{formatFileSize(drop.fileSize).toLowerCase()}</span>
            )}
            {drop.type === 'text' && (
              <span>{`${displayContent.length} chars`}</span>
            )}
            {/* Encryption indicator */}
            {drop.encrypted ? (
              <span className={`flex items-center gap-1 ${selected ? tc.inactivePillText : tc.muted}`}>
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2">
                  <path d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                </svg>
                Encrypted
              </span>
            ) : null}
            <span className={selected ? tc.inactivePillText : tc.muted}>
              {getTimeRemaining(drop.expiresAt)}
            </span>
          </div>
          {/* Text preview - single line truncated */}
          {!selectionMode && drop.type === 'text' && displayContent && !thumbnailSrc && (
            <p className={`text-xs mt-1 ${font} ${selected ? tc.inactivePillText : tc.muted} line-clamp-1`}>
              {displayContent}
            </p>
          )}
        </div>

        {/* Action buttons - icon style */}
        {!selectionMode && !confirmDelete && (
          <div className={`flex items-center justify-end sm:justify-start gap-2 sm:gap-1 flex-shrink-0 pt-2 sm:pt-0 border-t ${tc.border} sm:border-t-0 mt-2 sm:mt-0 w-full sm:w-auto`}>
            {canCopyContent && (
              <button
                onClick={handleCopy}
                className={`p-2 sm:px-3 sm:py-1.5 border ${tc.border} ${tc.text} rounded ${tc.btnHoverBg} ${tc.btnHoverText} ${tc.hoverBorder} transition-colors`}
                title={copied ? 'Copied!' : 'Copy content'}
              >
                {copied ? (
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                ) : (
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 17.25v3.375c0 .621-.504 1.125-1.125 1.125h-9.75a1.125 1.125 0 01-1.125-1.125V7.875c0-.621.504-1.125 1.125-1.125H6.75a9.06 9.06 0 011.5.124m7.5 10.376h3.375c.621 0 1.125-.504 1.125-1.125V11.25c0-4.46-3.243-8.161-7.5-8.876a9.06 9.06 0 00-1.5-.124H9.375c-.621 0-1.125.504-1.125 1.125v3.5m7.5 10.375H9.375a1.125 1.125 0 01-1.125-1.125v-9.25m12 6.625v-1.875a3.375 3.375 0 00-3.375-3.375h-1.5" />
                  </svg>
                )}
              </button>
            )}
            {drop.type === 'file' && (
              <button
                onClick={handleDownload}
                disabled={isDownloading}
                className={`p-2 sm:px-3 sm:py-1.5 border ${tc.border} ${tc.text} rounded ${tc.btnHoverBg} ${tc.btnHoverText} ${tc.hoverBorder} transition-colors disabled:opacity-50`}
                title="Download"
              >
                {isDownloading ? (
                  <div className="w-3.5 h-3.5 border border-current/30 border-t-current animate-spin rounded-full" />
                ) : (
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M12 12.75v-7.5m0 7.5l-3-3m3 3l3-3" />
                  </svg>
                )}
              </button>
            )}
            <button
              onClick={handleShare}
              disabled={isSharing}
              className={`p-2 sm:p-1.5 border ${tc.border} ${tc.text} rounded ${tc.btnHoverBg} ${tc.btnHoverText} ${tc.hoverBorder} transition-colors disabled:opacity-50`}
              title={shareCopied ? 'Link copied!' : 'Share'}
            >
              {shareCopied ? (
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              ) : isSharing ? (
                <div className="w-3.5 h-3.5 border border-current/30 border-t-current animate-spin rounded-full" />
              ) : (
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M7.217 10.907a2.25 2.25 0 100 2.186m0-2.186c.18.324.287.696.287 1.093m0-2.186l9.566-5.314m-9.566 7.5l9.566 5.314m0 0a2.25 2.25 0 103.935 2.186 2.25 2.25 0 00-3.935-2.186zm0-12.814a2.25 2.25 0 103.933-2.185 2.25 2.25 0 00-3.933 2.185z" />
                </svg>
              )}
            </button>
            <button
              onClick={handleDeleteClick}
              className={`p-2 sm:p-1.5 border ${tc.border} ${tc.text} rounded hover:border-red-400 hover:text-red-500 transition-colors`}
              title="Delete"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
              </svg>
            </button>
          </div>
        )}

        {/* Inline delete confirmation */}
        {!selectionMode && confirmDelete && (
          <div className="flex items-center gap-1 flex-shrink-0">
            <button
              onClick={handleCancelDelete}
              className={`px-3 h-8 flex items-center justify-center ${tc.roundedClass} border ${tc.border} ${tc.inactivePillText} ${tc.inactivePillHoverBg} transition-colors text-xs ${font}`}
            >
              Cancel
            </button>
            <button
              onClick={handleConfirmDelete}
              className={`px-3 h-8 flex items-center justify-center gap-1 ${tc.roundedClass} bg-red-500 text-white hover:bg-red-600 transition-colors text-xs ${font}`}
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2">
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
              Delete
            </button>
          </div>
        )}
      </div>

      {/* Text preview with thumbnail - shown below the row for thumbnail variant */}
      {!selectionMode && drop.type === 'text' && displayContent && thumbnailSrc && (
        <div className={`px-3 pb-3 pt-0`}>
          <p className={`text-xs ${font} ${selected ? tc.inactivePillText : tc.muted} line-clamp-2`}>
            {displayContent}
          </p>
        </div>
      )}
    </div>
  );
}
