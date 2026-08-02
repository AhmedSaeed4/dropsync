import { NextRequest, NextResponse } from 'next/server';
import { getAdminDb } from '@/lib/firebase-admin';
import {
  CALL_PRESENCE_STALE_MS,
  authUid,
  cascadeCallSubcollections,
  deriveCallLimitFields,
  enforceExpiredCall,
  getTrustedStatusMapInTransaction,
} from '../_lib';

export const runtime = 'nodejs';
export const maxDuration = 30;
export const dynamic = 'force-dynamic';

// POST /api/call/reap-stale — body { callDropId, staleUid }. Invoked client-side from any REMAINING
// participant's 30s tick when they observe a peer go quiet. ONE transaction, FAIL-CLOSED: evicts
// staleUid ONLY if (a) the caller is a current participant, (b) staleUid is in the roster, AND
// (c) staleUid's callPresence/{staleUid}.lastSeen is >60s stale by the SERVER clock. Any read error
// or non-stale read → NO eviction (never grants a free seat / wrongly evicts). If the eviction
// empties the roster, the call is deleted + cascaded.
export async function POST(request: NextRequest) {
  try {
    const uidOrErr = await authUid(request);
    if (typeof uidOrErr !== 'string') return uidOrErr;
    const uid = uidOrErr; // the caller (a remaining participant)

    const body = await request.json().catch(() => ({}));
    const callDropId = typeof body.callDropId === 'string' ? body.callDropId : null;
    const staleUid = typeof body.staleUid === 'string' ? body.staleUid : null;
    if (!callDropId || !staleUid) {
      return NextResponse.json({ error: 'callDropId and staleUid are required' }, { status: 400 });
    }

    const db = getAdminDb();
    const callRef = db.collection('drops').doc(callDropId);
    const presenceRef = callRef.collection('callPresence').doc(staleUid);
    const nowMs = Date.now();

    let decision: { cascade: boolean; expired: boolean } = { cascade: false, expired: false };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        decision = await db.runTransaction(async (txn) => {
        const callSnap = await txn.get(callRef);
        if (!callSnap.exists) return { cascade: false, expired: false };
        if (callSnap.data()?.type !== 'call' || callSnap.data()?.callState !== 'live') {
          return { cascade: false, expired: false };
        }
        const rawDeadline = callSnap.data()?.callLimitDeadlineAt;
        const currentDeadlineMs =
          rawDeadline && typeof rawDeadline.toMillis === 'function' ? rawDeadline.toMillis() : null;
        if (currentDeadlineMs != null && currentDeadlineMs <= nowMs) {
          return { cascade: false, expired: true };
        }
        const data = callSnap.data() as { callParticipantUids?: unknown };
        const uids = Array.isArray(data.callParticipantUids)
          ? (data.callParticipantUids as unknown[]).filter((u): u is string => typeof u === 'string')
          : [];
        // (a) caller must be a current participant (defense-in-depth — the client only invokes this
        //     from a remaining participant's tick; enforce it server-side too).
        if (!uids.includes(uid)) return { cascade: false, expired: false };
        // (b) staleUid must be in the roster.
        if (!uids.includes(staleUid)) return { cascade: false, expired: false };
        // (c) read staleUid's lastSeen and FAIL-CLOSED on anything but a provably-stale value.
        const presenceSnap = await txn.get(presenceRef);
        const lastSeen = presenceSnap.exists
          ? (presenceSnap.data() as { lastSeen?: { toMillis?: () => number } | null }).lastSeen
          : null;
        if (!lastSeen || typeof lastSeen.toMillis !== 'function') return { cascade: false, expired: false };
        if (nowMs - lastSeen.toMillis() <= CALL_PRESENCE_STALE_MS) return { cascade: false, expired: false }; // not stale yet

        // Evict: remove staleUid from the roster + delete its presence doc.
        const next = uids.filter((u) => u !== staleUid);
        if (next.length === 0) {
          txn.delete(presenceRef);
          txn.delete(callRef);
          return { cascade: true, expired: false };
        }
        const trustedByUid = await getTrustedStatusMapInTransaction(txn, db, next);
        const limitFields = deriveCallLimitFields(next, trustedByUid, currentDeadlineMs, nowMs);
        txn.delete(presenceRef);
        txn.update(callRef, {
          callParticipantUids: next,
          trustedParticipantCount: limitFields.trustedParticipantCount,
          callLimitDeadlineAt: limitFields.callLimitDeadlineAt,
        });
        return { cascade: false, expired: false };
        });
      } catch (err) {
        // FAIL-CLOSED on ANY txn error — never evicts on a blip.
        console.error('call/reap-stale transaction failed:', err);
        return NextResponse.json({ error: 'Reap check failed' }, { status: 503 });
      }

      if (!decision.expired) break;
      const enforcement = await enforceExpiredCall(db, callDropId, nowMs);
      if (enforcement.ended) {
        return NextResponse.json({ ok: true, callEnded: true });
      }
    }

    if (decision.expired) {
      return NextResponse.json({ ok: true, callEnded: false });
    }

    if (decision.cascade) {
      cascadeCallSubcollections(db, callDropId).catch(() => {});
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('call/reap-stale error:', error);
    return NextResponse.json({ error: 'Reap check failed' }, { status: 503 });
  }
}
