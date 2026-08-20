'use client';

import { useRef, useState } from 'react';
import type { Workspace } from '@/types';
import {
  runYoutubeBackfill,
  type YoutubeBackfillProgress,
  type YoutubeBackfillResult,
} from '@/lib/youtubeBackfill';
import { getEditorialThemeColors } from './editorial/editorialTheme';

type Theme = 'light' | 'dark' | 'minimal';
type Variant = 'classic' | 'editorial';

interface YouTubeBackfillModalProps {
  userId: string;
  workspaces: Workspace[];
  theme: Theme;
  variant: Variant;
  onClose: () => void;
}

export function YouTubeBackfillModal({
  userId,
  workspaces,
  theme,
  variant,
  onClose,
}: YouTubeBackfillModalProps) {
  const [progress, setProgress] = useState<YoutubeBackfillProgress | null>(null);
  const [result, setResult] = useState<YoutubeBackfillResult | null>(null);
  const [running, setRunning] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const isEditorial = variant === 'editorial';
  const isDark = theme === 'dark';
  const isMinimal = theme === 'minimal';
  const tc = isEditorial ? getEditorialThemeColors(theme) : null;

  const colors = isEditorial && tc
    ? {
        panel: `${isDark ? tc.bg : tc.cardBg} ${tc.border}`,
        border: tc.border,
        text: tc.text,
        muted: tc.muted,
        primary: 'bg-[#1a1a1a] text-white hover:bg-[#333]',
        secondary: `${tc.btnBg} ${tc.btnText} ${tc.btnBorder} hover:bg-[#1a1a1a] hover:text-white`,
        track: theme === 'dark' ? 'bg-white/10' : 'bg-[#1A1A1A]/10',
        bar: tc.activePillBg,
        font: tc.fontClass,
      }
    : {
        panel: isDark ? 'bg-[#1A1A1A]' : isMinimal ? 'bg-[#D4D8C8]' : 'bg-white',
        border: isDark ? 'border-white/10' : isMinimal ? 'border-[#1A1A1A]/20' : 'border-[#1A1A1A]',
        text: isDark ? 'text-white' : 'text-[#1A1A1A]',
        muted: isDark ? 'text-white/60' : 'text-[#1A1A1A]/60',
        primary: isMinimal ? 'bg-[#1A1A1A] text-white hover:bg-[#333]' : 'bg-[#FF5A47] text-white hover:bg-[#ff705f]',
        secondary: isDark ? 'bg-white/10 text-white hover:bg-white/20' : 'bg-[#1A1A1A]/10 text-[#1A1A1A] hover:bg-[#1A1A1A]/20',
        track: isDark ? 'bg-white/10' : 'bg-[#1A1A1A]/10',
        bar: 'bg-[#FF5A47]',
        font: isMinimal ? 'font-sans tracking-wide' : 'font-mono uppercase tracking-wider',
      };

  const start = async () => {
    if (running) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);
    setResult(null);
    setProgress(null);
    try {
      const backfillResult = await runYoutubeBackfill({
        userId,
        workspaces,
        signal: controller.signal,
        onProgress: setProgress,
      });
      setResult(backfillResult);
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setRunning(false);
    }
  };

  const close = () => {
    if (running) {
      abortRef.current?.abort();
      return;
    }
    onClose();
  };

  const percent = progress && progress.processed > 0
    ? Math.min(99, Math.max(5, progress.phase === 'complete' ? 100 : progress.processed % 100))
    : progress?.phase === 'complete'
      ? 100
      : null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 overscroll-contain">
      <div className="fixed inset-0 bg-black/55" onClick={close} />
      <div className={`relative z-10 w-full max-w-lg border ${colors.panel} ${colors.border} ${isEditorial || isMinimal ? 'rounded-lg' : ''} shadow-2xl`}>
        <div className={`flex items-center justify-between border-b ${colors.border} px-5 py-4`}>
          <div>
            <h2 className={`text-sm ${colors.font} ${colors.text}`}>Find titles for my saved videos</h2>
            <p className={`mt-1 text-[11px] ${colors.font} ${colors.muted}`}>
              Only searchable video labels are added. Your drop content and encryption stay unchanged.
            </p>
          </div>
          <button type="button" onClick={close} className={`${colors.muted} hover:opacity-70`} aria-label="Close">
            ×
          </button>
        </div>

        <div className={`space-y-4 p-5 ${colors.font}`}>
          <div className={`text-xs leading-relaxed ${colors.muted}`}>
            This checks your personal drops and workspaces you currently belong to. Password drops,
            expired drops, files, and calls are skipped. The work is paced and can resume after a reload.
          </div>

          {progress && (
            <div className={`border ${colors.border} p-3 ${isEditorial || isMinimal ? 'rounded-lg' : ''}`}>
              <div className={`flex justify-between text-[11px] ${colors.muted}`}>
                <span>{progress.phase === 'paused' ? 'Paused — resume when ready' : progress.scopeName}</span>
                <span>{progress.processed} processed</span>
              </div>
              <div className={`mt-2 h-1 ${colors.track} ${isEditorial || isMinimal ? 'rounded-full' : ''}`}>
                <div
                  className={`h-1 ${colors.bar} ${isEditorial || isMinimal ? 'rounded-full' : ''}`}
                  style={{ width: `${percent ?? 5}%` }}
                />
              </div>
              <div className={`mt-2 grid grid-cols-2 gap-1 text-[10px] ${colors.muted}`}>
                <span>Labeled: {progress.labeled}</span>
                <span>Skipped: {progress.skipped}</span>
                <span>Waiting: {progress.unresolved}</span>
                <span>Errors: {progress.errors}</span>
              </div>
            </div>
          )}

          {result?.completed && (
            <p className={`border border-green-500/30 bg-green-500/10 p-3 text-xs text-green-700 ${isDark ? 'text-green-200' : ''}`}>
              Finished. {result.labeled} drop{result.labeled === 1 ? '' : 's'} received searchable video labels.
            </p>
          )}
          {result && !result.completed && !running && (
            <p className={`border border-amber-500/30 bg-amber-500/10 p-3 text-xs ${isDark ? 'text-amber-200' : 'text-amber-700'}`}>
              This run paused before every title was resolved.
              {result.unresolved > 0 && ' Some titles could not be fetched right now — the title service or YouTube was slow to answer.'}
              {' '}Press Resume to retry; after a few tries those drops are skipped so the rest can finish.
            </p>
          )}
        </div>

        <div className={`flex justify-end gap-2 border-t ${colors.border} px-5 py-4 ${colors.font}`}>
          <button type="button" onClick={close} className={`px-4 py-2 text-xs ${colors.secondary} ${isEditorial || isMinimal ? 'rounded-lg' : ''}`}>
            {running ? 'Pause' : 'Close'}
          </button>
          {!result?.completed && (
            <button type="button" onClick={() => void start()} disabled={running} className={`px-4 py-2 text-xs ${colors.primary} ${isEditorial || isMinimal ? 'rounded-lg' : ''} disabled:opacity-50`}>
              {running ? 'Working…' : progress ? 'Resume' : 'Start'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
