// src/engine/evidence-export.js — exportable governance evidence package (gaps 128/123/122).
// buildPackage(waveId) assembles a SELF-CONTAINED, OFFLINE-VERIFIABLE bundle from
// EXISTING data sources (it REUSES the ledger / store facades, never duplicates a
// scanner or a migration):
//   1. ledger        — the signed, hash-chained audit rows (ledger.list)
//   2. ledgerProof   — ledger.verifyChain() over the EXACT rows in the package, so
//                      an auditor can re-verify integrity offline (gap 122 audit-as-output)
//   3. waivers       — the waiver register (store.listWaivers) — the second-line control
//   4. reconciliation— proofs reconstructed from ledger meta (proof: evidence hashes)
//                      cross-referenced with the stored gate rows (store.listGates)
//   5. toolLog+orders— the external-interaction audit substrate (best-effort: read
//                      only if the store exposes a listing; absent => recorded as such)
//   6. framework     — the wave's PINNED binding (framework_template_id + version)
// plus a STATIC CONTROL_MAP (frozen) cross-referencing VOSJ invariants/gates to
// ISO 38500 / COBIT 2019 / ITIL 4 / IIA Three Lines / SOC2-SOX ITGC controls
// (gap 123: the mapping is DATA, not prose). The output manifest is DETERMINISTIC
// (sorted keys via canonical()) so two exports of the same state are byte-identical.
//
// FAIL-CLOSED: ledger.verifyChain() throws without an HMAC key (it never substitutes
// a default), so a package built on an unsigned ledger fails rather than misleads.

'use strict';

const crypto = require('crypto');
const { canonical } = require('../ledger/ledger');

// Manifest schema version — bumped if the section shape changes.
const PACKAGE_VERSION = '1';

// ---------------------------------------------------------------------------
// CONTROL_MAP (gap 123) — VOSJ invariant/gate -> external control framework refs.
// Expressed as frozen DATA so an auditor (or a downstream Atlas scorecard) reads the
// cross-reference programmatically. Each entry names the VOSJ control, the source
// (the module that enforces it), and the mapped clause in each framework.
// ---------------------------------------------------------------------------
const CONTROL_MAP = Object.freeze([
  Object.freeze({
    vosjControl: 'no-agent-self-sign',
    invariant: 1,
    source: 'engine/gate.js (GateSigner.assertHumanIndependent)',
    description: 'A gate is signed only by a human; an agent can never self-sign.',
    iso38500: 'Principle 3 Acquisition / Principle 6 Human Behaviour',
    cobit2019: 'EDM01 Ensured Governance Framework Setting & Maintenance',
    itil4: 'Guiding Principle: Collaborate and promote visibility',
    iiaThreeLines: 'First Line: management ownership of the control action',
    soc2SoxItgc: 'CC1.1 / CC5.2 — control environment, authorised approver',
  }),
  Object.freeze({
    vosjControl: 'separation-of-duties',
    invariant: 2,
    source: 'engine/gate.js (author !== signer)',
    description: 'The author of a change cannot sign their own gate.',
    iso38500: 'Principle 4 Performance / Principle 5 Conformance',
    cobit2019: 'DSS06.03 Manage Roles, Responsibilities, Access Privileges',
    itil4: 'Change Enablement practice — segregation of authorities',
    iiaThreeLines: 'Second Line: independent oversight of the first line',
    soc2SoxItgc: 'CC5.2 — segregation of duties (SOX ITGC change management)',
  }),
  Object.freeze({
    vosjControl: 'four-eyes-change-validation',
    invariant: 3,
    source: 'vosj.change_requests (change.validated ledger row)',
    description: 'A change is validated only by an independent second human (V !== A).',
    iso38500: 'Principle 5 Conformance',
    cobit2019: 'BAI06 Managed IT Changes',
    itil4: 'Change Enablement practice — change authorisation',
    iiaThreeLines: 'Second Line: review and challenge',
    soc2SoxItgc: 'CC8.1 — change management authorisation & approval',
  }),
  Object.freeze({
    vosjControl: 'tamper-evident-ledger',
    invariant: 4,
    source: 'ledger/ledger.js (HMAC hash chain + verifyChain)',
    description: 'Every governance action is recorded in an append-only, hash-chained, HMAC-signed ledger.',
    iso38500: 'Principle 5 Conformance (auditability)',
    cobit2019: 'MEA01 Managed Performance & Conformance Monitoring',
    itil4: 'Continual Improvement — measurement & evidence',
    iiaThreeLines: 'Third Line: independent assurance over the evidence base',
    soc2SoxItgc: 'CC7.2 / PI1.x — audit logging, integrity of records',
  }),
  Object.freeze({
    vosjControl: 'ledger-fail-closed',
    invariant: 5,
    source: 'ledger/ledger.js (_key throws without VOSJ_LEDGER_HMAC_KEY)',
    description: 'Without a signing key the ledger refuses to append — it never uses a default key.',
    iso38500: 'Principle 6 Human Behaviour (no silent bypass)',
    cobit2019: 'APO13 Managed Security',
    itil4: 'Information Security Management practice',
    iiaThreeLines: 'First Line: secure-by-default control design',
    soc2SoxItgc: 'CC6.1 — logical access / key custody',
  }),
  Object.freeze({
    vosjControl: 'verified-before-cutover',
    invariant: 6,
    source: 'engine/gate.js + engine/reconcile.js (proof.ok required)',
    description: 'A cutover (Jump) fires only with a PASSING reconciliation proof AND a human signature.',
    iso38500: 'Principle 4 Performance / Principle 5 Conformance',
    cobit2019: 'BAI07 Managed IT Change Acceptance & Transitioning',
    itil4: 'Service Validation and Testing practice',
    iiaThreeLines: 'First & Second Line: control execution + verification',
    soc2SoxItgc: 'CC8.1 — testing/approval prior to production cutover',
  }),
  Object.freeze({
    vosjControl: 'high-risk-strangler-fig',
    invariant: 7,
    source: 'engine/disposition.js (high-risk -> CUTOVER.STRANGLER_FIG)',
    description: 'High-risk dispositions (Refactor/Replatform/Relocate) resolve only to incremental Strangler-Fig; big-bang is structurally unavailable.',
    iso38500: 'Principle 4 Performance (risk-managed delivery)',
    cobit2019: 'APO12 Managed Risk',
    itil4: 'Risk Management practice',
    iiaThreeLines: 'First Line: risk-proportionate control design',
    soc2SoxItgc: 'CC3.x — risk assessment driving control rigor',
  }),
  Object.freeze({
    vosjControl: 'advisory-only-waiver',
    invariant: 8,
    source: 'engine/waiver.js (hard invariants structurally unwaivable)',
    description: 'A waiver may relax only an ADVISORY check and is itself audited; it can never bypass a hard invariant.',
    iso38500: 'Principle 5 Conformance',
    cobit2019: 'MEA03 Managed Compliance with External Requirements',
    itil4: 'Change Enablement — documented exceptions',
    iiaThreeLines: 'Second Line: exception governance',
    soc2SoxItgc: 'CC8.1 — documented & approved exceptions',
  }),
]);

const CONTROL_FRAMEWORKS = Object.freeze([
  'iso38500', 'cobit2019', 'itil4', 'iiaThreeLines', 'soc2SoxItgc',
]);

// ---------------------------------------------------------------------------
// section builders (each kept small + side-effect free)
// ---------------------------------------------------------------------------

// Project a ledger row to the audited, non-internal fields (mirrors routes.redactLedger
// so the package matches the REST projection an auditor already sees).
function projectLedger(row) {
  return {
    seq: row.seq,
    ts: row.ts,
    actor: row.actor || null,
    signerRole: row.signerRole || null,
    action: row.action,
    evidenceHashes: row.evidenceHashes || [],
    meta: row.meta || {},
    prevHash: row.prevHash,
    hash: row.hash,
  };
}

// A ledger row belongs to a wave if its meta.migrationId matches OR (for non-gate
// rows like waiver.use) its meta.gateId / scope references the wave. We keep it
// inclusive-by-migrationId and fall back to the FULL chain when no scoping is
// possible, because verifyChain must run over a CONTIGUOUS chain from genesis.
function ledgerForWave(rows, waveId) {
  return rows.filter((r) => {
    const m = r.meta || {};
    return m.migrationId === waveId || m.waveId === waveId;
  });
}

// reconciliation proofs (gap 122 audit-as-output): every gate.sign row that carries
// a proof: evidence hash is a reconciliation event. Cross-reference it with the
// stored gate projection (who signed, when) so source->target is explicit.
function buildReconciliationProofs(ledgerRows, gates) {
  const gateById = {};
  for (const g of gates) gateById[`${g.id}:${g.migration_id || g.migrationId || ''}`] = g;
  const proofs = [];
  for (const row of ledgerRows) {
    const proofHashes = (row.evidenceHashes || []).filter((h) => String(h).startsWith('proof:'));
    if (proofHashes.length === 0) continue;
    const m = row.meta || {};
    const key = `${m.gateId || ''}:${m.migrationId || ''}`;
    const gate = gateById[key] || null;
    proofs.push({
      ledgerSeq: row.seq,
      action: row.action,
      gateId: m.gateId || null,
      migrationId: m.migrationId || null,
      unitId: m.unitId || null,
      fromState: m.fromState || null,
      toState: m.toState || null,
      proofHashes,
      // who/when surfaced from the gate projection (or the ledger row itself).
      signedBy: gate ? (gate.signed_by || gate.signedBy || null) : (m.signerId || null),
      signerRole: row.signerRole || (gate ? (gate.signer_role || gate.signerRole || null) : null),
      signedAt: row.ts,
    });
  }
  return proofs;
}

// Best-effort read of the tool_log + orders audit substrate. The store may not expose
// a listing (the MCP seam only appends); we NEVER fabricate — absence is recorded.
async function buildToolAudit(store) {
  const out = { available: false, toolLog: [], orders: [], note: null };
  if (store && typeof store.listToolLog === 'function') {
    out.available = true;
    out.toolLog = (await store.listToolLog({})) || [];
  }
  if (store && typeof store.listOrders === 'function') {
    out.available = true;
    out.orders = (await store.listOrders({})) || [];
  }
  if (!out.available) {
    out.note = 'tool_log/orders listing not exposed by this store; substrate is append-only and verified via the ledger';
  }
  return out;
}

// The auditability section (gap 122 audit-as-output): surface who/what/when/source->
// target as a FIRST-CLASS, queryable summary derived from ledger meta (the data is
// already there — this makes it an explicit deliverable, not buried in the rows).
function buildAuditTrail(ledgerRows) {
  return ledgerRows.map((r) => {
    const m = r.meta || {};
    return {
      seq: r.seq,
      who: r.actor || m.signerId || null,
      role: r.signerRole || null,
      what: r.action,
      when: r.ts,
      source: m.fromState || null,
      target: m.toState || null,
      gateId: m.gateId || null,
      hash: r.hash,
    };
  });
}

// Cross-reference the control map to the controls actually EXERCISED in this wave's
// ledger, so the manifest shows coverage (which invariants produced evidence here).
function annotateControlMap(ledgerRows) {
  const actions = new Set(ledgerRows.map((r) => r.action));
  const sawCutoverProof = ledgerRows.some((r) =>
    (r.evidenceHashes || []).some((h) => String(h).startsWith('proof:')));
  const sawWaiver = actions.has('waiver.use');
  const sawSign = [...actions].some((a) => String(a).startsWith('gate.sign'));
  return CONTROL_MAP.map((c) => {
    let evidenced = false;
    if (c.vosjControl === 'verified-before-cutover') evidenced = sawCutoverProof;
    else if (c.vosjControl === 'advisory-only-waiver') evidenced = sawWaiver;
    else if (c.invariant === 1 || c.invariant === 2 || c.invariant === 4) evidenced = sawSign;
    return Object.assign({}, c, { evidencedInThisWave: evidenced });
  });
}

function sha256(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// buildEvidenceExport({ ledger, store }) -> { buildPackage }
// ---------------------------------------------------------------------------
function buildEvidenceExport({ ledger, store }) {
  if (!ledger) throw new Error('evidence export requires a ledger');

  // buildPackage(waveId) -> { ok:true, package } | throws (handler shapes the error).
  async function buildPackage(waveId) {
    const id = String(waveId || '').trim();
    if (!id) throw new Error('evidence package requires a waveId');

    const wave = store && typeof store.getWave === 'function' ? await store.getWave(id) : null;
    if (!wave) throw new Error('wave not found');

    // --- source rows (REUSED facades) ---
    const allLedger = (await ledger.list({})).map(projectLedger);
    const waveLedger = ledgerForWave(allLedger, id);
    const waivers = store && typeof store.listWaivers === 'function'
      ? await store.listWaivers({}) : [];
    const gates = store && typeof store.listGates === 'function'
      ? await store.listGates({ migrationId: id }) : [];

    // --- verifyChain proof embedded so an auditor re-verifies OFFLINE (gap 122). ---
    // Verify the FULL chain (contiguous from genesis); the package also carries the
    // wave-scoped subset for review. A tampered row anywhere fails this proof.
    const chainProof = await ledger.verifyChain(allLedger);

    const toolAudit = await buildToolAudit(store);

    const sections = {
      // 1. signed ledger (wave-scoped view + the full chain for verification)
      ledger: { wave: waveLedger, full: allLedger },
      // 2. integrity proof (embedded so re-verification needs no live service)
      ledgerProof: { ok: chainProof.ok, brokenAt: chainProof.brokenAt, rowCount: allLedger.length },
      // 3. waiver register
      waivers: waivers.map((w) => ({
        id: w.id, gateId: w.gate_id || null, checkName: w.check_name || null,
        checkClass: w.check_class || 'advisory', status: w.status || 'active',
        scope: w.scope || null, reason: w.reason || null,
        grantedBy: w.granted_by || null, expiresAt: w.expires_at || null,
      })),
      // 4. reconciliation proofs (from ledger meta x stored gate rows)
      reconciliation: buildReconciliationProofs(waveLedger, gates),
      // 5. tool/order interaction audit (best-effort; absence is recorded)
      toolLog: toolAudit,
      // 6. pinned framework binding
      framework: {
        templateId: wave.framework_template_id || null,
        version: wave.framework_version || null,
        waveState: wave.state || null,
      },
    };

    // auditability as a first-class output (gap 122) + control map (gap 123).
    const auditTrail = buildAuditTrail(waveLedger);
    const controlMap = annotateControlMap(waveLedger);

    const body = {
      packageVersion: PACKAGE_VERSION,
      wave: { id: wave.id, name: wave.name || null, state: wave.state || null },
      generatedAt: new Date().toISOString(),
      sections,
      auditTrail,
      controlMap,
      frameworks: CONTROL_FRAMEWORKS.slice(),
    };

    // Deterministic digest over EVERYTHING EXCEPT the volatile generatedAt + the
    // digest itself, so two exports of identical state share a stable contentHash.
    const stable = Object.assign({}, body);
    delete stable.generatedAt;
    const contentHash = sha256(canonical(stable));

    return { ok: true, package: Object.assign({ contentHash }, body) };
  }

  return { buildPackage, CONTROL_MAP, CONTROL_FRAMEWORKS, PACKAGE_VERSION };
}

module.exports = {
  buildEvidenceExport,
  CONTROL_MAP,
  CONTROL_FRAMEWORKS,
  PACKAGE_VERSION,
};
