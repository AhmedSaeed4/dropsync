'use client';

import { useMemo, useRef, useState } from 'react';
import { useBodyScrollLock } from '@/hooks/useBodyScrollLock';
import { useModalBackClose } from '@/hooks/useModalBackClose';
import { Workspace } from '@/types';
import { getEditorialThemeColors } from '@/components/editorial/editorialTheme';
import { WORKSPACE_ARCHIVE_EXTENSION } from '@/lib/workspaceArchive';
import type {
  WorkspaceArchiveImportResult,
  WorkspaceArchiveInspection,
  WorkspaceArchiveProgress,
} from '@/lib/workspaceArchive';
import type {
  PersonalArchiveImportResult,
  PersonalArchiveInspection,
  PersonalArchiveProgress,
} from '@/lib/personalArchive';

type ArchiveInspection = WorkspaceArchiveInspection | PersonalArchiveInspection;
type ArchiveImportResult = WorkspaceArchiveImportResult | PersonalArchiveImportResult;
type WorkspaceArchiveDestination =
  | { mode: 'new'; workspaceName: string }
  | { mode: 'merge'; workspaceId: string };

interface WorkspaceArchiveModalProps {
  scope?: 'workspace' | 'personal';
  mode: 'export' | 'import';
  variant: 'classic' | 'editorial';
  theme: 'light' | 'dark' | 'minimal';
  currentWorkspace: Workspace | null;
  workspaces: Workspace[];
  onExport: (
    password: string,
    signal: AbortSignal,
    onProgress: (progress: WorkspaceArchiveProgress) => void
  ) => Promise<void>;
  onInspect: (
    file: File,
    password: string,
    signal: AbortSignal,
    onProgress: (progress: WorkspaceArchiveProgress | PersonalArchiveProgress) => void
  ) => Promise<ArchiveInspection>;
  onImport: (
    file: File,
    password: string,
    destination: WorkspaceArchiveDestination | undefined,
    signal: AbortSignal,
    onProgress: (progress: WorkspaceArchiveProgress | PersonalArchiveProgress) => void
  ) => Promise<ArchiveImportResult>;
  onCheckImportOverlap?: (archiveId: string, destinationWorkspaceId: string | null) => Promise<boolean>;
  onClose: () => void;
}

export function WorkspaceArchiveModal({
  scope = 'workspace',
  mode,
  variant,
  theme,
  currentWorkspace,
  workspaces,
  onExport,
  onInspect,
  onImport,
  onCheckImportOverlap,
  onClose,
}: WorkspaceArchiveModalProps) {
  const isPersonal = scope === 'personal';
  const isEditorial = variant === 'editorial';
  const isDark = theme === 'dark';
  const isMinimal = theme === 'minimal';
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [inspection, setInspection] = useState<ArchiveInspection | null>(null);
  const [destinationMode, setDestinationMode] = useState<'new' | 'merge'>('new');
  const [workspaceName, setWorkspaceName] = useState(
    currentWorkspace ? `${currentWorkspace.name} Restored` : 'Restored workspace'
  );
  const [targetWorkspaceId, setTargetWorkspaceId] = useState(currentWorkspace?.id || workspaces[0]?.id || '');
  const [progress, setProgress] = useState<WorkspaceArchiveProgress | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [completeMessage, setCompleteMessage] = useState<string | null>(null);
  const [checkingOverlap, setCheckingOverlap] = useState(false);
  const [duplicateWarning, setDuplicateWarning] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useBodyScrollLock();
  useModalBackClose(true, () => {
    if (!abortRef.current) onClose();
  });

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
        input: `${isDark ? editorialColors.bg : editorialColors.cardBg} ${editorialColors.border} ${editorialColors.text}`,
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
        error: theme === 'dark' ? 'border-red-300/30 bg-red-300/10 text-red-200' : 'border-red-500/30 bg-red-500/10 text-red-600',
        success: theme === 'dark' ? 'border-green-300/30 bg-green-300/10 text-green-200' : 'border-green-500/30 bg-green-500/10 text-green-700',
      };
    }
    return {
      panel: `${isDark ? 'bg-[#1A1A1A] border-white/10' : isMinimal ? 'bg-[#D4D8C8] border-[#1A1A1A]/20 rounded-lg' : 'bg-white border-[#1A1A1A]'}`,
      text: isDark ? 'text-white' : 'text-[#1A1A1A]',
      muted: isDark ? 'text-white/55' : 'text-[#1A1A1A]/55',
      border: isDark ? 'border-white/10' : isMinimal ? 'border-[#1A1A1A]/20' : 'border-[#1A1A1A]/20',
      input: isDark ? 'bg-[#0D0D0D] border-white/10 text-white' : isMinimal ? 'bg-[#C5C9B8] border-[#1A1A1A]/20 text-[#1A1A1A]' : 'bg-white border-[#1A1A1A]/20 text-[#1A1A1A]',
      primary: isMinimal ? 'bg-[#1A1A1A] text-white hover:bg-[#333]' : 'bg-[#FF5A47] text-white hover:bg-[#ff705f]',
      secondary: isDark ? 'bg-white/10 text-white hover:bg-white/20' : 'bg-[#1A1A1A]/10 text-[#1A1A1A] hover:bg-[#1A1A1A]/20',
      font: isMinimal ? 'font-sans' : 'font-mono',
      rounded: isMinimal ? 'rounded-lg' : '',
      progressTrack: isDark ? 'bg-white/10' : 'bg-[#1A1A1A]/10',
      progressBar: 'bg-[#FF5A47]',
      error: isDark ? 'border-red-300/30 bg-red-300/10 text-red-200' : 'border-red-500/30 bg-red-500/10 text-red-600',
      success: isDark ? 'border-green-300/30 bg-green-300/10 text-green-200' : 'border-green-500/30 bg-green-500/10 text-green-700',
    };
  }, [isDark, isEditorial, isMinimal, theme]);

  const labelClass = `text-[10px] ${isEditorial || isMinimal ? 'tracking-wide' : 'font-mono uppercase tracking-wider'} ${colors.font} ${colors.muted}`;
  const buttonClass = `px-4 ${isEditorial ? 'py-2.5 text-sm' : 'py-2 text-xs'} ${isEditorial || isMinimal ? 'tracking-wide' : 'font-mono uppercase tracking-wider'} ${colors.font} ${colors.rounded} transition-colors disabled:opacity-50 disabled:cursor-not-allowed`;
  const start = (operation: (controller: AbortController) => Promise<void>) => {
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    setProgress(null);
    setError(null);
    setCompleteMessage(null);
    setCheckingOverlap(false);
    setDuplicateWarning(false);
    operation(controller)
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) {
          setError(caught instanceof Error ? caught.message : 'The archive operation failed.');
        }
      })
      .finally(() => {
        if (abortRef.current === controller) abortRef.current = null;
        setBusy(false);
      });
  };

  const handleExport = () => {
    if (password.length < 8) {
      setError('Use an archive password with at least 8 characters.');
      return;
    }
    if (password !== confirmPassword) {
      setError('The passwords do not match.');
      return;
    }
    start(async (controller) => {
      await onExport(password, controller.signal, setProgress);
      setCompleteMessage(isPersonal ? 'Personal backup saved successfully.' : 'Workspace backup saved successfully.');
    });
  };

  const handleInspect = () => {
    if (!file) {
      setError('Choose a .dropsync file first.');
      return;
    }
    if (password.length < 8) {
      setError('Use the password that protects this archive.');
      return;
    }
    start(async (controller) => {
      const result = await onInspect(file, password, controller.signal, setProgress);
      setInspection(result);
      if (!isPersonal && 'sourceWorkspace' in result.manifest && result.manifest.sourceWorkspace.name) {
        setWorkspaceName(`${result.manifest.sourceWorkspace.name} Restored`);
      }
    });
  };

  const runImport = async (controller: AbortController) => {
    if (!file || !inspection) return;
    const result = await onImport(
      file,
      password,
      isPersonal
        ? undefined
        : destinationMode === 'new'
          ? { mode: 'new', workspaceName: workspaceName.trim() }
          : { mode: 'merge', workspaceId: targetWorkspaceId },
      controller.signal,
      setProgress
    );
    const details = [
      `Imported ${result.importedCount} drop${result.importedCount === 1 ? '' : 's'}.`,
      result.legacyExpiryFallbackCount
        ? 'This older backup had no saved remaining-time data, so finite drops restarted from their saved duration.'
        : 'Finite drop timers resumed from their saved remaining time.',
      result.zeroRemainingCount
        ? `${result.zeroRemainingCount} drop${result.zeroRemainingCount === 1 ? '' : 's'} may expire immediately after import.`
        : '',
      result.downgradedForeverCount ? `${result.downgradedForeverCount} forever drop${result.downgradedForeverCount === 1 ? '' : 's'} downgraded to 24 hours.` : '',
      result.unpinnedCount ? `${result.unpinnedCount} pin${result.unpinnedCount === 1 ? '' : 's'} adjusted for the two-pin limit.` : '',
    ].filter(Boolean);
    setCompleteMessage(details.join(' '));
    setDuplicateWarning(false);
    setInspection(null);
  };

  const handleImport = () => {
    if (!file || !inspection) return;
    if (!isPersonal && destinationMode === 'new' && !workspaceName.trim()) {
      setError('Enter a name for the restored workspace.');
      return;
    }
    if (!isPersonal && destinationMode === 'merge' && !targetWorkspaceId) {
      setError('Choose a destination workspace.');
      return;
    }
    const destinationWorkspaceId = !isPersonal && destinationMode === 'merge'
      ? targetWorkspaceId
      : null;
    if (!onCheckImportOverlap) {
      start(runImport);
      return;
    }
    start(async (controller) => {
      setCheckingOverlap(true);
      try {
        const hasOverlap = await onCheckImportOverlap(inspection.manifest.archiveId, destinationWorkspaceId);
        if (controller.signal.aborted) return;
        if (hasOverlap) {
          setDuplicateWarning(true);
          return;
        }
        setCheckingOverlap(false);
        await runImport(controller);
      } finally {
        setCheckingOverlap(false);
      }
    });
  };

  const handleImportAnyway = () => {
    if (!file || !inspection || !duplicateWarning) return;
    setDuplicateWarning(false);
    start(runImport);
  };

  const closeOrCancel = () => {
    setDuplicateWarning(false);
    setCheckingOverlap(false);
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
      setBusy(false);
      setProgress(null);
      return;
    }
    onClose();
  };

  const progressPercent = completeMessage
    ? 100
    : progress && progress.totalBytes > 0
      ? Math.min(100, Math.round((progress.processedBytes / progress.totalBytes) * 100))
      : null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 overscroll-contain">
      <div className="fixed inset-0 bg-black/55" onClick={closeOrCancel} />
      <div className={`relative z-10 w-full max-w-lg border ${colors.panel} ${colors.rounded} shadow-2xl overflow-hidden`}>
        <div className={`px-5 py-4 border-b ${colors.border} flex items-center justify-between`}>
          <div>
            <h2 className={`text-sm font-medium ${isEditorial ? 'tracking-wide' : 'font-mono uppercase tracking-wider'} ${colors.font} ${colors.text}`}>
              {mode === 'export'
                ? (isPersonal ? (isEditorial ? 'Export personal drops' : 'EXPORT_PERSONAL_DROPS') : (isEditorial ? 'Export workspace' : 'EXPORT_WORKSPACE'))
                : (isPersonal ? (isEditorial ? 'Import personal backup' : 'IMPORT_PERSONAL_BACKUP') : (isEditorial ? 'Import workspace backup' : 'IMPORT_WORKSPACE_BACKUP'))}
            </h2>
            <p className={`mt-1 text-[11px] ${colors.muted}`}>
              {mode === 'export'
                ? (isPersonal ? 'Create a password-protected copy. Your personal drops will not be changed.' : 'Create a password-protected copy. Your workspace will not be changed.')
                : 'Unlock a .dropsync backup and restore its contents.'}
            </p>
          </div>
          <button type="button" onClick={closeOrCancel} className={`${colors.muted} hover:opacity-70 transition-opacity`} aria-label="Close">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="p-5 space-y-4">
          {mode === 'export' ? (
            <>
              <div className={`border ${colors.border} ${colors.rounded} p-3 text-xs leading-relaxed ${colors.font} ${colors.muted}`}>
                {isPersonal
                  ? 'This includes all active personal text/file drops, drawings, custom categories, reminders, locked drops, and password-category drops. Calls, expired drops, share links, and encryption keys are excluded. Files at or above 10 MB remain raw binary on restore to match the live app\'s existing storage behavior.'
                  : 'This includes all active text/file drops, drawings, custom categories, display names, reminders, locked drops, and password-category drops. Chat, calls, expired drops, invite codes, share links, and encryption keys are excluded. Files at or above 10 MB remain raw binary on restore to match the live app\'s existing storage behavior.'}
              </div>
              <div>
                <label className={labelClass}>Archive password</label>
                <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} className={`mt-1 w-full border px-3 py-2 text-sm outline-none ${colors.input} ${colors.font} ${colors.rounded}`} autoComplete="new-password" />
              </div>
              <div>
                <label className={labelClass}>Confirm password</label>
                <input type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} className={`mt-1 w-full border px-3 py-2 text-sm outline-none ${colors.input} ${colors.font} ${colors.rounded}`} autoComplete="new-password" />
              </div>
              <p className={`text-[11px] ${colors.font} ${colors.muted}`}>DropSync cannot recover a forgotten archive password.</p>
            </>
          ) : (
            <>
              <div>
                <label className={labelClass}>Backup file</label>
                <input
                  type="file"
                  accept={WORKSPACE_ARCHIVE_EXTENSION}
                  onChange={(event) => { setFile(event.target.files?.[0] || null); setInspection(null); setDuplicateWarning(false); setError(null); }}
                  className={`mt-1 block w-full text-xs ${colors.font} ${colors.text}`}
                />
              </div>
              <div>
                <label className={labelClass}>Archive password</label>
                <input type="password" value={password} onChange={(event) => { setPassword(event.target.value); setInspection(null); setDuplicateWarning(false); }} className={`mt-1 w-full border px-3 py-2 text-sm outline-none ${colors.input} ${colors.font} ${colors.rounded}`} autoComplete="current-password" />
              </div>
              {!inspection && (
                <button type="button" onClick={handleInspect} disabled={busy || !file} className={`${buttonClass} ${colors.primary}`}>
                  {busy ? 'Checking…' : 'Check backup'}
                </button>
              )}
              {inspection && (
                <>
                  <div className={`border ${colors.border} ${colors.rounded} p-3 space-y-1 text-xs ${colors.font} ${colors.text}`}>
                    <p><strong>{isPersonal
                      ? (('sourceUser' in inspection.manifest && inspection.manifest.sourceUser?.displayName) ? `Personal drops from ${inspection.manifest.sourceUser.displayName}` : 'Personal drops')
                      : ('sourceWorkspace' in inspection.manifest ? inspection.manifest.sourceWorkspace.name : 'Workspace backup')}</strong></p>
                    <p className={colors.muted}>{inspection.dropCount} drops · {inspection.fileCount} files · {inspection.totalPayloadBytes.toLocaleString()} payload bytes</p>
                    {inspection.passwordDropCount > 0 && <p className="text-amber-600">Includes {inspection.passwordDropCount} password-category drop{inspection.passwordDropCount === 1 ? '' : 's'}.</p>}
                    {inspection.lockedDropCount > 0 && <p className={colors.muted}>Includes {inspection.lockedDropCount} locked drop{inspection.lockedDropCount === 1 ? '' : 's'}. Imported locks remain flags, but edit authority belongs to the importer.</p>}
                    {inspection.foreverDropCount > 0 && <p className="text-amber-600">Includes {inspection.foreverDropCount} forever drop{inspection.foreverDropCount === 1 ? '' : 's'}; standard-tier importers will downgrade them to 24 hours.</p>}
                    <p className={colors.muted}>
                      {inspection.manifest.drops.some((drop) => drop.remainingSeconds === undefined)
                        ? 'This older backup has no saved remaining-time data; finite drops will restart from their saved duration.'
                        : 'Finite drop timers resume with the time remaining when this backup was created.'}
                    </p>
                    {inspection.zeroRemainingDropCount > 0 && <p className={colors.muted}>{inspection.zeroRemainingDropCount} drop{inspection.zeroRemainingDropCount === 1 ? '' : 's'} may expire immediately after import.</p>}
                  </div>
                  {!isPersonal && (
                    <>
                      <div>
                        <label className={labelClass}>Destination</label>
                        <div className="mt-1 flex gap-2">
                          <button type="button" onClick={() => { setDestinationMode('new'); setDuplicateWarning(false); }} className={`${buttonClass} flex-1 border ${destinationMode === 'new' ? colors.primary : colors.secondary}`}>New workspace</button>
                          <button type="button" onClick={() => { setDestinationMode('merge'); setDuplicateWarning(false); }} className={`${buttonClass} flex-1 border ${destinationMode === 'merge' ? colors.primary : colors.secondary}`}>Merge</button>
                        </div>
                      </div>
                      {destinationMode === 'new' ? (
                        <div>
                          <label className={labelClass}>New workspace name</label>
                          <input value={workspaceName} onChange={(event) => setWorkspaceName(event.target.value)} className={`mt-1 w-full border px-3 py-2 text-sm outline-none ${colors.input} ${colors.font} ${colors.rounded}`} maxLength={120} />
                        </div>
                      ) : (
                        <div>
                          <label className={labelClass}>Merge into</label>
                          <select value={targetWorkspaceId} onChange={(event) => { setTargetWorkspaceId(event.target.value); setDuplicateWarning(false); }} className={`mt-1 w-full border px-3 py-2 text-sm outline-none ${colors.input} ${colors.font} ${colors.rounded}`}>
                            {workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}
                          </select>
                          <p className={`mt-1 text-[11px] ${colors.font} ${colors.muted}`}>Existing drops and members are unchanged. Imported drops receive fresh IDs.</p>
                        </div>
                      )}
                    </>
                  )}
                </>
              )}
            </>
          )}

          {progress && (
            <div className={`border ${colors.border} ${colors.rounded} p-3 ${colors.font}`}>
              <div className={`flex justify-between text-[11px] ${colors.muted}`}>
                <span>{progress.message || 'Working…'}</span>
                <span>{progressPercent === null ? '…' : `${progressPercent}%`}</span>
              </div>
              <div className={`mt-2 h-1 ${colors.progressTrack} ${colors.rounded}`}>
                <div className={`h-1 ${colors.progressBar} ${colors.rounded}`} style={{ width: `${progressPercent ?? 5}%` }} />
              </div>
              {progress.currentName && <p className={`mt-2 text-[10px] truncate ${colors.muted}`}>{progress.currentName}</p>}
            </div>
          )}
          {duplicateWarning && (
            <div role="alertdialog" aria-live="assertive" className={`border p-3 ${colors.border} ${colors.rounded} ${colors.font}`}>
              <p className={`text-xs ${colors.text}`}>Some of these drops are already here. Importing again will create duplicates. Continue?</p>
              <div className="mt-3 flex justify-end gap-2">
                <button type="button" onClick={() => setDuplicateWarning(false)} className={`${buttonClass} border ${colors.secondary}`}>Cancel</button>
                <button type="button" onClick={handleImportAnyway} disabled={busy} className={`${buttonClass} ${colors.primary}`}>Import anyway</button>
              </div>
            </div>
          )}
          {error && <p className={`border p-3 text-xs ${colors.font} ${colors.rounded} ${colors.error}`}>{error}</p>}
          {completeMessage && <p className={`border p-3 text-xs ${colors.font} ${colors.rounded} ${colors.success}`}>{completeMessage}</p>}
        </div>

        <div className={`px-5 py-4 border-t ${colors.border} flex justify-end gap-2 ${colors.font}`}>
          <button type="button" onClick={closeOrCancel} className={`${buttonClass} border ${colors.secondary}`}>
            {busy ? 'Cancel' : completeMessage ? 'Close' : 'Cancel'}
          </button>
          {mode === 'export' ? (
            <button type="button" onClick={handleExport} disabled={busy || !!completeMessage} className={`${buttonClass} ${colors.primary}`}>
              {busy ? 'Exporting…' : (isPersonal ? 'Export personal drops' : 'Export workspace')}
            </button>
          ) : inspection ? (
            <button type="button" onClick={handleImport} disabled={busy || !!completeMessage || duplicateWarning} className={`${buttonClass} ${colors.primary}`}>
              {busy ? (checkingOverlap ? 'Checking…' : 'Importing…') : (isPersonal ? 'Import personal drops' : 'Import backup')}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}