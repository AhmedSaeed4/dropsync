'use client';

import type { ArchiveDisplaySnapshot, ArchiveSettledSnapshot } from '@/lib/archiveTaskManager';

export function ArchiveProgressChip({ item, overflowCount, contrast, onOpen, onCancel, onDismiss, onOverflow }: {
  item: ArchiveDisplaySnapshot | ArchiveSettledSnapshot;
  overflowCount: number;
  contrast: boolean;
  onOpen: () => void;
  onCancel: () => void;
  onDismiss: () => void;
  onOverflow: () => void;
}) {
  const active = 'currentName' in item ? item : null;
  const isError = item.status === 'failed' || item.status === 'cleanup-needed';
  const label = item.status === 'succeeded' ? '✓ Saved'
    : item.status === 'cancelling' ? 'Cancelling'
      : item.status === 'finalizing' ? 'Finalizing'
        : isError ? 'Error'
          : item.kind === 'import' ? 'Importing' : 'Exporting';
  const showDismiss = item.status === 'failed';
  const showCancel = !!active?.canCancel;
  const control = showDismiss ? onDismiss : showCancel ? onCancel : undefined;
  const controlLabel = showDismiss ? 'Dismiss archive error' : showCancel ? `Cancel ${item.kind}` : 'Unavailable';
  return (
    <div className={`archive-chip-row relative w-[300px] max-[639px]:w-[min(360px,calc(100vw-28px))] h-[26px] max-[639px]:h-11 pointer-events-auto ${contrast ? 'mix-blend-difference text-white' : 'text-current'}`} role={isError ? 'alert' : 'status'} aria-live={isError ? 'assertive' : 'polite'}>
      <div className="grid h-full w-full grid-cols-[11px_68px_64px_30px_60px_26px] gap-[7px] items-center max-[639px]:grid-cols-[9px_66px_minmax(0,52px)_30px_minmax(28px,1fr)_44px] max-[639px]:gap-[6px]">
        {isError
          ? <span className="text-[11px]" aria-hidden>!</span>
          : item.status === 'succeeded'
            ? <span className="text-[11px]" aria-hidden>✓</span>
            : <span className="w-[11px] h-[11px] max-[639px]:w-[9px] max-[639px]:h-[9px] border border-current/30 border-t-current rounded-full animate-spin" aria-hidden />}
        <button type="button" onClick={onOpen} className="min-w-0 text-left text-[11px] font-mono uppercase tracking-tight truncate" aria-label={`Open ${item.kind} details`}>{label}</button>
        <button type="button" onClick={onOpen} className="min-w-0 text-left text-[11px] truncate" title={active?.currentName || item.message}>{active?.currentName || ''}</button>
        <span className="text-right text-[10px] tabular-nums">{active?.percent === null || active?.percent === undefined ? '' : `${active.percent}%`}</span>
        <div className="relative h-[2px] bg-current/25" aria-hidden>
          {active?.percent !== null && active?.percent !== undefined && <div className="absolute inset-y-0 left-0 bg-current" style={{ width: `${active.percent}%` }} />}
          {overflowCount > 0 && <button type="button" onClick={onOverflow} className="absolute inset-[-12px] flex items-center justify-center bg-inherit text-[10px] font-mono" aria-label={`Show ${overflowCount} more archive errors`}>+{overflowCount}</button>}
        </div>
        <button type="button" disabled={!control} onClick={control} aria-label={controlLabel} className="h-[26px] w-[26px] max-[639px]:h-11 max-[639px]:w-11 text-center text-lg disabled:opacity-0">×</button>
      </div>
    </div>
  );
}
