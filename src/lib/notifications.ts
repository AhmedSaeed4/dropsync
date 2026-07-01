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

// localStorage key recording the FCM token we last registered on this device, so registration is
// idempotent across reloads (see ensureFcmToken). The token is already client-accessible (the SDK
// holds it in IndexedDB); storing it here adds no new exposure.
const FCM_TOKEN_KEY = 'dropsync-fcm-token';

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
 * (the doc id is the token string). Idempotent: getToken returns the existing token while the SW
 * grant is valid, and re-writing the same doc id just refreshes createdAt. Fire-and-forget from
 * callers — it never throws. No-ops without a VAPID key (warns), without a signed-in user, on
 * iOS Safari, or where serviceWorker/messaging is unavailable.
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

    // Idempotent registration: only write when this exact token isn't already registered on this
    // device. The Firestore rule allows CREATE of your own token doc but blocks read AND update
    // (`allow read: if false`, `allow update: if false`) — so we can't check existence server-side, and
    // a reload that re-runs setDoc would be treated as an update and throw "permission-denied" (the
    // reload warning this fixes). We remember the last registered token in localStorage instead. A
    // permission-denied on the write (doc already exists — e.g. first load after this change, before
    // the flag is set) is treated as "already registered".
    let alreadyRegistered = false;
    try { alreadyRegistered = localStorage.getItem(FCM_TOKEN_KEY) === token; } catch {}
    if (!alreadyRegistered) {
      const tokenDocRef = doc(db, 'users', uid, 'fcmTokens', token);
      try {
        await setDoc(tokenDocRef, { uid, token, createdAt: serverTimestamp() });
      } catch (writeErr) {
        // permission-denied ⟹ the doc already exists (create is allowed for your own token) ⟹ already
        // registered. Anything else is a real error → rethrow to the outer catch.
        if ((writeErr as { code?: string }).code !== 'permission-denied') throw writeErr;
      }
      try { localStorage.setItem(FCM_TOKEN_KEY, token); } catch {}
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
    // Clear the local "registered" flag so a later sign-in re-registers (getToken mints a fresh
    // token after deleteToken).
    try { localStorage.removeItem(FCM_TOKEN_KEY); } catch {}
  } catch {
    // best-effort — never throw to the caller
  }
}
