import { NextRequest, NextResponse } from 'next/server';
import { getAdminAuth, getAdminDb } from '@/lib/firebase-admin';

export const runtime = 'nodejs';
export const maxDuration = 30;
export const dynamic = 'force-dynamic';

// POST /api/workspaces/delete-status — the STATUS helper (Round 12 parts D/E). The
// owner-facing authority at resume and after a lost response. POST because it performs the
// bounded counting-resume reconciliation:
//   * workspace deleting + deleteTotal ABSENT → the server initializes it ONCE from an
//     authoritative aggregate count (never resets an existing total — the absent-only rule);
//   * returns the job fields, the outstanding (unresolved) call attempts for the workspace
//     (bounded listing, cap 20 — the loop re-runs the call stage on any), the open import
//     fences for the workspace, and the notice-certificate coverage;
//   * workspace doc GONE → the deletionReceipts record decides: completed (owner or any
//     frozen recipient may ask; recipients use their notice + the receipt rules-read
//     themselves, this route serves the owner/second-runner case).
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

    const wsSnap = await wsRef.get();
    if (!wsSnap.exists) {
      const receiptSnap = await db.collection('deletionReceipts').doc(workspaceId).get();
      if (receiptSnap.exists) {
        const r = receiptSnap.data()!;
        if (r.ownerId !== uid && !(Array.isArray(r.recipients) && r.recipients.includes(uid))) {
          return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        }
        return NextResponse.json({ ok: true, status: 'completed' });
      }
      return NextResponse.json({ ok: false, status: 'not-found' }, { status: 404 });
    }

    const data = wsSnap.data()!;
    if (data.deleting === true && data.deletingOwner !== uid) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    if (data.deleting !== true) {
      return NextResponse.json({ ok: false, status: 'not-deleting' }, { status: 409 });
    }

    // Counting-resume operation: initialize deleteTotal absent-only.
    if (data.deleteTotal == null) {
      let count = 0;
      try {
        const countSnap = await db.collection('drops')
          .where('workspaceId', '==', workspaceId)
          .count()
          .get();
        count = countSnap.data().count;
      } catch {
        count = 0;
      }
      await db.runTransaction(async (tx) => {
        const reSnap = await tx.get(wsRef);
        if (reSnap.exists && reSnap.get('deleting') === true && reSnap.get('deleteTotal') == null) {
          tx.update(wsRef, { deleteTotal: count });
          data.deleteTotal = count;
        }
      });
    }

    const [attemptSnap, fenceSnap, certSnap] = await Promise.all([
      db.collection('callTerminations')
        .where('workspaceId', '==', workspaceId)
        .where('phase', 'in', ['registered', 'roomCreated', 'creationFailed'])
        .limit(20)
        .get(),
      db.collection('importFences')
        .where('workspaceId', '==', workspaceId)
        .where('state', '==', 'open')
        .limit(5)
        .get(),
      db.collection('deletionJobs').doc(workspaceId).get(),
    ]);

    return NextResponse.json({
      ok: true,
      status: 'deleting',
      job: {
        deletingStartedAt: data.deletingStartedAt ?? null,
        deleteTotal: data.deleteTotal ?? null,
        deleteDone: data.deleteDone ?? 0,
      },
      outstandingAttempts: attemptSnap.docs.map((d) => ({
        callDropId: d.get('callDropId') ?? '',
        attemptKey: d.get('attemptKey') ?? '',
        phase: d.get('phase') ?? '',
        roomName: d.get('roomName') ?? null,
        registeredAt: d.get('registeredAt') ?? null,
      })),
      openFences: fenceSnap.size,
      noticesPrepared: certSnap.exists ? (certSnap.get('prepared') ?? []).length : 0,
      noticesExpected: Array.isArray(data.deletingRecipients) ? data.deletingRecipients.length : 0,
    });
  } catch (e) {
    console.error('workspaces/delete-status error:', e);
    return NextResponse.json({ error: 'Failed to read deletion status' }, { status: 500 });
  }
}
