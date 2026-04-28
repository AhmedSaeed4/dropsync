'use client';

import { getEditorialThemeColors } from './editorialTheme';

interface EditorialThemeSelectorProps {
  theme: 'light' | 'dark' | 'minimal';
  onThemeChange: (theme: 'light' | 'dark' | 'minimal') => void;
  showChat?: boolean;
}

const OPTIONS: { value: 'light' | 'dark' | 'minimal'; label: string; icon: string }[] = [
  { value: 'light', label: 'Light', icon: '☼' },
  { value: 'dark', label: 'Dark', icon: '☾' },
  { value: 'minimal', label: 'Minimal', icon: '○' },
];

export function EditorialThemeSelector({ theme, onThemeChange, showChat = false }: EditorialThemeSelectorProps) {
  const tc = getEditorialThemeColors(theme);

  return (
    <div className={`border ${tc.border} rounded-lg transition-all duration-[350ms] ease-[cubic-bezier(0.4,0,0.2,1)] ${showChat ? 'p-1' : 'p-1.5'}`}>
      <div className={`grid grid-cols-3 transition-all duration-[350ms] ease-[cubic-bezier(0.4,0,0.2,1)] ${showChat ? 'gap-1' : 'gap-1.5'}`}>
        {OPTIONS.map((opt) => (
          <button
            key={opt.value}
            onClick={() => onThemeChange(opt.value)}
            className={`flex items-center justify-center gap-2 ${tc.fontClass} rounded-md transition-all duration-200 ${
              theme === opt.value
                ? `${tc.activePillBg} ${tc.activePillText} border ${tc.border}`
                : `border ${tc.border} ${tc.text} hover:border-[#1a1a1a]`
            } ${showChat ? 'px-2.5 py-2 text-xs' : 'px-4 py-2.5 text-[13px]'}`}
          >
            <span className={`transition-all duration-[350ms] ease-[cubic-bezier(0.4,0,0.2,1)] ${showChat ? 'text-sm' : 'text-base'}`}>{opt.icon}</span>
            <span>{opt.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
