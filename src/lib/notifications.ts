/**
 * Browser desktop chat notifications — FOREGROUND ONLY.
 * No server, no FCM, no service worker. Fires OS-level notifications while the
 * app/tab is open. Reads the plain (unencrypted) `senderName` field from message
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
  try {
    const n = new Notification(`New message from ${senderName}`, {
      body: `In ${workspaceName}`,
      tag: 'dropsync-chat', // shared tag → replaces, never stacks
      icon: '/icon.svg',
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
