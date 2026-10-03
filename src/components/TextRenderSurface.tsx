'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import hljs from 'highlight.js/lib/core';
import typescript from 'highlight.js/lib/languages/typescript';
import javascript from 'highlight.js/lib/languages/javascript';
import python from 'highlight.js/lib/languages/python';
import json from 'highlight.js/lib/languages/json';
import html from 'highlight.js/lib/languages/xml';
import css from 'highlight.js/lib/languages/css';
import bash from 'highlight.js/lib/languages/bash';

// Core only: HTML uses the XML grammar, registered under the one visible HTML lens.
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('python', python);
hljs.registerLanguage('json', json);
hljs.registerLanguage('html', html);
hljs.registerLanguage('css', css);
hljs.registerLanguage('bash', bash);

type Theme = 'light' | 'dark' | 'minimal';
export type TextLens = 'plain' | 'markdown' | 'typescript' | 'javascript' | 'python' | 'json' | 'html' | 'css' | 'bash';
export interface TextRecommendation { lens: TextLens; score: number }

const LENSES: { lens: TextLens; label: string }[] = [
  { lens: 'markdown', label: 'Markdown' },
  { lens: 'plain', label: 'Plain text' },
  { lens: 'typescript', label: 'TypeScript' },
  { lens: 'javascript', label: 'JavaScript' },
  { lens: 'python', label: 'Python' },
  { lens: 'json', label: 'JSON' },
  { lens: 'html', label: 'HTML' },
  { lens: 'css', label: 'CSS' },
  { lens: 'bash', label: 'Bash' },
];
const TIE_ORDER: TextLens[] = ['json', 'html', 'css', 'bash', 'python', 'javascript', 'typescript', 'markdown'];
const EXTENSIONS: Record<string, TextLens> = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript',
  py: 'python', json: 'json', html: 'html', css: 'css', sh: 'bash', bash: 'bash', md: 'markdown', markdown: 'markdown',
};
const MIME_LENSES: Record<string, TextLens> = {
  'text/typescript': 'typescript', 'text/x-typescript': 'typescript',
  'text/javascript': 'javascript', 'application/javascript': 'javascript',
  'text/x-python': 'python', 'text/python': 'python',
  'application/json': 'json', 'text/json': 'json', 'text/html': 'html', 'text/css': 'css',
  'text/x-shellscript': 'bash', 'text/x-sh': 'bash', 'text/markdown': 'markdown', 'text/x-markdown': 'markdown',
};
const DETECTION_LIMIT = 32_768;
const HIGHLIGHT_LIMIT = 100_000;
const LINE_LIMIT = 20_000;
const labelFor = (lens: TextLens) => LENSES.find(item => item.lens === lens)!.label;

/** Pure, bounded presence scoring. MIME can corroborate, never nominate a language. */
export function detectTextLenses(content: string, name: string, mimeType?: string): TextRecommendation[] {
  const sample = content.slice(0, DETECTION_LIMIT);
  const scores = new Map<TextLens, number>();
  const add = (lens: TextLens, points: number) => scores.set(lens, Math.min(80, (scores.get(lens) ?? 0) + points));
  if (/^\s*(?:export\s+)?(?:interface|type|enum)\s+\w+/m.test(sample)) add('typescript', 45);
  if (/\b(?:const|let|var)\s+\w+\s*:\s*[\w[{]|\)\s*:\s*\w+|\w+\??\s*:\s*(?:string|number|boolean)\b/.test(sample)) add('typescript', 25);
  if (/\b(?:const|let|var|function)\s+\w+/.test(sample)) { add('javascript', 30); add('typescript', 30); }
  if (/=>/.test(sample)) { add('javascript', 15); add('typescript', 15); }
  if (/^\s*(?:import\s+.+\sfrom\s|export\s+(?:default|const|function)\b)/m.test(sample)) { add('javascript', 10); add('typescript', 10); }
  if (/^\s*(?:async\s+)?(?:def|class)\s+\w+[^\n]*:\s*$/m.test(sample)) add('python', 35);
  if (/:\s*\n[ \t]+\S/.test(sample)) add('python', 15);
  if (/^\s*(?:import\s+\w+|from\s+\S+\s+import\s+)/m.test(sample)) add('python', 20);
  if (content.length <= DETECTION_LIMIT) {
    try { JSON.parse(content); add('json', 60); } catch { /* Not complete JSON. */ }
  }
  if (/<[a-z][\w:-]*(?:\s[^<>]*?)?\s*\/?>/.test(sample)) add('html', 35);
  if (/<\/[a-z][\w:-]*\s*>/.test(sample)) add('html', 20);
  if (/<!doctype\s+html\b/i.test(sample)) add('html', 60);
  const cssBlock = sample.match(/^[ \t]*[.#@*a-z][^{}\n]{0,120}\{[^{}]{0,1600}\b[\w-]+\s*:\s*[^{};]+[;}]/m);
  if (cssBlock && !/^\s*(?:interface|type|enum|const|let|function|class)\b/.test(cssBlock[0])) add('css', 45);
  if (/^#![^\n]*(?:\/(?:ba)?sh\b|env\s+(?:ba)?sh\b)/.test(sample)) add('bash', 60);
  if (/^\s*(?:echo|printf|export|source|cd|set)\s+/m.test(sample)) add('bash', 30);
  if (/\$\{?[A-Za-z_]\w*\}?|\$\(/.test(sample)) add('bash', 15);
  if (/^\s*(?:if|for|while)\b[^\n]*\b(?:then|do)\b/m.test(sample)) add('bash', 25);
  const markdown = sample.replace(/#\[((?:\\.|[^\]\\])*)\]\(([^)]+)\)/g, '');
  if (/^\s{0,3}#{1,6}\s+\S/m.test(markdown)) add('markdown', 35);
  if (/^\s{0,3}(?:\x60{3,}|~{3,})/m.test(markdown)) add('markdown', 35);
  if (/\*\*[^*\n]+\*\*/.test(markdown)) add('markdown', 15);
  if (/^\s*[-*]\s+\S/m.test(markdown)) add('markdown', 20);
  if (/\[[^\]\n]+\]\([^)]+\)/.test(markdown)) add('markdown', 20);

  const extension = name.slice(-1024).match(/\.([^.]+)$/)?.[1].toLowerCase();
  const namedLens = extension && Object.hasOwn(EXTENSIONS, extension) ? EXTENSIONS[extension] : undefined;
  if (namedLens) scores.set(namedLens, (scores.get(namedLens) ?? 0) + 100);
  const mime = mimeType?.split(';')[0].trim().toLowerCase() ?? '';
  const mimeLens = Object.hasOwn(MIME_LENSES, mime) ? MIME_LENSES[mime] : undefined;
  if (mimeLens && scores.has(mimeLens)) scores.set(mimeLens, scores.get(mimeLens)! + 5);
  const recommendations = [...scores].filter(([, score]) => score >= 30)
    .sort(([a, aScore], [b, bScore]) => bScore - aScore || TIE_ORDER.indexOf(a) - TIE_ORDER.indexOf(b))
    .slice(0, 3).map(([lens, score]) => ({ lens, score }));
  return recommendations.length ? recommendations : [{ lens: 'plain', score: 0 }];
}

/** Null means React must render the full source as ordinary escaped monospace text. */
export function getHighlightedText(content: string, lens: TextLens): string | null {
  if (lens === 'plain' || lens === 'markdown' || content.length > HIGHLIGHT_LIMIT) return null;
  let lineLength = 0;
  for (let i = 0; i < content.length; i++) {
    if (content[i] === '\n' || content[i] === '\r') lineLength = 0;
    else if (++lineLength > LINE_LIMIT) return null;
  }
  try { return hljs.highlight(content, { language: lens, ignoreIllegals: true }).value; }
  catch { return null; }
}

/** Keep the completed-chat plugin/link treatment, but render drop tokens as literal source. */
export function createTextMarkdownComponents(content: string): Components {
  return {
    a: ({ href, children, node }) => {
      const start = node?.position?.start.offset;
      const end = node?.position?.end.offset;
      if (start !== undefined && end !== undefined && content[start - 1] === '#') {
        const rawLink = content.slice(start, end);
        if (/^\[((?:\\.|[^\]\\])*)\]\(([^)]+)\)$/.test(rawLink)) return <span>{rawLink}</span>;
      }
      return <a href={href} target="_blank" rel="noopener noreferrer" className="ds-link">{children}</a>;
    },
  };
}

interface ViewAsMenuProps {
  x: number;
  y: number;
  lens: TextLens;
  recommendations: TextRecommendation[];
  onSelect: (lens: TextLens) => void;
  onClose: () => void;
  theme: Theme;
  editorial: boolean;
}

function ViewAsMenu({ x, y, lens, recommendations, onSelect, onClose, theme, editorial }: ViewAsMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const isDark = theme === 'dark';
  const palette = editorial
    ? isDark ? 'bg-[#1a1a1a] text-white border-[#333]'
      : theme === 'minimal' ? 'bg-[#C5C9B8] text-[#1a1a1a] border-[#b0b4a5]'
      : 'bg-white text-[#1a1a1a] border-[#e0e0e0]'
    : isDark ? 'bg-[#1A1A1A] text-white border-white/10'
      : theme === 'minimal' ? 'bg-[#D4D8C8] text-[#1A1A1A] border-[#1A1A1A]/20'
      : 'bg-white text-[#1A1A1A] border-[#1A1A1A]';
  const typography = editorial ? 'font-[family-name:var(--font-raleway)] text-xs rounded-lg'
    : theme === 'minimal' ? 'font-sans text-xs rounded-lg' : 'font-mono text-xs';

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const viewport = window.visualViewport;
    const position = () => {
      const width = viewport?.width ?? window.innerWidth;
      const height = viewport?.height ?? window.innerHeight;
      const left = viewport?.offsetLeft ?? 0;
      const top = viewport?.offsetTop ?? 0;
      menu.style.maxHeight = Math.max(0, height - 16) + 'px';
      menu.style.width = Math.max(0, Math.min(224, width - 16)) + 'px';
      const rect = menu.getBoundingClientRect();
      menu.style.left = Math.max(left + 8, Math.min(x, left + width - rect.width - 8)) + 'px';
      menu.style.top = Math.max(top + 8, Math.min(y, top + height - rect.height - 8)) + 'px';
    };
    position();
    window.addEventListener('resize', position);
    viewport?.addEventListener('resize', position);
    viewport?.addEventListener('scroll', position);
    return () => {
      window.removeEventListener('resize', position);
      viewport?.removeEventListener('resize', position);
      viewport?.removeEventListener('scroll', position);
    };
  }, [x, y]);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    menuRef.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, [onClose]);

  const dismiss = (event: React.SyntheticEvent) => {
    event.preventDefault();
    event.stopPropagation();
    onClose();
  };
  const row = (choice: TextLens, section: string) => (
    <button
      key={section + choice}
      type="button"
      role="menuitemradio"
      aria-checked={lens === choice}
      tabIndex={-1}
      className={'w-full px-3 py-2 text-left flex items-center justify-between gap-3 outline-none focus:outline-none ' + (isDark ? 'hover:bg-white/10' : 'hover:bg-[#1a1a1a]/10')}
      onClick={event => { event.stopPropagation(); onSelect(choice); }}
    >
      <span>{labelFor(choice)}</span>
      {lens === choice && <span aria-hidden="true">✓</span>}
    </button>
  );

  return createPortal(
    <>
      <div className="fixed inset-0 z-[1100]" onClick={dismiss} onContextMenu={dismiss} onPointerDown={event => event.stopPropagation()} />
      <div
        ref={menuRef}
        role="menu"
        aria-label="View as"
        className={'fixed z-[1101] border shadow-lg py-1 overflow-y-auto overscroll-contain ' + palette + ' ' + typography}
        style={{ left: x, top: y, width: 'min(224px, calc(100vw - 16px))', maxHeight: 'calc(100dvh - 16px)' }}
        onClick={event => event.stopPropagation()}
        onContextMenu={event => { event.preventDefault(); event.stopPropagation(); }}
        onKeyDown={event => {
          if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'));
          const current = items.indexOf(document.activeElement as HTMLButtonElement);
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
            : (current + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length;
          items[next]?.focus();
        }}
      >
        <div className="px-3 py-2 font-semibold">View as</div>
        <div className="px-3 pb-1 opacity-60">Recommended</div>
        {recommendations.map(item => row(item.lens, 'recommended-'))}
        <div className={'my-1 border-t ' + (isDark ? 'border-white/10' : 'border-[#1a1a1a]/15')} />
        {LENSES.map(item => row(item.lens, 'all-'))}
      </div>
    </>,
    document.body,
  );
}

interface TextRenderSurfaceProps {
  content: string;
  name: string;
  mimeType?: string;
  theme?: Theme;
  editorial?: boolean;
  isFullscreen?: boolean;
  children: ReactNode;
}

/** Mount/key defines a viewing session; fullscreen changes only the existing host's classes. */
export function TextRenderSurface({ content, name, mimeType, theme = 'light', editorial = false, isFullscreen = false, children }: TextRenderSurfaceProps) {
  const [lens, setLens] = useState<TextLens>('plain');
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<number | null>(null);
  const touchRef = useRef<{ x: number; y: number; opened: boolean } | null>(null);
  const previousLens = useRef(lens);
  const recommendations = useMemo(() => detectTextLenses(content, name, mimeType), [content, name, mimeType]);
  const highlighted = useMemo(() => getHighlightedText(content, lens), [content, lens]);
  const markdownComponents = useMemo(() => createTextMarkdownComponents(content), [content]);
  const best = recommendations[0].lens;
  const isDark = theme === 'dark';
  const closeMenu = useCallback(() => setMenu(null), []);
  const cancelTouch = useCallback(() => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    touchRef.current = null;
  }, []);

  useEffect(() => {
    const surface = contentRef.current;
    if (!surface) return;
    const start = (event: TouchEvent) => {
      cancelTouch();
      if (event.touches.length !== 1) return;
      const touch = event.touches[0];
      const gesture = { x: touch.clientX, y: touch.clientY, opened: false };
      touchRef.current = gesture;
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        gesture.opened = true;
        const selection = window.getSelection();
        if (selection?.anchorNode && surface.contains(selection.anchorNode)) selection.removeAllRanges();
        setMenu({ x: gesture.x, y: gesture.y });
      }, 700);
    };
    const move = (event: TouchEvent) => {
      const gesture = touchRef.current;
      if (!gesture) return;
      if (event.touches.length !== 1) { cancelTouch(); return; }
      if (gesture.opened) { event.preventDefault(); return; }
      const touch = event.touches[0];
      if (Math.abs(touch.clientX - gesture.x) > 10 || Math.abs(touch.clientY - gesture.y) > 10) cancelTouch();
    };
    const end = (event: TouchEvent) => {
      if (touchRef.current?.opened) event.preventDefault();
      cancelTouch();
    };
    surface.addEventListener('touchstart', start, { passive: true });
    surface.addEventListener('touchmove', move, { passive: false });
    surface.addEventListener('touchend', end, { passive: false });
    surface.addEventListener('touchcancel', cancelTouch);
    window.addEventListener('blur', cancelTouch);
    return () => {
      surface.removeEventListener('touchstart', start);
      surface.removeEventListener('touchmove', move);
      surface.removeEventListener('touchend', end);
      surface.removeEventListener('touchcancel', cancelTouch);
      window.removeEventListener('blur', cancelTouch);
      cancelTouch();
    };
  }, [cancelTouch]);

  const resetScroll = useCallback(() => {
    const surface = contentRef.current;
    if (!surface) return;
    surface.querySelectorAll<HTMLElement>('pre').forEach(node => node.scrollTo({ top: 0, left: 0, behavior: 'instant' }));
    let node: HTMLElement | null = surface;
    while (node && node !== document.body && node !== document.documentElement) {
      node.scrollTo({ top: 0, left: 0, behavior: 'instant' });
      if (getComputedStyle(node).position === 'fixed') break;
      node = node.parentElement;
    }
  }, []);
  useLayoutEffect(() => {
    if (previousLens.current === lens) return;
    previousLens.current = lens;
    resetScroll();
  }, [lens, resetScroll]);
  const selectLens = useCallback((choice: TextLens) => {
    resetScroll();
    setLens(choice);
    setDismissed(true);
    closeMenu();
  }, [closeMenu, resetScroll]);
  const colors = {
    '--tr-keyword': isDark ? '#fca5a5' : '#9f1239',
    '--tr-string': isDark ? '#86efac' : '#166534',
    '--tr-number': isDark ? '#fdba74' : '#9a3412',
    '--tr-type': isDark ? '#93c5fd' : '#1d4ed8',
    '--tr-title': isDark ? '#c4b5fd' : '#6d28d9',
    '--tr-comment': isDark ? '#a3a3a3' : '#626262',
    color: isDark ? '#ffffff' : 'var(--black)',
  } as CSSProperties;

  return (
    <div className={isFullscreen ? 'h-full min-h-0 flex flex-col' : 'min-w-0 max-w-full'}>
      {!dismissed && best !== 'plain' && (
        <div className={'mb-2 pr-9 flex items-start gap-2 text-xs shrink-0 ' + (isDark ? 'text-white/70' : 'text-[#1a1a1a]/70')}>
          <button type="button" className="text-left underline underline-offset-2" onClick={() => selectLens(best)}>
            Looks like {labelFor(best)} — view as {labelFor(best)}?
          </button>
          <button type="button" aria-label="Dismiss rendering suggestion" className="px-1" onClick={() => setDismissed(true)}>×</button>
        </div>
      )}
      <div
        ref={contentRef}
        className={isFullscreen ? 'min-w-0 min-h-0 flex-1' : 'min-w-0 max-w-full'}
        style={{ WebkitTouchCallout: 'none' }}
        onContextMenu={event => {
          event.preventDefault();
          event.stopPropagation();
          // A native touch contextmenu must not bypass the 700 ms timer or duplicate its menu.
          if (touchRef.current) return;
          cancelTouch();
          setMenu({ x: event.clientX, y: event.clientY });
        }}
      >
        {lens === 'plain' ? children : lens === 'markdown' ? (
          <div className={'text-sm leading-relaxed break-words [&_p]:mb-2 [&_p:last-child]:mb-0 [&_h1]:text-2xl [&_h2]:text-xl [&_h3]:text-lg [&_h1]:font-bold [&_h2]:font-bold [&_h3]:font-bold [&_h1]:mb-2 [&_h2]:mb-2 [&_h3]:mb-2 [&_ul]:list-disc [&_ol]:list-decimal [&_ul]:pl-5 [&_ol]:pl-5 [&_pre]:overflow-x-auto [&_pre]:max-w-full [&_code]:break-all ' + (editorial ? 'font-[family-name:var(--font-raleway)] ' : '') + (isDark ? 'text-white ' : 'text-[#1a1a1a] ') + (isFullscreen ? 'h-full overflow-y-auto' : '')}>
            <ReactMarkdown remarkPlugins={[remarkBreaks]} components={markdownComponents}>{content}</ReactMarkdown>
          </div>
        ) : (
          <pre className={'ds-text-code text-sm font-mono leading-relaxed whitespace-pre break-normal min-w-0 max-w-full overflow-auto ' + (isFullscreen ? 'h-full' : 'max-h-[50vh]')} style={colors}>
            {highlighted === null ? <code>{content}</code> : <code dangerouslySetInnerHTML={{ __html: highlighted }} />}
          </pre>
        )}
      </div>
      {menu && <ViewAsMenu {...menu} lens={lens} recommendations={recommendations} onSelect={selectLens} onClose={closeMenu} theme={theme} editorial={editorial} />}
      <style jsx global>{`
        .ds-text-code .hljs-keyword, .ds-text-code .hljs-selector-tag { color: var(--tr-keyword); }
        .ds-text-code .hljs-string, .ds-text-code .hljs-attr, .ds-text-code .hljs-regexp { color: var(--tr-string); }
        .ds-text-code .hljs-number, .ds-text-code .hljs-literal { color: var(--tr-number); }
        .ds-text-code .hljs-type, .ds-text-code .hljs-built_in, .ds-text-code .hljs-variable { color: var(--tr-type); }
        .ds-text-code .hljs-title, .ds-text-code .hljs-name, .ds-text-code .hljs-tag { color: var(--tr-title); }
        .ds-text-code .hljs-comment, .ds-text-code .hljs-quote, .ds-text-code .hljs-meta { color: var(--tr-comment); }
      `}</style>
    </div>
  );
}
