import { NextRequest, NextResponse } from 'next/server';
import { getAdminAuth, getAdminDb } from '@/lib/firebase-admin';

export const runtime = 'nodejs';
export const maxDuration = 30;
export const dynamic = 'force-dynamic';

// POST /api/archive/import-fence — the durable import fence (Round 12 part J).
// A producer epoch at the Firestore commit boundary is enforced by firestore.rules
// (importEpochAdmitted): a job-naming create is admitted ONLY while this fence is OPEN —
// cancellation closes it, so a persistent multi-tab client replaying a buffered write
// after cancellation is denied at the boundary. R2 uploads are not Firestore replays;
// their fence obligation is this registration ledger plus cleanup acknowledgment.
const CHUNK_LIMIT = 100;
const HEARTBEAT_LEASE_MS = 15 * 60 * 1000;

type RegisterItem = { kind: string; id: string };
type DispositionEntry = { id: string; disposition: string };

function itemDocId(item: RegisterItem): string {
  return encodeURIComponent(`${item.kind}:${item.id}`);
}

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

    let body: Record<string, unknown> | null;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return NextResponse.json({ error: 'Missing op' }, { status: 400 });
    }
    const op = typeof body?.op === 'string' ? body.op : '';
    const jobId = typeof body?.jobId === 'string' ? body.jobId : '';
    if (!op || !jobId) {
      return NextResponse.json({ error: 'Missing op or jobId' }, { status: 400 });
    }

    const db = getAdminDb();
    const fenceRef = db.collection('importFences').doc(`${uid}_${jobId}`);

    // ---------- op: open ----------
    if (op === 'open') {
      const mode = body.mode === 'merge' ? 'merge' : 'fresh';
      const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId : '';
      if (!workspaceId) {
        return NextResponse.json({ error: 'Missing workspaceId' }, { status: 400 });
      }
      const result = await db.runTransaction(async (tx) => {
        const fenceSnap = await tx.get(fenceRef);
        if (fenceSnap.exists) {
          return { code: 409, payload: { error: 'Fence already exists for this job' } };
        }
        const barrierSnap = await tx.get(db.collection('accountBarriers').doc(uid));
        if (barrierSnap.exists) {
          const state = barrierSnap.get('state');
          if (state === 'active' || state === 'completing' || state === 'finalizing') {
            return { code: 409, payload: { error: 'Account deletion is in progress' } };
          }
        }
        const wsSnap = await tx.get(db.collection('workspaces').doc(workspaceId));
        if (mode === 'fresh') {
          if (wsSnap.exists) {
            return { code: 409, payload: { error: 'Pre-allocated workspace id already exists' } };
          }
        } else {
          if (!wsSnap.exists) {
            return { code: 404, payload: { error: 'Merge target workspace not found' } };
          }
          const data = wsSnap.data()!;
          const members: string[] = Array.isArray(data.members) ? data.members : [];
          if (data.ownerId !== uid && !members.includes(uid)) {
            return { code: 403, payload: { error: 'Forbidden' } };
          }
          if (data.deleting === true) {
            return { code: 409, payload: { error: 'Workspace is deleting' } };
          }
        }
        const now = Date.now();
        tx.set(fenceRef, {
          userId: uid,
          jobId,
          workspaceId,
          mode,
          state: 'open',
          complete: false,
          createdAt: now,
          updatedAt: now,
          heartbeatAt: now,
        });
        return { code: 200, payload: { ok: true, state: 'open' } };
      });
      return NextResponse.json(result.payload, { status: result.code });
    }

    // ---------- op: probe-items (R14-D4 hotfix-4) ----------
    // Recovery existence probe. A bare client read of a MISSING doc is denied by the
    // rules (the read rules dereference the document body), so the browser cannot ask
    // "does this obligation exist?" — the route answers under Admin. Every PRESENT doc
    // must belong to the caller (drop.userId / fence.userId / category.createdBy /
    // workspace.ownerId); anything else fails the whole call. Runs BEFORE the shared
    // fence check on purpose: a fully-acked fence is deleted, yet its journal cleanup
    // still needs probes.
    if (op === 'probe-items') {
      const rawIds = Array.isArray(body.ids) ? (body.ids as unknown[]) : [];
      const ids = rawIds.filter((i): i is string => typeof i === 'string');
      if (ids.length === 0 || ids.length > CHUNK_LIMIT) {
        return NextResponse.json({ error: 'Ids chunk must be 1-100' }, { status: 400 });
      }
      const absent: string[] = [];
      const present: string[] = [];
      const fenceState: Record<string, { state: string; heartbeatAt: number | null }> = {};
      for (const id of ids) {
        const colon = id.indexOf(':');
        const kind = colon > 0 ? id.slice(0, colon) : '';
        const refId = colon > 0 ? id.slice(colon + 1) : '';
        if (!refId || (kind !== 'drop' && kind !== 'category' && kind !== 'workspace' && kind !== 'fence')) {
          return NextResponse.json({ error: 'Bad probe id' }, { status: 400 });
        }
        const ref = kind === 'fence'
          ? db.collection('importFences').doc(refId)
          : db.collection(kind === 'drop' ? 'drops' : kind === 'category' ? 'categories' : 'workspaces').doc(refId);
        const snap = await ref.get();
        if (!snap.exists) { absent.push(id); continue; }
        const data = snap.data()!;
        const ownerId = kind === 'drop' || kind === 'fence' ? data.userId : kind === 'category' ? data.createdBy : data.ownerId;
        if (ownerId !== uid) {
          return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        }
        present.push(id);
        if (kind === 'fence') {
          fenceState[id] = {
            state: typeof data.state === 'string' ? data.state : '',
            heartbeatAt: typeof data.heartbeatAt === 'number' ? data.heartbeatAt : null,
          };
        }
      }
      return NextResponse.json({ ok: true, absent, present, fenceState });
    }

    // ---------- shared: the fence must belong to the caller ----------
    const fenceSnap = await fenceRef.get();
    if (!fenceSnap.exists || fenceSnap.get('userId') !== uid) {
      return NextResponse.json({ error: 'Fence not found' }, { status: 404 });
    }

    // ---------- op: register ----------
    if (op === 'register') {
      const rawItems = Array.isArray(body.items) ? (body.items as unknown[]) : [];
      const items: RegisterItem[] = [];
      for (const raw of rawItems) {
        if (
          raw && typeof raw === 'object' &&
          typeof (raw as Record<string, unknown>).kind === 'string' &&
          typeof (raw as Record<string, unknown>).id === 'string'
        ) {
          items.push({ kind: (raw as Record<string, string>).kind, id: (raw as Record<string, string>).id });
        }
      }
      if (items.length === 0 || items.length > CHUNK_LIMIT) {
        return NextResponse.json({ error: 'Items chunk must be 1-100 items' }, { status: 400 });
      }
      const result = await db.runTransaction(async (tx) => {
        const snap = await tx.get(fenceRef);
        if (snap.get('state') !== 'open') {
          return { code: 409, payload: { error: 'Fence is closed' } };
        }
        for (const item of items) {
          tx.set(
            fenceRef.collection('items').doc(itemDocId(item)),
            { kind: item.kind, refId: item.id, jobId, addedAt: Date.now() }
          );
        }
        tx.update(fenceRef, { heartbeatAt: Date.now(), updatedAt: Date.now() });
        return { code: 200, payload: { ok: true, registered: items.length } };
      });
      return NextResponse.json(result.payload, { status: result.code });
    }

    // ---------- op: heartbeat ----------
    if (op === 'heartbeat') {
      const result = await db.runTransaction(async (tx) => {
        const snap = await tx.get(fenceRef);
        if (snap.get('state') !== 'open') {
          return { code: 409, payload: { error: 'Fence is closed' } };
        }
        tx.update(fenceRef, { heartbeatAt: Date.now(), updatedAt: Date.now() });
        return { code: 200, payload: { ok: true } };
      });
      return NextResponse.json(result.payload, { status: result.code });
    }

    // ---------- op: disposition ----------
    if (op === 'disposition') {
      const rawChunks = Array.isArray(body.chunks) ? (body.chunks as unknown[]) : [];
      if (rawChunks.length === 0 || rawChunks.length > 5) {
        return NextResponse.json({ error: 'Disposition must carry 1-5 chunks' }, { status: 400 });
      }
      const parsed: Array<{ index: number; entries: DispositionEntry[] }> = [];
      for (const raw of rawChunks) {
        const rec = raw as Record<string, unknown>;
        const index = typeof rec.index === 'number' ? rec.index : -1;
        const entries = Array.isArray(rec.entries) ? (rec.entries as unknown[]) : [];
        if (index < 0 || entries.length === 0 || entries.length > CHUNK_LIMIT) {
          return NextResponse.json({ error: 'Bad disposition chunk' }, { status: 400 });
        }
        const list: DispositionEntry[] = [];
        for (const e of entries) {
          const er = e as Record<string, unknown>;
          if (
            typeof er.id !== 'string' ||
            (er.disposition !== 'committed' && er.disposition !== 'not-committed')
          ) {
            return NextResponse.json({ error: 'Bad disposition entry' }, { status: 400 });
          }
          list.push({ id: er.id, disposition: er.disposition });
        }
        parsed.push({ index, entries: list });
      }
      const result = await db.runTransaction(async (tx) => {
        const snap = await tx.get(fenceRef);
        if (snap.get('state') !== 'open') {
          return { code: 409, payload: { error: 'Fence is closed' } };
        }
        let newEntries = 0;
        // Firestore transactions require ALL reads before ALL writes — read every
        // existing chunk doc first, then write the missing chunks + the fence update.
        const existingByChunk: boolean[] = [];
        for (const chunk of parsed) {
          const chunkRef = fenceRef.collection('manifest').doc(String(chunk.index));
          const existing = await tx.get(chunkRef);
          existingByChunk.push(existing.exists);
        }
        for (let i = 0; i < parsed.length; i += 1) {
          if (existingByChunk[i]) continue;
          const chunk = parsed[i];
          tx.set(
            fenceRef.collection('manifest').doc(String(chunk.index)),
            { index: chunk.index, entries: chunk.entries, jobId, writtenAt: Date.now() },
          );
          newEntries += chunk.entries.length;
        }
        // Only newly-written chunks advance the running entry count, so a re-sent
        // identical chunk stays idempotent across producer retries.
        tx.update(fenceRef, {
          heartbeatAt: Date.now(),
          updatedAt: Date.now(),
          manifestEntries:
            (typeof snap.get('manifestEntries') === 'number' ? snap.get('manifestEntries') : 0) + newEntries,
        });
        return { code: 200, payload: { ok: true, chunks: parsed.length } };
      });
      return NextResponse.json(result.payload, { status: result.code });
    }

    // ---------- op: complete ----------
    if (op === 'complete') {
      const expectedTotal = typeof body.expectedTotal === 'number' ? body.expectedTotal : -1;
      if (expectedTotal < 0) {
        return NextResponse.json({ error: 'Missing expectedTotal' }, { status: 400 });
      }
      const result = await db.runTransaction(async (tx) => {
        const snap = await tx.get(fenceRef);
        const state = snap.get('state');
        if (state === 'closed-cancelled') {
          return { code: 409, payload: { error: 'Fence was cancelled' } };
        }
        if (state === 'closed-success') {
          return { code: 200, payload: { ok: true, state: 'closed-success', already: true } };
        }
        const itemsCount = await fenceRef.collection('items').count().get();
        // F4: adoption is decided by THIS durable producer-completion record over the FULL
        // expected manifest — coverage must be exact; a prefix cannot stand in for it.
        // Coverage counts ENTRIES, not documents: the record ships as chunk documents of
        // up to CHUNK_LIMIT entries each, and the disposition op maintains the running
        // total (idempotent across retries).
        const manifestEntries =
          typeof snap.get('manifestEntries') === 'number' ? snap.get('manifestEntries') : 0;
        if (itemsCount.data().count !== expectedTotal || manifestEntries !== expectedTotal) {
          return {
            code: 409,
            payload: {
              error: 'Coverage incomplete',
              registered: itemsCount.data().count,
              dispositioned: manifestEntries,
              expectedTotal,
            },
          };
        }
        tx.update(fenceRef, {
          state: 'closed-success',
          complete: true,
          expectedTotal,
          completedAt: Date.now(),
          updatedAt: Date.now(),
        });
        return { code: 200, payload: { ok: true, state: 'closed-success' } };
      });
      return NextResponse.json(result.payload, { status: result.code });
    }

    // ---------- op: cancel ----------
    if (op === 'cancel') {
      const override = body.override === true;
      const result = await db.runTransaction(async (tx) => {
        const snap = await tx.get(fenceRef);
        const state = snap.get('state');
        if (state === 'closed-success') {
          return { code: 409, payload: { error: 'Fence already completed successfully' } };
        }
        if (state === 'closed-cancelled') {
          return { code: 200, payload: { ok: true, state: 'closed-cancelled', already: true } };
        }
        const heartbeatAt = snap.get('heartbeatAt') ?? 0;
        if (!override && Date.now() - heartbeatAt < HEARTBEAT_LEASE_MS) {
          return { code: 409, payload: { error: 'Heartbeat lease still active', retryAfterMs: HEARTBEAT_LEASE_MS - (Date.now() - heartbeatAt) } };
        }
        tx.update(fenceRef, { state: 'closed-cancelled', updatedAt: Date.now() });
        return { code: 200, payload: { ok: true, state: 'closed-cancelled' } };
      });
      return NextResponse.json(result.payload, { status: result.code });
    }

    // ---------- op: outstanding ----------
    if (op === 'outstanding') {
      const itemsCount = await fenceRef.collection('items').count().get();
      return NextResponse.json({
        ok: true,
        state: fenceSnap.get('state'),
        mode: fenceSnap.get('mode'),
        workspaceId: fenceSnap.get('workspaceId'),
        heartbeatAt: fenceSnap.get('heartbeatAt') ?? null,
        outstandingItems: itemsCount.data().count,
      });
    }

    // ---------- op: ack-items ----------
    if (op === 'ack-items') {
      const rawIds = Array.isArray(body.ids) ? (body.ids as unknown[]) : [];
      const ids = rawIds.filter((i): i is string => typeof i === 'string');
      if (ids.length === 0 || ids.length > CHUNK_LIMIT) {
        return NextResponse.json({ error: 'Ids chunk must be 1-100' }, { status: 400 });
      }
      const state = fenceSnap.get('state');
      if (state !== 'closed-cancelled' && state !== 'closed-success') {
        return NextResponse.json({ error: 'Fence is still open' }, { status: 409 });
      }
      const result = await db.runTransaction(async (tx) => {
        for (const id of ids) {
          tx.delete(fenceRef.collection('items').doc(encodeURIComponent(id)));
        }
        return { code: 200, payload: { ok: true, acknowledged: ids.length } };
      });
      return NextResponse.json(result.payload, { status: result.code });
    }

    return NextResponse.json({ error: 'Unknown op' }, { status: 400 });
  } catch (e) {
    console.error('archive/import-fence error:', e);
    return NextResponse.json({ error: 'Import fence operation failed' }, { status: 500 });
  }
}
