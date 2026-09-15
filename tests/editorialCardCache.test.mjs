// Order 17 (Stage B+C) — editorialCardCache unit tests (node --test).
// The store is import-free by law, so these tests drive the REAL module with
// fake runners. Run: node --test tests/editorialCardCache.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createEditorialCardCache,
  EDITORIAL_CARD_CACHE_ROW_BUDGET,
  EMPTY_CARD_RESOURCE,
  payloadRevision,
} from '../src/lib/editorialCardCache.ts';

// Resolve a promise, then let the store's microtask chains (then → absorb →
// publish → finally → pump) fully drain before asserting.
async function flush() {
  for (let i = 0; i < 25; i++) {
    await Promise.resolve();
  }
}

const textDrop = (id, content, iv) => ({ id, type: 'text', encrypted: true, content, iv });
const plainOf = (drop, patch) => ({ ...drop, encrypted: false, ...patch });

// A decrypt runner whose results the test settles per drop id, by hand.
// Deferreds are FIFO per id: the same drop id can run sequential jobs
// (e.g. after a payload revision change) and each settles in order.
function makeDecryptRunner() {
  const calls = [];
  const pending = new Map();
  return {
    calls,
    runner(drop, userId, signal) {
      calls.push({ id: drop.id, userId, signal });
      const d = makeDeferredFor(signal);
      if (!pending.has(drop.id)) pending.set(drop.id, []);
      pending.get(drop.id).push(d);
      return d.promise;
    },
    settle(id, value) {
      pending.get(id).shift().resolve(value);
    },
    fail(id, err) {
      pending.get(id).shift().reject(err);
    },
    deferred: (id) => pending.get(id)[0],
  };
}

function makeDeferredFor(signal) {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  if (signal) {
    signal.addEventListener('abort', () => reject(new Error('aborted')));
  }
  return { promise, resolve, reject };
}

// An immediately-resolving decrypt runner (records calls, settles itself).
function instantDecryptRunner() {
  const calls = [];
  return {
    calls,
    runner: async (drop) => {
      calls.push({ id: drop.id });
      return plainOf(drop, { content: 'P-' + drop.id });
    },
  };
}

// A thumbnail runner whose results the test settles per fileData, by hand.
function makeThumbRunner() {
  const calls = [];
  const pending = new Map();
  return {
    calls,
    runner(fileData, signal) {
      calls.push({ fileData });
      const d = makeDeferredFor(signal);
      pending.set(fileData, d);
      return d.promise;
    },
    settle(fileData, value) {
      pending.get(fileData).resolve(value);
    },
    fail(fileData, err) {
      pending.get(fileData).reject(err);
    },
  };
}

test('both row-budget constants agree at 60', () => {
  assert.equal(EDITORIAL_CARD_CACHE_ROW_BUDGET, 60);
});

test('first request decrypts, then the snapshot is a stable hit', async () => {
  const cache = createEditorialCardCache(60);
  const runner = makeDecryptRunner();
  cache.setRunners({ decrypt: runner.runner });
  const drop = textDrop('t1', 'CIPHER', 'iv1');
  const rev = payloadRevision(drop);

  cache.requestDecrypt('personal', 't1', drop, 'u1');
  assert.equal(runner.calls.length, 1);
  assert.equal(runner.calls[0].userId, 'u1');
  assert.equal(cache.snapshot('personal', 't1', rev).textReady, false);
  // A missing entry reads as the shared EMPTY snapshot (stable identity).
  assert.equal(cache.snapshot('personal', 'nope', rev), EMPTY_CARD_RESOURCE);

  runner.settle('t1', plainOf(drop, { content: 'PLAIN' }));
  await flush();

  const snap = cache.snapshot('personal', 't1', rev);
  assert.equal(snap.text, 'PLAIN');
  assert.equal(snap.textReady, true);
  assert.equal(snap.ready, true);
  assert.equal(snap.failed, false);
  // useSyncExternalStore law: same identity between mutations.
  assert.equal(cache.snapshot('personal', 't1', rev), snap);
});

test('Option 1 retention: 70 visited drops, nothing evicted', async () => {
  const cache = createEditorialCardCache(60);
  const runner = instantDecryptRunner();
  cache.setRunners({ decrypt: runner.runner });
  for (let i = 0; i < 70; i++) {
    const d = textDrop(`d${i}`, `C${i}`, `iv${i}`);
    cache.requestDecrypt('personal', d.id, d, 'u1');
    await flush();
  }
  for (let i = 0; i < 70; i++) {
    const d = textDrop(`d${i}`, `C${i}`, `iv${i}`);
    const snap = cache.snapshot('personal', d.id, payloadRevision(d));
    assert.equal(snap.textReady, true, `drop d${i} must survive the visit`);
    assert.equal(snap.text, `P-d${i}`);
  }
});

test('false success (payload unchanged) is an error, never plaintext, never retried', async () => {
  const cache = createEditorialCardCache(60);
  const runner = makeDecryptRunner();
  cache.setRunners({ decrypt: runner.runner });
  const drop = textDrop('t1', 'CIPHERTEXT', 'iv1');
  cache.requestDecrypt('personal', 't1', drop, 'u1');
  // decryptDrop's false-success catch shape: {...drop, encrypted: false}.
  runner.settle('t1', { ...drop, encrypted: false });
  await flush();

  const snap = cache.snapshot('personal', 't1', payloadRevision(drop));
  assert.equal(snap.text, undefined);
  assert.equal(snap.textReady, false);
  assert.equal(snap.textError, true);
  assert.equal(snap.failed, true);
  assert.equal(snap.ready, false);

  cache.requestDecrypt('personal', 't1', drop, 'u1');
  assert.equal(runner.calls.length, 1, 'failed work must not be retried automatically');
});

test('empty-text success IS ready', async () => {
  const cache = createEditorialCardCache(60);
  const runner = makeDecryptRunner();
  cache.setRunners({ decrypt: runner.runner });
  const drop = textDrop('t1', 'CIPHER', 'iv1');
  cache.requestDecrypt('personal', 't1', drop, 'u1');
  runner.settle('t1', plainOf(drop, { content: '' }));
  await flush();
  const snap = cache.snapshot('personal', 't1', payloadRevision(drop));
  assert.equal(snap.textReady, true);
  assert.equal(snap.text, '');
});

test('partial success: ready text survives a missing attached image, no re-decrypt loop', async () => {
  const cache = createEditorialCardCache(60);
  const runner = makeDecryptRunner();
  cache.setRunners({ decrypt: runner.runner });
  const drop = { id: 't9', type: 'text', encrypted: true, content: 'C', iv: 'iv9', imageUrl: 'https://img' };
  cache.requestDecrypt('personal', 't9', drop, 'u1');
  // decryptDrop succeeded for the text but produced NO imageData (its private
  // image catch swallowed the failure). Every applicable part must now be
  // decided — otherwise requestDecrypt would re-queue forever.
  runner.settle('t9', plainOf(drop, { content: 'PLAIN' }));
  await flush();

  const snap = cache.snapshot('personal', 't9', payloadRevision(drop));
  assert.equal(snap.textReady, true);
  assert.equal(snap.text, 'PLAIN');
  assert.equal(snap.imageReady, false);
  assert.equal(snap.imageError, true);
  assert.equal(snap.ready, true);
  assert.equal(snap.failed, false);

  cache.requestDecrypt('personal', 't9', drop, 'u1');
  assert.equal(runner.calls.length, 1, 'a decided entry must not re-queue the decrypt');
});

test('two requests for the same payload dedupe to one runner call', async () => {
  const cache = createEditorialCardCache(60);
  const runner = makeDecryptRunner();
  cache.setRunners({ decrypt: runner.runner });
  const drop = textDrop('t1', 'C', 'iv1');
  cache.requestDecrypt('personal', 't1', drop, 'u1');
  cache.requestDecrypt('personal', 't1', drop, 'u1');
  cache.requestDecrypt('personal', 't1', drop, 'u1');
  assert.equal(runner.calls.length, 1);
});

test('at most 2 decrypt jobs run; a permit frees only on settle', async () => {
  const cache = createEditorialCardCache(60);
  const runner = makeDecryptRunner();
  cache.setRunners({ decrypt: runner.runner });
  cache.requestDecrypt('personal', 'a', textDrop('a', 'C', 'i1'), 'u1');
  cache.requestDecrypt('personal', 'b', textDrop('b', 'C', 'i2'), 'u1');
  cache.requestDecrypt('personal', 'c', textDrop('c', 'C', 'i3'), 'u1');
  assert.equal(runner.calls.length, 2, 'third job must wait for a permit');

  runner.settle('a', plainOf(textDrop('a', 'C', 'i1'), { content: 'PA' }));
  await flush();
  assert.equal(runner.calls.length, 3);
  assert.equal(runner.calls[2].id, 'c', 'queued job starts FIFO');
});

test('queue capped at the row budget: the oldest queued job is dropped', async () => {
  const cache = createEditorialCardCache(2);
  const runner = makeDecryptRunner();
  cache.setRunners({ decrypt: runner.runner });
  cache.requestDecrypt('personal', 'A', textDrop('A', 'C', 'i1'), 'u1');
  cache.requestDecrypt('personal', 'B', textDrop('B', 'C', 'i2'), 'u1'); // 2 in flight
  cache.requestDecrypt('personal', 'C', textDrop('C', 'C', 'i3'), 'u1'); // queued
  cache.requestDecrypt('personal', 'D', textDrop('D', 'C', 'i4'), 'u1'); // queued
  cache.requestDecrypt('personal', 'E', textDrop('E', 'C', 'i5'), 'u1'); // queue full → C dropped
  runner.settle('A', plainOf(textDrop('A', 'C', 'i1'), { content: 'PA' }));
  await flush();
  const started = runner.calls.map((c) => c.id);
  assert.equal(started.length, 3);
  assert.equal(started[2], 'D', 'D starts after A settles, not the dropped C');
  assert.ok(!started.includes('C'), 'the dropped oldest job must never run');
});

test('payload revision change: fresh decrypt, old revision never reused', async () => {
  const cache = createEditorialCardCache(60);
  const runner = makeDecryptRunner();
  cache.setRunners({ decrypt: runner.runner });
  const v1 = textDrop('t1', 'C1', 'iv1');
  cache.requestDecrypt('personal', 't1', v1, 'u1');
  runner.settle('t1', plainOf(v1, { content: 'P1' }));
  await flush();

  const v2 = textDrop('t1', 'C2', 'iv2'); // edited → new iv → new revision
  assert.notEqual(payloadRevision(v2), payloadRevision(v1));
  cache.requestDecrypt('personal', 't1', v2, 'u1');
  assert.equal(runner.calls.length, 2, 'a new revision must decrypt fresh');
  runner.settle('t1', plainOf(v2, { content: 'P2' }));
  await flush();

  assert.equal(cache.snapshot('personal', 't1', payloadRevision(v2)).text, 'P2');
  assert.equal(
    cache.snapshot('personal', 't1', payloadRevision(v1)),
    EMPTY_CARD_RESOURCE,
    'the old revision is never reused'
  );
});

test('revokeScope: entries gone, in-flight aborted, queued dropped', async () => {
  const cache = createEditorialCardCache(60);
  const runner = makeDecryptRunner();
  cache.setRunners({ decrypt: runner.runner });
  const drop = textDrop('t1', 'C', 'iv1');
  cache.requestDecrypt('personal', 't1', drop, 'u1');
  cache.requestDecrypt('personal', 't2', textDrop('t2', 'C', 'iv2'), 'u1'); // in flight (2 permits)
  cache.requestDecrypt('personal', 't3', textDrop('t3', 'C', 'iv3'), 'u1'); // genuinely queued

  cache.revokeScope('personal');
  assert.equal(cache.snapshot('personal', 't1', payloadRevision(drop)), EMPTY_CARD_RESOURCE);

  // Both in-flight runners reject via the abort; the store's generation check
  // discards them and the queued job never starts.
  await flush();
  assert.equal(runner.calls.length, 2, 'the queued job must never start');
  assert.equal(cache.snapshot('personal', 't3', payloadRevision(textDrop('t3', 'C', 'iv3'))), EMPTY_CARD_RESOURCE);
});

test('a completion that lands after its scope was revoked is discarded', async () => {
  const cache = createEditorialCardCache(60);
  const deferreds = [];
  cache.setRunners({
    decrypt: () => {
      const d = makeDeferredFor(null);
      deferreds.push(d);
      return d.promise;
    },
  });
  const drop = textDrop('t1', 'C', 'iv1');
  cache.requestDecrypt('personal', 't1', drop, 'u1');
  cache.revokeScope('personal');
  deferreds[0].resolve(plainOf(drop, { content: 'LATE' }));
  await flush();
  assert.equal(cache.snapshot('personal', 't1', payloadRevision(drop)), EMPTY_CARD_RESOURCE);
});

test('runner rejection marks an error; not auto-retried', async () => {
  const cache = createEditorialCardCache(60);
  const runner = makeDecryptRunner();
  cache.setRunners({ decrypt: runner.runner });
  const drop = textDrop('t1', 'C', 'iv1');
  cache.requestDecrypt('personal', 't1', drop, 'u1');
  runner.fail('t1', new Error('boom'));
  await flush();
  const snap = cache.snapshot('personal', 't1', payloadRevision(drop));
  assert.equal(snap.textError, true);
  assert.equal(snap.failed, true);
  cache.requestDecrypt('personal', 't1', drop, 'u1');
  assert.equal(runner.calls.length, 1);
});

test('beginSession: same user is a no-op, a user change clears + aborts', async () => {
  const cache = createEditorialCardCache(60);
  const runner = makeDecryptRunner();
  cache.setRunners({ decrypt: runner.runner });
  cache.beginSession('u1'); // the prod lifecycle: session opens before any card asks
  const drop = textDrop('t1', 'C', 'iv1');
  cache.requestDecrypt('personal', 't1', drop, 'u1');
  runner.settle('t1', plainOf(drop, { content: 'PLAIN' }));
  await flush();
  const rev = payloadRevision(drop);

  cache.beginSession('u1'); // same visit: keep everything
  assert.equal(cache.snapshot('personal', 't1', rev).text, 'PLAIN');

  cache.requestDecrypt('personal', 't9', textDrop('t9', 'C', 'iv9'), 'u1'); // now in flight
  cache.beginSession('u2'); // a different account starts fresh
  assert.equal(cache.snapshot('personal', 't1', rev), EMPTY_CARD_RESOURCE);
  await flush();
  assert.equal(runner.calls.length, 2);
  cache.requestDecrypt('personal', 't2', textDrop('t2', 'C', 'iv2'), 'u2');
  cache.beginSession(null); // signed out also clears
  assert.equal(cache.snapshot('personal', 't2', payloadRevision(textDrop('t2', 'C', 'iv2'))), EMPTY_CARD_RESOURCE);
});

test('subscribers are notified on publish and unsubscribe cleanly', async () => {
  const cache = createEditorialCardCache(60);
  const runner = makeDecryptRunner();
  cache.setRunners({ decrypt: runner.runner });
  let notes = 0;
  const unsubscribe = cache.subscribe('personal', 't1', () => {
    notes += 1;
  });
  const drop = textDrop('t1', 'C', 'iv1');
  cache.requestDecrypt('personal', 't1', drop, 'u1');
  runner.settle('t1', plainOf(drop, { content: 'PLAIN' }));
  await flush();
  assert.ok(notes >= 1, 'settle must notify');
  unsubscribe();
  cache.revokeScope('personal');
  cache.seedFromDecrypted('personal', 't1', drop, plainOf(drop, { content: 'AGAIN' }), cache.scopeGeneration('personal'));
  assert.equal(notes, 1, 'no notifications after unsubscribe');
});

test('seedFromDecrypted: seeds, validates false success, and respects the generation guard', async () => {
  const cache = createEditorialCardCache(60);
  const drop = textDrop('t1', 'C', 'iv1');
  const gen = cache.scopeGeneration('personal');

  // False-success seed: recorded as an error, returns false.
  assert.equal(cache.seedFromDecrypted('personal', 't1', drop, { ...drop, encrypted: false }, gen), false);
  assert.equal(cache.snapshot('personal', 't1', payloadRevision(drop)).textError, true);

  // A genuine seed on the SAME entry replaces the error with ready text.
  assert.equal(cache.seedFromDecrypted('personal', 't1', drop, plainOf(drop, { content: 'PLAIN' }), gen), true);
  const snap = cache.snapshot('personal', 't1', payloadRevision(drop));
  assert.equal(snap.text, 'PLAIN');
  assert.equal(snap.textReady, true);

  // A stale generation (scope revoked mid-preview) is discarded.
  cache.revokeScope('personal');
  assert.equal(
    cache.seedFromDecrypted('personal', 't1', textDrop('t1', 'C2', 'iv2'), plainOf(drop, { content: 'X' }), gen),
    false
  );
  assert.equal(cache.snapshot('personal', 't1', payloadRevision(textDrop('t1', 'C2', 'iv2'))), EMPTY_CARD_RESOURCE);
});

test('thumbnails: chained on a ready file, deduped, failures not retried, one at a time', async () => {
  const cache = createEditorialCardCache(60);
  const decrypts = makeDecryptRunner();
  const thumbs = makeThumbRunner();
  cache.setRunners({ decrypt: decrypts.runner, thumbnail: thumbs.runner });

  const v1 = { id: 'v1', type: 'file', encrypted: true, fileData: 'ENC1', iv: 'iv1', mimeType: 'video/mp4' };
  const v2 = { id: 'v2', type: 'file', encrypted: true, fileData: 'ENC2', iv: 'iv2', mimeType: 'video/webm' };
  cache.requestDecrypt('personal', 'v1', v1, 'u1');
  cache.requestDecrypt('personal', 'v2', v2, 'u1');
  decrypts.settle('v1', plainOf(v1, { fileData: 'DATAURL1' }));
  decrypts.settle('v2', plainOf(v2, { fileData: 'DATAURL2' }));
  await flush();

  const rev1 = payloadRevision(v1);
  assert.equal(cache.snapshot('personal', 'v1', rev1).fileReady, true);
  cache.requestThumbnail('personal', 'v1', rev1, 'DATAURL1');
  cache.requestThumbnail('personal', 'v1', rev1, 'DATAURL1'); // dedupe
  cache.requestThumbnail('personal', 'v2', payloadRevision(v2), 'DATAURL2'); // must wait (1 permit)
  assert.equal(thumbs.calls.length, 1);

  thumbs.settle('DATAURL1', 'data:image/jpeg;base64,AAA');
  await flush();
  assert.equal(cache.snapshot('personal', 'v1', rev1).thumbnail, 'data:image/jpeg;base64,AAA');
  assert.equal(thumbs.calls.length, 2, 'v2 starts after the permit frees');
  thumbs.settle('DATAURL2', 'data:image/jpeg;base64,BBB');
  await flush();
  assert.equal(cache.snapshot('personal', 'v2', payloadRevision(v2)).thumbnailReady, true);

  // A failed thumbnail is recorded and never auto-retried.
  const v3 = { id: 'v3', type: 'file', encrypted: true, fileData: 'ENC3', iv: 'iv3', mimeType: 'video/mp4' };
  cache.requestDecrypt('personal', 'v3', v3, 'u1');
  decrypts.settle('v3', plainOf(v3, { fileData: 'DATAURL3' }));
  await flush();
  cache.requestThumbnail('personal', 'v3', payloadRevision(v3), 'DATAURL3');
  thumbs.fail('DATAURL3', new Error('no frame'));
  await flush();
  const bad = cache.snapshot('personal', 'v3', payloadRevision(v3));
  assert.equal(bad.thumbnailReady, false);
  assert.equal(bad.thumbnailError, true);
  cache.requestThumbnail('personal', 'v3', payloadRevision(v3), 'DATAURL3');
  assert.equal(thumbs.calls.length, 3, 'no retry after a thumbnail failure');
});
