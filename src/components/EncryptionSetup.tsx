'use client';

import { useState } from 'react';
import { initializeUserKeys } from '@/lib/keys';

interface EncryptionSetupProps {
  userId: string;
  onComplete: () => void;
  theme?: 'light' | 'dark' | 'minimal';
}

export function EncryptionSetup({ userId, onComplete, theme = 'light' }: EncryptionSetupProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isDark = theme === 'dark';
  const isMinimal = theme === 'minimal';

  const handleSetup = async () => {
    setLoading(true);
    setError(null);

    try {
      await initializeUserKeys(userId);
      onComplete();
    } catch (err) {
      console.error('Failed to setup encryption:', err);
      setError('Failed to setup encryption. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const getThemeColors = () => {
    if (isMinimal) {
      return {
        borderColor: 'border-[#1A1A1A]/20',
        bgColor: 'bg-[#D4D8C8]',
        textColor: 'text-[#1A1A1A]',
        textMuted: 'text-[#1A1A1A]/50',
        headerBg: 'bg-[#1A1A1A]',
        fontClass: 'font-sans tracking-wide text-xs',
        roundedClass: 'rounded-lg',
      };
    }
    return {
      borderColor: isDark ? 'border-white/10' : 'border-[#1A1A1A]',
      bgColor: isDark ? 'bg-[#1A1A1A]' : 'bg-[#FAF7F2]',
      textColor: isDark ? 'text-white' : 'text-[#1A1A1A]',
      textMuted: isDark ? 'text-white/60' : 'text-[#1A1A1A]/60',
      headerBg: 'bg-[#FF5A47]',
      fontClass: 'font-mono uppercase tracking-wider text-[10px]',
      roundedClass: '',
    };
  };

  const tc = getThemeColors();

  return (
    <div className={`border ${tc.borderColor} ${tc.bgColor} ${tc.roundedClass} transition-colors duration-300`}>
      <div className={`border-b ${tc.borderColor} px-4 py-3 ${tc.headerBg} ${tc.roundedClass} ${isMinimal ? 'rounded-bl-none rounded-br-none' : ''}`}>
        <h3 className={`${isMinimal ? 'text-sm font-medium' : 'text-sm font-bold uppercase tracking-wider'} text-white`}>
          {isMinimal ? 'Enable encryption' : 'ENCRYPTION_SETUP'}
        </h3>
      </div>

      <div className="p-6 space-y-4">
        <p className={`${tc.fontClass} ${tc.textMuted}`}>
          {isMinimal
            ? 'Enable end-to-end encryption to protect your files. Only you and workspace members can decrypt them.'
            : 'ENABLE_END-TO-END_ENCRYPTION_TO_PROTECT_YOUR_FILES._ONLY_YOU_AND_WORKSPACE_MEMBERS_CAN_DECRYPT_THEM.'}
        </p>

        <div className={`border ${tc.borderColor} p-4 ${tc.roundedClass}`}>
          <div className="flex items-start gap-3">
            <svg className={`w-5 h-5 ${isMinimal ? 'text-[#1A1A1A]' : 'text-[#FF5A47]'} mt-0.5`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
            </svg>
            <div>
              <p className={`${tc.fontClass} ${tc.textColor}`}>
                {isMinimal ? 'Your files will be encrypted locally' : 'FILES_ENCRYPTED_LOCALLY'}
              </p>
              <p className={`${tc.fontClass} ${tc.textMuted} mt-1`}>
                {isMinimal ? 'Even Firebase cannot read your data' : 'EVEN_FIREBASE_CANNOT_READ_YOUR_DATA'}
              </p>
            </div>
          </div>
        </div>

        {error && (
          <div className={`border border-red-500/50 bg-red-500/10 px-4 py-3 ${tc.roundedClass}`}>
            <p className={`text-xs ${tc.textColor}`}>{error}</p>
          </div>
        )}

        <button
          onClick={handleSetup}
          disabled={loading}
          className={`w-full bg-[#1A1A1A] text-white py-3 text-xs tracking-wider hover:bg-[#2A2A2A] disabled:bg-[#C4C4C4] disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2 ${isMinimal ? 'rounded-full' : ''}`}
        >
          {loading ? (
            <>
              <div className="w-4 h-4 border border-white/30 border-t-white animate-spin rounded-full" />
              {isMinimal ? 'Setting up...' : 'SETTING_UP...'}
            </>
          ) : (
            isMinimal ? 'Enable encryption' : 'ENABLE_ENCRYPTION'
          )}
        </button>

        <button
          onClick={onComplete}
          className={`w-full border ${tc.borderColor} ${tc.textColor} py-3 text-xs tracking-wider hover:bg-[#1A1A1A] hover:text-white transition-colors ${isMinimal ? 'rounded-full' : ''}`}
        >
          {isMinimal ? 'Skip for now' : 'SKIP_FOR_NOW'}
        </button>
      </div>
    </div>
  );
}