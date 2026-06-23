// test/evidence-export.test.js — exportable governance evidence package
// (PKG-EVIDENCE-PACKAGE, gaps 128/123/122). Proves the curated, control-mapped,
// offline-verifiable bundle assembled from EXISTING data sources:
//   - the package contains all SIX sections (gap 128)
//   - the embedded verifyChain proof reports ok over the bundled rows (gap 122)
//   - the control-map manifest cross-references each VOSJ invariant to every
//     external framework (ISO 38500 / COBIT / ITIL / IIA / SOC2-SOX) (gap 123)
//   - auditability is a first-class output: who/what/when/source->target (gap 122)
//   - tampering a ledger row makes the EMBEDDED verify proof fail (offline detection)
//   - the manifest is DETERMINISTIC (stable contentHash across re-export)
//   - the route requires the NEW capability migration:evidence:read
//   - MATERIAL DEFECT carried through: a high-risk disposition is forced to
//     Strangler-Fig AND the planning gate/Jump is BLOCKED when the disposition's
//     CI/CD-365 precondition is violated — and the BLOCK leaves NO signed gate row
//     for the package to certify (a blocked Jump produces no evidence).
//
// In-memory, no network. Uses the same fail-closed ledger key convention as helpers.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildTestCtx, freshBaseline } = require('./helpers');
const {
  buildEvidenceExport, CONTROL_MAP, CONTROL_FRAMEWORKS,
} = require('../src/engine/evidence-export');
const { StateMachine } = require('../src/engine/state-machine');
const { HumanGateSigner } = require('../src/engine/gate');
const { CE_CAPABILITIES, requireCapability } = require('../src/api/auth');
const { DemoConnector } = require('../src/connectors/demo');

const DIRECTOR = { id: 'dir-1', kind: 'human', role: 'director' };
const DBA = { id: 'dba-1', kind: 'human', role: 'dba' };

// Seed a wave that has produced REAL governance evidence: a kickoff gate sign and a
// cutover-with-proof, so the package has signed rows + a reconciliation proof.
async function seedWaveWithEvidence(ctx) {
  const caf = ctx.engine.getTemplate('caf');
  await ctx.store.saveWave({
    id: 'w1', name: 'Wave One', state: 'P2',
    framework_template_id: 'caf', framework_version: caf.version, plan: {},
  });
  // an in-scope workload carrying a disposition (so a kickoff gate could pass)
  await ctx.store.saveWorkload({
    id: 'u1', name: 'App One', disposition: 'Rehost', wave_id: 'w1',
    state: 'reconciled', baseline_at: freshBaseline(), attributes: {},
  });

  // produce a reconciliation proof + a cutover sign (verified-before-Jump) so the
  // ledger carries a proof: evidence hash bound to a gate.
  const signer = new HumanGateSigner({ ledger: ctx.ledger, store: ctx.store });
  const sm = new StateMachine(caf, { signer, store: ctx.store });
  const unit = { id: 'u1', state: 'reconciled', migrationId: 'w1', baselineAt: freshBaseline(),
    rowCount: 1000 };
  const connector = new DemoConnector();
  await connector.replicate(unit, {}); // so verify() passes all pre-switch categories
  const recon = await ctx.engine.reconcile(unit, connector, {});
  await sm.cutoverUnit({ unit, actor: 'eng-a', signer: DBA, proof: recon.proof, evidence: ['ev:smoke-ok'] });

  // an advisory waiver in the register (the second-line control surface)
  await ctx.store.saveWaiver({
    id: 'wv-1', gate_id: 'g-go-no-go', check_name: 'scorecard-coverage',
    check_class: 'advisory', status: 'active', granted_by: 'lead',
    reason: 'compensating control in CR-1', scope: null,
  });
  return { recon };
}

// ---------------------------------------------------------------------------
// the package contains all six sections (gap 128)
// ---------------------------------------------------------------------------
test('evidence package contains all six sections (gap 128)', async () => {
  const ctx = await buildTestCtx();
  await seedWaveWithEvidence(ctx);
  const exporter = buildEvidenceExport({ ledger: ctx.ledger, store: ctx.store });
  const { package: pkg } = await exporter.buildPackage('w1');

  const s = pkg.sections;
  assert.ok(s.ledger, 'section 1: signed ledger');
  assert.ok(s.ledgerProof, 'section 2: integrity proof');
  assert.ok(Array.isArray(s.waivers), 'section 3: waiver register');
  assert.ok(Array.isArray(s.reconciliation), 'section 4: reconciliation proofs');
  assert.ok(s.toolLog, 'section 5: tool/order audit');
  assert.ok(s.framework, 'section 6: pinned framework binding');

  // the framework binding is the wave's PINNED template + version
  assert.equal(s.framework.templateId, 'caf');
  assert.equal(s.framework.version, '1');
  // the waiver register surfaces the active advisory waiver
  assert.equal(s.waivers.length, 1);
  assert.equal(s.waivers[0].id, 'wv-1');
  assert.equal(s.waivers[0].checkClass, 'advisory');
  // a reconciliation proof was reconstructed from the cutover ledger row
  assert.ok(s.reconciliation.length >= 1, 'at least one reconciliation proof present');
  assert.ok(s.reconciliation[0].proofHashes.some((h) => h.startsWith('proof:')));
  assert.equal(s.reconciliation[0].migrationId, 'w1');
});

// ---------------------------------------------------------------------------
// embedded verifyChain proof reports ok (gap 122 — offline re-verification)
// ---------------------------------------------------------------------------
test('embedded verifyChain proof reports ok over the bundled rows (gap 122)', async () => {
  const ctx = await buildTestCtx();
  await seedWaveWithEvidence(ctx);
  const exporter = buildEvidenceExport({ ledger: ctx.ledger, store: ctx.store });
  const { package: pkg } = await exporter.buildPackage('w1');

  assert.equal(pkg.sections.ledgerProof.ok, true, 'the embedded integrity proof verifies');
  assert.equal(pkg.sections.ledgerProof.brokenAt, null);
  assert.equal(pkg.sections.ledgerProof.rowCount, pkg.sections.ledger.full.length);
});

// ---------------------------------------------------------------------------
// control-map manifest cross-references each invariant to every framework (gap 123)
// ---------------------------------------------------------------------------
test('control-map manifest cross-references each invariant to every framework (gap 123)', async () => {
  const ctx = await buildTestCtx();
  await seedWaveWithEvidence(ctx);
  const exporter = buildEvidenceExport({ ledger: ctx.ledger, store: ctx.store });
  const { package: pkg } = await exporter.buildPackage('w1');

  assert.ok(Array.isArray(pkg.controlMap) && pkg.controlMap.length >= 6,
    'control map covers the core invariants');
  // every mapped control names ALL five frameworks (the cross-reference is DATA)
  for (const c of pkg.controlMap) {
    assert.ok(c.vosjControl && typeof c.vosjControl === 'string');
    assert.ok(typeof c.invariant === 'number');
    assert.ok(c.source, 'each control names the enforcing module');
    for (const fw of CONTROL_FRAMEWORKS) {
      assert.ok(typeof c[fw] === 'string' && c[fw].length > 0,
        `control ${c.vosjControl} must map framework ${fw}`);
    }
    // each control is annotated whether it produced evidence in THIS wave
    assert.ok(typeof c.evidencedInThisWave === 'boolean');
  }
  // the six hard invariants 1..6 are all present in the static map
  const invariants = new Set(CONTROL_MAP.map((c) => c.invariant));
  for (const n of [1, 2, 3, 4, 5, 6]) assert.ok(invariants.has(n), `invariant ${n} mapped`);
  // verified-before-cutover MUST show evidenced (we signed a cutover with a proof)
  const vbc = pkg.controlMap.find((c) => c.vosjControl === 'verified-before-cutover');
  assert.equal(vbc.evidencedInThisWave, true, 'a cutover proof was exercised in this wave');
});

// ---------------------------------------------------------------------------
// auditability is a first-class output (gap 122): who/what/when/source->target
// ---------------------------------------------------------------------------
test('audit trail surfaces who/what/when/source->target as a first-class output (gap 122)', async () => {
  const ctx = await buildTestCtx();
  await seedWaveWithEvidence(ctx);
  const exporter = buildEvidenceExport({ ledger: ctx.ledger, store: ctx.store });
  const { package: pkg } = await exporter.buildPackage('w1');

  assert.ok(Array.isArray(pkg.auditTrail) && pkg.auditTrail.length >= 1);
  const cutoverEntry = pkg.auditTrail.find((e) => e.what === 'gate.sign.cutover');
  assert.ok(cutoverEntry, 'the cutover sign appears in the audit trail');
  assert.equal(cutoverEntry.who, 'eng-a', 'who = actor');
  assert.equal(cutoverEntry.role, 'dba', 'role = signer role');
  assert.ok(cutoverEntry.when, 'when = timestamp');
  assert.equal(cutoverEntry.target, 'migrated', 'source->target captured');
  assert.ok(cutoverEntry.hash, 'each entry references its ledger hash');
});

// ---------------------------------------------------------------------------
// tampering a ledger row makes the EMBEDDED verify fail (offline detection)
// ---------------------------------------------------------------------------
test('tampering a ledger row makes the embedded verify proof fail', async () => {
  const ctx = await buildTestCtx();
  await seedWaveWithEvidence(ctx);

  // forge a stored ledger row AFTER it was signed (back-date the actor).
  const rows = await ctx.store.listLedger();
  assert.ok(rows.length >= 1);
  rows[rows.length - 1].actor = 'forged-actor';

  const exporter = buildEvidenceExport({ ledger: ctx.ledger, store: ctx.store });
  const { package: pkg } = await exporter.buildPackage('w1');

  assert.equal(pkg.sections.ledgerProof.ok, false, 'the embedded proof detects the forgery');
  assert.equal(pkg.sections.ledgerProof.brokenAt, rows[rows.length - 1].seq);
});

// ---------------------------------------------------------------------------
// the manifest is deterministic (stable contentHash for identical state)
// ---------------------------------------------------------------------------
test('the package contentHash is deterministic across re-export of identical state', async () => {
  const ctx = await buildTestCtx();
  await seedWaveWithEvidence(ctx);
  const exporter = buildEvidenceExport({ ledger: ctx.ledger, store: ctx.store });
  const a = await exporter.buildPackage('w1');
  const b = await exporter.buildPackage('w1');
  assert.equal(a.package.contentHash, b.package.contentHash,
    'two exports of identical state share a stable digest');
  assert.equal(a.package.contentHash.length, 64, 'sha256 hex digest');
});

// ---------------------------------------------------------------------------
// fail-closed: a missing wave / missing ledger key
// ---------------------------------------------------------------------------
test('buildPackage fails closed for an unknown wave and an empty waveId', async () => {
  const ctx = await buildTestCtx();
  const exporter = buildEvidenceExport({ ledger: ctx.ledger, store: ctx.store });
  await assert.rejects(() => exporter.buildPackage('nope'), /wave not found/);
  await assert.rejects(() => exporter.buildPackage(''), /requires a waveId/);
});

test('buildPackage fails closed when the ledger has no HMAC key (cannot certify)', async () => {
  // a ctx whose ledger has no signing key -> verifyChain throws (never a default key).
  const ctx = await buildTestCtx({ LEDGER_HMAC_KEY: '' });
  await ctx.store.saveWave({ id: 'w0', name: 'Keyless', state: 'P1' });
  const exporter = buildEvidenceExport({ ledger: ctx.ledger, store: ctx.store });
  await assert.rejects(() => exporter.buildPackage('w0'), /fail-closed|HMAC/);
});

// ---------------------------------------------------------------------------
// tool/order audit substrate: absence is RECORDED, never fabricated
// ---------------------------------------------------------------------------
test('tool/order audit records absence when the store exposes no listing (no fabrication)', async () => {
  const ctx = await buildTestCtx();
  await seedWaveWithEvidence(ctx);
  const exporter = buildEvidenceExport({ ledger: ctx.ledger, store: ctx.store });
  const { package: pkg } = await exporter.buildPackage('w1');
  // the memory store does NOT expose listToolLog/listOrders -> available:false + a note.
  assert.equal(pkg.sections.toolLog.available, false);
  assert.deepEqual(pkg.sections.toolLog.toolLog, []);
  assert.deepEqual(pkg.sections.toolLog.orders, []);
  assert.ok(/append-only|not exposed/.test(pkg.sections.toolLog.note));
});

test('tool/order audit surfaces rows when the store DOES expose a listing', async () => {
  const ctx = await buildTestCtx();
  await seedWaveWithEvidence(ctx);
  // augment the store instance with optional listings (forward-compatible read path).
  ctx.store.listToolLog = async () => [{ tool: 'classify_workload', actor: 'planner-x' }];
  ctx.store.listOrders = async () => [{ id: 'ord_1', kind: 'reconcile', status: 'done' }];
  const exporter = buildEvidenceExport({ ledger: ctx.ledger, store: ctx.store });
  const { package: pkg } = await exporter.buildPackage('w1');
  assert.equal(pkg.sections.toolLog.available, true);
  assert.equal(pkg.sections.toolLog.toolLog[0].tool, 'classify_workload');
  assert.equal(pkg.sections.toolLog.orders[0].id, 'ord_1');
});

// ---------------------------------------------------------------------------
// the NEW capability migration:evidence:read gates the route
// ---------------------------------------------------------------------------
test('migration:evidence:read is a declared CE capability', () => {
  assert.ok(CE_CAPABILITIES.includes('migration:evidence:read'),
    'the new evidence-read capability is declared');
});

test('requireCapability blocks a principal lacking migration:evidence:read', () => {
  const mw = requireCapability('migration:evidence:read');
  let status = 0; let payload = null;
  const res = { status(c) { status = c; return this; }, json(b) { payload = b; return this; } };
  mw({ principal: { capabilities: new Set(['migration:workload:write']) } }, res, () => {
    throw new Error('next() must NOT be called for a missing capability');
  });
  assert.equal(status, 403);
  assert.equal(payload.ok, false);
  // a principal WITH the capability passes through
  let passed = false;
  mw({ principal: { capabilities: new Set(['migration:evidence:read']) } },
    { status() { return this; }, json() { return this; } }, () => { passed = true; });
  assert.equal(passed, true);
});

test('the evidence route module mounts and binds requireAuth + the new capability', () => {
  const evidence = require('../src/api/evidence-routes');
  assert.equal(typeof evidence.mount, 'function');
  // mount registers exactly the one GET route under /api/waves/:id/evidence-package,
  // gated by an auth middleware then the capability middleware.
  const registered = [];
  const fakeApp = {
    get(path, ...mws) { registered.push({ method: 'get', path, mws }); },
  };
  evidence.mount(fakeApp, { ledger: { /* present */ }, store: { /* present */ }, config: {}, log() {} });
  assert.equal(registered.length, 1);
  assert.equal(registered[0].path, '/api/waves/:id/evidence-package');
  // auth middleware + capability middleware + handler = 3 in the chain.
  assert.ok(registered[0].mws.length >= 3, 'auth + capability + handler are bound');
});

// ===========================================================================
// MATERIAL DEFECT (carried through PKG-EVIDENCE): a high-risk disposition is forced
// to Strangler-Fig AND a gate/Jump is BLOCKED when the disposition rule (CI/CD-365
// precondition) is violated. Critically, the BLOCK leaves NO signed gate row — so a
// blocked Jump produces NO evidence the package could certify (fail-closed end-to-end).
// ===========================================================================
test('material defect: high-risk forces Strangler-Fig AND a CI/CD-365 violation BLOCKS the Jump (no evidence produced)', async () => {
  const ctx = await buildTestCtx();
  const caf = ctx.engine.getTemplate('caf');
  // rename the kickoff/planning gates to the engine's rule ids so the planning gate
  // is the disposition-bearing Jump toward execution.
  const compiled = JSON.parse(JSON.stringify(caf));
  // find a P2->P3 and P3->P4 transition gate and key them onto the rule map.
  compiled.phases[1].gate.id = 'g-kickoff-complete';
  compiled.phases[2].gate.id = 'g-planning-signoff';

  const signer = new HumanGateSigner({ ledger: ctx.ledger, store: ctx.store });
  const sm = new StateMachine(compiled, { signer, store: ctx.store });

  await ctx.store.saveWave({
    id: 'wm', name: 'High Risk', state: 'P3',
    framework_template_id: 'caf', framework_version: caf.version, plan: {},
  });
  // a high-risk Refactor workload WITHOUT cicd365Ready -> the planning Jump is BLOCKED.
  await ctx.store.saveWorkload({ id: 'wm1', name: 'Rearch', disposition: 'Refactor',
    wave_id: 'wm', attributes: {} });

  const ledgerBefore = (await ctx.ledger.list()).length;
  await assert.rejects(
    () => sm.signTransition({ run: { id: 'wm', state: 'P3' }, to: 'P4', actor: 'a', signer: DIRECTOR }),
    /machine-checkable criteria not satisfied/,
    'a CI/CD-365 disposition violation BLOCKS the gate (no Jump kicked off)'
  );
  // the blocked Jump produced NO signed ledger row -> the evidence package certifies
  // nothing for that gate (fail-closed: no fake evidence).
  const ledgerAfter = (await ctx.ledger.list()).length;
  assert.equal(ledgerAfter, ledgerBefore, 'a blocked Jump writes no signed gate row');

  const exporter = buildEvidenceExport({ ledger: ctx.ledger, store: ctx.store });
  const { package: pkg } = await exporter.buildPackage('wm');
  assert.equal(pkg.sections.reconciliation.length, 0, 'no reconciliation proof for a blocked Jump');
  assert.equal(pkg.auditTrail.filter((e) => e.gateId === 'g-planning-signoff').length, 0,
    'no audit entry certifies the blocked gate');

  // with the precondition met, the gate clears AND the bound runbook is the MANDATORY
  // Strangler-Fig one (big-bang structurally unavailable for high risk).
  await ctx.store.saveWorkload({ id: 'wm1', name: 'Rearch', disposition: 'Refactor',
    wave_id: 'wm', attributes: { cicd365Ready: true } });
  const run = { id: 'wm', state: 'P3' };
  const r = await sm.signTransition({ run, to: 'P4', actor: 'a', signer: DIRECTOR });
  assert.equal(r.state, 'P4');
  assert.equal(run.plan.executorBindings.wm1.cutoverStyle, 'strangler-fig');
  assert.equal(run.plan.executorBindings.wm1.runbookTemplate, 'refactor-strangler');
});
