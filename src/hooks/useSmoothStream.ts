'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Smooths streamed text into a steady, typing-like reveal (shared by the chat panels).
 *
 * Deltas from the backend arrive in network-sized bursts; rendering them raw makes the
 * text jump. This hook buffers the full received text and reveals it on a 30ms tick —
 * a small fixed step plus ~1/15 of the remaining backlog per tick, so a slow stream
 * drips steadily while a large burst automatically accelerates to catch up.
 * prefers-reduced-motion skips the drip and shows text as it arrives.
 *
 * Also covers the no-delta paths (guardrail replies, legacy /chat fallback): `setFull`
 * gets the complete text at once and the reveal types it out instead of popping it in.
 */
export function useSmoothStream() {
  const [revealed, setRevealed] = useState('');
  const [hasText, setHasText] = useState(false);
  // True only when the reveal has caught up with the buffer — panels gate the
  // streaming-bubble → saved-message handoff on it so the swap happens once, complete.
  const [isDone, setIsDone] = useState(false);
  const fullRef = useRef('');
  const lenRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stop = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const start = useCallback(() => {
    if (timerRef.current) return;
    timerRef.current = setInterval(() => {
      const full = fullRef.current;
      if (lenRef.current >= full.length) {
        stop();
        setIsDone(true);
        return;
      }
      // Calm base rate + gentle backlog catch-up (~2s time constant): steady drip for a
      // slow stream, unhurried acceleration for bursts — never a dump, never a long lag.
      const step = Math.max(1, Math.ceil((full.length - lenRef.current) / 50));
      const next = full.slice(0, lenRef.current + step);
      lenRef.current = next.length;
      setRevealed(next);
    }, 40);
  }, [stop]);

  const revealNow = useCallback(() => {
    lenRef.current = fullRef.current.length;
    setRevealed(fullRef.current);
    setIsDone(true);
  }, []);

  const maybeRevealInstantly = useCallback(() => {
    if (
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    ) {
      revealNow();
      return true;
    }
    return false;
  }, [revealNow]);

  /** Append a streamed chunk to the buffer and keep revealing. */
  const append = useCallback(
    (chunk: string) => {
      if (!chunk) return;
      fullRef.current += chunk;
      setHasText(true);
      setIsDone(false);
      if (!maybeRevealInstantly()) start();
    },
    [maybeRevealInstantly, start],
  );

  /** Replace the buffer wholesale — the final answer is authoritative (covers no-delta paths
   *  and trims any excess already revealed). */
  const setFull = useCallback(
    (text: string) => {
      const grew = text.length > lenRef.current;
      fullRef.current = text;
      setHasText(true);
      if (grew) setIsDone(false);
      if (lenRef.current > text.length) {
        lenRef.current = text.length;
        setRevealed(text);
      }
      if (!maybeRevealInstantly()) start();
    },
    [maybeRevealInstantly, start],
  );

  /** Drop everything (new request, cancel, conversation switch, handoff complete). */
  const reset = useCallback(() => {
    stop();
    fullRef.current = '';
    lenRef.current = 0;
    setRevealed('');
    setHasText(false);
    setIsDone(false);
  }, [stop]);

  // Stop the ticker on unmount.
  useEffect(() => stop, [stop]);

  return { revealed, hasText, isDone, append, setFull, reset };
}
