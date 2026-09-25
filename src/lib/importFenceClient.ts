'use client';

// ROUND 12 (part J) — the client face of /api/archive/import-fence (§4.4). All ops are
// bounded by the route (100 items / 5 disposition chunks per call); callers chunk.

import { getAuth } from 'firebase/auth';

export type ImportFenceMode = 'fresh' | 'merge';
export interface ImportFenceItem { kind: string; id: string }
export interface ImportDispositionEntry { id: string; disposition: 'committed' | 'not-committed' }
export interface ImportDispositionChunk { index: number; entries: ImportDispositionEntry[] }
export interface ImportFenceOutstanding {
  state: 'open' | 'closed-success' | 'closed-cancelled';
  mode: ImportFenceMode;
  workspaceId: string;
  outstandingItems: number;
  heartbeatAt: unknown;
}

async function fenceFetch(body: Record<string, unknown>): Promise<{ ok: boolean; status: number; json: Record<string, unknown> }> {
  const token = await getAuth().currentUser?.getIdToken();
  if (!token) return { ok: false, status: 401, json: {} };
  try {
    const res = await fetch('/api/archive/import-fence', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { ok: res.ok && json.ok === true, status: res.status, json };
  } catch {
    return { ok: false, status: 0, json: {} };
  }
}

export async function openImportFence(jobId: string, workspaceId: string, mode: ImportFenceMode): Promise<boolean> {
  return (await fenceFetch({ op: 'open', jobId, workspaceId, mode })).ok;
}

export async function registerImportItems(jobId: string, items: ImportFenceItem[]): Promise<boolean> {
  return (await fenceFetch({ op: 'register', jobId, items })).ok;
}

// 'ok' = beat recorded; 'closed' = the fence is no longer open (409 — stop producing);
// 'error' = transient (retry next tick — the rules at the Firestore boundary are the real
// cancellation enforcement).
export async function heartbeatImportFence(jobId: string): Promise<'ok' | 'closed' | 'error'> {
  const r = await fenceFetch({ op: 'heartbeat', jobId });
  if (r.ok) return 'ok';
  if (r.status === 409) return 'closed';
  return 'error';
}

export async function recordImportDispositions(jobId: string, chunks: ImportDispositionChunk[]): Promise<boolean> {
  return (await fenceFetch({ op: 'disposition', jobId, chunks })).ok;
}

export async function completeImportFence(jobId: string, expectedTotal: number): Promise<boolean> {
  return (await fenceFetch({ op: 'complete', jobId, expectedTotal })).ok;
}

export async function cancelImportFence(jobId: string, override: boolean): Promise<boolean> {
  return (await fenceFetch({ op: 'cancel', jobId, override })).ok;
}

// Resolve an uncertain complete/cancel response from the durable fence, never from a
// local request outcome. A missing or malformed response is deliberately not success.
export async function getImportFenceOutstanding(jobId: string): Promise<ImportFenceOutstanding | null> {
  const response = await fenceFetch({ op: 'outstanding', jobId });
  const value = response.json;
  if (!response.ok
    || (value.state !== 'open' && value.state !== 'closed-success' && value.state !== 'closed-cancelled')
    || (value.mode !== 'fresh' && value.mode !== 'merge')
    || typeof value.workspaceId !== 'string'
    || !Number.isSafeInteger(value.outstandingItems)
    || (value.outstandingItems as number) < 0) return null;
  return {
    state: value.state,
    mode: value.mode,
    workspaceId: value.workspaceId,
    outstandingItems: value.outstandingItems as number,
    heartbeatAt: value.heartbeatAt,
  };
}

// ids are RAW 'kind:refId' strings — the route re-encodes them to ledger doc ids.
export async function ackImportItems(jobId: string, ids: string[]): Promise<boolean> {
  return (await fenceFetch({ op: 'ack-items', jobId, ids })).ok;
}

// Recovery existence probe (R14-D4 hotfix-4): client reads of MISSING docs are
// rules-denied (the read rules dereference the document body), so recovery asks the
// Admin route instead. ids are RAW 'kind:refId' strings (kind: drop | category |
// workspace | fence; fence refId is the full fence doc id); callers chunk to <=100.
// Returns null on any uncertainty — the caller treats that as a failed cleanup check.
export interface ImportProbeResult {
  absent: string[];
  present: string[];
  fenceState: Record<string, { state: string; heartbeatAt: number | null }>;
}
export async function probeImportItems(jobId: string, ids: string[]): Promise<ImportProbeResult | null> {
  const response = await fenceFetch({ op: 'probe-items', jobId, ids });
  const value = response.json;
  if (!response.ok
    || !Array.isArray(value.absent) || !value.absent.every((entry) => typeof entry === 'string')
    || !Array.isArray(value.present) || !value.present.every((entry) => typeof entry === 'string')) return null;
  const fenceState: ImportProbeResult['fenceState'] = {};
  if (value.fenceState && typeof value.fenceState === 'object') {
    for (const [key, raw] of Object.entries(value.fenceState as Record<string, unknown>)) {
      const record = raw as Record<string, unknown>;
      if (typeof record?.state === 'string') {
        fenceState[key] = { state: record.state, heartbeatAt: typeof record.heartbeatAt === 'number' ? record.heartbeatAt : null };
      }
    }
  }
  return { absent: value.absent as string[], present: value.present as string[], fenceState };
}
