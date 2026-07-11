// Group chat typing + presence — thin plaintext data helpers.
//
// Both collections are EPHEMERAL PLAINTEXT docs. They never touch encryptData/getWorkspaceKey/
// decryptData, never enter the /api/notify-chat-message push path, and never get added to message
// docs. Identity = doc path (workspaces/{ws}/{typing|presence}/{uid}); readers resolve display
// names from the trusted workspaceMembers prop, NEVER from a stored field (prevents spoofing).
//
// All client timestamps use Timestamp.fromDate(new Date()) — NEVER serverTimestamp(). The client
// computes the TTL/grace; a serverTimestamp reads back null transiently and breaks the age diff.

import { collection, doc, onSnapshot, setDoc, Timestamp } from 'firebase/firestore';
import { db } from './firebase';

/** Typing docs expire (treated as not-typing) after this many ms. */
export const TYPING_TTL_MS = 10000;
/** A presence doc is considered stale (offline) once lastSeen is older than this many ms. */
export const PRESENCE_GRACE_MS = 25000;

export interface TypingEntry {
  uid: string;
  isTyping: boolean;
  atMs: number;
}
export interface PresenceEntry {
  uid: string;
  lastSeenMs: number;
  online: boolean;
}

/**
 * Subscribe to group-chat typing docs via a PLAIN onSnapshot (no decryption).
 *
 * Defensive parse is mandatory: the firestore write rules do NOT validate field types, so a member
 * with console access could otherwise inject a non-timestamp `at` (kills typing for the whole
 * workspace when toMillis is called) or a future-dated `at` (perpetual "typing"). We type-check the
 * timestamp (toMillis must be a function) + the isTyping boolean, and range-check the age
 * (0 <= age < TYPING_TTL_MS — future/negative docs and already-stale docs are dropped). Malformed
 * docs are skipped SILENTLY; the listener never throws.
 */
export function subscribeToTyping(
  workspaceId: string,
  cb: (entries: TypingEntry[]) => void,
): () => void {
  let cancelled = false;
  const unsub = onSnapshot(
    collection(db, 'workspaces', workspaceId, 'typing'),
    (snap) => {
      if (cancelled) return;
      const now = Date.now();
      const out: TypingEntry[] = [];
      snap.forEach((d) => {
        const data = d.data() as { at?: { toMillis?: unknown }; isTyping?: unknown };
        if (typeof data.at?.toMillis !== 'function') return;
        if (typeof data.isTyping !== 'boolean') return;
        const atMs = (data.at as { toMillis: () => number }).toMillis();
        const age = now - atMs;
        if (age < 0 || age >= TYPING_TTL_MS) return; // future-dated or already stale
        out.push({ uid: d.id, isTyping: data.isTyping, atMs });
      });
      cb(out);
    },
    () => {
      // Swallow listener errors silently — never throw.
    },
  );
  return () => {
    cancelled = true;
    unsub();
  };
}

/** Write (merge) the current user's typing state. Transition-only — never call per keystroke. */
export async function setTyping(
  workspaceId: string,
  userId: string,
  isTyping: boolean,
): Promise<void> {
  await setDoc(
    doc(db, 'workspaces', workspaceId, 'typing', userId),
    { isTyping, at: Timestamp.fromDate(new Date()) },
    { merge: true },
  );
}

/**
 * Subscribe to workspace presence docs via a PLAIN onSnapshot (no decryption).
 *
 * Defensive parse: type-check lastSeen (toMillis must be a function) and reject future-dated/negative
 * docs (age < 0) — a future-dated lastSeen would otherwise read as perpetually online. We do NOT
 * upper-bound the age here: the members popover needs to show OFFLINE members with a "last seen X
 * ago" line even when they have been away for hours, so stale docs must survive to the reader's
 * output. The online/stale determination (age < PRESENCE_GRACE_MS) is applied by the usePresence
 * hook's derive step + its 5s re-filter. Malformed docs are skipped silently.
 */
export function subscribeToPresence(
  workspaceId: string,
  cb: (entries: PresenceEntry[]) => void,
): () => void {
  let cancelled = false;
  const unsub = onSnapshot(
    collection(db, 'workspaces', workspaceId, 'presence'),
    (snap) => {
      if (cancelled) return;
      const out: PresenceEntry[] = [];
      snap.forEach((d) => {
        const data = d.data() as { lastSeen?: { toMillis?: unknown }; online?: unknown };
        if (typeof data.lastSeen?.toMillis !== 'function') return;
        const lastSeenMs = (data.lastSeen as { toMillis: () => number }).toMillis();
        if (Date.now() - lastSeenMs < 0) return; // future-dated → ignore
        out.push({ uid: d.id, lastSeenMs, online: data.online === true });
      });
      cb(out);
    },
    () => {
      // Swallow listener errors silently — never throw.
    },
  );
  return () => {
    cancelled = true;
    unsub();
  };
}

/**
 * Heartbeat write. First beat (isFirst true) sets { lastSeen, online: true }; later beats refresh
 * lastSeen only (online was already set true by the first beat / the visibility handler and stays
 * true until a hide event calls setPresenceOffline). The `online` flag is a fast-off hint; lastSeen
 * freshness is the source of truth.
 */
export async function updatePresence(
  workspaceId: string,
  userId: string,
  isFirst: boolean,
): Promise<void> {
  const lastSeen = Timestamp.fromDate(new Date());
  await setDoc(
    doc(db, 'workspaces', workspaceId, 'presence', userId),
    isFirst ? { lastSeen, online: true } : { lastSeen },
    { merge: true },
  );
}

/** Fast-off signal: write { online: false, lastSeen } on tab-hide / pagehide (best-effort). */
export async function setPresenceOffline(
  workspaceId: string,
  userId: string,
): Promise<void> {
  await setDoc(
    doc(db, 'workspaces', workspaceId, 'presence', userId),
    { online: false, lastSeen: Timestamp.fromDate(new Date()) },
    { merge: true },
  );
}

/** "Last seen Xm/Xh/Xd ago" formatter for the members popover. */
export function formatLastSeen(lastSeenMs: number): string {
  const diff = Date.now() - lastSeenMs;
  if (diff < 60_000) return 'just now';
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}
