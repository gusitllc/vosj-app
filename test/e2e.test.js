// test/e2e.test.js — end-to-end: drive a workload through the four stations
// Vault (V) -> Orchestrate (O) -> Shift (S) -> Jump (J) with the demo connector.
// Each human phase gate is signed by an INDEPENDENT human in the gate's role;
// Jump (the unit cutover -> migrated) is only reachable after a passing reconcile;
// the tamper-evident ledger chain verifies at the end. In-memory, no network.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildEngine } = require('../src/engine');
const { Ledger } = require('../src/ledger/ledger');
const { MemoryStateStore } = require('../src/db/statestore');
const { DemoConnector } = require('../src/connectors/demo');

const KEY = 'e2e-hmac-key-rotate-me';

// One independent human per role (never the actor who authored the work).
const SIGNERS = {
  director: { id: 'dana-director', kind: 'human', role: 'director' },
  'it-lead': { id: 'ivan-itlead', kind: 'human', role: 'it-lead' },
  infosec: { id: 'sam-infosec', kind: 'human', role: 'infosec' },
  dba: { id: 'alice-dba', kind: 'human', role: 'dba' },
};
const AUTHOR = 'carol-engineer'; // the agent/engineer who did the work

function kit() {
  const store = new MemoryStateStore();
  const config = Object.freeze({ LEDGER_HMAC_KEY: KEY, version: 'e2e' });
  const ledger = new Ledger({ store, config });
  const engine = buildEngine({ config, store, ledger });
  return { store, config, ledger, engine };
}

// Sign one phase transition with the human required by that phase's gate.
// A cutover-marked phase gate (e.g. CAF P6->P7 reconciliation-pass) fails closed
// unless a passing reconciliation proof is supplied — so the caller threads it in.
async function signPhase(machine, run, to, proof = null) {
  const next = machine.listValidNextStates(run).find((n) => n.to === to);
  assert.ok(next, `no transition to ${to} from ${run.state}`);
  const role = next.gate && next.gate.signerRole;
  const signer = SIGNERS[role];
  assert.ok(signer, `no test signer for role ${role}`);
  const res = await machine.signTransition({
    run, to, actor: AUTHOR, signer, proof,
    evidence: [`evidence:${run.state}->${to}`],
  });
  run.state = res.state;
  return res;
}

test('e2e: Vault -> Orchestrate -> Shift -> Jump with signed gates + verified cutover', async () => {
  const { store, engine, ledger } = kit();
  const conn = new DemoConnector();

  // --- discover (Vault station data source) ---
  const inv = await conn.discover({});
  assert.equal(inv.ok, true);
  const seed = inv.units.find((u) => u.kind === 'database');

  // High-risk reshape -> Strangler-Fig is structurally forced (no big-bang).
  const classed = engine.classify({ disposition: 'Replatform' });
  assert.equal(classed.bigBangAvailable, false);
  assert.equal(classed.strangler, true);

  // Persist the wave + workload (system-of-record).
  const wave = await store.saveWave({
    id: 'wave-1', name: 'Pilot wave', state: 'P1',
    framework_template_id: 'caf', framework_version: '1',
  });
  const unit = await store.saveWorkload({
    id: seed.id, name: seed.name, disposition: 'Replatform', state: 'legacy',
    wave_id: wave.id, baseline_at: new Date().toISOString(),
    attributes: { rowCount: seed.rowCount },
  });

  // --- walk the phase FSM P1..P5 (Vault V -> Orchestrate O -> Shift S) ---
  // The CAF P6->P7 gate is marked cutover:true, so it CANNOT be signed until a
  // passing reconciliation proof exists — proving verified-before-Jump at the
  // phase level too. We stop at P6 (the Verify/Jump-prep station) and reconcile.
  const machine = engine.machineFor('caf');
  const run = { id: wave.id, state: 'P1' };
  const path = ['P2', 'P3', 'P4', 'P5', 'P6'];
  const stationOf = { P1: 'V', P2: 'V', P3: 'O', P4: 'O', P5: 'S', P6: 'J', P7: 'J' };
  for (const to of path) {
    const res = await signPhase(machine, run, to);
    assert.equal(run.state, to, `advanced into ${to} (${stationOf[to]})`);
    assert.ok(res.ledger.hash, `gate into ${to} wrote a ledger row`);
  }
  assert.equal(run.state, 'P6', 'reached Verify (Jump station) — cutover not yet signed');

  // --- the unit lifecycle: replicate -> dual_running -> reconciled ---
  await conn.replicate({ id: unit.id, rowCount: seed.rowCount }, {});
  let u = await store.saveWorkload(Object.assign({}, unit, { state: 'dual_running' }));
  u = await store.saveWorkload(Object.assign({}, u, { state: 'reconciled' }));
  const reconcileUnit = { id: u.id, rowCount: seed.rowCount, state: u.state,
    baselineAt: u.baseline_at };

  // Jump is NOT reachable until a passing reconcile exists. Prove the gate
  // fails closed for both the phase cutover gate AND the unit cutover:
  await assert.rejects(
    () => signPhase(machine, run, 'P7', null),
    /passing reconciliation proof/,
    'P6->P7 cutover gate must fail with no proof'
  );
  assert.equal(run.state, 'P6', 'still at P6 after the rejected jump');
  await assert.rejects(
    () => machine.cutoverUnit({ unit: reconcileUnit, actor: AUTHOR, signer: SIGNERS.dba, proof: null }),
    /passing reconciliation proof required/,
    'unit cutover must fail with no proof'
  );

  // Now reconcile -> Jump becomes reachable.
  const recon = await engine.reconcile(reconcileUnit, conn, {});
  assert.equal(recon.ok, true, 'reconcile passes -> Jump becomes reachable');

  // --- Jump (phase): P6 -> P7 signed by the DBA, binding the proof ---
  const jumpPhase = await signPhase(machine, run, 'P7', recon.proof);
  assert.equal(run.state, 'P7', 'reached Jump-to-BAU phase after a passing reconcile');
  assert.equal(jumpPhase.gate, 'g-reconciliation-pass');

  // --- Jump (unit): cutover reconciled -> migrated, independent DBA ---
  const jump = await machine.cutoverUnit({
    unit: reconcileUnit, actor: AUTHOR, signer: SIGNERS.dba,
    proof: recon.proof, evidence: ['go-no-go:approved'],
  });
  assert.equal(jump.state, 'migrated');
  assert.equal(jump.gate, engine.injectedCutoverGate.id);
  await store.saveWorkload(Object.assign({}, u, { state: 'migrated' }));

  // --- the ledger chain verifies end-to-end ---
  const chain = await ledger.list();
  // 6 phase gates (P1->P2..P6->P7) + 1 unit cutover gate = 7 signed rows.
  assert.equal(chain.length, 7, 'all human gate signatures are on the chain');
  const cut = chain[chain.length - 1];
  assert.equal(cut.action, 'gate.sign.cutover');
  assert.ok(cut.evidenceHashes.some((h) => h.startsWith('proof:')), 'cutover binds the proof hash');

  const verify = await ledger.verifyChain();
  assert.equal(verify.ok, true, 'chain verifies');
  assert.equal(verify.brokenAt, null);
});

test('e2e: a tampered ledger row is detected by verifyChain', async () => {
  const { engine, ledger, store } = kit();
  const machine = engine.machineFor('caf');
  const run = { id: 'w2', state: 'P1' };
  await signPhase(machine, run, 'P2');
  await signPhase(machine, run, 'P3');

  // Forge the meta of the first row in the underlying store (back-date attack).
  const rows = await store.listLedger();
  rows[0].meta = Object.assign({}, rows[0].meta, { signerId: 'mallory' });

  const verify = await ledger.verifyChain();
  assert.equal(verify.ok, false, 'tamper must be detected');
  assert.equal(verify.brokenAt, 1, 'first row flagged');
});
