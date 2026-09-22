'use client';

// ROUND 12 (part K) — the client face of /api/account/barrier-*. Thin, typed, and
// deliberately dumb: every decision lives in the routes' committed transactions. The
// account flow (accountDeletion.ts) is the ONLY caller.

import { getAuth } from 'firebase/auth';

export type AccountBarrierState = 'none' | 'active' | 'cancelled' | 'finalizing' | 'removed';

async function barrierFetch(path: string): Promise<{ ok: boolean; status: number; json: Record<string, unknown> }> {
  const token = await getAuth().currentUser?.getIdToken();
  if (!token) return { ok: false, status: 401, json: {} };
  try {
    const res = await fetch(path, { method: 'POST', headers: { Authorization: 'Bearer ' + token } });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { ok: res.ok && json.ok === true, status: res.status, json };
  } catch {
    return { ok: false, status: 0, json: {} };
  }
}

// Creates/reactivates the caller's barrier. `finalizing` means a previous attempt already
// committed the finalizer — the caller resumes the committed tail, not a new flow.
export async function acquireAccountBarrier(): Promise<{ ok: boolean; state?: AccountBarrierState; attempt?: number }> {
  const r = await barrierFetch('/api/account/barrier-acquire');
  return {
    ok: r.ok,
    state: typeof r.json.state === 'string' ? (r.json.state as AccountBarrierState) : undefined,
    attempt: typeof r.json.attempt === 'number' ? r.json.attempt : undefined,
  };
}

// THE FINALIZER call (F1): must be the LAST token-bearing request before
// firebaseUser.delete(). ok:false + refused=true (409) = another device's abort landed
// first (or no barrier) — the caller HALTS before any Auth deletion. A network failure is
// also ok:false — the caller halts; the next attempt's acquire reports finalizing and
// resumes the tail. The committed transaction order alone decides.
export async function completeAccountBarrier(): Promise<{ ok: boolean; refused?: boolean }> {
  const r = await barrierFetch('/api/account/barrier-complete');
  return { ok: r.ok, refused: r.status === 409 };
}

// Best-effort living-owner recovery for every failure path. Refused (and moot) once
// `finalizing` committed — callers treat it as fire-and-forget.
export async function abortAccountBarrier(): Promise<void> {
  await barrierFetch('/api/account/barrier-abort');
}
