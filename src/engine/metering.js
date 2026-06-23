// src/engine/metering.js — per-workload effort/cost metering (§18 economics).
// Closes the metering half of "the four stations are observable + audited + METERED"
// (gap 1/5): /health previously reported counts only and §18 economics had no CE
// backing. recordEffort() appends one immutable usage row per signed transition or
// executor step; aggregate(waveId) sums effort + cost and groups by phase.
//
// Cost is config-driven (NEVER hardcoded at the call site): a caller may pass
// cost_units explicitly, otherwise metering derives it from the recorded effort and
// the configured unit price (config.costPerEffortUnit, env VOSJ_COST_PER_EFFORT_UNIT).
//
// Persistence is parameterised SQL only ($1..$n) against vosj.metering in pg mode;
// in memory mode (no DB) it keeps a process-local mirror so the spine and tests run
// without a database. This module is SELF-CONTAINED — it does not extend the
// StateStore (owned by a sibling package); it talks to the pool facade directly,
// matching the pattern in src/api/gaps.js.

'use strict';

const ONE = 1;

// buildMetering({ config, pool? }) -> { recordEffort, aggregate, _mem }.
// pool defaults to the shared db facade; tests may inject a stub (or omit it to use
// the in-memory mirror). The facade guards itself when the DB is not configured.
function buildMetering({ config, pool } = {}) {
  if (!config) throw new Error('metering requires config');
  const db = pool || safeRequirePool();
  const mem = [];

  function unitPrice() {
    const p = Number(config.costPerEffortUnit);
    return Number.isFinite(p) ? p : 0;
  }

  // effortUnits(effortMs) — one "effort unit" == one millisecond of recorded effort.
  // Cost = effortUnits * unitPrice, unless the caller supplied an explicit cost.
  function resolveCost(effortMs, costUnits) {
    if (costUnits !== undefined && costUnits !== null) {
      const c = Number(costUnits);
      return Number.isFinite(c) ? c : 0;
    }
    const ms = toNonNegInt(effortMs);
    return ms * unitPrice();
  }

  // recordEffort({ waveId, workloadId, phase, actor, effortMs, costUnits }) -> { ok, row }.
  // Fails CLOSED on a missing waveId — an unattributable usage row is rejected, never
  // silently dropped or attributed to a default wave (no insecure default).
  async function recordEffort(entry = {}) {
    const waveId = entry.waveId;
    if (!waveId) return { ok: false, error: 'recordEffort: waveId is required' };
    const effortMs = toNonNegInt(entry.effortMs);
    const cost = resolveCost(effortMs, entry.costUnits);
    const row = {
      wave_id: String(waveId),
      workload_id: entry.workloadId != null ? String(entry.workloadId) : null,
      phase: entry.phase != null ? String(entry.phase) : null,
      actor: entry.actor != null ? String(entry.actor) : null,
      effort_ms: effortMs,
      cost_units: cost,
      ts: new Date().toISOString(),
    };

    if (db && db.dbConfigured) {
      const r = await db.query(
        `INSERT INTO vosj.metering (wave_id, workload_id, phase, actor, effort_ms, cost_units)
         VALUES ($1,$2,$3,$4,$5,$6)
         RETURNING id, wave_id, workload_id, phase, actor, effort_ms, cost_units, ts`,
        [row.wave_id, row.workload_id, row.phase, row.actor, row.effort_ms, row.cost_units]);
      return { ok: true, row: r.rows[0] };
    }
    mem.push(Object.assign({ id: mem.length + ONE }, row));
    return { ok: true, row: mem[mem.length - ONE] };
  }

  // aggregate(waveId) -> { ok, waveId, totalEffortMs, totalCost, byPhase, count }.
  // byPhase maps each phase label to { effortMs, cost, count }. Pure read; never
  // mutates. Sums in pg mode via a parameterised GROUP BY, else over the mirror.
  async function aggregate(waveId) {
    if (!waveId) return { ok: false, error: 'aggregate: waveId is required' };
    const rows = await rowsFor(waveId);
    return summarise(waveId, rows);
  }

  async function rowsFor(waveId) {
    if (db && db.dbConfigured) {
      const r = await db.query(
        `SELECT phase, effort_ms, cost_units FROM vosj.metering WHERE wave_id = $1`,
        [String(waveId)]);
      return r.rows.map((x) => ({
        phase: x.phase, effort_ms: Number(x.effort_ms) || 0, cost_units: Number(x.cost_units) || 0,
      }));
    }
    return mem.filter((m) => m.wave_id === String(waveId));
  }

  return { recordEffort, aggregate, unitPrice, _mem: mem };
}

// summarise(waveId, rows) — fold rows into the aggregate envelope.
function summarise(waveId, rows) {
  let totalEffortMs = 0;
  let totalCost = 0;
  const byPhase = {};
  for (const r of rows) {
    const ms = Number(r.effort_ms) || 0;
    const cost = Number(r.cost_units) || 0;
    totalEffortMs += ms;
    totalCost += cost;
    const key = r.phase || 'unphased';
    if (!byPhase[key]) byPhase[key] = { effortMs: 0, cost: 0, count: 0 };
    byPhase[key].effortMs += ms;
    byPhase[key].cost += cost;
    byPhase[key].count += ONE;
  }
  return { ok: true, waveId: String(waveId), totalEffortMs, totalCost, byPhase, count: rows.length };
}

function toNonNegInt(v) {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function safeRequirePool() {
  try { return require('../db/pool'); } catch (_) { return null; }
}

module.exports = { buildMetering, summarise };
