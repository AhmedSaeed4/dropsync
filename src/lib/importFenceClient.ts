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

// ORDER 62: owner-bound continuations never borrow another session's credentials.
export class ArchiveContextExpiredError extends Error {
  constructor(message = 'Archive owner context expired.') { super(message); this.name = 'ArchiveContextExpiredError'; }
}
export interface ArchiveOwnerContext {
  uid: string;
  generation: string;
  signal?: AbortSignal;
  check: () => void;
}
export function createArchiveOwnerContext(
  uid: string, generation = 'foreground', validate: () => void = () => {}, signal?: AbortSignal
): ArchiveOwnerContext {
  const user = getAuth().currentUser;
  const context: ArchiveOwnerContext = {
    uid, generation, signal,
    check: () => {
      if (signal?.aborted || !user || user.uid !== uid || getAuth().currentUser !== user) {
        throw new ArchiveContextExpiredError();
      }
      validate();
    },
  };
  context.check();
  return context;
}

// Read waits may be abandoned. Mutation waits MUST settle before their lock is released.
export async function awaitArchiveOwner<T>(
  owner: ArchiveOwnerContext, operation: () => Promise<T>, abandonRead = false
): Promise<T> {
  owner.check();
  const pending = operation();
  let remove = () => {};
  try {
    const result = abandonRead && owner.signal ? await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        const abort = () => reject(new ArchiveContextExpiredError());
        owner.signal!.addEventListener('abort', abort, { once: true });
        remove = () => owner.signal!.removeEventListener('abort', abort);
        if (owner.signal!.aborted) abort();
      }),
    ]) : await pending;
    owner.check();
    return result;
  } finally { remove(); }
}

export async function archiveOwnerToken(owner: ArchiveOwnerContext): Promise<string> {
  return awaitArchiveOwner(owner, () => {
    const user = getAuth().currentUser;
    if (!user || user.uid !== owner.uid) throw new ArchiveContextExpiredError();
    return user.getIdToken();
  }, true);
}

async function fenceFetch(body: Record<string, unknown>, context?: ArchiveOwnerContext): Promise<{ ok: boolean; status: number; json: Record<string, unknown> }> {
  const uid = getAuth().currentUser?.uid;
  if (!context && !uid) return { ok: false, status: 401, json: {} };
  const owner = context ?? createArchiveOwnerContext(uid!);
  owner.check();
  try {
    const token = await archiveOwnerToken(owner);
    const res = await awaitArchiveOwner(owner, () => fetch('/api/archive/import-fence', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: owner.signal,
    }), true);
    const json = await awaitArchiveOwner(owner, async () => (await res.json().catch(() => ({}))) as Record<string, unknown>, true);
    return { ok: res.ok && json.ok === true, status: res.status, json };
  } catch (error) {
    owner.check();
    if (error instanceof ArchiveContextExpiredError) throw error;
    return { ok: false, status: 0, json: {} };
  }
}

export async function openImportFence(jobId: string, workspaceId: string, mode: ImportFenceMode, owner?: ArchiveOwnerContext): Promise<boolean> {
  return (await fenceFetch({ op: 'open', jobId, workspaceId, mode }, owner)).ok;
}

export async function registerImportItems(jobId: string, items: ImportFenceItem[], owner?: ArchiveOwnerContext): Promise<boolean> {
  return (await fenceFetch({ op: 'register', jobId, items }, owner)).ok;
}

// 'ok' = beat recorded; 'closed' = the fence is no longer open (409 — stop producing);
// 'error' = transient (retry next tick — the rules at the Firestore boundary are the real
// cancellation enforcement).
export async function heartbeatImportFence(jobId: string, owner?: ArchiveOwnerContext): Promise<'ok' | 'closed' | 'error'> {
  const r = await fenceFetch({ op: 'heartbeat', jobId }, owner);
  if (r.ok) return 'ok';
  if (r.status === 409) return 'closed';
  return 'error';
}

export async function recordImportDispositions(jobId: string, chunks: ImportDispositionChunk[], owner?: ArchiveOwnerContext): Promise<boolean> {
  return (await fenceFetch({ op: 'disposition', jobId, chunks }, owner)).ok;
}

export async function completeImportFence(jobId: string, expectedTotal: number, owner?: ArchiveOwnerContext): Promise<boolean> {
  return (await fenceFetch({ op: 'complete', jobId, expectedTotal }, owner)).ok;
}

export async function cancelImportFence(jobId: string, override: boolean, owner?: ArchiveOwnerContext): Promise<boolean> {
  return (await fenceFetch({ op: 'cancel', jobId, override }, owner)).ok;
}

// Resolve an uncertain complete/cancel response from the durable fence, never from a
// local request outcome. A missing or malformed response is deliberately not success.
export async function getImportFenceOutstanding(jobId: string, owner?: ArchiveOwnerContext): Promise<ImportFenceOutstanding | null> {
  const response = await fenceFetch({ op: 'outstanding', jobId }, owner);
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
export async function ackImportItems(jobId: string, ids: string[], owner?: ArchiveOwnerContext): Promise<boolean> {
  return (await fenceFetch({ op: 'ack-items', jobId, ids }, owner)).ok;
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
export async function probeImportItems(jobId: string, ids: string[], owner?: ArchiveOwnerContext): Promise<ImportProbeResult | null> {
  const response = await fenceFetch({ op: 'probe-items', jobId, ids }, owner);
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

export type ImportSettlementOutcome = 'adopted' | 'settled-cancelled' | 'cleanup-required' | 'remote-or-open' | 'not-found' | 'invalid';
export interface ImportSettlementResult { jobId: string; outcome: ImportSettlementOutcome }
export async function settleImportFences(jobIds: string[], owner: ArchiveOwnerContext): Promise<ImportSettlementResult[]> {
  const ids = [...new Set(jobIds)];
  const results: ImportSettlementResult[] = [];
  const outcomes: ImportSettlementOutcome[] = ['adopted', 'settled-cancelled', 'cleanup-required', 'remote-or-open', 'not-found', 'invalid'];
  for (let index = 0; index < ids.length; index += 25) {
    const chunk = ids.slice(index, index + 25);
    const response = await fenceFetch({ op: 'settle', jobIds: chunk }, owner);
    const raw = response.json.results;
    if (!response.ok || !Array.isArray(raw) || raw.length !== chunk.length) {
      throw new Error('Import cleanup settlement could not be confirmed.');
    }
    const seen = new Set<string>();
    for (const value of raw) {
      const item = value as Partial<ImportSettlementResult> | null;
      if (!item || typeof item.jobId !== 'string' || !chunk.includes(item.jobId)
        || seen.has(item.jobId) || !outcomes.includes(item.outcome as ImportSettlementOutcome)) {
        throw new Error('Import cleanup settlement returned an invalid result.');
      }
      seen.add(item.jobId);
      results.push(item as ImportSettlementResult);
    }
  }
  return results;
}
