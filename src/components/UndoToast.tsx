'use client';

import { useEffect, useState, useRef } from 'react';

interface UndoToastProps {
  message: string;
  dropName?: string;
  onUndo: () => void;
  onDismiss: () => void;
  duration?: number; // in seconds
  theme?: 'light' | 'dark' | 'minimal';
  index?: number; // For stacking multiple toasts
}

export function UndoToast({ message, dropName, onUndo, onDismiss, duration = 30, theme = 'light', index = 0 }: UndoToastProps) {
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

  const themeStyles = isMinimal
    ? {
        bg: 'bg-[#1A1A1A]',
        text: 'text-white',
        textMuted: 'text-white/60',
        undo: 'text-[#C5C9B8] hover:text-white',
        progress: 'bg-[#C5C9B8]',
        rounded: 'rounded-full',
      }
    : isDark
    ? {
        bg: 'bg-[#2A2A2A]',
        text: 'text-white',
        textMuted: 'text-white/60',
        undo: 'text-[#FF5A47] hover:text-white',
        progress: 'bg-[#FF5A47]',
        rounded: '',
      }
    : {
        bg: 'bg-[#1A1A1A]',
        text: 'text-white',
        textMuted: 'text-white/60',
        undo: 'text-[#FF5A47] hover:text-white',
        progress: 'bg-[#FF5A47]',
        rounded: '',
      };

  // Stack toasts: first one at bottom, subsequent ones above
  const bottomOffset = 24 + (index * 64); // 64px per toast

  const handleUndoClick = () => {
    if (!dismissedRef.current) {
      dismissedRef.current = true;
      onUndo();
    }
  };

  return (
    <div
      className={`fixed left-1/2 -translate-x-1/2 z-50 ${themeStyles.bg} ${themeStyles.text} shadow-lg ${themeStyles.rounded} overflow-hidden animate-slide-up w-80`}
      style={{ bottom: `${bottomOffset}px` }}
    >
      <div className="flex items-center gap-3 px-4 py-3">
        <span className={`${isMinimal ? 'text-sm font-medium' : 'text-xs font-mono uppercase'} truncate flex-1`}>
          {dropName ? `${message}: ${dropName}` : message}
        </span>
        <span className={`${themeStyles.textMuted} ${isMinimal ? 'text-xs' : 'text-[10px] font-mono'} flex-shrink-0`}>
          {timeLeft}s
        </span>
        <button
          onClick={handleUndoClick}
          className={`${themeStyles.undo} ${isMinimal ? 'text-sm font-medium' : 'text-xs font-mono uppercase'} transition-colors flex-shrink-0`}
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
    </div>
  );
}