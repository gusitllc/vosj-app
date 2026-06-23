// test/acceptance.test.js — revocable acceptance + three-way contingency reversal
// (PKG-REVOCABLE-ACCEPTANCE; §13.2 'Net effect'; §6 P6; gaps 36/130/135/136/139).
//
// Asserts the REVERSIBLE half of cutover (disjoint from the irreversible-forward
// cutoverUnit() in state-machine.js):
//   - revoke within the window SUCCEEDS, writes a 'cutover.revoke' ledger row, and
//     flips the unit back to 'reconciled';
//   - revoke AFTER the window is FAIL-CLOSED (window closed);
//   - three-way reversal needs a QUORUM of DISTINCT human signers;
//   - a duplicate signer id is rejected (no single actor can force/abort — gap 136);
//   - an agent signer is rejected (human-only, reuses GateSigner human-ness);
//   - net effect (gap 139): the proven-before-cutover guarantee still holds AND the
//     accepted cutover is reversible — both coexist.
//
// The companion material-defect cover for the §7 disposition guarantee (a high-risk
// disposition forces Strangler-Fig AND a gate is BLOCKED when the rule is violated)
// is asserted here too so this package ships its own proof of that invariant.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { AcceptanceWindow, ACCEPTANCE_STATUS, REVERT_STATE } = require('../src/engine/acceptance');
const { Ledger } = require('../src/ledger/ledger');
const { MemoryStateStore } = require('../src/db/statestore');
const { StateMachine } = require('../src/engine/state-machine');
const { HumanGateSigner } = require('../src/engine/gate');
const disposition = require('../src/engine/disposition');
const template = require('../src/engine/template');
const { CAF_TEMPLATE } = require('./helpers');

const TEST_HMAC_KEY = 'test-ledger-key-acceptance-0123456789abcdef';

// Config stand-in with the two new knobs (default 30 min window, 3-of-N quorum).
function cfg(overrides = {}) {
  return Object.freeze(Object.assign({
    version: 'test',
    LEDGER_HMAC_KEY: TEST_HMAC_KEY,
    revocationWindowMs: 30 * 60 * 1000,
    reversalQuorum: 3,
  }, overrides));
}

// Build a fresh in-memory kit with a workload already cut over (state 'migrated').
async function kit(overrides = {}) {
  const config = cfg(overrides);
  const store = new MemoryStateStore();
  await store.init();
  const ledger = new Ledger({ store, config });
  await store.saveWorkload({
    id: 'u1', name: 'App', disposition: 'Rehost', state: 'migrated',
    migrationId: 'm1', wave_id: 'w1', attributes: {},
  });
  const acceptance = new AcceptanceWindow({ ledger, store, config });
  return { config, store, ledger, acceptance };
}

const DBA = { id: 'dba-1', kind: 'human', role: 'dba' };
const DIR = { id: 'dir-1', kind: 'human', role: 'director' };
const ITLEAD = { id: 'it-1', kind: 'human', role: 'it-lead' };
const AGENT = { id: 'agent-7', kind: 'agent', role: 'dba' };

// ---------------------------------------------------------------------------
// recordAcceptance
// ---------------------------------------------------------------------------

test('recordAcceptance stamps accepted_at + flips status to accepted', async () => {
  const { acceptance, store } = await kit();
  const now = Date.now();
  const r = await acceptance.recordAcceptance({ unitId: 'u1', actor: 'agent-7', now });
  assert.equal(r.ok, true);
  assert.equal(r.acceptedAt, new Date(now).toISOString());
  const w = await store.getWorkload('u1');
  assert.equal(w.acceptance_status, ACCEPTANCE_STATUS.ACCEPTED);
  assert.ok(w.accepted_at, 'accepted_at is persisted');
});

test('recordAcceptance fail-closed on an unknown unit', async () => {
  const { acceptance } = await kit();
  const r = await acceptance.recordAcceptance({ unitId: 'nope' });
  assert.equal(r.ok, false);
  assert.match(r.error, /unknown unit/);
});

// ---------------------------------------------------------------------------
// revokeAcceptance — within / after the window (gaps 36/130/135)
// ---------------------------------------------------------------------------

test('revoke WITHIN the window succeeds, writes a cutover.revoke row, reverts to reconciled', async () => {
  const { acceptance, store, ledger } = await kit();
  const t0 = Date.now();
  await acceptance.recordAcceptance({ unitId: 'u1', now: t0 });

  // 10 minutes later — inside the 30-min window.
  const r = await acceptance.revokeAcceptance({
    unitId: 'u1', signer: DBA, reason: 'post-cutover drift detected', now: t0 + 10 * 60 * 1000,
  });
  assert.equal(r.ok, true);
  assert.equal(r.state, REVERT_STATE);
  assert.equal(r.ledger.action, 'cutover.revoke');
  assert.ok(r.ledger.hash, 'a ledger row was written');

  const w = await store.getWorkload('u1');
  assert.equal(w.state, 'reconciled', 'unit flipped back to reconciled');
  assert.equal(w.acceptance_status, ACCEPTANCE_STATUS.REVOKED);

  // The ledger chain is intact and contains exactly the one revoke row.
  const rows = await ledger.list();
  const revokes = rows.filter((x) => x.action === 'cutover.revoke');
  assert.equal(revokes.length, 1);
  assert.equal((await ledger.verifyChain()).ok, true);
});

test('revoke AFTER the window is FAIL-CLOSED (window closed)', async () => {
  const { acceptance, store } = await kit();
  const t0 = Date.now();
  await acceptance.recordAcceptance({ unitId: 'u1', now: t0 });

  // 31 minutes later — past the 30-min window.
  const r = await acceptance.revokeAcceptance({
    unitId: 'u1', signer: DBA, reason: 'late drift', now: t0 + 31 * 60 * 1000,
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /revocation window closed/);

  // The cutover STANDS — state is unchanged, acceptance still 'accepted'.
  const w = await store.getWorkload('u1');
  assert.equal(w.state, 'migrated');
  assert.equal(w.acceptance_status, ACCEPTANCE_STATUS.ACCEPTED);
});

test('revoke rejects an AGENT signer (human-only, no agent self-revoke)', async () => {
  const { acceptance } = await kit();
  const t0 = Date.now();
  await acceptance.recordAcceptance({ unitId: 'u1', now: t0 });
  const r = await acceptance.revokeAcceptance({
    unitId: 'u1', signer: AGENT, reason: 'x', now: t0 + 60 * 1000,
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /must be human/);
});

test('revoke requires a reason and a known, accepted unit', async () => {
  const { acceptance } = await kit();
  // no reason
  assert.equal((await acceptance.revokeAcceptance({ unitId: 'u1', signer: DBA })).ok, false);
  // never accepted
  const r = await acceptance.revokeAcceptance({ unitId: 'u1', signer: DBA, reason: 'r' });
  assert.equal(r.ok, false);
  assert.match(r.error, /no recorded acceptance/);
});

// ---------------------------------------------------------------------------
// threeWayReversal — quorum of distinct humans (gap 136)
// ---------------------------------------------------------------------------

test('three-way reversal SUCCEEDS with a quorum of distinct humans; one row per signer + a final row', async () => {
  const { acceptance, store, ledger } = await kit();
  await acceptance.recordAcceptance({ unitId: 'u1', now: Date.now() });

  const r = await acceptance.threeWayReversal({
    unitId: 'u1', signers: [DBA, DIR, ITLEAD], reason: 'contingency reversal in flight',
  });
  assert.equal(r.ok, true);
  assert.equal(r.state, REVERT_STATE);
  assert.equal(r.ledger.action, 'cutover.reverse');
  assert.equal(r.signerLedger.length, 3, 'one ledger row per signer');
  assert.deepEqual(r.ledger.meta.signerIds, ['dba-1', 'dir-1', 'it-1']);

  const w = await store.getWorkload('u1');
  assert.equal(w.state, 'reconciled');
  assert.equal(w.acceptance_status, ACCEPTANCE_STATUS.REVERSED);

  const rows = await ledger.list();
  assert.equal(rows.filter((x) => x.action === 'cutover.reverse.signer').length, 3);
  assert.equal(rows.filter((x) => x.action === 'cutover.reverse').length, 1);
  assert.equal((await ledger.verifyChain()).ok, true);
});

test('three-way reversal is REJECTED below quorum (fewer than 3 signers)', async () => {
  const { acceptance, store } = await kit();
  await acceptance.recordAcceptance({ unitId: 'u1', now: Date.now() });
  const r = await acceptance.threeWayReversal({ unitId: 'u1', signers: [DBA, DIR], reason: 'r' });
  assert.equal(r.ok, false);
  assert.match(r.error, /3 distinct human signers/);
  // No side effect — the unit is unchanged (no single coalition under quorum can act).
  const w = await store.getWorkload('u1');
  assert.equal(w.state, 'migrated');
});

test('three-way reversal REJECTS a duplicate signer id (no single actor can force it)', async () => {
  const { acceptance, store, ledger } = await kit();
  await acceptance.recordAcceptance({ unitId: 'u1', now: Date.now() });
  const dupe = { id: 'dba-1', kind: 'human', role: 'auditor' }; // same id as DBA
  const r = await acceptance.threeWayReversal({ unitId: 'u1', signers: [DBA, DIR, dupe], reason: 'r' });
  assert.equal(r.ok, false);
  assert.match(r.error, /duplicate signer rejected/);
  // Validated BEFORE any side effect: no reversal rows written, unit unchanged.
  const rows = await ledger.list();
  assert.equal(rows.filter((x) => /cutover\.reverse/.test(x.action)).length, 0);
  assert.equal((await store.getWorkload('u1')).state, 'migrated');
});

test('three-way reversal REJECTS an agent among the signers', async () => {
  const { acceptance } = await kit();
  await acceptance.recordAcceptance({ unitId: 'u1', now: Date.now() });
  const r = await acceptance.threeWayReversal({ unitId: 'u1', signers: [DBA, DIR, AGENT], reason: 'r' });
  assert.equal(r.ok, false);
  assert.match(r.error, /must be human/);
});

test('reversal quorum honours config (VOSJ_REVERSAL_QUORUM): 2-of-N works when configured', async () => {
  const { acceptance } = await kit({ reversalQuorum: 2 });
  await acceptance.recordAcceptance({ unitId: 'u1', now: Date.now() });
  const r = await acceptance.threeWayReversal({ unitId: 'u1', signers: [DBA, DIR], reason: 'r' });
  assert.equal(r.ok, true);
  assert.equal(r.signerLedger.length, 2);
});

test('reversal is NOT time-boxed — available past the revoke window (in-flight contingency)', async () => {
  const { acceptance } = await kit();
  const t0 = Date.now();
  await acceptance.recordAcceptance({ unitId: 'u1', now: t0 });
  // Past the 30-min revoke window, but reversal (the in-flight contingency) still works.
  const r = await acceptance.threeWayReversal({
    unitId: 'u1', signers: [DBA, DIR, ITLEAD], reason: 'late contingency', now: t0 + 60 * 60 * 1000,
  });
  assert.equal(r.ok, true);
  assert.equal(r.state, REVERT_STATE);
});

// ---------------------------------------------------------------------------
// Net effect (gap 139): proven-before-cutover AND reversible coexist.
// ---------------------------------------------------------------------------

test('net effect: cutover stays proven-before-traffic AND is reversible after acceptance', async () => {
  const { acceptance, store } = await kit();
  const signer = new HumanGateSigner({ ledger: acceptance.ledger, store });
  const sm = new StateMachine(template.loadFile(CAF_TEMPLATE), { signer, store });

  // (1) Proven-before-cutover is still enforced: no passing proof -> fail-closed.
  const unit = { id: 'u1', state: 'reconciled', migrationId: 'm1' };
  await assert.rejects(
    () => sm.cutoverUnit({ unit, actor: 'agent-7', signer: DBA, proof: null }),
    /passing reconciliation proof required/
  );

  // (2) A passing proof + independent human cuts the unit over.
  const proof = { ok: true, hash: 'deadbeef', categories: [] };
  const cut = await sm.cutoverUnit({ unit, actor: 'agent-7', signer: DBA, proof });
  assert.equal(cut.state, 'migrated');

  // (3) The accepted cutover is then REVERSIBLE within the window (the new half).
  const t0 = Date.now();
  await acceptance.recordAcceptance({ unitId: 'u1', now: t0 });
  const rev = await acceptance.revokeAcceptance({
    unitId: 'u1', signer: DIR, reason: 'drift after traffic shift', now: t0 + 5 * 60 * 1000,
  });
  assert.equal(rev.ok, true);
  assert.equal((await store.getWorkload('u1')).state, 'reconciled');
});

// ---------------------------------------------------------------------------
// Material-defect cover (§7): high-risk disposition forced onto Strangler-Fig AND a
// gate/Jump is BLOCKED when the disposition rule is violated. Shipped with this
// package so the structural guarantee is re-proven here.
// ---------------------------------------------------------------------------

test('material defect: every high-risk disposition is structurally forced onto Strangler-Fig', () => {
  for (const name of disposition.ALL) {
    const c = disposition.contractFor(name);
    if (c.highRisk === true) {
      assert.equal(c.cutoverStyle, disposition.CUTOVER.STRANGLER_FIG,
        `${name} is high-risk and MUST be Strangler-Fig (big-bang structurally unavailable)`);
      const view = disposition.classify({ disposition: name });
      assert.equal(view.bigBangAvailable, false, `${name} must NOT expose a big-bang plan`);
    }
  }
});

test('material defect: the P2 kickoff gate (the Jump) is BLOCKED when the disposition rule is violated', async () => {
  const config = cfg();
  const store = new MemoryStateStore();
  await store.init();
  const ledger = new Ledger({ store, config });
  const signer = new HumanGateSigner({ ledger, store });
  const sm = new StateMachine(template.loadFile(CAF_TEMPLATE), { signer, store });

  // A wave with a workload missing its 7-R disposition -> kickoff gate fails closed.
  await store.saveWorkload({ id: 'wv-ok', name: 'A', disposition: 'Rehost', wave_id: 'wv', attributes: {} });
  await store.saveWorkload({ id: 'wv-bad', name: 'B', disposition: null, wave_id: 'wv', attributes: {} });
  // The kickoff gate requires the 'it-lead' role; use it so the disposition criteria
  // (not the role check) is what fails closed.
  await assert.rejects(
    () => sm.signTransition({ run: { id: 'wv', state: 'P2' }, to: 'P3', actor: 'a', signer: ITLEAD }),
    /machine-checkable criteria not satisfied/
  );
});
