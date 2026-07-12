import { NextRequest, NextResponse } from 'next/server';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { getMessaging } from 'firebase-admin/messaging';

export const runtime = 'nodejs';
export const maxDuration = 30;
export const dynamic = 'force-dynamic';

// Initialize Firebase Admin (only once). getApps() guards double-init — safe alongside the sibling
// share/chat-notify routes. This route writes users/{uid}/mentions docs (Admin SDK bypasses rules)
// and sends FCM pushes. It reads ONLY plaintext message fields (mentionedUids/createdAt/senderId/
// senderName) — it NEVER reads `content` or `iv` (the message body is AES-256-GCM encrypted and the
// server can neither decrypt nor inspect it).
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

// FCM error codes that mean the token is permanently dead and should be removed.
const DEAD_TOKEN_ERRORS = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
]);

// POST /api/notify-mention — when a group-chat message @mentions workspace members, write each
// mentioned member a users/{uid}/mentions doc (drives the cross-workspace switcher glow + the
// foreground system notification) and send them an FCM push (for closed-app delivery). Called
// fire-and-forget from sendGroupMessage; a failure never blocks the message send. Authenticated +
// authorized: only a workspace member may call it. Mentions BYPASS notifMuted (a direct @ always
// rings) — deliberate divergence from notify-chat-message, which skips muted members.
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

    // ---- PARSE body: { workspaceId, messageId } (mentionedUids is read from the doc, NOT the body) ----
    const body = await request.json();
    const { workspaceId, messageId } = body as { workspaceId?: string; messageId?: string };
    if (!workspaceId || !messageId) {
      return NextResponse.json({ error: 'Missing fields' }, { status: 400 });
    }

    // ---- MEMBERSHIP: read the workspace doc (scopes the CALLER/sender). ----
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

    // ---- Read the message doc — PLAINTEXT FIELDS ONLY. NEVER read content/iv. ----
    const msgDoc = await adminDb.collection('workspaces').doc(workspaceId).collection('messages').doc(messageId).get();
    if (!msgDoc.exists) {
      return NextResponse.json({ written: 0, sent: 0 });
    }
    const msgData = msgDoc.data()!;
    const mentionedUidsRaw = msgData.mentionedUids as string[] | undefined;
    const senderId = msgData.senderId as string | undefined;
    const senderName = (msgData.senderName as string | undefined) || 'Someone';
    if (!Array.isArray(mentionedUidsRaw) || mentionedUidsRaw.length === 0) {
      return NextResponse.json({ written: 0, sent: 0 });
    }

    // Bind the call to the COMPOSER: only the message's sender may trigger its mention notifies.
    // senderId is bound to request.auth.uid at create (firestore.rules) and is immutable (absent from
    // the update allowlist), so it authoritatively identifies the composer. Without this, any
    // co-member who can READ the message could capture its id and replay this route, flooding a
    // mentioned member with un-silenceable pushes (this route deliberately bypasses notifMuted). A
    // missing senderId implies a tampered / non-conforming doc → rejected, not coerced to uid.
    if (!senderId || uid !== senderId) {
      return NextResponse.json({ error: 'Only the sender can notify mentions' }, { status: 403 });
    }

    // ---- Abuse boundary: intersect with CURRENT members; exclude sender + caller (self). ----
    // A sender can only @mention people who are currently co-members; a forged uid in the body
    // (or a since-removed member) is dropped here.
    // Abuse boundary: intersect with CURRENT members; exclude sender + caller (self). De-duped so a
    // repeated uid in mentionedUids can't produce duplicate mention docs + duplicate FCM pushes.
    const targets = [...new Set(mentionedUidsRaw.filter((m) => members.includes(m) && m !== senderId && m !== uid))];
    if (targets.length === 0) {
      return NextResponse.json({ written: 0, sent: 0 });
    }

    // ---- For each mentioned member: write a mention doc + collect their FCM tokens. ----
    // Mute is intentionally NOT checked — a direct @mention always rings (bypasses notifMuted).
    let written = 0;
    const tokenEntries: { token: string; uid: string }[] = [];
    for (const mentionedUid of targets) {
      // Mention doc — plaintext pointer back to the message. Admin SDK write bypasses the
      // users/{uid}/mentions `allow write: if false` rule. Drives the switcher glow + system notif.
      try {
        await adminDb.collection('users').doc(mentionedUid).collection('mentions').add({
          workspaceId,
          workspaceName,
          messageId,
          senderId,
          senderName,
          createdAt: new Date().toISOString(),
        });
        written++;
      } catch {
        // best-effort per recipient — a single failed doc write must not abort the rest
      }
      // FCM tokens for closed-app push. The fcmTokens subcollection is client-read-locked
      // (firestore.rules:80); the Admin SDK reads it server-side.
      try {
        const tokenSnap = await adminDb.collection('users').doc(mentionedUid).collection('fcmTokens').get();
        for (const td of tokenSnap.docs) {
          const token = (td.get('token') as string | undefined) || td.id;
          tokenEntries.push({ token, uid: mentionedUid });
        }
      } catch {
        // best-effort — token read failure for one user doesn't block others
      }
    }

    let sent = 0;
    if (tokenEntries.length > 0) {
      try {
        // One DATA-ONLY multicast (firebase-admin v13 sendEachForMulticast). type:'mention' lets the
        // service worker branch to a distinct tag + title. All values are strings. Urgency HIGH so
        // a closed app receives it promptly. No `notification` payload → the SW owns display + tap.
        const batchResponse = await getMessaging().sendEachForMulticast({
          tokens: tokenEntries.map((e) => e.token),
          data: {
            workspaceId,
            senderName,
            workspaceName,
            messageId,
            type: 'mention',
          },
          webpush: { headers: { Urgency: 'high', Priority: 'high' } },
        });

        sent = batchResponse.responses.filter((r) => r.success).length;

        // Best-effort dead-token cleanup (fire-and-forget — do not await or throw).
        batchResponse.responses.forEach((res, i) => {
          if (!res.success && res.error && DEAD_TOKEN_ERRORS.has(res.error.code)) {
            const entry = tokenEntries[i];
            adminDb.collection('users').doc(entry.uid).collection('fcmTokens').doc(entry.token).delete().catch(() => {});
          }
        });
      } catch {
        // FCM failure is best-effort — the mention doc (glow + system notif) was already written.
      }
    }

    return NextResponse.json({ written, sent });
  } catch (error) {
    console.error('notify-mention error:', error);
    return NextResponse.json({ error: 'Failed to send mention' }, { status: 500 });
  }
}
