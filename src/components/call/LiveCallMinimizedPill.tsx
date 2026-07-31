'use client';

// LiveCallMinimizedPill — desktop-only floating pill shown when a call is active AND minimized AND
// the viewport is hoverable (desktop). Pulsing LIVE dot + the workspace name + "tap to reopen".
// fixed bottom-4 right-4 z-40. onClick → onRestore (the page retracts the footer + un-minimizes).
// Mobile never sees it (mobile can't join, and on mobile leaving the call screen ends the call).

import { getCallTheme, type CallTheme, type CallVariant } from './callTheme';

interface LiveCallMinimizedPillProps {
  workspaceName: string;
  theme: CallTheme;
  variant: CallVariant;
  onRestore: () => void;
}

export function LiveCallMinimizedPill({ workspaceName, theme, variant, onRestore }: LiveCallMinimizedPillProps) {
  const tc = getCallTheme(variant, theme);
  return (
    <button
      type="button"
      onClick={onRestore}
      className={`fixed bottom-4 right-4 z-40 flex items-center gap-2 px-4 py-2.5 ${tc.rounded} ${tc.cardBg} ${tc.border} border shadow-lg ${tc.text} ${tc.fontClass} text-sm hover:opacity-90 transition-opacity`}
      title="Reopen call"
    >
      <span className="w-2 h-2 bg-red-500 rounded-full animate-pulse" />
      <span className="max-w-[160px] truncate">{workspaceName || 'Live call'}</span>
      <span className={`${tc.muted} opacity-70`}>tap to reopen</span>
    </button>
  );
}
