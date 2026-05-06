'use client';

import { useState } from 'react';
import { useBodyScrollLock } from '@/hooks/useBodyScrollLock';
import { Drop, Workspace } from '@/types';

interface MoveDropModalProps {
  drop: Drop;
  workspaces: Workspace[];
  currentWorkspaceId: string | null;
  onMove: (targetWorkspaceId: string | null) => Promise<void>;
  onClose: () => void;
  theme?: 'light' | 'dark' | 'minimal';
}

export function MoveDropModal({ drop, workspaces, currentWorkspaceId, onMove, onClose, theme = 'light' }: MoveDropModalProps) {
  useBodyScrollLock();
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(drop.workspaceId);
  const [loading, setLoading] = useState(false);
  const isDark = theme === 'dark';
  const isMinimal = theme === 'minimal';

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
      <div className={`${tc.bgColor} border ${tc.borderColor} ${tc.roundedClass} w-full max-w-md transition-colors duration-300`}>
        {/* Header */}
        <div className={`border-b ${tc.borderColor} px-6 py-4 flex items-center justify-between ${tc.headerBg} ${tc.roundedClass} ${isMinimal ? 'rounded-bl-none rounded-br-none' : ''}`}>
          <div>
            <h2 className={`${isMinimal ? 'text-sm font-medium' : 'text-sm font-bold uppercase tracking-wider'} text-white`}>
              {isMinimal ? 'Move drop' : 'MOVE_DROP'}
            </h2>
            <p className="text-[10px] text-white/50 mt-0.5 truncate max-w-[250px]">
              {drop.name}
            </p>
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
        <div className="p-6 space-y-4">
          {/* Current location */}
          <div>
            <label className={`${tc.fontClass} ${tc.textMuted} block mb-2`}>
              {isMinimal ? 'From' : 'FROM'}
            </label>
            <div className={`px-3 py-2 ${tc.selectedBg} border ${tc.borderColor} ${isMinimal ? 'rounded-lg' : ''}`}>
              <span className={`text-sm ${tc.textColor}`}>{currentName}</span>
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
                    : isSameLocation && drop.workspaceId === null
                    ? `${tc.textMuted2} cursor-not-allowed opacity-40`
                    : 'hover:bg-[#1A1A1A]/5'
                } ${isMinimal ? 'rounded-lg' : ''}`}
                disabled={isSameLocation && drop.workspaceId === null}
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
                      : isSameLocation && drop.workspaceId === ws.id
                      ? `${tc.textMuted2} cursor-not-allowed opacity-40`
                      : 'hover:bg-[#1A1A1A]/5'
                  } ${isMinimal ? 'rounded-lg' : ''}`}
                  disabled={isSameLocation && drop.workspaceId === ws.id}
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
              {drop.workspaceId === null && selectedWorkspaceId !== null && (
                <p className={`text-xs ${tc.textColor}`}>
                  {isMinimal ? 'All workspace members will gain access to this drop.' : 'ALL_WORKSPACE_MEMBERS_WILL_GAIN_ACCESS'}
                </p>
              )}
              {drop.workspaceId !== null && selectedWorkspaceId === null && (
                <p className={`text-xs ${tc.textColor}`}>
                  {isMinimal ? 'Other workspace members will lose access to this drop.' : 'OTHER_WORKSPACE_MEMBERS_WILL_LOSE_ACCESS'}
                </p>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className={`border-t ${tc.borderColor} px-6 py-4 flex items-center justify-end gap-3 ${tc.bgColor}`}>
          <button
            onClick={onClose}
            disabled={loading}
            className={`border ${tc.borderColor} ${tc.textColor} px-4 py-2 text-xs tracking-wider hover:bg-[#1A1A1A] hover:text-white transition-colors disabled:opacity-50 ${isMinimal ? 'rounded-full' : ''}`}
          >
            {isMinimal ? 'Cancel' : 'CANCEL'}
          </button>
          <button
            onClick={handleMove}
            disabled={isSameLocation || loading}
            className={`px-4 py-2 text-xs tracking-wider text-white transition-colors disabled:opacity-50 flex items-center gap-2 ${
              isMinimal ? 'bg-[#1A1A1A] rounded-full hover:bg-[#2A2A2A]' : 'bg-[#FF5A47] hover:bg-[#e04a38]'
            }`}
          >
            {loading ? (
              <>
                <div className="w-3.5 h-3.5 border-2 border-current border-t-transparent rounded-full animate-spin" />
                {isMinimal ? 'Moving...' : 'MOVING...'}
              </>
            ) : (
              <>
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 7.5L7.5 3m0 0L12 7.5M7.5 3v13.5M12 16.5l4.5-4.5m0 0L21 16.5M16.5 12V3" />
                </svg>
                {isMinimal ? 'Move' : 'MOVE'}
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
