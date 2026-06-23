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
    this._credentials = new Map(); // ref -> { ref, alg, ciphertext, iv, authTag, meta, ... }
    this._templates = new Map();   // id -> template row (snake_case, body JSONB shape)
    this._frameworkRoles = new Map(); // `${template_id}:${role_key}` -> row
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

  // Encrypted credential vault (§15.2). Stores ciphertext only — never plaintext.
  async putCredential(record) {
    this._credentials.set(record.ref, Object.assign({}, record));
    return { ok: true, ref: record.ref };
  }
  async getCredential(ref) {
    const r = this._credentials.get(ref);
    return r ? Object.assign({}, r) : null;
  }

  // Framework templates (§8.2). body holds the compiled phases/gates/states JSONB.
  async listTemplatesDb(filter = {}) {
    let rows = [...this._templates.values()];
    if (filter.visibility) rows = rows.filter((t) => t.visibility === filter.visibility);
    if (filter.tenantId) {
      rows = rows.filter((t) => t.visibility === 'public' || t.tenant_id === filter.tenantId);
    }
    if (filter.status) rows = rows.filter((t) => t.status === filter.status);
    return rows.map((r) => Object.assign({}, r));
  }
  async getTemplateDb(id) {
    const r = this._templates.get(id);
    return r ? Object.assign({}, r) : null;
  }
  async saveTemplateDb(t) {
    const row = Object.assign({ created_at: new Date().toISOString() },
      this._templates.get(t.id) || {}, t, { updated_at: new Date().toISOString() });
    this._templates.set(t.id, row);
    return Object.assign({}, row);
  }

  // Framework roles (§8.2, gap 55) — generalised role set per template.
  async listFrameworkRoles(templateId) {
    return [...this._frameworkRoles.values()]
      .filter((r) => r.template_id === templateId)
      .map((r) => Object.assign({}, r));
  }
  async saveFrameworkRole(role) {
    const key = `${role.template_id}:${role.role_key}`;
    this._frameworkRoles.set(key, Object.assign({}, role));
    return Object.assign({}, role);
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

  // Encrypted credential vault (§15.2) — parameterised SQL only, ciphertext only.
  // Re-putting a ref re-encrypts (rotation) and stamps rotated_at.
  async putCredential(record) {
    const r = await this.pool.query(
      `INSERT INTO vosj.credentials (ref, alg, ciphertext, iv, auth_tag, meta, created_at, rotated_at)
       VALUES ($1,$2,$3,$4,$5,$6, COALESCE($7, now()), $8)
       ON CONFLICT (ref) DO UPDATE SET
         alg=$2, ciphertext=$3, iv=$4, auth_tag=$5, meta=$6, rotated_at=now()
       RETURNING ref`,
      [record.ref, record.alg, record.ciphertext, record.iv, record.authTag,
        record.meta || {}, record.created_at || null, record.rotated_at || null]);
    return { ok: true, ref: r.rows[0].ref };
  }
  async getCredential(ref) {
    const r = await this.pool.query(
      'SELECT * FROM vosj.credentials WHERE ref = $1', [ref]);
    return r.rows[0] ? mapCredentialRow(r.rows[0]) : null;
  }

  // Framework templates (§8.2) — parameterised SQL only. body is compiled JSONB.
  async listTemplatesDb(filter = {}) {
    const where = [];
    const args = [];
    if (filter.visibility) { args.push(filter.visibility); where.push(`visibility = $${args.length}`); }
    if (filter.status) { args.push(filter.status); where.push(`status = $${args.length}`); }
    if (filter.tenantId) {
      args.push(filter.tenantId);
      where.push(`(visibility = 'public' OR tenant_id = $${args.length})`);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const r = await this.pool.query(
      `SELECT * FROM vosj.templates ${clause} ORDER BY created_at`, args);
    return r.rows;
  }
  async getTemplateDb(id) {
    const r = await this.pool.query('SELECT * FROM vosj.templates WHERE id = $1', [id]);
    return r.rows[0] || null;
  }
  async saveTemplateDb(t) {
    const r = await this.pool.query(
      `INSERT INTO vosj.templates
         (id, name, source, version, parent_template_id, visibility, status, body,
          owner, tenant_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (id) DO UPDATE SET
         name=$2, source=$3, version=$4, parent_template_id=$5, visibility=$6,
         status=$7, body=$8, owner=$9, tenant_id=$10, updated_at=now()
       RETURNING *`,
      [t.id, t.name, t.source || 'custom', t.version || '1', t.parent_template_id || null,
        t.visibility || 'public', t.status || 'draft', t.body || {},
        t.owner || null, t.tenant_id || null]);
    return r.rows[0];
  }

  // Framework roles (§8.2, gap 55).
  async listFrameworkRoles(templateId) {
    const r = await this.pool.query(
      'SELECT * FROM vosj.framework_roles WHERE template_id = $1 ORDER BY role_key', [templateId]);
    return r.rows;
  }
  async saveFrameworkRole(role) {
    const r = await this.pool.query(
      `INSERT INTO vosj.framework_roles (template_id, role_key, display, rbac_capability)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (template_id, role_key) DO UPDATE SET
         display=$3, rbac_capability=$4
       RETURNING *`,
      [role.template_id, role.role_key, role.display || null, role.rbac_capability || null]);
    return r.rows[0];
  }
}

// Map snake_case credential columns back to the vault module's camelCase shape so
// decrypt() reads ciphertext/iv/authTag consistently across the memory and pg stores.
function mapCredentialRow(r) {
  return {
    ref: r.ref,
    alg: r.alg,
    ciphertext: r.ciphertext,
    iv: r.iv,
    authTag: r.auth_tag,
    meta: r.meta || {},
    created_at: typeof r.created_at === 'string' || !r.created_at
      ? r.created_at : new Date(r.created_at).toISOString(),
    rotated_at: typeof r.rotated_at === 'string' || !r.rotated_at
      ? r.rotated_at : new Date(r.rotated_at).toISOString(),
  };
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
