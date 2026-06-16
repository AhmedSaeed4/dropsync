'use client';

import { getEditorialThemeColors } from './editorialTheme';

interface EditorialLoginProps {
  signIn: () => void;
  onShowAuthModal: () => void;
  theme: 'light' | 'dark' | 'minimal';
}

export function EditorialLogin({ signIn, onShowAuthModal, theme }: EditorialLoginProps) {
  const tc = getEditorialThemeColors(theme);

  return (
    <div className={`min-h-screen ${tc.bg} flex flex-col transition-colors duration-500`}>
      {/* Main Content */}
      <main className="flex-1 flex flex-col items-center justify-center px-8 relative">
        {/* Center Text Block */}
        <div className="max-w-lg text-center">
          {/* Logo */}
          <div className={`text-2xl font-medium tracking-tight ${tc.fontClass} ${tc.text} mb-8`}>
            <span className="inline-block mr-2 text-lg">&#9670;</span>
            DropSync
          </div>

          {/* Tagline */}
          <p className={`text-base md:text-lg leading-relaxed tracking-wide mb-4 ${tc.fontClass} ${tc.text}`}>
            Drop files on one device.<br />
            Pickup on another.<br />
            Simple. Secure. Temporary.
          </p>

          {/* Subtitle */}
          <p className={`text-sm ${tc.fontClass} ${tc.muted} mb-12`}>
            Auto-expire: 1h - Forever &middot; Max 500MB &middot; Unlimited drops
          </p>

          {/* Auth Buttons */}
          <div className="flex flex-col gap-3 items-center">
            <button
              onClick={signIn}
              className={`inline-flex items-center gap-3 px-8 py-3 border ${tc.border} rounded-full text-sm ${tc.fontClass} ${tc.text} hover:bg-[#1a1a1a] hover:text-white transition-all duration-300`}
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
              </svg>
              Sign in with Google
            </button>
            <button
              onClick={onShowAuthModal}
              className={`inline-flex items-center gap-3 px-8 py-3 bg-[#1a1a1a] rounded-full text-sm ${tc.fontClass} text-white hover:bg-[#333] transition-all duration-300`}
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
                <path strokeLinecap="round" strokeLinejoin="round" d="M21.75 6.75v10.5a2.25 2.25 0 01-2.25 2.25h-15a2.25 2.25 0 01-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25m19.5 0v.243a2.25 2.25 0 01-1.07 1.916l-7.5 4.615a2.25 2.25 0 01-2.36 0L3.32 8.91a2.25 2.25 0 01-1.07-1.916V6.75" />
              </svg>
              Sign in with Email
            </button>
          </div>
        </div>

        {/* Footer decorations */}
        <div className={`absolute bottom-8 left-8 text-xs ${tc.fontClass} ${tc.muted}`}>
          {new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}
        </div>
        <div className={`absolute bottom-8 right-8 text-xs ${tc.fontClass} ${tc.muted}`}>
          EDITION 2.0
        </div>
      </main>
    </div>
  );
}
