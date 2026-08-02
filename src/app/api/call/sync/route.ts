import { NextRequest, NextResponse } from 'next/server';
import { getAdminDb } from '@/lib/firebase-admin';
import { authUid, refreshCallLimitState } from '../_lib';

export const runtime = 'nodejs';
export const maxDuration = 30;
export const dynamic = 'force-dynamic';

// POST /api/call/sync — refreshes trusted presence from the server. The call client invokes this
// periodically so an owner changing a user's tier affects an active call without waiting for a new
// join or leave event.
export async function POST(request: NextRequest) {
  const uidOrErr = await authUid(request);
  if (typeof uidOrErr !== 'string') return uidOrErr;

  try {
    const body = await request.json().catch(() => ({}));
    const callDropId = typeof body.callDropId === 'string' ? body.callDropId : null;
    if (!callDropId) return NextResponse.json({ error: 'callDropId is required' }, { status: 400 });

    const db = getAdminDb();
    const callSnap = await db.collection('drops').doc(callDropId).get();
    const roster = callSnap.data()?.callParticipantUids;
    if (
      !callSnap.exists ||
      callSnap.data()?.type !== 'call' ||
      callSnap.data()?.callState !== 'live' ||
      !Array.isArray(roster) ||
      !roster.includes(uidOrErr)
    ) {
      return NextResponse.json({ error: 'Not an active call participant' }, { status: 403 });
    }

    const state = await refreshCallLimitState(db, callDropId);
    return NextResponse.json({
      trustedParticipantCount: state.trustedParticipantCount,
      deadlineAt: state.deadlineMs,
      expired: state.expired,
    });
  } catch (error) {
    console.error('[call/sync] failed:', error);
    return NextResponse.json({ error: 'Could not sync call limit' }, { status: 503 });
  }
}
