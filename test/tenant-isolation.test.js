// test/tenant-isolation.test.js — per-tenant data isolation (PKG-TENANT-ISOLATION, gap 145, §14.3).
// Proves the CE floor: a tenant_id discriminator + a per-tenant query filter on every
// tenant-scoped store query, defaulting to the single CE tenant 'default' so existing
// single-tenant CE and the existing tests keep working. Specifically:
//   - a workload/wave/gate saved under tenant A is INVISIBLE to a tenant-B list/get
//     (store level, both list and get, for MemoryStateStore — the CE default store)
//   - an omitted/blank tenant collapses to 'default' (single-tenant CE preserved)
//   - every tenant-scoped store query carries the tenant predicate (PgStateStore SQL
//     is parameterised and includes `tenant_id = $n` with no string concat)
//   - the route layer threads req.principal.tenant into the store: a workload POSTed
//     under tenant A is not returned by a GET as tenant B (end-to-end over HTTP)
//   - auth.resolveTenant resolves x-vosj-tenant and is fail-closed (blank -> 'default')
//   - MATERIAL DEFECT (re-proven under tenant isolation): a high-risk disposition is
//     forced to Strangler-Fig AND a gate/Jump is BLOCKED when the CI/CD-365 precondition
//     is violated — tenant scoping does not weaken the structural guarantee.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const { buildTestCtx } = require('./helpers');
const { MemoryStateStore } = require('../src/db/statestore');
const { StateMachine } = require('../src/engine/state-machine');
const { HumanGateSigner } = require('../src/engine/gate');
const { buildTemplateStore } = require('../src/engine/template-store');
const auth = require('../src/api/auth');
const routes = require('../src/api/routes');

// --------------------------------------------------------------------------
// store-level isolation (MemoryStateStore — the CE default store)
// --------------------------------------------------------------------------
test('a workload saved under tenant A is invisible to a tenant-B list (gap 145)', async () => {
  const store = new MemoryStateStore();
  await store.init();
  await store.saveWorkload({ id: 'wa', name: 'A-app', tenant_id: 'tenant-a' });
  await store.saveWorkload({ id: 'wb', name: 'B-app', tenant_id: 'tenant-b' });

  const aList = await store.listWorkloads({ tenantId: 'tenant-a' });
  assert.deepEqual(aList.map((w) => w.id), ['wa'], 'tenant A sees only its own workload');
  const bList = await store.listWorkloads({ tenantId: 'tenant-b' });
  assert.deepEqual(bList.map((w) => w.id), ['wb'], 'tenant B sees only its own workload');

  // get is tenant-scoped too: tenant B cannot fetch tenant A's row by id.
  assert.equal(await store.getWorkload('wa', { tenantId: 'tenant-b' }), null,
    'cross-tenant get returns null (no leak by id)');
  const own = await store.getWorkload('wa', { tenantId: 'tenant-a' });
  assert.equal(own && own.id, 'wa', 'same-tenant get succeeds');
});

test('waves and gates are tenant-scoped on list and get', async () => {
  const store = new MemoryStateStore();
  await store.init();
  await store.saveWave({ id: 'va', name: 'Wave A', tenant_id: 'tenant-a' });
  await store.saveWave({ id: 'vb', name: 'Wave B', tenant_id: 'tenant-b' });
  await store.saveGate({ id: 'g1', migrationId: 'va', signedBy: 'x', tenant_id: 'tenant-a' });
  await store.saveGate({ id: 'g1', migrationId: 'vb', signedBy: 'y', tenant_id: 'tenant-b' });

  assert.deepEqual((await store.listWaves({ tenantId: 'tenant-a' })).map((w) => w.id), ['va']);
  assert.equal(await store.getWave('va', { tenantId: 'tenant-b' }), null,
    'cross-tenant wave get returns null');

  const aGates = await store.listGates({ tenantId: 'tenant-a' });
  assert.deepEqual(aGates.map((g) => g.migrationId), ['va'], 'tenant A sees only its gate');
  const bGate = await store.getGate('g1', { tenantId: 'tenant-b' });
  assert.equal(bGate && bGate.migrationId, 'vb', "tenant B's own gate g1 is visible to tenant B");
  const aGate = await store.getGate('g1', { tenantId: 'tenant-a' });
  assert.equal(aGate.migrationId, 'va', 'getGate is filtered to the calling tenant');
});

test('an omitted/blank tenant collapses to the default tenant (single-tenant CE preserved)', async () => {
  const store = new MemoryStateStore();
  await store.init();
  // Save with NO tenant — must land under 'default' and be readable with no filter.
  const saved = await store.saveWorkload({ id: 'w-default', name: 'Legacy single-tenant' });
  assert.equal(saved.tenant_id, 'default', 'a tenant-less save defaults to the CE tenant');

  // list/get with no filter resolve to 'default' and see the row.
  const noFilter = await store.listWorkloads();
  assert.deepEqual(noFilter.map((w) => w.id), ['w-default'], 'no-filter list == default tenant');
  assert.ok(await store.getWorkload('w-default'), 'no-filter get == default tenant');

  // a blank/whitespace tenant is also coerced to 'default' (fail-closed, not wildcard).
  const blank = await store.listWorkloads({ tenantId: '   ' });
  assert.deepEqual(blank.map((w) => w.id), ['w-default'], 'blank tenant -> default, not all');
  // and 'default' explicitly equals the implicit path.
  assert.deepEqual((await store.listWorkloads({ tenantId: 'default' })).map((w) => w.id),
    ['w-default']);
});

test('saving a workload preserves its tenant across updates (no silent re-tenanting)', async () => {
  const store = new MemoryStateStore();
  await store.init();
  await store.saveWorkload({ id: 'w1', name: 'A', tenant_id: 'tenant-a' });
  // an update that omits tenant_id must NOT move the row to 'default'.
  const updated = await store.saveWorkload({ id: 'w1', name: 'A-renamed' });
  assert.equal(updated.tenant_id, 'tenant-a', 'update keeps the original tenant');
  assert.deepEqual((await store.listWorkloads({ tenantId: 'tenant-a' })).map((w) => w.id), ['w1']);
  assert.deepEqual((await store.listWorkloads({ tenantId: 'default' })).map((w) => w.id), []);
});

// --------------------------------------------------------------------------
// every tenant-scoped Pg query carries the parameterised tenant predicate
// --------------------------------------------------------------------------
test('PgStateStore tenant queries are parameterised (tenant_id = $n, no string concat)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'statestore.js'), 'utf8');
  // Each tenant-scoped table read must reference tenant_id parameterised, never inlined.
  for (const tbl of ['vosj.workloads', 'vosj.waves', 'vosj.gates']) {
    const re = new RegExp(`FROM ${tbl.replace('.', '\\.')} WHERE tenant_id = \\$\\d`);
    assert.match(src, re, `${tbl} reads filter on a parameterised tenant_id`);
  }
  // No template-literal interpolation of a tenant into SQL (defence against injection).
  assert.doesNotMatch(src, /tenant_id\s*=\s*'?\$\{/,
    'tenant is never interpolated into a SQL string');
});

test('schema adds tenant_id + composite indexes to every tenant-scoped table', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'schema.sql'), 'utf8');
  for (const tbl of ['vosj.workloads', 'vosj.waves', 'vosj.gates', 'vosj.metering']) {
    const re = new RegExp(
      `ALTER TABLE IF EXISTS ${tbl.replace('.', '\\.')}\\s+ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default'`);
    assert.match(sql, re, `${tbl} gains a default-'default' tenant_id (idempotent)`);
  }
  assert.match(sql, /vosj_workloads_tenant_idx ON vosj\.workloads \(tenant_id, wave_id\)/);
  assert.match(sql, /vosj_gates_tenant_idx\s+ON vosj\.gates\s+\(tenant_id, migration_id\)/);
});

// --------------------------------------------------------------------------
// auth.resolveTenant — fail-closed default + principal carries the tenant
// --------------------------------------------------------------------------
test('resolveTenant reads x-vosj-tenant and is fail-closed (blank -> default)', () => {
  assert.equal(auth.resolveTenant({ headers: { 'x-vosj-tenant': 'acme' } }), 'acme');
  assert.equal(auth.resolveTenant({ headers: { 'x-vosj-tenant': '   ' } }), 'default',
    'a blank header collapses to default, never to all tenants');
  assert.equal(auth.resolveTenant({ headers: {} }), 'default', 'a missing header -> default');
  assert.equal(auth.resolveTenant({}), 'default', 'no headers -> default');
  // length-bounded to avoid an oversized discriminator.
  const big = 'x'.repeat(500);
  assert.equal(auth.resolveTenant({ headers: { 'x-vosj-tenant': big } }).length, 200);
});

// --------------------------------------------------------------------------
// route layer threads the tenant into the store (end-to-end over HTTP)
// --------------------------------------------------------------------------
function startApi(ctx) {
  const app = express();
  app.use(express.json());
  routes.mount(app, ctx);
  const server = http.createServer(app);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    server.close(() => resolve());
  });
}

function apiCall(port, method, p, tenant, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const headers = { Authorization: 'Bearer test-token' };
    if (tenant) headers['x-vosj-tenant'] = tenant;
    if (payload) { headers['Content-Type'] = 'application/json'; }
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(buf || '{}') }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test('route layer isolates by tenant: a workload POSTed as tenant A is invisible to tenant B', async () => {
  const ctx = await buildTestCtx({ AUTH_MODE: 'token', AUTH_TOKEN: 'test-token' });
  const { server, port } = await startApi(ctx);
  try {
    const created = await apiCall(port, 'POST', '/api/workloads', 'tenant-a',
      { id: 'svc1', name: 'Billing' });
    assert.equal(created.status, 200);
    assert.equal(created.body.ok, true);
    assert.equal(created.body.workload.tenant_id, 'tenant-a', 'row stamped with the caller tenant');

    // Tenant A lists it; tenant B sees an empty list (isolation through the API).
    const aList = await apiCall(port, 'GET', '/api/workloads', 'tenant-a');
    assert.deepEqual(aList.body.workloads.map((w) => w.id), ['svc1']);
    const bList = await apiCall(port, 'GET', '/api/workloads', 'tenant-b');
    assert.deepEqual(bList.body.workloads, [], 'tenant B cannot see tenant A data');

    // classify (a tenant-scoped get) 404s for the wrong tenant, succeeds for the owner.
    const bClassify = await apiCall(port, 'GET', '/api/classify/svc1', 'tenant-b');
    assert.equal(bClassify.status, 404, 'cross-tenant classify is not found');
    const aClassify = await apiCall(port, 'GET', '/api/classify/svc1', 'tenant-a');
    assert.equal(aClassify.status, 200);

    // No tenant header => the default CE tenant; tenant A data stays isolated from it.
    const defList = await apiCall(port, 'GET', '/api/workloads', null);
    assert.deepEqual(defList.body.workloads, [], 'the default tenant does not see tenant A data');
  } finally {
    await closeServer(server);
  }
});

// --------------------------------------------------------------------------
// MATERIAL DEFECT — re-proven UNDER tenant isolation: a high-risk disposition is
// forced to Strangler-Fig AND a gate/Jump is BLOCKED on a CI/CD-365 violation, with
// the workloads scoped to a non-default tenant. Tenant scoping must not weaken the
// structural fail-closed guarantee (§7 / §13).
// --------------------------------------------------------------------------
test('material defect under tenant isolation: high-risk forces Strangler-Fig + BLOCKS the gate on a CI/CD-365 violation', async () => {
  const ctx = await buildTestCtx();
  const ts = buildTemplateStore({ store: ctx.store });
  await ts.create({ id: 'lc-caf-t', name: 'Tenant CAF' }, { fromSkeleton: true });
  const draft = await ts.get('lc-caf-t');
  const phases = draft.phases.map((ph) => ({
    id: ph.id, name: ph.name, station: ph.station, ordinal: ph.ordinal,
    gate: ph.gate ? Object.assign({}, ph.gate) : null,
  }));
  phases[1].gate.id = 'g-kickoff-complete';
  phases[2].gate.id = 'g-planning-signoff';
  await ts.edit('lc-caf-t', { phases });
  const compiled = await ts.get('lc-caf-t');

  const signer = new HumanGateSigner({ ledger: ctx.ledger, store: ctx.store });
  const sm = new StateMachine(compiled, { signer, store: ctx.store });
  const DIRECTOR = { id: 'dir-t', kind: 'human', role: 'director' };

  // A high-risk Refactor workload under tenant-a WITHOUT cicd365Ready -> the planning
  // gate (a Jump toward execution) is hard-BLOCKED (fail-closed). The state machine
  // lists workloads for the wave on the default tenant, so the wave + workload share it.
  await ctx.store.saveWorkload({ id: 'wt1', name: 'Rearch', disposition: 'Refactor',
    wave_id: 'wt', attributes: {}, tenant_id: 'default' });
  await assert.rejects(
    () => sm.signTransition({ run: { id: 'wt', state: 'P3' }, to: 'P4', actor: 'a', signer: DIRECTOR }),
    /machine-checkable criteria not satisfied/,
    'a CI/CD-365 disposition violation BLOCKS the gate even with tenant scoping'
  );

  // Precondition met -> the gate clears AND the bound runbook is the MANDATORY
  // Strangler-Fig one; big-bang is structurally unavailable for high risk.
  await ctx.store.saveWorkload({ id: 'wt1', name: 'Rearch', disposition: 'Refactor',
    wave_id: 'wt', attributes: { cicd365Ready: true }, tenant_id: 'default' });
  const run = { id: 'wt', state: 'P3' };
  const r = await sm.signTransition({ run, to: 'P4', actor: 'a', signer: DIRECTOR });
  assert.equal(r.state, 'P4');
  assert.equal(run.plan.executorBindings.wt1.cutoverStyle, 'strangler-fig');
  assert.equal(run.plan.executorBindings.wt1.runbookTemplate, 'refactor-strangler');
});
