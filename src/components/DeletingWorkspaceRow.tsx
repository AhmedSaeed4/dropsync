'use client';

import { useEffect, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { Workspace } from '@/types';
import { isDeletionPaused, onDeletionPaused, retryPausedDeletion } from '@/lib/workspaceDeletion';

interface Props {
  workspace: Workspace;
  theme: 'light' | 'dark' | 'minimal';
  variant: 'classic' | 'editorial';
  isOwnerView: boolean; // the deleting owner may Retry a paused job; members never can
}

// ROUND 12 (D-d/D-g) — v3: RESTORED to the owner-approved design
// (deleting-workspace-preview.html) after the v2 redesign was rejected. One-line
// row — dimmed icon + shimmer name + the subtle status word, no action buttons,
// dead (no hover highlight), shake on click. Hover shows the progress tooltip
// above every layer (z-index 60). The click-note is the mock's screen-level toast:
// portaled to <body> and pinned bottom-center, so it can never be clipped by the
// dropdown panel or the viewport edge (the v1 bug).
export function DeletingWorkspaceRow({ workspace, theme, variant, isOwnerView }: Props) {
  const [shake, setShake] = useState(false);
  const [note, setNote] = useState(false);
  const [pauseTick, setPauseTick] = useState(0);

  // Re-render when THIS job pauses/resumes (the Retry button appears/disappears).
  useEffect(
    () => onDeletionPaused((id) => { if (id === workspace.id) setPauseTick((t) => t + 1); }),
    [workspace.id],
  );
  void pauseTick;

  const done = workspace.deleteDone ?? 0;
  const total = workspace.deleteTotal ?? 0;
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  const paused = isOwnerView && isDeletionPaused(workspace.id);

  const isDark = theme === 'dark';
  const inkVars = (
    isDark
      ? { '--shimmer-ink': '#ffffff', '--shimmer-ink-light': '#999999' }
      : { '--shimmer-ink': '#1A1A1A', '--shimmer-ink-light': '#8a8a8a' }
  ) as CSSProperties;
  // Owner hands-on round 5: theme-aware ink in both variants (near-black on the dark
  // panel read as dim); on light the word matches the name — softer ink, not full black.
  const statusClass = variant === 'editorial'
    ? `text-[11px] font-medium ${isDark ? 'text-white/80' : 'text-[#1A1A1A]/75'}`
    : `text-[10px] font-medium ${isDark ? 'text-white/80' : 'text-[#1A1A1A]'}`;

  const deny = () => {
    setShake(true);
    setNote(true);
    setTimeout(() => setShake(false), 400);
    setTimeout(() => setNote(false), 2200);
  };

  return (
    <div
      className={`ws-deleting ${shake ? 'ws-deleting-shake' : ''}`}
      onClick={deny}
      data-testid={`deleting-row-${workspace.id}`}
    >
      <div className="flex items-center gap-2 flex-1 min-w-0">
        <svg className={`w-3.5 h-3.5 shrink-0 opacity-55 ${isDark ? 'text-white/90' : 'text-[#1A1A1A]'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0a2 2 0 014 0zM7 10a2 2 0 11-4 0a2 2 0 014 0z" />
        </svg>
        <span className={`truncate ${variant === 'editorial' ? 'text-sm' : ''}`}>
          <span className="shimmer-text" style={inkVars}>{workspace.name}</span>
        </span>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        {paused && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              retryPausedDeletion(workspace.id);
            }}
            className={`px-2 py-0.5 text-[10px] font-medium border rounded ${
              isDark ? 'border-white/30 text-white/80 hover:bg-white/10' : 'border-[#1A1A1A]/30 text-[#1A1A1A]/80 hover:bg-[#1A1A1A]/10'
            } transition-colors`}
          >
            Retry
          </button>
        )}
        <span className={statusClass}>Deleting…</span>
      </div>
      <div className={`ws-deleting-tip${isDark ? ' tip-dark' : ''}`} aria-hidden="true">
        {total > 0 ? `${done} of ${total} drops deleted (${pct}%)` : 'Deleting…'}
        <span className="ws-deleting-bar"><i style={{ width: `${pct}%` }} /></span>
      </div>
      {note && createPortal(
        <div className="ws-deleting-note">
          This workspace is being deleted — it will disappear when finished.
        </div>,
        document.body,
      )}
    </div>
  );
}
