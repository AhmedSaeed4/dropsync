'use client';

import { useAuth } from '@/hooks/useAuth';

type Theme = 'light' | 'dark' | 'minimal';

interface HeaderProps {
  theme?: Theme;
  onThemeChange?: (theme: Theme) => void;
}

export function Header({ theme = 'light', onThemeChange }: HeaderProps) {
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
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-[#1A1A1A] rounded-full flex items-center justify-center">
              <svg className="w-4 h-4 text-[#C5C9B8]" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
                <path d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
              </svg>
            </div>
            <span className="text-sm font-medium tracking-wide text-[#1A1A1A]">DROP/SYNC</span>
          </div>

          <div className="flex items-center gap-6">
            {user ? (
              <>
                <span className="text-xs text-[#1A1A1A]/50 hidden sm:block">{user.email}</span>
                <button
                  onClick={signOutUser}
                  className="border border-[#1A1A1A]/30 text-[#1A1A1A] px-4 py-2 text-xs tracking-wider hover:bg-[#1A1A1A] hover:text-white transition-all rounded-full"
                >
                  Sign out
                </button>
              </>
            ) : (
              <button
                onClick={signIn}
                className="border border-[#1A1A1A]/30 text-[#1A1A1A] px-5 py-2 text-xs tracking-wider hover:bg-[#1A1A1A] hover:text-white transition-all rounded-full flex items-center gap-2"
              >
                Sign in
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
      <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <div className="w-12 h-12 bg-[#FF5A47] flex items-center justify-center relative overflow-hidden">
            <div className="absolute inset-0 geo-crosshair opacity-20" />
            <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
              <path d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
            </svg>
          </div>
          <div>
            <h1 className={`text-xl font-bold tracking-tight ${styles.textColor} uppercase`}>
              DROP/SYNC
            </h1>
            <p className={`text-[10px] font-mono uppercase tracking-wider ${styles.textMuted}`}>
              SECURE TRANSFER SYSTEM // v1.0
            </p>
          </div>
        </div>

        <div className="flex items-center gap-6">
          {user ? (
            <>
              <div className={`hidden sm:flex items-center gap-3 text-[10px] font-mono uppercase tracking-wider`}>
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

              <button
                onClick={signOutUser}
                className={`px-5 py-2 text-xs font-semibold uppercase tracking-wider transition-colors ${styles.buttonClass}`}
              >
                SIGN OUT
              </button>
            </>
          ) : (
            <button
              onClick={signIn}
              className="bg-[#1A1A1A] text-white px-6 py-3 text-xs font-semibold uppercase tracking-wider hover:bg-[#2A2A2A] transition-colors flex items-center gap-2"
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
              </svg>
              AUTH/GOOGLE
            </button>
          )}
        </div>
      </div>
    </header>
  );
}
