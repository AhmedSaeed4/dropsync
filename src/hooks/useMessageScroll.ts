'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Shared scroll-to-message + flash-highlight machinery for the group chat message list. Used by both
 * ChatPanel and EditorialChatPanel so the two copy-pasted panels don't drift. Each panel owns its own
 * scroll container, so the panel's scrollRef is passed in.
 *
 * - messageElRefs: a Map<id, HTMLDivElement> populated via a per-id callback ref that SETS on mount
 *   and DELETES on unmount (null). Because the message list re-renders with different msg.id keys on
 *   a workspace/mode switch, old nodes unmount → ref(null) → auto-delete, so no stale detached-node
 *   pointers survive; jumpToMessage additionally guards on el.isConnected.
 * - jumpToMessage(id): scrolls ONLY the chat container (manual math via scrollRef, NOT
 *   el.scrollIntoView which would also scroll every ancestor incl. the body), bringing the target to
 *   ~1/4 from the top only if it's outside the visible band (block:'nearest'-ish). Then schedules a
 *   re-triggerable highlight flash after the scroll settles (~260ms).
 * - flashId: the id of the message currently flashing (panel applies a CSS flash class to that
 *   bubble). Re-triggerable: jumpToMessage clears flashId first, then sets it ~260ms later, so React
 *   always renders the class-absent state before re-adding it — the CSS animation restarts on
 *   repeated taps of the same quote.
 *
 * Honest v1: if the parent isn't in the loaded window (no DOM node), the jump is a no-op (the quote
 * already shows "Original message unavailable" in that case).
 */
export function useMessageScroll(scrollRef: React.RefObject<HTMLDivElement | null>) {
  const messageElRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  // Cache the per-id callback ref so React doesn't churn (call old(null)/new(el)) on every render.
  const refCache = useRef<Map<string, (el: HTMLDivElement | null) => void>>(new Map());
  const [flashId, setFlashId] = useState<string | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const setMessageRef = useCallback((id: string) => {
    let ref = refCache.current.get(id);
    if (!ref) {
      ref = (el: HTMLDivElement | null) => {
        if (el) messageElRefs.current.set(id, el);
        else messageElRefs.current.delete(id);
      };
      refCache.current.set(id, ref);
    }
    return ref;
  }, []);

  const jumpToMessage = useCallback((id: string) => {
    const container = scrollRef.current;
    const el = messageElRefs.current.get(id);
    if (!el) return;
    // Guard against a stale detached node (defensive — unmount ref(null) already cleans up).
    if (!el.isConnected) {
      messageElRefs.current.delete(id);
      return;
    }
    if (container && container.isConnected) {
      const cRect = container.getBoundingClientRect();
      const eRect = el.getBoundingClientRect();
      // 'nearest'-ish: only scroll when the target is outside the visible band.
      if (eRect.top < cRect.top + 8 || eRect.bottom > cRect.bottom - 8) {
        const offset = eRect.top - cRect.top + container.scrollTop;
        container.scrollTo({
          top: Math.max(0, offset - Math.round(container.clientHeight / 4)),
          behavior: 'smooth',
        });
      }
    }
    // Schedule the flash after the smooth scroll has had time to settle. Clear-then-set makes a
    // repeated tap on the same quote re-trigger the CSS animation.
    if (flashTimer.current) clearTimeout(flashTimer.current);
    setFlashId(null);
    flashTimer.current = setTimeout(() => {
      setFlashId(id);
      flashTimer.current = setTimeout(() => setFlashId(null), 1300);
    }, 260);
  }, [scrollRef]);

  // Clear any pending flash timer on unmount so no setState fires afterward.
  useEffect(() => () => {
    if (flashTimer.current) clearTimeout(flashTimer.current);
  }, []);

  return { setMessageRef, jumpToMessage, flashId };
}
