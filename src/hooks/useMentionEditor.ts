'use client';

import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import type { KeyboardEvent, FocusEvent, Dispatch, SetStateAction } from 'react';
import { Drop } from '@/types';
import { detectHashtagTrigger, parseMessageContent } from '@/lib/dropTagUtils';

/**
 * useMentionEditor — backs a contentEditable text editor that renders #[Name](id) mention
 * tokens as inline, atomic (contenteditable=false) chips while editing, but keeps the
 * SAVED format as the plain token string (so encrypt/save/round-trip is unchanged).
 *
 * Caret-safety is the whole point: the browser owns the DOM during normal typing — we only
 * READ the DOM → serialize → setContent on input, and never write innerHTML back on a typing
 * keystroke (that would jump the caret). We write innerHTML ONLY when `content` diverges from
 * what the DOM last produced — i.e. on mount, edit-load, voice-to-text append, or any other
 * external mutation. See `lastSerializedRef`.
 */

// Zero-width space placed after each chip so the caret has a landing spot; stripped on serialize.
const ZWSP = '\u200B';

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// DOM → token string. Walks child nodes; chips collapse back to #[Name](id), <br>/blocks → \n.
function serializeNode(node: Node): string {
  let out = '';
  node.childNodes.forEach((child) => {
    if (child.nodeType === Node.TEXT_NODE) {
      // Strip the zero-width spaces we insert after chips for caret placement.
      out += (child.textContent || '').replace(/\u200B/g, '');
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      const el = child as HTMLElement;
      if (el.classList && el.classList.contains('mention-chip')) {
        const name = el.getAttribute('data-drop-name') || '';
        const id = el.getAttribute('data-drop-id') || '';
        out += `#[${name}](${id})`;
      } else if (el.tagName === 'BR') {
        out += '\n';
      } else if (el.tagName === 'DIV' || el.tagName === 'P') {
        // Block-level: browsers wrap Enter-created lines in <div>/<p>; treat as a newline.
        if (out.length > 0 && !out.endsWith('\n')) out += '\n';
        out += serializeNode(el);
      } else {
        out += serializeNode(el);
      }
    }
  });
  return out;
}

// Token string → HTML for initial render / external updates. Chips are contenteditable=false.
function renderContentToHtml(content: string, allDrops: Drop[], foundClassName: string, deletedClassName: string): string {
  return parseMessageContent(content).map((part) => {
    if (part.type === 'text') {
      return escapeHtml(part.value || '').replace(/\n/g, '<br>');
    }
    const name = part.name || '';
    const id = part.dropId || '';
    const exists = allDrops.some((d) => d.id === id);
    const cls = exists ? foundClassName : deletedClassName;
    // Trailing ZWSP gives the caret a landing spot after the atomic chip; stripped on serialize.
    return `<span class="mention-chip ${cls}" contenteditable="false" data-drop-id="${escapeHtml(id)}" data-drop-name="${escapeHtml(name)}">${escapeHtml(name)}</span>${ZWSP}`;
  }).join('');
}

function createChipElement(drop: Drop, className: string): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = `mention-chip ${className}`;
  span.setAttribute('contenteditable', 'false');
  span.setAttribute('data-drop-id', drop.id);
  span.setAttribute('data-drop-name', drop.name);
  span.textContent = drop.name;
  return span;
}

function placeCaretAtEnd(el: HTMLElement) {
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false); // end
  const sel = window.getSelection();
  if (sel) {
    sel.removeAllRanges();
    sel.addRange(range);
  }
}

export interface UseMentionEditorOptions {
  content: string;
  setContent: Dispatch<SetStateAction<string>>;
  allDrops: Drop[];
  // Drop id to exclude from the picker (the drop being edited, so it can't mention itself).
  excludeDropId?: string;
  // Full className strings for chips — supplied by the caller per theme.
  foundClassName: string;
  deletedClassName: string;
}

export function useMentionEditor({
  content,
  setContent,
  allDrops,
  excludeDropId,
  foundClassName,
  deletedClassName,
}: UseMentionEditorOptions) {
  const editorRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  // The last string either read FROM the DOM or written INTO it. When `content` equals this,
  // the DOM is already in sync and we must NOT rewrite innerHTML (that would jump the caret).
  const lastSerializedRef = useRef<string | null>(null);
  // The text node + offset of the active #query, captured on input so insertMention knows what
  // range to replace. Chips are atomic, so a #query is always contiguous text in one text node.
  const mentionTextNodeRef = useRef<Text | null>(null);
  const mentionStartOffsetRef = useRef<number>(0);

  const [showMention, setShowMention] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const [mentionIndex, setMentionIndex] = useState(0);
  // Bumped by the setEditorRef callback whenever the contentEditable (re)mounts. Added to the
  // external→DOM effect's deps so the effect re-runs on remount EVEN IF `content` is unchanged —
  // which is what happens on a group→AI→group tab switch (the composer's contentEditable is
  // conditionally rendered on chatMode) or when editing message A then directly editing message B
  // whose content is identical to A's. Without this, the remounted editor stays blank and the next
  // keystroke overwrites the preserved draft (data loss).
  const [mountKey, setMountKey] = useState(0);
  // Callback ref the chat call sites attach (ref={groupMention.setEditorRef}). It mirrors the node
  // into the stable object `editorRef` (so .current readers — the always-mounted drop-note editor
  // AND the chat panels' focus/auto-grow effects — keep working unchanged) AND bumps mountKey on
  // attach so the sync effect re-runs. The drop-note editor keeps using ref={mention.editorRef}
  // directly (no callback, never remounts → mountKey stays 0 → no behavior change).
  const setEditorRef = useCallback((node: HTMLDivElement | null) => {
    editorRef.current = node;
    if (node) {
      lastSerializedRef.current = null;   // force the guard below to see `content` as new
      setMountKey((k) => k + 1);
    }
  }, []);

  const filteredMentionDrops = useMemo(() => {
    const q = mentionQuery.toLowerCase().trim();
    let list = allDrops.filter((d) => d.id !== excludeDropId);
    if (q) list = list.filter((d) => d.name.toLowerCase().includes(q));
    const MAX_RESULTS = typeof window !== 'undefined' && window.innerWidth < 640 ? 5 : 8;
    return list.slice(0, MAX_RESULTS);
  }, [allDrops, mentionQuery, excludeDropId]);

  // Reset highlight when the query changes.
  useEffect(() => { setMentionIndex(0); }, [mentionQuery]);

  // Clamp the highlight when the filtered list shrinks under an open picker (e.g. the live drops
  // list changes) so Enter always lands on a valid row instead of a silent no-op past the end.
  useEffect(() => {
    setMentionIndex((idx) => Math.max(0, Math.min(idx, filteredMentionDrops.length - 1)));
  }, [filteredMentionDrops]);

  // Keep the highlighted dropdown row in view while arrow-navigating.
  useEffect(() => {
    if (!showMention) return;
    const el = dropdownRef.current?.querySelector('[data-drop-highlighted="true"]');
    if (el) el.scrollIntoView({ block: 'nearest' });
  }, [mentionIndex, showMention]);

  // EXTERNAL → DOM. Fires when `content` changes for reasons other than typing (mount, edit-load,
  // voice appends), OR when the editor (re)mounts (mountKey — see setEditorRef). The guard prevents
  // innerHTML rewrites during typing (caret-safety).
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    // Remount detection (belt-and-suspenders): a conditionally-rendered editor that remounts comes
    // back as an EMPTY DOM node while lastSerializedRef still holds the prior value. setEditorRef
    // already nulls lastSerializedRef on attach for chat callers; this covers any future caller that
    // remounts without the callback. A truthy serialized value facing an empty DOM → reset → re-render.
    // Never fires during typing: deleting to nothing sets content='' and lastSerialized='' (falsy).
    if (lastSerializedRef.current && editor.childNodes.length === 0) {
      lastSerializedRef.current = null;
    }
    if (content !== lastSerializedRef.current) {
      editor.innerHTML = renderContentToHtml(content, allDrops, foundClassName, deletedClassName);
      lastSerializedRef.current = content;
      placeCaretAtEnd(editor);
    }
    // allDrops / class names are read via closure at the moment content/mount changes; depending on
    // them would re-run this effect on every parent render and risk caret disruption.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content, mountKey]);

  // DOM → EXTERNAL. Read-only on input: serialize and sync state. Never writes innerHTML back.
  const handleInput = () => {
    const editor = editorRef.current;
    if (!editor) return;
    const serialized = serializeNode(editor);
    lastSerializedRef.current = serialized;
    setContent(serialized);

    // Detect a #query at the caret — only meaningful inside a text node (chips are atomic).
    const sel = window.getSelection();
    const node = sel?.anchorNode;
    if (sel && sel.rangeCount && node && editor.contains(node) && node.nodeType === Node.TEXT_NODE) {
      const textBefore = (node.textContent || '').slice(0, sel.anchorOffset);
      const trigger = detectHashtagTrigger(textBefore);
      if (trigger && trigger.query.length > 0) {
        setShowMention(true);
        setMentionQuery(trigger.query);
        mentionTextNodeRef.current = node as Text;
        mentionStartOffsetRef.current = trigger.startIndex;
        return;
      }
    }
    setShowMention(false);
    setMentionQuery('');
    mentionTextNodeRef.current = null;
  };

  const insertMention = (drop: Drop) => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.focus();
    const sel = window.getSelection();
    const chip = createChipElement(drop, foundClassName);
    const zwsp = document.createTextNode(ZWSP);

    const node = mentionTextNodeRef.current;
    if (node && editor.contains(node) && node.nodeType === Node.TEXT_NODE) {
      // Replace the tracked #query range with [chip][zwsp].
      const len = node.textContent?.length ?? 0;
      const start = Math.min(mentionStartOffsetRef.current, len);
      let end = sel && sel.anchorNode === node ? sel.anchorOffset : len;
      end = Math.max(start, Math.min(end, len));
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, end);
      range.deleteContents();
      range.insertNode(zwsp);
      zwsp.parentNode?.insertBefore(chip, zwsp); // chip lands just before the ZWSP → [chip][zwsp]
    } else {
      // No tracked trigger — drop the chip at the current caret, else at the end.
      if (sel && sel.rangeCount && editor.contains(sel.anchorNode)) {
        const range = sel.getRangeAt(0);
        range.deleteContents();
        range.insertNode(zwsp);
        zwsp.parentNode?.insertBefore(chip, zwsp);
      } else {
        editor.appendChild(chip);
        editor.appendChild(zwsp);
      }
    }

    // Caret just after the ZWSP that follows the chip.
    const newRange = document.createRange();
    newRange.setStartAfter(zwsp);
    newRange.collapse(true);
    sel?.removeAllRanges();
    sel?.addRange(newRange);

    // Sync state from the mutated DOM (content will equal lastSerialized → no innerHTML rewrite).
    const serialized = serializeNode(editor);
    lastSerializedRef.current = serialized;
    setContent(serialized);

    setShowMention(false);
    setMentionQuery('');
    setMentionIndex(0);
    mentionTextNodeRef.current = null;
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (showMention && filteredMentionDrops.length > 0) {
      if (e.key === 'ArrowUp') { e.preventDefault(); setMentionIndex((p) => Math.max(0, p - 1)); return; }
      if (e.key === 'ArrowDown') { e.preventDefault(); setMentionIndex((p) => Math.min(filteredMentionDrops.length - 1, p + 1)); return; }
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); const sel = filteredMentionDrops[mentionIndex]; if (sel) insertMention(sel); return; }
      if (e.key === 'Escape') { e.preventDefault(); setShowMention(false); return; }
    }
    // Otherwise default: Enter inserts a newline (browser); we map <br>/<div>/<p> → \n on serialize.
  };

  const handleBlur = (e: FocusEvent<HTMLDivElement>) => {
    if (dropdownRef.current?.contains(e.relatedTarget as Node)) return;
    setShowMention(false);
  };

  const focusEditor = () => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.focus();
    placeCaretAtEnd(editor);
  };

  return {
    editorRef,
    setEditorRef,
    dropdownRef,
    showMention,
    mentionQuery,
    mentionIndex,
    setMentionIndex,
    filteredMentionDrops,
    handleInput,
    handleKeyDown,
    handleBlur,
    insertMention,
    focusEditor,
  };
}
