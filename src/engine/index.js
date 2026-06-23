// src/engine/index.js — assembles the Vosj engine facade placed on ctx.engine.
// Bundles the template loader, the signed-gate state machine, the 7-R disposition
// engine, the gate signer, and the reconciliation engine into one object the API,
// MCP, and UI layers call. Templates are loaded from templates/*.json at build.

'use strict';

const path = require('path');
const template = require('./template');
const { buildTemplateStore } = require('./template-store');
const disposition = require('./disposition');
const reconcile = require('./reconcile');
const { StateMachine, UNIT_STATES, INJECTED_CUTOVER_GATE } = require('./state-machine');
const { HumanGateSigner } = require('./gate');
const { WaiverRegistry, evaluateChecks } = require('./waiver');

const TEMPLATES_DIR = path.join(__dirname, '..', '..', 'templates');

// buildEngine({ config, store, ledger }) -> engine facade.
function buildEngine({ config, store = null, ledger }) {
  if (!ledger) throw new Error('engine requires a ledger');
  const signer = new HumanGateSigner({ ledger, store });
  const waivers = new WaiverRegistry({ store, ledger });
  const templates = template.loadDir(TEMPLATES_DIR);

  // DB-backed template lifecycle (clone/create/edit/publish/diff). Only available
  // when the store implements the optional template methods (memory + pg both do);
  // absent on a bare store so the spine still boots (fail-soft, like waivers).
  let templateStore = null;
  if (store && typeof store.saveTemplateDb === 'function') {
    try { templateStore = buildTemplateStore({ store }); } catch (_) { templateStore = null; }
  }

  // Filesystem-seeded template accessor — synchronous, used for version pinning at
  // kickoff (routes.buildWave) and as the diff/clone parent fallback.
  function fsTemplate(id) { return templates[id] || null; }

  function getTemplate(id) {
    const tpl = templates[id];
    if (!tpl) throw new Error(`unknown template: ${id}`);
    return tpl;
  }

  // getTemplateAsync(id) — filesystem first, then the DB overlay (gap 59/63). Lets a
  // wave bind a DB-authored template without changing the synchronous getTemplate path.
  async function getTemplateAsync(id) {
    if (templates[id]) return templates[id];
    if (templateStore) {
      const dbTpl = await templateStore.get(id);
      if (dbTpl) return dbTpl;
    }
    throw new Error(`unknown template: ${id}`);
  }

  function machineFor(templateId) {
    return new StateMachine(getTemplate(templateId), { signer, store });
  }

  return {
    config,
    signer,
    waivers,

    // advisory waiver enforcement (hard invariants remain structurally unwaivable)
    tryWaive: (check, actor) => waivers.tryWaive(check, actor),
    evaluateChecks: (checks, actor) => evaluateChecks(checks, waivers, actor),

    // templates
    listTemplates() { return Object.values(templates).map(summary); },
    getTemplate,
    getTemplateAsync,
    fsTemplate,
    compileTemplate: template.compile,
    // DB-backed lifecycle facade (null when the store has no template persistence).
    templateStore,

    // disposition (7-R)
    classify: disposition.classify,
    contractFor: disposition.contractFor,
    dispositions: disposition.ALL,

    // state machine
    machineFor,
    unitStates: () => UNIT_STATES.slice(),
    injectedCutoverGate: INJECTED_CUTOVER_GATE,

    // reconciliation
    reconcile: (unit, connector, ctx) =>
      reconcile.reconcile(unit, connector, Object.assign({ config }, ctx)),

    // counts for /health
    async counts() {
      const workloads = store ? (await store.listWorkloads({})).length : 0;
      const waves = store ? (await store.listWaves({})).length : 0;
      return { workloads, waves };
    },
  };
}

function summary(tpl) {
  return {
    id: tpl.id, name: tpl.name, version: tpl.version, source: tpl.source,
    description: tpl.description, phases: tpl.phases.length,
    stations: tpl.phases.map((p) => p.station),
  };
}

module.exports = { buildEngine, TEMPLATES_DIR };
