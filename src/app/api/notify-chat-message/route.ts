import { NextRequest, NextResponse } from 'next/server';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { getMessaging } from 'firebase-admin/messaging';

export const runtime = 'nodejs';
export const maxDuration = 30;
export const dynamic = 'force-dynamic';

// Initialize Firebase Admin (only once). getApps() guards double-init — safe to duplicate
// alongside the sibling share routes. This route is READ-ONLY on the workspace doc (it reads
// `members` + `name` to address the push, and never writes to it — the workspace switcher has a
// live onSnapshot that any write would re-render) and reads each recipient's fcmTokens. It writes
// ONLY token-doc deletes for tokens FCM reports as dead. It NEVER reads the message doc — messages
// are client-side encrypted and the server can neither decrypt nor inspect them; the payload is
// senderName + workspaceName only.
if (!getApps().length) {
  initializeApp({
    credential: cert({
      projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    }),
  });
}

const adminDb = getFirestore();

// FCM error codes that mean the token is permanently dead and should be removed so future sends
// don't keep failing on it. (Firebase Admin v13 SendResponse.error.code strings.)
const DEAD_TOKEN_ERRORS = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
]);

// POST /api/notify-chat-message — sends an FCM push to every OTHER member of a workspace when a
// group-chat message is sent. Called fire-and-forget from sendGroupMessage; a push failure never
// blocks or breaks the message send. Authenticated + authorized: only a workspace member may call
// it. Payload is senderName + workspaceName only (never message content). Android + desktop web
// tokens only (iOS is never registered).
export async function POST(request: NextRequest) {
  try {
    // ---- AUTH: verify the Firebase ID token ----
    const authHeader = request.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const idToken = authHeader.substring(7);
    let uid: string;
    try {
      const decoded = await getAuth().verifyIdToken(idToken);
      uid = decoded.uid;
    } catch {
      return NextResponse.json({ error: 'Invalid token' }, { status: 401 });
    }

    // ---- PARSE body: { workspaceId, messageId, senderId, senderName } ----
    const body = await request.json();
    const { workspaceId, messageId, senderId, senderName } = body as {
      workspaceId?: string;
      messageId?: string;
      senderId?: string;
      senderName?: string;
    };
    if (!workspaceId || !messageId || !senderId || !senderName) {
      return NextResponse.json({ error: 'Missing fields' }, { status: 400 });
    }

    // ---- MEMBERSHIP: read the workspace doc (READ-ONLY — never write to it). ----
    const wsDoc = await adminDb.collection('workspaces').doc(workspaceId).get();
    if (!wsDoc.exists) {
      return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
    }
    const wsData = wsDoc.data()!;
    const members: string[] = wsData.members || [];
    if (!members.includes(uid)) {
      return NextResponse.json({ error: 'Not a workspace member' }, { status: 403 });
    }
    const workspaceName: string = wsData.name || 'workspace';

    // ---- RECIPIENTS: every member EXCEPT the sender. The verified caller (uid) is the sender;
    // senderId from the body is expected to equal uid — exclude both so the sender is never
    // notified, regardless of which identifier is used. ----
    const recipients = members.filter((m) => m !== uid && m !== senderId);
    if (recipients.length === 0) {
      return NextResponse.json({ sent: 0 });
    }

    // ---- Collect every recipient FCM token. A user may have several devices (0/1/many tokens);
    // skip recipients with none. Doc id == token (Stage 1); the `token` field holds the same value. ----
    const tokenEntries: { token: string; uid: string }[] = [];
    for (const recipientUid of recipients) {
      // Skip muted members (Part B): the server-honored mute flag is on the user doc. A muted
      // member gets no push at all — even with the app closed.
      const recipientDoc = await adminDb.collection('users').doc(recipientUid).get();
      if (recipientDoc.get('notifMuted') === true) continue;
      // Scope the PLAIN-MESSAGE push to the recipient's LAST-ACTIVE workspace: skip if they last had
      // a DIFFERENT workspace open (they'll see it via the in-app Chat-button glow when they open it).
      // Absent field → push (backward compat for users who haven't switched since deploy). The user
      // doc is already fetched above for the mute check, so reuse it. @mention pushes go through a
      // SEPARATE route (notify-mention) and are NOT scoped by this — left untouched.
      const lastActiveWs = recipientDoc.get('lastActiveWorkspaceId') as string | undefined;
      if (lastActiveWs && lastActiveWs !== workspaceId) continue;
      const tokenSnap = await adminDb
        .collection('users')
        .doc(recipientUid)
        .collection('fcmTokens')
        .get();
      for (const td of tokenSnap.docs) {
        const token = (td.get('token') as string | undefined) || td.id;
        tokenEntries.push({ token, uid: recipientUid });
      }
    }
    if (tokenEntries.length === 0) {
      return NextResponse.json({ sent: 0 });
    }

    // ---- BUILD + SEND one DATA-ONLY multicast (firebase-admin v13: sendEachForMulticast, NOT the
    // deprecated sendMulticast). Data-only (no `notification` payload) lets the service worker's
    // onBackgroundMessage fully control BOTH display and the tap — no conflict with Firebase's
    // default click handler. Firebase fires the background handler only when the app is NOT in the
    // foreground, so there's no double-notification with the in-app foreground notification. Payload
    // is metadata-only (senderName + workspaceName); never message content. ----
    // `webpush.headers` set delivery URGENCY (RFC 8030) to HIGH so the push service delivers promptly
    // instead of deferring/batching when the browser/tab is closed or the device is idle — critical
    // for timely closed-app chat delivery. These are delivery-priority headers ONLY: they add NO
    // `notification` payload, so the SW still fully owns display + the tap. (android.priority is
    // omitted on purpose — every registered token is a WEB push token, so the android config is dead.)
    const batchResponse = await getMessaging().sendEachForMulticast({
      tokens: tokenEntries.map((e) => e.token),
      data: { workspaceId, senderName, workspaceName, type: 'chat' },
      webpush: { headers: { Urgency: 'high', Priority: 'high' } },
    });

    // ---- COUNT delivered + best-effort cleanup of dead tokens (fire-and-forget: do not await
    // or throw on cleanup). responses[i] corresponds to tokens[i] / tokenEntries[i]. ----
    let delivered = 0;
    batchResponse.responses.forEach((res, i) => {
      if (res.success) {
        delivered++;
        return;
      }
      if (res.error && DEAD_TOKEN_ERRORS.has(res.error.code)) {
        const entry = tokenEntries[i];
        adminDb
          .collection('users')
          .doc(entry.uid)
          .collection('fcmTokens')
          .doc(entry.token)
          .delete()
          .catch(() => {});
      }
    });

    return NextResponse.json({ sent: delivered });
  } catch (error) {
    console.error('notify-chat-message error:', error);
    return NextResponse.json({ error: 'Failed to send push' }, { status: 500 });
  }
}
