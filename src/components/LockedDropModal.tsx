'use client';

import { useBodyScrollLock } from '@/hooks/useBodyScrollLock';
import { useModalBackClose } from '@/hooks/useModalBackClose';
import { getEditorialThemeColors } from './editorial/editorialTheme';

export type LockedActionContext = 'edit' | 'move' | 'delete';

// One clean voice across every locked-drop surface. Shared with LockedActionButton's tooltip so
// the hover hint and the tap popup say exactly the same thing. No "tier"/"trusted" wording.
export const LOCKED_ACTION_MESSAGES: Record<LockedActionContext, string> = {
  edit: 'This drop is locked — only its creator can edit it.',
  move: 'This drop is locked — only its creator can move it.',
  delete: 'This drop is locked — only its creator can delete it.',
};

interface LockedDropModalProps {
  /** Host layout so the popup matches its surroundings. */
  variant: 'classic' | 'editorial';
  /** Host app theme. */
  theme: 'light' | 'dark' | 'minimal';
  /** Which gated action triggered the popup — picks the message. Defaults to 'edit'. */
  context?: LockedActionContext;
  onClose: () => void;
}

/**
 * Small informational popup shown when a non-creator taps a faded Edit/Move/Delete action on a
 * locked drop (touch devices — desktops get a hover tooltip instead). Reuses the codebase's modal
 * pattern (body scroll lock, browser-back close, click-outside, close button) and renders in the
 * host layout's style via `variant` + `theme`. Rendered at z-[60] so it overlays host modals
 * (e.g. PreviewModal, which is z-50).
 */
export function LockedDropModal({ variant, theme, context = 'edit', onClose }: LockedDropModalProps) {
  useBodyScrollLock();
  useModalBackClose(true, onClose);

  const body = LOCKED_ACTION_MESSAGES[context];

  if (variant === 'editorial') {
    const tc = getEditorialThemeColors(theme);
    return (
      <div
        className="fixed inset-0 bg-[#1a1a1a]/60 z-[60] flex items-center justify-center p-4 transition-colors duration-300"
        onClick={(e) => e.target === e.currentTarget && onClose()}
      >
        <div className={`${tc.bg} border ${tc.border} rounded-xl shadow-xl w-full max-w-sm transition-colors duration-300`}>
          <div className={`border-b ${tc.border} px-5 py-4 flex items-center justify-between`}>
            <h2 className={`${tc.fontClass} ${tc.text} font-medium text-[15px]`}>Locked</h2>
            <button
              onClick={onClose}
              className={`${tc.muted} hover:${tc.text} transition-colors p-1`}
              aria-label="Close"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
          <div className="px-5 py-5">
            <p className={`text-sm ${tc.fontClass} ${tc.text} leading-relaxed`}>{body}</p>
            <button
              onClick={onClose}
              className={`mt-5 w-full ${tc.activePillBg} ${tc.activePillText} ${tc.fontClass} py-2.5 text-sm rounded-lg hover:opacity-90 transition-opacity`}
            >
              Got it
            </button>
          </div>
        </div>
      </div>
    );
  }

  // classic
  const isDark = theme === 'dark';
  const isMinimal = theme === 'minimal';
  const overlayBg = isMinimal ? 'bg-black/30 backdrop-blur-sm' : 'bg-black/70 backdrop-blur-sm';
  const bgColor = isMinimal ? 'bg-[#D4D8C8]' : isDark ? 'bg-[#1A1A1A]' : 'bg-[#FAF7F2]';
  const borderColor = isMinimal ? 'border-[#1A1A1A]/20' : isDark ? 'border-white/10' : 'border-[#1A1A1A]';
  const textColor = isMinimal ? 'text-[#1A1A1A]' : isDark ? 'text-white' : 'text-[#1A1A1A]';
  const fontClass = isMinimal ? 'font-sans tracking-wide text-xs' : 'font-mono uppercase tracking-wider text-[10px]';
  const roundedClass = isMinimal ? 'rounded-lg' : '';

  return (
    <div
      className={`fixed inset-0 ${overlayBg} z-[60] flex items-center justify-center p-4 transition-colors duration-300 overscroll-contain`}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className={`${bgColor} border ${borderColor} ${roundedClass} w-full max-w-sm transition-colors duration-300`}>
        <div className={`border-b ${borderColor} px-6 py-4 flex items-center justify-between bg-[#FF5A47]`}>
          <h2 className="text-sm font-bold uppercase tracking-wider text-white">Locked</h2>
          <button
            onClick={onClose}
            className="text-white/70 hover:text-white transition-colors"
            aria-label="Close"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="p-6">
          <p className={`${fontClass} ${textColor} leading-relaxed`}>{body}</p>
          <button
            onClick={onClose}
            className={`mt-5 w-full bg-[#1A1A1A] text-white py-3 text-xs tracking-wider hover:bg-[#2A2A2A] transition-colors ${isMinimal ? 'rounded-full' : ''}`}
          >
            {isMinimal ? 'Got it' : 'GOT_IT'}
          </button>
        </div>
      </div>
    </div>
  );
}
