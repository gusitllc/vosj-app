// src/engine/index.js — assembles the Vosj engine facade placed on ctx.engine.
// Bundles the template loader, the signed-gate state machine, the 7-R disposition
// engine, the gate signer, and the reconciliation engine into one object the API,
// MCP, and UI layers call. Templates are loaded from templates/*.json at build.

'use strict';

const path = require('path');
const template = require('./template');
const disposition = require('./disposition');
const reconcile = require('./reconcile');
const { StateMachine, UNIT_STATES, INJECTED_CUTOVER_GATE } = require('./state-machine');
const { HumanGateSigner } = require('./gate');

const TEMPLATES_DIR = path.join(__dirname, '..', '..', 'templates');

// buildEngine({ config, store, ledger }) -> engine facade.
function buildEngine({ config, store = null, ledger }) {
  if (!ledger) throw new Error('engine requires a ledger');
  const signer = new HumanGateSigner({ ledger, store });
  const templates = template.loadDir(TEMPLATES_DIR);

  function getTemplate(id) {
    const tpl = templates[id];
    if (!tpl) throw new Error(`unknown template: ${id}`);
    return tpl;
  }

  function machineFor(templateId) {
    return new StateMachine(getTemplate(templateId), { signer, store });
  }

  return {
    config,
    signer,

    // templates
    listTemplates() { return Object.values(templates).map(summary); },
    getTemplate,
    compileTemplate: template.compile,

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
