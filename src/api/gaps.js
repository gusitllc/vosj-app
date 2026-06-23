// src/api/gaps.js — Implementation Gap Tracker API.
// Tracks each whitepaper claim's code status + work progress + the virtual persona
// assigned to execute it (live board at /progress.html). Seeds vosj.gaps from the
// baked src/db/gaps-seed.json on first boot when the table is empty.
//   GET   /api/gaps            -> { ok, gaps[] }
//   PATCH /api/gaps/:id        -> update work_status | pct_complete | assignee | validator | notes | priority
// Works in pg mode (persistent) and falls back to an in-memory copy in memory mode.
'use strict';

const fs = require('fs');
const path = require('path');
const { requireAuth, requireCapability } = require('./auth');
const pool = require('../db/pool');

const SEED = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'db', 'gaps-seed.json'), 'utf8')); }
  catch (_) { return []; }
})();
const EDITABLE = ['work_status', 'pct_complete', 'assignee', 'validator', 'notes', 'priority'];

function ok(res, data) { return res.json(Object.assign({ ok: true }, data)); }
function fail(res, code, error) { return res.status(code).json({ ok: false, error }); }

// in-memory fallback (memory mode) — non-persistent, seeded once
let mem = null;
function memRows() {
  if (!mem) mem = SEED.map((g, i) => Object.assign({ id: i + 1, updated_at: null }, g));
  return mem;
}

// Seed vosj.gaps from the baked seed when the table is empty (pg mode only).
async function ensureSeeded(ctx) {
  if (!pool.dbConfigured || !SEED.length) return;
  const c = await pool.query('SELECT count(*)::int AS n FROM vosj.gaps');
  if (c.rows[0].n > 0) return;
  if (ctx.log) ctx.log('INFO', `seeding vosj.gaps with ${SEED.length} claims`);
  for (const g of SEED) {
    await pool.query(
      `INSERT INTO vosj.gaps
         (area, wp_section, claim, wp_status, severity, scope, evidence, work_status, pct_complete, assignee, validator, priority)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [g.area, g.wp_section, g.claim, g.wp_status, g.severity, g.scope, g.evidence,
        g.work_status, g.pct_complete, g.assignee, g.validator, g.priority],
    );
  }
}

function mount(app, ctx) {
  const auth = requireAuth(ctx);
  // seed without blocking mount; never crash the server on a seed error.
  ensureSeeded(ctx).catch((e) => ctx.log && ctx.log('WARN', `gaps seed failed: ${e.message}`));

  app.get('/api/gaps', auth, async (_req, res) => {
    try {
      if (!pool.dbConfigured) return ok(res, { gaps: memRows() });
      const r = await pool.query('SELECT * FROM vosj.gaps ORDER BY priority, area, id');
      return ok(res, { gaps: r.rows });
    } catch (e) { return fail(res, 500, e.message); }
  });

  app.patch('/api/gaps/:id', auth, requireCapability('migration:workload:write'), async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isInteger(id)) return fail(res, 400, 'invalid id');
      const body = req.body || {};
      const updates = EDITABLE.filter((k) => body[k] !== undefined);
      if (!updates.length) return fail(res, 400, `nothing to update (editable: ${EDITABLE.join(', ')})`);

      if (!pool.dbConfigured) {
        const row = memRows().find((g) => g.id === id);
        if (!row) return fail(res, 404, 'gap not found');
        updates.forEach((k) => { row[k] = body[k]; });
        return ok(res, { gap: row });
      }
      const set = updates.map((k, i) => `${k}=$${i + 1}`);
      const vals = updates.map((k) => body[k]);
      vals.push(id);
      const r = await pool.query(
        `UPDATE vosj.gaps SET ${set.join(', ')}, updated_at=now() WHERE id=$${vals.length} RETURNING *`, vals);
      if (!r.rows.length) return fail(res, 404, 'gap not found');
      return ok(res, { gap: r.rows[0] });
    } catch (e) { return fail(res, 500, e.message); }
  });
}

module.exports = { mount };
