'use client';

import { useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import { useOperations, dismissOperation, cancelOperation, retryOperation } from '@/lib/operationCenter';
import type { Operation, OperationKind } from '@/lib/operationCenter';
import { getEditorialThemeColors } from './editorial/editorialTheme';

// The operations notification panel (record §4 D28): one card per running/settled bulk
// operation, docked bottom-right above the ArchiveChipStack (same --archive-stack-clearance
// consumption as Toast). Success departs itself after ~5 s; failure stays with Retry.
// Desktop-only this round (D28h) — no phone placement.

const VERBS: Record<OperationKind, [string, string]> = {
  move: ['Moving', 'Moved'],
  copy: ['Copying', 'Copied'],
  delete: ['Deleting', 'Deleted'],
};

const MAX_VISIBLE = 3;

// Hydration-safe mount gate: false during SSR and the hydration pass, true once the client
// store is live. Keeps createPortal off the server without losing the last card's exit fade.
const emptySubscribe = () => () => {};
const getClientSnapshot = () => true;
const getServerSnapshot = () => false;

function useMounted() {
  return useSyncExternalStore(emptySubscribe, getClientSnapshot, getServerSnapshot);
}

function CheckCircleIcon() {
  return (
    <svg className="w-4 h-4 shrink-0 text-emerald-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
      <circle cx="12" cy="12" r="9" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M8.5 12.5l2.5 2.5 4.5-5" />
    </svg>
  );
}

function FailCircleIcon() {
  return (
    <svg className="w-4 h-4 shrink-0 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
      <circle cx="12" cy="12" r="9" />
      <path strokeLinecap="round" d="M9 9l6 6M15 9l-6 6" />
    </svg>
  );
}

function TransferTrack({ done, total }: { done: number; total: number }) {
  const pct = Math.round((done / total) * 100);
  return (
    <div className="relative h-[3px] rounded-full bg-current/20 overflow-hidden">
      <motion.div
        className="absolute inset-y-0 left-0 bg-current rounded-full"
        initial={false}
        animate={{ width: `${pct}%` }}
        transition={{ type: 'spring', stiffness: 260, damping: 30 }}
      />
    </div>
  );
}

function DissolveDots({ done, total }: { done: number; total: number }) {
  return (
    <div className="flex items-center gap-1 flex-wrap">
      {Array.from({ length: total }).map((_, index) => (
        <motion.span
          key={index}
          className="w-1.5 h-1.5 rounded-full bg-current"
          initial={false}
          animate={{ opacity: index < done ? 0.2 : 0.8 }}
          transition={{ duration: 0.35 }}
        />
      ))}
    </div>
  );
}

function OperationCard({ op, theme }: { op: Operation; theme: 'light' | 'dark' | 'minimal' }) {
  const tc = getEditorialThemeColors(theme);
  const [running, past] = VERBS[op.kind];
  const noun = op.total === 1 ? 'drop' : 'drops';
  const failedCount = op.failed.length;
  const remaining = op.total - op.done - failedCount;

  let title: string;
  let subtitle: string;
  if (op.status === 'running') {
    title = `${running} ${op.total} ${noun}`;
    const progress = `${op.done} of ${op.total}`;
    const tail = op.cancelled ? ' · Cancelled' : '';
    subtitle = op.kind === 'delete' ? `${progress}${tail}` : `to ${op.targetName} · ${progress}${tail}`;
  } else if (op.status === 'succeeded') {
    title = `${past} ${op.done} ${op.done === 1 ? 'drop' : 'drops'}`;
    subtitle = op.kind === 'delete' ? '' : `to ${op.targetName}`;
  } else if (op.done === 0) {
    title = `${past} failed`;
    subtitle = op.failed[0]?.error || 'Nothing was changed.';
  } else {
    title = `${op.done} of ${op.total} ${past.toLowerCase()} — ${failedCount} failed`;
    subtitle = op.failed.map(f => f.drop.name || 'Untitled').join(', ');
  }

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 14, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 8, scale: 0.97 }}
      transition={{ type: 'spring', stiffness: 320, damping: 30 }}
      role={op.status === 'failed' ? 'alert' : 'status'}
      className={`relative rounded-lg border ${tc.border} ${tc.bg} shadow-lg px-3.5 py-3 pr-9 ${tc.fontClass}`}
    >
      <div className="flex items-start gap-2.5">
        {op.status === 'running' && (
          <div className="w-4 h-4 mt-0.5 shrink-0 rounded-full border-2 border-current/30 border-t-current animate-spin" />
        )}
        {op.status === 'succeeded' && <CheckCircleIcon />}
        {op.status === 'failed' && <FailCircleIcon />}
        <div className="min-w-0 flex-1">
          <p className={`text-[13px] font-medium ${op.status === 'failed' ? 'text-red-500' : tc.text} truncate`}>{title}</p>
          {subtitle && <p className={`text-[11px] ${tc.muted} mt-0.5 truncate`}>{subtitle}</p>}
          {op.status === 'running' && op.total > 1 && (
            <div className={`mt-2 ${op.kind === 'delete' ? '' : 'text-current'}`}>
              {op.kind === 'delete'
                ? (op.total <= 12 ? <DissolveDots done={op.done} total={op.total} /> : <TransferTrack done={op.done} total={op.total} />)
                : <TransferTrack done={op.done} total={op.total} />}
            </div>
          )}
          {op.status === 'failed' && (
            <div className="mt-2 flex items-center gap-2">
              <button
                onClick={() => retryOperation(op.id)}
                className={`text-[11px] px-2.5 py-1 rounded-md ${tc.activePillBg} ${tc.activePillText} hover:opacity-90 transition-opacity`}
              >
                Retry {failedCount > 0 ? failedCount : ''}
              </button>
              <button
                onClick={() => dismissOperation(op.id)}
                className={`text-[11px] ${tc.muted} hover:${tc.text} transition-colors`}
              >
                Dismiss
              </button>
            </div>
          )}
          {op.status === 'running' && (
            <button
              onClick={() => cancelOperation(op.id)}
              className={`mt-2 text-[11px] ${tc.muted} hover:${tc.text} transition-colors`}
            >
              Cancel{remaining > 0 ? ` ${remaining}` : ''}
            </button>
          )}
        </div>
      </div>
      {op.status !== 'running' && (
        <button
          onClick={() => dismissOperation(op.id)}
          aria-label="Dismiss notification"
          className={`absolute top-2 right-2 ${tc.muted} hover:${tc.text} transition-colors p-1`}
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
            <path strokeLinecap="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      )}
    </motion.div>
  );
}

export function OperationsPanel({ theme = 'light' }: { theme?: 'light' | 'dark' | 'minimal' }) {
  const mounted = useMounted();
  const { operations } = useOperations();
  const visible = operations.slice(-MAX_VISIBLE);
  const overflow = operations.length - visible.length;
  if (!mounted) return null;
  return createPortal(
    <div
      className="fixed right-6 max-[639px]:right-[14px] z-[60] flex flex-col gap-2 w-[340px] max-w-[calc(100vw-28px)]"
      style={{ bottom: 'max(24px, var(--archive-stack-clearance, 0px))' }}
    >
      <AnimatePresence initial={false}>
        {overflow > 0 && (
          <motion.div key="overflow" layout initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className={`text-[10px] text-right pr-1 ${getEditorialThemeColors(theme).muted}`}>
            +{overflow} earlier
          </motion.div>
        )}
        {visible.map(op => (
          <OperationCard key={op.id} op={op} theme={theme} />
        ))}
      </AnimatePresence>
    </div>,
    document.body
  );
}
