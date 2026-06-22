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

const UNIT_STATES = Object.freeze(['legacy', 'dual_running', 'reconciled', 'migrated']);

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
    const row = await this.signer.sign(gate, signer);
    return { state: to, gate: gate.id, ledger: row };
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

function indexTemplate(template) {
  const gates = {};
  for (const p of template.phases) {
    if (p.gate) gates[p.gate.id] = p.gate;
  }
  // Always make the injected cutover gate addressable.
  gates[INJECTED_CUTOVER_GATE.id] = INJECTED_CUTOVER_GATE;
  return { gates };
}

module.exports = { StateMachine, UNIT_STATES, INJECTED_CUTOVER_GATE };
