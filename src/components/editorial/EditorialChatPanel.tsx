'use client';

import { useState, useRef, useEffect, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import { auth } from '@/lib/firebase';
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
import { subscribeToGroupMessages, sendGroupMessage, editGroupMessage, deleteGroupMessage, clearGroupChat } from '@/lib/groupChat';
import { useInPanelMarkRead } from '@/hooks/useInPanelMarkRead';
import { useMentionEditor } from '@/hooks/useMentionEditor';
import { Drop, GroupChatMessage } from '@/types';
import { getEditorialThemeColors } from './editorialTheme';
import { EditorialDropPickerRow } from './EditorialDropPickerRow';
import { DropMentionContent } from '../DropMentionContent';
import { MessageContextMenu } from '@/components/MessageContextMenu';
import { ReplyQuoteBlock, ReplyPreviewBar } from '../ReplyQuoteBlock';
import { useMessageScroll } from '@/hooks/useMessageScroll';

interface EditorialChatPanelProps {
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

const WELCOME = 'Hi! I can help you manage your drops. Ask me to list drops, search content, check storage stats, or manage workspaces.';

export function EditorialChatPanel({ theme, onClose, onPreviewDrop, workspaceId, workspaceMembers, chatMode: chatModeProp, onChatModeChange, drops, ownerId, presence }: EditorialChatPanelProps) {
  const tc = getEditorialThemeColors(theme);

  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConvId, setActiveConvId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [showSidebar, setShowSidebar] = useState(false);
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
  const [menuMsg, setMenuMsg] = useState<{ msg: GroupChatMessage; x: number; y: number } | null>(null);
  const [copiedMsgId, setCopiedMsgId] = useState<string | null>(null);
  // Inline message editor — editingMsgId === msg.id swaps that bubble's text node for a textarea.
  const [editingMsgId, setEditingMsgId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');
  // Quote-reply draft — replyTo is the message being replied to; cleared on send / Escape / mode or
  // workspace switch. Display-only context; replyTo?.id is passed as sendGroupMessage's 5th arg.
  const [replyTo, setReplyTo] = useState<GroupChatMessage | null>(null);
  const groupUnsubRef = useRef<(() => void) | null>(null);
  const systemNoticeRef = useRef<HTMLDivElement>(null);
  const hadNoticeRef = useRef(false);

  // Inline drop-reference chips — mirrors the drop-note editor (EditorialTextModal). The group
  // composer AND the inline edit box back a contentEditable <div> with the shared useMentionEditor
  // hook; chips serialize to #[name](id), the exact token format group chat already stores/encrypts/
  // renders, so there are NO crypto / rules / data-model changes. workspaceDrops feeds the picker and
  // resolves chip targets for the editor AND the inline display.
  const workspaceDrops = useMemo(() => (drops || []).filter(d => d.workspaceId === workspaceId), [drops, workspaceId]);
  // Editor chip classes — solid pills on the editor's single-bg surface.
  const mentionChipBase = `inline-flex items-center mx-0.5 px-1.5 py-0.5 align-middle rounded text-[13px] leading-none ${tc.fontClass}`;
  const mentionFoundClass = `${mentionChipBase} ${tc.activePillBg} ${tc.activePillText}`;
  const mentionDeletedClass = `${mentionChipBase} ${tc.inactivePillBg} ${tc.muted} line-through cursor-not-allowed`;
  // Display chip classes — found reuses the theme accent (matches the prior separate-card look 1:1);
  // deleted is themed (inactive + muted + strike) instead of the old gray, per "deleted chip is
  // themed (not gray)".
  const displayChipBase = `inline-flex items-center mx-0.5 px-1.5 py-0.5 align-middle rounded text-[11px] font-medium leading-none ${tc.fontClass}`;
  const displayFoundClass = `${displayChipBase} ${tc.activePillBg} ${tc.activePillText} hover:opacity-80 cursor-pointer`;
  const displayDeletedClass = `${displayChipBase} ${tc.inactivePillBg} ${tc.muted} line-through cursor-not-allowed opacity-60`;
  const groupMention = useMentionEditor({ content: groupInput, setContent: setGroupInput, allDrops: workspaceDrops, foundClassName: mentionFoundClass, deletedClassName: mentionDeletedClass });
  // editMention is a single top-level instance (Rules of Hooks); its contentEditable renders only
  // for the message being edited (editingMsgId === msg.id).
  const editMention = useMentionEditor({ content: editDraft, setContent: setEditDraft, allDrops: workspaceDrops, foundClassName: mentionFoundClass, deletedClassName: mentionDeletedClass });

  const [switchingConv, setSwitchingConv] = useState<string | null>(null);
  const [animateMessages, setAnimateMessages] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const aiTextareaRef = useRef<HTMLTextAreaElement>(null);
  const unsubRef = useRef<(() => void) | null>(null);
  // Scroll-to-message + flash-highlight for quote-reply jumps (shared with ChatPanel).
  const { setMessageRef, jumpToMessage, flashId } = useMessageScroll(scrollRef);
  const userId = auth.currentUser?.uid;
  const isOwner = !!userId && ownerId === userId;
  const activeConv = conversations.find(c => c.id === activeConvId) || null;

  // Delayed animations for staggered entrance
  const [showHeader, setShowHeader] = useState(false);
  const [showContent, setShowContent] = useState(false);
  const [showInputArea, setShowInputArea] = useState(false);

  // Trigger staggered animations on mount
  useEffect(() => {
    setShowHeader(false);
    setShowContent(false);
    setShowInputArea(false);

    const t1 = setTimeout(() => setShowHeader(true), 50);
    const t2 = setTimeout(() => setShowContent(true), 150);
    const t3 = setTimeout(() => setShowInputArea(true), 280);

    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
    };
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

  // Auto-scroll on new messages
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, loading]);

  // Scroll to bottom when chat panel mounts (user opens chat)
  useEffect(() => {
    const scrollToBottom = () => {
      if (scrollRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      }
    };
    const timer = setTimeout(scrollToBottom, 400);
    return () => clearTimeout(timer);
  }, []);

  // Scroll to bottom when keyboard opens/closes (visual viewport resize).
  // Keyboard open/close produces a LARGE height delta (>=150px) — snap unconditionally to keep
  // stick-to-bottom for that transition (the user is already pinned to it). Small / width-only
  // resizes — e.g. the desktop scrollbar removed by useBodyScrollLock when a preview modal opens —
  // keep the 120px near-bottom guard so a scrolled-up user is NOT yanked to the bottom on chip-click.
  useEffect(() => {
    if (typeof window === 'undefined' || !window.visualViewport) return;
    const viewport = window.visualViewport;
    const KEYBOARD_THRESHOLD = 150;
    const prevHeight = { current: viewport.height };
    const scrollToBottom = () => {
      const el = scrollRef.current;
      if (!el) return;
      const heightDelta = Math.abs(viewport.height - prevHeight.current);
      prevHeight.current = viewport.height;
      if (heightDelta > KEYBOARD_THRESHOLD) {
        el.scrollTop = el.scrollHeight;
        return;
      }
      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= 120;
      if (nearBottom) el.scrollTop = el.scrollHeight;
    };
    viewport.addEventListener('resize', scrollToBottom);
    return () => viewport.removeEventListener('resize', scrollToBottom);
  }, []);

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
  // isExiting swaps in the fade-out class. Object access (not destructured).
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

  // Lock body scroll on mobile/tablet when chat is open as overlay
  useEffect(() => {
    let scrollY = 0;
    let locked = false;

    const applyLock = () => {
      const isMobile = window.innerWidth < 1400;
      if (isMobile && !locked) {
        scrollY = window.scrollY;
        document.documentElement.style.overflow = 'hidden';
        document.documentElement.style.height = '100%';
        document.body.style.overflow = 'hidden';
        document.body.style.height = '100%';
        document.body.style.scrollbarGutter = 'auto';
        locked = true;
      } else if (!isMobile && locked) {
        document.documentElement.style.overflow = '';
        document.documentElement.style.height = '';
        document.body.style.overflow = '';
        document.body.style.height = '';
        document.body.style.scrollbarGutter = '';
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
      if (locked) window.scrollTo(0, scrollY);
    };
  }, []);

  // Auto-scroll group messages
  useEffect(() => {
    if (chatMode === 'group' && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [groupMessages, chatMode]);

  // Auto-resize AI textarea (the AI branch's <textarea ref={aiTextareaRef}>)
  useEffect(() => {
    if (aiTextareaRef.current) {
      aiTextareaRef.current.style.height = 'auto';
      aiTextareaRef.current.style.height = Math.min(aiTextareaRef.current.scrollHeight, 120) + 'px';
    }
  }, [input]);

  // Auto-grow the group contentEditable — same 120px cap the AI textarea uses. The emerge wrapper
  // already hosted a self-growing textarea, so this is the SAME behavior, not a new one.
  useEffect(() => {
    const el = groupMention.editorRef.current;
    if (el) {
      el.style.height = 'auto';
      el.style.height = Math.min(el.scrollHeight, 120) + 'px';
    }
  }, [groupInput]);

  // Focus the inline edit box when it opens. The hook's external→DOM effect (keyed on editDraft)
  // renders the seeded tokens as chips; this places focus + the caret at the end.
  useEffect(() => {
    if (editingMsgId) editMention.focusEditor();
    // editMention.focusEditor is stable enough for this open/close transition; we only want this to
    // fire when editingMsgId changes, not on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingMsgId]);

  const handleNewChat = () => {
    setActiveConvId(null);
    setMessages([]);
    setShowSidebar(false);
  };

  const handleSwitchConv = (convId: string) => {
    if (switchingConv) return;
    if (convId === activeConvId) {
      setShowSidebar(false);
      return;
    }
    setSwitchingConv(convId);
    setMessages([]);
    setMessagesLoading(true);
    setActiveConvId(convId);
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

    setInput('');
    setLoading(true);

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
      const res = await fetch(`${AGENT_URL}/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${idToken}`,
        },
        body: JSON.stringify({
          message: text,
          history: messages.map((m) => ({ role: m.role, content: m.content })),
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: 'Request failed' }));
        throw new Error(err.detail || `Error ${res.status}`);
      }

      const data = await res.json();
      let response = data.response;

      if (data.previewDropId && onPreviewDrop) {
        onPreviewDrop(data.previewDropId, data.previewWorkspaceId);
      }

      await saveMessage(userId, convId, 'assistant', response);
    } catch (e: any) {
      await saveMessage(userId, convId, 'assistant', `Error: ${e.message || 'Something went wrong'}`);
    } finally {
      setLoading(false);
      requestAnimationFrame(() => aiTextareaRef.current?.focus());
    }
  };

  const handleCopy = async (msgId: string, content: string, messageElement: HTMLElement) => {
    const codeBlock = messageElement.querySelector('pre code');
    const textToCopy = codeBlock ? (codeBlock.textContent || '') : content;
    await navigator.clipboard.writeText(textToCopy);
    setCopiedId(msgId);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

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
    setMenuMsg({ msg, x: r.left, y: r.bottom });
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

  const closeMessageMenu = () => setMenuMsg(null);

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

  return (
    <div className={`flex flex-col h-full overflow-hidden border-l ${tc.border} ${tc.bg} transition-colors duration-500`}>
      {/* Header with staggered fade-in */}
      <div className={`z-20 border-b ${tc.border} px-5 py-4 flex items-center justify-between shrink-0 transition-all duration-300 ease-out ${showHeader ? 'opacity-100 translate-y-0' : 'opacity-0 -translate-y-[10px]'}`} style={{ touchAction: 'none' }}>
        <div className="flex items-center gap-1.5">
          <h3 className={`text-[15px] font-medium ${tc.fontClass} ${tc.text}`}>
            {chatMode === 'group' ? 'Workspace Chat' : 'AI Assistant'}
          </h3>
        </div>

        {/* Tab toggle */}
        <div className="flex gap-1">
          <button
            onClick={() => setChatMode('ai')}
            className={`px-2.5 py-1 text-xs ${tc.fontClass} transition-colors rounded-md ${
              chatMode === 'ai'
                ? `${tc.activePillBg} ${tc.activePillText}`
                : `${tc.inactivePillBg} ${tc.inactivePillText} ${tc.inactivePillHoverBg}`
            }`}
          >
            AI
          </button>
          <button
            onClick={() => workspaceId && setChatMode('group')}
            disabled={!workspaceId}
            title={!workspaceId ? 'Select a workspace to chat' : ''}
            className={`px-2.5 py-1 text-xs ${tc.fontClass} transition-colors rounded-md ${
              chatMode === 'group'
                ? `${tc.activePillBg} ${tc.activePillText}`
                : `${tc.inactivePillBg} ${tc.inactivePillText} ${tc.inactivePillHoverBg}`
            } ${!workspaceId ? 'opacity-30 cursor-not-allowed' : ''}`}
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
                className={`w-7 h-7 flex items-center justify-center rounded-md ${tc.text} transition-all ${showMembers ? 'opacity-100 bg-black/5' : 'opacity-50 hover:opacity-100 hover:bg-black/5'}`}
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
                    <div className={`w-56 max-h-[300px] overflow-y-auto border rounded-lg p-1.5 ${theme === 'dark' ? 'bg-[#2A2A2A] border-white/10 shadow-[0_10px_30px_rgba(0,0,0,0.55)]' : 'bg-white border-black/10 shadow-[0_12px_34px_rgba(0,0,0,0.10)]'}`}>
                    <div className={`flex items-center justify-between px-2 py-1 text-[10px] uppercase tracking-wider ${tc.muted} ${tc.fontClass}`}>
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
                        <div key={m.uid} className={`flex items-center gap-2 px-2 py-1.5 text-xs ${tc.fontClass} rounded hover:bg-black/5`}>
                          <span className={`w-2 h-2 rounded-full shrink-0 ${m.online ? 'bg-green-500' : 'bg-gray-400'}`} />
                          <span className={`truncate ${tc.text}`}>{m.displayName}{m.uid === userId && ' (you)'}</span>
                          <span className={`ml-auto text-[10px] ${tc.muted}`}>{m.online ? 'Online' : m.lastSeen ? formatLastSeen(m.lastSeen) : ''}</span>
                        </div>
                      ))}
                    </div>
                  </div>
              )}
            </span>
          )}
        </div>

        <div className="flex items-center gap-1">
          {/* History button — AI mode only */}
          {chatMode === 'ai' && (
            <button
              onClick={() => setShowSidebar(true)}
              className={`w-7 h-7 flex items-center justify-center rounded-md ${tc.text} opacity-50 hover:opacity-100 hover:bg-black/5 transition-all`}
              title="Chat history"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </button>
          )}
          {/* New chat button — AI mode only */}
          {chatMode === 'ai' && (
            <button
              onClick={handleNewChat}
              className={`w-7 h-7 flex items-center justify-center rounded-md ${tc.text} opacity-50 hover:opacity-100 hover:bg-black/5 transition-all`}
              title="New chat"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
              </svg>
            </button>
          )}
          {/* Close button */}
          <button
            onClick={onClose}
            className={`w-7 h-7 flex items-center justify-center rounded-md ${tc.text} opacity-50 hover:opacity-100 hover:bg-black/5 transition-all`}
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
        <div className="absolute inset-0 z-10 flex overflow-hidden">
          <div className={`w-full ${tc.bg} border-r ${tc.border} flex flex-col overflow-hidden`}>
            <div className={`px-5 py-4 border-b ${tc.border} flex items-center justify-between`}>
              <p className={`text-xs ${tc.fontClass} ${tc.muted}`}>
                Chat history
              </p>
              <button
                onClick={() => setShowSidebar(false)}
                className={`${tc.text} opacity-50 hover:opacity-100 transition-opacity`}
                title="Close history"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="flex-1 overflow-y-auto" style={{ touchAction: 'pan-y' }}>
              {conversations.map((conv) => (
                <div
                  key={conv.id}
                  className={`group flex items-center gap-1 px-5 py-2.5 cursor-pointer ${tc.inactivePillHoverBg} ${conv.id === activeConvId ? 'bg-black/5' : ''}`}
                  onClick={() => handleSwitchConv(conv.id)}
                >
                  <span className={`flex-1 text-sm ${tc.fontClass} ${tc.text} truncate`}>{conv.title}</span>
                  {switchingConv === conv.id && (
                    <div className={`w-3 h-3 border-2 ${theme === 'dark' ? 'border-white/30 border-t-white' : 'border-[#1a1a1a]/30 border-t-[#1a1a1a]'} rounded-full animate-spin`} />
                  )}
                  {switchingConv !== conv.id && (
                    <button
                      onClick={(e) => { e.stopPropagation(); handleDeleteConv(conv.id); }}
                      className="opacity-0 group-hover:opacity-60 hover:!opacity-100 text-red-400 hover:text-red-500 transition-opacity"
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
                <p className={`text-sm ${tc.fontClass} ${tc.muted} px-5 py-6 text-center`}>No conversations yet</p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* AI Agent Messages area with staggered fade-in */}
      {chatMode === 'ai' && (
        <div ref={chatMode === 'ai' ? scrollRef : undefined} className={`flex-1 overflow-y-auto overscroll-contain p-5 space-y-4 min-h-0 transition-all duration-[350ms] ease-out ${showContent ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-[10px]'}`} style={{ touchAction: 'pan-y' }} data-scroll-area>
          {/* Welcome message */}
          {messages.length === 0 && !loading && (
            <div className="flex flex-col items-center justify-center h-full">
              <svg className={`w-10 h-10 ${tc.muted} mb-4`} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
              </svg>
              <p className={`text-sm ${tc.fontClass} ${tc.muted} text-center max-w-[240px]`}>
                Ask me anything about your drops
              </p>
            </div>
          )}

          {/* Messages with fadeInUp animation */}
          {!showSidebar && messages.map((msg, idx) => (
            <div
              key={msg.id}
              className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'} animate-fade-in-up`}
              style={{ animationDelay: `${Math.min(idx, 10) * 30}ms` }}
            >
              <div
                className={`relative max-w-[85%] px-3.5 py-2.5 text-sm leading-relaxed overflow-x-auto group ${
                  msg.role === 'user'
                    ? 'bg-[#1a1a1a] text-[#FFFEF5] rounded-lg'
                    : `bg-[#f5f5f5] ${theme === 'dark' ? 'bg-white/10 text-white' : 'text-[#1a1a1a]'} rounded-lg border ${tc.border}`
                }`}
                style={msg.role === 'user' ? { borderBottomRightRadius: '3px' } : { borderBottomLeftRadius: '3px' }}
              >
                {msg.role === 'assistant' && (
                  <button
                    onClick={(e) => handleCopy(msg.id, msg.content, e.currentTarget.parentElement!)}
                    aria-label="Copy message"
                    className={`absolute top-1 right-1 p-1 ${tc.roundedClass} transition-opacity ${
                      theme === 'minimal'
                        ? 'opacity-40 hover:opacity-100'
                        : 'opacity-0 group-hover:opacity-70 hover:!opacity-100'
                    } ${theme === 'dark' ? 'text-white/60 hover:text-white' : 'text-[#1a1a1a]/40 hover:text-[#1a1a1a]'}`}
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
                  <div className={`break-words [&_p]:mb-1 [&_p:last-child]:mb-0 [&_pre]:overflow-x-auto [&_pre]:max-w-full [&_code]:break-all ${tc.fontClass}`}>
                    <ReactMarkdown remarkPlugins={[remarkBreaks]}>{msg.content}</ReactMarkdown>
                  </div>
                ) : (
                  <div className={`whitespace-pre-wrap break-words ${tc.fontClass}`}>{msg.content}</div>
                )}
              </div>
            </div>
          ))}

          {/* Loading indicator */}
          {loading && (
            <div className="flex justify-start px-4 py-3">
              <div className="w-3.5 h-3.5 rounded-full bg-[#1a1a1a]" style={{
                animation: 'l1-chat 2s infinite cubic-bezier(0.3,1,0,1)',
                ['--bg-mid' as string]: theme === 'dark' ? '#ffffff' : '#555555',
                ['--bg-end' as string]: theme === 'dark' ? '#cccccc' : '#333333',
              }} />
              <style>{`
                @keyframes l1-chat {
                  0%   { border-radius: 50%; clip-path: polygon(0 0, 100% 0, 100% 100%, 0 100%); }
                  33%  { border-radius: 0; clip-path: polygon(0 0, 100% 0, 100% 100%, 0 100%); background: var(--bg-mid); }
                  66%  { border-radius: 0; clip-path: polygon(50% 0%, 100% 50%, 50% 100%, 0% 50%); background: var(--bg-end); }
                  100% { border-radius: 50%; clip-path: polygon(0 0, 100% 0, 100% 100%, 0 100%); }
                }
              `}</style>
            </div>
          )}
        </div>
      )}

      {/* Group Chat Messages */}
      {chatMode === 'group' && (
        <div ref={scrollRef} className={`flex-1 overflow-y-auto overscroll-contain p-5 space-y-2 min-h-0 transition-all duration-[350ms] ease-out ${showContent ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-[10px]'}`} style={{ touchAction: 'pan-y' }} data-scroll-area>
          <div className={`space-y-2 transition-opacity duration-300 ease-out ${isClearing ? 'opacity-0' : 'opacity-100'}`}>
          {!groupMessagesLoading && groupMessages.length === 0 && (
            <div className="flex flex-col items-center justify-center py-8 animate-fade-in-up">
              <svg className={`w-8 h-8 ${tc.muted} mb-3`} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4" />
              </svg>
              <p className={`text-xs ${tc.fontClass} ${tc.muted} text-center`}>
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
                  <div className={`relative w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-medium shrink-0 mr-1.5 mt-0.5 ${tc.activePillBg} ${tc.activePillText}`}>
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
                    className={`absolute top-0 ${isOwn ? 'right-full mr-0.5' : 'left-full ml-0.5'} flex h-5 w-5 items-center justify-center rounded ${tc.muted} opacity-0 transition-opacity hover:opacity-100 focus:opacity-100 group-hover:opacity-100 [@media(hover:none)]:hidden`}
                  >
                    <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                    </svg>
                  </button>
                  {showSender && !isOwn && (
                    <p className={`text-[10px] ${tc.muted} mb-0.5 ml-1 truncate max-w-[160px]`}>{msg.senderName}</p>
                  )}
                  <div
                    ref={setMessageRef(msg.id)}
                    className={`px-3.5 py-2.5 text-sm leading-relaxed ${tc.roundedClass} ${
                      isOwn
                        ? 'bg-[#1a1a1a] text-[#FFFEF5]'
                        : `bg-[#f5f5f5] ${theme === 'dark' ? 'bg-white/10 text-white' : 'text-[#1a1a1a]'} border ${tc.border}`
                    } ${flashId === msg.id ? (theme === 'dark' ? 'animate-msg-flash-dark' : 'animate-msg-flash-light') : ''} relative [@media(hover:none)]:pt-7`}
                    style={isOwn ? { borderBottomRightRadius: '3px' } : { borderBottomLeftRadius: '3px' }}
                  >
                    <button
                      type="button"
                      aria-label="Message actions"
                      onClick={(e) => openMenuFromButton(e, msg)}
                      className={`absolute top-1 ${isOwn ? 'right-1' : 'left-1'} hidden [@media(hover:none)]:flex h-5 w-5 items-center justify-center rounded ${tc.muted} opacity-60 transition-opacity active:opacity-100`}
                    >
                      <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                        <circle cx="5" cy="12" r="1.6" />
                        <circle cx="12" cy="12" r="1.6" />
                        <circle cx="19" cy="12" r="1.6" />
                      </svg>
                    </button>
                    {editingMsgId === msg.id ? (
                      <div className={`relative flex flex-col gap-1.5 min-w-[200px] p-1.5 border ${tc.border} ${tc.roundedClass} ${tc.bg}`}>
                        {/* #-mention dropdown — anchored to this edit wrapper, floats above the bubble */}
                        {editMention.showMention && editMention.filteredMentionDrops.length > 0 && (
                          <div ref={editMention.dropdownRef} className={`absolute bottom-full ${isOwn ? 'right-0' : 'left-0'} w-[260px] mb-1 z-50 max-h-[240px] overflow-y-auto rounded-md border ${tc.border} ${tc.bg} shadow-lg`} style={{ touchAction: 'pan-y' }}>
                            {editMention.filteredMentionDrops.map((drop, idx) => (
                              <EditorialDropPickerRow key={drop.id} drop={drop} selected={idx === editMention.mentionIndex} attached={false} onSelect={editMention.insertMention} theme={theme} />
                            ))}
                          </div>
                        )}
                        {editDraft === '' && !editMention.showMention && (
                          <span className={`pointer-events-none absolute left-4 top-3 text-sm ${tc.fontClass} ${theme === 'dark' ? 'text-white/30' : 'text-[#1A1A1A]/30'}`}>
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
                          className={`w-full px-2 py-1.5 text-sm ${tc.fontClass} ${tc.bg} ${tc.text} border ${tc.border} rounded-lg focus:outline-none whitespace-pre-wrap break-words leading-relaxed min-h-[48px] max-h-[120px] overflow-y-auto`}
                        />
                        <div className="flex justify-end gap-1.5">
                          <button
                            type="button"
                            onClick={cancelEditing}
                            className={`px-2.5 py-1 text-xs ${tc.fontClass} ${tc.text} border ${tc.border} rounded-md hover:bg-black/5 transition-colors`}
                          >
                            Cancel
                          </button>
                          <button
                            type="button"
                            onClick={() => saveEdit(msg)}
                            disabled={!editDraft.trim()}
                            className={`px-2.5 py-1 text-xs font-medium ${tc.fontClass} ${tc.activePillBg} ${tc.activePillText} ${tc.roundedClass} hover:opacity-90 disabled:opacity-40 transition-colors`}
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
                            roundedClassName={tc.roundedClass}
                          />
                        )}
                        {/* Inline render: text → <span>, #[name](id) → clickable chip, in sentence
                            order. whitespace-pre-wrap preserves newlines in text parts. */}
                        <div className={`whitespace-pre-wrap break-words leading-relaxed ${tc.fontClass}`}>
                          <DropMentionContent
                            content={msg.content}
                            allDrops={workspaceDrops}
                            onPreview={(d) => { if (onPreviewDrop && workspaceId) onPreviewDrop(d.id, workspaceId); }}
                            foundClassName={displayFoundClass}
                            deletedClassName={displayDeletedClass}
                          />
                        </div>
                        {msg.edited && (
                          <span className="block text-[10px] opacity-60 mt-0.5">(edited)</span>
                        )}
                      </>
                    )}
                  </div>
                  {showSender && (
                    <p className={`text-[9px] ${tc.muted} mt-0.5 ${isOwn ? 'text-right mr-1' : 'ml-1'}`}>{timeStr}</p>
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
                <div className={`max-w-[85%] px-4 py-3 rounded-lg border ${tc.border} ${tc.cardBg} shadow-sm`}>
                  <div className={`flex items-center gap-1.5 mb-2 ${tc.muted}`}>
                    <svg className="w-3.5 h-3.5 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
                    </svg>
                    <span className={`text-[10px] ${tc.fontClass} ${tc.muted} uppercase tracking-wider`}>System</span>
                  </div>
                  <p className={`text-sm ${tc.fontClass} ${tc.text} mb-3`}>
                    Clear all messages? This can't be undone.
                  </p>
                  <div className="flex justify-center gap-2">
                    <button
                      onClick={() => setClearConfirm(false)}
                      disabled={clearLoading}
                      className={`px-3 py-1.5 text-xs ${tc.fontClass} ${tc.text} border ${tc.border} rounded-md hover:bg-black/5 transition-colors disabled:opacity-50`}
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

          {/* Text notice — subtle divider; always mounted; height + opacity animate */}
          <div className={`grid transition-[grid-template-rows] duration-[300ms] ease-[cubic-bezier(0.4,0,0.2,1)] ${(!clearConfirm && systemNotice) ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
            <div className={`min-h-0 overflow-hidden transition-opacity duration-[300ms] ${(!clearConfirm && systemNotice && !noticeLeaving) ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}>
              <div ref={!clearConfirm && systemNotice ? systemNoticeRef : undefined} className="flex items-center justify-center gap-3 py-3">
                <div className={`h-0.5 w-8 sm:w-12 ${tc.border}`} />
                <span className={`text-[11px] ${tc.fontClass} ${tc.muted} uppercase tracking-wider text-center min-w-0 font-medium`}>
                  {systemNotice}
                </span>
                <div className={`h-0.5 w-8 sm:w-12 ${tc.border}`} />
              </div>
            </div>
          </div>

          {menuMsg && (
            <MessageContextMenu
              x={menuMsg.x}
              y={menuMsg.y}
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
              theme={theme}
              editorial
            />
          )}
        </div>
      )}

      {/* Input area with staggered fade-in */}
      <div className={`border-t ${tc.border} p-4 shrink-0 relative transition-all duration-300 ease-out ${showInputArea ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-[10px]'}`} style={{ touchAction: 'none' }}>
        {/* Typing indicator — a zero-space overlay above the composer (group + at bottom + someone
            typing). Plain dots + muted text, no background (the original in-flow look). Anchored to
            this relative wrapper (never position:fixed — this wrapper's own translate-y emerge
            transform would trap that); bottom-full floats it above the input border, pb-1.5 clears
            the bouncing dots. pointer-events-none (click-through). atBottom gating makes it mutually
            exclusive with the scroll-to-bottom button. */}
        {pill.shouldRender && (
          <div className={`absolute bottom-full left-0 right-0 px-4 pb-1.5 flex items-center gap-2 pointer-events-none ${pill.isExiting ? 'animate-typing-fade-out' : 'animate-typing-fade'} z-10 ${tc.muted} ${tc.fontClass}`}>
            <span className="flex items-center gap-0.5">
              <span className="w-1.5 h-1.5 rounded-full bg-current" style={{ animation: 'typing-bounce 1.2s infinite', animationDelay: '0s' }} />
              <span className="w-1.5 h-1.5 rounded-full bg-current" style={{ animation: 'typing-bounce 1.2s infinite', animationDelay: '0.15s' }} />
              <span className="w-1.5 h-1.5 rounded-full bg-current" style={{ animation: 'typing-bounce 1.2s infinite', animationDelay: '0.3s' }} />
            </span>
            <span className="text-xs">{formatTypingText(typing.typingUsers.map((u) => u.displayName))}</span>
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
            className={`absolute bottom-full right-4 mb-2 flex items-center justify-center w-9 h-9 rounded-full shadow-md pointer-events-auto cursor-pointer ${scroll.isExiting ? 'animate-typing-fade-out' : 'animate-typing-fade'} z-10 ${theme === 'dark' ? 'bg-[#2A2A2A]' : 'bg-white'}`}
          >
            <svg className={`w-5 h-5 ${theme === 'dark' ? 'text-white' : 'text-[#1A1A1A]'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 5v14M5 12l7 7l7-7" />
            </svg>
            {typing.typingUsers.length > 0 && (
              <span className="absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full bg-[#FF5A47]" style={{ animation: 'typing-bounce 1.2s infinite' }} />
            )}
          </button>
        )}
        {/* Reply preview bar — an in-flow child above the composer row (mirrors classic's placement
            above the form). The group editor below is now wrapped in a relative flex-1 (also mirrors
            classic) so the placeholder + dropdown anchor to the editor box, not this outer wrapper;
            the outer wrapper's emerge animation inherits through the nesting, so it is unaffected. */}
        {chatMode === 'group' && replyTo && (
          <ReplyPreviewBar
            replyTo={replyTo}
            onClear={clearReply}
            containerClassName={`${theme === 'dark' ? 'bg-white/10' : 'bg-black/5'} ${tc.roundedClass} ${tc.text}`}
            iconClassName={tc.muted}
            nameClassName={tc.text}
            snippetClassName={tc.muted}
            closeBtnClassName={`${tc.muted} hover:opacity-100`}
          />
        )}
        <div className="flex gap-2 items-end">
          {chatMode === 'group' ? (
            // contentEditable mention editor — wrapped in relative flex-1 (mirrors classic ChatPanel)
            // so the dropdown + placeholder anchor to the editor box, not the outer input wrapper.
            // Without this wrap, an in-flow ReplyPreviewBar above the row pushed the editor down while
            // the absolutely-positioned placeholder stayed pinned to the outer wrapper → it floated up
            // onto the reply chip. The emerge animation is unaffected (opacity/translate inherit).
            <div className="relative flex-1">
              {/* #-mention dropdown — anchored to the editor wrapper, floats above it. */}
              {groupMention.showMention && groupMention.filteredMentionDrops.length > 0 && (
                <div
                  ref={groupMention.dropdownRef}
                  className={`absolute bottom-full left-0 right-0 mb-1 z-50 max-h-[240px] overflow-y-auto rounded-md border ${tc.border} ${tc.bg} shadow-lg`}
                  style={{ touchAction: 'pan-y' }}
                >
                  {groupMention.filteredMentionDrops.map((drop, idx) => (
                    <EditorialDropPickerRow
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
              {/* Placeholder — shown only when empty + no picker. Anchored to the editor wrapper, so
                  left-4 top-3 = the editor's px-4 py-3 text origin. (The old left-8 top-7 included the
                  outer wrapper's p-4, gone now that the anchor is the padding-less inner wrapper.) */}
              {groupInput === '' && !groupMention.showMention && (
                <span className={`pointer-events-none absolute left-4 top-3 text-[14px] ${tc.fontClass} ${theme === 'dark' ? 'text-white/30' : 'text-[#1A1A1A]/30'}`}>
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
                className={`w-full px-4 py-3 text-[14px] ${tc.fontClass} ${tc.bg} ${tc.text} border ${tc.border} rounded-lg focus:outline-none focus:border-[#1a1a1a] whitespace-pre-wrap break-words leading-relaxed min-h-[48px] max-h-[120px] overflow-y-auto [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]`}
              />
            </div>
          ) : (
            <textarea
              ref={aiTextareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Type a message..."
              disabled={loading}
              rows={1}
              className={`flex-1 px-4 py-3 text-[14px] ${tc.fontClass} ${tc.bg} ${tc.text} border ${tc.border} rounded-lg resize-none focus:outline-none focus:border-[#1a1a1a] disabled:opacity-50 [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none] ${theme === 'dark' ? 'placeholder:text-white/30' : 'placeholder:text-[#1A1A1A]/30'}`}
              style={{ maxHeight: '120px', touchAction: 'none' }}
            />
          )}
          <button
            onPointerDown={(e) => e.preventDefault()}
            onClick={chatMode === 'group' ? handleGroupSend : handleSend}
            disabled={chatMode === 'group' ? (groupSending || !groupInput.trim()) : (loading || !input.trim())}
            className="w-10 h-10 shrink-0 flex items-center justify-center bg-[#1a1a1a] text-white rounded-lg hover:bg-[#333] disabled:opacity-30 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5" />
            </svg>
          </button>
        </div>
      </div>

      {/* Copied toast */}
      {copiedMsgId && (
        <div className="absolute bottom-20 left-1/2 -translate-x-1/2 z-50 px-3 py-1.5 rounded-md bg-[#1a1a1a] text-white text-xs shadow-lg animate-fade-in-up">
          Copied
        </div>
      )}
    </div>
  );
}
