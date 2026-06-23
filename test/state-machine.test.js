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

// ---------------------------------------------------------------------------
// 7-R disposition gate (PKG-DISPO-GATE, gaps 40/41/44). The kickoff gate
// (g-kickoff-complete, P2->P3) is hard-blocked unless EVERY in-scope workload
// carries a valid disposition; the planning gate (g-planning-signoff, P3->P4)
// binds executors STRICTLY from the contract and hard-blocks a CI/CD-365
// disposition (Replatform/Refactor) that is not cicd365Ready.
// ---------------------------------------------------------------------------

async function gateKit() {
  const ctx = await buildTestCtx();
  const signer = new HumanGateSigner({ ledger: ctx.ledger, store: ctx.store });
  const sm = new StateMachine(loadCaf(), { signer, store: ctx.store });
  return { ctx, sm };
}
const ITLEAD = { id: 'iv-1', kind: 'human', role: 'it-lead' };
const DIRECTOR = { id: 'dir-2', kind: 'human', role: 'director' };

test('(a) P1->P2 signs fine regardless of dispositions (discovery gate is not disposition-bearing)', async () => {
  const { sm } = await gateKit();
  const run = { id: 'wa', state: 'P1' };
  const r = await sm.signTransition({ run, to: 'P2', actor: 'agent-x', signer: DIRECTOR });
  assert.equal(r.state, 'P2');
  assert.equal(r.gate, 'g-discovery-signoff');
});

test('(b) P2->P3 is BLOCKED when a wave has a workload with a null disposition', async () => {
  const { ctx, sm } = await gateKit();
  await ctx.store.saveWorkload({ id: 'w-ok', name: 'A', disposition: 'Rehost', wave_id: 'wb', attributes: {} });
  await ctx.store.saveWorkload({ id: 'w-bad', name: 'B', disposition: null, wave_id: 'wb', attributes: {} });
  const run = { id: 'wb', state: 'P2' };
  await assert.rejects(
    () => sm.signTransition({ run, to: 'P3', actor: 'agent-x', signer: ITLEAD }),
    /machine-checkable criteria not satisfied/
  );
});

test('(b2) P2->P3 is BLOCKED when the wave has NO in-scope workloads at all', async () => {
  const { sm } = await gateKit();
  await assert.rejects(
    () => sm.signTransition({ run: { id: 'wempty', state: 'P2' }, to: 'P3', actor: 'a', signer: ITLEAD }),
    /machine-checkable criteria not satisfied/
  );
});

test('(c) P2->P3 SUCCEEDS once every in-scope workload carries a valid disposition', async () => {
  const { ctx, sm } = await gateKit();
  await ctx.store.saveWorkload({ id: 'w1', name: 'A', disposition: 'Rehost', wave_id: 'wc', attributes: {} });
  await ctx.store.saveWorkload({ id: 'w2', name: 'B', disposition: 'Repurchase', wave_id: 'wc', attributes: {} });
  // out-of-scope workload with a null disposition must NOT block the gate.
  await ctx.store.saveWorkload({ id: 'w3', name: 'C', disposition: null, wave_id: 'wc', inScope: false, attributes: {} });
  const run = { id: 'wc', state: 'P2' };
  const r = await sm.signTransition({ run, to: 'P3', actor: 'agent-x', signer: ITLEAD });
  assert.equal(r.state, 'P3');
  assert.equal(r.gate, 'g-kickoff-complete');
});

test('(d) planning gate (P3->P4) BLOCKS a Replatform/Refactor workload lacking cicd365Ready, SUCCEEDS with it', async () => {
  const { ctx, sm } = await gateKit();
  // Replatform carries deliverySystemPrecondition=true -> CI/CD-365 is a hard dep.
  await ctx.store.saveWorkload({ id: 'wd1', name: 'Repl', disposition: 'Replatform', wave_id: 'wd', attributes: {} });
  await assert.rejects(
    () => sm.signTransition({ run: { id: 'wd', state: 'P3' }, to: 'P4', actor: 'a', signer: DIRECTOR }),
    /machine-checkable criteria not satisfied/,
    'Replatform without cicd365Ready must be hard-blocked at planning'
  );
  // Flip the precondition on -> the same gate clears.
  await ctx.store.saveWorkload({ id: 'wd1', name: 'Repl', disposition: 'Replatform', wave_id: 'wd',
    attributes: { cicd365Ready: true } });
  const run = { id: 'wd', state: 'P3' };
  const r = await sm.signTransition({ run, to: 'P4', actor: 'a', signer: DIRECTOR });
  assert.equal(r.state, 'P4');
  assert.equal(r.gate, 'g-planning-signoff');
});

test('(e) run.plan.executorBindings is populated STRICTLY from the disposition contract (gap 41)', async () => {
  const { ctx, sm } = await gateKit();
  await ctx.store.saveWorkload({ id: 'we1', name: 'Lift', disposition: 'Rehost', wave_id: 'we', attributes: {} });
  await ctx.store.saveWorkload({ id: 'we2', name: 'Reshape', disposition: 'Replatform', wave_id: 'we',
    attributes: { cicd365Ready: true } });
  const run = { id: 'we', state: 'P3' };
  await sm.signTransition({ run, to: 'P4', actor: 'a', signer: DIRECTOR });

  const b1 = run.plan.executorBindings.we1;
  assert.deepEqual(b1, { executorClass: 'rehost', runbookTemplate: 'rehost-near-zero-downtime', cutoverStyle: 'big-bang' });
  const b2 = run.plan.executorBindings.we2;
  // High-risk reshape -> Strangler-Fig runbook bound from the contract, never chosen at runtime.
  assert.deepEqual(b2, { executorClass: 'replatform', runbookTemplate: 'replatform-reshape', cutoverStyle: 'strangler-fig' });
});

test('material defect: a high-risk disposition is bound to Strangler-Fig AND a CI/CD-365 violation BLOCKS the gate', async () => {
  const { ctx, sm } = await gateKit();
  // Refactor is high-risk + carries the CI/CD precondition.
  await ctx.store.saveWorkload({ id: 'wf1', name: 'Rearch', disposition: 'Refactor', wave_id: 'wf', attributes: {} });
  // Without cicd365Ready the planning gate fails closed (no Jump kicked off).
  await assert.rejects(
    () => sm.signTransition({ run: { id: 'wf', state: 'P3' }, to: 'P4', actor: 'a', signer: DIRECTOR }),
    /machine-checkable criteria not satisfied/
  );
  // With the precondition met, the bound runbook is the mandatory Strangler-Fig one.
  await ctx.store.saveWorkload({ id: 'wf1', name: 'Rearch', disposition: 'Refactor', wave_id: 'wf',
    attributes: { cicd365Ready: true } });
  const run = { id: 'wf', state: 'P3' };
  const r = await sm.signTransition({ run, to: 'P4', actor: 'a', signer: DIRECTOR });
  assert.equal(r.state, 'P4');
  assert.equal(run.plan.executorBindings.wf1.cutoverStyle, 'strangler-fig');
  assert.equal(run.plan.executorBindings.wf1.runbookTemplate, 'refactor-strangler');
});
