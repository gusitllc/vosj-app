// test/disposition.test.js — the 7-R disposition engine (§7).
// Asserts the STRUCTURAL guarantee: high-risk reshapes (Refactor, Replatform,
// Relocate) resolve only to incremental Strangler-Fig runbooks, so a big-bang
// plan is physically unavailable — risk control by compilation, not review.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const disposition = require('../src/engine/disposition');
const { buildTestCtx } = require('./helpers');

test('exposes exactly the seven R dispositions', () => {
  assert.equal(disposition.ALL.length, 7);
  const expected = ['Retain', 'Retire', 'Rehost', 'Relocate', 'Replatform', 'Refactor', 'Repurchase'];
  for (const r of expected) assert.ok(disposition.ALL.includes(r), `missing disposition ${r}`);
});

test('Refactor is forced onto Strangler-Fig; big-bang is unavailable', () => {
  const c = disposition.classify({ disposition: 'Refactor' });
  assert.equal(c.disposition, 'Refactor');
  assert.equal(c.strangler, true);
  assert.equal(c.bigBangAvailable, false);
  assert.equal(c.contract.cutoverStyle, disposition.CUTOVER.STRANGLER_FIG);
  assert.equal(c.contract.highRisk, true);
});

test('Replatform and Relocate are also high-risk Strangler-Fig (no big-bang)', () => {
  for (const r of ['Replatform', 'Relocate']) {
    const c = disposition.classify({ disposition: r });
    assert.equal(c.strangler, true, `${r} should be strangler-fig`);
    assert.equal(c.bigBangAvailable, false, `${r} must not allow big-bang`);
    assert.equal(c.contract.highRisk, true, `${r} should be high-risk`);
  }
});

test('Rehost / Repurchase keep a big-bang style (low-risk)', () => {
  for (const r of ['Rehost', 'Repurchase']) {
    const c = disposition.classify({ disposition: r });
    assert.equal(c.bigBangAvailable, true, `${r} should allow big-bang`);
    assert.equal(c.contract.highRisk, false);
  }
});

test('Retire / Retain are non-migrating (no cutover)', () => {
  for (const r of ['Retire', 'Retain']) {
    const c = disposition.classify({ disposition: r });
    assert.equal(c.contract.cutoverStyle, disposition.CUTOVER.NONE);
    assert.equal(c.strangler, false);
    assert.equal(c.bigBangAvailable, false);
  }
});

test('heuristic never yields a big-bang plan for a cloud-native rewrite', () => {
  const c = disposition.classify({ cloudNativeRewrite: true }); // -> Refactor
  assert.equal(c.disposition, 'Refactor');
  assert.equal(c.bigBangAvailable, false);
});

test('an unknown disposition falls back to the conservative heuristic (Rehost)', () => {
  const c = disposition.classify({ disposition: 'NotAReal-R' });
  assert.equal(c.disposition, 'Rehost');
});

test('contractFor throws on an unknown disposition (fail loud)', () => {
  assert.throws(() => disposition.contractFor('Nope'), /unknown disposition/);
});

test('Replatform/Refactor carry the CI/CD delivery-system precondition (§7.1)', () => {
  for (const r of ['Replatform', 'Refactor']) {
    const c = disposition.contractFor(r);
    assert.equal(c.deliverySystemPrecondition, true, `${r} should require delivery-system readiness`);
  }
});

test('engine facade exposes the same disposition surface', async () => {
  const ctx = await buildTestCtx();
  assert.equal(ctx.engine.dispositions.length, 7);
  const c = ctx.engine.classify({ disposition: 'Refactor' });
  assert.equal(c.bigBangAvailable, false);
});
