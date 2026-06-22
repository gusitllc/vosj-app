// src/connectors/sdk.js — Connector SDK for Vosj CE (§16).
// Provides BaseConnector (a Connector with the §16.2 executor state machine,
// a structured verify() proof scaffold over the §13 reconciliation categories,
// and pre-flight guards the station conductor invokes but never bypasses) plus a
// connector registry so adding/swapping a provider is a config+connector task,
// not a redesign (§16.1, "durable pillars").
//
// To add a connector: extend BaseConnector, implement discover/replicate/
// _verifyCategories/cutover/rollback, then `registry.register(new MyConnector())`.

'use strict';

const crypto = require('crypto');
const { Connector } = require('../contracts');

// §16.2 executor lifecycle. Each unit a connector touches walks this FSM; the
// conductor steps it through the bridge and never bypasses the pre-flight checks.
const EXECUTOR_STATES = Object.freeze([
  'draft', 'validated', 'executing', 'completed', 'failed',
  'rolling_back', 'rolled_back',
]);

const EXECUTOR_TRANSITIONS = Object.freeze({
  draft: ['validated', 'failed'],
  validated: ['executing', 'failed'],
  executing: ['completed', 'failed', 'rolling_back'],
  completed: ['rolling_back'],
  failed: ['rolling_back', 'draft'],
  rolling_back: ['rolled_back', 'failed'],
  rolled_back: ['draft'],
});

// The §13 pre-switchover reconciliation categories every verify() must report.
// reconcile.js fails closed on any of these it does not see proven ok.
const VERIFY_CATEGORIES = Object.freeze([
  'replication_lag', 'row_counts', 'checksums',
  'sequence_identity', 'constraints', 'smoke',
]);

function sha256(obj) {
  const json = typeof obj === 'string' ? obj : JSON.stringify(obj);
  return crypto.createHash('sha256').update(json, 'utf8').digest('hex');
}

function category(name, ok, detail) {
  return { name, ok: Boolean(ok), detail: String(detail || '') };
}

// BaseConnector — extend this, not Connector directly, to inherit the executor
// state machine, pre-flight guard, and verify() proof assembly.
class BaseConnector extends Connector {
  constructor(meta = {}) {
    super(meta);
    this._exec = new Map(); // unitId -> { state, history[] }
  }

  // ----- executor state machine (§16.2) --------------------------------------
  executorState(unit) { return this._execFor(unit).state; }

  canAdvance(unit, to) {
    const from = this.executorState(unit);
    return Array.isArray(EXECUTOR_TRANSITIONS[from]) && EXECUTOR_TRANSITIONS[from].includes(to);
  }

  advance(unit, to) {
    const rec = this._execFor(unit);
    if (!this.canAdvance(unit, to)) {
      throw new Error(`executor: illegal transition ${rec.state} -> ${to}`);
    }
    rec.history.push({ from: rec.state, to, ts: new Date().toISOString() });
    rec.state = to;
    return rec.state;
  }

  // Pre-flight checks the conductor calls before executing. Subclasses override
  // _preflight() to add provider-specific validation; base ensures replication.
  async validate(unit, ctx) {
    const checks = await this._preflight(unit, ctx);
    const ok = checks.every((c) => c.ok);
    if (ok) this.advance(unit, 'validated');
    return { ok, checks };
  }

  async _preflight(unit, _ctx) {
    return [category('unit_identified', Boolean(unit && unit.id), 'unit has an id')];
  }

  // ----- verify() proof scaffold (§13) ---------------------------------------
  // Subclasses implement _verifyCategories(unit, ctx) -> [{name, ok, detail}].
  // This wrapper normalises to the 6 pre-switch categories, fails closed on any
  // missing one, and binds the result into a hashed proof reconcile.js consumes.
  async verify(unit, ctx) {
    const reported = await this._verifyCategories(unit, ctx);
    const byName = {};
    for (const c of (Array.isArray(reported) ? reported : [])) byName[c.name] = c;

    const categories = VERIFY_CATEGORIES.map((name) => {
      const c = byName[name];
      return category(name, c && c.ok, c ? c.detail : 'not reported (fail-closed)');
    });
    // carry any extra (e.g. post-cutover) categories the connector volunteered
    for (const c of (Array.isArray(reported) ? reported : [])) {
      if (!VERIFY_CATEGORIES.includes(c.name)) categories.push(category(c.name, c.ok, c.detail));
    }

    const ok = categories.every((c) => c.ok);
    const proof = { connector: this.id, unitId: unit && unit.id, categories };
    proof.hash = sha256(proof);
    return { ok, proof, categories };
  }

  async _verifyCategories(_unit, _ctx) {
    throw new Error(`${this.constructor.name}._verifyCategories() not implemented`);
  }

  _execFor(unit) {
    const id = (unit && unit.id) || '_';
    if (!this._exec.has(id)) this._exec.set(id, { state: 'draft', history: [] });
    return this._exec.get(id);
  }
}

// ConnectorRegistry — the §16.1 provider catalog. Connectors register by id; the
// engine/context resolves a connector by id at orchestration time.
class ConnectorRegistry {
  constructor() { this._byId = new Map(); }

  register(connector) {
    if (!connector || !connector.id) throw new Error('registry: connector needs an id');
    if (this._byId.has(connector.id)) throw new Error(`registry: duplicate id ${connector.id}`);
    this._byId.set(connector.id, connector);
    return connector;
  }

  get(id) { return this._byId.get(id); }
  has(id) { return this._byId.has(id); }
  list() { return Array.from(this._byId.values()).map((c) => ({ id: c.id, meta: c.meta })); }
  toMap() { return new Map(this._byId); }
}

module.exports = {
  BaseConnector,
  ConnectorRegistry,
  EXECUTOR_STATES,
  EXECUTOR_TRANSITIONS,
  VERIFY_CATEGORIES,
  sha256,
  category,
};
