'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

interface ToastProps {
  message: string;
  duration?: number;
  theme?: 'light' | 'dark' | 'minimal';
  editorial?: boolean;
  onDone: () => void;
}

export function Toast({ message, duration = 3, theme = 'light', editorial = false, onDone }: ToastProps) {
  const [visible, setVisible] = useState(true);
  // Latest-callback ref: callers (chat panels, DropList) pass an inline onDone that is a NEW
  // function identity on every render. Keeping onDone OUT of the effect deps below means the
  // dismiss timer is armed exactly once on mount and is NOT reset on every parent re-render —
  // otherwise a frequently-re-rendering parent (live listeners, typing/presence ticks, keystrokes)
  // would keep clearing the timer and the toast would never dismiss.
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  useEffect(() => {
    const timer = setTimeout(() => {
      setVisible(false);
      onDoneRef.current?.();
    }, duration * 1000);
    return () => clearTimeout(timer);
  }, [duration]);

  if (!visible) return null;

  const isDark = theme === 'dark';
  const isMinimal = theme === 'minimal';

  const styles = editorial
    ? {
        bg: isDark ? 'bg-[#1a1a1a] border border-[#333]' : isMinimal ? 'bg-[#1a1a1a] border border-[#b0b4a5] text-white' : 'bg-white border border-[#e0e0e0]',
        text: isDark ? 'text-white' : isMinimal ? 'text-[#C5C9B8]' : 'text-[#1a1a1a]',
        rounded: 'rounded-lg',
        font: 'text-[13px] font-[family-name:var(--font-raleway)]',
      }
    : isMinimal
    ? {
        bg: 'bg-[#1A1A1A]',
        text: 'text-white',
        rounded: 'rounded-full',
        font: 'text-sm font-medium',
      }
    : isDark
    ? {
        bg: 'bg-[#2A2A2A]',
        text: 'text-white',
        rounded: '',
        font: 'text-xs font-mono uppercase',
      }
    : {
        bg: 'bg-[#1A1A1A]',
        text: 'text-white',
        rounded: '',
        font: 'text-xs font-mono uppercase',
      };

  return createPortal(
    <div
      className={`${styles.bg} ${styles.text} shadow-lg ${styles.rounded} animate-slide-up`}
      style={{
        position: 'fixed',
        left: '50%',
        transform: 'translateX(-50%)',
        bottom: '24px',
        zIndex: 9999,
      }}
    >
      <div className={`px-4 py-3 text-center ${styles.font}`}>
        {message}
      </div>
    </div>,
    document.body
  );
}
