type Theme = 'light' | 'dark' | 'minimal';

export interface EditorialThemeColors {
  bg: string;
  text: string;
  muted: string;
  border: string;
  btnBg: string;
  btnText: string;
  btnBorder: string;
  btnHoverBg: string;
  btnHoverText: string;
  activePillBg: string;
  activePillText: string;
  inactivePillBg: string;
  inactivePillText: string;
  inactivePillHoverBg: string;
  cardBg: string;
  hoverBorder: string;
  hoverShadow: string;
  dragBg: string;
  dragText: string;
  dragBorder: string;
  dragMuted: string;
  fontClass: string;
  roundedClass: string;
}

export function getEditorialThemeColors(theme: Theme): EditorialThemeColors {
  if (theme === 'dark') {
    return {
      bg: 'bg-[#0D0D0D]',
      text: 'text-white',
      muted: 'text-[#888]',
      border: 'border-[#333]',
      btnBg: 'bg-transparent',
      btnText: 'text-white',
      btnBorder: 'border-[#333]',
      btnHoverBg: 'hover:bg-white',
      btnHoverText: 'hover:text-[#0D0D0D]',
      activePillBg: 'bg-white',
      activePillText: 'text-[#0D0D0D]',
      inactivePillBg: 'bg-transparent',
      inactivePillText: 'text-white/60',
      inactivePillHoverBg: 'hover:bg-white/10',
      cardBg: 'bg-[#1a1a1a]',
      hoverBorder: 'hover:border-[#555]',
      hoverShadow: 'hover:shadow-lg hover:shadow-white/5',
      dragBg: 'bg-[#1a1a1a]',
      dragText: 'text-white',
      dragBorder: 'border-white',
      dragMuted: 'text-white/60',
      fontClass: 'font-[family-name:var(--font-raleway)]',
      roundedClass: 'rounded-lg',
    };
  }

  if (theme === 'minimal') {
    return {
      bg: 'bg-[#C5C9B8]',
      text: 'text-[#1a1a1a]',
      muted: 'text-[#4a4a4a]',
      border: 'border-[#b0b4a5]',
      btnBg: 'bg-transparent',
      btnText: 'text-[#1a1a1a]',
      btnBorder: 'border-[#1a1a1a]',
      btnHoverBg: 'hover:bg-[#1a1a1a]',
      btnHoverText: 'hover:text-white',
      activePillBg: 'bg-[#1a1a1a]',
      activePillText: 'text-white',
      inactivePillBg: 'bg-transparent',
      inactivePillText: 'text-[#4a4a4a]',
      inactivePillHoverBg: 'hover:bg-[#1a1a1a]/10',
      cardBg: 'bg-[#C5C9B8]',
      hoverBorder: 'hover:border-[#1a1a1a]',
      hoverShadow: 'hover:shadow-lg hover:shadow-[#1a1a1a]/10',
      dragBg: 'bg-[#1a1a1a]',
      dragText: 'text-white',
      dragBorder: 'border-[#1a1a1a]',
      dragMuted: 'text-[#C5C9B8]/70',
      fontClass: 'font-[family-name:var(--font-raleway)]',
      roundedClass: 'rounded-lg',
    };
  }

  // Light theme (default)
  return {
    bg: 'bg-[#FFFEF5]',
    text: 'text-[#1a1a1a]',
    muted: 'text-[#666]',
    border: 'border-[#e0e0e0]',
    btnBg: 'bg-transparent',
    btnText: 'text-[#1a1a1a]',
    btnBorder: 'border-[#1a1a1a]',
    btnHoverBg: 'hover:bg-[#1a1a1a]',
    btnHoverText: 'hover:text-white',
    activePillBg: 'bg-[#1a1a1a]',
    activePillText: 'text-white',
    inactivePillBg: 'bg-transparent',
    inactivePillText: 'text-[#666]',
    inactivePillHoverBg: 'hover:bg-[#1a1a1a]/10',
    cardBg: 'bg-white',
    hoverBorder: 'hover:border-[#999]',
    hoverShadow: 'hover:shadow-lg hover:shadow-[#1a1a1a]/5',
    dragBg: 'bg-[#1a1a1a]',
    dragText: 'text-white',
    dragBorder: 'border-[#1a1a1a]',
    dragMuted: 'text-white/60',
    fontClass: 'font-[family-name:var(--font-raleway)]',
    roundedClass: 'rounded-lg',
  };
}
