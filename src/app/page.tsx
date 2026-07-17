'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/hooks/useAuth';
import { useDrops } from '@/hooks/useDrops';
import { useWorkspaces } from '@/hooks/useWorkspaces';
import { useCategories } from '@/hooks/useCategories';
import { usePresence } from '@/hooks/usePresence';
import { ClassicLayout } from '@/components/layouts/ClassicLayout';
import { EditorialLayout } from '@/components/editorial/EditorialLayout';
import { EditorialAuthModal } from '@/components/editorial/EditorialAuthModal';
import { EditorialVerifyEmailModal } from '@/components/editorial/EditorialVerifyEmailModal';
import { getEditorialThemeColors } from '@/components/editorial/editorialTheme';
import { AuthModal } from '@/components/AuthModal';
import { VerifyEmailModal } from '@/components/VerifyEmailModal';
import { Toast } from '@/components/Toast';
import { Footer } from '@/components/Footer';
import { lockScroll, unlockScroll, retractFooterIfUp } from '@/components/SmoothScrollProvider';
import { useDissolve } from '@/hooks/useDissolve';
import { useMagnet } from '@/hooks/useMagnet';
import { useIsWide } from '@/hooks/useIsWide';
import { Drop, Workspace, ExpirationOption } from '@/types';
import { initializeUserKeys, hasUserKeys, getUserKeys, ensurePublicKeyPublished } from '@/lib/keys';
import { ensureProfilePublished } from '@/lib/profiles';
import { decryptDrop, updateTextDrop, updateDropMetadata, moveDrop } from '@/lib/drops';
import { getWorkspaceMembers, MemberInfo } from '@/lib/workspaces';
import { getLastRead, initReadState, markWorkspaceChatRead, clearWorkspaceMentions } from '@/lib/groupChat';
import {
  isNotificationsSupported,
  getNotificationPermission,
  requestNotificationPermission,
  showChatNotification,
  showMentionNotification,
  registerChatServiceWorker,
  ensureFcmToken,
} from '@/lib/notifications';
import { reauthenticateUser } from '@/lib/auth';
import { db } from '@/lib/firebase';
import { collection, query, orderBy, limit, onSnapshot, getDocs, getDoc, doc, updateDoc, waitForPendingWrites, Timestamp } from 'firebase/firestore';

type Theme = 'light' | 'dark' | 'minimal';
type LayoutMode = 'classic' | 'editorial';

const THEME_STORAGE_KEY = 'dropsync_theme';
const LAYOUT_STORAGE_KEY = 'dropsync_layout';

export default function Home() {
  const router = useRouter();
  const { user, loading: authLoading, signIn, signUp, signInWithEmail: emailSignIn, resetPassword, resendVerification, signOutUser, updateDisplayName } = useAuth();
  const [previewDrop, setPreviewDrop] = useState<Drop | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [theme, setTheme] = useState<Theme>('light');
  const [themeLoaded, setThemeLoaded] = useState(false);
  const [layoutMode, setLayoutMode] = useState<LayoutMode>('editorial');
  const [encryptionInitializing, setEncryptionInitializing] = useState(false);
  const [layoutTransition, setLayoutTransition] = useState<'none' | 'fade-out' | 'fade-in'>('none');
  const [pendingLayout, setPendingLayout] = useState<LayoutMode | null>(null);
  const [pageTransition, setPageTransition] = useState<'none' | 'fade-out' | 'fade-in'>('fade-in');

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
    kick,
    loading: workspacesLoading
  } = useWorkspaces(user?.uid || null, {
    // Server-side removal notice: fires when a workspace the user belonged to disappears and it
    // was NOT a locally-initiated leave/delete (i.e. the owner kicked them, or the owner deleted
    // the workspace). Honest in both cases. Empty initial list → no false fire on load/refresh.
    onWorkspaceRemoved: (ws) => setRemovedNotice(`You no longer have access to "${ws.name}".`),
  });

  // Pass currentWorkspaceId to useDrops
  const { drops, loading: dropsLoading, refreshDrops } = useDrops(currentWorkspaceId);

  // Categories for current workspace
  const { categories, addCategory, removeCategory } = useCategories(currentWorkspaceId, user?.uid);

  // Workspace presence — PAGE-LEVEL (the chat panel unmounts on close, so presence must live here).
  // Self-excludes; threaded down to both chat panels as the `presence` prop. MUST stay above all
  // early returns (Rules of Hooks) — it self-guards when user/workspace are null.
  const presenceMap = usePresence(user?.uid || null, currentWorkspaceId);

  // Modal states
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showJoinModal, setShowJoinModal] = useState(false);
  const [editDrop, setEditDrop] = useState<Drop | null>(null);
  const [createdWorkspace, setCreatedWorkspace] = useState<{ name: string; inviteCode: string } | null>(null);
  const [workspaceToDelete, setWorkspaceToDelete] = useState<Workspace | null>(null);
  const [workspaceToLeave, setWorkspaceToLeave] = useState<Workspace | null>(null);
  const [isDeletingWorkspace, setIsDeletingWorkspace] = useState(false);
  const [isLeavingWorkspace, setIsLeavingWorkspace] = useState(false);
  const [isKickingMember, setIsKickingMember] = useState(false);
  const [removedNotice, setRemovedNotice] = useState<string | null>(null);
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [showChat, setShowChat] = useState(false);
  const [chatMode, setChatMode] = useState<'ai' | 'group'>('ai');
  const [unreadCount, setUnreadCount] = useState(0);
  const unreadUnsubRef = useRef<(() => void) | null>(null);
  const prevShowChatRef = useRef(showChat);

  // Browser chat notifications (foreground only) — permission + mute preference.
  // Default: notifications ON once permission is granted (mute flag = off).
  const [notifPermission, setNotifPermission] = useState<NotificationPermission>('default');
  const [notifMuted, setNotifMuted] = useState(false);
  // Approach-C: footer (dissolve + magnet) user toggle. Default ON. Persisted to Firestore
  // users/{uid}.footerEnabled (mirrors notifMuted) so it syncs across devices on reload.
  const [footerEnabled, setFooterEnabled] = useState(true);
  // Session-only guard for the chat-open permission prompt. Resets on every page load (NO
  // localStorage), so accounts created before the push feature get prompted again instead of being
  // permanently skipped. Only caps the prompt at once-per-tab-session.
  const chatNotifPromptedRef = useRef(false);
  const viewingGroupChatRef = useRef(false);
  // Opens the group chat (optionally switching to a tapped workspace) — held in a ref so the stable
  // service-worker message listener always calls the latest version without re-subscribing.
  const openChatFromTapRef = useRef<(workspaceId?: string) => void>(() => {});
  // Guards the /?chat=<id> deep link so it runs once, not after the user has navigated.
  const deepLinkHandledRef = useRef(false);
  const [resolvedWorkspaceMembers, setResolvedWorkspaceMembers] = useState<MemberInfo[]>([]);

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
      lockScroll(); // freeze smooth-scroll while the overlay locks the page (ref-counted)
      return () => {
        document.body.style.overflow = originalOverflow;
        document.body.style.paddingRight = originalPaddingRight;
        unlockScroll();
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

    // Lazy self-migration: ensure this user's publicKey is mirrored into the world-readable
    // userPublicKeys collection. Idempotent + rule-safe (self-only read/write). Covers any
    // pre-split user on their first login after deploy. Wrapped so a transient Firestore write
    // failure logs a warning instead of aborting the session (next login retries idempotently).
    try {
      await ensurePublicKeyPublished(user.uid);
      // Lazy self-migration for the profile split — MOVE displayName/photoURL from this user's own
      // users doc into the world-readable profiles doc. Same idempotent + best-effort contract as
      // ensurePublicKeyPublished above (reads source from users/{uid}, not Firebase Auth).
      await ensureProfilePublished(user.uid);
    } catch (error) {
      console.warn('self-migration (publicKey/profile) failed this session; will retry on next login', error);
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
      // Mirror the share page: also write the `share-theme` cookie so public
      // server-rendered pages (e.g. /privacy) can paint the app theme on the next
      // load. Public pages only do light/dark, so minimal (and any non-dark) → light.
      try { document.cookie = `share-theme=${theme === 'dark' ? 'dark' : 'light'};path=/;max-age=31536000;SameSite=Lax`; } catch {}
    }
  }, [theme, themeLoaded]);

  // Match the page background to the theme so the dissolve (#app-shell fade) never flashes
  // the cream body bg on the dark theme. On dark the body is PURE BLACK #000000 — matches the
  // footer exactly, so the whole scroll-into-footer is uniformly black (no lighter band above
  // the footer). On light/minimal the body stays cream (app is already cream → invisible).
  // The inline style overrides globals.css `body { background: var(--off-white) }`; '' reverts
  // to that cream default on light/minimal AND on unmount so other routes (/privacy, /s/[shareId])
  // keep their cream body.
  useEffect(() => {
    document.body.style.backgroundColor = theme === 'dark' ? '#000000' : '';
    return () => { document.body.style.backgroundColor = ''; };
  }, [theme]);

  // Load layout from localStorage on mount
  useEffect(() => {
    const stored = localStorage.getItem(LAYOUT_STORAGE_KEY);
    if (stored === 'classic' || stored === 'editorial') {
      setLayoutMode(stored);
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

  const handleLeaveAndTransfer = async (newOwnerId: string) => {
    if (workspaceToDelete) {
      setIsLeavingWorkspace(true);
      try {
        await leaveWorkspace(workspaceToDelete.id, newOwnerId);
        setWorkspaceToDelete(null);
      } finally {
        setIsLeavingWorkspace(false);
      }
    }
  };

  // Owner removes (kicks) a member. The owner STAYS in the workspace — no switchWorkspace(null)
  // (unlike delete/leave). Modal closes on success (matches delete/leave).
  const handleKickMember = async (memberUid: string) => {
    if (!workspaceToDelete) return;
    setIsKickingMember(true);
    try {
      await kick(workspaceToDelete.id, memberUid);
      setWorkspaceToDelete(null);
    } finally {
      setIsKickingMember(false);
    }
  };

  // Stable callback for the removal-notice Toast. Toast's dismiss effect depends on onDone, so a
  // fresh inline arrow per render would reset its 3s timer on every re-render the kick flow
  // triggers (listener emission, currentWorkspaceId reset, drops reload) and the notice would
  // linger. useCallback keeps the identity stable so the timer runs exactly once.
  const handleRemovedNoticeDone = useCallback(() => setRemovedNotice(null), []);

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
    // Retract the footer if it's partway up (mid-dissolve) BEFORE opening the drop, so the modal
    // isn't trapped behind the risen footer (#app-shell z-[1] < footer z-[2]). No-op at scrollY 0.
    retractFooterIfUp();
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

  // Resolve workspace member display names for @mention search
  useEffect(() => {
    if (!currentWorkspace?.members?.length) {
      setResolvedWorkspaceMembers([]);
      return;
    }
    let cancelled = false;
    getWorkspaceMembers(workspaceMembers, currentWorkspace.ownerId)
      .then(members => { if (!cancelled) setResolvedWorkspaceMembers(members); });
    return () => { cancelled = true; };
  }, [currentWorkspace?.id]);

  // Persist the user's last-active workspace so the SERVER can scope plain-message pushes to it:
  // notify-chat-message skips a recipient whose lastActiveWorkspaceId != the message's workspace.
  // Must live in Firestore (not localStorage) so OFFLINE recipients get the right decision. The
  // effect fires only on user/workspace change → no redundant writes. @mention pushes are NOT scoped
  // (notify-mention is untouched). A missed write only means one wrong push decision (lower-stakes
  // than readState), so a plain updateDoc-on-change is acceptable for v1.
  useEffect(() => {
    if (!user || !currentWorkspaceId) return;
    updateDoc(doc(db, 'users', user.uid), { lastActiveWorkspaceId: currentWorkspaceId }).catch((err) =>
      console.error('Failed to persist lastActiveWorkspaceId:', err),
    );
  }, [user?.uid, currentWorkspaceId]);

  // @mention glow + foreground notif. mentionedWorkspaceIds = workspace ids that have ≥1 unread
  // mention of this user (cross-workspace) — drives the switcher name glow. The listener below is
  // global (alive regardless of which workspace is open): the FIRST cross-workspace activity signal.
  const [mentionedWorkspaceIds, setMentionedWorkspaceIds] = useState<Set<string>>(new Set());
  // Refs read inside the mentions snapshot without re-subscribing: the currently-open workspace id,
  // and the mention doc ids we've already fired a notif for (suppresses notifs for pre-existing
  // mentions on mount; GC'd as docs are deleted on read so the set can't grow unbounded).
  const currentWsIdRef = useRef<string | null>(currentWorkspaceId);
  const seenMentionIdsRef = useRef<Set<string>>(new Set());

  // Mark as read when chat opens/closes (MUST come before unread listener). AWAITS the Firestore
  // write and only clears the glow (setUnreadCount(0)) on success — previously the write was
  // fire-and-forget and setUnreadCount(0) ran immediately, so a write lost to a tab close / device
  // sleep / dropped connection (before the server round-trip finished) silently cleared the glow
  // while the read state was never saved → phantom glow on the next cold start. Now a failed write
  // leaves the glow so the next open retries. The write is also flushed on tab-hidden (next effect)
  // and persisted via IndexedDB (firebase.ts), so it survives the common close paths.
  useEffect(() => {
    const prevShowChat = prevShowChatRef.current;
    prevShowChatRef.current = showChat;

    if (currentWorkspaceId && user && prevShowChat !== showChat) {
      void (async () => {
        try {
          // Derive lastReadAt from the newest message's already-resolved createdAt so it shares the
          // same time base as the messages it is compared against — no independent serverTimestamp
          // skew that could leave the newest message falsely unread (Cause C). Empty workspace →
          // no message → markWorkspaceChatRead falls back to serverTimestamp().
          let newestSeenCreatedAt: Timestamp | undefined;
          const newestSnap = await getDocs(query(
            collection(db, 'workspaces', currentWorkspaceId, 'messages'),
            orderBy('createdAt', 'desc'),
            limit(1),
          ));
          const newest = newestSnap.docs[0];
          if (newest) newestSeenCreatedAt = newest.data().createdAt as Timestamp | undefined;

          await markWorkspaceChatRead(currentWorkspaceId, user.uid, newestSeenCreatedAt);
          setUnreadCount(0); // only clear the glow once the write actually committed
          // Reading this workspace's chat also clears its @mention glow (deletes the mention docs
          // for this workspace; the mentions listener sees the removal → glow clears).
          void clearWorkspaceMentions(user.uid, currentWorkspaceId);
        } catch (err) {
          // Don't clear the glow on failure — it correctly persists so the next open retries.
          console.error('Failed to mark chat read:', err);
        }
      })();
    }
  }, [showChat, currentWorkspaceId, user]);

  // Flush pending Firestore writes when the tab is hidden / unloaded, so an in-flight mark-read
  // write (above) is pushed to the backend before the device sleeps or the tab is switched away —
  // the common close path that previously lost the write. visibilitychange covers backgrounding
  // (mobile swipe-away, tab switch, minimize); pagehide is belt-and-suspenders for navigation /
  // close. Non-blocking (fire-and-forget); persistence (firebase.ts) backstops anything still in
  // flight when the tab is ultimately torn down.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const flush = () => { void waitForPendingWrites(db).catch(() => {}); };
    const onVisibility = () => { if (document.visibilityState === 'hidden') flush(); };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', flush);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', flush);
    };
  }, []);

  // Lightweight unread workspace chat counter — no decryption needed
  useEffect(() => {
    // Unsubscribe from previous listener
    if (unreadUnsubRef.current) {
      unreadUnsubRef.current();
      unreadUnsubRef.current = null;
    }

    // Only listen when: logged in, workspace selected, and chat is closed
    if (!user || !currentWorkspaceId || showChat) {
      setUnreadCount(0);
      return;
    }

    let cancelled = false;
    let unsub: (() => void) | null = null;

    (async () => {
      // 1) Read baseline (or initialize) BEFORE subscribing
      let lastReadTime = await getLastRead(currentWorkspaceId, user.uid);
      if (cancelled) return;

      if (!lastReadTime) {
        // No read state yet — baseline = newest existing message time (or now if empty)
        const newestSnap = await getDocs(query(
          collection(db, 'workspaces', currentWorkspaceId, 'messages'),
          orderBy('createdAt', 'desc'),
          limit(1),
        ));
        if (cancelled) return;
        const newest = newestSnap.docs[0];
        lastReadTime = newest
          ? (newest.data().createdAt as Timestamp).toDate()
          : new Date();
        await initReadState(currentWorkspaceId, user.uid, lastReadTime);
        if (cancelled) return;
      }

      // 2) Subscribe only after baseline is known — no async inside onSnapshot
      const q = query(
        collection(db, 'workspaces', currentWorkspaceId, 'messages'),
        orderBy('createdAt', 'desc'),
        limit(50),
      );
      unsub = onSnapshot(q, (snap) => {
        if (cancelled) return;                       // ← stale-listener guard
        let count = 0;
        snap.forEach((d) => {
          const data = d.data();
          // Own messages never count as unread (mirrors the foreground notification listener) —
          // also defends against createdAt/lastReadAt skew on the user's own messages (Cause C).
          if (data.senderId === user.uid) return;
          const ts = data.createdAt as Timestamp | undefined;
          if (ts && ts.toDate() > lastReadTime!) count++;
        });
        setUnreadCount(count);
      }, (err) => {
        console.warn('Unread listener error:', err.message);
        if (!cancelled) setUnreadCount(0);
      });
      unreadUnsubRef.current = unsub;
    })();

    return () => {
      cancelled = true;
      unsub?.();
      unreadUnsubRef.current = null;
    };
  }, [user, currentWorkspaceId, showChat]);

  // --- Foreground desktop chat notifications (separate from the unread counter) ---

  // Init notif permission (sync). The mute flag is server-honored, so it lives on the user doc and is
  // loaded below once the user is known. The chat-open prompt now uses a session-only ref (no
  // permanent "already asked" flag), so there is nothing to restore from localStorage here.
  useEffect(() => {
    setNotifPermission(getNotificationPermission());
  }, []);

  // Load the server-honored mute flag from users/{uid}.notifMuted so the foreground gate and the push
  // route agree on the same value across all of the user's devices.
  useEffect(() => {
    if (!user) { setNotifMuted(false); return; }
    let cancelled = false;
    getDoc(doc(db, 'users', user.uid))
      .then((snap) => {
        if (cancelled) return;
        setNotifMuted(!!snap.data()?.notifMuted);
        // Default ON — use ?? true, NOT !! (!!undefined === false would hide the footer for everyone).
        setFooterEnabled(snap.data()?.footerEnabled ?? true);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [user]);

  // Re-read permission when Settings opens (can change in browser site settings).
  useEffect(() => {
    if (showSettingsModal) setNotifPermission(getNotificationPermission());
  }, [showSettingsModal]);

  const persistMuted = (v: boolean) => {
    setNotifMuted(v); // optimistic so the foreground gate updates instantly
    if (user) {
      updateDoc(doc(db, 'users', user.uid), { notifMuted: v }).catch(() => {});
    }
  };

  // Approach-C footer toggle — persisted to Firestore users/{uid}.footerEnabled (default ON), the
  // same pattern as persistMuted. Optimistic so the gate flips instantly; syncs across devices.
  const persistFooterEnabled = (v: boolean) => {
    setFooterEnabled(v); // optimistic
    if (user) {
      updateDoc(doc(db, 'users', user.uid), { footerEnabled: v }).catch(() => {});
    }
  };

  const onToggleFooterEnabled = () => persistFooterEnabled(!footerEnabled);
  // The footer's OWN "Hide footer" button → one-directional OFF (NOT the bidirectional Settings
  // toggle). Footer runs the close-modal → smooth-scroll-to-top → onComplete sequence itself and
  // calls this only once the footer has retracted out of view; persistFooterEnabled(false) then
  // flips footerActive → false, unmounting the footer and disabling dissolve/magnet atomically.
  const onHideFooter = () => persistFooterEnabled(false);

  // The Settings switch is THE reliable way to enable push. Its checked state (computed in
  // SettingsModal as `permission === 'granted' && !notifMuted`) decides direction:
  //  - Turning ON: if permission is still 'default', ask for it; then register the device token
  //    (ensureFcmToken) and unmute. Works identically for brand-new AND pre-push accounts (which
  //    were previously stuck with no prompt → no grant → no token).
  //  - Turning OFF: mute only — never changes the permission.
  // 'denied' can't reach here (the switch is disabled for it) but is guarded anyway.
  const handleToggleNotifications = async () => {
    const current = getNotificationPermission();
    setNotifPermission(current);
    if (!isNotificationsSupported()) return;
    if (current === 'denied') return;

    const isOn = current === 'granted' && !notifMuted; // mirrors the switch's checked state
    if (!isOn) {
      // Turning ON.
      if (current === 'default') {
        const result = await requestNotificationPermission();
        setNotifPermission(result);
        if (result !== 'granted') return; // dismissed or denied → stay off, don't register/unmute
      }
      // permission is now 'granted' (was already granted, or just granted above)
      void ensureFcmToken();
      persistMuted(false);
    } else {
      // Turning OFF.
      persistMuted(true);
    }
  };

  // Keep a ref so the notif listener reads the latest "actively viewing?" value
  // without re-subscribing on every showChat/chatMode change.
  useEffect(() => {
    viewingGroupChatRef.current = showChat && chatMode === 'group';
    currentWsIdRef.current = currentWorkspaceId;
  }, [showChat, chatMode, currentWorkspaceId]);

  // Active only when supported, permitted, and not muted.
  const notifsActive = isNotificationsSupported() && notifPermission === 'granted' && !notifMuted;

  // Notif listener — fires an OS notification for new group messages when the user
  // is NOT actively viewing the group chat. Reads plain senderName (no decryption).
  useEffect(() => {
    if (!user || !currentWorkspaceId || !notifsActive) return;

    let cancelled = false;
    let unsub: (() => void) | null = null;
    let lastSeenTs: Date | null = null; // baseline; null until first snapshot
    let lastNotifiedAt = 0;              // throttle timestamp (ms)

    const q = query(
      collection(db, 'workspaces', currentWorkspaceId, 'messages'),
      orderBy('createdAt', 'desc'),
      limit(20),
    );

    unsub = onSnapshot(q, (snap) => {
      if (cancelled) return;
      if (snap.empty) return;

      // First snapshot → set baseline to the newest message, notify nothing.
      if (lastSeenTs === null) {
        const first = snap.docs[0]?.data()?.createdAt as Timestamp | undefined;
        lastSeenTs = first ? first.toDate() : new Date();
        return;
      }

      // Walk new messages (newest first). Advance baseline for each seen message so
      // viewed/throttled ones aren't backfilled; only fire when all conditions hold.
      for (const d of snap.docs) {
        const data = d.data();
        const ts = data.createdAt as Timestamp | undefined;
        if (!ts) continue; // null createdAt (offline-pending) → skip
        const msgDate = ts.toDate();
        if (msgDate <= lastSeenTs) continue;
        if (data.senderId === user.uid) { lastSeenTs = msgDate; continue; } // own msg: seen, no notify
        // An @mention of this user is delivered by the MENTION listener (the richer "tagged you"
        // notif + workspace-switch tap), so skip the generic chat notif here — otherwise one message
        // yields two OS notifications. mentionedUids is plaintext on the doc (no decryption needed).
        const mentioned = data.mentionedUids as string[] | undefined;
        if (Array.isArray(mentioned) && mentioned.includes(user.uid)) { lastSeenTs = msgDate; continue; }
        lastSeenTs = msgDate; // advance baseline (seen)

        // Re-check permission at fire time (can change outside the app).
        if (getNotificationPermission() !== 'granted') continue;
        // Only notify when the tab is VISIBLE and NOT actively viewing the chat. When the tab is
        // hidden, defer to the FCM push (which fires for backgrounded/closed tabs) — otherwise both
        // fire and the user gets a double notification for one message.
        if (document.hidden || viewingGroupChatRef.current) continue;
        // Throttle: max one notification per 3 seconds (spam control).
        if (Date.now() - lastNotifiedAt < 3000) continue;
        lastNotifiedAt = Date.now();

        showChatNotification(
          data.senderName || 'Someone',
          currentWorkspace?.name || 'workspace',
          () => { setChatMode('group'); retractFooterIfUp(); setShowChat(true); },
        );
      }
    }, (err) => {
      // permission-denied fires when the user loses workspace access (kick/leave/delete).
      // Benign — the workspaces listener redirects them and this effect's cleanup unsubscribes.
    });

    return () => {
      cancelled = true;
      unsub?.();
    };
  }, [user, currentWorkspaceId, notifsActive, currentWorkspace?.name]);

  // Register the chat + FCM service worker once on mount (all platforms except iOS Safari).
  useEffect(() => {
    registerChatServiceWorker();
  }, []);

  // Register this device for push (FCM token) on app load when notifications are already granted,
  // so returning users who previously allowed them still register. Needs a signed-in user (the
  // token is stored under their uid); foreground permission grants re-call ensureFcmToken() too.
  useEffect(() => {
    if (!user) return;
    if (isNotificationsSupported() && getNotificationPermission() === 'granted') {
      void ensureFcmToken();
    }
  }, [user]);

  // Keep openChatFromTapRef pointing at the latest "switch workspace (if a member) + open chat"
  // logic, so the stable SW message listener below always calls a current closure.
  useEffect(() => {
    openChatFromTapRef.current = (workspaceId?: string) => {
      if (
        workspaceId &&
        user &&
        workspaces.some((w) => w.id === workspaceId && (w.members ?? []).includes(user.uid))
      ) {
        switchWorkspace(workspaceId);
      }
      setChatMode('group');
      retractFooterIfUp();
      setShowChat(true);
    };
  }, [user, workspaces, switchWorkspace]);

  // Deep-link from a notification tap that launched the app: /?chat=<workspaceId>. Switch to that
  // workspace (if a member) and open the group chat. We mark "handled" ONLY once the chat actually
  // opens (or when there's no chat param) — if the target workspace isn't loaded yet we return
  // WITHOUT setting the flag, so this retries on the next workspaces change instead of silently
  // giving up on a fresh app load (the race that left the chat panel closed after a tap).
  useEffect(() => {
    if (deepLinkHandledRef.current || !user || workspacesLoading) return;
    const chatWsId = new URLSearchParams(window.location.search).get('chat');
    if (!chatWsId) { deepLinkHandledRef.current = true; return; }
    const isMember = workspaces.some((w) => w.id === chatWsId && (w.members ?? []).includes(user.uid));
    if (!isMember) return; // workspace not hydrated yet (or no access) — retry on the next workspaces change
    switchWorkspace(chatWsId);
    setChatMode('group');
    retractFooterIfUp();
    setShowChat(true);
    deepLinkHandledRef.current = true;
  }, [user, workspaces, workspacesLoading, switchWorkspace]);

  // Open the group chat when the service worker reports a notification tap. workspaceId (from the
  // push's data) switches to that workspace first. Desktop foreground notifications have no
  // workspaceId and fall back to just opening the chat.
  useEffect(() => {
    if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;
    const handler = (event: Event) => {
      const data = (event as MessageEvent).data;
      if (data?.type === 'OPEN_CHAT') {
        openChatFromTapRef.current(data.workspaceId);
      }
    };
    navigator.serviceWorker.addEventListener('message', handler);
    return () => navigator.serviceWorker.removeEventListener('message', handler);
  }, []);

  // Global @mention listener — the FIRST cross-workspace activity signal. Subscribes to ALL of this
  // user's mention docs (every workspace), derives the glow set (mentionedWorkspaceIds), and fires a
  // foreground system notification for each NEW mention. The first snapshot only SEEDS the seen-id
  // set (no notif) so a page load with pending mentions doesn't spam. Stays alive across workspace
  // switches (deps: [user] only); currentWsIdRef/viewingGroupChatRef keep the notif gate current.
  useEffect(() => {
    if (!user) {
      setMentionedWorkspaceIds(new Set());
      seenMentionIdsRef.current = new Set();
      return;
    }
    const seen = seenMentionIdsRef.current;
    let firstSnap = true;
    const q = query(collection(db, 'users', user.uid, 'mentions'));
    const unsub = onSnapshot(q, (snap) => {
      const wsSet = new Set<string>();
      snap.forEach((d) => {
        const wsId = d.get('workspaceId') as string | undefined;
        if (wsId) wsSet.add(wsId);
        if (!seen.has(d.id)) {
          seen.add(d.id);
          if (!firstSnap) {
            const senderName = (d.get('senderName') as string | undefined) || 'Someone';
            const wsName = (d.get('workspaceName') as string | undefined) || 'workspace';
            // Skip the OS notif when the tab is hidden (the FCM/SW mention push handles closed-app)
            // or the user is already viewing that workspace's group chat.
            const viewingThis = !!wsId && wsId === currentWsIdRef.current && viewingGroupChatRef.current;
            if (wsId && document.visibilityState === 'visible' && !viewingThis && getNotificationPermission() === 'granted') {
              showMentionNotification(senderName, wsName, wsId, () => openChatFromTapRef.current(wsId || undefined));
            }
          }
        }
      });
      firstSnap = false;
      setMentionedWorkspaceIds(wsSet);
      // Drop seen ids whose docs were deleted (on read) so the set can't grow without bound.
      const live = new Set(snap.docs.map((d) => d.id));
      for (const id of seen) if (!live.has(id)) seen.delete(id);
    }, (err) => {
      console.warn('Mentions listener error:', err.message);
    });
    return () => unsub();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  // Toggle chat panel — auto-switch to workspace tab when unreads exist.
  // Passed down as onToggleChat so the layout chat buttons hit this (and thus the
  // Option B notification-permission prompt) instead of an inline handler.
  const handleToggleChat = useCallback(() => {
    // Ask for notification permission on the first chat open of the session (user gesture), so
    // accounts that predate the push feature get prompted instead of being silently skipped. The
    // guard is session-only (plain ref, resets every page load — NO localStorage), so it caps at one
    // prompt per tab session but never permanently suppresses old accounts.
    if (!showChat && !chatNotifPromptedRef.current && isNotificationsSupported() && getNotificationPermission() === 'default') {
      chatNotifPromptedRef.current = true;
      requestNotificationPermission().then(p => setNotifPermission(p));
    }
    if (!showChat && unreadCount > 0) {
      setChatMode('group');
    }
    if (!showChat) retractFooterIfUp(); // retract the footer only when chat is OPENING (no-op at scrollY 0)
    setShowChat(!showChat);
  }, [showChat, unreadCount]);

  // Handle edit drop — decrypt text drops, file drops just need metadata
  const handleEditDrop = async (drop: Drop) => {
    retractFooterIfUp(); // retract the footer before the edit overlay mounts (no-op at scrollY 0)
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
  const handleEditSubmit = async (drop: Drop, updates: { name?: string; content?: string; category?: string | null; categories?: string[]; expirationOption?: ExpirationOption; imageFile?: File | null; imageRemoved?: boolean; locked?: boolean }): Promise<boolean> => {
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

  // Approach-C: footer + dissolve + magnet are a large-desktop (>=1400px / `wide`) feature. Below
  // 1400px the footer is not rendered, so the dissolve/magnet self-heal polls never find
  // #footer-shell and stay unattached (plain single-screen app). SSR-safe (false pre-mount).
  const isWide = useIsWide();
  // The footer (dissolve + magnet) is active ONLY on wide screens (>=1400px) AND when the user
  // hasn't toggled it off in Settings (footerEnabled, default ON). This single flag gates the
  // render AND both hooks so toggling off fully removes the footer/dissolve/magnet and stops the
  // self-heal polls (same gate the hooks' Effect A uses — bailing here prevents a perpetual poll).
  const footerActive = isWide && footerEnabled;
  // Approach-C Part 2: the dissolve (app lifts + fades as the footer rises). Frozen solid while
  // chat or a modal is open; off under reduced-motion. No-ops on login/loading (elements absent).
  useDissolve(showChat, footerActive);
  // Approach-C Part 3: the magnetic footer wheel-gate (resist at the app<->footer boundary, glide
  // through on sustained intent). Desktop-pointer (wheel) only; off under reduced-motion; inert
  // when the footer is absent. No-ops on login/loading/verify.
  useMagnet(footerActive);

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
      const bgColor = theme === 'dark' ? '#0D0D0D' : theme === 'minimal' ? '#C5C9B8' : '#FFFEF5';
      const textColor = theme === 'dark' ? '#ffffff' : '#1a1a1a';
      const mutedColor = theme === 'dark' ? '#888' : theme === 'minimal' ? '#4a4a4a' : '#666';
      const borderColor = theme === 'dark' ? '#333' : theme === 'minimal' ? '#b0b4a5' : '#e0e0e0';
      const cardBg = theme === 'dark' ? '#1a1a1a' : theme === 'minimal' ? '#C5C9B8' : '#FDFCF9';
      const glassBg = theme === 'dark' ? 'rgba(255,255,255,0.05)' : theme === 'minimal' ? 'rgba(255,255,255,0.3)' : 'rgba(255,255,255,0.7)';
      const accentBg = theme === 'dark' ? '#ffffff' : '#1a1a1a';
      const accentText = theme === 'dark' ? '#0D0D0D' : '#ffffff';
      const font = 'font-[family-name:var(--font-raleway)]';

      const storyCards = [
        {
          num: '01', title: 'Drop', desc: 'Upload from any device,\nno installation needed',
          backTitle: 'How to Drop',
          backList: ['Drag & drop multiple files', 'Click to open file picker', 'Paste images from clipboard', 'Type or paste text snippets', 'Voice-to-text via Whisper AI', 'Any file type, up to 500MB'],
          backIcon: 'M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5',
        },
        {
          num: '02', title: 'Store', desc: 'Auto-expires from 1 hour\nto forever',
          backTitle: 'How Storage Works',
          backList: ['Files on Cloudflare R2', 'Metadata in Firebase Firestore', 'AES-256-GCM encryption', 'Auto-expire: 1h, 2h, 6h, 24h, or forever', 'Unlimited drops per workspace', 'Expired drops auto-deleted'],
          backIcon: 'M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z',
        },
        {
          num: '03', title: 'Pickup', desc: 'Access from any device,\nsecure & encrypted',
          backTitle: 'How Pickup Works',
          backList: ['Share via unique link', 'No account needed to view', 'Preview images, text, YouTube, video', 'Copy text to clipboard', 'Works on any device', 'Links expire with the drop'],
          backIcon: 'M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z',
        },
      ];

      const handleAboutClick = (e: React.MouseEvent) => {
        e.preventDefault();
        document.body.style.background = bgColor;
        setPageTransition('fade-out');
        setTimeout(() => {
          router.push('/about');
        }, 500);
      };

      return (
        <div className={`min-h-screen relative overflow-hidden transition-opacity duration-500 ease-out ${pageTransition === 'fade-out' ? 'opacity-0' : pageTransition === 'fade-in' ? 'opacity-100' : 'opacity-100'}`} style={{ background: bgColor, color: textColor, transition: 'background-color 0.5s, color 0.5s, opacity 500ms ease-out' }}>
          {/* Background gradient */}
          <div className="fixed inset-0 pointer-events-none z-0" style={{
            background: `radial-gradient(circle at 30% 40%, ${accentBg} 0%, transparent 50%), radial-gradient(circle at 70% 60%, ${accentBg} 0%, transparent 50%)`,
            opacity: 0.015,
          }} />

          <div className="relative z-10 min-h-screen flex flex-col" style={{ padding: '2rem' }}>
            {/* Header - smooth fade in */}
            <header className="text-center mb-10" style={{ opacity: 0, animation: 'fadeInUp 800ms ease forwards' }}>
              <div className="flex items-center justify-center gap-2 mb-6">
                {/* Diamond logo - simple fade in */}
                <div className="w-3 h-3 rotate-45" style={{
                  backgroundColor: accentBg,
                  opacity: 0,
                  animation: 'fadeIn 600ms ease 0ms forwards'
                }} />
                <span className={`${font} text-xl font-medium tracking-[-0.02em]`} style={{ opacity: 0, animation: 'fadeInUp 800ms ease 100ms forwards' }}>DropSync</span>
              </div>
              <h1 className="text-[clamp(1.5rem,4vw,2.5rem)] font-light tracking-[-0.02em] leading-tight max-w-[600px] mx-auto font-[family-name:var(--font-raleway)]">
                <span style={{ display: 'inline-block', opacity: 0, animation: 'fadeInUp 800ms ease 200ms forwards' }}>Drop files. </span>
                <span style={{ display: 'inline-block', opacity: 0, animation: 'fadeInUp 800ms ease 300ms forwards' }}>Store temporarily. </span>
                <span style={{ display: 'inline-block', opacity: 0, animation: 'fadeInUp 800ms ease 400ms forwards' }}>Pickup anywhere.</span>
              </h1>
            </header>

            {/* Auth section - MOBILE ONLY: above cards, smaller buttons */}
            <div className="auth-section text-center sm:hidden mb-8" style={{ opacity: 0, animation: 'fadeInUp 800ms ease 600ms forwards' }}>
              <p className="text-xs uppercase tracking-[0.15em] mb-3 font-[family-name:var(--font-raleway)]" style={{ color: mutedColor }}>GET STARTED</p>
              <div className="flex flex-col items-center gap-2">
                <button
                  onClick={signIn}
                  className="inline-flex items-center gap-2 px-5 py-2.5 border rounded-lg text-xs font-medium font-[family-name:var(--font-raleway)]"
                  style={{ borderColor, color: textColor, background: 'transparent' }}
                >
                  <svg viewBox="0 0 24 24" className="w-4 h-4" style={{ color: textColor }}>
                    <path fill="currentColor" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                    <path fill="currentColor" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                    <path fill="currentColor" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                    <path fill="currentColor" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
                  </svg>
                  Sign in with Google
                </button>
                <button
                  onClick={() => setShowAuthModal(true)}
                  className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg text-xs font-medium font-[family-name:var(--font-raleway)]"
                  style={{ background: accentBg, color: accentText }}
                >
                  <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5" className="w-4 h-4">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M21.75 6.75v10.5a2.25 2.25 0 01-2.25 2.25h-15a2.25 2.25 0 01-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25m19.5 0v.243a2.25 2.25 0 01-1.07 1.916l-7.5 4.615a2.25 2.25 0 01-2.36 0L3.32 8.91a2.25 2.25 0 01-1.07-1.916V6.75" />
                  </svg>
                  Sign in with Email
                </button>
              </div>
            </div>

            {/* Story container - centered with proper spacing */}
            <div className="flex-1 flex flex-col items-center justify-center">
              <div className="story-container flex items-center justify-center flex-wrap w-full max-w-[1200px] mx-auto" style={{ gap: '2rem' }}>
                {storyCards.map((card, cardIdx) => (
                  <React.Fragment key={cardIdx}>
                    {/* Arrow connector before card 2 and 3 */}
                    {cardIdx > 0 && (
                      <div className="arrow-connector w-10 h-10 flex items-center justify-center" style={{
                        opacity: 0,
                        animation: `fadeIn 600ms ease ${400 + cardIdx * 100}ms forwards`,
                      }}>
                        <svg viewBox="0 0 24 24" fill="none" stroke={accentBg} strokeWidth="1.5" className="w-6 h-6"><path d="M5 12h14M12 5l7 7-7 7" /></svg>
                      </div>
                    )}

                    {/* Story card - smooth fade in up with stagger */}
                    <div className="story-card flex-1 min-w-[280px] max-w-[340px] aspect-square relative rounded-[24px] overflow-hidden cursor-pointer"
                      style={{
                        background: cardBg, border: `1px solid ${borderColor}`,
                        backdropFilter: 'blur(20px)',
                        opacity: 0,
                        animation: `fadeInUp 800ms ease ${400 + cardIdx * 100}ms forwards`,
                      }}>
                      {/* Card number */}
                      <div className="absolute top-6 left-6 text-xs font-medium tracking-[0.1em] z-10 font-[family-name:var(--font-raleway)]" style={{ color: mutedColor }}>{card.num}</div>

                      {/* Front */}
                      <div className="card-front absolute inset-0 flex flex-col items-center justify-center" style={{ zIndex: 5, padding: '2rem' }}>
                        <div className="card-visual w-full h-[60%] flex items-center justify-center relative">
                          {/* Drop card visual - phone with animated file */}
                          {cardIdx === 0 && (
                            <>
                              {/* Phone outline */}
                              <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[50px] h-[90px] border-2 rounded-xl flex flex-col items-center" style={{ borderColor: accentBg, opacity: 0.7 }}>
                                <div className="w-[18px] h-[3px] mt-[5px] rounded-sm" style={{ background: accentBg, opacity: 0.3 }} />
                                <div className="w-[10px] h-[10px] border-2 rounded-full mt-auto mb-[5px]" style={{ borderColor: accentBg, opacity: 0.2 }} />
                              </div>
                              {/* Animated file card */}
                              <div className="file-card file-card-animated absolute left-1/2 top-[15%] w-[140px] h-[80px] rounded-2xl flex items-center gap-3 px-4"
                                style={{ background: glassBg, border: `1px solid ${borderColor}`, backdropFilter: 'blur(20px)', boxShadow: `0 4px 24px rgba(0,0,0,0.05), 0 0 0 1px rgba(255,255,255,0.1) inset`, animation: 'fileTravel 4s cubic-bezier(0.4,0,0.2,1) infinite' }}>
                                <div className="w-9 h-9 rounded-[10px] flex items-center justify-center flex-shrink-0" style={{ background: 'linear-gradient(135deg, #FF6B6B, #ee5a24)' }}>
                                  <svg viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" className="w-5 h-5"><path d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" /></svg>
                                </div>
                                <div className="min-w-0">
                                  <div className="text-xs font-medium truncate" style={{ color: textColor }}>report.pdf</div>
                                  <div className="text-[10px]" style={{ color: mutedColor }}>2.4 MB</div>
                                </div>
                              </div>
                            </>
                          )}

                          {/* Store card visual - timer */}
                          {cardIdx === 1 && (
                            <div className="timer-visual flex flex-col items-center gap-2">
                              <div className="timer-ring-visual w-[72px] h-[72px] rounded-full border-2 relative" style={{ borderColor }}>
                                <div className="timer-progress-ring absolute inset-[-2px] rounded-full border-[3px] border-transparent" style={{ borderTopColor: accentBg, animation: 'timerRotate 3s linear infinite' }} />
                                <div className="timer-label absolute inset-0 flex items-center justify-center text-xl font-semibold" style={{ color: accentBg }}>1h</div>
                              </div>
                              <div className="timer-subtext text-[10px] uppercase tracking-[0.1em]" style={{ color: mutedColor }}>AUTO-EXPIRE</div>
                            </div>
                          )}

                          {/* Pickup card visual - laptop with files */}
                          {cardIdx === 2 && (
                            <>
                              {/* Laptop base */}
                              <div className="device-laptop absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2" style={{ opacity: 0.7 }}>
                                <div className="w-[80px] h-[56px] border-2 rounded-t-lg relative" style={{ borderColor: accentBg, background: cardBg }}>
                                  <div className="absolute inset-0 flex items-center justify-center">
                                    <svg viewBox="0 0 24 24" fill="none" stroke={accentBg} strokeWidth="1.5" className="w-6 h-6" style={{ opacity: 0.5 }}>
                                      <path d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                                    </svg>
                                  </div>
                                </div>
                                <div className="w-[98px] h-[7px] border-2 border-t-0 rounded-b-md mx-[-9px]" style={{ borderColor: accentBg }} />
                              </div>
                              {/* Animated pickup files */}
                              <div className="pickup-files absolute left-1/2 -translate-x-1/2 flex flex-col gap-2" style={{ top: '15%' }}>
                                {[
                                  { grad: 'linear-gradient(135deg, #FF6B6B, #ee5a24)', path: 'M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z', delay: '0s' },
                                  { grad: 'linear-gradient(135deg, #4834d4, #686de0)', path: 'M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z', delay: '0.8s' },
                                  { grad: 'linear-gradient(135deg, #6ab04c, #badc58)', path: 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z', delay: '1.6s' },
                                ].map((file, i) => (
                                  <div key={i} className="pickup-file flex items-center justify-center" style={{ animation: `pickupDrop 3s cubic-bezier(0.4,0,0.2,1) ${file.delay} infinite` }}>
                                    <div className="file-icon-small w-7 h-7 rounded-lg flex items-center justify-center" style={{ background: file.grad }}>
                                      <svg viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" className="w-[14px] h-[14px]"><path d={file.path} /></svg>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            </>
                          )}
                        </div>

                        <div className="card-content text-center font-[family-name:var(--font-raleway)]" style={{ marginTop: '1.5rem' }}>
                          <div className="card-title text-sm font-medium mb-1">{card.title}</div>
                          <div className="card-desc text-sm whitespace-pre-line" style={{ color: mutedColor }}>{card.desc}</div>
                        </div>
                      </div>

                      {/* Back */}
                      <div className="card-back absolute inset-0 flex flex-col items-center justify-center font-[family-name:var(--font-raleway)]" style={{ zIndex: 5, padding: '2rem' }}>
                        <div className="card-back-content text-center">
                          <div className="card-back-icon w-12 h-12 mx-auto mb-4 rounded-xl border flex items-center justify-center"
                            style={{ background: glassBg, borderColor }}>
                            <svg viewBox="0 0 24 24" fill="none" stroke={accentBg} strokeWidth="1.5" className="w-6 h-6"><path d={card.backIcon} /></svg>
                          </div>
                          <div className="card-back-title text-sm font-semibold mb-3" style={{ color: accentBg }}>{card.backTitle}</div>
                          <ul className="card-back-list text-left list-none p-0 m-0">
                            {card.backList.map((item, i) => (
                              <li key={i} className="text-xs py-[0.35rem] flex items-start gap-2" style={{ color: mutedColor }}>
                                <span className="font-medium flex-shrink-0" style={{ color: accentBg }}>→</span>
                                {item}
                              </li>
                            ))}
                          </ul>
                        </div>
                      </div>
                    </div>
                  </React.Fragment>
                ))}
              </div>

              {/* Auth section - DESKTOP ONLY */}
              <div className="auth-section text-center mt-12 hidden sm:block" style={{ opacity: 0, animation: 'fadeInUp 800ms ease 800ms forwards' }}>
                <p className="text-xs uppercase tracking-[0.15em] mb-4 font-[family-name:var(--font-raleway)]" style={{ color: mutedColor }}>GET STARTED</p>
                <div className="flex flex-col items-center gap-3">
                  <button
                    onClick={signIn}
                    className="btn btn-outline inline-flex items-center gap-3 px-8 py-3.5 border rounded-[3rem] text-sm font-medium transition-all duration-300 hover:-translate-y-0.5 hover:shadow-lg font-[family-name:var(--font-raleway)]"
                    style={{ borderColor, color: textColor, background: 'transparent' }}
                  >
                    <svg viewBox="0 0 24 24" className="w-5 h-5" style={{ color: textColor }}>
                      <path fill="currentColor" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                      <path fill="currentColor" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                      <path fill="currentColor" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                      <path fill="currentColor" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
                    </svg>
                    Sign in with Google
                  </button>
                  <button
                    onClick={() => setShowAuthModal(true)}
                    className="btn btn-solid inline-flex items-center gap-3 px-8 py-3.5 rounded-[3rem] text-sm font-medium transition-all duration-300 hover:-translate-y-0.5 hover:shadow-lg font-[family-name:var(--font-raleway)]"
                    style={{ background: accentBg, color: accentText, border: `1px solid ${accentBg}` }}
                  >
                    <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5" className="w-5 h-5">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M21.75 6.75v10.5a2.25 2.25 0 01-2.25 2.25h-15a2.25 2.25 0 01-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25m19.5 0v.243a2.25 2.25 0 01-1.07 1.916l-7.5 4.615a2.25 2.25 0 01-2.36 0L3.32 8.91a2.25 2.25 0 01-1.07-1.916V6.75" />
                    </svg>
                    Sign in with Email
                  </button>
                </div>
              </div>
            </div>

            {/* Footer - fade in */}
            <footer className="flex justify-between items-center px-4 sm:px-6 lg:px-8 py-6 text-xs tracking-[0.05em] font-[family-name:var(--font-raleway)]" style={{ color: mutedColor, opacity: 0, animation: 'fadeIn 800ms ease 1000ms forwards' }}>
              <a href="/about" onClick={handleAboutClick} className="hover:opacity-70 transition-opacity cursor-pointer">About</a>
              <a href="/privacy" target="_blank" rel="noopener noreferrer" style={{ marginLeft: '104px' }} className="hover:opacity-70 transition-opacity cursor-pointer">Privacy Policy</a>
              <span className="hidden sm:inline">Max 500MB · Unlimited drops</span>
            </footer>
          </div>

          {/* Auth & Verify Modals */}
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
              <Link href="/about" className="hover:text-[#1A1A1A] cursor-pointer transition-colors">ABOUT</Link>
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
                Auto-expire: 1h - Forever
                <span className="hidden sm:inline"> • Max 500MB • Unlimited drops</span>
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
                  <span className="text-white">UNLIMITED DROPS</span>
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

        {/* Footer */}
        <div className={`py-4 px-8 border-t ${themeColors.isDark ? 'bg-[#0D0D0D] border-white/10' : 'bg-[#FAF7F2] border-[#1A1A1A]/10'}`}>
          <div className="flex items-center justify-between">
            <Link
              href="/about"
              className={`text-[10px] font-mono uppercase tracking-wider transition-colors ${themeColors.isDark ? 'text-white/40 hover:text-white' : 'text-[#1A1A1A]/40 hover:text-[#1A1A1A]'}`}
            >
              ABOUT
            </Link>
            <a
              href="/privacy"
              target="_blank"
              rel="noopener noreferrer"
              className={`text-[10px] font-mono uppercase tracking-wider transition-colors ${themeColors.isDark ? 'text-white/40 hover:text-white' : 'text-[#1A1A1A]/40 hover:text-[#1A1A1A]'}`}
            >
              PRIVACY POLICY
            </a>
            <span className={`hidden sm:inline text-[10px] font-mono uppercase tracking-wider ${themeColors.isDark ? 'text-white/40' : 'text-[#1A1A1A]/40'}`}>
              500MB / UNLIMITED
            </span>
          </div>
        </div>
    </div>
    );
  }

  // Main app — delegate to layout component
  const layoutProps = {
    theme, setTheme, themeColors,
    user, layoutMode, setLayoutMode: handleLayoutChange,
    showChat, setShowChat,
    chatMode, setChatMode,
    unreadCount,
    onToggleChat: handleToggleChat,
    notifPermission, notifMuted, onToggleNotifications: handleToggleNotifications,
    footerEnabled, onToggleFooterEnabled,
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
    mentionedWorkspaceIds,
    switchWorkspace,
    drops, dropsLoading, refreshDrops,
    categories, handleCreateCategory, handleDeleteCategory,
    handleCreateWorkspace, handleJoinWorkspace,
    handleDeleteWorkspace, handleLeaveWorkspace, handleLeaveAndTransfer,
    onKick: handleKickMember, isKicking: isKickingMember,
    handlePreview, handleShowVerifyModal, handleCheckVerification,
    signIn, emailSignIn, signUp, resetPassword, resendVerification,
    signOutUser, updateDisplayName, reauthenticateUser,
    editDrop, setEditDrop, handleEditDrop, handleEditSubmit,
    presenceMap,
  };

  const transitionClass = layoutTransition === 'fade-out'
    ? 'layout-fade-out'
    : layoutTransition === 'fade-in'
      ? 'layout-fade-in'
      : '';

  return (
    <>
      <div id="app-shell" className={`sticky top-0 z-[1] h-[100dvh] overflow-x-hidden overflow-y-hidden ${transitionClass}`}>
        {layoutMode === 'editorial' ? <EditorialLayout {...layoutProps} /> : <ClassicLayout {...layoutProps} />}
      </div>
      {footerActive && <Footer onHideFooter={onHideFooter} />}
      {removedNotice && (
        <Toast
          message={removedNotice}
          theme={theme}
          editorial={layoutMode === 'editorial'}
          onDone={handleRemovedNoticeDone}
        />
      )}
    </>
  );
}
