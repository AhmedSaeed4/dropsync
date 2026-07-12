// Chat service worker + Firebase Cloud Messaging background handler (desktop + Android).
//
// Two jobs:
//   1. Foreground chat notifications on mobile (mobile browsers can't use `new Notification()`,
//      so they must show notifications through a service worker).
//   2. FCM background push: load the Firebase compat messaging SDK so WE show + control the push
//      notification. Pushes are DATA-ONLY (the route sends no `notification` payload), so
//      onBackgroundMessage displays them (title/body/tag/icon of our choosing) AND we own the tap
//      handler — no conflict with Firebase's default click behavior. Works with the app/tab closed
//      (the browser wakes this worker on push). Loaded from the gstatic CDN pinned to the installed
//      SDK version (12.10.0) to avoid a main-thread/SW version mismatch. iOS is skipped at register.
//
// There is NO fetch handler here, so this worker does not intercept or cache network traffic.

// --- FCM background push (compat SDK, classic worker) ---
// The compat importScripts bundle is used so this stays a classic worker (registered without
// { type: 'module' }); sw.js is served verbatim from public/, so bare ESM imports wouldn't resolve.
importScripts('https://www.gstatic.com/firebasejs/12.10.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/12.10.0/firebase-messaging-compat.js');

// Full Firebase web config (NOT just messagingSenderId): in the v9+ SDK, FCM depends on Firebase
// Installations, which validates apiKey / appId / projectId at init — without them firebase.messaging()
// throws "Installations: Missing App configuration value: projectId" and the worker fails to evaluate,
// so no token is ever saved. These literals MUST stay in sync with src/lib/firebase.ts and the
// NEXT_PUBLIC_FIREBASE_* env vars. They are public web config (shipped to every client anyway) and are
// safe to inline — security is enforced by Firestore Rules, not by hiding the config. A static SW
// cannot read process.env at runtime, so the values are resolved to literals here.
firebase.initializeApp({
  apiKey: 'AIzaSyD39ZIXDM6dSd4KMVLzmcrRdPnlJX1qhM4',
  authDomain: 'dropsync-1773445054.firebaseapp.com',
  projectId: 'dropsync-1773445054',
  storageBucket: 'dropsync-1773445054.firebasestorage.app',
  messagingSenderId: '459321423349',
  appId: '1:459321423349:web:1602b68480c3d7cd855cbc',
});

const messaging = firebase.messaging();

// Show the notification ourselves for DATA-ONLY pushes (the route sends no `notification` payload,
// so Firebase won't auto-display). Firebase fires this background handler only when the app is NOT in
// the foreground, so it never doubles up with the in-app foreground notification. `tag` collapses
// rapid messages in the same workspace; `data.workspaceId` lets the tap handler deep-link the chat.
messaging.onBackgroundMessage((payload) => {
  const d = (payload && payload.data) || {};
  const wsId = d.workspaceId || '';
  // @mention push — distinct tag (dropsync-mention-<wsId>) so a later plain message in the same
  // workspace can't collapse it, + mention-specific copy. Tap reuses the same deep-link pipeline.
  if (d.type === 'mention') {
    self.registration.showNotification((d.senderName || 'Someone') + ' tagged you', {
      body: 'In ' + (d.workspaceName || 'workspace'),
      tag: 'dropsync-mention-' + wsId,
      data: { workspaceId: wsId },
      icon: '/icon.svg?v=2',
    });
    return;
  }
  self.registration.showNotification(d.senderName || 'New message', {
    body: 'Sent a message in ' + (d.workspaceName || 'workspace'),
    tag: 'dropsync-chat-' + wsId,
    data: { workspaceId: wsId },
    icon: '/icon.svg?v=2',
  });
});

// Take over immediately when a new version installs.
self.addEventListener('install', () => {
  self.skipWaiting();
});

// Control all open clients (tabs) as soon as it activates.
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// Tapping a push (or a foreground chat notification) opens the app and jumps into that workspace's
// group chat. Reads workspaceId from the notification's data (set by onBackgroundMessage above);
// falls back gracefully for foreground notifications that carry no workspaceId.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const wsId = (event.notification.data && event.notification.data.workspaceId) || '';
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (all.length > 0) {
      const client = all[0];
      await client.focus();
      client.postMessage({ type: 'OPEN_CHAT', workspaceId: wsId });
    } else {
      await self.clients.openWindow(wsId ? '/?chat=' + wsId : '/');
    }
  })());
});
