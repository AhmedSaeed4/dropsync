/**
 * Browser chat notifications (foreground) + FCM device registration (push foundation).
 *
 * Foreground chat notifications are still shown only while the app/tab is open — through a
 * service worker on Android and `new Notification()` on desktop. On top of that, this module
 * registers each user's device for Firebase Cloud Messaging via ensureFcmToken(), persisting a
 * per-device push token under users/{uid}/fcmTokens/{token}. No push is sent from here yet
 * (sending is a later stage) — this is registration only. The service worker (public/sw.js)
 * loads the FCM SDK so it can auto-display push notifications, including when the app is closed.
 *
 * Reads the plain (unencrypted) `senderName` field from message docs, so no workspace-key
 * decryption is needed for the foreground "New message from X" notification.
 *
 * Permission model: ask once on first chat open (user gesture); a settings toggle mutes/unmutes
 * after that. iPhone/iPad Safari has no Notification API → detected and disabled in the UI.
 */

import { getAuth } from 'firebase/auth';
import { doc, setDoc, deleteDoc, serverTimestamp } from 'firebase/firestore';
import { getToken, deleteToken } from 'firebase/messaging';
import { db, messaging } from './firebase';

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
  let result: NotificationPermission;
  try {
    result = await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
  // Permission was just granted — register this device for FCM push (fire-and-forget; never
  // throws). Returning users who already had permission are handled by the app-load call.
  if (result === 'granted') {
    void ensureFcmToken();
  }
  return result;
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
 * Register the chat + FCM service worker on ALL platforms (desktop + Android), so background
 * push works everywhere. The worker (public/sw.js) loads the FCM SDK and auto-displays push
 * notifications, including when the app is closed; it also shows foreground chat notifications on
 * mobile (which can't use `new Notification()`). iOS Safari is skipped (no Notification API), and
 * so is any browser without serviceWorker. Registration failure is swallowed (never breaks the
 * app). No fetch handler → the worker does not intercept or cache network traffic.
 */
export async function registerChatServiceWorker(): Promise<void> {
  if (typeof window === 'undefined') return;
  if (!isNotificationsSupported() || isIOSSafari()) return;
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

/**
 * Register this device for FCM push and persist its token at users/{uid}/fcmTokens/{token}
 * (the doc id is the token string). Always attempts the write: if the doc is ABSENT this CREATEs it
 * (re-registers — e.g. after a stale-token cleanup deleted it); if it EXISTS the rule blocks the
 * UPDATE (permission-denied) and we treat that as "already registered" (silent). We deliberately do
 * NOT cache "already registered" in localStorage — that flag goes stale if the doc is ever deleted,
 * which would make us skip the write and never recreate the token. Fire-and-forget from callers — it
 * never throws. No-ops without a VAPID key (warns), without a signed-in user, on iOS Safari, or
 * where serviceWorker/messaging is unavailable.
 *
 * The VAPID public key comes from NEXT_PUBLIC_VAPID_KEY (added by the operator). If it is
 * missing we log a warning and bail out instead of letting getToken throw, so the app keeps
 * working — push simply won't register until the key is configured.
 */
export async function ensureFcmToken(): Promise<void> {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator) || isIOSSafari()) return;
  if (!messaging) return; // SSR / unsupported browser — messaging is null off the client
  const vapidKey = process.env.NEXT_PUBLIC_VAPID_KEY;
  if (!vapidKey) {
    console.warn('[FCM] NEXT_PUBLIC_VAPID_KEY is not set — skipping push token registration.');
    return;
  }

  // The token is stored under the signed-in user's uid; if auth hasn't resolved yet, bail out
  // (the app-load caller re-invokes once the user is available).
  const uid = getAuth().currentUser?.uid;
  if (!uid) return;

  try {
    // Register /sw.js (idempotent) and hand that registration to FCM so background push is wired
    // to the worker that loads the FCM SDK.
    const serviceWorkerRegistration = await navigator.serviceWorker.register('/sw.js');
    const token = await getToken(messaging, { vapidKey, serviceWorkerRegistration });
    if (!token) return;

    // Always write the token doc. If it's ABSENT this CREATEs it (re-registers — e.g. after a
    // stale-token cleanup deleted it). If it EXISTS this is an UPDATE, which the rule blocks
    // (`allow update: if false`) → permission-denied → swallowed below as "already registered" (no
    // reload warning). Any other error is rethrown to the outer catch. No localStorage "already
    // registered" flag: it goes stale when the doc is deleted, which would make us skip the write
    // and never recreate the token (the bug this fixes).
    const tokenDocRef = doc(db, 'users', uid, 'fcmTokens', token);
    try {
      await setDoc(tokenDocRef, { uid, token, createdAt: serverTimestamp() });
    } catch (writeErr) {
      // permission-denied ⟹ doc already exists (create is allowed for your own token) ⟹ silently registered.
      // Anything else is a real error → rethrow to the outer catch.
      if ((writeErr as { code?: string }).code !== 'permission-denied') throw writeErr;
    }
  } catch (e) {
    console.warn('[FCM] Could not register push token:', e);
  }
}

/**
 * Remove this device's push token: deletes the users/{uid}/fcmTokens/{token} doc and invalidates the
 * token with FCM (deleteToken). Called on sign-out so a shared computer stops receiving this user's
 * pushes. Best-effort — never throws. No-ops without a user/token/messaging or on unsupported browsers.
 */
export async function clearFcmToken(): Promise<void> {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator) || isIOSSafari()) return;
  if (!messaging) return;
  const vapidKey = process.env.NEXT_PUBLIC_VAPID_KEY;
  if (!vapidKey) return;
  const uid = getAuth().currentUser?.uid;
  if (!uid) return;
  try {
    const token = await getToken(messaging, { vapidKey });
    if (!token) return;
    await deleteDoc(doc(db, 'users', uid, 'fcmTokens', token));
    await deleteToken(messaging);
  } catch {
    // best-effort — never throw to the caller
  }
}
