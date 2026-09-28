'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Drop, Workspace } from '@/types';
import { usePendingDeletions } from '@/lib/pendingDeletions';
import { useNow } from '@/hooks/useNow';
import { getEditorialThemeColors } from './editorialTheme';

type Theme = 'light' | 'dark' | 'minimal';
type Mode = 'drops' | 'workspaces';
type Result = { kind: 'drop'; drop: Drop } | { kind: 'workspace'; workspace: Workspace };
type IconKind = 'workspace' | 'file' | 'text' | 'link' | 'drawing' | 'image';

interface EditorialQuickJumpProps {
  theme: Theme;
  userId: string | null;
  currentWorkspaceId: string | null;
  workspaces: Workspace[];
  drops: Drop[];
  dropsLoading: boolean;
  blocked: boolean;
  onSwitchWorkspace: (id: string | null) => void;
  onOpenRootDrop: (drop: Drop) => void;
}

const ROW_CAP = 100;
const BAR_HEIGHT = 38;
const DROPDOWN_GAP = 8;
const EDGE = 12;

const palette = {
  dark: {
    surface: '#1A1A1A',
    text: '#F5F2ED',
    dim: 'rgba(245,242,237,.55)',
    faint: 'rgba(245,242,237,.38)',
    line: 'rgba(255,255,255,.10)',
    strong: 'rgba(255,255,255,.26)',
    inverse: '#F5F2ED',
    inverseText: '#1A1A1A',
    shadow: '0 24px 60px rgba(0,0,0,.55), 0 2px 10px rgba(0,0,0,.35)',
  },
  light: {
    surface: '#FFFFFF',
    text: '#1A1A1A',
    dim: '#666666',
    faint: 'rgba(26,26,26,.38)',
    line: '#E0E0E0',
    strong: '#1A1A1A',
    inverse: '#1A1A1A',
    inverseText: '#FFFFFF',
    shadow: '0 24px 60px rgba(26,26,26,.18), 0 2px 10px rgba(26,26,26,.10)',
  },
  minimal: {
    surface: '#C5C9B8',
    text: '#1A1A1A',
    dim: '#4A4A4A',
    faint: 'rgba(26,26,26,.38)',
    line: '#B0B4A5',
    strong: '#1A1A1A',
    inverse: '#1A1A1A',
    inverseText: '#FFFFFF',
    shadow: '0 24px 60px rgba(26,26,26,.22), 0 2px 10px rgba(26,26,26,.12)',
  },
} as const;

function resultName(result: Result): string {
  return result.kind === 'workspace' ? result.workspace.name : result.drop.name;
}

function dropIconKind(drop: Drop): IconKind {
  if (drop.isDrawing) return 'drawing';
  if (drop.mimeType?.startsWith('image/') || drop.imageUrl) return 'image';
  if (drop.type === 'file') return 'file';
  if (drop.category?.toLowerCase() === 'link' || drop.categories?.some((category) => category.toLowerCase() === 'link')) return 'link';
  return 'text';
}

function ResultIcon({ kind }: { kind: IconKind }) {
  const common = { width: 15, height: 15, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6 };
  if (kind === 'workspace') {
    return <svg {...common} aria-hidden="true"><rect x="7" y="7" width="10" height="10" transform="rotate(45 12 12)" /></svg>;
  }
  if (kind === 'file') {
    return <svg {...common} aria-hidden="true"><path d="M7 3h7l4 4v14H7zM14 3v4h4M10 12h5M10 16h5" /></svg>;
  }
  if (kind === 'link') {
    return <svg {...common} aria-hidden="true"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.6l-1.4 1.4M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.6l1.4-1.4" /></svg>;
  }
  if (kind === 'drawing') {
    return <svg {...common} aria-hidden="true"><path d="M17 3l4 4L8 20l-5 1 1-5L17 3z" /></svg>;
  }
  if (kind === 'image') {
    return <svg {...common} aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="9" cy="10" r="1.6" /><path d="M4 18l5-5 4 4 3-3 4 4" /></svg>;
  }
  return <svg {...common} aria-hidden="true"><path d="M5 5h14M5 9.5h14M5 14h9M5 18.5h6" /></svg>;
}

function placeAt(pointer: { x: number; y: number } | null) {
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const width = Math.min(486, Math.max(0, viewportWidth - EDGE * 2));
  const anchorX = pointer?.x ?? viewportWidth / 2;
  const anchorY = pointer?.y ?? viewportHeight / 2;
  let left = anchorX + 18;
  if (left + width > viewportWidth - EDGE) left = anchorX - width - 18;
  left = Math.min(Math.max(EDGE, left), Math.max(EDGE, viewportWidth - width - EDGE));

  const desiredListHeight = Math.min(316, Math.max(80, viewportHeight - EDGE * 2 - BAR_HEIGHT - DROPDOWN_GAP));
  let top = anchorY + 22;
  const bottomLimit = viewportHeight - EDGE - BAR_HEIGHT - DROPDOWN_GAP - desiredListHeight;
  if (top > bottomLimit) top = Math.max(EDGE, bottomLimit);
  const maxListHeight = Math.max(48, Math.min(316, viewportHeight - top - BAR_HEIGHT - DROPDOWN_GAP - EDGE));
  return { left, top, width, maxListHeight };
}

export function EditorialQuickJump({
  theme,
  userId,
  currentWorkspaceId,
  workspaces,
  drops,
  dropsLoading,
  blocked,
  onSwitchWorkspace,
  onOpenRootDrop,
}: EditorialQuickJumpProps) {
  const colors = palette[theme];
  const tc = getEditorialThemeColors(theme);
  const now = useNow().getTime();
  const { pending, tombstone } = usePendingDeletions();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>('drops');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const [entered, setEntered] = useState(false);
  const [position, setPosition] = useState({ left: EDGE, top: EDGE, width: 486, maxListHeight: 316 });
  const pointerRef = useRef<{ x: number; y: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const rowRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const previousWorkspaceRef = useRef(currentWorkspaceId);

  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    setEntered(false);
    setQuery('');
    setSelected(0);
    if (restoreFocus) {
      const previous = previousFocusRef.current;
      window.requestAnimationFrame(() => {
        if (previous?.isConnected) previous.focus({ preventScroll: true });
      });
    }
  }, []);

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      pointerRef.current = { x: event.clientX, y: event.clientY };
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    return () => window.removeEventListener('pointermove', onMove);
  }, []);

  useEffect(() => {
    if (!blocked) return;
    const frame = window.requestAnimationFrame(() => close(false));
    return () => window.cancelAnimationFrame(frame);
  }, [blocked, close]);

  useEffect(() => {
    if (previousWorkspaceRef.current === currentWorkspaceId) return;
    previousWorkspaceRef.current = currentWorkspaceId;
    const frame = window.requestAnimationFrame(() => close(false));
    return () => window.cancelAnimationFrame(frame);
  }, [currentWorkspaceId, close]);

  useEffect(() => {
    if (!open || blocked) return;
    const frame = window.requestAnimationFrame(() => {
      inputRef.current?.focus({ preventScroll: true });
      setEntered(true);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open, blocked]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) close(false);
    };
    const onResize = () => close(false);
    document.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('resize', onResize);
    };
  }, [open, close]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (blocked || event.defaultPrevented || event.isComposing || event.repeat) return;
      const ownInput = event.target === inputRef.current;
      const target = event.target instanceof Element ? event.target : null;
      const editable = !!target?.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]');
      const ctrlOnly = event.ctrlKey && !event.metaKey && !event.altKey;
      let requested: Mode | null = null;
      if (ctrlOnly && !event.shiftKey && event.code === 'Space') requested = 'drops';
      if (ctrlOnly && !event.shiftKey && event.code === 'KeyW') requested = 'workspaces';
      if (ctrlOnly && event.shiftKey && event.code === 'Space') requested = 'workspaces';
      if (event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey && event.code === 'Space') requested = 'workspaces';
      if (requested) {
        if (editable && !ownInput) return;
        event.preventDefault();
        if (open && mode === requested) {
          close(true);
          return;
        }
        if (!open) {
          previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
          setPosition(placeAt(pointerRef.current));
          setEntered(false);
        }
        setMode(requested);
        setQuery('');
        setSelected(0);
        setOpen(true);
        inputRef.current?.focus({ preventScroll: true });
      } else if (event.key === 'Escape' && open) {
        event.preventDefault();
        close(true);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [blocked, open, mode, close]);

  const normalized = query.trim().toLowerCase();
  const visible = open && !blocked;
  const results = useMemo(() => {
    if (!normalized) return [] as Result[];
    const candidates: Result[] = mode === 'workspaces'
      ? workspaces
        .filter((workspace) => workspace.deleting !== true && !!userId && (workspace.members ?? []).includes(userId))
        .map((workspace) => ({ kind: 'workspace' as const, workspace }))
      : currentWorkspaceId
        ? drops
          .filter((drop) => (
            drop.workspaceId === currentWorkspaceId &&
            drop.type !== 'call' &&
            !pending.has(drop.id) &&
            !tombstone.has(drop.id) &&
            (!drop.expiresAt || drop.expiresAt.getTime() > now)
          ))
          .map((drop) => ({ kind: 'drop' as const, drop }))
        : [];
    const starts: Result[] = [];
    const contains: Result[] = [];
    for (const candidate of candidates) {
      const name = resultName(candidate).toLowerCase();
      if (name.startsWith(normalized)) starts.push(candidate);
      else if (name.includes(normalized)) contains.push(candidate);
    }
    return starts.concat(contains).slice(0, ROW_CAP);
  }, [normalized, mode, workspaces, userId, currentWorkspaceId, drops, pending, tombstone, now]);

  const activeIndex = results.length ? Math.min(selected, results.length - 1) : 0;
  useEffect(() => {
    if (!visible || !normalized || !results.length) return;
    rowRefs.current[activeIndex]?.scrollIntoView({ block: 'nearest' });
  }, [visible, normalized, results, activeIndex]);

  const pick = (index: number) => {
    const chosen = results[index];
    if (!chosen) return;
    if (chosen.kind === 'workspace') {
      const workspace = workspaces.find((candidate) => candidate.id === chosen.workspace.id);
      if (!workspace || workspace.deleting || !userId || !(workspace.members ?? []).includes(userId)) return;
      close(false);
      onSwitchWorkspace(workspace.id);
      return;
    }
    const drop = drops.find((candidate) => candidate.id === chosen.drop.id);
    if (!drop || !currentWorkspaceId || drop.workspaceId !== currentWorkspaceId ||
        drop.type === 'call' || pending.has(drop.id) || tombstone.has(drop.id) ||
        (drop.expiresAt && drop.expiresAt.getTime() <= Date.now())) return;
    close(false);
    onOpenRootDrop(drop);
  };

  const onInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    } else if (event.key === 'ArrowDown' && normalized && results.length) {
      event.preventDefault();
      setSelected((current) => (Math.min(current, results.length - 1) + 1) % results.length);
    } else if (event.key === 'ArrowUp' && normalized && results.length) {
      event.preventDefault();
      setSelected((current) => (Math.min(current, results.length - 1) - 1 + results.length) % results.length);
    } else if (event.key === 'Enter' && normalized) {
      event.preventDefault();
      if (results.length) pick(activeIndex);
    }
  };

  if (!visible) return null;

  const emptyMessage = mode === 'workspaces'
    ? 'No workspaces match'
    : !currentWorkspaceId
      ? 'Choose a workspace to search drops'
      : dropsLoading
        ? 'Loading drops…'
        : 'No drops match';

  return createPortal(
    <div
      ref={rootRef}
      role="search"
      aria-label="Quick Jump"
      className={'fixed z-[90] font-[family-name:var(--font-inter)] transition-[opacity,transform] duration-[140ms] ease-out motion-reduce:transition-none ' +
        (entered ? 'opacity-100 translate-y-0 scale-100' : 'opacity-0 translate-y-[3px] scale-[.98]')}
      style={{ left: position.left, top: position.top, width: position.width }}
    >
      <div
        className={`relative flex w-full items-center border pl-10 pr-4 py-2 text-sm ${tc.cardBg} ${tc.border} ${tc.text} ${tc.fontClass} ${tc.roundedClass} focus-within:outline-none focus-within:ring-1 focus-within:ring-[#1A1A1A]/20 transition-colors`}
        style={{ boxShadow: colors.shadow }}
      >
        <svg
          className={`absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 ${tc.muted}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          strokeWidth={1.5}
          aria-hidden="true"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
        </svg>
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(event) => { setQuery(event.target.value); setSelected(0); }}
          onKeyDown={onInputKeyDown}
          placeholder={mode === 'workspaces' ? 'Search workspaces...' : 'Search drops...'}
          aria-label={mode === 'workspaces' ? 'Search workspaces' : 'Search drops'}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={!!normalized}
          aria-controls="editorial-quick-jump-results"
          aria-activedescendant={results.length && normalized ? 'editorial-quick-jump-row-' + activeIndex : undefined}
          autoComplete="off"
          spellCheck={false}
          className={`w-full bg-transparent border-none outline-none text-sm caret-current ${theme === 'dark' ? 'placeholder:text-white/30' : 'placeholder:text-[#1A1A1A]/30'}`}
        />
      </div>
      <div
        id="editorial-quick-jump-results"
        role="listbox"
        aria-label={mode === 'workspaces' ? 'Matching workspaces' : 'Matching drops'}
        aria-hidden={!normalized}
        className={'absolute left-0 right-0 top-[calc(100%+8px)] rounded-lg border overflow-hidden transition-[opacity,transform] duration-[160ms] ease-out motion-reduce:transition-none ' +
          (normalized ? 'opacity-100 translate-y-0 scale-100 pointer-events-auto' : 'opacity-0 -translate-y-[6px] scale-[.985] pointer-events-none')}
        style={{ backgroundColor: colors.surface, borderColor: colors.line, boxShadow: colors.shadow }}
      >
        <div className="overflow-y-auto py-[5px]" style={{ maxHeight: position.maxListHeight }}>
          {results.length ? results.map((result, index) => {
            const active = index === activeIndex;
            const kind = result.kind === 'workspace' ? 'workspace' : dropIconKind(result.drop);
            return (
              <button
                key={result.kind === 'workspace' ? 'workspace-' + result.workspace.id : 'drop-' + result.drop.id}
                id={'editorial-quick-jump-row-' + index}
                ref={(node) => { rowRefs.current[index] = node; }}
                type="button"
                role="option"
                aria-selected={active}
                onMouseEnter={() => setSelected(index)}
                onClick={() => pick(index)}
                className="flex w-full items-center gap-[11px] px-[15px] py-[9px] text-left cursor-default font-[family-name:var(--font-inter)]"
                style={{ backgroundColor: active ? colors.inverse : 'transparent', color: active ? colors.inverseText : colors.text }}
              >
                <span className="shrink-0 flex" style={{ color: active ? colors.inverseText : colors.dim }}><ResultIcon kind={kind} /></span>
                <span className="min-w-0 truncate text-[14px] font-medium">{resultName(result)}</span>
              </button>
            );
          }) : (
            <p className="px-[15px] py-5 text-center text-[12.5px]" style={{ color: colors.dim }}>{emptyMessage}</p>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
