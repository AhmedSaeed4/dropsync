'use client';

import { useState, useEffect, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { sections, LAST_UPDATED } from './sections';

type Theme = 'light' | 'dark' | 'minimal';
type LayoutMode = 'classic' | 'editorial';

const THEME_STORAGE_KEY = 'dropsync_theme';
const LAYOUT_STORAGE_KEY = 'dropsync_layout';

export default function PrivacyClient() {
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

  // Keep body bg in sync with the chosen theme + layout (minimal collapses to light — no sage on
  // this page). Mirrors AboutClient's body-bg useEffect; KEEP IN SYNC with the PREPAINT in page.tsx.
  useEffect(() => {
    const _isDark = theme === 'dark';
    const _isClassic = layoutMode === 'classic';
    const bgColor = _isDark ? '#0D0D0D' : _isClassic ? '#FAF7F2' : '#FFFEF5';
    document.body.style.background = bgColor;
    document.body.style.color = _isDark ? '#ffffff' : '#1a1a1a';
    return () => {
      document.body.style.background = '';
      document.body.style.color = '';
    };
  }, [theme, layoutMode]);

  // Client-only gate via useSyncExternalStore — identical effect to dynamic({ ssr: false }) (which a
  // Server Component cannot use in Next 16). Returns false during SSR AND the hydration render, so the
  // server-rendered null matches the first client render (null) -> NO hydration mismatch; then true on
  // the next client render so the tree mounts behind the opacity gate. The PREPAINT in page.tsx already
  // holds the correct body bg during the null phase -> NO flash. (React-blessed client-detection hook,
  // used instead of setState-in-effect.)
  const isClient = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );

  // Opacity gate — pageVisible flips ~10ms after mount so the tree fades in. setState is in the timer
  // callback (not synchronous in the effect body), satisfying react-hooks/set-state-in-effect.
  useEffect(() => {
    const timer = setTimeout(() => setPageVisible(true), 10);
    return () => clearTimeout(timer);
  }, []);

  if (!isClient) return null;

  const isDark = theme === 'dark';
  const isClassic = layoutMode === 'classic';

  // ========================
  // CLASSIC LAYOUT (minimal chrome — logo link + article + back-link, no nav/toggle)
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
        className={`min-h-screen relative overflow-hidden transition-opacity duration-500 ease-out ${pageVisible ? 'opacity-100' : 'opacity-0'}`}
        style={{
          background: classicBg,
          color: classicText,
          transition: 'background-color 0.5s, color 0.5s, opacity 500ms ease-out',
        }}
      >
        <main className="relative z-10 mx-auto max-w-[800px] px-8 py-16">
          {/* Logo link */}
          <Link href="/" className="mb-12 flex items-center gap-2">
            <div className="h-3 w-3" style={{ background: accentColor }} />
            <span className="font-mono text-sm uppercase tracking-widest">DROP/SYNC</span>
          </Link>

          {/* Title */}
          <h1 className="mb-4 font-mono text-[clamp(2rem,5vw,3rem)] uppercase tracking-widest">
            Privacy Policy
          </h1>
          <p
            className="mb-12 font-mono text-xs uppercase tracking-widest"
            style={{ color: faint }}
          >
            Last updated: {LAST_UPDATED}
          </p>

          {/* Intro (sentence-case body; mailto link) */}
          <p className="mb-12 text-sm leading-7" style={{ color: muted }}>
            This Privacy Policy explains what DropSync collects, why, how it is protected, and the
            choices you have. DropSync is operated by Ahmed, based in Pakistan, who is the data
            controller responsible for your personal data under the EU/UK GDPR and other applicable
            privacy laws. For any privacy question, request, or complaint, contact us at{' '}
            <a
              href="mailto:ahmedsaeed20026@gmail.com"
              className="underline"
              style={{ color: accentColor }}
            >
              ahmedsaeed20026@gmail.com
            </a>
            .
          </p>

          {/* Sections — titles uppercased via the class; body prose stays sentence-case */}
          {sections.map((section) => (
            <section key={section.id} className="mb-10">
              <h2 className="mb-4 font-mono text-sm uppercase tracking-wider">{section.title}</h2>
              {section.paragraphs?.map((para, i) => (
                <p key={i} className="mb-4 text-sm leading-7" style={{ color: muted }}>
                  {para}
                </p>
              ))}
              {section.items && (
                <ul className="space-y-3">
                  {section.items.map((item, i) => (
                    <li key={i} className="text-sm leading-7" style={{ color: muted }}>
                      {item.label && (
                        <span className="font-semibold" style={{ color: classicText }}>
                          {item.label}{' '}
                        </span>
                      )}
                      {item.text}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ))}

          {/* 12. Contact — standalone (mailto link), rendered in BOTH layouts (invariant #6) */}
          <section className="mb-10">
            <h2 className="mb-4 font-mono text-sm uppercase tracking-wider">12. Contact</h2>
            <p className="text-sm leading-7" style={{ color: muted }}>
              For privacy questions, requests, or complaints, contact us at{' '}
              <a
                href="mailto:ahmedsaeed20026@gmail.com"
                className="underline"
                style={{ color: accentColor }}
              >
                ahmedsaeed20026@gmail.com
              </a>
              . We aim to respond within a reasonable time and within any period required by law.
            </p>
          </section>

          {/* Footer — back-link + copyright, minimal chrome */}
          <footer
            className="mt-16 flex flex-col gap-2 pt-8"
            style={{ borderTop: `1px solid ${classicBorder}` }}
          >
            <p className="font-mono text-xs uppercase tracking-widest" style={{ color: faint }}>
              © {new Date().getFullYear()} DropSync. This page is provided for informational purposes.
            </p>
            <Link
              href="/"
              className="font-mono text-xs uppercase tracking-widest underline"
              style={{ color: muted }}
            >
              ← Back to DropSync
            </Link>
          </footer>
        </main>
      </div>
    );
  }

  // ========================
  // EDITORIAL LAYOUT — byte-identical to the previous /privacy page (only the PREPAINT <script>
  // moved to page.tsx and the opacity gate was added to <main>). Consumes the shared sections.ts.
  // ========================
  return (
    <main className={`min-h-screen bg-[var(--bg)] text-[var(--text)] antialiased transition-opacity duration-500 ease-out ${pageVisible ? 'opacity-100' : 'opacity-0'}`}>
      <article className="mx-auto max-w-2xl rounded-lg px-6 py-16 sm:py-20">
        {/* Header / logo */}
        <header className="mb-10">
          <Link
            href="/"
            className="inline-flex items-center gap-2 text-[var(--link)]"
          >
            <span className="text-xl leading-none" aria-hidden>
              ◆
            </span>
            <span className="text-base font-semibold tracking-tight font-[family-name:var(--font-raleway)]">DropSync</span>
          </Link>
          <h1 className="mt-8 text-3xl font-bold tracking-tight text-[var(--heading)] font-[family-name:var(--font-raleway)]">
            Privacy Policy
          </h1>
          <p className="mt-2 text-sm text-[var(--muted)]">
            Last updated: {LAST_UPDATED}
          </p>
        </header>

        {/* Intro */}
        <p className="text-[15px] leading-7 text-[var(--text)]">
          This Privacy Policy explains what DropSync collects, why, how it is protected,
          and the choices you have. DropSync is operated by Ahmed, based in Pakistan, who
          is the data controller responsible for your personal data under the EU/UK GDPR
          and other applicable privacy laws. For any privacy question, request, or
          complaint, contact us at{" "}
          <a
            href="mailto:ahmedsaeed20026@gmail.com"
            className="text-[var(--link)] underline hover:opacity-70 transition-opacity"
          >
            ahmedsaeed20026@gmail.com
          </a>
          .
        </p>

        {/* Sections */}
        {sections.map((section) => (
          <section key={section.id} className="mt-12">
            <h2 className="text-xl font-semibold tracking-tight text-[var(--heading)] font-[family-name:var(--font-raleway)]">
              {section.title}
            </h2>

            {section.paragraphs?.map((para, i) => (
              <p key={i} className="mt-4 text-[15px] leading-7 text-[var(--text)]">
                {para}
              </p>
            ))}

            {section.items && (
              <ul className="mt-4 space-y-3">
                {section.items.map((item, i) => (
                  <li
                    key={i}
                    className="text-[15px] leading-7 text-[var(--text)]"
                  >
                    {item.label && (
                      <span className="font-semibold text-[var(--heading)]">
                        {item.label}{" "}
                      </span>
                    )}
                    {item.text}
                  </li>
                ))}
              </ul>
            )}
          </section>
        ))}

        {/* 12. Contact — explicit so the email renders as a clickable mailto link */}
        <section className="mt-12">
          <h2 className="text-xl font-semibold tracking-tight text-[var(--heading)] font-[family-name:var(--font-raleway)]">
            12. Contact
          </h2>
          <p className="mt-4 text-[15px] leading-7 text-[var(--text)]">
            For privacy questions, requests, or complaints, contact us at{" "}
            <a
              href="mailto:ahmedsaeed20026@gmail.com"
              className="text-[var(--link)] underline hover:opacity-70 transition-opacity"
            >
              ahmedsaeed20026@gmail.com
            </a>
            . We aim to respond within a reasonable time and within any period required
            by law.
          </p>
        </section>

        {/* Footer */}
        <footer className="mt-16 border-t border-[var(--border)] pt-8">
          <p className="text-sm text-[var(--muted)]">
            © {new Date().getFullYear()} DropSync. This page is provided for
            informational purposes.
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
