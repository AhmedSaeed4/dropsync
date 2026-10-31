'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

const MODAL_FADE_MS = 200;
const escapeStack: symbol[] = [];

export function useModalFade<Args extends unknown[]>(
  onClose: (...args: Args) => void,
  open = true,
  onEscape?: (close: (...args: Args) => void) => void,
  onOtherKey?: (event: KeyboardEvent) => void,
) {
  const [closing, setClosing] = useState(false);
  const closingRef = useRef(false);
  const activeRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeRef = useRef(onClose);
  const escapeRef = useRef(onEscape);
  const otherKeyRef = useRef(onOtherKey);
  closeRef.current = onClose;
  escapeRef.current = onEscape;
  otherKeyRef.current = onOtherKey;

  // Persistent surfaces must reopen with a fresh entrance after an external close.
  if (!open && closing) setClosing(false);

  useEffect(() => {
    activeRef.current = open;
    closingRef.current = false;
    return () => {
      activeRef.current = false;
      closingRef.current = false;
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = null;
    };
  }, [open]);

  const requestClose = useCallback((...args: Args) => {
    if (!activeRef.current || closingRef.current) return;
    closingRef.current = true;
    setClosing(true);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      if (!activeRef.current) return;
      try {
        closeRef.current(...args);
      } finally {
        closingRef.current = false;
        if (activeRef.current) setClosing(false);
      }
    }, MODAL_FADE_MS);
  }, []);

  const escapeEnabled = !!onEscape;
  useEffect(() => {
    if (!open || !escapeEnabled) return;
    const entry = Symbol();
    escapeStack.push(entry);
    const onKey = (event: KeyboardEvent) => {
      if (escapeStack[escapeStack.length - 1] !== entry) return;
      if (event.key !== 'Escape') { otherKeyRef.current?.(event); return; }
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      escapeRef.current?.(requestClose);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      const index = escapeStack.indexOf(entry);
      if (index !== -1) escapeStack.splice(index, 1);
    };
  }, [open, escapeEnabled, requestClose]);

  return { closing, requestClose };
}
