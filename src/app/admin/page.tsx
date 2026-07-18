import type { Metadata } from "next";
import Link from "next/link";
import { AdminClient } from "./AdminClient";

export const metadata: Metadata = {
  title: "Admin — DropSync",
  description: "Owner-only access management for DropSync.",
};

/**
 * Owner-only admin shell. Standalone editorial page mirroring /privacy: a parse-time PREPAINT
 * script reads `dropsync_theme` from localStorage and paints this page's editorial CSS vars on
 * document.body.style BEFORE first paint (NO cookie, NO flash), then hands off to the client
 * component for the interactive UI. The Firestore rules are the real enforcement; the
 * client-side owner check in AdminClient is UX only.
 */
// COOKIE-FREE theme pre-paint — mirrors /privacy + /docs. Same collapse rule the cookie read
// used: dark → dark, everything else (light/minimal/missing) → light. Tokens byte-identical to
// the old server-side buildThemeStyle output.
const PREPAINT = `(function(){try{var t=localStorage.getItem('dropsync_theme');var bg,text,muted,heading,border,link;if(t==='dark'){bg='#0D0D0D';text='#ffffff';muted='#888';heading='#ffffff';border='#333';link='#ffffff';}else{bg='#FFFEF5';text='#1a1a1a';muted='#666';heading='#1a1a1a';border='#e0e0e0';link='#1a1a1a';}var r=document.body.style;r.setProperty('--bg',bg);r.setProperty('--text',text);r.setProperty('--muted',muted);r.setProperty('--heading',heading);r.setProperty('--border',border);r.setProperty('--link',link);r.background=bg;r.color=text;}catch(e){}})();`;

export default function AdminPage() {
  // Cookie-free: the server can't read localStorage, so SSR + first paint rely on PREPAINT
  // (above) for the shell theme. AdminClient reads `dropsync_theme` itself on mount so its
  // editorial (tc.*) theming follows the app theme too — see AdminClient.tsx.
  return (
    <main className="min-h-screen bg-[var(--bg)] text-[var(--text)] antialiased">
      <script dangerouslySetInnerHTML={{ __html: PREPAINT }} />
      <article className="mx-auto max-w-2xl rounded-lg px-6 py-16 sm:py-20">
        <header className="mb-10">
          <Link href="/" className="inline-flex items-center gap-2 text-[var(--link)]">
            <span className="text-xl leading-none" aria-hidden>
              ◆
            </span>
            <span className="text-base font-semibold tracking-tight font-[family-name:var(--font-raleway)]">
              DropSync
            </span>
          </Link>
          <h1 className="mt-8 text-3xl font-bold tracking-tight text-[var(--heading)] font-[family-name:var(--font-raleway)]">
            Admin
          </h1>
          <p className="mt-2 text-sm text-[var(--muted)]">
            Owner-only access management.
          </p>
        </header>

        <AdminClient initialTheme="light" />

        <footer className="mt-16 border-t border-[var(--border)] pt-8">
          <p className="text-sm text-[var(--muted)]">
            © {new Date().getFullYear()} DropSync.
          </p>
          <p className="mt-2">
            <Link
              href="/"
              className="text-sm text-[var(--link)] underline hover:opacity-70 transition-opacity"
            >
              ← Back to DropSync
            </Link>
          </p>
        </footer>
      </article>
    </main>
  );
}
