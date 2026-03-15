'use client';

import { useState } from 'react';

interface CreateWorkspaceModalProps {
  onSubmit: (name: string) => Promise<void>;
  onClose: () => void;
  createdWorkspace: { name: string; inviteCode: string } | null;
  theme?: 'light' | 'dark' | 'minimal';
}

export function CreateWorkspaceModal({ onSubmit, onClose, createdWorkspace, theme = 'light' }: CreateWorkspaceModalProps) {
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(false);
  const isDark = theme === 'dark';
  const isMinimal = theme === 'minimal';

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;

    setLoading(true);
    await onSubmit(name.trim());
    setLoading(false);
  };

  const getThemeColors = () => {
    if (isMinimal) {
      return {
        borderColor: 'border-[#1A1A1A]/20',
        bgColor: 'bg-[#D4D8C8]',
        textColor: 'text-[#1A1A1A]',
        textMuted: 'text-[#1A1A1A]/50',
        inputBg: 'bg-[#C5C9B8]',
        placeholderColor: 'placeholder:text-[#1A1A1A]/30',
        headerBg: 'bg-[#1A1A1A]',
        fontClass: 'font-sans tracking-wide text-xs',
        roundedClass: 'rounded-lg',
        overlayBg: 'bg-[#1A1A1A]/70',
      };
    }
    return {
      borderColor: isDark ? 'border-white/10' : 'border-[#1A1A1A]',
      bgColor: isDark ? 'bg-[#1A1A1A]' : 'bg-[#FAF7F2]',
      textColor: isDark ? 'text-white' : 'text-[#1A1A1A]',
      textMuted: isDark ? 'text-white/60' : 'text-[#1A1A1A]/60',
      inputBg: isDark ? 'bg-[#0D0D0D]' : 'bg-white',
      placeholderColor: isDark ? 'placeholder:text-white/30' : 'placeholder:text-[#1A1A1A]/30',
      headerBg: 'bg-[#FF5A47]',
      fontClass: 'font-mono uppercase tracking-wider text-[10px]',
      roundedClass: '',
      overlayBg: 'bg-[#1A1A1A]/90',
    };
  };

  const tc = getThemeColors();

  // Show invite code after creation
  if (createdWorkspace) {
    return (
      <div
        className={`fixed inset-0 ${tc.overlayBg} flex items-center justify-center z-50 p-4 transition-colors duration-300`}
        onClick={(e) => e.target === e.currentTarget && onClose()}
      >
        <div className={`${tc.bgColor} border ${tc.borderColor} ${tc.roundedClass} w-full max-w-md transition-colors duration-300`}>
          <div className={`border-b ${tc.borderColor} px-6 py-4 flex items-center justify-between ${tc.headerBg} ${tc.roundedClass} ${isMinimal ? 'rounded-bl-none rounded-br-none' : ''}`}>
            <h2 className={`${isMinimal ? 'text-sm font-medium' : 'text-sm font-bold uppercase tracking-wider'} text-white`}>
              {isMinimal ? 'Workspace created' : 'WORKSPACE_CREATED'}
            </h2>
            <button
              onClick={onClose}
              className="text-white/70 hover:text-white transition-colors"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          <div className="p-6 space-y-4">
            <p className={`${tc.fontClass} ${tc.textMuted}`}>
              {isMinimal ? 'Share this code with others to join:' : 'SHARE_THIS_CODE_WITH_OTHERS_TO_JOIN:'}
            </p>
            <div className={`border-2 border-dashed ${isMinimal ? 'border-[#1A1A1A]/30' : 'border-[#FF5A47]'} p-6 text-center ${tc.roundedClass}`}>
              <p className={`text-2xl ${isMinimal ? 'font-sans tracking-widest' : 'font-mono tracking-widest'} ${tc.textColor}`}>
                {createdWorkspace.inviteCode}
              </p>
            </div>
            <p className={`${tc.fontClass} ${tc.textMuted} text-center`}>
              {isMinimal ? `"${createdWorkspace.name}" workspace` : `WORKSPACE: "${createdWorkspace.name}"`}
            </p>
          </div>

          <div className="p-6 pt-0">
            <button
              onClick={onClose}
              className={`w-full bg-[#1A1A1A] text-white py-3 text-xs tracking-wider hover:bg-[#2A2A2A] transition-colors ${isMinimal ? 'rounded-full' : ''}`}
            >
              {isMinimal ? 'Done' : 'DONE'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`fixed inset-0 ${tc.overlayBg} flex items-center justify-center z-50 p-4 transition-colors duration-300`}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className={`${tc.bgColor} border ${tc.borderColor} ${tc.roundedClass} w-full max-w-md transition-colors duration-300`}>
        <div className={`border-b ${tc.borderColor} px-6 py-4 flex items-center justify-between ${tc.headerBg} ${tc.roundedClass} ${isMinimal ? 'rounded-bl-none rounded-br-none' : ''}`}>
          <h2 className={`${isMinimal ? 'text-sm font-medium' : 'text-sm font-bold uppercase tracking-wider'} text-white`}>
            {isMinimal ? 'Create workspace' : 'CREATE_WORKSPACE'}
          </h2>
          <button
            onClick={onClose}
            className="text-white/70 hover:text-white transition-colors"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          <div>
            <label className={`block ${tc.fontClass} ${tc.textMuted} mb-2`}>
              {isMinimal ? 'Workspace name' : 'WORKSPACE_NAME'}
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={isMinimal ? 'My workspace' : 'MY_WORKSPACE'}
              autoFocus
              className={`w-full border ${tc.borderColor} ${tc.inputBg} ${tc.textColor} px-4 py-3 text-sm ${isMinimal ? 'font-sans tracking-wide' : 'uppercase tracking-wider'} ${tc.placeholderColor} focus:outline-none focus:ring-2 focus:ring-[#1A1A1A] focus:border-transparent transition-colors duration-300 ${tc.roundedClass}`}
            />
          </div>

          <div className="flex gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className={`flex-1 border ${tc.borderColor} ${tc.textColor} py-3 text-xs tracking-wider hover:bg-[#1A1A1A] hover:text-white transition-colors ${isMinimal ? 'rounded-full' : ''}`}
            >
              {isMinimal ? 'Cancel' : 'CANCEL'}
            </button>
            <button
              type="submit"
              disabled={loading || !name.trim()}
              className={`flex-1 bg-[#1A1A1A] text-white py-3 text-xs tracking-wider hover:bg-[#2A2A2A] disabled:bg-[#C4C4C4] disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2 ${isMinimal ? 'rounded-full' : ''}`}
            >
              {loading ? (
                <>
                  <div className="w-4 h-4 border border-white/30 border-t-white animate-spin rounded-full" />
                  {isMinimal ? 'Creating...' : 'CREATING...'}
                </>
              ) : (
                isMinimal ? 'Create' : 'CREATE'
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}