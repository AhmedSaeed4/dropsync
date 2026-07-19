'use client';

import { useState, useEffect, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { DocsSidebar } from './DocsSidebar';
import { getLenis } from '@/components/SmoothScrollProvider';
import { docsSections, HEADER_OFFSET } from './sections';

type Theme = 'light' | 'dark' | 'minimal';
type LayoutMode = 'classic' | 'editorial';

const THEME_STORAGE_KEY = 'dropsync_theme';
const LAYOUT_STORAGE_KEY = 'dropsync_layout';

/**
 * Client wrapper for `/docs`. Branches the classic vs editorial layout from localStorage, mirrors
 * the `/privacy` + `/terms` two-layout pattern (PR #178). The prose (`DocsContent`) is passed in as
 * server children from `page.tsx` and rendered UNCHANGED in BOTH layouts (the user chose the "light
 * classic touch": keep the editorial body, restyle only the chrome + bg + TOC skin).
 *
 * No-flash / no-mismatch: a `useSyncExternalStore` mount gate returns `null` on SSR AND on the
 * hydration render (so server null == first client null -> NO hydration mismatch), then renders the
 * layout-driven tree behind an opacity gate on the next client render. The PREPAINT in `page.tsx`
 * already holds the correct body bg + editorial CSS vars during the null phase -> NO cold-load flash.
 */
export function DocsClient({ children }: { children: ReactNode }) {
  // Read theme + layout synchronously from localStorage to avoid flash + hydration mismatch.
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

  const [theme] = useState<Theme>(getStoredTheme);
  const [layoutMode] = useState<LayoutMode>(getStoredLayout);
  const [pageVisible, setPageVisible] = useState(false);

  // Keep body bg in sync with the chosen theme + layout. Mirrors the PREPAINT in page.tsx — KEEP IN
  // SYNC. classic+minimal collapses to classic-light #FAF7F2 (sage is editorial-only). Dark text is
  // the editorial cream #FAF7F2 (matches the PREPAINT `text` token), not pure white.
  useEffect(() => {
    const _isDark = theme === 'dark';
    const _isClassic = layoutMode === 'classic';
    const _isMinimal = theme === 'minimal';
    const bgColor = _isDark ? '#0D0D0D' : _isClassic ? '#FAF7F2' : _isMinimal ? '#C5C9B8' : '#FFFEF5';
    document.body.style.background = bgColor;
    document.body.style.color = _isDark ? '#FAF7F2' : '#1a1a1a';
    return () => {
      document.body.style.background = '';
      document.body.style.color = '';
    };
  }, [theme, layoutMode]);

  // Client-only gate via useSyncExternalStore — identical effect to dynamic({ ssr: false }) (which a
  // Server Component cannot use in Next 16). Returns false during SSR AND the hydration render, so
  // the server-rendered null matches the first client render (null) -> NO hydration mismatch; then
  // true on the next client render so the tree mounts behind the opacity gate. The PREPAINT in
  // page.tsx already holds the correct body bg during the null phase -> NO flash. (React-blessed
  // client-detection hook, used instead of setState-in-effect.)
  const isClient = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );

  // Opacity gate — pageVisible flips ~10ms after mount so the tree fades in. setState is in the
  // timer callback (not synchronous in the effect body), satisfying react-hooks/set-state-in-effect.
  useEffect(() => {
    const timer = setTimeout(() => setPageVisible(true), 10);
    return () => clearTimeout(timer);
  }, []);

  // One-shot hash-scroll: once mounted, if the URL has a #anchor matching a docs section, jump to
  // it. The mount gate delays the `<h2>/<h3>` ids entering the DOM, so the browser's native load-time
  // hash-scroll would find nothing; this carries `/docs#security` (etc.) deep-links through the
  // null -> mount transition. Routes through Lenis to stay in sync (a raw jump would desync Lenis);
  // falls back to native scrollIntoView when Lenis is null (reduced-motion). Runs once when isClient
  // flips false -> true.
  useEffect(() => {
    if (!isClient) return;
    const hash = window.location.hash.slice(1);
    if (!hash) return;
    const valid = docsSections.some(
      (s) => s.anchor === hash || s.subsections.some((sub) => sub.anchor === hash),
    );
    if (!valid) return;
    const el = document.getElementById(hash);
    if (!el) return;
    const lenis = getLenis();
    if (lenis) lenis.scrollTo(el, { offset: -HEADER_OFFSET });
    else el.scrollIntoView({ block: 'start' });
    // One-shot: intentionally dep-only on isClient (flips false->true once after mount).
    // docsSections/HEADER_OFFSET are stable module exports; getLenis is a stable module function,
    // so exhaustive-deps does not require them in the array.
  }, [isClient]);

  if (!isClient) return null;

  const isDark = theme === 'dark';
  const isClassic = layoutMode === 'classic';

  // ========================
  // CLASSIC LAYOUT (restyled chrome: sticky header / title / TOC skin / footer + bg; prose unchanged)
  // ========================
  if (isClassic) {
    const classicBg = isDark ? '#0D0D0D' : '#FAF7F2';
    const classicText = isDark ? '#ffffff' : '#1a1a1a';
    const classicBorder = isDark ? 'rgba(255,255,255,0.1)' : '#1a1a1a';
    const accentColor = '#FF5A47';
    const muted = isDark ? 'rgba(255,255,255,0.6)' : 'rgba(26,26,26,0.6)';
    const faint = isDark ? 'rgba(255,255,255,0.4)' : 'rgba(26,26,26,0.4)';

    return (
      <div
        className={`min-h-screen relative transition-opacity duration-500 ease-out ${pageVisible ? 'opacity-100' : 'opacity-0'}`}
        style={{
          background: classicBg,
          color: classicText,
          transition: 'background-color 0.5s, color 0.5s, opacity 500ms ease-out',
        }}
      >
        {/* Sticky header — classic chrome (mirrors the editorial header STRUCTURE, restyled). ~52px
            tall (py-4 + ~20px row) ≪ HEADER_OFFSET 96, so the sticky TOC `top-24` + `scroll-mt-24`
            budget still clears it. */}
        <header
          className="sticky top-0 z-50 border-b"
          style={{ borderColor: classicBorder, background: classicBg }}
        >
          <div className="mx-auto flex max-w-[1000px] items-center justify-between px-4 py-4 sm:px-8 lg:px-0">
            <Link href="/" className="flex items-center gap-2">
              <div className="h-3 w-3" style={{ background: accentColor }} />
              <span className="font-mono text-sm uppercase tracking-widest">DROP/SYNC</span>
            </Link>
            <div className="flex items-center gap-4 sm:gap-6">
              {/* Mobile TOC slot — classic-skinned dropdown */}
              <DocsSidebar layout="classic" variant="mobile" />
              <Link
                href="/"
                className="font-mono text-xs uppercase tracking-widest"
                style={{ color: muted }}
              >
                ← Back to DropSync
              </Link>
            </div>
          </div>
        </header>

        <div className="mx-auto max-w-[1000px] px-4 sm:px-8 lg:px-0">
          {/* Title block */}
          <div className="py-12 lg:py-16">
            <p className="font-mono text-xs uppercase tracking-widest" style={{ color: faint }}>
              User guide
            </p>
            <h1 className="mt-3 font-mono text-[clamp(2rem,5vw,3rem)] uppercase tracking-widest">
              Documentation
            </h1>
            <p className="mt-4 max-w-[560px] text-sm leading-7" style={{ color: muted }}>
              Everything you need to use DropSync — drops, sharing, workspaces, chat, notifications,
              the AI assistant, security, and settings.
            </p>
          </div>

          {/* 220px classic sidebar + 1fr content. {children} = DocsContent prose (unchanged). */}
          <div className="lg:grid lg:grid-cols-[220px_1fr] lg:gap-12">
            <DocsSidebar layout="classic" />
            {children}
          </div>
        </div>

        {/* Footer — classic chrome */}
        <footer
          className="mt-16 border-t pt-8"
          style={{ borderTopColor: classicBorder, borderTopWidth: '1px', borderTopStyle: 'solid' }}
        >
          <div className="mx-auto max-w-[1000px] px-4 pb-8 sm:px-8 lg:px-0">
            <Link
              href="/"
              className="font-mono text-xs uppercase tracking-widest underline"
              style={{ color: muted }}
            >
              ← Back to DropSync
            </Link>
            <p className="mt-3 font-mono text-xs uppercase tracking-widest" style={{ color: faint }}>
              © {new Date().getFullYear()} DropSync.
            </p>
          </div>
        </footer>
      </div>
    );
  }

  // ========================
  // EDITORIAL LAYOUT — byte-identical to the previous /docs shell (only the PREPAINT <script>
  // stayed in page.tsx and the opacity gate was added to <main>). Consumes {children} (DocsContent,
  // a server component passed through) + the DocsSidebar.
  // ========================
  return (
    <main className={`min-h-screen bg-[var(--bg)] font-[family-name:var(--font-raleway)] text-[var(--text)] antialiased transition-opacity duration-500 ease-out ${pageVisible ? 'opacity-100' : 'opacity-0'}`}>
      <header className="sticky top-0 z-50 border-b border-[var(--border)] bg-[var(--bg)] transition-colors duration-500">
        <div className="mx-auto flex max-w-[1000px] items-center justify-between px-4 py-4 sm:px-8 lg:px-0">
          <Link href="/" className="flex items-center gap-2 text-[var(--text)]">
            <span className="text-base leading-none" aria-hidden>
              ◆
            </span>
            <span className="text-[22px] font-medium tracking-[-0.3px]">DropSync</span>
          </Link>
          <div className="flex items-center gap-4 sm:gap-6">
            {/* Mobile TOC slot — the client sidebar renders the `Contents ▾` dropdown here. */}
            <DocsSidebar variant="mobile" />
            <Link
              href="/"
              className="text-sm text-[var(--muted)] transition-colors hover:text-[var(--text)]"
            >
              ← Back to DropSync
            </Link>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-[1000px] px-4 sm:px-8 lg:px-0">
        <div className="py-12 lg:py-16">
          <p className="text-[0.75rem] uppercase tracking-[0.15em] text-[var(--muted)]">User guide</p>
          <h1 className="mt-3 text-[clamp(2rem,5vw,3rem)] font-normal tracking-[-0.02em] text-[var(--text)]">
            Documentation
          </h1>
          <p className="mt-4 max-w-[560px] text-[15px] leading-7 text-[var(--muted)]">
            Everything you need to use DropSync — drops, sharing, workspaces, chat, notifications,
            the AI assistant, security, and settings.
          </p>
        </div>

        {/* 220px sidebar + 1fr content (= ~732px) inside the 1000px container with gap-12 (48px).
            No horizontal overflow between 1024–1279px: the container is max-w-[1000px] and the
            viewport is ≥1024 > 1000, so it always fits. */}
        <div className="lg:grid lg:grid-cols-[220px_1fr] lg:gap-12">
          <DocsSidebar />
          {children}
        </div>
      </div>

      <footer className="mt-16 border-t border-[var(--border)]">
        <div className="mx-auto max-w-[1000px] px-4 py-8 sm:px-8 lg:px-0">
          <Link
            href="/"
            className="text-sm text-[var(--muted)] transition-colors hover:text-[var(--text)]"
          >
            ← Back to DropSync
          </Link>
        </div>
      </footer>
    </main>
  );
}
