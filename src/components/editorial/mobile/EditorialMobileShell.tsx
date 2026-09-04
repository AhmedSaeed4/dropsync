'use client';

import { useState, useEffect } from 'react';
import { Drop, Workspace } from '@/types';
import { getEditorialThemeColors } from '../editorialTheme';
import { EditorialChatPanel } from '../EditorialChatPanel';
import { EditorialSettingsModal } from '../EditorialSettingsModal';
import { MobileHeader } from './MobileHeader';
import { MobileNavbar } from './MobileNavbar';

type Theme = 'light' | 'dark' | 'minimal';

interface EditorialMobileShellProps {
  theme: Theme;
  setTheme: (t: Theme) => void;
  encryptionInitializing: boolean;
  showChat: boolean;
  setShowChat: (v: boolean) => void;
  onToggleChat?: () => void;
  unreadCount?: number;
  chatMode?: 'ai' | 'group';
  setChatMode: (v: 'ai' | 'group') => void;
  user: any;
  showSettingsModal: boolean;
  setShowSettingsModal: (v: boolean) => void;
  onOpenSettings: () => void;
  onSettingsClosedOrDismissed: () => void;
  onResetPassword: (email: string) => Promise<{ success: boolean; error?: string }>;
  onReauthenticate: (password?: string) => Promise<{ success: boolean; error?: string }>;
  onNameUpdate: (name: string) => void;
  onLayoutChange: (layout: 'classic' | 'editorial') => void;
  layoutMode: 'classic' | 'editorial';
  notifPermission?: NotificationPermission;
  notifMuted?: boolean;
  onToggleNotifications?: () => void;
  footerEnabled?: boolean;
  onToggleFooterEnabled?: () => void;
  wordAnimEnabled: boolean;
  onToggleWordAnim: () => void;
  wordAnimStyle: string;
  onWordAnimStyleChange: (s: string) => void;
  wordAnimHold: number;
  onWordAnimHoldChange: (ms: number) => void;
  currentWorkspaceId: string | null;
  currentWorkspace: Workspace | null;
  workspaceMembers: any[];
  presenceMap: Record<string, { lastSeen: number; online: boolean }>;
  drops: Drop[];
  onPreviewDrop: (dropId: string, workspaceId: string | null) => void;
}

// Placeholder view panel (4.6) — a quiet full-height dead-end until the view's own order lands.
function MobileViewPlaceholder({ message, toneClass }: { message: string; toneClass: string }) {
  return (
    <div className="flex h-full items-center justify-center px-6 text-center">
      <p className={`text-sm ${toneClass}`}>{message}</p>
    </div>
  );
}

export function EditorialMobileShell({
  theme, setTheme,
  encryptionInitializing,
  showChat, setShowChat,
  onToggleChat,
  unreadCount = 0,
  chatMode = 'ai', setChatMode,
  user,
  showSettingsModal, setShowSettingsModal,
  onOpenSettings,
  onSettingsClosedOrDismissed,
  onResetPassword, onReauthenticate, onNameUpdate,
  onLayoutChange, layoutMode,
  notifPermission, notifMuted, onToggleNotifications,
  footerEnabled, onToggleFooterEnabled,
  wordAnimEnabled, onToggleWordAnim,
  wordAnimStyle, onWordAnimStyleChange,
  wordAnimHold, onWordAnimHoldChange,
  currentWorkspaceId, currentWorkspace,
  workspaceMembers, presenceMap,
  drops, onPreviewDrop,
}: EditorialMobileShellProps) {
  const tc = getEditorialThemeColors(theme);

  // Tab persistence (#8): open on the last tab; reads/writes wrapped like EditorialLayout's
  // localStorage effects — a thrown storage exception must never break render.
  const [activeTab, setActiveTab] = useState<'drops' | 'create' | 'search'>('drops');

  useEffect(() => {
    try {
      const t = localStorage.getItem('dropsync_editorial_mobile_tab');
      if (t === 'drops' || t === 'create' || t === 'search') setActiveTab(t);
    } catch {}
  }, []);

  useEffect(() => {
    try { localStorage.setItem('dropsync_editorial_mobile_tab', activeTab); } catch {}
  }, [activeTab]);

  return (
    <div className={`relative flex h-[100dvh] flex-col overflow-x-hidden ${tc.bg} transition-colors duration-500`}>
      {/* Encryption initializing overlay — same markup as the desktop root (EditorialLayout.tsx:356-367) */}
      {encryptionInitializing && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 overscroll-contain">
          <div className={`${tc.cardBg} border ${tc.border} rounded-lg p-8`}>
            <div className="flex flex-col items-center gap-4">
              <div className="w-8 h-8 border-2 border-[#1a1a1a]/30 border-t-[#1a1a1a] animate-spin rounded-full" />
              <p className={`text-sm ${tc.fontClass} ${tc.text}`}>
                Setting up encryption...
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Header — no logo (#13): chat + theme + settings; the workspace pill lands with the Drops order */}
      <MobileHeader
        theme={theme}
        onCycleTheme={() => setTheme(theme === 'light' ? 'dark' : theme === 'dark' ? 'minimal' : 'light')}
        onToggleChat={onToggleChat}
        chatOpen={showChat}
        unreadCount={unreadCount}
        onOpenSettings={onOpenSettings}
      />

      {/* Active view panel — placeholders this round; real views arrive with their orders */}
      <main className="flex-1 min-h-0">
        {activeTab === 'drops' && (
          <MobileViewPlaceholder message="Drops view lands in the next order." toneClass={`${tc.muted} ${tc.fontClass}`} />
        )}
        {activeTab === 'create' && (
          <MobileViewPlaceholder message="Create view lands in a later order." toneClass={`${tc.muted} ${tc.fontClass}`} />
        )}
        {activeTab === 'search' && (
          <MobileViewPlaceholder message="Search view lands in a later order." toneClass={`${tc.muted} ${tc.fontClass}`} />
        )}
      </main>

      {/* Chat overlay — the same full-screen treatment as EditorialLayout.tsx:484-501 on non-wide widths */}
      {showChat && (
        <div className={`absolute top-0 left-0 right-0 z-40 ${tc.bg} h-[100dvh]`}>
          <EditorialChatPanel
            theme={theme}
            onClose={() => setShowChat(false)}
            onPreviewDrop={onPreviewDrop}
            workspaceId={currentWorkspaceId}
            workspaceMembers={workspaceMembers}
            chatMode={chatMode}
            onChatModeChange={setChatMode}
            drops={drops}
            ownerId={currentWorkspace?.ownerId ?? null}
            presence={presenceMap}
          />
        </div>
      )}

      {/* Settings — the real modal, unchanged (#15), props mirroring EditorialLayout.tsx:711-735 */}
      {showSettingsModal && user && (
        <EditorialSettingsModal
          user={user}
          onResetPassword={onResetPassword}
          onReauthenticate={onReauthenticate}
          onClose={() => setShowSettingsModal(false)}
          onDeleted={onSettingsClosedOrDismissed}
          onSignOut={onSettingsClosedOrDismissed}
          onNameUpdate={onNameUpdate}
          onLayoutChange={onLayoutChange}
          layoutMode={layoutMode}
          theme={theme}
          notifPermission={notifPermission}
          notifMuted={notifMuted}
          onToggleNotifications={onToggleNotifications}
          footerEnabled={footerEnabled}
          onToggleFooterEnabled={onToggleFooterEnabled}
          wordAnimEnabled={wordAnimEnabled}
          onToggleWordAnim={onToggleWordAnim}
          wordAnimStyle={wordAnimStyle}
          onWordAnimStyleChange={onWordAnimStyleChange}
          wordAnimHold={wordAnimHold}
          onWordAnimHoldChange={onWordAnimHoldChange}
        />
      )}

      {/* Bottom floating navbar (Drops · Create · Search) */}
      <MobileNavbar activeTab={activeTab} onTabChange={setActiveTab} theme={theme} />
    </div>
  );
}
