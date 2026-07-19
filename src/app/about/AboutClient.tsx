'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useAuth } from '@/hooks/useAuth';
import { getEditorialThemeColors } from '@/components/editorial/editorialTheme';

type Theme = 'light' | 'dark' | 'minimal';
type LayoutMode = 'classic' | 'editorial';

const THEME_STORAGE_KEY = 'dropsync_theme';
const LAYOUT_STORAGE_KEY = 'dropsync_layout';

export default function AboutClient() {
  const { user } = useAuth();

  // Read theme and layout synchronously from localStorage to avoid flash
  const getStoredTheme = (): Theme => {
    if (typeof window === 'undefined') return 'light';
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === 'dark' || stored === 'minimal') return stored;
    return 'light';
  };

  const getStoredLayout = (): LayoutMode => {
    if (typeof window === 'undefined') return 'editorial';
    const stored = localStorage.getItem(LAYOUT_STORAGE_KEY);
    if (stored === 'classic') return 'classic';
    return 'editorial';
  };

  const [theme, setTheme] = useState<Theme>(getStoredTheme);
  const [layoutMode, setLayoutMode] = useState<LayoutMode>(getStoredLayout);
  const [openFaqs, setOpenFaqs] = useState<Record<number, boolean>>({});
  const [pageVisible, setPageVisible] = useState(false);
  const [themeDropdownOpen, setThemeDropdownOpen] = useState(false);
  const [classicThemeDropdown, setClassicThemeDropdown] = useState(false);

  // Update theme/layout when localStorage changes
  useEffect(() => {
    const _isDark = theme === 'dark';
    const _isMinimal = theme === 'minimal';
    const _isClassic = layoutMode === 'classic';
    const bgColor = _isDark ? '#0D0D0D' : _isMinimal ? '#C5C9B8' : (_isClassic ? '#FAF7F2' : '#FFFEF5');
    document.body.style.background = bgColor;
    document.body.style.color = _isDark ? '#ffffff' : '#1a1a1a';
    return () => {
      document.body.style.background = '';
      document.body.style.color = '';
    };
  }, [theme, layoutMode]);

  const toggleFaq = (index: number) => {
    setOpenFaqs(prev => ({ ...prev, [index]: !prev[index] }));
  };

  useEffect(() => {
    const timer = setTimeout(() => setPageVisible(true), 10);
    return () => clearTimeout(timer);
  }, []);

  const isDark = theme === 'dark';
  const isMinimal = theme === 'minimal';
  const isClassic = layoutMode === 'classic';

  // ========================
  // CLASSIC LAYOUT
  // ========================
  if (isClassic) {
    const classicBg = isDark ? '#0D0D0D' : '#FAF7F2';
    const classicText = isDark ? '#ffffff' : '#1a1a1a';
    const classicBorder = isDark ? 'rgba(255,255,255,0.1)' : '#1a1a1a';
    const accentColor = '#FF5A47';

    return (
      <div className={`min-h-screen relative overflow-hidden transition-opacity duration-500 ease-out ${pageVisible ? 'opacity-100' : 'opacity-0'}`} style={{
        background: classicBg,
        color: classicText,
        transition: 'background-color 0.5s, color 0.5s, opacity 500ms ease-out',
      }}>
        {/* Header */}
        <header className="sticky top-0 z-50 border-b" style={{ borderColor: classicBorder, background: classicBg }}>
          <div className="flex items-center justify-between px-8 py-6">
            <a href="/" className="flex items-center gap-2">
              <div className="w-3 h-3" style={{ background: accentColor }} />
              <span className="font-mono text-sm uppercase tracking-widest">DROP/SYNC</span>
            </a>
            <div className="flex items-center gap-4 sm:gap-6">
              <a href="/" className="font-mono text-xs uppercase tracking-widest hover:opacity-70 transition-opacity" style={{ color: isDark ? 'rgba(255,255,255,0.6)' : 'rgba(26,26,26,0.6)' }}>HOME</a>
              <div className="hidden sm:flex gap-2">
                {(['light', 'dark'] as Theme[]).map((t) => (
                  <button key={t} onClick={() => { setTheme(t); localStorage.setItem(THEME_STORAGE_KEY, t); }}
                    className="font-mono text-xs uppercase tracking-widest border px-3 py-2 transition-all"
                    style={{ borderColor: t === theme ? accentColor : classicBorder, background: t === theme ? accentColor : 'transparent', color: t === theme ? '#ffffff' : isDark ? 'rgba(255,255,255,0.6)' : 'rgba(26,26,26,0.6)' }}>
                    {t}
                  </button>
                ))}
              </div>
              {/* Mobile theme dropdown */}
              <div className="relative sm:hidden">
                <button
                  onClick={() => setClassicThemeDropdown(!classicThemeDropdown)}
                  className="flex items-center gap-1 font-mono text-xs uppercase tracking-widest border rounded px-2 py-1.5 transition-colors"
                  style={{ borderColor: classicBorder, color: classicText }}
                >
                  {theme}
                  <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 9l6 6 6-6"/></svg>
                </button>
                {classicThemeDropdown && (
                  <div className="absolute right-0 top-full mt-1 border rounded shadow-lg z-50"
                    style={{ background: classicBg, borderColor: classicBorder }}>
                    {(['light', 'dark'] as Theme[]).map((t) => (
                      <button key={t}
                        onClick={() => { setTheme(t); localStorage.setItem(THEME_STORAGE_KEY, t); setClassicThemeDropdown(false); }}
                        className="block w-full text-left font-mono text-xs uppercase tracking-widest px-3 py-2 transition-colors"
                        style={{
                          background: t === theme ? accentColor : 'transparent',
                          color: t === theme ? '#ffffff' : classicText,
                        }}
                      >
                        {t}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        </header>

        <main className="relative z-10 max-w-[1000px] mx-auto px-8 py-16">
          {/* Title */}
          <div className="text-center mb-16">
            <h1 className="text-[clamp(2rem,5vw,3rem)] font-mono uppercase tracking-widest mb-4">ABOUT DROP/SYNC</h1>
            <p className="text-sm max-w-[600px] mx-auto leading-relaxed" style={{ color: isDark ? 'rgba(255,255,255,0.6)' : 'rgba(26,26,26,0.6)' }}>
              Secure file sharing and team collaboration in one place. Drop files, chat in real time, and work together in shared workspaces — encrypted, and cleaned up on a timer.
            </p>
          </div>

          {/* Specs */}
          <section className="py-16 border-t" style={{ borderColor: classicBorder }}>
            <div className="font-mono text-xs uppercase tracking-widest mb-3" style={{ color: isDark ? 'rgba(255,255,255,0.4)' : 'rgba(26,26,26,0.4)' }}>SPECIFICATIONS</div>
            <h2 className="text-[clamp(1.5rem,4vw,2.25rem)] font-mono uppercase tracking-widest mb-4">WHAT IS DROP/SYNC?</h2>
            <p className="text-sm max-w-[650px] mb-10" style={{ color: isDark ? 'rgba(255,255,255,0.6)' : 'rgba(26,26,26,0.6)' }}>
              No installation required, no permanent storage — just fast, private transfers that clean up after themselves.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {[
                ['MAX FILE SIZE', '500 MB'],
                ['MAX DROPS', 'UNLIMITED'],
                ['ENCRYPTION', 'AES-256-GCM'],
                ['STORAGE', 'CLOUDFLARE R2 + FIREBASE'],
                ['AUTO-EXPIRE', '1H, 2H, 6H, 24H'],
                ['AUTH', 'GOOGLE + EMAIL/PASSWORD'],
              ].map(([label, value]) => (
                <div key={label} className="p-4 border" style={{ borderColor: classicBorder, background: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(26,26,26,0.05)' }}>
                  <div className="font-mono text-xs uppercase tracking-widest mb-1" style={{ color: isDark ? 'rgba(255,255,255,0.4)' : 'rgba(26,26,26,0.4)' }}>{label}</div>
                  <div className="font-mono text-sm uppercase tracking-wider">{value}</div>
                </div>
              ))}
            </div>
          </section>

          {/* Features */}
          <section className="py-16 border-t" style={{ borderColor: classicBorder }}>
            <div className="font-mono text-xs uppercase tracking-widest mb-3" style={{ color: isDark ? 'rgba(255,255,255,0.4)' : 'rgba(26,26,26,0.4)' }}>FEATURES</div>
            <h2 className="text-[clamp(1.5rem,4vw,2.25rem)] font-mono uppercase tracking-widest mb-4">EVERYTHING YOU NEED</h2>
            <p className="text-sm max-w-[650px] mb-10" style={{ color: isDark ? 'rgba(255,255,255,0.6)' : 'rgba(26,26,26,0.6)' }}>
              Share files and work with your team in one encrypted place. Free to use today, with premium features like forever storage on the roadmap.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {[
                ['DRAG & DROP', 'Drop multiple files at once or click to open the file picker. Supports any file type.'],
                ['TEXT SNIPPETS', 'Type or paste text directly. Great for notes, code, URLs, or quick messages between devices.'],
                ['CLIPBOARD PASTE', 'Paste images directly from your clipboard. Screenshot on one device, paste on another.'],
                ['VOICE TO TEXT', 'Speak instead of type. Uses Groq Whisper AI for fast, accurate transcription in any language.'],
                ['SHAREABLE LINKS', 'Each drop gets a unique link. Share it with anyone — no account needed to view or download.'],
                ['AUTO-EXPIRY', 'Set files to auto-delete after 1h, 2h, 6h, or 24h. Forever storage is a premium feature on the roadmap. Expired drops are cleaned up automatically.'],
                ['RICH PREVIEWS', 'Preview images, text, videos, and YouTube links inline. No need to download just to see what was shared.'],
                ['WORKS EVERYWHERE', 'Desktop, tablet, or phone. Any modern browser. No app to install, no extensions required.'],
                ['SHARED WORKSPACES', 'Create workspaces, invite team members with a 6-character code, and collaborate on drops and chat together in real time.'],
                ['TEAM CHAT', 'Real-time group chat inside every workspace, encrypted with the workspace key.'],
                ['MENTIONS & PUSH', '@mention teammates to pull them in — even across workspaces — and get push notifications on desktop and mobile, even when DropSync is closed.'],
                ['READ RECEIPTS & TYPING', 'See when your messages are read and when someone\'s typing, so team conversations keep moving.'],
                ['REPLY & EDIT', 'Reply to specific messages and edit your own — changes sync instantly for everyone.'],
                ['MOVE DROPS', 'Move drops between personal space and workspaces, or between different workspaces — with automatic re-encryption.'],
                ['BULK ACTIONS', 'Select multiple drops at once. Bulk move to another workspace or bulk delete in a single action.'],
                ['DROP EDITING', 'Edit existing drops — update names, content, categories, expiry, or attached images with automatic re-encryption.'],
                ['MULTI-CATEGORY', 'Assign up to 3 categories per drop for better organization. Built-in categories like Password and Link, or create your own.'],
                ['AI CHAT ASSISTANT', 'Talk to your drops naturally — search, create, delete, get stats, and preview drops via the built-in AI agent.'],
                ['UNDO DELETE', 'Accidentally deleted a drop? A 30-second undo window gives you time to recover before it&apos;s gone for good.'],
                ['ACCOUNT DELETION', 'Delete your account anytime. Your drops, profile, keys, and chat history are removed from our database.'],
              ].map(([title, desc]) => (
                <div key={title} className="p-6 border transition-colors" style={{ borderColor: classicBorder, background: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(26,26,26,0.05)' }}>
                  <div className="font-mono text-sm uppercase tracking-wider mb-2">{title}</div>
                  <div className="text-xs leading-relaxed" style={{ color: isDark ? 'rgba(255,255,255,0.6)' : 'rgba(26,26,26,0.6)' }}>{desc}</div>
                </div>
              ))}
            </div>
          </section>

          {/* How It Works */}
          <section id="how-it-works" className="py-16 border-t" style={{ borderColor: classicBorder }}>
            <div className="font-mono text-xs uppercase tracking-widest mb-3" style={{ color: isDark ? 'rgba(255,255,255,0.4)' : 'rgba(26,26,26,0.4)' }}>HOW IT WORKS</div>
            <h2 className="text-[clamp(1.5rem,4vw,2.25rem)] font-mono uppercase tracking-widest mb-4">TWO MODES. FOUR STEPS EACH.</h2>
            <p className="text-sm max-w-[650px] mb-10" style={{ color: isDark ? 'rgba(255,255,255,0.6)' : 'rgba(26,26,26,0.6)' }}>
              DropSync works two ways — share a file with anyone via link, or collaborate with a team in a shared workspace.
            </p>

            {/* Personal sharing flow */}
            <div className="mb-12">
              <h3 className="font-mono text-sm uppercase tracking-wider mb-6" style={{ color: accentColor }}>PERSONAL SHARING — DROP & PICKUP</h3>
              {[
                ['1', 'SIGN IN', 'Use Google or create an email account. Takes 10 seconds. Your personal workspace is created automatically.'],
                ['2', 'DROP YOUR FILES', 'Drag files onto the page, click to browse, paste from clipboard, or type a text snippet. Set an expiry time.'],
                ['3', 'SHARE THE LINK', 'Copy the unique link and send it to anyone. They can view, preview, and download — no account needed on their end.'],
                ['4', 'IT CLEANS UP', 'When the timer expires, files are automatically deleted from storage.'],
              ].map(([num, title, desc], i, arr) => (
                <div key={num} className="flex gap-6 py-6" style={{ borderBottom: i < arr.length - 1 ? `1px solid ${classicBorder}` : 'none' }}>
                  <div className="flex-shrink-0 w-10 h-10 border flex items-center justify-center font-mono text-sm" style={{ borderColor: classicBorder }}>{num}</div>
                  <div>
                    <div className="font-mono text-sm uppercase tracking-wider mb-1">{title}</div>
                    <div className="text-xs leading-relaxed" style={{ color: isDark ? 'rgba(255,255,255,0.6)' : 'rgba(26,26,26,0.6)' }}>{desc}</div>
                  </div>
                </div>
              ))}
            </div>

            {/* Workspace collaboration flow */}
            <div>
              <h3 className="font-mono text-sm uppercase tracking-wider mb-6" style={{ color: accentColor }}>WORKSPACE COLLABORATION — SHARE & WORK TOGETHER</h3>
              {[
                ['1', 'CREATE A WORKSPACE', 'Name your workspace and get a unique 6-character invite code. You become the owner with full control.'],
                ['2', 'INVITE YOUR TEAM', 'Share the invite code. Anyone who joins sees the same drops in real time, all encrypted with a shared workspace key.'],
                ['3', 'COLLABORATE ON DROPS & CHAT', 'Any member can drop files, edit drops, move drops, and chat in real time. Everything stays in sync.'],
                ['4', 'MANAGE YOUR TEAM', 'Owners can delete workspaces, remove members, and rotate the invite code. Members can leave at any time.'],
              ].map(([num, title, desc], i, arr) => (
                <div key={num} className="flex gap-6 py-6" style={{ borderBottom: i < arr.length - 1 ? `1px solid ${classicBorder}` : 'none' }}>
                  <div className="flex-shrink-0 w-10 h-10 border flex items-center justify-center font-mono text-sm" style={{ borderColor: classicBorder }}>{num}</div>
                  <div>
                    <div className="font-mono text-sm uppercase tracking-wider mb-1">{title}</div>
                    <div className="text-xs leading-relaxed" style={{ color: isDark ? 'rgba(255,255,255,0.6)' : 'rgba(26,26,26,0.6)' }}>{desc}</div>
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* Security */}
          <section id="security" className="py-16 border-t" style={{ borderColor: classicBorder }}>
            <div className="font-mono text-xs uppercase tracking-widest mb-3" style={{ color: isDark ? 'rgba(255,255,255,0.4)' : 'rgba(26,26,26,0.4)' }}>SECURITY</div>
            <h2 className="text-[clamp(1.5rem,4vw,2.25rem)] font-mono uppercase tracking-widest mb-4">YOUR FILES, YOUR PRIVACY</h2>
            <p className="text-sm max-w-[650px] mb-10" style={{ color: isDark ? 'rgba(255,255,255,0.6)' : 'rgba(26,26,26,0.6)' }}>
              Files under 10MB are encrypted client-side with AES-256-GCM; larger files are protected in transit over HTTPS. Metadata lives in Firebase Firestore behind strict access rules. This is encryption in transit and at rest — not end-to-end: we hold the keys to run features like the AI assistant, so we are able to decrypt content when needed. Expired files are deleted from our storage and database; provider-side backups may persist briefly as part of normal operations.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {[
                ['ENCRYPTED AT REST', 'AES-256-GCM encryption on stored files under 10MB. Larger files ride HTTPS only. Personal drops use individual keys; workspace drops use a shared key.'],
                ['FIREBASE AUTH', 'Google and email/password authentication via Firebase. Sensitive server actions additionally verify your token.'],
                ['AUTO-DELETION', 'Expired drops are removed from storage and database. Provider-side backups may persist briefly as part of normal operations.'],
                ['WORKSPACE KEYS', 'Workspace drops are encrypted with a key shared among members. Leaving or being removed revokes your copy of the key.'],
                ['ACCESS CONTROL', 'Any workspace member can add, edit, and move drops. Only the owner can delete the workspace, remove members, and rotate the invite code. Shared links are read-only.'],
                ['LARGE FILE HANDLING', 'Files under 10MB are encrypted. Larger files skip encryption for performance but remain secure via HTTPS in transit.'],
              ].map(([title, desc]) => (
                <div key={title} className="p-6 border transition-colors" style={{ borderColor: classicBorder, background: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(26,26,26,0.05)' }}>
                  <div className="font-mono text-sm uppercase tracking-wider mb-2">{title}</div>
                  <div className="text-xs leading-relaxed" style={{ color: isDark ? 'rgba(255,255,255,0.6)' : 'rgba(26,26,26,0.6)' }}>{desc}</div>
                </div>
              ))}
            </div>
          </section>

          {/* FAQ */}
          <section className="py-16 border-t" style={{ borderColor: classicBorder }}>
            <div className="font-mono text-xs uppercase tracking-widest mb-3" style={{ color: isDark ? 'rgba(255,255,255,0.4)' : 'rgba(26,26,26,0.4)' }}>FAQ</div>
            <h2 className="text-[clamp(1.5rem,4vw,2.25rem)] font-mono uppercase tracking-widest mb-10">COMMON QUESTIONS</h2>
            <div className="flex flex-col">
              {[
                ['DO I NEED AN ACCOUNT TO DOWNLOAD SHARED FILES?', 'No. Anyone with the link can view and download files. Accounts are only needed to upload and manage drops.'],
                ['WHAT FILE TYPES ARE SUPPORTED?', 'Any file type. Images, PDFs, documents, videos, archives — if it\'s under 500MB, you can drop it.'],
                ['WHAT HAPPENS WHEN A DROP EXPIRES?', 'The files are deleted from Cloudflare R2 storage and the metadata is removed from the database. The share link stops working. Provider-side backups may persist briefly as part of normal operations.'],
                ['CAN I EXTEND THE EXPIRY TIME AFTER UPLOADING?', 'Not currently. Once a drop is created, its expiry is fixed. Delete it and re-upload with a new timer if needed.'],
                ['IS THERE A LIMIT TO HOW MANY DROPS I CAN CREATE?', 'No, there is no limit on the number of drops you can create.'],
                ['HOW DOES VOICE-TO-TEXT WORK?', 'Click the microphone button, speak, and your audio is transcribed using Groq\'s Whisper AI. The text appears as a regular text drop you can edit before saving.'],
                ['WHAT ARE SHARED WORKSPACES?', 'Workspaces let multiple users collaborate on the same drops. Create one, invite team members with a 6-character code, and everyone sees the same drops in real time.'],
                ['CAN I MOVE DROPS BETWEEN WORKSPACES?', 'Yes. You can move drops between your personal space and any workspace you\'re a member of, or between workspaces. The drop is automatically re-encrypted with the new workspace key.'],
                ['WHO CAN MANAGE A WORKSPACE?', 'The workspace owner can delete the workspace and copy the invite code. Members can leave. All members can add and manage drops.'],
                ['HOW DO I INVITE SOMEONE TO MY WORKSPACE?', 'Click the workspace selector, find your workspace, and click the link icon to copy the 6-character invite code. Share it with anyone — they can join from the login screen.'],
                ['CAN MY TEAM CHAT INSIDE A WORKSPACE?', 'Yes. Every workspace has real-time group chat. Messages are encrypted with the workspace key, and you can @mention teammates, reply to messages, edit your own, and see read receipts and typing indicators.'],
                ['WILL I BE NOTIFIED ABOUT NEW MESSAGES?', 'Yes. You get push notifications on desktop and mobile (Android and desktop browsers), even when DropSync is closed. @mentions reach you across workspaces.'],
                ['CAN I DELETE MY ACCOUNT?', 'Yes. Account deletion removes your drops, profile, keys, and chat history from our database. Workspace drops you created remain available to other members.'],
              ].map(([q, a], i) => (
                <div key={i} style={{ borderBottom: `1px solid ${classicBorder}` }}>
                  <button onClick={() => toggleFaq(i)} className="w-full flex items-center justify-between py-6 text-left font-mono text-sm uppercase tracking-wider hover:opacity-70 transition-opacity">
                    <span>{q}</span>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={`w-5 h-5 flex-shrink-0 transition-transform duration-300 ${openFaqs[i] ? 'rotate-45' : ''}`} style={{ color: isDark ? 'rgba(255,255,255,0.6)' : 'rgba(26,26,26,0.6)' }}>
                      <path d="M12 6v12m6-6H6" />
                    </svg>
                  </button>
                  <div className={`overflow-hidden transition-all duration-300 ${openFaqs[i] ? 'max-h-[200px] pb-6' : 'max-h-0'}`}>
                    <p className="text-xs leading-relaxed" style={{ color: isDark ? 'rgba(255,255,255,0.6)' : 'rgba(26,26,26,0.6)' }}>{a}</p>
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* CTA */}
          <section className="py-16 text-center">
            <h2 className="text-[clamp(1.5rem,4vw,2.25rem)] font-mono uppercase tracking-widest mb-4">READY TO DROP?</h2>
            <p className="text-sm mb-8" style={{ color: isDark ? 'rgba(255,255,255,0.6)' : 'rgba(26,26,26,0.6)' }}>Start sharing and collaborating in seconds. Sign in with Google or email — no download, no install.</p>
            <Link href="/" className="inline-flex items-center gap-2 px-8 py-3 border font-mono text-xs uppercase tracking-widest transition-all duration-300" style={{ borderColor: accentColor, background: accentColor, color: '#ffffff' }}>
              GET STARTED
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 12h14M12 5l7 7-7 7" /></svg>
            </Link>
          </section>
        </main>

        <footer className="relative z-10 flex justify-between items-center px-8 py-6 text-xs border-t font-mono uppercase tracking-widest" style={{ borderColor: classicBorder, color: isDark ? 'rgba(255,255,255,0.4)' : 'rgba(26,26,26,0.4)' }}>
          <div className="flex items-center gap-4">
            <a href="/" style={{ color: isDark ? 'rgba(255,255,255,0.4)' : 'rgba(26,26,26,0.4)' }} className="hover:opacity-70 transition-opacity">HOME</a>
            <a href="/docs" style={{ color: isDark ? 'rgba(255,255,255,0.4)' : 'rgba(26,26,26,0.4)' }} className="hover:opacity-70 transition-opacity">DOCS</a>
            <a href="/terms" style={{ color: isDark ? 'rgba(255,255,255,0.4)' : 'rgba(26,26,26,0.4)' }} className="hover:opacity-70 transition-opacity">TERMS</a>
            <a href="/privacy" style={{ color: isDark ? 'rgba(255,255,255,0.4)' : 'rgba(26,26,26,0.4)' }} className="hover:opacity-70 transition-opacity">PRIVACY</a>
          </div>
          <span>© 2026 DropSync</span>
          <span className="hidden sm:inline">500MB / UNLIMITED</span>
        </footer>
      </div>
    );
  }

  // ========================
  // EDITORIAL LAYOUT
  // ========================
  return (
    <div className={`min-h-screen relative overflow-hidden transition-opacity duration-500 ease-out ${pageVisible ? 'opacity-100' : 'opacity-0'}`} style={{
      background: isDark ? '#0D0D0D' : isMinimal ? '#C5C9B8' : '#FFFEF5',
      color: isDark ? '#ffffff' : '#1a1a1a',
      transition: 'background-color 0.5s, color 0.5s, opacity 500ms ease-out',
    }}>
      {/* Header */}
      <header className={`sticky top-0 z-50 border-b ${isDark ? 'border-[#333]' : isMinimal ? 'border-[#b0b4a5]' : 'border-[#e0e0e0]'}`} style={{ background: isDark ? '#0D0D0D' : isMinimal ? '#C5C9B8' : '#FFFEF5', transition: 'background-color 0.5s' }}>
        <div className="flex items-center justify-between px-4 sm:px-6 lg:px-[7.5rem] py-4 lg:py-6">
          <div className="flex items-center gap-2.5">
            <Link href="/" className="flex items-center gap-2.5">
              <div className="w-3 h-3 rotate-45" style={{ background: isDark ? '#ffffff' : '#1a1a1a' }} />
              <span className="font-[family-name:var(--font-raleway)] text-[22px] font-medium tracking-[-0.3px]">DropSync</span>
            </Link>
          </div>
          <div className="flex items-center gap-2 sm:gap-3 lg:gap-6">
            <Link href="/" className="text-sm font-[family-name:var(--font-raleway)] text-[#666] hover:text-[#1a1a1a] transition-colors tracking-wider">Home</Link>
            {/* Desktop theme buttons */}
            <div className="hidden sm:flex gap-1 sm:gap-2">
              {(['light', 'dark', 'minimal'] as Theme[]).map((t) => (
                <button key={t} onClick={() => { setTheme(t); localStorage.setItem(THEME_STORAGE_KEY, t); }}
                  className={`text-sm font-[family-name:var(--font-raleway)] rounded-md border transition-all duration-350 px-3 sm:px-4 py-2 ${t === theme ? isDark ? 'bg-white text-[#0D0D0D] border-white' : 'bg-[#1a1a1a] text-white border-[#1a1a1a]' : `${isDark ? 'border-[#333] text-[#888]' : isMinimal ? 'border-[#b0b4a5] text-[#4a4a4a]' : 'border-[#e0e0e0] text-[#666]'} hover:bg-[#1a1a1a] hover:text-white`}`}>
                  {t === 'light' ? 'Light' : t === 'dark' ? 'Dark' : 'Minimal'}
                </button>
              ))}
            </div>
            {/* Mobile theme dropdown */}
            <div className="relative sm:hidden">
              <button
                onClick={() => setThemeDropdownOpen(!themeDropdownOpen)}
                className="flex items-center gap-1 text-xs font-[family-name:var(--font-raleway)] border rounded px-2 py-1.5 transition-colors"
                style={{ borderColor: isDark ? '#333' : isMinimal ? '#b0b4a5' : '#e0e0e0', color: isDark ? '#ffffff' : '#1a1a1a' }}
              >
                {theme === 'light' ? 'Light' : theme === 'dark' ? 'Dark' : 'Minimal'}
                <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 9l6 6 6-6"/></svg>
              </button>
              {themeDropdownOpen && (
                <div className="absolute right-0 top-full mt-1 border rounded shadow-lg z-50"
                  style={{ background: isDark ? '#0D0D0D' : isMinimal ? '#C5C9B8' : '#FFFEF5', borderColor: isDark ? '#333' : isMinimal ? '#b0b4a5' : '#e0e0e0' }}>
                  {(['light', 'dark', 'minimal'] as Theme[]).map((t) => (
                    <button key={t}
                      onClick={() => { setTheme(t); localStorage.setItem(THEME_STORAGE_KEY, t); setThemeDropdownOpen(false); }}
                      className="block w-full text-left text-xs font-[family-name:var(--font-raleway)] px-3 py-2 transition-colors whitespace-nowrap"
                      style={{
                        background: t === theme ? (isDark ? '#ffffff' : '#1a1a1a') : 'transparent',
                        color: t === theme ? (isDark ? '#0D0D0D' : '#ffffff') : (isDark ? '#ffffff' : '#1a1a1a'),
                      }}
                    >
                      {t === 'light' ? 'Light' : t === 'dark' ? 'Dark' : 'Minimal'}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </header>

      <main className="relative z-10 max-w-[1000px] mx-auto px-4 sm:px-8 lg:px-0 py-16">
        {/* Title */}
        <div className="text-center mb-16 font-[family-name:var(--font-raleway)]">
          <h1 className="text-[clamp(2rem,5vw,3rem)] font-light tracking-[-0.02em] mb-4">About DropSync</h1>
          <p className="text-[1.1rem] text-[#666] max-w-[600px] mx-auto leading-relaxed">
            Secure file sharing and team collaboration in one place. Drop files, chat in real time, and work together in shared workspaces — encrypted, and cleaned up on a timer.
          </p>
        </div>

        {/* Specs */}
        <section className="py-16 border-t first:border-t-0 font-[family-name:var(--font-raleway)]" style={{ borderColor: isDark ? '#333' : isMinimal ? '#b0b4a5' : '#e0e0e0' }}>
          <div className="text-[0.75rem] uppercase tracking-[0.15em] text-[#666] mb-3">Specifications</div>
          <h2 className="text-[clamp(1.5rem,4vw,2.25rem)] font-normal tracking-[-0.02em] mb-4">What is DropSync?</h2>
          <p className="text-[1rem] text-[#666] leading-relaxed max-w-[650px] mb-10">
            No installation required, no permanent storage — just fast, private transfers that clean up after themselves.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {[
              ['Max File Size', '500 MB'],
              ['Max Drops', 'Unlimited'],
              ['Encryption', 'AES-256-GCM'],
              ['Storage', 'Cloudflare R2 + Firebase'],
              ['Auto-Expire', '1h, 2h, 6h, 24h'],
              ['Auth', 'Google + Email/Password'],
            ].map(([label, value]) => (
              <div key={label} className={`p-5 border rounded-lg ${isDark ? 'bg-[#1a1a1a] border-[#333]' : isMinimal ? 'bg-[#C5C9B8] border-[#b0b4a5]' : 'bg-[#FDFCF9] border-[#e0e0e0]'}`}>
                <div className="text-[0.75rem] uppercase tracking-[0.15em] text-[#666] mb-1">{label}</div>
                <div className="text-[1rem] font-medium">{value}</div>
              </div>
            ))}
          </div>
        </section>

        {/* Features */}
        <section className="py-16 border-t font-[family-name:var(--font-raleway)]" style={{ borderColor: isDark ? '#333' : isMinimal ? '#b0b4a5' : '#e0e0e0' }}>
          <div className="text-[0.75rem] uppercase tracking-[0.15em] text-[#666] mb-3">Features</div>
          <h2 className="text-[clamp(1.5rem,4vw,2.25rem)] font-normal tracking-[-0.02em] mb-4">Everything you need</h2>
          <p className="text-[1rem] text-[#666] leading-relaxed max-w-[650px] mb-10">
            Share files and work with your team in one encrypted place. Free to use today, with premium features like forever storage on the roadmap.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-2 gap-6">
            {[
              ['Drag & Drop', 'Drop multiple files at once or click to open the file picker. Supports any file type.', 'M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5'],
              ['Text Snippets', 'Type or paste text directly. Great for notes, code, URLs, or quick messages between devices.', 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z'],
              ['Clipboard Paste', 'Paste images directly from your clipboard. Screenshot on one device, paste on another.', 'M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z'],
              ['Voice to Text', 'Speak instead of type. Uses Groq Whisper AI for fast, accurate transcription in any language.', 'M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m-4-2h8m-4-12a3 3 0 01-3-3V3a3 3 0 016 0v2a3 3 0 01-3 3z'],
              ['Shareable Links', 'Each drop gets a unique link. Share it with anyone — no account needed to view or download.', 'M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1'],
              ['Auto-Expiry', 'Set files to auto-delete after 1h, 2h, 6h, or 24h. Forever storage is a premium feature on the roadmap. Expired drops are cleaned up automatically.', 'M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z'],
              ['Rich Previews', 'Preview images, text, videos, and YouTube links inline. No need to download just to see what was shared.', 'M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z'],
              ['Works Everywhere', 'Desktop, tablet, or phone. Any modern browser. No app to install, no extensions required.', 'M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z'],
              ['Shared Workspaces', 'Create workspaces, invite team members with a 6-character code, and collaborate on drops and chat together in real time.', 'M18 9v3m0 0v3m0-3h3m-3 0h-3m-2-5a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3v-1z'],
              ['Team Chat', 'Real-time group chat inside every workspace, encrypted with the workspace key.', 'M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z'],
              ['Mentions & Push', '@mention teammates to pull them in — even across workspaces — and get push notifications on desktop and mobile, even when DropSync is closed.', 'M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 0 1-3.46 0'],
              ['Read Receipts & Typing', 'See when your messages are read and when someone\'s typing, so team conversations keep moving.', 'M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8zM15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0z'],
              ['Reply & Edit', 'Reply to specific messages and edit your own — changes sync instantly for everyone.', 'M9 14L4 9l5-5M4 9h11a4 4 0 0 1 0 8h-1'],
              ['Move Drops', 'Move drops between personal space and workspaces, or between different workspaces — with automatic re-encryption.', 'M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12'],
              ['Bulk Actions', 'Select multiple drops at once. Bulk move to another workspace or bulk delete in a single action.', 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z'],
              ['Drop Editing', 'Edit existing drops — update names, content, categories, expiry, or attached images with automatic re-encryption.', 'M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z'],
              ['Multi-Category', 'Assign up to 3 categories per drop for better organization. Built-in categories like Password and Link, or create your own.', 'M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z'],
              ['AI Chat Assistant', 'Talk to your drops naturally — search, create, delete, get stats, and preview drops via the built-in AI agent.', 'M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z'],
              ['Undo Delete', 'Accidentally deleted a drop? A 30-second undo window gives you time to recover before it&apos;s gone for good.', 'M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6'],
              ['Account Deletion', 'Delete your account anytime. Your drops, profile, keys, and chat history are removed from our database.', 'M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M10 11v6M14 11v6'],
            ].map(([title, desc, path]) => (
              <div key={title} className={`p-8 border rounded-lg transition-colors ${isDark ? 'bg-[#1a1a1a] border-[#333] hover:border-[#555]' : isMinimal ? 'bg-[#C5C9B8] border-[#b0b4a5] hover:border-[#1a1a1a]' : 'bg-[#FDFCF9] border-[#e0e0e0] hover:border-[#999]'}`}>
                <div className={`w-12 h-12 rounded-lg border flex items-center justify-center mb-5 ${isDark ? 'bg-white/5 border-[#333]' : isMinimal ? 'bg-white/30 border-[#b0b4a5]' : 'bg-white/70 border-[#e0e0e0]'}`}>
                  <svg viewBox="0 0 24 24" fill="none" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="w-[22px] h-[22px]" style={{ stroke: isDark ? '#ffffff' : '#1a1a1a' }}>
                    <path d={path} />
                  </svg>
                </div>
                <div className="text-[1rem] font-medium mb-2">{title}</div>
                <div className="text-[0.875rem] text-[#666] leading-relaxed">{desc}</div>
              </div>
            ))}
          </div>
        </section>

        {/* How It Works */}
        <section id="how-it-works" className="py-16 border-t font-[family-name:var(--font-raleway)]" style={{ borderColor: isDark ? '#333' : isMinimal ? '#b0b4a5' : '#e0e0e0' }}>
          <div className="text-[0.75rem] uppercase tracking-[0.15em] text-[#666] mb-3">How It Works</div>
          <h2 className="text-[clamp(1.5rem,4vw,2.25rem)] font-normal tracking-[-0.02em] mb-4">Two modes. Four steps each.</h2>
          <p className="text-[1rem] text-[#666] leading-relaxed max-w-[650px] mb-10">
            DropSync works two ways — share a file with anyone via link, or collaborate with a team in a shared workspace.
          </p>

          {/* Personal sharing flow */}
          <div className="mb-12">
            <h3 className="text-[1rem] font-medium mb-6" style={{ color: isDark ? '#ffffff' : '#1a1a1a' }}>Personal Sharing — Drop &amp; Pickup</h3>
            {[
              ['1', 'Sign in', 'Use Google or create an email account. Takes 10 seconds. Your personal workspace is created automatically.'],
              ['2', 'Drop your files', 'Drag files onto the page, click to browse, paste from clipboard, or type a text snippet. Set an expiry time.'],
              ['3', 'Share the link', 'Copy the unique link and send it to anyone. They can view, preview, and download — no account needed on their end.'],
              ['4', 'It cleans up', 'When the timer expires, files are automatically deleted from storage.'],
            ].map(([num, title, desc], i, arr) => (
              <div key={num} className="flex gap-6 py-6" style={{ borderBottom: i < arr.length - 1 ? (isDark ? '#333' : isMinimal ? '#b0b4a5' : '#e0e0e0') : 'none' }}>
                <div className={`flex-shrink-0 w-10 h-10 rounded-full border flex items-center justify-center text-[0.875rem] font-medium text-[#666] ${isDark ? 'border-[#333]' : isMinimal ? 'border-[#b0b4a5]' : 'border-[#e0e0e0]'}`}>{num}</div>
                <div>
                  <div className="text-[1rem] font-medium mb-1">{title}</div>
                  <div className="text-[0.875rem] text-[#666] leading-relaxed">{desc}</div>
                </div>
              </div>
            ))}
          </div>

          {/* Workspace collaboration flow */}
          <div>
            <h3 className="text-[1rem] font-medium mb-6" style={{ color: isDark ? '#ffffff' : '#1a1a1a' }}>Workspace Collaboration — Share &amp; Work Together</h3>
            {[
              ['1', 'Create a workspace', 'Name your workspace and get a unique 6-character invite code. You become the owner with full control.'],
              ['2', 'Invite your team', 'Share the invite code. Anyone who joins sees the same drops in real time, all encrypted with a shared workspace key.'],
              ['3', 'Collaborate on drops & chat', 'Any member can drop files, edit drops, move drops, and chat in real time. Everything stays in sync.'],
              ['4', 'Manage your team', 'Owners can delete workspaces, remove members, and rotate the invite code. Members can leave at any time.'],
            ].map(([num, title, desc], i, arr) => (
              <div key={num} className="flex gap-6 py-6" style={{ borderBottom: i < arr.length - 1 ? (isDark ? '#333' : isMinimal ? '#b0b4a5' : '#e0e0e0') : 'none' }}>
                <div className={`flex-shrink-0 w-10 h-10 rounded-full border flex items-center justify-center text-[0.875rem] font-medium text-[#666] ${isDark ? 'border-[#333]' : isMinimal ? 'border-[#b0b4a5]' : 'border-[#e0e0e0]'}`}>{num}</div>
                <div>
                  <div className="text-[1rem] font-medium mb-1">{title}</div>
                  <div className="text-[0.875rem] text-[#666] leading-relaxed">{desc}</div>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Security */}
        <section id="security" className="py-16 border-t font-[family-name:var(--font-raleway)]" style={{ borderColor: isDark ? '#333' : isMinimal ? '#b0b4a5' : '#e0e0e0' }}>
          <div className="text-[0.75rem] uppercase tracking-[0.15em] text-[#666] mb-3">Security</div>
          <h2 className="text-[clamp(1.5rem,4vw,2.25rem)] font-normal tracking-[-0.02em] mb-4">Your files, your privacy</h2>
          <p className="text-[1rem] text-[#666] leading-relaxed max-w-[650px] mb-10">
            Files under 10MB are encrypted client-side with AES-256-GCM; larger files are protected in transit over HTTPS. Metadata lives in Firebase Firestore behind strict access rules. This is encryption in transit and at rest — not end-to-end: we hold the keys to run features like the AI assistant, so we are able to decrypt content when needed. Expired files are deleted from our storage and database; provider-side backups may persist briefly as part of normal operations.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
            {[
              ['Encrypted at Rest', 'AES-256-GCM encryption on stored files under 10MB. Larger files ride HTTPS only. Personal drops use individual keys; workspace drops use a shared key.', 'M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z'],
              ['Firebase Auth', 'Google and email/password authentication via Firebase. Sensitive server actions additionally verify your token.', 'M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z'],
              ['Auto-Deletion', 'Expired drops are removed from storage and database. Provider-side backups may persist briefly as part of normal operations.', 'M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16'],
              ['Workspace Keys', 'Workspace drops are encrypted with a key shared among members. Leaving or being removed revokes your copy of the key.', 'M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z'],
              ['Access Control', 'Any workspace member can add, edit, and move drops. Only the owner can delete the workspace, remove members, and rotate the invite code. Shared links are read-only.', 'M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21'],
              ['Large File Handling', 'Files under 10MB are encrypted client-side. Larger files skip encryption for performance but remain secure via HTTPS in transit.', 'M13 10V3L4 14h7v7l9-11h-7z'],
            ].map(([title, desc, path]) => (
              <div key={title} className={`p-8 border rounded-lg transition-colors ${isDark ? 'bg-[#1a1a1a] border-[#333] hover:border-[#555]' : isMinimal ? 'bg-[#C5C9B8] border-[#b0b4a5] hover:border-[#1a1a1a]' : 'bg-[#FDFCF9] border-[#e0e0e0] hover:border-[#999]'}`}>
                <div className={`w-12 h-12 rounded-lg border flex items-center justify-center mb-5 ${isDark ? 'bg-white/5 border-[#333]' : isMinimal ? 'bg-white/30 border-[#b0b4a5]' : 'bg-white/70 border-[#e0e0e0]'}`}>
                  <svg viewBox="0 0 24 24" fill="none" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="w-[22px] h-[22px]" style={{ stroke: isDark ? '#ffffff' : '#1a1a1a' }}>
                    <path d={path} />
                  </svg>
                </div>
                <div className="text-[1rem] font-medium mb-2">{title}</div>
                <div className="text-[0.875rem] text-[#666] leading-relaxed">{desc}</div>
              </div>
            ))}
          </div>
        </section>

        {/* FAQ */}
        <section className="py-16 border-t font-[family-name:var(--font-raleway)]" style={{ borderColor: isDark ? '#333' : isMinimal ? '#b0b4a5' : '#e0e0e0' }}>
          <div className="text-[0.75rem] uppercase tracking-[0.15em] text-[#666] mb-3">FAQ</div>
          <h2 className="text-[clamp(1.5rem,4vw,2.25rem)] font-normal tracking-[-0.02em] mb-10">Common questions</h2>
          <div className="flex flex-col">
            {[
              ['Do I need an account to download shared files?', 'No. Anyone with the link can view and download files. Accounts are only needed to upload and manage drops.'],
              ['What file types are supported?', 'Any file type. Images, PDFs, documents, videos, archives — if it\'s under 500MB, you can drop it.'],
              ['What happens when a drop expires?', 'The files are deleted from Cloudflare R2 storage and the metadata is removed from the database. The share link stops working. Provider-side backups may persist briefly as part of normal operations.'],
              ['Can I extend the expiry time after uploading?', 'Not currently. Once a drop is created, its expiry is fixed. Delete it and re-upload with a new timer if needed.'],
              ['Is there a limit to how many drops I can create?', 'No, there is no limit on the number of drops you can create.'],
              ['How does voice-to-text work?', 'Click the microphone button, speak, and your audio is transcribed using Groq\'s Whisper AI. The text appears as a regular text drop you can edit before saving.'],
              ['What are shared workspaces?', 'Workspaces let multiple users collaborate on the same drops. Create one, invite team members with a 6-character code, and everyone sees the same drops in real time.'],
              ['Can I move drops between workspaces?', 'Yes. You can move drops between your personal space and any workspace you\'re a member of, or between workspaces. The drop is automatically re-encrypted with the new workspace key.'],
              ['Who can manage a workspace?', 'The workspace owner can delete the workspace and copy the invite code. Members can leave. All members can add and manage drops.'],
              ['How do I invite someone to my workspace?', 'Click the workspace selector, find your workspace, and click the link icon to copy the 6-character invite code. Share it with anyone — they can join from the login screen.'],
              ['Can my team chat inside a workspace?', 'Yes. Every workspace has real-time group chat. Messages are encrypted with the workspace key, and you can @mention teammates, reply to messages, edit your own, and see read receipts and typing indicators.'],
              ['Will I be notified about new messages?', 'Yes. You get push notifications on desktop and mobile (Android and desktop browsers), even when DropSync is closed. @mentions reach you across workspaces.'],
              ['Can I delete my account?', 'Yes. Account deletion removes your drops, profile, keys, and chat history from our database. Workspace drops you created remain available to other members.'],
            ].map(([q, a], i) => (
              <div key={i} style={{ borderBottom: isDark ? '#333' : isMinimal ? '#b0b4a5' : '#e0e0e0' }}>
                <button onClick={() => toggleFaq(i)} className="w-full flex items-center justify-between py-6 text-left text-[1rem] font-medium hover:text-[#1a1a1a] transition-colors">
                  <span>{q}</span>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={`w-6 h-6 flex-shrink-0 text-[#666] transition-transform duration-300 ${openFaqs[i] ? 'rotate-45' : ''}`}>
                    <path d="M12 6v12m6-6H6" />
                  </svg>
                </button>
                <div className={`overflow-hidden transition-all duration-300 ${openFaqs[i] ? 'max-h-[200px] pb-6' : 'max-h-0'}`}>
                  <p className="text-[0.875rem] text-[#666] leading-relaxed">{a}</p>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* CTA */}
        <section className="py-16 text-center font-[family-name:var(--font-raleway)]">
          <h2 className="text-[clamp(1.5rem,4vw,2.25rem)] font-normal tracking-[-0.02em] mb-4">Ready to drop?</h2>
          <p className="text-[1rem] text-[#666] mb-8">Start sharing and collaborating in seconds. Sign in with Google or email — no download, no install.</p>
          <Link href="/" className="inline-flex items-center gap-2 px-8 py-3.5 rounded-full text-sm font-medium transition-all duration-300 hover:-translate-y-0.5 hover:shadow-lg" style={{ background: isDark ? '#ffffff' : '#1a1a1a', color: isDark ? '#0D0D0D' : '#ffffff', border: `1px solid ${isDark ? '#ffffff' : '#1a1a1a'}` }}>
            Get Started
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 12h14M12 5l7 7-7 7" /></svg>
          </Link>
        </section>
      </main>

      <footer className={`relative z-10 flex justify-between items-center px-8 py-6 text-[0.75rem] tracking-[0.05em] text-[#666] border-t font-[family-name:var(--font-raleway)] ${isDark ? 'border-[#333]' : isMinimal ? 'border-[#b0b4a5]' : 'border-[#e0e0e0]'}`}>
        <div className="flex items-center gap-4">
          <Link href="/" className="text-[#666] hover:text-[#1a1a1a] transition-colors">Home</Link>
          <Link href="/docs" className="text-[#666] hover:text-[#1a1a1a] transition-colors">Docs</Link>
          <Link href="/terms" className="text-[#666] hover:text-[#1a1a1a] transition-colors">Terms</Link>
          <Link href="/privacy" className="text-[#666] hover:text-[#1a1a1a] transition-colors">Privacy</Link>
        </div>
        <span>© 2026 DropSync</span>
        <span className="hidden sm:inline">Max 500MB · Unlimited drops</span>
      </footer>
    </div>
  );
}