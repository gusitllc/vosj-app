// src/api/routes.js — Vosj CE REST API (§12.1). Mounted by server.js's
// mountOptional('./api/routes'). Exports `function mount(app, ctx)` which registers
// every route under /api. Each data route is gated with requireAuth; each mutation
// additionally with requireCapability. The engine facade + store from ctx do the
// real work — this layer only validates input and shapes the { ok, ... } envelope.
//
// Invariant 1 & 2 (no agent self-sign, separation of duties) are enforced
// STRUCTURALLY in the engine's HumanGateSigner — the human signer identity is
// supplied in the request body and validated there, never granted by this layer.

'use strict';

const { requireAuth, requireCapability } = require('./auth');

// --------------------------------------------------------------------------
// envelope helpers
// --------------------------------------------------------------------------
function ok(res, data) { return res.json(Object.assign({ ok: true }, data)); }
function fail(res, code, error) { return res.status(code).json({ ok: false, error }); }

// Wrap an async handler so a thrown error becomes a clean { ok:false } envelope
// instead of an unhandled rejection. Never leaks a stack to the client.
function handler(ctx, fn) {
  return async function wrapped(req, res) {
    try {
      await fn(req, res);
    } catch (e) {
      if (ctx.log) ctx.log('ERROR', `api ${req.method} ${req.path}`, e.message);
      if (!res.headersSent) fail(res, 400, e.message || 'request failed');
    }
  };
}

function str(v) { return (v === undefined || v === null) ? '' : String(v); }

// Build the in-memory unit shape the engine expects from a stored workload row.
// The store persists snake_case columns; reconcile/state-machine read camelCase.
function unitFromWorkload(w) {
  return {
    id: w.id,
    name: w.name,
    migrationId: w.wave_id || null,
    state: w.state || 'legacy',
    baselineAt: w.baseline_at || null,
    rowCount: (w.attributes && w.attributes.rowCount) || undefined,
    attributes: w.attributes || {},
  };
}

function connectorFor(ctx, name) {
  const id = name || 'demo';
  const conn = ctx.connectors && ctx.connectors.get(id);
  if (!conn) throw new Error(`unknown connector: ${id}`);
  return conn;
}

// --------------------------------------------------------------------------
// route groups (kept small to respect the <30-line function rule)
// --------------------------------------------------------------------------
function mountTemplates(app, ctx, auth) {
  app.get('/api/templates', auth, handler(ctx, async (_req, res) => {
    ok(res, { templates: ctx.engine.listTemplates() });
  }));

  app.get('/api/templates/:id', auth, handler(ctx, async (req, res) => {
    const tpl = ctx.engine.getTemplate(str(req.params.id));
    ok(res, { template: tpl });
  }));
}

function mountWorkloads(app, ctx, auth) {
  app.get('/api/workloads', auth, handler(ctx, async (req, res) => {
    const filter = req.query.waveId ? { waveId: str(req.query.waveId) } : {};
    ok(res, { workloads: await ctx.store.listWorkloads(filter) });
  }));

  app.post('/api/workloads', auth, requireCapability('migration:workload:write'),
    handler(ctx, async (req, res) => {
      const w = buildWorkload(req.body || {});
      const saved = await ctx.store.saveWorkload(w);
      ok(res, { workload: saved });
    }));
}

function buildWorkload(body) {
  const id = str(body.id).trim();
  const name = str(body.name).trim();
  if (!id) throw new Error('workload requires an id');
  if (!name) throw new Error('workload requires a name');
  return {
    id,
    name,
    disposition: body.disposition ? str(body.disposition) : null,
    state: body.state ? str(body.state) : 'legacy',
    wave_id: body.waveId ? str(body.waveId) : null,
    baseline_at: body.baselineAt ? str(body.baselineAt) : null,
    attributes: (body.attributes && typeof body.attributes === 'object') ? body.attributes : {},
  };
}

function mountWaves(app, ctx, auth) {
  app.get('/api/waves', auth, handler(ctx, async (_req, res) => {
    ok(res, { waves: await ctx.store.listWaves({}) });
  }));

  app.post('/api/waves', auth, requireCapability('migration:wave:write'),
    handler(ctx, async (req, res) => {
      const wave = buildWave(ctx, req.body || {});
      const saved = await ctx.store.saveWave(wave);
      ok(res, { wave: saved });
    }));

  app.post('/api/waves/:id/transition', auth, requireCapability('migration:gate:sign'),
    handler(ctx, transitionHandler(ctx)));
}

function buildWave(ctx, body) {
  const id = str(body.id).trim();
  const name = str(body.name).trim();
  if (!id) throw new Error('wave requires an id');
  if (!name) throw new Error('wave requires a name');
  const templateId = body.templateId ? str(body.templateId) : null;
  // Pin the framework version at kickoff so a later template edit can't mutate a run.
  let version = null;
  if (templateId) version = ctx.engine.getTemplate(templateId).version;
  return {
    id,
    name,
    state: body.state ? str(body.state) : 'P1',
    framework_template_id: templateId,
    framework_version: version,
    plan: (body.plan && typeof body.plan === 'object') ? body.plan : {},
  };
}

// POST /api/waves/:id/transition — sign a gate transition via the engine's signed-gate
// path. The human signer is supplied in the body; the engine rejects agent/self-sign.
function transitionHandler(ctx) {
  return async (req, res) => {
    const wave = await ctx.store.getWave(str(req.params.id));
    if (!wave) return fail(res, 404, 'wave not found');
    if (!wave.framework_template_id) {
      return fail(res, 400, 'wave has no pinned framework template to transition');
    }
    const body = req.body || {};
    const to = str(body.to).trim();
    if (!to) return fail(res, 400, 'transition requires a target state: to');
    const signer = buildSigner(body.signer);
    const actor = str(body.actor || (req.principal && req.principal.id)).trim() || null;

    const machine = ctx.engine.machineFor(wave.framework_template_id);
    const result = await machine.signTransition({
      run: wave,
      to,
      actor,
      signer,
      evidence: Array.isArray(body.evidence) ? body.evidence : [],
      proof: body.proof || null,
    });
    const saved = await ctx.store.saveWave(Object.assign({}, wave, { state: result.state }));
    ok(res, { wave: saved, gate: result.gate, ledger: redactLedger(result.ledger) });
  };
}

// The signer is a HUMAN identity from the request. Shape it strictly; the engine
// enforces kind==='human' and author!==signer (it throws otherwise).
function buildSigner(raw) {
  const s = raw || {};
  const id = str(s.id).trim();
  if (!id) throw new Error('transition requires signer.id');
  return { id, kind: str(s.kind).trim() || 'human', role: s.role ? str(s.role) : null };
}

function mountClassify(app, ctx, auth) {
  app.get('/api/classify/:workloadId', auth, handler(ctx, async (req, res) => {
    const w = await ctx.store.getWorkload(str(req.params.workloadId));
    if (!w) return fail(res, 404, 'workload not found');
    const result = ctx.engine.classify({
      disposition: w.disposition || undefined,
      ...(w.attributes || {}),
    });
    ok(res, { workloadId: w.id, classification: result });
  }));
}

function mountReconcile(app, ctx, auth) {
  app.post('/api/reconcile', auth, requireCapability('migration:reconcile:run'),
    handler(ctx, async (req, res) => {
      const body = req.body || {};
      const workloadId = str(body.workloadId).trim();
      if (!workloadId) return fail(res, 400, 'reconcile requires a workloadId');
      const w = await ctx.store.getWorkload(workloadId);
      if (!w) return fail(res, 404, 'workload not found');
      const connector = connectorFor(ctx, body.connector);
      const unit = unitFromWorkload(w);
      const result = await ctx.engine.reconcile(unit, connector, {});
      ok(res, {
        workloadId: w.id,
        connector: connector.id,
        proofOk: result.ok,
        baselineFresh: result.baselineFresh,
        categories: result.categories,
        proof: result.proof,
      });
    }));
}

function mountLedger(app, ctx, auth) {
  app.get('/api/ledger', auth, handler(ctx, async (_req, res) => {
    const rows = await ctx.ledger.list({});
    ok(res, { entries: rows.map(redactLedger) });
  }));

  app.get('/api/ledger/verify', auth, handler(ctx, async (_req, res) => {
    const result = await ctx.ledger.verifyChain();
    ok(res, { verified: result.ok, brokenAt: result.brokenAt });
  }));
}

// Ledger rows are non-secret (hash chain + meta), but we never echo internal pool
// objects. Return only the audited, queryable fields.
function redactLedger(row) {
  if (!row) return null;
  return {
    seq: row.seq,
    ts: row.ts,
    actor: row.actor,
    signerRole: row.signerRole,
    action: row.action,
    evidenceHashes: row.evidenceHashes || [],
    meta: row.meta || {},
    prevHash: row.prevHash,
    hash: row.hash,
  };
}

// --------------------------------------------------------------------------
// mount(app, ctx) — entrypoint consumed by server.js
// --------------------------------------------------------------------------
function mount(app, ctx) {
  if (!ctx || !ctx.engine || !ctx.store || !ctx.ledger) {
    throw new Error('api routes require ctx.engine, ctx.store, ctx.ledger');
  }
  const auth = requireAuth(ctx);
  mountTemplates(app, ctx, auth);
  mountWorkloads(app, ctx, auth);
  mountWaves(app, ctx, auth);
  mountClassify(app, ctx, auth);
  mountReconcile(app, ctx, auth);
  mountLedger(app, ctx, auth);
}

module.exports = { mount };
