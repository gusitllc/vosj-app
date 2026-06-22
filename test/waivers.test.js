// test/waivers.test.js — the soft-vs-hard waiver boundary, end-to-end.
// Asserts the platform's second-line control AND its limit:
//   (A) a SOFT / advisory gate CAN be waived — an active, scoped, non-expired
//       waiver row flips a failed advisory check to passing AND writes an AUDITED
//       'waiver.use' row to the tamper-evident ledger (verifiable hash chain);
//   (B) a HARD invariant CANNOT be waived even with a waiver row present —
//       specifically verified-before-cutover and no-self-sign. We plant an active
//       waiver and then prove the REAL engine gate path still rejects, because the
//       waiver mechanism is STRUCTURALLY incapable of feeding the gate signer.
// In-memory, no network. Complements rbac-waiver.test.js (which covers the
// WaiverRegistry check-name list); here we bind the waiver layer to the live gate
// engine so a regression that wired a waiver INTO the gate would be caught.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { WaiverRegistry, isWaivable, HARD_INVARIANT_CHECKS } = require('../src/engine/waiver');
const { HumanGateSigner } = require('../src/engine/gate');
const { StateMachine } = require('../src/engine/state-machine');
const { Ledger } = require('../src/ledger/ledger');
const { MemoryStateStore } = require('../src/db/statestore');
const template = require('../src/engine/template');
const { CAF_TEMPLATE } = require('./helpers');

const KEY = 'waiver-test-hmac-key';

function kit() {
  const store = new MemoryStateStore();
  const config = Object.freeze({ LEDGER_HMAC_KEY: KEY, version: 'test' });
  const ledger = new Ledger({ store, config });
  return { store, config, ledger };
}

const HUMAN_DBA = Object.freeze({ id: 'alice-dba', kind: 'human', role: 'dba' });

// ============================================================================
// (A) A soft / advisory gate CAN be waived, with an audited ledger entry.
// ============================================================================
test('soft gate: an active advisory waiver waives the check + writes an audited ledger row', async () => {
  const { store, ledger } = kit();
  await store.saveWaiver({
    id: 'wv-soft', gate_id: 'g-go-no-go', check_name: 'scorecard-coverage',
    check_class: 'advisory', status: 'active',
    granted_by: 'sam-infosec', reason: 'compensating control documented in CR-123',
  });
  const reg = new WaiverRegistry({ store, ledger });

  const before = (await ledger.list()).length;
  const r = await reg.tryWaive(
    { name: 'scorecard-coverage', class: 'advisory', gateId: 'g-go-no-go' }, 'carol-lead');

  assert.equal(r.waived, true, 'an active advisory waiver must waive the soft check');
  assert.equal(r.waiver.id, 'wv-soft');
  assert.ok(r.ledger && r.ledger.hash, 'waiver use writes a ledger row');
  assert.equal(r.ledger.action, 'waiver.use');
  assert.equal(r.ledger.meta.waiverId, 'wv-soft');
  assert.equal(r.ledger.meta.checkName, 'scorecard-coverage');
  assert.equal(r.ledger.meta.grantedBy, 'sam-infosec');

  const after = await ledger.list();
  assert.equal(after.length, before + 1, 'exactly one audited row was appended');
});

test('soft gate: the audited waiver row is tamper-evident (hash chain verifies)', async () => {
  const { store, ledger } = kit();
  await store.saveWaiver({
    id: 'wv-chain', check_name: 'readiness-score', check_class: 'advisory',
    status: 'active', granted_by: 'lead', reason: 'documented',
  });
  const reg = new WaiverRegistry({ store, ledger });
  await reg.tryWaive({ name: 'readiness-score', class: 'advisory' }, 'carol');

  const chain = await ledger.list();
  const v = await ledger.verifyChain(chain);
  assert.equal(v.ok, true, 'the chain including the waiver row verifies');

  // Tamper with the recorded waiver row -> the chain must break at that seq.
  const idx = chain.findIndex((e) => e.action === 'waiver.use');
  chain[idx].meta = Object.assign({}, chain[idx].meta, { reason: 'forged after the fact' });
  const v2 = await ledger.verifyChain(chain);
  assert.equal(v2.ok, false, 'a forged waiver row is detected');
  assert.equal(v2.brokenAt, chain[idx].seq);
});

test('soft gate: a waiver applied without a ledger fails closed (cannot waive silently)', async () => {
  const { store } = kit();
  await store.saveWaiver({
    id: 'wv-noledger', check_name: 'coverage', check_class: 'advisory',
    status: 'active', granted_by: 'x', reason: 'y',
  });
  const reg = new WaiverRegistry({ store, ledger: null }); // no ledger
  await assert.rejects(
    () => reg.tryWaive({ name: 'coverage', class: 'advisory' }, 'carol'),
    /waiver fail-closed: a ledger is required/,
    'a waiver must never be applied without an audit trail'
  );
});

// ============================================================================
// (B) A HARD invariant CANNOT be waived — even with a waiver row present.
// ============================================================================

// (B1) verified-before-cutover: plant an active "advisory" waiver naming the hard
// invariant, then prove BOTH the waiver layer refuses it AND the real gate engine
// still rejects a cutover with no passing proof. The waiver cannot reach the gate.
test('hard: verified-before-cutover cannot be waived even with an active waiver row', async () => {
  const { store, ledger } = kit();
  await store.saveWaiver({
    id: 'evil-vbc', check_name: 'verified-before-cutover', check_class: 'advisory',
    status: 'active', granted_by: 'mallory', reason: 'just let it through',
  });
  const reg = new WaiverRegistry({ store, ledger });

  // 1) the waiver layer structurally refuses (and does not record a waiver.use).
  assert.equal(isWaivable({ name: 'verified-before-cutover', class: 'advisory' }), false);
  const w = await reg.tryWaive({ name: 'verified-before-cutover', class: 'advisory' }, 'mallory');
  assert.equal(w.waived, false, 'the hard invariant must never be waived');

  // 2) the REAL gate engine still fails closed on a cutover with no passing proof,
  //    regardless of the waiver row sitting in the store.
  const signer = new HumanGateSigner({ ledger, store });
  const sm = new StateMachine(template.loadFile(CAF_TEMPLATE), { signer, store });
  const unit = { id: 'u1', state: 'reconciled', migrationId: 'm1' };
  await assert.rejects(
    () => sm.cutoverUnit({ unit, actor: 'bob-eng', signer: HUMAN_DBA, proof: null }),
    /passing reconciliation proof required/,
    'no waiver may bypass verified-before-cutover'
  );
  await assert.rejects(
    () => sm.cutoverUnit({ unit, actor: 'bob-eng', signer: HUMAN_DBA, proof: { ok: false, hash: 'x' } }),
    /passing reconciliation proof required/
  );

  // 3) no 'waiver.use' row was ever written for the hard invariant.
  const chain = await ledger.list();
  assert.equal(chain.filter((e) => e.action === 'waiver.use').length, 0);
});

// (B2) no-agent-self-sign + separation-of-duties: a waiver cannot make an agent a
// signer, nor let the author sign their own gate. The gate signer ignores waivers
// entirely (it takes no waiver argument); these guards are in contracts.GateSigner.
test('hard: no-self-sign cannot be waived (agent signer + author==signer both refused)', async () => {
  const { store, ledger } = kit();
  for (const name of ['no-agent-self-sign', 'separation-of-duties']) {
    await store.saveWaiver({
      id: `evil-${name}`, check_name: name, check_class: 'advisory',
      status: 'active', granted_by: 'mallory', reason: 'bypass duties',
    });
    assert.equal(isWaivable({ name, class: 'advisory' }), false, `${name} must be unwaivable`);
  }
  const signer = new HumanGateSigner({ ledger, store });

  // an AGENT signer is rejected (no agent self-sign) — a waiver cannot help.
  const agentGate = { id: 'g1', actor: 'eng-1', fromState: 'P1', toState: 'P2' };
  await assert.rejects(
    () => signer.sign(agentGate, { id: 'bot-7', kind: 'agent', role: 'director' }),
    /signer must be human/
  );
  // the AUTHOR signing their own gate is rejected (separation of duties).
  const selfGate = { id: 'g2', actor: 'dana', fromState: 'P1', toState: 'P2' };
  await assert.rejects(
    () => signer.sign(selfGate, { id: 'dana', kind: 'human', role: 'director' }),
    /author cannot self-sign/
  );

  const chain = await ledger.list();
  assert.equal(chain.filter((e) => e.action === 'waiver.use').length, 0,
    'no waiver.use was recorded for a hard invariant');
});

// (B3) every reserved hard-invariant name is refused, and the store is not even
// queried — a defence-in-depth check distinct from the engine-path tests above.
test('hard: the full reserved hard-invariant list is structurally unwaivable', () => {
  for (const name of HARD_INVARIANT_CHECKS) {
    assert.equal(isWaivable({ name, class: 'advisory' }), false,
      `${name} must be unwaivable even when classed advisory`);
  }
  // and the canonical soft check is still waivable (the boundary is real, not blanket-deny).
  assert.equal(isWaivable({ name: 'scorecard-coverage', class: 'advisory' }), true);
});

// (B4) the waiver layer never widens the gate: a successfully-waived SOFT check
// does NOT grant any cutover. Proves the two systems are decoupled — passing the
// advisory go/no-go scorecard still requires the separate verified-before-Jump proof.
test('decoupled: waiving a soft scorecard check does not authorise a cutover', async () => {
  const { store, ledger } = kit();
  await store.saveWaiver({
    id: 'wv-go', gate_id: 'g-go-no-go', check_name: 'scorecard-coverage',
    check_class: 'advisory', status: 'active', granted_by: 'lead', reason: 'ok',
  });
  const reg = new WaiverRegistry({ store, ledger });
  const w = await reg.tryWaive({ name: 'scorecard-coverage', class: 'advisory', gateId: 'g-go-no-go' }, 'carol');
  assert.equal(w.waived, true);

  // The cutover gate is a DIFFERENT, hard path: still needs a passing proof.
  const signer = new HumanGateSigner({ ledger, store });
  const sm = new StateMachine(template.loadFile(CAF_TEMPLATE), { signer, store });
  await assert.rejects(
    () => sm.cutoverUnit({ unit: { id: 'u9', state: 'reconciled' }, actor: 'a', signer: HUMAN_DBA, proof: null }),
    /passing reconciliation proof required/,
    'a waived soft check grants no cutover authority'
  );
});
