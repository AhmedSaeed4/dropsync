import { NextRequest, NextResponse } from 'next/server';
import { getAdminDb } from '@/lib/firebase-admin';
import {
  authUid,
  cascadeCallSubcollections,
  deriveCallLimitFields,
  enforceExpiredCall,
  getTrustedStatusMapInTransaction,
} from '../_lib';

export const runtime = 'nodejs';
export const maxDuration = 30;
export const dynamic = 'force-dynamic';

// POST /api/call/leave — body { callDropId }. Enforces LAST-LEAVE-AUTO-DELETE in ONE transaction:
// read; missing → { ok, callEnded:true } (already gone — idempotent); next = roster without me; if
// next is empty → delete the call doc (the subcollection cascade runs after, best-effort) →
// { ok, callEnded:true }; else participantUids = next. The Admin SDK bypasses firestore.rules.
export async function POST(request: NextRequest) {
  try {
    const uidOrErr = await authUid(request);
    if (typeof uidOrErr !== 'string') return uidOrErr;
    const uid = uidOrErr;

    const body = await request.json().catch(() => ({}));
    const callDropId = typeof body.callDropId === 'string' ? body.callDropId : null;
    if (!callDropId) {
      return NextResponse.json({ error: 'callDropId is required' }, { status: 400 });
    }

    const db = getAdminDb();
    const callRef = db.collection('drops').doc(callDropId);
    const nowMs = Date.now();

    let decision: { callEnded: boolean; cascade: boolean; expired: boolean; noOp: boolean } = {
      callEnded: false,
      cascade: false,
      expired: false,
      noOp: false,
    };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        decision = await db.runTransaction(async (txn) => {
        const snap = await txn.get(callRef);
        if (!snap.exists) return { callEnded: true, cascade: false, expired: false, noOp: false }; // already gone — idempotent
        if (snap.data()?.callState !== 'live') return { callEnded: true, cascade: false, expired: false, noOp: false };
        const rawDeadline = snap.data()?.callLimitDeadlineAt;
        const currentDeadlineMs =
          rawDeadline && typeof rawDeadline.toMillis === 'function' ? rawDeadline.toMillis() : null;
        if (currentDeadlineMs != null && currentDeadlineMs <= nowMs) {
          return { callEnded: true, cascade: false, expired: true, noOp: false };
        }
        const data = snap.data() as { callParticipantUids?: unknown };
        const uids = Array.isArray(data.callParticipantUids)
          ? (data.callParticipantUids as unknown[]).filter((u): u is string => typeof u === 'string')
          : [];
        if (!uids.includes(uid)) {
          return { callEnded: false, cascade: false, expired: false, noOp: true };
        }
        const next = uids.filter((u) => u !== uid);
        if (next.length === 0) {
          // last leaver — the call ends. Delete the doc; subcollections cascade after the txn.
          txn.delete(callRef);
          return { callEnded: true, cascade: true, expired: false, noOp: false };
        }
        const trustedByUid = await getTrustedStatusMapInTransaction(txn, db, next);
        const limitFields = deriveCallLimitFields(next, trustedByUid, currentDeadlineMs, nowMs);
        txn.update(callRef, {
          callParticipantUids: next,
          trustedParticipantCount: limitFields.trustedParticipantCount,
          callLimitDeadlineAt: limitFields.callLimitDeadlineAt,
        });
        return { callEnded: false, cascade: false, expired: false, noOp: false };
        });
      } catch (err) {
        console.error('call/leave transaction failed:', err);
        return NextResponse.json({ error: 'Failed to leave call' }, { status: 500 });
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
      // last leaver — cascade the call's subcollections (Firestore doesn't cascade). Best-effort.
      cascadeCallSubcollections(db, callDropId).catch(() => {});
    }

    return NextResponse.json({ ok: true, callEnded: decision.callEnded });
  } catch (error) {
    console.error('call/leave error:', error);
    return NextResponse.json({ error: 'Failed to leave call' }, { status: 500 });
  }
}
