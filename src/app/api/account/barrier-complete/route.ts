import { NextRequest, NextResponse } from 'next/server';
import { getAdminAuth, getAdminDb } from '@/lib/firebase-admin';

export const runtime = 'nodejs';
export const maxDuration = 10;
export const dynamic = 'force-dynamic';

// POST /api/account/barrier-complete — THE SERVER FINALIZER (Round 12 part K, the F1 fix).
// Commits `finalizing` atomically (completing + finalizing are ONE committed transition —
// no observer, and no other route, can ever see one without the other). The client calls
// this as the LAST token-bearing request before firebaseUser.delete().
//   * active → finalizing (committed; from here abort refuses forever).
//   * finalizing → idempotent ok (a lost response recovers here; the client retries the
//     Auth deletion, which is the accepted §6 residual).
//   * cancelled → REFUSE (another device's abort landed first — the client HALTS before
//     any Auth deletion).
// There is NO Auth-exists observation in this path.
export async function POST(request: NextRequest) {
  try {
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

    const db = getAdminDb();
    const ref = db.collection('accountBarriers').doc(uid);

    const result = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) {
        return { code: 409, payload: { error: 'No barrier exists' } };
      }
      const state = snap.get('state');
      const attempt = snap.get('attempt') ?? 1;
      const now = Date.now();
      if (state === 'cancelled') {
        return { code: 409, payload: { error: 'Barrier was aborted by another device' } };
      }
      if (state === 'finalizing') {
        return { code: 200, payload: { ok: true, state: 'finalizing', attempt, already: true } };
      }
      tx.update(ref, { state: 'finalizing', completingAt: now, updatedAt: now });
      return { code: 200, payload: { ok: true, state: 'finalizing', attempt } };
    });

    return NextResponse.json(result.payload, { status: result.code });
  } catch (e) {
    console.error('account/barrier-complete error:', e);
    return NextResponse.json({ error: 'Failed to complete barrier' }, { status: 500 });
  }
}
