// src/mcp/tools.js — the MCP tool catalog (the bring-your-own-AI seam, R8).
// Each tool is a thin, audited adapter over an engine operation. The set is an
// explicit ALLOW-LIST: tools/call rejects anything not registered here. Mutating
// tools fail closed (sign_gate REQUIRES a human signer; the engine re-checks).
// Every tool returns the house envelope { ok:true, ...data } | { ok:false, error }.

'use strict';

// JSON Schemas are advertised via tools/list so a planner can call correctly.
const TOOLS = Object.freeze({
  list_templates: {
    description: 'List the available migration framework templates (V-O-S-J phases/gates).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: listTemplates,
  },
  classify_workload: {
    description: 'Classify a workload into one of the 7-R dispositions and return its typed contract.',
    inputSchema: {
      type: 'object',
      properties: { workload: { type: 'object' } },
      required: ['workload'],
    },
    handler: classifyWorkload,
  },
  sign_gate: {
    description: 'Apply a human gate sign-off (no agent self-sign; separation of duties; cutover needs a passing proof).',
    inputSchema: {
      type: 'object',
      properties: { gate: { type: 'object' }, signer: { type: 'object' } },
      required: ['gate', 'signer'],
    },
    handler: signGate,
  },
  run_reconcile: {
    description: 'Run the verification/reconciliation engine for a unit via a connector and return the equivalence proof.',
    inputSchema: {
      type: 'object',
      properties: { unit: { type: 'object' }, connector: { type: 'string' } },
      required: ['unit'],
    },
    handler: runReconcile,
  },
  ledger_verify: {
    description: 'Verify the tamper-evident hash-chained audit ledger end to end.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: ledgerVerify,
  },
});

function listToolDefs() {
  return Object.keys(TOOLS).map((name) => ({
    name,
    description: TOOLS[name].description,
    inputSchema: TOOLS[name].inputSchema,
  }));
}

function isAllowed(name) {
  return Object.prototype.hasOwnProperty.call(TOOLS, name);
}

// ---- handlers (engine adapters) -------------------------------------------

async function listTemplates(_args, ctx) {
  return { ok: true, templates: ctx.engine.listTemplates() };
}

async function classifyWorkload(args, ctx) {
  const workload = args && args.workload;
  if (!workload || typeof workload !== 'object') return { ok: false, error: 'workload object required' };
  const result = ctx.engine.classify(workload);
  return { ok: true, disposition: result.disposition, contract: result.contract,
    strangler: result.strangler, bigBangAvailable: result.bigBangAvailable };
}

// sign_gate enforces a HUMAN signer at the seam; the engine's HumanGateSigner
// re-validates (kind==='human', author!==signer, cutover needs a passing proof).
async function signGate(args, ctx) {
  const gate = args && args.gate;
  const signer = args && args.signer;
  if (!gate || typeof gate !== 'object') return { ok: false, error: 'gate object required' };
  if (!signer || signer.kind !== 'human') {
    return { ok: false, error: 'sign_gate requires a human signer (no agent self-sign)' };
  }
  const row = await ctx.engine.signer.sign(gate, signer);
  return { ok: true, ledger: { seq: row.seq, hash: row.hash, action: row.action, ts: row.ts } };
}

async function runReconcile(args, ctx) {
  const unit = args && args.unit;
  if (!unit || typeof unit !== 'object') return { ok: false, error: 'unit object required' };
  const connector = ctx.connectors.get((args && args.connector) || 'demo');
  if (!connector) return { ok: false, error: `unknown connector: ${args && args.connector}` };
  const r = await ctx.engine.reconcile(unit, connector, {});
  return { ok: r.ok, proof: r.proof, categories: r.categories, baselineFresh: r.baselineFresh };
}

async function ledgerVerify(_args, ctx) {
  const r = await ctx.ledger.verifyChain();
  return { ok: r.ok, brokenAt: r.brokenAt };
}

// runTool(name, args, ctx) -> envelope. Audits every call to vosj.tool_log.
async function runTool(name, args, ctx, actor) {
  const started = Date.now();
  let result;
  try {
    result = await TOOLS[name].handler(args || {}, ctx);
  } catch (e) {
    result = { ok: false, error: e.message };
  }
  await audit(ctx, name, args, result, actor, Date.now() - started);
  return result;
}

async function audit(ctx, tool, args, result, actor, durationMs) {
  try {
    if (ctx.store && typeof ctx.store.appendToolLog === 'function') {
      await ctx.store.appendToolLog({
        server: 'vosj-mcp', tool, actor: actor || null,
        arguments: redact(args), result, durationMs,
      });
    }
  } catch (e) {
    if (ctx.log) ctx.log('WARN', `tool_log append failed for ${tool}`, e.message);
  }
}

// Never persist a signer's raw identity beyond its id/role in the audit args.
function redact(args) {
  if (!args || typeof args !== 'object') return {};
  const copy = Object.assign({}, args);
  if (copy.signer && typeof copy.signer === 'object') {
    copy.signer = { id: copy.signer.id, kind: copy.signer.kind, role: copy.signer.role };
  }
  return copy;
}

module.exports = { TOOLS, listToolDefs, isAllowed, runTool };
