// src/engine/disposition.js — the 7-R disposition engine (§7).
// Each disposition is a TYPED CONTRACT <executor_class, runbook_template,
// reconciliation_profile, cutover_style>. HIGH-RISK dispositions (Refactor,
// Replatform — and Relocate) resolve only to incremental Strangler-Fig runbooks,
// so a big-bang plan is STRUCTURALLY unavailable (§7 structural guarantee).

'use strict';

const CUTOVER = Object.freeze({ STRANGLER_FIG: 'strangler-fig', BIG_BANG: 'big-bang', NONE: 'none' });

// The 7-R contract table. cutoverStyle === STRANGLER_FIG means big-bang is unavailable.
const DISPOSITIONS = Object.freeze({
  Retire: {
    meaning: 'Decommission; no migration.',
    executorClass: 'none',
    runbookTemplate: 'decommission',
    reconciliationProfile: 'none',
    cutoverStyle: CUTOVER.NONE,
    highRisk: false,
  },
  Retain: {
    meaning: 'Keep at source (regulatory/technical).',
    executorClass: 'none',
    runbookTemplate: 'split-environment',
    reconciliationProfile: 'none',
    cutoverStyle: CUTOVER.NONE,
    highRisk: false,
  },
  Rehost: {
    meaning: 'Lift-and-shift to IaaS.',
    executorClass: 'rehost',
    runbookTemplate: 'rehost-near-zero-downtime',
    reconciliationProfile: 'standard',
    cutoverStyle: CUTOVER.BIG_BANG,
    highRisk: false,
  },
  Relocate: {
    meaning: 'Move hypervisor wholesale (e.g. on-prem virtualization -> cloud-hosted).',
    executorClass: 'relocate',
    runbookTemplate: 'relocate-replication-assisted',
    reconciliationProfile: 'standard',
    cutoverStyle: CUTOVER.STRANGLER_FIG, // enforced incremental (§7 table)
    highRisk: true,
  },
  Repurchase: {
    meaning: 'Drop-and-shop to SaaS.',
    executorClass: 'repurchase',
    runbookTemplate: 'data-extract-cutover',
    reconciliationProfile: 'standard',
    cutoverStyle: CUTOVER.BIG_BANG,
    highRisk: false,
  },
  Replatform: {
    meaning: 'Lift-and-reshape (e.g. managed database).',
    executorClass: 'replatform',
    runbookTemplate: 'replatform-reshape',
    reconciliationProfile: 'tightened',
    cutoverStyle: CUTOVER.STRANGLER_FIG,
    highRisk: true,
    deliverySystemPrecondition: true, // CI/CD 365° readiness is a hard dependency (§7.1/§17)
  },
  Refactor: {
    meaning: 'Re-architect cloud-native.',
    executorClass: 'refactor',
    runbookTemplate: 'refactor-strangler',
    reconciliationProfile: 'tightened',
    cutoverStyle: CUTOVER.STRANGLER_FIG, // Strangler-Fig MANDATORY; big-bang unavailable
    highRisk: true,
    deliverySystemPrecondition: true,
  },
});

const ALL = Object.freeze(Object.keys(DISPOSITIONS));

// classify(workload) -> { disposition, contract } using an explicit choice or a
// conservative heuristic. The heuristic NEVER produces a big-bang plan for a
// high-risk reshape — that property comes from the contract table, not the guess.
function classify(workload = {}) {
  let key = workload.disposition;
  if (!key || !DISPOSITIONS[key]) {
    key = heuristic(workload);
  }
  const contract = DISPOSITIONS[key];
  return Object.freeze({
    disposition: key,
    contract: Object.freeze(Object.assign({}, contract)),
    strangler: contract.cutoverStyle === CUTOVER.STRANGLER_FIG,
    bigBangAvailable: contract.cutoverStyle === CUTOVER.BIG_BANG,
  });
}

function heuristic(w) {
  if (w.decommission || w.endOfLife) return 'Retire';
  if (w.mustStaySource || w.regulatoryHold) return 'Retain';
  if (w.saasReplacement) return 'Repurchase';
  if (w.cloudNativeRewrite) return 'Refactor';
  if (w.managedServiceTarget) return 'Replatform';
  if (w.hypervisorMove) return 'Relocate';
  return 'Rehost';
}

function contractFor(disposition) {
  const c = DISPOSITIONS[disposition];
  if (!c) throw new Error(`unknown disposition: ${disposition}`);
  return Object.freeze(Object.assign({}, c));
}

module.exports = { classify, contractFor, DISPOSITIONS, ALL, CUTOVER };
