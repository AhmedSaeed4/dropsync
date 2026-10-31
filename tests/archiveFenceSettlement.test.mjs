import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ts = require('typescript');
const read = (name) => fs.readFileSync(new URL('../' + name, import.meta.url), 'utf8');
const copy = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

function server(seed = {}, { retry } = {}) {
  const docs = new Map(Object.entries(copy(seed)));
  const writes = [];
  const snapshot = (path) => {
    const data = copy(docs.get(path));
    return { exists: data !== undefined, data: () => copy(data), get: (key) => data?.[key] };
  };
  const ref = (path) => ({
    path,
    doc: (id) => ref(path + '/' + id),
    collection: (name) => ref(path + '/' + name),
    limit: (limit) => ({ path, query: true, limit }),
    get: async () => snapshot(path),
    count: () => ({ get: async () => ({ data: () => ({ count: [...docs.keys()].filter((key) => key.startsWith(path + '/') && !key.slice(path.length + 1).includes('/')).length }) }) }),
  });
  let retried = false;
  const db = {
    collection: (name) => ref(name),
    runTransaction: async (callback) => {
      for (;;) {
        let didWrite = false;
        const pending = [];
        const tx = {
          get: async (target) => {
            assert.equal(didWrite, false, 'all transaction reads precede writes');
            if (target.query) {
              const entries = [...docs.keys()].filter((key) => key.startsWith(target.path + '/') && !key.slice(target.path.length + 1).includes('/')).slice(0, target.limit);
              return { empty: entries.length === 0, docs: entries.map(snapshot) };
            }
            return snapshot(target.path);
          },
          update: (target, value) => { didWrite = true; pending.push(['update', target.path, copy(value)]); },
          set: (target, value) => { didWrite = true; pending.push(['set', target.path, copy(value)]); },
          delete: (target) => { didWrite = true; pending.push(['delete', target.path]); },
        };
        const result = await callback(tx);
        if (retry && !retried) { retried = true; retry(docs); continue; }
        for (const [kind, path, data] of pending) {
          if (kind === 'delete') docs.delete(path);
          else docs.set(path, kind === 'update' ? { ...docs.get(path), ...data } : data);
          writes.push([kind, path, data]);
        }
        return result;
      }
    },
  };
  const exports = {};
  const code = ts.transpileModule(read('src/app/api/archive/import-fence/route.ts'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(code, { exports, require: (id) => {
    if (id === 'next/server') return { NextResponse: { json: (body, init) => ({ body: copy(body), status: init?.status || 200 }) } };
    if (id === '@/lib/firebase-admin') return { getAdminDb: () => db, getAdminAuth: () => ({ verifyIdToken: async (token) => { if (token !== 'valid') throw Error('invalid'); return { uid: 'owner' }; } }) };
    throw Error(id);
  }, console });
  return { docs, writes, call: (body, token = 'valid') => exports.POST({ headers: { get: () => token ? 'Bearer ' + token : null }, json: async () => body }) };
}
const fence = (extra = {}) => ({ userId: 'owner', jobId: 'job', mode: 'merge', workspaceId: 'workspace', state: 'closed-cancelled', updatedAt: 1, ...extra });
const path = 'importFences/owner_job';

test('P1 zero ledger certifies cancellation; idempotent; parent and manifest retained', async () => {
  const app = server({ [path]: fence(), [path + '/manifest/0']: { entries: [] } });
  const first = await app.call({ op: 'settle', jobId: 'job' });
  assert.equal(first.status, 200);
  assert.equal(first.body.results[0].outcome, 'settled-cancelled');
  assert.equal(app.docs.get(path).cleanupComplete, true);
  assert.ok(app.docs.has(path + '/manifest/0'));
  const saved = copy(app.docs.get(path));
  await app.call({ op: 'settle', jobId: 'job' });
  assert.deepEqual(app.docs.get(path), saved);
  assert.equal(app.writes.length, 1);
});

test('P1 success is adopted byte-untouched, including zero items', async () => {
  const initial = fence({ state: 'closed-success', complete: true });
  const app = server({ [path]: initial });
  assert.equal((await app.call({ op: 'settle', jobId: 'job' })).body.results[0].outcome, 'adopted');
  assert.deepEqual(app.docs.get(path), initial);
  assert.equal(app.writes.length, 0);
});

test('P1 open, missing, invalid ownership/shape and outstanding items never certify', async () => {
  const cases = [
    [{}, 'not-found'],
    [{ [path]: fence({ state: 'open' }) }, 'remote-or-open'],
    [{ [path]: fence({ state: 'unknown' }) }, 'invalid'],
    [{ [path]: fence({ userId: 'peer' }) }, 'invalid'],
    [{ [path]: fence({ jobId: 'peer-job' }) }, 'invalid'],
    [{ [path]: fence({ mode: 'unknown' }) }, 'invalid'],
    [{ [path]: fence({ workspaceId: 'bad/path' }) }, 'invalid'],
    [{ [path]: fence(), [path + '/items/drop%3Aid']: { kind: 'drop', refId: 'id' } }, 'cleanup-required'],
  ];
  for (const [seed, outcome] of cases) {
    const app = server(seed);
    assert.equal((await app.call({ op: 'settle', jobId: 'job' })).body.results[0].outcome, outcome);
    assert.equal(app.writes.length, 0);
  }
});

test('P1 fresh workspace AND key must be absent; personal synthetic workspace needs no real parent', async () => {
  for (const extraPath of ['workspaces/workspace', 'workspaceKeys/workspace']) {
    const app = server({ [path]: fence({ mode: 'fresh' }), [extraPath]: { ownerId: 'owner' } });
    assert.equal((await app.call({ op: 'settle', jobId: 'job' })).body.results[0].outcome, 'cleanup-required');
  }
  for (const workspaceId of ['workspace', 'personal-import-job']) {
    const app = server({ [path]: fence({ mode: 'fresh', workspaceId }) });
    assert.equal((await app.call({ op: 'settle', jobId: 'job' })).body.results[0].outcome, 'settled-cancelled');
  }
});

test('P1 batches dedupe, cap at 25 unique jobs, reject mixed/unknown/body-userId shapes', async () => {
  const app = server({ [path]: fence() });
  const result = await app.call({ op: 'settle', jobIds: ['job', 'job', 'other'] });
  assert.equal(result.body.results.length, 2);
  assert.equal(result.body.results[1].outcome, 'not-found');
  for (const body of [
    { op: 'settle', jobIds: [] }, { op: 'settle', jobIds: [7] },
    { op: 'settle', jobId: 'bad/path' }, { op: 'settle', jobId: '' },
    { op: 'settle', jobId: 'job', jobIds: ['job'] },
    { op: 'settle', jobId: 'job', userId: 'peer' },
    { op: 'settle', jobIds: Array.from({ length: 26 }, (_, i) => 'job-' + i) },
  ]) assert.equal((await app.call(body)).status, 400);
  assert.equal((await app.call({ op: 'settle', jobIds: Array.from({ length: 25 }, (_, i) => 'job-' + i) })).body.results.length, 25);
});

test('P1 only verified uid derives parent; unauthorized tokens refuse', async () => {
  const app = server({ 'importFences/peer_job': fence({ userId: 'peer' }) });
  assert.equal((await app.call({ op: 'settle', jobId: 'job' })).body.results[0].outcome, 'not-found');
  assert.equal((await app.call({ op: 'settle', jobId: 'job' }, null)).status, 401);
  assert.equal((await app.call({ op: 'settle', jobId: 'job' }, 'wrong')).status, 401);
});

test('P1 transaction retry rechecks obligations; discarded first attempt cannot certify', async () => {
  const app = server({ [path]: fence() }, { retry: (docs) => docs.set(path + '/items/drop%3Aid', { kind: 'drop', refId: 'id' }) });
  assert.equal((await app.call({ op: 'settle', jobId: 'job' })).body.results[0].outcome, 'cleanup-required');
  assert.equal(app.docs.get(path).cleanupComplete, undefined);
});

test('P1 outstanding stays a read and ack stays a child delete with retained parent', async () => {
  const app = server({ [path]: fence(), [path + '/items/drop%3Aid']: { kind: 'drop', refId: 'id' } });
  assert.equal((await app.call({ op: 'outstanding', jobId: 'job' })).body.outstandingItems, 1);
  assert.equal(app.writes.length, 0);
  assert.equal((await app.call({ op: 'ack-items', jobId: 'job', ids: ['drop:id'] })).status, 200);
  assert.equal((await app.call({ op: 'outstanding', jobId: 'job' })).body.outstandingItems, 0);
  assert.ok(app.docs.has(path));
  assert.equal(app.docs.get(path).cleanupComplete, undefined);
});

function client({ fetcher, token } = {}) {
  const calls = [];
  const auth = { currentUser: { uid: 'owner', getIdToken: token || (async () => 'owner-token') } };
  const exports = {};
  const code = ts.transpileModule(read('src/lib/importFenceClient.ts'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(code, {
    exports, require: () => ({ getAuth: () => auth }), AbortController,
    fetch: async (url, init) => {
      calls.push({ url, init });
      if (fetcher) return fetcher(url, init);
      const body = JSON.parse(init.body);
      return { ok: true, status: 200, json: async () => ({ ok: true, results: body.jobIds.map((jobId) => ({ jobId, outcome: 'settled-cancelled' })) }) };
    },
  });
  return { ...exports, auth, calls };
}

test('P2 empty input makes no request; client chunks 26 jobs and dedupes', async () => {
  const app = client();
  const owner = app.createArchiveOwnerContext('owner');
  assert.equal((await app.settleImportFences([], owner)).length, 0);
  assert.equal(app.calls.length, 0);
  const ids = Array.from({ length: 26 }, (_, i) => 'job-' + i);
  assert.equal((await app.settleImportFences([...ids, ids[0]], owner)).length, 26);
  assert.deepEqual(app.calls.map((c) => JSON.parse(c.init.body).jobIds.length), [25, 1]);
  assert.ok(app.calls.every((c) => c.init.headers.Authorization === 'Bearer owner-token'));
});

test('P2 owner checked before and after token acquisition; never borrows switched-user token', async () => {
  let resolve;
  const app = client({ token: () => new Promise((done) => { resolve = done; }) });
  const owner = app.createArchiveOwnerContext('owner');
  const pending = app.settleImportFences(['job'], owner);
  app.auth.currentUser = { uid: 'peer', getIdToken: async () => { throw Error('must never get peer token'); } };
  resolve('owner-token');
  await assert.rejects(pending, app.ArchiveContextExpiredError);
  assert.equal(app.calls.length, 0);
  await assert.rejects(app.settleImportFences(['job'], owner), app.ArchiveContextExpiredError);
});

test('P2 routine abort abandons a hung read but mutation wait remains attached', async () => {
  const app = client();
  const control = new AbortController();
  const owner = app.createArchiveOwnerContext('owner', 'g', () => {}, control.signal);
  let finish;
  const hung = app.awaitArchiveOwner(owner, () => new Promise((done) => { finish = done; }), true);
  control.abort();
  await assert.rejects(hung, app.ArchiveContextExpiredError);
  finish('late');
  const control2 = new AbortController();
  const owner2 = app.createArchiveOwnerContext('owner', 'g', () => {}, control2.signal);
  let finish2, settled = false;
  const mutation = app.awaitArchiveOwner(owner2, () => new Promise((done) => { finish2 = done; })).finally(() => { settled = true; });
  control2.abort();
  await Promise.resolve();
  assert.equal(settled, false);
  finish2();
  await assert.rejects(mutation, app.ArchiveContextExpiredError);
});

test('P2 missing/404, unknown or duplicate settlement results are never success', async () => {
  for (const response of [
    { ok: false, status: 404, json: async () => ({}) },
    { ok: true, status: 200, json: async () => ({ ok: true, results: [{ jobId: 'job', outcome: 'invented' }] }) },
    { ok: true, status: 200, json: async () => ({ ok: true, results: [] }) },
    { ok: true, status: 200, json: async () => ({ ok: true, results: [{ jobId: 'other', outcome: 'adopted' }] }) },
  ]) {
    const app = client({ fetcher: async () => response });
    await assert.rejects(app.settleImportFences(['job'], app.createArchiveOwnerContext('owner')), /settlement/);
  }
});

test('P2 generation invalidation is enforced after response parsing', async () => {
  let valid = true;
  const app = client({ fetcher: async () => ({ ok: true, status: 200, json: async () => {
    valid = false; return { ok: true, results: [{ jobId: 'job', outcome: 'settled-cancelled' }] };
  } }) });
  const owner = app.createArchiveOwnerContext('owner', 'old', () => { if (!valid) throw new app.ArchiveContextExpiredError(); });
  await assert.rejects(app.settleImportFences(['job'], owner), app.ArchiveContextExpiredError);
});

function recoveryFixture({ fences = [], journals = {}, items = [], present = [], failList = false, failSettle = false, fenceState = 'closed-cancelled', fenceExists = true, heartbeatAt = 0 } = {}) {
  const app = client();
  let state = fenceState;
  const logs = [];
  const stored = new Map(Object.entries(journals));
  const existing = new Set(present);
  const ledger = new Map(items.map((item) => [item.kind + ':' + item.refId, item]));
  const storage = { get length() { return stored.size; }, key: (i) => [...stored.keys()][i] ?? null, getItem: (key) => stored.get(key) ?? null, removeItem: (key) => stored.delete(key), setItem: (key, value) => stored.set(key, value) };
  const exportsByName = {};
  const firestore = {
    collection: (_db, ...path) => ({ path: path.join('/') }),
    query: (value) => value, where: () => ({}), doc: (_db, ...path) => ({ path: path.join('/') }),
    getDocsFromServer: async (query) => {
      logs.push('read:' + query.path);
      if (query.path === 'importFences') {
        if (failList) throw Error('offline');
        return { docs: fences.map((data) => ({ data: () => data })) };
      }
      return { docs: [...ledger.values()].map((data) => ({ get: (key) => data[key] })) };
    },
    deleteDoc: async (ref) => { existing.delete(ref.path.replace('drops/', 'drop:').replace('categories/', 'category:')); logs.push('delete:' + ref.path); },
  };
  const fenceApi = {
    ...app,
    probeImportItems: async (_job, ids, owner) => {
      owner.check(); logs.push('probe:' + ids.join(','));
      const result = { present: [], absent: [], fenceState: {} };
      for (const id of ids) {
        if (id.startsWith('fence:')) {
          if (fenceExists) { result.present.push(id); result.fenceState[id] = { state, heartbeatAt }; }
          else result.absent.push(id);
        }
        else (existing.has(id) ? result.present : result.absent).push(id);
      }
      return result;
    },
    cancelImportFence: async (_job, _override, owner) => { owner.check(); logs.push('cancel'); state = 'closed-cancelled'; return true; },
    getImportFenceOutstanding: async (_job, owner) => { owner.check(); logs.push('outstanding'); return { state, outstandingItems: ledger.size }; },
    ackImportItems: async (_job, ids, owner) => { owner.check(); logs.push('ack:' + ids.length); for (const id of ids) ledger.delete(id); return true; },
    settleImportFences: async (ids, owner) => {
      owner.check(); if (ids.length) logs.push('settle:' + ids.length);
      if (failSettle && ids.length) throw Error('settlement response lost');
      return ids.map((jobId) => ({ jobId, outcome: 'settled-cancelled' }));
    },
  };
  const load = (file, key) => {
    const exports = {};
    const code = ts.transpileModule(read(file), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    vm.runInNewContext(code, { exports, localStorage: storage, console, AbortController, require: (id) => {
      if (id === 'firebase/firestore') return firestore;
      if (id === './firebase') return { db: {}, auth: app.auth };
      if (id === './importFenceClient') return fenceApi;
      if (id === './workspaceArchive') return exportsByName.work;
      if (id === './archiveJournalVisibility') return { announceArchiveJournalTransition: () => logs.push('journal-transition') };
      if (id === './drops') return { deleteFromR2: async () => logs.push('delete:r2') };
      return {};
    } });
    exportsByName[key] = exports;
    return exports;
  };
  const work = load('src/lib/workspaceArchive.ts', 'work');
  const personal = load('src/lib/personalArchive.ts', 'personal');
  return { app, work, personal, logs, stored, ledger, owner: app.createArchiveOwnerContext('owner') };
}

test('P3 marked journal-less cancellations skip work; exactly two existing list reads', async () => {
  const fixture = recoveryFixture({ fences: [
    fence({ cleanupComplete: true }),
    fence({ jobId: 'personal', mode: 'fresh', workspaceId: 'personal-import-personal', cleanupComplete: true }),
    fence({ jobId: 'success', state: 'closed-success' }),
  ] });
  const work = await fixture.work.discoverInterruptedWorkspaceArchiveImport('owner', fixture.owner);
  const personal = await fixture.personal.discoverInterruptedPersonalArchiveImport('owner', fixture.owner);
  assert.equal(work.journals.length + personal.journals.length, 0);
  await fixture.work.certifyArchiveRecoveryPlan(work, fixture.owner);
  await fixture.work.certifyArchiveRecoveryPlan(personal, fixture.owner);
  assert.deepEqual(fixture.logs, ['read:importFences', 'read:importFences']);
});

test('P3 unmarked cancelled fences are admitted and batch-certified, not blindly skipped', async () => {
  const fixture = recoveryFixture({ fences: [fence(), fence({ jobId: 'job2' })] });
  const plan = await fixture.work.discoverInterruptedWorkspaceArchiveImport('owner', fixture.owner);
  assert.equal(plan.journals.length, 2);
  assert.equal(plan.journals[0].fenceMayExist, undefined, 'workspace synthesized guard remains');
  const prepared = await fixture.work.certifyArchiveRecoveryPlan(plan, fixture.owner);
  assert.equal(prepared.journals.length, 0);
  assert.ok(fixture.logs.includes('settle:2'));
});

test('P3 local journal survives a server completion marker and lost settlement response', async () => {
  const journal = { jobId: 'job', userId: 'owner', workspaceId: 'workspace', createdWorkspace: false, createdDropIds: ['id'], createdCategoryIds: [], createdR2Keys: [], fenceMayExist: true };
  const key = 'dropsync_archive_import_journal_job';
  const fixture = recoveryFixture({ fences: [fence({ cleanupComplete: true })], journals: { [key]: JSON.stringify(journal) }, items: [{ kind: 'drop', refId: 'id' }], present: ['drop:id'], failSettle: true });
  const plan = await fixture.work.discoverInterruptedWorkspaceArchiveImport('owner', fixture.owner);
  assert.equal(plan.journals.length, 1);
  assert.equal(plan.cancelledJobIds.length, 0);
  await assert.rejects(fixture.work.executeArchiveRecoveryPlan(plan, false, fixture.owner), /settlement/);
  assert.ok(fixture.logs.includes('delete:drops/id'));
  assert.ok(fixture.logs.indexOf('ack:1') > fixture.logs.indexOf('delete:drops/id'));
  assert.ok(fixture.stored.has(key), 'lost settle response retains recovery truth');
});

test('P3 local cleanup still runs when cross-device list fails, then reports check unavailable', async () => {
  const journal = { jobId: 'job', userId: 'owner', workspaceId: 'workspace', createdWorkspace: false, createdDropIds: [], createdCategoryIds: [], createdR2Keys: [], fenceMayExist: true };
  const key = 'dropsync_archive_import_journal_job';
  const fixture = recoveryFixture({ journals: { [key]: JSON.stringify(journal) }, failList: true });
  await assert.rejects(fixture.work.recoverInterruptedWorkspaceArchiveImport('owner', false, fixture.owner), /Could not check/);
  assert.equal(fixture.stored.has(key), false);
  assert.ok(fixture.logs.includes('settle:1'));
});

test('P3 personal synthesized journal and legacy journal retain their recovery behavior', async () => {
  const fixture = recoveryFixture({ fences: [fence({ workspaceId: 'personal-import-job', mode: 'fresh' })], journals: {
    dropsync_personal_archive_import_journal: JSON.stringify({ userId: 'owner', createdDropIds: [], createdCategoryIds: [], createdR2Keys: ['key'] }),
  } });
  const plan = await fixture.personal.discoverInterruptedPersonalArchiveImport('owner', fixture.owner);
  assert.equal(plan.journals[0].fenceMayExist, true);
  await fixture.work.executeArchiveRecoveryPlan(plan, false, fixture.owner);
  assert.ok(fixture.logs.includes('delete:r2'));
  assert.equal(fixture.stored.size, 0);
});

test('P3 >100 obligations are probed, deleted, acknowledged and settled in finite chunks', async () => {
  const items = Array.from({ length: 201 }, (_, i) => ({ kind: 'drop', refId: 'id' + i }));
  const fixture = recoveryFixture({ items, present: items.map((item) => 'drop:' + item.refId) });
  await fixture.work.recoverArchiveFenceJob({ jobId: 'job', userId: 'owner', workspaceId: 'workspace', createdWorkspace: false, createdDropIds: [], createdCategoryIds: [], createdR2Keys: [] }, false, fixture.owner);
  assert.deepEqual(fixture.logs.filter((entry) => entry.startsWith('ack:')), ['ack:100', 'ack:100', 'ack:1']);
  assert.equal(fixture.logs.filter((entry) => entry.startsWith('delete:drops/')).length, 201);
  assert.equal(fixture.ledger.size, 0);
  assert.equal(fixture.logs.at(-1), 'settle:1');
});

test('P6 success adoption never deletes data or settles cancellation, including local journal', async () => {
  const key = 'dropsync_archive_import_journal_job';
  const fixture = recoveryFixture({ fenceState: 'closed-success',
    journals: { [key]: JSON.stringify({ jobId: 'job', userId: 'owner', workspaceId: 'workspace', createdWorkspace: false, createdDropIds: ['id'], createdCategoryIds: [], createdR2Keys: [], fenceMayExist: true }) },
    items: [{ kind: 'drop', refId: 'id' }], present: ['drop:id'],
  });
  assert.equal(await fixture.work.recoverInterruptedWorkspaceArchiveImport('owner', false, fixture.owner), false);
  assert.equal(fixture.stored.size, 0);
  assert.equal(fixture.ledger.size, 1);
  assert.equal(fixture.logs.some((entry) => entry.startsWith('delete:') || entry.startsWith('ack:') || entry.startsWith('settle:')), false);
});

test('P6 missing synthesized workspace fence remains fail-closed; explicit pre-open allowance does not certify absence', async () => {
  const fixture = recoveryFixture({ fenceExists: false });
  const journal = { jobId: 'job', userId: 'owner', workspaceId: 'workspace', createdWorkspace: false, createdDropIds: [], createdCategoryIds: [], createdR2Keys: [] };
  await assert.rejects(fixture.work.recoverArchiveFenceJob(journal, false, fixture.owner), /fence is missing/);
  assert.equal(await fixture.work.recoverArchiveFenceJob({ ...journal, fenceMayExist: true }, true, fixture.owner), 'cancelled');
  assert.equal(fixture.logs.some((entry) => entry.startsWith('settle:')), false);
});

test('P6 15-minute remote lease remains; stale fence cancels before deleting and acking', async () => {
  const journal = { jobId: 'job', userId: 'owner', workspaceId: 'workspace', createdWorkspace: false, createdDropIds: [], createdCategoryIds: [], createdR2Keys: [] };
  const live = recoveryFixture({ fenceState: 'open', heartbeatAt: Date.now() });
  assert.equal(await live.work.recoverArchiveFenceJob(journal, false, live.owner), 'remote-active');
  assert.equal(live.logs.some((entry) => entry === 'cancel'), false);
  const stale = recoveryFixture({ fenceState: 'open', heartbeatAt: Date.now() - 16 * 60 * 1000, items: [{ kind: 'drop', refId: 'id' }], present: ['drop:id'] });
  await stale.work.recoverArchiveFenceJob(journal, false, stale.owner);
  assert.ok(stale.logs.indexOf('cancel') < stale.logs.indexOf('delete:drops/id'));
  assert.ok(stale.logs.indexOf('delete:drops/id') < stale.logs.indexOf('ack:1'));
});
