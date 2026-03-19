'use client';

import { useAuth } from '@/hooks/useAuth';
import { ReactNode } from 'react';

type Theme = 'light' | 'dark' | 'minimal';

interface HeaderProps {
  theme?: Theme;
  onThemeChange?: (theme: Theme) => void;
  onOpenSettings?: () => void;
  children?: ReactNode;
}

export function Header({ theme = 'light', onThemeChange, onOpenSettings, children }: HeaderProps) {
  const { user, loading, signIn, signOutUser } = useAuth();
  const isDark = theme === 'dark';
  const isMinimal = theme === 'minimal';

  // Theme-specific styles
  const getThemeStyles = () => {
    if (isMinimal) {
      return {
        bgColor: 'bg-[#C5C9B8]',
        borderColor: 'border-[#1A1A1A]/10',
        textColor: 'text-[#1A1A1A]',
        textMuted: 'text-[#1A1A1A]/50',
        buttonClass: 'border border-[#1A1A1A]/30 text-[#1A1A1A] hover:bg-[#1A1A1A] hover:text-white rounded-full px-6',
        logoBg: 'bg-[#1A1A1A]',
        fontClass: 'font-sans tracking-wide',
      };
    }
    return {
      bgColor: isDark ? 'bg-[#0D0D0D]' : 'bg-[#FAF7F2]',
      borderColor: isDark ? 'border-white/10' : 'border-[#1A1A1A]',
      textColor: isDark ? 'text-white' : 'text-[#1A1A1A]',
      textMuted: isDark ? 'text-white/60' : 'text-[#1A1A1A]/60',
      buttonClass: isDark
        ? 'border border-white/20 text-white hover:bg-white hover:text-[#0D0D0D]'
        : 'border border-[#1A1A1A] text-[#1A1A1A] hover:bg-[#1A1A1A] hover:text-white',
      logoBg: 'bg-[#FF5A47]',
      fontClass: 'font-mono uppercase tracking-wider',
    };
  };

  const styles = getThemeStyles();

  if (loading) {
    return (
      <header className={`border-b ${styles.borderColor} ${styles.bgColor} sticky top-0 z-40 transition-colors duration-500`}>
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className={`w-10 h-10 ${isMinimal ? 'bg-[#1A1A1A]/20' : isDark ? 'bg-white/20' : 'bg-[#1A1A1A]'} animate-pulse ${isMinimal ? 'rounded-full' : ''}`} />
          </div>
        </div>
      </header>
    );
  }

  // Minimal theme header - clean and elegant
  if (isMinimal) {
    return (
      <header className="border-b border-[#1A1A1A]/10 bg-[#C5C9B8] sticky top-0 z-40 transition-colors duration-500">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-3 sm:py-4 flex items-center justify-between">
          <div className="flex items-center gap-2 sm:gap-3">
            <div className="w-8 h-8 bg-[#1A1A1A] rounded-full flex items-center justify-center shrink-0">
              <svg className="w-4 h-4 text-[#C5C9B8]" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
                <path d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
              </svg>
            </div>
            <span className="text-sm font-medium tracking-wide text-[#1A1A1A] hidden sm:block">DROP/SYNC</span>
          </div>

          <div className="flex items-center gap-2 sm:gap-4">
            {children}

            {user ? (
              <>
                <span className="text-xs text-[#1A1A1A]/50 hidden md:block">{user.email}</span>
                {onOpenSettings && (
                  <button
                    onClick={onOpenSettings}
                    className="border border-[#1A1A1A]/30 text-[#1A1A1A] px-3 py-2 sm:px-4 text-xs tracking-wider hover:bg-[#1A1A1A] hover:text-white transition-all rounded-full"
                  >
                    <span className="sm:hidden">
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                        <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                      </svg>
                    </span>
                    <span className="hidden sm:inline">Settings</span>
                  </button>
                )}
                <button
                  onClick={signOutUser}
                  className="border border-[#1A1A1A]/30 text-[#1A1A1A] px-3 py-2 sm:px-4 text-xs tracking-wider hover:bg-[#1A1A1A] hover:text-white transition-all rounded-full"
                >
                  <span className="sm:hidden">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
                    </svg>
                  </span>
                  <span className="hidden sm:inline">Sign out</span>
                </button>
              </>
            ) : (
              <button
                onClick={signIn}
                className="border border-[#1A1A1A]/30 text-[#1A1A1A] px-3 py-2 sm:px-5 text-xs tracking-wider hover:bg-[#1A1A1A] hover:text-white transition-all rounded-full flex items-center gap-2"
              >
                <span className="hidden sm:inline">Sign in</span>
                <span className="sm:hidden">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M11 16l-4-4m0 0l4-4m-4 4h14m-5 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h7a3 3 0 013 3v1" />
                  </svg>
                </span>
              </button>
            )}
          </div>
        </div>
      </header>
    );
  }

  // Light/Dark theme header - operational intelligence
  return (
    <header className={`border-b ${styles.borderColor} ${styles.bgColor} sticky top-0 z-40 transition-colors duration-500`}>
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-3 sm:py-4 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-3 sm:gap-4">
          <div className="w-10 h-10 sm:w-12 sm:h-12 bg-[#FF5A47] flex items-center justify-center relative overflow-hidden shrink-0">
            <div className="absolute inset-0 geo-crosshair opacity-20" />
            <svg className="w-5 h-5 sm:w-6 sm:h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
              <path d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
            </svg>
          </div>
          <div className="hidden sm:block">
            <h1 className={`text-lg sm:text-xl font-bold tracking-tight ${styles.textColor} uppercase`}>
              DROP/SYNC
            </h1>
            <p className={`text-[9px] sm:text-[10px] font-mono uppercase tracking-wider ${styles.textMuted}`}>
              SECURE TRANSFER // v1.0
            </p>
          </div>

          {/* Workspace Switcher */}
          <div className="sm:hidden">
            {children}
          </div>
        </div>

        <div className="flex items-center gap-2 sm:gap-4">
          {/* Workspace Switcher - desktop */}
          <div className="hidden sm:block">
            {children}
          </div>

          {user ? (
            <>
              <div className={`hidden md:flex items-center gap-3 text-[10px] font-mono uppercase tracking-wider`}>
                <div className="flex items-center gap-2">
                  <span className="w-2 h-2 bg-[#FF5A47] rounded-full status-active" />
                  <span className={styles.textMuted}>SYS:</span>
                  <span className={styles.textColor}>ONLINE</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className={styles.textMuted}>USER:</span>
                  <span className={`${styles.textColor} truncate max-w-[120px]`}>{user.email}</span>
                </div>
              </div>

              {onOpenSettings && (
                <button
                  onClick={onOpenSettings}
                  className={`px-3 py-2 sm:px-5 text-[10px] sm:text-xs font-semibold uppercase tracking-wider transition-colors ${styles.buttonClass}`}
                >
                  <span className="sm:hidden">⚙</span>
                  <span className="hidden sm:inline">SETTINGS</span>
                </button>
              )}

              <button
                onClick={signOutUser}
                className={`px-3 py-2 sm:px-5 text-[10px] sm:text-xs font-semibold uppercase tracking-wider transition-colors ${styles.buttonClass}`}
              >
                <span className="sm:hidden flex items-center justify-center">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
                  </svg>
                </span>
                <span className="hidden sm:inline">SIGN OUT</span>
              </button>
            </>
          ) : (
            <button
              onClick={signIn}
              className="bg-[#1A1A1A] text-white px-4 py-2 sm:px-6 text-[10px] sm:text-xs font-semibold uppercase tracking-wider hover:bg-[#2A2A2A] transition-colors flex items-center gap-2"
            >
              <svg className="w-3 h-3 sm:w-4 sm:h-4" viewBox="0 0 24 24" fill="currentColor">
                <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
              </svg>
              <span className="hidden sm:inline">AUTH/GOOGLE</span>
              <span className="sm:hidden">SIGN IN</span>
            </button>
          )}
        </div>
      </div>
    </header>
  );
}
