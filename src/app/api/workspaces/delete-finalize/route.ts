import { NextRequest, NextResponse } from 'next/server';
import { getAdminAuth, getAdminDb } from '@/lib/firebase-admin';

export const runtime = 'nodejs';
export const maxDuration = 30;
export const dynamic = 'force-dynamic';

// POST /api/workspaces/delete-finalize — the SEAL helper (Round 12 part I). Verifies, then
// atomically deletes the workspace doc + creates the deletionReceipts completion record:
//   * the certificate covers the EXACT frozen audience (prepared == expected, set-equal);
//   * NO unresolved import fence exists for this workspace (part J);
//   * NO unresolved call attempt exists for this workspace (phases registered/roomCreated/
//     creationFailed are unresolved — part D; resolved/cancelled are done);
//   * the workspace is deleting and the caller is the frozen deleting owner.
// The receipt (ownerId + the frozen recipients) is the durable completion authority — the
// owner's STATUS and any recipient's notice-holder read recover a lost SEAL response.
// The stage emptiness itself (drops/messages/categories/key gone) is the CLIENT loop's
// authoritative requery responsibility before it calls SEAL.
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

    let body: { workspaceId?: unknown } | null;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Missing workspaceId' }, { status: 400 });
    }
    const workspaceId = typeof body?.workspaceId === 'string' ? body.workspaceId : '';
    if (!workspaceId) {
      return NextResponse.json({ error: 'Missing workspaceId' }, { status: 400 });
    }

    const db = getAdminDb();
    const wsRef = db.collection('workspaces').doc(workspaceId);
    const certRef = db.collection('deletionJobs').doc(workspaceId);
    const receiptRef = db.collection('deletionReceipts').doc(workspaceId);

    // ---- Idempotent: a lost SEAL response recovers here. ----
    const receiptSnap = await receiptRef.get();
    if (receiptSnap.exists) {
      return NextResponse.json({ ok: true, status: 'already-sealed' });
    }

    // ---- Pre-checks (bounded, outside the write transaction). ----
    const wsSnap = await wsRef.get();
    if (!wsSnap.exists) {
      // Parent gone without a receipt is NOT invented success — fail loudly.
      return NextResponse.json({ error: 'Workspace not found and no receipt exists' }, { status: 404 });
    }
    const data = wsSnap.data()!;
    if (data.deleting !== true || data.deletingOwner !== uid) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const fenceSnap = await db.collection('importFences')
      .where('workspaceId', '==', workspaceId)
      .where('state', '==', 'open')
      .limit(1)
      .get();
    if (!fenceSnap.empty) {
      return NextResponse.json({ error: 'An import for this workspace is still unresolved' }, { status: 409 });
    }

    const attemptSnap = await db.collection('callTerminations')
      .where('workspaceId', '==', workspaceId)
      .where('phase', 'in', ['registered', 'roomCreated', 'creationFailed'])
      .limit(1)
      .get();
    if (!attemptSnap.empty) {
      return NextResponse.json({ error: 'A call attempt is still unresolved' }, { status: 409 });
    }

    const certSnap = await certRef.get();
    if (!certSnap.exists) {
      return NextResponse.json({ error: 'Missing deletion certificate' }, { status: 409 });
    }
    const frozen: string[] = Array.isArray(data.deletingRecipients) ? data.deletingRecipients : [];
    const prepared: string[] = certSnap.get('prepared') ?? [];
    const frozenSet = new Set(frozen);
    const preparedSet = new Set(prepared);
    if (prepared.length !== preparedSet.size || frozen.length !== frozenSet.size) {
      return NextResponse.json({ error: 'Certificate corrupted (duplicate identities)' }, { status: 409 });
    }
    if (preparedSet.size !== frozenSet.size || ![...frozenSet].every((r) => preparedSet.has(r))) {
      return NextResponse.json({ error: 'Notices are not fully prepared' }, { status: 409 });
    }

    // ---- The atomic seal: parent delete + receipt create + certificate delete. ----
    await db.runTransaction(async (tx) => {
      const reSnap = await tx.get(wsRef);
      if (!reSnap.exists) return; // racing SEAL already removed it — receipt written below is idempotent
      tx.delete(wsRef);
      tx.set(receiptRef, {
        ownerId: data.ownerId,
        workspaceName: data.name ?? '',
        recipients: frozen,
        total: data.deleteTotal ?? frozen.length,
        done: data.deleteDone ?? 0,
        completedAt: Date.now(),
      });
      tx.delete(certRef);
    });

    return NextResponse.json({ ok: true, status: 'sealed' });
  } catch (e) {
    console.error('workspaces/delete-finalize error:', e);
    return NextResponse.json({ error: 'Failed to finalize deletion' }, { status: 500 });
  }
}
