import { NextRequest, NextResponse } from 'next/server';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

export const runtime = 'nodejs';
export const maxDuration = 30;
export const dynamic = 'force-dynamic';

// READ-ONLY "seen by" route. Derives which workspace members have read a given group-chat message
// WITHOUT weakening the self-only readState client rule. The derivation is: "member X has read
// message M" === X.lastReadAt >= M.createdAt — lastReadAt is the createdAt of the newest message X
// has read up to (NOT a wall-clock "when"), the same skew-free comparator the unread-glow already
// trusts. The Firestore readState rule is self-only (a client cannot read another member's cursor),
// so this runs through the Admin SDK which bypasses rules: it reads the message doc's PLAINTEXT
// metadata (createdAt + senderId — NEVER the encrypted content/iv) plus each member's readState
// cursor, and returns ONLY the seen-uid list. No raw timestamps leak to other members. The route
// never writes, never decrypts, never pushes.
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

// POST /api/chat-seen-by — returns { seenUids: string[] }: the workspace members (excluding the
// sender/viewer) whose readState cursor is at/past message `messageId`'s createdAt. Called on demand
// from the group-chat message action menu ("Seen", own messages only). Authenticated + authorized:
// only a current workspace member may call it (the response is member-privacy data).
export async function POST(request: NextRequest) {
  try {
    // ---- AUTH: verify the Firebase ID token (mirrors notify-chat-message) ----
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

    // ---- PARSE body: { workspaceId, messageId } ----
    const body = await request.json();
    const { workspaceId, messageId } = body as { workspaceId?: string; messageId?: string };
    if (!workspaceId || !messageId) {
      return NextResponse.json({ error: 'Missing fields' }, { status: 400 });
    }

    // ---- MEMBERSHIP: read the workspace doc (READ-ONLY — mirrors notify-chat-message). Mandatory:
    // the response is member-privacy data, so only a current member may call this. ----
    const wsDoc = await adminDb.collection('workspaces').doc(workspaceId).get();
    if (!wsDoc.exists) {
      return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
    }
    const members: string[] = wsDoc.data()!.members || [];
    if (!members.includes(uid)) {
      return NextResponse.json({ error: 'Not a workspace member' }, { status: 403 });
    }

    // ---- READ the message doc's plaintext metadata (createdAt + senderId). The route never reads,
    // decrypts, logs, or returns the encrypted content/iv (the Admin SDK fetches the whole doc into
    // server memory, but content/iv are never accessed off the object — the server is trusted and the
    // response is {seenUids} only). If the doc is gone or has no createdAt, nobody can be derived as
    // having read it → return an empty list. ----
    const msgDoc = await adminDb
      .collection('workspaces')
      .doc(workspaceId)
      .collection('messages')
      .doc(messageId)
      .get();
    if (!msgDoc.exists) {
      return NextResponse.json({ seenUids: [] });
    }
    const msgData = msgDoc.data()!;
    const createdAt = msgData.createdAt;
    const senderId: string = msgData.senderId || '';
    if (!createdAt) {
      return NextResponse.json({ seenUids: [] });
    }

    // ---- QUERY readState for cursors at/past this message's createdAt. doc.id == uid. This can
    // include ex-members' stale readState docs (they linger after a kick/leave); the intersect with
    // `members` below drops them — ex-members are not current members. ----
    const snap = await adminDb
      .collection('workspaces')
      .doc(workspaceId)
      .collection('readState')
      .where('lastReadAt', '>=', createdAt)
      .get();
    const rawSeen: string[] = snap.docs.map((d) => d.id);

    // ---- INTERSECT with current members + exclude sender and viewer. Excluding both senderId and
    // uid is belt-and-suspenders (the verified caller is the sender; mirrors notify-chat-message's
    // recipients filter) and is what drops ex-members. ----
    const seenUids: string[] = rawSeen.filter(
      (u) => members.includes(u) && u !== senderId && u !== uid,
    );

    return NextResponse.json({ seenUids });
  } catch (error) {
    console.error('chat-seen-by error:', error);
    return NextResponse.json({ error: 'Failed to compute seen-by' }, { status: 500 });
  }
}
