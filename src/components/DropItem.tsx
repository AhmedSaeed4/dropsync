'use client';

import { Drop } from '@/types';
import { formatFileSize, getTimeRemaining, decryptDrop, getYouTubeVideoId } from '@/lib/drops';
import { createShare } from '@/lib/shares';
import { downloadBinaryFromUrl } from '@/lib/download';
import { contentToPlainText } from '@/lib/dropTagUtils';
import { DropMentionContent } from './DropMentionContent';
import { useState, useEffect } from 'react';
import { useVideoThumbnail } from '@/hooks/useVideoThumbnail';
import { DropContextMenu, useContextMenu } from './DropContextMenu';
import { LockedHintTooltip } from './LockedHintTooltip';
import { LockedActionButton } from './LockedActionButton';
import { LiveCallDropTile } from './call/LiveCallDropTile';
import type { MemberInfo } from '@/lib/workspaces';

interface DropItemProps {
  drop: Drop;
  onDelete: (drop: Drop) => void;
  onPreview: (drop: Drop) => void;
  onEdit?: (drop: Drop) => void;
  selected: boolean;
  onSelect: (id: string) => void;
  selectionMode: boolean;
  theme?: 'light' | 'dark' | 'minimal';
  currentUserId?: string;
  onPin?: (drop: Drop) => void;
  onUnpin?: (drop: Drop) => void;
  // Current space's drops — used to resolve #[Name](id) mention chips inline.
  allDrops?: Drop[];
  // Creator/workspace owner — may still delete a locked drop. Non-creators see a faded gate.
  canMutate?: boolean;
  // Reminder glow (viewer-dependent) — turns the title coral + shows a clock badge. Computed by the
  // parent list via isReminderGlowingForViewer so this item stays presentational.
  reminderGlow?: boolean;
  // LIVE CALL — a call drop renders ONLY a LiveCallDropTile (no normal row). onJoinCall dispatches
  // to the page's join handler; members resolve the host avatar; isReopenCallId (the viewer's own
  // active minimized call id, or undefined) flips the button to "Reopen"; hoverable gates desktop.
  onJoinCall?: (drop: Drop) => void;
  members?: MemberInfo[];
  isReopenCallId?: string;
  hoverable?: boolean;
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

export function DropItem({ drop, onDelete, onPreview, onEdit, selected, onSelect, selectionMode, theme = 'light', currentUserId, onPin, onUnpin, allDrops = [], canMutate = false, reminderGlow = false, onJoinCall, members = [], isReopenCallId, hoverable = false }: DropItemProps) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [copied, setCopied] = useState(false);
  const [decryptedContent, setDecryptedContent] = useState<string>('');
  const [decryptedFileData, setDecryptedFileData] = useState<string>('');
  const [decryptedImageData, setDecryptedImageData] = useState<string>('');
  const [decryptError, setDecryptError] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const [isSharing, setIsSharing] = useState(false);
  const [shareCopied, setShareCopied] = useState(false);
  const isDark = theme === 'dark';
  const isMinimal = theme === 'minimal';

  const { menuState, closeMenu, contextMenuProps } = useContextMenu();

  const isImage = drop.mimeType?.startsWith('image/');
  const isVideo = drop.mimeType?.startsWith('video/');
  const hasAttachedImage = drop.type === 'text' && !!drop.imageR2Key;

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
          } else if (decrypted.imageData) {
            setDecryptError(false);
          } else if (!decrypted.content && !decrypted.fileData) {
            setDecryptError(true);
          }
          // Capture decrypted image data if present
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

  // What to display: decrypted, error message, or original content
  const displayContent = drop.encrypted
    ? (decryptError ? '[Encrypted - cannot decrypt]' : decryptedContent)
    : (drop.content || '');

  // What to display for file data (images)
  const displayFileData = drop.encrypted ? decryptedFileData : (drop.fileData || '');

  // What to display for attached image (text drop with image)
  const displayImageData = decryptedImageData;

  // Video thumbnail
  const { thumbnailUrl: videoThumbnail, isGenerating: isGeneratingThumbnail } = useVideoThumbnail(
    isVideo ? displayFileData : null,
    drop.mimeType
  );

  // YouTube thumbnail detection
  const youtubeVideoId = drop.type === 'text' ? getYouTubeVideoId(displayContent) : null;

  const handleShare = async (e: React.MouseEvent) => {
    e.stopPropagation();
    // A call drop has nothing to share (and never reaches the share button — it early-returns the
    // LiveCallDropTile). The guard also narrows drop.type to 'file'|'text' for createShare below.
    if (drop.type === 'call') return;
    setIsSharing(true);
    try {
      const result = await createShare({
        dropId: drop.id,
        type: drop.type,
        name: drop.name,
        content: drop.type === 'text' ? displayContent : undefined,
        imageData: displayImageData || (isImage ? displayFileData : undefined),
        fileData: !isImage && drop.type === 'file' ? displayFileData : undefined,
        fileUrl: !isImage && drop.type === 'file' && !displayFileData ? drop.fileUrl : undefined,
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

  const handleDownload = async (e: React.MouseEvent) => {
    e.stopPropagation();

    // Binary (unencrypted large) file — fetch the public R2 URL as a Blob and download via a
    // same-origin blob: URL (filename honored). The legacy data-URI/decrypt path below corrupts
    // real binary bytes, so it must not run for binary drops.
    if (drop.fileFormat === 'binary' && drop.fileUrl) {
      setIsDownloading(true);
      try {
        await downloadBinaryFromUrl(drop.fileUrl, drop.name);
      } catch (error) {
        console.error('Download failed:', error);
      } finally {
        setIsDownloading(false);
      }
      return;
    }

    // If already decrypted, download immediately
    if (displayFileData) {
      const link = document.createElement('a');
      link.href = displayFileData;
      link.download = drop.name;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      return;
    }

    // Need to decrypt first (R2 files)
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
        // Cache for future use
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
      await navigator.clipboard.writeText(contentToPlainText(content));
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

  const handleEdit = (e: React.MouseEvent) => {
    e.stopPropagation();
    onEdit?.(drop);
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

  // Inline mention-chip class strings — the shared DropMentionContent does the parse+render.
  const chipBase = `inline-flex items-center mx-0.5 my-0.5 px-1.5 py-0.5 align-middle text-[11px] ${isMinimal ? 'rounded-full font-sans' : 'font-mono'}`;
  const mentionFoundClass = `${chipBase} ${tc.selectedBg} text-white hover:opacity-80`;
  const mentionDeletedClass = `${chipBase} bg-[#1A1A1A]/10 ${tc.textMuted} line-through cursor-not-allowed`;

  // A call drop renders ONLY the live-call tile — no normal row, no PIN/lock badges, no selection
  // checkbox, no preview. This early return IS the type-discrimination (call → onJoinCall via the
  // tile; everything else → the normal row's onPreview below).
  if (drop.type === 'call') {
    return (
      <LiveCallDropTile
        drop={drop}
        theme={theme}
        variant="classic"
        hoverable={hoverable}
        members={members}
        isReopen={isReopenCallId === drop.id}
        onJoin={() => onJoinCall?.(drop)}
        onMobileTap={() => onJoinCall?.(drop)}
      />
    );
  }

  return (
    <div
      onClick={() => selectionMode ? onSelect(drop.id) : onPreview(drop)}
      {...contextMenuProps}
      className={`relative select-none border ${tc.borderColor} ${tc.bgColor} transition-all cursor-pointer group overflow-hidden ${
        selected ? `${tc.selectedBg} ${tc.selectedBorder}` : tc.hoverBg
      }`}
    >
      {/* Pinned indicator */}
      {drop.pinned && (
        <div className={`absolute top-0 left-0 z-10 px-1.5 py-0.5 ${isMinimal ? 'bg-[#1A1A1A]/80 text-[#D4D8C8]' : isDark ? 'bg-white/80 text-[#1A1A1A]' : 'bg-[#FF5A47] text-white'} ${isMinimal ? 'text-[7px] font-sans tracking-wide' : 'text-[7px] font-mono uppercase tracking-wider'}`}>
          PIN
        </div>
      )}
      {/* Lock badge — top-right (PIN is top-left) so a pinned+locked drop shows both. */}
      {drop.locked && (
        <div className={`absolute top-0 right-0 z-10 px-1.5 py-0.5 flex items-center ${isMinimal ? 'bg-[#1A1A1A]/80 text-[#D4D8C8]' : isDark ? 'bg-white/80 text-[#1A1A1A]' : 'bg-[#FF5A47] text-white'}`} title="Locked">
          <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2.5}>
            <path d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
          </svg>
        </div>
      )}
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
            {drop.type === 'text' && hasAttachedImage && displayImageData ? (
              <img src={displayImageData} alt={drop.name} className="w-full h-full object-cover" />
            ) : drop.type === 'text' && youtubeVideoId ? (
              <img src={`https://img.youtube.com/vi/${youtubeVideoId}/mqdefault.jpg`} alt="YouTube thumbnail" className="w-full h-full object-cover" />
            ) : drop.type === 'text' ? (
              <svg className={`w-5 h-5 ${tc.textColor}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
                <path d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
            ) : isImage && displayFileData ? (
              <img src={displayFileData} alt={drop.name} className="w-full h-full object-cover" />
            ) : isVideo && videoThumbnail ? (
              <div className="relative w-full h-full">
                <img src={videoThumbnail} alt={drop.name} className="w-full h-full object-cover" />
                <div className="absolute inset-0 flex items-center justify-center">
                  <div className="w-6 h-6 bg-black/60 rounded-full flex items-center justify-center">
                    <svg className="w-3 h-3 text-white ml-0.5" fill="currentColor" viewBox="0 0 24 24">
                      <path d="M8 5v14l11-7z" />
                    </svg>
                  </div>
                </div>
              </div>
            ) : isVideo && isGeneratingThumbnail ? (
              <div className={`w-5 h-5 ${tc.textMuted} animate-pulse`}>
                <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
                  <path strokeLinecap="round" strokeLinejoin="round" d="m15.75 10.5 4.72-4.72a.75.75 0 0 1 1.28.53v11.38a.75.75 0 0 1-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 0 0 2.25-2.25v-9a2.25 2.25 0 0 0-2.25-2.25h-9A2.25 2.25 0 0 0 2.25 7.5v9a2.25 2.25 0 0 0 2.25 2.25Z" />
                </svg>
              </div>
            ) : isVideo ? (
              <svg className={`w-5 h-5 ${tc.textColor}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
                <path strokeLinecap="round" strokeLinejoin="round" d="m15.75 10.5 4.72-4.72a.75.75 0 0 1 1.28.53v11.38a.75.75 0 0 1-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 0 0 2.25-2.25v-9a2.25 2.25 0 0 0-2.25-2.25h-9A2.25 2.25 0 0 0 2.25 7.5v9a2.25 2.25 0 0 0 2.25 2.25Z" />
              </svg>
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
            <h3 className={`text-sm ${isMinimal ? 'font-medium tracking-wide' : 'font-semibold uppercase tracking-wider'} line-clamp-1 ${reminderGlow && !selected ? 'text-[#FF5A47]' : selected ? 'text-white' : tc.textColor}`} title={drop.name}>
              {drop.name}
            </h3>
            {reminderGlow && (
              <span className={`shrink-0 flex items-center gap-1 px-1.5 py-0.5 ${isMinimal ? 'bg-[#1A1A1A]/80 text-[#D4D8C8]' : isDark ? 'bg-white/80 text-[#1A1A1A]' : 'bg-[#FF5A47] text-white'} ${isMinimal ? 'text-[7px] font-sans tracking-wide' : 'text-[7px] font-mono uppercase tracking-wider'}`} title="Reminder active">
                <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2.5" aria-hidden="true">
                  <circle cx="12" cy="12" r="9" />
                  <path d="M12 7v5l3 2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </span>
            )}
            {drop.creatorName && (
              <span className={`text-[10px] px-2 py-0.5 rounded-full ${selected ? 'bg-white/20 text-white' : isMinimal ? 'bg-[#1A1A1A]/10 text-[#1A1A1A]/60' : isDark ? 'bg-white/10 text-white/50' : 'bg-[#1A1A1A]/10 text-[#1A1A1A]/50'}`}>
                {drop.creatorName}
              </span>
            )}
          </div>
          <div className={`flex items-center gap-3 mt-1 ${isMinimal ? 'text-xs tracking-wide' : 'text-[10px] font-mono uppercase tracking-wider'}`}>
            {drop.type === 'file' && drop.fileSize && (
              <>
                <span className={selected ? 'text-white/70' : tc.textMuted}>
                  {isMinimal ? formatFileSize(drop.fileSize).toLowerCase() : formatFileSize(drop.fileSize)}
                </span>
                {/* Encryption status indicator */}
                {drop.encrypted ? (
                  <span className={`flex items-center gap-1 ${selected ? 'text-white/50' : isDark ? 'text-green-400/70' : 'text-green-600/70'}`} title="Encrypted">
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2">
                      <path d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                    </svg>
                    {isMinimal ? 'Encrypted' : 'ENCRYPTED'}
                  </span>
                ) : (
                  <span className={`flex items-center gap-1 ${selected ? 'text-white/50' : tc.textMuted}`} title="Not encrypted (large file)">
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2">
                      <path d="M8 11V7a4 4 0 118 0m-4 8v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2z" />
                    </svg>
                    {isMinimal ? 'Not encrypted' : 'UNENCRYPTED'}
                  </span>
                )}
              </>
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
                disabled={isDownloading}
                className={`w-12 h-full flex items-center justify-center border-r ${tc.borderColor} ${tc.textMuted} hover:bg-[#1A1A1A] hover:text-white transition-colors disabled:opacity-50`}
                title={isMinimal ? 'Download' : 'DOWNLOAD'}
              >
                {isDownloading ? (
                  <div className={`w-4 h-4 border-2 border-current border-t-transparent animate-spin ${isMinimal ? 'rounded-full' : ''}`} />
                ) : (
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
                    <path d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                  </svg>
                )}
              </button>
            )}
            {/* Share button - hidden on mobile */}
            <button
              onClick={handleShare}
              disabled={isSharing}
              className={`hidden sm:flex w-12 h-full items-center justify-center border-r ${tc.borderColor} ${tc.textMuted} hover:bg-[#1A1A1A] hover:text-white transition-colors disabled:opacity-50`}
              title={isMinimal ? 'Share' : 'SHARE'}
            >
              {shareCopied ? (
                <svg className={`w-4 h-4 ${isMinimal ? 'text-[#1A1A1A]' : 'text-[#FF5A47]'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2">
                  <path d="M5 13l4 4L19 7" />
                </svg>
              ) : (
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
                  <path d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" />
                </svg>
              )}
            </button>
            {/* Delete button with inline confirmation */}
            {drop.locked && !canMutate ? (
              <LockedActionButton
                context="delete"
                variant="classic"
                theme={theme}
                className={`w-12 h-full flex items-center justify-center ${tc.textMuted} transition-colors`}
                icon={
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
                    <path d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                }
              />
            ) : confirmDelete ? (
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
          <p className={`${isMinimal ? 'text-sm font-sans tracking-wide' : 'text-xs font-mono'} ${tc.textPreviewColor} leading-relaxed line-clamp-3 break-all`}>
            <DropMentionContent
              content={displayContent}
              allDrops={allDrops}
              onPreview={onPreview}
              foundClassName={mentionFoundClass}
              deletedClassName={mentionDeletedClass}
            />
          </p>
        </div>
      )}

      {/* Context menu */}
      {menuState && !(drop.locked && !canMutate) && (
        <DropContextMenu
          x={menuState.x}
          y={menuState.y}
          isPinned={!!drop.pinned}
          onPin={() => onPin?.(drop)}
          onUnpin={() => onUnpin?.(drop)}
          onClose={closeMenu}
          theme={theme}
          locked={!!drop.locked}
          canMutate={canMutate}
        />
      )}

      {/* Locked hint: when the menu is suppressed (locked drop, non-creator), show a brief
          auto-dismissing hint at the gesture point instead of a silent dead-end. */}
      {menuState && drop.locked && !canMutate && (
        <LockedHintTooltip x={menuState.x} y={menuState.y} onClose={closeMenu} />
      )}
    </div>
  );
}
