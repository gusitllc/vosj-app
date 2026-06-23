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

const {
  WaiverRegistry, evaluateChecks, isWaivable, isExpired,
  citationDefect, missingCitations, HARD_INVARIANT_CHECKS,
} = require('../src/engine/waiver');
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

// ============================================================================
// (C) gap 125 — time-boxed, signed-citation waiver lifecycle.
//   A waiver is a SIGNED LEDGER ROW citing (1) the gate criterion waived,
//   (2) residual risk, (3) compensating control, (4) remediation plan — never a
//   verbal override — and it is an EXPIRING object: on expiry the waived advisory
//   criterion RE-FAILS. Hard invariants stay structurally unwaivable throughout.
// ============================================================================

// The four citation fields a governed waiver row must carry (snake_case columns).
const FULL_CITATION = Object.freeze({
  reason: 'criterion scorecard-coverage waived: coverage 78% < 80% threshold',
  residual_risk: 'a thin slice of the legacy module ships unmetered for one wave',
  compensating_control: 'synthetic canary + on-call paging on the unmetered path',
  remediation_plan: 'backfill coverage to 80% by wave W+1; tracked in CR-742',
});

// (C1) A waiver missing compensating-control / remediation-plan is REJECTED — both
// the strict-mode lookup refuses to apply it AND the record path throws fail-closed.
test('gap125: a waiver missing compensatingControl/remediationPlan is rejected (fail-closed)', async () => {
  const { store, ledger } = kit();
  await store.saveWaiver({
    id: 'wv-partial', gate_id: 'g-go-no-go', check_name: 'scorecard-coverage',
    check_class: 'advisory', status: 'active', granted_by: 'sam',
    reason: FULL_CITATION.reason, residual_risk: FULL_CITATION.residual_risk,
    // compensating_control + remediation_plan deliberately ABSENT
  });

  // A partial citation set is a defect regardless of strict mode (no half-governed
  // waiver) — name the two missing fields explicitly.
  const lenientDefect = citationDefect({
    reason: 'r', residual_risk: 'rr',
  }, false);
  assert.match(lenientDefect, /compensatingControl/);
  assert.match(lenientDefect, /remediationPlan/);

  // Strict registry: the incomplete waiver is NOT applied -> the advisory check
  // re-fails (waived:false), and no waiver.use row is written.
  const strict = new WaiverRegistry({ store, ledger, requireCitations: true });
  const before = (await ledger.list()).length;
  const r = await strict.tryWaive(
    { name: 'scorecard-coverage', class: 'advisory', gateId: 'g-go-no-go' }, 'carol');
  assert.equal(r.waived, false, 'an incomplete governed waiver must not be applied');
  assert.equal((await ledger.list()).length, before, 'no waiver.use row for an incomplete waiver');

  // The record path itself throws fail-closed if ever reached with an incomplete row.
  await assert.rejects(
    () => strict._record(
      { name: 'scorecard-coverage', gateId: 'g-go-no-go' },
      { id: 'wv-partial', reason: 'r', residual_risk: 'rr' }, 'carol'),
    /waiver fail-closed: .*missing citation field/,
    'recording an incomplete waiver fails closed'
  );
});

// (C2) An EXPIRED waiver re-fails the advisory check through evaluateChecks — the
// re-arm assertion path the gap requires.
test('gap125: an expired waiver re-fails the advisory check (evaluateChecks reports FAILED)', async () => {
  const { store, ledger } = kit();
  const past = new Date(Date.now() - 60 * 1000).toISOString();
  const expiredRow = {
    id: 'wv-expired', gate_id: 'g-go-no-go', check_name: 'scorecard-coverage',
    check_class: 'advisory', status: 'active', granted_by: 'sam',
    expires_at: past, ...FULL_CITATION,
  };
  await store.saveWaiver(expiredRow);

  // isExpired() reports the row as expired; a future expiry would not be.
  assert.equal(isExpired(expiredRow), true, 'a past expiry => expired');
  assert.equal(isExpired({ ...expiredRow, expires_at: new Date(Date.now() + 60000).toISOString() }), false);

  const reg = new WaiverRegistry({ store, ledger });
  // findActive excludes the expired waiver entirely.
  assert.equal(
    await reg.findActive({ name: 'scorecard-coverage', class: 'advisory', gateId: 'g-go-no-go' }),
    null, 'an expired waiver is not active');

  // evaluateChecks: the advisory check that WAS waivable now reports FAILED again.
  const checks = [{ name: 'scorecard-coverage', class: 'advisory', gateId: 'g-go-no-go', ok: false }];
  const out = await evaluateChecks(checks, reg, 'carol');
  assert.equal(out.ok, false, 'an expired waiver re-arms the criterion');
  assert.equal(out.results[0].ok, false, 'the advisory check FAILS again on expiry');
  assert.equal(out.results[0].waived, false);

  // No waiver.use row was written for the expired waiver.
  assert.equal((await ledger.list()).filter((e) => e.action === 'waiver.use').length, 0);
});

// (C2b) Control: BEFORE expiry the same fully-cited waiver DOES waive the check —
// proving the re-fail in (C2) is the expiry, not a missing citation.
test('gap125: a fully-cited, unexpired waiver waives the advisory check (the positive control)', async () => {
  const { store, ledger } = kit();
  const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  await store.saveWaiver({
    id: 'wv-live', gate_id: 'g-go-no-go', check_name: 'scorecard-coverage',
    check_class: 'advisory', status: 'active', granted_by: 'sam',
    expires_at: future, ...FULL_CITATION,
  });
  const reg = new WaiverRegistry({ store, ledger, requireCitations: true });
  const checks = [{ name: 'scorecard-coverage', class: 'advisory', gateId: 'g-go-no-go', ok: false }];
  const out = await evaluateChecks(checks, reg, 'carol');
  assert.equal(out.ok, true, 'an active fully-cited waiver waives the advisory check');
  assert.equal(out.results[0].waived, true);
});

// (C3) The recorded ledger meta carries ALL FOUR citation fields.
test('gap125: the recorded waiver.use ledger meta carries all four citation fields', async () => {
  const { store, ledger } = kit();
  await store.saveWaiver({
    id: 'wv-cited', gate_id: 'g-go-no-go', check_name: 'scorecard-coverage',
    check_class: 'advisory', status: 'active', granted_by: 'sam-infosec',
    ...FULL_CITATION,
  });
  const reg = new WaiverRegistry({ store, ledger, requireCitations: true });
  const r = await reg.tryWaive(
    { name: 'scorecard-coverage', class: 'advisory', gateId: 'g-go-no-go' }, 'carol');

  assert.equal(r.waived, true);
  const m = r.ledger.meta;
  assert.equal(m.reason, FULL_CITATION.reason);
  assert.equal(m.residualRisk, FULL_CITATION.residual_risk);
  assert.equal(m.compensatingControl, FULL_CITATION.compensating_control);
  assert.equal(m.remediationPlan, FULL_CITATION.remediation_plan);
  assert.equal(m.waiverId, 'wv-cited');
  assert.equal(m.checkName, 'scorecard-coverage');
  // The audited citation row is part of the tamper-evident chain.
  const v = await ledger.verifyChain(await ledger.list());
  assert.equal(v.ok, true, 'the cited waiver.use row verifies in the chain');
});

// (C4) A hard invariant stays unwaivable EVEN with a fully-cited, unexpired waiver
// row planted — the citation fields do not buy a hard-invariant bypass.
test('gap125: a hard invariant is never waivable even with a full citation set', async () => {
  const { store, ledger } = kit();
  for (const name of HARD_INVARIANT_CHECKS) {
    await store.saveWaiver({
      id: `cited-evil-${name}`, check_name: name, check_class: 'advisory',
      status: 'active', granted_by: 'mallory',
      expires_at: new Date(Date.now() + 3600_000).toISOString(), ...FULL_CITATION,
    });
  }
  const reg = new WaiverRegistry({ store, ledger, requireCitations: true });
  for (const name of HARD_INVARIANT_CHECKS) {
    assert.equal(isWaivable({ name, class: 'advisory' }), false, `${name} stays unwaivable`);
    const r = await reg.tryWaive({ name, class: 'advisory' }, 'mallory');
    assert.equal(r.waived, false, `${name} must never be waived, citations or not`);
  }
  assert.equal((await ledger.list()).filter((e) => e.action === 'waiver.use').length, 0,
    'no waiver.use row was written for any hard invariant');
});

// (C5) The fail-closed FLOOR holds even in the legacy non-strict default: a waiver
// that declares SOME governed citation but omits one is rejected (no silent
// half-governed waiver), while a bare reason-only legacy waiver is still honoured.
test('gap125: non-strict floor rejects a half-cited waiver but honours a bare reason-only one', async () => {
  const { store, ledger } = kit();
  await store.saveWaiver({
    id: 'wv-half', check_name: 'readiness-score', check_class: 'advisory',
    status: 'active', granted_by: 'x',
    reason: 'r', compensating_control: 'cc', // declares governance but omits two fields
  });
  await store.saveWaiver({
    id: 'wv-bare', check_name: 'docs-present', check_class: 'advisory',
    status: 'active', granted_by: 'y', reason: 'legacy reason-only waiver',
  });
  const reg = new WaiverRegistry({ store, ledger }); // default (non-strict)

  // half-cited -> rejected (fail-closed floor), missing the two absent fields.
  assert.match(citationDefect({ reason: 'r', compensating_control: 'cc' }, false), /residualRisk/);
  const half = await reg.tryWaive({ name: 'readiness-score', class: 'advisory' }, 'z');
  assert.equal(half.waived, false, 'a half-governed waiver is never applied');

  // bare reason-only -> still honoured in the legacy non-strict seam, with a
  // ledger row whose governed citation fields are null (not fabricated).
  const bare = await reg.tryWaive({ name: 'docs-present', class: 'advisory' }, 'z');
  assert.equal(bare.waived, true, 'the legacy reason-only waiver is honoured non-strict');
  assert.equal(bare.ledger.meta.reason, 'legacy reason-only waiver');
  assert.equal(bare.ledger.meta.residualRisk, null);
  assert.equal(bare.ledger.meta.compensatingControl, null);
  assert.equal(bare.ledger.meta.remediationPlan, null);
  assert.deepEqual(missingCitations({ reason: 'legacy reason-only waiver' }).sort(),
    ['compensatingControl', 'remediationPlan', 'residualRisk']);
});
