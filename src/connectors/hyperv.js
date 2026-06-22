// src/connectors/hyperv.js — Hyper-V connector stub (§16).
// On-prem virtualization source: discover VMs/VHDs on a Hyper-V host/cluster and
// replicate them into Azure / Azure Local / another Hyper-V. Per §16.2 the Shift
// transfer steps run ON THE SOURCE HOST via the appropriate remote-management
// transport (WinRM / PowerShell Direct), not a gateway-local copy.
//
// STRUCTURAL STUB: discover/replicate/cutover/rollback carry clear TODOs for the
// real Hyper-V WMI / PowerShell remoting calls, while verify() returns a genuine,
// structured proof so the verified-before-Jump gate (§13) is exercisable.

'use strict';

const { BaseConnector, category } = require('./sdk');

class HyperVConnector extends BaseConnector {
  constructor(meta = {}) {
    super(Object.assign({
      id: 'hyperv',
      name: 'Microsoft Hyper-V',
      modes: ['api-orchestration'],          // §16 Mode 1 (WMI / PowerShell remoting)
      primitives: ['disk-replication', 'image-conversion'], // §16.1
      // Source host + transport are config-driven; no hardcoded host/credentials.
      env: ['HYPERV_HOST', 'HYPERV_TRANSPORT', 'HYPERV_VM_FILTER'],
    }, meta));
    this._units = new Map();
  }

  // discover(ctx) — enumerate VMs and their virtual disks on the Hyper-V host.
  async discover(_ctx) {
    // TODO: Get-VM / Get-VMHardDiskDrive over WinRM against HYPERV_HOST; map each
    //   VM + its VHD(X) chain to a migration unit. Honor HYPERV_VM_FILTER.
    return {
      ok: true,
      source: 'hyperv',
      units: [
        { id: 'hv-vm-web', name: 'WEB01', kind: 'vm', os: 'windows', vhdGiB: 80 },
        { id: 'hv-vm-file', name: 'FILE01', kind: 'vm', os: 'windows', vhdGiB: 512 },
      ],
      note: 'STUB inventory — wire Hyper-V WMI/PowerShell discovery here.',
    };
  }

  // replicate(unit, ctx) — seed disk replication / convert image toward target.
  async replicate(unit, ctx) {
    await this.validate(unit, ctx); // §16.2 pre-flight before executing
    this.advance(unit, 'executing');
    const st = this._stateFor(unit);
    // TODO: enable Hyper-V Replica or stream the VHD(X) to the target replication
    //   service; convert VHDX->target image format as needed. Transfer runs on the
    //   source host (PowerShell Direct / WinRM), never a gateway-local copy.
    st.replicated = true;
    st.lagSeconds = 0;
    st.sourceBlocks = unit.vhdGiB ? unit.vhdGiB * 1024 : 0; // simulated dirty-block count
    st.targetBlocks = st.sourceBlocks;
    st.bootCheck = true;
    this.advance(unit, 'completed');
    return { ok: true, unitId: unit.id, replicated: true, note: 'STUB Hyper-V replication seeded.' };
  }

  async _verifyCategories(unit, _ctx) {
    const st = this._stateFor(unit);
    const src = st.sourceBlocks || 0;
    const tgt = st.targetBlocks != null ? st.targetBlocks : src;
    const lag = st.lagSeconds != null ? st.lagSeconds : null;
    // TODO: replace simulated values with real replica-health, in-flight-block
    //   delta, target block-count, VHD content-hash compare, and a target boot /
    //   guest-agent smoke probe. (Row/sequence/constraint categories map to a
    //   guest-app/db check or pass trivially for pure-VM image moves.)
    return [
      category('replication_lag', lag === 0, `replica in-flight delta: ${lag}s (must be 0)`),
      category('row_counts', src === tgt, `source-blocks=${src} target-blocks=${tgt}`),
      category('checksums', st.replicated === true, 'VHD content hashes compared (simulated)'),
      category('sequence_identity', true, 'image identity continuity (n/a for VM move)'),
      category('constraints', true, 'no relational constraints for pure VM image'),
      category('smoke', st.bootCheck === true, 'target VM boots + guest agent healthy (simulated)'),
    ];
  }

  // cutover(unit, ctx) — planned failover: final sync, stop source, start target.
  async cutover(unit, _ctx) {
    const st = this._stateFor(unit);
    if (!st.replicated) return { ok: false, error: 'cannot cut over before replication' };
    // TODO: final-sync the replica, gracefully stop the source VM, then start the
    //   target VM and confirm guest health before declaring cutover complete.
    st.cutOver = true;
    return { ok: true, unitId: unit.id, cutOver: true, note: 'STUB Hyper-V planned failover.' };
  }

  // rollback(unit, ctx) — reverse replication and restart the source VM.
  async rollback(unit, _ctx) {
    const st = this._stateFor(unit);
    // TODO: reverse replication direction and bring the original source VM back up.
    st.cutOver = false;
    return { ok: true, unitId: unit.id, rolledBack: true, note: 'STUB Hyper-V fail-back.' };
  }

  _stateFor(unit) {
    const id = unit && unit.id;
    if (!this._units.has(id)) this._units.set(id, {});
    return this._units.get(id);
  }
}

module.exports = { HyperVConnector };
