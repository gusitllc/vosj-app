// src/engine/template-store.js — DB-backed framework-template lifecycle (§8.2/§8.3).
// The compiler (engine/template.js) stays the single source of structural truth;
// this layer only PERSISTS a compiled template's body as JSONB and manages its
// lifecycle: create (blank or from a V->O->S->J skeleton), clone (recording
// parent_template_id lineage), edit (draft only), publish (draft->published with a
// version bump), diff (structural phase/gate/role delta against the parent), and
// list (with a strongest-fit hint). It never forks the compiler — every write is
// validated through template.compile() so a malformed template fails closed (gap 63).
//
// Storage shape (vosj.templates): the row carries id/name/source/version/lineage/
// visibility/status/owner/tenant_id columns plus body JSONB = the compiled
// { id, name, version, source, description, phases[], states[], transitions[] }.
// Framework roles persist separately (vosj.framework_roles, gap 55).

'use strict';

const template = require('./template');

const STATIONS = ['V', 'O', 'S', 'J'];

// buildTemplateStore({ store }) -> the lifecycle facade. Requires a StateStore that
// implements the optional template methods (memory + pg both do); throws otherwise.
function buildTemplateStore({ store }) {
  if (!store || typeof store.saveTemplateDb !== 'function') {
    throw new Error('template-store requires a store with template persistence');
  }

  // ---- read ----------------------------------------------------------------
  async function get(id) {
    const row = await store.getTemplateDb(id);
    if (!row) return null;
    return rowToCompiled(row);
  }

  // list({ visibility, tenantId, status }) -> [{ ...summary, fitHint }] (gaps 55/56).
  // The strongest-fit hint is a lightweight, deterministic score so a consultant can
  // see at a glance which template best matches a target without binding it.
  async function list(filter = {}) {
    const rows = await store.listTemplatesDb(filter || {});
    const roleCounts = await rolesByTemplate(rows.map((r) => r.id));
    return rows.map((r) => decorate(r, roleCounts[r.id] || 0, filter));
  }

  // ---- create (gap 59) -----------------------------------------------------
  // create(draft, { owner, tenantId, visibility, fromSkeleton }) -> persisted draft.
  // A blank draft must still compile; fromSkeleton emits the 4-station 7-phase stub.
  async function create(draft, opts = {}) {
    const input = draft || {};
    const src = opts.fromSkeleton ? skeleton(input) : input;
    if (!src.id) throw new Error('template requires an id');
    const existing = await store.getTemplateDb(src.id);
    if (existing) throw new Error(`template already exists: ${src.id}`);
    const compiled = template.compile(withDefaults(src));
    // visibility/roles are read from the ORIGINAL draft (the skeleton helper drops
    // non-structural metadata), then overridden by an explicit opts value.
    return persist(compiled, {
      source: input.source || 'custom',
      status: 'draft',
      parent_template_id: null,
      visibility: opts.visibility || input.visibility || 'private',
      owner: opts.owner || null,
      tenant_id: opts.tenantId || null,
    }, input.roles || src.roles);
  }

  // ---- clone (gap 58) ------------------------------------------------------
  // clone(parentId, { id, owner, tenantId, visibility }) -> a DRAFT that records
  // parent_template_id lineage. The clone starts at version 1 of its own line; the
  // parent is read from the DB OR the filesystem-seeded set (so a seed can be cloned).
  async function clone(parentId, opts = {}) {
    const parent = await resolveParent(parentId, opts.fallbackGet);
    if (!parent) throw new Error(`unknown parent template: ${parentId}`);
    const id = (opts.id || `${parent.id}-clone`).trim();
    if (!id) throw new Error('clone requires a target id');
    if (await store.getTemplateDb(id)) throw new Error(`template already exists: ${id}`);
    const body = compiledBody(parent, { id, version: '1' });
    const compiled = template.compile(body);
    const roles = await parentRoles(parent.id, opts.fallbackRoles);
    return persist(compiled, {
      source: parent.source || 'custom',
      status: 'draft',
      parent_template_id: parent.id, // lineage recorded (gap 58)
      visibility: opts.visibility || 'private',
      owner: opts.owner || null,
      tenant_id: opts.tenantId || null,
    }, roles);
  }

  // ---- edit (draft only) ---------------------------------------------------
  // edit(id, patch) -> re-compiled draft. A published template is IMMUTABLE; editing
  // it is rejected (a run pins its version, so an edit must produce a new version via
  // a clone or a re-publish). patch is a shallow body overlay (name/description/phases).
  async function edit(id, patch = {}) {
    const row = await requireRow(id);
    if (row.status !== 'draft') {
      throw new Error(`cannot edit a ${row.status} template: ${id} (clone it to a draft first)`);
    }
    const merged = Object.assign({}, row.body, patch, { id: row.id });
    if (patch.version === undefined) merged.version = row.version;
    // A phases edit invalidates any previously-derived states/transitions: drop the
    // stale ones (unless the patch supplies its own) so the compiler re-derives the
    // linear transitions from the NEW phase gates (else a gate could go unreachable).
    if (patch.phases !== undefined) {
      if (patch.states === undefined) delete merged.states;
      if (patch.transitions === undefined) delete merged.transitions;
    }
    const compiled = template.compile(merged);
    const saved = await persist(compiled, {
      source: row.source,
      status: 'draft',
      parent_template_id: row.parent_template_id || null,
      visibility: row.visibility,
      owner: row.owner || null,
      tenant_id: row.tenant_id || null,
    }, Array.isArray(patch.roles) ? patch.roles : undefined);
    return saved;
  }

  // ---- publish (draft -> published, version bump) --------------------------
  // publish(id) -> the published template. Only a draft may be published; the
  // version is bumped (a pinned run is unaffected because it pinned the prior value).
  async function publish(id) {
    const row = await requireRow(id);
    if (row.status === 'published') throw new Error(`template already published: ${id}`);
    if (row.status !== 'draft') throw new Error(`cannot publish a ${row.status} template: ${id}`);
    const nextVersion = bumpVersion(row.version);
    const compiled = template.compile(Object.assign({}, row.body, { version: nextVersion }));
    return persist(compiled, {
      source: row.source,
      status: 'published',
      parent_template_id: row.parent_template_id || null,
      visibility: row.visibility,
      owner: row.owner || null,
      tenant_id: row.tenant_id || null,
    });
  }

  // ---- diff against parent (gap 58) ----------------------------------------
  // diff(id) -> structural delta vs parent_template_id: added/removed/changed phases,
  // gate-role changes, and added/removed roles. Throws if the template has no parent.
  async function diff(id, opts = {}) {
    const row = await requireRow(id);
    if (!row.parent_template_id) throw new Error(`template has no parent to diff: ${id}`);
    const parent = await resolveParent(row.parent_template_id, opts.fallbackGet);
    if (!parent) throw new Error(`parent template not found: ${row.parent_template_id}`);
    const child = rowToCompiled(row);
    const childRoles = await store.listFrameworkRoles(id);
    const parentRoleRows = await parentRoles(parent.id, opts.fallbackRoles);
    return structuralDiff(parent, child, parentRoleRows, childRoles);
  }

  // ---- skeleton (gap 59) ---------------------------------------------------
  // skeleton(meta) -> a valid 4-station, 7-phase V->O->S->J stub the compiler accepts.
  // P1-P2 on V, P3-P4 on O, P5 on S, P6-P7 on J — the canonical station mapping. The
  // final J gate is the cutover gate so the engine's verified-before-Jump pins to it.
  function skeleton(meta = {}) {
    const id = (meta.id || '').trim();
    if (!id) throw new Error('skeleton requires an id');
    return {
      id,
      name: meta.name || id,
      version: '1',
      source: meta.source || 'custom',
      description: meta.description || 'V->O->S->J skeleton (7-phase gated stub).',
      phases: skeletonPhases(),
      roles: meta.roles,
    };
  }

  // ---- internals -----------------------------------------------------------
  async function persist(compiled, meta, roles) {
    const row = await store.saveTemplateDb({
      id: compiled.id,
      name: compiled.name,
      source: meta.source || compiled.source || 'custom',
      version: compiled.version,
      parent_template_id: meta.parent_template_id || null,
      visibility: meta.visibility || 'private',
      status: meta.status || 'draft',
      body: compiledBody(compiled),
      owner: meta.owner || null,
      tenant_id: meta.tenant_id || null,
    });
    if (Array.isArray(roles)) await persistRoles(compiled.id, roles);
    return rowToCompiled(row);
  }

  async function persistRoles(templateId, roles) {
    for (const r of roles) {
      if (!r || !r.role_key && !r.roleKey) continue;
      await store.saveFrameworkRole({
        template_id: templateId,
        role_key: r.role_key || r.roleKey,
        display: r.display || null,
        rbac_capability: r.rbac_capability || r.rbacCapability || null,
      });
    }
  }

  async function requireRow(id) {
    const row = await store.getTemplateDb(id);
    if (!row) throw new Error(`unknown template: ${id}`);
    return row;
  }

  // resolveParent: DB row first (clone of an edited draft/published), else a
  // filesystem-seeded compiled template via the optional fallbackGet (clone of a seed).
  async function resolveParent(parentId, fallbackGet) {
    const row = await store.getTemplateDb(parentId);
    if (row) return rowToCompiled(row);
    if (typeof fallbackGet === 'function') {
      try { return fallbackGet(parentId); } catch (_) { return null; }
    }
    return null;
  }

  async function parentRoles(templateId, fallbackRoles) {
    const rows = await store.listFrameworkRoles(templateId);
    if (rows.length || typeof fallbackRoles !== 'function') return rows;
    try { return fallbackRoles(templateId) || []; } catch (_) { return []; }
  }

  async function rolesByTemplate(ids) {
    const out = {};
    for (const id of ids) out[id] = (await store.listFrameworkRoles(id)).length;
    return out;
  }

  return { get, list, create, clone, edit, publish, diff, skeleton };
}

// rowToCompiled(row) -> a frozen compiled template carrying its lifecycle metadata.
// The body is re-compiled so a stored template is always structurally valid on read.
function rowToCompiled(row) {
  const compiled = template.compile(Object.assign({}, row.body, {
    id: row.id, name: row.name, version: row.version, source: row.source,
  }));
  return Object.freeze(Object.assign({}, compiled, {
    status: row.status,
    visibility: row.visibility,
    parentTemplateId: row.parent_template_id || null,
    owner: row.owner || null,
    tenantId: row.tenant_id || null,
  }));
}

// compiledBody(tpl, overrides) -> the JSONB body persisted in vosj.templates.body.
// Stores phases/states/transitions exactly so a round-trip recompiles identically.
function compiledBody(tpl, overrides = {}) {
  return Object.assign({
    id: tpl.id,
    name: tpl.name,
    version: tpl.version,
    source: tpl.source,
    description: tpl.description || '',
    phases: tpl.phases.map(phasePlain),
    states: tpl.states.slice(),
    transitions: tpl.transitions.map((t) => Object.assign({}, t)),
  }, overrides);
}

function phasePlain(p) {
  return {
    id: p.id, ordinal: p.ordinal, name: p.name, goal: p.goal, station: p.station,
    activities: p.activities.slice(), deliverables: p.deliverables.slice(),
    entryCriteria: p.entryCriteria.slice(), roles: p.roles.slice(),
    gate: p.gate ? gatePlain(p.gate) : null,
  };
}

function gatePlain(g) {
  return {
    id: g.id, name: g.name, signerRole: g.signerRole,
    signoffRoles: g.signoffRoles.slice(), requiresSignature: g.requiresSignature,
    criteria: g.criteria.slice(), cutover: g.cutover,
  };
}

function withDefaults(src) {
  // A blank draft must still compile: ensure at least one phase exists.
  if (Array.isArray(src.phases) && src.phases.length) return src;
  return Object.assign({}, src, { phases: skeletonPhases() });
}

// decorate(row, roleCount, filter) -> a list summary with a strongest-fit hint (gap 56).
function decorate(row, roleCount, filter) {
  const phases = Array.isArray(row.body && row.body.phases) ? row.body.phases : [];
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    source: row.source,
    status: row.status,
    visibility: row.visibility,
    parentTemplateId: row.parent_template_id || null,
    owner: row.owner || null,
    tenantId: row.tenant_id || null,
    phases: phases.length,
    stations: phases.map((p) => p.station),
    roles: roleCount,
    fitHint: fitHint(row, phases, roleCount, filter),
  };
}

// fitHint — a deterministic strongest-fit score in [0,1] + a short label. A consultant
// browsing (gap 56) sees which template best fits: full 4-station coverage, a complete
// 7-phase spine, a declared role set, and tenant-ownership all raise the score.
function fitHint(row, phases, roleCount, filter) {
  let score = 0;
  const stations = new Set(phases.map((p) => p.station));
  score += (STATIONS.filter((s) => stations.has(s)).length / STATIONS.length) * 0.4;
  score += Math.min(phases.length, 7) / 7 * 0.3;
  if (roleCount > 0) score += 0.15;
  if (filter && filter.tenantId && row.tenant_id === filter.tenantId) score += 0.15;
  else if (row.visibility === 'public') score += 0.1;
  const rounded = Math.round(score * 100) / 100;
  const label = rounded >= 0.8 ? 'strong' : rounded >= 0.5 ? 'moderate' : 'weak';
  return { score: rounded, label };
}

// structuralDiff(parent, child, parentRoles, childRoles) -> phase/gate/role delta.
function structuralDiff(parent, child, parentRoles, childRoles) {
  const pPhases = indexBy(parent.phases, 'id');
  const cPhases = indexBy(child.phases, 'id');
  const phasesAdded = child.phases.filter((p) => !pPhases[p.id]).map((p) => p.id);
  const phasesRemoved = parent.phases.filter((p) => !cPhases[p.id]).map((p) => p.id);
  const phasesChanged = [];
  for (const p of child.phases) {
    const prev = pPhases[p.id];
    if (prev) collectPhaseChange(prev, p, phasesChanged);
  }
  return {
    parent: { id: parent.id, version: parent.version },
    child: { id: child.id, version: child.version },
    phasesAdded,
    phasesRemoved,
    phasesChanged,
    rolesAdded: roleKeyDelta(childRoles, parentRoles),
    rolesRemoved: roleKeyDelta(parentRoles, childRoles),
    changed: phasesAdded.length > 0 || phasesRemoved.length > 0 || phasesChanged.length > 0,
  };
}

function collectPhaseChange(prev, p, out) {
  const fields = [];
  if (prev.station !== p.station) fields.push('station');
  if (prev.name !== p.name) fields.push('name');
  const pg = prev.gate || {};
  const cg = p.gate || {};
  if (pg.id !== cg.id) fields.push('gate.id');
  if (pg.signerRole !== cg.signerRole) fields.push('gate.signerRole');
  if (!sameSet(pg.signoffRoles, cg.signoffRoles)) fields.push('gate.signoffRoles');
  if (Boolean(pg.cutover) !== Boolean(cg.cutover)) fields.push('gate.cutover');
  if (fields.length) out.push({ id: p.id, fields });
}

function roleKeyDelta(a, b) {
  const set = new Set((b || []).map((r) => r.role_key));
  return (a || []).map((r) => r.role_key).filter((k) => !set.has(k));
}

function indexBy(arr, key) {
  const out = {};
  for (const x of arr) out[x[key]] = x;
  return out;
}

function sameSet(a, b) {
  const sa = new Set(a || []);
  const sb = new Set(b || []);
  if (sa.size !== sb.size) return false;
  for (const x of sa) if (!sb.has(x)) return false;
  return true;
}

// bumpVersion('1') -> '2'; '1.2' -> '1.3'; non-numeric tail -> append '-r2'.
function bumpVersion(v) {
  const s = String(v || '1');
  const m = s.match(/^(.*?)(\d+)$/);
  if (!m) return `${s}-r2`;
  return `${m[1]}${Number(m[2]) + 1}`;
}

// skeletonPhases() -> the canonical 4-station, 7-phase V->O->S->J stub.
function skeletonPhases() {
  return [
    phaseStub('P1', 'Envision', 'V', 'director', false),
    phaseStub('P2', 'Examine', 'V', 'it-lead', false),
    phaseStub('P3', 'Engineer the Plan', 'O', 'director', false),
    phaseStub('P4', 'Establish Readiness', 'O', 'infosec', false),
    phaseStub('P5', 'Shift / Execute', 'S', 'director', false),
    phaseStub('P6', 'Verify & Optimize', 'J', 'dba', true),
    phaseStub('P7', 'Jump to BAU & Learn', 'J', 'director', false),
  ];
}

function phaseStub(id, name, station, signerRole, cutover) {
  return {
    id,
    name,
    station,
    goal: '',
    activities: [],
    deliverables: [],
    roles: [signerRole],
    gate: {
      id: `g-${id.toLowerCase()}`,
      name: `${name} sign-off`,
      signerRole,
      signoffRoles: [signerRole],
      requiresSignature: true,
      criteria: [],
      cutover,
    },
  };
}

module.exports = { buildTemplateStore, skeletonPhases };
