'use client';

import { useState } from 'react';
import { useBodyScrollLock } from '@/hooks/useBodyScrollLock';
import { useModalBackClose } from '@/hooks/useModalBackClose';
import { useUserTier } from '@/hooks/useUserTier';
import { useAuth } from '@/hooks/useAuth';
import { Drop, Workspace } from '@/types';
import { getEditorialThemeColors } from './editorialTheme';
import { ForeverLockedModal } from '../ForeverLockedModal';
import { LockedActionButton } from '../LockedActionButton';

interface EditorialMoveDropModalProps {
  drops: Drop | Drop[];
  workspaces: Workspace[];
  currentWorkspaceId: string | null;
  onMove: (drops: Drop[], targetWorkspaceId: string | null) => Promise<void>;
  onCopy: (drops: Drop[], targetWorkspaceId: string | null) => Promise<void>;
  onClose: () => void;
  theme?: 'light' | 'dark' | 'minimal';
}

export function EditorialMoveDropModal({ drops: dropsProp, workspaces, currentWorkspaceId, onMove, onCopy, onClose, theme = 'light' }: EditorialMoveDropModalProps) {
  useBodyScrollLock();
  const dropList = Array.isArray(dropsProp) ? dropsProp : [dropsProp];
  const isBulk = dropList.length > 1;
  const firstDrop = dropList[0];

  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(firstDrop.workspaceId);
  const [mode, setMode] = useState<'move' | 'copy'>('move');
  const [loading, setLoading] = useState(false);
  const [showForeverLocked, setShowForeverLocked] = useState(false);
  const { tier, loading: tierLoading } = useUserTier();
  const { user } = useAuth();
  const currentUserId = user?.uid ?? null;
  // Back closes only when not mid move/copy (matches the disabled X/backdrop).
  useModalBackClose(true, () => { if (!loading) onClose(); });

  const tc = getEditorialThemeColors(theme);

  const currentName = firstDrop.workspaceId
    ? workspaces.find(w => w.id === firstDrop.workspaceId)?.name || 'Unknown'
    : 'Personal';
  const targetName = selectedWorkspaceId === null
    ? 'Personal'
    : workspaces.find(w => w.id === selectedWorkspaceId)?.name || 'Unknown';

  const allSameWorkspace = dropList.every(d => d.workspaceId === firstDrop.workspaceId);
  const isSameLocation = selectedWorkspaceId === firstDrop.workspaceId;
  // A locked drop can only be moved by its creator or the workspace owner. In Move mode, if any
  // selected drop is unmovable by this user, the submit button fades (LockedActionButton) instead
  // of running — Copy mode is never blocked (a copy is a fresh open drop).
  const moveBlocked = mode === 'move' && dropList.some((d) => d.locked && currentUserId !== d.userId &&
    currentUserId !== (d.workspaceId ? workspaces.find(w => w.id === d.workspaceId)?.ownerId : undefined));

  const handleSubmit = async () => {
    if (isSameLocation) return;
    // Standard users can't move a forever drop (the rules reject the write). Show a clean popup
    // instead of letting the move fail. Copy is NOT gated here — copyDrop silently downgrades.
    if (
      mode === 'move' &&
      tier === 'standard' &&
      !tierLoading &&
      dropList.some((d) => d.expirationOption === 'forever' || d.expiresAt == null)
    ) {
      setShowForeverLocked(true);
      return;
    }
    setLoading(true);
    if (mode === 'copy') await onCopy(dropList, selectedWorkspaceId);
    else await onMove(dropList, selectedWorkspaceId);
    setLoading(false);
  };

  return (
    <div
      className="fixed inset-0 bg-[#1a1a1a]/60 flex items-center justify-center z-50 p-4"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className={`${tc.bg} border ${tc.border} rounded-xl w-full max-w-md max-h-[90vh] flex flex-col overflow-hidden shadow-xl`}>
        {/* Header */}
        <div className={`border-b ${tc.border} px-5 py-4 flex items-center justify-between shrink-0`}>
          <div>
            <h2 className={`${tc.fontClass} ${tc.text} font-medium text-[15px]`}>
              {isBulk ? `${mode === 'copy' ? 'Copy' : 'Move'} ${dropList.length} drops` : (mode === 'copy' ? 'Copy drop' : 'Move drop')}
            </h2>
            {!isBulk && (
              <p className={`text-[11px] ${tc.muted} mt-0.5 truncate max-w-[250px] ${tc.fontClass}`}>
                {firstDrop.name}
              </p>
            )}
          </div>
          <button onClick={onClose} className={`${tc.muted} hover:${tc.text} transition-colors p-1`}>
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="p-5 space-y-4 flex-1 min-h-0 overflow-y-auto thin-scrollbar">
          {/* Mode toggle: Move / Copy */}
          <div className={`flex p-0.5 border ${tc.border} ${tc.bg} rounded-lg`}>
            <button
              type="button"
              onClick={() => setMode('move')}
              className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs ${tc.fontClass} rounded-md transition-colors ${mode === 'move' ? `${tc.activePillBg} ${tc.activePillText}` : `${tc.muted} hover:${tc.text}`}`}
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M8 7h12m0 0l-4-4m4 4l-4 4M16 17H4m0 0l4-4m-4 4l4 4" />
              </svg>
              <span>Move</span>
            </button>
            <button
              type="button"
              onClick={() => setMode('copy')}
              className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs ${tc.fontClass} rounded-md transition-colors ${mode === 'copy' ? `${tc.activePillBg} ${tc.activePillText}` : `${tc.muted} hover:${tc.text}`}`}
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
              <span>Copy</span>
            </button>
          </div>

          {/* Current location */}
          <div>
            <label className={`text-xs ${tc.muted} ${tc.fontClass} mb-1.5 block`}>From</label>
            <div className={`border ${tc.border} ${tc.bg} rounded-lg px-3 py-2.5`}>
              <span className={`text-sm ${tc.text} ${tc.fontClass}`}>{currentName}{isBulk ? ` (${dropList.length} drops)` : ''}</span>
            </div>
          </div>

          {/* Target selector */}
          <div>
            <label className={`text-xs ${tc.muted} ${tc.fontClass} mb-1.5 block`}>To</label>
            <div className="space-y-1.5">
              {/* Personal option */}
              <button
                onClick={() => setSelectedWorkspaceId(null)}
                className={`w-full text-left px-3 py-2.5 border ${tc.border} rounded-lg transition-colors flex items-center justify-between ${
                  selectedWorkspaceId === null
                    ? `${tc.activePillBg}`
                    : allSameWorkspace && firstDrop.workspaceId === null
                    ? `${tc.muted} opacity-40 cursor-not-allowed`
                    : `${tc.hoverBorder}`
                }`}
                disabled={allSameWorkspace && firstDrop.workspaceId === null}
              >
                <span className={`text-sm ${selectedWorkspaceId === null ? tc.activePillText : tc.text} ${tc.fontClass}`}>Personal</span>
                {selectedWorkspaceId === null && (
                  <svg className={`w-4 h-4 ${tc.activePillText}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7" />
                  </svg>
                )}
              </button>

              {/* Workspace options */}
              {workspaces.map(ws => (
                <button
                  key={ws.id}
                  onClick={() => setSelectedWorkspaceId(ws.id)}
                  className={`w-full text-left px-3 py-2.5 border ${tc.border} rounded-lg transition-colors flex items-center justify-between ${
                    selectedWorkspaceId === ws.id
                      ? `${tc.activePillBg}`
                      : allSameWorkspace && firstDrop.workspaceId === ws.id
                      ? `${tc.muted} opacity-40 cursor-not-allowed`
                      : `${tc.hoverBorder}`
                  }`}
                  disabled={allSameWorkspace && firstDrop.workspaceId === ws.id}
                >
                  <span className={`text-sm ${selectedWorkspaceId === ws.id ? tc.activePillText : tc.text} ${tc.fontClass}`}>{ws.name}</span>
                  {selectedWorkspaceId === ws.id && (
                    <svg className={`w-4 h-4 ${tc.activePillText}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7" />
                    </svg>
                  )}
                </button>
              ))}
            </div>
          </div>

          {/* Warnings */}
          {!isSameLocation && (
            <div className={`border ${tc.border} ${tc.bg} rounded-lg px-3 py-2.5 ${tc.fontClass} space-y-1`}>
              {mode === 'copy' ? (
                <>
                  <p className={`text-xs ${tc.muted}`}>A copy will be created in {targetName}. The original stays in {currentName}.</p>
                  {selectedWorkspaceId !== null && (
                    <p className={`text-xs ${tc.muted}`}>Workspace members of {targetName} will gain access to the copy.</p>
                  )}
                </>
              ) : (
                <>
                  <p className={`text-xs ${tc.muted}`}>
                    {isBulk
                      ? `These ${dropList.length} drops will be moved to ${targetName} and removed from ${currentName}.`
                      : `This drop will be moved to ${targetName} and removed from ${currentName}.`}
                  </p>
                  {firstDrop.workspaceId === null && selectedWorkspaceId !== null && (
                    <p className={`text-xs ${tc.muted}`}>All workspace members will gain access to these drops.</p>
                  )}
                  {firstDrop.workspaceId !== null && selectedWorkspaceId === null && (
                    <p className={`text-xs ${tc.muted}`}>Other workspace members will lose access to these drops.</p>
                  )}
                  {firstDrop.workspaceId !== null && selectedWorkspaceId !== null && (
                    <p className={`text-xs ${tc.muted}`}>Members of {currentName} will lose access, and members of {targetName} will gain access.</p>
                  )}
                </>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className={`border-t ${tc.border} px-5 py-4 flex items-center justify-end gap-3 shrink-0`}>
          <button
            onClick={onClose}
            disabled={loading}
            className={`border ${tc.border} ${tc.text} px-4 py-2 text-sm rounded-lg ${tc.hoverBorder} transition-colors disabled:opacity-50 ${tc.fontClass}`}
          >
            Cancel
          </button>
          {moveBlocked ? (
            <LockedActionButton
              context="move"
              variant="editorial"
              theme={theme}
              className={`px-4 py-2 text-sm rounded-lg flex items-center gap-2 ${tc.activePillBg} ${tc.activePillText} transition-opacity ${tc.fontClass}`}
              icon={
                <>
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3 7.5L7.5 3m0 0L12 7.5M7.5 3v13.5M12 16.5l4.5-4.5m0 0L21 16.5M16.5 12V3" />
                  </svg>
                  Move
                </>
              }
            />
          ) : (
            <button
              onClick={handleSubmit}
              disabled={isSameLocation || loading}
              className={`px-4 py-2 text-sm rounded-lg disabled:opacity-50 flex items-center gap-2 ${tc.activePillBg} ${tc.activePillText} hover:opacity-90 transition-opacity ${tc.fontClass}`}
            >
              {loading ? (
                <>
                  <div className={`w-4 h-4 border border-white/30 border-t-white animate-spin rounded-full`} />
                  {mode === 'copy' ? 'Copying...' : 'Moving...'}
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
                  {mode === 'copy' ? 'Copy' : 'Move'}
                </>
              )}
            </button>
          )}
        </div>
      </div>
      {showForeverLocked && (
        <ForeverLockedModal context="move" variant="editorial" theme={theme} onClose={() => setShowForeverLocked(false)} />
      )}
    </div>
  );
}
