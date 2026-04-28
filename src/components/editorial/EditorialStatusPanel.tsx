'use client';

import { getEditorialThemeColors } from './editorialTheme';

interface EditorialStatusPanelProps {
  dropsCount: number;
  encryptionInitializing: boolean;
  theme: 'light' | 'dark' | 'minimal';
  showChat?: boolean;
}

export function EditorialStatusPanel({ dropsCount, encryptionInitializing, theme, showChat = false }: EditorialStatusPanelProps) {
  const tc = getEditorialThemeColors(theme);

  return (
    <div className={`flex items-center gap-2 ${tc.fontClass} ${tc.muted} transition-all duration-[350ms] ease-[cubic-bezier(0.4,0,0.2,1)] ${showChat ? 'text-xs' : 'text-sm'}`}>
      <span className="flex items-center gap-1.5">
        <span className={`rounded-full ${encryptionInitializing ? 'bg-yellow-400' : 'bg-green-500'} transition-all duration-[350ms] ease-[cubic-bezier(0.4,0,0.2,1)] ${showChat ? 'w-1 h-1' : 'w-1.5 h-1.5'}`} />
        <span className={tc.text}>{encryptionInitializing ? 'Setting up...' : 'Online'}</span>
      </span>
      <span className={tc.muted}>&middot;</span>
      <span>
        {dropsCount}/200 drops
      </span>
    </div>
  );
}
