// test/db-ha.test.js — PostgreSQL HA values stanza (PKG-PG-HA-VALUES, gap 146,
// whitepaper §14.4: quorum synchronous replication >=3, continuous backup, WAL
// archiving, PITR, with a stated ledger RPO/RTO).
//
// Proves the chart CODIFIES the §14.4 durability posture for the system-of-record
// (the database that holds the tamper-evident LEDGER):
//   - a CloudNativePG `Cluster` CR is gated behind postgresHA.enabled, DEFAULT
//     false — so the in-memory and single-PVC POC paths are unaffected (opt-in);
//   - when enabled it renders >=3 instances, quorum-based SYNCHRONOUS replication
//     (method ANY, fail-closed dataDurability:required), and (when a backup target
//     + creds Secret are supplied) WAL archiving + base backups + a PITR window;
//   - the render is FAIL-CLOSED: instances<3 errors; backup with no destinationPath
//     errors; backup with no credentials Secret renders NO backup stanza;
//   - the RPO/RTO statement exists and names the ledger as the system-of-record.
//
// When `helm` is on PATH the test renders the real chart and asserts on the
// emitted YAML. When it is not, structural assertions on the template + values +
// audit-doc source still prove something (no external dependency). The structural
// checks run unconditionally.
//
// It ALSO re-proves the MATERIAL DEFECT this repo guards (independent of helm):
// a high-risk disposition is FORCED onto Strangler-Fig AND a gate/Jump is BLOCKED
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
const PG_TEMPLATE = path.join(CHART_DIR, 'templates', 'postgres-cluster.yaml');
const VALUES = path.join(CHART_DIR, 'values.yaml');
const AUDIT_DOC = path.join(__dirname, '..', 'docs', 'audits', 'DB-HA-RPO-RTO.md');

function readFile(p) { return fs.readFileSync(p, 'utf8'); }

// Locate a helm binary (PATH, or the known Windows install in this env).
function findHelm() {
  for (const cmd of ['helm', 'C:/Users/gus/.azure-kubectl/helm']) {
    const r = spawnSync(cmd, ['version', '--short'], { encoding: 'utf8' });
    if (r.status === 0) return cmd;
  }
  return null;
}

// helm template the postgres-cluster only, with optional --set overrides.
// Returns { status, out } so callers can assert on both render output AND
// fail-closed errors (helm exits non-zero with the `fail` message on stderr).
function renderCluster(helm, sets = []) {
  const args = ['template', 't', CHART_DIR, '--show-only', 'templates/postgres-cluster.yaml'];
  for (const s of sets) args.push('--set', s);
  const r = spawnSync(helm, args, { encoding: 'utf8' });
  return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

// ---------------------------------------------------------------------------
// Structural assertions (no external dependency — always run).
// ---------------------------------------------------------------------------

test('postgres-cluster template renders a CNPG Cluster gated by postgresHA.enabled', () => {
  const tpl = readFile(PG_TEMPLATE);
  assert.match(tpl, /kind:\s*Cluster/, 'declares a CNPG Cluster');
  assert.match(tpl, /apiVersion:\s*postgresql\.cnpg\.io\/v1/, 'uses the CNPG API group');
  assert.match(tpl, /\{\{-?\s*if \.Values\.postgresHA\.enabled\s*\}\}/, 'gated by postgresHA.enabled');
  // Quorum synchronous replication block (the §14.4 core requirement).
  assert.match(tpl, /synchronous:/, 'renders a synchronous stanza');
  assert.match(tpl, /method:\s*\{\{\s*\$sync\.method/, 'synchronous.method is values-driven (quorum ANY)');
  assert.match(tpl, /dataDurability/, 'sets dataDurability (fail-closed durability)');
  // Continuous backup / WAL / PITR retention.
  assert.match(tpl, /barmanObjectStore:/, 'renders barmanObjectStore (WAL + base backups)');
  assert.match(tpl, /retentionPolicy:/, 'renders a PITR retention window');
  // Fail-closed guards present in the template source.
  assert.match(tpl, /must be >= 3 for quorum synchronous replication/, 'fail-closes on instances < 3');
  assert.match(tpl, /requires backup\.barmanObjectStore\.destinationPath/, 'fail-closes on missing destinationPath');
});

test('values.yaml ships a postgresHA stanza, DISABLED by default, instances>=3, quorum sync', () => {
  const v = readFile(VALUES);
  assert.match(v, /postgresHA:/, 'has a postgresHA stanza');
  // Default DISABLED so the POC/memory paths are unaffected (opt-in HA).
  assert.match(v, /postgresHA:\s*\n(?:\s*#.*\n)*\s*enabled:\s*false/,
    'postgresHA.enabled defaults to false (POC paths intact)');
  // The values-level posture: >=3 instances + quorum sync + a PITR window.
  assert.match(v, /instances:\s*3/, 'default instances 3 (quorum majority)');
  assert.match(v, /method:\s*any/, 'quorum method ANY');
  assert.match(v, /dataDurability:\s*required/, 'dataDurability defaults to required (fail-closed)');
  assert.match(v, /retentionPolicy:\s*30d/, 'a PITR recovery window is stated');
  // Backup defaults OFF (no object store assumed) — fail-closed.
  assert.match(v, /backup:\s*\n\s*enabled:\s*false/, 'backup defaults off (no object store assumed)');
});

test('DB-HA-RPO-RTO audit doc states the RPO/RTO and names the ledger as system-of-record', () => {
  const d = readFile(AUDIT_DOC);
  assert.match(d, /RPO/, 'states an RPO');
  assert.match(d, /RTO/, 'states an RTO');
  // The load-bearing framing: the ledger is the system-of-record whose durability
  // the RPO protects (the explicit note the package requires).
  assert.match(d, /ledger is the system-of-record/i, 'names the ledger as the system-of-record');
  assert.match(d, /lost WAL segment is a lost audit row/i, 'frames RPO as audit integrity');
  // Single-node failure RPO is zero (synchronous quorum), the headline guarantee.
  assert.match(d, /zero data loss|RPO\s*=\s*0|RPO\s*0/i, 'states zero-RPO for single-node failure');
  assert.match(d, /§14\.4/, 'cites whitepaper §14.4');
});

// ---------------------------------------------------------------------------
// Rendered-YAML assertions (run only when helm is available).
// ---------------------------------------------------------------------------

const helm = findHelm();

test('helm: postgresHA disabled (default) renders NO Cluster object', { skip: !helm && 'helm not on PATH' }, () => {
  const { out } = renderCluster(helm);
  // `--show-only` on an empty render errors with "could not find template"; either
  // way there is NO Cluster object — the POC/memory paths are unaffected.
  assert.ok(!/kind: Cluster/.test(out), 'no Cluster when postgresHA.enabled is false (default)');
});

test('helm: enabled renders a 3-instance quorum-sync Cluster (method ANY, dataDurability required)', { skip: !helm && 'helm not on PATH' }, () => {
  const { status, out } = renderCluster(helm, ['postgresHA.enabled=true']);
  assert.equal(status, 0, 'renders successfully when enabled with >=3 instances');
  assert.match(out, /kind: Cluster/, 'a CNPG Cluster is rendered');
  assert.match(out, /name: t-vosj-pg/, 'named <fullname>-pg by default');
  assert.match(out, /instances: 3/, '>=3 instances (quorum majority)');
  // Quorum-based synchronous replication.
  assert.match(out, /synchronous:\s*\n\s*method: "any"/, 'quorum synchronous method ANY');
  assert.match(out, /dataDurability: "required"/, 'fail-closed durability (required, not preferred)');
  assert.match(out, /minSyncReplicas: 1/, 'legacy quorum knob emitted for older CNPG');
  // No backup stanza by default (no object store assumed) — fail-closed.
  assert.ok(!/barmanObjectStore:/.test(out), 'no backup rendered until an object store is configured');
});

test('helm: instances<3 while enabled FAILS the render (fail-closed quorum guard)', { skip: !helm && 'helm not on PATH' }, () => {
  const { status, out } = renderCluster(helm, ['postgresHA.enabled=true', 'postgresHA.instances=2']);
  assert.notEqual(status, 0, 'render must fail when instances < 3');
  assert.match(out, /must be >= 3 for quorum synchronous replication/, 'errors with the quorum guard message');
});

test('helm: backup enabled with no destinationPath FAILS the render (fail-closed)', { skip: !helm && 'helm not on PATH' }, () => {
  const { status, out } = renderCluster(helm, ['postgresHA.enabled=true', 'postgresHA.backup.enabled=true']);
  assert.notEqual(status, 0, 'render must fail when a backup has nowhere to write');
  assert.match(out, /requires backup\.barmanObjectStore\.destinationPath/, 'errors with the destinationPath guard');
});

test('helm: backup enabled + destinationPath but NO creds Secret renders NO backup stanza', { skip: !helm && 'helm not on PATH' }, () => {
  const { status, out } = renderCluster(helm, [
    'postgresHA.enabled=true',
    'postgresHA.backup.enabled=true',
    'postgresHA.backup.barmanObjectStore.destinationPath=s3://vosj-backups/',
  ]);
  assert.equal(status, 0, 'renders (the Cluster) without erroring');
  assert.match(out, /kind: Cluster/, 'the Cluster is still rendered');
  // A backup that cannot authenticate is not durability: deny, do not pretend.
  assert.ok(!/barmanObjectStore:/.test(out), 'no backup stanza without credentials (fail-closed)');
});

test('helm: full S3 backup renders WAL archiving + base backups + a PITR retention window', { skip: !helm && 'helm not on PATH' }, () => {
  const { status, out } = renderCluster(helm, [
    'postgresHA.enabled=true',
    'postgresHA.backup.enabled=true',
    'postgresHA.backup.barmanObjectStore.destinationPath=s3://vosj-backups/',
    'postgresHA.backup.barmanObjectStore.credentials.secretName=vosj-backup-creds',
    'postgresHA.backup.retentionPolicy=14d',
  ]);
  assert.equal(status, 0, 'renders successfully with a full backup config');
  assert.match(out, /barmanObjectStore:/, 'backup object store rendered');
  assert.match(out, /destinationPath: "s3:\/\/vosj-backups\/"/, 'WAL/base backups target the object store');
  assert.match(out, /s3Credentials:/, 'S3 credentials wired from the Secret');
  assert.match(out, /name: "vosj-backup-creds"/, 'credentials reference the supplied Secret');
  assert.match(out, /wal:/, 'WAL archiving configured');
  assert.match(out, /retentionPolicy: "14d"/, 'PITR recovery window is values-driven');
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
  const director = { id: 'dir-pg-9', kind: 'human', role: 'director' };

  // Refactor is high-risk + carries deliverySystemPrecondition. Not cicd365Ready
  // => the rule is violated => the gate fails closed and the Jump never kicks off.
  await ctx.store.saveWorkload({ id: 'wp1', name: 'Rearch', disposition: 'Refactor', wave_id: 'wp', attributes: {} });
  await assert.rejects(
    () => sm.signTransition({ run: { id: 'wp', state: 'P3' }, to: 'P4', actor: 'a', signer: director }),
    /machine-checkable criteria not satisfied/,
    'a violated disposition precondition must hard-block the gate'
  );

  // Satisfy the precondition: the SAME gate clears and binds the MANDATORY
  // Strangler-Fig runbook strictly from the contract (never chosen at runtime).
  await ctx.store.saveWorkload({ id: 'wp1', name: 'Rearch', disposition: 'Refactor', wave_id: 'wp',
    attributes: { cicd365Ready: true } });
  const run = { id: 'wp', state: 'P3' };
  const r = await sm.signTransition({ run, to: 'P4', actor: 'a', signer: director });
  assert.equal(r.state, 'P4', 'gate clears once the rule is satisfied');
  assert.equal(run.plan.executorBindings.wp1.cutoverStyle, 'strangler-fig');
  assert.equal(run.plan.executorBindings.wp1.runbookTemplate, 'refactor-strangler');
});

test('material defect: the structural guard BLOCKS a high-risk disposition that is not Strangler-Fig', async () => {
  const ctx = await buildTestCtx();
  const signer = new HumanGateSigner({ ledger: ctx.ledger, store: ctx.store });
  const sm = new StateMachine(loadCaf(), { signer, store: ctx.store });
  const director = { id: 'dir-pg-10', kind: 'human', role: 'director' };

  // Corrupt the disposition table at runtime to a rule-violating shape: a
  // high-risk disposition whose contract is NOT Strangler-Fig. The planning
  // binder asserts the §7 structural guarantee and MUST throw (fail loud),
  // so the gate/Jump is blocked rather than binding an unsafe big-bang plan.
  const realContractFor = disposition.contractFor;
  const corrupt = Object.assign({}, realContractFor('Refactor'), { cutoverStyle: disposition.CUTOVER.BIG_BANG });
  disposition.contractFor = (name) => (name === 'Refactor'
    ? Object.freeze(Object.assign({}, corrupt))
    : realContractFor(name));
  try {
    await ctx.store.saveWorkload({ id: 'wpc1', name: 'Rearch', disposition: 'Refactor', wave_id: 'wpcg',
      attributes: { cicd365Ready: true } });
    await assert.rejects(
      () => sm.signTransition({ run: { id: 'wpcg', state: 'P3' }, to: 'P4', actor: 'a', signer: director }),
      /structural guarantee violated/,
      'a high-risk non-Strangler contract must throw and block the gate'
    );
  } finally {
    disposition.contractFor = realContractFor; // restore — never leak the corruption
  }
});
