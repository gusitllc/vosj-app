// test/rbac.test.js — capability gating: today's behaviour + the new role model.
// Asserts:
//   (1) requireCapability still GRANTS today's capabilities by default — an
//       authenticated CE principal holding the capability in its own Set passes,
//       with NO registry configured (back-compat; the 38 existing tests rely on it);
//   (2) the new config-driven capability model (src/api/rbac.js) can GRANT or DENY
//       by role — a role mapping grants exactly its listed capabilities;
//   (3) an un-permitted principal is REJECTED (403) — no own-Set capability, and
//       either no registry or a role the registry does not grant.
// In-memory, no network: the middleware is driven with a tiny fake req/res/next.
// The capability layer bounds *mutation* only; it never grants the human gate
// sign-off (that is structural in the engine) — see waivers.test.js / invariants.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { requireCapability, CE_CAPABILITIES } = require('../src/api/auth');
const { buildRegistry, registryFromConfig } = require('../src/api/rbac');

// A minimal Express-like (req, res, next) harness. Captures the status/body the
// middleware writes and whether next() was called.
function runMiddleware(mw, req) {
  const out = { nextCalled: false, status: 200, body: null };
  const res = {
    status(code) { out.status = code; return res; },
    json(obj) { out.body = obj; return res; },
  };
  mw(req, res, () => { out.nextCalled = true; });
  return out;
}

function principal({ capabilities = [], role = null, kind = 'agent' } = {}) {
  return { id: 'p-1', kind, role, capabilities: new Set(capabilities) };
}

// ---- (1) today's behaviour: own-Set capability grants, unconfigured registry --
test('back-compat: a principal holding the capability in its own Set passes', () => {
  const mw = requireCapability('migration:workload:write', buildRegistry(null));
  const r = runMiddleware(mw, { principal: principal({ capabilities: ['migration:workload:write'] }) });
  assert.equal(r.nextCalled, true, 'own-Set capability must still grant');
  assert.equal(r.status, 200);
});

test('back-compat: the full CE capability set is granted by own-Set today', () => {
  for (const cap of CE_CAPABILITIES) {
    const mw = requireCapability(cap, buildRegistry(null));
    const r = runMiddleware(mw, { principal: principal({ capabilities: CE_CAPABILITIES }) });
    assert.equal(r.nextCalled, true, `CE capability ${cap} must be granted by own-Set`);
  }
});

// ---- (2) the new capability model can GRANT by role -------------------------
test('role model: a configured role grants exactly its mapped capabilities', () => {
  const registry = buildRegistry({
    operator: ['migration:workload:write', 'migration:reconcile:run'],
    viewer: [],
  });
  assert.equal(registry.configured, true);

  // operator holds a granted capability even with an EMPTY own Set.
  const mw = requireCapability('migration:reconcile:run', registry);
  const op = runMiddleware(mw, { principal: principal({ role: 'operator', capabilities: [] }) });
  assert.equal(op.nextCalled, true, 'operator role must be granted its mapped capability');
});

test('role model: registry.grants reflects the exact mapping (grant + deny)', () => {
  const registry = buildRegistry({ operator: ['migration:wave:write'] });
  assert.equal(registry.grants('operator', 'migration:wave:write'), true);
  assert.equal(registry.grants('operator', 'migration:gate:sign'), false, 'unlisted cap denied');
  assert.equal(registry.grants('nobody', 'migration:wave:write'), false, 'unknown role denied');
  assert.deepEqual([...registry.capabilitiesForRole('operator')], ['migration:wave:write']);
});

// ---- (2b) the new model can DENY by role ------------------------------------
test('role model: a role NOT granting the capability is rejected (403)', () => {
  const registry = buildRegistry({ viewer: ['migration:workload:read'] });
  const mw = requireCapability('migration:workload:write', registry);
  const r = runMiddleware(mw, { principal: principal({ role: 'viewer', capabilities: [] }) });
  assert.equal(r.nextCalled, false, 'viewer must NOT get a write capability');
  assert.equal(r.status, 403);
  assert.equal(r.body.ok, false);
  assert.match(r.body.error, /missing capability/);
});

// A configured registry is ADDITIVE: it never strips a capability the principal
// already held in its own Set (so it cannot break existing callers).
test('role model is additive: own-Set capability still grants under a configured registry', () => {
  const registry = buildRegistry({ viewer: [] }); // viewer grants nothing
  const mw = requireCapability('migration:workload:write', registry);
  const r = runMiddleware(mw, {
    principal: principal({ role: 'viewer', capabilities: ['migration:workload:write'] }),
  });
  assert.equal(r.nextCalled, true, 'own-Set capability survives a configured registry');
});

// ---- (3) un-permitted principals are rejected -------------------------------
test('reject: an authenticated principal with no capability is denied (403)', () => {
  const mw = requireCapability('migration:gate:sign', buildRegistry(null));
  const r = runMiddleware(mw, { principal: principal({ capabilities: [] }) });
  assert.equal(r.nextCalled, false);
  assert.equal(r.status, 403);
  assert.match(r.body.error, /missing capability: migration:gate:sign/);
});

test('reject: an unauthenticated request (no principal) is denied (401)', () => {
  const mw = requireCapability('migration:workload:write', buildRegistry(null));
  const r = runMiddleware(mw, {}); // no req.principal
  assert.equal(r.nextCalled, false);
  assert.equal(r.status, 401);
  assert.match(r.body.error, /authentication required/);
});

test('reject: a principal with no role cannot use a role-only grant', () => {
  const registry = buildRegistry({ operator: ['migration:wave:write'] });
  const mw = requireCapability('migration:wave:write', registry);
  const r = runMiddleware(mw, { principal: principal({ role: null, capabilities: [] }) });
  assert.equal(r.nextCalled, false, 'no role => no role-based grant');
  assert.equal(r.status, 403);
});

// ---- registry hygiene: malformed/empty config fails to an empty registry ----
test('registry: malformed or empty config yields an unconfigured (empty) registry', () => {
  for (const bad of [null, undefined, '', 'not-json', '[]', '42', JSON.stringify(['a'])]) {
    const reg = buildRegistry(bad);
    assert.equal(reg.configured, false, `source ${JSON.stringify(bad)} must be unconfigured`);
    assert.deepEqual(reg.roles, []);
  }
});

test('registry: a JSON string source parses into role grants', () => {
  const reg = buildRegistry('{"operator":["migration:reconcile:run"]}');
  assert.equal(reg.configured, true);
  assert.equal(reg.grants('operator', 'migration:reconcile:run'), true);
});

test('registry: registryFromConfig reads config.RBAC_ROLE_CAPABILITIES', () => {
  const reg = registryFromConfig({ RBAC_ROLE_CAPABILITIES: { operator: ['migration:wave:plan'] } });
  assert.equal(reg.configured, true);
  assert.equal(reg.grants('operator', 'migration:wave:plan'), true);
});

// Non-string capability entries are dropped (no accidental grant via junk data).
test('registry: non-string capability entries are ignored (no junk grants)', () => {
  const reg = buildRegistry({ operator: ['migration:wave:write', 123, null, ''] });
  assert.deepEqual([...reg.capabilitiesForRole('operator')], ['migration:wave:write']);
});
