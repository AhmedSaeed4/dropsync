import { NextRequest, NextResponse } from 'next/server';
import { getAdminAuth, getAdminDb } from '@/lib/firebase-admin';

export const runtime = 'nodejs';
export const maxDuration = 10;
export const dynamic = 'force-dynamic';

// POST /api/account/barrier-abort — the living-owner recovery (Round 12 part K). Marks the
// caller's own barrier cancelled: idempotent, lost-ack recoverable (re-abort is a no-op).
// REFUSES once `finalizing` is committed — the committed transaction order alone decides
// between abort and complete. There is deliberately NO Auth-exists observation anywhere in
// this path (the F1 hole): the servers' committed order is the only evidence.
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
        return { code: 404, payload: { error: 'No barrier exists' } };
      }
      const state = snap.get('state');
      if (state === 'finalizing') {
        return { code: 409, payload: { error: 'Account deletion was already committed by another device' } };
      }
      if (state === 'cancelled') {
        return { code: 200, payload: { ok: true, state: 'cancelled', already: true } };
      }
      tx.update(ref, { state: 'cancelled', updatedAt: Date.now() });
      return { code: 200, payload: { ok: true, state: 'cancelled' } };
    });

    return NextResponse.json(result.payload, { status: result.code });
  } catch (e) {
    console.error('account/barrier-abort error:', e);
    return NextResponse.json({ error: 'Failed to abort barrier' }, { status: 500 });
  }
}
