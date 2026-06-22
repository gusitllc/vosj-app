// src/engine/reconcile.js — verification & reconciliation engine (§13).
// Produces the equivalence proof π(w) required before any cutover (Invariant 6).
// Compares migrated target vs source across categories via connector.verify();
// returns { ok, categories[], proof:{ hash, ... } }. The proof hash is what the
// cutover gate binds (§14.1) — no proof => the Jump gate is unreachable.

'use strict';

const crypto = require('crypto');

// Pre-switchover categories are HARD gates on verified-before-Jump (§13).
// Performance/plan parity is assessed POST-cutover in P6 (revocable window), so
// it is informational here, not a pre-switch blocker.
const PRE_SWITCH_CATEGORIES = Object.freeze([
  'replication_lag', 'row_counts', 'checksums',
  'sequence_identity', 'constraints', 'smoke',
]);

function hashProof(obj) {
  const canonical = stableStringify(obj);
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function stableStringify(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(stableStringify).join(',') + ']';
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
}

function isFreshBaseline(unit, config) {
  const maxAge = (config && config.baselineMaxAgeMs) || (24 * 60 * 60 * 1000);
  const at = unit && unit.baselineAt ? Date.parse(unit.baselineAt) : NaN;
  if (!Number.isFinite(at)) return false; // no baseline => not fresh (fail-closed)
  return (Date.now() - at) <= maxAge;
}

// reconcile(unit, connector, ctx) -> { ok, categories, proof, baselineFresh }.
async function reconcile(unit, connector, ctx = {}) {
  if (!connector || typeof connector.verify !== 'function') {
    throw new Error('reconcile requires a connector with verify()');
  }
  const config = ctx.config || {};
  const baselineFresh = isFreshBaseline(unit, config);

  const result = await connector.verify(unit, ctx);
  const reported = (result && Array.isArray(result.categories)) ? result.categories : [];

  // Normalise categories; fail-closed for any pre-switch category not proven ok.
  const byName = {};
  for (const c of reported) byName[c.name] = c;
  const categories = PRE_SWITCH_CATEGORIES.map((name) => {
    const c = byName[name];
    return {
      name,
      ok: Boolean(c && c.ok),
      detail: (c && c.detail) || (c ? '' : 'not reported (fail-closed)'),
      preSwitch: true,
    };
  });
  // Carry through any extra (e.g. post-cutover) categories the connector reported.
  for (const c of reported) {
    if (!PRE_SWITCH_CATEGORIES.includes(c.name)) {
      categories.push({ name: c.name, ok: Boolean(c.ok), detail: c.detail || '', preSwitch: false });
    }
  }

  const preSwitchOk = categories.filter((c) => c.preSwitch).every((c) => c.ok);
  const ok = Boolean(result && result.ok) && preSwitchOk && baselineFresh;

  const proofBody = {
    ok, // self-describing: the gate signer receives only the proof object
    unitId: unit && unit.id,
    connector: connector.id,
    baselineFresh,
    categories,
    connectorProof: (result && result.proof) || null,
    ts: new Date().toISOString(),
  };
  const proof = Object.assign({ hash: hashProof(proofBody) }, proofBody);

  return { ok, categories, proof, baselineFresh };
}

module.exports = { reconcile, hashProof, isFreshBaseline, PRE_SWITCH_CATEGORIES };
