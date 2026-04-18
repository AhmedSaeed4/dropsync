'use client';

import { useState } from 'react';
import { useBodyScrollLock } from '@/hooks/useBodyScrollLock';

interface AuthModalProps {
  onSignIn: (email: string, password: string) => Promise<{ error?: string; needsVerification?: boolean }>;
  onSignUp: (email: string, password: string) => Promise<{ error?: string; success?: boolean }>;
  onResetPassword: (email: string) => Promise<{ success: boolean; error?: string }>;
  onGoogleSignIn: () => void;
  onShowVerifyModal: (email: string) => void;
  onClose: () => void;
  theme?: 'light' | 'dark' | 'minimal';
  loading?: boolean;
}

export function AuthModal({
  onSignIn,
  onSignUp,
  onResetPassword,
  onGoogleSignIn,
  onShowVerifyModal,
  onClose,
  theme = 'light',
  loading: externalLoading
}: AuthModalProps) {
  useBodyScrollLock();
  const [tab, setTab] = useState<'signin' | 'signup'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resetEmailSent, setResetEmailSent] = useState(false);
  const [showResetForm, setShowResetForm] = useState(false);
  const [success, setSuccess] = useState(false);

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
        placeholderColor: 'placeholder:text-[#1A1A1A]/30',
        errorBg: 'bg-red-500/10',
        errorBorder: 'border-red-500/50',
        fontClass: 'font-sans tracking-wide text-xs',
        roundedClass: 'rounded-lg',
        tabActive: 'bg-[#1A1A1A] text-white',
        tabInactive: 'text-[#1A1A1A]/50 hover:text-[#1A1A1A]',
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
      placeholderColor: isDark ? 'placeholder:text-white/30' : 'placeholder:text-[#1A1A1A]/30',
      errorBg: 'bg-red-500/10',
      errorBorder: 'border-red-500/50',
      fontClass: 'font-mono uppercase tracking-wider text-[10px]',
      roundedClass: '',
      tabActive: 'bg-[#1A1A1A] text-white',
      tabInactive: isDark ? 'text-white/50 hover:text-white' : 'text-[#1A1A1A]/50 hover:text-[#1A1A1A]',
    };
  };

  const tc = getThemeColors();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!email.trim() || !password) {
      setError('Please fill in all fields.');
      return;
    }

    if (tab === 'signup' && password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    if (tab === 'signup' && password.length < 6) {
      setError('Password must be at least 6 characters.');
      return;
    }

    setLoading(true);

    if (tab === 'signup') {
      const result = await onSignUp(email.trim(), password);
      setLoading(false);
      if (result.error) {
        setError(result.error);
      } else if (result.success) {
        // Show verification modal
        onShowVerifyModal(email.trim());
      }
    } else {
      const result = await onSignIn(email.trim(), password);
      setLoading(false);
      if (result.error) {
        setError(result.error);
        if (result.needsVerification) {
          onShowVerifyModal(email.trim());
        }
      } else {
        // Sign in successful - hide form immediately and close modal
        setSuccess(true);
        onClose();
      }
    }
  };

  const handleResetPassword = async () => {
    if (!email.trim()) {
      setError('Please enter your email address.');
      return;
    }

    setLoading(true);
    const result = await onResetPassword(email.trim());
    setLoading(false);

    if (result.success) {
      setResetEmailSent(true);
      setShowResetForm(false);
    } else if (result.error) {
      setError(result.error);
    }
  };

  const isLoading = loading || externalLoading;

  return (
    <div
      className={`fixed inset-0 ${tc.overlayBg} flex items-center justify-center z-50 p-4 transition-colors duration-300 overscroll-contain`}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className={`${tc.bgColor} border ${tc.borderColor} ${tc.roundedClass} w-full max-w-md transition-colors duration-300`}>
        {/* Header */}
        <div className={`border-b ${tc.borderColor} px-6 py-4 flex items-center justify-between ${tc.headerBg}`}>
          <h2 className={`${isMinimal ? 'text-sm font-medium' : 'text-sm font-bold uppercase tracking-wider'} text-white`}>
            {showResetForm ? 'Reset Password' : 'Account'}
          </h2>
          <button onClick={onClose} className="text-white/70 hover:text-white transition-colors">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="p-6">
          {showResetForm ? (
            <>
              <p className={`${tc.fontClass} ${tc.textMuted} mb-4`}>
                Enter your email address and we&apos;ll send you a link to reset your password.
              </p>

              {resetEmailSent ? (
                <div className={`border ${tc.borderColor} p-4 ${tc.roundedClass} mb-4`}>
                  <p className={`${tc.fontClass} ${tc.textColor}`}>
                    Password reset email sent! Check your inbox.
                  </p>
                </div>
              ) : (
                <form onSubmit={(e) => { e.preventDefault(); handleResetPassword(); }} className="space-y-4">
                  <div>
                    <label className={`block ${tc.fontClass} ${tc.textMuted} mb-2`}>Email</label>
                    <input
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="your@email.com"
                      className={`w-full border ${tc.borderColor} ${tc.inputBg} ${tc.textColor} px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#1A1A1A] focus:border-transparent transition-colors duration-300 ${tc.roundedClass} ${tc.placeholderColor}`}
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
                      onClick={() => { setShowResetForm(false); setError(null); }}
                      className={`flex-1 border ${tc.borderColor} ${tc.textColor} py-3 text-xs tracking-wider hover:bg-[#1A1A1A] hover:text-white transition-colors ${isMinimal ? 'rounded-full' : ''}`}
                    >
                      Back
                    </button>
                    <button
                      type="submit"
                      disabled={isLoading}
                      className={`flex-1 bg-[#1A1A1A] text-white py-3 text-xs tracking-wider hover:bg-[#2A2A2A] disabled:bg-[#C4C4C4] disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2 ${isMinimal ? 'rounded-full' : ''}`}
                    >
                      {isLoading ? (
                        <>
                          <div className="w-4 h-4 border border-white/30 border-t-white animate-spin rounded-full" />
                          Sending...
                        </>
                      ) : (
                        'Send Reset Link'
                      )}
                    </button>
                  </div>
                </form>
              )}
            </>
          ) : (
            <>
              {/* Success state - show nothing while modal closes */}
              {success ? (
                <div className="p-6 flex items-center justify-center">
                  <div className="w-6 h-6 border-2 border-[#FF5A47] border-t-transparent animate-spin rounded-full" />
                </div>
              ) : (
                <>
                  {/* Tabs */}
                  <div className="flex mb-6">
                    <button
                      onClick={() => { setTab('signin'); setError(null); }}
                      className={`flex-1 py-3 text-xs tracking-wider transition-all ${isMinimal ? 'rounded-full mr-2' : ''} ${tab === 'signin' ? tc.tabActive : tc.tabInactive}`}
                    >
                      Sign In
                    </button>
                    <button
                      onClick={() => { setTab('signup'); setError(null); }}
                      className={`flex-1 py-3 text-xs tracking-wider transition-all ${isMinimal ? 'rounded-full' : ''} ${tab === 'signup' ? tc.tabActive : tc.tabInactive}`}
                    >
                      Sign Up
                    </button>
                  </div>

              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <label className={`block ${tc.fontClass} ${tc.textMuted} mb-2`}>Email</label>
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="your@email.com"
                    autoFocus
                    className={`w-full border ${tc.borderColor} ${tc.inputBg} ${tc.textColor} px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#1A1A1A] focus:border-transparent transition-colors duration-300 ${tc.roundedClass} ${tc.placeholderColor}`}
                  />
                </div>

                <div>
                  <label className={`block ${tc.fontClass} ${tc.textMuted} mb-2`}>Password</label>
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    className={`w-full border ${tc.borderColor} ${tc.inputBg} ${tc.textColor} px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#1A1A1A] focus:border-transparent transition-colors duration-300 ${tc.roundedClass} ${tc.placeholderColor}`}
                  />
                </div>

                {tab === 'signup' && (
                  <div>
                    <label className={`block ${tc.fontClass} ${tc.textMuted} mb-2`}>Confirm Password</label>
                    <input
                      type="password"
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      placeholder="••••••••"
                      className={`w-full border ${tc.borderColor} ${tc.inputBg} ${tc.textColor} px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#1A1A1A] focus:border-transparent transition-colors duration-300 ${tc.roundedClass} ${tc.placeholderColor}`}
                    />
                  </div>
                )}

                {tab === 'signin' && (
                  <button
                    type="button"
                    onClick={() => { setShowResetForm(true); setError(null); }}
                    className={`${tc.fontClass} ${tc.textMuted} hover:${tc.textColor} transition-colors`}
                  >
                    Forgot password?
                  </button>
                )}

                {error && (
                  <div data-error-box className={`border ${tc.errorBorder} ${tc.errorBg} px-4 py-3 ${tc.roundedClass}`}>
                    <p className={`text-xs ${tc.textColor}`}>{error}</p>
                  </div>
                )}

                <button
                  type="submit"
                  disabled={isLoading}
                  className={`w-full bg-[#1A1A1A] text-white py-3 text-xs tracking-wider hover:bg-[#2A2A2A] disabled:bg-[#C4C4C4] disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2 ${isMinimal ? 'rounded-full' : ''}`}
                >
                  {isLoading ? (
                    <>
                      <div className="w-4 h-4 border border-white/30 border-t-white animate-spin rounded-full" />
                      {tab === 'signup' ? 'Creating Account...' : 'Signing In...'}
                    </>
                  ) : (
                    tab === 'signup' ? 'Create Account' : 'Sign In'
                  )}
                </button>
              </form>

              {/* Divider */}
              <div className="flex items-center gap-4 my-6">
                <div className={`flex-1 h-px ${isDark ? 'bg-white/10' : 'bg-[#1A1A1A]/10'}`} />
                <span className={`${tc.fontClass} ${tc.textMuted}`}>or</span>
                <div className={`flex-1 h-px ${isDark ? 'bg-white/10' : 'bg-[#1A1A1A]/10'}`} />
              </div>

              {/* Google Sign In */}
              <button
                onClick={onGoogleSignIn}
                disabled={isLoading}
                className={`w-full border ${tc.borderColor} ${tc.textColor} py-3 text-xs tracking-wider hover:bg-[#1A1A1A] hover:text-white transition-colors flex items-center justify-center gap-3 ${isMinimal ? 'rounded-full' : ''}`}
              >
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                  <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                  <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                  <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
                </svg>
                Sign in with Google
              </button>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}