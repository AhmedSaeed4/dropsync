/**
 * Browser chat notifications — FOREGROUND ONLY.
 * No server, no FCM, no push messaging: notifications are shown only while the app/tab
 * is open. Android mobile shows them through a service worker (see
 * registerChatServiceWorker); desktop uses the Notification constructor directly and never
 * registers a service worker. Reads the plain (unencrypted) `senderName` field from message
 * docs, so no workspace-key decryption is needed to show "New message from X".
 *
 * Permission model: ask once on first chat open (user gesture); a settings toggle
 * mutes/unmutes after that. iPhone/iPad Safari has no Notification API → detected
 * and disabled in the UI.
 */

/** True where the Notification API exists (guards SSR). */
export function isNotificationsSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

/**
 * Detect iPhone/iPad Safari, which does not support the Notification API.
 * Excludes Chrome/Firefox-on-iOS (crios/fxios) and Edge's MSStream UA trick.
 */
export function isIOSSafari(): boolean {
  if (typeof navigator === 'undefined' || typeof window === 'undefined') return false;
  const ua = navigator.userAgent;
  const isIOS = /iPad|iPhone|iPod/.test(ua);
  const isSafari = /^((?!chrome|android|crios|fxios).)*safari/i.test(ua);
  return isIOS && isSafari && !(window as unknown as { MSStream?: unknown }).MSStream;
}

/** Current permission, or 'denied' if unsupported (so the UI treats it as off). */
export function getNotificationPermission(): NotificationPermission {
  if (!isNotificationsSupported()) return 'denied';
  return Notification.permission;
}

/** Request permission (must be called from a user gesture). Resolves to the result. */
export async function requestNotificationPermission(): Promise<NotificationPermission> {
  if (!isNotificationsSupported()) return 'denied';
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

/**
 * Fire a chat notification. `tag` makes repeat notifications REPLACE rather than
 * stack (spam control). Clicking focuses the window and runs `onClick` (open chat).
 */
export function showChatNotification(
  senderName: string,
  workspaceName: string,
  onClick: () => void,
): void {
  if (!isNotificationsSupported() || Notification.permission !== 'granted') return;

  // Android mobile browsers can't use `new Notification()` (throws "Illegal constructor" and
  // fails silently) — they require showing notifications through a service worker. iOS Safari
  // is excluded (no Notification API). The `onClick` param is unused on this branch; the SW's
  // notificationclick + the page's message listener handle opening the chat instead.
  const isMobile = typeof window !== 'undefined' && window.matchMedia('(max-width: 1023px)').matches;
  if (isMobile && !isIOSSafari() && 'serviceWorker' in navigator) {
    (async () => {
      try {
        const reg = await navigator.serviceWorker.ready;
        await reg.showNotification(`New message from ${senderName}`, {
          body: `In ${workspaceName}`,
          tag: 'dropsync-chat',
          icon: '/icon.svg?v=2',
        });
      } catch (e) {
        console.error('Notification failed:', e);
      }
    })();
    return;
  }

  try {
    const n = new Notification(`New message from ${senderName}`, {
      body: `In ${workspaceName}`,
      tag: 'dropsync-chat', // shared tag → replaces, never stacks
      icon: '/icon.svg?v=2',
    });
    n.onclick = () => {
      window.focus();
      onClick();
      n.close();
    };
  } catch (e) {
    console.error('Notification failed:', e);
  }
}

/**
 * Register the chat service worker (Android mobile only). Mobile needs a SW to show
 * notifications; desktop uses `new Notification()` directly and must never register one.
 * Gated to: supported + non-iOS + serviceWorker available + mobile breakpoint. Registration
 * failure is swallowed (never breaks the app or affects desktop). No-op everywhere else.
 */
export async function registerChatServiceWorker(): Promise<void> {
  if (typeof window === 'undefined') return;
  if (!isNotificationsSupported() || isIOSSafari()) return;
  if (!('serviceWorker' in navigator)) return;
  if (!window.matchMedia('(max-width: 1023px)').matches) return;
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
