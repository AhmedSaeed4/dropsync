import { NextRequest, NextResponse } from 'next/server';
import { getAdminAuth, getAdminDb } from '@/lib/firebase-admin';

export const runtime = 'nodejs';
export const maxDuration = 30;
export const dynamic = 'force-dynamic';

// POST /api/cleanup-fcm-tokens — deletes ALL of the CALLER's OWN FCM push-token docs
// (users/{uid}/fcmTokens/{token}). The client cannot do this itself: the fcmTokens subcollection is
// rule-locked (`allow read: if false`, firestore.rules:80), so it cannot enumerate its own tokens.
// The Admin SDK bypasses firestore.rules, so this route can. Called best-effort from deleteAccount()
// BEFORE the Firebase Auth user is deleted — after that the ID token is revoked → this route 401s →
// no cleanup (which is why the call is ordered before firebaseUser.delete()).
//
// SECURITY (mirrors /api/notify-chat-message): the target uid is derived ONLY from the verified ID
// token (decoded.uid) — NEVER from the request body/query; the body is ignored entirely. The route
// can therefore only ever delete the caller's OWN tokens (IDOR-safe). The response is a COUNT only
// ({ deleted: N }); token strings are NEVER echoed.
export async function POST(request: NextRequest) {
  try {
    // ---- AUTH: verify the Firebase ID token. The target uid is the VERIFIED caller — nothing else. ----
    const authHeader = request.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const idToken = authHeader.substring(7);
    let uid: string;
    try {
      const decoded = await getAdminAuth().verifyIdToken(idToken);
      uid = decoded.uid;
    } catch {
      return NextResponse.json({ error: 'Invalid token' }, { status: 401 });
    }

    // ---- Enumerate the caller's OWN token docs. Admin SDK bypasses `allow read: if false`.
    // listDocuments() returns DocumentReference[] (ids only) — no token-field read is needed, we only
    // delete. An empty subcollection (no devices registered) → deleted: 0. ----
    const tokenRefs = await getAdminDb()
      .collection('users')
      .doc(uid)
      .collection('fcmTokens')
      .listDocuments();

    if (tokenRefs.length === 0) {
      return NextResponse.json({ deleted: 0 });
    }

    // ---- Delete in writeBatch chunks of ≤450 (Firestore batch cap is 500). Per-user counts are tiny
    // (one doc per device); chunking is free insurance against a pathological >450-token user. Each
    // batch commits atomically; on success the count reflects every ref in the chunk. ----
    let deleted = 0;
    for (let i = 0; i < tokenRefs.length; i += 450) {
      const chunk = tokenRefs.slice(i, i + 450);
      const batch = getAdminDb().batch();
      for (const ref of chunk) {
        batch.delete(ref);
      }
      await batch.commit();
      deleted += chunk.length;
    }

    return NextResponse.json({ deleted });
  } catch (error) {
    console.error('cleanup-fcm-tokens error:', error);
    return NextResponse.json({ error: 'Failed to clean push tokens' }, { status: 500 });
  }
}
