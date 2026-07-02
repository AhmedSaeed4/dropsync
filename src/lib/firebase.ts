import { initializeApp, type FirebaseApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import {
  getFirestore,
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  type Firestore,
} from 'firebase/firestore';
import { getStorage } from 'firebase/storage';
import { getMessaging } from 'firebase/messaging';

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);

// Browser: enable IndexedDB-backed Firestore persistence (multi-tab aware) so in-flight writes —
// chiefly the chat mark-read write at workspaces/{ws}/readState/{uid} — survive a tab close /
// device sleep / dropped connection and are replayed on the next load. Without it Firestore is
// memory-only: a mark-read write that doesn't finish before the tab dies is lost, and already-read
// messages recount as unread on the next cold start (the phantom-unread-glow bug). This is paired
// with a flush-on-hidden handler (page.tsx) and awaiting the mark-read write.
// Server/SSR: IndexedDB does not exist during prerender, so use plain getFirestore(app) there.
// initializeFirestore throws if Firestore is already initialized for this app (e.g. HMR
// re-evaluating this module) — on throw, getFirestore(app) returns the already-initialized
// (persistent) instance, so the call is idempotent across hot reloads.
function initPersistentDb(firebaseApp: FirebaseApp): Firestore {
  try {
    return initializeFirestore(firebaseApp, {
      localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
    });
  } catch {
    return getFirestore(firebaseApp);
  }
}

export const db = typeof window !== 'undefined' ? initPersistentDb(app) : getFirestore(app);
export const storage = getStorage(app);

// Firebase Cloud Messaging instance (web push). Browser-only: getMessaging(app) touches browser
// APIs at construction and throws "unsupported-browser" in a non-browser, so it must NOT run
// during SSR / prerender. Guarded on typeof window so importing this module on the server is
// safe; client code (notifications.ts) uses it only after its own window guard, where it's
// non-null.
export const messaging = typeof window !== 'undefined' ? getMessaging(app) : null;