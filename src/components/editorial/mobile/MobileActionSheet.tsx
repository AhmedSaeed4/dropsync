'use client';

import { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import { Drop } from '@/types';
import { decryptDrop, updateDropMetadata, getYouTubeVideoId } from '@/lib/drops';
import { createShare } from '@/lib/shares';
import { downloadBinaryFromUrl } from '@/lib/download';
import { contentToPlainText } from '@/lib/dropTagUtils';
import { getEditorialThemeColors } from '../editorialTheme';
import { Toast } from '@/components/Toast';

type Theme = 'light' | 'dark' | 'minimal';

interface MobileActionSheetProps {
  // The sheeted drop; null = closed. The LIVE drop flows in (Firestore updates included), so
  // the locked state below always reflects the current doc.
  drop: Drop | null;
  onClose: () => void;
  // Fired after a successful clipboard copy — the VIEW owns the "Copied" toast, because
  // the sheet unmounts as it closes and could not show one (D10 add-on: keep confirmation).
  onCopied: () => void;
  theme: Theme;
  currentUserId: string | null;
  onPreview: (drop: Drop) => void;
  onEditDrop: (drop: Drop) => void;
  // canMutate = !!currentUserId && (uid === drop.userId || workspace owner) — computed by the view.
  canMutate: boolean;
  onMove: (drop: Drop) => void;
  // Single delete — the view wires this to requestDelete; the 30s undo toast IS the safety net (#18).
  onDelete: (drop: Drop) => void;
  onPin: (drop: Drop) => void;
  onUnpin: (drop: Drop) => void;
  // Manual sort mode (unfiltered, not selecting) — Move up / Move down rows appear.
  manualMove?: { canUp: boolean; canDown: boolean; onUp(): void; onDown(): void };
}

function isTextFile(drop: Drop): boolean {
  if (drop.type === 'text') return true;
  const textMimeTypes = ['text/', 'application/json', 'application/xml'];
  const textExtensions = ['.txt', '.md', '.json', '.csv', '.xml', '.html', '.css', '.js', '.ts', '.jsx', '.tsx'];
  return textMimeTypes.some(t => drop.mimeType?.startsWith(t)) ||
         textExtensions.some(ext => drop.name.toLowerCase().endsWith(ext));
}

// The ⋯ bottom sheet (#18): icon+label rows, destructive in muted red, disabled rows grayed with
// a reason, drag handle, backdrop/Esc close, slide-up. Share/Download/Copy are the verbatim ports
// of EditorialDropItem's handlers (:316-413) — this sheet is their only mobile call site. When the
// drop is locked and the viewer can't mutate it, the sheet shows ONLY Preview / Copy / Share /
// Download + the muted "Locked by the creator" note (pin/edit/move/delete are rules-blocked).
export function MobileActionSheet({
  drop,
  onClose,
  onCopied,
  theme,
  currentUserId,
  onPreview,
  onEditDrop,
  canMutate,
  onMove,
  onDelete,
  onPin,
  onUnpin,
  manualMove,
}: MobileActionSheetProps) {
  const tc = getEditorialThemeColors(theme);
  const font = tc.fontClass;

  // Display content for Copy/Share — decrypted lazily when the sheet opens (single drop, cheap).
  const [displayContent, setDisplayContent] = useState('');
  const [displayFileData, setDisplayFileData] = useState('');
  const [displayImageData, setDisplayImageData] = useState('');
  const [isDownloading, setIsDownloading] = useState(false);
  const [isSharing, setIsSharing] = useState(false);
  const [shareToast, setShareToast] = useState(false);

  const lockedNoMutate = !!drop?.isStaged || (!!drop?.locked && !canMutate);
  const isImage = drop?.mimeType?.startsWith('image/') ?? false;

  useEffect(() => {
    if (!drop) return;
    let cancelled = false;
    async function load() {
      if (!drop) return;
      if (!drop.encrypted) {
        setDisplayContent(drop.content || '');
        setDisplayFileData(drop.fileData || '');
        return;
      }
      if (!currentUserId) return;
      try {
        const decrypted = await decryptDrop(drop, currentUserId);
        if (cancelled) return;
        setDisplayContent(decrypted.content || '');
        setDisplayFileData(decrypted.fileData || '');
        if (decrypted.imageData) setDisplayImageData(decrypted.imageData);
      } catch (error) {
        console.error('Decryption error:', error);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [drop, currentUserId]);

  useEffect(() => {
    if (!drop) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [drop, onClose]);

  if (!drop) return null;

  const youtubeVideoId = drop.type === 'text' ? getYouTubeVideoId(displayContent) : null;

  // --- Verbatim ports (EditorialDropItem :316-413), minus the stopPropagation (rows live in
  // their own sheet, nothing beneath them to protect) ---

  const handleShare = async () => {
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
        setShareToast(true);
      }
    } catch (error) {
      console.error('Share failed:', error);
    } finally {
      setIsSharing(false);
    }
  };

  const handleDownload = async () => {
    // Binary (unencrypted large) file path first — the data-URI path corrupts real binary bytes.
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
        setDisplayFileData(decrypted.fileData);
      }
    } catch (error) {
      console.error('Download failed:', error);
    } finally {
      setIsDownloading(false);
    }
  };

  const handleCopy = async () => {
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
      onClose();
      onCopied();
    }
  };

  const handleToggleLock = async () => {
    if (drop.isStaged) return;
    try {
      await updateDropMetadata(drop.id, { locked: !drop.locked });
    } catch (error) {
      console.error('Lock toggle failed:', error);
    }
  };

  const rowClass = `flex w-full items-center gap-3 px-5 py-3 text-left text-sm ${font} transition-colors`;
  const iconClass = 'h-4 w-4 shrink-0';
  const spinner = <div className="h-4 w-4 shrink-0 animate-spin rounded-full border border-current/30 border-t-current" />;

  return (
    <>
      <motion.div
        className="fixed inset-0 z-50 bg-black/50"
        onClick={onClose}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.2 }}
      />
      <motion.div
        role="menu"
        aria-label={`Actions for ${drop.name}`}
        initial={{ y: '100%' }}
        animate={{ y: 0 }}
        exit={{ y: '100%' }}
        transition={{ duration: 0.28, ease: [0.4, 0, 0.2, 1] }}
        className={`fixed inset-x-0 bottom-0 z-50 rounded-t-[14px] border-t ${tc.cardBg} ${tc.border}`}
        style={{ maxHeight: 'calc(100dvh - 12px)', overflowY: 'auto', paddingBottom: 'max(env(safe-area-inset-bottom), var(--archive-stack-clearance, 0px))' }}
      >
        <div className="mx-auto mt-2.5 mb-1 h-1 w-9 rounded-full bg-current opacity-20" />
        <p className={`truncate px-5 pb-1 pt-1 text-[13px] font-semibold ${font} ${tc.text}`}>{drop.name}</p>

        <div className="pb-2">
          <button type="button" role="menuitem" onClick={() => { onClose(); onPreview(drop); }} className={`${rowClass} ${tc.text} ${tc.inactivePillHoverBg}`}>
            <svg className={iconClass} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round"><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" /><circle cx="12" cy="12" r="3" /></svg>
            Preview
          </button>

          {!lockedNoMutate && (
            <>
              <button type="button" role="menuitem" onClick={() => { onClose(); onEditDrop(drop); }} className={`${rowClass} ${tc.text} ${tc.inactivePillHoverBg}`}>
                <svg className={iconClass} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round"><path d="M17 3.5 20.5 7 8.5 19l-4.6 1.1L5 15.5 17 3.5z" /></svg>
                Edit
              </button>
              <button type="button" role="menuitem" onClick={() => { onClose(); onMove(drop); }} className={`${rowClass} ${tc.text} ${tc.inactivePillHoverBg}`}>
                <svg className={iconClass} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h13m0 0-4-4m4 4-4 4" /><path d="M4 5v14" /></svg>
                Move
              </button>
            </>
          )}

          {isTextFile(drop) && (
            <button type="button" role="menuitem" onClick={handleCopy} className={`${rowClass} ${tc.text} ${tc.inactivePillHoverBg}`}>
              <svg className={iconClass} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round"><rect x="8.5" y="8.5" width="12" height="12" rx="2.5" /><path d="M15.5 5.5v-1a2 2 0 0 0-2-2h-9a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h1" /></svg>
              Copy
            </button>
          )}

          <button type="button" role="menuitem" onClick={handleShare} disabled={isSharing || !!drop.isStaged} className={`${rowClass} ${tc.text} ${tc.inactivePillHoverBg} disabled:opacity-50`}>
            {isSharing ? spinner : (
              <svg className={iconClass} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round"><path d="M12 3.5v11m0-11-3.5 3.5M12 3.5l3.5 3.5" /><path d="M5 12.5v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6" /></svg>
            )}
            Share
          </button>

          {drop.type === 'file' && (
            <button type="button" role="menuitem" onClick={handleDownload} disabled={isDownloading} className={`${rowClass} ${tc.text} ${tc.inactivePillHoverBg} disabled:opacity-50`}>
              {isDownloading ? spinner : (
                <svg className={iconClass} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round"><path d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M12 12.75v-7.5m0 7.5-3-3m3 3 3-3" /></svg>
              )}
              Download
            </button>
          )}

          {/* Pin — rules-blocked for a locked drop the viewer can't mutate (DropContextMenu.tsx:30) */}
          {!lockedNoMutate && (
            <button
              type="button"
              role="menuitem"
              onClick={() => { (drop.pinned ? onUnpin : onPin)(drop); onClose(); }}
              className={`${rowClass} ${tc.text} ${tc.inactivePillHoverBg}`}
            >
              <svg className={iconClass} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round"><path d="M9 4.5h6l-.8 5.2 3.3 3.3H6.5l3.3-3.3L9 4.5zM12 13v6.5" /></svg>
              {drop.pinned ? 'Unpin drop' : 'Pin drop'}
            </button>
          )}

          {/* D13: the desktop's ONLY lock surfaces are the create/edit Access pills, and
              personal drops never see them (EditorialTextModal.tsx:71-73: canMutate +
              !!workspaceId). The sheet's toggle follows the same surface exactly. */}
          {!lockedNoMutate && canMutate && !!drop.workspaceId && (
            <button
              type="button"
              role="menuitem"
              onClick={() => { handleToggleLock(); onClose(); }}
              className={`${rowClass} ${tc.text} ${tc.inactivePillHoverBg}`}
            >
              <svg className={iconClass} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round"><path d="M12 15v2m-6 4h12a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2zm10-10V7a4 4 0 0 0-8 0v4h8z" /></svg>
              {drop.locked ? 'Unlock drop' : 'Lock drop'}
            </button>
          )}

          {manualMove && !drop.isStaged && (
            <>
              <button
                type="button"
                role="menuitem"
                onClick={() => { manualMove.onUp(); onClose(); }}
                disabled={!manualMove.canUp}
                className={`${rowClass} ${manualMove.canUp ? `${tc.text} ${tc.inactivePillHoverBg}` : `opacity-40 ${tc.muted}`}`}
              >
                <svg className={iconClass} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round"><path d="M5 15l7-7 7 7" /></svg>
                Move up{!manualMove.canUp ? ' — already at the top' : ''}
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => { manualMove.onDown(); onClose(); }}
                disabled={!manualMove.canDown}
                className={`${rowClass} ${manualMove.canDown ? `${tc.text} ${tc.inactivePillHoverBg}` : `opacity-40 ${tc.muted}`}`}
              >
                <svg className={iconClass} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round"><path d="M19 9l-7 7-7-7" /></svg>
                Move down{!manualMove.canDown ? ' — already at the bottom' : ''}
              </button>
            </>
          )}

          {/* Delete — replaced by the muted note for locked non-mutable drops; otherwise fires
              requestDelete directly (the 30s undo toast is the safety net, #18 — no extra step) */}
          {lockedNoMutate ? (
            <p className={`px-5 py-3 text-xs ${font} ${tc.muted}`}>{drop.isStaged ? 'This item is still importing.' : 'Locked by the creator'}</p>
          ) : (
            <button
              type="button"
              role="menuitem"
              onClick={() => { onClose(); onDelete(drop); }}
              className={`${rowClass} text-red-500/90 hover:bg-red-500/10`}
            >
              <svg className={iconClass} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round"><path d="M4 6.5h16M9.5 6V4.5a1.5 1.5 0 0 1 1.5-1.5h2a1.5 1.5 0 0 1 1.5 1.5V6M6.5 6.5l1 13a1.5 1.5 0 0 0 1.5 1.4h6a1.5 1.5 0 0 0 1.5-1.4l1-13" /></svg>
              Delete
            </button>
          )}
        </div>
      </motion.div>

      {shareToast && (
        <Toast message="Link copied" duration={2} theme={theme} editorial onDone={() => setShareToast(false)} />
      )}
    </>
  );
}
