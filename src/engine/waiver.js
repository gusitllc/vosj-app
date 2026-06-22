// src/engine/waiver.js — advisory-only waiver enforcement (§12 second-line control).
// Closes the "waiver enforcement" design open-question ADDITIVELY: when a SOFT /
// advisory readiness or scorecard check fails, the engine may consult vosj.waivers
// for an active, non-expired, correctly-scoped waiver and, if found, allow the
// advisory check to pass — RECORDING an audited 'waiver.use' row in the ledger.
//
// HARD GUARDRAIL (structurally unwaivable). A waiver can NEVER bypass:
//   - verified-before-cutover  (gate.js, reconcile.js — proof.ok required)
//   - no-agent-self-sign       (contracts.GateSigner.assertHumanIndependent)
//   - separation-of-duties     (author !== signer)
//   - ledger fail-closed       (ledger.js — missing HMAC key throws)
//   - baseline-drift           (reconcile.js isFreshBaseline)
// Those live in OTHER modules and are NOT touched here. This module additionally
// refuses, at the application boundary, to apply ANY waiver whose check is not
// classed 'advisory' or whose name is on the reserved hard-invariant list — even
// if such a waiver row somehow exists in the table. Fail-closed: no ledger key =>
// no waiver applied (the ledger.append throws and propagates).

'use strict';

// Reserved check names that name a hard invariant. A waiver MUST NEVER apply to
// any of these regardless of how the row is classed — defence in depth.
const HARD_INVARIANT_CHECKS = Object.freeze([
  'verified-before-cutover',
  'verified_before_cutover',
  'no-agent-self-sign',
  'separation-of-duties',
  'ledger-fail-closed',
  'baseline-drift',
  'baseline_drift',
]);

const ADVISORY = 'advisory';

// isWaivable(check) -> boolean. ONLY an advisory-classed check whose name is not a
// reserved hard invariant may ever be waived. Default-deny for unknown classes.
function isWaivable(check) {
  if (!check || typeof check !== 'object') return false;
  if (check.class !== ADVISORY) return false;
  const name = String(check.name || '').toLowerCase();
  if (!name) return false;
  return !HARD_INVARIANT_CHECKS.includes(name);
}

function isActive(row, now) {
  if (!row) return false;
  if ((row.status || 'active') !== 'active') return false;
  const exp = row.expires_at ? Date.parse(row.expires_at) : NaN;
  if (Number.isFinite(exp) && exp <= now) return false; // expired => not active
  return true;
}

function scopeMatches(row, scope) {
  if (!row.scope) return true;        // an unscoped waiver applies broadly
  if (!scope) return false;           // a scoped waiver needs a matching scope
  return String(row.scope) === String(scope);
}

// WaiverRegistry — the engine seam. Constructed with { store, ledger }.
class WaiverRegistry {
  constructor({ store = null, ledger = null } = {}) {
    this.store = store;
    this.ledger = ledger;
  }

  // findActive(check) -> the matching active waiver row, or null. Returns null for
  // a non-waivable check WITHOUT querying the store (structural refusal).
  async findActive(check) {
    if (!isWaivable(check)) return null;
    if (!this.store || typeof this.store.listWaivers !== 'function') return null;
    const rows = await this.store.listWaivers({
      gateId: check.gateId || undefined,
      checkName: check.name,
      status: 'active',
    });
    const now = Date.now();
    return rows.find((r) => isActive(r, now) && scopeMatches(r, check.scope)) || null;
  }

  // tryWaive(check, actor) -> { waived:boolean, waiver?, ledger? }.
  // Applies an advisory waiver if one is active, recording an audited 'waiver.use'
  // ledger row (fail-closed: a missing HMAC key makes ledger.append throw). A
  // non-waivable (hard-invariant) check ALWAYS returns { waived:false } and is
  // never recorded as waived.
  async tryWaive(check, actor) {
    if (!isWaivable(check)) return { waived: false, reason: 'check is not waivable' };
    const waiver = await this.findActive(check);
    if (!waiver) return { waived: false, reason: 'no active waiver' };
    const row = await this._record(check, waiver, actor);
    return { waived: true, waiver, ledger: row };
  }

  async _record(check, waiver, actor) {
    if (!this.ledger || typeof this.ledger.append !== 'function') {
      throw new Error('waiver fail-closed: a ledger is required to record waiver use');
    }
    return this.ledger.append({
      actor: actor || null,
      action: 'waiver.use',
      evidenceHashes: [`waiver:${waiver.id}`],
      meta: {
        waiverId: waiver.id,
        gateId: check.gateId || waiver.gate_id || null,
        checkName: check.name,
        checkClass: ADVISORY,
        scope: check.scope || waiver.scope || null,
        grantedBy: waiver.granted_by || null,
        reason: waiver.reason || null,
      },
    });
  }
}

// evaluateChecks(checks, registry, actor) -> { ok, results[] }.
// For a list of advisory/scorecard check results, lets an active waiver flip a
// FAILED advisory check to passing-with-waiver. Hard-invariant checks are reported
// as-is and can never be waived. A passing check is returned unchanged.
async function evaluateChecks(checks, registry, actor) {
  const results = [];
  for (const check of checks || []) {
    results.push(await evaluateOne(check, registry, actor));
  }
  return { ok: results.every((r) => r.ok), results };
}

async function evaluateOne(check, registry, actor) {
  if (check && check.ok) return { name: check.name, ok: true, waived: false };
  if (!registry) return failed(check, 'no waiver registry');
  const r = await registry.tryWaive(check, actor);
  if (r.waived) {
    return { name: check.name, ok: true, waived: true, waiverId: r.waiver.id };
  }
  return failed(check, r.reason);
}

function failed(check, reason) {
  return { name: check && check.name, ok: false, waived: false, reason };
}

module.exports = {
  WaiverRegistry, evaluateChecks, isWaivable,
  HARD_INVARIANT_CHECKS, ADVISORY,
};
