// src/connectors/azure-arc.js — Azure Arc / Azure Local connector stub (§16).
// Mode 1 (API orchestration, §16): drives the DURABLE first-party primitives —
// block/disk replication, image conversion, and database migration — into
// Azure / AKS-on-Azure-Local rather than any churn-prone product name (§16.1).
//
// This is a STRUCTURAL STUB: discover/replicate/cutover/rollback carry clear
// TODOs for the real Arc/ARM + replication-service calls, but verify() returns a
// genuine, structured proof so the verified-before-Jump gate (§13) can be
// exercised end-to-end against a simulated replication target.

'use strict';

const { BaseConnector, category } = require('./sdk');

class AzureArcConnector extends BaseConnector {
  constructor(meta = {}) {
    super(Object.assign({
      id: 'azure-arc',
      name: 'Azure Arc / Azure Local',
      modes: ['api-orchestration'],         // §16 Mode 1
      primitives: ['disk-replication', 'image-conversion', 'db-migration'], // §16.1
      // All targets are config-driven — no hardcoded subscription/region/host.
      env: ['AZURE_SUBSCRIPTION_ID', 'AZURE_ARC_RESOURCE_GROUP', 'AZURE_LOCAL_CLUSTER'],
    }, meta));
    this._units = new Map(); // unitId -> simulated replication state
  }

  // discover(ctx) — inventory the Arc-connected source estate.
  async discover(_ctx) {
    // TODO: enumerate Arc-connected machines / Azure Local VMs via ARM
    //   (Microsoft.HybridCompute/machines, Microsoft.AzureStackHCI/virtualMachines)
    //   and the replication appliance's protectable items. Return real units.
    return {
      ok: true,
      source: 'azure-arc',
      units: [
        { id: 'arc-vm-app01', name: 'app01 (Arc VM)', kind: 'vm', os: 'linux', diskGiB: 128 },
        { id: 'arc-sql01', name: 'sql01 (Arc SQL)', kind: 'database', engine: 'mssql', rowCount: 0 },
      ],
      note: 'STUB inventory — wire ARM + replication-appliance discovery here.',
    };
  }

  // replicate(unit, ctx) — start/seed continuous replication into the target.
  async replicate(unit, ctx) {
    await this.validate(unit, ctx); // §16.2 pre-flight before executing
    this.advance(unit, 'executing');
    const st = this._stateFor(unit);
    // TODO: enable replication via the disk/block replication service or DB
    //   migration service; for image-conversion targets, convert then attach.
    st.replicated = true;
    st.lagSeconds = 0;          // settled target at the switchover instant (§13)
    st.sourceRows = unit.rowCount || 0;
    st.targetRows = st.sourceRows;
    st.checksumMatch = true;
    this.advance(unit, 'completed');
    return { ok: true, unitId: unit.id, replicated: true, note: 'STUB replication seeded.' };
  }

  // verify(unit, ctx) is provided by BaseConnector; we supply the categories.
  async _verifyCategories(unit, _ctx) {
    const st = this._stateFor(unit);
    const src = st.sourceRows || 0;
    const tgt = st.targetRows != null ? st.targetRows : src;
    const lag = st.lagSeconds != null ? st.lagSeconds : null;
    // TODO: replace simulated values with real replication-health, CDC lag,
    //   target row/object counts, content-hash compare, identity/sequence and
    //   constraint re-validation, and an application smoke probe against target.
    return [
      category('replication_lag', lag === 0, `replication lag: ${lag}s (must be 0 at switchover)`),
      category('row_counts', src === tgt, `source=${src} target=${tgt}`),
      category('checksums', st.checksumMatch === true, 'content/BLOB hashes compared (simulated)'),
      category('sequence_identity', st.replicated === true, 'identity/sequence continuity (simulated)'),
      category('constraints', st.replicated === true, 'keys/FKs/checks re-validated (simulated)'),
      category('smoke', st.replicated === true, 'critical user journeys vs target (simulated)'),
    ];
  }

  // cutover(unit, ctx) — final delta, then commit the migrated target.
  async cutover(unit, _ctx) {
    const st = this._stateFor(unit);
    if (!st.replicated) return { ok: false, error: 'cannot cut over before replication' };
    // TODO: planned failover / final-sync + commit via the replication service;
    //   for DB migration, perform the cutover and repoint connection strings.
    //   The Shift transfer runs ON THE SOURCE HOST via remote management (§16.2),
    //   never a gateway-local copy.
    st.cutOver = true;
    return { ok: true, unitId: unit.id, cutOver: true, note: 'STUB cutover committed.' };
  }

  // rollback(unit, ctx) — reverse-protect / re-point back to source.
  async rollback(unit, _ctx) {
    const st = this._stateFor(unit);
    // TODO: reverse replication direction and fail back to the original source.
    st.cutOver = false;
    return { ok: true, unitId: unit.id, rolledBack: true, note: 'STUB rollback / fail-back.' };
  }

  _stateFor(unit) {
    const id = unit && unit.id;
    if (!this._units.has(id)) this._units.set(id, {});
    return this._units.get(id);
  }
}

module.exports = { AzureArcConnector };
