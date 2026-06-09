'use client';

import { useState, useRef, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import { auth } from '@/lib/firebase';
import {
  subscribeToMessages,
  saveMessage,
  createConversation,
  deleteConversation,
  updateConversationTitle,
  listConversations,
  Conversation,
  ChatMessage,
} from '@/lib/chat';
import { subscribeToGroupMessages, sendGroupMessage } from '@/lib/groupChat';
import { GroupChatMessage } from '@/types';

interface ChatPanelProps {
  theme: 'light' | 'dark' | 'minimal';
  onClose: () => void;
  onPreviewDrop?: (dropId: string, workspaceId: string | null) => void;
  workspaceId?: string | null;
  workspaceMembers?: any[];
  chatMode?: 'ai' | 'group';
  onChatModeChange?: (mode: 'ai' | 'group') => void;
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

export function ChatPanel({ theme, onClose, onPreviewDrop, workspaceId, workspaceMembers, chatMode: chatModeProp, onChatModeChange }: ChatPanelProps) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConvId, setActiveConvId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
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
  const groupUnsubRef = useRef<(() => void) | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const chatPanelRef = useRef<HTMLDivElement>(null);
  const unsubRef = useRef<(() => void) | null>(null);
  const s = getThemeStyles(theme);
  const userId = auth.currentUser?.uid;

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
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, loading]);

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

  // Keep panel above mobile virtual keyboard
  useEffect(() => {
    if (typeof window === 'undefined' || !window.visualViewport) return;

    const viewport = window.visualViewport;
    const panel = chatPanelRef.current;
    if (!panel) return;

    const onResize = () => {
      const offsetTop = viewport.offsetTop || 0;
      panel.style.height = `${viewport.height}px`;
      panel.style.top = `${offsetTop}px`;
    };

    onResize();
    viewport.addEventListener('resize', onResize);
    viewport.addEventListener('scroll', onResize);
    return () => {
      viewport.removeEventListener('resize', onResize);
      viewport.removeEventListener('scroll', onResize);
      panel.style.height = '';
      panel.style.top = '';
    };
  }, []);

  // Lock body scroll on mobile when chat is open
  useEffect(() => {
    const isMobile = window.innerWidth < 1024;
    if (isMobile) {
      const original = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      return () => { document.body.style.overflow = original; };
    }
  }, []);

  // Auto-scroll group messages
  useEffect(() => {
    if (chatMode === 'group' && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [groupMessages, chatMode]);

  const handleNewChat = () => {
    setActiveConvId(null);
    setMessages([]);
    setShowSidebar(false);
  };

  const [switchingConv, setSwitchingConv] = useState<string | null>(null);

  const handleSwitchConv = (convId: string) => {
    if (switchingConv) return;
    if (convId === activeConvId) {
      // Already on this chat, just close sidebar
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
      // Turn off animation after it completes
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

      // Check for preview drop from backend
      if (data.previewDropId && onPreviewDrop) {
        onPreviewDrop(data.previewDropId, data.previewWorkspaceId);
      }

      await saveMessage(userId, convId, 'assistant', response);
    } catch (e: any) {
      await saveMessage(userId, convId, 'assistant', `Error: ${e.message || 'Something went wrong'}`);
    } finally {
      setLoading(false);
      requestAnimationFrame(() => {
        inputRef.current?.focus();
      });
    }
  };

  const activeConv = conversations.find((c) => c.id === activeConvId);

  const handleGroupSend = async () => {
    const text = groupInput.trim();
    if (!text || groupSending || !userId || !workspaceId) return;
    const senderName = auth.currentUser?.displayName || auth.currentUser?.email?.split('@')[0] || 'Unknown';
    setGroupInput('');
    setGroupSending(true);
    await sendGroupMessage(workspaceId, userId, senderName, text);
    setGroupSending(false);
    // Mobile: refocus with small delay to keep keyboard open
    setTimeout(() => inputRef.current?.focus(), 100);
  };

  const handleClose = () => {
    setIsExiting(true);
    setTimeout(() => {
      onClose();
    }, theme === 'light' ? 200 : theme === 'dark' ? 250 : 300);
  };

  const handleCopy = async (msgId: string, content: string, messageElement: HTMLElement) => {
    const codeBlock = messageElement.querySelector('pre code');
    const textToCopy = codeBlock ? (codeBlock.textContent || '') : content;
    await navigator.clipboard.writeText(textToCopy);
    setCopiedId(msgId);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const animationClass = isExiting ? s.exitAnimation : s.enterAnimation;

  return (
    <div ref={chatPanelRef} onClick={() => inputRef.current?.focus()} className={`relative flex flex-col h-[520px] ${s.panelBorderWidth} ${s.borderColor} ${s.panelBg} ${s.panelShadow} ${animationClass} ${s.roundedClass} ${theme === 'minimal' ? 'minimal-scroll' : ''}`}>
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
              <div className={`max-w-[90%] px-3 py-2 text-xs leading-relaxed ${s.assistantBubble} ${s.roundedClass}`}>
                <ReactMarkdown>{WELCOME}</ReactMarkdown>
              </div>
            </div>
          )}
          {/* Messages - only show when sidebar is closed to prevent double render */}
          {!showSidebar && messages.map((msg, idx) => (
            <div
              key={msg.id}
              className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'} ${animateMessages ? 'animate-fade-in-msg' : ''}`}
              style={animateMessages ? { animationDelay: `${idx * 50}ms` } : {}}
            >
              <div
                className={`relative max-w-[90%] px-3 py-2 text-xs leading-relaxed overflow-x-auto group ${
                  msg.role === 'user' ? s.userBubble : s.assistantBubble
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
          ))}

          {loading && (
            <div className="flex justify-start px-3 py-2">
              <div className="w-3.5 h-3.5 rounded-full" style={{
                backgroundColor: theme === 'dark' ? '#ffffff' : '#1a1a1a',
                animation: 'l1-chat 2s infinite cubic-bezier(0.3,1,0,1)',
                ['--bg-mid' as string]: theme === 'dark' ? '#cccccc' : '#555555',
                ['--bg-end' as string]: theme === 'dark' ? '#888888' : '#333333',
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
        <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-2 min-h-0">
          {!groupMessagesLoading && groupMessages.length === 0 && (
            <div className="flex flex-col items-center justify-center py-8">
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
              <div key={msg.id} className={`flex ${isOwn ? 'justify-end' : 'justify-start'} animate-fade-in-up`} style={{ animationDelay: `${Math.min(idx, 10) * 30}ms` }}>
                {/* Avatar for other users */}
                {!isOwn && showSender && (
                  <div className={`w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-medium shrink-0 mr-1.5 mt-0.5 ${s.sendBtn} text-white`}>
                    {initial}
                  </div>
                )}
                {!isOwn && !showSender && <div className="w-6 mr-1.5 shrink-0" />}
                <div className="max-w-[80%]">
                  {showSender && !isOwn && (
                    <p className={`text-[10px] ${s.muted} mb-0.5 ml-1 truncate max-w-[160px]`}>{msg.senderName}</p>
                  )}
                  <div className={`px-3 py-2 text-xs leading-relaxed ${s.roundedClass} ${
                    isOwn ? s.userBubble : s.assistantBubble
                  }`}>
                    <div className="whitespace-pre-wrap break-words">{msg.content}</div>
                  </div>
                  {showSender && (
                    <p className={`text-[9px] ${s.muted} mt-0.5 ${isOwn ? 'text-right mr-1' : 'ml-1'}`}>{timeStr}</p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Input */}
      <div className={`border-t ${s.borderColor} p-3 shrink-0`}>
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
              disabled={loading}
              className={`flex-1 px-3 py-2 text-xs ${s.inputBg} ${s.inputText} ${s.placeholder} ${s.fontClass} tracking-wider border ${s.inputBorder} ${s.roundedClass} focus:outline-none focus:ring-1 ${s.focusRing} disabled:opacity-50`}
            />
            <button
              type="submit"
              disabled={loading || !input.trim()}
              className={`px-3 py-2 text-white text-xs disabled:opacity-30 transition-colors flex items-center justify-center ${s.sendBtn} ${s.roundedClass}`}
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5" />
              </svg>
            </button>
          </form>
        ) : (
          <form
            onSubmit={(e) => { e.preventDefault(); handleGroupSend(); }}
            className="flex gap-2"
          >
            <input
              ref={inputRef}
              type="text"
              value={groupInput}
              onChange={(e) => setGroupInput(e.target.value)}
              placeholder="Message workspace..."
              disabled={false}
              className={`flex-1 px-3 py-2 text-xs ${s.inputBg} ${s.inputText} ${s.placeholder} ${s.fontClass} tracking-wider border ${s.inputBorder} ${s.roundedClass} focus:outline-none focus:ring-1 ${s.focusRing} disabled:opacity-50`}
            />
            <button
              type="submit"
              disabled={groupSending || !groupInput.trim()}
              className={`px-3 py-2 text-white text-xs disabled:opacity-30 transition-colors flex items-center justify-center ${s.sendBtn} ${s.roundedClass}`}
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5" />
              </svg>
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
