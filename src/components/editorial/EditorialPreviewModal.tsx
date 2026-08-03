'use client';

import { useState, useEffect } from 'react';
import { Drop } from '@/types';
import { useBodyScrollLock } from '@/hooks/useBodyScrollLock';
import { useModalBackClose } from '@/hooks/useModalBackClose';
import { useNow } from '@/hooks/useNow';
import { formatFileSize, getYouTubeVideoId, updateDropMetadata, isReminderGlowingForViewer, formatReminderFire } from '@/lib/drops';
import { createShare } from '@/lib/shares';
import { downloadBinaryFromUrl } from '@/lib/download';
import { contentToPlainText } from '@/lib/dropTagUtils';
import { getEditorialThemeColors } from './editorialTheme';
import { DropMentionContent } from '../DropMentionContent';
import { LockedActionButton } from '../LockedActionButton';

const YOUTUBE_PLAYER_TRANSITION = 'transition-[grid-template-rows] duration-300 ease-in-out';

interface EditorialPreviewModalProps {
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
  // Current viewer — drives the per-viewer reminder glow (dismiss visibility) + the reminder-setBy.
  currentUserId?: string;
}

function isTextFile(drop: Drop): boolean {
  if (drop.type === 'text') return true;
  const textMimeTypes = ['text/', 'application/json', 'application/xml'];
  const textExtensions = ['.txt', '.md', '.json', '.csv', '.xml', '.html', '.css', '.js', '.ts', '.jsx', '.tsx'];
  return textMimeTypes.some(t => drop.mimeType?.startsWith(t)) ||
         textExtensions.some(ext => drop.name.toLowerCase().endsWith(ext));
}

export function EditorialPreviewModal({ drop, onClose, theme = 'light', isLoading = false, onEdit, onMove, allDrops = [], onPreview, canMutate = false, currentUserId }: EditorialPreviewModalProps) {
  useBodyScrollLock();
  useModalBackClose(true, onClose);
  const [copied, setCopied] = useState(false);
  const [shareCopied, setShareCopied] = useState(false);
  const [isSharing, setIsSharing] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);
  const isImage = drop.mimeType?.startsWith('image/');
  const isVideo = drop.mimeType?.startsWith('video/');
  const isText = isTextFile(drop);

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

    return () => {
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

  const tc = getEditorialThemeColors(theme);

  // In-app reminder DISMISS (footer, next to Edit). The set/change/turn-off controls moved to the
  // Edit modal (EditorialTextModal). Light path via updateDropMetadata (never updateTextDrop).
  // Live "now" drives the header fire-time countdown AND the per-viewer glow (a reminder that fires
  // while the modal is open starts glowing without a reopen). 30s tick — light.
  const now = useNow();
  const reminderGlowing = isReminderGlowingForViewer(drop, currentUserId, now);
  // Header fire-time preview (next to the drop name) when this drop has a reminder. "Due …" once past.
  const reminderFire = drop.reminderAt ? formatReminderFire(drop.reminderAt, now) : null;
  const handleReminderDismiss = async () => {
    if (!currentUserId) return;
    // On a locked drop only creator/owner (canMutate) may write; the Dismiss button is gated to
    // LockedActionButton below, so this is defense-in-depth.
    if (drop.locked && !canMutate) return;
    // Any dismiss clears the glow for non-creators; the creator keeps glowing until they dismiss
    // themselves (see isReminderGlowingForViewer).
    await updateDropMetadata(drop.id, { reminderDismissedBy: currentUserId });
  };

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
      await navigator.clipboard.writeText(contentToPlainText(content));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const textContent = isText ? getTextContent() : '';
  const youtubeVideoId = textContent ? getYouTubeVideoId(textContent) : null;

  const handleShare = async () => {
    if (drop.type === 'call') return;
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

  const fullscreenIcon = isFullscreen ? (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 9V4.5M9 9H4.5M9 9L3.75 3.75M9 15v4.5M9 15H4.5M9 15l-5.25 5.25M15 9h4.5M15 9V4.5M15 9l5.25-5.25M15 15h4.5M15 15v4.5m0-4.5l5.25 5.25" />
    </svg>
  ) : (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 3.75v4.5m0-4.5h4.5m-4.5 0L9 9M3.75 20.25v-4.5m0 4.5h4.5m-4.5 0L9 15M20.25 3.75h-4.5m4.5 0v4.5m-4.5-4.5L15 9m5.25 11.25h-4.5m4.5 0v-4.5m0 4.5L15 15" />
    </svg>
  );

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
              {drop.type === 'call' ? (
                <svg className={`w-4 h-4 ${tc.text}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 6.75c0 8.284 6.716 15 15 15h2.25a2.25 2.25 0 002.25-2.25v-1.372c0-.516-.351-.966-.852-1.091l-4.423-1.106c-.44-.11-.902.055-1.173.417l-.97 1.293c-.282.376-.769.542-1.21.38a12.035 12.035 0 01-7.143-7.143c-.162-.441.004-.928.38-1.21l1.293-.97c.363-.271.527-.734.417-1.173L6.963 3.102a1.125 1.125 0 00-1.091-.852H4.5A2.25 2.25 0 002.25 4.5v2.25z" />
                </svg>
              ) : drop.type === 'text' ? (
                <svg className={`w-4 h-4 ${tc.text}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
              ) : isImage ? (
                <svg className={`w-4 h-4 ${tc.text}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
              ) : isVideo ? (
                <svg className={`w-4 h-4 ${tc.text}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
                  <path strokeLinecap="round" strokeLinejoin="round" d="m15.75 10.5 4.72-4.72a.75.75 0 0 1 1.28.53v11.38a.75.75 0 0 1-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 0 0 2.25-2.25v-9a2.25 2.25 0 0 0-2.25-2.25h-9A2.25 2.25 0 0 0 2.25 7.5v9a2.25 2.25 0 0 0 2.25 2.25Z" />
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
              {reminderFire && (
                <p className={`text-xs ${tc.muted} ${tc.fontClass}`}>
                  {reminderFire.fired ? 'Due ' : 'Fires '}{reminderFire.absolute}{reminderFire.remaining ? ` · ${reminderFire.remaining}` : ''}
                </p>
              )}
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
                <div
                  className={isFullscreen ? 'fixed inset-0 z-[999] bg-black/40 flex items-center justify-center p-4' : 'relative'}
                  onClick={(e) => isFullscreen && e.target === e.currentTarget && setIsFullscreen(false)}
                >
                  <div className={`relative border ${tc.border} ${tc.bg} rounded-lg ${isFullscreen ? 'w-full h-[calc(100vh-32px)] overflow-hidden p-4' : 'p-4'}`}>
                    <button
                      type="button"
                      onClick={() => setIsFullscreen(!isFullscreen)}
                      className={`absolute top-2 right-2 z-10 w-8 h-8 flex items-center justify-center ${tc.btnBg} ${tc.text} ${tc.btnHoverBg} ${tc.btnHoverText} ${tc.roundedClass} transition-colors`}
                      title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
                    >
                      {fullscreenIcon}
                    </button>
                    <pre className={`text-sm ${tc.fontClass} ${tc.text} whitespace-pre-wrap break-all ${isFullscreen ? 'h-full overflow-y-auto' : ''}`}>
                      <DropMentionContent
                        content={drop.content}
                        allDrops={allDrops}
                        onPreview={onPreview}
                        foundClassName={`inline-flex items-center mx-0.5 px-1.5 py-0.5 align-middle rounded text-[13px] ${tc.fontClass} ${tc.activePillBg} ${tc.activePillText} hover:opacity-80`}
                        deletedClassName={`inline-flex items-center mx-0.5 px-1.5 py-0.5 align-middle rounded text-[13px] ${tc.fontClass} ${tc.inactivePillBg} ${tc.muted} line-through cursor-not-allowed`}
                      />
                    </pre>
                  </div>
                </div>
              )}
              {drop.imageData && (
                <div className="flex items-center justify-center">
                  <img
                    src={drop.imageData}
                    alt="Attached"
                    className={`rounded-lg object-contain ${
                      drop.isDrawing
                        ? 'max-w-[80%] max-h-[50vh] border'
                        : 'max-w-full h-auto'
                    }`}
                  />
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

          {/* YouTube Player */}
          {!isLoading && youtubeVideoId && (
            <div className="p-5 pt-0">
              <div className="grid transition-[grid-template-rows] duration-300 ease-in-out" style={{ gridTemplateRows: showPlayer ? '1fr' : '0fr' }}>
                <div className="overflow-hidden">
                  <div className="aspect-video rounded-lg overflow-hidden">
                    <iframe
                      src={`https://www.youtube-nocookie.com/embed/${youtubeVideoId}`}
                      className="w-full h-full"
                      allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                      allowFullScreen
                    />
                  </div>
                </div>
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

          {/* Video Preview */}
          {!isLoading && drop.type === 'file' && isVideo && (
            <div className="flex items-center justify-center p-5 min-h-[300px]">
              {isSupportedVideo && videoSrc ? (
                <div className={`relative aspect-video max-h-[50vh] w-full overflow-hidden rounded-lg border ${tc.border} bg-black`}>
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
                      <div className={`animate-pulse ${tc.muted} ${tc.fontClass}`}>Loading video...</div>
                    </div>
                  )}
                </div>
              ) : !isSupportedVideo ? (
                <div className="flex flex-col items-center justify-center">
                  <div className={`w-16 h-16 border ${tc.border} rounded-lg flex items-center justify-center mb-4`}>
                    <svg className={`w-8 h-8 ${tc.muted}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
                      <path strokeLinecap="round" strokeLinejoin="round" d="m15.75 10.5 4.72-4.72a.75.75 0 0 1 1.28.53v11.38a.75.75 0 0 1-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 0 0 2.25-2.25v-9a2.25 2.25 0 0 0-2.25-2.25h-9A2.25 2.25 0 0 0 2.25 7.5v9a2.25 2.25 0 0 0 2.25 2.25Z" />
                    </svg>
                  </div>
                  <p className={`${tc.fontClass} ${tc.muted} text-sm`}>
                    Video preview not available for this format
                  </p>
                  <p className={`${tc.fontClass} ${tc.muted} text-xs mt-1`}>
                    Download to watch
                  </p>
                </div>
              ) : (
                <div className={`animate-pulse ${tc.muted} ${tc.fontClass}`}>Loading video...</div>
              )}
            </div>
          )}

          {/* Other Files */}
          {!isLoading && !isText && !isImage && !isVideo && drop.fileData && (
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
                onClick={() => setShowPlayer(p => !p)}
                className={`flex items-center gap-2 px-2 sm:px-4 py-2 rounded-md border ${tc.border} ${tc.text} hover:bg-[#FF0000] hover:text-white hover:border-[#FF0000] transition-all text-sm ${tc.fontClass}`}
                title="Watch video"
              >
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M8 5v14l11-7z" />
                </svg>
                <span className="hidden sm:inline">{showPlayer ? 'Close' : 'Watch video'}</span>
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

            {/* Move button — opens the move/copy modal for everyone (Copy is reachable via the in-modal toggle). */}
            {onMove && (
              <button
                onClick={() => onMove(drop)}
                className={`flex items-center gap-2 px-2 sm:px-4 py-2 rounded-md border ${tc.border} ${tc.text} hover:border-[#1a1a1a] transition-all text-sm ${tc.fontClass}`}
                title="Move"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 7.5L7.5 3m0 0L12 7.5M7.5 3v13.5M12 16.5l4.5-4.5m0 0L21 16.5M16.5 12V3" />
                </svg>
                <span className="hidden sm:inline">Move</span>
              </button>
            )}

            {/* Edit button */}
            {onEdit && (
              drop.locked && !canMutate ? (
                <LockedActionButton
                  context="edit"
                  variant="editorial"
                  theme={theme}
                  className={`flex items-center gap-2 px-2 sm:px-4 py-2 rounded-md border ${tc.border} ${tc.text} transition-all text-sm ${tc.fontClass}`}
                  icon={
                    <>
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0115.75 21H5.25A2.25 2.25 0 013 18.75V8.25A2.25 2.25 0 015.25 6H10" />
                      </svg>
                      <span className="hidden sm:inline">{drop.isDrawing ? 'Edit drawing' : 'Edit'}</span>
                    </>
                  }
                />
              ) : (
                <button
                  onClick={() => onEdit(drop)}
                  className={`flex items-center gap-2 px-2 sm:px-4 py-2 rounded-md border ${tc.border} ${tc.text} hover:border-[#1a1a1a] transition-all text-sm ${tc.fontClass}`}
                  title="Edit"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0115.75 21H5.25A2.25 2.25 0 013 18.75V8.25A2.25 2.25 0 015.25 6H10" />
                  </svg>
                  <span className="hidden sm:inline">{drop.isDrawing ? 'Edit drawing' : 'Edit'}</span>
                </button>
              )
            )}

            {/* Dismiss reminder — only when the reminder is glowing for THIS viewer. Light path:
                writes reminderDismissedBy (any dismiss clears it for non-creators; the creator keeps
                glowing until they dismiss). Locked-gated: only creator/owner may dismiss on a locked drop. */}
            {reminderGlowing && (
              drop.locked && !canMutate ? (
                <LockedActionButton
                  context="edit"
                  variant="editorial"
                  theme={theme}
                  className={`flex items-center gap-2 px-2 sm:px-4 py-2 rounded-md border ${tc.border} ${tc.text} transition-all text-sm ${tc.fontClass}`}
                  icon={
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
                      <circle cx="12" cy="12" r="9" />
                      <path d="M12 7v5l3 2" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  }
                />
              ) : (
                <button
                  onClick={handleReminderDismiss}
                  className={`flex items-center gap-2 px-2 sm:px-4 py-2 rounded-md border ${tc.border} ${tc.text} hover:border-[#1a1a1a] transition-all text-sm ${tc.fontClass}`}
                  title="Dismiss reminder"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
                    <circle cx="12" cy="12" r="9" />
                    <path d="M12 7v5l3 2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  <span className="hidden sm:inline">Dismiss</span>
                </button>
              )
            )}
          </div>

          {/* Share */}
          <button
            onClick={handleShare}
            disabled={isSharing}
            className={`flex items-center gap-2 px-2 sm:px-4 py-2 rounded-md ${tc.activePillBg} ${tc.activePillText} hover:opacity-90 transition-all text-sm ${tc.fontClass} disabled:opacity-50`}
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
                <span className="hidden sm:inline">Share</span>
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
