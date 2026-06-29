import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { AdminClient } from "./AdminClient";

export const metadata: Metadata = {
  title: "Admin — DropSync",
  description: "Owner-only access management for DropSync.",
};

/**
 * Owner-only admin shell. Standalone editorial page mirroring /privacy: reads the share-theme
 * cookie, injects the SYNC_THEME script + an editorial palette <style>, and hands off to the
 * client component for the interactive UI. The Firestore rules are the real enforcement; the
 * client-side owner check in AdminClient is UX only.
 */
function buildThemeStyle(theme: 'light' | 'dark'): string {
  const p = theme === 'dark'
    ? { bg: '#0D0D0D', text: '#ffffff', muted: '#888', heading: '#ffffff', border: '#333', link: '#ffffff' }
    : { bg: '#FFFEF5', text: '#1a1a1a', muted: '#666', heading: '#1a1a1a', border: '#e0e0e0', link: '#1a1a1a' };
  return `:root{--bg:${p.bg};--text:${p.text};--muted:${p.muted};--heading:${p.heading};--border:${p.border};--link:${p.link};}`;
}

// Verbatim from src/app/privacy/page.tsx (and src/app/s/[shareId]/page.tsx). Copies the app's
// dropsync_theme localStorage value into the share-theme cookie during HTML parse so /admin
// matches the app theme on the next load.
const SYNC_THEME = `(function(){try{var t=localStorage.getItem('dropsync_theme');if(t==='dark'||t==='light'){document.cookie='share-theme='+t+';path=/;max-age=31536000;SameSite=Lax';}}catch(e){}})();`;

export default async function AdminPage() {
  const c = await cookies();
  const initialTheme: 'light' | 'dark' =
    c.get('share-theme')?.value === 'dark' ? 'dark' : 'light';
  const themeStyle = buildThemeStyle(initialTheme);

  return (
    <main className="min-h-screen bg-[var(--bg)] text-[var(--text)] antialiased">
      <script dangerouslySetInnerHTML={{ __html: SYNC_THEME }} />
      <style dangerouslySetInnerHTML={{ __html: themeStyle }} />
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

        <AdminClient initialTheme={initialTheme} />

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
