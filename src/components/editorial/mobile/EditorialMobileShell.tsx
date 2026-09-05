'use client';

import { useState, useEffect } from 'react';
import { Drop, Workspace, Category, ExpirationOption } from '@/types';
import { getEditorialThemeColors } from '../editorialTheme';
import { EditorialChatPanel } from '../EditorialChatPanel';
import { EditorialSettingsModal } from '../EditorialSettingsModal';
import { EditorialPreviewModal } from '../EditorialPreviewModal';
import { EditorialTextModal } from '../EditorialTextModal';
import { EditorialMoveDropModal } from '../EditorialMoveDropModal';
import { EditorialCreateWorkspaceModal } from '../EditorialCreateWorkspaceModal';
import { EditorialJoinWorkspaceModal } from '../EditorialJoinWorkspaceModal';
import WorkspaceOptionsModal from '@/components/WorkspaceOptionsModal';
import { retractFooterIfUp } from '../../SmoothScrollProvider';
import type { DropSortMode } from '@/lib/auth';
import type { MemberInfo } from '@/lib/workspaces';
import { MobileHeader } from './MobileHeader';
import { MobileNavbar } from './MobileNavbar';
import { MobileDropsView } from './MobileDropsView';

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
  // ---- Order 2: Drops view + shared modals (types mirrored from EditorialLayoutProps) ----
  dropsLoading: boolean;
  refreshDrops: () => void;
  categories: Category[];
  onCreateCategory: (name: string) => Promise<string | null>;
  onDeleteCategory: (categoryId: string, categoryName: string) => void;
  workspaces: Workspace[];
  onSwitchWorkspace: (workspaceId: string | null) => void;
  mentionedWorkspaceIds: Set<string>;
  showCreateModal: boolean;
  setShowCreateModal: (v: boolean) => void;
  createdWorkspace: { name: string; inviteCode: string } | null;
  setCreatedWorkspace: (v: { name: string; inviteCode: string } | null) => void;
  showJoinModal: boolean;
  setShowJoinModal: (v: boolean) => void;
  workspaceToDelete: Workspace | null;
  setWorkspaceToDelete: (v: Workspace | null) => void;
  workspaceToLeave: Workspace | null;
  setWorkspaceToLeave: (v: Workspace | null) => void;
  isDeletingWorkspace: boolean;
  isLeavingWorkspace: boolean;
  isKicking: boolean;
  onKick: (memberUid: string) => void;
  onDeleteWorkspace: () => void;
  onLeaveWorkspace: () => void;
  onLeaveAndTransfer: (newOwnerId: string) => void;
  onOpenPersonalOptions?: () => void;
  onImportWorkspace?: () => void;
  // FLAG (not in §4.1's list, but §4.2 mandates the Create/Join modals :671-685 whose props are
  // these handlers — both already exist in EditorialLayout): added as two extra gate prop lines.
  onCreateWorkspace: (name: string) => Promise<void>;
  onJoinWorkspace: (code: string) => Promise<{ success: boolean; error?: string }>;
  previewDrop: Drop | null;
  setPreviewDrop: (v: Drop | null) => void;
  previewLoading: boolean;
  setPreviewLoading: (v: boolean) => void;
  onOpenRootDrop: (drop: Drop) => void;
  onPreview: (drop: Drop) => void;
  onOpenMentionedDrop: (drop: Drop) => void;
  onClosePreview: () => void;
  onPreviewBack: () => void;
  clearPreviewTrail: () => void;
  dropTrailLength: number;
  onPreviewInvalidate: () => void;
  editPreparing: boolean;
  editDrop: Drop | null;
  onEditDrop: (drop: Drop) => void;
  onEditSubmit: (drop: Drop, updates: { name?: string; content?: string; category?: string | null; categories?: string[]; expirationOption?: ExpirationOption; imageFile?: File | null; imageRemoved?: boolean; locked?: boolean; imagePreviewData?: string; reminderAt?: Date | null; reminderSetByUid?: string | null; reminderDismissedBy?: string | null }) => Promise<boolean>;
  onEditClose: () => void;
  onMoveDrops: (drops: Drop[], targetWorkspaceId: string | null) => Promise<void>;
  onCopyDrops: (drops: Drop[], targetWorkspaceId: string | null) => Promise<void>;
  onSortModeChange?: (mode: DropSortMode, spaceKey: string) => void;
  onExportWorkspace?: () => void;
  onExportPersonal?: () => void;
  youtubeBackfillVisible: boolean;
  onOpenYoutubeBackfill: () => void;
  onJoinCall: (drop: Drop) => void;
  isReopenCallId?: string;
  hoverable: boolean;
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
  dropsLoading, refreshDrops,
  categories, onCreateCategory, onDeleteCategory,
  workspaces, onSwitchWorkspace, mentionedWorkspaceIds,
  showCreateModal, setShowCreateModal,
  createdWorkspace, setCreatedWorkspace,
  showJoinModal, setShowJoinModal,
  workspaceToDelete, setWorkspaceToDelete,
  workspaceToLeave, setWorkspaceToLeave,
  isDeletingWorkspace, isLeavingWorkspace, isKicking, onKick,
  onDeleteWorkspace, onLeaveWorkspace, onLeaveAndTransfer,
  onOpenPersonalOptions, onImportWorkspace,
  onCreateWorkspace, onJoinWorkspace,
  previewDrop, setPreviewDrop, previewLoading, setPreviewLoading,
  onOpenRootDrop, onPreview, onOpenMentionedDrop,
  onClosePreview, onPreviewBack, clearPreviewTrail, dropTrailLength,
  onPreviewInvalidate,
  editPreparing, editDrop, onEditDrop, onEditSubmit, onEditClose,
  onMoveDrops, onCopyDrops,
  onSortModeChange, onExportWorkspace, onExportPersonal,
  youtubeBackfillVisible, onOpenYoutubeBackfill,
  onJoinCall, isReopenCallId, hoverable,
}: EditorialMobileShellProps) {
  const tc = getEditorialThemeColors(theme);

  // Move-modal memory (mirrors EditorialLayout :213 + :246): the selected drops the modal edits,
  // and — when the modal opened from the preview — the drop to re-open on close/copy.
  const [moveDrops, setMoveDrops] = useState<Drop[] | null>(null);
  const [moveReturnDrop, setMoveReturnDrop] = useState<Drop | null>(null);

  // Tab persistence (#8): open on the last tab; reads/writes wrapped like EditorialLayout's
  // localStorage effects — a thrown storage exception must never break render.
  const [activeTab, setActiveTab] = useState<'drops' | 'create' | 'search'>('drops');

  // Mirror of the Drops view's selection mode — slides the navbar away while selecting
  // (OWNER REQUEST #2). Resets on tab switch so leaving Drops mid-selection can never leave
  // the navbar hidden on another tab.
  const [dropsSelecting, setDropsSelecting] = useState(false);

  useEffect(() => {
    setDropsSelecting(false);
  }, [activeTab]);

  // OWNER REQUEST #3: header controls (chat / settings / theme) live here, above the Drops
  // view — bumping this counter asks the view to cancel an open selection, exactly like its
  // Cancel button. The view watches the `deselectSignal` prop.
  const [deselectSignal, setDeselectSignal] = useState(0);
  const cancelDropsSelection = () => setDeselectSignal((n) => n + 1);

  useEffect(() => {
    try {
      const t = localStorage.getItem('dropsync_editorial_mobile_tab');
      if (t === 'drops' || t === 'create' || t === 'search') setActiveTab(t);
    } catch {}
  }, []);

  useEffect(() => {
    try { localStorage.setItem('dropsync_editorial_mobile_tab', activeTab); } catch {}
  }, [activeTab]);

  // Re-open the preview with the drop the user was viewing before Move (returnToPreview port,
  // EditorialLayout :261-269).
  const returnToPreview = (returnDrop: Drop) => {
    if (previewDrop) return; // defensive: already back
    if (returnDrop.encrypted) {
      onPreview(returnDrop);
    } else {
      setPreviewDrop(returnDrop);
      setPreviewLoading(false);
    }
  };

  // X / backdrop / Cancel close (EditorialLayout :274-280): preview-originated → re-open the
  // preview; bulk flow → straight back to the list.
  const handleCloseMoveModal = () => {
    const returnDrop = moveReturnDrop;
    setMoveDrops(null);
    setMoveReturnDrop(null);
    if (returnDrop) returnToPreview(returnDrop);
  };

  // Completion wrappers: the layout's handlers own categories/refresh/alerts; the shell owns
  // closing its own modal. MOVE — the drop left this workspace, so no preview return (layout
  // :303-309). COPY — the original still exists, so return to its preview (:337-342).
  const handleMoveComplete = async (selDrops: Drop[], targetWorkspaceId: string | null) => {
    await onMoveDrops(selDrops, targetWorkspaceId);
    setMoveDrops(null);
    setMoveReturnDrop(null);
  };
  const handleCopyComplete = async (selDrops: Drop[], targetWorkspaceId: string | null) => {
    const returnDrop = moveReturnDrop;
    await onCopyDrops(selDrops, targetWorkspaceId);
    setMoveDrops(null);
    setMoveReturnDrop(null);
    if (returnDrop) returnToPreview(returnDrop);
  };

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

      {/* Header — no logo (#13): workspace pill on the left (Drops), chat/theme/settings right */}
      <MobileHeader
        theme={theme}
        onCycleTheme={() => {
          cancelDropsSelection();
          setTheme(theme === 'light' ? 'dark' : theme === 'dark' ? 'minimal' : 'light');
        }}
        onToggleChat={() => {
          cancelDropsSelection();
          onToggleChat?.();
        }}
        chatOpen={showChat}
        unreadCount={unreadCount}
        onOpenSettings={() => {
          cancelDropsSelection();
          onOpenSettings();
        }}
        activeTab={activeTab}
        workspaceNav={{
          workspaces,
          currentWorkspace,
          currentUserId: user?.uid ?? null,
          onSwitch: onSwitchWorkspace,
          onCreate: () => { retractFooterIfUp(); setShowCreateModal(true); },
          onJoin: () => { retractFooterIfUp(); setShowJoinModal(true); },
          onDelete: (ws) => { retractFooterIfUp(); setWorkspaceToDelete(ws); },
          onLeave: (ws) => { retractFooterIfUp(); setWorkspaceToLeave(ws); },
          onPersonalOptions: onOpenPersonalOptions,
          mentionedWorkspaceIds,
        }}
      />

      {/* Active view panel — Drops is real (Order 2); Create/Search wait for their orders */}
      <main className="flex-1 min-h-0">
        {activeTab === 'drops' && (
          <MobileDropsView
            theme={theme}
            currentUserId={user?.uid ?? null}
            currentWorkspace={currentWorkspace}
            currentWorkspaceId={currentWorkspaceId}
            drops={drops}
            dropsLoading={dropsLoading}
            refreshDrops={refreshDrops}
            categories={categories}
            onDeleteCategory={onDeleteCategory}
            workspaceMembers={workspaceMembers}
            encryptionInitializing={encryptionInitializing}
            wordAnimEnabled={wordAnimEnabled}
            wordAnimStyle={wordAnimStyle}
            wordAnimHold={wordAnimHold}
            youtubeBackfillVisible={youtubeBackfillVisible}
            onOpenYoutubeBackfill={onOpenYoutubeBackfill}
            onExportWorkspace={onExportWorkspace}
            onExportPersonal={onExportPersonal}
            onSortModeChange={onSortModeChange}
            onJoinCall={onJoinCall}
            isReopenCallId={isReopenCallId}
            hoverable={hoverable}
            onPreview={onOpenRootDrop}
            onEditDrop={onEditDrop}
            onOpenMoveModal={setMoveDrops}
            onSelectionModeChange={setDropsSelecting}
            deselectSignal={deselectSignal}
          />
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

      {/* ---- Shared overlays, mirrored from EditorialLayout :564-745 ---- */}

      {/* Preview Modal (:564-606, incl. the onMove hand-off into the move modal) */}
      {previewDrop && (
        <EditorialPreviewModal
          drop={previewDrop}
          canMutate={!!user && (user.uid === previewDrop.userId || (!!currentWorkspace && user.uid === currentWorkspace.ownerId))}
          onClose={onClosePreview}
          onBack={onPreviewBack}
          canBack={dropTrailLength > 0}
          theme={theme}
          isLoading={previewLoading}
          onEdit={onEditDrop}
          editPreparing={editPreparing}
          onMove={(drop) => {
            clearPreviewTrail();
            setPreviewDrop(null);
            setPreviewLoading(false);
            onPreviewInvalidate(); // a late preview decrypt must not resurrect behind the modal
            setMoveReturnDrop(drop); // use the freshest version the user was viewing
            // Decrypted file previews intentionally have encrypted=false at runtime. Keep the raw
            // file record for Move/Copy's encryption decision, with fresh editable metadata from
            // the preview (EditorialLayout :585-599).
            const persistedFile = drop.type === 'file' ? drops.find(d => d.id === drop.id) : null;
            const operationDrop = persistedFile
              ? {
                  ...persistedFile,
                  name: drop.name,
                  expiresAt: drop.expiresAt,
                  expirationOption: drop.expirationOption,
                  category: drop.category,
                  categories: drop.categories,
                  locked: drop.locked,
                  reminderAt: drop.reminderAt,
                  reminderSetByUid: drop.reminderSetByUid,
                  reminderDismissedBy: drop.reminderDismissedBy,
                }
              : drop;
            setMoveDrops([operationDrop]);
          }}
          allDrops={drops}
          onPreview={onOpenMentionedDrop}
          currentUserId={user?.uid}
        />
      )}

      {/* Edit Text Modal (:654-668) */}
      {editDrop && (
        <EditorialTextModal
          onSubmit={async () => {}}
          onClose={onEditClose}
          theme={theme}
          customCategories={categories.map(c => c.name)}
          onCreateCategory={onCreateCategory}
          editDrop={editDrop}
          onEdit={onEditSubmit}
          currentUserId={user?.uid}
          mentionableDrops={drops}
          canMutate={!!user && !!editDrop && (user.uid === editDrop.userId || (!!currentWorkspace && user.uid === currentWorkspace.ownerId))}
        />
      )}

      {/* Move Drop Modal (:642-652) — opened from the preview's Move, the ⋯ sheet, or bulk Move */}
      {moveDrops && moveDrops.length > 0 && (
        <EditorialMoveDropModal
          drops={moveDrops}
          workspaces={workspaces}
          currentWorkspaceId={moveDrops[0].workspaceId}
          onMove={handleMoveComplete}
          onCopy={handleCopyComplete}
          onClose={handleCloseMoveModal}
          theme={theme}
        />
      )}

      {/* Workspace modals (:671-703) */}
      {showCreateModal && (
        <EditorialCreateWorkspaceModal
          onCreate={onCreateWorkspace}
          onClose={() => { setShowCreateModal(false); setCreatedWorkspace(null); }}
          theme={theme}
        />
      )}

      {showJoinModal && (
        <EditorialJoinWorkspaceModal
          onJoin={onJoinWorkspace}
          onClose={() => setShowJoinModal(false)}
          theme={theme}
        />
      )}

      {workspaceToDelete && (
        <WorkspaceOptionsModal
          workspace={workspaceToDelete}
          theme={theme}
          variant="editorial"
          isDeleting={isDeletingWorkspace}
          isLeaving={isLeavingWorkspace}
          isKicking={isKicking}
          onKick={onKick}
          currentUserId={user?.uid || null}
          onDelete={onDeleteWorkspace}
          onLeaveAndTransfer={onLeaveAndTransfer}
          onImport={onImportWorkspace ? () => { setWorkspaceToDelete(null); onImportWorkspace(); } : undefined}
          onClose={() => setWorkspaceToDelete(null)}
        />
      )}

      {/* Leave Workspace Confirmation (:705-745, same markup, tc tokens) */}
      {workspaceToLeave && (
        <div className="fixed inset-0 z-50 flex items-center justify-center overscroll-contain">
          <div className="fixed inset-0 bg-black/50" onClick={() => !isLeavingWorkspace && setWorkspaceToLeave(null)} />
          <div className={`relative z-10 mx-4 w-full max-w-[384px] border ${tc.border} ${tc.cardBg} rounded-lg overflow-hidden`}>
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
                  onClick={onLeaveWorkspace}
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

      {/* Bottom floating navbar (Drops · Create · Search) */}
      <MobileNavbar activeTab={activeTab} onTabChange={setActiveTab} theme={theme} hidden={dropsSelecting} />
    </div>
  );
}
