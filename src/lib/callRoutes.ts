// Client wrappers for /api/call/* — the routes are the SOLE enforcer of the 3 call invariants
// (one-call-per-workspace / capacity-4 / last-leave-auto-delete). All routes take a Firebase Bearer
// token → verifyIdToken → uid server-side (NEVER trust a body uid). These are thin fetches; the
// routes do the transactional work (Admin SDK bypasses firestore.rules; the rules are defense-in-
// depth). Mirrors the auth contract of /api/transcribe.

import { auth } from './firebase';

export const CALL_LIMIT_MESSAGE =
  'Your 30-minute daily call allowance has been used. You can still join a call with a trusted user.';

async function callRoute<T = unknown>(path: string, body: Record<string, unknown>): Promise<T> {
  const user = auth.currentUser;
  if (!user) throw new Error('Not signed in');
  const token = await user.getIdToken();
  const res = await fetch(`/api/call/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Surface the route's message verbatim — the join 409 carries the exact capacity copy the UI
    // toasts (§11). Attach the status so callers can branch (e.g. capacity vs. generic).
    const msg =
      (data && typeof data.error === 'string' && data.error) || `Call ${path} failed`;
    const err = new Error(msg) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return data as T;
}

/**
 * Start (or join an existing live) call in a workspace. The start route is idempotent on the
 * deterministic doc id `drops/call-{workspaceId}` — if a live call already exists it returns that
 * id (intent: starting another just joins the existing one). Returns the call drop id to join.
 */
export async function startCallRoute(workspaceId: string): Promise<{
  callDropId: string;
  created?: boolean;
  callHostUid?: string;
  creatorName?: string;
  callParticipantUids?: string[];
}> {
  return callRoute('start', { workspaceId });
}

/** Join a call. Throws (status 409) with the exact capacity message when the call is full. */
export async function joinCallRoute(
  callDropId: string,
): Promise<{ ok: true; already?: boolean }> {
  return callRoute('join', { callDropId });
}

/** Leave a call. `callEnded` is true when this was the last leaver (the route deleted the doc). */
export async function leaveCallRoute(
  callDropId: string,
): Promise<{ ok: boolean; callEnded?: boolean }> {
  return callRoute('leave', { callDropId });
}

/**
 * Reap a stale participant — invoked client-side from any REMAINING participant's 30s tick when
 * they observe a peer whose callPresence lastSeen is >60s stale. Fail-closed server-side: never
 * grants a free seat or wrongly evicts. Best-effort on the client (swallowed by the caller).
 */
export async function reapStaleCallRoute(callDropId: string, staleUid: string): Promise<void> {
  await callRoute('reap-stale', { callDropId, staleUid });
}

/**
 * Fetch a short-lived LiveKit access token for a call the caller has ALREADY joined (joinCallRoute
 * ran first and appended them to the roster). Returns the JWT + the LiveKit server URL + room name;
 * the client calls room.connect(url, token). The token route re-verifies the caller is a current
 * participant, so this can never mint a token for a room the user was not admitted to.
 */
export async function getCallTokenRoute(
  callDropId: string,
): Promise<{ token: string; url: string; roomName: string }> {
  return callRoute<{ token: string; url: string; roomName: string }>('token', { callDropId });
}

/** Fetch the server decision for whether this user may use more call time today. */
export async function getCallAccessRoute(): Promise<{
  canStart: boolean;
  trusted: boolean;
  resetAt: number | null;
}> {
  return callRoute<{ canStart: boolean; trusted: boolean; resetAt: number | null }>('access', {});
}

/** Refresh trusted presence, the no-trusted deadline, and daily usage for an active call. */
export async function syncCallLimitRoute(callDropId: string): Promise<{
  trustedParticipantCount: number;
  deadlineAt: number | null;
  expired: boolean;
  ended: boolean;
  minutesUsedToday: number;
  callTotalMinutes: number;
  trusted: boolean;
}> {
  return callRoute('sync', { callDropId });
}
