import { NextRequest, NextResponse } from 'next/server';
import { getAdminAuth, getAdminDb } from '@/lib/firebase-admin';

export const runtime = 'nodejs';
export const maxDuration = 10;
export const dynamic = 'force-dynamic';

// POST /api/account/barrier-status — a NAMED reconciliation entry point (part K). If the
// Auth user is verifiably GONE, the barrier is debris from a completed account deletion
// and is REMOVED (missing = open for every admission predicate). An "Auth still exists"
// observation NEVER changes any committed state — it is merely "not completed yet".
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
    const snap = await ref.get();
    if (!snap.exists) {
      return NextResponse.json({ ok: true, state: 'none' });
    }

    let authGone = false;
    try {
      await getAdminAuth().getUser(uid);
    } catch (e) {
      const code = (e as { code?: string })?.code ?? '';
      if (code === 'auth/user-not-found') {
        authGone = true;
      } else {
        // Ambiguous Auth observation — report the barrier state, commit NOTHING.
        return NextResponse.json({
          ok: true,
          state: snap.get('state'),
          attempt: snap.get('attempt') ?? 1,
          reconciled: false,
        });
      }
    }

    if (authGone) {
      await ref.delete();
      return NextResponse.json({ ok: true, state: 'removed', reconciled: true });
    }

    return NextResponse.json({
      ok: true,
      state: snap.get('state'),
      attempt: snap.get('attempt') ?? 1,
      reconciled: false,
    });
  } catch (e) {
    console.error('account/barrier-status error:', e);
    return NextResponse.json({ error: 'Failed to read barrier' }, { status: 500 });
  }
}
