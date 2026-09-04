'use client';

import { getEditorialThemeColors } from '../editorialTheme';

type Theme = 'light' | 'dark' | 'minimal';

interface MobileHeaderProps {
  theme: Theme;
  onCycleTheme: () => void;
  onToggleChat?: () => void;
  chatOpen: boolean;
  unreadCount: number;
  onOpenSettings: () => void;
}

// Mobile header (decisions #6 + #13): no logo — chat, theme, settings icons on the right.
// Desktop keeps its pills and its logo; this bar is shell-only.
export function MobileHeader({ theme, onCycleTheme, onToggleChat, chatOpen, unreadCount, onOpenSettings }: MobileHeaderProps) {
  const tc = getEditorialThemeColors(theme);

  return (
    <header className={`${tc.bg} border-b ${tc.border} shrink-0 pt-[env(safe-area-inset-top)] transition-colors duration-500`}>
      <div className="flex h-[56px] items-center justify-end px-4">
        <div className="flex items-center gap-2">
          {onToggleChat && (
            <button
              type="button"
              onClick={onToggleChat}
              aria-label={chatOpen ? 'Close chat' : 'Open chat'}
              className={`relative flex h-10 w-10 items-center justify-center rounded-full border transition-colors ${
                chatOpen
                  ? `${tc.activePillBg} ${tc.activePillText} border-transparent`
                  : `${tc.border} ${tc.text}`
              }`}
            >
              <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.8}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M21 12a8.5 8.5 0 0 1-8.5 8.5c-1.3 0-2.6-.3-3.7-.85L3.5 20.5l.9-4.1A8.5 8.5 0 1 1 21 12z" />
                <circle cx="8.5" cy="12" r=".9" fill="currentColor" stroke="none" />
                <circle cx="12.5" cy="12" r=".9" fill="currentColor" stroke="none" />
                <circle cx="16.5" cy="12" r=".9" fill="currentColor" stroke="none" />
              </svg>
              {unreadCount > 0 && !chatOpen && (
                <span aria-hidden="true" className={`absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-current ${tc.text}`} />
              )}
            </button>
          )}

          <button
            type="button"
            onClick={onCycleTheme}
            aria-label="Cycle theme"
            className={`flex h-10 w-10 items-center justify-center rounded-full border ${tc.border} ${tc.text} transition-colors`}
          >
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.8}>
              <circle cx="12" cy="12" r="8.5" />
              <path d="M12 3.5v17M12 3.5a8.5 8.5 0 0 1 0 17" fill="currentColor" stroke="none" opacity=".18" />
            </svg>
          </button>

          <button
            type="button"
            onClick={onOpenSettings}
            aria-label="Settings"
            className={`flex h-10 w-10 items-center justify-center rounded-full border ${tc.border} ${tc.text} transition-colors`}
          >
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          </button>
        </div>
      </div>
    </header>
  );
}
