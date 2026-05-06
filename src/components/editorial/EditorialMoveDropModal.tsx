'use client';

import { useState } from 'react';
import { useBodyScrollLock } from '@/hooks/useBodyScrollLock';
import { Drop, Workspace } from '@/types';
import { getEditorialThemeColors } from './editorialTheme';

interface EditorialMoveDropModalProps {
  drop: Drop;
  workspaces: Workspace[];
  currentWorkspaceId: string | null;
  onMove: (targetWorkspaceId: string | null) => Promise<void>;
  onClose: () => void;
  theme?: 'light' | 'dark' | 'minimal';
}

export function EditorialMoveDropModal({ drop, workspaces, currentWorkspaceId, onMove, onClose, theme = 'light' }: EditorialMoveDropModalProps) {
  useBodyScrollLock();
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(drop.workspaceId);
  const [loading, setLoading] = useState(false);

  const tc = getEditorialThemeColors(theme);

  const currentName = drop.workspaceId
    ? workspaces.find(w => w.id === drop.workspaceId)?.name || 'Unknown'
    : 'Personal';
  const targetName = selectedWorkspaceId
    ? workspaces.find(w => w.id === selectedWorkspaceId)?.name || 'Unknown'
    : 'Personal';

  const isSameLocation = selectedWorkspaceId === drop.workspaceId;

  const handleMove = async () => {
    if (isSameLocation) return;
    setLoading(true);
    await onMove(selectedWorkspaceId);
    setLoading(false);
  };

  return (
    <div
      className="fixed inset-0 bg-[#1a1a1a]/60 flex items-center justify-center z-50 p-4"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className={`${tc.bg} border ${tc.border} rounded-xl w-full max-w-md overflow-hidden shadow-xl`}>
        {/* Header */}
        <div className={`border-b ${tc.border} px-5 py-4 flex items-center justify-between`}>
          <div>
            <h2 className={`${tc.fontClass} ${tc.text} font-medium text-[15px]`}>Move drop</h2>
            <p className={`text-[11px] ${tc.muted} mt-0.5 truncate max-w-[250px] ${tc.fontClass}`}>
              {drop.name}
            </p>
          </div>
          <button onClick={onClose} className={`${tc.muted} hover:${tc.text} transition-colors p-1`}>
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="p-5 space-y-4">
          {/* Current location */}
          <div>
            <label className={`text-xs ${tc.muted} ${tc.fontClass} mb-1.5 block`}>From</label>
            <div className={`border ${tc.border} ${tc.bg} rounded-lg px-3 py-2.5`}>
              <span className={`text-sm ${tc.text} ${tc.fontClass}`}>{currentName}</span>
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
                    : isSameLocation && drop.workspaceId === null
                    ? `${tc.muted} opacity-40 cursor-not-allowed`
                    : `hover:${tc.hoverBorder}`
                }`}
                disabled={isSameLocation && drop.workspaceId === null}
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
                      : isSameLocation && drop.workspaceId === ws.id
                      ? `${tc.muted} opacity-40 cursor-not-allowed`
                      : `hover:${tc.hoverBorder}`
                  }`}
                  disabled={isSameLocation && drop.workspaceId === ws.id}
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
              {drop.workspaceId === null && selectedWorkspaceId !== null && (
                <p className={`text-xs ${tc.muted}`}>All workspace members will gain access to this drop.</p>
              )}
              {drop.workspaceId !== null && selectedWorkspaceId === null && (
                <p className={`text-xs ${tc.muted}`}>Other workspace members will lose access to this drop.</p>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className={`border-t ${tc.border} px-5 py-4 flex items-center justify-end gap-3`}>
          <button
            onClick={onClose}
            disabled={loading}
            className={`border ${tc.border} ${tc.text} px-4 py-2 text-sm rounded-lg hover:${tc.hoverBorder} transition-colors disabled:opacity-50 ${tc.fontClass}`}
          >
            Cancel
          </button>
          <button
            onClick={handleMove}
            disabled={isSameLocation || loading}
            className={`px-4 py-2 text-sm rounded-lg disabled:opacity-50 flex items-center gap-2 ${tc.activePillBg} ${tc.activePillText} hover:opacity-90 transition-opacity ${tc.fontClass}`}
          >
            {loading ? (
              <>
                <div className={`w-4 h-4 border border-white/30 border-t-white animate-spin rounded-full`} />
                Moving...
              </>
            ) : (
              <>
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 7.5L7.5 3m0 0L12 7.5M7.5 3v13.5M12 16.5l4.5-4.5m0 0L21 16.5M16.5 12V3" />
                </svg>
                Move
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
