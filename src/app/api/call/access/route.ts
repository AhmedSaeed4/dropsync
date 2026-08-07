import { NextRequest, NextResponse } from 'next/server';
import { getAdminDb } from '@/lib/firebase-admin';
import { authUid, getCallUsageState, isTrustedCallUser, releaseNeverConfirmedReservation } from '../_lib';

export const runtime = 'nodejs';
export const maxDuration = 30;
export const dynamic = 'force-dynamic';

// POST /api/call/access — returns the current user's ability to START a call. Joining an existing
// trusted-user call remains a separate decision enforced by /api/call/join.
export async function POST(request: NextRequest) {
  const uidOrErr = await authUid(request);
  if (typeof uidOrErr !== 'string') return uidOrErr;

  try {
    const db = getAdminDb();
    const trusted = await isTrustedCallUser(db, uidOrErr);
    if (trusted) return NextResponse.json({ canStart: true, trusted: true, resetAt: null });

    // LAZY RELEASE (load-bearing): a reservation for a never-confirmed (pending) call — e.g. the
    // user closed the tab mid-start — must NEVER leave the Start button blocked. Clear it with zero
    // charge; the daily sweep deletes the orphaned pending doc. An in-flight start in another tab
    // self-heals because /api/call/confirm re-reserves before promoting.
    await releaseNeverConfirmedReservation(db, uidOrErr);

    const usage = await getCallUsageState(db, uidOrErr);
    return NextResponse.json({
      canStart: !usage.limited,
      trusted: false,
      resetAt: usage.limited ? usage.resetAtMs : null,
    });
  } catch (error) {
    console.error('[call/access] failed:', error);
    // Fail closed: a limit lookup failure must not grant a standard user a new call.
    return NextResponse.json({ error: 'Could not verify call access' }, { status: 503 });
  }
}
