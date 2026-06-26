// Minimal service worker for foreground chat notifications on Android mobile browsers.
// Mobile browsers cannot use `new Notification()` ("Illegal constructor"); they must show
// notifications through a service worker. Desktop never registers this worker (registration
// is gated to mobile in registerChatServiceWorker). There is NO fetch handler here, so this
// worker does not intercept or cache any network traffic — it is purely passive.

// Take over immediately when a new version installs.
self.addEventListener('install', () => {
  self.skipWaiting();
});

// Control all open clients (tabs) as soon as it activates.
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// Tapping a chat notification focuses an existing tab and tells it to open the group chat;
// if none is open, a new one is launched at the app root.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (all.length > 0) {
      const client = all[0];
      await client.focus();
      client.postMessage({ type: 'OPEN_CHAT' });
    } else {
      await self.clients.openWindow('/');
    }
  })());
});
