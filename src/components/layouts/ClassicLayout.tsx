'use client';

import { useRef, useState } from 'react';
import { Drop, Workspace, ExpirationOption } from '@/types';
import { Header } from '@/components/Header';
import { DropZone } from '@/components/DropZone';
import { DropList } from '@/components/DropList';
import { PreviewModal } from '@/components/PreviewModal';
import { WorkspaceSwitcher } from '@/components/WorkspaceSwitcher';
import { CreateWorkspaceModal } from '@/components/CreateWorkspaceModal';
import { JoinWorkspaceModal } from '@/components/JoinWorkspaceModal';
import { AuthModal } from '@/components/AuthModal';
import { VerifyEmailModal } from '@/components/VerifyEmailModal';
import { SettingsModal } from '@/components/SettingsModal';
import { ChatPanel } from '@/components/ChatPanel';
import { SavedPaths } from '@/components/SavedPaths';
import { TextModal } from '@/components/TextModal';
import { MoveDropModal } from '@/components/MoveDropModal';
import { moveDrop, copyDrop } from '@/lib/drops';
import { ensureCategoriesForTarget } from '@/lib/categories';

type Theme = 'light' | 'dark' | 'minimal';
type LayoutMode = 'classic' | 'editorial';

interface ThemeColors {
  isDark: boolean;
  isMinimal: boolean;
  bgColor: string;
  cardBg: string;
  borderColor: string;
  textColor: string;
  textMuted: string;
  headerBg: string;
  accentColor: string;
  dropZoneBg: string;
}

interface ClassicLayoutProps {
  theme: Theme;
  setTheme: (t: Theme) => void;
  themeColors: ThemeColors;
  user: any;
  layoutMode: LayoutMode;
  setLayoutMode: (l: LayoutMode) => void;
  showChat: boolean;
  setShowChat: (v: boolean) => void;
  onToggleChat?: () => void;
  chatMode?: 'ai' | 'group';
  setChatMode: (v: 'ai' | 'group') => void;
  unreadCount?: number;
  notifPermission?: NotificationPermission;
  notifMuted?: boolean;
  onToggleNotifications?: () => void;
  showSettingsModal: boolean;
  setShowSettingsModal: (v: boolean) => void;
  showAuthModal: boolean;
  setShowAuthModal: (v: boolean) => void;
  showVerifyModal: boolean;
  setShowVerifyModal: (v: boolean) => void;
  verifyEmail: string;
  showCreateModal: boolean;
  setShowCreateModal: (v: boolean) => void;
  showJoinModal: boolean;
  setShowJoinModal: (v: boolean) => void;
  createdWorkspace: { name: string; inviteCode: string } | null;
  setCreatedWorkspace: (v: { name: string; inviteCode: string } | null) => void;
  workspaceToDelete: Workspace | null;
  setWorkspaceToDelete: (v: Workspace | null) => void;
  workspaceToLeave: Workspace | null;
  setWorkspaceToLeave: (v: Workspace | null) => void;
  isDeletingWorkspace: boolean;
  isLeavingWorkspace: boolean;
  previewDrop: Drop | null;
  setPreviewDrop: (v: Drop | null) => void;
  previewLoading: boolean;
  setPreviewLoading: (v: boolean) => void;
  encryptionInitializing: boolean;
  workspaces: Workspace[];
  currentWorkspace: Workspace | null;
  currentWorkspaceId: string | null;
  workspaceMembers: any[];
  resolvedWorkspaceMembers: any[];
  switchWorkspace: (id: string | null) => void;
  drops: Drop[];
  dropsLoading: boolean;
  refreshDrops: () => void;
  categories: any[];
  handleCreateCategory: (name: string) => Promise<string | null>;
  handleDeleteCategory: (id: string, name: string) => void;
  handleCreateWorkspace: (name: string) => Promise<void>;
  handleJoinWorkspace: (code: string) => Promise<{ success: boolean; error?: string }>;
  handleDeleteWorkspace: () => void;
  handleLeaveWorkspace: () => void;
  handlePreview: (drop: Drop) => void;
  handleShowVerifyModal: (email: string) => void;
  handleCheckVerification: () => Promise<boolean>;
  signIn: () => Promise<void>;
  emailSignIn: (e: string, p: string) => Promise<{ error?: string; needsVerification?: boolean }>;
  signUp: (e: string, p: string) => Promise<{ error?: string; success?: boolean }>;
  resetPassword: (e: string) => Promise<{ success: boolean; error?: string }>;
  resendVerification: () => Promise<{ success: boolean; error?: string }>;
  signOutUser: () => void;
  updateDisplayName: (n: string) => void;
  reauthenticateUser: (p?: string) => Promise<{ success: boolean; error?: string }>;
  editDrop: Drop | null;
  setEditDrop: (d: Drop | null) => void;
  handleEditDrop: (drop: Drop) => void;
  handleEditSubmit: (drop: Drop, updates: { name?: string; content?: string; category?: string | null; expirationOption?: ExpirationOption; imageFile?: File | null; imageRemoved?: boolean }) => Promise<boolean>;
}

export function ClassicLayout(props: ClassicLayoutProps) {
  const {
    theme, setTheme, themeColors,
    user, layoutMode, setLayoutMode,
    showChat, setShowChat,
    onToggleChat,
    chatMode = 'ai', setChatMode,
    unreadCount = 0,
    notifPermission, notifMuted, onToggleNotifications,
    showSettingsModal, setShowSettingsModal,
    showAuthModal, setShowAuthModal,
    showVerifyModal, setShowVerifyModal,
    verifyEmail,
    showCreateModal, setShowCreateModal,
    showJoinModal, setShowJoinModal,
    createdWorkspace, setCreatedWorkspace,
    workspaceToDelete, setWorkspaceToDelete,
    workspaceToLeave, setWorkspaceToLeave,
    isDeletingWorkspace, isLeavingWorkspace,
    previewDrop, setPreviewDrop,
    previewLoading, setPreviewLoading,
    encryptionInitializing,
    workspaces, currentWorkspace, currentWorkspaceId, workspaceMembers, resolvedWorkspaceMembers,
    switchWorkspace,
    drops, dropsLoading, refreshDrops,
    categories, handleCreateCategory, handleDeleteCategory,
    handleCreateWorkspace, handleJoinWorkspace,
    handleDeleteWorkspace, handleLeaveWorkspace,
    handlePreview, handleShowVerifyModal, handleCheckVerification,
    signIn, emailSignIn, signUp, resetPassword, resendVerification,
    signOutUser, updateDisplayName, reauthenticateUser,
    editDrop, setEditDrop, handleEditDrop, handleEditSubmit,
  } = props;

  // Ref to always access the latest drops value (avoids stale closure issues)
  const dropsRef = useRef(drops);
  dropsRef.current = drops;

  // Move drop state
  const [moveDrops, setMoveDrops] = useState<Drop[] | null>(null);
  const [moveLoading, setMoveLoading] = useState(false);

  const handleMoveDrop = async (drops: Drop[], targetWorkspaceId: string | null) => {
    if (!user || !drops.length) return;
    setMoveLoading(true);
    let catMap = new Map<string, string>();
    try {
      const allCatNames = Array.from(new Set(
        drops.flatMap(d => d.categories || (d.category ? [d.category] : []))
      ));
      if (allCatNames.length > 0) {
        catMap = await ensureCategoriesForTarget(targetWorkspaceId, user.uid, allCatNames);
      }
    } catch (error) {
      console.error('Category pre-resolution failed:', error);
      setMoveLoading(false);
      alert('Failed to prepare categories. Please try again.');
      return;
    }
    const results = await Promise.all(drops.map(d => moveDrop(d, targetWorkspaceId, user.uid, catMap)));
    setMoveLoading(false);
    const failures = results.filter(r => !r.success);
    if (failures.length === 0) {
      setMoveDrops(null);
      refreshDrops();
    } else {
      alert(`${failures.length}/${drops.length} drops failed to move: ${failures[0].error}`);
    }
  };

  const handleCopyDrop = async (drops: Drop[], targetWorkspaceId: string | null) => {
    if (!user || !drops.length) return;
    setMoveLoading(true);
    let catMap = new Map<string, string>();
    try {
      const allCatNames = Array.from(new Set(
        drops.flatMap(d => d.categories || (d.category ? [d.category] : []))
      ));
      if (allCatNames.length > 0) {
        catMap = await ensureCategoriesForTarget(targetWorkspaceId, user.uid, allCatNames);
      }
    } catch (error) {
      console.error('Category pre-resolution failed:', error);
      setMoveLoading(false);
      alert('Failed to prepare categories. Please try again.');
      return;
    }
    const results = await Promise.all(drops.map(d => copyDrop(d, targetWorkspaceId, user.uid, catMap)));
    setMoveLoading(false);
    const failures = results.filter(r => !r.success);
    if (failures.length === 0) {
      setMoveDrops(null);
      refreshDrops();
    } else {
      alert(`${failures.length}/${drops.length} drops failed to copy: ${failures[0].error}`);
    }
  };

  const handleCloseCreateModal = () => {
    setShowCreateModal(false);
    setCreatedWorkspace(null);
  };

  // Handle preview drop from chat — switch workspace if needed, then open
  const handlePreviewDrop = async (dropId: string, workspaceId: string | null) => {
    if (workspaceId !== currentWorkspaceId) {
      switchWorkspace(workspaceId);
      // Wait for drops to update via Firestore listener
      await new Promise(r => setTimeout(r, 1000));
    }
    const found = dropsRef.current.find(d => d.id === dropId);
    if (found) {
      handlePreview(found);
    }
  };

  return (
    <div className={`min-h-screen ${themeColors.bgColor} transition-colors duration-500`}>
      {/* Encryption initializing overlay */}
      {encryptionInitializing && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 overscroll-contain">
          <div className={`${themeColors.cardBg} border ${themeColors.borderColor} p-8 ${theme === 'minimal' ? 'rounded-lg' : ''}`}>
            <div className="flex flex-col items-center gap-4">
              <div className="w-8 h-8 border-2 border-[#FF5A47] border-t-transparent animate-spin rounded-full" />
              <p className={`text-sm ${theme === 'minimal' ? 'font-sans tracking-wide' : 'font-mono uppercase tracking-wider'} ${themeColors.textColor}`}>
                {theme === 'minimal' ? 'Setting up encryption...' : 'INITIALIZING_ENCRYPTION...'}
              </p>
            </div>
          </div>
        </div>
      )}
      <Header theme={theme} onThemeChange={setTheme} onOpenSettings={() => setShowSettingsModal(true)} onToggleChat={onToggleChat} chatOpen={showChat} unreadCount={unreadCount}>
        <WorkspaceSwitcher
          workspaces={workspaces}
          currentWorkspace={currentWorkspace}
          currentUserId={user?.uid || null}
          onSwitch={switchWorkspace}
          onCreate={() => setShowCreateModal(true)}
          onJoin={() => setShowJoinModal(true)}
          onDelete={(workspace) => setWorkspaceToDelete(workspace)}
          onLeave={(workspace) => setWorkspaceToLeave(workspace)}
          theme={theme}
        />
      </Header>
      <main className="max-w-6xl mx-auto px-6 py-8">
        <div className="flex flex-col lg:flex-row gap-6">
          <div className="flex-1">
            <section className="mb-6">
              <DropZone
                theme={theme}
                workspaceId={currentWorkspaceId}
                workspaceMembers={workspaceMembers}
                customCategories={categories.map(c => c.name)}
                onCreateCategory={handleCreateCategory}
                editModalOpen={!!editDrop}
                mentionableDrops={drops}
              />
            </section>
            <section>
              <DropList
                drops={drops}
                loading={dropsLoading}
                onDelete={refreshDrops}
                onPreview={handlePreview}
                onEdit={handleEditDrop}
                workspaces={workspaces}
                theme={theme}
                currentUserId={user?.uid}
                categories={categories}
                onDeleteCategory={handleDeleteCategory}
                currentWorkspace={currentWorkspace}
                workspaceMembers={resolvedWorkspaceMembers}
                allDrops={drops}
              />
            </section>
          </div>

          <div className={`sticky ${theme === 'minimal' ? 'top-24' : 'top-28'} self-start w-full flex flex-col min-h-0 transition-all duration-300 ease-out ${showChat ? 'lg:w-[480px]' : 'lg:w-80'}`}>
            {showChat ? (
              <ChatPanel theme={theme} onClose={() => setShowChat(false)} onPreviewDrop={handlePreviewDrop} workspaceId={currentWorkspaceId} workspaceMembers={resolvedWorkspaceMembers} chatMode={chatMode} onChatModeChange={setChatMode} drops={drops} ownerId={currentWorkspace?.ownerId ?? null} />
            ) : (
              <div className="space-y-6">
            {/* Theme Toggle Panel */}
            <div className={`border ${themeColors.borderColor} ${themeColors.cardBg} transition-colors duration-300 ${theme === 'minimal' ? 'rounded-lg' : ''}`}>
              <div className={`border-b ${themeColors.borderColor} px-4 py-3 ${theme === 'minimal' ? 'bg-[#1A1A1A]/5' : themeColors.isDark ? 'bg-white/5' : 'bg-[#1A1A1A]'}`}>
                <h3 className={`text-[10px] ${theme === 'minimal' ? 'font-sans tracking-wide' : 'font-mono uppercase tracking-wider'} ${theme === 'minimal' ? 'text-[#1A1A1A]/70' : 'text-white'}`}>
                  {theme === 'minimal' ? 'Theme' : 'THEME/SELECT'}
                </h3>
              </div>
              <div className="p-4">
                <div className="flex gap-2">
                  {(['light', 'dark', 'minimal'] as Theme[]).map((t) => (
                    <button
                      key={t}
                      onClick={() => setTheme(t)}
                      className={`flex-1 py-2 px-3 text-xs font-medium tracking-wider transition-all ${
                        theme === t
                          ? theme === 'minimal'
                            ? 'bg-[#1A1A1A] text-white rounded-full'
                            : 'bg-[#FF5A47] text-white'
                          : theme === 'minimal'
                            ? 'text-[#1A1A1A]/50 hover:text-[#1A1A1A] rounded-full'
                            : themeColors.isDark
                              ? 'bg-white/10 text-white/60 hover:bg-white/20'
                              : 'bg-[#1A1A1A]/10 text-[#1A1A1A]/60 hover:bg-[#1A1A1A]/20'
                      }`}
                    >
                      {t.toUpperCase()}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* System Status Panel */}
            <div className={`border ${themeColors.borderColor} ${themeColors.cardBg} transition-colors duration-300 ${theme === 'minimal' ? 'rounded-lg' : ''}`}>
              <div className={`border-b ${themeColors.borderColor} px-4 py-3 ${theme === 'minimal' ? 'bg-[#1A1A1A]/5' : themeColors.isDark ? 'bg-white/5' : 'bg-[#1A1A1A]'}`}>
                <h3 className={`text-[10px] ${theme === 'minimal' ? 'font-sans tracking-wide' : 'font-mono uppercase tracking-wider'} ${theme === 'minimal' ? 'text-[#1A1A1A]/70' : 'text-white'}`}>
                  {theme === 'minimal' ? 'Status' : 'SYSTEM/STATUS'}
                </h3>
              </div>
              <div className="p-4">
                <ul className={`text-[10px] ${theme === 'minimal' ? 'font-sans tracking-wide space-y-3' : 'font-mono uppercase tracking-wider space-y-2'}`}>
                  <li className={`flex justify-between py-2 border-b ${themeColors.borderColor}`}>
                    <span className={themeColors.textMuted}>State</span>
                    <span className="flex items-center gap-2">
                      <span className="w-1.5 h-1.5 bg-[#FF5A47] rounded-full" />
                      <span className={themeColors.textColor}>Online</span>
                    </span>
                  </li>
                  <li className={`flex justify-between py-2 border-b ${themeColors.borderColor}`}>
                    <span className={themeColors.textMuted}>Active</span>
                    <span className={themeColors.textColor}>{drops.length}</span>
                  </li>
                  <li className={`flex justify-between py-2 border-b ${themeColors.borderColor}`}>
                    <span className={themeColors.textMuted}>Encryption</span>
                    <span className="flex items-center gap-2">
                      <span className="w-1.5 h-1.5 bg-green-500 rounded-full" />
                      <span className={themeColors.textColor}>{encryptionInitializing ? 'Setting up...' : 'Active'}</span>
                    </span>
                  </li>
                  <li className={`flex justify-between py-2`}>
                    <span className={themeColors.textMuted}>Session</span>
                    <span className={themeColors.accentColor}>Active</span>
                  </li>
                </ul>
              </div>
            </div>

            {/* Saved Paths */}
            <SavedPaths theme={theme} />
              </div>
            )}
          </div>
        </div>
      </main>

      {previewDrop && (
        <PreviewModal
          drop={previewDrop}
          onClose={() => {
            setPreviewDrop(null);
            setPreviewLoading(false);
          }}
          theme={theme}
          isLoading={previewLoading}
          onEdit={handleEditDrop}
          onMove={(drop) => {
            setPreviewDrop(null);
            const originalDrop = drops.find(d => d.id === drop.id) || drop;
            setMoveDrops([originalDrop]);
          }}
          allDrops={drops}
          onPreview={handlePreview}
        />
      )}

      {/* Move Drop Modal */}
      {moveDrops && (
        <MoveDropModal
          drops={moveDrops}
          workspaces={workspaces}
          currentWorkspaceId={currentWorkspaceId}
          onMove={handleMoveDrop}
          onCopy={handleCopyDrop}
          onClose={() => setMoveDrops(null)}
          theme={theme}
        />
      )}

      {/* Edit Text Modal */}
      {editDrop && (
        <TextModal
          onSubmit={async () => {}}
          onClose={() => setEditDrop(null)}
          theme={theme}
          customCategories={categories.map(c => c.name)}
          onCreateCategory={undefined}
          editDrop={editDrop}
          onEdit={handleEditSubmit}
          currentUserId={user?.uid}
          mentionableDrops={drops}
        />
      )}

      {/* Workspace Modals */}
      {showCreateModal && (
        <CreateWorkspaceModal
          onSubmit={handleCreateWorkspace}
          onClose={handleCloseCreateModal}
          createdWorkspace={createdWorkspace}
          theme={theme}
        />
      )}

      {showJoinModal && (
        <JoinWorkspaceModal
          onSubmit={handleJoinWorkspace}
          onClose={() => setShowJoinModal(false)}
          theme={theme}
        />
      )}

      {/* Delete Workspace Confirmation Modal */}
      {workspaceToDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center overscroll-contain">
          <div className="fixed inset-0 bg-black/50" onClick={() => !isDeletingWorkspace && setWorkspaceToDelete(null)} />
          <div className={`relative z-10 w-80 border ${theme === 'dark' ? 'bg-[#1A1A1A] border-white/10' : theme === 'minimal' ? 'bg-[#D4D8C8] border-[#1A1A1A]/20 rounded-lg' : 'bg-white border-[#1A1A1A]'}`}>
            <div className={`px-4 py-3 border-b ${theme === 'dark' ? 'border-white/10' : theme === 'minimal' ? 'border-[#1A1A1A]/20' : 'border-[#1A1A1A]'} flex items-center justify-between ${theme === 'minimal' ? 'bg-[#1A1A1A]/5' : 'bg-[#FF5A47]'}`}>
              <h3 className={`font-bold text-white ${theme === 'minimal' ? 'font-sans tracking-wide text-xs' : 'font-mono uppercase tracking-wider text-[10px]'}`}>
                {theme === 'minimal' ? 'Delete workspace' : 'DELETE_WORKSPACE'}
              </h3>
              <button onClick={() => !isDeletingWorkspace && setWorkspaceToDelete(null)} className="text-white/70 hover:text-white transition-colors disabled:opacity-50" disabled={isDeletingWorkspace}>
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="p-4">
              <p className={`text-sm mb-4 ${theme === 'dark' ? 'text-white/80' : 'text-[#1A1A1A]/80'}`}>
                {theme === 'minimal'
                  ? `Are you sure you want to delete "${workspaceToDelete.name}"? This cannot be undone.`
                  : `ARE_YOU_SURE_YOU_WANT_TO_DELETE "${workspaceToDelete.name}"? THIS_ACTION_CANNOT_BE_UNDONE.`
                }
              </p>
              <div className="flex gap-2">
                <button
                  onClick={() => setWorkspaceToDelete(null)}
                  disabled={isDeletingWorkspace}
                  className={`flex-1 px-4 py-2 ${theme === 'dark' ? 'bg-white/10 hover:bg-white/20 text-white' : theme === 'minimal' ? 'bg-[#1A1A1A]/10 hover:bg-[#1A1A1A]/20 text-[#1A1A1A] rounded-lg' : 'bg-[#1A1A1A]/10 hover:bg-[#1A1A1A]/20 text-[#1A1A1A]'} transition-colors ${theme === 'minimal' ? 'font-sans tracking-wide text-xs' : 'font-mono uppercase tracking-wider text-[10px]'} disabled:opacity-50 disabled:cursor-not-allowed`}
                >
                  {theme === 'minimal' ? 'Cancel' : 'CANCEL'}
                </button>
                <button
                  onClick={handleDeleteWorkspace}
                  disabled={isDeletingWorkspace}
                  className={`flex-1 px-4 py-2 bg-red-500 hover:bg-red-600 text-white transition-colors ${theme === 'minimal' ? 'rounded-lg font-sans tracking-wide text-xs' : 'font-mono uppercase tracking-wider text-[10px]'} flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed`}
                >
                  {isDeletingWorkspace ? (
                    <>
                      <div className={`w-4 h-4 border-2 border-white border-t-transparent animate-spin ${theme === 'minimal' ? 'rounded-full' : ''}`} />
                      {theme === 'minimal' ? 'Deleting...' : 'DELETING...'}
                    </>
                  ) : (
                    theme === 'minimal' ? 'Delete' : 'DELETE'
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Leave Workspace Confirmation Modal */}
      {workspaceToLeave && (
        <div className="fixed inset-0 z-50 flex items-center justify-center overscroll-contain">
          <div className="fixed inset-0 bg-black/50" onClick={() => !isLeavingWorkspace && setWorkspaceToLeave(null)} />
          <div className={`relative z-10 w-80 border ${theme === 'dark' ? 'bg-[#1A1A1A] border-white/10' : theme === 'minimal' ? 'bg-[#D4D8C8] border-[#1A1A1A]/20 rounded-lg' : 'bg-white border-[#1A1A1A]'}`}>
            <div className={`px-4 py-3 border-b ${theme === 'dark' ? 'border-white/10' : theme === 'minimal' ? 'border-[#1A1A1A]/20' : 'border-[#1A1A1A]'} flex items-center justify-between ${theme === 'minimal' ? 'bg-[#1A1A1A]/5' : 'bg-[#FF5A47]'}`}>
              <h3 className={`font-bold text-white ${theme === 'minimal' ? 'font-sans tracking-wide text-xs' : 'font-mono uppercase tracking-wider text-[10px]'}`}>
                {theme === 'minimal' ? 'Leave workspace' : 'LEAVE_WORKSPACE'}
              </h3>
              <button onClick={() => !isLeavingWorkspace && setWorkspaceToLeave(null)} className="text-white/70 hover:text-white transition-colors disabled:opacity-50" disabled={isLeavingWorkspace}>
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="p-4">
              <p className={`text-sm mb-4 ${theme === 'dark' ? 'text-white/80' : 'text-[#1A1A1A]/80'}`}>
                {theme === 'minimal'
                  ? `Are you sure you want to leave "${workspaceToLeave.name}"?`
                  : `ARE_YOU_SURE_YOU_WANT_TO_LEAVE "${workspaceToLeave.name}"?`
                }
              </p>
              <div className="flex gap-2">
                <button
                  onClick={() => setWorkspaceToLeave(null)}
                  disabled={isLeavingWorkspace}
                  className={`flex-1 px-4 py-2 ${theme === 'dark' ? 'bg-white/10 hover:bg-white/20 text-white' : theme === 'minimal' ? 'bg-[#1A1A1A]/10 hover:bg-[#1A1A1A]/20 text-[#1A1A1A] rounded-lg' : 'bg-[#1A1A1A]/10 hover:bg-[#1A1A1A]/20 text-[#1A1A1A]'} transition-colors ${theme === 'minimal' ? 'font-sans tracking-wide text-xs' : 'font-mono uppercase tracking-wider text-[10px]'} disabled:opacity-50 disabled:cursor-not-allowed`}
                >
                  {theme === 'minimal' ? 'Cancel' : 'CANCEL'}
                </button>
                <button
                  onClick={handleLeaveWorkspace}
                  disabled={isLeavingWorkspace}
                  className={`flex-1 px-4 py-2 ${theme === 'dark' ? 'bg-[#FF5A47] hover:bg-[#E54A37]' : theme === 'minimal' ? 'bg-[#1A1A1A] hover:bg-[#333] rounded-lg' : 'bg-[#FF5A47] hover:bg-[#E54A37]'} text-white transition-colors ${theme === 'minimal' ? 'font-sans tracking-wide text-xs' : 'font-mono uppercase tracking-wider text-[10px]'} flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed`}
                >
                  {isLeavingWorkspace ? (
                    <>
                      <div className={`w-4 h-4 border-2 border-white border-t-transparent animate-spin ${theme === 'minimal' ? 'rounded-full' : ''}`} />
                      {theme === 'minimal' ? 'Leaving...' : 'LEAVING...'}
                    </>
                  ) : (
                    theme === 'minimal' ? 'Leave' : 'LEAVE'
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Auth Modal */}
      {showAuthModal && (
        <AuthModal
          onSignIn={emailSignIn}
          onSignUp={signUp}
          onResetPassword={resetPassword}
          onGoogleSignIn={signIn}
          onShowVerifyModal={handleShowVerifyModal}
          onClose={() => setShowAuthModal(false)}
          theme={theme}
        />
      )}

      {/* Verify Email Modal */}
      {showVerifyModal && (
        <VerifyEmailModal
          email={verifyEmail}
          onResendVerification={resendVerification}
          onCheckVerification={handleCheckVerification}
          onClose={() => setShowVerifyModal(false)}
          theme={theme}
        />
      )}

      {/* Settings Modal */}
      {showSettingsModal && user && (
        <SettingsModal
          user={user}
          onResetPassword={resetPassword}
          onReauthenticate={reauthenticateUser}
          onClose={() => setShowSettingsModal(false)}
          onDeleted={() => {
            setShowSettingsModal(false);
            signOutUser();
          }}
          onNameUpdate={updateDisplayName}
          onLayoutChange={setLayoutMode}
          layoutMode={layoutMode}
          theme={theme}
          notifPermission={notifPermission}
          notifMuted={notifMuted}
          onToggleNotifications={onToggleNotifications}
        />
      )}
    </div>
  );
}
