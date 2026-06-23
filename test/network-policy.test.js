// test/network-policy.test.js — default-deny egress NetworkPolicy (PKG-DEFAULT-DENY-EGRESS,
// gap 159, whitepaper §15.8 / CIS Kubernetes Benchmark 5.3.2).
//
// Proves the chart codifies a zero-trust egress posture:
//   - the chart ships exactly one Egress-only NetworkPolicy bound to the engine
//     pod's selectorLabels (default-deny: selected pods may egress ONLY to the
//     allow-list; the absence of a catch-all rule IS the deny);
//   - the allow-list is values-driven and fail-closed — empty model/source-control
//     target lists render NO egress for them (deny), DNS is the only default rule;
//   - networkPolicy.enabled=false renders no policy at all (explicit opt-out);
//   - a populated allow-list renders PG (port from config), model, and
//     source-control egress rules.
//
// When `helm` is on PATH the test renders the real chart and asserts on the
// emitted YAML. When it is not, the test falls back to a structural assertion on
// the template + values source (no external dependency) so it ALWAYS proves
// something. The structural checks run unconditionally.
//
// It ALSO re-proves the MATERIAL DEFECT this repo guards (independent of helm):
// a high-risk disposition is forced to Strangler-Fig AND a gate/Jump is BLOCKED
// when the disposition rule is violated.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const disposition = require('../src/engine/disposition');
const { StateMachine } = require('../src/engine/state-machine');
const { HumanGateSigner } = require('../src/engine/gate');
const { buildTestCtx, CAF_TEMPLATE } = require('./helpers');
const template = require('../src/engine/template');

const CHART_DIR = path.join(__dirname, '..', 'deploy', 'helm', 'vosj');
const NP_TEMPLATE = path.join(CHART_DIR, 'templates', 'networkpolicy.yaml');
const VALUES = path.join(CHART_DIR, 'values.yaml');

function readFile(p) { return fs.readFileSync(p, 'utf8'); }

// Locate a helm binary (PATH, or the known Windows install in this env).
function findHelm() {
  for (const cmd of ['helm', 'C:/Users/gus/.azure-kubectl/helm']) {
    const r = spawnSync(cmd, ['version', '--short'], { encoding: 'utf8' });
    if (r.status === 0) return cmd;
  }
  return null;
}

// helm template the NetworkPolicy only, with optional --set overrides.
// Returns the rendered string ('' when the object renders empty / not present).
function renderPolicy(helm, sets = []) {
  const args = ['template', 't', CHART_DIR, '--show-only', 'templates/networkpolicy.yaml'];
  for (const s of sets) args.push('--set', s);
  const r = spawnSync(helm, args, { encoding: 'utf8' });
  // `--show-only` errors (status != 0) when the template renders nothing — that
  // is the "disabled => no object" case, which we treat as an empty render.
  if (r.status !== 0) return '';
  return r.stdout || '';
}

// ---------------------------------------------------------------------------
// Structural assertions (no external dependency — always run).
// ---------------------------------------------------------------------------

test('NetworkPolicy template exists and is default-deny EGRESS bound to the engine selector', () => {
  const tpl = readFile(NP_TEMPLATE);
  assert.match(tpl, /kind:\s*NetworkPolicy/, 'declares a NetworkPolicy');
  // Egress is the (only) declared policy type — selection => deny-all-egress-but-allow-list.
  assert.match(tpl, /policyTypes:\s*\n\s*-\s*Egress/, 'policyTypes is [Egress]');
  // Bound to the chart's selectorLabels (the same immutable selector the Deployment uses).
  assert.match(tpl, /podSelector:\s*\n\s*matchLabels:\s*\n\s*\{\{-?\s*include "vosj\.selectorLabels"/,
    'podSelector uses vosj.selectorLabels');
  // Gated behind the values flag (secure-by-default; explicit opt-out).
  assert.match(tpl, /\{\{-?\s*if \.Values\.networkPolicy\.enabled\s*\}\}/, 'gated by networkPolicy.enabled');
  // The four allow-list dimensions are present.
  for (const dim of ['dns', 'postgres', 'model', 'sourceControl']) {
    assert.match(tpl, new RegExp(`\\$egress\\.${dim}`), `references egress.${dim}`);
  }
  // CIS framing is documented in-template.
  assert.match(tpl, /CIS Kubernetes Benchmark/, 'documents CIS framing');
});

test('values.yaml ships a networkPolicy stanza, enabled by default, fail-closed allow-lists', () => {
  const v = readFile(VALUES);
  assert.match(v, /networkPolicy:/, 'has a networkPolicy stanza');
  assert.match(v, /enabled:\s*true/, 'enabled true by default (secure-by-default)');
  // Model + source-control target lists default to EMPTY (fail-closed: no egress).
  assert.match(v, /model:\s*\n\s*enabled:\s*true\s*\n(?:\s*#.*\n)*\s*targets:\s*\[\]/,
    'model.targets defaults to [] (deny)');
  assert.match(v, /sourceControl:\s*\n\s*enabled:\s*true\s*\n(?:\s*#.*\n)*\s*targets:\s*\[\]/,
    'sourceControl.targets defaults to [] (deny)');
});

// ---------------------------------------------------------------------------
// Rendered-YAML assertions (run only when helm is available).
// ---------------------------------------------------------------------------

const helm = findHelm();

test('helm renders a single default-deny egress policy: DNS only by default, fail-closed', { skip: !helm && 'helm not on PATH' }, () => {
  const out = renderPolicy(helm);
  assert.match(out, /kind: NetworkPolicy/, 'a policy is rendered when enabled (default)');
  assert.match(out, /name: t-vosj-egress/, 'named <fullname>-egress');
  assert.match(out, /policyTypes:\s*\n\s*-\s*Egress/, 'Egress-only');
  // DNS rule present (kube-dns, 53/UDP + 53/TCP).
  assert.match(out, /k8s-app: kube-dns/, 'DNS rule targets kube-dns');
  assert.match(out, /port: 53/, 'DNS allows port 53');
  // Fail-closed: with empty model/source-control targets and no PG CIDR, there
  // are NO ipBlock rules — only the DNS rule exists.
  assert.ok(!/ipBlock/.test(out), 'no ipBlock egress when allow-lists are empty (default-deny)');
});

test('helm: networkPolicy.enabled=false renders no policy object at all', { skip: !helm && 'helm not on PATH' }, () => {
  const out = renderPolicy(helm, ['networkPolicy.enabled=false']);
  assert.ok(!/kind: NetworkPolicy/.test(out), 'no NetworkPolicy when disabled');
});

test('helm: a populated allow-list renders PG (port from config), model, and source-control egress', { skip: !helm && 'helm not on PATH' }, () => {
  const out = renderPolicy(helm, [
    'networkPolicy.egress.postgres.cidr=10.0.0.0/16',
    'config.postgres.port=5432',
    'networkPolicy.egress.model.targets[0].cidr=20.1.0.0/16',
    'networkPolicy.egress.model.targets[0].port=443',
    'networkPolicy.egress.sourceControl.targets[0].cidr=140.82.112.0/20',
    'networkPolicy.egress.sourceControl.targets[0].port=443',
  ]);
  // PG rule: CIDR + port pulled from config.postgres.port.
  assert.match(out, /cidr: "10\.0\.0\.0\/16"/, 'PG CIDR rendered');
  assert.match(out, /port: 5432/, 'PG port taken from config.postgres.port');
  // Model + source-control allow-list rules.
  assert.match(out, /cidr: "20\.1\.0\.0\/16"/, 'model CIDR rendered');
  assert.match(out, /cidr: "140\.82\.112\.0\/20"/, 'source-control CIDR rendered');
  // Still Egress-only and DNS still present (DNS + 3 ipBlock rules = 4 egress entries).
  const ipBlocks = (out.match(/ipBlock:/g) || []).length;
  assert.equal(ipBlocks, 3, 'exactly PG + model + source-control ipBlock rules');
});

// ---------------------------------------------------------------------------
// MATERIAL DEFECT (re-proven here, independent of helm): a high-risk disposition
// is FORCED onto Strangler-Fig, and a gate/Jump is BLOCKED when that rule is
// violated. Two violation paths:
//   (1) the planning gate fails closed when a CI/CD-365 disposition is not ready;
//   (2) the structural guard throws if a high-risk contract is ever non-Strangler.
// ---------------------------------------------------------------------------

function loadCaf() { return template.loadFile(CAF_TEMPLATE); }

test('material defect: every high-risk disposition is Strangler-Fig with big-bang unavailable', () => {
  for (const name of disposition.ALL) {
    const c = disposition.contractFor(name);
    if (c.highRisk === true) {
      assert.equal(c.cutoverStyle, disposition.CUTOVER.STRANGLER_FIG,
        `${name} is high-risk => must be Strangler-Fig`);
      const cl = disposition.classify({ disposition: name });
      assert.equal(cl.bigBangAvailable, false, `${name} must not expose a big-bang plan`);
    }
  }
});

test('material defect: a CI/CD-365 disposition rule violation BLOCKS the planning gate (no Jump)', async () => {
  const ctx = await buildTestCtx();
  const signer = new HumanGateSigner({ ledger: ctx.ledger, store: ctx.store });
  const sm = new StateMachine(loadCaf(), { signer, store: ctx.store });
  const director = { id: 'dir-9', kind: 'human', role: 'director' };

  // Refactor is high-risk + carries deliverySystemPrecondition. Not cicd365Ready
  // => the rule is violated => the gate fails closed and the Jump never kicks off.
  await ctx.store.saveWorkload({ id: 'wn1', name: 'Rearch', disposition: 'Refactor', wave_id: 'wn', attributes: {} });
  await assert.rejects(
    () => sm.signTransition({ run: { id: 'wn', state: 'P3' }, to: 'P4', actor: 'a', signer: director }),
    /machine-checkable criteria not satisfied/,
    'a violated disposition precondition must hard-block the gate'
  );

  // Satisfy the precondition: the SAME gate clears and binds the MANDATORY
  // Strangler-Fig runbook strictly from the contract (never chosen at runtime).
  await ctx.store.saveWorkload({ id: 'wn1', name: 'Rearch', disposition: 'Refactor', wave_id: 'wn',
    attributes: { cicd365Ready: true } });
  const run = { id: 'wn', state: 'P3' };
  const r = await sm.signTransition({ run, to: 'P4', actor: 'a', signer: director });
  assert.equal(r.state, 'P4', 'gate clears once the rule is satisfied');
  assert.equal(run.plan.executorBindings.wn1.cutoverStyle, 'strangler-fig');
  assert.equal(run.plan.executorBindings.wn1.runbookTemplate, 'refactor-strangler');
});

test('material defect: the structural guard BLOCKS a high-risk disposition that is not Strangler-Fig', async () => {
  const ctx = await buildTestCtx();
  const signer = new HumanGateSigner({ ledger: ctx.ledger, store: ctx.store });
  const sm = new StateMachine(loadCaf(), { signer, store: ctx.store });
  const director = { id: 'dir-10', kind: 'human', role: 'director' };

  // Corrupt the disposition table at runtime to a rule-violating shape: a
  // high-risk disposition whose contract is NOT Strangler-Fig. The planning
  // binder asserts the §7 structural guarantee and MUST throw (fail loud),
  // so the gate/Jump is blocked rather than binding an unsafe big-bang plan.
  const original = disposition.DISPOSITIONS.Refactor;
  const corrupt = Object.assign({}, original, { cutoverStyle: disposition.CUTOVER.BIG_BANG });
  const realContractFor = disposition.contractFor;
  disposition.contractFor = (name) => (name === 'Refactor'
    ? Object.freeze(Object.assign({}, corrupt))
    : realContractFor(name));
  try {
    await ctx.store.saveWorkload({ id: 'wc1', name: 'Rearch', disposition: 'Refactor', wave_id: 'wcg',
      attributes: { cicd365Ready: true } });
    await assert.rejects(
      () => sm.signTransition({ run: { id: 'wcg', state: 'P3' }, to: 'P4', actor: 'a', signer: director }),
      /structural guarantee violated/,
      'a high-risk non-Strangler contract must throw and block the gate'
    );
  } finally {
    disposition.contractFor = realContractFor; // restore — never leak the corruption
  }
});
