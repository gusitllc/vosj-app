// src/connectors/sdk.js — Connector SDK for Vosj CE (§16).
// Provides BaseConnector (a Connector with the §16.2 executor state machine, a
// fail-closed verify() proof scaffold over the §13 reconciliation categories, and
// pre-flight guards the station conductor invokes but never bypasses) plus a
// connector registry so adding/swapping a provider is a config+connector task,
// not a redesign (§16.1, "durable pillars").
//
// To add a connector: extend BaseConnector, implement discover/replicate/cutover/
// rollback + a probe set (see _probes / _verifyCategories), then
// `registry.register(new MyConnector())`.
//
// HONEST verify() CONTRACT (§13): a category is reported ok ONLY when a probe has
// actually MEASURED equivalence. A probe whose underlying SDK call is not yet
// wired returns notVerified() — it does NOT fabricate a pass. So a connector with
// unimplemented seams fails closed: the verified-before-Jump gate stays unreachable
// until the real measurement exists.

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

// notVerified(reason) — the honest result of a probe whose real measurement has
// not run (SDK seam unimplemented, or replication not yet completed). It NEVER
// reports ok:true, so verify() cannot lie about an unproven category.
function notVerified(reason) {
  return { ok: false, detail: `not verified: ${reason || 'measurement unavailable'}` };
}

// verified(detail) — an affirmative probe result from a real measurement.
function verified(detail) {
  return { ok: true, detail: String(detail || 'verified') };
}

// MissingConfigError — thrown by requireConfig(); callers fail closed on it.
class MissingConfigError extends Error {
  constructor(keys) {
    super(`missing required config: ${keys.join(', ')}`);
    this.name = 'MissingConfigError';
    this.keys = keys;
  }
}

// BaseConnector — extend this, not Connector directly, to inherit the executor
// state machine, pre-flight guard, fail-closed config gating, and the probe-driven
// verify() proof assembly.
class BaseConnector extends Connector {
  constructor(meta = {}) {
    super(meta);
    this._exec = new Map();     // unitId -> { state, history[] }
    this._session = new Map();  // unitId -> replication session bookkeeping
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

  // ----- fail-closed config gating -------------------------------------------
  // requireConfig(ctx, keys) -> resolved config object, or throws MissingConfigError.
  // Reads from ctx.env first (testable), then process.env. No silent defaults.
  requireConfig(ctx, keys) {
    const env = (ctx && ctx.env) || process.env || {};
    const out = {};
    const missing = [];
    for (const k of keys) {
      const v = env[k];
      if (v === undefined || v === null || String(v) === '') missing.push(k);
      else out[k] = String(v);
    }
    if (missing.length) throw new MissingConfigError(missing);
    return out;
  }

  // Pre-flight checks the conductor calls before executing. Subclasses override
  // _preflight() to add provider-specific validation; base ensures unit identity.
  async validate(unit, ctx) {
    const checks = await this._preflight(unit, ctx);
    const ok = checks.every((c) => c.ok);
    if (ok && this.executorState(unit) === 'draft') this.advance(unit, 'validated');
    return { ok, checks };
  }

  async _preflight(unit, _ctx) {
    return [category('unit_identified', Boolean(unit && unit.id), 'unit has an id')];
  }

  // ----- verify() proof scaffold (§13) ---------------------------------------
  // Subclasses supply _probes(unit, ctx) -> { categoryName: async () => result }.
  // Each probe returns verified()/notVerified() (or { ok, detail }). The default
  // _verifyCategories runs every pre-switch probe; a missing or throwing probe is
  // recorded as notVerified (fail-closed), so an unwired connector cannot pass.
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

  // Default: drive the probe set. Returns one category per VERIFY_CATEGORIES, each
  // resolved from its probe. A probe that throws (e.g. SDK not wired) fails closed.
  async _verifyCategories(unit, ctx) {
    const probes = this._probes(unit, ctx) || {};
    const out = [];
    for (const name of VERIFY_CATEGORIES) {
      out.push(await this._runProbe(name, probes[name]));
    }
    return out;
  }

  async _runProbe(name, probe) {
    if (typeof probe !== 'function') {
      return category(name, false, 'not verified: no probe registered (fail-closed)');
    }
    try {
      const r = await probe();
      if (!r || typeof r.ok !== 'boolean') {
        return category(name, false, 'not verified: probe returned no result (fail-closed)');
      }
      return category(name, r.ok, r.detail);
    } catch (e) {
      return category(name, false, `not verified: probe error (fail-closed): ${e.message}`);
    }
  }

  // Subclasses MUST override _probes(); base throws so a half-built connector fails
  // loudly rather than silently passing verification.
  _probes(_unit, _ctx) {
    throw new Error(`${this.constructor.name}._probes() not implemented`);
  }

  // ----- replication session bookkeeping (real, not faked) -------------------
  _sessionFor(unit) {
    const id = (unit && unit.id) || '_';
    if (!this._session.has(id)) this._session.set(id, { started: false, measured: {} });
    return this._session.get(id);
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
  MissingConfigError,
  EXECUTOR_STATES,
  EXECUTOR_TRANSITIONS,
  VERIFY_CATEGORIES,
  sha256,
  category,
  verified,
  notVerified,
};
