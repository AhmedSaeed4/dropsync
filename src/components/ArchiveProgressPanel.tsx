'use client';

import { useMemo, useState, useSyncExternalStore } from 'react';
import { useBodyScrollLock } from '@/hooks/useBodyScrollLock';
import { useModalBackClose } from '@/hooks/useModalBackClose';
import { getArchiveTaskManager } from '@/lib/archiveTaskManager';
import { getEditorialThemeColors } from './editorial/editorialTheme';

type Theme = 'light' | 'dark' | 'minimal';
type Variant = 'classic' | 'editorial';

export function ArchiveProgressPanel({ jobId, uid, theme, variant, onBack, showAllInitially = false }: {
  jobId: string; uid: string; theme: Theme; variant: Variant; onBack: () => void; showAllInitially?: boolean;
}) {
  const manager = getArchiveTaskManager();
  const store = useSyncExternalStore(manager.subscribe, manager.getSnapshot, manager.getSnapshot);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(showAllInitially);
  const active = store.active?.jobId === jobId ? store.active : null;
  const settled = store.settled.find((item) => item.jobId === jobId && !item.dismissed);
  const item = active || settled;
  const isEditorial = variant === 'editorial';
  const isDark = theme === 'dark';
  const isMinimal = theme === 'minimal';
  const colors = useMemo(() => {
    if (isEditorial) {
      const editorialColors = getEditorialThemeColors(theme);
      return {
        // Dark editorial gets the theme border color on the outer frame (bare `border` would
        // otherwise fall back to currentColor = white). Light/minimal keep their existing look.
        panel: `${isDark ? editorialColors.bg : editorialColors.cardBg} ${isDark ? editorialColors.border : ''}`,
        text: editorialColors.text,
        muted: editorialColors.muted,
        border: editorialColors.border,
        // Dark editorial uses the dark primary (never the white activePillBg) to match
        // WorkspaceOptionsModal; light/minimal keep the black pill primary.
        primary: isDark
          ? 'bg-[#1a1a1a] hover:bg-[#333] text-white'
          : `${editorialColors.activePillBg} ${editorialColors.activePillText} hover:opacity-90`,
        secondary: `${editorialColors.btnBg} ${editorialColors.btnText} ${editorialColors.btnBorder} ${editorialColors.inactivePillHoverBg}`,
        font: editorialColors.fontClass,
        rounded: editorialColors.roundedClass,
        progressTrack: theme === 'dark' ? 'bg-white/10' : 'bg-[#1A1A1A]/10',
        progressBar: editorialColors.activePillBg,
      };
    }
    return {
      panel: `${isDark ? 'bg-[#1A1A1A] border-white/10' : isMinimal ? 'bg-[#D4D8C8] border-[#1A1A1A]/20 rounded-lg' : 'bg-white border-[#1A1A1A]'}`,
      text: isDark ? 'text-white' : 'text-[#1A1A1A]',
      muted: isDark ? 'text-white/55' : 'text-[#1A1A1A]/55',
      border: isDark ? 'border-white/10' : isMinimal ? 'border-[#1A1A1A]/20' : 'border-[#1A1A1A]/20',
      primary: isMinimal ? 'bg-[#1A1A1A] text-white hover:bg-[#333]' : 'bg-[#FF5A47] text-white hover:bg-[#ff705f]',
      secondary: isDark ? 'bg-white/10 text-white hover:bg-white/20' : 'bg-[#1A1A1A]/10 text-[#1A1A1A] hover:bg-[#1A1A1A]/20',
      font: isMinimal ? 'font-sans' : 'font-mono',
      rounded: isMinimal ? 'rounded-lg' : '',
      progressTrack: isDark ? 'bg-white/10' : 'bg-[#1A1A1A]/10',
      progressBar: 'bg-[#FF5A47]',
    };
  }, [isDark, isEditorial, isMinimal, theme]);
  const buttonClass = `px-4 ${isEditorial ? 'py-2.5 text-sm' : 'py-2 text-xs'} ${isEditorial || isMinimal ? 'tracking-wide' : 'font-mono uppercase tracking-wider'} ${colors.font} ${colors.rounded} transition-colors disabled:opacity-50 disabled:cursor-not-allowed`;
  useBodyScrollLock();
  useModalBackClose(true, onBack);

  const retry = async () => {
    setRetryError(null);
    try { await manager.retryCleanup(uid, jobId); onBack(); }
    catch (error) { setRetryError(error instanceof Error ? error.message : 'Cleanup is still incomplete.'); }
  };
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 overscroll-contain">
      <div className="fixed inset-0 bg-black/55" onClick={onBack} />
      <section role="dialog" aria-modal="true" aria-label="Archive progress" className={`relative z-10 w-full max-w-lg border shadow-2xl overflow-hidden ${colors.panel} ${colors.text} ${colors.rounded}`}>
        <div className={`px-5 py-4 border-b flex items-center justify-between ${colors.border}`}>
          <h2 className={`text-sm font-medium ${isEditorial ? 'tracking-wide' : 'font-mono uppercase tracking-wider'} ${colors.font} ${colors.text}`}>Archive progress</h2>
          <button type="button" onClick={onBack} className={`${colors.muted} hover:opacity-70 transition-opacity`} aria-label="Back to app">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="p-5 space-y-3">
          {item ? (
            <>
              <p role={settled ? 'alert' : 'status'} className={`text-sm ${colors.font} ${colors.text}`}>{active?.message || settled?.message}</p>
              {active?.currentName && <p className={`truncate text-xs ${colors.font} ${colors.muted}`}>{active.currentName}</p>}
              {active && <>
                <div className={`flex justify-between text-xs ${colors.font}`}><span>{active.status === 'succeeded' ? '✓' : active.status === 'cancelling' ? 'Cancelling…' : active.status}</span><span>{active.percent === null ? '…' : `${active.percent}%`}</span></div>
                <div className={`h-1 ${colors.progressTrack}`}><div className={`h-1 ${colors.progressBar}`} style={{ width: `${active.percent ?? 5}%` }} /></div>
                {active.totalItems > 0 && <p className={`text-xs ${colors.font} ${colors.muted}`}>{active.completedItems} of {active.totalItems} items</p>}
              </>}
              {retryError && <p role="alert" className={`text-xs ${isDark ? 'text-red-300' : 'text-red-600'}`}>{retryError}</p>}
            </>
          ) : <p className={`text-sm ${colors.font} ${colors.muted}`}>This archive has finished.</p>}
        </div>
        <div className={`flex justify-end gap-3 border-t px-5 py-4 ${colors.border}`}>
          <button type="button" onClick={onBack} className={`${buttonClass} border ${colors.secondary}`}>Back</button>
          {active?.canCancel && <button type="button" onClick={() => manager.requestCancel(jobId)} className={`${buttonClass} ${colors.primary}`}>Cancel</button>}
          {settled?.status === 'failed' && <button type="button" onClick={() => { manager.dismissVerifiedError(jobId); onBack(); }} className={`${buttonClass} border ${colors.secondary}`}>Dismiss</button>}
          {settled?.status === 'cleanup-needed' && <button type="button" onClick={() => void retry()} className={`${buttonClass} ${colors.primary}`}>Retry cleanup</button>}
        </div>
        {store.settled.filter((entry) => !entry.dismissed).length > 1 && (
          <div className="px-5 pb-5">
            <button type="button" onClick={() => setShowAll((value) => !value)} className={`text-xs underline ${colors.font} ${colors.muted}`}>Other archive errors</button>
            {showAll && <ul className={`mt-2 max-h-[30dvh] overflow-y-auto space-y-2 text-xs ${colors.font}`}>
              {store.settled.filter((entry) => !entry.dismissed).map((entry) => <li key={entry.jobId}><button type="button" onClick={() => { window.dispatchEvent(new CustomEvent('dropsync-archive-select', { detail: entry.jobId })); }} className={`w-full text-left border p-2 ${colors.border} ${colors.rounded}`}>{entry.message}</button></li>)}
            </ul>}
          </div>
        )}
      </section>
    </div>
  );
}
