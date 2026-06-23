// src/api/template-routes.js — framework-template lifecycle REST API (§8.3).
// A SEPARATE mount file (server.js mountOptional('./api/template-routes')) kept
// disjoint from routes.js so PKG-TEMPLATE-LIFECYCLE can land independently. Every
// route requires auth; every mutation additionally requires the NEW capability
// migration:template:write (declared in auth.js CE_CAPABILITIES).
//
// The engine's templateStore (DB-backed) does the real work. When the store has no
// template persistence (a bare store), templateStore is null and the routes report
// a clean 503 rather than crashing the spine (fail-soft mount).

'use strict';

const { requireAuth, requireCapability } = require('./auth');

function ok(res, data) { return res.json(Object.assign({ ok: true }, data)); }
function fail(res, code, error) { return res.status(code).json({ ok: false, error }); }

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

// The store lifecycle facade; 503 when unavailable so callers get a clean envelope.
function storeOf(ctx, res) {
  const ts = ctx.engine && ctx.engine.templateStore;
  if (!ts) {
    fail(res, 503, 'template persistence not available (store has no template backend)');
    return null;
  }
  return ts;
}

// Filesystem-seed fallbacks so a clone/diff can reference a baked template (gap 59).
function fallbacks(ctx) {
  return {
    fallbackGet: (id) => {
      const tpl = ctx.engine.fsTemplate ? ctx.engine.fsTemplate(id) : null;
      return tpl || null;
    },
    fallbackRoles: () => [],
  };
}

// Resolve the calling principal's tenant/owner for scoping a created/cloned template.
function principalScope(req) {
  const p = req.principal || {};
  return {
    owner: p.id || null,
    tenantId: p.tenantId || (req.headers && req.headers['x-vosj-tenant']) || null,
  };
}

function mountList(app, ctx, auth) {
  app.get('/api/templates/lifecycle', auth, handler(ctx, async (req, res) => {
    const ts = storeOf(ctx, res); if (!ts) return;
    const filter = {};
    if (req.query.visibility) filter.visibility = str(req.query.visibility);
    if (req.query.tenantId) filter.tenantId = str(req.query.tenantId);
    if (req.query.status) filter.status = str(req.query.status);
    ok(res, { templates: await ts.list(filter) });
  }));
}

function mountCreate(app, ctx, auth) {
  app.post('/api/templates', auth, requireCapability('migration:template:write'),
    handler(ctx, async (req, res) => {
      const ts = storeOf(ctx, res); if (!ts) return;
      const body = req.body || {};
      const scope = principalScope(req);
      const opts = {
        owner: scope.owner,
        tenantId: scope.tenantId,
        visibility: body.visibility ? str(body.visibility) : undefined,
        fromSkeleton: Boolean(body.fromSkeleton),
      };
      const draft = (body.template && typeof body.template === 'object') ? body.template : body;
      const tpl = await ts.create(draft, opts);
      ok(res, { template: tpl });
    }));
}

function mountClone(app, ctx, auth) {
  app.post('/api/templates/:id/clone', auth, requireCapability('migration:template:write'),
    handler(ctx, async (req, res) => {
      const ts = storeOf(ctx, res); if (!ts) return;
      const body = req.body || {};
      const scope = principalScope(req);
      const tpl = await ts.clone(str(req.params.id), Object.assign({
        id: body.id ? str(body.id) : undefined,
        visibility: body.visibility ? str(body.visibility) : undefined,
        owner: scope.owner,
        tenantId: scope.tenantId,
      }, fallbacks(ctx)));
      ok(res, { template: tpl });
    }));
}

function mountEdit(app, ctx, auth) {
  app.patch('/api/templates/:id', auth, requireCapability('migration:template:write'),
    handler(ctx, async (req, res) => {
      const ts = storeOf(ctx, res); if (!ts) return;
      const patch = (req.body && typeof req.body === 'object') ? req.body : {};
      const tpl = await ts.edit(str(req.params.id), patch);
      ok(res, { template: tpl });
    }));
}

function mountPublish(app, ctx, auth) {
  app.post('/api/templates/:id/publish', auth, requireCapability('migration:template:write'),
    handler(ctx, async (req, res) => {
      const ts = storeOf(ctx, res); if (!ts) return;
      const tpl = await ts.publish(str(req.params.id));
      ok(res, { template: tpl });
    }));
}

function mountDiff(app, ctx, auth) {
  app.get('/api/templates/:id/diff', auth, handler(ctx, async (req, res) => {
    const ts = storeOf(ctx, res); if (!ts) return;
    const result = await ts.diff(str(req.params.id), fallbacks(ctx));
    ok(res, { diff: result });
  }));
}

function mount(app, ctx) {
  if (!ctx || !ctx.engine) throw new Error('template routes require ctx.engine');
  const auth = requireAuth(ctx);
  mountList(app, ctx, auth);
  mountCreate(app, ctx, auth);
  mountClone(app, ctx, auth);
  mountEdit(app, ctx, auth);
  mountPublish(app, ctx, auth);
  mountDiff(app, ctx, auth);
}

module.exports = { mount };
