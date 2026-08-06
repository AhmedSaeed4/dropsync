'use client';

import { useEffect, useRef, useState } from 'react';
import { useBodyScrollLock } from '@/hooks/useBodyScrollLock';
import { useModalBackClose } from '@/hooks/useModalBackClose';
import { getEditorialThemeColors } from './editorialTheme';

interface EditorialAuthModalProps {
  onSignIn: (email: string, password: string) => Promise<{ error?: string; needsVerification?: boolean }>;
  onSignUp: (email: string, password: string) => Promise<{ error?: string; success?: boolean }>;
  onResetPassword: (email: string) => Promise<{ success: boolean; error?: string }>;
  onGoogleSignIn: () => void;
  onShowVerifyModal: (email: string) => void;
  onClose: () => void;
  theme?: 'light' | 'dark' | 'minimal';
  loading?: boolean;
}

export function EditorialAuthModal({
  onSignIn,
  onSignUp,
  onResetPassword,
  onGoogleSignIn,
  onShowVerifyModal,
  onClose,
  theme = 'light',
  loading: externalLoading
}: EditorialAuthModalProps) {
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
  const authRequestEpochRef = useRef(0);

  // A closed auth window must not let a late network result surface a modal or other form state.
  useEffect(() => () => {
    authRequestEpochRef.current += 1;
  }, []);

  const tc = getEditorialThemeColors(theme);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const requestEpoch = ++authRequestEpochRef.current;
    setLoading(true);

    if (showResetForm) {
      const result = await onResetPassword(email);
      if (authRequestEpochRef.current !== requestEpoch) return;
      if (result.success) {
        setResetEmailSent(true);
      } else if (result.error) {
        setError(result.error);
      }
      setLoading(false);
      return;
    }

    if (tab === 'signup') {
      if (password !== confirmPassword) {
        setError('Passwords do not match');
        setLoading(false);
        return;
      }
      const result = await onSignUp(email, password);
      if (authRequestEpochRef.current !== requestEpoch) return;
      if (result.error) {
        setError(result.error);
      } else if (result.success) {
        setSuccess(true);
      }
    } else {
      const result = await onSignIn(email, password);
      if (authRequestEpochRef.current !== requestEpoch) return;
      if (result.error) {
        setError(result.error);
      } else if (result.needsVerification) {
        onShowVerifyModal(email);
      }
    }

    setLoading(false);
  };

  const handleClose = () => {
    authRequestEpochRef.current += 1;
    onClose();
  };

  useModalBackClose(true, handleClose);

  const isLoading = loading || externalLoading;

  return (
    <div
      className="fixed inset-0 bg-[#1a1a1a]/60 flex items-center justify-center z-50 p-4"
      onClick={(e) => e.target === e.currentTarget && handleClose()}
    >
      <div className={`${tc.bg} border ${tc.border} rounded-xl w-full max-w-md overflow-hidden shadow-xl`}>
        {/* Header */}
        <div className={`border-b ${tc.border} px-5 py-4 flex items-center justify-between`}>
          <h2 className={`${tc.fontClass} ${tc.text} font-medium text-[15px]`}>
            {showResetForm ? 'Reset Password' : 'Welcome'}
          </h2>
          <button onClick={handleClose} className={`${tc.muted} hover:${tc.text} transition-colors p-1`}>
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="p-5">
          {!showResetForm && !success && (
            <>
              {/* Tabs */}
              <div className={`flex border ${tc.border} rounded-lg mb-5 overflow-hidden`}>
                <button
                  onClick={() => setTab('signin')}
                  className={`flex-1 py-2.5 text-sm ${tc.fontClass} transition-colors ${
                    tab === 'signin'
                      ? `${tc.activePillBg} ${tc.activePillText}`
                      : `${tc.text} hover:bg-[#1a1a1a]/5`
                  }`}
                >
                  Sign In
                </button>
                <button
                  onClick={() => setTab('signup')}
                  className={`flex-1 py-2.5 text-sm ${tc.fontClass} transition-colors ${
                    tab === 'signup'
                      ? `${tc.activePillBg} ${tc.activePillText}`
                      : `${tc.text} hover:bg-[#1a1a1a]/5`
                  }`}
                >
                  Sign Up
                </button>
              </div>

              {/* Google Sign In */}
              <button
                onClick={onGoogleSignIn}
                className={`w-full flex items-center justify-center gap-2 border ${tc.border} rounded-lg py-2.5 mb-4 hover:border-[#1a1a1a] transition-colors ${tc.fontClass} ${tc.text}`}
              >
                <svg className="w-4 h-4" viewBox="0 0 24 24">
                  <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                  <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                  <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                  <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
                </svg>
                Continue with Google
              </button>

              <div className={`flex items-center gap-3 mb-4 ${tc.muted}`}>
                <div className={`flex-1 h-px ${tc.border} bg-current opacity-20`} />
                <span className={`text-xs ${tc.fontClass}`}>or</span>
                <div className={`flex-1 h-px ${tc.border} bg-current opacity-20`} />
              </div>
            </>
          )}

          {success ? (
            <div className="text-center py-6">
              <svg className="w-12 h-12 text-green-500 mx-auto mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <h3 className={`${tc.fontClass} ${tc.text} text-lg font-medium mb-2`}>Check your email</h3>
              <p className={`${tc.muted} text-sm ${tc.fontClass}`}>
                We sent a verification link to {email}
              </p>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              {resetEmailSent ? (
                <div className="text-center py-4">
                  <svg className="w-10 h-10 text-green-500 mx-auto mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                  </svg>
                  <p className={`${tc.text} ${tc.fontClass} text-sm`}>Check your email for reset instructions</p>
                </div>
              ) : (
                <>
                  {error && (
                    <div className={`bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-sm text-red-600 ${tc.fontClass}`}>
                      {error}
                    </div>
                  )}

                  <div>
                    <label className={`block text-xs ${tc.muted} ${tc.fontClass} mb-1.5`}>Email</label>
                    <input
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      required
                      className={`w-full border ${tc.border} ${tc.bg} ${tc.text} px-3 py-2.5 text-sm rounded-lg focus:outline-none focus:border-[#1a1a1a] transition-colors ${tc.fontClass}`}
                      placeholder="you@example.com"
                    />
                  </div>

                  {!showResetForm && (
                    <div>
                      <label className={`block text-xs ${tc.muted} ${tc.fontClass} mb-1.5`}>Password</label>
                      <input
                        type="password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        required
                        className={`w-full border ${tc.border} ${tc.bg} ${tc.text} px-3 py-2.5 text-sm rounded-lg focus:outline-none focus:border-[#1a1a1a] transition-colors ${tc.fontClass}`}
                        placeholder="••••••••"
                      />
                    </div>
                  )}

                  {tab === 'signup' && !showResetForm && (
                    <div>
                      <label className={`block text-xs ${tc.muted} ${tc.fontClass} mb-1.5`}>Confirm Password</label>
                      <input
                        type="password"
                        value={confirmPassword}
                        onChange={(e) => setConfirmPassword(e.target.value)}
                        required
                        className={`w-full border ${tc.border} ${tc.bg} ${tc.text} px-3 py-2.5 text-sm rounded-lg focus:outline-none focus:border-[#1a1a1a] transition-colors ${tc.fontClass}`}
                        placeholder="••••••••"
                      />
                    </div>
                  )}

                  {tab === 'signin' && !showResetForm && (
                    <button
                      type="button"
                      onClick={() => setShowResetForm(true)}
                      className={`text-xs ${tc.muted} hover:${tc.text} transition-colors ${tc.fontClass}`}
                    >
                      Forgot password?
                    </button>
                  )}

                  <div className="flex gap-3 pt-2">
                    {(showResetForm || tab === 'signup') && (
                      <button
                        type="button"
                        onClick={() => {
                          setShowResetForm(false);
                          setResetEmailSent(false);
                          setError(null);
                        }}
                        className={`flex-1 border ${tc.border} ${tc.text} py-2.5 text-sm rounded-lg hover:border-[#1a1a1a] transition-colors ${tc.fontClass}`}
                      >
                        Back
                      </button>
                    )}
                    <button
                      type="submit"
                      disabled={isLoading}
                      className={`flex-1 ${tc.activePillBg} ${tc.activePillText} py-2.5 text-sm rounded-lg hover:opacity-90 disabled:opacity-50 transition-opacity ${tc.fontClass} flex items-center justify-center gap-2`}
                    >
                      {isLoading ? (
                        <>
                          <div className="w-4 h-4 border border-white/30 border-t-white animate-spin rounded-full" />
                          {showResetForm ? 'Sending...' : tab === 'signin' ? 'Signing in...' : 'Creating account...'}
                        </>
                      ) : (
                        showResetForm ? 'Send Reset Link' : tab === 'signin' ? 'Sign In' : 'Create Account'
                      )}
                    </button>
                  </div>
                </>
              )}
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
