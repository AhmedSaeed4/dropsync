'use client';

import { useEffect, useState, useRef } from 'react';
import { createPortal } from 'react-dom';

interface UndoToastProps {
  message: string;
  dropName?: string;
  onUndo: () => void;
  onDismiss: () => void;
  duration?: number; // in seconds
  theme?: 'light' | 'dark' | 'minimal';
  index?: number; // For stacking multiple toasts
  editorial?: boolean;
  // epoch ms of the real delete deadline (store-owned). When provided, the countdown is derived from
  // (expiresAt - now) so it survives remounts (a layout switch mounts a fresh toast reading the SAME
  // deadline) and stays synced to the authoritative store timer instead of restarting at 30.
  expiresAt?: number;
}

export function UndoToast({ message, dropName, onUndo, onDismiss, duration = 30, theme = 'light', index = 0, editorial = false, expiresAt }: UndoToastProps) {
  // Countdown: when the store provides the real delete deadline (expiresAt), derive the remaining
  // seconds from it on mount — self-correcting across remounts (a layout switch mounts a fresh toast
  // that reads the SAME deadline) and resilient to tab-throttling. Fall back to the duration-based
  // initial value when no deadline is supplied (keeps the component self-contained).
  const [timeLeft, setTimeLeft] = useState(() =>
    expiresAt !== undefined ? Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000)) : duration
  );
  const [progress, setProgress] = useState(100);
  const dismissedRef = useRef(false);
  const isDark = theme === 'dark';
  const isMinimal = theme === 'minimal';

  useEffect(() => {
    // expiresAt path: recompute the remaining time from the real deadline each tick (NOT a
    // decrement) so the display can never drift from the store's timer — correct on any remount and
    // resilient to background-tab throttling. Legacy path (no deadline): decrement once per second.
    if (expiresAt !== undefined) {
      const interval = setInterval(() => {
        setTimeLeft(Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000)));
      }, 1000);
      return () => clearInterval(interval);
    }
    const interval = setInterval(() => {
      setTimeLeft((prev) => {
        if (prev <= 1) {
          clearInterval(interval);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(interval);
  }, [expiresAt, duration]);

  // Handle auto-dismiss when time runs out
  useEffect(() => {
    if (timeLeft === 0 && !dismissedRef.current) {
      dismissedRef.current = true;
      onDismiss();
    }
  }, [timeLeft, onDismiss]);

  useEffect(() => {
    setProgress((timeLeft / duration) * 100);
  }, [timeLeft, duration]);

  const themeStyles = editorial
    ? {
        bg: theme === 'dark' ? 'bg-[#1a1a1a] border border-[#333]' : theme === 'minimal' ? 'bg-[#1a1a1a] border border-[#b0b4a5] text-white' : 'bg-white border border-[#e0e0e0]',
        text: theme === 'dark' ? 'text-white' : theme === 'minimal' ? 'text-[#C5C9B8]' : 'text-[#1a1a1a]',
        textMuted: theme === 'dark' ? 'text-white/60' : theme === 'minimal' ? 'text-[#C5C9B8]/60' : 'text-[#1a1a1a]/50',
        undo: theme === 'dark' ? 'text-white hover:text-white/80' : theme === 'minimal' ? 'text-[#C5C9B8] hover:text-white' : 'text-[#1a1a1a] hover:text-[#1a1a1a]/70',
        progress: theme === 'dark' ? 'bg-white' : theme === 'minimal' ? 'bg-[#C5C9B8]' : 'bg-[#1a1a1a]',
        rounded: 'rounded-lg',
        font: 'font-[family-name:var(--font-raleway)]',
        fontSize: 'text-[13px]',
        undoFont: 'text-[12px] font-medium',
      }
    : isMinimal
    ? {
        bg: 'bg-[#1A1A1A]',
        text: 'text-white',
        textMuted: 'text-white/60',
        undo: 'text-[#C5C9B8] hover:text-white',
        progress: 'bg-[#C5C9B8]',
        rounded: 'rounded-full',
        font: '',
        fontSize: 'text-sm font-medium',
        undoFont: 'text-sm font-medium',
      }
    : isDark
    ? {
        bg: 'bg-[#2A2A2A]',
        text: 'text-white',
        textMuted: 'text-white/60',
        undo: 'text-[#FF5A47] hover:text-white',
        progress: 'bg-[#FF5A47]',
        rounded: '',
        font: '',
        fontSize: 'text-xs font-mono uppercase',
        undoFont: 'text-xs font-mono uppercase',
      }
    : {
        bg: 'bg-[#1A1A1A]',
        text: 'text-white',
        textMuted: 'text-white/60',
        undo: 'text-[#FF5A47] hover:text-white',
        progress: 'bg-[#FF5A47]',
        rounded: '',
        font: '',
        fontSize: 'text-xs font-mono uppercase',
        undoFont: 'text-xs font-mono uppercase',
      };

  // Stack toasts: first one at bottom, subsequent ones above
  const bottomOffset = 24 + (index * 64); // 64px per toast

  const handleUndoClick = () => {
    if (!dismissedRef.current) {
      dismissedRef.current = true;
      onUndo();
    }
  };

  return createPortal(
    <div
      className={`toast-container ${themeStyles.bg} ${themeStyles.text} shadow-lg ${themeStyles.rounded} overflow-hidden animate-slide-up`}
      style={{
        position: 'fixed',
        left: '50%',
        transform: 'translateX(-50%)',
        bottom: `${bottomOffset}px`,
        width: 'calc(100% - 32px)',
        maxWidth: '320px',
        zIndex: 9999
      }}
    >
      <div className="flex items-center gap-3 px-4 py-3">
        <span className={`${themeStyles.fontSize} ${themeStyles.font} ${themeStyles.text} truncate flex-1`}>
          {dropName ? `${message}: ${dropName}` : message}
        </span>
        <span className={`${themeStyles.textMuted} ${isMinimal && !editorial ? 'text-xs' : editorial ? 'text-[11px]' : 'text-[10px] font-mono'} flex-shrink-0`}>
          {timeLeft}s
        </span>
        <button
          onClick={handleUndoClick}
          className={`${themeStyles.undo} ${themeStyles.undoFont} transition-colors flex-shrink-0`}
        >
          Undo
        </button>
      </div>
      {/* Progress bar */}
      <div className="h-0.5 bg-white/10">
        <div
          className={`h-full ${themeStyles.progress} transition-all duration-1000 ease-linear`}
          style={{ width: `${progress}%` }}
        />
      </div>
    </div>,
    document.body
  );
}