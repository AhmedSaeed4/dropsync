import { NextResponse } from 'next/server';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 10;

// Initialize Firebase Admin (only once). Copied verbatim from notify-chat-message/route.ts —
// getApps() guards double-init so this is safe alongside the sibling Admin routes.
//
// WHY ADMIN SDK: it bypasses firestore.rules by design. This route is the server-side invite-code
// enforcement point (Release 1 of 2); the firestore.rules tightening is Release 2 — a SEPARATE
// task. Release 1 is purely additive and must not touch the rules.
//
// GATING: USER-gated, NOT owner-gated. Any authenticated user holding a valid invite code may
// join — there is deliberately NO owner/config check here (unlike the admin/* routes). The
// verified token's uid IS the joining user; the `userId` the client passes is therefore not
// trusted for the write.
//
// SCOPE OF WRITE: touches ONLY the workspace's `members` array, atomically via arrayUnion. Never
// ownerId / name / inviteCode / createdAt, and never workspaceKeys. Membership alone grants
// keySecret read via the rules, so addMemberToWorkspaceKey is intentionally NOT called.
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

// POST /api/workspaces/join — adds the authenticated caller to a workspace by invite code.
// Called from joinWorkspace() in src/lib/workspaces.ts. Returns the joined workspace on success
// or a { error } envelope on failure. Three client-facing error strings are preserved verbatim:
//   "Invalid invite code", "You are already a member of this workspace", "Failed to join workspace".
export async function POST(request: Request) {
  try {
    // ---- AUTH: verify the Firebase ID token (copied verbatim from notify-chat-message/route.ts).
    // USER-gated — there is NO owner check here, unlike the admin routes. ----
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

    // ---- BODY: { inviteCode: string }. Parse defensively: an empty or non-JSON body makes
    // request.json() throw BEFORE the field guard runs, which would otherwise fall through to the
    // 500 catch. Catch it here so absent/malformed input returns the contract's 400. ----
    let body: { inviteCode?: unknown } | null;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Missing invite code' }, { status: 400 });
    }
    if (!body || typeof body.inviteCode !== 'string') {
      return NextResponse.json({ error: 'Missing invite code' }, { status: 400 });
    }

    // ---- Normalize the code BEFORE the equality query (matches the client's old behavior). ----
    const code = String(body.inviteCode).trim().toUpperCase();

    // ---- LOOKUP the workspace by invite code. Admin SDK read bypasses client read rules. ----
    const snap = await adminDb.collection('workspaces').where('inviteCode', '==', code).get();
    if (snap.empty) {
      return NextResponse.json({ error: 'Invalid invite code' }, { status: 404 });
    }

    const d = snap.docs[0];
    const data = d.data();
    const members: string[] = Array.isArray(data.members) ? data.members : [];

    // ---- Distinct error if already a member (NOT a silent success). ----
    if (members.includes(uid)) {
      return NextResponse.json(
        { error: 'You are already a member of this workspace' },
        { status: 409 }
      );
    }

    // ---- WRITE: atomic arrayUnion so a concurrent join can't race a duplicate. Members ONLY. ----
    await d.ref.update({ members: FieldValue.arrayUnion(uid) });

    return NextResponse.json(
      {
        workspaceId: d.id,
        name: data.name,
        ownerId: data.ownerId,
        members: [...members, uid],
        inviteCode: data.inviteCode,
      },
      { status: 200 }
    );
  } catch (e) {
    console.error('workspaces/join error:', e);
    return NextResponse.json({ error: 'Failed to join workspace' }, { status: 500 });
  }
}
