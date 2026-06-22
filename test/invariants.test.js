// test/invariants.test.js — the non-waivable Vosj invariants (§12/§13/§14).
// In-memory store, no network. Reads the engine/ledger/gate APIs directly.
// Asserts: (1) no agent self-sign / author != signer; (2) verified-before-Jump;
// (3) ledger fail-closed (missing HMAC key throws); (4) baseline-drift guard;
// (5) Strangler-Fig forced for high-risk (no big-bang).

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { Ledger } = require('../src/ledger/ledger');
const { MemoryStateStore } = require('../src/db/statestore');
const { buildEngine } = require('../src/engine');
const { reconcile } = require('../src/engine/reconcile');
const { DemoConnector } = require('../src/connectors/demo');

const KEY = 'test-hmac-key-please-rotate';
const HUMAN_DBA = { id: 'alice-dba', kind: 'human', role: 'dba' };

function buildKit({ ledgerKey = KEY } = {}) {
  const store = new MemoryStateStore();
  const config = Object.freeze({ LEDGER_HMAC_KEY: ledgerKey, version: 'test' });
  const ledger = new Ledger({ store, config });
  const engine = buildEngine({ config, store, ledger });
  return { store, config, ledger, engine };
}

function freshUnit(extra = {}) {
  return Object.assign(
    { id: 'u-db', name: 'DB', state: 'reconciled', rowCount: 1000,
      baselineAt: new Date().toISOString() },
    extra
  );
}

async function passingProof(unit) {
  const { engine } = buildKit();
  const conn = new DemoConnector();
  await conn.replicate(unit, {});
  const r = await engine.reconcile(unit, conn, {});
  assert.equal(r.ok, true, 'precondition: reconcile should pass');
  return r.proof;
}

// ---- Invariant 1 & 2: no agent self-sign / author cannot self-sign --------
test('Inv1: agent signer is rejected (no agent self-sign)', async () => {
  const { engine } = buildKit();
  const machine = engine.machineFor('caf');
  const run = { id: 'wave-1', state: 'P1' };
  const agent = { id: 'bot-7', kind: 'agent', role: 'director' };
  await assert.rejects(
    () => machine.signTransition({ run, to: 'P2', actor: 'someone', signer: agent }),
    /signer must be human/
  );
});

test('Inv2: author cannot also sign (separation of duties)', async () => {
  const { engine } = buildKit();
  const machine = engine.machineFor('caf');
  const run = { id: 'wave-1', state: 'P1' };
  // P1 gate signerRole is 'director'; make the human the same id as the actor.
  const signer = { id: 'dana-director', kind: 'human', role: 'director' };
  await assert.rejects(
    () => machine.signTransition({ run, to: 'P2', actor: 'dana-director', signer }),
    /author cannot self-sign/
  );
});

// ---- Invariant 6: verified-before-Jump --------------------------------------
test('Inv6: cutover without a passing proof is rejected (fail-closed)', async () => {
  const { engine } = buildKit();
  const machine = engine.machineFor('caf');
  const unit = freshUnit();
  // No proof at all.
  await assert.rejects(
    () => machine.cutoverUnit({ unit, actor: 'bob', signer: HUMAN_DBA, proof: null }),
    /passing reconciliation proof required/
  );
  // A proof that did NOT pass (ok:false) is also rejected.
  await assert.rejects(
    () => machine.cutoverUnit({ unit, actor: 'bob', signer: HUMAN_DBA, proof: { ok: false, hash: 'x' } }),
    /passing reconciliation proof required/
  );
});

test('Inv6: a passing proof + independent human DBA reaches migrated', async () => {
  const { engine } = buildKit();
  const machine = engine.machineFor('caf');
  const unit = freshUnit();
  const proof = await passingProof(unit);
  const res = await machine.cutoverUnit({ unit, actor: 'carol-eng', signer: HUMAN_DBA, proof });
  assert.equal(res.state, 'migrated');
  assert.equal(res.gate, engine.injectedCutoverGate.id);
  assert.ok(res.ledger && res.ledger.hash, 'cutover writes a signed ledger row');
});

// ---- Invariant 5: ledger fail-closed (missing HMAC key) ---------------------
test('Inv5: ledger append throws when the HMAC key is missing', async () => {
  const { ledger } = buildKit({ ledgerKey: '' });
  await assert.rejects(
    () => ledger.append({ action: 'gate.sign', actor: 'x' }),
    /fail-closed: VOSJ_LEDGER_HMAC_KEY is not set/
  );
});

test('Inv5: verifyChain also fails closed without a key', async () => {
  const { ledger } = buildKit({ ledgerKey: '' });
  await assert.rejects(() => ledger.verifyChain([]), /fail-closed/);
  // healthy() must NOT throw — it reports false.
  assert.equal(await ledger.healthy(), false);
});

// ---- Invariant: baseline-drift guard ----------------------------------------
test('Inv: a stale baseline makes the proof fail (drift guard)', async () => {
  const { engine } = buildKit();
  const conn = new DemoConnector();
  const stale = new Date(Date.now() - (48 * 60 * 60 * 1000)).toISOString();
  const unit = freshUnit({ baselineAt: stale });
  await conn.replicate(unit, {});
  const r = await engine.reconcile(unit, conn, {});
  assert.equal(r.baselineFresh, false);
  assert.equal(r.ok, false, 'stale baseline must not produce a passing proof');
});

test('Inv: a missing baseline is treated as not-fresh (fail-closed)', async () => {
  const { config } = buildKit();
  const conn = new DemoConnector();
  const unit = freshUnit({ baselineAt: undefined });
  await conn.replicate(unit, {});
  const r = await reconcile(unit, conn, { config });
  assert.equal(r.baselineFresh, false);
  assert.equal(r.ok, false);
});

test('Inv: a stale baseline cannot be cut over even with a "passing" proof shape', async () => {
  const { engine } = buildKit();
  const machine = engine.machineFor('caf');
  const conn = new DemoConnector();
  const stale = new Date(Date.now() - (48 * 60 * 60 * 1000)).toISOString();
  const unit = freshUnit({ baselineAt: stale });
  await conn.replicate(unit, {});
  const r = await engine.reconcile(unit, conn, {});
  // r.ok is false -> cutover must reject.
  await assert.rejects(
    () => machine.cutoverUnit({ unit, actor: 'carol', signer: HUMAN_DBA, proof: r.proof }),
    /passing reconciliation proof required/
  );
});

// ---- Invariant 3/7: Strangler-Fig forced for high-risk (no big-bang) --------
test('Inv: high-risk dispositions are Strangler-Fig only (no big-bang)', () => {
  const { engine } = buildKit();
  for (const key of ['Refactor', 'Replatform', 'Relocate']) {
    const c = engine.classify({ disposition: key });
    assert.equal(c.disposition, key);
    assert.equal(c.contract.highRisk, true, `${key} is high-risk`);
    assert.equal(c.strangler, true, `${key} must be Strangler-Fig`);
    assert.equal(c.bigBangAvailable, false, `${key} must NOT allow big-bang`);
  }
});

test('Inv: the cloud-native-rewrite heuristic never yields a big-bang plan', () => {
  const { engine } = buildKit();
  const c = engine.classify({ cloudNativeRewrite: true });
  assert.equal(c.disposition, 'Refactor');
  assert.equal(c.bigBangAvailable, false);
});
