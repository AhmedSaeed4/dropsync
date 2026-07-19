import type { Metadata } from 'next';
import { DocsClient } from './DocsClient';
import { DocsContent } from './DocsContent';

export const metadata: Metadata = {
  title: 'Docs — DropSync',
  description:
    'How DropSync works — drops, sharing & pickup, workspaces, group chat, notifications, the AI assistant, security, and settings.',
};

/**
 * `/docs` — a standalone user-guide page with a sticky sidebar TOC, served in TWO layouts
 * (classic + editorial), mirroring the `/privacy` + `/terms` two-layout pattern (PR #178).
 *
 * SERVER component (no `'use client'`). Keeps the route `metadata` + the parse-time PREPAINT, then
 * mounts `DocsClient` (client), which branches the classic vs editorial layout from localStorage.
 * `DocsContent` (the prose) is passed as SERVER CHILDREN — it stays a server component (no client
 * JS; the prose rides in the RSC payload and is attached to the DOM only after the client gate
 * opens, identical no-SSR/no-mismatch/no-flash effect to `dynamic(..., { ssr: false })`, which a
 * Server Component cannot use in Next 16 — see `DocsClient`). `DocsSidebar` (the TOC) lives inside
 * `DocsClient` so it mounts together with the content behind the same gate (scroll-spy binds after
 * the `<h2>/<h3>` ids are in the DOM).
 *
 * There is NO `#app-shell` / magnetic footer here — this page has its own standalone shell, so the
 * overlay/footer stacking rules that govern the main app do not apply.
 *
 * No cold-load flash: the PREPAINT below reads `dropsync_theme` AND `dropsync_layout` from
 * localStorage during HTML parse (BEFORE first paint) and paints the correct background + the 4
 * editorial CSS vars (`--bg/--text/--muted/--border`) on `document.body.style` (NEVER
 * `documentElement` — layout.tsx `suppressHydrationWarning` is on `<body>`). The sage branch is
 * gated on `layout!=='classic'` so classic+minimal collapses to classic-light `#FAF7F2` (sage is
 * editorial-only here, matching `/docs`'s keep-editorial-body intent). Default = light.
 *
 * Entry path: the footer's Docs link opens `/docs` with `target=_blank` (a full page load), so the
 * PREPAINT script always runs before paint. (An in-app SPA navigation would not re-run an inline
 * script; that path is currently unreachable, and is the reason we rely on full-load entry.)
 */
const PREPAINT = `(function(){try{var t=localStorage.getItem('dropsync_theme');var l=localStorage.getItem('dropsync_layout');var bg,text,muted,border;if(t==='dark'){bg='#0D0D0D';text='#FAF7F2';muted='#888';border='#333';}else if(t==='minimal'&&l!=='classic'){bg='#C5C9B8';text='#1a1a1a';muted='#4a4a4a';border='#b0b4a5';}else if(l==='classic'){bg='#FAF7F2';text='#1a1a1a';muted='#666';border='#e0e0e0';}else{bg='#FFFEF5';text='#1a1a1a';muted='#666';border='#e0e0e0';}var r=document.body.style;r.setProperty('--bg',bg);r.setProperty('--text',text);r.setProperty('--muted',muted);r.setProperty('--border',border);r.background=bg;r.color=text;}catch(e){}})();`;

export default function DocsPage() {
  return (
    <>
      <script dangerouslySetInnerHTML={{ __html: PREPAINT }} />
      <DocsClient>
        <DocsContent />
      </DocsClient>
    </>
  );
}
