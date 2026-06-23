// test/four-eyes.test.js — Four-eyes change validation (Invariant 3, gaps 37/117)
// + independent rollback authoring (gap 35), as MACHINE-CHECKABLE P3 gate
// preconditions. In-memory store, no network.
//
// Asserts:
//   - a change validated by its OWN author is rejected (author === validator);
//   - an AGENT validator is rejected (no agent self-validate, mirrors Invariant 1);
//   - a validation with no diff-impact report is rejected;
//   - isFourEyesSatisfied(wave) is FALSE until a valid INDEPENDENT human validation
//     exists, then TRUE;
//   - isIndependentRollbackAuthored(wave) is FALSE when the rollback and cutover
//     runbooks share an author, TRUE when authored independently;
//   - a 'change.validated' row is written to the tamper-evident ledger and the chain
//     still verifies;
//   - MATERIAL DEFECT: the composition seam (ctx.fourEyes.evaluateP3) BLOCKS a P3
//     planning gate when the four-eyes / independent-rollback rule is violated, and
//     the gate clears only once both controls are satisfied (fail-closed).

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildFourEyes, attachFourEyes, FourEyesRegistry,
  CUTOVER_RUNBOOK, ROLLBACK_RUNBOOK,
} = require('../src/engine/four-eyes');
const { buildTestCtx } = require('./helpers');

const HUMAN_V = { id: 'val-1', kind: 'human', role: 'risk-control' };
const AGENT_V = { id: 'bot-7', kind: 'agent', role: 'risk-control' };
const DIFF = { files: 3, added: 120, removed: 17, risk: 'medium' };

async function kit() {
  const ctx = await buildTestCtx();
  const fourEyes = buildFourEyes({ store: ctx.store, ledger: ctx.ledger });
  return { ctx, fourEyes };
}

test('buildFourEyes requires a ledger (fail loud)', () => {
  assert.throws(() => new FourEyesRegistry({ store: null, ledger: null }), /requires a ledger/);
});

test('recordChange fail-closes without an author (no one to be independent of)', async () => {
  const { fourEyes } = await kit();
  const r = await fourEyes.recordChange({ id: 'c0', waveId: 'w0', author: '' });
  assert.equal(r.ok, false);
  assert.match(r.error, /requires an author/);
});

test('a change validated by its OWN author is rejected (author === validator)', async () => {
  const { fourEyes } = await kit();
  await fourEyes.recordChange({ id: 'c1', waveId: 'w1', author: 'agent-a' });
  const r = await fourEyes.recordValidation({
    changeId: 'c1',
    validator: { id: 'agent-a', kind: 'human', role: 'risk-control' },
    diffImpact: DIFF,
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /validator cannot be the change author/);
});

test('an AGENT validator is rejected (no agent self-validate)', async () => {
  const { fourEyes } = await kit();
  await fourEyes.recordChange({ id: 'c2', waveId: 'w2', author: 'agent-a' });
  const r = await fourEyes.recordValidation({ changeId: 'c2', validator: AGENT_V, diffImpact: DIFF });
  assert.equal(r.ok, false);
  assert.match(r.error, /validator must be human/);
});

test('a validation with no diff-impact report is rejected', async () => {
  const { fourEyes } = await kit();
  await fourEyes.recordChange({ id: 'c3', waveId: 'w3', author: 'agent-a' });
  const r = await fourEyes.recordValidation({ changeId: 'c3', validator: HUMAN_V, diffImpact: null });
  assert.equal(r.ok, false);
  assert.match(r.error, /diff-impact report is required/);
});

test('validating an unknown change is rejected (fail-closed)', async () => {
  const { fourEyes } = await kit();
  const r = await fourEyes.recordValidation({ changeId: 'nope', validator: HUMAN_V, diffImpact: DIFF });
  assert.equal(r.ok, false);
  assert.match(r.error, /unknown change/);
});

test('isFourEyesSatisfied is FALSE until a valid independent human validation exists, then TRUE', async () => {
  const { fourEyes } = await kit();
  // no changes at all -> not satisfied (fail-closed, nothing validated)
  assert.equal(await fourEyes.isFourEyesSatisfied('w4'), false);

  await fourEyes.recordChange({ id: 'c4', waveId: 'w4', author: 'agent-a' });
  // pending change -> still not satisfied
  assert.equal(await fourEyes.isFourEyesSatisfied('w4'), false);

  const ok = await fourEyes.recordValidation({ changeId: 'c4', validator: HUMAN_V, diffImpact: DIFF });
  assert.equal(ok.ok, true);
  assert.equal(ok.change.status, 'validated');
  assert.equal(ok.change.validator, 'val-1');
  // now an independent human validated it -> satisfied
  assert.equal(await fourEyes.isFourEyesSatisfied('w4'), true);
});

test('a wave is NOT satisfied while ANY change remains unvalidated', async () => {
  const { fourEyes } = await kit();
  await fourEyes.recordChange({ id: 'c5a', waveId: 'w5', author: 'agent-a' });
  await fourEyes.recordChange({ id: 'c5b', waveId: 'w5', author: 'agent-b' });
  await fourEyes.recordValidation({ changeId: 'c5a', validator: HUMAN_V, diffImpact: DIFF });
  // c5b still pending -> the whole wave is not satisfied
  assert.equal(await fourEyes.isFourEyesSatisfied('w5'), false);
  await fourEyes.recordValidation({ changeId: 'c5b', validator: HUMAN_V, diffImpact: DIFF });
  assert.equal(await fourEyes.isFourEyesSatisfied('w5'), true);
});

test('recordValidation writes a change.validated ledger row and the chain still verifies', async () => {
  const { ctx, fourEyes } = await kit();
  await fourEyes.recordChange({ id: 'c6', waveId: 'w6', author: 'agent-a' });
  const r = await fourEyes.recordValidation({ changeId: 'c6', validator: HUMAN_V, diffImpact: DIFF });
  assert.equal(r.ok, true);
  assert.equal(r.ledger.action, 'change.validated');
  assert.equal(r.ledger.meta.changeId, 'c6');
  assert.equal(r.ledger.meta.validatorId, 'val-1');
  assert.ok(r.ledger.evidenceHashes[0].startsWith('diff-impact:'), 'diff-impact evidence hash recorded');
  const v = await ctx.ledger.verifyChain();
  assert.equal(v.ok, true, 'tamper-evident chain remains intact after a validation row');
});

// ---- independent rollback authoring (gap 35) --------------------------------
test('isIndependentRollbackAuthored is FALSE when rollback shares the cutover author', async () => {
  const { fourEyes } = await kit();
  fourEyes.recordDeliverable({ waveId: 'w7', kind: CUTOVER_RUNBOOK, author: 'agent-a' });
  fourEyes.recordDeliverable({ waveId: 'w7', kind: ROLLBACK_RUNBOOK, author: 'agent-a' });
  assert.equal(fourEyes.isIndependentRollbackAuthored('w7'), false);
});

test('isIndependentRollbackAuthored is FALSE when the rollback runbook is missing (fail-closed)', async () => {
  const { fourEyes } = await kit();
  fourEyes.recordDeliverable({ waveId: 'w8', kind: CUTOVER_RUNBOOK, author: 'agent-a' });
  assert.equal(fourEyes.isIndependentRollbackAuthored('w8'), false);
});

test('isIndependentRollbackAuthored is TRUE when authored by a separate agent in a separate context', async () => {
  const { fourEyes } = await kit();
  fourEyes.recordDeliverable({ waveId: 'w9', kind: CUTOVER_RUNBOOK, author: 'agent-a' });
  fourEyes.recordDeliverable({ waveId: 'w9', kind: ROLLBACK_RUNBOOK, author: 'agent-b' });
  assert.equal(fourEyes.isIndependentRollbackAuthored('w9'), true);
});

// ---- the composition seam: ctx.fourEyes.evaluateP3 --------------------------
test('attachFourEyes wires ctx.fourEyes as the declared P3 integration seam', async () => {
  const ctx = await buildTestCtx();
  assert.equal(ctx.fourEyes, undefined, 'not present until attached');
  const fe = attachFourEyes(ctx);
  assert.equal(typeof fe.evaluateP3, 'function');
  assert.equal(ctx.fourEyes, fe, 'registry placed on ctx for the gate to consult');
  // idempotent — re-attach returns the same instance
  assert.equal(attachFourEyes(ctx), fe);
});

// MATERIAL DEFECT: a gate that DEPENDS on four-eyes must be BLOCKED when the control
// is violated, and may clear only when BOTH four-eyes AND independent rollback hold.
// We exercise the EXACT seam PKG-DISPO-GATE consults (ctx.fourEyes.evaluateP3) via a
// tiny local gate evaluator, so this proves composition WITHOUT editing state-machine.js.
async function evaluateP3GateDependingOnFourEyes(ctx, waveId) {
  // Mirrors how state-machine.evaluateGateCriteria folds in an external criteria
  // provider: fail-closed if the provider is absent, else consult its single seam.
  if (!ctx.fourEyes || typeof ctx.fourEyes.evaluateP3 !== 'function') return false;
  return ctx.fourEyes.evaluateP3(waveId);
}

test('material defect: the P3 gate is BLOCKED until four-eyes AND independent rollback are satisfied', async () => {
  const ctx = await buildTestCtx();
  const fe = attachFourEyes(ctx);
  const wave = 'w-defect';

  // (0) nothing recorded -> gate fail-closed
  assert.equal(await evaluateP3GateDependingOnFourEyes(ctx, wave), false);

  // (1) a change exists but is only SELF-validated by its author -> rejected, gate blocked
  await fe.recordChange({ id: 'cd', waveId: wave, author: 'agent-a' });
  const selfVal = await fe.recordValidation({
    changeId: 'cd',
    validator: { id: 'agent-a', kind: 'human' }, // author === validator
    diffImpact: DIFF,
  });
  assert.equal(selfVal.ok, false);
  assert.equal(await evaluateP3GateDependingOnFourEyes(ctx, wave), false, 'self-validated change cannot clear the gate');

  // (2) an INDEPENDENT human validates -> four-eyes satisfied, but rollback still
  //     shares the cutover author -> gate STILL blocked (independent rollback fails)
  await fe.recordValidation({ changeId: 'cd', validator: HUMAN_V, diffImpact: DIFF });
  assert.equal(await fe.isFourEyesSatisfied(wave), true);
  fe.recordDeliverable({ waveId: wave, kind: CUTOVER_RUNBOOK, author: 'agent-a' });
  fe.recordDeliverable({ waveId: wave, kind: ROLLBACK_RUNBOOK, author: 'agent-a' }); // same author!
  assert.equal(await evaluateP3GateDependingOnFourEyes(ctx, wave), false,
    'four-eyes alone is not enough — a non-independent rollback still BLOCKS the gate');

  // (3) re-author the rollback in a separate context -> BOTH controls hold -> gate clears
  fe.recordDeliverable({ waveId: wave, kind: ROLLBACK_RUNBOOK, author: 'agent-b' });
  assert.equal(await evaluateP3GateDependingOnFourEyes(ctx, wave), true,
    'gate clears only once four-eyes AND independent rollback are both satisfied');
});

test('evaluateP3 is independent per wave (a satisfied wave does not leak into a fresh one)', async () => {
  const ctx = await buildTestCtx();
  const fe = attachFourEyes(ctx);
  await fe.recordChange({ id: 'cw', waveId: 'wA', author: 'agent-a' });
  await fe.recordValidation({ changeId: 'cw', validator: HUMAN_V, diffImpact: DIFF });
  fe.recordDeliverable({ waveId: 'wA', kind: CUTOVER_RUNBOOK, author: 'agent-a' });
  fe.recordDeliverable({ waveId: 'wA', kind: ROLLBACK_RUNBOOK, author: 'agent-b' });
  assert.equal(await fe.evaluateP3('wA'), true);
  // a brand-new wave with no records is still fail-closed
  assert.equal(await fe.evaluateP3('wB'), false);
});
