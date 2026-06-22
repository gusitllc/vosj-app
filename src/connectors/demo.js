// src/connectors/demo.js — a WORKING demo connector for Vosj CE.
// Simulates a source->target migration entirely in memory so the engine, the API,
// and the UI all function out-of-the-box with STATE_STORE=memory and no real cloud.
// It returns a genuine structured verify() proof across the pre-switchover
// reconciliation categories (§13) so the verified-before-Jump gate can clear.

'use strict';

const crypto = require('crypto');
const { Connector } = require('../contracts');

class DemoConnector extends Connector {
  constructor(meta = {}) {
    super(Object.assign({ id: 'demo' }, meta));
    this._units = new Map(); // unitId -> simulated migration state
  }

  async discover(ctx) {
    // Return a small, deterministic inventory so the Vault station has data.
    return {
      ok: true,
      units: [
        { id: 'demo-web', name: 'Demo Web App', kind: 'app', rowCount: 12000 },
        { id: 'demo-db', name: 'Demo Database', kind: 'database', rowCount: 845231 },
      ],
    };
  }

  async replicate(unit, ctx) {
    const st = this._stateFor(unit);
    st.replicated = true;
    st.sourceRows = unit.rowCount || 1000;
    st.targetRows = st.sourceRows; // a clean replication mirrors row counts
    st.lagRows = 0;
    return { ok: true, unitId: unit.id, replicated: true };
  }

  // verify(unit) -> { ok, proof:{ categories[], hash } } across pre-switch categories.
  async verify(unit, ctx) {
    const st = this._stateFor(unit);
    const sourceRows = st.sourceRows || unit.rowCount || 1000;
    const targetRows = st.targetRows != null ? st.targetRows : sourceRows;
    const lag = st.lagRows != null ? st.lagRows : 0;

    const categories = [
      cat('replication_lag', lag === 0, `in-flight rows: ${lag}`),
      cat('row_counts', sourceRows === targetRows, `source=${sourceRows} target=${targetRows}`),
      cat('checksums', st.replicated === true, 'content hashes match (simulated)'),
      cat('sequence_identity', true, 'identity/sequence continuity verified (simulated)'),
      cat('constraints', true, 'keys/FKs/checks re-validated (simulated)'),
      cat('smoke', st.replicated === true, 'critical user journeys pass (simulated)'),
    ];
    const ok = categories.every((c) => c.ok);
    const proof = { categories, hash: hashOf({ unitId: unit.id, categories }) };
    return { ok, proof, categories };
  }

  async cutover(unit, ctx) {
    const st = this._stateFor(unit);
    if (!st.replicated) return { ok: false, error: 'cannot cut over before replication' };
    st.cutOver = true;
    return { ok: true, unitId: unit.id, cutOver: true };
  }

  async rollback(unit, ctx) {
    const st = this._stateFor(unit);
    st.cutOver = false;
    return { ok: true, unitId: unit.id, rolledBack: true };
  }

  _stateFor(unit) {
    const id = unit && unit.id;
    if (!this._units.has(id)) this._units.set(id, {});
    return this._units.get(id);
  }
}

function cat(name, ok, detail) { return { name, ok: Boolean(ok), detail }; }

function hashOf(obj) {
  return crypto.createHash('sha256').update(JSON.stringify(obj), 'utf8').digest('hex');
}

module.exports = { DemoConnector };
