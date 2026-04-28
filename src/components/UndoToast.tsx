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
}

export function UndoToast({ message, dropName, onUndo, onDismiss, duration = 30, theme = 'light', index = 0, editorial = false }: UndoToastProps) {
  const [timeLeft, setTimeLeft] = useState(duration);
  const [progress, setProgress] = useState(100);
  const dismissedRef = useRef(false);
  const isDark = theme === 'dark';
  const isMinimal = theme === 'minimal';

  useEffect(() => {
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
  }, []);

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