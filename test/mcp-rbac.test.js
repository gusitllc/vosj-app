// test/mcp-rbac.test.js — per-tool RBAC binding at the MCP seam (gaps 64/153/156).
// The MCP tool catalog is an explicit allow-list (tools.isAllowed) but an allow-list
// is NOT authorization. Each tool is now bound to a required capability and the seam
// (server.dispatch -> handleToolsCall -> authorizeToolCall) PRE-FILTERS every
// tools/call against the caller's capability BEFORE the tool reaches the engine,
// reusing auth.holdsCapability + the configured RBAC registry. We assert:
//   (1) a principal LACKING migration:gate:sign is REJECTED at the seam, and the
//       engine signer is NEVER invoked (rejection precedes the engine);
//   (2) a principal HOLDING the capability PASSES (the engine runs);
//   (3) the tool_log audit records the BOUND capability + the local-Hub audience;
//   (4) an unknown / unbound tool is still rejected (allow-list intact);
//   (5) confused-deputy / RFC 8707: a principal whose audience is not THIS Hub
//       (a foreign auth mode = a forwarded/pass-through token) is REFUSED;
//   (6) per-tool denial via a configured role registry (read tool denied to a role
//       that the registry does not grant), and the same registry granting it.
// Defence-in-depth: the engine's HumanGateSigner STILL re-validates the human gate,
// so even a capability-holder cannot force a cutover without a passing proof — we
// prove the structural disposition guarantee survives the seam:
//   (7) a high-risk disposition (Refactor/Replatform) is forced onto Strangler-Fig
//       through classify_workload (no big-bang), AND a cutover gate signed through
//       sign_gate is BLOCKED when the verified-before-jump rule is violated (no proof).
// In-memory, no network: server.dispatch is driven with crafted principals.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const server = require('../src/mcp/server');
const { buildTestCtx } = require('./helpers');
const { CE_CAPABILITIES, configureRbac } = require('../src/api/auth');

// A local-Hub principal (mode 'token' is a recognised local auth mode). capabilities
// is the caller's own Set; role is consulted only when a registry is configured.
function principal({ id = 'p-1', kind = 'agent', mode = 'token', role = null,
  capabilities = [] } = {}) {
  return { id, kind, mode, role, capabilities: new Set(capabilities) };
}

// A full-contributor CE principal (holds the whole CE capability set), as minted by
// auth.tokenPrincipal/openPrincipal in production.
function contributor(overrides = {}) {
  return principal(Object.assign({ capabilities: CE_CAPABILITIES }, overrides));
}

async function callTool(ctx, name, args, who) {
  return server.dispatch('tools/call', { name, arguments: args || {} }, ctx, who);
}

// Reset the module-level RBAC registry to UNCONFIGURED between registry tests so the
// default (own-Set) path is restored (configureRbac is idempotent + global).
function resetRbac() { configureRbac({ RBAC_ROLE_CAPABILITIES: '' }); }

// ---- (1) reject at the seam, before the engine ------------------------------
test('seam rejects sign_gate for a principal lacking migration:gate:sign — engine never runs', async () => {
  resetRbac();
  const ctx = await buildTestCtx();
  // Spy: prove the rejection happens at the MCP seam, before the engine signer.
  let signCalls = 0;
  ctx.engine.signer.sign = async () => { signCalls += 1; return {}; };

  const who = principal({ capabilities: ['migration:disposition:read'] }); // no gate:sign
  await assert.rejects(
    () => callTool(ctx, 'sign_gate', { gate: { id: 'g1' }, signer: { kind: 'human', id: 'h1' } }, who),
    /missing capability: migration:gate:sign/,
    'a caller without the bound capability must be rejected at the seam'
  );
  assert.equal(signCalls, 0, 'the engine signer must NOT be reached when the seam rejects');

  // Nothing authorized => nothing audited.
  assert.equal(ctx.store._toolLog.length, 0, 'a rejected call writes no tool_log row');
});

// ---- (2) a capability-holder passes -----------------------------------------
test('seam allows a read tool for a principal holding the bound capability', async () => {
  resetRbac();
  const ctx = await buildTestCtx();
  const who = principal({ capabilities: ['migration:template:read'] });
  const res = await callTool(ctx, 'list_templates', {}, who);
  assert.equal(res.isError, false, 'an authorized read tool succeeds');
  assert.equal(res.structuredContent.ok, true);
  assert.ok(Array.isArray(res.structuredContent.templates), 'returns the template list');
});

// ---- (3) the tool_log records the BOUND capability + audience ---------------
test('tool_log records the bound capability and the local-Hub audience', async () => {
  resetRbac();
  const ctx = await buildTestCtx();
  const who = contributor({ id: 'auditor-1' });
  await callTool(ctx, 'ledger_verify', {}, who);

  assert.equal(ctx.store._toolLog.length, 1, 'one audited call');
  const row = ctx.store._toolLog[0];
  assert.equal(row.tool, 'ledger_verify');
  assert.equal(row.actor, 'auditor-1', 'actor attribution preserved');
  assert.ok(row.arguments._rbac, 'audit carries the _rbac authority envelope');
  assert.equal(row.arguments._rbac.capability, 'migration:ledger:read',
    'the bound capability is recorded');
  assert.equal(row.arguments._rbac.audience, 'vosj-hub',
    'the local-Hub audience is recorded (gap 156)');
});

// ---- (4) the allow-list is intact: unknown / unbound tools rejected ---------
test('seam rejects an unknown tool (allow-list intact)', async () => {
  resetRbac();
  const ctx = await buildTestCtx();
  const who = contributor();
  await assert.rejects(
    () => callTool(ctx, 'definitely_not_a_tool', {}, who),
    /unknown or disallowed tool/,
    'a tool not in the allow-list is rejected'
  );
  assert.equal(ctx.store._toolLog.length, 0);
});

test('seam rejects a tools/call with no principal (authentication required)', async () => {
  resetRbac();
  const ctx = await buildTestCtx();
  await assert.rejects(
    () => callTool(ctx, 'list_templates', {}, null),
    /authentication required/,
    'an unauthenticated tool call is rejected'
  );
});

// ---- (5) confused-deputy / RFC 8707 audience --------------------------------
test('seam refuses a foreign-audience principal (token pass-through refused, gap 156)', async () => {
  resetRbac();
  const ctx = await buildTestCtx();
  // A principal that holds the capability but whose mode is NOT a local-Hub mode
  // (i.e. a forwarded/pass-through token) must be refused before any tool runs.
  const foreign = principal({ mode: 'forwarded-upstream', capabilities: CE_CAPABILITIES });
  await assert.rejects(
    () => callTool(ctx, 'list_templates', {}, foreign),
    /audience is not this Hub/,
    'a non-local-Hub audience must be refused even with the capability'
  );
  assert.equal(ctx.store._toolLog.length, 0, 'a refused pass-through writes no audit row');
});

test('open-mode (localhost dev) principal is a valid local-Hub audience', async () => {
  resetRbac();
  const ctx = await buildTestCtx();
  const dev = principal({ id: 'localhost-dev', mode: 'open', capabilities: ['migration:template:read'] });
  const res = await callTool(ctx, 'list_templates', {}, dev);
  assert.equal(res.isError, false, 'open mode is a recognised local audience');
});

// ---- (6) per-tool denial / grant via a configured role registry -------------
test('configured registry: a role NOT granted the tool capability is denied per-tool', async () => {
  // viewer is granted nothing the read tool needs; own Set is empty -> denied.
  configureRbac({ RBAC_ROLE_CAPABILITIES: { viewer: ['migration:workload:read'] } });
  const ctx = await buildTestCtx();
  const who = principal({ role: 'viewer', capabilities: [] });
  await assert.rejects(
    () => callTool(ctx, 'classify_workload', { workload: { disposition: 'Rehost' } }, who),
    /missing capability: migration:disposition:read/,
    'a role without the bound capability is denied at the seam'
  );
  resetRbac();
});

test('configured registry: a role granted the tool capability passes per-tool', async () => {
  configureRbac({ RBAC_ROLE_CAPABILITIES: { analyst: ['migration:disposition:read'] } });
  const ctx = await buildTestCtx();
  const who = principal({ role: 'analyst', capabilities: [] }); // empty own Set; role grants it
  const res = await callTool(ctx, 'classify_workload', { workload: { disposition: 'Rehost' } }, who);
  assert.equal(res.isError, false, 'a role-granted capability authorizes the tool');
  assert.equal(res.structuredContent.ok, true);
  resetRbac();
});

// ---- (7) structural disposition guarantee survives the seam -----------------
// The seam authorizes; the engine still enforces the structural rules. A high-risk
// disposition is forced onto Strangler-Fig (no big-bang) THROUGH the tool, and a
// cutover gate signed through sign_gate is BLOCKED when the verified-before-jump
// rule is violated — capability alone cannot bypass the human/proof gate.
test('classify_workload forces a high-risk disposition onto Strangler-Fig (no big-bang)', async () => {
  resetRbac();
  const ctx = await buildTestCtx();
  const who = principal({ capabilities: ['migration:disposition:read'] });
  for (const d of ['Refactor', 'Replatform', 'Relocate']) {
    const res = await callTool(ctx, 'classify_workload', { workload: { disposition: d } }, who);
    assert.equal(res.isError, false, `${d} classifies via the tool`);
    assert.equal(res.structuredContent.disposition, d);
    assert.equal(res.structuredContent.strangler, true, `${d} must be Strangler-Fig`);
    assert.equal(res.structuredContent.bigBangAvailable, false, `${d} must have NO big-bang`);
  }
});

test('sign_gate (authorized) is BLOCKED when the cutover proof rule is violated (defence in depth)', async () => {
  resetRbac();
  const ctx = await buildTestCtx();
  // An authorized human signer (holds migration:gate:sign) — the seam lets it
  // through, but the engine's HumanGateSigner re-validates the structural rule and
  // refuses a cutover gate with no passing reconciliation proof.
  const who = contributor();
  const cutoverGate = {
    id: 'g-cutover', cutover: true, migrationId: 'm1',
    signerRole: 'dba', proof: null, // verified-before-jump rule VIOLATED (no proof)
  };
  const signer = { id: 'alice-dba', kind: 'human', role: 'dba' };
  const res = await callTool(ctx, 'sign_gate', { gate: cutoverGate, signer }, who);
  assert.equal(res.isError, true, 'the cutover gate is blocked by the engine');
  assert.equal(res.structuredContent.ok, false);
  assert.match(res.structuredContent.error, /proof|cutover|reconcil/i,
    'blocked for the missing verified-before-jump proof');

  // The call WAS authorized, so it is audited with the bound capability even though
  // the engine refused the structural step (the audit is the source of truth).
  const row = ctx.store._toolLog.find((r) => r.tool === 'sign_gate');
  assert.ok(row, 'the authorized-but-engine-refused call is audited');
  assert.equal(row.arguments._rbac.capability, 'migration:gate:sign');
});

test('sign_gate rejects a non-human signer at the tool seam (no agent self-sign)', async () => {
  resetRbac();
  const ctx = await buildTestCtx();
  const who = contributor();
  const res = await callTool(ctx, 'sign_gate',
    { gate: { id: 'g2' }, signer: { kind: 'agent', id: 'bot' } }, who);
  assert.equal(res.isError, true);
  assert.match(res.structuredContent.error, /human signer/, 'agent self-sign refused');
});
