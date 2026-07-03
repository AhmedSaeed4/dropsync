'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { getEditorialThemeColors } from './editorial/editorialTheme';

interface MessageContextMenuProps {
  x: number;
  y: number;
  isOwnMessage: boolean;
  onCopy: () => void;
  onDelete: () => void;
  onEdit?: () => void;
  canEdit?: boolean;
  onClose: () => void;
  theme?: 'light' | 'dark' | 'minimal';
  editorial?: boolean;
}

export function MessageContextMenu({
  x,
  y,
  isOwnMessage,
  onCopy,
  onDelete,
  onEdit,
  canEdit,
  onClose,
  theme = 'light',
  editorial,
}: MessageContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [adjustedPos, setAdjustedPos] = useState({ x, y });
  const [ready, setReady] = useState(false);

  // Adjust position so menu doesn't overflow viewport before first paint
  useLayoutEffect(() => {
    if (!menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    let newX = x;
    let newY = y;
    if (x + rect.width > window.innerWidth) {
      newX = x - rect.width;
    }
    if (newY + rect.height > window.innerHeight) {
      newY = y - rect.height;
    }
    setAdjustedPos({
      x: Math.max(8, newX),
      y: Math.max(8, newY),
    });
    setReady(true);
  }, [x, y]);

  // Close on Escape or click outside
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    onCopy();
    onClose();
  };

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    onDelete();
    onClose();
  };

  const handleEdit = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    onEdit?.();
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

  const tc = editorial ? getEditorialThemeColors(theme) : null;

  const menu = editorial ? (
    <>
      <div className="fixed inset-0 z-[200]" onClick={stopAndClose} onContextMenu={stopAndClose} />
      <div
        ref={menuRef}
        className={`fixed z-[201] ${tc!.cardBg} border ${tc!.border} ${tc!.roundedClass} shadow-lg py-1 min-w-[140px]`}
        onClick={stopEvent}
        onContextMenu={stopEvent}
        style={{ left: `${adjustedPos.x}px`, top: `${adjustedPos.y}px`, visibility: ready ? 'visible' : 'hidden' }}
      >
        <button
          onClick={handleCopy}
          className={`w-full px-3 py-2 text-left text-xs ${tc!.fontClass} ${tc!.text} hover:bg-[#1a1a1a]/5 transition-colors flex items-center gap-2`}
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
            <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
          </svg>
          Copy text
        </button>
        {canEdit && (
          <button
            onClick={handleEdit}
            className={`w-full px-3 py-2 text-left text-xs ${tc!.fontClass} ${tc!.text} hover:bg-[#1a1a1a]/5 transition-colors flex items-center gap-2`}
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
              <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125" />
            </svg>
            Edit
          </button>
        )}
        {isOwnMessage && (
          <button
            onClick={handleDelete}
            className={`w-full px-3 py-2 text-left text-xs ${tc!.fontClass} text-red-500 hover:bg-red-500/10 transition-colors flex items-center gap-2`}
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
              <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
            </svg>
            Delete
          </button>
        )}
      </div>
    </>
  ) : (
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
        style={{ left: `${adjustedPos.x}px`, top: `${adjustedPos.y}px`, visibility: ready ? 'visible' : 'hidden' }}
      >
        <button
          onClick={handleCopy}
          className={`w-full px-3 py-2 text-left flex items-center gap-2 transition-colors ${
            isMinimal
              ? `text-xs font-sans tracking-wide text-[#1A1A1A] hover:bg-[#1A1A1A]/10`
              : `text-[10px] font-mono uppercase tracking-wider ${isDark ? 'text-white hover:bg-white/10' : 'text-[#1A1A1A] hover:bg-[#1A1A1A]/10'}`
          }`}
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
            <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
          </svg>
          {isMinimal ? 'Copy text' : 'COPY_TEXT'}
        </button>
        {canEdit && (
          <button
            onClick={handleEdit}
            className={`w-full px-3 py-2 text-left flex items-center gap-2 transition-colors ${
              isMinimal
                ? `text-xs font-sans tracking-wide text-[#1A1A1A] hover:bg-[#1A1A1A]/10`
                : `text-[10px] font-mono uppercase tracking-wider ${isDark ? 'text-white hover:bg-white/10' : 'text-[#1A1A1A] hover:bg-[#1A1A1A]/10'}`
            }`}
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
              <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125" />
            </svg>
            {isMinimal ? 'Edit' : 'EDIT'}
          </button>
        )}
        {isOwnMessage && (
          <button
            onClick={handleDelete}
            className={`w-full px-3 py-2 text-left flex items-center gap-2 transition-colors text-red-500 hover:bg-red-500/10 ${
              isMinimal
                ? `text-xs font-sans tracking-wide`
                : `text-[10px] font-mono uppercase tracking-wider`
            }`}
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
              <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
            </svg>
            {isMinimal ? 'Delete' : 'DELETE'}
          </button>
        )}
      </div>
    </>
  );

  if (typeof document === 'undefined') return null;
  return createPortal(menu, document.body);
}
