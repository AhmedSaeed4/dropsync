import { NextRequest, NextResponse } from 'next/server';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';

export const runtime = 'nodejs';
export const maxDuration = 60; // one-time backfill may touch many user docs
export const dynamic = 'force-dynamic';

// Initialize Firebase Admin (only once). getApps() guards double-init — safe to duplicate
// alongside the sibling notify-chat-message / share / migrate-public-keys routes. Same
// service-account cert env vars. The Admin SDK bypasses firestore.rules, which is exactly why this
// backfill can read EVERY user's displayName/photoURL server-side and write profiles/{uid} for
// inactive users — something the lazy self-migration (page.tsx) can only do for users who log in.
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

// POST /api/admin/migrate-profiles — ONE-TIME backfill that MOVEs every existing user's
// displayName+photoURL from users/{uid} into the world-readable profiles/{uid} collection.
// Idempotent (skips users who already have a profiles doc, and users whose users doc has neither a
// displayName nor a photoURL to mirror). OWNER-ONLY: this is an admin op, not any-authed-user.
//
// Unlike the public-key backfill, deploy order is NOT load-bearing here: no live cross-user reader
// breaks if a profiles doc is missing — getProfile just returns null and callers fall back to the
// uid. So this can run before or after the rules lock. The lazy self-migration (page.tsx) covers
// users who log in; this covers inactive users so their display name shows in workspace member
// lists instead of their raw uid.
//
// Trigger once as the owner (e.g. from the browser console with the owner's ID token):
//   curl -X POST https://dropsync.vercel.app/api/admin/migrate-profiles \
//     -H "Authorization: Bearer <owner-id-token>"
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

    // ---- OWNER GATE: only the DropSync owner may run this backfill (config/owner.uid). ----
    const ownerDoc = await adminDb.collection('config').doc('owner').get();
    const ownerUid = ownerDoc.exists ? ownerDoc.get('uid') : undefined;
    if (!ownerUid || ownerUid !== uid) {
      return NextResponse.json({ error: 'Forbidden — owner only' }, { status: 403 });
    }

    // ---- BACKFILL: mirror displayName+photoURL from each users doc into profiles. ----
    // Read both collections up front; build a Set of uids that already have a profiles doc so the
    // run is idempotent and safe to re-run.
    const [usersSnap, existingProfilesSnap] = await Promise.all([
      adminDb.collection('users').get(),
      adminDb.collection('profiles').get(),
    ]);
    const existing = new Set(existingProfilesSnap.docs.map((d) => d.id));

    let migrated = 0;
    let skipped = 0;
    const total = usersSnap.size;
    const now = Timestamp.now();

    for (const userDoc of usersSnap.docs) {
      const data = userDoc.data() as { displayName?: string | null; photoURL?: string | null };
      const displayName = data.displayName ?? null;
      const photoURL = data.photoURL ?? null;
      // Skip if there's nothing to mirror, or this uid already has a profiles doc.
      if ((!displayName && !photoURL) || existing.has(userDoc.id)) {
        skipped++;
        continue;
      }
      await adminDb.collection('profiles').doc(userDoc.id).set({
        displayName,
        photoURL,
        createdAt: now,
      });
      migrated++;
    }

    return NextResponse.json({ migrated, skipped, total });
  } catch (error) {
    console.error('migrate-profiles error:', error);
    return NextResponse.json({ error: 'Backfill failed' }, { status: 500 });
  }
}
