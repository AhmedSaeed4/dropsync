'use client';

import { useEffect, useRef, useState } from 'react';
import { Drop, Workspace } from '@/types';
import { formatFileSize, getTimeRemaining, decryptDrop, getYouTubeVideoId } from '@/lib/drops';
import { DropMentionContent } from '../../DropMentionContent';
import { useVideoThumbnail } from '@/hooks/useVideoThumbnail';
import { getEditorialThemeColors } from '../editorialTheme';
import { LiveCallDropTile } from '../../call/LiveCallDropTile';
import type { MemberInfo } from '@/lib/workspaces';

type Theme = 'light' | 'dark' | 'minimal';

interface MobileDropCardProps {
  drop: Drop;
  theme: Theme;
  currentUserId: string | null;
  // Kept in the prop contract (per the order) for parity with the desktop card's data surface;
  // the card itself needs only currentUserId for decryption.
  currentWorkspaceId: string | null;
  currentWorkspace: Workspace | null;
  // Current space's drops — resolves #[Name](id) mention chips inline.
  allDrops: Drop[];
  selectionMode: boolean;
  selected: boolean;
  onSelect: (id: string) => void;
  onPreview: (drop: Drop) => void;
  // ⋯ button — the sheet is owned by the view (#18: the face carries no action buttons).
  onOpenSheet: (drop: Drop) => void;
  // Viewer-dependent reminder glow — computed by the view via isReminderGlowingForViewer.
  reminderGlow: boolean;
  // LIVE CALL — a call drop renders ONLY a LiveCallDropTile (never selectable, never sheeted).
  onJoinCall?: (drop: Drop) => void;
  members: MemberInfo[];
  isReopenCallId?: string;
  hoverable: boolean;
  // Manual sort mode (unfiltered, not selecting): enables the order badge. The reorder itself
  // lives in the ⋯ sheet (Move up / Move down) — #18 removed the desktop's card-row buttons.
  manualMove?: { canUp: boolean; canDown: boolean; onUp(): void; onDown(): void };
  // The drop's 0-based position within the manual unpinned order (for the order badge).
  manualPosition?: number;
}

/**
 * Nearest ancestor of `el` that actually scrolls vertically, or null if there isn't one.
 * Ported from EditorialDropItem — on phones the drops live in the page scroll (the shell's
 * <main> does not clip), so this usually returns null and the observer falls back to the
 * viewport; the 1000px rootMargin buffer + latch behavior are identical to desktop.
 */
function getScrollParent(el: Element | null): Element | null {
  let node = el?.parentElement;
  while (node) {
    const overflowY = getComputedStyle(node).overflowY;
    if (overflowY === 'auto' || overflowY === 'scroll') {
      if (node.scrollHeight > node.clientHeight) return node;
    }
    node = node.parentElement;
  }
  return null;
}

// Lazy-visibility hook ported verbatim from EditorialDropItem (1000px margin, scroll-parent
// root, latch-on-first-intersect). LOAD-BEARING: without it a big encrypted workspace would
// decrypt everything on mount.
function useInView<T extends Element>(rootMargin = '1000px 0px') {
  const ref = useRef<T | null>(null);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === 'undefined') {
      setInView(true);
      return;
    }
    const root = getScrollParent(el);
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setInView(true);
            observer.disconnect();
          }
        }
      },
      { root, rootMargin }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [rootMargin]);

  return { ref, inView };
}

// The real drop card's data + anatomy, mobile face (#17/#17a/#19/#20/#21/#22): 14px radius,
// 160px media head flush to the card edges, title + clock + creator + ⋯ row, desktop meta
// line, 1/2-line text preview, pin/lock corner chips, tick overlay in select mode.
export function MobileDropCard({
  drop,
  theme,
  currentUserId,
  allDrops,
  selectionMode,
  selected,
  onSelect,
  onPreview,
  onOpenSheet,
  reminderGlow,
  onJoinCall,
  members,
  isReopenCallId,
  hoverable,
  manualMove,
  manualPosition,
}: MobileDropCardProps) {
  const [decryptedContent, setDecryptedContent] = useState<string>('');
  const [decryptedFileData, setDecryptedFileData] = useState<string>('');
  const [decryptedImageData, setDecryptedImageData] = useState<string>('');
  const [decryptError, setDecryptError] = useState(false);

  const { ref: cardRef, inView } = useInView<HTMLDivElement>('1000px 0px');
  const hasDecrypted = useRef(false);
  // iv changes on every re-encryption; imageR2Key covers image-only edits (see EditorialDropItem).
  const lastSigRef = useRef<string | null>(null);

  const tc = getEditorialThemeColors(theme);
  const font = tc.fontClass;

  const chipBase = `inline-flex items-center mx-0.5 my-0.5 px-1.5 py-0.5 align-middle rounded text-[11px] ${font}`;
  const mentionFoundClass = `${chipBase} ${tc.activePillBg} ${tc.activePillText} hover:opacity-80`;
  const mentionDeletedClass = `${chipBase} ${tc.inactivePillBg} ${tc.muted} line-through cursor-not-allowed`;

  const isImage = drop.mimeType?.startsWith('image/');
  const isVideo = drop.mimeType?.startsWith('video/');
  const hasAttachedImage = drop.type === 'text' && !!drop.imageR2Key;

  // Decrypt effect ported verbatim from EditorialDropItem :234-281 (incl. signature guard).
  useEffect(() => {
    async function decrypt() {
      if (!drop.encrypted) {
        setDecryptedContent(drop.content || '');
        setDecryptedFileData(drop.fileData || '');
        setDecryptError(false);
        return;
      }
      if (!currentUserId || !inView) return;
      const sig = `${drop.iv ?? ''}|${drop.imageR2Key ?? ''}`;
      if (hasDecrypted.current && lastSigRef.current === sig) return;

      hasDecrypted.current = true;
      lastSigRef.current = sig;

      try {
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
        if (decrypted.imageData) {
          setDecryptedImageData(decrypted.imageData);
        }
      } catch (error) {
        console.error('Decryption error:', error);
        setDecryptError(true);
        setDecryptedContent('');
        setDecryptedFileData('');
      }
    }
    decrypt();
  }, [drop, currentUserId, inView]);

  const displayContent = drop.encrypted
    ? (decryptError ? '[Encrypted - cannot decrypt]' : decryptedContent)
    : (drop.content || '');
  const displayFileData = drop.encrypted ? decryptedFileData : (drop.fileData || '');
  const displayImageData = decryptedImageData;

  const contentReady = !drop.encrypted
    || decryptedContent !== ''
    || decryptedFileData !== ''
    || decryptedImageData !== ''
    || decryptError;

  // Video thumbnail + YouTube detection — same priority chain as EditorialDropItem :300-314.
  const { thumbnailUrl: videoThumbnail } = useVideoThumbnail(
    isVideo ? displayFileData : null,
    drop.mimeType
  );
  const youtubeVideoId = drop.type === 'text' ? getYouTubeVideoId(displayContent) : null;

  const getThumbnailSrc = () => {
    if (isImage && displayFileData) return displayFileData;
    if (drop.type === 'text' && hasAttachedImage && displayImageData) return displayImageData;
    if (youtubeVideoId) return `https://img.youtube.com/vi/${youtubeVideoId}/mqdefault.jpg`;
    if (isVideo && videoThumbnail) return videoThumbnail;
    return null;
  };
  const thumbnailSrc = getThumbnailSrc();

  // A call drop renders ONLY the live-call tile — never selectable, never sheeted (#21).
  if (drop.type === 'call') {
    return (
      <LiveCallDropTile
        drop={drop}
        theme={theme}
        variant="editorial"
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
      ref={cardRef}
      onClick={() => (selectionMode ? onSelect(drop.id) : onPreview(drop))}
      className={`relative w-full select-none overflow-hidden border ${tc.cardBg} ${tc.border} rounded-[14px] transition-colors cursor-pointer`}
    >
      {/* Pin badge — top-right (desktop parity :479-486) */}
      {drop.pinned && (
        <div className={`absolute right-2 top-2 z-10 flex h-5 w-5 items-center justify-center rounded-md ${theme === 'dark' ? 'bg-white/10 text-white/70' : 'bg-[#1A1A1A]/10 text-[#1A1A1A]/60'}`}>
          <svg className="h-2.5 w-2.5" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z" />
          </svg>
        </div>
      )}
      {/* Lock badge — top-left (:487-494) */}
      {drop.locked && (
        <div className={`absolute left-2 top-2 z-10 flex h-5 w-5 items-center justify-center rounded-md ${theme === 'dark' ? 'bg-white/10 text-white/70' : 'bg-[#1A1A1A]/10 text-[#1A1A1A]/60'}`} title="Locked">
          <svg className="h-2.5 w-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2} aria-hidden="true">
            <path d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
          </svg>
        </div>
      )}

      {/* Select-mode tick — overlays the card's top-left (#21); ink-inverted when selected */}
      {selectionMode && (
        <div
          aria-hidden="true"
          className={`absolute left-2 top-2 z-20 flex h-6 w-6 items-center justify-center rounded-[8px] border-[1.5px] transition-colors ${
            selected
              ? `${tc.activePillBg} ${tc.activePillText} border-transparent`
              : `${tc.cardBg} ${tc.text} ${tc.border}`
          }`}
        >
          {selected && (
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={3}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          )}
        </div>
      )}

      {/* Media head — 160px, flush to the card edges; corners clipped by the 14px radius (#17a) */}
      {thumbnailSrc && (
        <div className={`relative h-40 w-full overflow-hidden ${selected ? 'opacity-60' : ''}`}>
          <img src={thumbnailSrc} alt={drop.name} className="h-full w-full object-cover" />
          {isVideo && (
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="flex h-9 w-9 items-center justify-center rounded-full bg-black/60">
                <svg className="ml-0.5 h-4 w-4 text-white" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M8 5v14l11-7z" />
                </svg>
              </div>
            </div>
          )}
        </div>
      )}

      <div className={`p-3 ${selected && !thumbnailSrc ? 'opacity-60' : ''}`}>
        {/* No media → the 40px icon tile alone on its row (text/file/video svgs :546-565) */}
        {!thumbnailSrc && (
          <div className={`mb-2 flex h-10 w-10 items-center justify-center rounded-[10px] border ${tc.border} ${tc.inactivePillBg}`}>
            {isVideo ? (
              <svg className={`h-4 w-4 ${tc.muted}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
                <path strokeLinecap="round" strokeLinejoin="round" d="m15.75 10.5 4.72-4.72a.75.75 0 0 1 1.28.53v11.38a.75.75 0 0 1-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 0 0 2.25-2.25v-9a2.25 2.25 0 0 0-2.25-2.25h-9A2.25 2.25 0 0 0 2.25 7.5v9a2.25 2.25 0 0 0 2.25 2.25Z" />
              </svg>
            ) : drop.type === 'text' ? (
              <svg className={`h-4 w-4 ${tc.muted}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
                <path d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
            ) : (
              <svg className={`h-4 w-4 ${tc.muted}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
                <path d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
              </svg>
            )}
          </div>
        )}

        {/* Title row: title · clock chip · creator chip · ⋯ (#20; ⋯ hidden while selecting) */}
        <div className="flex items-start gap-2">
          <h3
            className={`min-w-0 flex-1 text-sm font-medium tracking-tight line-clamp-2 ${font} ${
              reminderGlow && !selected ? 'animate-text-rgb' : ''
            } ${tc.text}`}
            title={drop.name}
          >
            {drop.name}
          </h3>
          {reminderGlow && (
            <span className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md ${theme === 'dark' ? 'bg-white/10 text-white/70' : 'bg-[#1A1A1A]/10 text-[#1A1A1A]/60'}`} title="Reminder active">
              <svg className="h-2.5 w-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2" aria-hidden="true">
                <circle cx="12" cy="12" r="9" />
                <path d="M12 7v5l3 2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
          )}
          {drop.creatorName && (
            <span className={`max-w-[38%] shrink-0 truncate px-2 py-0.5 text-[10px] ${font} ${tc.inactivePillBg} ${tc.inactivePillText}`}>
              {drop.creatorName}
            </span>
          )}
          {!selectionMode && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onOpenSheet(drop); }}
              aria-label="More actions"
              aria-haspopup="menu"
              className={`-mr-1 -mt-0.5 flex h-11 w-11 shrink-0 items-center justify-center ${tc.muted} transition-colors`}
            >
              <svg className="h-5 w-5" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <circle cx="5" cy="12" r="1.7" /><circle cx="12" cy="12" r="1.7" /><circle cx="19" cy="12" r="1.7" />
              </svg>
            </button>
          )}
        </div>

        {/* Manual order badge (Manual sort, unfiltered) — position only; reorder lives in the sheet */}
        {manualMove && manualPosition !== undefined && (
          <span className={`mt-1.5 inline-flex items-center px-1.5 py-0.5 text-[9px] font-semibold tracking-[0.06em] ${font} border ${tc.border} ${tc.muted}`}>
            #{manualPosition + 1}
          </span>
        )}

        {/* Meta line — exactly the desktop's (:593-616) */}
        <div className={`mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs ${font} ${tc.muted}`}>
          {drop.type === 'file' && drop.fileSize && (
            <span>{formatFileSize(drop.fileSize).toLowerCase()}</span>
          )}
          {drop.type === 'text' && (
            contentReady ? (
              <span>{`${displayContent.length} chars`}</span>
            ) : (
              <span className={tc.muted}>decrypting…</span>
            )
          )}
          {drop.encrypted ? (
            <span className={`flex items-center gap-1 ${tc.muted}`}>
              <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2" aria-hidden="true">
                <path d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
              </svg>
              Encrypted
            </span>
          ) : null}
          <span className={tc.muted}>{getTimeRemaining(drop.expiresAt)}</span>
        </div>

        {/* Text preview — 1 line with no media, 2 lines below the media (mention chips live) */}
        {drop.type === 'text' && displayContent && (
          <p className={`mt-1.5 text-xs leading-relaxed ${font} ${tc.muted} ${thumbnailSrc ? 'line-clamp-2' : 'line-clamp-1'}`}>
            <DropMentionContent
              content={displayContent}
              allDrops={allDrops}
              onPreview={onPreview}
              foundClassName={mentionFoundClass}
              deletedClassName={mentionDeletedClass}
            />
          </p>
        )}
      </div>
    </div>
  );
}
