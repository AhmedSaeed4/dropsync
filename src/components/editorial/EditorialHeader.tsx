'use client';

import { Workspace } from '@/types';
import { getEditorialThemeColors } from './editorialTheme';
import { EditorialWorkspaceSwitcher } from './EditorialWorkspaceSwitcher';

type Theme = 'light' | 'dark' | 'minimal';

interface EditorialHeaderProps {
  theme: Theme;
  onThemeChange?: (theme: Theme) => void;
  onOpenSettings?: () => void;
  onToggleChat?: () => void;
  chatOpen?: boolean;
  unreadCount?: number;
  user: { email: string | null; displayName: string | null } | null;
  onSignOut?: () => void;
  // Workspace props
  workspaces: Workspace[];
  currentWorkspace: Workspace | null;
  currentUserId: string | null;
  onSwitch: (workspaceId: string | null) => void;
  onCreate: () => void;
  onJoin: () => void;
  onDelete: (workspace: Workspace) => void;
  onLeave: (workspace: Workspace) => void;
  onPersonalOptions?: () => void;
  // Workspace ids with ≥1 unread @mention of this user → the switcher name glows.
  mentionedWorkspaceIds?: Set<string>;
}

export function EditorialHeader({
  theme,
  onOpenSettings,
  onToggleChat,
  chatOpen = false,
  unreadCount = 0,
  // Workspace props
  workspaces,
  currentWorkspace,
  currentUserId,
  onSwitch,
  onCreate,
  onJoin,
  onDelete,
  onLeave,
  onPersonalOptions,
  mentionedWorkspaceIds,
}: EditorialHeaderProps) {
  const tc = getEditorialThemeColors(theme);

  return (
    <header
      className={`${tc.bg} border-b ${tc.border} relative z-40 shrink-0 transition-colors duration-500`}
    >
      {/* Main header with chat-open animations */}
      <div className={`flex items-center justify-between transition-all duration-[350ms] ease-[cubic-bezier(0.4,0,0.2,1)] px-4 sm:px-6 py-4 lg:py-6 lg:pl-[var(--nav-pl)] lg:pr-[var(--nav-pr)] [--nav-pl:80px] [--nav-pr:80px] ${chatOpen ? '' : 'wide:[--nav-pl:120px] wide:[--nav-pr:140px]'}`}>
        {/* Left: Logo */}
        <div className={`flex items-center transition-all duration-[350ms] ease-[cubic-bezier(0.4,0,0.2,1)] ${chatOpen ? 'gap-2' : 'gap-2.5'}`}>
          <span className={`${tc.fontClass} ${tc.text} font-medium tracking-[-0.3px] transition-all duration-[350ms] ease-[cubic-bezier(0.4,0,0.2,1)] ${chatOpen ? 'text-[20px]' : 'text-[22px]'}`}>
            <span className="inline-block mr-2 text-lg">&#9670;</span>
            DropSync
          </span>
        </div>

        {/* Right: Actions */}
        <div className={`flex items-center transition-all duration-[350ms] ease-[cubic-bezier(0.4,0,0.2,1)] gap-2 sm:gap-3 ${chatOpen ? 'lg:gap-4' : 'lg:gap-6'}`}>
          {/* Workspace Selector - Editorial style */}
          <EditorialWorkspaceSwitcher
            workspaces={workspaces}
            currentWorkspace={currentWorkspace}
            currentUserId={currentUserId}
            onSwitch={onSwitch}
            onCreate={onCreate}
            onJoin={onJoin}
            onDelete={onDelete}
            onLeave={onLeave}
            onPersonalOptions={onPersonalOptions}
            theme={theme}
            showChat={chatOpen}
            mentionedWorkspaceIds={mentionedWorkspaceIds}
          />

          {/* AI Assistant - Filled pill when chat closed, outline when open */}
          {onToggleChat && (
            <button
              onClick={onToggleChat}
              className={`text-xs ${tc.fontClass} rounded-md transition-all duration-[350ms] ease-[cubic-bezier(0.4,0,0.2,1)] hidden sm:flex
                ${chatOpen
                  ? `border ${tc.border} ${tc.btnBg} ${tc.text} hover:border-[#1a1a1a] px-2.5 sm:px-3 py-2`
                  : `${tc.activePillBg} ${tc.activePillText} hover:opacity-90 px-2.5 sm:px-4 py-2 sm:py-2.5`
                }`}
            >
              <span className="hidden sm:inline">{chatOpen ? 'Close' : <>Agent / <span className={unreadCount > 0 && !chatOpen ? 'animate-text-rgb' : ''}>Chat</span></>}</span>
              <span className="sm:hidden">{chatOpen ? 'Close' : 'Chat'}</span>
            </button>
          )}

          {/* Settings - Outline pill */}
          {onOpenSettings && (
            <button
              onClick={onOpenSettings}
              className={`text-sm ${tc.fontClass} rounded-md border ${tc.border} ${tc.btnBg} ${tc.text} hover:border-[#1a1a1a] transition-all duration-[350ms] ease-[cubic-bezier(0.4,0,0.2,1)] px-3 sm:px-4 ${chatOpen ? 'lg:px-4 lg:py-2' : 'lg:px-6 lg:py-2.5'} py-2`}
            >
              <span className="hidden sm:inline">Settings</span>
              <svg className="w-4 h-4 sm:hidden" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
            </button>
          )}
        </div>
      </div>
    </header>
  );
}
