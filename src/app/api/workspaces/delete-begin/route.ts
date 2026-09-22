import { NextRequest, NextResponse } from 'next/server';
import { getAdminAuth, getAdminDb } from '@/lib/firebase-admin';

export const runtime = 'nodejs';
export const maxDuration = 30;
export const dynamic = 'force-dynamic';

// POST /api/workspaces/delete-begin — the START helper (Round 12 part A). ONE transaction:
//   * verifies ownership and that the workspace is not already deleting (or is this owner's
//     own running job → idempotent resume);
//   * verifies the caller's account barrier is open (START is a barrier participant — part K);
//   * reads the call state commit-time: if ANY call drop exists for the workspace and the
//     request carries no forceEndAck, NOTHING is committed and the route answers
//     confirmation-required (the D-m commit-time confirmation — a call that starts after the
//     modal looked is still caught here);
//   * commits the frozen job fields atomically: deleting, deletingStartedAt, deletingOwner,
//     deletingOwnerName, deletingRecipients (members-at-begin minus the owner — the frozen
//     notice audience, D-k), and creates the deletionJobs/{workspaceId} certificate.
// AFTER the transaction: the post-lock drop count is written as deleteTotal (once — the
// counting is server-authoritative; the counting-resume operation lives in delete-status).
// There is NO deletion work here — no R2, no doc deletes. The client loop does the work.
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

    let body: { workspaceId?: unknown; forceEndAck?: unknown } | null;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Missing workspaceId' }, { status: 400 });
    }
    const workspaceId = typeof body?.workspaceId === 'string' ? body.workspaceId : '';
    const forceEndAck = body?.forceEndAck === true;
    if (!workspaceId) {
      return NextResponse.json({ error: 'Missing workspaceId' }, { status: 400 });
    }

    const db = getAdminDb();
    const wsRef = db.collection('workspaces').doc(workspaceId);

    // ---- The transaction: ownership, barrier, call state, frozen fields, certificate. ----
    const beginResult = await db.runTransaction(async (tx) => {
      const wsSnap = await tx.get(wsRef);
      if (!wsSnap.exists) {
        return { code: 404, payload: { error: 'Workspace not found' } };
      }
      const data = wsSnap.data()!;
      if (data.ownerId !== uid) {
        return { code: 403, payload: { error: 'Forbidden' } };
      }

      // Idempotent resume: the same owner re-beginning their own running job.
      if (data.deleting === true) {
        if (data.deletingOwner === uid) {
          return {
            code: 200,
            payload: {
              ok: true,
              status: 'already-deleting',
              job: {
                deletingStartedAt: data.deletingStartedAt ?? null,
                deleteTotal: data.deleteTotal ?? null,
                deleteDone: data.deleteDone ?? 0,
              },
            },
          };
        }
        return { code: 409, payload: { error: 'Workspace is already deleting' } };
      }

      // Barrier participant check (part K): no new deletion job under an account barrier.
      const barrierSnap = await tx.get(db.collection('accountBarriers').doc(uid));
      if (barrierSnap.exists) {
        const state = barrierSnap.get('state');
        if (state === 'active' || state === 'completing' || state === 'finalizing') {
          return { code: 409, payload: { error: 'Account deletion is in progress' } };
        }
      }

      // Commit-time call check (D-m): ANY call drop for this workspace (live, pending, or an
      // ended-but-retained slot) requires the explicit force-end acknowledgment.
      const callSnap = await tx.get(
        db.collection('drops')
          .where('workspaceId', '==', workspaceId)
          .where('type', '==', 'call')
          .limit(1)
      );
      if (!callSnap.empty && !forceEndAck) {
        return { code: 200, payload: { status: 'confirmation-required' } };
      }

      const members: string[] = Array.isArray(data.members) ? data.members : [];
      const recipients = members.filter((m) => m !== uid);
      const now = Date.now();

      tx.update(wsRef, {
        deleting: true,
        deletingStartedAt: now,
        deletingOwner: uid,
        deletingOwnerName: data.ownerId === uid ? data.name : '',
        deletingRecipients: recipients,
        deleteDone: 0,
      });
      tx.set(db.collection('deletionJobs').doc(workspaceId), {
        ownerId: uid,
        workspaceName: data.name ?? '',
        expected: recipients,
        prepared: [],
        sealed: false,
        createdAt: now,
        updatedAt: now,
      });

      return {
        code: 200,
        payload: { ok: true, status: 'started', job: { deletingStartedAt: now } },
      };
    });

    if (beginResult.code !== 200 || beginResult.payload.status !== 'started') {
      return NextResponse.json(beginResult.payload, { status: beginResult.code });
    }

    // ---- Post-lock count (bounded aggregate; written ONCE). ----
    let deleteTotal = 0;
    try {
      const countSnap = await db.collection('drops')
        .where('workspaceId', '==', workspaceId)
        .count()
        .get();
      deleteTotal = countSnap.data().count;
    } catch {
      deleteTotal = 0;
    }
    await db.runTransaction(async (tx) => {
      const wsSnap = await tx.get(wsRef);
      if (wsSnap.exists && wsSnap.get('deleting') === true && wsSnap.get('deleteTotal') == null) {
        tx.update(wsRef, { deleteTotal });
      }
    });

    return NextResponse.json({
      ok: true,
      status: 'started',
      job: { deletingStartedAt: (beginResult.payload as { job: { deletingStartedAt: number } }).job.deletingStartedAt },
      deleteTotal,
    });
  } catch (e) {
    console.error('workspaces/delete-begin error:', e);
    return NextResponse.json({ error: 'Failed to begin deletion' }, { status: 500 });
  }
}
