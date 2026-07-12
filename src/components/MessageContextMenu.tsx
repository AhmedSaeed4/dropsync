'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { getEditorialThemeColors } from './editorial/editorialTheme';
import type { MemberInfo } from '@/lib/workspaces';
import type { PresenceMap } from '@/hooks/usePresence';

interface MessageContextMenuProps {
  x: number;
  y: number;
  // Chat panel's right edge in viewport coords. The menu is a portal (no DOM link to the panel), so
  // the panel passes this in to align the menu's right edge to the panel's right edge; falls back to
  // the viewport width when not provided.
  rightBound?: number;
  isOwnMessage: boolean;
  onCopy: () => void;
  onDelete: () => void;
  onEdit?: () => void;
  canEdit?: boolean;
  onReply?: () => void;
  onClose: () => void;
  theme?: 'light' | 'dark' | 'minimal';
  editorial?: boolean;
  // --- Seen-by (group chat, own messages only). The panel fetches the seen-uid list ON DEMAND when
  // "Seen" is tapped (handleSeen → getSeenBy), then this menu swaps in place from the action list to
  // a "Read by" roster. workspaceMembers + presence are threaded down from the panel (already props
  // there); currentUserId excludes the viewer/sender from the roster. ---
  onSeen?: () => void;
  seenInfo?: { loading: boolean; seenUids: Set<string>; error: boolean } | null;
  workspaceMembers?: MemberInfo[];
  presence?: PresenceMap;
  currentUserId: string;
}

export function MessageContextMenu({
  x,
  y,
  rightBound,
  isOwnMessage,
  onCopy,
  onDelete,
  onEdit,
  canEdit,
  onReply,
  onClose,
  theme = 'light',
  editorial,
  onSeen,
  seenInfo,
  workspaceMembers,
  presence,
  currentUserId,
}: MessageContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [adjustedPos, setAdjustedPos] = useState({ x, y });
  const [ready, setReady] = useState(false);
  // In-panel view swap: the menu transforms from the action list into a "Read by" roster without
  // closing (the "Seen" button is the unique handler that does NOT call onClose). Resets to 'actions'
  // naturally on each reopen because the menu unmounts when menuMsg → null in the panel.
  const [view, setView] = useState<'actions' | 'seen'>('actions');

  // Position the menu ONCE on open (deps [x, y]) so its corner never moves when Seen is tapped → no
  // jump. The taller/wider roster is handled WITHOUT repositioning: horizontally we reserve the
  // roster width up front (224 = w-56, wider than the actions list, so it is the binding constraint);
  // vertically the roster body is capped to the on-screen space below the menu top (dynamic
  // rosterMaxH in renderSeenList) and scrolls internally. No ResizeObserver, no size-watcher.
  useLayoutEffect(() => {
    if (!menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    // Horizontal: reserve the roster width (224 = w-56) so the menu already fits the WIDER seen view
    // at open and never has to re-flip when Seen is tapped. The right bound is the CHAT PANEL's right
    // edge (rightBound, passed in — the menu is a portal with no DOM link to the panel), falling back
    // to the viewport; the 8px inset keeps a breathing margin so the menu aligns to but isn't flush
    // with the panel's right edge. left = x; shift left only if the roster width would run past it.
    const ROSTER_W = 224;
    const boundRight = (rightBound ?? window.innerWidth) - 8;
    let newX = x;
    if (newX + ROSTER_W > boundRight) {
      newX = boundRight - ROSTER_W;
    }
    // Vertical: prefer below the button; flip up only if the small actions menu itself wouldn't fit.
    let newY = y;
    if (newY + rect.height > window.innerHeight) {
      newY = y - rect.height;
    }
    setAdjustedPos({
      x: Math.max(8, newX),
      y: Math.max(8, newY),
    });
    setReady(true);
  }, [x, y, rightBound]);

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

  const handleReply = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    onReply?.();
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

  // --- "Read by" roster, rendered when view === 'seen'. ONE helper called from both branches; only
  // the token object differs (editorial tc.* vs classic isMinimal/isDark + mono-uppercase). Roster
  // comes from workspaceMembers (current members) — never a client readState/presence scan. The
  // viewer/sender (currentUserId) is excluded; ex-members are already absent from workspaceMembers.
  // Seen / not-seen only — no timestamps. Rows mirror the members-popover shape (dot + name +
  // status), online-first then alphabetical. ---
  interface SeenListTokens {
    title: string;            // header + seen-section title ("Read by" / "READ BY")
    notYetTitle: string;      // "Not yet" / "NOT YET"
    titleClass: string;       // header row className
    backClass: string;        // back-chevron button color
    nameClass: string;        // member-name className
    mutedClass: string;       // section labels + empty/loading/error + not-yet names + "Read" word
    rowHover: string;         // row hover bg
    spinnerClass: string;     // loading spinner border (themed)
    readStatus: 'check' | 'word'; // ✓ icon (editorial) or "Read" word (classic)
  }
  const renderSeenList = (t: SeenListTokens) => {
    // Dynamic roster cap: the menu is placed once (its top = adjustedPos.y) and never repositioned,
    // so cap the body to the space between the menu top and the viewport bottom (minus the header row
    // + padding ≈ 56, and a 12px bottom margin). Long lists scroll inside; the menu can't run off the
    // bottom. window.innerHeight is read here in render (client component rendering to a portal — no
    // resize listener / size-watcher).
    const rosterMaxH = Math.min(280, Math.max(0, window.innerHeight - adjustedPos.y - 56 - 12));
    const roster = (workspaceMembers || []).filter((m) => m.uid !== currentUserId);
    const onlineFirst = (a: MemberInfo, b: MemberInfo) => {
      const ao = a.uid === currentUserId ? true : !!presence?.[a.uid]?.online;
      const bo = b.uid === currentUserId ? true : !!presence?.[b.uid]?.online;
      if (ao !== bo) return ao ? -1 : 1;
      return (a.displayName || 'Unknown').localeCompare(b.displayName || 'Unknown');
    };
    const seen = roster.filter((m) => seenInfo?.seenUids.has(m.uid)).sort(onlineFirst);
    const notYet = roster.filter((m) => !seenInfo?.seenUids.has(m.uid)).sort(onlineFirst);

    const renderRow = (m: MemberInfo, read: boolean) => {
      const online = m.uid === currentUserId ? true : !!presence?.[m.uid]?.online; // mirror members-popover
      return (
        <div key={m.uid} className={`flex items-center gap-2 px-3 py-1.5 rounded ${t.rowHover}`}>
          <span className={`w-2 h-2 rounded-full shrink-0 ${online ? 'bg-green-500' : 'bg-gray-400'}`} />
          <span className={`truncate flex-1 min-w-0 ${read ? t.nameClass : t.mutedClass}`}>{m.displayName || 'Unknown'}</span>
          {read &&
            (t.readStatus === 'word' ? (
              <span className={`ml-auto text-[10px] ${t.mutedClass}`}>Read</span>
            ) : (
              <svg className={`ml-auto w-3 h-3 ${t.nameClass}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            ))}
        </div>
      );
    };

    return (
      <div className="px-1 pb-1">
        {/* Header: back chevron (returns to actions WITHOUT closing) + title (also the seen-section label). */}
        <div className={`flex items-center gap-1 px-2 py-1.5 ${t.titleClass}`}>
          <button
            onClick={(e) => { e.stopPropagation(); e.preventDefault(); setView('actions'); }}
            className={`p-0.5 rounded ${t.rowHover} ${t.backClass}`}
            title="Back"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <span>{t.title}</span>
        </div>
        {/* Body — capped to the on-screen space below the menu top (dynamic rosterMaxH), scrolls internally. */}
        <div className="overflow-y-auto" style={{ maxHeight: rosterMaxH }}>
          {seenInfo?.loading ? (
            <div className={`flex items-center justify-center gap-2 px-3 py-4 text-xs ${t.mutedClass}`}>
              <span className={`inline-block w-3 h-3 rounded-full border ${t.spinnerClass} animate-spin`} />
              Loading…
            </div>
          ) : seenInfo?.error ? (
            <div className={`px-3 py-4 text-center text-xs ${t.mutedClass}`}>Couldn&apos;t load — tap back</div>
          ) : (
            <>
              {seen.length === 0 && (
                <div className={`px-3 py-2 text-xs ${t.mutedClass}`}>No one has read this yet</div>
              )}
              {seen.length > 0 && <div className="mt-0.5">{seen.map((m) => renderRow(m, true))}</div>}
              {notYet.length > 0 && (
                <div className={seen.length > 0 ? 'mt-1' : 'mt-0.5'}>
                  <div className={`px-3 pt-1 pb-0.5 ${t.mutedClass}`}>{t.notYetTitle}</div>
                  {notYet.map((m) => renderRow(m, false))}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    );
  };

  const menu = editorial ? (
    <>
      <div className="fixed inset-0 z-[200]" onClick={stopAndClose} onContextMenu={stopAndClose} />
      <div
        ref={menuRef}
        className={`fixed z-[201] ${tc!.cardBg} border ${tc!.border} ${tc!.roundedClass} shadow-lg py-1 ${view === 'seen' ? 'w-56' : 'min-w-[140px]'}`}
        onClick={stopEvent}
        onContextMenu={stopEvent}
        style={{ left: `${adjustedPos.x}px`, top: `${adjustedPos.y}px`, visibility: ready ? 'visible' : 'hidden' }}
      >
        {view === 'actions' && (
          <>
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
            {onReply && (
              <button
                onClick={handleReply}
                className={`w-full px-3 py-2 text-left text-xs ${tc!.fontClass} ${tc!.text} hover:bg-[#1a1a1a]/5 transition-colors flex items-center gap-2`}
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 15L3 9m0 0l6-6M3 9h12a6 6 0 010 12h-3" />
                </svg>
                Reply
              </button>
            )}
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
            {isOwnMessage && onSeen && (
              <button
                onClick={(e) => { e.stopPropagation(); e.preventDefault(); onSeen(); setView('seen'); }}
                className={`w-full px-3 py-2 text-left text-xs ${tc!.fontClass} ${tc!.text} hover:bg-[#1a1a1a]/5 transition-colors flex items-center gap-2`}
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
                Seen
              </button>
            )}
          </>
        )}
        {view === 'seen' &&
          renderSeenList({
            title: 'Read by',
            notYetTitle: 'Not yet',
            titleClass: `text-xs ${tc!.fontClass} ${tc!.muted}`,
            backClass: tc!.text,
            nameClass: `text-xs ${tc!.fontClass} ${tc!.text}`,
            mutedClass: `text-xs ${tc!.fontClass} ${tc!.muted}`,
            rowHover: 'hover:bg-[#1a1a1a]/5',
            spinnerClass: theme === 'dark' ? 'border-white/30 border-t-white' : 'border-[#1a1a1a]/30 border-t-[#1a1a1a]',
            readStatus: 'check',
          })}
      </div>
    </>
  ) : (
    <>
      <div className="fixed inset-0 z-[200]" onClick={stopAndClose} onContextMenu={stopAndClose} />
      <div
        ref={menuRef}
        className={`fixed z-[201] border shadow-lg py-1 ${view === 'seen' ? 'w-56' : 'min-w-[140px]'} ${
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
        {view === 'actions' && (
          <>
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
            {onReply && (
              <button
                onClick={handleReply}
                className={`w-full px-3 py-2 text-left flex items-center gap-2 transition-colors ${
                  isMinimal
                    ? `text-xs font-sans tracking-wide text-[#1A1A1A] hover:bg-[#1A1A1A]/10`
                    : `text-[10px] font-mono uppercase tracking-wider ${isDark ? 'text-white hover:bg-white/10' : 'text-[#1A1A1A] hover:bg-[#1A1A1A]/10'}`
                }`}
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 15L3 9m0 0l6-6M3 9h12a6 6 0 010 12h-3" />
                </svg>
                {isMinimal ? 'Reply' : 'REPLY'}
              </button>
            )}
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
            {isOwnMessage && onSeen && (
              <button
                onClick={(e) => { e.stopPropagation(); e.preventDefault(); onSeen(); setView('seen'); }}
                className={`w-full px-3 py-2 text-left flex items-center gap-2 transition-colors ${
                  isMinimal
                    ? `text-xs font-sans tracking-wide text-[#1A1A1A] hover:bg-[#1A1A1A]/10`
                    : `text-[10px] font-mono uppercase tracking-wider ${isDark ? 'text-white hover:bg-white/10' : 'text-[#1A1A1A] hover:bg-[#1A1A1A]/10'}`
                }`}
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
                {isMinimal ? 'Seen' : 'SEEN'}
              </button>
            )}
          </>
        )}
        {view === 'seen' &&
          renderSeenList({
            title: isMinimal ? 'Read by' : 'READ BY',
            notYetTitle: isMinimal ? 'Not yet' : 'NOT YET',
            titleClass: isMinimal
              ? 'text-[10px] font-sans tracking-wide text-[#1A1A1A]/50'
              : `text-[10px] font-mono uppercase tracking-wider ${isDark ? 'text-white/50' : 'text-[#1A1A1A]/50'}`,
            backClass: isDark ? 'text-white' : 'text-[#1A1A1A]',
            nameClass: isMinimal
              ? 'text-xs font-sans tracking-wide text-[#1A1A1A]'
              : `text-xs font-mono ${isDark ? 'text-white' : 'text-[#1A1A1A]'}`,
            mutedClass: isMinimal
              ? 'text-[10px] font-sans tracking-wide text-[#1A1A1A]/40'
              : `text-[10px] font-mono ${isDark ? 'text-white/40' : 'text-[#1A1A1A]/40'}`,
            rowHover: isMinimal ? 'hover:bg-[#1A1A1A]/8' : isDark ? 'hover:bg-white/10' : 'hover:bg-[#1A1A1A]/10',
            spinnerClass: isDark ? 'border-white/30 border-t-white' : 'border-[#1A1A1A]/30 border-t-[#1A1A1A]',
            readStatus: 'word',
          })}
      </div>
    </>
  );

  if (typeof document === 'undefined') return null;
  return createPortal(menu, document.body);
}
