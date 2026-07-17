import type { Metadata } from 'next';
import Link from 'next/link';
import { DocsContent } from './DocsContent';
import { DocsSidebar } from './DocsSidebar';

export const metadata: Metadata = {
  title: 'Docs — DropSync',
  description:
    'How DropSync works — drops, sharing & pickup, workspaces, group chat, notifications, the AI assistant, security, and settings.',
};

/**
 * `/docs` — a standalone editorial-minimal user-guide page with a sticky sidebar TOC.
 *
 * SERVER component (no `'use client'`). The only interactive island is `DocsSidebar` (the TOC);
 * `DocsContent` is static prose. There is NO `#app-shell` / magnetic footer here — this page has
 * its own standalone shell (own `<header>`/`<footer>`), so the overlay/footer stacking rules that
 * govern the main app do not apply.
 *
 * No cold-load flash: a parse-time inline `<script>` reads `dropsync_theme` from localStorage and
 * sets the `:root` CSS custom properties (`--bg/--text/--muted/--border`) + `document.body` bg/color
 * BEFORE first paint — mirroring `src/app/about/page.tsx`'s PREPAINT_BG, but setting the full var
 * set that this page consumes via Tailwind `var()` classes. The palette below is pulled VERBATIM
 * from `src/components/editorial/editorialTheme.ts` (dark / light / minimal-sage); default = light.
 *
 * Entry path: the footer's Docs link opens `/docs` with `target=_blank` (a full page load), so the
 * PREPAINT script always runs before paint. (An in-app SPA navigation would not re-run an inline
 * script; that path is currently unreachable, and is the reason we rely on full-load entry.)
 */
const PREPAINT = `(function(){try{var t=localStorage.getItem('dropsync_theme');var bg,text,muted,border;if(t==='dark'){bg='#0D0D0D';text='#FAF7F2';muted='#888';border='#333';}else if(t==='minimal'){bg='#C5C9B8';text='#1a1a1a';muted='#4a4a4a';border='#b0b4a5';}else{bg='#FFFEF5';text='#1a1a1a';muted='#666';border='#e0e0e0';}var r=document.body.style;r.setProperty('--bg',bg);r.setProperty('--text',text);r.setProperty('--muted',muted);r.setProperty('--border',border);r.background=bg;r.color=text;}catch(e){}})();`;

export default function DocsPage() {
  return (
    <>
      <script dangerouslySetInnerHTML={{ __html: PREPAINT }} />
      <main className="min-h-screen bg-[var(--bg)] font-[family-name:var(--font-raleway)] text-[var(--text)] antialiased">
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
            <DocsContent />
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
    </>
  );
}
