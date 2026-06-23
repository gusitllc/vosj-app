// src/engine/state-machine.js — the signed-gate phase-gate FSM (§14.1).
// Compiles a (data-driven) framework template into a finite-state machine and
// exposes getCurrentState / listValidNextStates / signTransition. Allowed
// transitions and signer roles come from the BOUND TEMPLATE's rows, not constants.
//
// Two FSMs coexist:
//   - the PHASE machine (template states P1..Pn), gated at each phase exit;
//   - the UNIT lifecycle (legacy -> dual_running -> reconciled -> migrated).
// The cutover transition (-> migrated) is ENGINE-INJECTED and NON-REMOVABLE: a
// template cannot delete it. It requires BOTH a passing reconciliation proof and
// a human-signed gate (§6.1, §14.1).

'use strict';

const disposition = require('./disposition');

const UNIT_STATES = Object.freeze(['legacy', 'dual_running', 'reconciled', 'migrated']);

// The phrase that marks the P2 kickoff gate's disposition criterion. A gate is
// "disposition-bearing" if its id is the kickoff id OR it declares this criterion.
const KICKOFF_CRITERION = 'every in-scope workload carries a disposition';

// Frozen rule map keyed by gateId. kind drives which machine-checkable criteria
// the engine COMPUTES (gate.js fails closed on criteriaMet===false). Data-driven
// so a template can opt a differently-named gate into the same rule via criteria.
const GATE_CRITERIA_RULES = Object.freeze({
  'g-kickoff-complete': 'kickoff',     // P2 exit: every in-scope workload has a disposition
  'g-planning-signoff': 'planning',    // P3 exit: bind executors from contract + CI/CD-365 gate
});

// The non-removable cutover gate the engine injects on every template.
const INJECTED_CUTOVER_GATE = Object.freeze({
  id: 'engine.verified-before-jump',
  name: 'Verified-before-Jump (engine-injected)',
  signerRole: 'dba',
  requiresSignature: true,
  cutover: true,
  injected: true,
  criteria: Object.freeze(['reconciliation proof passing', 'human DBA signature']),
});

class StateMachine {
  // template: compiled template (see engine/template.js). signer: HumanGateSigner.
  constructor(template, { signer, store = null } = {}) {
    if (!template) throw new Error('StateMachine requires a compiled template');
    this.template = template;
    this.signer = signer;
    this.store = store;
    this._index = indexTemplate(template);
  }

  // ---- phase FSM ----
  getCurrentState(run) {
    return (run && run.state) || this.template.states[0];
  }

  listValidNextStates(run) {
    const cur = this.getCurrentState(run);
    return this.template.transitions
      .filter((t) => t.from === cur)
      .map((t) => ({ to: t.to, gateId: t.gateId, gate: this._index.gates[t.gateId] || null }));
  }

  canTransition(run, to) {
    const cur = this.getCurrentState(run);
    return this.template.transitions.some((t) => t.from === cur && t.to === to);
  }

  // signTransition: validates the move, requires a human signature via the gate
  // engine, and (on success) returns the new state + the signed ledger row.
  async signTransition({ run, to, actor, signer, evidence = [], proof = null }) {
    const cur = this.getCurrentState(run);
    const transition = this.template.transitions.find((t) => t.from === cur && t.to === to);
    if (!transition) throw new Error(`no transition ${cur} -> ${to} in template ${this.template.id}`);

    const gateDef = this._index.gates[transition.gateId];
    if (!gateDef) throw new Error(`transition ${cur} -> ${to} has no gate`);
    if (!this.signer) throw new Error('StateMachine has no signer configured');

    const gate = Object.assign({}, gateDef, {
      migrationId: run && run.id,
      fromState: cur,
      toState: to,
      actor,
      evidence,
      proof,
    });
    // Compute machine-checkable criteria for disposition-bearing gates and hand
    // the verdict to the signer; gate.js (L40) fails closed on criteriaMet===false.
    const computed = await this.evaluateGateCriteria(gateDef, run);
    if (computed !== null) gate.criteriaMet = computed;
    const row = await this.signer.sign(gate, signer);
    return { state: to, gate: gate.id, ledger: row };
  }

  // evaluateGateCriteria(gateDef, run) -> true | false | null.
  // null  = gate is not disposition-bearing (criteria left to the existing flow).
  // true  = all computed criteria satisfied; false = at least one fails (fail-closed).
  async evaluateGateCriteria(gateDef, run) {
    const kind = gateRuleKind(gateDef);
    if (!kind) return null;
    if (!this.store || typeof this.store.listWorkloads !== 'function') return false;
    const workloads = (await this.store.listWorkloads({ waveId: run && run.id })) || [];
    const inScope = workloads.filter((w) => w && w.inScope !== false);
    if (kind === 'kickoff') return this._everyWorkloadHasDisposition(inScope);
    if (kind === 'planning') return this._bindPlanningExecutors(inScope, run);
    return false;
  }

  // P2 exit: a wave may not leave kickoff unless EVERY in-scope workload carries a
  // valid 7-R disposition. Zero in-scope workloads is also a fail (nothing decided).
  _everyWorkloadHasDisposition(inScope) {
    if (inScope.length === 0) return false;
    return inScope.every((w) => w.disposition && disposition.ALL.includes(w.disposition));
  }

  // P3 exit: derive each in-scope workload's contract FROM its disposition, bind the
  // executor/runbook strictly from that contract (gap 41), and fail closed when a
  // CI/CD-365-preconditioned contract lacks cicd365Ready (gap 44).
  _bindPlanningExecutors(inScope, run) {
    if (inScope.length === 0) return false;
    if (run && !run.plan) run.plan = {};
    const bindings = (run && run.plan && run.plan.executorBindings) || {};
    let ok = true;
    for (const w of inScope) {
      if (!w.disposition || !disposition.ALL.includes(w.disposition)) { ok = false; continue; }
      const contract = disposition.contractFor(w.disposition);
      assertHighRiskStranglerFig(w.disposition, contract);
      bindings[w.id] = bindingFromContract(contract);
      if (contract.deliverySystemPrecondition === true &&
          !(w.attributes && w.attributes.cicd365Ready === true)) ok = false;
    }
    if (run && run.plan) run.plan.executorBindings = bindings;
    return ok;
  }

  // ---- unit lifecycle FSM (cutover is the gated, injected transition) ----
  unitStates() { return UNIT_STATES.slice(); }

  canUnitTransition(unit, to) {
    const from = (unit && unit.state) || 'legacy';
    const i = UNIT_STATES.indexOf(from);
    const j = UNIT_STATES.indexOf(to);
    if (i < 0 || j < 0) return false;
    return j === i + 1; // strictly forward, one step
  }

  // cutover (reconciled -> migrated). NON-REMOVABLE gate: requires proof.ok AND a
  // human signature. Fails closed if either is missing.
  async cutoverUnit({ unit, actor, signer, proof, evidence = [] }) {
    if (!this.canUnitTransition(unit, 'migrated')) {
      throw new Error(`unit ${unit && unit.id} cannot cut over from '${unit && unit.state}'`);
    }
    if (!proof || proof.ok !== true) {
      throw new Error('cutover fail-closed: passing reconciliation proof required');
    }
    if (!this.signer) throw new Error('StateMachine has no signer configured');

    const gate = Object.assign({}, INJECTED_CUTOVER_GATE, {
      migrationId: unit && unit.migrationId,
      unitId: unit && unit.id,
      fromState: unit && unit.state,
      toState: 'migrated',
      actor,
      proof,
      evidence,
    });
    const row = await this.signer.sign(gate, signer);
    return { state: 'migrated', gate: gate.id, ledger: row };
  }
}

// gateRuleKind(gateDef) -> 'kickoff' | 'planning' | null. Matched by gate id OR,
// for the kickoff rule, by the presence of the canonical disposition criterion so
// a renamed gate that declares it still gets enforced (data-driven, not hardcoded).
function gateRuleKind(gateDef) {
  if (!gateDef) return null;
  if (GATE_CRITERIA_RULES[gateDef.id]) return GATE_CRITERIA_RULES[gateDef.id];
  const criteria = Array.isArray(gateDef.criteria) ? gateDef.criteria : [];
  if (criteria.some((c) => typeof c === 'string' && c.includes(KICKOFF_CRITERION))) {
    return 'kickoff';
  }
  return null;
}

// The executor binding is taken STRICTLY from the disposition contract — the
// executor/runbook/cutover style are selected at planning from the disposition,
// never chosen at runtime (gap 41).
function bindingFromContract(contract) {
  return Object.freeze({
    executorClass: contract.executorClass,
    runbookTemplate: contract.runbookTemplate,
    cutoverStyle: contract.cutoverStyle,
  });
}

// Assert (do not duplicate) the §7 structural guarantee: a high-risk disposition
// must already resolve to Strangler-Fig in the contract table.
function assertHighRiskStranglerFig(name, contract) {
  if (contract.highRisk === true && contract.cutoverStyle !== disposition.CUTOVER.STRANGLER_FIG) {
    throw new Error(`disposition ${name} is high-risk but not Strangler-Fig — structural guarantee violated`);
  }
}

function indexTemplate(template) {
  const gates = {};
  for (const p of template.phases) {
    if (p.gate) gates[p.gate.id] = p.gate;
  }
  // Always make the injected cutover gate addressable.
  gates[INJECTED_CUTOVER_GATE.id] = INJECTED_CUTOVER_GATE;
  return { gates };
}

module.exports = { StateMachine, UNIT_STATES, INJECTED_CUTOVER_GATE, GATE_CRITERIA_RULES };
