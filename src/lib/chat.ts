import {
  collection,
  query,
  orderBy,
  limit,
  onSnapshot,
  serverTimestamp,
  getDocs,
  deleteDoc,
  doc,
  setDoc,
  updateDoc,
} from 'firebase/firestore';
import { db } from './firebase';

const CHATS_COLLECTION = 'chats';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: Date;
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: Date;
  updatedAt: Date;
}

// ── Conversations ──────────────────────────────────────────────

export async function createConversation(userId: string, title: string = 'New chat'): Promise<string> {
  const docRef = doc(collection(db, CHATS_COLLECTION, userId, 'conversations'));
  await setDoc(docRef, {
    title,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  return docRef.id;
}

export async function listConversations(userId: string): Promise<Conversation[]> {
  const q = query(
    collection(db, CHATS_COLLECTION, userId, 'conversations'),
    orderBy('updatedAt', 'desc'),
  );
  const snapshot = await getDocs(q);
  return snapshot.docs.map((d) => {
    const data = d.data();
    return {
      id: d.id,
      title: data.title,
      createdAt: data.createdAt?.toDate() || new Date(),
      updatedAt: data.updatedAt?.toDate() || new Date(),
    };
  });
}

export async function updateConversationTitle(userId: string, convId: string, title: string): Promise<void> {
  await updateDoc(doc(db, CHATS_COLLECTION, userId, 'conversations', convId), {
    title,
    updatedAt: serverTimestamp(),
  });
}

export async function deleteConversation(userId: string, convId: string): Promise<void> {
  // Delete all messages in the conversation
  const q = query(collection(db, CHATS_COLLECTION, userId, 'conversations', convId, 'messages'));
  const snapshot = await getDocs(q);
  await Promise.all(snapshot.docs.map((d) => deleteDoc(d.ref)));
  // Delete the conversation itself
  await deleteDoc(doc(db, CHATS_COLLECTION, userId, 'conversations', convId));
}

// ── Messages ───────────────────────────────────────────────────

export function subscribeToMessages(
  userId: string,
  convId: string,
  callback: (messages: ChatMessage[]) => void,
  maxMessages: number = 100,
): () => void {
  const q = query(
    collection(db, CHATS_COLLECTION, userId, 'conversations', convId, 'messages'),
    orderBy('createdAt', 'asc'),
    limit(maxMessages),
  );

  return onSnapshot(q, (snapshot) => {
    const messages: ChatMessage[] = [];
    snapshot.forEach((document) => {
      const data = document.data();
      messages.push({
        id: document.id,
        role: data.role,
        content: data.content,
        createdAt: data.createdAt?.toDate() || new Date(),
      });
    });
    callback(messages);
  });
}

export async function saveMessage(
  userId: string,
  convId: string,
  role: 'user' | 'assistant',
  content: string,
  onId?: (id: string) => void,
): Promise<string | null> {
  try {
    // Pre-create the doc ref so the id is knowable BEFORE the write: onId fires
    // synchronously, ahead of any await — callers use it to set UI handoff state (which
    // saved message the streaming bubble becomes) before Firestore's latency-compensated
    // onSnapshot echo renders the saved twin. With addDoc, the echo could beat the
    // awaited id and briefly paint a duplicate.
    const ref = doc(collection(db, CHATS_COLLECTION, userId, 'conversations', convId, 'messages'));
    onId?.(ref.id);
    await setDoc(ref, {
      role,
      content,
      createdAt: serverTimestamp(),
    });
    // Update conversation's updatedAt
    await updateDoc(doc(db, CHATS_COLLECTION, userId, 'conversations', convId), {
      updatedAt: serverTimestamp(),
    });
    return ref.id;
  } catch (error) {
    console.error('Error saving chat message:', error);
    return null;
  }
}
