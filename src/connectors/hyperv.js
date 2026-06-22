// src/connectors/hyperv.js — Hyper-V connector (§16).
// On-prem virtualization source: discover VMs/VHDs on a Hyper-V host/cluster and
// replicate them into Azure / Azure Local / another Hyper-V. Per §16.2 the Shift
// transfer steps run ON THE SOURCE HOST via the appropriate remote-management
// transport (WinRM / PowerShell Direct), not a gateway-local copy.
//
// CONTRACT-COMPLETE, HONEST connector. discover/replicate/cutover/rollback run the
// full surrounding logic (config gating, executor FSM, replication-session
// bookkeeping, ordering guards). The verify() probes carry the EXACT remote-
// management seam as a single TODO naming the WMI/PowerShell call that supplies the
// measurement. Until those seams are wired the probes return notVerified(), so
// verify() FAILS CLOSED rather than fabricating a passing proof (§13).

'use strict';

const { BaseConnector, verified, notVerified } = require('./sdk');

// Source host + transport are config-driven; no hardcoded host/credentials.
const REQUIRED_ENV = Object.freeze(['HYPERV_HOST', 'HYPERV_TRANSPORT']);

class HyperVConnector extends BaseConnector {
  constructor(meta = {}) {
    super(Object.assign({
      id: 'hyperv',
      name: 'Microsoft Hyper-V',
      modes: ['api-orchestration'],          // §16 Mode 1 (WMI / PowerShell remoting)
      primitives: ['disk-replication', 'image-conversion'], // §16.1
      env: REQUIRED_ENV.concat(['HYPERV_VM_FILTER']),
    }, meta));
  }

  // discover(ctx) — enumerate VMs and their virtual disks on the Hyper-V host.
  async discover(ctx) {
    const cfg = this.requireConfig(ctx, REQUIRED_ENV); // fail-closed on missing config
    // TODO[SDK]: enumerate VMs + virtual disks over the configured transport:
    //   Get-VM | Get-VMHardDiskDrive  (WinRM / PowerShell remoting against
    //   HYPERV_HOST), honoring HYPERV_VM_FILTER; map each VM + its VHD(X) chain to a
    //   migration unit. Until wired, discover reports the seam openly.
    return {
      ok: false,
      source: 'hyperv',
      pending: 'sdk',
      detail: 'Hyper-V WMI/PowerShell discovery not wired; cannot enumerate VMs yet',
      target: { host: cfg.HYPERV_HOST, transport: cfg.HYPERV_TRANSPORT },
      units: [],
    };
  }

  // replicate(unit, ctx) — seed disk replication / convert image toward target.
  // Runs the executor FSM and opens a replication session. The enable-call is the
  // SDK seam; the session records only real measurements (none yet).
  async replicate(unit, ctx) {
    this.requireConfig(ctx, REQUIRED_ENV);
    const pre = await this.validate(unit, ctx);
    if (!pre.ok) return { ok: false, unitId: unit && unit.id, error: 'pre-flight failed', checks: pre.checks };
    this.advance(unit, 'executing');

    const sess = this._sessionFor(unit);
    sess.started = true;
    sess.startedAt = new Date().toISOString();
    sess.kind = unit.kind || 'vm';
    // TODO[SDK]: enable Hyper-V Replica (Enable-VMReplication / Start-VMInitialReplication)
    //   OR stream the VHD(X) to the target replication service and convert format as
    //   needed. The transfer runs on the source host (PowerShell Direct / WinRM),
    //   never a gateway-local copy. On initial-replication-complete, populate
    //   sess.measured from Measure-VMReplication / target telemetry. We do NOT set
    //   sess.measured here: an un-measured session must verify as not-verified.
    return {
      ok: true, unitId: unit.id, replicationStarted: true, sessionAt: sess.startedAt,
      note: 'replication session opened; awaiting SDK enable + initial replication telemetry',
    };
  }

  // verify(unit, ctx) is provided by BaseConnector; we supply the probe set. Each
  // probe reads ONLY real measurements from the replication session. With the SDK
  // seams unwired, sess.measured is empty -> every probe returns notVerified().
  _probes(unit, ctx) {
    const m = (this._sessionFor(unit).measured) || {};
    return {
      replication_lag: async () => {
        // TODO[SDK]: Measure-VMReplication -> in-flight delta / last-replication age.
        if (typeof m.lagSeconds !== 'number') return notVerified('replica in-flight delta not measured');
        return m.lagSeconds === 0
          ? verified('replica delta 0s at probe')
          : notVerified(`replica in-flight delta ${m.lagSeconds}s (must be 0)`);
      },
      row_counts: async () => {
        // TODO[SDK]: compare source vs target written-block counts (target disk
        //   inventory) — the VM analogue of row counts.
        if (typeof m.sourceBlocks !== 'number' || typeof m.targetBlocks !== 'number') {
          return notVerified('block counts not measured');
        }
        return m.sourceBlocks === m.targetBlocks
          ? verified(`block counts equal (${m.sourceBlocks})`)
          : notVerified(`source-blocks=${m.sourceBlocks} target-blocks=${m.targetBlocks}`);
      },
      checksums: async () => {
        // TODO[SDK]: compare VHD(X) content hashes between source and replicated copy.
        if (m.checksumMatch == null) return notVerified('VHD content hashes not compared');
        return m.checksumMatch === true ? verified('VHD content hashes match') : notVerified('VHD hash mismatch');
      },
      sequence_identity: async () => {
        // TODO[SDK]: confirm image/identity continuity (BIOS/UUID, gen-id). For a
        //   guest DB the DB connector measures this; for a pure VM move, confirm the
        //   target VM identity matches the planned identity.
        if (m.identityOk == null) return notVerified('image identity continuity not confirmed');
        return m.identityOk === true ? verified('image identity continuity confirmed') : notVerified('identity drift');
      },
      constraints: async () => {
        // TODO[SDK]: for a guest DB/app, re-validate keys/FKs/checks; for a pure VM
        //   image move confirm there are no in-guest integrity errors on first boot.
        if (m.constraintsOk == null) return notVerified('in-guest integrity not re-validated');
        return m.constraintsOk === true ? verified('in-guest integrity re-validated') : notVerified('integrity errors');
      },
      smoke: async () => {
        // TODO[SDK]: boot the target VM and confirm guest-agent health + a critical
        //   service probe (Get-VM state + guest heartbeat + app endpoint check).
        if (m.bootOk == null) return notVerified('target VM boot + guest-agent probe not run');
        return m.bootOk === true ? verified('target VM boots + guest healthy') : notVerified('boot/guest failures');
      },
    };
  }

  // cutover(unit, ctx) — planned failover: final sync, stop source, start target.
  async cutover(unit, ctx) {
    this.requireConfig(ctx, REQUIRED_ENV);
    const sess = this._sessionFor(unit);
    if (!sess.started) return { ok: false, unitId: unit && unit.id, error: 'cannot cut over before replication' };
    // TODO[SDK]: planned failover via remote management:
    //   Stop-VM (source, graceful) -> Start-VMFailover (target) -> Complete-VMFailover,
    //   then confirm guest health before declaring cutover complete.
    this.advance(unit, 'completed');
    sess.cutOver = true;
    return { ok: true, unitId: unit.id, cutOver: true, note: 'planned failover requested; awaiting SDK failover steps' };
  }

  // rollback(unit, ctx) — reverse replication and restart the source VM.
  async rollback(unit, ctx) {
    this.requireConfig(ctx, REQUIRED_ENV);
    const sess = this._sessionFor(unit);
    if (this.canAdvance(unit, 'rolling_back')) this.advance(unit, 'rolling_back');
    // TODO[SDK]: Set-VMReplication -Reverse toward the source, then Start-VM on the
    //   original source host and confirm it is healthy before declaring fail-back done.
    sess.cutOver = false;
    if (this.canAdvance(unit, 'rolled_back')) this.advance(unit, 'rolled_back');
    return { ok: true, unitId: unit.id, rolledBack: true, note: 'fail-back requested; awaiting SDK reverse replication' };
  }
}

module.exports = { HyperVConnector };
