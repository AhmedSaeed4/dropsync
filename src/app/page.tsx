'use client';

import { LoadingIndicator } from '@/components/LoadingIndicator';
import React, { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { useDrops } from '@/hooks/useDrops';
import { useWorkspaces } from '@/hooks/useWorkspaces';
import { useCategories } from '@/hooks/useCategories';
import { usePresence } from '@/hooks/usePresence';
import { useLiveKitCall } from '@/hooks/useLiveKitCall';
import { useCallAccess } from '@/hooks/useCallAccess';
import { useIsHoverable } from '@/hooks/useIsHoverable';
import { LiveCallMinimizedPill } from '@/components/call/LiveCallMinimizedPill';
import { ClassicLayout } from '@/components/layouts/ClassicLayout';
import { EditorialLayout } from '@/components/editorial/EditorialLayout';
import { YouTubeBackfillModal } from '@/components/YouTubeBackfillModal';
import { Landing } from '@/components/landing/Landing';
import { EditorialVerifyEmailModal } from '@/components/editorial/EditorialVerifyEmailModal';
import { getEditorialThemeColors } from '@/components/editorial/editorialTheme';
import { Toast } from '@/components/Toast';
import { Footer } from '@/components/Footer';
import { lockScroll, unlockScroll, retractFooterIfUp, retractFooterImmediately } from '@/components/SmoothScrollProvider';
import { useDissolve } from '@/hooks/useDissolve';
import { useMagnet } from '@/hooks/useMagnet';
import { useIsWide } from '@/hooks/useIsWide';
import { isAgentDropEligible } from '@/lib/agentDropEligibility';
import { AgentDropRequest, ChatDropRequest, Drop, Workspace, ExpirationOption } from '@/types';
import { initializeUserKeys, hasUserKeys, getUserKeys, ensurePublicKeyPublished } from '@/lib/keys';
import { ensureProfilePublished } from '@/lib/profiles';
import { decryptDrop, updateTextDrop, updateDropMetadata, moveDrop, getExpirationDate } from '@/lib/drops';
import { previewSig, getPrimedPreview, consumePrebuiltVideoUrl, clearPreviewPrimeCaches, primeDecryptedPreview } from '@/lib/previewPrime';
import { editorialCardCache, payloadRevision } from '@/lib/editorialCardCache';
import {
  evaluateYoutubeBackfillVisibility,
  isPasswordCategories,
  normalizeYoutubeLabels,
  subscribeBackfillDecisionState,
} from '@/lib/youtubeLabels';
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
import { reauthenticateUser, type DropSortMode } from '@/lib/auth';
import { CALL_LIMIT_MESSAGE } from '@/lib/callRoutes';
import { db } from '@/lib/firebase';
import { CURRENT_TERMS_VERSION } from '@/lib/termsVersion';
import { TermsConsentGate } from '@/components/TermsConsentGate';
import { WorkspaceArchiveModal } from '@/components/WorkspaceArchiveModal';
import { ArchiveChipStack } from '@/components/ArchiveChipStack';
import { OperationsPanel } from '@/components/OperationsPanel';
import { ArchiveProgressPanel } from '@/components/ArchiveProgressPanel';
import { getArchiveTaskManager, type ArchiveJobDescriptor } from '@/lib/archiveTaskManager';
import { requestArchiveSaveHandle } from '@/lib/archiveFormat';
import { assertCategoryWritableById, assertDropWritableById } from '@/lib/archiveJournalVisibility';
import WorkspaceOptionsModal from '@/components/WorkspaceOptionsModal';
import { startWorkspaceDeletion, runDeletionJob, resumeDeletionJobs, subscribeDeletionNotices } from '@/lib/workspaceDeletion';
import {
  exportWorkspaceArchive,
  hasLiveWorkspaceArchiveOverlap,
  importWorkspaceArchive,
  inspectWorkspaceArchive,
  workspaceArchiveFileName,
  type WorkspaceArchiveImportResult,
  type WorkspaceArchiveInspection,
  type WorkspaceArchiveProgress,
} from '@/lib/workspaceArchive';
import {
  exportPersonalArchive,
  hasLivePersonalArchiveOverlap,
  importPersonalArchive,
  inspectPersonalArchive,
  personalArchiveFileName,
  type PersonalArchiveExportResult,
  type PersonalArchiveImportResult,
  type PersonalArchiveInspection,
  type PersonalArchiveProgress,
} from '@/lib/personalArchive';
import { collection, query, orderBy, limit, onSnapshot, getDocs, getDoc, doc, setDoc, serverTimestamp, updateDoc, waitForPendingWrites, Timestamp } from 'firebase/firestore';

type Theme = 'light' | 'dark' | 'minimal';
type LayoutMode = 'classic' | 'editorial';
type TosStatus = 'unknown' | 'accepted' | 'needed' | 'error';

const THEME_STORAGE_KEY = 'dropsync_theme';
// COOKIE-FREE theme pre-paint. This module-level string is rendered as an inline <script> by the
// !themeLoaded branch below (the branch SSR always renders, since themeLoaded starts false). It runs
// during HTML parse — BEFORE first paint — reads `dropsync_theme` from localStorage, and paints
// document.body.background so the hard-refresh first paint is the user's real theme color, NOT the
// browser default white nor the globals.css cream. 2-way map that MATCHES the post-mount body-bg
// useEffect below (L281-284: dark → #000000, else → '' which reverts to the CSS cream #F5F2ED), so
// there is NO color-swap once React mounts and that effect takes over the live bg. Mutates
// document.body.style ONLY. The separate boot script owns the html boot attributes;
// layout.tsx permits those intentional pre-hydration attribute changes.
const PREPAINT_BG = `(function(){try{var t=localStorage.getItem('dropsync_theme');var bg=(t==='dark')?'#000000':'#F5F2ED';document.body.style.background=bg;document.body.style.color=(t==='dark')?'#ffffff':'#1a1a1a';}catch(e){}})();`;
// ORDER 60c: parse-time boot loader — the owner's landing boot design carried from
// index-part-4.html. Rendered by the SSR branch below so it runs during HTML parse
// (like PREPAINT_BG), BEFORE the client bundle finishes downloading. It creates the
// loader DOM itself (React never owns it), hides the landing .shell via
// html[data-boot] until load + fonts + sculpture-first-frame are ready, and reveals
// for the signed-in app via dropsync:app-ready. Boot colors follow the saved variant.
const BOOT_SCRIPT = `(function () {
  'use strict';
  const root = document.documentElement;
  let landingTheme = 'light';
  try { if (localStorage.getItem('dropsync_theme') === 'dark') landingTheme = 'dark'; } catch {}
  root.dataset.landingTheme = landingTheme;
  root.dataset.loadingTheme = landingTheme;
  root.dataset.boot = 'pending';
  const loader = document.createElement('div');
  loader.className = 'boot-loader';
  loader.id = 'bootLoader';
  loader.setAttribute('role', 'status');
  loader.setAttribute('aria-label', 'Loading DropSync');
  loader.setAttribute('aria-hidden', 'true');
  loader.innerHTML = '<div class="boot-brand" aria-hidden="true"><span class="boot-diamond"></span>DropSync</div><div class="boot-track" aria-hidden="true"></div>';
  document.body.appendChild(loader);
  let loaded = document.readyState === 'complete', fontsReady = false, sceneReady = false;
  let revealing = false, shownAt = 0, revealTimer = 0;
  const showTimer = setTimeout(function () {
    if (revealing) return;
    shownAt = performance.now();
    root.dataset.loader = 'visible';
    if (loader) loader.removeAttribute('aria-hidden');
  }, 320);
  // A failed font or graphics setup must never leave the homepage hidden.
  const safetyTimer = setTimeout(reveal, 8000);
  function reveal() {
    if (revealing) return;
    revealing = true;
    clearTimeout(showTimer); clearTimeout(safetyTimer); clearTimeout(revealTimer);
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        root.dataset.boot = 'ready';
        delete root.dataset.loader;
        if (loader) loader.setAttribute('aria-hidden', 'true');
        setTimeout(function () {
          if (loader) loader.hidden = true;
          delete root.dataset.boot;
        }, 850);
      });
    });
  }
  function checkReady() {
    if (revealing || !loaded || !fontsReady || !sceneReady) return;
    clearTimeout(showTimer);
    const remaining = shownAt ? Math.max(0, 320 - (performance.now() - shownAt)) : 0;
    clearTimeout(revealTimer); revealTimer = setTimeout(reveal, remaining);
  }
  document.addEventListener('dropsync:scene-ready', function () { sceneReady = true; checkReady(); }, {once: true});
  document.addEventListener('dropsync:app-ready', function () { sceneReady = true; checkReady(); }, {once: true});
  window.addEventListener('load', function () { loaded = true; checkReady(); }, {once: true});
  document.addEventListener('DOMContentLoaded', function () {
    const fonts = document.fonts ? document.fonts.ready : Promise.resolve();
    Promise.resolve(fonts).catch(function () {}).then(function () { fontsReady = true; checkReady(); });
  }, {once: true});
})();`;
// Link hover color by theme (Round 11 owner pick "Crimson" — 2026-09-20): a deep
// editorial red with a fine-tuned shade per theme, matching the preview page the owner
// chose from. Published on document.body.style by the body-bg effect below (the
// sanctioned body-only mutation channel, page.tsx:94) and read by globals.css
// `.ds-link:hover` via var(--link-hover). Links only — the app-wide --coral is
// untouched.
const LINK_HOVER_BY_THEME: Record<Theme, string> = {
  light: '#C81E3C',
  dark: '#FF5C74',
  minimal: '#A81730',
};
const LAYOUT_STORAGE_KEY = 'dropsync_layout';

// One-shot reassurance banner shown on the login screen after a user declines the Terms (misclick
// recovery). EDITORIAL: an in-flow, borderless line above the Sign In button (heartbeat pulse).
// CLASSIC (+ minimal via isMinimal): a floating top-center card. Variant-aware via layoutMode.
function TosDeclinedNote({ theme, layoutMode }: { theme: Theme; layoutMode: LayoutMode }) {
  if (layoutMode === 'editorial') {
    const tc = getEditorialThemeColors(theme);
    return (
      <p className={`mb-3 text-center text-xs leading-snug ${tc.muted} ${tc.fontClass} animate-[dropsync-heartbeat_2.4s_ease-in-out_infinite]`}>
        <span aria-hidden>✓ </span>Your drops and workspaces are kept — sign in to accept the Terms and continue.
      </p>
    );
  }
  // classic
  const isDark = theme === 'dark';
  const isMinimal = theme === 'minimal';
  const bg = isMinimal ? 'bg-[#D4D8C8]' : isDark ? 'bg-[#1A1A1A]' : 'bg-[#FAF7F2]';
  const border = isMinimal ? 'border-[#1A1A1A]/20' : isDark ? 'border-white/10' : 'border-[#1A1A1A]';
  const text = isMinimal || !isDark ? 'text-[#1A1A1A]' : 'text-white';
  return (
    <div className="fixed top-6 left-1/2 -translate-x-1/2 z-50 w-[calc(100%-2rem)] max-w-sm">
      <div className={`${bg} border ${border} ${isMinimal ? 'rounded-lg' : ''} shadow-xl px-4 py-3`}>
        <p className={`text-xs ${text} leading-relaxed text-center`}>
          You&apos;re signed out. Your drops and workspaces are kept — sign in and accept the Terms to continue.
        </p>
      </div>
    </div>
  );
}

export default function Home() {
  const { user, loading: authLoading, signIn, signUp, signInWithEmail: emailSignIn, resetPassword, resendVerification, signOutUser, updateDisplayName, authActionNotice, clearAuthActionNotice } = useAuth();
  const [previewDrop, setPreviewDrop] = useState<Drop | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [dropTrail, setDropTrail] = useState<string[]>([]);
  const previewDropRef = useRef<Drop | null>(null);
  const decryptedPreviewCache = useRef<Map<string, Drop>>(new Map());
  previewDropRef.current = previewDrop;
  const resetPreviewNavigation = useCallback(() => {
    setDropTrail([]);
    decryptedPreviewCache.current.clear();
  }, []);
  // Monotonic generation counter for preview decryption. Bumped whenever the preview's context is
  // invalidated (an edit session starts). An in-flight decryptDrop from handlePreview only commits
  // if the epoch is unchanged — so a decrypt that finishes during/after an edit session can never
  // resurrect the preview behind the edit modal nor clobber the post-save merged drop.
  const previewEpochRef = useRef(0);
  const [theme, setTheme] = useState<Theme>('light');
  const [themeLoaded, setThemeLoaded] = useState(false);
  const [layoutMode, setLayoutMode] = useState<LayoutMode>('editorial');
  const [encryptionInitializing, setEncryptionInitializing] = useState(false);
  const [layoutTransition, setLayoutTransition] = useState<'none' | 'fade-out' | 'fade-in'>('none');
  const [pendingLayout, setPendingLayout] = useState<LayoutMode | null>(null);

  // ToS consent gate — 4-state machine (never a boolean). 'unknown' until the users/{uid} onSnapshot
  // resolves; a loader is shown meanwhile so already-accepted users never see the gate flash.
  const [tosStatus, setTosStatus] = useState<TosStatus>('unknown');
  // Bumped by the gate's Retry on a read error/time-out → re-runs the onSnapshot subscription.
  const [consentRetry, setConsentRetry] = useState(0);
  // One-shot "declined" flag for the login-screen reassurance note (read once on first render).
  const [tosDeclinedNote, setTosDeclinedNote] = useState<boolean>(
    () => typeof window !== 'undefined' && window.sessionStorage.getItem('tosDeclined') === '1'
  );

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
    kick,
    loading: workspacesLoading
  } = useWorkspaces(user?.uid || null, {
    // Server-side removal notice: fires when a workspace the user belonged to disappears and it
    // was NOT a locally-initiated leave/delete (i.e. the owner kicked them, or the owner deleted
    // the workspace). Honest in both cases. Empty initial list → no false fire on load/refresh.
    onWorkspaceRemoved: (ws, reason) => {
      if (reason === 'import-cancelled') return;
      // Stage B: confirmed access loss - drop the scope's cached payloads.
      editorialCardCache.revokeScope(ws.id);
      if (reason === 'deleted') {
        // ROUND 12: the workspace finished deleting. The owner who began it gets a quiet
        // completion note; members get the goodbye via their deletion notice (queued +
        // visibility-gated below) — never the wrong "you were removed" text.
        if (ws.deletingOwner && ws.deletingOwner === (user?.uid ?? null)) {
          setRemovedNotice(`"${ws.name}" was deleted.`);
        }
        return;
      }
      setRemovedNotice(`You no longer have access to "${ws.name}".`);
    },
  });

  // ---- ROUND 12: background deletion wiring ----
  const [forceEndPending, setForceEndPending] = useState(false);
  const goodbyeQueueRef = useRef<{ noticeId: string; text: string; ack: () => Promise<void> }[]>([]);
  const [activeGoodbye, setActiveGoodbye] = useState<{ noticeId: string; text: string; ack: () => Promise<void> } | null>(null);
  const resumedIdsRef = useRef<Set<string>>(new Set());

  // Resume MY running jobs — each workspace at most ONCE per session (part E). NOT a
  // whole-list one-shot: that burned its only attempt on the stale pre-auth emission
  // (uid restored while workspaces is still []), stranding the job after a mid-deletion
  // refresh. The once-set also keeps a PAUSED job from auto-retrying on later
  // emissions — the Retry button is the only restart after a pause.
  useEffect(() => {
    const uid = user?.uid || null;
    if (!uid || workspacesLoading) return;
    const fresh = workspaces.filter(
      (w) => w.deleting === true && w.deletingOwner === uid && !resumedIdsRef.current.has(w.id),
    );
    if (fresh.length === 0) return;
    fresh.forEach((w) => resumedIdsRef.current.add(w.id));
    resumeDeletionJobs(fresh, uid);
  }, [user?.uid, workspacesLoading, workspaces]);

  // Goodbye notices: queue arrivals, show ONE at a time, ONLY while the tab is visible —
  // a hidden tab keeps the queue (and the notice docs) intact for the next visit.
  const advanceGoodbye = useCallback(() => {
    if (document.visibilityState !== 'visible') return;
    const next = goodbyeQueueRef.current.shift();
    setActiveGoodbye(next ?? null);
  }, []);

  useEffect(() => {
    const uid = user?.uid || null;
    if (!uid) return;
    return subscribeDeletionNotices(uid, (notice) => {
      goodbyeQueueRef.current.push({
        noticeId: notice.noticeId,
        text: `${notice.workspaceName} was deleted by its owner`,
        ack: notice.ack,
      });
      setActiveGoodbye((current) => {
        if (current) return current;
        if (document.visibilityState !== 'visible') return null; // stays queued
        return goodbyeQueueRef.current.shift() ?? null;
      });
    });
  }, [user?.uid]);

  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === 'visible') advanceGoodbye();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [advanceGoodbye]);

  // Pass currentWorkspaceId to useDrops
  const { drops, loading: dropsLoading, refreshDrops } = useDrops(currentWorkspaceId, {
    // Stage B: a permission-denied on a workspace's drops listener is
    // confirmed access loss - the resource store drops that scope's cached
    // payloads and aborts its in-flight work.
    onAccessDenied: (deniedWorkspaceId) => {
      if (deniedWorkspaceId) editorialCardCache.revokeScope(deniedWorkspaceId);
    },
  });

  useEffect(() => {
    if (dropsLoading) return;
    const frame = requestAnimationFrame(() => setPreviewDrop((previous) => {
      if (!previous) return previous;
      const live = drops.find((drop) => drop.id === previous.id);
      if (!live) return null;
      return previous.isStaged === live.isStaged ? previous : { ...previous, isStaged: live.isStaged };
    }));
    return () => cancelAnimationFrame(frame);
  }, [drops, dropsLoading]);

  // A workspace/personal scope change starts a fresh preview trail. Layout switches do not affect
  // this state because the trail belongs to Home, not either layout branch.
  useEffect(() => {
    resetPreviewNavigation();
    // The instant-open caches are cleared HERE, never in resetPreviewNavigation: that runs
    // before every fresh open, and clearing there would erase the priming the click is
    // about to use. A different account/workspace must never inherit primed payloads.
    clearPreviewPrimeCaches();
  }, [user?.uid, currentWorkspaceId, resetPreviewNavigation]);

  // Stage B lifecycle: a different signed-in account starts a fresh resource
  // store (the same visit keeps everything - Option 1). Scope revocation is
  // event-driven (removal notice / permission-denied), not navigation-driven.
  useEffect(() => {
    editorialCardCache.beginSession(user?.uid ?? null);
  }, [user?.uid]);

  // Categories for current workspace
  const { categories, addCategory, removeCategory } = useCategories(currentWorkspaceId, user?.uid);

  // Workspace presence — PAGE-LEVEL (the chat panel unmounts on close, so presence must live here).
  // Self-excludes; threaded down to both chat panels as the `presence` prop. MUST stay above all
  // early returns (Rules of Hooks) — it self-guards when user/workspace are null.
  const presenceMap = usePresence(user?.uid || null, currentWorkspaceId);

  // ---- Live calls ---- desktop-only (useIsHoverable, NOT a width breakpoint; defaults false
  // pre-mount/SSR). activeCallDrop + callMinimized are page-level so the call survives the modal
  // unmounting on minimize; useCallMesh (below) is keyed on callDropId so a call survives a
  // workspace switch. Declared here (above early returns) so the Rules of Hooks hold.
  const hoverable = useIsHoverable();
  const callAccess = useCallAccess(user?.uid ?? null);
  const [activeCallDrop, setActiveCallDrop] = useState<Drop | null>(null);
  const [callMinimized, setCallMinimized] = useState(false);
  const [callNotice, setCallNotice] = useState<string | null>(null);

  // Modal states
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showJoinModal, setShowJoinModal] = useState(false);
  const [editDrop, setEditDrop] = useState<Drop | null>(null);
  useEffect(() => {
    if (dropsLoading) return;
    const frame = requestAnimationFrame(() => setEditDrop((previous) => previous && (drops.find((drop) => drop.id === previous.id)?.isStaged || !drops.some((drop) => drop.id === previous.id)) ? null : previous));
    return () => cancelAnimationFrame(frame);
  }, [drops, dropsLoading]);
  // True while the edit modal is being prepared (metadata refresh + decrypt) — drives a loading
  // state on the preview's Edit button so the wait never looks like the app froze.
  const [editPreparing, setEditPreparing] = useState(false);
  const editPreparationEpochRef = useRef(0);
  const [createdWorkspace, setCreatedWorkspace] = useState<{ name: string; inviteCode: string } | null>(null);
  const [workspaceToDelete, setWorkspaceToDelete] = useState<Workspace | null>(null);
  const [workspaceToLeave, setWorkspaceToLeave] = useState<Workspace | null>(null);
  const [isDeletingWorkspace, setIsDeletingWorkspace] = useState(false);
  const [workspaceDeleteError, setWorkspaceDeleteError] = useState<string | null>(null);
  const [isLeavingWorkspace, setIsLeavingWorkspace] = useState(false);
  const [isKickingMember, setIsKickingMember] = useState(false);
  const [removedNotice, setRemovedNotice] = useState<string | null>(null);
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [archiveMode, setArchiveMode] = useState<'export' | 'import' | null>(null);
  const [archiveScope, setArchiveScope] = useState<'workspace' | 'personal'>('workspace');
  const [personalOptionsOpen, setPersonalOptionsOpen] = useState(false);
  const [showYoutubeBackfill, setShowYoutubeBackfill] = useState(false);
  const [youtubeBackfillVisible, setYoutubeBackfillVisible] = useState(true);
  const [youtubeBackfillVisibilityReady, setYoutubeBackfillVisibilityReady] = useState(false);
  const [archiveNotice, setArchiveNotice] = useState<string | null>(null);
  const [archivePanelJobId, setArchivePanelJobId] = useState<string | null>(null);
  const [archivePanelShowAll, setArchivePanelShowAll] = useState(false);
  const archiveManager = getArchiveTaskManager();
  const [showChat, setShowChat] = useState(false);
  const [chatMode, setChatMode] = useState<'ai' | 'group'>('ai');
  const [pendingChatDropQueue, setPendingChatDropQueue] = useState<ChatDropRequest[]>([]);
  const nextChatDropRequestIdRef = useRef(0);
  const [pendingAgentDropQueue, setPendingAgentDropQueue] = useState<AgentDropRequest[]>([]);
  const nextAgentDropRequestIdRef = useRef(0);
  useEffect(() => {
    const clearStale = setTimeout(() => setPendingAgentDropQueue(queue => {
      const matching = queue.filter(request => showChat && chatMode === 'ai' &&
        request.userId === user?.uid && request.workspaceId === currentWorkspaceId &&
        request.panelKey === layoutMode);
      return matching.length === queue.length ? queue : matching;
    }), 0);
    return () => clearTimeout(clearStale);
  }, [showChat, chatMode, user?.uid, currentWorkspaceId, layoutMode]);

  const [unreadCount, setUnreadCount] = useState(0);
  const unreadUnsubRef = useRef<(() => void) | null>(null);
  const prevShowChatRef = useRef(showChat);


  useEffect(() => {
    setPendingChatDropQueue((queue) => {
      if (!showChat || !user?.uid || !currentWorkspaceId) return queue.length ? [] : queue;
      const matching = queue.filter((request) => request.workspaceId === currentWorkspaceId && request.userId === user.uid);
      return matching.length === queue.length ? queue : matching;
    });
  }, [showChat, currentWorkspaceId, user?.uid]);

  // Browser chat notifications (foreground only) — permission + mute preference.
  // Default: notifications ON once permission is granted (mute flag = off).
  const [notifPermission, setNotifPermission] = useState<NotificationPermission>('default');
  const [notifMuted, setNotifMuted] = useState(false);
  // Approach-C: footer (dissolve + magnet) user toggle. Default ON. Persisted to Firestore
  // users/{uid}.footerEnabled (mirrors notifMuted) so it syncs across devices on reload.
  const [footerEnabled, setFooterEnabled] = useState(true);
  // Editorial reports the current space's sort mode here so the page-level Footer gate can
  // temporarily suppress the Footer without changing the user's saved footer preference.
  const [editorialSortState, setEditorialSortState] = useState<{
    spaceKey: string;
    mode: DropSortMode;
  } | null>(null);
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

  // Backfill button visibility = account-wide Firestore state on users/{uid},
  // live via onSnapshot (all tabs and devices converge; localStorage is no
  // longer an input). Hidden until the first snapshot answers; a stream error
  // keeps the last-known state and self-heals on reconnect. Signed out → hidden.
  const youtubeUserId = user?.uid;
  useEffect(() => {
    if (!youtubeUserId) {
      setYoutubeBackfillVisible(false);
      setYoutubeBackfillVisibilityReady(true);
      return;
    }
    setYoutubeBackfillVisibilityReady(false);
    const stopSubscribe = subscribeBackfillDecisionState(youtubeUserId, (state) => {
      setYoutubeBackfillVisible(evaluateYoutubeBackfillVisibility(state));
      setYoutubeBackfillVisibilityReady(true);
    });
    return stopSubscribe;
  }, [youtubeUserId]);

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

  // Routine discovery is cancellable; only real cleanup holds the account lock.
  const archiveUserId = user?.uid;
  useEffect(() => {
    if (!archiveUserId) return;
    const recovery = archiveManager.attachRecovery(archiveUserId);
    return () => recovery.dispose();
  }, [archiveManager, archiveUserId]);

  useEffect(() => {
    archiveManager.setNoticeHandler((notice) => setArchiveNotice(notice));
    return () => archiveManager.setNoticeHandler(null);
  }, [archiveManager]);

  useEffect(() => {
    const select = (event: Event) => {
      const jobId = (event as CustomEvent<string>).detail;
      if (jobId) { setArchivePanelJobId(jobId); setArchivePanelShowAll(true); }
    };
    window.addEventListener('dropsync-archive-select', select);
    return () => window.removeEventListener('dropsync-archive-select', select);
  }, []);

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

  // ORDER 60d: keep loader colors and the landing variant in sync with the live theme (before paint).
  useLayoutEffect(() => {
    if (!themeLoaded) return;
    const variant = theme === 'dark' ? 'dark' : 'light';
    document.documentElement.dataset.loadingTheme = variant;
    document.documentElement.dataset.landingTheme = variant;
  }, [theme, themeLoaded]);

  // Save theme to localStorage when it changes
  useEffect(() => {
    if (themeLoaded) {
      localStorage.setItem(THEME_STORAGE_KEY, theme);
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
    // Crimson hover shade rides the same theme change (see LINK_HOVER_BY_THEME above).
    document.body.style.setProperty('--link-hover', LINK_HOVER_BY_THEME[theme]);
    return () => {
      document.body.style.backgroundColor = '';
      document.body.style.removeProperty('--link-hover');
    };
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

  // ROUND 12 (parts D/F): begin the BACKGROUND job. D-m lives here — the server answers
  // confirmation-required when a call exists; the modal then shows "end the call and
  // delete?" and re-invokes this with forceEndAck. On success the modal closes, the
  // owner is switched to Personal, and the runner loop starts in the background. A
  // failure keeps the modal open (retryable) exactly as before.
  const handleDeleteWorkspace = async (forceEndAck = false) => {
    if (workspaceToDelete) {
      setIsDeletingWorkspace(true);
      try {
        const result = await startWorkspaceDeletion(workspaceToDelete.id, { forceEndAck });
        if (result.status === 'confirmation-required') {
          setForceEndPending(true); // the modal swaps to the D-m confirm view
          return;
        }
        setForceEndPending(false);
        if (result.ok) {
          setWorkspaceToDelete(null);
          setWorkspaceDeleteError(null);
          runDeletionJob(workspaceToDelete.id);
          if (currentWorkspaceId === workspaceToDelete.id) switchWorkspace(null); // D-h
          setRemovedNotice(`Deleting "${workspaceToDelete.name}" — you can keep working.`);
        } else {
          setWorkspaceDeleteError("Couldn't delete the workspace — please try again.");
        }
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
        const ok = await leaveWorkspace(workspaceToDelete.id, newOwnerId);
        if (ok) {
          setWorkspaceToDelete(null);
        } else {
          // ROUND 12 (A2): a refused transfer (e.g. the workspace began deleting) surfaces
          // instead of silently closing the modal.
          setWorkspaceDeleteError("Couldn't leave and transfer — the workspace may be deleting.");
        }
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
    editPreparationEpochRef.current += 1;
    setEditPreparing(false);
    const epoch = ++previewEpochRef.current;
    if (!user) {
      setPreviewDrop(drop);
      setPreviewLoading(false);
      return;
    }

    // If encrypted, show modal immediately with skeleton, then decrypt
    if (drop.encrypted) {
      // Instant open (Win A): the clicked card already decrypted this payload into the
      // primed cache — serve the primed PAYLOAD on top of the LIVE drop (name/lock/
      // reminder must stay fresh) and skip the duplicate download+decrypt. Signature-
      // guarded: any payload change rotates iv/imageR2Key/r2Key and falls through to the
      // normal path below.
      const primed = getPrimedPreview(drop.id, previewSig(drop));
      if (primed) {
        const shown: Drop = {
          ...drop,
          content: primed.content,
          fileData: primed.fileData,
          imageData: primed.imageData,
          encrypted: false,
        };
        // Win B: a settled hover may have pre-built this video's blob URL — hand it over
        // (ownership transfers; the modal's cleanup revokes it).
        const prebuiltUrl = consumePrebuiltVideoUrl(drop.id, previewSig(drop));
        if (prebuiltUrl) shown.prebuiltVideoUrl = prebuiltUrl;
        setPreviewDrop(shown);
        setPreviewLoading(false);
        decryptedPreviewCache.current.set(drop.id, primed);
        return;
      }
      // Stage B (Order 17): the scoped page-visit store is the second hit
      // path - a drop this visit already decrypted (even one whose card is
      // no longer mounted) reopens with its payload and NO lock flash.
      const scopeKey = currentWorkspaceId ?? 'personal';
      const scopeGen = editorialCardCache.scopeGeneration(scopeKey);
      const cached = editorialCardCache.snapshot(scopeKey, drop.id, payloadRevision(drop));
      if (cached.ready) {
        const shown: Drop = {
          ...drop,
          content: cached.text,
          fileData: cached.file,
          imageData: cached.image,
          encrypted: false,
        };
        setPreviewDrop(shown);
        setPreviewLoading(false);
        return;
      }
      setPreviewDrop(drop); // Show modal immediately with encrypted drop
      setPreviewLoading(true); // Show skeleton
      try {
        const decryptedDrop = await decryptDrop(drop, user.uid);
        // Only commit if no edit session invalidated this preview in the meantime (the edit modal
        // is open or a save already replaced this drop) — a late decrypt must never resurrect the
        // preview behind the edit modal nor clobber the post-save merged drop.
        if (previewEpochRef.current === epoch) {
          setPreviewDrop(decryptedDrop); // Update with decrypted content
          decryptedPreviewCache.current.set(drop.id, decryptedDrop);
          // The click did the decrypt work anyway — hand the fresh payload to the
          // instant-open shelf, so reopening THIS drop is always a hit even if the
          // cards' scroll-priming was evicted.
          primeDecryptedPreview(drop, decryptedDrop);
          // Stage B: seed the page-visit store too, so the (possibly unmounted)
          // window card reopens without the lock flash.
          editorialCardCache.seedFromDecrypted(scopeKey, drop.id, drop, decryptedDrop, scopeGen);
        }
      } finally {
        if (previewEpochRef.current === epoch) {
          setPreviewLoading(false); // Hide skeleton
        }
      }
    } else {
      setPreviewDrop(drop);
      setPreviewLoading(false);
    }
  };

  // Read the latest persisted fields when a runtime-decrypted preview is reused. The preview keeps
  // plaintext content/imageData for instant rendering, while this refresh supplies the current
  // ciphertext/image keys so a second edit or Move/Copy cannot use deleted R2 metadata.
  const loadLatestDrop = async (drop: Drop, preserveRuntimePayload = false): Promise<Drop> => {
    try {
      const snapshot = await getDoc(doc(db, 'drops', drop.id));
      if (!snapshot.exists()) return drop;
      const data = snapshot.data();
      return {
        ...drop,
        userId: data.userId ?? drop.userId,
        type: data.type ?? drop.type,
        name: data.name ?? drop.name,
        content: preserveRuntimePayload ? drop.content : data.content,
        fileData: preserveRuntimePayload ? drop.fileData : data.fileData,
        fileUrl: data.fileUrl ?? undefined,
        r2Key: data.r2Key ?? undefined,
        fileSize: data.fileSize ?? drop.fileSize,
        mimeType: data.mimeType ?? drop.mimeType,
        createdAt: data.createdAt?.toDate?.() ?? drop.createdAt,
        expiresAt: data.expiresAt?.toDate?.() ?? null,
        expirationOption: data.expirationOption,
        workspaceId: data.workspaceId ?? null,
        // Text content/imageData are already plaintext in the runtime preview. Keep that payload,
        // but replace the crypto fields below with the latest Firestore values.
        encrypted: preserveRuntimePayload && drop.type === 'text' ? false : data.encrypted,
        iv: data.iv,
        encryptedDEK: data.encryptedDEK,
        encryptedDEKs: data.encryptedDEKs,
        imageUrl: data.imageUrl || undefined,
        imageR2Key: data.imageR2Key || undefined,
        imageSize: data.imageSize || undefined,
        imageMimeType: data.imageMimeType || undefined,
        imageIv: data.imageIv || undefined,
        imageData: preserveRuntimePayload && data.imageUrl ? drop.imageData : undefined,
        category: data.category || undefined,
        categories: data.categories || (data.category ? [data.category] : []),
        creatorName: data.creatorName || undefined,
        pinned: data.pinned || false,
        isDrawing: data.isDrawing || false,
        locked: data.locked || false,
        reminderAt: data.reminderAt?.toDate?.() ?? null,
        reminderSetByUid: data.reminderSetByUid || null,
        reminderDismissedBy: data.reminderDismissedBy || null,
        fileFormat: data.fileFormat ?? drop.fileFormat,
        youtubeVideoLabels: isPasswordCategories([
          ...(Array.isArray(data.categories) ? data.categories : []),
          ...(typeof data.category === 'string' ? [data.category] : []),
        ]) ? [] : normalizeYoutubeLabels(data.youtubeVideoLabels),
      };
    } catch (error) {
      console.warn('Could not refresh drop metadata:', error);
      return drop;
    }
  };

  // Return to the preview through the normal decrypt path when the edit session still holds a raw
  // encrypted record (possible if Edit was clicked while a file preview was still loading).
  const reopenPreview = (drop: Drop) => {
    if (drop.encrypted) {
      void handlePreview(drop);
      return;
    }
    setPreviewDrop(drop);
    setPreviewLoading(false);
  };

  // Get workspace members for encryption
  const workspaceMembers = currentWorkspace?.members || [];

  // Page-level call mesh — called ONCE above all early returns (like usePresence). Keyed on the call
  // drop id (NOT workspaceId) so a call survives a workspace switch; media persists across modal
  // minimize/unmount because this hook never unmounts with the modal.
  const callState = useLiveKitCall({
    userId: user?.uid ?? null,
    callDropId: activeCallDrop?.id ?? null,
    workspaceMembers: resolvedWorkspaceMembers,
    isDesktop: hoverable,
  });

  // A server-ended call reports its reason before the terminal call document is cleaned up. Leave the
  // local LiveKit room and surface the same message to every non-trusted participant.
  useEffect(() => {
    if (callState.status !== 'ended') return;
    if (callState.callEndReason === 'untrusted_time_limit') {
      setCallNotice(CALL_LIMIT_MESSAGE);
      void callAccess.refresh();
    }
    void callState.leaveCall().finally(() => {
      setActiveCallDrop(null);
      setCallMinimized(false);
    });
  }, [callState.status, callState.callEndReason, callState.leaveCall, callAccess.refresh]);

  // Host pressed Start in the create-modal's Call mode. Adopt the preview stream (no camera blink),
  // set the active call drop (the real doc hydrates via createDropListener within ~1s), and join.
  // A fresh start returns callState 'pending' + attemptToken: the host joins WITHOUT the join route
  // (already admitted at start) and confirms pending → live right after the LiveKit connect.
  const handleStartCall = async (
    callDropId: string,
    stream: MediaStream | null,
    callInfo?: {
      created?: boolean;
      callState?: 'live' | 'pending';
      attemptToken?: string | null;
      livekitRoomName?: string;
      callHostUid?: string;
      creatorName?: string;
      callParticipantUids?: string[];
    },
  ) => {
    if (!user) return;
    retractFooterIfUp();
    callState.adoptPreviewStream(stream);
    const hostName = user.displayName || user.email?.split('@')[0] || 'Host';
    const existingCall = drops.find((drop) => drop.id === callDropId && drop.type === 'call');
    setActiveCallDrop(existingCall
      ? {
          ...existingCall,
          creatorName: callInfo?.creatorName || existingCall.creatorName,
          callHostUid: callInfo?.callHostUid || existingCall.callHostUid,
          callParticipantUids: callInfo?.callParticipantUids || existingCall.callParticipantUids,
        }
      : {
          id: callDropId,
          userId: callInfo?.callHostUid || user.uid,
          type: 'call',
          name: 'Live call',
          creatorName: callInfo?.creatorName || hostName,
          callHostUid: callInfo?.callHostUid || user.uid,
          callParticipantUids: callInfo?.callParticipantUids || [user.uid],
          workspaceId: currentWorkspaceId,
          callState: callInfo?.callState ?? 'live',
          createdAt: new Date(),
          callStartedAt: new Date(),
          expiresAt: null,
          expirationOption: 'forever',
        });
    setCallMinimized(false);
    try {
      await callState.joinCall(callDropId, {
        skipJoinRoute: callInfo?.callState === 'pending' && callInfo?.created === true,
        attemptToken: callInfo?.attemptToken ?? null,
        expectedRoomName: callInfo?.livekitRoomName ?? null,
      });
    } catch (error) {
      setActiveCallDrop(null);
      throw error instanceof Error ? error : new Error('Failed to join the call.');
    }
  };

  // A member clicked the call drop's Join. Desktop-only is checked up front; capacity is NOT — the
  // route is the sole enforcer because it first reconciles the roster against LiveKit (dropping ghosts
  // from hard-killed tabs), so a stale client-side count could wrongly block a real joiner. The 409
  // (genuinely full) is toasted from the catch below.
  const handleJoinCall = async (drop: Drop) => {
    if (!user) return;
    if (!hoverable) {
      setCallNotice('🔒 Live calls are desktop-only — please join from a computer.');
      return;
    }
    retractFooterIfUp();
    setActiveCallDrop(drop);
    setCallMinimized(false);
    try {
      await callState.joinCall(drop.id);
    } catch (e) {
      setActiveCallDrop(null);
      setCallNotice(e instanceof Error ? e.message : 'Failed to join the call.');
    }
  };

  // PERF(PF-1) stable identity: the drop cards are React.memo'd, so every handler that
  // reaches a card must keep its identity across unrelated Home re-renders. The ref
  // carries the latest closure; the wrapper never changes.
  const handleJoinCallRef = useRef(handleJoinCall);
  useEffect(() => {
    handleJoinCallRef.current = handleJoinCall;
  });
  const stableJoinCall = useCallback((drop: Drop) => handleJoinCallRef.current(drop), []);

  const handleMinimizeCall = () => {
    retractFooterIfUp();
    setCallMinimized(true);
  };
  const handleRestoreCall = () => {
    retractFooterIfUp();
    setCallMinimized(false);
  };
  const handleLeaveCall = async () => {
    await callState.leaveCall();
    setActiveCallDrop(null);
    setCallMinimized(false);
  };

  // The drop id of the viewer's own active, minimized call (flips that call's tile button to "Reopen").
  const reopenCallDropId = activeCallDrop && callMinimized ? activeCallDrop.id : undefined;

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
    if (!user) {
      setNotifMuted(false);
      setEditorialSortState(null);
      return;
    }
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
          data.kind,
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

  const handleSendDropToChat = useCallback((selectedDrop: Drop) => {
    const userId = user?.uid;
    if (!userId || !currentWorkspaceId || selectedDrop.workspaceId !== currentWorkspaceId) return;
    const drop = drops.find((item) => item.id === selectedDrop.id);
    if (!drop || drop.workspaceId !== currentWorkspaceId || drop.isStaged || drop.type === 'call') return;
    const canMutate = userId === drop.userId || (!!currentWorkspace && userId === currentWorkspace.ownerId);
    if (drop.locked && !canMutate) return;

    const requestId = nextChatDropRequestIdRef.current + 1;
    nextChatDropRequestIdRef.current = requestId;
    setPendingChatDropQueue((queue) => [...queue, {
      requestId,
      workspaceId: currentWorkspaceId,
      dropId: drop.id,
      userId,
    }]);
    setChatMode('group');
    setShowChat(true);
  }, [user?.uid, currentWorkspaceId, currentWorkspace, drops]);

  const handleSendDropToAgent = useCallback((selectedDrop: Drop) => {
    const drop = drops.find(item => item.id === selectedDrop.id);
    const scope = {
      userId: user?.uid, workspaceId: currentWorkspaceId,
      ready: !dropsLoading && (currentWorkspaceId === null ||
        (currentWorkspace?.id === currentWorkspaceId && currentWorkspace.deleting !== true)),
    };
    if (!isAgentDropEligible(drop, scope) || !user?.uid) return;
    const requestId = ++nextAgentDropRequestIdRef.current;
    setPendingAgentDropQueue(queue => [...queue, {
      requestId, dropId: drop.id, workspaceId: currentWorkspaceId,
      userId: user.uid, panelKey: layoutMode,
    }]);
    setChatMode('ai');
    setShowChat(true);
  }, [drops, dropsLoading, user?.uid, currentWorkspaceId, currentWorkspace, layoutMode]);

  const handleAgentDropHandled = useCallback((requestId: number) => {
    setPendingAgentDropQueue(queue => queue.filter(request => request.requestId !== requestId));
  }, []);

  const handleChatDropHandled = useCallback((requestId: number) => {
    setPendingChatDropQueue((queue) => queue.filter((request) => request.requestId !== requestId));
  }, []);

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
    try { await assertDropWritableById(drop.id); }
    catch (error) { setArchiveNotice(error instanceof Error ? error.message : 'This item is still importing.'); return; }
    retractFooterIfUp(); // retract the footer before the edit overlay mounts (no-op at scrollY 0)
    previewEpochRef.current += 1; // any in-flight preview decrypt is now stale — must not resurrect
    const preparationEpoch = ++editPreparationEpochRef.current;
    setEditPreparing(true);
    const isCurrentPreparation = () => editPreparationEpochRef.current === preparationEpoch;
    // A runtime-decrypted text preview may still carry the previous version's crypto metadata.
    // Refresh the raw text record before editing so updateTextDrop always has current image keys.
    const editSource = drop.type === 'text' && !drop.encrypted
      ? await loadLatestDrop(drop)
      : drop;
    if (!isCurrentPreparation()) return;
    try { await assertDropWritableById(drop.id); }
    catch (error) { setEditPreparing(false); setArchiveNotice(error instanceof Error ? error.message : 'This item is still importing.'); return; }
    const openEditModal = (source: Drop) => {
      if (!isCurrentPreparation()) return;
      // Keep the preview visible during the metadata/decryption wait, then replace it in the same
      // state turn that mounts the edit modal so there is no blank interval between overlays.
      setPreviewDrop(null);
      setPreviewLoading(false);
      setEditPreparing(false);
      setEditDrop(source);
    };
    if (editSource.type === 'file') {
      openEditModal(editSource);
    } else if (editSource.encrypted && user) {
      try {
        const decrypted = await decryptDrop(editSource, user.uid);
        openEditModal(decrypted);
      } catch {
        openEditModal({ ...editSource, content: '' });
      }
    } else {
      openEditModal(editSource);
    }
  };

  // Re-open the preview with the drop being edited after the edit modal closes without a save
  // (X/backdrop/cancel with or without the discard confirm). editDrop is still the pre-edit
  // (already decrypted) drop here, so the preview renders instantly — no skeleton, no re-decrypt.
  const handleEditClose = () => {
    const edited = editDrop;
    setEditDrop(null);
    if (edited) {
      reopenPreview(edited);
    }
  };

  // Invalidate any in-flight preview decrypt. Called when the preview's context is superseded by
  // another overlay the layouts open from the preview (the move modal) — a late decrypt must never
  // resurrect the preview behind that overlay nor clobber what the layouts show after it closes.
  // PERF(PF-1) stable identity — see the stableJoinCall note above.
  const handleEditDropRef = useRef(handleEditDrop);
  useEffect(() => {
    handleEditDropRef.current = handleEditDrop;
  });
  const stableEditDrop = useCallback((drop: Drop) => handleEditDropRef.current(drop), []);

  const handlePreviewInvalidate = () => {
    previewEpochRef.current += 1;
    editPreparationEpochRef.current += 1;
    setEditPreparing(false);
  };

  const handleOpenRootDrop = (drop: Drop) => {
    resetPreviewNavigation();
    handlePreview(drop);
  };

  // PERF(PF-1) stable identity — see the stableJoinCall note above.
  const handleOpenRootDropRef = useRef(handleOpenRootDrop);
  useEffect(() => {
    handleOpenRootDropRef.current = handleOpenRootDrop;
  });
  const stableOpenRootDrop = useCallback((drop: Drop) => handleOpenRootDropRef.current(drop), []);

  const handleOpenMentionedDrop = (target: Drop) => {
    const current = previewDropRef.current;
    if (current && target.id === current.id) return;

    const liveTarget = drops.find((drop) => drop.id === target.id);
    if (!liveTarget || (liveTarget.expiresAt !== null && liveTarget.expiresAt.getTime() <= Date.now())) return;

    if (current) {
      setDropTrail((previous) => {
        const next = [...previous, current.id];
        return next.length > 50 ? next.slice(next.length - 50) : next;
      });
    }
    handlePreview(liveTarget);
  };

  const handleClosePreview = () => {
    resetPreviewNavigation();
    handlePreviewInvalidate();
    setPreviewDrop(null);
    setPreviewLoading(false);
  };

  const handlePreviewBack = () => {
    const remainingTrail = [...dropTrail];
    while (remainingTrail.length > 0) {
      const previousId = remainingTrail.pop()!;
      setDropTrail((previous) => previous.slice(0, -1));
      const previousDrop = drops.find((drop) => drop.id === previousId);
      if (previousDrop && (previousDrop.expiresAt === null || previousDrop.expiresAt.getTime() > Date.now())) {
        const cached = decryptedPreviewCache.current.get(previousId);
        handlePreview(cached ?? previousDrop);
        return;
      }
    }
    handleClosePreview();
  };

  const clearPreviewTrail = resetPreviewNavigation;

  // Build the preview drop from the edit session's knowledge. The DB stores content/images
  // encrypted, and updateTextDrop/updateDropMetadata only return booleans — so the preview's
  // post-save state must be merged here: new plaintext content, name, categories, expiration,
  // lock, image (or its removal), and reminder state on top of the untouched original fields.
  const mergeEditedDrop = (original: Drop, updates: {
    name?: string; content?: string; categories?: string[]; expirationOption?: ExpirationOption;
    locked?: boolean; imagePreviewData?: string; imageRemoved?: boolean;
    reminderAt?: Date | null; reminderSetByUid?: string | null; reminderDismissedBy?: string | null;
  }): Drop => {
    const merged: Drop = { ...original };
    if (updates.name !== undefined) merged.name = updates.name;
    if (updates.content !== undefined) merged.content = updates.content;
    if (updates.categories !== undefined) {
      merged.categories = updates.categories;
      merged.category = undefined;
    }
    if (updates.expirationOption !== undefined) {
      merged.expirationOption = updates.expirationOption;
      merged.expiresAt = getExpirationDate(updates.expirationOption);
    }
    if (updates.locked !== undefined) merged.locked = updates.locked;
    // The preview renders text-drop images from imageData (decrypted at runtime). A new/changed
    // image arrives as a client-side data URL; clear persisted fields until loadLatestDrop reconciles
    // the runtime preview with the keys written by updateTextDrop.
    if (updates.imagePreviewData) {
      merged.imageData = updates.imagePreviewData;
      merged.imageUrl = undefined;
      merged.imageR2Key = undefined;
      merged.imageSize = undefined;
      merged.imageMimeType = undefined;
      merged.imageIv = undefined;
    } else if (updates.imageRemoved) {
      merged.imageData = undefined;
      merged.imageUrl = undefined;
      merged.imageR2Key = undefined;
      merged.imageSize = undefined;
      merged.imageMimeType = undefined;
      merged.imageIv = undefined;
    }
    if (updates.reminderAt !== undefined) {
      merged.reminderAt = updates.reminderAt;
      merged.reminderSetByUid = updates.reminderSetByUid ?? null;
      merged.reminderDismissedBy = updates.reminderDismissedBy ?? null;
    }
    return merged;
  };

  // Handle edit submit
  const handleEditSubmit = async (drop: Drop, updates: { name?: string; content?: string; category?: string | null; categories?: string[]; expirationOption?: ExpirationOption; imageFile?: File | null; imageRemoved?: boolean; locked?: boolean; imagePreviewData?: string; reminderAt?: Date | null; reminderSetByUid?: string | null; reminderDismissedBy?: string | null }): Promise<boolean> => {
    if (!user) return false;
    const success = drop.type === 'file'
      ? await updateDropMetadata(drop.id, updates)
      : await updateTextDrop(drop, updates, user.uid);
    if (success) {
      let reminderSaved = true;
      // Text content uses the encrypted update path, so persist reminder metadata separately before
      // reopening the preview. The preview must not claim a reminder was saved when this write fails.
      if (drop.type === 'text' && updates.reminderAt !== undefined) {
        reminderSaved = await updateDropMetadata(drop.id, {
          reminderAt: updates.reminderAt,
          reminderSetByUid: updates.reminderSetByUid,
          reminderDismissedBy: updates.reminderDismissedBy,
        });
        if (!reminderSaved) {
          console.error('Reminder save failed; reopening with the persisted reminder state');
        }
      }

      const merged = mergeEditedDrop(
        drop,
        reminderSaved
          ? updates
          : { ...updates, reminderAt: undefined, reminderSetByUid: undefined, reminderDismissedBy: undefined }
      );
      // Reconcile the runtime plaintext preview with the freshly written crypto/image metadata.
      const savedPreview = drop.type === 'text'
        ? await loadLatestDrop(merged, true)
        : merged;
      setEditDrop(null);
      decryptedPreviewCache.current.set(savedPreview.id, savedPreview);
      reopenPreview(savedPreview);
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
    try { await assertCategoryWritableById(categoryId); }
    catch (error) { setArchiveNotice(error instanceof Error ? error.message : 'This category is still importing.'); return; }
    const result = await removeCategory(categoryId, categoryName);
    if (!result.success) {
      console.error('Failed to delete category:', result.error);
      setArchiveNotice(result.error ?? 'Failed to delete the category.');
    }
  };

  // PERF(PF-1) stable identity (Order 8h): the drops list is memoized, so every handler
  // that reaches it must keep its identity across unrelated Home re-renders. The ref
  // carries the latest closure; the wrapper never changes.
  const handleDeleteCategoryRef = useRef(handleDeleteCategory);
  useEffect(() => {
    handleDeleteCategoryRef.current = handleDeleteCategory;
  });
  const stableDeleteCategory = useCallback(
    (categoryId: string, categoryName: string) => handleDeleteCategoryRef.current(categoryId, categoryName),
    [],
  );

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
  const activeSpaceKey = currentWorkspaceId ?? 'personal';
  const currentEditorialSortMode =
    editorialSortState?.spaceKey === activeSpaceKey ? editorialSortState.mode : null;
  // While Editorial's per-space sort preference is still loading, keep the Footer hidden rather
  // than briefly showing it with the default mode before Firestore resolves a saved Manual mode.
  const editorialSortReady = layoutMode !== 'editorial' || currentEditorialSortMode !== null;
  const manualSortActive = layoutMode === 'editorial' && currentEditorialSortMode === 'manual';
  // The saved preference remains untouched: Manual is only a temporary effective-visibility
  // override. Classic has no Manual sort mode, so it follows footerEnabled exactly as before.
  const footerVisible = footerEnabled && editorialSortReady && !manualSortActive;
  // This single flag gates the Footer render and both footer hooks. Below 1400px the feature stays
  // off as before, regardless of the saved preference or sort mode.
  const footerActive = isWide && footerVisible;
  const handleEditorialSortModeChange = useCallback((mode: DropSortMode, spaceKey: string) => {
    // Retract before the state update when Manual is selected so a Footer already mid-reveal or
    // Lenis glide cannot remain over the list while React removes it.
    if (mode === 'manual') retractFooterImmediately();
    setEditorialSortState({ mode, spaceKey });
  }, []);

  // Covers asynchronous sort-preference loading, workspace changes, responsive teardown, and the
  // Settings toggle. The direct callback handles the normal Manual click before paint; this catches
  // any other true → false transition. It intentionally does not touch Lenis stop/start locks.
  const previousFooterActiveRef = useRef(false);
  useLayoutEffect(() => {
    if (previousFooterActiveRef.current && !footerActive) {
      retractFooterImmediately();
    }
    previousFooterActiveRef.current = footerActive;
  }, [footerActive]);
  // Approach-C Part 2: the dissolve (app lifts + fades as the footer rises). Frozen solid while
  // chat or a modal is open; off under reduced-motion. No-ops on login/loading (elements absent).
  useDissolve(showChat, footerActive);
  // Approach-C Part 3: the magnetic footer wheel-gate (resist at the app<->footer boundary, glide
  // through on sustained intent). Desktop-pointer (wheel) only; off under reduced-motion; inert
  // when the footer is absent. No-ops on login/loading/verify.
  useMagnet(footerActive);
  // Block Space from scrolling the page (which would pop the footer) when focus is not
  // on something that legitimately uses Space (typing / activating buttons / toggles).
  useEffect(() => {
    if (!footerActive) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== ' ' || e.ctrlKey || e.metaKey || e.altKey || (layoutMode === 'editorial' && e.shiftKey)) return;
      const t = e.target as HTMLElement | null;
      if (!t) return;
      if (t.isContentEditable) return; // typing in a rich-text composer
      const interactive = t.closest(
        'button, input, textarea, select, summary, ' +
        '[role="button"], [role="checkbox"], [role="radio"], [role="tab"], ' +
        '[role="switch"], [role="menuitem"], [role="menuitemcheckbox"], ' +
        '[role="menuitemradio"], [role="option"], [role="treeitem"], [role="combobox"]'
      );
      if (interactive) return; // Space has a real job here — let it work
      e.preventDefault(); // otherwise Space's default = scroll page + pop footer → block it
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [footerActive, layoutMode]);

  // ToS consent: reactive read of users/{uid}.tosAcceptedVersion. onSnapshot (NOT a one-shot getDoc)
  // so it self-corrects the first-login race and auto-dismisses the gate in other open tabs. A read
  // error or an 8s time-out surfaces the 'error' screen — never silently 'needed' (which would lock
  // users out offline). Resets to 'unknown' on sign-out / uid change.
  useEffect(() => {
    if (!user?.uid) {
      setTosStatus('unknown');
      return;
    }
    setTosStatus('unknown');
    let resolved = false;
    const timeout = window.setTimeout(() => {
      if (!resolved) setTosStatus('error');
    }, 8000);
    const unsubscribe = onSnapshot(
      doc(db, 'users', user.uid),
      (snap) => {
        resolved = true;
        const v = snap.exists() ? (snap.get('tosAcceptedVersion') ?? 0) : 0;
        setTosStatus(v >= CURRENT_TERMS_VERSION ? 'accepted' : 'needed');
      },
      (error) => {
        resolved = true;
        if (error?.code === 'permission-denied') return; // expected during sign-out teardown — ignore
        console.error('tos consent read error', error);
        setTosStatus('error');
      }
    );
    return () => {
      resolved = true;
      window.clearTimeout(timeout);
      unsubscribe();
    };
  }, [user?.uid, consentRetry]);

  // Consume the post-Decline banner at the correct boundary — SIGN-IN. Clears BOTH the live
  // tosDeclinedNote state AND the durable sessionStorage flag, so the note survives remounts
  // (route changes to /about or /privacy, refresh, dev HMR) between Decline and sign-in, and
  // stays gone after sign-in (no re-show on a later normal logout). On Decline itself user goes
  // truthy→falsy, so this no-ops then; it only fires when the user actually returns.
  useEffect(() => {
    if (user) {
      setTosDeclinedNote(false);
      try { window.sessionStorage.removeItem('tosDeclined'); } catch {}
    }
  }, [user]);

  // Decline = non-destructive sign-out (clears this device's FCM token + ends the session; touches
  // NO Firestore data, so a misclick loses nothing). Sets a one-shot flag so the login screen can
  // show a reassurance note.
  const handleDecline = async () => {
    const signedOut = await signOutUser();
    if (!signedOut) { setArchiveNotice('Finish the active archive before signing out.'); return; }
    try {
      window.sessionStorage.setItem('tosDeclined', '1');
    } catch {}
    // Flip the note state live so the banner shows on this same-session re-render (the lazy
    // useState initializer only runs once at first mount, so without this the banner wouldn't
    // appear until a cold reload).
    setTosDeclinedNote(true);
  };

  const canManageWorkspaceArchive = !!user && !!currentWorkspace && currentWorkspace.ownerId === user.uid;
  const openWorkspaceArchive = useCallback((mode: 'export' | 'import') => {
    retractFooterIfUp();
    setArchiveNotice(null);
    setArchiveScope('workspace');
    setArchiveMode(mode);
  }, []);
  const openPersonalArchive = useCallback((mode: 'export' | 'import') => {
    retractFooterIfUp();
    setArchiveNotice(null);
    setArchiveScope('personal');
    setArchiveMode(mode);
  }, []);

  // PERF(PF-1) stable identity (Order 8h): the drops list receives these props; the
  // inline arrows in layoutProps churned identity on every render.
  const stableWorkspaceExport = useCallback(() => openWorkspaceArchive('export'), [openWorkspaceArchive]);
  const stablePersonalExport = useCallback(() => openPersonalArchive('export'), [openPersonalArchive]);
  const openPersonalOptions = useCallback(() => {
    retractFooterIfUp();
    setPersonalOptionsOpen(true);
  }, []);

  const handleArchiveInspect = useCallback(async (
    file: File,
    password: string,
    signal: AbortSignal,
    onProgress: (progress: WorkspaceArchiveProgress | PersonalArchiveProgress) => void
  ): Promise<WorkspaceArchiveInspection | PersonalArchiveInspection> => {
    if (archiveScope === 'personal') return inspectPersonalArchive(file, password, signal, onProgress);
    return inspectWorkspaceArchive(file, password, signal, onProgress);
  }, [archiveScope]);

  const handleArchiveImportOverlap = useCallback(async (
    archiveId: string,
    destinationWorkspaceId: string | null
  ): Promise<boolean> => {
    if (!user) throw new Error('Sign in before checking archive overlap.');
    if (archiveScope === 'personal') return hasLivePersonalArchiveOverlap(user.uid, archiveId);
    return destinationWorkspaceId ? hasLiveWorkspaceArchiveOverlap(destinationWorkspaceId, archiveId) : false;
  }, [archiveScope, user]);

  const handleArchiveExport = useCallback(async (password: string): Promise<string | null> => {
    if (!user) throw new Error('Sign in before exporting a backup.');
    if (archiveScope === 'workspace' && (!currentWorkspace || currentWorkspace.ownerId !== user.uid)) {
      throw new Error('Choose a workspace you own before exporting.');
    }
    if (archiveScope === 'personal' && currentWorkspace) throw new Error('Switch to Personal before exporting.');
    const scope = archiveScope;
    const workspace = currentWorkspace ? { ...currentWorkspace } : null;
    const sourceDrops = drops.map((drop) => ({ ...drop }));
    const sourceCategories = categories.map((category) => ({ ...category }));
    const sourceMembers = resolvedWorkspaceMembers.map((member) => ({ ...member }));
    const jobId = crypto.randomUUID();
    const exactFileName = scope === 'personal'
      ? personalArchiveFileName('personal', new Date())
      : workspaceArchiveFileName(workspace!.name, new Date());
    const descriptor: ArchiveJobDescriptor = {
      jobId, uid: user.uid, kind: 'export', scope,
      sourceWorkspaceId: workspace?.id || null, sourceWorkspaceName: workspace?.name,
      sourceDropIds: sourceDrops.map((drop) => drop.id), startedAt: Date.now(),
    };
    archiveManager.reserveForStart(descriptor);
    let saveHandle;
    try {
      const picker = requestArchiveSaveHandle(exactFileName, 'DropSync backup');
      saveHandle = picker ? await picker : null;
    } catch (error) {
      archiveManager.releaseReservation(jobId);
      if (error instanceof DOMException && error.name === 'AbortError') return null;
      throw error;
    }
    void archiveManager.startUnderLock(descriptor, async (signal, onProgress, onFinalClose) => {
      if (scope === 'personal') {
        const result: PersonalArchiveExportResult = await exportPersonalArchive({
          drops: sourceDrops, categories: sourceCategories, userId: descriptor.uid,
          sourceDisplayName: user.displayName || user.email?.split('@')[0] || null,
          password, suggestedName: 'personal', exactFileName, saveHandle, onFinalizing: onFinalClose,
          signal, onProgress,
        });
        return [
          result.saveKind === 'picker' ? 'Personal backup saved.' : 'Backup download started; check your downloads.',
          result.skippedExpiredCount ? result.skippedExpiredCount + ' expired drops skipped.' : '',
          result.skippedDrops.length ? result.skippedDrops.length + ' drops could not be decrypted and were skipped.' : '',
          result.uneditableDrawingNames.length ? result.uneditableDrawingNames.length + ' drawings included without editable data.' : '',
        ].filter(Boolean).join(' ');
      }
      const members = sourceMembers.length ? sourceMembers : await getWorkspaceMembers(workspace!.members, workspace!.ownerId);
      const result = await exportWorkspaceArchive({
        workspace: workspace!, drops: sourceDrops, categories: sourceCategories, members,
        userId: descriptor.uid, password, exactFileName, saveHandle, onFinalizing: onFinalClose,
        signal, onProgress,
      });
      return [
        result.saveKind === 'picker' ? 'Workspace backup saved.' : 'Backup download started; check your downloads.',
        result.skippedExpiredCount ? result.skippedExpiredCount + ' expired drops skipped.' : '',
        result.uneditableDrawingNames.length ? result.uneditableDrawingNames.length + ' drawings included without editable data.' : '',
      ].filter(Boolean).join(' ');
    }).catch((error) => setArchiveNotice(error instanceof Error ? error.message : 'Could not start the archive.'));
    return jobId;
  }, [archiveManager, archiveScope, categories, currentWorkspace, drops, resolvedWorkspaceMembers, user]);

  const handleArchiveImport = useCallback(async (
    file: File,
    password: string,
    destination: { mode: 'new'; workspaceName: string } | { mode: 'merge'; workspaceId: string } | undefined
  ): Promise<string | null> => {
    if (!user) throw new Error('Sign in before importing a backup.');
    if (archiveScope === 'workspace' && !destination) throw new Error('Choose a workspace destination.');
    const scope = archiveScope;
    const jobId = crypto.randomUUID();
    const chosenDestination = destination ? { ...destination } : undefined;
    const descriptor: ArchiveJobDescriptor = {
      jobId, uid: user.uid, kind: 'import', scope,
      destinationMode: chosenDestination?.mode,
      destinationId: chosenDestination?.mode === 'merge' ? chosenDestination.workspaceId : null,
      destinationName: chosenDestination?.mode === 'new' ? chosenDestination.workspaceName : undefined,
      sourceDropIds: [], startedAt: Date.now(),
    };
    archiveManager.reserveForStart(descriptor);
    void archiveManager.startUnderLock(descriptor, async (signal, onProgress) => {
      if (scope === 'personal') {
        const result: PersonalArchiveImportResult = await importPersonalArchive({
          file, password, userId: descriptor.uid, jobId, signal, onProgress,
        });
        refreshDrops();
        return [
          'Personal backup imported: ' + result.importedCount + ' drops.',
          result.legacyExpiryFallbackCount ? 'Finite drops restarted from their saved duration.' : 'Finite drop timers resumed from their saved remaining time.',
          result.zeroRemainingCount ? result.zeroRemainingCount + ' drops may expire immediately.' : '',
          result.downgradedForeverCount ? result.downgradedForeverCount + ' forever drops were downgraded to 24 hours.' : '',
          result.unpinnedCount ? result.unpinnedCount + ' pins were adjusted for the two-pin limit.' : '',
          ...result.warnings,
        ].filter(Boolean).join(' ');
      }
      const result: WorkspaceArchiveImportResult = await importWorkspaceArchive({
        file, password, userId: descriptor.uid, destination: chosenDestination!, jobId, signal, onProgress,
      });
      refreshDrops();
      return [
        'Workspace backup imported into "' + (chosenDestination?.mode === 'new' ? chosenDestination.workspaceName : workspaces.find((ws) => ws.id === chosenDestination?.workspaceId)?.name || 'workspace') + '": ' + result.importedCount + ' drops.',
        result.legacyExpiryFallbackCount ? 'Finite drops restarted from their saved duration.' : 'Finite drop timers resumed from their saved remaining time.',
        result.zeroRemainingCount ? result.zeroRemainingCount + ' drops may expire immediately.' : '',
        result.downgradedForeverCount ? result.downgradedForeverCount + ' forever drops were downgraded to 24 hours.' : '',
        result.unpinnedCount ? result.unpinnedCount + ' pins were adjusted for the two-pin limit.' : '',
        ...result.warnings,
      ].filter(Boolean).join(' ');
    }).catch((error) => setArchiveNotice(error instanceof Error ? error.message : 'Could not start the archive.'));
    return jobId;
  }, [archiveManager, archiveScope, refreshDrops, user, workspaces]);

  // Reveal the signed-in screen only when its own loading gates have resolved.
  // Account prompts can appear immediately; the main app also waits for initial data.
  useEffect(() => {
    if (!themeLoaded || !user || authLoading) return;
    const accountScreenReady = !user.emailVerified || tosStatus === 'needed' || tosStatus === 'error';
    const mainScreenReady = tosStatus === 'accepted' && !encryptionInitializing && !workspacesLoading && !dropsLoading;
    if (accountScreenReady || mainScreenReady) document.dispatchEvent(new Event('dropsync:app-ready'));
  }, [themeLoaded, user, authLoading, tosStatus, encryptionInitializing, workspacesLoading, dropsLoading]);

  // Wait for theme to load to prevent flash. While waiting, emit the PREPAINT_BG <script> (runs
  // during parse, before first paint) so the body background is the saved theme color immediately —
  // closing the white/cream hard-refresh flash. This branch is what SSR renders. It also emits the
  // ORDER-60c BOOT_SCRIPT: the landing boot loader starts during parse, before the client bundle
  // downloads, and reveals via html[data-boot] once load + fonts + sculpture/app readiness land.
  if (!themeLoaded) {
    return (
      <>
        <script dangerouslySetInnerHTML={{ __html: PREPAINT_BG }} />
        <script dangerouslySetInnerHTML={{ __html: BOOT_SCRIPT }} />
      </>
    );
  }

  // The shared loading design also covers auth changes after the initial boot.
  if (authLoading) {
    return <LoadingIndicator fullScreen />;
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
    return (
      <>
        <Landing
          onSignIn={emailSignIn}
          onSignUp={signUp}
          onResetPassword={resetPassword}
          onGoogleSignIn={signIn}
          onShowVerifyModal={handleShowVerifyModal}
          declineNote={tosDeclinedNote && <TosDeclinedNote theme="light" layoutMode="editorial" />}
        />
        {showVerifyModal && (
          <EditorialVerifyEmailModal
            email={verifyEmail}
            onResend={resendVerification}
            onClose={() => setShowVerifyModal(false)}
            theme={theme}
          />
        )}
      </>
    );
  }

  // ToS consent gate — after login + verified email, before the main app. Four states; the gate is
  // NEVER painted from 'unknown' (a loader is shown instead, so already-accepted users never see it
  // flash). 'accepted' falls through to the main app below.
  if (user && tosStatus === 'unknown') {
    return <LoadingIndicator fullScreen />;
  }

  if (user && tosStatus === 'error') {
    return (
      <TermsConsentGate
        status="error"
        variant={layoutMode === 'editorial' ? 'editorial' : 'classic'}
        theme={theme}
        uid={user.uid}
        onAccepted={() => setTosStatus('accepted')}
        onDecline={handleDecline}
        onRetry={() => setConsentRetry((n) => n + 1)}
      />
    );
  }

  if (user && tosStatus === 'needed') {
    return (
      <TermsConsentGate
        status="needed"
        variant={layoutMode === 'editorial' ? 'editorial' : 'classic'}
        theme={theme}
        uid={user.uid}
        onAccepted={() => setTosStatus('accepted')}
        onDecline={handleDecline}
      />
    );
  }

  // Main app — delegate to layout component
  const activeChatDropRequest = pendingChatDropQueue.find((request) => (
    request.workspaceId === currentWorkspaceId && request.userId === user?.uid
  ));
  const layoutProps = {
    theme, setTheme, themeColors,
    user, layoutMode, setLayoutMode: handleLayoutChange,
    quickJumpExternalBlocked: !!(showYoutubeBackfill || personalOptionsOpen || archiveMode || archivePanelJobId),
    showChat, setShowChat,
    chatMode, setChatMode,
    pendingChatDropRequest: activeChatDropRequest,
    pendingAgentDropRequest: pendingAgentDropQueue.find(request =>
      request.workspaceId === currentWorkspaceId && request.userId === user?.uid && request.panelKey === layoutMode),
    onSendDropToAgent: handleSendDropToAgent,
    onAgentDropHandled: handleAgentDropHandled,
    onSendDropToChat: handleSendDropToChat,
    onChatDropHandled: handleChatDropHandled,
    unreadCount,
    onToggleChat: handleToggleChat,
    notifPermission, notifMuted, onToggleNotifications: handleToggleNotifications,
    footerEnabled, onToggleFooterEnabled,
    onExportWorkspace: canManageWorkspaceArchive ? stableWorkspaceExport : undefined,
    onImportWorkspace: canManageWorkspaceArchive ? () => openWorkspaceArchive('import') : undefined,
    onExportPersonal: user && !currentWorkspace ? stablePersonalExport : undefined,
    onOpenPersonalOptions: user ? openPersonalOptions : undefined,
    youtubeBackfillVisible: youtubeBackfillVisibilityReady && youtubeBackfillVisible,
    onOpenYoutubeBackfill: () => setShowYoutubeBackfill(true),
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
    categories, handleCreateCategory, handleDeleteCategory: stableDeleteCategory,
    handleCreateWorkspace, handleJoinWorkspace,
    handleDeleteWorkspace, handleLeaveWorkspace, handleLeaveAndTransfer,
    forceEndPending,
    onKick: handleKickMember, isKicking: isKickingMember,
    handlePreview, handleOpenRootDrop: stableOpenRootDrop, handleOpenMentionedDrop, handlePreviewBack,
    handleClosePreview, clearPreviewTrail, dropTrailLength: dropTrail.length,
    handleShowVerifyModal, handleCheckVerification,
    signIn, emailSignIn, signUp, resetPassword, resendVerification,
    signOutUser, updateDisplayName, reauthenticateUser,
    editDrop, setEditDrop, handleEditDrop: stableEditDrop, handleEditSubmit, onEditClose: handleEditClose,
    handlePreviewInvalidate, editPreparing,
    presenceMap,
    hoverable,
    activeCallDrop, callMinimized, callState, reopenCallDropId,
    callCanStart: callAccess.canStart,
    callAccessLoading: callAccess.loading,
    callAccessError: callAccess.error,
    onRefreshCallAccess: callAccess.refresh,
    onStartCall: handleStartCall,
    onJoinCall: stableJoinCall,
    onMinimizeCall: handleMinimizeCall,
    onLeaveCall: handleLeaveCall,
  };

  const transitionClass = layoutTransition === 'fade-out'
    ? 'layout-fade-out'
    : layoutTransition === 'fade-in'
      ? 'layout-fade-in'
      : '';

  return (
    <>
      <div id="app-shell" className={`sticky top-0 z-[1] h-[100dvh] overflow-x-hidden overflow-y-hidden ${transitionClass}`}>
        {layoutMode === 'editorial'
          ? <EditorialLayout {...layoutProps} onSortModeChange={handleEditorialSortModeChange} />
          : <ClassicLayout {...layoutProps} />}
      </div>
      {showYoutubeBackfill && user && (
        <YouTubeBackfillModal
          userId={user.uid}
          workspaces={workspaces}
          theme={theme}
          variant={layoutMode === 'editorial' ? 'editorial' : 'classic'}
          onClose={() => setShowYoutubeBackfill(false)}
        />
      )}
      {personalOptionsOpen && (
        <WorkspaceOptionsModal
          scope="personal"
          workspace={null}
          theme={theme}
          variant={layoutMode === 'editorial' ? 'editorial' : 'classic'}
          isDeleting={false}
          isLeaving={false}
          isKicking={false}
          onKick={() => {}}
          currentUserId={user?.uid || null}
          onDelete={() => {}}
          onLeaveAndTransfer={() => {}}
          onImport={() => {
            setPersonalOptionsOpen(false);
            openPersonalArchive('import');
          }}
          onClose={() => setPersonalOptionsOpen(false)}
        />
      )}
      {archiveMode && (
        <WorkspaceArchiveModal
          scope={archiveScope}
          mode={archiveMode}
          variant={layoutMode === 'editorial' ? 'editorial' : 'classic'}
          theme={theme}
          currentWorkspace={archiveScope === 'workspace' ? currentWorkspace : null}
          workspaces={archiveScope === 'workspace' ? workspaces.filter((workspace) => workspace.ownerId === user?.uid) : []}
          onExport={handleArchiveExport}
          onInspect={handleArchiveInspect}
          onImport={handleArchiveImport}
          onCheckImportOverlap={handleArchiveImportOverlap}
          onStarted={(jobId) => { setArchiveMode(null); setArchivePanelShowAll(false); setArchivePanelJobId(jobId); }}
          onClose={() => setArchiveMode(null)}
        />
      )}
      {archivePanelJobId && user && <ArchiveProgressPanel key={archivePanelJobId + String(archivePanelShowAll)} jobId={archivePanelJobId} uid={user.uid}
        theme={theme} variant={layoutMode === 'editorial' ? 'editorial' : 'classic'}
        showAllInitially={archivePanelShowAll}
        onBack={() => setArchivePanelJobId(null)} />}
      <ArchiveChipStack editorial={layoutMode === 'editorial'} callPill={!!activeCallDrop && callMinimized}
        onOpen={(jobId, showAll) => { setArchivePanelShowAll(!!showAll); setArchivePanelJobId(jobId); }} />
      <OperationsPanel theme={theme} />
      {footerActive && <Footer onHideFooter={onHideFooter} />}
      {activeCallDrop && callMinimized && hoverable && (
        <LiveCallMinimizedPill
          workspaceName={currentWorkspace?.name || 'Live call'}
          theme={theme}
          variant={layoutMode === 'editorial' ? 'editorial' : 'classic'}
          onRestore={handleRestoreCall}
        />
      )}
      {callNotice && (
        <Toast
          message={callNotice}
          theme={theme}
          editorial={layoutMode === 'editorial'}
          onDone={() => setCallNotice(null)}
        />
      )}
      {removedNotice && (
        <Toast
          message={removedNotice}
          theme={theme}
          editorial={layoutMode === 'editorial'}
          onDone={handleRemovedNoticeDone}
        />
      )}
      {activeGoodbye && (
        <Toast
          message={activeGoodbye.text}
          duration={6}
          theme={theme}
          editorial={layoutMode === 'editorial'}
          onDone={() => {
            void activeGoodbye.ack();
            setActiveGoodbye(null);
            advanceGoodbye();
          }}
        />
      )}
      {archiveNotice && (
        <Toast
          message={archiveNotice}
          duration={8}
          theme={theme}
          editorial={layoutMode === 'editorial'}
          onDone={() => setArchiveNotice(null)}
        />
      )}
      {authActionNotice && <Toast message={authActionNotice} duration={6} theme={theme}
        editorial={layoutMode === 'editorial'} onDone={clearAuthActionNotice} />}
      {workspaceDeleteError && (
        <Toast
          message={workspaceDeleteError}
          duration={6}
          theme={theme}
          editorial={layoutMode === 'editorial'}
          onDone={() => setWorkspaceDeleteError(null)}
        />
      )}
    </>
  );
}
