'use client';

import { useState } from 'react';
import { Drop } from '@/types';
import { useBodyScrollLock } from '@/hooks/useBodyScrollLock';
import { formatFileSize, getYouTubeVideoId } from '@/lib/drops';
import { createShare } from '@/lib/shares';

interface PreviewModalProps {
  drop: Drop;
  onClose: () => void;
  theme?: 'light' | 'dark' | 'minimal';
  isLoading?: boolean;
}

function isTextFile(drop: Drop): boolean {
  if (drop.type === 'text') return true;
  const textMimeTypes = ['text/', 'application/json', 'application/xml'];
  const textExtensions = ['.txt', '.md', '.json', '.csv', '.xml', '.html', '.css', '.js', '.ts', '.jsx', '.tsx'];
  return textMimeTypes.some(t => drop.mimeType?.startsWith(t)) ||
         textExtensions.some(ext => drop.name.toLowerCase().endsWith(ext));
}

export function PreviewModal({ drop, onClose, theme = 'light', isLoading = false }: PreviewModalProps) {
  useBodyScrollLock();
  const [copied, setCopied] = useState(false);
  const [shareCopied, setShareCopied] = useState(false);
  const [isSharing, setIsSharing] = useState(false);
  const isImage = drop.mimeType?.startsWith('image/');
  const isText = isTextFile(drop);
  const isDark = theme === 'dark';
  const isMinimal = theme === 'minimal';

  const getTextContent = () => {
    if (drop.type === 'text' && drop.content) return drop.content;
    if (!drop.fileData) return '';
    try {
      const base64 = drop.fileData.split(',')[1];
      return atob(base64);
    } catch {
      return 'UNABLE_TO_DECODE_CONTENT';
    }
  };

  const handleDownload = () => {
    if (drop.fileData) {
      const link = document.createElement('a');
      link.href = drop.fileData;
      link.download = drop.name;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    }
  };

  const handleCopy = async () => {
    const content = getTextContent();
    if (content) {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const textContent = isText ? getTextContent() : '';
  const youtubeVideoId = textContent ? getYouTubeVideoId(textContent) : null;

  const handleShare = async () => {
    setIsSharing(true);
    try {
      const result = await createShare({
        dropId: drop.id,
        type: drop.type,
        name: drop.name,
        content: drop.type === 'text' ? (drop.content || textContent) : undefined,
        imageData: drop.imageData || (isImage ? drop.fileData : undefined),
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

  // Theme colors
  const getThemeColors = () => {
    if (isMinimal) {
      return {
        borderColor: 'border-[#1A1A1A]/20',
        bgColor: 'bg-[#D4D8C8]',
        contentBg: 'bg-[#C5C9B8]',
        textColor: 'text-[#1A1A1A]',
        textMuted: 'text-[#1A1A1A]/30',
        textMuted2: 'text-[#1A1A1A]/50',
        headerBg: 'bg-[#1A1A1A]',
        fontClass: 'font-sans tracking-wide text-xs',
        roundedClass: 'rounded-lg',
        overlayBg: 'bg-[#1A1A1A]/70',
        skeletonBg: 'bg-[#1A1A1A]/10',
        skeletonPulse: 'animate-pulse bg-[#1A1A1A]/20',
      };
    }
    return {
      borderColor: isDark ? 'border-white/10' : 'border-[#1A1A1A]',
      bgColor: isDark ? 'bg-[#1A1A1A]' : 'bg-[#FAF7F2]',
      contentBg: isDark ? 'bg-[#0D0D0D]' : 'bg-[#F5F2ED]',
      textColor: isDark ? 'text-white' : 'text-[#1A1A1A]',
      textMuted: isDark ? 'text-white/30' : 'text-[#1A1A1A]/30',
      textMuted2: isDark ? 'text-white/50' : 'text-[#1A1A1A]/50',
      headerBg: 'bg-[#FF5A47]',
      fontClass: 'font-mono uppercase tracking-wider text-[10px]',
      roundedClass: '',
      overlayBg: 'bg-[#1A1A1A]/90',
      skeletonBg: isDark ? 'bg-white/10' : 'bg-[#1A1A1A]/10',
      skeletonPulse: isDark ? 'animate-pulse bg-white/20' : 'animate-pulse bg-[#1A1A1A]/20',
    };
  };

  const tc = getThemeColors();

  return (
    <div
      className={`fixed inset-0 ${tc.overlayBg} flex items-center justify-center z-50 p-4 transition-colors duration-300 overscroll-contain`}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className={`${tc.bgColor} border ${tc.borderColor} ${tc.roundedClass} w-full max-w-3xl max-h-[85vh] overflow-hidden flex flex-col transition-colors duration-300`}>
        {/* Header */}
        <div className={`border-b ${tc.borderColor} px-6 py-4 flex items-center justify-between ${tc.headerBg}`}>
          <div className="flex items-center gap-4">
            <div className={`w-10 h-10 border ${isMinimal ? 'border-white/30 rounded-lg' : 'border-white/30'} flex items-center justify-center`}>
              {drop.type === 'text' ? (
                <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
                  <path d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
              ) : isImage ? (
                <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
                  <path d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
              ) : (
                <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
                  <path d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
                </svg>
              )}
            </div>
            <div>
              <h2 className={`${isMinimal ? 'text-sm font-medium' : 'text-sm font-bold uppercase tracking-wider'} text-white truncate max-w-[300px]`} title={drop.name}>
                {drop.name}
              </h2>
              {drop.fileSize && (
                <p className={`${tc.fontClass} text-white/60`}>
                  {isMinimal ? formatFileSize(drop.fileSize).toLowerCase() : formatFileSize(drop.fileSize)}
                </p>
              )}
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-white/70 hover:text-white transition-colors"
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2">
              <path d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className={`flex-1 overflow-auto ${tc.contentBg} transition-colors duration-300`}>
          {/* Loading Skeleton */}
          {isLoading && (
            <div className="p-6 space-y-4">
              {/* Skeleton header */}
              <div className={`${tc.skeletonPulse} h-4 w-1/3 ${tc.roundedClass}`} />
              {/* Skeleton content lines */}
              <div className={`${tc.skeletonPulse} h-3 w-full ${tc.roundedClass}`} />
              <div className={`${tc.skeletonPulse} h-3 w-5/6 ${tc.roundedClass}`} />
              <div className={`${tc.skeletonPulse} h-3 w-4/5 ${tc.roundedClass}`} />
              <div className={`${tc.skeletonPulse} h-3 w-full ${tc.roundedClass}`} />
              <div className={`${tc.skeletonPulse} h-3 w-3/4 ${tc.roundedClass}`} />
              {/* Decrypting text */}
              <p className={`${tc.fontClass} ${tc.textMuted} text-center pt-4`}>
                {isMinimal ? 'Decrypting...' : 'DECRYPTING...'}
              </p>
            </div>
          )}

          {/* Text Snippet */}
          {!isLoading && drop.type === 'text' && (drop.content || drop.imageData) && (
            <div className="p-6 space-y-4">
              {drop.content && (
                <div className={`border ${tc.borderColor} ${tc.bgColor} p-4 ${tc.roundedClass}`}>
                  <pre className={`${isMinimal ? 'text-sm font-sans' : 'text-sm font-mono'} ${tc.textColor} whitespace-pre-wrap break-all`}>
                    {drop.content}
                  </pre>
                </div>
              )}
              {drop.imageData && (
                <div className="flex items-center justify-center">
                  <img
                    src={drop.imageData}
                    alt="Attached image"
                    className={`max-w-full max-h-[50vh] border ${tc.borderColor} object-contain ${tc.roundedClass}`}
                  />
                </div>
              )}
            </div>
          )}

          {/* Image Preview */}
          {!isLoading && drop.type === 'file' && isImage && drop.fileData && (
            <div className="flex items-center justify-center p-6 min-h-[300px]">
              <img
                src={drop.fileData}
                alt={drop.name}
                className={`max-w-full max-h-[60vh] border ${tc.borderColor} object-contain ${tc.roundedClass}`}
              />
            </div>
          )}

          {/* Text File Preview */}
          {!isLoading && drop.type === 'file' && isText && drop.fileData && (
            <div className="p-6">
              <div className={`border ${tc.borderColor} ${tc.bgColor} p-4 ${tc.roundedClass}`}>
                <pre className={`${isMinimal ? 'text-sm font-sans' : 'text-sm font-mono'} ${tc.textColor} whitespace-pre-wrap overflow-x-auto`}>
                  {textContent}
                </pre>
              </div>
            </div>
          )}

          {/* Other File Types */}
          {!isLoading && drop.type === 'file' && !isImage && !isText && (
            <div className="flex flex-col items-center justify-center py-16 px-6">
              <div className={`w-20 h-20 border ${tc.borderColor} flex items-center justify-center mb-4 ${tc.roundedClass}`}>
                <svg className={`w-8 h-8 ${tc.textMuted}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
                </svg>
              </div>
              <p className={`${isMinimal ? 'text-sm font-medium tracking-wide' : 'text-xs font-semibold uppercase tracking-wider'} ${tc.textColor}`}>
                {isMinimal ? 'Preview not available' : 'PREVIEW_NOT_AVAILABLE'}
              </p>
              <p className={`${tc.fontClass} ${tc.textMuted2} mt-1`}>
                {isMinimal ? 'Download to view' : 'DOWNLOAD_TO_VIEW'}
              </p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className={`border-t ${tc.borderColor} px-6 py-4 flex justify-end gap-3 ${tc.bgColor} transition-colors duration-300`}>
          {youtubeVideoId && (
            <button
              onClick={() => window.open(`https://www.youtube.com/watch?v=${youtubeVideoId}`, '_blank')}
              className={`border ${tc.borderColor} ${tc.textColor} px-5 py-2 text-xs tracking-wider hover:bg-[#FF0000] hover:text-white hover:border-[#FF0000] transition-colors flex items-center gap-2 ${isMinimal ? 'rounded-full' : ''}`}
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/>
              </svg>
              {isMinimal ? 'Watch on YouTube' : 'WATCH_ON_YOUTUBE'}
            </button>
          )}
          <button
            onClick={handleShare}
            disabled={isSharing}
            className={`border ${tc.borderColor} ${tc.textColor} px-5 py-2 text-xs tracking-wider hover:bg-[#1A1A1A] hover:text-white transition-colors flex items-center gap-2 disabled:opacity-50 ${isMinimal ? 'rounded-full' : ''}`}
          >
            {shareCopied ? (
              <>
                <svg className={`w-4 h-4 ${isMinimal ? 'text-[#1A1A1A]' : 'text-[#FF5A47]'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path d="M5 13l4 4L19 7" />
                </svg>
                {isMinimal ? 'Link copied' : 'LINK_COPIED'}
              </>
            ) : (
              <>
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
                  <path d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" />
                </svg>
                {isMinimal ? 'Share' : 'SHARE'}
              </>
            )}
          </button>
          <button
            onClick={onClose}
            className={`border ${tc.borderColor} ${tc.textColor} px-5 py-2 text-xs tracking-wider hover:bg-[#1A1A1A] hover:text-white transition-colors ${isMinimal ? 'rounded-full' : ''}`}
          >
            {isMinimal ? 'Close' : 'CLOSE'}
          </button>
          {isText && textContent && (
            <button
              onClick={handleCopy}
              className={`border ${tc.borderColor} ${tc.textColor} px-5 py-2 text-xs tracking-wider hover:bg-[#1A1A1A] hover:text-white transition-colors flex items-center gap-2 ${isMinimal ? 'rounded-full' : ''}`}
            >
              {copied ? (
                <>
                  <svg className={`w-4 h-4 ${isMinimal ? 'text-[#1A1A1A]' : 'text-[#FF5A47]'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path d="M5 13l4 4L19 7" />
                  </svg>
                  {isMinimal ? 'Copied' : 'COPIED'}
                </>
              ) : (
                <>
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
                    <path d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                  </svg>
                  {isMinimal ? 'Copy' : 'COPY'}
                </>
              )}
            </button>
          )}
          {drop.type === 'text' && drop.imageData && (
            <button
              onClick={() => {
                const link = document.createElement('a');
                link.href = drop.imageData!;
                link.download = `image-${drop.name}.png`;
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);
              }}
              className="bg-[#1A1A1A] text-white px-5 py-2 text-xs tracking-wider hover:bg-[#2A2A2A] transition-colors flex items-center gap-2"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
                <path d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
              {isMinimal ? 'Download image' : 'DOWNLOAD_IMAGE'}
            </button>
          )}
          {drop.type === 'file' && drop.fileData && (
            <button
              onClick={handleDownload}
              className="bg-[#1A1A1A] text-white px-5 py-2 text-xs tracking-wider hover:bg-[#2A2A2A] transition-colors flex items-center gap-2"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
                <path d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
              {isMinimal ? 'Download' : 'DOWNLOAD'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
