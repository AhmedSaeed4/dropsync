'use client';

import { useState, useEffect } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { useDrops } from '@/hooks/useDrops';
import { useWorkspaces } from '@/hooks/useWorkspaces';
import { useCategories } from '@/hooks/useCategories';
import { ClassicLayout } from '@/components/layouts/ClassicLayout';
import { EditorialLayout } from '@/components/editorial/EditorialLayout';
import { EditorialLogin } from '@/components/editorial/EditorialLogin';
import { EditorialAuthModal } from '@/components/editorial/EditorialAuthModal';
import { EditorialVerifyEmailModal } from '@/components/editorial/EditorialVerifyEmailModal';
import { getEditorialThemeColors } from '@/components/editorial/editorialTheme';
import { AuthModal } from '@/components/AuthModal';
import { VerifyEmailModal } from '@/components/VerifyEmailModal';
import { Drop, Workspace, ExpirationOption } from '@/types';
import { initializeUserKeys, hasUserKeys, getUserKeys } from '@/lib/keys';
import { decryptDrop, updateTextDrop, updateDropMetadata } from '@/lib/drops';
import { reauthenticateUser } from '@/lib/auth';

type Theme = 'light' | 'dark' | 'minimal';
type LayoutMode = 'classic' | 'editorial';

const THEME_STORAGE_KEY = 'dropsync_theme';
const LAYOUT_STORAGE_KEY = 'dropsync_layout';

export default function Home() {
  const { user, loading: authLoading, signIn, signUp, signInWithEmail: emailSignIn, resetPassword, resendVerification, signOutUser, updateDisplayName } = useAuth();
  const [previewDrop, setPreviewDrop] = useState<Drop | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [theme, setTheme] = useState<Theme>('light');
  const [themeLoaded, setThemeLoaded] = useState(false);
  const [layoutMode, setLayoutMode] = useState<LayoutMode>('editorial');
  const [encryptionInitializing, setEncryptionInitializing] = useState(false);
  const [layoutTransition, setLayoutTransition] = useState<'none' | 'fade-out' | 'fade-in'>('none');
  const [pendingLayout, setPendingLayout] = useState<LayoutMode | null>(null);

  // Auth modal states
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [showVerifyModal, setShowVerifyModal] = useState(false);
  const [verifyEmail, setVerifyEmail] = useState('');

  // Workspace state
  const {
    workspaces,
    currentWorkspace,
    currentWorkspaceId,
    switchWorkspace,
    create: createWorkspace,
    join: joinWorkspace,
    leave: leaveWorkspace,
    deleteWS,
    loading: workspacesLoading
  } = useWorkspaces(user?.uid || null);

  // Pass currentWorkspaceId to useDrops
  const { drops, loading: dropsLoading, refreshDrops } = useDrops(currentWorkspaceId);

  // Categories for current workspace
  const { categories, addCategory, removeCategory } = useCategories(currentWorkspaceId, user?.uid);

  // Modal states
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showJoinModal, setShowJoinModal] = useState(false);
  const [editDrop, setEditDrop] = useState<Drop | null>(null);
  const [createdWorkspace, setCreatedWorkspace] = useState<{ name: string; inviteCode: string } | null>(null);
  const [workspaceToDelete, setWorkspaceToDelete] = useState<Workspace | null>(null);
  const [workspaceToLeave, setWorkspaceToLeave] = useState<Workspace | null>(null);
  const [isDeletingWorkspace, setIsDeletingWorkspace] = useState(false);
  const [isLeavingWorkspace, setIsLeavingWorkspace] = useState(false);
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [showChat, setShowChat] = useState(false);

  // Auto-close auth modal when user successfully logs in
  useEffect(() => {
    if (user && user.emailVerified && showAuthModal) {
      setShowAuthModal(false);
    }
  }, [user, showAuthModal]);

  // Lock body scroll for inline modals (delete/leave workspace, encryption overlay)
  useEffect(() => {
    if (workspaceToDelete || workspaceToLeave || encryptionInitializing) {
      const originalOverflow = document.body.style.overflow;
      const originalPaddingRight = document.body.style.paddingRight;
      const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;
      document.body.style.overflow = 'hidden';
      if (scrollbarWidth > 0) {
        document.body.style.paddingRight = `${scrollbarWidth}px`;
      }
      return () => {
        document.body.style.overflow = originalOverflow;
        document.body.style.paddingRight = originalPaddingRight;
      };
    }
  }, [workspaceToDelete, workspaceToLeave, encryptionInitializing]);

  // Auto-initialize encryption keys on user login
  useEffect(() => {
    if (user) {
      initializeEncryption();
    }
  }, [user]);

  const initializeEncryption = async () => {
    if (!user) return;

    // Check if user already has keys in Firestore
    const hasKeys = await hasUserKeys(user.uid);

    if (!hasKeys) {
      // No keys at all - create new ones
      setEncryptionInitializing(true);
      try {
        await initializeUserKeys(user.uid);
      } catch (error) {
        console.error('Failed to initialize encryption keys:', error);
      } finally {
        setEncryptionInitializing(false);
      }
    } else {
      // Keys exist - check if they have masterKey (migration case)
      // getUserKeys will handle restoring from Firestore or returning null
      const keys = await getUserKeys(user.uid);
      if (!keys) {
        // Old keys without masterKey backup - need to reinitialize
        console.log('Migrating keys to include masterKey backup...');
        setEncryptionInitializing(true);
        try {
          await initializeUserKeys(user.uid);
        } catch (error) {
          console.error('Failed to reinitialize encryption keys:', error);
        } finally {
          setEncryptionInitializing(false);
        }
      }
    }
  };

  // Load theme from localStorage on mount
  useEffect(() => {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (stored && ['light', 'dark', 'minimal'].includes(stored)) {
      setTheme(stored as Theme);
    }
    setThemeLoaded(true);
  }, []);

  // Save theme to localStorage when it changes
  useEffect(() => {
    if (themeLoaded) {
      localStorage.setItem(THEME_STORAGE_KEY, theme);
    }
  }, [theme, themeLoaded]);

  // Load layout from localStorage on mount
  useEffect(() => {
    const stored = localStorage.getItem(LAYOUT_STORAGE_KEY);
    if (stored === 'editorial') {
      setLayoutMode('editorial');
    }
  }, []);

  // Save layout to localStorage when it changes
  useEffect(() => {
    localStorage.setItem(LAYOUT_STORAGE_KEY, layoutMode);
  }, [layoutMode]);

  // Layout transition handler with fade out/in + blur
  const handleLayoutChange = (newLayout: LayoutMode) => {
    if (newLayout === layoutMode) return;
    setShowSettingsModal(false);
    setPendingLayout(newLayout);
    setLayoutTransition('fade-out');
  };

  // Handle fade-out completion → swap layout → fade in
  useEffect(() => {
    if (layoutTransition === 'fade-out' && pendingLayout) {
      const timer = setTimeout(() => {
        setLayoutMode(pendingLayout);
        setPendingLayout(null);
        setLayoutTransition('fade-in');
      }, 200);
      return () => clearTimeout(timer);
    }
    if (layoutTransition === 'fade-in') {
      const timer = setTimeout(() => {
        setLayoutTransition('none');
      }, 300);
      return () => clearTimeout(timer);
    }
  }, [layoutTransition, pendingLayout]);

  // Workspace handlers
  const handleCreateWorkspace = async (name: string) => {
    const workspace = await createWorkspace(name);
    if (workspace) {
      setCreatedWorkspace({ name: workspace.name, inviteCode: workspace.inviteCode });
      switchWorkspace(workspace.id);
    }
  };

  const handleJoinWorkspace = async (inviteCode: string) => {
    const result = await joinWorkspace(inviteCode);
    if (result.workspace) {
      switchWorkspace(result.workspace.id);
      return { success: true };
    }
    return { success: false, error: result.error };
  };

  const handleDeleteWorkspace = async () => {
    if (workspaceToDelete) {
      setIsDeletingWorkspace(true);
      try {
        await deleteWS(workspaceToDelete.id);
        setWorkspaceToDelete(null);
      } finally {
        setIsDeletingWorkspace(false);
      }
    }
  };

  const handleLeaveWorkspace = async () => {
    if (workspaceToLeave) {
      setIsLeavingWorkspace(true);
      try {
        await leaveWorkspace(workspaceToLeave.id);
        setWorkspaceToLeave(null);
      } finally {
        setIsLeavingWorkspace(false);
      }
    }
  };

  // Auth handlers
  const handleShowVerifyModal = (email: string) => {
    setVerifyEmail(email);
    setShowAuthModal(false);
    setShowVerifyModal(true);
  };

  const handleCheckVerification = async (): Promise<boolean> => {
    // Reload the current user to get latest emailVerified status
    if (user) {
      // User is already logged in, verification check passed
      return true;
    }
    return false;
  };

  // Handle preview with decryption
  const handlePreview = async (drop: Drop) => {
    if (!user) {
      setPreviewDrop(drop);
      return;
    }

    // If encrypted, show modal immediately with skeleton, then decrypt
    if (drop.encrypted) {
      setPreviewDrop(drop); // Show modal immediately with encrypted drop
      setPreviewLoading(true); // Show skeleton
      try {
        const decryptedDrop = await decryptDrop(drop, user.uid);
        setPreviewDrop(decryptedDrop); // Update with decrypted content
      } finally {
        setPreviewLoading(false); // Hide skeleton
      }
    } else {
      setPreviewDrop(drop);
    }
  };

  // Get workspace members for encryption
  const workspaceMembers = currentWorkspace?.members || [];

  // Handle edit drop — decrypt text drops, file drops just need metadata
  const handleEditDrop = async (drop: Drop) => {
    setPreviewDrop(null); // close preview if open
    if (drop.type === 'file') {
      setEditDrop(drop);
    } else if (drop.encrypted && user) {
      try {
        const decrypted = await decryptDrop(drop, user.uid);
        setEditDrop(decrypted);
      } catch {
        setEditDrop({ ...drop, content: '' });
      }
    } else {
      setEditDrop(drop);
    }
  };

  // Handle edit submit
  const handleEditSubmit = async (drop: Drop, updates: { name?: string; content?: string; category?: string | null; expirationOption?: ExpirationOption; imageFile?: File | null; imageRemoved?: boolean }): Promise<boolean> => {
    if (!user) return false;
    const success = drop.type === 'file'
      ? await updateDropMetadata(drop.id, updates)
      : await updateTextDrop(drop, updates, user.uid);
    if (success) {
      setEditDrop(null);
    }
    return success;
  };

  // Handle category creation
  const handleCreateCategory = async (name: string): Promise<string | null> => {
    if (!user) return null;
    const category = await addCategory(name, user.uid);
    return category ? category.name : null;
  };

  // Handle category deletion
  const handleDeleteCategory = async (categoryId: string, categoryName: string) => {
    const result = await removeCategory(categoryId, categoryName);
    if (!result.success) {
      console.error('Failed to delete category:', result.error);
    }
  };

  // Theme configuration
  const getThemeColors = (theme: Theme) => {
    switch (theme) {
      case 'dark':
        return {
          isDark: true,
          isMinimal: false,
          bgColor: 'bg-[#0D0D0D]',
          cardBg: 'bg-[#1A1A1A]',
          borderColor: 'border-white/10',
          textColor: 'text-white',
          textMuted: 'text-white/50',
          headerBg: 'bg-[#0D0D0D]',
          accentColor: 'text-[#FF5A47]',
          dropZoneBg: 'bg-[#1A1A1A]',
        };
      case 'minimal':
        return {
          isDark: false,
          isMinimal: true,
          bgColor: 'bg-[#C5C9B8]', // Sage green
          cardBg: 'bg-[#D4D8C8]',
          borderColor: 'border-[#1A1A1A]/20',
          textColor: 'text-[#1A1A1A]',
          textMuted: 'text-[#1A1A1A]/50',
          headerBg: 'bg-[#C5C9B8]',
          accentColor: 'text-[#1A1A1A]',
          dropZoneBg: 'bg-[#D4D8C8]',
        };
      default: // light
        return {
          isDark: false,
          isMinimal: false,
          bgColor: 'bg-[#F5F2ED]',
          cardBg: 'bg-[#FAF7F2]',
          borderColor: 'border-[#1A1A1A]',
          textColor: 'text-[#1A1A1A]',
          textMuted: 'text-[#1A1A1A]/50',
          headerBg: 'bg-[#FAF7F2]',
          accentColor: 'text-[#FF5A47]',
          dropZoneBg: 'bg-white',
        };
    }
  };

  const themeColors = getThemeColors(theme);

  // Wait for theme to load to prevent flash
  if (!themeLoaded) {
    return null;
  }

  // Editorial-style loading screen
  if (authLoading) {
    const tc = getEditorialThemeColors(theme);

    return (
      <div className={`min-h-screen flex flex-col items-center justify-center ${tc.bg} transition-colors duration-500`}>
        <div className="flex flex-col items-center gap-4">
          {/* Logo mark */}
          <span className={`text-lg ${tc.text} font-medium tracking-[-0.3px] ${tc.fontClass}`}>
            <span className="inline-block mr-2">&#9670;</span>
            DropSync
          </span>
          {/* Spinner */}
          <div className={`w-5 h-5 border border-current/30 border-t-current animate-spin rounded-full ${tc.text}`} />
          {/* Text */}
          <p className={`text-xs ${tc.muted} ${tc.fontClass}`}>
            Loading...
          </p>
        </div>
      </div>
    );
  }

  // Check if user is logged in but email not verified (for email/password users)
  if (user && !user.emailVerified) {
    const isDark = theme === 'dark';
    const isMinimal = theme === 'minimal';
    const isEditorial = layoutMode === 'editorial';
    const tc = isEditorial ? getEditorialThemeColors(theme) : null;

    if (isEditorial && tc) {
      return (
        <div className={`min-h-screen flex items-center justify-center ${tc.bg} transition-colors duration-500 p-4`}>
          <div className={`max-w-md w-full ${tc.bg} border ${tc.border} rounded-xl shadow-xl`}>
            <div className={`border-b ${tc.border} px-5 py-4`}>
              <h2 className={`${tc.fontClass} ${tc.text} font-medium text-[15px]`}>Verify your email</h2>
            </div>
            <div className="p-6 text-center">
              <div className="flex justify-center mb-6">
                <div className={`w-16 h-16 ${tc.inactivePillBg} flex items-center justify-center rounded-xl`}>
                  <svg className={`w-8 h-8 ${tc.muted}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M21.75 6.75v10.5a2.25 2.25 0 01-2.25 2.25h-15a2.25 2.25 0 01-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25m19.5 0v.243a2.25 2.25 0 01-1.07 1.916l-7.5 4.615a2.25 2.25 0 01-2.36 0L3.32 8.91a2.25 2.25 0 01-1.07-1.916V6.75" />
                  </svg>
                </div>
              </div>
              <p className={`text-sm ${tc.fontClass} ${tc.text} mb-2`}>We sent a verification email to:</p>
              <p className={`text-sm font-semibold ${tc.text} ${tc.fontClass} mb-4`}>{user.email}</p>
              <p className={`text-xs ${tc.fontClass} ${tc.muted} mb-6`}>
                Click the link in the email to verify your account. Check your spam folder if you don&apos;t see it.
              </p>
              <div className="space-y-3">
                <button
                  onClick={async () => { await resendVerification(); alert('Verification email sent!'); }}
                  className={`w-full ${tc.activePillBg} ${tc.activePillText} py-2.5 text-sm rounded-lg hover:opacity-90 transition-opacity ${tc.fontClass}`}
                >
                  Resend Verification Email
                </button>
                <button
                  onClick={async () => { window.location.reload(); }}
                  className={`w-full border ${tc.border} ${tc.text} py-2.5 text-sm rounded-lg hover:border-[#1a1a1a] transition-colors ${tc.fontClass}`}
                >
                  I&apos;ve Verified My Email
                </button>
                <button
                  onClick={signOutUser}
                  className={`w-full ${tc.muted} py-2 text-sm hover:${tc.text} transition-colors ${tc.fontClass}`}
                >
                  Sign Out
                </button>
              </div>
            </div>
          </div>
        </div>
      );
    }

    return (
      <div className={`min-h-screen flex items-center justify-center ${themeColors.bgColor} transition-colors duration-500 p-4`}>
        <div className={`max-w-md w-full ${themeColors.cardBg} border ${themeColors.borderColor} ${isMinimal ? 'rounded-lg' : ''}`}>
          {/* Header */}
          <div className={`border-b ${themeColors.borderColor} px-6 py-4 ${isMinimal ? 'bg-[#1A1A1A]/5' : 'bg-[#FF5A47]'}`}>
            <h2 className={`${isMinimal ? 'text-sm font-medium' : 'text-sm font-bold uppercase tracking-wider'} text-white`}>
              {isMinimal ? 'Verify your email' : 'EMAIL_VERIFICATION_REQUIRED'}
            </h2>
          </div>

          {/* Content */}
          <div className="p-6 text-center">
            {/* Email Icon */}
            <div className="flex justify-center mb-6">
              <div className={`w-16 h-16 ${isMinimal ? 'bg-[#1A1A1A]/5' : isDark ? 'bg-white/10' : 'bg-[#1A1A1A]/5'} flex items-center justify-center ${isMinimal ? 'rounded-full' : ''}`}>
                <svg className={`w-8 h-8 ${isMinimal ? 'text-[#1A1A1A]' : 'text-[#FF5A47]'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M21.75 6.75v10.5a2.25 2.25 0 01-2.25 2.25h-15a2.25 2.25 0 01-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25m19.5 0v.243a2.25 2.25 0 01-1.07 1.916l-7.5 4.615a2.25 2.25 0 01-2.36 0L3.32 8.91a2.25 2.25 0 01-1.07-1.916V6.75" />
                </svg>
              </div>
            </div>

            <p className={`${isMinimal ? 'text-sm font-sans' : 'text-xs font-mono uppercase tracking-wider'} ${themeColors.textColor} mb-2`}>
              We sent a verification email to:
            </p>
            <p className={`text-sm font-semibold ${themeColors.textColor} mb-4`}>
              {user.email}
            </p>
            <p className={`${isMinimal ? 'text-xs font-sans' : 'text-[10px] font-mono'} ${themeColors.textMuted} mb-6`}>
              Click the link in the email to verify your account. Check your spam folder if you don&apos;t see it.
            </p>

            <div className="space-y-3">
              <button
                onClick={async () => {
                  await resendVerification();
                  alert('Verification email sent!');
                }}
                className={`w-full bg-[#1A1A1A] text-white py-3 text-xs tracking-wider hover:bg-[#2A2A2A] transition-colors ${isMinimal ? 'rounded-full' : ''}`}
              >
                Resend Verification Email
              </button>
              <button
                onClick={async () => {
                  // Reload the page to check if verified
                  window.location.reload();
                }}
                className={`w-full border ${themeColors.borderColor} ${themeColors.textColor} py-3 text-xs tracking-wider hover:bg-[#1A1A1A] hover:text-white transition-colors ${isMinimal ? 'rounded-full' : ''}`}
              >
                I&apos;ve Verified My Email
              </button>
              <button
                onClick={signOutUser}
                className={`w-full ${themeColors.textMuted} py-2 text-xs tracking-wider hover:${themeColors.textColor} transition-colors`}
              >
                Sign Out
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (!user) {
    // Editorial layout login page
    if (layoutMode === 'editorial') {
      return (
        <div className="min-h-screen bg-[#FFFEF5] transition-colors duration-500">
          <EditorialLogin
            signIn={signIn}
            onShowAuthModal={() => setShowAuthModal(true)}
            theme={theme}
          />
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
          {showVerifyModal && (
            <EditorialVerifyEmailModal
              email={verifyEmail}
              onResend={resendVerification}
              onClose={() => setShowVerifyModal(false)}
              theme={theme}
            />
          )}
        </div>
      );
    }

    // Minimal theme login page
    if (theme === 'minimal') {
      return (
        <div className="min-h-screen bg-[#C5C9B8] flex flex-col transition-colors duration-500">
          {/* Top Navigation */}
          <header className="flex items-center justify-between px-8 py-6">
            <div className="text-sm font-medium tracking-wide text-[#1A1A1A] uppercase">
              DROP/SYNC
            </div>
            <nav className="hidden md:flex items-center gap-8 text-xs tracking-widest text-[#1A1A1A]/70">
              <span className="hover:text-[#1A1A1A] cursor-pointer transition-colors">ABOUT</span>
              <span className="hover:text-[#1A1A1A] cursor-pointer transition-colors">FEATURES</span>
              <span className="hover:text-[#1A1A1A] cursor-pointer transition-colors">CONTACT</span>
            </nav>
            <div className="flex items-center gap-4">
              <span className="text-xs text-[#1A1A1A]/50">[ N.001 ]</span>
            </div>
          </header>

          {/* Main Content */}
          <main className="flex-1 flex flex-col items-center justify-center px-8 relative">
            {/* Center Text Block */}
            <div className="max-w-lg text-center">
              <p className="text-[#1A1A1A] text-sm md:text-base leading-relaxed tracking-wide mb-8">
                DROP FILES ON ONE DEVICE.<br />
                PICKUP ON ANOTHER.<br />
                SIMPLE. SECURE. TEMPORARY.
              </p>
              <p className="text-[#1A1A1A]/60 text-xs tracking-wider mb-12">
                Auto-expire: 1h - Forever • Max 500MB • 200 drops
              </p>

              {/* Auth Button - Pill Style */}
              <div className="flex flex-col gap-3">
                <button
                  onClick={signIn}
                  className="inline-flex items-center gap-3 px-8 py-3 border border-[#1A1A1A]/30 rounded-full text-xs tracking-widest text-[#1A1A1A] hover:bg-[#1A1A1A] hover:text-white transition-all duration-300"
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
                  onClick={() => setShowAuthModal(true)}
                  className="inline-flex items-center gap-3 px-8 py-3 bg-[#1A1A1A] rounded-full text-xs tracking-widest text-white hover:bg-[#2A2A2A] transition-all duration-300"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M21.75 6.75v10.5a2.25 2.25 0 01-2.25 2.25h-15a2.25 2.25 0 01-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25m19.5 0v.243a2.25 2.25 0 01-1.07 1.916l-7.5 4.615a2.25 2.25 0 01-2.36 0L3.32 8.91a2.25 2.25 0 01-1.07-1.916V6.75" />
                  </svg>
                  Sign in with Email
                </button>
              </div>
            </div>

            {/* Decorative Elements */}
            <div className="absolute bottom-8 left-8 text-[10px] tracking-widest text-[#1A1A1A]/40">
              {new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}
            </div>
            <div className="absolute bottom-8 right-8 text-[10px] tracking-widest text-[#1A1A1A]/40">
              EDITION 2.0
            </div>
          </main>

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
        </div>
      );
    }

    // Original Operational Intelligence login (light/dark)
    return (
      <div className="min-h-screen flex flex-col">
        <div className="flex-1 flex">
          <div className={`flex-1 ${themeColors.isDark ? 'bg-[#FF5A47]' : 'bg-[#FF5A47]'} flex items-center justify-center p-12`}>
            <div className="max-w-md">
              <div className="w-24 h-24 border-2 border-white flex items-center justify-center mb-8 relative">
                <div className="absolute inset-2 border border-white/30" />
                <div className="absolute inset-4 border border-white/20" />
                <svg className="w-10 h-10 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
                  <path d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                </svg>
              </div>
              <h1 className="text-6xl md:text-7xl font-bold tracking-tighter text-white uppercase leading-[0.9] mb-4">
                DROP<br/>/SYNC
              </h1>
              <p className="text-sm text-white/80 uppercase tracking-wider mb-8">
                SECURE FILE TRANSFER // OP/INTELLIGENCE
              </p>
            </div>
          </div>

          <div className={`w-80 ${themeColors.isDark ? 'bg-[#0D0D0D]' : 'bg-[#1A1A1A]'} p-8 flex flex-col justify-between hidden lg:flex`}>
            <div>
              <h2 className="text-[10px] font-mono uppercase tracking-wider text-white/40 mb-4">
                SYSTEM/SPECS
              </h2>
              <ul className="font-mono text-[10px] uppercase tracking-wider space-y-2">
                <li className="flex justify-between py-1 border-b border-white/10">
                  <span className="text-white/60">PROTOCOL</span>
                  <span className="text-[#FF5A47]">HTTPS/TLS</span>
                </li>
                <li className="flex justify-between py-1 border-b border-white/10">
                  <span className="text-white/60">ENCRYPTION</span>
                  <span className="text-white">AES-256*</span>
                </li>
                <li className="flex justify-between py-1 border-b border-white/10">
                  <span className="text-white/60">EXPIRATION</span>
                  <span className="text-white">1h - FOREVER</span>
                </li>
                <li className="flex justify-between py-1 border-b border-white/10">
                  <span className="text-white/60">CAPACITY</span>
                  <span className="text-white">200 DROPS</span>
                </li>
                <li className="flex justify-between py-1 border-b border-white/10">
                  <span className="text-white/60">MAX_SIZE</span>
                  <span className="text-white">500MB</span>
                </li>
                <li className="flex justify-between py-1">
                  <span className="text-white/40 text-[8px]">*Files under 10MB encrypted</span>
                  <span className="text-white/40 text-[8px]"></span>
                </li>
              </ul>
            </div>

            <div>
              <p className="text-[10px] font-mono uppercase tracking-wider text-white/40 mb-4">
                DROP_FILES_ON_ONE_DEVICE<br/>
                PICKUP_ON_ANOTHER
              </p>
              <div className={`${themeColors.isDark ? 'bg-[#1A1A1A]' : 'bg-[#FAF7F2]'} border ${themeColors.isDark ? 'border-white/10' : 'border-white/20'}`}>
                <div className="p-4 flex items-center gap-3">
                  <div className="w-10 h-10 bg-[#FF5A47] flex items-center justify-center">
                    <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
                      <path d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                    </svg>
                  </div>
                  <div className="flex-1">
                    <p className="text-xs font-bold uppercase tracking-wider text-[#1A1A1A]">DROP/SYNC</p>
                    <p className="text-[9px] font-mono uppercase text-[#1A1A1A]/50">SECURE TRANSFER</p>
                  </div>
                </div>
                <div className="border-t border-[#1A1A1A]/10">
                  <button
                    onClick={signIn}
                    className="w-full py-3 px-4 text-xs font-semibold uppercase tracking-wider text-[#1A1A1A] hover:bg-[#1A1A1A] hover:text-white transition-colors flex items-center justify-center gap-2"
                  >
                    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                      <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
                    </svg>
                    AUTH / GOOGLE
                  </button>
                </div>
                <div className="border-t border-[#1A1A1A]/10">
                  <button
                    onClick={() => setShowAuthModal(true)}
                    className="w-full py-3 px-4 text-xs font-semibold uppercase tracking-wider text-[#1A1A1A] hover:bg-[#1A1A1A] hover:text-white transition-colors flex items-center justify-center gap-2"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M21.75 6.75v10.5a2.25 2.25 0 01-2.25 2.25h-15a2.25 2.25 0 01-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25m19.5 0v.243a2.25 2.25 0 01-1.07 1.916l-7.5 4.615a2.25 2.25 0 01-2.36 0L3.32 8.91a2.25 2.25 0 01-1.07-1.916V6.75" />
                    </svg>
                    AUTH / EMAIL
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className={`lg:hidden ${themeColors.isDark ? 'bg-[#0D0D0D]' : 'bg-[#1A1A1A]'} p-6`}>
          <div className={`${themeColors.isDark ? 'bg-[#1A1A1A]' : 'bg-[#FAF7F2]'}`}>
            <div className="p-4 flex items-center gap-3">
              <div className="w-10 h-10 bg-[#FF5A47] flex items-center justify-center">
                <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
                  <path d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                </svg>
              </div>
              <div className="flex-1">
                <p className="text-xs font-bold uppercase tracking-wider text-[#1A1A1A]">DROP/SYNC</p>
                <p className="text-[9px] font-mono uppercase text-[#1A1A1A]/50">SECURE TRANSFER</p>
              </div>
            </div>
            <div className="border-t border-[#1A1A1A]/10">
              <button
                onClick={signIn}
                className="w-full py-3 px-4 text-xs font-semibold uppercase tracking-wider text-[#1A1A1A] hover:bg-[#1A1A1A] hover:text-white transition-colors flex items-center justify-center gap-2"
              >
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                  <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                  <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                  <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
                </svg>
                AUTH / GOOGLE
              </button>
            </div>
            <div className="border-t border-[#1A1A1A]/10">
              <button
                onClick={() => setShowAuthModal(true)}
                className="w-full py-3 px-4 text-xs font-semibold uppercase tracking-wider text-[#1A1A1A] hover:bg-[#1A1A1A] hover:text-white transition-colors flex items-center justify-center gap-2"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M21.75 6.75v10.5a2.25 2.25 0 01-2.25 2.25h-15a2.25 2.25 0 01-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25m19.5 0v.243a2.25 2.25 0 01-1.07 1.916l-7.5 4.615a2.25 2.25 0 01-2.36 0L3.32 8.91a2.25 2.25 0 01-1.07-1.916V6.75" />
                </svg>
                AUTH / EMAIL
              </button>
            </div>
          </div>
        </div>

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
    </div>
    );
  }

  // Main app — delegate to layout component
  const layoutProps = {
    theme, setTheme, themeColors,
    user, layoutMode, setLayoutMode: handleLayoutChange,
    showChat, setShowChat,
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
    workspaces, currentWorkspace, currentWorkspaceId, workspaceMembers,
    switchWorkspace,
    drops, dropsLoading, refreshDrops,
    categories, handleCreateCategory, handleDeleteCategory,
    handleCreateWorkspace, handleJoinWorkspace,
    handleDeleteWorkspace, handleLeaveWorkspace,
    handlePreview, handleShowVerifyModal, handleCheckVerification,
    signIn, emailSignIn, signUp, resetPassword, resendVerification,
    signOutUser, updateDisplayName, reauthenticateUser,
    editDrop, setEditDrop, handleEditDrop, handleEditSubmit,
  };

  const transitionClass = layoutTransition === 'fade-out'
    ? 'layout-fade-out'
    : layoutTransition === 'fade-in'
      ? 'layout-fade-in'
      : '';

  if (layoutMode === 'editorial') {
    return (
      <div className={transitionClass}>
        <EditorialLayout {...layoutProps} />
      </div>
    );
  }

  return (
    <div className={transitionClass}>
      <ClassicLayout {...layoutProps} />
    </div>
  );
}
