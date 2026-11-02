// Order 67 — pure policy and dev readout tests. No browser or account access.
import { register } from 'node:module';
import assert from 'node:assert/strict';
import { test } from 'node:test';

register('./helpers/hook-module-loader.mjs', import.meta.url);
const {
  resolveEditorialWindowPolicy,
  createEditorialWindowProbe,
  getEditorialWindowReadoutSnapshot,
  subscribeEditorialWindowReadout,
  registerEditorialWindowReadout,
} = await import('../src/lib/editorialWindowPolicy.ts');
const { EDITORIAL_WINDOW_ROW_BUDGET } = await import('../src/lib/editorialWindowModel.ts');

function withEnv(value, run) {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = value;
  try { return run(); } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
}
const defaultPolicy = { requested: null, effectiveBudget: 24, source: 'default' };
const trials = [60, 48, 36, 24, 16, 12];
const loopbacks = ['localhost', '127.0.0.1', '[::1]'];
const input = (host = 'localhost', search = '?editorialWindowBudget=24') => ({ host, search, isDev: true });
const metadata = (patch = {}) => ({
  ...defaultPolicy, appliedBudget: 24,
  userReady: true, spaceReady: true, N: 610, F: 610,
  filters: { search: false, motionFiltered: false, category: 'all', mention: false },
  sort: 'newest', manualOrderIdsCount: 0, reducedMotion: false,
  enableDrag: false, animate: true, branch: 'window-animated', ...patch,
});
const rows = (patch = {}) => ({
  mountedRowIdsCount: 24, retainedRowCount: 0, exitingRowCount: 0,
  geometryVersion: 1, rowsSampleReady: true, ...patch,
});
const sample = () => ({ ...rows(), viewportWidth: 1440, mediaQueryMatches: true });

test('SSR-safe module/default inputs preserve the imported budget 24 with no browser globals', () => {
  assert.equal(typeof window, 'undefined');
  assert.equal(typeof document, 'undefined');
  assert.equal(EDITORIAL_WINDOW_ROW_BUDGET, 24);
  withEnv('development', () => {
    for (const value of [undefined, null, {}, { isDev: true }, { host: 'localhost' }]) {
      assert.deepEqual(resolveEditorialWindowPolicy(value), defaultPolicy);
    }
    assert.equal(getEditorialWindowReadoutSnapshot(), null);
  });
});

test('every exact trial is accepted on each exact loopback host in development', () => {
  withEnv('development', () => {
    for (const host of loopbacks) for (const budget of trials) {
      assert.deepEqual(resolveEditorialWindowPolicy(input(host, '?editorialWindowBudget=' + budget)), {
        requested: budget, effectiveBudget: budget, source: 'override',
      });
    }
    // Actual build mode is the default when the explicit test seam is omitted.
    assert.equal(resolveEditorialWindowPolicy({ host: 'localhost', search: '?editorialWindowBudget=24' }).effectiveBudget, 24);
    assert.deepEqual(resolveEditorialWindowPolicy({ ...input(), isDev: false }), defaultPolicy);
  });
});

test('missing, malformed, noncanonical and unsupported values all fail closed', () => {
  withEnv('development', () => {
    for (const search of [
      '', '?', '?other=24', '?editorialwindowbudget=24', '?editorialWindowBudget',
      '?editorialWindowBudget=', '?editorialWindowBudget=-24', '?editorialWindowBudget=0',
      '?editorialWindowBudget=1', '?editorialWindowBudget=23', '?editorialWindowBudget=61',
      '?editorialWindowBudget=024', '?editorialWindowBudget=24.0', '?editorialWindowBudget=24e0',
      '?editorialWindowBudget=+24', '?editorialWindowBudget=%2024', '?editorialWindowBudget=24%20',
      '?editorialWindowBudget=24%0A', '?editorialWindowBudget=24%0D', '?editorialWindowBudget=%0A24',
      '?editorialWindowBudget=２４',
      '?editorialWindowBudget=NaN', '?editorialWindowBudget=Infinity', '?editorialWindowBudget=0x18',
      '?editorialWindowBudget=%', '?editorialWindowBudget=24x',
      '?editorialWindowBudget=999999999999999999999999999999999999999999999999',
      '?editorialWindowBudget=24&editorialWindowBudget=24',
      '?editorialWindowBudget=24&editorialWindowBudget=',
      '?editorialWindowBudget=bad&editorialWindowBudget=24',
    ]) assert.deepEqual(resolveEditorialWindowPolicy(input('localhost', search)), defaultPolicy, search);
    assert.equal(resolveEditorialWindowPolicy(input('localhost', '?other=1&editorialWindowBudget=24&x=2')).effectiveBudget, 24);
  });
});

test('host matching is exact: public hosts, ports and lookalikes cannot enable the knob', () => {
  withEnv('development', () => {
    for (const host of [
      undefined, '', 'example.com', '192.168.1.1', '0.0.0.0', '::1',
      'localhost:3000', '[::1]:3000', 'LOCALHOST', 'localhost.', 'dev.localhost',
      '127.0.0.1.example.com', ' localhost', 'localhost ',
    ]) for (const budget of trials) {
      assert.deepEqual(resolveEditorialWindowPolicy({ host, search: '?editorialWindowBudget=' + budget, isDev: true }), defaultPolicy);
    }
  });
});

test('actual production cannot be overridden even through the explicit development test seam', () => {
  withEnv('production', () => {
    for (const host of loopbacks) for (const budget of trials) {
      assert.deepEqual(resolveEditorialWindowPolicy(input(host, '?editorialWindowBudget=' + budget)), defaultPolicy);
    }
  });
  withEnv('test', () => {
    assert.deepEqual(resolveEditorialWindowPolicy({ host: 'localhost', search: '?editorialWindowBudget=24' }), defaultPolicy);
  });
});

test('readout registration and subscriptions are inert in production; public dev hosts cannot register', () => {
  let calls = 0;
  withEnv('production', () => {
    const unsubscribe = subscribeEditorialWindowReadout(() => { calls += 1; });
    assert.equal(registerEditorialWindowReadout('localhost', 'personal'), null);
    assert.equal(getEditorialWindowReadoutSnapshot(), null);
    unsubscribe();
  });
  withEnv('development', () => {
    assert.equal(registerEditorialWindowReadout('example.com', 'personal'), null);
    assert.equal(getEditorialWindowReadoutSnapshot(), null);
  });
  assert.equal(calls, 0);
});

test('readout pushes only boundaries and pulls fresh rows/geometry/viewport without frame publications', () => {
  withEnv('development', () => {
    const probe = createEditorialWindowProbe();
    let width = 1440;
    let facts = rows();
    const unbind = probe.bind(() => facts);
    const lease = registerEditorialWindowReadout('localhost', 'personal');
    let calls = 0;
    const unsubscribe = subscribeEditorialWindowReadout(() => { calls += 1; });
    const pull = () => ({ ...probe.read(), viewportWidth: width, mediaQueryMatches: width >= 1400 });
    try {
      lease.publish(metadata({ requested: 24, effectiveBudget: 24, source: 'override', appliedBudget: 24 }), pull);
      const first = getEditorialWindowReadoutSnapshot();
      assert.equal(calls, 1);
      assert.equal(first.mountedRowIdsCount, 24);
      assert.equal(first.branch, 'window-animated');
      assert.equal(first.scope, 'personal');
      assert.ok(Object.isFrozen(first));
      assert.ok(Object.isFrozen(first.filters));
      assert.throws(() => { first.filters.search = true; }, TypeError);
      // A commit/exit/resize updates pull facts, not the notification count.
      facts = rows({ mountedRowIdsCount: 26, retainedRowCount: 1, exitingRowCount: 1, geometryVersion: 2 });
      width = 1500;
      for (let i = 0; i < 10; i++) {
        const current = getEditorialWindowReadoutSnapshot();
        assert.equal(current.mountedRowIdsCount, 26);
        assert.equal(current.retainedRowCount, 1);
        assert.equal(current.exitingRowCount, 1);
        assert.equal(current.geometryVersion, 2);
        assert.equal(current.viewportWidth, 1500);
      }
      assert.equal(calls, 1, 'pull sampling must never notify subscribers');
      lease.publish(metadata({ branch: 'window-plain', F: 100, filters: { search: true, motionFiltered: true, category: 'all', mention: false } }), pull);
      assert.equal(calls, 2);
      unsubscribe();
      lease.publish(metadata(), pull);
      assert.equal(calls, 2);
    } finally {
      unsubscribe(); unbind(); lease.dispose();
    }
    assert.equal(getEditorialWindowReadoutSnapshot(), null);
  });
});

test('stale epochs cannot publish over or dispose a new user/workspace owner', () => {
  withEnv('development', () => {
    const old = registerEditorialWindowReadout('localhost', 'space-a');
    old.publish(metadata(), sample);
    const oldEpoch = getEditorialWindowReadoutSnapshot().epoch;
    const current = registerEditorialWindowReadout('localhost', 'space-b');
    try {
      current.publish(metadata({ branch: 'legacy-plain', appliedBudget: null }), sample);
      const next = getEditorialWindowReadoutSnapshot();
      assert.ok(next.epoch > oldEpoch);
      old.publish(metadata({ N: 999 }), sample);
      old.dispose();
      assert.equal(getEditorialWindowReadoutSnapshot().scope, 'space-b');
      assert.equal(getEditorialWindowReadoutSnapshot().N, 610);
      assert.equal(getEditorialWindowReadoutSnapshot().appliedBudget, null);
    } finally { current.dispose(); }
    assert.equal(getEditorialWindowReadoutSnapshot(), null);
  });
});

test('StrictMode-style cleanup and setup leaves one live epoch and no stale snapshot', () => {
  withEnv('development', () => {
    const first = registerEditorialWindowReadout('[::1]', 'personal');
    first.publish(metadata(), sample);
    const epoch = getEditorialWindowReadoutSnapshot().epoch;
    first.dispose();
    assert.equal(getEditorialWindowReadoutSnapshot(), null);
    const replay = registerEditorialWindowReadout('[::1]', 'personal');
    try {
      replay.publish(metadata(), sample);
      assert.ok(getEditorialWindowReadoutSnapshot().epoch > epoch);
      first.dispose();
      assert.equal(getEditorialWindowReadoutSnapshot().scope, 'personal');
    } finally { replay.dispose(); }
    assert.equal(getEditorialWindowReadoutSnapshot(), null);
  });
});

test('old probe cleanup cannot erase a newly committed branch sampler', () => {
  const probe = createEditorialWindowProbe();
  assert.equal(probe.read(), null);
  const oldCleanup = probe.bind(() => rows({ geometryVersion: 1 }));
  const currentCleanup = probe.bind(() => rows({ geometryVersion: 2 }));
  oldCleanup();
  assert.equal(probe.read().geometryVersion, 2);
  currentCleanup();
  assert.equal(probe.read(), null);
});

test('a failing measurement subscriber cannot break the renderer', () => {
  withEnv('development', () => {
    const lease = registerEditorialWindowReadout('127.0.0.1', 'personal');
    const unsubscribe = subscribeEditorialWindowReadout(() => { throw new Error('measurement consumer'); });
    try {
      assert.doesNotThrow(() => lease.publish(metadata(), sample));
      assert.equal(getEditorialWindowReadoutSnapshot().N, 610);
    } finally { unsubscribe(); lease.dispose(); }
  });
});
