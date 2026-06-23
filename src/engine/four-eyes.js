// src/engine/four-eyes.js — Four-eyes change validation (Invariant 3, §12.5).
// Makes the named-but-uncoded P3 governance controls into MACHINE-CHECKABLE gate
// preconditions:
//
//   - Invariant 3 (four-eyes change validation, gaps 37/117): a change authored by
//     actor A is only "validated" when an INDEPENDENT validator V (V !== A AND V is
//     a HUMAN) records a diff-impact report. recordValidation() writes a
//     'change.validated' row to the tamper-evident ledger and marks the change
//     validated. A change can NEVER be self-validated by its author, and an AGENT
//     can never be the validator (mirrors Invariant 1's no-agent-self-sign posture).
//
//   - Independent rollback authoring (gap 35, §6 P3): the rollback runbook MUST be
//     authored by a DIFFERENT actor than the cutover runbook. isIndependentRollback-
//     Authored(waveId) asserts the rollback deliverable's author !== the cutover
//     runbook author — a separate agent in a separate context.
//
// COMPOSITION SEAM (file-disjoint from PKG-DISPO-GATE/state-machine.js): this module
// owns NO gate-firing code. It exposes pure criteria evaluators and registers itself
// on ctx as `ctx.fourEyes`. The P3 planning gate consults the single named function
// ctx.fourEyes.evaluateP3(waveId) -> bool; PKG-DISPO-GATE's evaluateGateCriteria can
// call it without either package editing the other's files. Absent registration the
// gate keeps its existing behaviour (additive, fail-soft like the waiver registry).
//
// PERSISTENCE: optional StateStore methods (saveChangeRequest/getChangeRequest/
// listChangeRequests) are used when present; otherwise an in-memory mirror backs the
// register (same fallback shape as src/vault/vault.js and the ledger). FAIL-CLOSED:
// nothing here invents an insecure default — an un-validated change is never treated
// as validated, and a missing validator/author is a rejection, never a pass.

'use strict';

// The canonical P3 criterion phrases from templates/caf.json. A gate is
// "four-eyes-bearing" / "independent-rollback-bearing" when it declares these, so a
// renamed gate that keeps the criterion is still enforced (data-driven, not hardcoded).
const FOUR_EYES_CRITERION = 'four-eyes validation complete';
const ROLLBACK_CRITERION = 'rollback authored independently';

// Deliverable kinds whose authorship must be independent (gap 35).
const CUTOVER_RUNBOOK = 'cutover-runbook';
const ROLLBACK_RUNBOOK = 'rollback-runbook';

class FourEyesRegistry {
  // store: optional StateStore-like with saveChangeRequest/getChangeRequest/
  //        listChangeRequests. When omitted (or the store lacks them), an in-memory
  //        mirror backs the register. ledger: required — validations are audited.
  constructor({ store = null, ledger }) {
    if (!ledger) throw new Error('FourEyesRegistry requires a ledger');
    this.store = store;
    this.ledger = ledger;
    this._mem = new Map();        // id -> change-request row (mirror / fallback sink)
    this._deliverables = new Map(); // `${waveId}:${kind}` -> { waveId, kind, author }
  }

  _storeHas(method) {
    return this.store && typeof this.store[method] === 'function';
  }

  // ---- change-request register --------------------------------------------
  // recordChange({ id, waveId, author }) -> { ok, change } | { ok:false, error }.
  // Opens a pending change authored by `author`. author is mandatory and fail-closed:
  // a change with no author can never satisfy four-eyes (no one to be independent of).
  async recordChange({ id, waveId = null, author } = {}) {
    if (!id) return { ok: false, error: 'change requires an id' };
    if (!author) return { ok: false, error: 'change requires an author' };
    const existing = await this._get(id);
    const row = Object.assign(
      { created_at: new Date().toISOString() },
      existing || {},
      { id, wave_id: waveId, author, status: existing ? existing.status : 'pending' }
    );
    await this._save(row);
    return { ok: true, change: projectChange(row) };
  }

  // recordValidation({ changeId, author, validator, diffImpact }) -> signed result.
  // Enforces Invariant 3 fail-closed:
  //   - validator must be a HUMAN (validator.kind === 'human') — no agent self-validate;
  //   - validator !== author (independent reviewer — separation of duties);
  //   - a diff-impact report must be supplied.
  // On success writes a 'change.validated' ledger row and marks the change validated.
  async recordValidation({ changeId, author = null, validator, diffImpact } = {}) {
    if (!changeId) return { ok: false, error: 'recordValidation requires changeId' };

    const change = await this._get(changeId);
    // The change must already be registered (its author is the authority of record).
    if (!change) return { ok: false, error: `unknown change: ${changeId}` };
    // Author of record wins; an override that disagrees is rejected (no laundering).
    if (author && author !== change.author) {
      return { ok: false, error: 'recordValidation author does not match the change author of record' };
    }
    const changeAuthor = change.author;

    // (1) Human-only validator — mirrors Invariant 1 (no agent self-sign).
    if (!validator || validator.kind !== 'human') {
      return { ok: false, error: 'four-eyes rejected: validator must be human (no agent self-validate)' };
    }
    // (2) Independence — validator cannot be the change author (Invariant 2/3).
    if (validator.id && changeAuthor && validator.id === changeAuthor) {
      return { ok: false, error: 'four-eyes rejected: validator cannot be the change author (not independent)' };
    }
    // (3) A diff-impact report is mandatory evidence.
    if (!diffImpact) {
      return { ok: false, error: 'four-eyes rejected: a diff-impact report is required' };
    }

    const row = await this.ledger.append({
      actor: changeAuthor,
      action: 'change.validated',
      evidenceHashes: [`diff-impact:${stableHash(diffImpact)}`],
      meta: {
        changeId,
        waveId: change.wave_id || null,
        author: changeAuthor,
        validatorId: validator.id || null,
        validatorRole: validator.role || null,
      },
    });

    const validated = Object.assign({}, change, {
      status: 'validated',
      validator: validator.id || null,
      diff_impact: diffImpact,
      validated_at: row.ts,
    });
    await this._save(validated);
    return { ok: true, change: projectChange(validated), ledger: row };
  }

  // isFourEyesSatisfied(waveId) -> boolean. True only when AT LEAST ONE change in the
  // wave is validated AND every change in the wave is validated by an independent
  // human. Fail-closed: a wave with no validated change is NOT satisfied.
  async isFourEyesSatisfied(waveId) {
    const changes = await this._listForWave(waveId);
    if (changes.length === 0) return false;
    let anyValidated = false;
    for (const c of changes) {
      if (c.status !== 'validated') return false;
      if (!c.validator || !c.author || c.validator === c.author) return false;
      anyValidated = true;
    }
    return anyValidated;
  }

  // ---- independent rollback authoring (gap 35) ----------------------------
  // recordDeliverable({ waveId, kind, author }) registers an authored P3 deliverable
  // (e.g. the cutover runbook, the rollback runbook) so authorship independence can
  // be asserted at the planning gate.
  recordDeliverable({ waveId, kind, author } = {}) {
    if (!waveId || !kind || !author) {
      return { ok: false, error: 'deliverable requires waveId, kind and author' };
    }
    this._deliverables.set(`${waveId}:${kind}`, { waveId, kind, author });
    return { ok: true };
  }

  // isIndependentRollbackAuthored(waveId) -> boolean. True only when BOTH the cutover
  // runbook and the rollback runbook are registered AND authored by DIFFERENT actors
  // (a separate agent in a separate context). Fail-closed: a missing rollback runbook,
  // a missing cutover runbook, or a same-author pair is NOT independent.
  isIndependentRollbackAuthored(waveId) {
    const cutover = this._deliverables.get(`${waveId}:${CUTOVER_RUNBOOK}`);
    const rollback = this._deliverables.get(`${waveId}:${ROLLBACK_RUNBOOK}`);
    if (!cutover || !rollback) return false;
    if (!cutover.author || !rollback.author) return false;
    return cutover.author !== rollback.author;
  }

  // ---- the composition seam consumed by the P3 planning gate --------------
  // evaluateP3(waveId) -> boolean. The single named function PKG-DISPO-GATE's
  // evaluateGateCriteria calls so the two packages compose without editing each
  // other's files. Both P3 governance criteria must hold (fail-closed AND).
  async evaluateP3(waveId) {
    const fourEyes = await this.isFourEyesSatisfied(waveId);
    if (!fourEyes) return false;
    return this.isIndependentRollbackAuthored(waveId);
  }

  // ---- private persistence helpers ----------------------------------------
  async _get(id) {
    if (this._storeHas('getChangeRequest')) {
      const r = await this.store.getChangeRequest(id);
      if (r) return r;
    }
    return this._mem.get(id) || null;
  }

  async _save(row) {
    this._mem.set(row.id, row);
    if (this._storeHas('saveChangeRequest')) {
      await this.store.saveChangeRequest(row);
    }
    return row;
  }

  async _listForWave(waveId) {
    if (this._storeHas('listChangeRequests')) {
      const rows = await this.store.listChangeRequests({ waveId });
      if (Array.isArray(rows)) return rows;
    }
    return [...this._mem.values()].filter((c) => (c.wave_id || null) === (waveId || null));
  }
}

// projectChange — the {ok,...} envelope-friendly public view of a stored row.
function projectChange(row) {
  return {
    id: row.id,
    waveId: row.wave_id || null,
    author: row.author,
    validator: row.validator || null,
    status: row.status || 'pending',
    diffImpact: row.diff_impact || null,
    createdAt: row.created_at || null,
    validatedAt: row.validated_at || null,
  };
}

// stableHash — a deterministic, dependency-free fingerprint of the diff-impact report
// for the ledger evidence hash. Canonical JSON (sorted keys) so the same report always
// yields the same hash. Uses node:crypto SHA-256 (same primitive the ledger relies on).
function stableHash(obj) {
  const crypto = require('node:crypto');
  return crypto.createHash('sha256').update(canonical(obj), 'utf8').digest('hex');
}

function canonical(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(canonical).join(',') + ']';
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(obj[k])).join(',') + '}';
}

// buildFourEyes({ store, ledger }) -> FourEyesRegistry. attachFourEyes(ctx) wires the
// registry onto ctx.fourEyes so the P3 planning gate can consult ctx.fourEyes.evaluateP3
// (the declared integration seam). Returns the registry either way.
function buildFourEyes({ store = null, ledger }) {
  return new FourEyesRegistry({ store, ledger });
}

function attachFourEyes(ctx) {
  if (!ctx || !ctx.ledger) throw new Error('attachFourEyes requires ctx.ledger');
  if (!ctx.fourEyes) ctx.fourEyes = buildFourEyes({ store: ctx.store || null, ledger: ctx.ledger });
  return ctx.fourEyes;
}

module.exports = {
  FourEyesRegistry,
  buildFourEyes,
  attachFourEyes,
  FOUR_EYES_CRITERION,
  ROLLBACK_CRITERION,
  CUTOVER_RUNBOOK,
  ROLLBACK_RUNBOOK,
};
