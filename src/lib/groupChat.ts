/**
 * Group chat messaging for workspaces
 * Messages are AES-encrypted using the workspace key (same system as drops)
 * Stored in: workspaces/{workspaceId}/messages/{messageId}
 */

import {
  collection,
  addDoc,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  increment,
  setDoc,
  query,
  orderBy,
  limit,
  onSnapshot,
  serverTimestamp,
  Timestamp,
  updateDoc,
  where,
  writeBatch,
} from 'firebase/firestore';
import { getAuth } from 'firebase/auth';
import { db } from './firebase';
import { encryptData, decryptData } from './crypto';
import { getWorkspaceKey } from './keys';
import { extractMentionedUids } from './dropTagUtils';
import { GroupChatMessage } from '@/types';

const MAX_MESSAGES = 200;

/**
 * Subscribe to workspace group chat messages in real-time.
 * Decrypts content using the workspace encryption key.
 * Returns an unsubscribe function.
 */
export function subscribeToGroupMessages(
  workspaceId: string,
  userId: string,
  callback: (messages: GroupChatMessage[]) => void,
): () => void {
  // Cache the workspace key so we don't re-fetch on every snapshot tick
  let cachedKey: CryptoKey | null = null;
  let keyFetched = false;
  // Cancellation flag. The onSnapshot callback below is async and awaits getWorkspaceKey before it
  // invokes the panel callback; Firestore's unsubscribe() cannot cancel an already-suspended async
  // callback. Without this, a rapid workspace switch (A→B→C within B's key-fetch window) could let
  // an orphaned B callback resume and deliver B's messages into a panel now viewing C — which would
  // let a stale message list overwrite the WRONG workspace's read state (silent unread suppression).
  // Setting this on teardown and re-checking after the await guarantees a torn-down subscription
  // never delivers messages.
  let cancelled = false;

  const q = query(
    collection(db, 'workspaces', workspaceId, 'messages'),
    orderBy('createdAt', 'asc'),
    limit(MAX_MESSAGES),
  );

  const unsubscribe = onSnapshot(q, async (snapshot) => {
    if (cancelled) return;
    // Fetch workspace key once (or reuse cached)
    if (!keyFetched) {
      cachedKey = await getWorkspaceKey(workspaceId, userId);
      keyFetched = true;
    }
    // Re-check after the await — the subscription may have been torn down while we were suspended
    // (e.g. a rapid workspace switch). Never deliver a stale workspace's messages to the panel.
    if (cancelled) return;

    const messages: GroupChatMessage[] = [];

    for (const document of snapshot.docs) {
      const data = document.data();

      if (!cachedKey || !data.encrypted) {
        messages.push({
          id: document.id,
          senderId: data.senderId || '',
          senderName: data.senderName || 'Unknown',
          content: data.encrypted ? '[Decryption failed]' : (data.content || ''),
          encrypted: !!data.encrypted,
          iv: data.iv || '',
          createdAt: data.createdAt?.toDate() || new Date(),
          edited: !!data.edited,
          editedAt: data.editedAt?.toDate() ?? null,
          editCount: typeof data.editCount === 'number' ? data.editCount : 0,
          replyToMessageId: data.replyToMessageId || undefined,
        });
        continue;
      }

      try {
        const decryptedContent = await decryptData(data.content, cachedKey, data.iv);
        messages.push({
          id: document.id,
          senderId: data.senderId || '',
          senderName: data.senderName || 'Unknown',
          content: decryptedContent,
          encrypted: true,
          iv: data.iv,
          createdAt: data.createdAt?.toDate() || new Date(),
          edited: !!data.edited,
          editedAt: data.editedAt?.toDate() ?? null,
          editCount: typeof data.editCount === 'number' ? data.editCount : 0,
          replyToMessageId: data.replyToMessageId || undefined,
        });
      } catch {
        messages.push({
          id: document.id,
          senderId: data.senderId || '',
          senderName: data.senderName || 'Unknown',
          content: '[Decryption failed]',
          encrypted: true,
          iv: data.iv || '',
          createdAt: data.createdAt?.toDate() || new Date(),
          edited: !!data.edited,
          editedAt: data.editedAt?.toDate() ?? null,
          editCount: typeof data.editCount === 'number' ? data.editCount : 0,
          replyToMessageId: data.replyToMessageId || undefined,
        });
      }
    }

    callback(messages);
  }, (error) => {
    // Permission denied = user left workspace or doesn't have access
    console.error('Group chat subscription error:', error.message);
    if (!cancelled) callback([]);
  });

  return () => {
    cancelled = true;
    unsubscribe();
  };
}

/**
 * Send a text message to the workspace group chat.
 * Encrypts content with the workspace key before writing to Firestore.
 */
export async function sendGroupMessage(
  workspaceId: string,
  userId: string,
  senderName: string,
  content: string,
  replyToMessageId?: string,
): Promise<string | null> {
  try {
    const workspaceKey = await getWorkspaceKey(workspaceId, userId);
    if (!workspaceKey) {
      console.error('No workspace key available for group chat');
      return null;
    }

    const { encrypted, iv } = await encryptData(content, workspaceKey);
    // @[displayName](uid) chips live in the PLAINTEXT body; collect their uids for the plaintext,
    // create-only `mentionedUids` field. The notify route intersects these with current members
    // (abuse boundary) so a uid forged into the body still can't push to a non-member.
    const mentionedUids = extractMentionedUids(content);

    // Reply is a CREATE: it gets a fresh serverTimestamp() createdAt. replyToMessageId is a plaintext
    // pointer (NEVER encrypted) written ONLY when present — omit the key entirely when undefined so
    // we never store null. The create rule has no hasOnly allowlist, so the extra field passes; the
    // update rule's hasOnly excludes it, making it immutable after create.
    const docRef = await addDoc(
      collection(db, 'workspaces', workspaceId, 'messages'),
      {
        senderId: userId,
        senderName,
        content: encrypted,
        encrypted: true,
        iv,
        editCount: 0,            // baseline so the update rule's editCount math never hits the
                                 // missing-field branch for new messages
        createdAt: serverTimestamp(),
        ...(replyToMessageId ? { replyToMessageId } : {}),
        // @member mentions — plaintext + create-only. The update rule's hasOnly (:191) makes this
        // immutable after create (same as replyToMessageId) — that's why v1 is composer-only.
        // Omitted entirely when nobody is @mentioned, so it never stores null/empty.
        ...(mentionedUids.length > 0 ? { mentionedUids } : {}),
      },
    );

    // Fire-and-forget push (Stage 2): notify every OTHER member with registered devices. Runs in
    // the background — must NEVER block, delay, or fail the message send, so it's fully isolated
    // (its own try/catch, not awaited by this function). Only fires when addDoc produced an id.
    if (docRef.id) {
      void (async () => {
        try {
          const idToken = await getAuth().currentUser?.getIdToken();
          if (!idToken) return;
          // Two best-effort notifies, fully isolated — a failure in either NEVER blocks/delays the
          // send. notify-chat-message pings every OTHER member of THIS workspace (in-app glow/push).
          // notify-mention writes a users/{uid}/mentions doc + FCM for each @mentioned member, CROSS-
          // workspace, and BYPASSES mute (a direct @ always rings). The mention route reads
          // mentionedUids from the doc (authoritative), not the body. allSettled so one rejection
          // can't abort the other mid-flight.
          await Promise.allSettled([
            fetch('/api/notify-chat-message', {
              method: 'POST',
              headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ workspaceId, messageId: docRef.id, senderId: userId, senderName }),
            }),
            fetch('/api/notify-mention', {
              method: 'POST',
              headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ workspaceId, messageId: docRef.id }),
            }),
          ]);
        } catch {
          // Push is best-effort — never surface a failure to the chat.
        }
      })();
    }

    return docRef.id;
  } catch (error) {
    console.error('Error sending group message:', error);
    return null;
  }
}

/**
 * Delete a group chat message.
 * Firestore security rules enforce that only the sender can delete their own messages
 * or the workspace owner can delete any message.
 */
export async function deleteGroupMessage(
  workspaceId: string,
  messageId: string,
): Promise<boolean> {
  try {
    await deleteDoc(doc(db, 'workspaces', workspaceId, 'messages', messageId));
    return true;
  } catch (error) {
    console.error('Error deleting group message:', error);
    return false;
  }
}

/**
 * Edit the sender's OWN message in place (NOT delete+create): updates content/iv with a FRESH
 * encryption of `newPlaintext` via the workspace key, sets edited/editedAt, and atomically
 * increments editCount. SILENT — never calls any notify endpoint. `createdAt` is deliberately
 * omitted so Firestore preserves it: a fresh createdAt would resurrect the phantom-unread glow for
 * everyone AND re-fire an FCM push (the exact bug we just fixed). Mirrors the drops.ts edit
 * precedent — one encryptData call writing BOTH content and the fresh iv from that single result
 * (reusing the old iv is a serious AES-GCM iv-reuse break that leaks plaintext). Server-side
 * enforcement (sender-only, 24h, 10-edit cap) lives in firestore.rules; the UI only does UX gating.
 */
export async function editGroupMessage(
  workspaceId: string,
  messageId: string,
  userId: string,
  newPlaintext: string,
): Promise<boolean> {
  try {
    const workspaceKey = await getWorkspaceKey(workspaceId, userId);
    if (!workspaceKey) {
      console.error('No workspace key available to edit group message');
      return false;
    }
    const { encrypted, iv } = await encryptData(newPlaintext, workspaceKey); // ONE call → fresh iv
    const ref = doc(db, 'workspaces', workspaceId, 'messages', messageId);
    await updateDoc(ref, {
      content: encrypted,
      iv,
      encrypted: true,
      edited: true,
      editedAt: serverTimestamp(),
      editCount: increment(1),
    });
    return true;
  } catch (error) {
    console.error('Error editing group message:', error);
    return false;
  }
}

/**
 * Clear all messages from a workspace group chat.
 * Only the workspace owner can delete messages they did not send (enforced by rules).
 * Uses batched deletes in 500-document chunks.
 */
export async function clearGroupChat(workspaceId: string): Promise<void> {
  const messagesRef = collection(db, 'workspaces', workspaceId, 'messages');

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const snapshot = await getDocs(query(messagesRef, limit(500)));
    if (snapshot.empty) break;

    const batch = writeBatch(db);
    for (const document of snapshot.docs) {
      batch.delete(document.ref);
    }
    await batch.commit();
  }
}

/**
 * Read this user's last-read time for a workspace (null if never initialized).
 * Server-side read state — replaces the old localStorage fallback that broke on cold start.
 */
export async function getLastRead(workspaceId: string, userId: string): Promise<Date | null> {
  const ref = doc(db, 'workspaces', workspaceId, 'readState', userId);
  const snap = await getDoc(ref);
  if (!snap.exists()) return null;
  const ts = snap.data().lastReadAt as Timestamp | undefined;
  return ts ? ts.toDate() : null;
}

/**
 * Mark everything as read up to the newest message the user has seen. Pass `newestSeenCreatedAt`
 * (an already-resolved message Timestamp) so lastReadAt shares the same time base as the messages
 * it is compared against — no independent serverTimestamp() resolution, hence no cross-write clock
 * skew that could leave the newest message falsely counted as unread (Cause C). Falls back to
 * serverTimestamp() only when no message is available (e.g. an empty workspace, or a caller with
 * no message context). Backward-compatible: lastReadAt stays a Timestamp field; existing readState
 * docs keep working and pick up the derived value on the next mark-read.
 */
export async function markWorkspaceChatRead(
  workspaceId: string,
  userId: string,
  newestSeenCreatedAt?: Timestamp,
): Promise<void> {
  const ref = doc(db, 'workspaces', workspaceId, 'readState', userId);
  await setDoc(ref, { lastReadAt: newestSeenCreatedAt ?? serverTimestamp() }, { merge: true });
}

/**
 * One-time init: baseline = the newest existing message's time (NOT 1970, NOT serverTimestamp).
 * Called when no readState doc exists yet, so existing messages aren't falsely counted as unread.
 */
export async function initReadState(workspaceId: string, userId: string, baseline: Date): Promise<void> {
  const ref = doc(db, 'workspaces', workspaceId, 'readState', userId);
  await setDoc(ref, { lastReadAt: Timestamp.fromDate(baseline) }, { merge: true });
}

/**
 * On-demand: which members have read message `messageId`. Server-derived from readState cursors via
 * the read-only /api/chat-seen-by route (the client readState rule is self-only, so the cross-member
 * derivation must run server-side through the Admin SDK). Returns only the seen-uid list — never raw
 * timestamps. One call per "Seen" tap (no live listener). Mirrors sendGroupMessage's notify-call
 * auth pattern (getIdToken + Bearer fetch).
 */
export async function getSeenBy(workspaceId: string, messageId: string): Promise<string[]> {
  const idToken = await getAuth().currentUser?.getIdToken();
  if (!idToken) throw new Error('Not authenticated');
  const res = await fetch('/api/chat-seen-by', {
    method: 'POST',
    headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspaceId, messageId }),
  });
  if (!res.ok) throw new Error(`seen-by failed: ${res.status}`);
  const { seenUids } = (await res.json()) as { seenUids: string[] };
  return seenUids;
}

/**
 * Delete this user's @mention docs for ONE workspace — called when they read that workspace's chat,
 * so the switcher glow + system notification clear once they've actually seen it. Client-side delete
 * is allowed by the users/{uid}/mentions self-only rule. Best-effort: never throws to the caller
 * (a failed clear just leaves the glow until the next read retry).
 */
export async function clearWorkspaceMentions(userId: string, workspaceId: string): Promise<void> {
  try {
    const snap = await getDocs(query(collection(db, 'users', userId, 'mentions'), where('workspaceId', '==', workspaceId)));
    if (snap.empty) return;
    const batch = writeBatch(db);
    snap.forEach((d) => batch.delete(d.ref));
    await batch.commit();
  } catch (error) {
    console.error('Error clearing workspace mentions:', error);
  }
}
