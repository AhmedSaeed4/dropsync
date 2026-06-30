'use client';

import { useState, useEffect } from 'react';
import { Drop } from '@/types';
import { useBodyScrollLock } from '@/hooks/useBodyScrollLock';
import { useModalBackClose } from '@/hooks/useModalBackClose';
import { formatFileSize, getYouTubeVideoId } from '@/lib/drops';
import { createShare } from '@/lib/shares';
import { downloadBinaryFromUrl } from '@/lib/download';
import { contentToPlainText } from '@/lib/dropTagUtils';
import { DropMentionContent } from './DropMentionContent';
import { LockedActionButton } from './LockedActionButton';

interface PreviewModalProps {
  drop: Drop;
  onClose: () => void;
  theme?: 'light' | 'dark' | 'minimal';
  isLoading?: boolean;
  onEdit?: (drop: Drop) => void;
  onMove?: (drop: Drop) => void;
  // Current space's drops — resolve #[Name](id) chips inline; clicking swaps the preview.
  allDrops?: Drop[];
  onPreview?: (drop: Drop) => void;
  // Creator/workspace owner — may still Edit/Move a locked drop. Non-creators see faded gates.
  canMutate?: boolean;
}

function isTextFile(drop: Drop): boolean {
  if (drop.type === 'text') return true;
  const textMimeTypes = ['text/', 'application/json', 'application/xml'];
  const textExtensions = ['.txt', '.md', '.json', '.csv', '.xml', '.html', '.css', '.js', '.ts', '.jsx', '.tsx'];
  return textMimeTypes.some(t => drop.mimeType?.startsWith(t)) ||
         textExtensions.some(ext => drop.name.toLowerCase().endsWith(ext));
}

export function PreviewModal({ drop, onClose, theme = 'light', isLoading = false, onEdit, onMove, allDrops = [], onPreview, canMutate = false }: PreviewModalProps) {
  useBodyScrollLock();
  useModalBackClose(true, onClose);
  const [copied, setCopied] = useState(false);
  const [shareCopied, setShareCopied] = useState(false);
  const [isSharing, setIsSharing] = useState(false);
  const isImage = drop.mimeType?.startsWith('image/');
  const isVideo = drop.mimeType?.startsWith('video/');
  const isText = isTextFile(drop);
  const isDark = theme === 'dark';
  const isMinimal = theme === 'minimal';

  const SUPPORTED_VIDEO_TYPES = new Set(['video/mp4', 'video/webm', 'video/ogg']);
  const isSupportedVideo = isVideo && SUPPORTED_VIDEO_TYPES.has(drop.mimeType || '');

  const [showPlayer, setShowPlayer] = useState(false);

  // Video blob URL: fetch data URL → Blob → blob URL (handles binary data correctly)
  const [videoSrc, setVideoSrc] = useState<string | null>(null);
  // Whether the <video> has buffered enough to play (onCanPlay). False while buffering → the app's
  // "Loading video..." overlay covers the browser's native loading spinner. Reset whenever the src
  // actually changes (binary OR legacy) so the overlay re-shows for a new video.
  const [videoReady, setVideoReady] = useState(false);

  useEffect(() => {
    if (!isVideo) return;

    // Binary (unencrypted large) video: stream the R2 URL directly — no fetch/decode. The object
    // is served with its real Content-Type, so the browser range-requests + streams it.
    if (drop.fileFormat === 'binary' && drop.fileUrl) {
      setVideoSrc(drop.fileUrl);
      return;
    }

    let url: string | null = null;
    let cancelled = false;

    if (drop.fileData && drop.fileData.startsWith('data:')) {
      // Encrypted video: data URL → blob
      fetch(drop.fileData)
        .then(res => res.blob())
        .then(blob => {
          if (!cancelled) {
            url = URL.createObjectURL(blob);
            setVideoSrc(url);
          }
        })
        .catch(() => { if (!cancelled) setVideoSrc(null); });
    } else if (drop.fileUrl) {
      // Unencrypted video: fetch from R2 — may be raw binary or data URL string
      fetch(drop.fileUrl)
        .then(res => res.text())
        .then(text => {
          if (cancelled) return;
          if (text.startsWith('data:')) {
            // Stored as data URL string — convert to blob via fetch
            return fetch(text).then(r => r.blob());
          }
          // Raw binary — wrap with correct MIME type
          return new Blob([text], { type: drop.mimeType || 'video/mp4' });
        })
        .then(blob => {
          if (!cancelled && blob) {
            url = URL.createObjectURL(blob);
            setVideoSrc(url);
          }
        })
        .catch(() => { if (!cancelled) setVideoSrc(null); });
    } else {
      setVideoSrc(null);
    }

    return () => {
      cancelled = true;
      if (url && !url.startsWith('http')) {
        URL.revokeObjectURL(url);
      }
    };
  }, [isVideo, drop.fileData, drop.fileUrl, drop.fileFormat]);

  // Reset the ready flag only when the source actually changes (not on every effect re-run), so
  // the overlay shows for a new video and hides once onCanPlay fires for it. onError also clears
  // it so a failed load never leaves the overlay permanently covering the video.
  useEffect(() => {
    setVideoReady(false);
  }, [videoSrc]);

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

  const handleDownload = async () => {
    // Binary (unencrypted large) file — fetch the public R2 URL as a Blob and download via a
    // same-origin blob: URL (filename honored). The legacy data-URI path below corrupts real
    // binary bytes, so it must not run for binary drops.
    if (drop.fileFormat === 'binary' && drop.fileUrl) {
      try {
        await downloadBinaryFromUrl(drop.fileUrl, drop.name);
      } catch (error) {
        console.error('Download failed:', error);
      }
      return;
    }
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
      await navigator.clipboard.writeText(contentToPlainText(content));
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
        fileData: !isImage && drop.type === 'file' ? drop.fileData : undefined,
        fileUrl: !isImage && drop.type === 'file' && !drop.fileData ? drop.fileUrl : undefined,
        fileFormat: drop.fileFormat,
        mimeType: drop.mimeType || undefined,
        fileSize: drop.fileSize || undefined,
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
              ) : isVideo ? (
                <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
                  <path strokeLinecap="round" strokeLinejoin="round" d="m15.75 10.5 4.72-4.72a.75.75 0 0 1 1.28.53v11.38a.75.75 0 0 1-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 0 0 2.25-2.25v-9a2.25 2.25 0 0 0-2.25-2.25h-9A2.25 2.25 0 0 0 2.25 7.5v9a2.25 2.25 0 0 0 2.25 2.25Z" />
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
                    <DropMentionContent
                      content={drop.content}
                      allDrops={allDrops}
                      onPreview={onPreview}
                      foundClassName={`inline-flex items-center mx-0.5 px-1.5 py-0.5 align-middle text-[13px] ${isMinimal ? 'rounded-full font-sans' : 'font-mono'} ${isMinimal ? 'bg-[#1A1A1A]' : 'bg-[#FF5A47]'} text-white hover:opacity-80`}
                      deletedClassName={`inline-flex items-center mx-0.5 px-1.5 py-0.5 align-middle text-[13px] ${isMinimal ? 'rounded-full font-sans' : 'font-mono'} bg-[#1A1A1A]/10 ${tc.textMuted2} line-through cursor-not-allowed`}
                    />
                  </pre>
                </div>
              )}
              {drop.imageData && (
                <div className="flex items-center justify-center">
                  <img
                    src={drop.imageData}
                    alt="Attached image"
                    className={`border ${tc.borderColor} object-contain ${tc.roundedClass} ${
                      drop.isDrawing
                        ? 'max-w-[80%] max-h-[50vh]'
                        : 'max-w-full max-h-[50vh]'
                    }`}
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

          {/* YouTube Player */}
          {!isLoading && youtubeVideoId && (
            <div className="p-6 pt-0">
              <div className="grid transition-[grid-template-rows] duration-300 ease-in-out" style={{ gridTemplateRows: showPlayer ? '1fr' : '0fr' }}>
                <div className="overflow-hidden">
                  <div className="aspect-video">
                    <iframe
                      src={`https://www.youtube.com/embed/${youtubeVideoId}`}
                      className="w-full h-full"
                      allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                      allowFullScreen
                    />
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Video Preview */}
          {!isLoading && drop.type === 'file' && isVideo && (
            <div className="flex items-center justify-center p-6 min-h-[300px]">
              {isSupportedVideo && videoSrc ? (
                <div className={`relative aspect-video max-h-[60vh] w-full overflow-hidden border ${tc.borderColor} ${tc.roundedClass} bg-black`}>
                  <video
                    src={videoSrc}
                    controls
                    onCanPlay={() => setVideoReady(true)}
                    onError={() => setVideoReady(true)}
                    className={`h-full w-full object-contain ${videoReady ? '' : 'opacity-0'}`}
                  >
                    Your browser does not support video playback.
                  </video>
                  {!videoReady && (
                    <div className="absolute inset-0 flex items-center justify-center bg-black/50">
                      <div className={`animate-pulse ${tc.textMuted} ${tc.fontClass}`}>Loading video...</div>
                    </div>
                  )}
                </div>
              ) : !isSupportedVideo ? (
                <div className="flex flex-col items-center justify-center">
                  <div className={`w-20 h-20 border ${tc.borderColor} flex items-center justify-center mb-4 ${tc.roundedClass}`}>
                    <svg className={`w-8 h-8 ${tc.textMuted}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
                      <path strokeLinecap="round" strokeLinejoin="round" d="m15.75 10.5 4.72-4.72a.75.75 0 0 1 1.28.53v11.38a.75.75 0 0 1-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 0 0 2.25-2.25v-9a2.25 2.25 0 0 0-2.25-2.25h-9A2.25 2.25 0 0 0 2.25 7.5v9a2.25 2.25 0 0 0 2.25 2.25Z" />
                    </svg>
                  </div>
                  <p className={`${isMinimal ? 'text-sm font-medium tracking-wide' : 'text-xs font-semibold uppercase tracking-wider'} ${tc.textColor}`}>
                    {isMinimal ? 'Video preview not available' : 'VIDEO_PREVIEW_NOT_AVAILABLE'}
                  </p>
                  <p className={`${tc.fontClass} ${tc.textMuted2} mt-1`}>
                    {isMinimal ? 'Download to watch' : 'DOWNLOAD_TO_WATCH'}
                  </p>
                </div>
              ) : (
                <div className={`animate-pulse ${tc.textMuted} ${tc.fontClass}`}>Loading video...</div>
              )}
            </div>
          )}

          {/* Other File Types */}
          {!isLoading && drop.type === 'file' && !isImage && !isVideo && !isText && (
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
        <div className={`border-t ${tc.borderColor} px-4 py-3 sm:px-6 sm:py-4 flex flex-wrap justify-end gap-2 sm:gap-3 ${tc.bgColor} transition-colors duration-300`}>
          {youtubeVideoId && (
            <button
              onClick={() => setShowPlayer(p => !p)}
              className={`border ${tc.borderColor} ${tc.textColor} px-3 py-1.5 sm:px-5 sm:py-2 text-xs tracking-wider hover:bg-[#FF0000] hover:text-white hover:border-[#FF0000] transition-colors flex items-center gap-2 ${isMinimal ? 'rounded-full' : ''}`}
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                <path d="M8 5v14l11-7z" />
              </svg>
              {showPlayer ? (isMinimal ? 'Close' : 'CLOSE') : (isMinimal ? 'Watch' : 'WATCH')}
            </button>
          )}
          <button
            onClick={handleShare}
            disabled={isSharing}
            className={`border ${tc.borderColor} ${tc.textColor} px-3 py-1.5 sm:px-5 sm:py-2 text-xs tracking-wider hover:bg-[#1A1A1A] hover:text-white transition-colors flex items-center gap-2 disabled:opacity-50 ${isMinimal ? 'rounded-full' : ''}`}
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
            className={`border ${tc.borderColor} ${tc.textColor} px-3 py-1.5 sm:px-5 sm:py-2 text-xs tracking-wider hover:bg-[#1A1A1A] hover:text-white transition-colors ${isMinimal ? 'rounded-full' : ''}`}
          >
            {isMinimal ? 'Close' : 'CLOSE'}
          </button>
          {isText && textContent && (
            <button
              onClick={handleCopy}
              className={`border ${tc.borderColor} ${tc.textColor} px-3 py-1.5 sm:px-5 sm:py-2 text-xs tracking-wider hover:bg-[#1A1A1A] hover:text-white transition-colors flex items-center gap-2 ${isMinimal ? 'rounded-full' : ''}`}
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
              className="bg-[#1A1A1A] text-white px-3 py-1.5 sm:px-5 sm:py-2 text-xs tracking-wider hover:bg-[#2A2A2A] transition-colors flex items-center gap-2"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
                <path d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
              {isMinimal ? 'Save' : 'SAVE'}
            </button>
          )}
          {/* Move button — opens the move/copy modal for everyone (Copy is reachable via the in-modal toggle). */}
          {onMove && (
            <button
              onClick={() => onMove(drop)}
              className={`border ${tc.borderColor} ${tc.textColor} px-3 py-1.5 sm:px-5 sm:py-2 text-xs tracking-wider hover:bg-[#1A1A1A] hover:text-white transition-colors flex items-center gap-2 ${isMinimal ? 'rounded-full' : ''}`}
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 7.5L7.5 3m0 0L12 7.5M7.5 3v13.5M12 16.5l4.5-4.5m0 0L21 16.5M16.5 12V3" />
              </svg>
              {isMinimal ? 'Move' : 'MOVE'}
            </button>
          )}
          {/* Edit button */}
          {onEdit && (
            drop.locked && !canMutate ? (
              <LockedActionButton
                context="edit"
                variant="classic"
                theme={theme}
                className={`border ${tc.borderColor} ${tc.textColor} px-3 py-1.5 sm:px-5 sm:py-2 text-xs tracking-wider transition-colors flex items-center gap-2 ${isMinimal ? 'rounded-full' : ''}`}
                icon={
                  <>
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0115.75 21H5.25A2.25 2.25 0 013 18.75V8.25A2.25 2.25 0 015.25 6H10" />
                    </svg>
                    {drop.isDrawing
                      ? (isMinimal ? 'Edit drawing' : 'EDIT_DRAWING')
                      : (isMinimal ? 'Edit' : 'EDIT')}
                  </>
                }
              />
            ) : (
              <button
                onClick={() => onEdit(drop)}
                className={`border ${tc.borderColor} ${tc.textColor} px-3 py-1.5 sm:px-5 sm:py-2 text-xs tracking-wider hover:bg-[#1A1A1A] hover:text-white transition-colors flex items-center gap-2 ${isMinimal ? 'rounded-full' : ''}`}
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0115.75 21H5.25A2.25 2.25 0 013 18.75V8.25A2.25 2.25 0 015.25 6H10" />
                </svg>
                {drop.isDrawing
                  ? (isMinimal ? 'Edit drawing' : 'EDIT_DRAWING')
                  : (isMinimal ? 'Edit' : 'EDIT')
                }
              </button>
            )
          )}
          {drop.type === 'file' && drop.fileData && (
            <button
              onClick={handleDownload}
              className="bg-[#1A1A1A] text-white px-3 py-1.5 sm:px-5 sm:py-2 text-xs tracking-wider hover:bg-[#2A2A2A] transition-colors flex items-center gap-2"
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
