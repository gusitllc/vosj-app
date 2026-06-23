// src/engine/acceptance.js — revocable acceptance + three-way contingency reversal
// (§13.2 'Net effect'; §6 P6 'Reconciliation pass — DBA, revocable within 30 min on
// drift'). This is the REVERSIBLE half of cutover. It is DISJOINT from the
// irreversible-forward cutover in state-machine.js (PKG-DISPO-GATE): cutoverUnit()
// is untouched. After a successful cutover the caller stamps acceptedAt here; the
// engine then permits two backward operations, each fail-closed and each audited:
//
//   revokeAcceptance  — the database authority unwinds a JUST-accepted cutover
//                        (within config.revocationWindowMs, default 30 min) on
//                        detected drift. One passing human signer; one ledger row
//                        ('cutover.revoke'); the unit flips back to 'reconciled'
//                        (gaps 36/130/135).
//
//   threeWayReversal  — a contingency reversal during execution requiring N-of-M
//                        DISTINCT human signers (config.reversalQuorum, default 3),
//                        so NO single actor can force or abort an in-flight cutover
//                        (gap 136). One ledger row per signer + a final
//                        'cutover.reverse' row; the unit flips back to 'reconciled'.
//
// Coexisting with the already-real proven-before-cutover guarantee, this closes the
// §13.2 'net effect' combination claim: provably equivalent before traffic moves AND
// reversible if not (gap 139).
//
// Human-ness / independence reuse the SAME semantics as the gate engine
// (contracts.GateSigner.assertHumanIndependent): a signer must be kind==='human'.
// schema.sql adds workloads.accepted_at + workloads.acceptance_status (shared with
// PKG-VAULT / PKG-METERING — additive, idempotent).

'use strict';

const { GateSigner } = require('../contracts');

// Acceptance lifecycle values stamped on the workload row (acceptance_status).
const ACCEPTANCE_STATUS = Object.freeze({
  PENDING: 'pending',
  ACCEPTED: 'accepted',
  REVOKED: 'revoked',
  REVERSED: 'reversed',
});

// The state a revoked/reversed unit returns to — the last proven-equivalent state
// BEFORE the irreversible forward cutover (reconciled -> migrated).
const REVERT_STATE = 'reconciled';

class AcceptanceWindow {
  // { ledger, store, config }. ledger is required (every operation is audited).
  // config supplies revocationWindowMs + reversalQuorum (see src/config.js).
  constructor({ ledger, store = null, config }) {
    if (!ledger) throw new Error('AcceptanceWindow requires a ledger');
    if (!config) throw new Error('AcceptanceWindow requires config');
    this.ledger = ledger;
    this.store = store;
    this.config = config;
  }

  // recordAcceptance({ unitId, actor, now }) — called by the cutover caller AFTER a
  // successful cutoverUnit(). Stamps accepted_at (the window start) and flips
  // acceptance_status to 'accepted'. Returns { ok, unit }.
  async recordAcceptance({ unitId, actor = null, now = Date.now() } = {}) {
    if (!unitId) return fail('unitId required');
    const unit = await this._loadUnit(unitId);
    if (!unit) return fail(`unknown unit: ${unitId}`);
    const acceptedAtIso = new Date(now).toISOString();
    const next = Object.assign({}, unit, {
      accepted_at: acceptedAtIso,
      acceptance_status: ACCEPTANCE_STATUS.ACCEPTED,
    });
    await this._saveUnit(next);
    return { ok: true, unit: next, acceptedAt: acceptedAtIso };
  }

  // revokeAcceptance({ unitId, signer, reason, now }) — fail-closed unless:
  //   (a) the unit was accepted and carries an acceptedAt, AND
  //   (b) (now - acceptedAt) <= config.revocationWindowMs, AND
  //   (c) a PASSING human signer authorises it (no agent self-revoke).
  // On success: writes a 'cutover.revoke' ledger row and flips state to 'reconciled'.
  async revokeAcceptance({ unitId, signer, reason, now = Date.now() } = {}) {
    if (!unitId) return fail('unitId required');
    if (!reason) return fail('a reason is required to revoke acceptance');

    const human = assertPassingHuman(signer);
    if (!human.ok) return fail(human.error);

    const unit = await this._loadUnit(unitId);
    if (!unit) return fail(`unknown unit: ${unitId}`);

    const acceptedAt = unitAcceptedAtMs(unit);
    if (acceptedAt === null) return fail('unit has no recorded acceptance to revoke');
    if (unit.acceptance_status === ACCEPTANCE_STATUS.REVOKED ||
        unit.acceptance_status === ACCEPTANCE_STATUS.REVERSED) {
      return fail(`unit acceptance is already ${unit.acceptance_status}`);
    }

    const windowMs = this.config.revocationWindowMs;
    const elapsed = now - acceptedAt;
    if (elapsed > windowMs) {
      // Fail-closed: the revocation window has CLOSED. The cutover stands; the
      // reversible half is no longer available via revoke (gap 36/135).
      return fail(`revocation window closed: ${elapsed}ms elapsed > ${windowMs}ms`);
    }

    const row = await this.ledger.append({
      actor: signer.id,
      signerRole: signer.role || null,
      action: 'cutover.revoke',
      evidenceHashes: [],
      meta: {
        unitId,
        migrationId: unit.migrationId || unit.migration_id || null,
        signerId: signer.id,
        reason,
        acceptedAt: new Date(acceptedAt).toISOString(),
        elapsedMs: elapsed,
        windowMs,
        fromState: unit.state || 'migrated',
        toState: REVERT_STATE,
      },
    });

    const next = await this._revert(unit, ACCEPTANCE_STATUS.REVOKED);
    return { ok: true, unit: next, state: REVERT_STATE, ledger: row };
  }

  // threeWayReversal({ unitId, signers[], reason, now }) — contingency reversal that
  // requires config.reversalQuorum (default 3) DISTINCT human signers. Reject if
  // fewer than quorum, if any signer is not human, or if any signer id is duplicated
  // (no single actor can force OR abort — gap 136). Records ONE ledger row per signer
  // ('cutover.reverse.signer') plus a FINAL 'cutover.reverse' row, then flips the
  // unit back to 'reconciled'. Unlike revoke, reversal is NOT time-boxed: it is the
  // in-flight contingency control, intentionally available beyond the revoke window.
  async threeWayReversal({ unitId, signers = [], reason, now = Date.now() } = {}) {
    if (!unitId) return fail('unitId required');
    if (!reason) return fail('a reason is required to reverse a cutover');

    const quorum = this.config.reversalQuorum;
    if (!Array.isArray(signers) || signers.length < quorum) {
      return fail(`three-way reversal requires ${quorum} distinct human signers`);
    }

    // Each signer must be human; ids must be DISTINCT (separation enforced across the
    // whole quorum, not just per-row). Validate the FULL set before any side effect.
    const seen = new Set();
    for (const s of signers) {
      const h = assertPassingHuman(s);
      if (!h.ok) return fail(h.error);
      if (seen.has(s.id)) return fail(`duplicate signer rejected: ${s.id}`);
      seen.add(s.id);
    }
    if (seen.size < quorum) return fail(`three-way reversal requires ${quorum} distinct human signers`);

    const unit = await this._loadUnit(unitId);
    if (!unit) return fail(`unknown unit: ${unitId}`);
    if (unit.acceptance_status === ACCEPTANCE_STATUS.REVERSED) {
      return fail('unit acceptance is already reversed');
    }

    // One ledger row per signer (each human's distinct authorisation is recorded).
    const signerRows = [];
    for (const s of signers) {
      const row = await this.ledger.append({
        actor: s.id,
        signerRole: s.role || null,
        action: 'cutover.reverse.signer',
        evidenceHashes: [],
        meta: { unitId, signerId: s.id, reason, quorum },
      });
      signerRows.push(row);
    }

    // Final aggregate row that records the reversal as authorised by the full quorum.
    const finalRow = await this.ledger.append({
      actor: signers[0].id,
      signerRole: signers[0].role || null,
      action: 'cutover.reverse',
      evidenceHashes: signerRows.map((r) => `signer:${r.hash}`),
      meta: {
        unitId,
        migrationId: unit.migrationId || unit.migration_id || null,
        reason,
        quorum,
        signerIds: signers.map((s) => s.id),
        fromState: unit.state || 'migrated',
        toState: REVERT_STATE,
      },
    });

    const next = await this._revert(unit, ACCEPTANCE_STATUS.REVERSED);
    return { ok: true, unit: next, state: REVERT_STATE, ledger: finalRow, signerLedger: signerRows };
  }

  // ---- internals ----------------------------------------------------------

  async _loadUnit(unitId) {
    if (this.store && typeof this.store.getWorkload === 'function') {
      return this.store.getWorkload(unitId);
    }
    return null;
  }

  async _saveUnit(unit) {
    if (this.store && typeof this.store.saveWorkload === 'function') {
      return this.store.saveWorkload(unit);
    }
    return unit;
  }

  // Flip the unit back to the last proven state and stamp the terminal acceptance
  // status. Persisted through the store so the projection reflects the reversal.
  async _revert(unit, status) {
    const next = Object.assign({}, unit, { state: REVERT_STATE, acceptance_status: status });
    await this._saveUnit(next);
    return next;
  }
}

// assertPassingHuman(signer) -> { ok:true } | { ok:false, error }. Reuses the
// human-ness semantics of contracts.GateSigner.assertHumanIndependent (kind must be
// 'human'); there is no gate author here, so independence is the distinctness check
// the callers enforce. Returns a result rather than throwing so the {ok,error}
// envelope is preserved end-to-end.
function assertPassingHuman(signer) {
  if (!signer || !signer.id) return { ok: false, error: 'signer must carry an id' };
  try {
    // Pass an author-less gate so assertHumanIndependent enforces ONLY the human
    // kind rule (the same rule the gate engine applies, not a parallel copy).
    GateSigner.assertHumanIndependent({}, signer);
  } catch (e) {
    return { ok: false, error: e.message };
  }
  return { ok: true };
}

// unitAcceptedAtMs(unit) -> epoch ms of the recorded acceptance, or null if none.
function unitAcceptedAtMs(unit) {
  const raw = unit && (unit.accepted_at || unit.acceptedAt);
  if (!raw) return null;
  const ms = typeof raw === 'number' ? raw : Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

function fail(error) { return { ok: false, error }; }

module.exports = { AcceptanceWindow, ACCEPTANCE_STATUS, REVERT_STATE };
