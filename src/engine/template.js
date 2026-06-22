// src/engine/template.js — framework template engine (§8).
// Loads a methodology JSON and normalises it into
//   { id, name, version, phases:[{id,name,station,gate:{id,signerRole,criteria[]}}],
//     states:[...], transitions:[{from,to,gateId}] }
// The same FSM shape the signed-gate engine runs (Figure 3). The signing/RBAC
// machinery is reused unchanged — only the SOURCE of phases/gates is data here.

'use strict';

const fs = require('fs');
const path = require('path');

const STATIONS = new Set(['V', 'O', 'S', 'J']);

function loadFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  return compile(JSON.parse(raw));
}

function loadDir(dir) {
  const out = {};
  if (!fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    const tpl = loadFile(path.join(dir, f));
    out[tpl.id] = tpl;
  }
  return out;
}

// compile(json) -> normalised, frozen template. Validates structure & gate shape.
function compile(json) {
  if (!json || typeof json !== 'object') throw new Error('template must be an object');
  if (!json.id) throw new Error('template requires an id');
  if (!Array.isArray(json.phases) || json.phases.length === 0) {
    throw new Error('template requires a non-empty phases[]');
  }

  const phases = json.phases.map((p, i) => normalisePhase(p, i));
  const states = Array.isArray(json.states) && json.states.length
    ? json.states.slice()
    : deriveStates(phases);
  const transitions = Array.isArray(json.transitions) && json.transitions.length
    ? json.transitions.map((t) => Object.freeze(Object.assign({}, t)))
    : deriveTransitions(phases);

  return Object.freeze({
    id: json.id,
    name: json.name || json.id,
    version: json.version || '1',
    source: json.source || 'custom',
    description: json.description || '',
    phases: Object.freeze(phases),
    states: Object.freeze(states),
    transitions: Object.freeze(transitions),
    // Unit-level lifecycle states are fixed by the engine (§ state-machine).
    unitStates: Object.freeze(['legacy', 'dual_running', 'reconciled', 'migrated']),
  });
}

function normalisePhase(p, i) {
  if (!p.id) throw new Error(`phase[${i}] requires an id`);
  if (p.station && !STATIONS.has(p.station)) {
    throw new Error(`phase ${p.id} has invalid station '${p.station}'`);
  }
  const gate = normaliseGate(p.gate, p.id);
  return Object.freeze({
    id: p.id,
    ordinal: typeof p.ordinal === 'number' ? p.ordinal : i + 1,
    name: p.name || p.id,
    goal: p.goal || '',
    station: p.station || 'V',
    activities: Object.freeze(Array.isArray(p.activities) ? p.activities.slice() : []),
    deliverables: Object.freeze(Array.isArray(p.deliverables) ? p.deliverables.slice() : []),
    entryCriteria: Object.freeze(Array.isArray(p.entryCriteria) ? p.entryCriteria.slice() : []),
    roles: Object.freeze(Array.isArray(p.roles) ? p.roles.slice() : []),
    gate,
  });
}

function normaliseGate(g, phaseId) {
  if (!g) return null; // a phase may have no exit gate (rare)
  if (!g.id) throw new Error(`phase ${phaseId} gate requires an id`);
  return Object.freeze({
    id: g.id,
    name: g.name || g.id,
    signerRole: g.signerRole || (Array.isArray(g.signoffRoles) ? g.signoffRoles[0] : null),
    signoffRoles: Object.freeze(Array.isArray(g.signoffRoles)
      ? g.signoffRoles.slice()
      : (g.signerRole ? [g.signerRole] : [])),
    requiresSignature: g.requiresSignature !== false,
    criteria: Object.freeze(Array.isArray(g.criteria) ? g.criteria.slice() : []),
    // Marks the Shift->Jump cutover gate so the engine can pin/inject it (§14.1).
    cutover: Boolean(g.cutover),
  });
}

// states default to the ordered phase ids if not declared.
function deriveStates(phases) {
  return phases.map((p) => p.id);
}

// linear transitions phase[i] -> phase[i+1], gated by phase[i]'s exit gate.
function deriveTransitions(phases) {
  const out = [];
  for (let i = 0; i < phases.length - 1; i += 1) {
    out.push(Object.freeze({
      from: phases[i].id,
      to: phases[i + 1].id,
      gateId: phases[i].gate ? phases[i].gate.id : null,
    }));
  }
  return out;
}

module.exports = { loadFile, loadDir, compile, STATIONS };
