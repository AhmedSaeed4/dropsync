// Shared theme resolver for the live-call components. Each call component is dual-layout
// (`variant`: 'classic' | 'editorial' + `theme`: 'light' | 'dark' | 'minimal') — this returns ONE
// unified token set so the components don't each re-derive classic vs editorial tokens. Classic
// replicates the inline getThemeColors() contract used by PreviewModal/DropZone; editorial defers to
// the shared getEditorialThemeColors.

import { getEditorialThemeColors } from '../editorial/editorialTheme';

export type CallTheme = 'light' | 'dark' | 'minimal';
export type CallVariant = 'classic' | 'editorial';

export interface CallTokens {
  bg: string;
  cardBg: string;
  border: string;
  hoverBorder: string;
  text: string;
  muted: string;
  overlayBg: string;
  activePillBg: string;
  activePillText: string;
  inactivePillBg: string;
  rounded: string;
  fontClass: string;
}

export function getCallTheme(variant: CallVariant, theme: CallTheme): CallTokens {
  if (variant === 'editorial') {
    const tc = getEditorialThemeColors(theme);
    return {
      bg: tc.bg,
      cardBg: tc.cardBg,
      border: tc.border,
      hoverBorder: tc.hoverBorder,
      text: tc.text,
      muted: tc.muted,
      overlayBg: 'bg-[#1a1a1a]/60',
      activePillBg: tc.activePillBg,
      activePillText: tc.activePillText,
      inactivePillBg: tc.inactivePillBg,
      rounded: tc.roundedClass,
      fontClass: tc.fontClass,
    };
  }
  // classic — mirrors PreviewModal/DropZone's inline getThemeColors contract
  const isDark = theme === 'dark';
  if (theme === 'minimal') {
    return {
      bg: 'bg-[#D4D8C8]',
      cardBg: 'bg-[#D4D8C8]',
      border: 'border-[#1A1A1A]/20',
      text: 'text-[#1A1A1A]',
      muted: 'text-[#1A1A1A]/50',
      overlayBg: 'bg-[#1A1A1A]/70',
      activePillBg: 'bg-[#1A1A1A]',
      activePillText: 'text-white',
      inactivePillBg: 'bg-[#1A1A1A]/10',
      hoverBorder: 'hover:opacity-90',
      rounded: 'rounded-lg',
      fontClass: 'font-sans',
    };
  }
  return {
    bg: isDark ? 'bg-[#1A1A1A]' : 'bg-[#FAF7F2]',
    cardBg: isDark ? 'bg-[#1A1A1A]' : 'bg-[#FAF7F2]',
    border: isDark ? 'border-white/10' : 'border-[#1A1A1A]',
    text: isDark ? 'text-white' : 'text-[#1A1A1A]',
    muted: isDark ? 'text-white/50' : 'text-[#1A1A1A]/50',
    overlayBg: 'bg-[#1A1A1A]/90',
    activePillBg: 'bg-[#1A1A1A]',
    activePillText: 'text-white',
    inactivePillBg: 'bg-[#1A1A1A]/10',
    hoverBorder: 'hover:opacity-90',
    rounded: '',
    fontClass: 'font-mono uppercase',
  };
}
