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

// The four citation fields a governed waiver MUST carry (§12.4, gap 125). A waiver
// is a *signed ledger row* — never a verbal override — so it must name the gate
// criterion waived (reason), the residual risk accepted, the compensating control
// in place, and the remediation plan that closes it. The waiver row's check_name
// already names the waived criterion; these are the accompanying citation fields.
// Stored snake_case on the row (PG + memory store); read with a camelCase fallback.
const CITATION_FIELDS = Object.freeze([
  ['reason', 'reason'],
  ['residual_risk', 'residualRisk'],
  ['compensating_control', 'compensatingControl'],
  ['remediation_plan', 'remediationPlan'],
]);

// citationsOf(row) -> { reason, residualRisk, compensatingControl, remediationPlan }
// reading each field from its snake_case column with a camelCase fallback, trimmed.
function citationsOf(row) {
  const out = {};
  for (const [snake, camel] of CITATION_FIELDS) {
    const v = row && (row[snake] != null ? row[snake] : row[camel]);
    out[camel] = (v == null) ? '' : String(v).trim();
  }
  return out;
}

// The three citation fields that DISTINGUISH a governed gap-125 waiver from a bare
// legacy reason-only waiver. If a waiver supplies ANY of these it declares itself a
// governed waiver and MUST then supply ALL FOUR (reason + these three) — a partial
// citation set is rejected fail-closed regardless of strict mode (a half-cited
// waiver is never a governed waiver). 'reason' is excluded here because the legacy
// minimal waiver carries only reason.
const GOVERNED_CITATION_FIELDS = Object.freeze(
  CITATION_FIELDS.filter(([snake]) => snake !== 'reason'));

// missingCitations(row) -> string[] of the camelCase citation fields absent/blank.
// A fully-cited waiver has none missing (fail-closed: an incomplete governed waiver
// is not a governed waiver and must not be applied).
function missingCitations(row) {
  const c = citationsOf(row);
  return CITATION_FIELDS.map(([, camel]) => camel).filter((k) => !c[k]);
}

// declaresGovernance(row) -> true if the waiver supplies any of the three governed
// citation fields (residualRisk / compensatingControl / remediationPlan).
function declaresGovernance(row) {
  const c = citationsOf(row);
  return GOVERNED_CITATION_FIELDS.some(([, camel]) => !!c[camel]);
}

// citationDefect(row, strict) -> a human-readable reason a waiver is NOT applicable
// on citation grounds, or null if it is acceptable.
//   - strict mode (production / gap-125 default): ALL FOUR citation fields required.
//   - non-strict (legacy seam): a bare reason-only waiver is accepted, BUT a waiver
//     that declares ANY governed field must still supply ALL FOUR — a partial
//     citation set is always rejected (fail-closed; no silent half-governed waiver).
function citationDefect(row, strict) {
  const missing = missingCitations(row);
  if (missing.length === 0) return null; // fully cited — always acceptable
  if (strict) {
    return `incomplete waiver missing citation field(s): ${missing.join(', ')}`;
  }
  if (declaresGovernance(row)) {
    return `partially-cited waiver missing citation field(s): ${missing.join(', ')}`;
  }
  return null; // legacy reason-only waiver in non-strict mode
}

// isWaivable(check) -> boolean. ONLY an advisory-classed check whose name is not a
// reserved hard invariant may ever be waived. Default-deny for unknown classes.
function isWaivable(check) {
  if (!check || typeof check !== 'object') return false;
  if (check.class !== ADVISORY) return false;
  const name = String(check.name || '').toLowerCase();
  if (!name) return false;
  return !HARD_INVARIANT_CHECKS.includes(name);
}

// isExpired(row, now) -> boolean. A waiver is an EXPIRING object: once its expiry
// passes it is no longer active and the waived criterion RE-FAILS (gap 125). A
// waiver with no expiry never expires by time (status/citations still gate it).
function isExpired(row, now = Date.now()) {
  if (!row || !row.expires_at) return false;
  const exp = Date.parse(row.expires_at);
  return Number.isFinite(exp) && exp <= now;
}

function isActive(row, now) {
  if (!row) return false;
  if ((row.status || 'active') !== 'active') return false;
  if (isExpired(row, now)) return false; // expired => not active => criterion re-fails
  return true;
}

function scopeMatches(row, scope) {
  if (!row.scope) return true;        // an unscoped waiver applies broadly
  if (!scope) return false;           // a scoped waiver needs a matching scope
  return String(row.scope) === String(scope);
}

// WaiverRegistry — the engine seam. Constructed with { store, ledger }.
//
// requireCitations gates the §12.4 / gap-125 governed-waiver rule in its STRICT
// form: when strict, a waiver lacking ANY of the four citation fields (reason,
// residualRisk, compensatingControl, remediationPlan) is an incomplete, non-governed
// waiver and is NOT applied — its use throws fail-closed and findActive skips it.
//
// Even when NOT strict, the fail-closed floor still holds: a waiver that declares
// ANY governed citation field (residualRisk/compensatingControl/remediationPlan) but
// omits one is rejected (a half-cited waiver is never a governed waiver — see
// citationDefect()). The strict/non-strict toggle ONLY governs whether a *bare
// reason-only* legacy waiver is still honoured, preserving the pre-gap-125 advisory
// seam without ever silently applying a half-governed waiver.
//
// Resolution (the ONE place the default is decided): an explicit constructor boolean
// wins; otherwise env VOSJ_WAIVER_REQUIRE_CITATIONS — 'true'/'1'/'on'/'yes' turns
// STRICT on (recommended for production). The unset default is non-strict so the
// legacy reason-only seam keeps working; production turns strict on via env or by
// passing requireCitations:true.
function resolveRequireCitations(explicit) {
  if (typeof explicit === 'boolean') return explicit;
  const raw = String(process.env.VOSJ_WAIVER_REQUIRE_CITATIONS || '').trim().toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'on' || raw === 'yes';
}

class WaiverRegistry {
  constructor({ store = null, ledger = null, requireCitations } = {}) {
    this.store = store;
    this.ledger = ledger;
    this.requireCitations = resolveRequireCitations(requireCitations);
  }

  // findActive(check) -> the matching active waiver row, or null. Returns null for
  // a non-waivable check WITHOUT querying the store (structural refusal). When
  // citations are required, a citation-incomplete row is treated as not-applicable
  // (fail-closed) so an incomplete waiver never silently passes the check.
  async findActive(check) {
    if (!isWaivable(check)) return null;
    if (!this.store || typeof this.store.listWaivers !== 'function') return null;
    const rows = await this.store.listWaivers({
      gateId: check.gateId || undefined,
      checkName: check.name,
      status: 'active',
    });
    const now = Date.now();
    return rows.find((r) => isActive(r, now)
      && scopeMatches(r, check.scope)
      && citationDefect(r, this.requireCitations) === null) || null;
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
    const citations = citationsOf(waiver);
    const defect = citationDefect(waiver, this.requireCitations);
    if (defect) {
      // An incomplete / half-governed waiver is not applied (fail-closed).
      throw new Error(`waiver fail-closed: ${defect}`);
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
        // The four citation fields the governed waiver row cites (§12.4, gap 125).
        reason: citations.reason || null,
        residualRisk: citations.residualRisk || null,
        compensatingControl: citations.compensatingControl || null,
        remediationPlan: citations.remediationPlan || null,
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
  WaiverRegistry, evaluateChecks, isWaivable, isExpired,
  citationsOf, missingCitations, citationDefect, declaresGovernance,
  resolveRequireCitations, CITATION_FIELDS, GOVERNED_CITATION_FIELDS,
  HARD_INVARIANT_CHECKS, ADVISORY,
};
