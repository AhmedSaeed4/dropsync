'use client';

// PANEL-LEVEL typing hook (you only type while the chat is open). Lives in BOTH chat panels.
//
// Writer is TRANSITION-ONLY — never per keystroke: a 300ms debounce starts typing, a 4s idle timer
// stops it. On workspace-switch / unmount it clears typing for the OLD workspace (captured in the
// effect closure, NOT the new one) so a stale doc doesn't ghost-type there until the 10s TTL. The
// panels do NOT remount on switch (no key prop), so this cleanup matters.
//
// Reader is a PLAIN onSnapshot (no decryption); display names are resolved from the trusted
// workspaceMembers prop — the docs carry NO name field (identity = doc path, preventing spoofing).
// Typing docs are NOT messages and are never counted by useInPanelMarkRead or the unread listener.

import { useCallback, useEffect, useRef, useState } from 'react';
import { TYPING_TTL_MS, setTyping, subscribeToTyping, type TypingEntry } from '@/lib/presence';

interface MemberLike {
  uid: string;
  displayName: string;
}

export function useTypingStatus(
  workspaceId: string | null | undefined,
  userId: string | undefined,
  workspaceMembers: MemberLike[] | undefined,
) {
  const [typingUsers, setTypingUsers] = useState<{ uid: string; displayName: string }[]>([]);

  // Refs (NOT state — avoid render loops). currentlyTyping tracks our own writer state.
  const currentlyTyping = useRef(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const idleRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const entriesRef = useRef<TypingEntry[]>([]);

  // Latest-value refs so the callbacks/effect stay stable (no re-subscription on member-name churn).
  const nameMapRef = useRef<Map<string, string>>(new Map());
  const userIdRef = useRef(userId);
  const wsIdRef = useRef(workspaceId);
  nameMapRef.current = new Map((workspaceMembers ?? []).map((m) => [m.uid, m.displayName]));
  userIdRef.current = userId;
  wsIdRef.current = workspaceId;

  // Re-derive typingUsers from cached entries + current time (TTL + self-exclude). Stable identity.
  const recompute = useCallback(() => {
    const me = userIdRef.current;
    if (!me) {
      setTypingUsers([]);
      return;
    }
    const now = Date.now();
    const active = entriesRef.current
      .filter((e) => e.uid !== me && e.isTyping && now - e.atMs >= 0 && now - e.atMs < TYPING_TTL_MS)
      .map((e) => ({ uid: e.uid, displayName: nameMapRef.current.get(e.uid) || 'Someone' }));
    setTypingUsers(active);
  }, []);

  // Subscribe + clear-on-switch. The cleanup closes over the workspaceId that was active when this
  // effect ran, so on a switch it writes setTyping(OLD_workspaceId, userId, false) — NOT the new one.
  useEffect(() => {
    if (!workspaceId || !userId) {
      setTypingUsers([]);
      return;
    }
    // Reset reader state for the new workspace so stale typers from the previous workspace don't
    // bleed through during the async gap before this workspace's first onSnapshot lands.
    entriesRef.current = [];
    setTypingUsers([]);
    let cancelled = false;
    const unsub = subscribeToTyping(workspaceId, (entries) => {
      if (cancelled) return;
      entriesRef.current = entries;
      recompute();
    });
    const interval = setInterval(() => {
      if (!cancelled) recompute();
    }, 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
      unsub();
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
      if (idleRef.current) {
        clearTimeout(idleRef.current);
        idleRef.current = null;
      }
      // Clear typing for THIS (old) workspace so we don't ghost-type there after a switch/unmount.
      if (currentlyTyping.current) {
        currentlyTyping.current = false;
        void setTyping(workspaceId, userId, false).catch(() => {});
      }
    };
  }, [workspaceId, userId, recompute]);

  // Stop typing now. Idempotent (safe to call repeatedly). Writes to the CURRENT workspace.
  const clearTyping = useCallback(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    if (idleRef.current) {
      clearTimeout(idleRef.current);
      idleRef.current = null;
    }
    const ws = wsIdRef.current;
    const me = userIdRef.current;
    if (currentlyTyping.current && ws && me) {
      currentlyTyping.current = false;
      void setTyping(ws, me, false).catch(() => {});
    }
  }, []);

  // Signal that the composer received input. currentText is the composer's LIVE text — the group
  // composer is a contentEditable <div>, so the caller passes e.currentTarget.textContent (groupInput
  // React state is stale within the onInput tick). Empty input clears typing immediately.
  const onComposerInput = useCallback(
    (currentText: string) => {
      const ws = wsIdRef.current;
      const me = userIdRef.current;
      if (!ws || !me) return;
      if (!currentText.trim()) {
        clearTyping();
        return;
      }
      // Re-arm the 4s idle timer on every keystroke.
      if (idleRef.current) clearTimeout(idleRef.current);
      idleRef.current = setTimeout(() => clearTyping(), 4000);
      // Only START typing on a transition (debounced); never write per keystroke while already typing.
      if (!currentlyTyping.current) {
        if (debounceRef.current) clearTimeout(debounceRef.current);
        debounceRef.current = setTimeout(() => {
          currentlyTyping.current = true;
          void setTyping(wsIdRef.current!, userIdRef.current!, true).catch(() => {});
        }, 300);
      }
    },
    [clearTyping],
  );

  return { typingUsers, onComposerInput, clearTyping };
}

/** Format the "X is typing…" line for 1, 2, or 3+ typers. */
export function formatTypingText(names: string[]): string {
  if (names.length === 0) return '';
  if (names.length === 1) return `${names[0]} is typing…`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing…`;
  const rest = names.length - 2;
  return `${names[0]}, ${names[1]} and ${rest} other${rest === 1 ? '' : 's'} are typing…`;
}
