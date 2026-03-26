'use client';

import { useState, useEffect } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { useDrops } from '@/hooks/useDrops';
import { useWorkspaces } from '@/hooks/useWorkspaces';
import { useCategories } from '@/hooks/useCategories';
import { Header } from '@/components/Header';
import { DropZone } from '@/components/DropZone';
import { DropList } from '@/components/DropList';
import { PreviewModal } from '@/components/PreviewModal';
import { WorkspaceSwitcher } from '@/components/WorkspaceSwitcher';
import { CreateWorkspaceModal } from '@/components/CreateWorkspaceModal';
import { JoinWorkspaceModal } from '@/components/JoinWorkspaceModal';
import { AuthModal } from '@/components/AuthModal';
import { VerifyEmailModal } from '@/components/VerifyEmailModal';
import { Drop, Workspace } from '@/types';
import { initializeUserKeys, hasUserKeys, getUserKeys } from '@/lib/keys';
import { decryptDrop } from '@/lib/drops';
import { SettingsModal } from '@/components/SettingsModal';
import { reauthenticateUser } from '@/lib/auth';

type Theme = 'light' | 'dark' | 'minimal';

const THEME_STORAGE_KEY = 'dropsync_theme';

export default function Home() {
  const { user, loading: authLoading, signIn, signUp, signInWithEmail: emailSignIn, resetPassword, resendVerification, signOutUser, updateDisplayName } = useAuth();
  const [previewDrop, setPreviewDrop] = useState<Drop | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [theme, setTheme] = useState<Theme>('light');
  const [themeLoaded, setThemeLoaded] = useState(false);
  const [encryptionInitializing, setEncryptionInitializing] = useState(false);

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
  const [createdWorkspace, setCreatedWorkspace] = useState<{ name: string; inviteCode: string } | null>(null);
  const [workspaceToDelete, setWorkspaceToDelete] = useState<Workspace | null>(null);
  const [workspaceToLeave, setWorkspaceToLeave] = useState<Workspace | null>(null);
  const [showSettingsModal, setShowSettingsModal] = useState(false);

  // Auto-close auth modal when user successfully logs in
  useEffect(() => {
    if (user && user.emailVerified && showAuthModal) {
      setShowAuthModal(false);
    }
  }, [user, showAuthModal]);

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

  const handleCloseCreateModal = () => {
    setShowCreateModal(false);
    setCreatedWorkspace(null);
  };

  const handleDeleteWorkspace = async () => {
    if (workspaceToDelete) {
      await deleteWS(workspaceToDelete.id);
      setWorkspaceToDelete(null);
    }
  };

  const handleLeaveWorkspace = async () => {
    if (workspaceToLeave) {
      await leaveWorkspace(workspaceToLeave.id);
      setWorkspaceToLeave(null);
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

  if (authLoading) {
    return (
      <div className={`min-h-screen flex items-center justify-center ${themeColors.bgColor} transition-colors duration-500`}>
        <div className="flex flex-col items-center gap-4">
          {theme === 'minimal' ? (
            <div className="w-8 h-8 border border-[#1A1A1A]/30 border-t-[#1A1A1A] animate-spin rounded-full" />
          ) : (
            <div className={`w-8 h-8 border-2 ${themeColors.isDark ? 'border-white' : 'border-[#1A1A1A]'} border-t-transparent animate-spin`} />
          )}
          <p className={`text-[10px] ${theme === 'minimal' ? 'font-sans tracking-wide' : 'font-mono uppercase tracking-wider'} ${themeColors.textMuted}`}>
            {theme === 'minimal' ? 'Loading...' : 'INITIALIZING_SYSTEM...'}
          </p>
        </div>
      </div>
    );
  }

  // Check if user is logged in but email not verified (for email/password users)
  if (user && !user.emailVerified) {
    const isDark = theme === 'dark';
    const isMinimal = theme === 'minimal';

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
                Auto-expire after 2 hours • Max 800KB • 50 drops
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
                  <span className="text-white">AES-256</span>
                </li>
                <li className="flex justify-between py-1 border-b border-white/10">
                  <span className="text-white/60">EXPIRATION</span>
                  <span className="text-white">2 HOURS</span>
                </li>
                <li className="flex justify-between py-1 border-b border-white/10">
                  <span className="text-white/60">CAPACITY</span>
                  <span className="text-white">50 DROPS</span>
                </li>
                <li className="flex justify-between py-1 border-b border-white/10">
                  <span className="text-white/60">MAX_SIZE</span>
                  <span className="text-white">800KB</span>
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

  // Main app with theme selector
  return (
    <div className={`min-h-screen ${themeColors.bgColor} transition-colors duration-500`}>
      {/* Encryption initializing overlay */}
      {encryptionInitializing && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
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
      <Header theme={theme} onThemeChange={setTheme} onOpenSettings={() => setShowSettingsModal(true)}>
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
              />
            </section>
            <section>
              <DropList
                drops={drops}
                loading={dropsLoading}
                onDelete={refreshDrops}
                onPreview={handlePreview}
                theme={theme}
                currentUserId={user?.uid}
                categories={categories}
                onDeleteCategory={handleDeleteCategory}
              />
            </section>
          </div>

          <div className="w-full lg:w-80 space-y-6">
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
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="fixed inset-0 bg-black/50" onClick={() => setWorkspaceToDelete(null)} />
          <div className={`relative z-10 w-80 border ${theme === 'dark' ? 'bg-[#1A1A1A] border-white/10' : theme === 'minimal' ? 'bg-[#D4D8C8] border-[#1A1A1A]/20 rounded-lg' : 'bg-white border-[#1A1A1A]'}`}>
            <div className={`px-4 py-3 border-b ${theme === 'dark' ? 'border-white/10' : theme === 'minimal' ? 'border-[#1A1A1A]/20' : 'border-[#1A1A1A]'} flex items-center justify-between ${theme === 'minimal' ? 'bg-[#1A1A1A]/5' : 'bg-[#FF5A47]'}`}>
              <h3 className={`font-bold text-white ${theme === 'minimal' ? 'font-sans tracking-wide text-xs' : 'font-mono uppercase tracking-wider text-[10px]'}`}>
                {theme === 'minimal' ? 'Delete workspace' : 'DELETE_WORKSPACE'}
              </h3>
              <button onClick={() => setWorkspaceToDelete(null)} className="text-white/70 hover:text-white transition-colors">
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
                  className={`flex-1 px-4 py-2 ${theme === 'dark' ? 'bg-white/10 hover:bg-white/20 text-white' : theme === 'minimal' ? 'bg-[#1A1A1A]/10 hover:bg-[#1A1A1A]/20 text-[#1A1A1A] rounded-lg' : 'bg-[#1A1A1A]/10 hover:bg-[#1A1A1A]/20 text-[#1A1A1A]'} transition-colors ${theme === 'minimal' ? 'font-sans tracking-wide text-xs' : 'font-mono uppercase tracking-wider text-[10px]'}`}
                >
                  {theme === 'minimal' ? 'Cancel' : 'CANCEL'}
                </button>
                <button
                  onClick={handleDeleteWorkspace}
                  className={`flex-1 px-4 py-2 bg-red-500 hover:bg-red-600 text-white transition-colors ${theme === 'minimal' ? 'rounded-lg font-sans tracking-wide text-xs' : 'font-mono uppercase tracking-wider text-[10px]'}`}
                >
                  {theme === 'minimal' ? 'Delete' : 'DELETE'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Leave Workspace Confirmation Modal */}
      {workspaceToLeave && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="fixed inset-0 bg-black/50" onClick={() => setWorkspaceToLeave(null)} />
          <div className={`relative z-10 w-80 border ${theme === 'dark' ? 'bg-[#1A1A1A] border-white/10' : theme === 'minimal' ? 'bg-[#D4D8C8] border-[#1A1A1A]/20 rounded-lg' : 'bg-white border-[#1A1A1A]'}`}>
            <div className={`px-4 py-3 border-b ${theme === 'dark' ? 'border-white/10' : theme === 'minimal' ? 'border-[#1A1A1A]/20' : 'border-[#1A1A1A]'} flex items-center justify-between ${theme === 'minimal' ? 'bg-[#1A1A1A]/5' : 'bg-[#FF5A47]'}`}>
              <h3 className={`font-bold text-white ${theme === 'minimal' ? 'font-sans tracking-wide text-xs' : 'font-mono uppercase tracking-wider text-[10px]'}`}>
                {theme === 'minimal' ? 'Leave workspace' : 'LEAVE_WORKSPACE'}
              </h3>
              <button onClick={() => setWorkspaceToLeave(null)} className="text-white/70 hover:text-white transition-colors">
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
                  className={`flex-1 px-4 py-2 ${theme === 'dark' ? 'bg-white/10 hover:bg-white/20 text-white' : theme === 'minimal' ? 'bg-[#1A1A1A]/10 hover:bg-[#1A1A1A]/20 text-[#1A1A1A] rounded-lg' : 'bg-[#1A1A1A]/10 hover:bg-[#1A1A1A]/20 text-[#1A1A1A]'} transition-colors ${theme === 'minimal' ? 'font-sans tracking-wide text-xs' : 'font-mono uppercase tracking-wider text-[10px]'}`}
                >
                  {theme === 'minimal' ? 'Cancel' : 'CANCEL'}
                </button>
                <button
                  onClick={handleLeaveWorkspace}
                  className={`flex-1 px-4 py-2 ${theme === 'dark' ? 'bg-[#FF5A47] hover:bg-[#E54A37]' : theme === 'minimal' ? 'bg-[#1A1A1A] hover:bg-[#333] rounded-lg' : 'bg-[#FF5A47] hover:bg-[#E54A37]'} text-white transition-colors ${theme === 'minimal' ? 'font-sans tracking-wide text-xs' : 'font-mono uppercase tracking-wider text-[10px]'}`}
                >
                  {theme === 'minimal' ? 'Leave' : 'LEAVE'}
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
          theme={theme}
        />
      )}
    </div>
  );
}
