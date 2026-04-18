'use client';

import { useState } from 'react';
import { useBodyScrollLock } from '@/hooks/useBodyScrollLock';

interface VerifyEmailModalProps {
  email: string;
  onResendVerification: () => Promise<{ success: boolean; error?: string }>;
  onCheckVerification: () => Promise<boolean>;
  onClose: () => void;
  theme?: 'light' | 'dark' | 'minimal';
}

export function VerifyEmailModal({
  email,
  onResendVerification,
  onCheckVerification,
  onClose,
  theme = 'light'
}: VerifyEmailModalProps) {
  useBodyScrollLock();
  const [loading, setLoading] = useState(false);
  const [resendSuccess, setResendSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isDark = theme === 'dark';
  const isMinimal = theme === 'minimal';

  const getThemeColors = () => {
    if (isMinimal) {
      return {
        overlayBg: 'bg-black/30 backdrop-blur-sm',
        bgColor: 'bg-[#D4D8C8]',
        borderColor: 'border-[#1A1A1A]/20',
        headerBg: 'bg-[#1A1A1A]',
        textColor: 'text-[#1A1A1A]',
        textMuted: 'text-[#1A1A1A]/50',
        inputBg: 'bg-[#C5C9B8]',
        fontClass: 'font-sans tracking-wide text-xs',
        roundedClass: 'rounded-lg',
      };
    }
    return {
      overlayBg: 'bg-black/70 backdrop-blur-sm',
      bgColor: isDark ? 'bg-[#1A1A1A]' : 'bg-[#FAF7F2]',
      borderColor: isDark ? 'border-white/10' : 'border-[#1A1A1A]',
      headerBg: 'bg-[#FF5A47]',
      textColor: isDark ? 'text-white' : 'text-[#1A1A1A]',
      textMuted: isDark ? 'text-white/50' : 'text-[#1A1A1A]/50',
      inputBg: isDark ? 'bg-[#0D0D0D]' : 'bg-white',
      fontClass: 'font-mono uppercase tracking-wider text-[10px]',
      roundedClass: '',
    };
  };

  const tc = getThemeColors();

  const handleResend = async () => {
    setLoading(true);
    setError(null);
    const result = await onResendVerification();
    setLoading(false);

    if (result.success) {
      setResendSuccess(true);
      setTimeout(() => setResendSuccess(false), 3000);
    } else {
      setError(result.error || 'Failed to resend email.');
    }
  };

  const handleCheckVerification = async () => {
    setLoading(true);
    const isVerified = await onCheckVerification();
    setLoading(false);

    if (isVerified) {
      onClose();
    } else {
      setError('Your email is not verified yet. Please check your inbox.');
    }
  };

  return (
    <div
      className={`fixed inset-0 ${tc.overlayBg} flex items-center justify-center z-50 p-4 transition-colors duration-300 overscroll-contain`}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className={`${tc.bgColor} border ${tc.borderColor} ${tc.roundedClass} w-full max-w-md transition-colors duration-300`}>
        {/* Header */}
        <div className={`border-b ${tc.borderColor} px-6 py-4 flex items-center justify-between ${tc.headerBg}`}>
          <h2 className={`${isMinimal ? 'text-sm font-medium' : 'text-sm font-bold uppercase tracking-wider'} text-white`}>
            Verify Your Email
          </h2>
          <button onClick={onClose} className="text-white/70 hover:text-white transition-colors">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-6">
          {/* Email Icon */}
          <div className="flex justify-center">
            <div className={`w-16 h-16 ${tc.inputBg} border ${tc.borderColor} flex items-center justify-center ${tc.roundedClass}`}>
              <svg className={`w-8 h-8 ${isMinimal ? 'text-[#1A1A1A]' : 'text-[#FF5A47]'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
                <path strokeLinecap="round" strokeLinejoin="round" d="M21.75 6.75v10.5a2.25 2.25 0 01-2.25 2.25h-15a2.25 2.25 0 01-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25m19.5 0v.243a2.25 2.25 0 01-1.07 1.916l-7.5 4.615a2.25 2.25 0 01-2.36 0L3.32 8.91a2.25 2.25 0 01-1.07-1.916V6.75" />
              </svg>
            </div>
          </div>

          {/* Message */}
          <div className="text-center">
            <p className={`${tc.fontClass} ${tc.textColor} mb-2`}>
              We&apos;ve sent a verification email to:
            </p>
            <p className={`text-sm font-semibold ${tc.textColor}`}>
              {email}
            </p>
          </div>

          <p className={`${tc.fontClass} ${tc.textMuted} text-center`}>
            Click the link in the email to verify your account. Don&apos;t forget to check your spam folder.
          </p>

          {error && (
            <div className={`border border-red-500/50 bg-red-500/10 px-4 py-3 ${tc.roundedClass}`}>
              <p className={`text-xs ${tc.textColor}`}>{error}</p>
            </div>
          )}

          {resendSuccess && (
            <div className={`border ${tc.borderColor} ${tc.inputBg} px-4 py-3 ${tc.roundedClass}`}>
              <p className={`text-xs ${tc.textColor}`}>Verification email sent!</p>
            </div>
          )}

          {/* Actions */}
          <div className="space-y-3">
            <button
              onClick={handleCheckVerification}
              disabled={loading}
              className={`w-full bg-[#1A1A1A] text-white py-3 text-xs tracking-wider hover:bg-[#2A2A2A] disabled:bg-[#C4C4C4] disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2 ${isMinimal ? 'rounded-full' : ''}`}
            >
              {loading ? (
                <>
                  <div className="w-4 h-4 border border-white/30 border-t-white animate-spin rounded-full" />
                  Checking...
                </>
              ) : (
                "I've Verified My Email"
              )}
            </button>

            <button
              onClick={handleResend}
              disabled={loading}
              className={`w-full border ${tc.borderColor} ${tc.textColor} py-3 text-xs tracking-wider hover:bg-[#1A1A1A] hover:text-white transition-colors ${isMinimal ? 'rounded-full' : ''}`}
            >
              Resend Verification Email
            </button>

            <button
              onClick={onClose}
              className={`w-full ${tc.textMuted} py-2 text-xs tracking-wider hover:${tc.textColor} transition-colors`}
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}