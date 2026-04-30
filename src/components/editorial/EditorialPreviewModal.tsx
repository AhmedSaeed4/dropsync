'use client';

import { useState } from 'react';
import { Drop } from '@/types';
import { useBodyScrollLock } from '@/hooks/useBodyScrollLock';
import { formatFileSize, getYouTubeVideoId } from '@/lib/drops';
import { createShare } from '@/lib/shares';
import { getEditorialThemeColors } from './editorialTheme';

interface EditorialPreviewModalProps {
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

export function EditorialPreviewModal({ drop, onClose, theme = 'light', isLoading = false }: EditorialPreviewModalProps) {
  useBodyScrollLock();
  const [copied, setCopied] = useState(false);
  const [shareCopied, setShareCopied] = useState(false);
  const [isSharing, setIsSharing] = useState(false);
  const isImage = drop.mimeType?.startsWith('image/');
  const isText = isTextFile(drop);

  const tc = getEditorialThemeColors(theme);

  const getTextContent = () => {
    if (drop.type === 'text' && drop.content) return drop.content;
    if (!drop.fileData) return '';
    try {
      const base64 = drop.fileData.split(',')[1];
      return atob(base64);
    } catch {
      return 'Unable to decode content';
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

  const handleDownloadImage = () => {
    if (drop.imageData) {
      const link = document.createElement('a');
      link.href = drop.imageData;
      link.download = `${drop.name}-image.png`;
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

  return (
    <div
      className={`fixed inset-0 bg-[#1a1a1a]/60 flex items-center justify-center z-50 p-4 transition-colors duration-300 overscroll-contain`}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className={`${tc.bg} border ${tc.border} rounded-xl w-full max-w-3xl max-h-[85vh] overflow-hidden flex flex-col transition-colors duration-300 shadow-xl`}>
        {/* Header */}
        <div className={`border-b ${tc.border} px-5 py-4 flex items-center justify-between`}>
          <div className="flex items-center gap-3">
            <div className={`w-9 h-9 border ${tc.border} rounded-lg flex items-center justify-center`}>
              {drop.type === 'text' ? (
                <svg className={`w-4 h-4 ${tc.text}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
              ) : isImage ? (
                <svg className={`w-4 h-4 ${tc.text}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
              ) : (
                <svg className={`w-4 h-4 ${tc.text}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
                </svg>
              )}
            </div>
            <div>
              <h2 className={`${tc.fontClass} ${tc.text} font-medium text-[15px] line-clamp-2 max-w-[280px]`} title={drop.name}>
                {drop.name}
              </h2>
              {drop.fileSize && (
                <p className={`text-xs ${tc.muted} ${tc.fontClass}`}>
                  {formatFileSize(drop.fileSize)}
                </p>
              )}
            </div>
          </div>
          <button
            onClick={onClose}
            className={`${tc.muted} hover:${tc.text} transition-colors p-1`}
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className={`flex-1 overflow-auto ${tc.bg} transition-colors duration-300`}>
          {/* Loading Skeleton */}
          {isLoading && (
            <div className="p-6 space-y-4">
              <div className="animate-pulse bg-[#1a1a1a]/10 h-4 w-1/3 rounded" />
              <div className="animate-pulse bg-[#1a1a1a]/10 h-3 w-full rounded" />
              <div className="animate-pulse bg-[#1a1a1a]/10 h-3 w-5/6 rounded" />
              <div className="animate-pulse bg-[#1a1a1a]/10 h-3 w-4/5 rounded" />
              <p className={`${tc.fontClass} ${tc.muted} text-sm text-center pt-4`}>
                Decrypting...
              </p>
            </div>
          )}

          {/* Text Snippet */}
          {!isLoading && drop.type === 'text' && (drop.content || drop.imageData) && (
            <div className="p-5 space-y-4">
              {drop.content && (
                <div className={`border ${tc.border} ${tc.bg} rounded-lg p-4`}>
                  <pre className={`text-sm ${tc.fontClass} ${tc.text} whitespace-pre-wrap break-all`}>
                    {drop.content}
                  </pre>
                </div>
              )}
              {drop.imageData && (
                <div className="rounded-lg overflow-hidden border ${tc.border}">
                  <img src={drop.imageData} alt="Attached" className="max-w-full h-auto" />
                </div>
              )}
            </div>
          )}

          {/* Text File */}
          {!isLoading && isText && drop.fileData && (
            <div className="p-5">
              <div className={`border ${tc.border} ${tc.bg} rounded-lg p-4`}>
                <pre className={`text-sm ${tc.fontClass} ${tc.text} whitespace-pre-wrap break-all max-h-[50vh] overflow-auto`}>
                  {textContent}
                </pre>
              </div>
            </div>
          )}

          {/* Image */}
          {!isLoading && isImage && drop.fileData && (
            <div className="p-5 flex items-center justify-center">
              <img
                src={drop.fileData}
                alt={drop.name}
                className="max-w-full max-h-[50vh] object-contain rounded-lg border ${tc.border}"
              />
            </div>
          )}

          {/* Other Files */}
          {!isLoading && !isText && !isImage && drop.fileData && (
            <div className="p-5 flex flex-col items-center justify-center min-h-[200px]">
              <div className={`w-16 h-16 border ${tc.border} rounded-lg flex items-center justify-center mb-4`}>
                <svg className={`w-8 h-8 ${tc.muted}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
                </svg>
              </div>
              <p className={`${tc.fontClass} ${tc.muted} text-sm`}>
                Preview not available for this file type
              </p>
            </div>
          )}
        </div>

        {/* Actions */}
        <div className={`border-t ${tc.border} px-5 py-4 flex items-center justify-between`}>
          <div className="flex items-center gap-2">
            {/* Copy (for text) */}
            {(drop.type === 'text' || isText) && (
              <button
                onClick={handleCopy}
                className={`flex items-center gap-2 px-4 py-2 rounded-md border ${tc.border} ${tc.text} hover:border-[#1a1a1a] transition-all text-sm ${tc.fontClass}`}
              >
                {copied ? (
                  <>
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                    Copied
                  </>
                ) : (
                  <>
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                    </svg>
                    Copy
                  </>
                )}
              </button>
            )}

            {/* YouTube */}
            {youtubeVideoId && (
              <button
                onClick={() => window.open(`https://www.youtube.com/watch?v=${youtubeVideoId}`, '_blank')}
                className={`flex items-center gap-2 px-2 sm:px-4 py-2 rounded-md border ${tc.border} ${tc.text} hover:bg-[#FF0000] hover:text-white hover:border-[#FF0000] transition-all text-sm ${tc.fontClass}`}
                title="Watch on YouTube"
              >
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/>
                </svg>
                <span className="hidden sm:inline">Watch on YouTube</span>
              </button>
            )}

            {/* Download */}
            {drop.fileData && (
              <button
                onClick={handleDownload}
                className={`flex items-center gap-2 px-2 sm:px-4 py-2 rounded-md border ${tc.border} ${tc.text} hover:border-[#1a1a1a] transition-all text-sm ${tc.fontClass}`}
                title="Download"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                </svg>
                <span className="hidden sm:inline">Download</span>
              </button>
            )}

            {/* Download Image (for text drops with attached images) */}
            {drop.imageData && (
              <button
                onClick={handleDownloadImage}
                className={`flex items-center gap-2 px-2 sm:px-4 py-2 rounded-md border ${tc.border} ${tc.text} hover:border-[#1a1a1a] transition-all text-sm ${tc.fontClass}`}
                title="Download Image"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                </svg>
                <span className="hidden sm:inline">Download Image</span>
              </button>
            )}
          </div>

          {/* Share */}
          <button
            onClick={handleShare}
            disabled={isSharing}
            className={`flex items-center gap-2 px-4 py-2 rounded-md ${tc.activePillBg} ${tc.activePillText} hover:opacity-90 transition-all text-sm ${tc.fontClass} disabled:opacity-50`}
          >
            {isSharing ? (
              <>
                <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
                Sharing...
              </>
            ) : shareCopied ? (
              <>
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
                Link Copied
              </>
            ) : (
              <>
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" />
                </svg>
                Share
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
