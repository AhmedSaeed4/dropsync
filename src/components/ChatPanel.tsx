'use client';

import { useState, useRef, useEffect, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import { ThinkingOrb } from 'thinking-orbs';
import { auth } from '@/lib/firebase';
import { getLenis, lockScroll, unlockScroll } from './SmoothScrollProvider';
import { useTypingStatus, formatTypingText } from '@/hooks/useTypingStatus';
import { useNearBottom } from '@/hooks/useNearBottom';
import { useDelayedUnmount } from '@/hooks/useDelayedUnmount';
import type { PresenceMap } from '@/hooks/usePresence';
import { formatLastSeen } from '@/lib/presence';
import {
  subscribeToMessages,
  saveMessage,
  createConversation,
  deleteConversation,
  listConversations,
  Conversation,
  ChatMessage,
} from '@/lib/chat';
import { subscribeToGroupMessages, sendGroupMessage, editGroupMessage, deleteGroupMessage, clearGroupChat, getSeenBy } from '@/lib/groupChat';
import { streamAgentChat, AgentStoppedError, AgentRateLimitError, AgentTransientError } from '@/lib/agentActivity';
import { useSmoothStream } from '@/hooks/useSmoothStream';
import { useInPanelMarkRead } from '@/hooks/useInPanelMarkRead';
import { useMentionEditor } from '@/hooks/useMentionEditor';
import { useVoiceTranscribe } from '@/hooks/useVoiceTranscribe';
import { Toast } from '@/components/Toast';
import { Drop, GroupChatMessage } from '@/types';
import { DropPickerRow } from './DropPickerRow';
import { DropMentionContent } from './DropMentionContent';
import { MessageContextMenu } from '@/components/MessageContextMenu';
import { ReplyQuoteBlock, ReplyPreviewBar } from '@/components/ReplyQuoteBlock';
import { useMessageScroll } from '@/hooks/useMessageScroll';

interface ChatPanelProps {
  theme: 'light' | 'dark' | 'minimal';
  onClose: () => void;
  onPreviewDrop?: (dropId: string, workspaceId: string | null) => void;
  workspaceId?: string | null;
  workspaceMembers?: any[];
  chatMode?: 'ai' | 'group';
  onChatModeChange?: (mode: 'ai' | 'group') => void;
  drops?: Drop[];
  ownerId?: string | null;
  presence?: PresenceMap;
}

const AGENT_URL = process.env.NEXT_PUBLIC_AGENT_URL || 'http://localhost:8000';

function getThemeStyles(theme: 'light' | 'dark' | 'minimal') {
  switch (theme) {
    case 'dark':
      return {
        panelBg: 'bg-[#1A1A1A]',
        borderColor: 'border-white/10',
        headerBg: 'bg-[#0D0D0D]',
        headerText: 'text-white',
        inputBg: 'bg-[#0D0D0D]',
        inputText: 'text-white',
        inputBorder: 'border-white/20',
        userBubble: 'bg-[#FF5A47] text-white',
        assistantBubble: 'bg-white/10 text-white',
        placeholder: 'placeholder-white/30',
        fontClass: 'font-mono',
        roundedClass: '',
        muted: 'text-white/40',
        hoverBg: 'hover:bg-white/10',
        activeBg: 'bg-white/10',
        dangerBtn: 'text-red-400 hover:text-red-300',
        focusRing: 'focus:ring-white/30',
        sendBtn: 'bg-[#FF5A47] hover:bg-[#E54A37]',
        spinnerBorder: 'border-white/30 border-t-white',
        dotColor: 'bg-white',
        panelShadow: '',
        panelBorderWidth: 'border',
        msgAnimation: 'animate-chat-msg',
        enterAnimation: 'animate-fade-in-dark',
        exitAnimation: 'animate-fade-out-dark',
        animDuration: 'duration-250',
      };
    case 'minimal':
      return {
        panelBg: 'bg-[#D4D8C8]',
        borderColor: 'border-transparent',
        headerBg: 'bg-[#1A1A1A]/5',
        headerText: 'text-[#1A1A1A]',
        inputBg: 'bg-white',
        inputText: 'text-[#1A1A1A]',
        inputBorder: 'border-transparent',
        userBubble: 'bg-[#1A1A1A] text-white',
        assistantBubble: 'bg-white text-[#1A1A1A] shadow-[0_2px_8px_rgba(0,0,0,0.06)]',
        placeholder: 'placeholder-[#1A1A1A]/30',
        fontClass: 'font-sans',
        roundedClass: 'rounded-lg',
        muted: 'text-[#1A1A1A]/40',
        hoverBg: 'hover:bg-[#1A1A1A]/8',
        activeBg: 'bg-[#1A1A1A]/15 text-[#1A1A1A]',
        dangerBtn: 'text-red-500 hover:text-red-400',
        focusRing: 'focus:shadow-[0_4px_16px_rgba(0,0,0,0.1)] focus:outline-none',
        sendBtn: 'bg-[#1A1A1A] hover:bg-[#333]',
        spinnerBorder: 'border-[#1A1A1A]/30 border-t-[#1A1A1A]',
        dotColor: 'bg-[#1A1A1A]',
        panelShadow: 'shadow-[0_8px_32px_rgba(0,0,0,0.1)]',
        panelBorderWidth: 'border-0',
        msgAnimation: 'animate-spring-msg',
        enterAnimation: 'animate-fade-in-minimal',
        exitAnimation: 'animate-fade-out-minimal',
        animDuration: 'duration-300',
      };
    default:
      return {
        panelBg: 'bg-[#FAF7F2]',
        borderColor: 'border-[#1A1A1A]',
        headerBg: 'bg-[#1A1A1A]',
        headerText: 'text-white',
        inputBg: 'bg-[#F5F2ED]',
        inputText: 'text-[#1A1A1A]',
        inputBorder: 'border-[#1A1A1A]',
        userBubble: 'bg-[#FF5A47] text-white',
        assistantBubble: 'bg-[#F5F2ED] text-[#1A1A1A] border border-[#1A1A1A]',
        placeholder: 'placeholder-[#1A1A1A]/40',
        fontClass: 'font-mono',
        roundedClass: '',
        muted: 'text-[#1A1A1A]/40',
        hoverBg: 'hover:bg-[#1A1A1A]/10',
        activeBg: 'bg-[#FF5A47]/10 text-[#1A1A1A]',
        dangerBtn: 'text-red-500 hover:text-red-400',
        focusRing: 'focus:ring-[#FF5A47]/30 focus:border-[#FF5A47]',
        sendBtn: 'bg-[#FF5A47] hover:bg-[#E54A37]',
        spinnerBorder: 'border-[#1A1A1A]/30 border-t-[#1A1A1A]',
        dotColor: 'bg-[#1A1A1A]',
        panelShadow: 'shadow-[8px_8px_0_#1A1A1A]',
        panelBorderWidth: 'border-2',
        msgAnimation: 'animate-chat-msg',
        enterAnimation: 'animate-fade-in-light',
        exitAnimation: 'animate-fade-out-light',
        animDuration: 'duration-200',
      };
  }
}

const WELCOME = 'Hi! I can help you manage your drops. Ask me to list drops, search content, check storage stats, or manage workspaces.';

export function ChatPanel({ theme, onClose, onPreviewDrop, workspaceId, workspaceMembers, chatMode: chatModeProp, onChatModeChange, drops, ownerId, presence }: ChatPanelProps) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConvId, setActiveConvId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  // Live "what the agent is doing" label from /chat/stream activity events, shown (with the
  // shimmer treatment) beside the loader while loading. null = nothing to show yet.
  const [activity, setActivity] = useState<string | null>(null);
  // Streaming reply handoff: the id of the assistant message we just saved. The streaming
  // bubble stays mounted until THIS message renders from Firestore (derived in render, so
  // the bubble-hide and message-show land in the same commit — no gap, no duplicate).
  const [savedMsgId, setSavedMsgId] = useState<string | null>(null);
  // Smooth typing-like reveal of the streamed answer text.
  const smooth = useSmoothStream();
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [showSidebar, setShowSidebar] = useState(false);
  const [isExiting, setIsExiting] = useState(false);
  const [showWelcome, setShowWelcome] = useState(false);
  const [animateMessages, setAnimateMessages] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  // Group chat state — lifted to parent, fallback to local
  const [localChatMode, setLocalChatMode] = useState<'ai' | 'group'>('ai');
  const chatMode = chatModeProp ?? localChatMode;
  const setChatMode = onChatModeChange ?? setLocalChatMode;
  const [groupMessages, setGroupMessages] = useState<GroupChatMessage[]>([]);
  const [groupMessagesLoading, setGroupMessagesLoading] = useState(true);
  const [groupInput, setGroupInput] = useState('');
  const [groupSending, setGroupSending] = useState(false);
  const [clearConfirm, setClearConfirm] = useState(false);
  const [systemNotice, setSystemNotice] = useState<string | null>(null);
  const [clearLoading, setClearLoading] = useState(false);
  const [isClearing, setIsClearing] = useState(false);
  const [noticeLeaving, setNoticeLeaving] = useState(false);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const aiReplyEpochRef = useRef(0);
  // Active assistant request's abort controller — aborted by the Stop button, panel close,
  // and unmount. NOT by conversation switch: a late reply still lands in its own
  // conversation via saveMessage(convId), matching pre-streaming behavior.
  const aiAbortRef = useRef<AbortController | null>(null);
  const [menuMsg, setMenuMsg] = useState<{ msg: GroupChatMessage; x: number; y: number; panelRight: number } | null>(null);
  const [copiedMsgId, setCopiedMsgId] = useState<string | null>(null);
  // Inline message editor — editingMsgId === msg.id swaps that bubble's text node for a textarea.
  const [editingMsgId, setEditingMsgId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');
  // Quote-reply draft — replyTo is the message being replied to; cleared on send / Escape / mode or
  // workspace switch. Display-only context; replyTo?.id is passed as sendGroupMessage's 5th arg.
  const [replyTo, setReplyTo] = useState<GroupChatMessage | null>(null);
  // Seen-by roster for the open message's "Read by" view (null = not fetched). Cleared on menu close
  // and on workspace/chat-mode switch (mirrors editingMsgId/replyTo). On-demand: one getSeenBy fetch
  // per "Seen" tap — no live listener.
  const [seenInfo, setSeenInfo] = useState<{ loading: boolean; seenUids: Set<string>; error: boolean } | null>(null);
  const groupUnsubRef = useRef<(() => void) | null>(null);
  const systemNoticeRef = useRef<HTMLDivElement>(null);
  const hadNoticeRef = useRef(false);

  // Invalidate AI preview side effects before the panel's close animation finishes, not only after
  // React unmounts the panel. Aborting also cancels the backend run (Stop-button semantics).
  useEffect(() => () => {
    aiReplyEpochRef.current += 1;
    aiAbortRef.current?.abort();
    aiAbortRef.current = null;
  }, []);

  // Inline drop-reference chips — mirrors the drop-note editor (TextModal). The group composer AND
  // the inline edit box back a contentEditable <div> with the shared useMentionEditor hook; chips
  // serialize to #[name](id), the exact token format group chat already stores/encrypts/renders, so
  // there are NO crypto / rules / data-model changes. workspaceDrops feeds the picker and resolves
  // chip targets for both the editor and the inline display.
  const workspaceDrops = useMemo(() => (drops || []).filter(d => d.workspaceId === workspaceId), [drops, workspaceId]);
  // Declared early so the editor hook below can self-exclude the current user from the @ picker.
  const userId = auth.currentUser?.uid;
  // Editor chip classes — solid fills, since the editor sits on a single input-bg surface.
  const mentionChipBase = 'inline-flex items-center mx-0.5 px-1.5 py-0.5 align-middle text-[13px] leading-none';
  const mentionFoundClass = `${mentionChipBase} ${theme === 'minimal' ? 'rounded-full font-sans bg-[#1A1A1A]' : 'font-mono bg-[#FF5A47]'} text-white`;
  const mentionDeletedClass = `${mentionChipBase} line-through opacity-50 cursor-not-allowed`;
  // @member chips use a blue accent so they read distinctly from #[drop] chips (coral) while editing.
  const mentionMemberClass = `${mentionChipBase} ${theme === 'minimal' ? 'rounded-full font-sans bg-[#1A1A1A]' : 'font-mono bg-[#2563eb]'} text-white`;
  const groupMention = useMentionEditor({ content: groupInput, setContent: setGroupInput, allDrops: workspaceDrops, foundClassName: mentionFoundClass, deletedClassName: mentionDeletedClass, allMembers: workspaceMembers, excludeUid: userId, memberClassName: mentionMemberClass });
  // editMention is a single top-level instance (Rules of Hooks); its contentEditable renders only
  // for the message being edited (editingMsgId === msg.id).
  const editMention = useMentionEditor({ content: editDraft, setContent: setEditDraft, allDrops: workspaceDrops, foundClassName: mentionFoundClass, deletedClassName: mentionDeletedClass, memberClassName: mentionMemberClass });
  // Voice-to-text mic — reuses the shared useVoiceTranscribe hook (extracted from TextModal).
  // onTranscript APPENDS to the currently-shown composer: the group composer keeps raw text
  // (newlines render as <br>); the classic AI box is a single-line <input>, so flatten newlines.
  // The hook stabilizes these callbacks via latest-refs, so a mode switch mid-recording still
  // routes the transcript to the right composer.
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const voice = useVoiceTranscribe({
    onTranscript: (text) => {
      if (chatMode === 'group') {
        setGroupInput((prev) => (prev ? prev + ' ' + text : text));
      } else {
        const flat = text.replace(/\n/g, ' ').trim();
        setInput((prev) => (prev ? prev + ' ' + flat : flat));
      }
    },
    onError: setVoiceError,
  });

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const unsubRef = useRef<(() => void) | null>(null);
  // Scroll-to-message + flash-highlight for quote-reply jumps (shared with EditorialChatPanel).
  const { setMessageRef, jumpToMessage, flashId } = useMessageScroll(scrollRef);
  const s = getThemeStyles(theme);
  const isOwner = !!userId && ownerId === userId;
  // Display chip classes — translucent fills, since a rendered chip can land on EITHER the sender's
  // own bubble (s.userBubble) or another member's (s.assistantBubble); a solid accent would vanish on
  // the own bubble. Found reuses the theme accent (matches the prior separate-card look 1:1); deleted
  // is themed (muted + strike) instead of the old gray, per "deleted chip is themed (not gray)".
  const displayChipBase = 'inline-flex items-center mx-0.5 px-1.5 py-0.5 align-middle rounded text-[10px] font-medium transition-opacity leading-none';
  const displayFoundClass = `${displayChipBase} ${s.activeBg} hover:opacity-80 cursor-pointer`;
  const displayDeletedClass = `${displayChipBase} ${s.muted} line-through cursor-not-allowed opacity-60`;
  // Displayed @member chip — blue, non-interactive (translucent so it reads on either bubble color).
  const displayUserClass = `${displayChipBase} bg-[#2563eb]/15 text-[#2563eb]`;

  // Delay welcome message fade-in until panel animation completes
  useEffect(() => {
    const timer = setTimeout(() => {
      setShowWelcome(true);
    }, 500);
    return () => clearTimeout(timer);
  }, []);

  // Load conversations list
  useEffect(() => {
    if (!userId) return;
    listConversations(userId).then(setConversations);
  }, [userId]);

  // Subscribe to messages when active conversation changes
  useEffect(() => {
    if (!userId || !activeConvId) return;

    setMessagesLoading(true);
    if (unsubRef.current) unsubRef.current();

    unsubRef.current = subscribeToMessages(userId, activeConvId, (msgs) => {
      setMessages(msgs);
      setMessagesLoading(false);
    });

    return () => {
      if (unsubRef.current) unsubRef.current();
    };
  }, [userId, activeConvId]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // Follow the stream only when already pinned near the bottom — a reader scrolled up
    // during a long reveal isn't yanked down on every reveal tick.
    if (el.scrollHeight - el.scrollTop - el.clientHeight <= 120) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, loading, smooth.revealed]);

  // Auto-switch to AI mode when workspace is deselected
  useEffect(() => {
    if (!workspaceId && chatMode === 'group') {
      setChatMode('ai');
    }
  }, [workspaceId]);

  // Subscribe to group chat messages when group tab is active
  useEffect(() => {
    if (chatMode !== 'group' || !workspaceId || !userId) {
      if (groupUnsubRef.current) {
        groupUnsubRef.current();
        groupUnsubRef.current = null;
      }
      return;
    }

    setGroupMessagesLoading(true);

    groupUnsubRef.current = subscribeToGroupMessages(workspaceId, userId, (msgs) => {
      setGroupMessages(msgs);
      setGroupMessagesLoading(false);
    });

    return () => {
      if (groupUnsubRef.current) {
        groupUnsubRef.current();
        groupUnsubRef.current = null;
      }
    };
  }, [chatMode, workspaceId, userId]);

  // Mark group messages read as they're viewed (panel open + tab visible) — closes Cause B of the
  // phantom-unread glow (messages read while the panel was open but never closed weren't persisted).
  useInPanelMarkRead(workspaceId, userId, groupMessages);

  // Group typing indicator (panel-level — only the open panel subscribes) + members-popover state.
  const typing = useTypingStatus(workspaceId, userId, workspaceMembers);
  // atBottom drives the typing-pill vs scroll-to-bottom-button swap (group only). Additive — it only
  // observes scroll position and never touches the existing scrollTop = scrollHeight auto-scroll.
  const atBottom = useNearBottom(scrollRef);
  // Fade-OUT: keep each overlay mounted ~180ms past its exit so a pure-opacity fade-out can play
  // before the real unmount (React otherwise removes instantly). shouldRender gates the element;
  // isExiting swaps in the fade-out class. Object access (not destructured) — classic has its own
  // isExiting state at the top of this component.
  const pillVisible = chatMode === 'group' && atBottom && typing.typingUsers.length > 0;
  const scrollVisible = chatMode === 'group' && !atBottom;
  const pill = useDelayedUnmount(pillVisible, 180);
  const scroll = useDelayedUnmount(scrollVisible, 180);
  const [showMembers, setShowMembers] = useState(false);
  const membersBtnRef = useRef<HTMLButtonElement>(null);
  const membersPopoverRef = useRef<HTMLDivElement>(null);
  // Close the members popover on workspace switch (the panel does not remount on switch).
  useEffect(() => setShowMembers(false), [workspaceId]);
  // Click-away: a document mousedown listener (transform-proof — the old fixed inset-0 overlay was
  // trapped inside the header's slide-in transform and never covered the panel). Ignores the trigger
  // button (so its onClick toggle still works) and the popover body. Attached only while open.
  useEffect(() => {
    if (!showMembers) return;
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (membersPopoverRef.current?.contains(target)) return;
      if (membersBtnRef.current?.contains(target)) return;
      setShowMembers(false);
    };
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [showMembers]);

  // Lock body scroll on mobile
  useEffect(() => {
    let scrollY = 0;
    let locked = false;

    const applyLock = () => {
      const isMobile = window.innerWidth < 1024;
      if (isMobile && !locked) {
        scrollY = window.scrollY;
        document.documentElement.style.overflow = 'hidden';
        document.documentElement.style.height = '100%';
        document.body.style.overflow = 'hidden';
        document.body.style.height = '100%';
        document.body.style.scrollbarGutter = 'auto';
        lockScroll(); // freeze smooth-scroll while the chat overlay locks the page (ref-counted)
        locked = true;
      } else if (!isMobile && locked) {
        document.documentElement.style.overflow = '';
        document.documentElement.style.height = '';
        document.body.style.overflow = '';
        document.body.style.height = '';
        document.body.style.scrollbarGutter = '';
        unlockScroll();
        locked = false;
      }
    };

    applyLock();
    window.addEventListener('resize', applyLock);
    return () => {
      window.removeEventListener('resize', applyLock);
      document.documentElement.style.overflow = '';
      document.documentElement.style.height = '';
      document.body.style.overflow = '';
      document.body.style.height = '';
      document.body.style.scrollbarGutter = '';
      if (locked) {
        // Route the position-restore through Lenis so its internal target stays in sync
        // (raw window.scrollTo would desync → a jump on the next wheel). Native fallback
        // when Lenis is off (reduced-motion). unlockScroll() (ref-counted) resumes Lenis
        // only if no other overlay still holds the lock.
        const lenis = getLenis();
        unlockScroll();
        if (lenis) {
          lenis.scrollTo(scrollY, { immediate: true });
        } else {
          window.scrollTo(0, scrollY);
        }
      }
    };
  }, []);

  // Auto-scroll group messages
  useEffect(() => {
    if (chatMode === 'group' && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [groupMessages, chatMode]);

  const handleNewChat = () => {
    aiReplyEpochRef.current += 1;
    setActiveConvId(null);
    setMessages([]);
    setShowSidebar(false);
    setSavedMsgId(null);
    smooth.reset();
  };

  const [switchingConv, setSwitchingConv] = useState<string | null>(null);

  const handleSwitchConv = (convId: string) => {
    if (switchingConv) return;
    if (convId === activeConvId) {
      setShowSidebar(false);
      return;
    }
    aiReplyEpochRef.current += 1;
    setSwitchingConv(convId);
    setMessages([]);
    setMessagesLoading(true);
    setActiveConvId(convId);
    setSavedMsgId(null);
    smooth.reset();
  };

  // Close sidebar when messages finish loading after switching
  useEffect(() => {
    if (switchingConv && !messagesLoading) {
      setAnimateMessages(true);
      setShowSidebar(false);
      setSwitchingConv(null);
      const timer = setTimeout(() => setAnimateMessages(false), 500);
      return () => clearTimeout(timer);
    }
  }, [messagesLoading, switchingConv]);

  const handleDeleteConv = async (convId: string) => {
    if (!userId) return;
    await deleteConversation(userId, convId);
    const updated = await listConversations(userId);
    setConversations(updated);
    if (activeConvId === convId) {
      setActiveConvId(updated.length > 0 ? updated[0].id : null);
      setMessages([]);
    }
  };

  const handleSend = async () => {
    const text = input.trim();
    if (!text || loading || !userId) return;

    const requestEpoch = ++aiReplyEpochRef.current;
    const controller = new AbortController();
    aiAbortRef.current = controller;
    setInput('');
    setLoading(true);
    setActivity(null);
    setSavedMsgId(null);
    smooth.reset();

    let convId = activeConvId;
    if (!convId) {
      const title = text.length > 40 ? text.slice(0, 40) + '...' : text;
      convId = await createConversation(userId, title);
      setActiveConvId(convId);
      const updated = await listConversations(userId);
      setConversations(updated);
    }

    await saveMessage(userId, convId, 'user', text);

    const currentUser = auth.currentUser;
    if (!currentUser) { setLoading(false); return; }

    try {
      const idToken = await currentUser.getIdToken();
      // Streaming request: activity events drive the shimmer label beside the loader; the
      // terminal event carries the same {response, previewDropId, previewWorkspaceId} the
      // old single JSON body did (with a legacy /chat fallback for deploy-order gaps).
      const data = await streamAgentChat({
        url: AGENT_URL,
        token: idToken,
        message: text,
        history: messages.map((m) => ({ role: m.role, content: m.content })),
        signal: controller.signal,
        onActivity: (label) => {
          // Epoch + abort gate so a late event never paints into a different conversation.
          if (aiReplyEpochRef.current === requestEpoch && !controller.signal.aborted) {
            setActivity(label);
          }
        },
        onDelta: (chunk) => {
          if (aiReplyEpochRef.current === requestEpoch && !controller.signal.aborted) {
            smooth.append(chunk);
          }
        },
        onDeltaReset: () => {
          if (aiReplyEpochRef.current === requestEpoch) smooth.reset();
        },
      });

      // Successful send: clear any lingering rate-limit notice (in case the reset countdown hasn't fired yet).
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
      setNoticeLeaving(false);
      setSystemNotice(null);

      if (data.previewDropId && onPreviewDrop && aiReplyEpochRef.current === requestEpoch) {
        onPreviewDrop(data.previewDropId, data.previewWorkspaceId ?? null);
      }

      // The final answer is authoritative — top up the reveal buffer, save, then hold the
      // streaming bubble until the saved message itself renders from Firestore. onId fires
      // BEFORE the write lands, so the handoff state is set before Firestore's echo can
      // render the saved twin — the duplicate race is dead.
      smooth.setFull(data.response);
      const savedId = await saveMessage(userId, convId, 'assistant', data.response, (id) => {
        if (aiReplyEpochRef.current === requestEpoch) setSavedMsgId(id);
      });
      if (aiReplyEpochRef.current === requestEpoch) {
        if (!savedId) {
          setSavedMsgId(null);
          setTimeout(() => smooth.reset(), 1500); // save failed — don't yank the text instantly
        }
      } else {
        smooth.reset(); // user switched away — the reply stays saved in its own conversation
      }
    } catch (e: any) {
      if (e instanceof AgentStoppedError) {
        // Stop-memory: the user stopped the assistant and the backend reported what
        // had already been done. Save it as a NORMAL assistant turn (no prefix, no
        // error styling) so it renders like any reply and reaches the model as
        // history on the next send. The smooth-stream bubble is dropped on purpose:
        // the partial streamed text was thinking-out-loud, and the saved summary
        // renders via the normal Firestore echo. No onId handoff — this is not the
        // success path. Saves even after close/unmount (epoch already moved): the
        // write lands in the right conversation; state updates above are inert
        // when the epoch guard fails, matching the existing late-save behavior.
        smooth.reset();
        setSavedMsgId(null);
        await saveMessage(userId, convId, 'assistant', e.summary);
        return;
      }
      if (controller.signal.aborted || e?.name === 'AbortError') {
        // Canceled (Stop button / panel close / unmount): silent — no error turn saved.
        // The user turn stays; the assistant just never answers it. Stop-memory
        // saves are handled by the AgentStoppedError branch above.
        smooth.reset();
        setSavedMsgId(null);
        return;
      }
      if (e instanceof AgentRateLimitError || e instanceof AgentTransientError) {
        // Rate limit / AI-service-busy — whether DropSync's own quota (pre-stream 429) or
        // the Gemini provider side (mid-stream): a transient toast, not a saved error
        // turn, so the message isn't persisted or replayed to the model as history later.
        showSystemNotice(e.message, 8000);
        smooth.reset();
        setSavedMsgId(null);
        return;
      }
      const errorText = `Error: ${e.message || 'Something went wrong'}`;
      smooth.setFull(errorText);
      const savedId = await saveMessage(userId, convId, 'assistant', errorText, (id) => {
        if (aiReplyEpochRef.current === requestEpoch) setSavedMsgId(id);
      });
      if (aiReplyEpochRef.current === requestEpoch) {
        if (!savedId) {
          setSavedMsgId(null);
          setTimeout(() => smooth.reset(), 1500);
        }
      } else {
        smooth.reset();
      }
    } finally {
      if (aiAbortRef.current === controller) aiAbortRef.current = null;
      setLoading(false);
      setActivity(null);
      requestAnimationFrame(() => {
        inputRef.current?.focus();
      });
    }
  };

  const activeConv = conversations.find((c) => c.id === activeConvId);

  // Streaming-reply visibility (derived in render so bubble-hide + message-show share a commit):
  // the loader/label row shows while working with no text yet; once text streams, it collapses
  // (CSS fade) and the streaming bubble takes over. The saved twin (hidden at render below
  // while the reveal is still running) swaps in only when the reveal is COMPLETE — one
  // atomic commit, identical text, identical slot: no duplicate, no mid-type removal.
  const savedMsgVisible = !!savedMsgId && messages.some((m) => m.id === savedMsgId);
  const handoffComplete = savedMsgVisible && smooth.isDone;
  const showLoaderRow = loading && !smooth.hasText;
  const showStreamBubble = smooth.hasText && !handoffComplete;

  // Once the twin has taken over, clear the stream state — drops the collapsed loader
  // wrapper (and its space-y gap) while the now-real message stays exactly where it is.
  useEffect(() => {
    if (handoffComplete) smooth.reset();
    // smooth.reset is stable
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handoffComplete]);

  // Safety net: ONLY if the saved twin never renders (offline hiccup). Once it has rendered
  // this never fires — savedMsgId must never flip back on success, or state keyed to it
  // flickers on the settled message.
  useEffect(() => {
    if (!savedMsgId) return;
    if (messages.some((m) => m.id === savedMsgId)) return;
    const timer = setTimeout(() => {
      setSavedMsgId(null);
      smooth.reset();
    }, 5000);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedMsgId, messages]);

  // Auto-grow the group composer — the classic composer used to be a single-line <input>; the
  // contentEditable wraps/grows like the editorial one, capped at 120px (the hook keeps the DOM in
  // sync, so scrollHeight is current when this runs).
  useEffect(() => {
    const el = groupMention.editorRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 120) + 'px';
  }, [groupInput]);

  // Focus the inline edit box when it opens. The hook's external→DOM effect (keyed on editDraft)
  // renders the seeded tokens as chips; this places focus + the caret at the end.
  useEffect(() => {
    if (editingMsgId) editMention.focusEditor();
    // editMention.focusEditor is stable enough for this open/close transition; we only want this to
    // fire when editingMsgId changes, not on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingMsgId]);

  // Show a transient text notice, auto-dismissed after ms
  const showSystemNotice = (text: string, ms = 4000) => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    setNoticeLeaving(false);
    setSystemNotice(text);
    noticeTimer.current = setTimeout(() => {
      setNoticeLeaving(true);              // phase 1: fade opacity out, grid stays full
      noticeTimer.current = setTimeout(() => {
        setSystemNotice(null);             // phase 2: now collapse the grid (content already invisible)
        setNoticeLeaving(false);
      }, 300);                             // matches the opacity transition duration
    }, ms);
  };

  const handleGroupSend = async () => {
    const text = groupInput.trim();
    if (groupSending || !userId || !workspaceId) return;

    // Sending (or clearing) ends any active typing state for this composer.
    typing.clearTyping();

    if (text === '/clear') {
      setGroupInput('');
      setReplyTo(null);
      if (isOwner) {
        setClearConfirm(true);
      } else {
        showSystemNotice('Only the workspace owner can clear the chat.', 4000);
      }
      return;
    }

    if (!text) {
      setReplyTo(null);
      return;
    }

    // Chips are already inline in groupInput as #[name](id) tokens (serialized by useMentionEditor),
    // so the message body IS the trimmed input — no separate attachment prepend.
    const senderName = auth.currentUser?.displayName || auth.currentUser?.email?.split('@')[0] || 'Unknown';
    setGroupInput('');
    setReplyTo(null);
    setGroupSending(true);
    // replyTo?.id is the quote pointer (CREATE only; plaintext id, never encrypted). Undefined when
    // not replying → sendGroupMessage omits the key entirely (never writes null).
    await sendGroupMessage(workspaceId, userId, senderName, text, replyTo?.id);
    setGroupSending(false);
    setTimeout(() => groupMention.editorRef.current?.focus(), 100);
  };

  const handleClose = () => {
    aiReplyEpochRef.current += 1;
    aiAbortRef.current?.abort();
    aiAbortRef.current = null;
    setIsExiting(true);
    setTimeout(() => {
      onClose();
    }, theme === 'light' ? 200 : theme === 'dark' ? 250 : 300);
  };

  const handleClearChat = async () => {
    if (!workspaceId) return;
    setClearConfirm(false);       // collapse the card WITH the messages — unified wipe
    setIsClearing(true);          // messages fade out
    setClearLoading(true);
    try {
      await new Promise(r => setTimeout(r, 320));  // let the wipe play
      await clearGroupChat(workspaceId);
      setIsClearing(false);       // empty state fades in; card already gone → no flash
      showSystemNotice('Chat cleared', 3000);
    } catch (error) {
      console.error('Error clearing group chat:', error);
      setIsClearing(false);
      showSystemNotice('Failed to clear chat. Please try again.', 4000);
    } finally {
      setClearLoading(false);
    }
  };

  // WhatsApp-style: the per-message chevron opens the action menu at the BUTTON's rect (just below
  // it), reusing the existing x/y model + MessageContextMenu's viewport-overflow flip — so NO change
  // to that component's positioning. stopPropagation so the click never triggers the panel-root
  // focus-on-click. (Replaces the old right-click / 700ms-long-press trigger, which is removed.)
  const openMenuFromButton = (e: React.MouseEvent, msg: GroupChatMessage) => {
    e.preventDefault();
    e.stopPropagation();
    const r = e.currentTarget.getBoundingClientRect();
    const panelRight = panelRef.current?.getBoundingClientRect().right ?? window.innerWidth;
    setMenuMsg({ msg, x: r.left, y: r.bottom, panelRight });
  };

  const handleCopyMessage = async (msg: GroupChatMessage) => {
    try {
      await navigator.clipboard.writeText(msg.content);
      setCopiedMsgId(msg.id);
      setTimeout(() => setCopiedMsgId(null), 2000);
    } catch (error) {
      console.error('Failed to copy message:', error);
    }
  };

  const handleDeleteMessage = async (msg: GroupChatMessage) => {
    if (!workspaceId) return;
    await deleteGroupMessage(workspaceId, msg.id);
  };

  const closeMessageMenu = () => { setMenuMsg(null); setSeenInfo(null); };

  // On-demand fetch of which members have read `msg` (server-derived from readState cursors). Drives
  // the "Read by" roster in the message menu. Silent failure → error state in the menu (no toast).
  const handleSeen = async (msg: GroupChatMessage) => {
    if (!workspaceId) return;
    setSeenInfo({ loading: true, seenUids: new Set(), error: false });
    try {
      const seenUids = await getSeenBy(workspaceId, msg.id);
      setSeenInfo({ loading: false, seenUids: new Set(seenUids), error: false });
    } catch {
      setSeenInfo({ loading: false, seenUids: new Set(), error: true });
    }
  };

  // Inline edit lifecycle. editDraft is seeded from the RAW message content (not the parsed parts) so
  // #[name](id) attachment mentions survive the round-trip and re-parse correctly after save. Silent:
  // editGroupMessage never notifies. On failure we revert to the old content (cancel) + log.
  // Quote-reply lifecycle. startReply closes the action menu, stashes the message being replied to,
  // and focuses the composer so the user can type immediately. clearReply drops it (✕ / Escape /
  // send / mode or workspace switch).
  const startReply = (msg: GroupChatMessage) => {
    setMenuMsg(null);
    setReplyTo(msg);
    groupMention.editorRef.current?.focus();
  };
  const clearReply = () => setReplyTo(null);
  const startEditing = (msg: GroupChatMessage) => {
    setMenuMsg(null);
    setEditingMsgId(msg.id);
    setEditDraft(msg.content);
  };
  const cancelEditing = () => {
    setEditingMsgId(null);
    setEditDraft('');
  };
  const saveEdit = async (msg: GroupChatMessage) => {
    if (!workspaceId || !userId) return;
    const text = editDraft;
    if (!text.trim()) return; // never persist an empty edit (Save is also disabled while empty)
    const ok = await editGroupMessage(workspaceId, msg.id, userId, text);
    if (ok) {
      setEditingMsgId(null);
      setEditDraft('');
    } else {
      console.error('Failed to edit message');
      cancelEditing();
    }
  };

  // Cancel any open editor / reply draft when the user leaves this workspace / chat mode — the panel
  // does NOT remount on a workspace switch (its groupMessages state isn't cleared), so without this
  // an editingMsgId / replyTo could outlive the message it points at.
  useEffect(() => {
    setEditingMsgId(null);
    setEditDraft('');
    setReplyTo(null);
    setSeenInfo(null);
  }, [workspaceId, chatMode]);

  // Scroll a notice into view ONLY when one appears from nothing.
  // Skip the confirm→success/error handoff (card collapsing into a divider):
  // the user is already viewing that spot, and a smooth scroll there chases the
  // divider (which shifts as the card above collapses) and flickers the card.
  useEffect(() => {
    const hasNotice = !!(clearConfirm || systemNotice);
    const justAppeared = hasNotice && !hadNoticeRef.current;
    hadNoticeRef.current = hasNotice;
    if (!justAppeared) return;

    const scroll = () =>
      systemNoticeRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    const raf = requestAnimationFrame(scroll);
    const t = setTimeout(scroll, 320); // the height transition is ~300ms
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(t);
    };
  }, [clearConfirm, systemNotice]);

  // Clear any pending notice timer on unmount so no setState fires afterward
  useEffect(() => () => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
  }, []);

  const handleCopy = async (msgId: string, content: string, messageElement: HTMLElement) => {
    const codeBlock = messageElement.querySelector('pre code');
    const textToCopy = codeBlock ? (codeBlock.textContent || '') : content;
    await navigator.clipboard.writeText(textToCopy);
    setCopiedId(msgId);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const animationClass = isExiting ? s.exitAnimation : s.enterAnimation;

  return (
    <div ref={panelRef} onClick={() => (chatMode === 'group' ? groupMention.editorRef.current : inputRef.current)?.focus()} className={`relative flex flex-col h-[520px] overflow-hidden ${s.panelBorderWidth} ${s.borderColor} ${s.panelBg} ${s.panelShadow} ${animationClass} ${s.roundedClass} ${theme === 'minimal' ? 'minimal-scroll' : ''}`}>
      {/* Header */}
      <div className={`border-b ${s.borderColor} px-4 py-3 ${s.headerBg} flex items-center justify-between shrink-0`}>
        <div className="flex items-center gap-2">
          {chatMode === 'ai' && (
            <button
              onClick={() => setShowSidebar(!showSidebar)}
              className={`${s.headerText} opacity-60 hover:opacity-100 transition-opacity`}
              title="Chat history"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            </button>
          )}
          <h3 className={`text-[10px] ${s.fontClass} uppercase tracking-wider ${s.headerText} truncate max-w-[140px]`}>
            {chatMode === 'group' ? 'WORKSPACE CHAT' : (activeConv ? activeConv.title : (theme === 'minimal' ? 'AI Assistant' : 'DROP/AI'))}
          </h3>
        </div>

        {/* Tab toggle */}
        <div className="flex gap-1">
          <button
            onClick={() => setChatMode('ai')}
            className={`px-2 py-1 text-[10px] ${s.fontClass} uppercase tracking-wider transition-colors ${
              chatMode === 'ai' ? s.activeBg + ' ' + s.headerText : s.muted + ' ' + s.hoverBg
            } ${s.roundedClass}`}
          >
            {theme === 'minimal' ? 'AI' : 'AI'}
          </button>
          <button
            onClick={() => workspaceId && setChatMode('group')}
            disabled={!workspaceId}
            title={!workspaceId ? 'Select a workspace to chat' : ''}
            className={`px-2 py-1 text-[10px] ${s.fontClass} uppercase tracking-wider transition-colors ${
              chatMode === 'group' ? s.activeBg + ' ' + s.headerText : s.muted + ' ' + s.hoverBg
            } ${!workspaceId ? 'opacity-30 cursor-not-allowed' : ''} ${s.roundedClass}`}
          >
            Workspace
          </button>
          {chatMode === 'group' && (
            <span className="relative inline-flex">
              <button
                ref={membersBtnRef}
                type="button"
                onClick={() => setShowMembers((v) => !v)}
                title="Members"
                className={`py-1 px-1 rounded transition-colors ${showMembers ? s.headerText : s.muted} ${s.hoverBg}`}
              >
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="8" r="3.4" />
                  <path d="M5.5 20c0-3.4 2.9-6 6.5-6s6.5 2.6 6.5 6" />
                </svg>
              </button>
              {showMembers && (
                <div ref={membersPopoverRef} className="absolute top-full -right-2 mt-2 z-50">
                    {/* Pointer notch — a sibling of the scrollable card so the card's overflow-y-auto can't clip it. */}
                    <span className={`absolute -top-1.5 right-[16px] w-3 h-3 rotate-45 ${theme === 'dark' ? 'bg-[#2A2A2A] border-t border-l border-white/10' : 'bg-white border-t border-l border-black/10'}`} />
                    <div className={`w-56 max-h-[300px] overflow-y-auto border p-1.5 ${s.roundedClass} ${theme === 'dark' ? 'bg-[#2A2A2A] border-white/10 shadow-[0_10px_30px_rgba(0,0,0,0.55)]' : 'bg-white border-black/10 shadow-[0_12px_34px_rgba(0,0,0,0.10)]'}`}>
                    <div className={`flex items-center justify-between px-2 py-1 text-[10px] uppercase tracking-wider ${s.muted} ${s.fontClass}`}>
                      <span>Members</span>
                      <span>{(workspaceMembers || []).filter((m) => m.uid === userId || presence?.[m.uid]?.online).length} online</span>
                    </div>
                    {[...(workspaceMembers || [])]
                      .map((m) => ({
                        uid: m.uid as string,
                        displayName: (m.displayName as string) || 'Unknown',
                        online: m.uid === userId ? true : !!presence?.[m.uid]?.online,
                        lastSeen: presence?.[m.uid]?.lastSeen,
                      }))
                      .sort((a, b) => (b.online ? 1 : 0) - (a.online ? 1 : 0))
                      .map((m) => (
                        <div key={m.uid} className={`flex items-center gap-2 px-2 py-1.5 text-xs ${s.fontClass} ${s.hoverBg} rounded`}>
                          <span className={`w-2 h-2 rounded-full shrink-0 ${m.online ? 'bg-green-500' : 'bg-gray-400'}`} />
                          <span className={`truncate ${s.inputText}`}>{m.displayName}{m.uid === userId && ' (you)'}</span>
                          <span className={`ml-auto text-[10px] ${s.muted}`}>{m.online ? 'Online' : m.lastSeen ? formatLastSeen(m.lastSeen) : ''}</span>
                        </div>
                      ))}
                    </div>
                  </div>
              )}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          {chatMode === 'ai' && (
            <button
              onClick={handleNewChat}
              className={`${s.headerText} opacity-60 hover:opacity-100 transition-opacity`}
              title="New chat"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
              </svg>
            </button>
          )}
          <button
            onClick={handleClose}
            className={`${s.headerText} opacity-60 hover:opacity-100 transition-opacity`}
            title="Close"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      {/* Sidebar overlay — AI mode only */}
      {chatMode === 'ai' && showSidebar && (
        <div className={`absolute inset-0 z-10 flex ${s.roundedClass} overflow-hidden`}>
          <div className={`w-full ${s.panelBg} border-r ${s.borderColor} flex flex-col overflow-hidden`}>
            <div className={`px-4 py-3 border-b ${s.borderColor} ${s.headerBg} flex items-center justify-between`}>
              <p className={`text-[10px] ${s.fontClass} uppercase tracking-wider ${s.muted}`}>
                {theme === 'minimal' ? 'Chat history' : 'CHAT/LOG'}
              </p>
              <div className="flex items-center gap-2">
                <button
                  onClick={handleNewChat}
                  className={`${s.headerText} opacity-60 hover:opacity-100 transition-opacity`}
                  title="New chat"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                  </svg>
                </button>
                <button
                  onClick={() => setShowSidebar(false)}
                  className={`${s.headerText} opacity-60 hover:opacity-100 transition-opacity`}
                  title="Close history"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto">
              {conversations.map((conv) => (
                <div
                  key={conv.id}
                  className={`group flex items-center gap-1 px-4 py-2 cursor-pointer ${s.hoverBg} ${conv.id === activeConvId ? s.activeBg : ''}`}
                  onClick={() => handleSwitchConv(conv.id)}
                >
                  <span className={`flex-1 text-xs ${s.inputText} truncate`}>{conv.title}</span>
                  {switchingConv === conv.id && (
                    <div className={`w-3 h-3 border-2 ${s.spinnerBorder} rounded-full animate-spin`} />
                  )}
                  {switchingConv !== conv.id && (
                    <button
                      onClick={(e) => { e.stopPropagation(); handleDeleteConv(conv.id); }}
                      className={`opacity-0 group-hover:opacity-60 hover:!opacity-100 ${s.dangerBtn} transition-opacity`}
                      title="Delete conversation"
                    >
                      <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  )}
                </div>
              ))}
              {conversations.length === 0 && (
                <p className={`text-xs ${s.muted} px-4 py-4 text-center`}>No conversations yet</p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* AI Agent Messages */}
      {chatMode === 'ai' && (
        <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-3 min-h-0">
          {messages.length === 0 && showWelcome && (
            <div className="flex justify-start animate-fade-in-welcome">
              {/* Agent box made INVISIBLE on purpose (container kept): ink only, no bg/border.
                  Revert = swap the ink class back to s.assistantBubble. */}
              <div className={`max-w-[90%] px-3 py-2 text-xs leading-relaxed ${theme === 'dark' ? 'text-white' : 'text-[#1A1A1A]'} ${s.roundedClass}`}>
                <ReactMarkdown>{WELCOME}</ReactMarkdown>
              </div>
            </div>
          )}
          {!showSidebar && messages.map((msg, idx) => {
            // While the streaming bubble still owns this text (reveal unfinished), skip the
            // saved twin's row — state keeps it (it IS the history), render hides it, so the
            // two never paint at once.
            if (msg.id === savedMsgId && smooth.hasText && !smooth.isDone) return null;
            return (
            <div
              key={msg.id}
              className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'} ${animateMessages ? 'animate-fade-in-msg' : ''} ${msg.id === savedMsgId ? 'settle-fade' : ''}`}
              style={animateMessages ? { animationDelay: `${idx * 50}ms` } : {}}
            >
              {/* Agent box made INVISIBLE on purpose (container kept): agent replies render with ink
                  color only — no bg/border. User bubbles keep s.userBubble. Revert = s.assistantBubble. */}
              <div
                className={`relative max-w-[90%] px-3 py-2 text-xs leading-relaxed overflow-x-auto group ${
                  msg.role === 'user' ? s.userBubble : theme === 'dark' ? 'text-white' : 'text-[#1A1A1A]'
                } ${s.roundedClass}`}
              >
                {msg.role === 'assistant' && (
                  <button
                    onClick={(e) => handleCopy(msg.id, msg.content, e.currentTarget.parentElement!)}
                    aria-label="Copy message"
                    className={`absolute top-1 right-1 p-1 rounded transition-opacity ${
                      theme === 'minimal'
                        ? 'opacity-40 hover:opacity-100'
                        : 'opacity-0 group-hover:opacity-70 hover:!opacity-100'
                    } ${theme === 'dark' ? 'text-white/60 hover:text-white' : 'text-[#1A1A1A]/40 hover:text-[#1A1A1A]'}`}
                    title={copiedId === msg.id ? 'Copied!' : 'Copy'}
                  >
                    {copiedId === msg.id ? (
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                      </svg>
                    ) : (
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                        <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                        <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
                      </svg>
                    )}
                  </button>
                )}
                {msg.role === 'assistant' ? (
                  <div className="break-words [&_p]:mb-1 [&_p:last-child]:mb-0 [&_pre]:overflow-x-auto [&_pre]:max-w-full [&_code]:break-all">
                    <ReactMarkdown remarkPlugins={[remarkBreaks]}>{msg.content}</ReactMarkdown>
                  </div>
                ) : (
                  <div className="whitespace-pre-wrap break-words">{msg.content}</div>
                )}
              </div>
            </div>
            );
          })}

          {/* Loader + activity label — fades and collapses out when streamed text starts or
              the request ends (height on the grid wrapper, opacity on the inner element). */}
          {(showLoaderRow || smooth.hasText) && (
            <div className={`grid transition-[grid-template-rows] duration-300 ease-[cubic-bezier(0.4,0,0.2,1)] ${showLoaderRow ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
              <div className={`min-h-0 overflow-hidden transition-opacity duration-300 ${showLoaderRow ? 'opacity-100' : 'opacity-0'}`}>
                <div className="flex justify-start px-3 py-2">
                  <div className="flex items-center gap-3">
                    {/* ORIGINAL logo dot (l1-chat morph-square) — INTENTIONALLY HIDDEN, not deleted.
                        The owner-approved ThinkingOrb below replaced it (2026-08-17). To revert to
                        the original: re-enable this div, remove the ThinkingOrb line + its import
                        (the @keyframes l1-chat style block further below is still live).
                    <div className="w-3.5 h-3.5 rounded-full shrink-0" style={{
                      backgroundColor: theme === 'dark' ? '#ffffff' : '#1a1a1a',
                      animation: 'l1-chat 2s infinite cubic-bezier(0.3,1,0,1)',
                      ['--bg-mid' as string]: theme === 'dark' ? '#cccccc' : '#555555',
                      ['--bg-end' as string]: theme === 'dark' ? '#888888' : '#333333',
                    }} />
                    */}
                    <ThinkingOrb state="listening" size={20} speed={0.70} style={{ width: 24, height: 24 }} />
                    {activity && (
                      <span
                        className="shimmer-text text-[13px] font-medium"
                        style={{
                          ['--shimmer-ink' as string]: theme === 'dark' ? '#ffffff' : '#1A1A1A',
                          ['--shimmer-ink-light' as string]: theme === 'dark' ? '#999999' : '#8a8a8a',
                        }}
                      >
                        {activity}
                      </span>
                    )}
                  </div>
                  <style>{`
                    @keyframes l1-chat {
                      0%   { border-radius: 50%; clip-path: polygon(0 0, 100% 0, 100% 100%, 0 100%); }
                      33%  { border-radius: 0; clip-path: polygon(0 0, 100% 0, 100% 100%, 0 100%); background: var(--bg-mid); }
                      66%  { border-radius: 0; clip-path: polygon(50% 0%, 100% 50%, 50% 100%, 0% 50%); background: var(--bg-end); }
                      100% { border-radius: 50%; clip-path: polygon(0 0, 100% 0, 100% 100%, 0 100%); }
                    }
                  `}</style>
                </div>
              </div>
            </div>
          )}

          {/* Streaming assistant reply — identical wrapper classes to a saved assistant
              message, so the Firestore handoff (bubble out, saved message in) is seamless. */}
          {showStreamBubble && (
            <div className="flex justify-start animate-fade-in-up">
              {/* Streaming twin of the invisible agent box above (ink only, no bg/border). */}
              <div className={`relative max-w-[90%] px-3 py-2 text-xs leading-relaxed overflow-x-auto opacity-80 ${theme === 'dark' ? 'text-white' : 'text-[#1A1A1A]'} ${s.roundedClass}`}>
                <div className="break-words [&_p]:mb-1 [&_p:last-child]:mb-0 [&_pre]:overflow-x-auto [&_pre]:max-w-full [&_code]:break-all">
                  <ReactMarkdown remarkPlugins={[remarkBreaks]}>{smooth.revealed}</ReactMarkdown>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Group Chat Messages */}
      {chatMode === 'group' && (
        <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-2 min-h-0">
          <div className={`space-y-2 transition-opacity duration-300 ${isClearing ? 'opacity-0' : 'opacity-100'}`}>
          {!groupMessagesLoading && groupMessages.length === 0 && (
            <div className="flex flex-col items-center justify-center py-8 animate-fade-in-up">
              <svg className={`w-8 h-8 ${s.muted} mb-3`} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4" />
              </svg>
              <p className={`text-xs ${s.muted} text-center`}>
                No messages yet. Start the conversation!
              </p>
            </div>
          )}
          {groupMessages.map((msg) => {
            const isOwn = msg.senderId === userId;
            const idx = groupMessages.indexOf(msg);
            const prevMsg = idx > 0 ? groupMessages[idx - 1] : null;
            const showSender = !prevMsg || prevMsg.senderId !== msg.senderId;
            const initial = msg.senderName.charAt(0).toUpperCase();
            const timeStr = msg.createdAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

            return (
              <div key={msg.id} className={`group flex ${isOwn ? 'justify-end' : 'justify-start'} animate-fade-in-up`} style={{ animationDelay: `${Math.min(idx, 10) * 30}ms` }}>
                {/* Avatar for other users */}
                {!isOwn && showSender && (
                  <div className={`relative w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-medium shrink-0 mr-1.5 mt-0.5 ${s.sendBtn} text-white`}>
                    {initial}
                    {presence?.[msg.senderId]?.online && (
                      <span className="absolute bottom-0 right-0 w-2 h-2 rounded-full bg-green-500 ring-1 ring-white" />
                    )}
                  </div>
                )}
                {!isOwn && !showSender && <div className="w-6 mr-1.5 shrink-0" />}
                <div className="relative max-w-[80%]">
                  {/* Message-actions chevron (replaces right-click / long-press). Outer side, away from
                      the screen edge + the incoming avatar: own (right-aligned) → top-LEFT; others
                      (left-aligned) → top-RIGHT. Hover-reveals on desktop (group-hover), always on
                      touch ([@media(hover:none)]) + keyboard (focus). Pure CSS, no device sniffing. */}
                  <button
                    type="button"
                    aria-label="Message actions"
                    onClick={(e) => openMenuFromButton(e, msg)}
                    className={`absolute top-0 ${isOwn ? 'right-full mr-0.5' : 'left-full ml-0.5'} flex h-5 w-5 items-center justify-center rounded ${s.muted} opacity-0 transition-opacity hover:opacity-100 focus:opacity-100 group-hover:opacity-100 [@media(hover:none)]:hidden`}
                  >
                    <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                    </svg>
                  </button>
                  {showSender && !isOwn && (
                    <p className={`text-[10px] ${s.muted} mb-0.5 ml-1 truncate max-w-[160px]`}>{msg.senderName}</p>
                  )}
                  <div
                    ref={setMessageRef(msg.id)}
                    className={`px-3 py-2 text-xs leading-relaxed ${s.roundedClass} ${
                      isOwn ? s.userBubble : s.assistantBubble
                    } ${flashId === msg.id ? (theme === 'dark' ? 'animate-msg-flash-dark' : 'animate-msg-flash-light') : ''} relative [@media(hover:none)]:pt-7`}
                  >
                    <button
                      type="button"
                      aria-label="Message actions"
                      onClick={(e) => openMenuFromButton(e, msg)}
                      className={`absolute top-1 ${isOwn ? 'right-1' : 'left-1'} hidden [@media(hover:none)]:flex h-5 w-5 items-center justify-center rounded ${s.muted} opacity-60 transition-opacity active:opacity-100`}
                    >
                      <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                        <circle cx="5" cy="12" r="1.6" />
                        <circle cx="12" cy="12" r="1.6" />
                        <circle cx="19" cy="12" r="1.6" />
                      </svg>
                    </button>
                    {editingMsgId === msg.id ? (
                      <div onClick={(e) => e.stopPropagation()} className={`relative flex flex-col gap-1.5 min-w-[180px] p-1.5 border ${s.inputBorder} ${s.roundedClass} ${s.panelBg}`}>
                        {/* #-mention dropdown — anchored to this edit wrapper, floats above the bubble */}
                        {editMention.showMention && editMention.filteredMentionDrops.length > 0 && (
                          <div ref={editMention.dropdownRef} className={`absolute bottom-full ${isOwn ? 'right-0' : 'left-0'} w-[260px] z-50 mb-1 max-h-[240px] overflow-y-auto border ${s.borderColor} ${s.panelBg} ${s.roundedClass} shadow-lg`} style={{ touchAction: 'pan-y' }}>
                            {editMention.filteredMentionDrops.map((drop, idx) => (
                              <DropPickerRow key={drop.id} drop={drop} selected={idx === editMention.mentionIndex} attached={false} onSelect={editMention.insertMention} theme={theme} />
                            ))}
                          </div>
                        )}
                        {editDraft === '' && !editMention.showMention && (
                          <span className={`pointer-events-none absolute left-4 top-3 text-xs ${s.muted} ${s.fontClass}`}>
                            Edit message...
                          </span>
                        )}
                        <div
                          ref={editMention.setEditorRef}
                          contentEditable
                          suppressContentEditableWarning
                          onInput={editMention.handleInput}
                          onKeyDown={(e) => {
                            editMention.handleKeyDown(e);
                            if (!e.defaultPrevented) {
                              if (e.key === 'Enter' && !e.shiftKey) {
                                e.preventDefault();
                                saveEdit(msg);
                              } else if (e.key === 'Escape') {
                                e.preventDefault();
                                cancelEditing();
                              }
                            }
                          }}
                          onBlur={editMention.handleBlur}
                          onClick={(e) => e.stopPropagation()}
                          onContextMenu={(e) => e.stopPropagation()}
                          onTouchStart={(e) => e.stopPropagation()}
                          role="textbox"
                          aria-multiline="true"
                          className={`w-full px-2 py-1.5 text-xs ${s.fontClass} ${s.inputBg} ${s.inputText} border ${s.inputBorder} ${s.roundedClass} focus:outline-none focus:ring-1 ${s.focusRing} whitespace-pre-wrap break-words leading-relaxed min-h-[48px] max-h-[120px] overflow-y-auto`}
                        />
                        <div className="flex justify-end gap-1.5">
                          <button
                            type="button"
                            onClick={cancelEditing}
                            className={`px-2 py-1 text-[10px] ${s.fontClass} border ${s.borderColor} ${s.inputText} ${s.roundedClass} hover:opacity-70`}
                          >
                            Cancel
                          </button>
                          <button
                            type="button"
                            onClick={() => saveEdit(msg)}
                            disabled={!editDraft.trim()}
                            className={`px-2 py-1 text-[10px] ${s.fontClass} text-white disabled:opacity-40 ${s.sendBtn} ${s.roundedClass}`}
                          >
                            Save
                          </button>
                        </div>
                      </div>
                    ) : (
                      <>
                        {/* Quote-reply block — ABOVE the body. Resolved live from groupMessages so
                            edits/deletes to the parent reflect immediately; tapping jumps + flashes.
                            (Hidden while this message is being edited — the edit box replaces this
                            fragment — acceptable; the replyTo pointer survives.) */}
                        {msg.replyToMessageId && (
                          <ReplyQuoteBlock
                            replyToMessageId={msg.replyToMessageId}
                            groupMessages={groupMessages}
                            onJump={() => jumpToMessage(msg.replyToMessageId!)}
                            roundedClassName={s.roundedClass}
                          />
                        )}
                        {/* Inline render: text → <span>, #[name](id) → clickable chip, in sentence
                            order. Replaces the old separate card-row so chips stay coherent with
                            inline composing. whitespace-pre-wrap preserves newlines in text parts. */}
                        <div className="whitespace-pre-wrap break-words leading-relaxed">
                          <DropMentionContent
                            content={msg.content}
                            allDrops={workspaceDrops}
                            onPreview={(d) => { if (onPreviewDrop && workspaceId) onPreviewDrop(d.id, workspaceId); }}
                            foundClassName={displayFoundClass}
                            deletedClassName={displayDeletedClass}
                            userMentionClassName={displayUserClass}
                          />
                        </div>
                        {msg.edited && (
                          <span className="block text-[9px] opacity-60 mt-0.5">(edited)</span>
                        )}
                      </>
                    )}
                  </div>
                  {showSender && (
                    <p className={`text-[9px] ${s.muted} mt-0.5 ${isOwn ? 'text-right mr-1' : 'ml-1'}`}>{timeStr}</p>
                  )}
                </div>
              </div>
            );
          })}
          </div>

          {/* Confirm card — always mounted; height + opacity animate for a smooth slide */}
          <div className={`grid transition-[grid-template-rows] duration-[300ms] ease-[cubic-bezier(0.4,0,0.2,1)] ${clearConfirm ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
            <div className={`min-h-0 overflow-hidden transition-opacity duration-[300ms] ${clearConfirm ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}>
              <div ref={clearConfirm ? systemNoticeRef : undefined} className="flex justify-center py-4">
                <div className={`max-w-[85%] px-4 py-3 rounded-lg border ${s.borderColor} ${s.panelBg} shadow-sm`}>
                  <div className={`flex items-center gap-1.5 mb-2 ${s.muted}`}>
                    <svg className="w-3.5 h-3.5 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
                    </svg>
                    <span className={`text-[10px] ${s.fontClass} uppercase tracking-wider ${s.muted}`}>System</span>
                  </div>
                  <p className={`text-sm ${s.fontClass} ${s.headerText} mb-3`}>
                    Clear all messages? This can't be undone.
                  </p>
                  <div className="flex justify-center gap-2">
                    <button
                      onClick={() => setClearConfirm(false)}
                      disabled={clearLoading}
                      className={`px-3 py-1.5 text-xs ${s.fontClass} ${s.headerText} border ${s.borderColor} rounded-md hover:bg-black/5 transition-colors disabled:opacity-50`}
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleClearChat}
                      disabled={clearLoading}
                      className="px-3 py-1.5 text-xs font-medium text-white bg-red-500 rounded-md hover:bg-red-600 transition-colors disabled:opacity-50 flex items-center gap-1.5"
                    >
                      {clearLoading && (
                        <div className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                      )}
                      Clear all
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {menuMsg && (
            <MessageContextMenu
              x={menuMsg.x}
              y={menuMsg.y}
              rightBound={menuMsg.panelRight}
              isOwnMessage={menuMsg.msg.senderId === userId}
              canEdit={
                !!userId &&
                menuMsg.msg.senderId === userId &&
                Date.now() - menuMsg.msg.createdAt.getTime() <= 86_400_000 &&
                (menuMsg.msg.editCount ?? 0) < 10
              }
              onEdit={() => startEditing(menuMsg.msg)}
              onReply={() => startReply(menuMsg.msg)}
              onCopy={() => handleCopyMessage(menuMsg.msg)}
              onDelete={() => handleDeleteMessage(menuMsg.msg)}
              onClose={closeMessageMenu}
              onSeen={() => handleSeen(menuMsg.msg)}
              seenInfo={seenInfo}
              workspaceMembers={workspaceMembers}
              presence={presence}
              currentUserId={userId || ''}
              theme={theme}
            />
          )}
        </div>
      )}

          {/* Text notice — subtle divider; always mounted; height + opacity animate */}
          <div className={`grid transition-[grid-template-rows] duration-[300ms] ease-[cubic-bezier(0.4,0,0.2,1)] ${(!clearConfirm && systemNotice) ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
            <div className={`min-h-0 overflow-hidden transition-opacity duration-[300ms] ${(!clearConfirm && systemNotice && !noticeLeaving) ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}>
              <div ref={!clearConfirm && systemNotice ? systemNoticeRef : undefined} className="flex items-center justify-center gap-3 py-3">
                <div className={`h-0.5 w-8 sm:w-12 ${s.borderColor}`} />
                <span className={`text-[11px] ${s.fontClass} ${s.muted} uppercase tracking-wider text-center min-w-0 font-medium`}>
                  {systemNotice}
                </span>
                <div className={`h-0.5 w-8 sm:w-12 ${s.borderColor}`} />
              </div>
            </div>
          </div>

      {/* Input */}
      <div className={`border-t ${s.borderColor} p-3 shrink-0 ${chatMode === 'group' ? 'relative' : ''}`}>
        {/* Typing indicator — a zero-space overlay above the composer (group + at bottom + someone
            typing). Plain dots + muted text, no background (the original in-flow look). Anchored to
            this relative input wrapper (never position:fixed — a transform on an ancestor would trap
            it); bottom-full floats it just above the input border and pb-1.5 clears the bouncing dots
            off that border. pointer-events-none (click-through). atBottom gating makes it mutually
            exclusive with the scroll-to-bottom button. */}
        {pill.shouldRender && (
          <div className={`absolute bottom-full left-0 right-0 px-3 pb-1.5 flex items-center gap-2 pointer-events-none ${pill.isExiting ? 'animate-typing-fade-out' : 'animate-typing-fade'} z-10 ${s.muted} ${s.fontClass}`}>
            <span className="flex items-center gap-0.5">
              <span className="w-1.5 h-1.5 rounded-full bg-current" style={{ animation: 'typing-bounce 1.2s infinite', animationDelay: '0s' }} />
              <span className="w-1.5 h-1.5 rounded-full bg-current" style={{ animation: 'typing-bounce 1.2s infinite', animationDelay: '0.15s' }} />
              <span className="w-1.5 h-1.5 rounded-full bg-current" style={{ animation: 'typing-bounce 1.2s infinite', animationDelay: '0.3s' }} />
            </span>
            <span className="text-[10px]">{formatTypingText(typing.typingUsers.map((u) => u.displayName))}</span>
          </div>
        )}
        {/* Scroll-to-bottom button — shown only when scrolled up (group + !atBottom). Mutually
            exclusive with the pill (atBottom vs !atBottom). Clicking smooth-scrolls the list to the
            bottom → atBottom flips true → this hides and the pill re-shows if still typing. The
            typing badge (coral dot, top corner) reuses typing-bounce so a scrolled-up user still sees
            activity. pointer-events-auto (clickable, unlike the pill). Same opaque members-popover bg. */}
        {scroll.shouldRender && (
          <button
            type="button"
            aria-label="Scroll to bottom"
            onClick={() => scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })}
            className={`absolute bottom-full right-3 mb-2 flex items-center justify-center w-9 h-9 rounded-full shadow-md pointer-events-auto cursor-pointer ${scroll.isExiting ? 'animate-typing-fade-out' : 'animate-typing-fade'} z-10 ${theme === 'dark' ? 'bg-[#2A2A2A]' : 'bg-white'}`}
          >
            <svg className={`w-5 h-5 ${theme === 'dark' ? 'text-white' : 'text-[#1A1A1A]'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 5v14M5 12l7 7l7-7" />
            </svg>
            {typing.typingUsers.length > 0 && (
              <span className="absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full bg-[#FF5A47]" style={{ animation: 'typing-bounce 1.2s infinite' }} />
            )}
          </button>
        )}
        {chatMode === 'ai' ? (
          <form
            onSubmit={(e) => { e.preventDefault(); handleSend(); }}
            className="flex gap-2"
          >
            <input
              ref={inputRef}
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={theme === 'minimal' ? 'Ask anything...' : 'QUERY...'}
              className={`flex-1 px-3 py-2 text-xs ${s.inputBg} ${s.inputText} ${s.placeholder} ${s.fontClass} tracking-wider border ${s.inputBorder} ${s.roundedClass} focus:outline-none focus:ring-1 ${s.focusRing} disabled:opacity-50`}
            />
            <button
              type="button"
              onPointerDown={(e) => e.preventDefault()}
              onClick={voice.toggle}
              disabled={voice.isTranscribing}
              aria-label={voice.isRecording ? 'Stop recording' : voice.isTranscribing ? 'Transcribing' : 'Voice to text'}
              className={`px-3 py-2 text-xs transition-colors flex items-center justify-center border ${s.roundedClass} ${
                voice.isRecording
                  ? 'bg-red-500 border-red-500 text-white'
                  : voice.isTranscribing
                    ? `${s.inputBorder} ${s.placeholder} opacity-50 cursor-wait`
                    : `${s.inputBorder} ${s.inputText} hover:bg-[#1A1A1A] hover:text-white`
              }`}
            >
              {voice.isTranscribing ? (
                <div className="w-4 h-4 border border-current/30 border-t-current animate-spin rounded-full" />
              ) : voice.isRecording ? (
                <span className="w-3 h-3 bg-white rounded-sm" />
              ) : (
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 18.75a6 6 0 006-6v-1.5m-6 7.5a6 6 0 01-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 01-3-3V4.5a3 3 0 116 0v8.25a3 3 0 01-3 3z" />
                </svg>
              )}
            </button>
            <button
              type="submit"
              onPointerDown={(e) => e.preventDefault()}
              // While the agent is working, the send button becomes the Stop control
              // (standard chat pattern): square icon, clickable even with an empty input.
              onClick={(e) => {
                if (loading) {
                  e.preventDefault();
                  aiAbortRef.current?.abort();
                }
              }}
              disabled={!loading && !input.trim()}
              aria-label={loading ? 'Stop' : 'Send message'}
              className={`px-3 py-2 text-white text-xs disabled:opacity-30 transition-colors flex items-center justify-center ${s.sendBtn} ${s.roundedClass}`}
            >
              {loading ? (
                <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  <rect x="6" y="6" width="12" height="12" rx="2" />
                </svg>
              ) : (
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5" />
                </svg>
              )}
            </button>
          </form>
        ) : (
          <>
            {replyTo && (
              <ReplyPreviewBar
                replyTo={replyTo}
                onClear={clearReply}
                containerClassName={`${s.activeBg} ${s.roundedClass} ${s.inputText}`}
                iconClassName={s.muted}
                nameClassName={s.inputText}
                snippetClassName={s.muted}
                closeBtnClassName={`${s.muted} hover:opacity-100`}
              />
            )}
            <form
              onSubmit={(e) => { e.preventDefault(); handleGroupSend(); }}
              className="flex gap-2"
            >
              {/* contentEditable mention editor: chips render INLINE while typing; the saved value
                  stays the plain #[name](id) token string (useMentionEditor). The relative wrapper
                  anchors the dropdown + placeholder to the editor box (and aligns the placeholder). */}
              <div className="relative flex-1">
                {groupMention.showMention && groupMention.filteredMentionDrops.length > 0 && (
                  <div
                    ref={groupMention.dropdownRef}
                    className={`absolute bottom-full left-0 right-0 z-50 mb-1 max-h-[240px] overflow-y-auto border ${s.borderColor} ${s.panelBg} ${s.roundedClass} shadow-lg`}
                    style={{ touchAction: 'pan-y' }}
                  >
                    {groupMention.filteredMentionDrops.map((drop, idx) => (
                      <DropPickerRow
                        key={drop.id}
                        drop={drop}
                        selected={idx === groupMention.mentionIndex}
                        attached={false}
                        onSelect={groupMention.insertMention}
                        theme={theme}
                      />
                    ))}
                  </div>
                )}
                {groupMention.showUserMention && groupMention.filteredMembers.length > 0 && (
                  <div
                    ref={groupMention.userDropdownRef}
                    className={`absolute bottom-full left-0 right-0 z-50 mb-1 max-h-[240px] overflow-y-auto border ${s.borderColor} ${s.panelBg} ${s.roundedClass} shadow-lg`}
                    style={{ touchAction: 'pan-y' }}
                  >
                    {groupMention.filteredMembers.map((member, idx) => (
                      <button
                        key={member.uid}
                        type="button"
                        data-member-highlighted={idx === groupMention.userMentionIndex}
                        onPointerDown={(e) => e.preventDefault()}
                        onClick={() => groupMention.insertUserMention(member)}
                        className={`w-full text-left px-3 py-2 text-xs flex items-center gap-2 ${idx === groupMention.userMentionIndex ? `${s.activeBg} ${s.inputText}` : `${s.hoverBg} ${s.inputText}`}`}
                      >
                        <span className={`w-5 h-5 rounded-full ${s.sendBtn} text-white flex items-center justify-center text-[9px] font-medium shrink-0`}>
                          {member.displayName.charAt(0).toUpperCase()}
                        </span>
                        <span className="truncate">{member.displayName}</span>
                      </button>
                    ))}
                  </div>
                )}
                {groupInput === '' && !groupMention.showMention && !groupMention.showUserMention && (
                  <span className={`pointer-events-none absolute left-3 top-2 text-xs ${s.placeholder} ${s.fontClass}`}>
                    Message workspace...
                  </span>
                )}
                <div
                  ref={groupMention.setEditorRef}
                  contentEditable
                  suppressContentEditableWarning
                  onInput={(e) => { groupMention.handleInput(); typing.onComposerInput(e.currentTarget.textContent || ''); }}
                  onKeyDown={(e) => {
                    // Hook handles picker nav + Enter-to-pick when open; closed + Enter (no shift) sends.
                    groupMention.handleKeyDown(e);
                    if (e.defaultPrevented) return;
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      handleGroupSend();
                    } else if (e.key === 'Escape' && replyTo) {
                      // Mirror the inline-edit's Escape→cancel: clear an active reply first; the
                      // composer has no other Escape behavior, so without a reply this is a no-op.
                      e.preventDefault();
                      clearReply();
                    }
                  }}
                  onBlur={(e) => { groupMention.handleBlur(e); typing.clearTyping(); }}
                  role="textbox"
                  aria-multiline="true"
                  className={`w-full px-3 py-2 text-xs ${s.fontClass} ${s.inputBg} ${s.inputText} border ${s.inputBorder} ${s.roundedClass} focus:outline-none focus:ring-1 ${s.focusRing} whitespace-pre-wrap break-words leading-relaxed min-h-[40px] max-h-[120px] overflow-y-auto [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]`}
                />
              </div>
              <button
                type="button"
                onPointerDown={(e) => e.preventDefault()}
                onClick={voice.toggle}
                disabled={voice.isTranscribing}
                aria-label={voice.isRecording ? 'Stop recording' : voice.isTranscribing ? 'Transcribing' : 'Voice to text'}
                className={`px-3 py-2 text-xs transition-colors flex items-center justify-center border ${s.roundedClass} ${
                  voice.isRecording
                    ? 'bg-red-500 border-red-500 text-white'
                    : voice.isTranscribing
                      ? `${s.inputBorder} ${s.placeholder} opacity-50 cursor-wait`
                      : `${s.inputBorder} ${s.inputText} hover:bg-[#1A1A1A] hover:text-white`
                }`}
              >
                {voice.isTranscribing ? (
                  <div className="w-4 h-4 border border-current/30 border-t-current animate-spin rounded-full" />
                ) : voice.isRecording ? (
                  <span className="w-3 h-3 bg-white rounded-sm" />
                ) : (
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 18.75a6 6 0 006-6v-1.5m-6 7.5a6 6 0 01-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 01-3-3V4.5a3 3 0 116 0v8.25a3 3 0 01-3 3z" />
                  </svg>
                )}
              </button>
              <button
                type="submit"
                onPointerDown={(e) => e.preventDefault()}
                disabled={groupSending || !groupInput.trim()}
                className={`px-3 py-2 text-white text-xs disabled:opacity-30 transition-colors flex items-center justify-center ${s.sendBtn} ${s.roundedClass}`}
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5" />
              </svg>
              </button>
            </form>
          </>
        )}
      </div>

      {/* Voice-to-text failure toast */}
      {voiceError && (
        <Toast
          message={voiceError}
          duration={4}
          theme={theme}
          editorial={false}
          onDone={() => setVoiceError(null)}
        />
      )}

      {/* Copied toast */}
      {copiedMsgId && (
        <div className="absolute bottom-16 left-1/2 -translate-x-1/2 z-50 px-3 py-1.5 rounded-md bg-[#1a1a1a] text-white text-xs shadow-lg animate-fade-in-up">
          Copied
        </div>
      )}
    </div>
  );
}
