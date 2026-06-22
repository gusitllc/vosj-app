// test/connectors.test.js — every non-demo connector honours the §13 contract.
// For each of azure-arc, hyperv, and the SDK BaseConnector this asserts:
//   (1) it implements the full Connector contract (discover/replicate/verify/
//       cutover/rollback) — a partial plugin must fail loudly, not silently;
//   (2) verify() EITHER returns the six pre-switch categories OR fail-closes
//       (not-verified) for an unimplemented step;
//   (3) it NEVER falsely reports verified — these connectors leave the real
//       SDK/replication seam UNWIRED, so verify() must report ok:false even after
//       replicate(), and reconcile() must refuse to produce a passing proof.
// In-memory, no network. Config is injected via ctx.env (no real cloud).
//
// FINDING captured here: azure-arc and hyperv are honest stubs — their probes read
// only real replication measurements, which are never populated, so verify() ALWAYS
// fails closed. The demo connector is the only one with a genuine passing proof.
// A regression that made these fabricate a pass would defeat verified-before-Jump.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { AzureArcConnector } = require('../src/connectors/azure-arc');
const { HyperVConnector } = require('../src/connectors/hyperv');
const {
  BaseConnector, ConnectorRegistry, MissingConfigError,
  verified, notVerified, VERIFY_CATEGORIES,
} = require('../src/connectors/sdk');
const { reconcile } = require('../src/engine/reconcile');

// The full Connector method surface every connector must implement.
const CONTRACT = ['discover', 'replicate', 'verify', 'cutover', 'rollback'];

const CONFIG = Object.freeze({ LEDGER_HMAC_KEY: 'test-key', version: 'test' });
function freshBaseline() { return new Date().toISOString(); }

// Each stub + a ctx.env that satisfies its requireConfig() so replicate() runs.
const STUBS = [
  {
    name: 'azure-arc',
    make: () => new AzureArcConnector(),
    unit: () => ({ id: 'arc-sql01', name: 'sql01', kind: 'database', rowCount: 1000 }),
    env: {
      AZURE_SUBSCRIPTION_ID: 'sub-1',
      AZURE_ARC_RESOURCE_GROUP: 'rg-1',
      AZURE_LOCAL_CLUSTER: 'cl-1',
    },
  },
  {
    name: 'hyperv',
    make: () => new HyperVConnector(),
    unit: () => ({ id: 'hv-vm-web', name: 'WEB01', kind: 'vm', vhdGiB: 80 }),
    env: { HYPERV_HOST: 'hv01', HYPERV_TRANSPORT: 'winrm' },
  },
];

// ---- (1) full contract ------------------------------------------------------
for (const { name, make } of STUBS) {
  test(`${name}: implements the full Connector contract`, () => {
    const conn = make();
    assert.ok(conn.id, `${name} has an id`);
    for (const m of CONTRACT) {
      assert.equal(typeof conn[m], 'function', `${name}.${m}() must exist`);
    }
  });
}

test('SDK BaseConnector: implements the full Connector contract', () => {
  const base = new BaseConnector({ id: 'base-test' });
  for (const m of CONTRACT) {
    assert.equal(typeof base[m], 'function', `BaseConnector.${m}() must exist`);
  }
});

// ---- (1b) fail-closed config gating: no config => no operation --------------
for (const { name, make, unit } of STUBS) {
  test(`${name}: replicate fails closed without required config`, async () => {
    const conn = make();
    await assert.rejects(
      () => conn.replicate(unit(), { env: {} }),
      (e) => e instanceof MissingConfigError,
      `${name} must refuse to replicate without its required config`
    );
  });
}

// ---- (2) verify() reports the six categories AND never fabricates a pass ----
for (const { name, make, unit, env } of STUBS) {
  test(`${name}: verify() reports exactly the six pre-switch categories`, async () => {
    const conn = make();
    const u = unit();
    await conn.replicate(u, { env });            // open the replication session
    const v = await conn.verify(u, { env });
    const names = v.categories.map((c) => c.name).sort();
    assert.deepEqual(names, [...VERIFY_CATEGORIES].sort(),
      `${name} must report all six categories`);
  });

  // The SDK seam is unwired -> the session has no measurements -> verify() MUST
  // fail closed. This is the honesty invariant: never a false 'verified'.
  test(`${name}: verify() fails closed after replicate (SDK seam unwired)`, async () => {
    const conn = make();
    const u = unit();
    await conn.replicate(u, { env });
    const v = await conn.verify(u, { env });
    assert.equal(v.ok, false,
      `${name} must NOT report verified while its measurement seam is unwired`);
    for (const c of v.categories) {
      assert.equal(c.ok, false, `${name} category ${c.name} must be not-verified`);
      assert.match(c.detail, /not verified|not reported/i,
        `${name} ${c.name} detail must state it was not verified`);
    }
  });

  test(`${name}: reconcile refuses a passing proof (verified-before-Jump holds)`, async () => {
    const conn = make();
    const u = Object.assign(unit(), { baselineAt: freshBaseline() });
    await conn.replicate(u, { env });
    const r = await reconcile(u, conn, { config: CONFIG, env });
    assert.equal(r.ok, false,
      `${name} must never produce a passing reconcile proof while unwired`);
  });

  // Even BEFORE replication, verify() must not report verified.
  test(`${name}: verify() fails closed BEFORE replication too`, async () => {
    const conn = make();
    const v = await conn.verify(unit(), { env });
    assert.equal(v.ok, false, `${name} must not report verified before replication`);
  });
}

// ---- (3) BaseConnector: an unimplemented probe set fails LOUDLY -------------
// The base _probes() throws so a half-built connector cannot silently pass verify.
test('SDK BaseConnector: unimplemented _probes() throws (fails loud)', async () => {
  const base = new BaseConnector({ id: 'base-unimpl' });
  await assert.rejects(
    () => base.verify({ id: 'x' }, {}),
    /_probes\(\) not implemented/,
    'an unimplemented probe set must throw, not return ok:true'
  );
});

// A connector that registers SOME probes (and lies that they pass via a non-probe)
// still fails closed: any category without a real passing probe is not-verified.
test('SDK BaseConnector: a partial probe set fails closed (never verified)', async () => {
  class PartialConnector extends BaseConnector {
    _probes() {
      return {
        row_counts: async () => verified('counts equal'),
        checksums: async () => verified('hashes match'),
        // replication_lag, sequence_identity, constraints, smoke: NO probe.
      };
    }
  }
  const conn = new PartialConnector({ id: 'partial' });
  const v = await conn.verify({ id: 'u-partial' }, {});
  assert.equal(v.ok, false, 'a partial probe set must never report verified');
  const byName = {};
  for (const c of v.categories) byName[c.name] = c;
  for (const missing of ['replication_lag', 'sequence_identity', 'constraints', 'smoke']) {
    assert.equal(byName[missing].ok, false, `${missing} must fail closed without a probe`);
    assert.match(byName[missing].detail, /not verified|not reported|no probe/i);
  }
});

// A probe that THROWS (e.g. an SDK call errors) must be recorded not-verified, not
// crash verify() and not be treated as a pass — defence against a flaky plugin.
test('SDK BaseConnector: a throwing probe is recorded not-verified (fail-closed)', async () => {
  class ThrowingConnector extends BaseConnector {
    _probes() {
      const all = {};
      for (const n of VERIFY_CATEGORIES) all[n] = async () => verified('ok');
      all.smoke = async () => { throw new Error('SDK exploded'); };
      return all;
    }
  }
  const conn = new ThrowingConnector({ id: 'throwing' });
  const v = await conn.verify({ id: 'u-throw' }, {});
  assert.equal(v.ok, false, 'a throwing probe must sink the proof, not pass');
  const smoke = v.categories.find((c) => c.name === 'smoke');
  assert.equal(smoke.ok, false);
  assert.match(smoke.detail, /not verified|probe error/i);
});

// A probe returning ok:false (a measured FAILURE) must surface ok:false overall.
test('SDK BaseConnector: a single failing probe forces ok:false', async () => {
  class OneFailConnector extends BaseConnector {
    _probes() {
      const all = {};
      for (const n of VERIFY_CATEGORIES) all[n] = async () => verified('ok');
      all.checksums = async () => notVerified('content hash mismatch');
      return all;
    }
  }
  const conn = new OneFailConnector({ id: 'one-fail' });
  const v = await conn.verify({ id: 'u-1f' }, {});
  assert.equal(v.ok, false, 'one failing category must sink the whole proof');
});

// A FULLY-wired connector (all six probes measure a pass) is the ONLY way verify
// returns ok:true — proving the gate is reachable when the work is genuinely done.
test('SDK BaseConnector: a fully-measured probe set is the only path to verified', async () => {
  class WiredConnector extends BaseConnector {
    _probes() {
      const all = {};
      for (const n of VERIFY_CATEGORIES) all[n] = async () => verified(`${n} measured`);
      return all;
    }
  }
  const conn = new WiredConnector({ id: 'wired' });
  const v = await conn.verify({ id: 'u-wired' }, {});
  assert.equal(v.ok, true, 'a genuinely-measured proof must verify');
  assert.ok(v.proof && v.proof.hash, 'a verified proof carries a hash');
});

// The registry rejects a duplicate id and resolves a registered connector by id.
test('ConnectorRegistry: registers by id and rejects duplicates', () => {
  const reg = new ConnectorRegistry();
  reg.register(new AzureArcConnector());
  assert.equal(reg.has('azure-arc'), true);
  assert.ok(reg.get('azure-arc'));
  assert.throws(() => reg.register(new AzureArcConnector()), /duplicate id/);
});
