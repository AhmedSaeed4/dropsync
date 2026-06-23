import type { CSSProperties } from 'react';

/**
 * Share-page theme helpers.
 *
 * The public share page is a standalone route (no app ThemeProvider), but it must still
 * respect the app's theme system. The app stores its theme in localStorage under
 * `dropsync_theme` (`light` | `dark` | `minimal`, default `light`) — see
 * src/app/page.tsx and src/app/about/page.tsx. We read the SAME key here so a logged-in
 * owner sees their chosen theme on their own share link, and an anonymous recipient gets
 * the safe `light` default.
 *
 * Raw hex values below mirror src/components/editorial/editorialTheme.ts 1:1 (and therefore
 * also the standalone mockups, whose CSS vars are documented to "mirror editorialTheme").
 * Keep this in sync if editorialTheme changes.
 */

export type ShareTheme = 'light' | 'dark' | 'minimal';

/** Which stage design is showing — the content-side palette is design-aware (see below). */
export type ShareDesign = 'flowfield' | 'wave';

/** localStorage key shared with the rest of the app. */
export const SHARE_THEME_KEY = 'dropsync_theme';

export interface SharePalette {
  paper: string;
  paper2: string;
  card: string;
  ink: string;
  muted: string;
  faint: string;
  hair: string;
  hair2: string;
}

export const SHARE_PALETTES: Record<ShareTheme, SharePalette> = {
  // light — matches editorialTheme light (#FFFEF5 / #1a1a1a) + mockup :root vars
  light: {
    paper: '#FFFEF5',
    paper2: '#FBF9EE',
    card: '#FDFCF9',
    ink: '#1a1a1a',
    muted: '#666',
    faint: '#999',
    hair: '#e0e0e0',
    hair2: '#ececec',
  },
  // dark — matches editorialTheme dark (#0D0D0D / #ffffff) + mockup [data-theme=dark] vars
  dark: {
    paper: '#0D0D0D',
    paper2: '#141414',
    card: '#1a1a1a',
    ink: '#ffffff',
    muted: '#9a9a9a',
    faint: '#666',
    hair: '#2a2a2a',
    hair2: '#222222',
  },
  // minimal — matches editorialTheme minimal (#C5C9B8 / #1a1a1a). Unlikely on a public
  // share link, but supported so an owner with this theme set still sees correct colors.
  minimal: {
    paper: '#C5C9B8',
    paper2: '#BFC4AE',
    card: '#C5C9B8',
    ink: '#1a1a1a',
    muted: '#4a4a4a',
    faint: '#6a6a5c',
    hair: '#b0b4a5',
    hair2: '#c0c4b3',
  },
};

/**
 * Wave design + dark theme gets a BLUE-TINTED dark content side (navy-black bg, blue-gray
 * text) so it matches the always-dark blue wave stage. Matches the share-preview-2-stacked
 * dark vars. Every other theme×design combo uses the neutral palette above (flow-field dark
 * stays neutral; all light modes stay cream).
 */
export const WAVE_DARK_PALETTE: SharePalette = {
  paper: '#06070E',
  paper2: '#0A0C18',
  card: '#0E0E15',
  ink: '#ffffff',
  muted: '#9aa7c7',
  faint: '#64708e',
  hair: 'rgba(255,255,255,0.10)',
  hair2: 'rgba(255,255,255,0.06)',
};

/** Navy→black fade applied to the content side on wave+dark. */
export const WAVE_DARK_GRADIENT = 'linear-gradient(90deg, #06070E 35%, #000000 100%)';

export function getSharePalette(theme: ShareTheme, design?: ShareDesign | null): SharePalette {
  if (design === 'wave' && theme === 'dark') return WAVE_DARK_PALETTE;
  return SHARE_PALETTES[theme] ?? SHARE_PALETTES.light;
}

/**
 * CSS variables applied to the share wrapper. Children reference them as
 * `var(--ds-paper)`, `var(--ds-ink)`, etc. — so the whole pane re-tints by changing one
 * style object on the wrapper, matching the mockup's var-driven theming.
 */
export function shareCssVars(theme: ShareTheme, design?: ShareDesign | null): CSSProperties {
  const p = getSharePalette(theme, design);
  return {
    ['--ds-paper']: p.paper,
    ['--ds-paper-2']: p.paper2,
    ['--ds-card']: p.card,
    ['--ds-ink']: p.ink,
    ['--ds-muted']: p.muted,
    ['--ds-faint']: p.faint,
    ['--ds-hair']: p.hair,
    ['--ds-hair-2']: p.hair2,
  } as CSSProperties;
}
