'use client';

import { useEffect, useRef } from 'react';
import { Timestamp } from 'firebase/firestore';
import { markWorkspaceChatRead, clearWorkspaceMentions } from '@/lib/groupChat';
import type { GroupChatMessage } from '@/types';

const DEBOUNCE_MS = 1500;

/**
 * Persist group-chat messages as read while the user is actually viewing them — the chat panel is
 * open AND the tab is visible. Closes Cause B of the phantom-unread glow: messages received while
 * the panel was open were only marked read on the open/close transition (page.tsx), so closing the
 * APP without first closing the panel (mobile swipe-away) left them "unread" and the glow returned
 * on the next cold start.
 *
 * Behavior:
 *  - Fires only when the latest message is genuinely newer than the last one marked FOR THIS
 *    workspace — never on every snapshot, so bursts and re-emits don't cause write spam.
 *  - Debounced (DEBOUNCE_MS): a burst of arrivals collapses into one write.
 *  - Skips entirely while the tab is hidden (the user isn't viewing); re-marks on becoming visible
 *    to cover anything that arrived while hidden.
 *  - Workspace-switch safe: the chat panels do NOT remount on a workspace switch and do NOT clear
 *    their message list, so for one commit after a switch `messages` still belongs to the PREVIOUS
 *    workspace. The hook detects the switch, cancels any pending write, drops the baseline, and
 *    refuses to mark (both here and in the visibility listener) until the new workspace's first real
 *    snapshot arrives — otherwise it would stamp the new workspace's readState with the old
 *    workspace's timestamps, silently suppressing the new workspace's genuine unread glow.
 *  - lastReadAt is derived from the message's own already-resolved createdAt (Timestamp.fromDate),
 *    so it shares the same time base as the messages it is compared against — no fresh
 *    serverTimestamp, hence no cross-write clock skew (Cause C).
 *  - Best-effort: never throws to the caller; clears its debounce timer on unmount.
 *
 * `messages` is the ascending-ordered list from subscribeToGroupMessages (newest = last element).
 */
export function useInPanelMarkRead(
  workspaceId: string | null | undefined,
  userId: string | undefined,
  messages: GroupChatMessage[],
): void {
  const lastMarkedRef = useRef<{ wsId: string; createdAtMs: number } | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Latest-messages ref so the (workspace/user)-scoped visibility listener can stay stable instead
  // of re-subscribing on every snapshot.
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  // Previous workspace id, used to detect a switch inside the messages effect.
  const prevWsRef = useRef<string | null | undefined>(undefined);
  // The workspace the CURRENT `messages` list belongs to. `undefined` = "not yet known / stale"
  // (e.g. right after a switch, before the new subscription delivers its first snapshot). The
  // visibility listener gates on this so it never stamps the current workspace with a stale list.
  const messagesWorkspaceRef = useRef<string | null | undefined>(undefined);

  const markUpToNewest = (wsId: string, uId: string, msgs: GroupChatMessage[]) => {
    if (msgs.length === 0) return;
    const newest = msgs[msgs.length - 1]; // ascending order → newest is last
    const createdAtMs = newest.createdAt.getTime();
    const last = lastMarkedRef.current;
    // Already marked up to (or past) this message for this workspace → nothing to do.
    if (last && last.wsId === wsId && createdAtMs <= last.createdAtMs) return;

    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      lastMarkedRef.current = { wsId, createdAtMs };
      void markWorkspaceChatRead(wsId, uId, Timestamp.fromDate(newest.createdAt)).catch((err) =>
        console.error('Failed to mark chat read (in-panel):', err),
      );
      // Reading up to the newest message also clears this workspace's @mention glow (the mentions
      // listener in page.tsx sees the doc deletes → the switcher glow clears). Best-effort, like the
      // mark-read above; a failed clear just leaves the glow until the next read retry.
      void clearWorkspaceMentions(uId, wsId).catch(() => {});
    }, DEBOUNCE_MS);
  };

  // Mark on new arrivals while the tab is visible.
  useEffect(() => {
    if (!workspaceId || !userId) return;

    // Detect a workspace switch and update workspace-ownership bookkeeping BEFORE any visibility
    // deferral, so the visibility listener's gate stays accurate even when this mark is deferred
    // (e.g. the tab is hidden in the window between the switch and the new workspace's first
    // snapshot). `messages` is the panels' state, which is NOT cleared on a switch (the panels
    // don't remount), so on the switch commit it still belongs to the PREVIOUS workspace.
    const oldWsId = prevWsRef.current;
    const switched = prevWsRef.current !== undefined && prevWsRef.current !== workspaceId;
    prevWsRef.current = workspaceId;

    if (switched) {
      // Cancel any pending write for the old workspace, drop its baseline, and record that the
      // current messages do not (yet) belong to the new one — so neither this effect nor the
      // visibility listener stamps the new workspace's readState with the old workspace's
      // timestamps. The new workspace's first real snapshot re-runs this effect (now unchanged)
      // with belonging messages and marks correctly.
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      lastMarkedRef.current = null;
      messagesWorkspaceRef.current = undefined;
      // The user was viewing oldWsId's chat — clear its @mention glow on departure, mirroring the
      // chat-close path (page.tsx). The debounced clear above was just cancelled by this switch, so
      // fire it directly. Fire-and-forget + idempotent (no-op if no mention docs); readState logic
      // is unaffected.
      if (oldWsId && userId) {
        void clearWorkspaceMentions(userId, oldWsId).catch(() => {});
      }
      return;
    }

    // Not a switch → the current messages belong to workspaceId. Record that EVEN IF we defer the
    // actual mark below (tab hidden), so the visibility listener can mark correctly when the tab
    // returns — otherwise it would stay permanently gated off after a switch-then-hide.
    messagesWorkspaceRef.current = workspaceId;

    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;

    markUpToNewest(workspaceId, userId, messages);
    // markUpToNewest reads only refs + its args; deps are intentionally the triggers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, userId, messages]);

  // Re-mark when the tab becomes visible again (covers messages that arrived while it was hidden).
  useEffect(() => {
    if (!workspaceId || !userId || typeof document === 'undefined') return;
    const onVisibility = () => {
      if (document.visibilityState !== 'visible') return;
      // Only mark if the current messages actually belong to this workspace — right after a switch
      // the stale list still belongs to the previous workspace.
      if (messagesWorkspaceRef.current !== workspaceId) return;
      markUpToNewest(workspaceId, userId, messagesRef.current);
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, userId]);

  // Clear any pending debounce timer on unmount so no write fires after teardown.
  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );
}
