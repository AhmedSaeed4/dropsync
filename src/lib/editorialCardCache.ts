// Editorial card resource store (Round 9, Order 17 — Stage B+C).
//
// A scoped, page-visit store for decrypted drop payloads and completed video
// thumbnails, read SYNCHRONOUSLY by virtual window cards so a revisited drop
// never flashes back to its locked state (D17 / Order 15 plan §1.6–§1.7).
//
// Laws (owner-locked):
//  - Option 1 retention: successfully visited payloads and completed
//    thumbnails are NEVER evicted by size or age during the signed-in visit.
//    Only the lifecycle events below end reuse.
//  - Key = access scope + drop id + payload revision. A payload edit creates
//    a new revision; the old revision's entries are never reused.
//  - Failed work is NOT "visited": a decrypt that comes back unchanged
//    (decryptDrop's false-success catch shape) is recorded as an error, never
//    as ready plaintext. Partial success is preserved (ready text survives a
//    failed attached image). Failed parts are not retried automatically.
//  - Bounds: at most 2 decrypt jobs and 1 thumbnail job in flight; queues are
//    capped at the window row budget (oldest dropped). No timers, no polling,
//    no idle warming — work starts only from a card request or a preview.
//  - This module is PURE: no React, no Firebase, no app imports at all (the
//    row budget is mirrored below on purpose — Node's test runner and the
//    app's bundler disagree about import extensions across that file). The
//    real decrypt/thumbnail runners are injected (setRunners), so
//    `node --test` can drive it with fakes (tests/editorialCardCache.test.mjs).

// The window's mounted-row budget (keep in sync with
// EDITORIAL_WINDOW_ROW_BUDGET in editorialWindowModel.ts — the §8 battery
// asserts both are 60).
export const EDITORIAL_CARD_CACHE_ROW_BUDGET = 60;

export const EDITORIAL_CACHE_MAX_DECRYPT_JOBS = 2;
export const EDITORIAL_CACHE_MAX_THUMBNAIL_JOBS = 1;

// Structural payload shape (a superset of the app's Drop fields this store
// touches). Declared locally so the module stays import-free at runtime.
export interface CacheDrop {
  id: string;
  type?: string;
  encrypted?: boolean;
  content?: string;
  fileData?: string;
  imageData?: string;
  iv?: string;
  imageR2Key?: string;
  r2Key?: string;
  fileUrl?: string;
  imageUrl?: string;
  imageIv?: string;
  fileFormat?: string;
  mimeType?: string;
}

export type CacheDecryptRunner = (drop: CacheDrop, userId: string, signal: AbortSignal) => Promise<CacheDrop>;
export type CacheThumbnailRunner = (fileData: string, signal: AbortSignal) => Promise<string>;

// Payload revision: only locators that change when the encrypted payload
// changes. Name, pin, categories, reminders, selection NEVER qualify.
export function payloadRevision(drop: CacheDrop): string {
  return [
    drop.iv ?? '',
    drop.imageR2Key ?? '',
    drop.r2Key ?? '',
    drop.fileUrl ?? '',
    drop.imageUrl ?? '',
    drop.imageIv ?? '',
    drop.fileFormat ?? '',
    drop.mimeType ?? '',
  ].join('|');
}

export interface CardResourceSnapshot {
  text?: string;
  textReady: boolean;
  textError: boolean;
  file?: string;
  fileReady: boolean;
  fileError: boolean;
  image?: string;
  imageReady: boolean;
  imageError: boolean;
  thumbnail?: string;
  thumbnailReady: boolean;
  thumbnailError: boolean;
  // True when any part is ready (successfully visited content exists).
  ready: boolean;
  // True when the last attempt failed without producing any ready part.
  failed: boolean;
}

export const EMPTY_CARD_RESOURCE: CardResourceSnapshot = {
  textReady: false,
  textError: false,
  fileReady: false,
  fileError: false,
  imageReady: false,
  imageError: false,
  thumbnailReady: false,
  thumbnailError: false,
  ready: false,
  failed: false,
};

interface Part {
  state: 'ready' | 'error';
  value: string;
}

interface Entry {
  rev: string;
  text?: Part;
  file?: Part;
  image?: Part;
  thumbnail?: Part;
  snapshot: CardResourceSnapshot;
}

export interface CacheRunners {
  decrypt?: CacheDecryptRunner;
  thumbnail?: CacheThumbnailRunner;
}

export interface EditorialCardCache {
  // Lifecycle (Order 15 plan §1.6). A user change/replacement invalidates
  // every scope and aborts in-flight work; the same user is a no-op.
  beginSession(userId: string | null): void;
  // Confirmed access loss (permission-denied / removal notice): drop the
  // scope's entries, abort its in-flight and queued work.
  revokeScope(scope: string): void;
  // Current generation for a scope — callers capture it before their own
  // awaits and pass it back to seedFromDecrypted as a staleness guard.
  scopeGeneration(scope: string): number;
  // Synchronous read for useSyncExternalStore — stable snapshot identity
  // between mutations. revision comes from payloadRevision(drop).
  snapshot(scope: string, dropId: string, revision: string): CardResourceSnapshot;
  subscribe(scope: string, dropId: string, cb: () => void): () => void;
  // Start (or join) the decrypt job for this scope+drop+revision. No-op when
  // every applicable part is already decided, on error, already in flight, or
  // already queued.
  requestDecrypt(scope: string, dropId: string, drop: CacheDrop, userId: string): void;
  // Stage C: deduped, retained thumbnail generation for a ready file payload.
  requestThumbnail(scope: string, dropId: string, revision: string, fileData: string): void;
  // Seed from an out-of-band decrypt (Home's preview path). Same false-success
  // validation as a store-run job. Discarded when expectedScopeGen is stale.
  seedFromDecrypted(scope: string, dropId: string, raw: CacheDrop, decrypted: CacheDrop, expectedScopeGen: number): boolean;
  // Prod wiring (the hook module calls it once; tests inject via factory use).
  setRunners(runners: CacheRunners): void;
  // Diagnostics only (dev): approximate retained payload bytes. NOT a ceiling.
  approxBytes(): number;
}

// False-success validation (Order 15 plan §1.6; the primeDecryptedPreview
// principle): a part only becomes ready when its decrypted value PROVABLY
// differs from the raw input. Everything applicable that did not become ready
// is recorded as an error. Unchanged ciphertext must never read as plaintext.
function absorb(raw: CacheDrop, decrypted: CacheDrop, entry: Entry): void {
  const isText = raw.type === 'text';
  const isFile = raw.type === 'file';
  const hasAttachedImage = isText && !!raw.imageUrl;
  const valid = decrypted.encrypted === false;
  if (valid && isText && decrypted.content !== undefined && decrypted.content !== raw.content) {
    entry.text = { state: 'ready', value: decrypted.content };
  }
  if (valid && isFile && decrypted.fileData !== undefined && decrypted.fileData !== raw.fileData) {
    entry.file = { state: 'ready', value: decrypted.fileData };
  }
  if (valid && hasAttachedImage && decrypted.imageData !== undefined && decrypted.imageData !== raw.imageData) {
    entry.image = { state: 'ready', value: decrypted.imageData };
  }
  // After a completed attempt EVERY applicable part is decided: anything not
  // ready above is an error. Without this, a partial success (e.g. text ready
  // but the attached image missing) would leave a part undecided forever and
  // requestDecrypt would re-queue the whole decrypt on every commit. Failed
  // work is never "visited"; a partial success keeps its ready parts.
  // (markApplicableError below stays for the runner-THREW path, where absorb
  // never ran.)
  if (isText && !entry.text) entry.text = { state: 'error', value: '' };
  if (isFile && !entry.file) entry.file = { state: 'error', value: '' };
  if (hasAttachedImage && !entry.image) entry.image = { state: 'error', value: '' };
  if (!isText && !isFile && !entry.text) entry.text = { state: 'error', value: '' };
}

function markApplicableError(drop: CacheDrop, entry: Entry): void {
  const isText = drop.type === 'text';
  const isFile = drop.type === 'file';
  const hasAttachedImage = isText && !!drop.imageUrl;
  if (isText && !entry.text) entry.text = { state: 'error', value: '' };
  if (isFile && !entry.file) entry.file = { state: 'error', value: '' };
  if (hasAttachedImage && !entry.image) entry.image = { state: 'error', value: '' };
  if (!isText && !isFile && !hasAttachedImage && !entry.text && !entry.file && !entry.image) {
    entry.text = { state: 'error', value: '' };
  }
}

function buildSnapshot(entry: Entry): CardResourceSnapshot {
  const payloadParts = [entry.text, entry.file, entry.image];
  return {
    text: entry.text?.state === 'ready' ? entry.text.value : undefined,
    textReady: entry.text?.state === 'ready',
    textError: entry.text?.state === 'error',
    file: entry.file?.state === 'ready' ? entry.file.value : undefined,
    fileReady: entry.file?.state === 'ready',
    fileError: entry.file?.state === 'error',
    image: entry.image?.state === 'ready' ? entry.image.value : undefined,
    imageReady: entry.image?.state === 'ready',
    imageError: entry.image?.state === 'error',
    thumbnail: entry.thumbnail?.state === 'ready' ? entry.thumbnail.value : undefined,
    thumbnailReady: entry.thumbnail?.state === 'ready',
    thumbnailError: entry.thumbnail?.state === 'error',
    ready: payloadParts.some((p) => p?.state === 'ready') || entry.thumbnail?.state === 'ready',
    failed: payloadParts.every((p) => p?.state !== 'ready') && payloadParts.some((p) => p?.state === 'error'),
  };
}

export function createEditorialCardCache(rowBudget: number): EditorialCardCache {
  const scopes = new Map<string, Map<string, Entry>>();
  const subscribers = new Map<string, Set<() => void>>();
  const scopeGenerations = new Map<string, number>();
  let sessionGen = 0;
  let sessionUser: string | null = null;
  let decryptRunning = 0;
  let thumbnailRunning = 0;
  const decryptQueue: Array<{
    scope: string; dropId: string; rev: string; drop: CacheDrop; userId: string; sessionGen: number; scopeGen: number;
  }> = [];
  const thumbnailQueue: Array<{
    scope: string; dropId: string; rev: string; fileData: string; sessionGen: number; scopeGen: number;
  }> = [];
  const inFlight = new Map<string, AbortController>();
  let runners: CacheRunners = {};

  const keyOf = (scope: string, dropId: string): string => `${scope}\u0000${dropId}`;
  // In-flight keys put the SCOPE LAST so revokeScope's endsWith abort-match
  // finds every job belonging to the revoked scope. The REVISION sits between
  // the drop id and the scope (WV-5, Order 21): an in-flight job for an OLD
  // revision must not silently swallow a demand for a NEW one.
  const flightKey = (kind: string, scope: string, dropId: string, rev: string): string =>
    `${kind}\u0000${dropId}\u0000${rev}\u0000${scope}`;

  function entryFor(scope: string, dropId: string, rev: string): Entry | undefined {
    const e = scopes.get(scope)?.get(dropId);
    // A revision change means the payload was edited: the old revision's
    // entry is never reused (and the new revision starts empty).
    if (!e || e.rev !== rev) return undefined;
    return e;
  }

  function publish(scope: string, dropId: string, entry: Entry): void {
    entry.snapshot = buildSnapshot(entry);
    subscribers.get(keyOf(scope, dropId))?.forEach((cb) => cb());
  }

  function scopeAlive(scope: string, gen: number): boolean {
    return (scopeGenerations.get(scope) ?? 0) === gen;
  }

  function pumpDecrypt(): void {
    while (decryptRunning < EDITORIAL_CACHE_MAX_DECRYPT_JOBS && decryptQueue.length > 0) {
      const job = decryptQueue.shift();
      if (!job) return;
      // Stale jobs (revoked scope / ended session / dropped runner) are
      // skipped without consuming permits they never took.
      if (!scopeAlive(job.scope, job.scopeGen) || job.sessionGen !== sessionGen || !runners.decrypt) continue;
      const runner = runners.decrypt;
      const controller = new AbortController();
      const k = flightKey('d', job.scope, job.dropId, job.rev);
      inFlight.set(k, controller);
      decryptRunning += 1;
      runner(job.drop, job.userId, controller.signal)
        .then((decrypted) => {
          if (!scopeAlive(job.scope, job.scopeGen) || job.sessionGen !== sessionGen) return;
          const entry = entryFor(job.scope, job.dropId, job.rev);
          if (!entry) return;
          absorb(job.drop, decrypted, entry);
          publish(job.scope, job.dropId, entry);
        })
        .catch(() => {
          if (!scopeAlive(job.scope, job.scopeGen) || job.sessionGen !== sessionGen) return;
          const entry = entryFor(job.scope, job.dropId, job.rev);
          if (!entry) return;
          markApplicableError(job.drop, entry);
          publish(job.scope, job.dropId, entry);
        })
        .finally(() => {
          inFlight.delete(k);
          decryptRunning -= 1;
          pumpDecrypt();
        });
    }
  }

  function pumpThumbnail(): void {
    while (thumbnailRunning < EDITORIAL_CACHE_MAX_THUMBNAIL_JOBS && thumbnailQueue.length > 0) {
      const job = thumbnailQueue.shift();
      if (!job) return;
      if (!scopeAlive(job.scope, job.scopeGen) || job.sessionGen !== sessionGen || !runners.thumbnail) continue;
      const runner = runners.thumbnail;
      const controller = new AbortController();
      const k = flightKey('t', job.scope, job.dropId, job.rev);
      inFlight.set(k, controller);
      thumbnailRunning += 1;
      runner(job.fileData, controller.signal)
        .then((dataUrl) => {
          if (!scopeAlive(job.scope, job.scopeGen) || job.sessionGen !== sessionGen) return;
          const entry = entryFor(job.scope, job.dropId, job.rev);
          if (!entry) return;
          entry.thumbnail = { state: 'ready', value: dataUrl };
          publish(job.scope, job.dropId, entry);
        })
        .catch(() => {
          if (!scopeAlive(job.scope, job.scopeGen) || job.sessionGen !== sessionGen) return;
          const entry = entryFor(job.scope, job.dropId, job.rev);
          if (!entry) return;
          if (!entry.thumbnail) entry.thumbnail = { state: 'error', value: '' };
          publish(job.scope, job.dropId, entry);
        })
        .finally(() => {
          inFlight.delete(k);
          thumbnailRunning -= 1;
          pumpThumbnail();
        });
    }
  }

  return {
    beginSession(userId: string | null): void {
      if (userId === sessionUser) return; // same visit: keep everything
      sessionUser = userId;
      sessionGen += 1;
      scopes.clear();
      scopeGenerations.clear();
      decryptQueue.length = 0;
      thumbnailQueue.length = 0;
      inFlight.forEach((c) => c.abort());
      inFlight.clear();
    },
    revokeScope(scope: string): void {
      const nextGen = (scopeGenerations.get(scope) ?? 0) + 1;
      scopeGenerations.set(scope, nextGen);
      scopes.delete(scope);
      for (let i = decryptQueue.length - 1; i >= 0; i--) {
        if (decryptQueue[i].scope === scope) decryptQueue.splice(i, 1);
      }
      for (let i = thumbnailQueue.length - 1; i >= 0; i--) {
        if (thumbnailQueue[i].scope === scope) thumbnailQueue.splice(i, 1);
      }
      inFlight.forEach((controller, k) => {
        if (k.endsWith(`\u0000${scope}`)) controller.abort();
      });
    },
    scopeGeneration(scope: string): number {
      return scopeGenerations.get(scope) ?? 0;
    },
    snapshot(scope: string, dropId: string, revision: string): CardResourceSnapshot {
      return entryFor(scope, dropId, revision)?.snapshot ?? EMPTY_CARD_RESOURCE;
    },
    subscribe(scope: string, dropId: string, cb: () => void): () => void {
      const k = keyOf(scope, dropId);
      let set = subscribers.get(k);
      if (!set) {
        set = new Set();
        subscribers.set(k, set);
      }
      set.add(cb);
      return () => {
        const cur = subscribers.get(k);
        if (!cur) return;
        cur.delete(cb);
        if (cur.size === 0) subscribers.delete(k);
      };
    },
    requestDecrypt(scope: string, dropId: string, drop: CacheDrop, userId: string): void {
      const rev = payloadRevision(drop);
      // The request CREATES the entry it will fill (seedFromDecrypted is the
      // other creator); a revision change starts a fresh entry and the old
      // revision's decided parts are never reused.
      let scopeMap = scopes.get(scope);
      if (!scopeMap) {
        scopeMap = new Map();
        scopes.set(scope, scopeMap);
      }
      let entry = scopeMap.get(dropId);
      if (!entry || entry.rev !== rev) {
        entry = { rev, snapshot: EMPTY_CARD_RESOURCE };
        scopeMap.set(dropId, entry);
      }
      const isText = drop.type === 'text';
      const isFile = drop.type === 'file';
      const hasAttachedImage = isText && !!drop.imageUrl;
      const allDecided =
        (!isText || entry.text !== undefined) &&
        (!isFile || entry.file !== undefined) &&
        (!hasAttachedImage || entry.image !== undefined);
      if (allDecided) return; // every applicable part ready or errored: nothing to do
      const anyError =
        (isText && entry.text?.state === 'error') ||
        (isFile && entry.file?.state === 'error') ||
        (hasAttachedImage && entry.image?.state === 'error');
      if (anyError) return; // failed work is not retried automatically
      if (inFlight.has(flightKey('d', scope, dropId, rev))) return; // this revision is already running
      if (decryptQueue.some((j) => j.scope === scope && j.dropId === dropId && j.rev === rev)) return;
      // WV-5 (Order 21): a demand arriving while an OLDER revision runs must
      // queue - the running job can no longer fill the entry it replaced.
      // Latest-wins: a still-queued job for this drop from a superseded
      // revision is dropped, so the queue holds at most one job per drop.
      for (let i = decryptQueue.length - 1; i >= 0; i--) {
        if (decryptQueue[i].scope === scope && decryptQueue[i].dropId === dropId) decryptQueue.splice(i, 1);
      }
      const job = { scope, dropId, rev, drop, userId, sessionGen, scopeGen: scopeGenerations.get(scope) ?? 0 };
      decryptQueue.push(job);
      while (decryptQueue.length > rowBudget) decryptQueue.shift(); // oldest dropped, newest win
      pumpDecrypt();
    },
    requestThumbnail(scope: string, dropId: string, revision: string, fileData: string): void {
      const entry = entryFor(scope, dropId, revision);
      if (entry?.thumbnail) return; // ready or already errored: no auto retry
      if (inFlight.has(flightKey('t', scope, dropId, revision))) return; // this revision is already running
      if (thumbnailQueue.some((j) => j.scope === scope && j.dropId === dropId && j.rev === revision)) return;
      // WV-5 (Order 21): same repair as decrypt - a demand during an older
      // revision's flight queues, and a superseded queued thumbnail is
      // replaced (at most one queued job per drop).
      for (let i = thumbnailQueue.length - 1; i >= 0; i--) {
        if (thumbnailQueue[i].scope === scope && thumbnailQueue[i].dropId === dropId) thumbnailQueue.splice(i, 1);
      }
      thumbnailQueue.push({
        scope, dropId, rev: revision, fileData, sessionGen, scopeGen: scopeGenerations.get(scope) ?? 0,
      });
      while (thumbnailQueue.length > rowBudget) thumbnailQueue.shift();
      pumpThumbnail();
    },
    seedFromDecrypted(scope: string, dropId: string, raw: CacheDrop, decrypted: CacheDrop, expectedScopeGen: number): boolean {
      if (!scopeAlive(scope, expectedScopeGen)) return false; // revoked mid-preview
      const rev = payloadRevision(raw);
      let scopeMap = scopes.get(scope);
      if (!scopeMap) {
        scopeMap = new Map();
        scopes.set(scope, scopeMap);
      }
      let entry = scopeMap.get(dropId);
      if (!entry || entry.rev !== rev) {
        entry = { rev, snapshot: EMPTY_CARD_RESOURCE };
        scopeMap.set(dropId, entry);
      }
      absorb(raw, decrypted, entry);
      publish(scope, dropId, entry);
      return entry.text?.state === 'ready' || entry.file?.state === 'ready' || entry.image?.state === 'ready';
    },
    setRunners(next: CacheRunners): void {
      runners = next;
      pumpDecrypt();
      pumpThumbnail();
    },
    approxBytes(): number {
      let total = 0;
      scopes.forEach((m) =>
        m.forEach((entry) => {
          total +=
            (entry.text?.value.length ?? 0) +
            (entry.file?.value.length ?? 0) +
            (entry.image?.value.length ?? 0) +
            (entry.thumbnail?.value.length ?? 0);
        })
      );
      return total;
    },
  };
}

// Production singleton (row budget = the window's mounted-row budget; the
// mirrored constant above). Runners are wired lazily by
// useEditorialCardResources.ts so this module never imports app code.
export const editorialCardCache: EditorialCardCache = createEditorialCardCache(EDITORIAL_CARD_CACHE_ROW_BUDGET);
