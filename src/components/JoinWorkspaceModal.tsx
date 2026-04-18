'use client';

import { useState } from 'react';
import { useBodyScrollLock } from '@/hooks/useBodyScrollLock';

interface JoinWorkspaceModalProps {
  onSubmit: (inviteCode: string) => Promise<{ success: boolean; error?: string }>;
  onClose: () => void;
  theme?: 'light' | 'dark' | 'minimal';
}

export function JoinWorkspaceModal({ onSubmit, onClose, theme = 'light' }: JoinWorkspaceModalProps) {
  useBodyScrollLock();
  const [inviteCode, setInviteCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isDark = theme === 'dark';
  const isMinimal = theme === 'minimal';

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inviteCode.trim()) return;

    setLoading(true);
    setError(null);

    const result = await onSubmit(inviteCode.trim().toUpperCase());

    setLoading(false);

    if (result.success) {
      onClose();
    } else if (result.error) {
      setError(result.error);
    }
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
        errorBg: 'bg-[#1A1A1A]/5',
        errorBorder: 'border-[#1A1A1A]/20',
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
      errorBg: 'bg-[#FF5A47]/10',
      errorBorder: 'border-[#FF5A47]',
    };
  };

  const tc = getThemeColors();

  return (
    <div
      className={`fixed inset-0 ${tc.overlayBg} flex items-center justify-center z-50 p-4 transition-colors duration-300 overscroll-contain`}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className={`${tc.bgColor} border ${tc.borderColor} ${tc.roundedClass} w-full max-w-md transition-colors duration-300`}>
        <div className={`border-b ${tc.borderColor} px-6 py-4 flex items-center justify-between ${tc.headerBg} ${tc.roundedClass} ${isMinimal ? 'rounded-bl-none rounded-br-none' : ''}`}>
          <h2 className={`${isMinimal ? 'text-sm font-medium' : 'text-sm font-bold uppercase tracking-wider'} text-white`}>
            {isMinimal ? 'Join workspace' : 'JOIN_WORKSPACE'}
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
              {isMinimal ? 'Invite code' : 'INVITE_CODE'}
            </label>
            <input
              type="text"
              value={inviteCode}
              onChange={(e) => {
                setInviteCode(e.target.value.toUpperCase());
                setError(null);
              }}
              placeholder={isMinimal ? 'ABC123' : 'ENTER_CODE'}
              autoFocus
              maxLength={6}
              className={`w-full border ${tc.borderColor} ${tc.inputBg} ${tc.textColor} px-4 py-3 text-center text-lg ${isMinimal ? 'font-sans tracking-widest' : 'font-mono tracking-widest'} ${tc.placeholderColor} focus:outline-none focus:ring-2 focus:ring-[#1A1A1A] focus:border-transparent transition-colors duration-300 ${tc.roundedClass}`}
            />
          </div>

          {error && (
            <div className={`border ${tc.errorBorder} ${tc.errorBg} px-4 py-3 ${tc.roundedClass}`}>
              <p className={`text-xs ${tc.textColor}`}>{error}</p>
            </div>
          )}

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
              disabled={loading || inviteCode.length !== 6}
              className={`flex-1 bg-[#1A1A1A] text-white py-3 text-xs tracking-wider hover:bg-[#2A2A2A] disabled:bg-[#C4C4C4] disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2 ${isMinimal ? 'rounded-full' : ''}`}
            >
              {loading ? (
                <>
                  <div className="w-4 h-4 border border-white/30 border-t-white animate-spin rounded-full" />
                  {isMinimal ? 'Joining...' : 'JOINING...'}
                </>
              ) : (
                isMinimal ? 'Join' : 'JOIN'
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}