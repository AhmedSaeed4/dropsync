'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { getEditorialThemeColors } from './editorial/editorialTheme';

interface DropContextMenuProps {
  x: number;
  y: number;
  isPinned: boolean;
  onPin: () => void;
  onUnpin: () => void;
  onClose: () => void;
  theme?: 'light' | 'dark' | 'minimal';
  editorial?: boolean;
  // When the drop is locked and the current user can't mutate it, the rules block pin/unpin —
  // hide the option rather than show an action that fails silently.
  locked?: boolean;
  canMutate?: boolean;
  // Call drops can't be pinned (they're always-top; the rules block it). Defense-in-depth: a call
  // drop's context menu is normally unreachable (DropItem early-returns the LiveCallDropTile), but
  // suppress Pin here too so a call doc reaching this menu never shows a dead Pin action.
  isCall?: boolean;
}

export function DropContextMenu({ x, y, isPinned, onPin, onUnpin, onClose, theme = 'light', editorial, locked = false, canMutate = false, isCall = false }: DropContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  // Pin/unpin is a mutation the Firestore rules reject for a non-creator on a locked drop, and call
  // drops can't be pinned at all (always-top; rules block it).
  const pinBlocked = (locked && !canMutate) || isCall;
  const [adjustedPos, setAdjustedPos] = useState({ x, y });

  // Adjust position so menu doesn't overflow viewport
  useEffect(() => {
    if (!menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    const newX = x + rect.width > window.innerWidth ? x - rect.width : x;
    const newY = y + rect.height > window.innerHeight ? y - rect.height : y;
    setAdjustedPos({
      x: Math.max(8, newX),
      y: Math.max(8, newY),
    });
  }, [x, y]);

  // Close on Escape or click outside
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const handlePin = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (isPinned) {
      onUnpin();
    } else {
      onPin();
    }
    onClose();
  };

  const stopAndClose = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    onClose();
  };

  const stopEvent = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
  };

  const isDark = theme === 'dark';
  const isMinimal = theme === 'minimal';

  if (editorial) {
    const tc = getEditorialThemeColors(theme);
    return (
      <>
        <div className="fixed inset-0 z-[200]" onClick={stopAndClose} onContextMenu={stopAndClose} />
        <div
          ref={menuRef}
          className={`fixed z-[201] ${tc.cardBg} border ${tc.border} ${tc.roundedClass} shadow-lg py-1 min-w-[140px]`}
          onClick={stopEvent}
          onContextMenu={stopEvent}
          style={{ left: `${adjustedPos.x}px`, top: `${adjustedPos.y}px` }}
        >
          {!pinBlocked && (
            <button
              onClick={handlePin}
              className={`w-full px-3 py-2 text-left text-xs ${tc.fontClass} ${tc.text} hover:bg-[#1a1a1a]/5 transition-colors flex items-center gap-2`}
            >
              <svg className="w-3.5 h-3.5" fill={isPinned ? 'currentColor' : 'none'} stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
                <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5m-10.5 0h10.5m-10.5 0l.75-10.5h9l.75 10.5" />
              </svg>
              {isPinned ? 'Unpin drop' : 'Pin drop'}
            </button>
          )}
        </div>
      </>
    );
  }

  return (
    <>
      <div className="fixed inset-0 z-[200]" onClick={stopAndClose} onContextMenu={stopAndClose} />
      <div
        ref={menuRef}
        className={`fixed z-[201] border shadow-lg py-1 min-w-[140px] ${
          isMinimal
            ? 'bg-[#D4D8C8] border-[#1A1A1A]/20 rounded-lg'
            : isDark
            ? 'bg-[#1A1A1A] border-white/10'
            : 'bg-white border-[#1A1A1A]'
        }`}
        onClick={stopEvent}
        onContextMenu={stopEvent}
        style={{ left: `${adjustedPos.x}px`, top: `${adjustedPos.y}px` }}
      >
        {!pinBlocked && (
          <button
            onClick={handlePin}
            className={`w-full px-3 py-2 text-left flex items-center gap-2 transition-colors ${
              isMinimal
                ? `text-xs font-sans tracking-wide text-[#1A1A1A] hover:bg-[#1A1A1A]/10`
                : `text-[10px] font-mono uppercase tracking-wider ${isDark ? 'text-white hover:bg-white/10' : 'text-[#1A1A1A] hover:bg-[#1A1A1A]/10'}`
            }`}
          >
            <svg className="w-3.5 h-3.5" fill={isPinned ? 'currentColor' : 'none'} stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
              <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5m-10.5 0h10.5m-10.5 0l.75-10.5h9l.75 10.5" />
            </svg>
            {isMinimal
              ? (isPinned ? 'Unpin drop' : 'Pin drop')
              : (isPinned ? 'UNPIN_DROP' : 'PIN_DROP')
            }
          </button>
        )}
      </div>
    </>
  );
}

// Hook for right-click / long-press context menu
export function useContextMenu() {
  const [menuState, setMenuState] = useState<{ x: number; y: number } | null>(null);
  const longPressTimer = useRef<NodeJS.Timeout | null>(null);
  const touchStartPos = useRef<{ x: number; y: number } | null>(null);
  const MOVE_THRESHOLD = 10;

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setMenuState({ x: e.clientX, y: e.clientY });
  }, []);

  const cancelLongPress = useCallback(() => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
    touchStartPos.current = null;
  }, []);

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    const touch = e.touches[0];
    touchStartPos.current = { x: touch.clientX, y: touch.clientY };
    longPressTimer.current = setTimeout(() => {
      setMenuState({ x: touch.clientX, y: touch.clientY });
      touchStartPos.current = null;
    }, 700);
  }, []);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (!touchStartPos.current) return;
    const touch = e.touches[0];
    const dx = Math.abs(touch.clientX - touchStartPos.current.x);
    const dy = Math.abs(touch.clientY - touchStartPos.current.y);
    if (dx > MOVE_THRESHOLD || dy > MOVE_THRESHOLD) {
      cancelLongPress();
    }
  }, [cancelLongPress]);

  const handleTouchEnd = useCallback(() => {
    cancelLongPress();
  }, [cancelLongPress]);

  const closeMenu = useCallback(() => {
    setMenuState(null);
  }, []);

  return {
    menuState,
    closeMenu,
    contextMenuProps: {
      onContextMenu: handleContextMenu,
      onTouchStart: handleTouchStart,
      onTouchMove: handleTouchMove,
      onTouchEnd: handleTouchEnd,
    },
  };
}
