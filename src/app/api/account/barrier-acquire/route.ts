import { NextRequest, NextResponse } from 'next/server';
import { getAdminAuth, getAdminDb } from '@/lib/firebase-admin';

export const runtime = 'nodejs';
export const maxDuration = 10;
export const dynamic = 'force-dynamic';

// POST /api/account/barrier-acquire — the account-deletion barrier acquisition (Round 12
// part K). Creates the caller's own barrier doc or returns its current state. Writers
// that must refuse while a barrier holds: workspace deletion START, call-attempt
// registration, workspace create (proposed owner), ownership transfer (successor), the
// archive import fence admission. Acquire itself is SELF-scoped: the verified uid IS
// the barrier id — nothing from the body is trusted or needed.
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
      const now = Date.now();
      if (!snap.exists) {
        tx.set(ref, { state: 'active', attempt: 1, createdAt: now, updatedAt: now });
        return { state: 'active', attempt: 1 };
      }
      const state = snap.get('state');
      const attempt = snap.get('attempt') ?? 1;
      if (state === 'active') {
        return { state: 'active', attempt };
      }
      if (state === 'cancelled') {
        // A living owner re-acquiring after an abort = a NEW attempt (the caller is
        // token-verified, so Auth existence is established by the request itself).
        tx.update(ref, { state: 'active', attempt: attempt + 1, updatedAt: now });
        return { state: 'active', attempt: attempt + 1 };
      }
      // completing/finalizing: MONOTONIC — never reverted here. The client resumes the
      // committed tail (retry the Auth deletion), not a new account-deletion flow.
      return { state, attempt };
    });

    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    console.error('account/barrier-acquire error:', e);
    return NextResponse.json({ error: 'Failed to acquire barrier' }, { status: 500 });
  }
}
