import { NextRequest, NextResponse } from 'next/server';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Initialize Firebase Admin (only once). getApps() guards double-init — safe to duplicate
// alongside the sibling notify-chat-message / share / migrate-* routes. Same service-account cert
// env vars (NEXT_PUBLIC_FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY). The Admin
// SDK bypasses firestore.rules, which is exactly why this route can read EVERY user's email + tier
// server-side — something no client (not even the owner) can do once the users/{uid} read rule goes
// self/owner-only.
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

// GET /api/admin/list-users — owner-only user lookup for the admin page. Firestore cannot
// query-filter through the isOwner() rules branch (it's an external get() on config/owner), so
// once users/{uid} is locked to self||isOwner the client can no longer run
// where('tier','==','trusted') / where('email','==',...) list queries against users/. This route
// reads via the Admin SDK (bypasses rules) and joins users/{uid} (email, tier) with profiles/{uid}
// (displayName). OWNER-ONLY — the Firestore rules are the real gate; this is the data path.
//
//   GET /api/admin/list-users?tier=trusted        -> [{uid, email, displayName, tier}, ...]
//   GET /api/admin/list-users?email=<exact-email>  -> single-match array (empty if not found)
export async function GET(request: NextRequest) {
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

    // ---- OWNER GATE: only the DropSync owner may look up users (config/owner.uid). ----
    const ownerDoc = await adminDb.collection('config').doc('owner').get();
    const ownerUid = ownerDoc.exists ? ownerDoc.get('uid') : undefined;
    if (!ownerUid || ownerUid !== uid) {
      return NextResponse.json({ error: 'Forbidden — owner only' }, { status: 403 });
    }

    // ---- QUERY: tier list OR exact-email lookup ----
    const tier = request.nextUrl.searchParams.get('tier');
    const email = request.nextUrl.searchParams.get('email');
    let userSnap;
    if (tier) {
      userSnap = await adminDb.collection('users').where('tier', '==', tier).get();
    } else if (email) {
      userSnap = await adminDb.collection('users').where('email', '==', email).get();
    } else {
      return NextResponse.json({ error: 'Provide ?tier= or ?email=' }, { status: 400 });
    }

    // ---- JOIN profiles/{uid} for displayName (null if the profile doc is missing) ----
    const rows = await Promise.all(
      userSnap.docs.map(async (d) => {
        const data = d.data() as { email?: string | null; tier?: string | null };
        const profileSnap = await adminDb.collection('profiles').doc(d.id).get();
        const displayName = profileSnap.exists ? (profileSnap.get('displayName') ?? null) : null;
        return {
          uid: d.id,
          email: data.email ?? null,
          displayName: displayName ?? null,
          tier: data.tier ?? null,
        };
      })
    );

    return NextResponse.json(rows);
  } catch (error) {
    console.error('list-users error:', error);
    return NextResponse.json({ error: 'Lookup failed' }, { status: 500 });
  }
}
