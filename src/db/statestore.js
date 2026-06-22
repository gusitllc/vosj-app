// src/db/statestore.js — StateStore implementations (§ contracts.StateStore).
// MemoryStateStore: zero-dependency fallback (STATE_STORE=memory).
// PgStateStore:     PostgreSQL-backed, parameterised SQL only.
// createStateStore(config) picks one by config.STATE_STORE.

'use strict';

const { StateStore } = require('../contracts');

// ---------------------------------------------------------------------------
// In-memory store
// ---------------------------------------------------------------------------
class MemoryStateStore extends StateStore {
  constructor() {
    super();
    this.kind = 'memory';
    this._workloads = new Map();
    this._waves = new Map();
    this._gates = new Map(); // key = `${id}:${migrationId}`
    this._ledger = [];
    this._toolLog = [];
    this._waivers = new Map();
  }

  async init() { return { ok: true }; }
  async health() { return { ok: true, kind: this.kind }; }

  async listWorkloads(filter = {}) {
    let rows = [...this._workloads.values()];
    if (filter.waveId) rows = rows.filter((w) => w.wave_id === filter.waveId);
    return rows;
  }
  async getWorkload(id) { return this._workloads.get(id) || null; }
  async saveWorkload(w) {
    const row = Object.assign({ created_at: new Date().toISOString() },
      this._workloads.get(w.id) || {}, w, { updated_at: new Date().toISOString() });
    this._workloads.set(w.id, row);
    return row;
  }

  async listWaves() { return [...this._waves.values()]; }
  async getWave(id) { return this._waves.get(id) || null; }
  async saveWave(wave) {
    const row = Object.assign({ created_at: new Date().toISOString() },
      this._waves.get(wave.id) || {}, wave, { updated_at: new Date().toISOString() });
    this._waves.set(wave.id, row);
    return row;
  }

  async getGate(id) {
    for (const g of this._gates.values()) if (g.id === id) return g;
    return null;
  }
  async listGates(filter = {}) {
    let rows = [...this._gates.values()];
    if (filter.migrationId) rows = rows.filter((g) => g.migrationId === filter.migrationId);
    return rows;
  }
  async saveGate(gate) {
    this._gates.set(`${gate.id}:${gate.migrationId || ''}`, gate);
    return gate;
  }

  async appendLedger(row) { this._ledger.push(row); return row; }
  async listLedger() { return this._ledger.slice(); }
  async lastLedger() { return this._ledger[this._ledger.length - 1] || null; }

  async appendToolLog(row) { this._toolLog.push(row); return row; }

  async listWaivers(filter = {}) {
    let rows = [...this._waivers.values()];
    if (filter.gateId) rows = rows.filter((w) => w.gate_id === filter.gateId);
    if (filter.checkName) rows = rows.filter((w) => w.check_name === filter.checkName);
    if (filter.status) rows = rows.filter((w) => (w.status || 'active') === filter.status);
    return rows;
  }
  async saveWaiver(w) {
    const row = Object.assign({ created_at: new Date().toISOString() },
      this._waivers.get(w.id) || {}, w);
    this._waivers.set(w.id, row);
    return row;
  }
}

// ---------------------------------------------------------------------------
// PostgreSQL store
// ---------------------------------------------------------------------------
class PgStateStore extends StateStore {
  constructor(pool) {
    super();
    this.kind = 'pg';
    this.pool = pool; // src/db/pool.js facade ({ query })
  }

  async init() { return { ok: true }; }
  async health() {
    const r = await this.pool.query('SELECT 1 AS ok');
    return { ok: r.rows[0].ok === 1, kind: this.kind };
  }

  async listWorkloads(filter = {}) {
    if (filter.waveId) {
      const r = await this.pool.query(
        'SELECT * FROM vosj.workloads WHERE wave_id = $1 ORDER BY created_at', [filter.waveId]);
      return r.rows;
    }
    const r = await this.pool.query('SELECT * FROM vosj.workloads ORDER BY created_at');
    return r.rows;
  }
  async getWorkload(id) {
    const r = await this.pool.query('SELECT * FROM vosj.workloads WHERE id = $1', [id]);
    return r.rows[0] || null;
  }
  async saveWorkload(w) {
    const r = await this.pool.query(
      `INSERT INTO vosj.workloads (id, name, disposition, state, wave_id, baseline_at, attributes)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (id) DO UPDATE SET
         name=$2, disposition=$3, state=$4, wave_id=$5, baseline_at=$6,
         attributes=$7, updated_at=now()
       RETURNING *`,
      [w.id, w.name, w.disposition || null, w.state || 'legacy', w.wave_id || null,
        w.baseline_at || null, w.attributes || {}]);
    return r.rows[0];
  }

  async listWaves() {
    const r = await this.pool.query('SELECT * FROM vosj.waves ORDER BY created_at');
    return r.rows;
  }
  async getWave(id) {
    const r = await this.pool.query('SELECT * FROM vosj.waves WHERE id = $1', [id]);
    return r.rows[0] || null;
  }
  async saveWave(wave) {
    const r = await this.pool.query(
      `INSERT INTO vosj.waves (id, name, state, framework_template_id, framework_version, plan)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (id) DO UPDATE SET
         name=$2, state=$3, framework_template_id=$4, framework_version=$5,
         plan=$6, updated_at=now()
       RETURNING *`,
      [wave.id, wave.name, wave.state || 'P1', wave.framework_template_id || null,
        wave.framework_version || null, wave.plan || {}]);
    return r.rows[0];
  }

  async getGate(id) {
    const r = await this.pool.query('SELECT * FROM vosj.gates WHERE id = $1 LIMIT 1', [id]);
    return r.rows[0] || null;
  }
  async listGates(filter = {}) {
    if (filter.migrationId) {
      const r = await this.pool.query(
        'SELECT * FROM vosj.gates WHERE migration_id = $1 ORDER BY signed_at', [filter.migrationId]);
      return r.rows;
    }
    const r = await this.pool.query('SELECT * FROM vosj.gates ORDER BY signed_at');
    return r.rows;
  }
  async saveGate(gate) {
    const r = await this.pool.query(
      `INSERT INTO vosj.gates (id, migration_id, unit_id, signed_by, signer_role, ledger_hash, signed_at)
       VALUES ($1,$2,$3,$4,$5,$6, COALESCE($7, now()))
       ON CONFLICT (id, migration_id) DO UPDATE SET
         unit_id=$3, signed_by=$4, signer_role=$5, ledger_hash=$6, signed_at=COALESCE($7, now())
       RETURNING *`,
      [gate.id, gate.migrationId || '', gate.unitId || null, gate.signedBy || null,
        gate.signerRole || null, gate.ledgerHash || null, gate.signedAt || null]);
    return r.rows[0];
  }

  async appendLedger(row) {
    const r = await this.pool.query(
      `INSERT INTO vosj.ledger (ts, actor, signer_role, action, evidence_hashes, meta, prev_hash, hash)
       VALUES (COALESCE($1, now()),$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [row.ts || null, row.actor || null, row.signerRole || null, row.action,
        JSON.stringify(row.evidenceHashes || []), row.meta || {}, row.prevHash, row.hash]);
    return r.rows[0];
  }
  async listLedger() {
    const r = await this.pool.query('SELECT * FROM vosj.ledger ORDER BY seq');
    return r.rows.map(mapLedgerRow);
  }
  async lastLedger() {
    const r = await this.pool.query('SELECT * FROM vosj.ledger ORDER BY seq DESC LIMIT 1');
    return r.rows[0] ? mapLedgerRow(r.rows[0]) : null;
  }

  async appendToolLog(row) {
    const r = await this.pool.query(
      `INSERT INTO vosj.tool_log (ts, server, tool, actor, arguments, result, duration_ms)
       VALUES (COALESCE($1, now()),$2,$3,$4,$5,$6,$7) RETURNING id`,
      [row.ts || null, row.server || null, row.tool, row.actor || null,
        row.arguments || {}, row.result || null, row.durationMs || null]);
    return r.rows[0];
  }

  async listWaivers(filter = {}) {
    const where = [];
    const args = [];
    if (filter.gateId) { args.push(filter.gateId); where.push(`gate_id = $${args.length}`); }
    if (filter.checkName) { args.push(filter.checkName); where.push(`check_name = $${args.length}`); }
    if (filter.status) { args.push(filter.status); where.push(`status = $${args.length}`); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const r = await this.pool.query(
      `SELECT * FROM vosj.waivers ${clause} ORDER BY created_at`, args);
    return r.rows;
  }
  async saveWaiver(w) {
    const r = await this.pool.query(
      `INSERT INTO vosj.waivers
         (id, gate_id, reason, granted_by, expires_at, check_name, check_class, scope, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (id) DO UPDATE SET
         gate_id=$2, reason=$3, granted_by=$4, expires_at=$5, check_name=$6,
         check_class=$7, scope=$8, status=$9
       RETURNING *`,
      [w.id, w.gate_id || null, w.reason, w.granted_by, w.expires_at || null,
        w.check_name || null, w.check_class || 'advisory', w.scope || null,
        w.status || 'active']);
    return r.rows[0];
  }
}

// Map snake_case ledger columns back to the ledger module's camelCase shape so
// verifyChain() recomputes the same HMAC it wrote.
function mapLedgerRow(r) {
  return {
    seq: Number(r.seq),
    ts: typeof r.ts === 'string' ? r.ts : new Date(r.ts).toISOString(),
    actor: r.actor,
    signerRole: r.signer_role,
    action: r.action,
    evidenceHashes: Array.isArray(r.evidence_hashes) ? r.evidence_hashes : [],
    meta: r.meta || {},
    prevHash: r.prev_hash,
    hash: r.hash,
  };
}

function createStateStore(config, pool) {
  if (config.STATE_STORE === 'pg') {
    if (!pool) throw new Error('pg StateStore requires a configured pool');
    return new PgStateStore(pool);
  }
  return new MemoryStateStore();
}

module.exports = { MemoryStateStore, PgStateStore, createStateStore };
