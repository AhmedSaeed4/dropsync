'use client';

import { useState } from 'react';
import { User } from '@/types';
import { useBodyScrollLock } from '@/hooks/useBodyScrollLock';
import { getEditorialThemeColors } from './editorialTheme';

interface EditorialSettingsModalProps {
  user: User;
  onResetPassword: (email: string) => Promise<{ success: boolean; error?: string }>;
  onClose: () => void;
  onLayoutChange?: (layout: 'classic' | 'editorial') => void;
  layoutMode?: 'classic' | 'editorial';
  theme?: 'light' | 'dark' | 'minimal';
}

export function EditorialSettingsModal({
  user,
  onResetPassword,
  onClose,
  onLayoutChange,
  layoutMode = 'classic',
  theme = 'light',
}: EditorialSettingsModalProps) {
  useBodyScrollLock();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'general' | 'appearance'>('general');

  const tc = getEditorialThemeColors(theme);

  const handlePasswordReset = async () => {
    if (!user.email) return;
    setLoading(true);
    const result = await onResetPassword(user.email);
    if (result.success) {
      setSuccess('Password reset email sent!');
    } else if (result.error) {
      setError(result.error);
    }
    setLoading(false);
  };

  return (
    <div
      className="fixed inset-0 bg-[#1a1a1a]/60 flex items-center justify-center z-50 p-4"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className={`${tc.bg} border ${tc.border} rounded-xl w-full max-w-md overflow-hidden shadow-xl max-h-[80vh] flex flex-col`}>
        {/* Header */}
        <div className={`border-b ${tc.border} px-5 py-4 flex items-center justify-between`}>
          <h2 className={`${tc.fontClass} ${tc.text} font-medium text-[15px]`}>Settings</h2>
          <button onClick={onClose} className={`${tc.muted} hover:${tc.text} transition-colors p-1`}>
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Tabs */}
        <div className={`flex border-b ${tc.border}`}>
          <button
            onClick={() => setActiveTab('general')}
            className={`flex-1 py-3 text-sm ${tc.fontClass} transition-colors border-b-2 ${
              activeTab === 'general'
                ? `${tc.text} border-[#1a1a1a]`
                : `${tc.muted} border-transparent hover:${tc.text}`
            }`}
          >
            General
          </button>
          <button
            onClick={() => setActiveTab('appearance')}
            className={`flex-1 py-3 text-sm ${tc.fontClass} transition-colors border-b-2 ${
              activeTab === 'appearance'
                ? `${tc.text} border-[#1a1a1a]`
                : `${tc.muted} border-transparent hover:${tc.text}`
            }`}
          >
            Appearance
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-5">
          {error && (
            <div className={`bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-sm text-red-600 mb-4 ${tc.fontClass}`}>
              {error}
            </div>
          )}

          {success && (
            <div className={`bg-green-50 border border-green-200 rounded-lg px-3 py-2 text-sm text-green-600 mb-4 ${tc.fontClass}`}>
              {success}
            </div>
          )}

          {activeTab === 'general' ? (
            <div className="space-y-5">
              {/* Account Info */}
              <div>
                <h3 className={`${tc.fontClass} ${tc.text} font-medium text-sm mb-3`}>Account</h3>
                <div className={`p-3 rounded-lg border ${tc.border} ${tc.bg}`}>
                  <label className={`block text-xs ${tc.muted} ${tc.fontClass} mb-1`}>Email</label>
                  <p className={`${tc.text} text-sm ${tc.fontClass}`}>{user.email}</p>
                </div>
              </div>

              {/* Password Reset */}
              {user.providerId === 'password' && (
                <div>
                  <h3 className={`${tc.fontClass} ${tc.text} font-medium text-sm mb-3`}>Security</h3>
                  <button
                    onClick={handlePasswordReset}
                    disabled={loading}
                    className={`w-full border ${tc.border} ${tc.text} py-2.5 text-sm rounded-lg hover:border-[#1a1a1a] transition-colors ${tc.fontClass} flex items-center justify-center gap-2`}
                  >
                    {loading ? (
                      <>
                        <div className="w-4 h-4 border border-current/30 border-t-current animate-spin rounded-full" />
                        Sending...
                      </>
                    ) : (
                      <>
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 5.25a3 3 0 013 3m2.25 4.5a6 6 0 01-7.5 0M7.5 8.25H3.75v10.5h16.5V8.25H16.5M12 15.75a3 3 0 01-3-3v-1.5a3 3 0 116 0v1.5a3 3 0 01-3 3z" />
                        </svg>
                        Reset Password
                      </>
                    )}
                  </button>
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-5">
              {/* Layout Selection */}
              {onLayoutChange && (
                <div>
                  <h3 className={`${tc.fontClass} ${tc.text} font-medium text-sm mb-3`}>Layout</h3>
                  <div className="space-y-2">
                    <button
                      onClick={() => onLayoutChange('classic')}
                      className={`w-full flex items-center justify-between p-3 rounded-lg border transition-colors ${
                        layoutMode === 'classic'
                          ? `${tc.border} ${tc.activePillBg} ${tc.activePillText}`
                          : `${tc.border} ${tc.text} hover:border-[#1a1a1a]`
                      }`}
                    >
                      <span className={`${tc.fontClass} text-sm`}>Classic</span>
                      {layoutMode === 'classic' && (
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                        </svg>
                      )}
                    </button>
                    <button
                      onClick={() => onLayoutChange('editorial')}
                      className={`w-full flex items-center justify-between p-3 rounded-lg border transition-colors ${
                        layoutMode === 'editorial'
                          ? `${tc.border} ${tc.activePillBg} ${tc.activePillText}`
                          : `${tc.border} ${tc.text} hover:border-[#1a1a1a]`
                      }`}
                    >
                      <span className={`${tc.fontClass} text-sm`}>Editorial</span>
                      {layoutMode === 'editorial' && (
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                        </svg>
                      )}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className={`border-t ${tc.border} px-5 py-4`}>
          <button
            onClick={onClose}
            className={`w-full ${tc.activePillBg} ${tc.activePillText} py-2.5 text-sm rounded-lg hover:opacity-90 transition-opacity ${tc.fontClass}`}
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
