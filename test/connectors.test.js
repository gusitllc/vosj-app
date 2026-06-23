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
const { reconcile, PRE_SWITCH_CATEGORIES } = require('../src/engine/reconcile');
const { buildConnectorMap, buildProviderRegistry } = require('../src/connectors');
const { DemoConnector } = require('../src/connectors/demo');
const disposition = require('../src/engine/disposition');
const { StateMachine } = require('../src/engine/state-machine');

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

// ===========================================================================
// PKG-PROVIDER-REGISTRY — the code registry is actually USED, the provider
// registry is config-driven, and reconciliation categories are configurable.
// (gaps 6 / 16 / 17 / 2)
// ===========================================================================

// ---- (gap 2/16/17) the code registry is wired: ctx.connectors carries all three
test('buildConnectorMap(): registers demo + azure-arc + hyperv (registry is used, not forked)', () => {
  const map = buildConnectorMap();
  assert.ok(map instanceof Map, 'buildConnectorMap returns a Map (ctx.connectors shape)');
  for (const id of ['demo', 'azure-arc', 'hyperv']) {
    assert.equal(map.has(id), true, `${id} must be registered in the connector map`);
    assert.equal(map.get(id).id, id, `${id} resolves to its connector`);
  }
  assert.equal(map.size, 3, 'exactly the three shipped connectors are registered');
});

// ---- (gap 16/17 honesty) wiring the extra connectors does NOT open the gate:
// an unwired connector still cannot produce a passing reconcile proof.
test('an unwired registered connector cannot produce a passing reconcile proof', async () => {
  const map = buildConnectorMap();
  const config = Object.freeze({ LEDGER_HMAC_KEY: 'k', version: 'test' });
  for (const id of ['azure-arc', 'hyperv']) {
    const conn = map.get(id);
    const env = id === 'azure-arc'
      ? { AZURE_SUBSCRIPTION_ID: 's', AZURE_ARC_RESOURCE_GROUP: 'rg', AZURE_LOCAL_CLUSTER: 'cl' }
      : { HYPERV_HOST: 'hv01', HYPERV_TRANSPORT: 'winrm' };
    const unit = { id: `${id}-u`, baselineAt: freshBaseline() };
    await conn.replicate(unit, { env });
    const r = await reconcile(unit, conn, { config, env });
    assert.equal(r.ok, false, `${id} (registered but unwired) must never pass reconcile`);
  }
  // The demo connector IS wired and DOES pass — proving the gate is reachable.
  const demo = map.get('demo');
  const u = { id: 'demo-u', rowCount: 100, baselineAt: freshBaseline() };
  await demo.replicate(u, {});
  const rd = await reconcile(u, demo, { config: Object.freeze({ ...config }) });
  assert.equal(rd.ok, true, 'the wired demo connector produces a genuine passing proof');
});

// ---- (gap 6) provider registry list()/get() is config-driven (regions + price)
test('provider registry: list()/get() merge code connectors with config region/price', () => {
  const connectors = buildConnectorMap();
  const config = Object.freeze({
    providerRegistry: {
      'azure-arc': { regions: ['eastus', 'westeurope'], priceTier: 'standard' },
      'fabric-future': { regions: ['eu-north'], priceTier: 'preview' }, // declared, not yet shipped
    },
  });
  const providers = buildProviderRegistry(connectors, config);

  const arc = providers.get('azure-arc');
  assert.deepEqual([...arc.regions], ['eastus', 'westeurope'], 'regions come from config');
  assert.equal(arc.priceTier, 'standard', 'price tier comes from config');
  assert.equal(arc.wired, true, 'azure-arc has a registered connector (wired)');

  // A connector with NO config entry still surfaces, with empty metadata (fail-closed).
  const demo = providers.get('demo');
  assert.deepEqual([...demo.regions], [], 'no config => empty regions (no hardcoded default)');
  assert.equal(demo.priceTier, null, 'no config => null price tier');
  assert.equal(demo.wired, true);

  // A config-declared provider with no connector yet surfaces as wired:false.
  const future = providers.get('fabric-future');
  assert.equal(future.wired, false, 'a configured-but-unshipped provider is not wired');
  assert.deepEqual([...future.regions], ['eu-north']);

  const ids = providers.list().map((p) => p.id);
  assert.deepEqual(ids, ['azure-arc', 'demo', 'fabric-future', 'hyperv'].sort(),
    'list() is the union of registered connectors and configured providers');
  assert.equal(providers.get('nope'), null, 'get() of an unknown id returns null (fail-closed)');
});

// ---- (gap 6) provider registry fails closed with absent/malformed config
test('provider registry: absent/malformed config => empty metadata, never a permissive default', () => {
  const connectors = buildConnectorMap();
  for (const bad of [undefined, {}, { providerRegistry: null }, { providerRegistry: 'oops' }]) {
    const providers = buildProviderRegistry(connectors, bad);
    const arc = providers.get('azure-arc');
    assert.deepEqual([...arc.regions], [], 'malformed/absent config yields no regions');
    assert.equal(arc.priceTier, null, 'malformed/absent config yields null price tier');
    // The connector set is still surfaced (the code registry is the source of truth).
    assert.equal(providers.list().length, 3, 'all three connectors still listed');
  }
});

// ---- (gap 6) reconcile honours configured pre-switch categories ------------
test('reconcile: VOSJ_RECONCILE_CATEGORIES overrides the pre-switch gate set', async () => {
  const conn = new DemoConnector();
  const unit = { id: 'cfg-u', rowCount: 100, baselineAt: freshBaseline() };
  await conn.replicate(unit, {});

  // Override to a strict subset: only row_counts + checksums gate the switch.
  const config = Object.freeze({
    LEDGER_HMAC_KEY: 'k', version: 'test',
    reconcileCategories: ['row_counts', 'checksums'],
  });
  const r = await reconcile(unit, conn, { config });
  const names = r.categories.filter((c) => c.preSwitch).map((c) => c.name).sort();
  assert.deepEqual(names, ['checksums', 'row_counts'],
    'the configured categories REPLACE the default pre-switch set');
  assert.equal(r.ok, true, 'a clean replication still passes the configured subset');
});

// ---- (gap 6) a configured category that is NOT reported fails closed -------
test('reconcile: a configured category with no measurement fails closed', async () => {
  const conn = new DemoConnector();
  const unit = { id: 'cfg-u2', rowCount: 100, baselineAt: freshBaseline() };
  await conn.replicate(unit, {});
  // 'durability' is not a category the demo connector measures -> not reported.
  const config = Object.freeze({
    LEDGER_HMAC_KEY: 'k', version: 'test',
    reconcileCategories: ['row_counts', 'durability'],
  });
  const r = await reconcile(unit, conn, { config });
  assert.equal(r.ok, false, 'an unmeasured configured category must sink the proof');
  const durability = r.categories.find((c) => c.name === 'durability');
  assert.equal(durability.ok, false);
  assert.match(durability.detail, /not reported/);
});

// ---- (gap 6) absent/empty config keeps the default frozen list (no regression)
test('reconcile: absent or empty reconcileCategories keeps the default six categories', async () => {
  const conn = new DemoConnector();
  const unit = { id: 'cfg-u3', rowCount: 100, baselineAt: freshBaseline() };
  await conn.replicate(unit, {});
  for (const cfg of [{}, { reconcileCategories: [] }, { reconcileCategories: null }]) {
    const config = Object.freeze({ LEDGER_HMAC_KEY: 'k', version: 'test', ...cfg });
    const r = await reconcile(unit, conn, { config });
    const names = r.categories.filter((c) => c.preSwitch).map((c) => c.name).sort();
    assert.deepEqual(names, [...PRE_SWITCH_CATEGORIES].sort(),
      'with no override the default six pre-switch categories stand');
  }
});

// ===========================================================================
// Material defect proof (cross-cuts gap 16/17): a high-risk disposition is
// FORCED onto Strangler-Fig, AND the verified-before-Jump gate is BLOCKED when
// the structural disposition rule is violated. Wiring the registry must NOT
// create a path around either guarantee.
// ===========================================================================

// A minimal template + a memory-less StateMachine to exercise the planning gate.
function planningTemplate() {
  return {
    id: 'tpl-plan', name: 'Plan', version: '1', source: 'test',
    description: 'x', states: ['P3', 'P4'],
    transitions: [{ from: 'P3', to: 'P4', gateId: 'g-planning-signoff' }],
    phases: [{ station: 'plan', gate: { id: 'g-planning-signoff', name: 'plan', signerRole: 'director', requiresSignature: true, criteria: [] } }],
  };
}

test('material defect: every high-risk disposition resolves to Strangler-Fig (big-bang structurally unavailable)', () => {
  for (const name of disposition.ALL) {
    const c = disposition.contractFor(name);
    if (c.highRisk === true) {
      assert.equal(c.cutoverStyle, disposition.CUTOVER.STRANGLER_FIG,
        `high-risk ${name} must be Strangler-Fig`);
      const cl = disposition.classify({ disposition: name });
      assert.equal(cl.bigBangAvailable, false, `${name} must not offer big-bang`);
    }
  }
});

test('material defect: the planning gate BLOCKS when a high-risk disposition is not Strangler-Fig', async () => {
  // Refactor is a REAL high-risk disposition (so it passes the ALL.includes() guard).
  // We tamper ONLY its contract to (illegally) keep a big-bang cutover style, then
  // assert the planning gate refuses to bind — i.e. the structural guarantee is
  // enforced at the gate, not merely declared in the contract table.
  const orig = disposition.contractFor;
  const store = {
    async listWorkloads() {
      return [{ id: 'w1', inScope: true, disposition: 'Refactor', attributes: { cicd365Ready: true } }];
    },
  };
  disposition.contractFor = (n) => (n === 'Refactor'
    ? Object.freeze({ executorClass: 'refactor', runbookTemplate: 'r', cutoverStyle: disposition.CUTOVER.BIG_BANG, highRisk: true })
    : orig(n));
  try {
    const tpl = planningTemplate();
    const sm = new StateMachine(tpl, { signer: { sign: async () => ({}) }, store });
    await assert.rejects(
      () => sm.evaluateGateCriteria(tpl.phases[0].gate, { id: 'run-1', plan: {} }),
      /structural guarantee violated/,
      'a high-risk disposition that is not Strangler-Fig must block the gate, not pass it'
    );
  } finally {
    disposition.contractFor = orig;
  }
});

test('material defect: an honest high-risk Refactor binds Strangler-Fig and the gate is reachable', async () => {
  // The complementary case: with the genuine contract, the SAME gate binds the
  // mandatory Strangler-Fig runbook and does NOT throw — proving the guarantee
  // blocks ONLY the violation, not legitimate high-risk work.
  const store = {
    async listWorkloads() {
      return [{ id: 'w1', inScope: true, disposition: 'Refactor', attributes: { cicd365Ready: true } }];
    },
  };
  const tpl = planningTemplate();
  const sm = new StateMachine(tpl, { signer: { sign: async () => ({}) }, store });
  const run = { id: 'run-ok', plan: {} };
  const ok = await sm.evaluateGateCriteria(tpl.phases[0].gate, run);
  assert.equal(ok, true, 'a CI/CD-365-ready high-risk Refactor satisfies the planning gate');
  assert.equal(run.plan.executorBindings.w1.cutoverStyle, disposition.CUTOVER.STRANGLER_FIG,
    'the bound runbook is the mandatory Strangler-Fig style');
});
