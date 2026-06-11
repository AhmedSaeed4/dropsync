'use client';

import { useState, useRef, useEffect, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import { auth } from '@/lib/firebase';
import {
  subscribeToMessages,
  saveMessage,
  createConversation,
  deleteConversation,
  listConversations,
  Conversation,
  ChatMessage,
} from '@/lib/chat';
import { subscribeToGroupMessages, sendGroupMessage } from '@/lib/groupChat';
import { Drop, GroupChatMessage } from '@/types';
import { getEditorialThemeColors } from './editorialTheme';
import { parseMessageContent, detectHashtagTrigger } from '@/lib/dropTagUtils';

interface EditorialChatPanelProps {
  theme: 'light' | 'dark' | 'minimal';
  onClose: () => void;
  onPreviewDrop?: (dropId: string, workspaceId: string | null) => void;
  workspaceId?: string | null;
  workspaceMembers?: any[];
  chatMode?: 'ai' | 'group';
  onChatModeChange?: (mode: 'ai' | 'group') => void;
  drops?: Drop[];
}

const AGENT_URL = process.env.NEXT_PUBLIC_AGENT_URL || 'http://localhost:8000';

const WELCOME = 'Hi! I can help you manage your drops. Ask me to list drops, search content, check storage stats, or manage workspaces.';

export function EditorialChatPanel({ theme, onClose, onPreviewDrop, workspaceId, workspaceMembers, chatMode: chatModeProp, onChatModeChange, drops }: EditorialChatPanelProps) {
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
  const groupUnsubRef = useRef<(() => void) | null>(null);

  // Drop tag picker state
  const [showDropPicker, setShowDropPicker] = useState(false);
  const [hashtagQuery, setHashtagQuery] = useState('');
  const [pickerSelectedIndex, setPickerSelectedIndex] = useState(0);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [tagReplaceRange, setTagReplaceRange] = useState<{ start: number; end: number } | null>(null);

  // Attachment state — drops selected for the current message
  const [attachments, setAttachments] = useState<Drop[]>([]);

  const [switchingConv, setSwitchingConv] = useState<string | null>(null);
  const [animateMessages, setAnimateMessages] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const unsubRef = useRef<(() => void) | null>(null);
  const userId = auth.currentUser?.uid;
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

  // Scroll to bottom when keyboard opens/closes (visual viewport resize)
  useEffect(() => {
    if (typeof window === 'undefined' || !window.visualViewport) return;
    const viewport = window.visualViewport;
    const scrollToBottom = () => {
      if (scrollRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      }
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

  // Reset selected index when query changes
  useEffect(() => {
    setPickerSelectedIndex(0);
  }, [hashtagQuery]);

  // Scroll highlighted dropdown item into view
  useEffect(() => {
    if (!showDropPicker) return;
    const el = document.querySelector('[data-drop-highlighted="true"]');
    if (el) {
      el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [pickerSelectedIndex, showDropPicker]);

  // Close dropdown when switching out of group mode
  useEffect(() => {
    if (chatMode !== 'group') {
      setShowDropPicker(false);
      setAttachments([]);
    }
  }, [chatMode]);

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

  // Lock body scroll on mobile
  useEffect(() => {
    const isMobile = window.innerWidth < 1024;
    if (!isMobile) return;
    const scrollY = window.scrollY;
    document.documentElement.style.overflow = 'hidden';
    document.documentElement.style.height = '100%';
    document.body.style.overflow = 'hidden';
    document.body.style.height = '100%';
    document.body.style.scrollbarGutter = 'auto';
    return () => {
      document.documentElement.style.overflow = '';
      document.documentElement.style.height = '';
      document.body.style.overflow = '';
      document.body.style.height = '';
      document.body.style.scrollbarGutter = '';
      window.scrollTo(0, scrollY);
    };
  }, []);

  // Auto-scroll group messages
  useEffect(() => {
    if (chatMode === 'group' && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [groupMessages, chatMode]);

  // Auto-resize textarea
  useEffect(() => {
    if (textareaRef.current && chatMode === 'ai') {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 120) + 'px';
    }
  }, [input, chatMode]);

  // Auto-resize group textarea
  useEffect(() => {
    if (textareaRef.current && chatMode === 'group') {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 120) + 'px';
    }
  }, [groupInput, chatMode]);

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
      requestAnimationFrame(() => textareaRef.current?.focus());
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

  const handleGroupSend = async () => {
    setShowDropPicker(false);
    const text = groupInput.trim();
    if ((!text && attachments.length === 0) || groupSending || !userId || !workspaceId) return;

    // Build message with attachments at the top
    const attachmentTags = attachments.map(drop => `#[${drop.name}](${drop.id})`).join(' ');
    const fullText = attachmentTags ? `${attachmentTags} ${text}` : text;

    const senderName = auth.currentUser?.displayName || auth.currentUser?.email?.split('@')[0] || 'Unknown';
    setGroupInput('');
    setAttachments([]);
    setGroupSending(true);
    await sendGroupMessage(workspaceId, userId, senderName, fullText);
    setGroupSending(false);
    setTimeout(() => textareaRef.current?.focus(), 100);
  };

  // Filter drops for hashtag autocomplete
  const filteredDrops = useMemo(() => {
    if (!drops || !workspaceId) return [];
    const query = hashtagQuery.toLowerCase();
    const workspaceDrops = drops.filter(d => d.workspaceId === workspaceId);
    const matched = query
      ? workspaceDrops.filter(d => d.name.toLowerCase().includes(query))
      : workspaceDrops;
    const MAX_RESULTS = typeof window !== 'undefined' && window.innerWidth < 640 ? 5 : 8;
    return matched.slice(0, MAX_RESULTS);
  }, [drops, workspaceId, hashtagQuery]);

  const attachDrop = (drop: Drop) => {
    // Don't attach duplicates
    if (attachments.some(a => a.id === drop.id)) {
      setShowDropPicker(false);
      setTagReplaceRange(null);
      return;
    }

    // Remove the trigger text from input
    if (tagReplaceRange) {
      const { start, end } = tagReplaceRange;
      const before = groupInput.slice(0, start);
      const after = groupInput.slice(end);
      setGroupInput(before + after);
    }

    setAttachments(prev => [...prev, drop]);
    setShowDropPicker(false);
    setHashtagQuery('');
    setTagReplaceRange(null);
  };

  const removeAttachment = (dropId: string) => {
    setAttachments(prev => prev.filter(d => d.id !== dropId));
  };

  const handleGroupKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Dropdown navigation
    if (showDropPicker && filteredDrops.length > 0) {
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setPickerSelectedIndex(prev => Math.max(0, prev - 1));
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setPickerSelectedIndex(prev => Math.min(filteredDrops.length - 1, prev + 1));
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const selected = filteredDrops[pickerSelectedIndex];
        if (selected) attachDrop(selected);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setShowDropPicker(false);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleGroupSend();
    }
  };

  return (
    <div className={`flex flex-col h-full overflow-hidden border-l ${tc.border} ${tc.bg} transition-colors duration-500`}>
      {/* Header with staggered fade-in */}
      <div className={`border-b ${tc.border} px-5 py-4 flex items-center justify-between shrink-0 transition-all duration-300 ease-out ${showHeader ? 'opacity-100 translate-y-0' : 'opacity-0 -translate-y-[10px]'}`} style={{ touchAction: 'none' }}>
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
          {!groupMessagesLoading && groupMessages.length === 0 && (
            <div className="flex flex-col items-center justify-center py-8">
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
            const parts = parseMessageContent(msg.content);
            const textParts = parts.filter(p => p.type === 'text');
            const tagParts = parts.filter(p => p.type === 'tag');

            return (
              <div key={msg.id} className={`flex ${isOwn ? 'justify-end' : 'justify-start'} animate-fade-in-up`} style={{ animationDelay: `${Math.min(idx, 10) * 30}ms` }}>
                {/* Avatar for other users */}
                {!isOwn && showSender && (
                  <div className={`w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-medium shrink-0 mr-1.5 mt-0.5 ${tc.activePillBg} ${tc.activePillText}`}>
                    {initial}
                  </div>
                )}
                {!isOwn && !showSender && <div className="w-6 mr-1.5 shrink-0" />}
                <div className="max-w-[80%]">
                  {showSender && !isOwn && (
                    <p className={`text-[10px] ${tc.muted} mb-0.5 ml-1 truncate max-w-[160px]`}>{msg.senderName}</p>
                  )}
                  <div
                    className={`px-3.5 py-2.5 text-sm leading-relaxed ${tc.roundedClass} ${
                      isOwn
                        ? 'bg-[#1a1a1a] text-[#FFFEF5]'
                        : `bg-[#f5f5f5] ${theme === 'dark' ? 'bg-white/10 text-white' : 'text-[#1a1a1a]'} border ${tc.border}`
                    }`}
                    style={isOwn ? { borderBottomRightRadius: '3px' } : { borderBottomLeftRadius: '3px' }}
                  >
                    {/* Attachment cards */}
                    {tagParts.length > 0 && (
                      <div className="flex flex-wrap gap-1.5 mb-1">
                        {tagParts.map((part, i) => {
                          const dropExists = drops?.some(d => d.id === part.dropId);
                          return (
                            <button
                              key={i}
                              onClick={() => {
                                if (dropExists && onPreviewDrop && workspaceId) {
                                  onPreviewDrop(part.dropId!, workspaceId);
                                }
                              }}
                              disabled={!dropExists}
                              className={`inline-flex items-center gap-1 px-2 py-1 rounded text-[10px] font-medium transition-opacity ${
                                dropExists
                                  ? `${tc.activePillBg} ${tc.activePillText} hover:opacity-80 cursor-pointer`
                                  : 'bg-gray-500/20 text-gray-500 cursor-not-allowed opacity-50'
                              }`}
                            >
                              {dropExists && drops?.find(d => d.id === part.dropId)?.type === 'file' ? (
                                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 10.5V6.75a4.5 4.5 0 119 0v3.75M3.75 21.75h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H3.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" />
                                </svg>
                              ) : (
                                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25H12" />
                                </svg>
                              )}
                              {part.name}
                            </button>
                          );
                        })}
                      </div>
                    )}
                    {/* Text content */}
                    {textParts.length > 0 && (
                      <div className={`whitespace-pre-wrap break-words ${tc.fontClass}`}>
                        {textParts.map((part, i) => (
                          <span key={i}>{part.value}</span>
                        ))}
                      </div>
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
      )}

      {/* Input area with staggered fade-in */}
      <div className={`border-t ${tc.border} p-4 shrink-0 relative transition-all duration-300 ease-out ${showInputArea ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-[10px]'}`} style={{ touchAction: 'none' }}>
        {/* Dropdown */}
        {showDropPicker && filteredDrops.length > 0 && (
          <div
            ref={dropdownRef}
            className={`absolute bottom-full left-4 right-14 mb-1 z-50 max-h-[200px] overflow-y-auto rounded-md border ${tc.border} ${tc.bg} shadow-lg`}
            style={{ touchAction: 'pan-y' }}
          >
            {filteredDrops.map((drop, idx) => (
              <button
                key={drop.id}
                onClick={() => attachDrop(drop)}
                data-drop-highlighted={idx === pickerSelectedIndex}
                className={`w-full text-left px-4 py-2.5 text-sm truncate ${tc.fontClass} ${tc.text} ${
                  idx === pickerSelectedIndex ? `${tc.activePillBg} ${tc.activePillText}` : 'hover:bg-black/5'
                }`}
              >
                {drop.name}
              </button>
            ))}
          </div>
        )}
        {/* Attachment cards */}
        {chatMode === 'group' && attachments.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-2 px-4">
            {attachments.map((drop) => (
              <div
                key={drop.id}
                className={`inline-flex items-center gap-1.5 px-2 py-1 rounded text-[14px] ${tc.activePillBg} ${tc.activePillText}`}
              >
                {drop.type === 'file' ? (
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 10.5V6.75a4.5 4.5 0 119 0v3.75M3.75 21.75h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H3.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" />
                  </svg>
                ) : (
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25H12" />
                  </svg>
                )}
                <span className="truncate max-w-[120px]">{drop.name}</span>
                <button
                  onClick={() => removeAttachment(drop.id)}
                  className="opacity-60 hover:opacity-100 ml-1"
                >
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="flex gap-2 items-end">
          <textarea
            ref={textareaRef}
            value={chatMode === 'group' ? groupInput : input}
            onChange={(e) => {
              const value = e.target.value;
              if (chatMode === 'group') {
                setGroupInput(value);
                const cursor = e.target.selectionStart;
                const textBeforeCursor = value.slice(0, cursor ?? 0);
                const trigger = detectHashtagTrigger(textBeforeCursor);
                if (trigger && trigger.query.length > 0) {
                  setShowDropPicker(true);
                  setHashtagQuery(trigger.query);
                  setTagReplaceRange({ start: trigger.startIndex, end: cursor ?? 0 });
                } else {
                  setShowDropPicker(false);
                  setHashtagQuery('');
                  setTagReplaceRange(null);
                }
              } else {
                setInput(value);
              }
            }}
            onKeyDown={chatMode === 'group' ? handleGroupKeyDown : handleKeyDown}
            onBlur={(e) => {
              if (dropdownRef.current?.contains(e.relatedTarget as Node)) {
                return;
              }
              setShowDropPicker(false);
            }}
            placeholder={chatMode === 'group' ? 'Message workspace...' : 'Type a message...'}
            disabled={chatMode === 'group' ? false : loading}
            rows={1}
            className={`flex-1 px-4 py-3 text-[14px] ${tc.fontClass} ${tc.bg} ${tc.text} border ${tc.border} rounded-lg resize-none focus:outline-none focus:border-[#1a1a1a] disabled:opacity-50 [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none] ${theme === 'dark' ? 'placeholder:text-white/30' : 'placeholder:text-[#1A1A1A]/30'}`}
            style={{ maxHeight: '120px', touchAction: 'none' }}
          />
          <button
            onClick={chatMode === 'group' ? handleGroupSend : handleSend}
            disabled={chatMode === 'group' ? (groupSending || (!groupInput.trim() && attachments.length === 0)) : (loading || !input.trim())}
            className="w-10 h-10 shrink-0 flex items-center justify-center bg-[#1a1a1a] text-white rounded-lg hover:bg-[#333] disabled:opacity-30 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
