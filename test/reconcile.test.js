// test/reconcile.test.js — the reconciliation engine + demo connector verify().
// Drives the genuine verify()/π(w) over the six pre-switch categories (§13):
// replication_lag, row_counts, checksums, sequence_identity, constraints, smoke.
// In-memory, no network. Covers a passing case AND a deliberately-broken case.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildEngine } = require('../src/engine');
const { reconcile, PRE_SWITCH_CATEGORIES } = require('../src/engine/reconcile');
const { Ledger } = require('../src/ledger/ledger');
const { MemoryStateStore } = require('../src/db/statestore');
const { DemoConnector } = require('../src/connectors/demo');

const KEY = 'test-hmac-key';

function engineKit() {
  const store = new MemoryStateStore();
  const config = Object.freeze({ LEDGER_HMAC_KEY: KEY, version: 'test' });
  const ledger = new Ledger({ store, config });
  return { config, engine: buildEngine({ config, store, ledger }) };
}

function freshUnit(extra = {}) {
  return Object.assign(
    { id: 'u-db', name: 'DB', rowCount: 845231, baselineAt: new Date().toISOString() },
    extra
  );
}

function catMap(categories) {
  const m = {};
  for (const c of categories) m[c.name] = c;
  return m;
}

// ---- The six categories are present and pre-switch -------------------------
test('verify() reports exactly the six pre-switch categories', async () => {
  const conn = new DemoConnector();
  const unit = freshUnit();
  await conn.replicate(unit, {});
  const v = await conn.verify(unit, {});
  const names = v.categories.map((c) => c.name).sort();
  assert.deepEqual(names, [...PRE_SWITCH_CATEGORIES].sort());
});

// ---- Passing case ----------------------------------------------------------
test('reconcile passes after a clean replication (π(w) ok, all six ok)', async () => {
  const { engine } = engineKit();
  const conn = new DemoConnector();
  const unit = freshUnit();
  await conn.replicate(unit, {});

  const r = await engine.reconcile(unit, conn, {});
  assert.equal(r.ok, true);
  assert.equal(r.baselineFresh, true);

  const m = catMap(r.categories);
  for (const name of PRE_SWITCH_CATEGORIES) {
    assert.equal(m[name].ok, true, `category ${name} should pass`);
    assert.equal(m[name].preSwitch, true);
  }
  assert.ok(r.proof.hash && r.proof.hash.length === 64, 'proof carries a sha256 hash');
  assert.equal(r.proof.ok, true, 'proof is self-describing');
});

// ---- Broken case: verify before replication (checksums + smoke fail) -------
test('reconcile fails when the connector has not replicated (broken case)', async () => {
  const { engine } = engineKit();
  const conn = new DemoConnector();
  const unit = freshUnit();
  // NOTE: no replicate() call -> st.replicated is falsy.

  const r = await engine.reconcile(unit, conn, {});
  assert.equal(r.ok, false, 'an un-replicated unit must not pass');

  const m = catMap(r.categories);
  assert.equal(m.checksums.ok, false, 'checksums must fail without replication');
  assert.equal(m.smoke.ok, false, 'smoke must fail without replication');
});

// ---- Broken case: a deliberately mismatched row count ----------------------
test('reconcile fails on a deliberate row-count mismatch (broken case)', async () => {
  const { config } = engineKit();
  const conn = new DemoConnector();
  const unit = freshUnit();
  await conn.replicate(unit, {});
  // Inject drift directly into the connector's simulated state.
  const st = conn._stateFor(unit);
  st.targetRows = st.sourceRows - 7; // 7 rows lost in flight
  st.lagRows = 3;

  const r = await reconcile(unit, conn, { config });
  assert.equal(r.ok, false);
  const m = catMap(r.categories);
  assert.equal(m.row_counts.ok, false, 'row_counts must catch the mismatch');
  assert.equal(m.replication_lag.ok, false, 'replication_lag must catch in-flight rows');
});

// ---- A not-reported category fails closed ----------------------------------
test('reconcile fails closed when a pre-switch category is not reported', async () => {
  const { config } = engineKit();
  const partial = {
    id: 'demo',
    async verify() {
      // Only report two of the six categories; ok:true is a lie the engine ignores.
      return { ok: true, categories: [
        { name: 'row_counts', ok: true, detail: 'ok' },
        { name: 'checksums', ok: true, detail: 'ok' },
      ], proof: { hash: 'partial' } };
    },
  };
  const unit = freshUnit();
  const r = await reconcile(unit, partial, { config });
  assert.equal(r.ok, false, 'missing categories must fail closed');
  const m = catMap(r.categories);
  assert.equal(m.smoke.ok, false);
  assert.match(m.smoke.detail, /not reported/);
});

// ---- Determinism: the proof hash is stable for identical inputs ------------
test('proof hash is deterministic for the same verified state', async () => {
  const { config } = engineKit();
  const conn = new DemoConnector();
  const unit = freshUnit({ baselineAt: '2026-06-22T00:00:00.000Z' });
  await conn.replicate(unit, {});
  const a = await reconcile(unit, conn, { config });
  const b = await reconcile(unit, conn, { config });
  // ts differs in proof body, so hashes differ; the verify() proof.hash is stable.
  assert.equal(a.proof.connectorProof.hash, b.proof.connectorProof.hash);
});
