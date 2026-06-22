// test/state-machine.test.js — the signed-gate phase-gate FSM (§6.1/§14.1).
// Asserts: the unit lifecycle is strictly forward; cutover (-> migrated) is
// FAIL-CLOSED without a passing reconciliation proof; the verified-before-Jump
// gate is engine-injected and addressable on every template (non-removable).

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { StateMachine, UNIT_STATES, INJECTED_CUTOVER_GATE } = require('../src/engine/state-machine');
const template = require('../src/engine/template');
const { HumanGateSigner } = require('../src/engine/gate');
const { buildTestCtx, CAF_TEMPLATE } = require('./helpers');

function loadCaf() { return template.loadFile(CAF_TEMPLATE); }

test('unit lifecycle is the fixed four-state forward chain', () => {
  assert.deepEqual(UNIT_STATES, ['legacy', 'dual_running', 'reconciled', 'migrated']);
});

test('unit transitions are strictly forward, one step at a time', () => {
  const sm = new StateMachine(loadCaf(), {});
  assert.equal(sm.canUnitTransition({ state: 'legacy' }, 'dual_running'), true);
  assert.equal(sm.canUnitTransition({ state: 'reconciled' }, 'migrated'), true);
  // backwards and skips are rejected
  assert.equal(sm.canUnitTransition({ state: 'dual_running' }, 'legacy'), false);
  assert.equal(sm.canUnitTransition({ state: 'legacy' }, 'migrated'), false);
});

test('the injected cutover gate is non-removable and addressable on the template', () => {
  const sm = new StateMachine(loadCaf(), {});
  // The injected gate id is always indexed even though the JSON never declares it.
  assert.equal(INJECTED_CUTOVER_GATE.id, 'engine.verified-before-jump');
  assert.equal(INJECTED_CUTOVER_GATE.cutover, true);
  assert.equal(INJECTED_CUTOVER_GATE.requiresSignature, true);
  // Reachable via the same indexing the FSM uses internally.
  assert.equal(sm._index.gates['engine.verified-before-jump'].injected, true);
});

test('cutover is FAIL-CLOSED without a passing reconciliation proof', async () => {
  const ctx = await buildTestCtx();
  const signer = new HumanGateSigner({ ledger: ctx.ledger, store: ctx.store });
  const sm = new StateMachine(loadCaf(), { signer, store: ctx.store });

  const unit = { id: 'u1', state: 'reconciled', migrationId: 'm1' };
  const human = { id: 'dba-1', kind: 'human', role: 'dba' };

  // no proof at all -> rejected
  await assert.rejects(
    () => sm.cutoverUnit({ unit, actor: 'agent-7', signer: human, proof: null }),
    /passing reconciliation proof required/
  );
  // failing proof -> rejected
  await assert.rejects(
    () => sm.cutoverUnit({ unit, actor: 'agent-7', signer: human, proof: { ok: false, hash: 'x' } }),
    /passing reconciliation proof required/
  );
});

test('cutover succeeds with a passing proof + an independent human signer', async () => {
  const ctx = await buildTestCtx();
  const signer = new HumanGateSigner({ ledger: ctx.ledger, store: ctx.store });
  const sm = new StateMachine(loadCaf(), { signer, store: ctx.store });

  const unit = { id: 'u1', state: 'reconciled', migrationId: 'm1' };
  const human = { id: 'dba-1', kind: 'human', role: 'dba' };
  const proof = { ok: true, hash: 'deadbeef', categories: [] };

  const r = await sm.cutoverUnit({ unit, actor: 'agent-7', signer: human, proof });
  assert.equal(r.state, 'migrated');
  assert.equal(r.gate, 'engine.verified-before-jump');
  assert.equal(r.ledger.action, 'gate.sign.cutover');
  assert.ok(r.ledger.hash, 'a ledger row was written');
});

test('cannot cut over a unit that is not yet reconciled', async () => {
  const ctx = await buildTestCtx();
  const signer = new HumanGateSigner({ ledger: ctx.ledger, store: ctx.store });
  const sm = new StateMachine(loadCaf(), { signer, store: ctx.store });
  const human = { id: 'dba-1', kind: 'human', role: 'dba' };
  const proof = { ok: true, hash: 'deadbeef' };
  await assert.rejects(
    () => sm.cutoverUnit({ unit: { id: 'u2', state: 'legacy' }, actor: 'a', signer: human, proof }),
    /cannot cut over/
  );
});

test('phase FSM: linear transitions are derived from the template gates', () => {
  const sm = new StateMachine(loadCaf(), {});
  const fromP1 = sm.listValidNextStates({ state: 'P1' });
  assert.equal(fromP1.length, 1);
  assert.equal(fromP1[0].to, 'P2');
  assert.ok(fromP1[0].gate, 'P1->P2 carries an exit gate');
  assert.equal(sm.canTransition({ state: 'P1' }, 'P2'), true);
  assert.equal(sm.canTransition({ state: 'P1' }, 'P7'), false);
});

test('a phase transition requires a human signature via the gate engine', async () => {
  const ctx = await buildTestCtx();
  const signer = new HumanGateSigner({ ledger: ctx.ledger, store: ctx.store });
  const sm = new StateMachine(loadCaf(), { signer, store: ctx.store });

  const run = { id: 'm1', state: 'P1' };
  const human = { id: 'dir-1', kind: 'human', role: 'director' };
  const r = await sm.signTransition({ run, to: 'P2', actor: 'agent-1', signer: human });
  assert.equal(r.state, 'P2');
  assert.equal(r.gate, 'g-discovery-signoff');
  assert.ok(r.ledger.hash);
});
