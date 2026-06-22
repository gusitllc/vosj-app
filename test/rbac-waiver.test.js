// test/rbac-waiver.test.js — the two ADDITIVE design-question closures:
//   (1) the config-driven RBAC capability registry (src/api/rbac.js + auth.js);
//   (2) advisory-only waiver enforcement (src/engine/waiver.js).
// Asserts BOTH the new behaviour AND the hard guardrail that a waiver can NEVER
// bypass a hard invariant. In-memory, no network.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildRegistry } = require('../src/api/rbac');
const { holdsCapability } = require('../src/api/auth');
const { WaiverRegistry, evaluateChecks, isWaivable, HARD_INVARIANT_CHECKS } =
  require('../src/engine/waiver');
const { Ledger } = require('../src/ledger/ledger');
const { MemoryStateStore } = require('../src/db/statestore');

const KEY = 'rbac-waiver-test-key';

function ledgerKit() {
  const store = new MemoryStateStore();
  const config = Object.freeze({ LEDGER_HMAC_KEY: KEY, version: 'test' });
  return { store, ledger: new Ledger({ store, config }) };
}

// ---- (1) RBAC capability registry ------------------------------------------
test('RBAC: an unconfigured registry preserves Set-only behaviour (no breakage)', () => {
  const reg = buildRegistry(null);
  assert.equal(reg.configured, false);
  const p = { role: 'director', capabilities: new Set(['migration:gate:sign']) };
  // Set holds it -> allowed; not in Set + no config -> denied (today's behaviour).
  assert.equal(holdsCapability(p, 'migration:gate:sign', reg), true);
  assert.equal(holdsCapability(p, 'migration:reconcile:run', reg), false);
});

test('RBAC: a configured registry GRANTS by role (additive, never removes)', () => {
  const reg = buildRegistry('{"dba":["migration:reconcile:run"]}');
  assert.equal(reg.configured, true);
  const dba = { role: 'dba', capabilities: new Set() };
  // Granted via role even though the Set is empty.
  assert.equal(holdsCapability(dba, 'migration:reconcile:run', reg), true);
  // A capability NOT mapped is still denied.
  assert.equal(holdsCapability(dba, 'migration:gate:sign', reg), false);
  // A capability the Set already had is still allowed (registry never removes).
  const keep = { role: 'dba', capabilities: new Set(['migration:wave:write']) };
  assert.equal(holdsCapability(keep, 'migration:wave:write', reg), true);
});

test('RBAC: malformed config fails closed to unconfigured (no silent grant)', () => {
  const reg = buildRegistry('{not valid json');
  assert.equal(reg.configured, false);
  const p = { role: 'admin', capabilities: new Set() };
  assert.equal(holdsCapability(p, 'migration:gate:sign', reg), false);
});

// ---- (2) Waiver enforcement: advisory only ---------------------------------
test('Waiver: an active advisory waiver flips a failed advisory check to passing', async () => {
  const { store, ledger } = ledgerKit();
  await store.saveWaiver({
    id: 'wv-1', gate_id: 'g-go-no-go', reason: 'compensating control documented',
    granted_by: 'sam-infosec', check_name: 'scorecard-coverage',
    check_class: 'advisory', status: 'active',
  });
  const reg = new WaiverRegistry({ store, ledger });
  const r = await reg.tryWaive(
    { name: 'scorecard-coverage', class: 'advisory', gateId: 'g-go-no-go' }, 'carol');
  assert.equal(r.waived, true);
  assert.equal(r.waiver.id, 'wv-1');
  assert.ok(r.ledger && r.ledger.hash, 'waiver use is recorded on the ledger');
  assert.equal(r.ledger.action, 'waiver.use');
});

test('Waiver: no active waiver => not waived (fail-closed)', async () => {
  const { store, ledger } = ledgerKit();
  const reg = new WaiverRegistry({ store, ledger });
  const r = await reg.tryWaive({ name: 'scorecard-coverage', class: 'advisory' }, 'carol');
  assert.equal(r.waived, false);
});

test('Waiver: an expired waiver is not active', async () => {
  const { store, ledger } = ledgerKit();
  const past = new Date(Date.now() - 60 * 1000).toISOString();
  await store.saveWaiver({
    id: 'wv-exp', reason: 'temporary', granted_by: 'x',
    check_name: 'readiness-score', check_class: 'advisory',
    status: 'active', expires_at: past,
  });
  const reg = new WaiverRegistry({ store, ledger });
  const r = await reg.tryWaive({ name: 'readiness-score', class: 'advisory' }, 'y');
  assert.equal(r.waived, false);
});

// ---- HARD GUARDRAIL: hard invariants are structurally unwaivable -----------
test('Guardrail: a non-advisory check is never waivable', () => {
  assert.equal(isWaivable({ name: 'scorecard-coverage', class: 'advisory' }), true);
  assert.equal(isWaivable({ name: 'scorecard-coverage', class: 'hard' }), false);
  assert.equal(isWaivable({ name: 'scorecard-coverage' }), false); // no class => deny
});

test('Guardrail: every hard-invariant check name is refused even if classed advisory', async () => {
  const { store, ledger } = ledgerKit();
  // Plant a malicious "advisory" waiver row for each hard invariant.
  for (const name of HARD_INVARIANT_CHECKS) {
    await store.saveWaiver({
      id: `evil-${name}`, reason: 'attack', granted_by: 'mallory',
      check_name: name, check_class: 'advisory', status: 'active',
    });
  }
  const reg = new WaiverRegistry({ store, ledger });
  for (const name of HARD_INVARIANT_CHECKS) {
    assert.equal(isWaivable({ name, class: 'advisory' }), false, `${name} must be unwaivable`);
    const r = await reg.tryWaive({ name, class: 'advisory' }, 'mallory');
    assert.equal(r.waived, false, `${name} must never be waived`);
  }
  // None of the refusals wrote a 'waiver.use' row.
  const chain = await ledger.list();
  assert.equal(chain.filter((e) => e.action === 'waiver.use').length, 0);
});

test('Guardrail: findActive does not even query the store for a hard invariant', async () => {
  let queried = false;
  const store = { async listWaivers() { queried = true; return []; } };
  const reg = new WaiverRegistry({ store, ledger: { append: async () => ({}) } });
  const r = await reg.findActive({ name: 'baseline-drift', class: 'advisory' });
  assert.equal(r, null);
  assert.equal(queried, false, 'no store lookup for a structurally-unwaivable check');
});

// ---- evaluateChecks: passing checks unchanged, failed advisory may be waived
test('evaluateChecks: passes a failed advisory check only when a waiver is active', async () => {
  const { store, ledger } = ledgerKit();
  await store.saveWaiver({
    id: 'wv-cov', reason: 'documented', granted_by: 'lead',
    check_name: 'coverage', check_class: 'advisory', status: 'active',
  });
  const reg = new WaiverRegistry({ store, ledger });
  const checks = [
    { name: 'docs-present', class: 'advisory', ok: true },   // passing -> unchanged
    { name: 'coverage', class: 'advisory', ok: false },      // failing -> waived
    { name: 'readiness', class: 'advisory', ok: false },     // failing, no waiver
  ];
  const out = await evaluateChecks(checks, reg, 'carol');
  assert.equal(out.ok, false, 'one un-waived advisory failure remains');
  const byName = Object.fromEntries(out.results.map((r) => [r.name, r]));
  assert.equal(byName['docs-present'].ok, true);
  assert.equal(byName['docs-present'].waived, false);
  assert.equal(byName.coverage.ok, true);
  assert.equal(byName.coverage.waived, true);
  assert.equal(byName.readiness.ok, false);
});
