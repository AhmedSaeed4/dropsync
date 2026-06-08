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
  query,
  orderBy,
  limit,
  onSnapshot,
  serverTimestamp,
} from 'firebase/firestore';
import { db } from './firebase';
import { encryptData, decryptData } from './crypto';
import { getWorkspaceKey } from './keys';
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

  const q = query(
    collection(db, 'workspaces', workspaceId, 'messages'),
    orderBy('createdAt', 'asc'),
    limit(MAX_MESSAGES),
  );

  return onSnapshot(q, async (snapshot) => {
    // Fetch workspace key once (or reuse cached)
    if (!keyFetched) {
      cachedKey = await getWorkspaceKey(workspaceId, userId);
      keyFetched = true;
    }

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
        });
      }
    }

    callback(messages);
  }, (error) => {
    // Permission denied = user left workspace or doesn't have access
    console.error('Group chat subscription error:', error.message);
    callback([]);
  });
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
): Promise<string | null> {
  try {
    const workspaceKey = await getWorkspaceKey(workspaceId, userId);
    if (!workspaceKey) {
      console.error('No workspace key available for group chat');
      return null;
    }

    const { encrypted, iv } = await encryptData(content, workspaceKey);

    const docRef = await addDoc(
      collection(db, 'workspaces', workspaceId, 'messages'),
      {
        senderId: userId,
        senderName,
        content: encrypted,
        encrypted: true,
        iv,
        createdAt: serverTimestamp(),
      },
    );

    return docRef.id;
  } catch (error) {
    console.error('Error sending group message:', error);
    return null;
  }
}

/**
 * Delete a group chat message.
 * Firestore security rules enforce that only the sender can delete their own messages.
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
