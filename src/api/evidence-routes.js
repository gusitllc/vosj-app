// src/api/evidence-routes.js — exportable governance evidence package REST API
// (PKG-EVIDENCE-PACKAGE, gaps 128/123/122). A SEPARATE mount file (server.js
// mountOptional('./api/evidence-routes')) kept DISJOINT from routes.js so this
// package lands independently and a merge cannot collide on the shared routes file.
//
// One read-only route:
//   GET /api/waves/:id/evidence-package
//     requireAuth + requireCapability('migration:evidence:read')  (NEW capability)
// It returns a self-contained, OFFLINE-VERIFIABLE bundle (signed ledger + embedded
// verifyChain proof + waiver register + reconciliation proofs + tool/order audit +
// pinned framework binding) plus a static control-map manifest cross-referenced to
// ISO 38500 / COBIT 2019 / ITIL 4 / IIA Three Lines / SOC2-SOX ITGC.
//
// NEW CAPABILITY (flag to eng-director): migration:evidence:read is added to the CE
// contributor capability set in auth.js. It overlaps the one-new-capability
// convention shared with PKG-TEMPLATE-LIFECYCLE / PKG-PER-TOOL-RBAC; when a
// CONFIGURED RBAC registry is used, grant it to the auditor/reviewer role.

'use strict';

const { requireAuth, requireCapability } = require('./auth');
const { buildEvidenceExport } = require('../engine/evidence-export');

function ok(res, data) { return res.json(Object.assign({ ok: true }, data)); }
function fail(res, code, error) { return res.status(code).json({ ok: false, error }); }

// Wrap an async handler so a thrown error becomes a clean { ok:false } envelope.
// 'wave not found' maps to 404; everything else to 400. Never leaks a stack.
function handler(ctx, fn) {
  return async function wrapped(req, res) {
    try {
      await fn(req, res);
    } catch (e) {
      if (ctx.log) ctx.log('ERROR', `api ${req.method} ${req.path}`, e.message);
      if (res.headersSent) return;
      const code = /not found/i.test(e.message || '') ? 404 : 400;
      fail(res, code, e.message || 'request failed');
    }
  };
}

function str(v) { return (v === undefined || v === null) ? '' : String(v); }

function mountEvidence(app, ctx, auth) {
  // The exporter REUSES ctx.ledger + ctx.store (no duplicated scanner / migration).
  const exporter = buildEvidenceExport({ ledger: ctx.ledger, store: ctx.store });

  app.get('/api/waves/:id/evidence-package', auth,
    requireCapability('migration:evidence:read'),
    handler(ctx, async (req, res) => {
      const result = await exporter.buildPackage(str(req.params.id));
      ok(res, { package: result.package });
    }));
}

function mount(app, ctx) {
  if (!ctx || !ctx.ledger || !ctx.store) {
    throw new Error('evidence routes require ctx.ledger and ctx.store');
  }
  const auth = requireAuth(ctx);
  mountEvidence(app, ctx, auth);
}

module.exports = { mount };
