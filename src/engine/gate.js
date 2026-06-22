// src/engine/gate.js — gate signing engine (§6.1/§12/§14.1).
// A gate transition fires only when (a) machine-checkable criteria are satisfied
// AND (b) a human in a named role applies a signature. This module enforces:
//   - no agent self-sign  (signer.kind must be 'human', Invariant 1)
//   - separation of duties (author !== signer, Invariant 2)
//   - verified-before-cutover (a cutover gate requires a passing proof, Invariant 6)
// and writes the signed row to the tamper-evident ledger (Invariant 4).

'use strict';

const { GateSigner } = require('../contracts');

class HumanGateSigner extends GateSigner {
  // ledger: required to persist the signed row. store: optional, to save gate state.
  constructor({ ledger, store = null }) {
    super();
    if (!ledger) throw new Error('HumanGateSigner requires a ledger');
    this.ledger = ledger;
    this.store = store;
  }

  // sign(gate, signer) -> signed ledger row.
  // gate = { id, migrationId?, unitId?, fromState, toState, actor, capability?,
  //          criteria?, criteriaMet?, requiresProof?, proof? }
  // signer = { id, kind:'human', role }
  async sign(gate, signer) {
    if (!gate || !gate.id) throw new Error('gate sign rejected: gate.id required');

    // (1) Human-only + separation of duties (Invariants 1 & 2).
    GateSigner.assertHumanIndependent(gate, signer);

    // (2) Signer role must satisfy the gate's required signer role.
    if (gate.signerRole && signer.role && gate.signerRole !== signer.role) {
      throw new Error(
        `gate sign rejected: gate requires role '${gate.signerRole}', signer is '${signer.role}'`
      );
    }

    // (3) Machine-checkable criteria must be satisfied (§6.1).
    if (gate.criteriaMet === false) {
      throw new Error('gate sign rejected: machine-checkable criteria not satisfied');
    }

    // (4) Verified-before-cutover (Invariant 6). A cutover gate needs a passing proof.
    if (gate.cutover || gate.requiresProof) {
      const proof = gate.proof;
      if (!proof || proof.ok !== true || !proof.hash) {
        throw new Error('gate sign rejected: cutover requires a passing reconciliation proof');
      }
    }

    const evidenceHashes = collectEvidence(gate);
    const row = await this.ledger.append({
      actor: gate.actor || null,
      signerRole: signer.role || gate.signerRole || null,
      action: gate.cutover ? 'gate.sign.cutover' : 'gate.sign',
      evidenceHashes,
      meta: {
        gateId: gate.id,
        migrationId: gate.migrationId || null,
        unitId: gate.unitId || null,
        fromState: gate.fromState || null,
        toState: gate.toState || null,
        signerId: signer.id,
        capability: gate.capability || null,
      },
    });

    if (this.store && typeof this.store.saveGate === 'function') {
      await this.store.saveGate({
        id: gate.id,
        migrationId: gate.migrationId || null,
        unitId: gate.unitId || null,
        signedBy: signer.id,
        signerRole: signer.role || gate.signerRole || null,
        ledgerHash: row.hash,
        signedAt: row.ts,
      });
    }
    return row;
  }
}

function collectEvidence(gate) {
  const hashes = [];
  if (gate.proof && gate.proof.hash) hashes.push(`proof:${gate.proof.hash}`);
  if (Array.isArray(gate.evidence)) {
    for (const e of gate.evidence) hashes.push(typeof e === 'string' ? e : JSON.stringify(e));
  }
  return hashes;
}

module.exports = { HumanGateSigner };
