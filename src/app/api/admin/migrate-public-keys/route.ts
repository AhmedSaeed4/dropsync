import { NextRequest, NextResponse } from 'next/server';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';

export const runtime = 'nodejs';
export const maxDuration = 60; // one-time backfill may touch many user docs
export const dynamic = 'force-dynamic';

// Initialize Firebase Admin (only once). getApps() guards double-init — safe to duplicate
// alongside the sibling notify-chat-message / share routes. Same service-account cert env vars
// (NEXT_PUBLIC_FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY). The Admin SDK
// bypasses firestore.rules, which is exactly why this backfill can read EVERY user's publicKey
// server-side — something no client (not even the owner) can do once the userKeys read rule goes
// self-only.
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

// POST /api/admin/migrate-public-keys — ONE-TIME backfill that mirrors every existing user's
// publicKey from userKeys into the world-readable userPublicKeys collection. Idempotent (skips
// users who already have a userPublicKeys doc, and users whose userKeys doc has no publicKey).
// OWNER-ONLY: this is an admin op, not any-authed-user.
//
// DEPLOY-ORDER CRITICAL: this MUST run AFTER the public-key-split code is deployed AND BEFORE the
// firestore.rules read-lock is deployed. Otherwise users who never log in again have no
// userPublicKeys doc, and once the userKeys read rule goes self-only, other users can no longer
// fetch their publicKey to encrypt personal drops to them — those drops would become permanently
// undecryptable by the recipient. The lazy self-migration (page.tsx) only covers users who log in;
// this backfill is what covers inactive users.
//
// Trigger once as the owner (e.g. from the browser console with the owner's ID token):
//   curl -X POST https://dropsync.vercel.app/api/admin/migrate-public-keys \
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

    // ---- BACKFILL: mirror publicKey from each userKeys doc into userPublicKeys. ----
    // Read both collections up front; build a Set of uids that already have a public doc so the
    // run is idempotent and safe to re-run.
    const [userKeysSnap, existingPublicSnap] = await Promise.all([
      adminDb.collection('userKeys').get(),
      adminDb.collection('userPublicKeys').get(),
    ]);
    const existing = new Set(existingPublicSnap.docs.map((d) => d.id));

    let migrated = 0;
    let skipped = 0;
    const total = userKeysSnap.size;
    const now = Timestamp.now();

    for (const keyDoc of userKeysSnap.docs) {
      const publicKey = keyDoc.get('publicKey');
      // Skip if there is no publicKey to mirror, or this uid already has a public doc.
      if (!publicKey || existing.has(keyDoc.id)) {
        skipped++;
        continue;
      }
      await adminDb.collection('userPublicKeys').doc(keyDoc.id).set({
        userId: keyDoc.id,
        publicKey,
        createdAt: now,
      });
      migrated++;
    }

    return NextResponse.json({ migrated, skipped, total });
  } catch (error) {
    console.error('migrate-public-keys error:', error);
    return NextResponse.json({ error: 'Backfill failed' }, { status: 500 });
  }
}
