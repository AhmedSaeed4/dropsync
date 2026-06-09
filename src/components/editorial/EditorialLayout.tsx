'use client';

import { useRef, useState } from 'react';
import { Drop, Workspace, ExpirationOption } from '@/types';
import { EditorialPreviewModal } from './EditorialPreviewModal';
import { EditorialCreateWorkspaceModal } from './EditorialCreateWorkspaceModal';
import { EditorialJoinWorkspaceModal } from './EditorialJoinWorkspaceModal';
import { EditorialAuthModal } from './EditorialAuthModal';
import { EditorialVerifyEmailModal } from './EditorialVerifyEmailModal';
import { EditorialSettingsModal } from './EditorialSettingsModal';
import { EditorialHeader } from './EditorialHeader';
import { EditorialDropZone } from './EditorialDropZone';
import { EditorialDropList } from './EditorialDropList';
import { EditorialChatPanel } from './EditorialChatPanel';
import { EditorialStatusPanel } from './EditorialStatusPanel';
import { EditorialThemeSelector } from './EditorialThemeSelector';
import { EditorialSavedPaths } from './EditorialSavedPaths';
import { getEditorialThemeColors } from './editorialTheme';
import { EditorialTextModal } from './EditorialTextModal';
import { EditorialMoveDropModal } from './EditorialMoveDropModal';
import { moveDrop } from '@/lib/drops';

type Theme = 'light' | 'dark' | 'minimal';
type LayoutMode = 'classic' | 'editorial';

interface EditorialLayoutProps {
  theme: Theme;
  setTheme: (t: Theme) => void;
  themeColors: {
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
  };
  user: any;
  layoutMode: LayoutMode;
  setLayoutMode: (l: LayoutMode) => void;
  showChat: boolean;
  setShowChat: (v: boolean) => void;
  chatMode?: 'ai' | 'group';
  setChatMode: (v: 'ai' | 'group') => void;
  unreadCount?: number;
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

export function EditorialLayout(props: EditorialLayoutProps) {
  const {
    theme, setTheme, themeColors,
    user, layoutMode, setLayoutMode,
    showChat, setShowChat,
    chatMode = 'ai', setChatMode,
    unreadCount = 0,
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
    const results = await Promise.all(drops.map(d => moveDrop(d, targetWorkspaceId, user.uid)));
    setMoveLoading(false);
    const failures = results.filter(r => !r.success);
    if (failures.length === 0) {
      setMoveDrops(null);
      refreshDrops();
    } else {
      alert(`${failures.length}/${drops.length} drops failed to move: ${failures[0].error}`);
    }
  };

  const tc = getEditorialThemeColors(theme);

  const handleCloseCreateModal = () => {
    setShowCreateModal(false);
    setCreatedWorkspace(null);
  };

  // Handle preview drop from chat — switch workspace if needed, then open
  const handlePreviewDrop = async (dropId: string, workspaceId: string | null) => {
    if (workspaceId !== currentWorkspaceId) {
      switchWorkspace(workspaceId);
      await new Promise(r => setTimeout(r, 1000));
    }
    const found = dropsRef.current.find(d => d.id === dropId);
    if (found) {
      handlePreview(found);
    }
  };

  return (
    <div className={`min-h-screen ${tc.bg} transition-colors duration-500`}>
      {/* Encryption initializing overlay */}
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

      {/* Header */}
      <EditorialHeader
        theme={theme}
        onThemeChange={setTheme}
        onOpenSettings={() => setShowSettingsModal(true)}
        onToggleChat={() => { if (!showChat && unreadCount > 0) setChatMode('group'); setShowChat(!showChat); }}
        chatOpen={showChat}
        unreadCount={unreadCount}
        user={user}
        onSignOut={signOutUser}
        workspaces={workspaces}
        currentWorkspace={currentWorkspace}
        currentUserId={user?.uid || null}
        onSwitch={switchWorkspace}
        onCreate={() => setShowCreateModal(true)}
        onJoin={() => setShowJoinModal(true)}
        onDelete={(ws) => setWorkspaceToDelete(ws)}
        onLeave={(ws) => setWorkspaceToLeave(ws)}
      />

      {/* Main content - responsive: stacked on mobile, side-by-side on desktop */}
      <main className={`flex flex-col lg:flex-row py-6 lg:py-[45px] transition-all duration-[350ms] ease-[cubic-bezier(0.4,0,0.2,1)] px-4 sm:px-6 ${showChat ? 'lg:px-[80px] lg:gap-8' : 'lg:px-[80px] lg:gap-[60px]'} gap-6`} style={{ minHeight: 'calc(100vh - 65px)' }}>
        {/* Left column: DropZone + Status + Theme */}
        <div className={`lg:border-r ${tc.border} overflow-y-auto transition-all duration-[350ms] ease-[cubic-bezier(0.4,0,0.2,1)] lg:pr-5 w-full min-w-0 ${showChat ? 'lg:flex-[1.2_0_0px] lg:pl-1.5' : 'lg:flex-1 lg:pl-11'}`}>
          <div className="space-y-6">
            <EditorialDropZone
              theme={theme}
              workspaceId={currentWorkspaceId}
              workspaceMembers={workspaceMembers}
              customCategories={categories.map(c => c.name)}
              onCreateCategory={handleCreateCategory}
              showChat={showChat}
              editModalOpen={!!editDrop}
              onToggleChat={() => { if (!showChat && unreadCount > 0) setChatMode('group'); setShowChat(!showChat); }}
              unreadCount={unreadCount}
            />

            <EditorialStatusPanel
              dropsCount={drops.length}
              encryptionInitializing={encryptionInitializing}
              theme={theme}
              showChat={showChat}
            />
            <EditorialThemeSelector
              theme={theme}
              onThemeChange={setTheme}
              showChat={showChat}
            />
            <div className="hidden md:block">
              <EditorialSavedPaths theme={theme} showChat={showChat} />
            </div>
          </div>
        </div>

        {/* Right column: Drops + Saved Paths */}
        <div className={`shrink-0 overflow-y-auto transition-all duration-[350ms] ease-[cubic-bezier(0.4,0,0.2,1)] w-full ${showChat ? 'lg:w-[480px] lg:min-w-[480px]' : 'lg:w-[520px] lg:min-w-[520px]'}`}>
          <div>
            <EditorialDropList
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
              showChat={showChat}
              currentWorkspace={currentWorkspace}
              workspaceMembers={resolvedWorkspaceMembers}
            />
          </div>
        </div>

        {/* Chat panel: full screen overlay on mobile, slides in as third column on desktop */}
        <div className={`${showChat ? 'fixed inset-0 z-40 lg:static lg:inset-auto lg:z-auto lg:h-[calc(100vh-160px)]' : 'hidden lg:block lg:w-0 lg:opacity-0 lg:translate-x-[30px]'} lg:shrink-0 lg:relative overflow-hidden transition-all duration-[350ms] ease-[cubic-bezier(0.4,0,0.2,1)] ${showChat ? 'lg:w-[420px] lg:opacity-100 lg:translate-x-0 lg:pl-0' : ''}`}>
          {showChat && (
            <EditorialChatPanel
              theme={theme}
              onClose={() => setShowChat(false)}
              onPreviewDrop={handlePreviewDrop}
              workspaceId={currentWorkspaceId}
              workspaceMembers={resolvedWorkspaceMembers}
              chatMode={chatMode}
              onChatModeChange={setChatMode}
            />
          )}
        </div>
      </main>

      {/* Preview Modal */}
      {previewDrop && (
        <EditorialPreviewModal
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
        />
      )}

      {/* Move Drop Modal */}
      {moveDrops && (
        <EditorialMoveDropModal
          drops={moveDrops}
          workspaces={workspaces}
          currentWorkspaceId={currentWorkspaceId}
          onMove={handleMoveDrop}
          onClose={() => setMoveDrops(null)}
          theme={theme}
        />
      )}

      {/* Edit Text Modal */}
      {editDrop && (
        <EditorialTextModal
          onSubmit={async () => {}}
          onClose={() => setEditDrop(null)}
          theme={theme}
          customCategories={categories.map(c => c.name)}
          onCreateCategory={undefined}
          editDrop={editDrop}
          onEdit={handleEditSubmit}
          currentUserId={user?.uid}
        />
      )}

      {/* Workspace Modals */}
      {showCreateModal && (
        <EditorialCreateWorkspaceModal
          onCreate={handleCreateWorkspace}
          onClose={handleCloseCreateModal}
          theme={theme}
        />
      )}

      {showJoinModal && (
        <EditorialJoinWorkspaceModal
          onJoin={handleJoinWorkspace}
          onClose={() => setShowJoinModal(false)}
          theme={theme}
        />
      )}

      {/* Delete Workspace Confirmation Modal */}
      {workspaceToDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center overscroll-contain">
          <div className="fixed inset-0 bg-black/50" onClick={() => !isDeletingWorkspace && setWorkspaceToDelete(null)} />
          <div className={`relative z-10 w-96 border ${tc.border} ${tc.cardBg} rounded-lg overflow-hidden`}>
            <div className={`px-5 py-4 border-b ${tc.border}`}>
              <h3 className={`text-sm font-medium ${tc.fontClass} ${tc.text}`}>
                Delete workspace
              </h3>
            </div>
            <div className="p-5">
              <p className={`text-sm mb-5 ${tc.fontClass} ${tc.muted}`}>
                Are you sure you want to delete &ldquo;{workspaceToDelete.name}&rdquo;? This cannot be undone.
              </p>
              <div className="flex gap-3">
                <button
                  onClick={() => setWorkspaceToDelete(null)}
                  disabled={isDeletingWorkspace}
                  className={`flex-1 px-4 py-2.5 text-sm ${tc.fontClass} border ${tc.border} rounded-lg ${tc.text} hover:bg-[#1a1a1a] hover:text-white transition-colors disabled:opacity-50`}
                >
                  Cancel
                </button>
                <button
                  onClick={handleDeleteWorkspace}
                  disabled={isDeletingWorkspace}
                  className={`flex-1 px-4 py-2.5 text-sm ${tc.fontClass} bg-red-500 hover:bg-red-600 text-white rounded-lg transition-colors flex items-center justify-center gap-2 disabled:opacity-50`}
                >
                  {isDeletingWorkspace ? (
                    <>
                      <div className="w-4 h-4 border-2 border-white border-t-transparent animate-spin rounded-full" />
                      Deleting...
                    </>
                  ) : (
                    'Delete'
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
          <div className={`relative z-10 w-96 border ${tc.border} ${tc.cardBg} rounded-lg overflow-hidden`}>
            <div className={`px-5 py-4 border-b ${tc.border}`}>
              <h3 className={`text-sm font-medium ${tc.fontClass} ${tc.text}`}>
                Leave workspace
              </h3>
            </div>
            <div className="p-5">
              <p className={`text-sm mb-5 ${tc.fontClass} ${tc.muted}`}>
                Are you sure you want to leave &ldquo;{workspaceToLeave.name}&rdquo;?
              </p>
              <div className="flex gap-3">
                <button
                  onClick={() => setWorkspaceToLeave(null)}
                  disabled={isLeavingWorkspace}
                  className={`flex-1 px-4 py-2.5 text-sm ${tc.fontClass} border ${tc.border} rounded-lg ${tc.text} hover:bg-[#1a1a1a] hover:text-white transition-colors disabled:opacity-50`}
                >
                  Cancel
                </button>
                <button
                  onClick={handleLeaveWorkspace}
                  disabled={isLeavingWorkspace}
                  className={`flex-1 px-4 py-2.5 text-sm ${tc.fontClass} bg-[#1a1a1a] hover:bg-[#333] text-white rounded-lg transition-colors flex items-center justify-center gap-2 disabled:opacity-50`}
                >
                  {isLeavingWorkspace ? (
                    <>
                      <div className="w-4 h-4 border-2 border-white border-t-transparent animate-spin rounded-full" />
                      Leaving...
                    </>
                  ) : (
                    'Leave'
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Auth Modal */}
      {showAuthModal && (
        <EditorialAuthModal
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
        <EditorialVerifyEmailModal
          email={verifyEmail}
          onResend={resendVerification}
          onClose={() => setShowVerifyModal(false)}
          theme={theme}
        />
      )}

      {/* Settings Modal */}
      {showSettingsModal && user && (
        <EditorialSettingsModal
          user={user}
          onResetPassword={resetPassword}
          onReauthenticate={reauthenticateUser}
          onClose={() => setShowSettingsModal(false)}
          onDeleted={() => { setShowSettingsModal(false); signOutUser(); }}
          onSignOut={() => { setShowSettingsModal(false); signOutUser(); }}
          onNameUpdate={updateDisplayName}
          onLayoutChange={setLayoutMode}
          layoutMode={layoutMode}
          theme={theme}
        />
      )}
    </div>
  );
}
