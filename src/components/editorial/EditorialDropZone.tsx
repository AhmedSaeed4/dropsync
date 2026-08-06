'use client';

import { useState, useRef, useCallback, useEffect, Fragment } from 'react';
import { createFileDrop, createTextDrop } from '@/lib/drops';
import { leaveCallRoute, startCallRoute } from '@/lib/callRoutes';
import { useAuth } from '@/hooks/useAuth';
import { useUserTier } from '@/hooks/useUserTier';
import { EditorialTextModal } from './EditorialTextModal';
import { ForeverLockedModal } from '../ForeverLockedModal';
import { Tooltip } from '../Tooltip';
import { ExpirationOption, Drop } from '@/types';
import { getEditorialThemeColors } from './editorialTheme';
import { retractFooterIfUp } from '../SmoothScrollProvider';

interface EditorialDropZoneProps {
  theme?: 'light' | 'dark' | 'minimal';
  workspaceId?: string | null;
  workspaceMembers?: string[];
  customCategories?: string[];
  onCreateCategory?: (name: string) => Promise<string | null>;
  showChat?: boolean;
  editModalOpen?: boolean;
  onToggleChat?: () => void;
  unreadCount?: number;
  mentionableDrops?: Drop[];
  // LIVE CALL: page handler invoked after the start route creates the call drop. Receives the
  // callDropId + the preview stream (the mesh adopts the stream + joins).
  onStartCall?: (callDropId: string, stream: MediaStream | null, callInfo?: { created?: boolean; callHostUid?: string; creatorName?: string; callParticipantUids?: string[] }) => void | Promise<void>;
  callCanStart?: boolean;
  callAccessLoading?: boolean;
  callAccessError?: string | null;
  onRefreshCallAccess?: () => Promise<void>;
}

// Richer upload state for the editorial dropzone: idle, a live-uploading view carrying real byte
// progress (completed/total files + the in-flight file's ratio + name), done, or an accumulated
// error naming the failed file(s). Replaces the old boolean `uploading`.
type UploadState =
  | { status: 'idle' }
  | { status: 'uploading'; completed: number; total: number; currentRatio: number; currentName?: string }
  | { status: 'done' }
  | { status: 'error'; message: string };

const EXPIRATION_OPTIONS: { value: ExpirationOption; label: string }[] = [
  { value: '1h', label: '1h' },
  { value: '2h', label: '2h' },
  { value: '6h', label: '6h' },
  { value: '24h', label: '24h' },
  { value: 'forever', label: '∞' },
];

export function EditorialDropZone({
  theme = 'light',
  workspaceId = null,
  workspaceMembers = [],
  customCategories = [],
  onCreateCategory,
  showChat = false,
  editModalOpen = false,
  onToggleChat,
  unreadCount = 0,
  mentionableDrops = [],
  onStartCall,
  callCanStart = true,
  callAccessLoading = false,
  callAccessError = null,
  onRefreshCallAccess,
}: EditorialDropZoneProps) {
  const { user } = useAuth();
  const [isDragging, setIsDragging] = useState(false);
  const [uploadState, setUploadState] = useState<UploadState>({ status: 'idle' });
  // True only while a PUT is in flight — drives the cross-fade + the paste re-entrancy guard.
  const busy = uploadState.status === 'uploading';
  // Derived error surfaced in the error block below the drop box (from the richer upload state).
  const error = uploadState.status === 'error' ? uploadState.message : null;
  const [showTextModal, setShowTextModal] = useState(false);
  const [expiration, setExpiration] = useState<ExpirationOption>('2h');
  const [showForeverLocked, setShowForeverLocked] = useState(false);
  // The start route can finish after the create modal has been closed. Its epoch is invalidated by
  // every explicit call cancellation so a late route result cannot open the call.
  const callStartEpochRef = useRef(0);
  const callStartStreamRef = useRef<MediaStream | null>(null);
  // Open/Locked toggle for shared-workspace drops. Defaults Open; hidden for personal drops (Phase 3).
  const [locked, setLocked] = useState(false);
  const { tier, loading: tierLoading } = useUserTier();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const tc = getEditorialThemeColors(theme);

  const cancelCallStart = useCallback(() => {
    callStartEpochRef.current += 1;
    callStartStreamRef.current?.getTracks().forEach((track) => track.stop());
    callStartStreamRef.current = null;
  }, []);

  // Also cancel if the whole drop zone disappears while the route is still pending.
  useEffect(() => cancelCallStart, [cancelCallStart]);

  // --- File upload helpers ---
  const uploadFiles = useCallback(
    async (files: File[]) => {
      // Block a 2nd concurrent upload (drop / file-select / paste while one is already running).
      // `busy` is in the dep array below so this reads the LIVE value, not a stale closure.
      if (busy) return;
      if (!user || files.length === 0) return;
      const total = files.length;
      let completed = 0;
      // Accumulate per-file failures. The old code overwrote setError each iteration, so only the
      // LAST file's error survived and never named the file. We surface every failed filename.
      const failed: { name: string; message: string }[] = [];
      setUploadState({ status: 'uploading', completed: 0, total, currentRatio: 0, currentName: files[0]?.name });
      const creatorName =
        user.displayName || user.email?.split('@')[0] || undefined;
      try {
        for (const file of files) {
          // createFileDrop currently converts every exception into { drop: null, error }, but wrap
          // the call so uploadFiles is self-sufficient: if it ever throws, record the file as failed
          // (so finally settles to error, never 'done') and never let a rejection escape the loop.
          try {
            const result = await createFileDrop(
              user.uid,
              file,
              expiration,
              workspaceId,
              workspaceMembers,
              creatorName,
              locked,
              // Real byte progress for the in-flight PUT. Guarded so a late tick after the window
              // closed can't mutate a non-uploading state.
              (ratio: number) =>
                setUploadState((prev) =>
                  prev.status === 'uploading'
                    ? { ...prev, currentRatio: ratio, currentName: file.name }
                    : prev
                )
            );
            if (result.error) {
              failed.push({ name: file.name, message: result.error });
            }
          } catch {
            failed.push({ name: file.name, message: 'Failed to upload file. Please try again.' });
          }
          completed += 1;
          setUploadState((prev) =>
            prev.status === 'uploading' ? { ...prev, completed } : prev
          );
        }
      } finally {
        // ALWAYS settle — the UI must never get stuck "uploading", even if something throws.
        if (failed.length > 0) {
          // Surface the rich, actionable per-file reason (e.g. "File too large. Maximum size is
          // 500MB"), prepending each filename since createFileDrop's strings don't include it —
          // matching classic DropZone, which shows result.error verbatim, not just the name.
          const detail = failed.map((f) => `${f.name}: ${f.message}`).join('; ');
          setUploadState({
            status: 'error',
            message:
              failed.length === total
                ? detail
                : `Uploaded ${completed - failed.length} of ${total}. Failed — ${detail}`,
          });
        } else {
          // busy flips false -> the progress overlay cross-fades back to the idle layer (~350ms).
          setUploadState({ status: 'done' });
        }
      }
    },
    [busy, user, expiration, workspaceId, workspaceMembers, locked]
  );

  // --- Drag & Drop ---
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      const files = Array.from(e.dataTransfer.files);
      await uploadFiles(files);
    },
    [uploadFiles]
  );

  // --- File input ---
  const handleFileSelect = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      if (!e.target.files) return;
      const files = Array.from(e.target.files);
      await uploadFiles(files);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    },
    [uploadFiles]
  );

  // --- Text drop ---
  const handleTextSubmit = async (
    name: string,
    content: string,
    textExpiration: ExpirationOption,
    category?: string,
    imageFile?: File,
    categories?: string[],
    isDrawing?: boolean,
    locked: boolean = false,
    reminderAt?: Date | null
  ) => {
    // Defense-in-depth: the text modal can't be opened mid-upload (Add Text is disabled + the
    // heading click area is pointer-events-none while busy), so this is normally unreachable — but
    // guard anyway so the busy-lock is self-contained, matching uploadFiles.
    if (busy) return;
    if (!user) return;
    const creatorName =
      user.displayName || user.email?.split('@')[0] || undefined;
    // Reuse the upload state so the dropzone shows the same busy UI. createTextDrop returns
    // Drop | null (no error field) — a null return becomes an error (don't swallow it silently, and
    // certainly not worse than today, which closed the modal with no feedback at all).
    setUploadState({ status: 'uploading', completed: 0, total: 1, currentRatio: 0, currentName: name });
    try {
      const drop = await createTextDrop(
        user.uid,
        name,
        content,
        textExpiration,
        workspaceId,
        workspaceMembers,
        category,
        creatorName,
        imageFile,
        categories,
        isDrawing,
        locked,
        reminderAt ?? null
      );
      if (!drop) {
        setUploadState({ status: 'error', message: 'Failed to create text drop. Please try again.' });
        return;
      }
      setUploadState({ status: 'done' });
    } catch {
      setUploadState({ status: 'error', message: 'Failed to create text drop. Please try again.' });
    } finally {
      setShowTextModal(false);
    }
  };

  // LIVE CALL start — the host pressed Start in the TextModal's Call mode. The start route is the
  // SOLE creator of a call drop (one-call-per-workspace enforced server-side); on success, hand the
  // callDropId + the preview stream up to the page so the mesh can adopt the stream + join.
  const handleStartCall = async (stream: MediaStream | null) => {
    retractFooterIfUp();
    if (!workspaceId || !user) {
      stream?.getTracks().forEach((track) => track.stop());
      return;
    }
    const startEpoch = ++callStartEpochRef.current;
    callStartStreamRef.current = stream;
    try {
       const result = await startCallRoute(workspaceId);
       if (callStartEpochRef.current !== startEpoch) {
         stream?.getTracks().forEach((track) => track.stop());
         if (callStartStreamRef.current === stream) callStartStreamRef.current = null;
         // startCallRoute creates the caller as the first participant. Reuse the normal leave route
         // so the last-leaver transaction deletes that just-created call and its roster entry.
         if (result.created) {
           await leaveCallRoute(result.callDropId).catch((cleanupError) => {
             console.warn('Failed to clean up cancelled call start:', cleanupError);
           });
         }
         return;
       }
       await onStartCall?.(result.callDropId, stream, result);
     } catch (err) {
       if (callStartEpochRef.current !== startEpoch) return;
       stream?.getTracks().forEach((track) => track.stop());
       console.error('Failed to start call:', err);
       setUploadState({ status: 'error', message: err instanceof Error ? err.message : 'Failed to start the call. Please try again.' });
     } finally {
       if (callStartEpochRef.current === startEpoch) {
         if (callStartStreamRef.current === stream) callStartStreamRef.current = null;
         setShowTextModal(false);
       }
     }
  };

  // --- Clipboard paste ---
  useEffect(() => {
    const handlePaste = async (e: ClipboardEvent) => {
      if (!user || busy || showTextModal || editModalOpen) return;
      const target = e.target as HTMLElement;
      if (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable
      )
        return;

      const items = e.clipboardData?.items;
      if (!items) return;

      const imageFiles: File[] = [];
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          const blob = item.getAsFile();
          if (blob) {
            const ext = item.type.split('/')[1] || 'png';
            const file = new File([blob], `pasted-image-${Date.now()}.${ext}`, {
              type: item.type,
            });
            imageFiles.push(file);
          }
        }
      }

      if (imageFiles.length > 0) {
        e.preventDefault();
        await uploadFiles(imageFiles);
      }
    };

    document.addEventListener('paste', handlePaste);
    return () => document.removeEventListener('paste', handlePaste);
  }, [user, busy, showTextModal, uploadFiles, editModalOpen]);

  // --- Border/shadow states ---
  const borderClass = isDragging
    ? `${tc.dragBorder} border-2`
    : `${tc.border} ${tc.hoverBorder} border`;

  const shadowClass = isDragging ? 'shadow-lg' : '';

  const bgClass = isDragging ? tc.dragBg : tc.bg;
  const textClass = isDragging ? tc.dragText : tc.text;
  const mutedClass = isDragging ? tc.dragMuted : tc.muted;

  // Upload-progress display values (only meaningful while busy). % is the in-flight PUT's wire ratio
  // (0..100). No byte counts are shown, so the ~33% base64 wire inflation on the encrypted path is
  // irrelevant — the % still climbs 0->100. index is clamped so it never reads "N+1 of N".
  const isUploadingState = uploadState.status === 'uploading';
  const pct = isUploadingState ? Math.round(uploadState.currentRatio * 100) : 0;
  const progressLabel = isUploadingState
    ? uploadState.total > 1
      ? `Uploading ${Math.min(uploadState.completed + 1, uploadState.total)} of ${uploadState.total} · ${pct}%`
      : `Uploading… ${pct}%`
    : '';

  return (
    <>
      {/* Section header */}
      <div className={`flex items-center transition-all duration-[350ms] ease-[cubic-bezier(0.4,0,0.2,1)] ${showChat ? 'gap-2.5 mb-4' : 'gap-3 mb-6'}`}>
        <span className={`rounded-full ${tc.activePillBg} transition-all duration-[350ms] ease-[cubic-bezier(0.4,0,0.2,1)] ${showChat ? 'w-1.5 h-1.5' : 'w-1.5 h-1.5'}`}></span>
        <h2 className={`${tc.fontClass} ${tc.text} font-medium tracking-tight transition-all duration-[350ms] ease-[cubic-bezier(0.4,0,0.2,1)] ${showChat ? 'text-lg' : 'text-xl'}`}>Upload</h2>
      </div>

      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={`${bgClass} ${borderClass} rounded-xl ${shadowClass} text-left transition-all duration-[350ms] ease-[cubic-bezier(0.4,0,0.2,1)] ${showChat ? 'p-8' : 'p-10'}`}
      >
        {/* Hidden file input */}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          onChange={handleFileSelect}
          className="hidden"
        />

        {/* Cross-fade region. The IDLE layer stays in normal flow so it permanently reserves the
            box's full height (the box can NEVER shrink during upload); the PROGRESS layer is an
            absolute overlay that cross-fades in over it. Pure opacity, no transform -> no jiggle
            (repo rule). Both layers are always mounted; only opacity + pointer-events toggle. */}
        {/* Cross-fade region. The fade + absolute progress overlay are scoped to ONLY the
            heading+subtitle+buttons sub-wrapper, so the mobile Chat button — rendered as a sibling
            AFTER it — is never faded and never covered: usable + pixel-fixed during upload. The idle
            content stays in normal flow (box can't shrink); pure opacity, no transform (repo rule).
            The outer div carries the pb the old idle layer had, so the Chat button's vertical
            position is byte-identical to before (h2 + mb-2 + subtitle + mb-6 + buttons + mt-3 + Chat
            + pb — same flow in both states). */}
        <div
          className={`${showChat ? 'pb-6' : 'pb-8'} ${busy ? '' : 'cursor-pointer'}`}
          onClick={(e) => {
            // The ONE click-to-open-text-modal handler for this whole region — heading, subtitle,
            // button-row whitespace, AND the padding strip down to the divider line (restored). Only
            // when idle; never mid-upload. The action buttons (Browse/Add-Text/Chat) stopPropagation,
            // so they never reach here; closest('button') is belt-and-suspenders (matches original).
            if (busy) return;
            const target = e.target as HTMLElement;
            if (target.tagName === 'BUTTON' || target.closest('button')) return;
            retractFooterIfUp();
            setShowTextModal(true);
          }}
        >
          {/* Sub-wrapper owns the relative scope for the absolute overlay (heading+buttons only). */}
          <div className="relative">
            {/* IDLE content — purely the fading visual layer for heading+buttons: in normal flow
                (reserves height → box can't shrink), fades out while busy. No onClick here — clicks
                bubble up to the outer container's single modal-opening handler. */}
            <div
              className={`transition-opacity duration-[350ms] ease-[cubic-bezier(0.4,0,0.2,1)] ${busy ? 'opacity-0 pointer-events-none' : 'opacity-100'}`}
            >
              {/* Title */}
              <h2
                className={`${tc.fontClass} ${textClass} font-medium tracking-tight mb-2 transition-all duration-[350ms] ease-[cubic-bezier(0.4,0,0.2,1)] ${showChat ? 'text-2xl' : 'text-[28px]'}`}
                style={{ fontFamily: 'Raleway, sans-serif' }}
              >
                Drop files here
              </h2>

              {/* Subtitle */}
              <p className={`text-sm ${tc.fontClass} ${mutedClass} mb-6`}>
                Or choose an option below &mdash; Max 500MB
              </p>

              {/* Action buttons */}
              <div className={`flex items-center gap-3 transition-all duration-[350ms] ease-[cubic-bezier(0.4,0,0.2,1)]`}>
                {/* Browse Files - primary */}
                <button
                  disabled={busy}
                  onClick={(e) => {
                    e.stopPropagation();
                    fileInputRef.current?.click();
                  }}
                  className={`${tc.fontClass} rounded-lg ${tc.activePillBg} ${tc.activePillText} hover:opacity-90 transition-all duration-[350ms] ease-[cubic-bezier(0.4,0,0.2,1)] ${showChat ? 'px-4 py-2.5 text-sm' : 'px-6 py-3 text-sm'} ${busy ? 'cursor-not-allowed' : ''}`}
                >
                  Browse Files
                </button>

                {/* Add Text - secondary */}
                <button
                  disabled={busy}
                  onClick={(e) => {
                    e.stopPropagation();
                    retractFooterIfUp();
                    setShowTextModal(true);
                  }}
                  className={`${tc.fontClass} rounded-lg border ${tc.border} bg-transparent ${tc.text} ${tc.hoverBorder} transition-all duration-[350ms] ease-[cubic-bezier(0.4,0,0.2,1)] ${showChat ? 'px-4 py-2.5 text-sm' : 'px-6 py-3 text-sm'} ${busy ? 'cursor-not-allowed' : ''}`}
                >
                  Add Text
                </button>
              </div>
            </div>

            {/* PROGRESS overlay — absolute, scoped to THIS sub-wrapper (covers heading+buttons only,
                NOT the Chat button below), cross-fades in while busy. The live % NUMBER is visible. */}
            <div
              className={`absolute inset-0 flex flex-col items-start justify-center gap-4 transition-opacity duration-[350ms] ease-[cubic-bezier(0.4,0,0.2,1)] ${busy ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
              aria-live="polite"
            >
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 border-2 border-current/30 border-t-current animate-spin rounded-full" />
                <p className={`text-sm ${tc.fontClass} ${textClass}`}>{progressLabel}</p>
              </div>
              {/* Thin progress bar — width tracks the live % */}
              <div className="w-full h-1.5 bg-current/10 rounded-full overflow-hidden">
                <div
                  className={`h-full ${tc.activePillBg} rounded-full transition-[width] duration-150 ease-linear`}
                  style={{ width: `${pct}%` }}
                />
              </div>
            </div>
          </div>

          {/* Chat - mobile only. Rendered as a SIBLING after the cross-fade sub-wrapper, so it is
              OUTSIDE both the opacity-fade and the progress overlay: always visible + clickable
              during upload, in its exact original position (same flex sm:hidden / mt-3 / classes). */}
          {/* Chat-row wrapper — no onClick/cursor now: the outer container's single handler covers
              this whitespace too. The Chat button's own onClick still shields it (toggle, no modal). */}
          {onToggleChat && (
            <div className="flex sm:hidden mt-3">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleChat();
                }}
                className={`${tc.fontClass} rounded-lg border ${tc.border} bg-transparent ${tc.text} ${tc.hoverBorder} transition-colors flex items-center gap-1.5 ${showChat ? 'px-4 py-2.5 text-sm' : 'px-6 py-3 text-sm'}`}
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                </svg>
                <span className={unreadCount > 0 && !showChat ? 'animate-text-rgb' : ''}>
                  {showChat ? 'Close Chat' : 'Chat'}
                </span>
              </button>
            </div>
          )}
        </div>

        {/* Expiry + lock — ALWAYS mounted (hoisted out of the old ternary so the row never vanishes
            during upload), but DISABLED + greyed while busy. The upload captured expiration/locked
            at drop time, so a mid-upload change wouldn't take effect anyway. (The mobile Chat toggle
            is a sibling above the cross-fade sub-wrapper, so it stays usable during upload.) */}
        <div
          className={`border-t ${tc.border} transition-opacity duration-[350ms] ease-[cubic-bezier(0.4,0,0.2,1)] ${showChat ? 'pt-4' : 'pt-6'} ${busy ? 'opacity-50' : 'opacity-100'}`}
        >
              <div className="flex items-end justify-between gap-4">
                <div>
                  <p className={`text-xs ${tc.fontClass} ${tc.muted} mb-2 tracking-wider uppercase`}>Expires after</p>
                  <div className="flex gap-2 flex-wrap">
                    {EXPIRATION_OPTIONS.map((option) => {
                      const pill = (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={(e) => {
                            e.stopPropagation();
                            if (option.value === 'forever' && tier === 'standard' && !tierLoading) {
                              setShowForeverLocked(true);
                              return;
                            }
                            setExpiration(option.value);
                          }}
                          className={`${tc.fontClass} rounded-full border transition-all duration-[350ms] ease-[cubic-bezier(0.4,0,0.2,1)] ${
                            expiration === option.value
                              ? `${tc.activePillBg} ${tc.activePillText} ${tc.border}`
                              : `bg-transparent ${tc.text} ${tc.border} ${tc.hoverBorder}`
                          } ${showChat ? 'px-3 py-1.5 text-xs' : 'px-4 py-2 text-sm'} ${busy ? 'cursor-not-allowed' : ''}`}
                        >
                          {option.label}
                        </button>
                      );
                      // Busy-only hover explanation for the disabled pills. Mounted ONLY when busy:
                      // idle pills are active (nothing to explain), and the Tooltip always renders its
                      // `content` bubble on hover — so mounting it idle would show an empty bubble.
                      // The Tooltip's inline-flex wrapper shrink-wraps the button (no margin/padding/
                      // border), so wrapping the pill does not shift the flex row (layout-neutral).
                      return busy ? (
                        <Tooltip key={option.value} content="Unavailable while uploading">
                          {pill}
                        </Tooltip>
                      ) : (
                        <Fragment key={option.value}>{pill}</Fragment>
                      );
                    })}
                  </div>
                </div>
                {workspaceId && (
                  <Tooltip content={busy ? 'Unavailable while uploading' : (locked ? 'Locked — only the creator can edit' : 'Open — anyone can edit')}>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={(e) => { e.stopPropagation(); setLocked(!locked); }}
                      aria-label={locked ? 'Locked — only the creator can edit' : 'Open — anyone can edit'}
                      className={`flex items-center justify-center ${tc.fontClass} rounded-full border transition-all duration-[350ms] ease-[cubic-bezier(0.4,0,0.2,1)] ${
                        locked
                          ? `${tc.activePillBg} ${tc.activePillText} ${tc.border}`
                          : `bg-transparent ${tc.text} ${tc.border} ${tc.hoverBorder}`
                      } ${showChat ? 'px-3 py-1.5 text-xs' : 'px-4 py-2 text-sm'} ${busy ? 'cursor-not-allowed' : ''}`}
                    >
                      {locked ? (
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                        </svg>
                      ) : (
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M8 11V7a4 4 0 118 0m-4 8v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2z" />
                        </svg>
                      )}
                    </button>
                  </Tooltip>
                )}
              </div>
            </div>
      </div>

      {/* Error message */}
      {error && (
        <div
          className={`mt-4 border ${tc.border} ${tc.roundedClass} ${tc.bg} px-5 py-3 flex items-center justify-between`}
        >
          <span className={`text-sm ${tc.fontClass} ${tc.text}`}>
            {error}
          </span>
          <button
            onClick={() => setUploadState({ status: 'idle' })}
            className={`${tc.text} hover:opacity-60 transition-opacity`}
          >
            <svg
              className="w-4 h-4"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>
      )}

      {/* Text Modal */}
      {showTextModal && (
        <EditorialTextModal
          onSubmit={handleTextSubmit}
          onClose={() => {
            cancelCallStart();
            setShowTextModal(false);
          }}
          theme={theme}
          customCategories={customCategories}
          onCreateCategory={onCreateCategory}
          mentionableDrops={mentionableDrops}
          isWorkspace={!!workspaceId}
          onCancelCallStart={cancelCallStart}
          onStartCall={handleStartCall}
          callCanStart={callCanStart}
          callAccessLoading={callAccessLoading}
          callAccessError={callAccessError}
          onRefreshCallAccess={onRefreshCallAccess}
        />
      )}

      {showForeverLocked && (
        <ForeverLockedModal variant="editorial" theme={theme} onClose={() => setShowForeverLocked(false)} />
      )}
    </>
  );
}
