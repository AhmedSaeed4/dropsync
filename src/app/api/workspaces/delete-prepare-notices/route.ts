import { NextRequest, NextResponse } from 'next/server';
import { getAdminAuth, getAdminDb } from '@/lib/firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';

export const runtime = 'nodejs';
export const maxDuration = 30;
export const dynamic = 'force-dynamic';

// POST /api/workspaces/delete-prepare-notices — the PREPARE helper (Round 12 part I).
// The client loop sends the frozen recipient list in BOUNDED chunks (<= 100 per call). The
// server transactionally:
//   * re-verifies the frozen job (deleting, this owner);
//   * validates every chunk member against the FROZEN deletingRecipients set (a client
//     cannot introduce or skip audience members — set-based identity);
//   * creates deletionNotices/{recipientId}_{workspaceId} tombstones (immutable single
//     pending form — an existing notice is left untouched, so retries are idempotent);
//   * appends the chunk to the deletionJobs certificate with arrayUnion (a retried chunk
//     can never increment certified coverage twice).
// SEAL (delete-finalize) later verifies the certificate covers the exact frozen set.
const CHUNK_LIMIT = 100;

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

    let body: { workspaceId?: unknown; recipients?: unknown } | null;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Missing workspaceId' }, { status: 400 });
    }
    const workspaceId = typeof body?.workspaceId === 'string' ? body.workspaceId : '';
    const recipients = Array.isArray(body?.recipients)
      ? (body!.recipients as unknown[]).filter((r): r is string => typeof r === 'string')
      : [];
    if (!workspaceId) {
      return NextResponse.json({ error: 'Missing workspaceId' }, { status: 400 });
    }
    if (recipients.length === 0 || recipients.length > CHUNK_LIMIT) {
      return NextResponse.json({ error: 'Recipients chunk must be 1-100 recipients' }, { status: 400 });
    }
    if (new Set(recipients).size !== recipients.length) {
      return NextResponse.json({ error: 'Duplicate recipients in chunk' }, { status: 400 });
    }

    const db = getAdminDb();
    const wsRef = db.collection('workspaces').doc(workspaceId);
    const certRef = db.collection('deletionJobs').doc(workspaceId);

    const result = await db.runTransaction(async (tx) => {
      const wsSnap = await tx.get(wsRef);
      if (!wsSnap.exists) {
        return { code: 404, payload: { error: 'Workspace not found' } };
      }
      const data = wsSnap.data()!;
      if (data.deleting !== true || data.deletingOwner !== uid) {
        return { code: 403, payload: { error: 'Forbidden' } };
      }
      const frozen: string[] = Array.isArray(data.deletingRecipients) ? data.deletingRecipients : [];
      const frozenSet = new Set(frozen);
      for (const r of recipients) {
        if (!frozenSet.has(r)) {
          return { code: 400, payload: { error: 'Recipient not in the frozen audience' } };
        }
      }

      const certSnap = await tx.get(certRef);
      if (!certSnap.exists) {
        return { code: 409, payload: { error: 'Missing deletion certificate' } };
      }

      // Firestore transactions require ALL reads before ALL writes — read every
      // recipient's existing notice first, then write the missing ones.
      const existingNotices: boolean[] = [];
      for (const r of recipients) {
        const noticeRef = db.collection('deletionNotices').doc(`${r}_${workspaceId}`);
        const noticeSnap = await tx.get(noticeRef);
        existingNotices.push(noticeSnap.exists);
      }
      for (let i = 0; i < recipients.length; i += 1) {
        if (existingNotices[i]) continue;
        const r = recipients[i];
        tx.set(db.collection('deletionNotices').doc(`${r}_${workspaceId}`), {
          recipientId: r,
          workspaceId,
          workspaceName: data.name ?? '',
          ownerName: data.deletingOwnerName ?? '',
          createdAt: Date.now(),
        });
      }

      const preparedNow = new Set<string>(certSnap.get('prepared') ?? []);
      let added = 0;
      for (const r of recipients) {
        if (!preparedNow.has(r)) {
          preparedNow.add(r);
          added++;
        }
      }
      tx.update(certRef, {
        prepared: FieldValue.arrayUnion(...recipients),
        updatedAt: Date.now(),
      });

      return {
        code: 200,
        payload: { ok: true, added, prepared: preparedNow.size, expected: frozen.length },
      };
    });

    return NextResponse.json(result.payload, { status: result.code });
  } catch (e) {
    console.error('workspaces/delete-prepare-notices error:', e);
    return NextResponse.json({ error: 'Failed to prepare notices' }, { status: 500 });
  }
}
