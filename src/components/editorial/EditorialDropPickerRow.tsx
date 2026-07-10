'use client';

import { useState, useEffect } from 'react';
import { auth } from '@/lib/firebase';
import { Drop } from '@/types';
import { decryptDrop, getYouTubeVideoId, getTimeRemaining, formatFileSize } from '@/lib/drops';
import { getEditorialThemeColors } from './editorialTheme';

interface EditorialDropPickerRowProps {
  drop: Drop;
  selected: boolean;
  attached: boolean;
  onSelect: (drop: Drop) => void;
  theme: 'light' | 'dark' | 'minimal';
}

export function EditorialDropPickerRow({ drop, selected, attached, onSelect, theme }: EditorialDropPickerRowProps) {
  const tc = getEditorialThemeColors(theme);

  const [decryptedContent, setDecryptedContent] = useState<string>('');
  const [decryptedFileData, setDecryptedFileData] = useState<string>('');
  const [decryptedImageData, setDecryptedImageData] = useState<string>('');
  const [decryptError, setDecryptError] = useState(false);

  const isImage = drop.mimeType?.startsWith('image/');
  const isVideo = drop.mimeType?.startsWith('video/');
  const hasAttachedImage = drop.type === 'text' && !!drop.imageR2Key;

  // Decrypt content if encrypted — mirrors EditorialDropItem.tsx pattern
  useEffect(() => {
    let cancelled = false;
    async function decrypt() {
      const currentUserId = auth.currentUser?.uid;
      if (drop.encrypted && currentUserId) {
        try {
          const decrypted = await decryptDrop(drop, currentUserId);
          if (cancelled) return;
          if (decrypted.type === 'text' && decrypted.content) {
            setDecryptedContent(decrypted.content);
            setDecryptError(false);
          } else if (decrypted.type === 'file' && decrypted.fileData) {
            setDecryptedFileData(decrypted.fileData);
            setDecryptError(false);
          } else if (decrypted.imageData) {
            setDecryptError(false);
          } else if (!decrypted.content && !decrypted.fileData) {
            setDecryptError(true);
          }
          if (decrypted.imageData) {
            setDecryptedImageData(decrypted.imageData);
          }
        } catch (error) {
          if (cancelled) return;
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
    return () => { cancelled = true; };
  }, [drop]);

  // Display variables — mirrors EditorialDropItem.tsx
  const displayContent = drop.encrypted
    ? (decryptError ? '' : decryptedContent)
    : (drop.content || '');
  const displayFileData = drop.encrypted ? decryptedFileData : (drop.fileData || '');
  const displayImageData = decryptedImageData;

  // YouTube thumbnail detection
  const youtubeVideoId = drop.type === 'text' ? getYouTubeVideoId(displayContent) : null;

  return (
    <button
      onPointerDown={(e) => e.preventDefault()}
      type="button"
      disabled={attached}
      onClick={() => !attached && onSelect(drop)}
      data-drop-highlighted={selected}
      className={`w-full text-left px-4 py-2.5 flex items-center gap-3 ${tc.fontClass} ${
        attached
          ? 'opacity-50 cursor-not-allowed'
          : selected
            ? `${tc.activePillBg} ${tc.activePillText}`
            : `${tc.text} hover:bg-black/5`
      }`}
    >
      {/* Thumbnail box ~48x48 — image-first hierarchy (Editorial) */}
      <div className={`w-12 h-12 flex-shrink-0 flex items-center justify-center overflow-hidden rounded ${tc.inactivePillBg}`}>
        {isImage && displayFileData ? (
          <img src={displayFileData} alt={drop.name} className="w-full h-full object-cover rounded" />
        ) : drop.type === 'text' && hasAttachedImage && displayImageData ? (
          <img src={displayImageData} alt={drop.name} className="w-full h-full object-cover rounded" />
        ) : youtubeVideoId ? (
          <img src={`https://img.youtube.com/vi/${youtubeVideoId}/mqdefault.jpg`} alt="YouTube" className="w-full h-full object-cover rounded" />
        ) : isVideo ? (
          /* Static video icon — NO useVideoThumbnail */
          <svg className={`w-4 h-4 ${tc.muted}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
            <path strokeLinecap="round" strokeLinejoin="round" d="m15.75 10.5 4.72-4.72a.75.75 0 0 1 1.28.53v11.38a.75.75 0 0 1-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 0 0 2.25-2.25v-9a2.25 2.25 0 0 0-2.25-2.25h-9A2.25 2.25 0 0 0 2.25 7.5v9a2.25 2.25 0 0 0 2.25 2.25Z" />
          </svg>
        ) : drop.type === 'text' ? (
          <svg className={`w-4 h-4 ${tc.muted}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
            <path d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
        ) : (
          <svg className={`w-4 h-4 ${tc.muted}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
            <path d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
          </svg>
        )}
      </div>

      {/* Name + metadata column */}
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium tracking-tight truncate">
          {drop.name}
        </div>
        <div className={`flex items-center gap-2 mt-0.5 min-w-0 text-xs ${tc.fontClass} ${selected ? tc.activePillText : tc.muted}`}>
          {drop.type === 'file' && drop.fileSize && (
            <span>{formatFileSize(drop.fileSize).toLowerCase()}</span>
          )}
          {drop.type === 'text' && (
            <span>{`${displayContent.length} chars`}</span>
          )}
          {drop.creatorName && (
            <span className="shrink min-w-0 truncate">{drop.creatorName}</span>
          )}
          {drop.encrypted && (
            <span className="flex items-center gap-0.5">
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2">
                <path d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
              </svg>
            </span>
          )}
          <span>{getTimeRemaining(drop.expiresAt)}</span>
        </div>
        {/* Text preview — 1 line */}
        {drop.type === 'text' && displayContent && (
          <div className={`mt-0.5 text-xs ${tc.fontClass} ${selected ? tc.activePillText : tc.muted} line-clamp-1`}>
            {displayContent}
          </div>
        )}
        {/* Encrypted + not yet decrypted */}
        {drop.type === 'text' && !displayContent && drop.encrypted && !decryptError && (
          <div className={`mt-0.5 text-xs ${tc.fontClass} ${selected ? tc.activePillText : tc.muted}`}>
            {'…'}
          </div>
        )}
      </div>

      {/* Attached checkmark */}
      {attached && (
        <svg className="w-4 h-4 flex-shrink-0 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2.5">
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
        </svg>
      )}
    </button>
  );
}
