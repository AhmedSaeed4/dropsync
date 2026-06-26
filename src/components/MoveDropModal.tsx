'use client';

import { useState } from 'react';
import { useBodyScrollLock } from '@/hooks/useBodyScrollLock';
import { useModalBackClose } from '@/hooks/useModalBackClose';
import { Drop, Workspace } from '@/types';

interface MoveDropModalProps {
  drops: Drop | Drop[];
  workspaces: Workspace[];
  currentWorkspaceId: string | null;
  onMove: (drops: Drop[], targetWorkspaceId: string | null) => Promise<void>;
  onCopy: (drops: Drop[], targetWorkspaceId: string | null) => Promise<void>;
  onClose: () => void;
  theme?: 'light' | 'dark' | 'minimal';
}

export function MoveDropModal({ drops: dropsProp, workspaces, currentWorkspaceId, onMove, onCopy, onClose, theme = 'light' }: MoveDropModalProps) {
  useBodyScrollLock();
  const dropList = Array.isArray(dropsProp) ? dropsProp : [dropsProp];
  const isBulk = dropList.length > 1;
  const firstDrop = dropList[0];

  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(firstDrop.workspaceId);
  const [mode, setMode] = useState<'move' | 'copy'>('move');
  const [loading, setLoading] = useState(false);
  // Back closes only when not mid move/copy (matches the disabled X/backdrop).
  useModalBackClose(true, () => { if (!loading) onClose(); });
  const isDark = theme === 'dark';
  const isMinimal = theme === 'minimal';

  const currentName = firstDrop.workspaceId
    ? workspaces.find(w => w.id === firstDrop.workspaceId)?.name || 'Unknown'
    : 'Personal';
  const targetName = selectedWorkspaceId === null
    ? 'Personal'
    : workspaces.find(w => w.id === selectedWorkspaceId)?.name || 'Unknown';

  const allSameWorkspace = dropList.every(d => d.workspaceId === firstDrop.workspaceId);
  const isSameLocation = selectedWorkspaceId === firstDrop.workspaceId;

  const handleSubmit = async () => {
    if (isSameLocation) return;
    setLoading(true);
    if (mode === 'copy') await onCopy(dropList, selectedWorkspaceId);
    else await onMove(dropList, selectedWorkspaceId);
    setLoading(false);
  };

  const getThemeColors = () => {
    if (isMinimal) {
      return {
        borderColor: 'border-[#1A1A1A]/20',
        bgColor: 'bg-[#D4D8C8]',
        textColor: 'text-[#1A1A1A]',
        textMuted: 'text-[#1A1A1A]/50',
        textMuted2: 'text-[#1A1A1A]/30',
        headerBg: 'bg-[#1A1A1A]',
        inputBg: 'bg-[#C5C9B8]',
        fontClass: 'font-sans tracking-wide text-xs',
        roundedClass: 'rounded-lg',
        overlayBg: 'bg-[#1A1A1A]/70',
        warningBg: 'bg-[#1A1A1A]/5',
        warningBorder: 'border-[#1A1A1A]/15',
        selectedBg: 'bg-[#1A1A1A]/10',
      };
    }
    return {
      borderColor: isDark ? 'border-white/10' : 'border-[#1A1A1A]',
      bgColor: isDark ? 'bg-[#1A1A1A]' : 'bg-[#FAF7F2]',
      textColor: isDark ? 'text-white' : 'text-[#1A1A1A]',
      textMuted: isDark ? 'text-white/60' : 'text-[#1A1A1A]/60',
      textMuted2: isDark ? 'text-white/30' : 'text-[#1A1A1A]/30',
      headerBg: 'bg-[#FF5A47]',
      inputBg: isDark ? 'bg-[#0D0D0D]' : 'bg-white',
      fontClass: 'font-mono uppercase tracking-wider text-[10px]',
      roundedClass: '',
      overlayBg: 'bg-[#1A1A1A]/90',
      warningBg: isDark ? 'bg-yellow-900/20' : 'bg-amber-50',
      warningBorder: isDark ? 'border-yellow-800/30' : 'border-amber-200',
      selectedBg: isDark ? 'bg-white/5' : 'bg-[#1A1A1A]/5',
    };
  };

  const tc = getThemeColors();

  return (
    <div
      className={`fixed inset-0 ${tc.overlayBg} flex items-center justify-center z-50 p-4 transition-colors duration-300 overscroll-contain`}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className={`${tc.bgColor} border ${tc.borderColor} ${tc.roundedClass} w-full max-w-md max-h-[90vh] flex flex-col overflow-hidden transition-colors duration-300`}>
        {/* Header */}
        <div className={`border-b ${tc.borderColor} px-6 py-4 flex items-center justify-between ${tc.headerBg} ${tc.roundedClass} ${isMinimal ? 'rounded-bl-none rounded-br-none' : ''} shrink-0`}>
          <div>
            <h2 className={`${isMinimal ? 'text-sm font-medium' : 'text-sm font-bold uppercase tracking-wider'} text-white`}>
              {isBulk
                ? `${mode === 'copy' ? 'Copy' : 'Move'} ${dropList.length} drops`
                : isMinimal
                  ? (mode === 'copy' ? 'Copy drop' : 'Move drop')
                  : (mode === 'copy' ? 'COPY_DROP' : 'MOVE_DROP')}
            </h2>
            {!isBulk && (
              <p className="text-[10px] text-white/50 mt-0.5 truncate max-w-[250px]">
                {firstDrop.name}
              </p>
            )}
          </div>
          <button
            onClick={onClose}
            className="text-white/70 hover:text-white transition-colors"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-4 flex-1 min-h-0 overflow-y-auto thin-scrollbar">
          {/* Mode toggle: Move / Copy */}
          <div className={`flex p-0.5 border ${tc.borderColor} ${isMinimal ? 'rounded-lg' : ''}`}>
            <button
              type="button"
              onClick={() => setMode('move')}
              className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 ${tc.fontClass} transition-colors ${isMinimal ? 'rounded-md' : ''} ${mode === 'move' ? `${tc.selectedBg} ${tc.textColor}` : `${tc.textMuted2} hover:${tc.textColor}`}`}
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
                <path strokeLinecap="round" strokeLinejoin="round" d="M8 7h12m0 0l-4-4m4 4l-4 4M16 17H4m0 0l4-4m-4 4l4 4" />
              </svg>
              <span>{isMinimal ? 'Move' : 'MOVE'}</span>
            </button>
            <button
              type="button"
              onClick={() => setMode('copy')}
              className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 ${tc.fontClass} transition-colors ${isMinimal ? 'rounded-md' : ''} ${mode === 'copy' ? `${tc.selectedBg} ${tc.textColor}` : `${tc.textMuted2} hover:${tc.textColor}`}`}
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
                <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
              <span>{isMinimal ? 'Copy' : 'COPY'}</span>
            </button>
          </div>

          {/* Current location */}
          <div>
            <label className={`${tc.fontClass} ${tc.textMuted} block mb-2`}>
              {isMinimal ? 'From' : 'FROM'}
            </label>
            <div className={`px-3 py-2 ${tc.selectedBg} border ${tc.borderColor} ${isMinimal ? 'rounded-lg' : ''}`}>
              <span className={`text-sm ${tc.textColor}`}>{currentName}{isBulk ? ` (${dropList.length} drops)` : ''}</span>
            </div>
          </div>

          {/* Target selector */}
          <div>
            <label className={`${tc.fontClass} ${tc.textMuted} block mb-2`}>
              {isMinimal ? 'To' : 'TO'}
            </label>
            <div className="space-y-1">
              {/* Personal option */}
              <button
                onClick={() => setSelectedWorkspaceId(null)}
                className={`w-full text-left px-3 py-2.5 border ${tc.borderColor} transition-colors flex items-center justify-between ${
                  selectedWorkspaceId === null
                    ? `${tc.selectedBg} ${isMinimal ? 'border-[#1A1A1A]' : 'border-[#FF5A47]'}`
                    : allSameWorkspace && firstDrop.workspaceId === null
                    ? `${tc.textMuted2} cursor-not-allowed opacity-40`
                    : 'hover:bg-[#1A1A1A]/5'
                } ${isMinimal ? 'rounded-lg' : ''}`}
                disabled={allSameWorkspace && firstDrop.workspaceId === null}
              >
                <span className={`text-sm ${tc.textColor}`}>
                  {isMinimal ? 'Personal' : 'PERSONAL'}
                </span>
                {selectedWorkspaceId === null && (
                  <svg className="w-4 h-4 text-[#FF5A47]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7" />
                  </svg>
                )}
              </button>

              {/* Workspace options */}
              {workspaces.map(ws => (
                <button
                  key={ws.id}
                  onClick={() => setSelectedWorkspaceId(ws.id)}
                  className={`w-full text-left px-3 py-2.5 border ${tc.borderColor} transition-colors flex items-center justify-between ${
                    selectedWorkspaceId === ws.id
                      ? `${tc.selectedBg} ${isMinimal ? 'border-[#1A1A1A]' : 'border-[#FF5A47]'}`
                      : allSameWorkspace && firstDrop.workspaceId === ws.id
                      ? `${tc.textMuted2} cursor-not-allowed opacity-40`
                      : 'hover:bg-[#1A1A1A]/5'
                  } ${isMinimal ? 'rounded-lg' : ''}`}
                  disabled={allSameWorkspace && firstDrop.workspaceId === ws.id}
                >
                  <span className={`text-sm ${tc.textColor}`}>{ws.name}</span>
                  {selectedWorkspaceId === ws.id && (
                    <svg className="w-4 h-4 text-[#FF5A47]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7" />
                    </svg>
                  )}
                </button>
              ))}
            </div>
          </div>

          {/* Warnings */}
          {!isSameLocation && (
            <div className={`border ${tc.warningBorder} ${tc.warningBg} px-3 py-2.5 ${isMinimal ? 'rounded-lg' : ''} space-y-1.5`}>
              {mode === 'copy' ? (
                <>
                  <p className={`text-xs ${tc.textColor}`}>
                    {isMinimal
                      ? `A copy will be created in ${targetName}. The original stays in ${currentName}.`
                      : `A COPY WILL BE CREATED IN ${targetName.toUpperCase()}. THE ORIGINAL STAYS IN ${currentName.toUpperCase()}.`}
                  </p>
                  {selectedWorkspaceId !== null && (
                    <p className={`text-xs ${tc.textColor}`}>
                      {isMinimal
                        ? `Workspace members of ${targetName} will gain access to the copy.`
                        : `WORKSPACE MEMBERS OF ${targetName.toUpperCase()} WILL GAIN ACCESS TO THE COPY.`}
                    </p>
                  )}
                </>
              ) : (
                <>
                  <p className={`text-xs ${tc.textColor}`}>
                    {isBulk
                      ? (isMinimal
                          ? `These ${dropList.length} drops will be moved to ${targetName} and removed from ${currentName}.`
                          : `THESE ${dropList.length} DROPS WILL BE MOVED TO ${targetName.toUpperCase()} AND REMOVED FROM ${currentName.toUpperCase()}.`)
                      : (isMinimal
                          ? `This drop will be moved to ${targetName} and removed from ${currentName}.`
                          : `THIS DROP WILL BE MOVED TO ${targetName.toUpperCase()} AND REMOVED FROM ${currentName.toUpperCase()}.`)}
                  </p>
                  {firstDrop.workspaceId === null && selectedWorkspaceId !== null && (
                    <p className={`text-xs ${tc.textColor}`}>
                      {isMinimal ? 'All workspace members will gain access to these drops.' : 'ALL_WORKSPACE_MEMBERS_WILL_GAIN_ACCESS'}
                    </p>
                  )}
                  {firstDrop.workspaceId !== null && selectedWorkspaceId === null && (
                    <p className={`text-xs ${tc.textColor}`}>
                      {isMinimal ? 'Other workspace members will lose access to these drops.' : 'OTHER_WORKSPACE_MEMBERS_WILL_LOSE_ACCESS'}
                    </p>
                  )}
                  {firstDrop.workspaceId !== null && selectedWorkspaceId !== null && (
                    <p className={`text-xs ${tc.textColor}`}>
                      {isMinimal
                        ? `Members of ${currentName} will lose access, and members of ${targetName} will gain access.`
                        : `MEMBERS OF ${currentName.toUpperCase()} WILL LOSE ACCESS, AND MEMBERS OF ${targetName.toUpperCase()} WILL GAIN ACCESS.`}
                    </p>
                  )}
                </>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className={`border-t ${tc.borderColor} px-6 py-4 flex items-center justify-end gap-3 ${tc.bgColor} shrink-0`}>
          <button
            onClick={onClose}
            disabled={loading}
            className={`border ${tc.borderColor} ${tc.textColor} px-4 py-2 text-xs tracking-wider hover:bg-[#1A1A1A] hover:text-white transition-colors disabled:opacity-50 ${isMinimal ? 'rounded-full' : ''}`}
          >
            {isMinimal ? 'Cancel' : 'CANCEL'}
          </button>
          <button
            onClick={handleSubmit}
            disabled={isSameLocation || loading}
            className={`px-4 py-2 text-xs tracking-wider text-white transition-colors disabled:opacity-50 flex items-center gap-2 ${
              isMinimal ? 'bg-[#1A1A1A] rounded-full hover:bg-[#2A2A2A]' : 'bg-[#FF5A47] hover:bg-[#e04a38]'
            }`}
          >
            {loading ? (
              <>
                <div className="w-3.5 h-3.5 border-2 border-current border-t-transparent rounded-full animate-spin" />
                {isMinimal ? (mode === 'copy' ? 'Copying...' : 'Moving...') : (mode === 'copy' ? 'COPYING...' : 'MOVING...')}
              </>
            ) : (
              <>
                {mode === 'copy' ? (
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                  </svg>
                ) : (
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3 7.5L7.5 3m0 0L12 7.5M7.5 3v13.5M12 16.5l4.5-4.5m0 0L21 16.5M16.5 12V3" />
                  </svg>
                )}
                {isMinimal ? (mode === 'copy' ? 'Copy' : 'Move') : (mode === 'copy' ? 'COPY' : 'MOVE')}
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
