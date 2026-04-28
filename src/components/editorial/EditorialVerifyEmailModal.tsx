'use client';

import { useState } from 'react';
import { useBodyScrollLock } from '@/hooks/useBodyScrollLock';
import { getEditorialThemeColors } from './editorialTheme';

interface EditorialVerifyEmailModalProps {
  email: string;
  onResend: () => Promise<{ success: boolean; error?: string }>;
  onClose: () => void;
  theme?: 'light' | 'dark' | 'minimal';
}

export function EditorialVerifyEmailModal({ email, onResend, onClose, theme = 'light' }: EditorialVerifyEmailModalProps) {
  useBodyScrollLock();
  const [resending, setResending] = useState(false);
  const [resent, setResent] = useState(false);

  const tc = getEditorialThemeColors(theme);

  const handleResend = async () => {
    setResending(true);
    await onResend();
    setResent(true);
    setTimeout(() => setResent(false), 3000);
    setResending(false);
  };

  return (
    <div
      className="fixed inset-0 bg-[#1a1a1a]/60 flex items-center justify-center z-50 p-4"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className={`${tc.bg} border ${tc.border} rounded-xl w-full max-w-md overflow-hidden shadow-xl`}>
        <div className={`border-b ${tc.border} px-5 py-4 flex items-center justify-between`}>
          <h2 className={`${tc.fontClass} ${tc.text} font-medium text-[15px]`}>Verify Email</h2>
          <button onClick={onClose} className={`${tc.muted} hover:${tc.text} transition-colors p-1`}>
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="p-5 text-center">
          <svg className="w-12 h-12 mx-auto mb-4 text-[#1a1a1a]" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M21.75 6.75v10.5a2.25 2.25 0 01-2.25 2.25h-15a2.25 2.25 0 01-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25m19.5 0v.243a2.25 2.25 0 01-1.07 1.916l-7.5 4.615a2.25 2.25 0 01-2.36 0L3.32 8.91a2.25 2.25 0 01-1.07-1.916V6.75" />
          </svg>

          <h3 className={`${tc.fontClass} ${tc.text} text-lg font-medium mb-2`}>Check your inbox</h3>
          <p className={`${tc.muted} text-sm ${tc.fontClass} mb-4`}>
            We sent a verification link to <span className={tc.text}>{email}</span>
          </p>

          <div className={`p-4 rounded-lg ${tc.bg} border ${tc.border} mb-4`}>
            <p className={`text-xs ${tc.muted} ${tc.fontClass}`}>
              Click the link in the email to verify your account. If you don&apos;t see it, check your spam folder.
            </p>
          </div>

          <div className="flex gap-3">
            <button
              onClick={onClose}
              className={`flex-1 border ${tc.border} ${tc.text} py-2.5 text-sm rounded-lg hover:border-[#1a1a1a] transition-colors ${tc.fontClass}`}
            >
              Close
            </button>
            <button
              onClick={handleResend}
              disabled={resending || resent}
              className={`flex-1 ${tc.activePillBg} ${tc.activePillText} py-2.5 text-sm rounded-lg hover:opacity-90 disabled:opacity-50 transition-opacity ${tc.fontClass} flex items-center justify-center gap-2`}
            >
              {resent ? (
                <>
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                  Sent!
                </>
              ) : resending ? (
                <>
                  <div className="w-4 h-4 border border-white/30 border-t-white animate-spin rounded-full" />
                  Sending...
                </>
              ) : (
                'Resend Email'
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
