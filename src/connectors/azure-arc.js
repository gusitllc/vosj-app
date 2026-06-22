// src/connectors/azure-arc.js — Azure Arc / Azure Local connector (§16).
// Mode 1 (API orchestration, §16): drives the DURABLE first-party primitives —
// block/disk replication, image conversion, and database migration — into
// Azure / AKS-on-Azure-Local rather than any churn-prone product name (§16.1).
//
// CONTRACT-COMPLETE, HONEST connector. discover/replicate/cutover/rollback run the
// full surrounding logic (config gating, executor FSM, replication-session
// bookkeeping, ordering guards). The verify() probes each carry the EXACT SDK seam
// as a single TODO naming the ARM/replication API that would supply the
// measurement. Until those seams are wired the probes return notVerified(), so
// verify() FAILS CLOSED — it never fabricates a passing proof (§13).

'use strict';

const { BaseConnector, verified, notVerified } = require('./sdk');

// Config the connector needs to address a real target. Absent => fail closed.
const REQUIRED_ENV = Object.freeze([
  'AZURE_SUBSCRIPTION_ID', 'AZURE_ARC_RESOURCE_GROUP', 'AZURE_LOCAL_CLUSTER',
]);

class AzureArcConnector extends BaseConnector {
  constructor(meta = {}) {
    super(Object.assign({
      id: 'azure-arc',
      name: 'Azure Arc / Azure Local',
      modes: ['api-orchestration'],         // §16 Mode 1
      primitives: ['disk-replication', 'image-conversion', 'db-migration'], // §16.1
      env: REQUIRED_ENV.slice(),            // all targets are config-driven
    }, meta));
  }

  // discover(ctx) — inventory the Arc-connected source estate.
  async discover(ctx) {
    const cfg = this.requireConfig(ctx, REQUIRED_ENV); // fail-closed on missing config
    // TODO[SDK]: list Arc machines + Azure Local VMs + protectable items via ARM:
    //   GET .../subscriptions/{sub}/resourceGroups/{rg}/providers/
    //       Microsoft.HybridCompute/machines
    //   GET .../providers/Microsoft.AzureStackHCI/virtualMachines
    //   + the replication appliance's protectable-items list.
    //   Until wired, discover reports the seam openly rather than inventing hosts.
    return {
      ok: false,
      source: 'azure-arc',
      pending: 'sdk',
      detail: 'ARM discovery not wired; cannot enumerate Arc/Azure Local estate yet',
      target: { subscription: cfg.AZURE_SUBSCRIPTION_ID, cluster: cfg.AZURE_LOCAL_CLUSTER },
      units: [],
    };
  }

  // replicate(unit, ctx) — start/seed continuous replication into the target.
  // Runs the executor FSM and opens a replication session; the actual enable-call
  // is the SDK seam. The session records what WAS measured (nothing yet) so verify
  // reads truth, never an assumed success.
  async replicate(unit, ctx) {
    this.requireConfig(ctx, REQUIRED_ENV);
    const pre = await this.validate(unit, ctx);
    if (!pre.ok) return { ok: false, unitId: unit && unit.id, error: 'pre-flight failed', checks: pre.checks };
    this.advance(unit, 'executing');

    const sess = this._sessionFor(unit);
    sess.started = true;
    sess.startedAt = new Date().toISOString();
    sess.kind = unit.kind || 'vm';
    // TODO[SDK]: enable replication for this unit and BLOCK to initial-sync:
    //   POST .../replicationFabrics/.../replicationProtectedItems  (Azure Site
    //   Recovery / Azure Migrate appliance), OR start an Azure Database Migration
    //   Service project for engine==database. On completion, populate sess.measured
    //   from the service's real telemetry. We do NOT set sess.measured here: an
    //   un-measured session must verify as not-verified, not as a pass.
    return {
      ok: true, unitId: unit.id, replicationStarted: true, sessionAt: sess.startedAt,
      note: 'replication session opened; awaiting SDK enable + initial-sync telemetry',
    };
  }

  // verify(unit, ctx) is provided by BaseConnector; we supply the probe set. Each
  // probe reads ONLY real measurements from the replication session. With the SDK
  // seams unwired, sess.measured is empty -> every probe returns notVerified().
  _probes(unit, ctx) {
    const m = (this._sessionFor(unit).measured) || {};
    return {
      replication_lag: async () => {
        // TODO[SDK]: read CDC/replication lag from the replication item health:
        //   GET .../replicationProtectedItems/{item}?$expand=health  (rpoInSeconds).
        if (typeof m.lagSeconds !== 'number') return notVerified('replication lag not measured');
        return m.lagSeconds === 0
          ? verified('replication lag 0s at probe')
          : notVerified(`replication lag ${m.lagSeconds}s (must be 0 at switchover)`);
      },
      row_counts: async () => {
        // TODO[SDK]: compare source vs target object/row counts (DMS validation, or
        //   target disk/object inventory for image moves).
        if (typeof m.sourceRows !== 'number' || typeof m.targetRows !== 'number') {
          return notVerified('row counts not measured');
        }
        return m.sourceRows === m.targetRows
          ? verified(`row counts equal (${m.sourceRows})`)
          : notVerified(`source=${m.sourceRows} target=${m.targetRows}`);
      },
      checksums: async () => {
        // TODO[SDK]: compare content/BLOB hashes between source and replicated target.
        if (m.checksumMatch == null) return notVerified('content checksums not compared');
        return m.checksumMatch === true ? verified('content hashes match') : notVerified('content hash mismatch');
      },
      sequence_identity: async () => {
        // TODO[SDK]: re-validate identity/sequence continuity on the target (DMS post-
        //   migration validation for databases; n/a -> measure true for pure VM moves).
        if (m.sequenceOk == null) return notVerified('identity/sequence continuity not validated');
        return m.sequenceOk === true ? verified('identity/sequence continuity verified') : notVerified('sequence drift');
      },
      constraints: async () => {
        // TODO[SDK]: re-validate keys/FKs/checks on the target post-migration.
        if (m.constraintsOk == null) return notVerified('constraints not re-validated');
        return m.constraintsOk === true ? verified('keys/FKs/checks re-validated') : notVerified('constraint failures');
      },
      smoke: async () => {
        // TODO[SDK]: run the application smoke probe against the migrated target.
        if (m.smokeOk == null) return notVerified('target smoke probe not run');
        return m.smokeOk === true ? verified('critical journeys pass on target') : notVerified('smoke failures');
      },
    };
  }

  // cutover(unit, ctx) — final delta, then commit the migrated target.
  async cutover(unit, ctx) {
    this.requireConfig(ctx, REQUIRED_ENV);
    const sess = this._sessionFor(unit);
    if (!sess.started) return { ok: false, unitId: unit && unit.id, error: 'cannot cut over before replication' };
    // TODO[SDK]: planned failover + commit:
    //   POST .../replicationProtectedItems/{item}/plannedFailover, then /commit
    //   (or DMS cutover) and repoint connection strings. The transfer runs ON THE
    //   SOURCE/appliance via remote management (§16.2), never a gateway-local copy.
    this.advance(unit, 'completed');
    sess.cutOver = true;
    return { ok: true, unitId: unit.id, cutOver: true, note: 'cutover requested; awaiting SDK plannedFailover+commit' };
  }

  // rollback(unit, ctx) — reverse-protect / re-point back to source.
  async rollback(unit, ctx) {
    this.requireConfig(ctx, REQUIRED_ENV);
    const sess = this._sessionFor(unit);
    if (this.canAdvance(unit, 'rolling_back')) this.advance(unit, 'rolling_back');
    // TODO[SDK]: reverse replication direction and fail back:
    //   POST .../replicationProtectedItems/{item}/reprotect then plannedFailover
    //   toward the original source. Confirm source health before declaring done.
    sess.cutOver = false;
    if (this.canAdvance(unit, 'rolled_back')) this.advance(unit, 'rolled_back');
    return { ok: true, unitId: unit.id, rolledBack: true, note: 'fail-back requested; awaiting SDK reprotect' };
  }
}

module.exports = { AzureArcConnector };
