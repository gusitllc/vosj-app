// src/contracts/index.js — plugin interfaces / base classes for Vosj CE.
// These are the extension points. Every method is async and throws
// 'not implemented' so a partial plugin fails loudly rather than silently.
// verify() is MANDATORY on a Connector — a cutover cannot be proven without it (§13).

'use strict';

function notImplemented(cls, method) {
  return new Error(`${cls}.${method}() not implemented`);
}

// Connector — a point-to-point migration executor for one source->target pair.
// discover/replicate/cutover/rollback move a migration unit; verify() returns a
// structured equivalence proof consumed by the reconciliation engine (§13).
class Connector {
  constructor(meta = {}) {
    this.id = meta.id || this.constructor.name;
    this.meta = meta;
  }
  async discover(ctx) { throw notImplemented('Connector', 'discover'); }
  async replicate(unit, ctx) { throw notImplemented('Connector', 'replicate'); }
  // MANDATORY. Returns { ok:boolean, proof:{ categories:[{name,ok,detail}], hash } }.
  async verify(unit, ctx) { throw notImplemented('Connector', 'verify'); }
  async cutover(unit, ctx) { throw notImplemented('Connector', 'cutover'); }
  async rollback(unit, ctx) { throw notImplemented('Connector', 'rollback'); }
}

// Executor — runs a single runbook step (§6 conductor stepping the runbook).
class Executor {
  async run(step, ctx) { throw notImplemented('Executor', 'run'); }
}

// GateSigner — applies the human sign-off that authorises a gate transition (§12, Inv.1).
// Implementations MUST reject any non-human signer (no agent self-sign) and MUST reject
// self-signing (the actor who authored the work cannot also authorise it).
class GateSigner {
  // signer = { id, kind } ; gate = { ..., actor }
  async sign(gate, signer) { throw notImplemented('GateSigner', 'sign'); }

  // Shared guard usable by subclasses; throws on violation.
  static assertHumanIndependent(gate, signer) {
    if (!signer || signer.kind !== 'human') {
      throw new Error('gate sign rejected: signer must be human (no agent self-sign)');
    }
    const author = gate && gate.actor;
    if (author && (author === signer.id)) {
      throw new Error('gate sign rejected: author cannot self-sign (separation of duties)');
    }
  }
}

// AssessmentProvider — produces a readiness / risk score for a target (§5 Vault station).
class AssessmentProvider {
  async assess(target) { throw notImplemented('AssessmentProvider', 'assess'); }
}

// StateStore — persistence contract. Concrete impls live in src/db/statestore.js.
class StateStore {
  async init() { throw notImplemented('StateStore', 'init'); }
  async health() { throw notImplemented('StateStore', 'health'); }

  async listWorkloads(filter) { throw notImplemented('StateStore', 'listWorkloads'); }
  async getWorkload(id) { throw notImplemented('StateStore', 'getWorkload'); }
  async saveWorkload(workload) { throw notImplemented('StateStore', 'saveWorkload'); }

  async listWaves(filter) { throw notImplemented('StateStore', 'listWaves'); }
  async getWave(id) { throw notImplemented('StateStore', 'getWave'); }
  async saveWave(wave) { throw notImplemented('StateStore', 'saveWave'); }

  async getGate(id) { throw notImplemented('StateStore', 'getGate'); }
  async listGates(filter) { throw notImplemented('StateStore', 'listGates'); }
  async saveGate(gate) { throw notImplemented('StateStore', 'saveGate'); }

  async appendLedger(row) { throw notImplemented('StateStore', 'appendLedger'); }
  async listLedger(filter) { throw notImplemented('StateStore', 'listLedger'); }
  async lastLedger() { throw notImplemented('StateStore', 'lastLedger'); }

  async appendToolLog(row) { throw notImplemented('StateStore', 'appendToolLog'); }

  // Waivers — advisory-only exceptions (see src/engine/waiver.js). Optional on a
  // store; the engine treats their absence as "no waiver available" (fail-closed).
  async listWaivers(filter) { throw notImplemented('StateStore', 'listWaivers'); }
  async saveWaiver(waiver) { throw notImplemented('StateStore', 'saveWaiver'); }

  // Credential vault (see src/vault/vault.js). Optional on a store; the vault keeps
  // a pure in-memory mirror when absent. Persists ciphertext ONLY — never plaintext.
  async putCredential(record) { throw notImplemented('StateStore', 'putCredential'); }
  async getCredential(ref) { throw notImplemented('StateStore', 'getCredential'); }

  // Framework templates (§8.2, see src/engine/template-store.js). Optional on a
  // store; template-store falls back to filesystem-seeded templates when absent.
  // body persists the COMPILED phases/gates/states as JSONB (additive, no fork).
  async listTemplatesDb(filter) { throw notImplemented('StateStore', 'listTemplatesDb'); }
  async getTemplateDb(id) { throw notImplemented('StateStore', 'getTemplateDb'); }
  async saveTemplateDb(template) { throw notImplemented('StateStore', 'saveTemplateDb'); }
  async listFrameworkRoles(templateId) { throw notImplemented('StateStore', 'listFrameworkRoles'); }
  async saveFrameworkRole(role) { throw notImplemented('StateStore', 'saveFrameworkRole'); }
}

module.exports = { Connector, Executor, GateSigner, AssessmentProvider, StateStore };
