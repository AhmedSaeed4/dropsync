'use client';

import type { ReactNode } from 'react';
import { getEditorialThemeColors } from '../editorialTheme';

type Theme = 'light' | 'dark' | 'minimal';
type MobileTab = 'drops' | 'create' | 'search';

interface MobileNavbarProps {
  activeTab: MobileTab;
  onTabChange: (tab: MobileTab) => void;
  theme: Theme;
}

// z-30 keeps the bar UNDER the z-40 chat overlay, mirroring the desktop non-wide treatment
// where the full-screen chat covers the entire app (EditorialLayout.tsx:479-501).
const TAB_ICONS: Record<MobileTab, ReactNode> = {
  drops: (
    <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <rect x="3.5" y="3.5" width="7.5" height="7.5" rx="2" />
      <rect x="13" y="3.5" width="7.5" height="7.5" rx="2" />
      <rect x="3.5" y="13" width="7.5" height="7.5" rx="2" />
      <rect x="13" y="13" width="7.5" height="7.5" rx="2" />
    </svg>
  ),
  create: (
    <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round">
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 8.5v7M8.5 12h7" />
    </svg>
  ),
  search: (
    <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round">
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  ),
};

const TABS: { id: MobileTab; label: string }[] = [
  { id: 'drops', label: 'Drops' },
  { id: 'create', label: 'Create' },
  { id: 'search', label: 'Search' },
];

// Floating bottom pill navbar (prototype's .navbar rebuilt with theme tokens, no hardcoded hexes).
export function MobileNavbar({ activeTab, onTabChange, theme }: MobileNavbarProps) {
  const tc = getEditorialThemeColors(theme);

  return (
    <nav
      aria-label="Sections"
      className="pointer-events-none fixed inset-x-0 bottom-0 z-30 flex justify-center pb-[env(safe-area-inset-bottom)]"
    >
      <div className={`pointer-events-auto mb-[14px] flex items-center gap-[2px] rounded-full border p-[6px] ${tc.cardBg} ${tc.border}`}>
        {TABS.map(({ id, label }) => {
          const active = activeTab === id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => onTabChange(id)}
              aria-label={label}
              aria-current={active ? 'true' : undefined}
              className={`flex min-w-[64px] flex-col items-center gap-[2px] rounded-full px-[17px] py-[7px] transition-colors ${
                active ? `${tc.activePillBg} ${tc.activePillText}` : tc.inactivePillText
              }`}
            >
              {TAB_ICONS[id]}
              <span className={`text-[10px] font-semibold tracking-[0.04em] ${tc.fontClass}`}>{label}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
