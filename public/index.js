// public/index.js — Vosj CE Command Center (full "glass-room" workstation).
// Wires every panel of index.html to the /api/* routes (src/api/routes.js):
//   V·O·S·J pipeline · Workloads + 7-R · Waves + create · Wave detail ·
//   Human Gate Sign · Reconcile & Jump · Tamper-evident Ledger.
// Vanilla JS, fetch + DOM only — NO framework, NO CDN. Every server-supplied
// value passes through esc() before it touches the DOM (XSS). { ok:false }
// envelopes + HTTP errors surface as inline banners + toasts, never thrown to
// the console. Self-contained: app.js serves the focused board (app.html); this
// file serves the workstation and shares only the proven helper PATTERNS.
'use strict';

// ---------------------------------------------------------------------------
// DOM + escaping helpers
// ---------------------------------------------------------------------------
function $(id) { return document.getElementById(id); }

// esc() — HTML-escape ALL server/user content before interpolation (XSS guard).
function esc(v) {
  if (v === null || v === undefined) return '';
  return String(v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function toast(msg, kind) {
  const el = document.createElement('div');
  el.className = 'toast' + (kind ? ' ' + kind : '');
  el.textContent = msg;
  $('toast').appendChild(el);
  setTimeout(() => { el.remove(); }, 4200);
}

function bannerHtml(msg) { return '<div class="empty error">' + esc(msg) + '</div>'; }

// ---------------------------------------------------------------------------
// Auth token (field mirrored to localStorage)
// ---------------------------------------------------------------------------
const TOKEN_KEY = 'vosj.token';
function getToken() { return ($('token').value || '').trim(); }
function loadToken() {
  try { $('token').value = localStorage.getItem(TOKEN_KEY) || ''; } catch (_) { /* no storage */ }
}
function saveToken() {
  try { localStorage.setItem(TOKEN_KEY, getToken()); } catch (_) { /* no storage */ }
  toast('Token saved', 'ok');
}

// ---------------------------------------------------------------------------
// API client: returns { ok, ...data } or { ok:false, error } (never throws)
// ---------------------------------------------------------------------------
function authHeaders(extra) {
  const h = Object.assign({ Accept: 'application/json' }, extra || {});
  const tok = getToken();
  if (tok) h.Authorization = 'Bearer ' + tok; // matches src/api/auth.js bearer scheme
  return h;
}

async function api(method, path, body) {
  const init = { method, headers: authHeaders(body ? { 'Content-Type': 'application/json' } : null) };
  if (body) init.body = JSON.stringify(body);
  try {
    const res = await fetch(path, init);
    const data = await res.json().catch(() => ({ ok: false, error: 'invalid JSON from server' }));
    if (data && typeof data.ok === 'boolean') return Object.assign({ status: res.status }, data);
    if (!res.ok) return { ok: false, error: 'HTTP ' + res.status, status: res.status };
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    return { ok: false, error: 'network error: ' + (e && e.message ? e.message : e) };
  }
}

const apiGet = (p) => api('GET', p);
const apiPost = (p, b) => api('POST', p, b);

// ---------------------------------------------------------------------------
// Client state
// ---------------------------------------------------------------------------
const state = {
  templates: [],       // GET /api/templates summaries
  templateCache: {},   // id -> full template (GET /api/templates/:id), lazy
  workloads: [],       // GET /api/workloads
  waves: [],           // GET /api/waves
  selectedWaveId: null,
};

// 7-R disposition reference: cutover style + risk per disposition. Mirrors the
// engine's typed contracts (§7) so the workloads table can show a cutover hint
// without an extra classify round-trip per row.
const DISPOSITIONS = [
  { id: 'Retire', cutoverStyle: 'none', highRisk: false },
  { id: 'Retain', cutoverStyle: 'none', highRisk: false },
  { id: 'Rehost', cutoverStyle: 'big-bang', highRisk: false },
  { id: 'Relocate', cutoverStyle: 'strangler-fig', highRisk: true },
  { id: 'Repurchase', cutoverStyle: 'big-bang', highRisk: false },
  { id: 'Replatform', cutoverStyle: 'strangler-fig', highRisk: true },
  { id: 'Refactor', cutoverStyle: 'strangler-fig', highRisk: true },
];
function dispMeta(name) { return DISPOSITIONS.find((d) => d.id === name) || null; }

// Unit lifecycle states the pipeline visualises (legacy → … → migrated).
const LIFECYCLE = ['legacy', 'dual_running', 'reconciled', 'migrated'];

// ---------------------------------------------------------------------------
// Health strip
// ---------------------------------------------------------------------------
function dot(ok) { return '<span class="dot ' + (ok ? 'ok' : 'bad') + '"></span>'; }

async function loadHealth() {
  const strip = $('healthStrip');
  const r = await apiGet('/health');
  if (!r.ok) {
    strip.innerHTML = '<span><span class="dot bad"></span>health unreachable &mdash; ' + esc(r.error) + '</span>';
    return;
  }
  strip.innerHTML = [
    '<span>' + dot(true) + 'version <b>' + esc(r.version) + '</b></span>',
    '<span>' + dot(r.storeOk) + 'store <b>' + esc(r.store) + '</b></span>',
    '<span>' + dot(r.ledgerOk) + 'ledger <b>' + (r.ledgerOk ? 'ok' : 'unsigned') + '</b></span>',
    '<span>workloads <b>' + esc(r.workloads) + '</b></span>',
    '<span>waves <b>' + esc(r.waves) + '</b></span>',
    '<span>uptime <b>' + Math.round(r.uptime || 0) + 's</b></span>',
  ].join('');
}

// ---------------------------------------------------------------------------
// Templates (populate the wave-create select + cache full phase machines)
// ---------------------------------------------------------------------------
async function loadTemplates() {
  const r = await apiGet('/api/templates');
  state.templates = r.ok && Array.isArray(r.templates) ? r.templates : [];
  const sel = $('waveTpl');
  if (!state.templates.length) {
    sel.innerHTML = '<option value="">(no templates)</option>';
    return;
  }
  sel.innerHTML = state.templates
    .map((t) => '<option value="' + esc(t.id) + '">' + esc(t.name || t.id) + '</option>')
    .join('');
}

// Lazily fetch + cache a full template (with phases[] + transitions[]).
async function getFullTemplate(id) {
  if (!id) return null;
  if (state.templateCache[id]) return state.templateCache[id];
  const r = await apiGet('/api/templates/' + encodeURIComponent(id));
  if (!r.ok || !r.template) return null;
  state.templateCache[id] = r.template;
  return r.template;
}

// ---------------------------------------------------------------------------
// V·O·S·J Pipeline — station throughput by unit lifecycle
// ---------------------------------------------------------------------------
function renderPipeline() {
  const counts = {};
  LIFECYCLE.forEach((s) => { counts[s] = 0; });
  state.workloads.forEach((w) => {
    const s = (w.state || 'legacy');
    if (counts[s] === undefined) counts[s] = 0;
    counts[s] += 1;
  });
  $('pipeline').innerHTML = LIFECYCLE.map((s) => ''
    + '<div class="station state-' + esc(s) + '">'
    + '<div class="name">' + esc(s.replace(/_/g, ' ')) + '</div>'
    + '<div class="count">' + esc(counts[s]) + '</div>'
    + '</div>').join('');
}

// ---------------------------------------------------------------------------
// Workloads + 7-R disposition
// ---------------------------------------------------------------------------
async function loadWorkloads() {
  const r = await apiGet('/api/workloads');
  if (!r.ok) {
    $('workloadsBody').innerHTML = '<tr><td colspan="7">' + bannerHtml(r.error || 'failed to load workloads') + '</td></tr>';
    return;
  }
  state.workloads = Array.isArray(r.workloads) ? r.workloads : [];
  renderWorkloads();
  renderPipeline();
  populateUnitSelect();
}

function renderWorkloads() {
  const body = $('workloadsBody');
  if (!state.workloads.length) {
    body.innerHTML = '<tr><td colspan="7" class="empty">No workloads yet.</td></tr>';
    return;
  }
  body.innerHTML = state.workloads.map(workloadRow).join('');
  body.querySelectorAll('button[data-classify]').forEach((b) => {
    b.addEventListener('click', () => onClassify(b.getAttribute('data-classify')));
  });
}

function workloadRow(w) {
  const disp = w.disposition || '';
  const meta = dispMeta(disp);
  const cutover = meta ? meta.cutoverStyle : '';
  const cutChip = !disp ? '<span class="chip">(auto)</span>'
    : (meta && meta.cutoverStyle === 'strangler-fig'
      ? '<span class="chip warn">strangler-fig</span>'
      : '<span class="chip">' + esc(cutover || 'n/a') + '</span>');
  const st = w.state || 'legacy';
  return ''
    + '<tr>'
    + '<td class="mono">' + esc(w.id) + '</td>'
    + '<td>' + esc(w.name) + '</td>'
    + '<td>' + (disp ? esc(disp) : '<span class="muted">(auto)</span>') + '</td>'
    + '<td>' + cutChip + '</td>'
    + '<td><span class="chip state-' + esc(st) + '">' + esc(st.replace(/_/g, ' ')) + '</span></td>'
    + '<td>' + esc(w.wave_id || '&mdash;') + '</td>'
    + '<td class="row-actions"><button class="small ghost" data-classify="' + esc(w.id) + '">Classify</button></td>'
    + '</tr>';
}

async function onClassify(id) {
  const r = await apiGet('/api/classify/' + encodeURIComponent(id));
  if (!r.ok) { toast('Classify failed: ' + (r.error || 'error'), 'error'); return; }
  const c = r.classification || {};
  const bigBang = c.bigBangAvailable ? 'big-bang available' : 'big-bang UNAVAILABLE (forced incremental)';
  toast(id + ' → ' + (c.disposition || 'n/a') + (c.strangler ? ' · strangler-fig' : '') + ' · ' + bigBang, 'ok');
}

// Disposition + wave option lists for the add-workload form.
function populateWorkloadFormSelects() {
  const d = $('wlDisp');
  d.innerHTML = '<option value="">(auto / heuristic)</option>'
    + DISPOSITIONS.map((x) => '<option value="' + esc(x.id) + '">' + esc(x.id) + '</option>').join('');
  const wsel = $('wlWave');
  wsel.innerHTML = '<option value="">(unassigned)</option>'
    + state.waves.map((w) => '<option value="' + esc(w.id) + '">' + esc(w.name || w.id) + '</option>').join('');
}

function populateUnitSelect() {
  const sel = $('recUnit');
  if (!state.workloads.length) { sel.innerHTML = '<option value="">(no workloads)</option>'; return; }
  sel.innerHTML = state.workloads
    .map((w) => '<option value="' + esc(w.id) + '">' + esc(w.id) + '</option>').join('');
}

async function onAddWorkload() {
  const id = ($('wlId').value || '').trim();
  const name = ($('wlName').value || '').trim();
  if (!id || !name) { toast('Workload needs an ID and a name', 'error'); return; }
  const body = { id, name, disposition: ($('wlDisp').value || '') || undefined, waveId: ($('wlWave').value || '') || undefined };
  const r = await apiPost('/api/workloads', body);
  if (!r.ok) { toast('Add workload failed: ' + (r.error || 'error'), 'error'); return; }
  toast('Workload saved: ' + id, 'ok');
  $('wlId').value = ''; $('wlName').value = '';
  await Promise.all([loadWorkloads(), loadHealth()]);
}

// ---------------------------------------------------------------------------
// Waves + create
// ---------------------------------------------------------------------------
async function loadWaves() {
  const r = await apiGet('/api/waves');
  if (!r.ok) { $('wavesList').innerHTML = bannerHtml(r.error || 'failed to load waves'); return; }
  state.waves = Array.isArray(r.waves) ? r.waves : [];
  renderWaves();
  populateWorkloadFormSelects();
}

function renderWaves() {
  const host = $('wavesList');
  if (!state.waves.length) { host.innerHTML = '<div class="empty">No waves yet.</div>'; return; }
  host.innerHTML = state.waves.map(waveRow).join('');
  host.querySelectorAll('[data-wave]').forEach((el) => {
    el.addEventListener('click', () => selectWave(el.getAttribute('data-wave')));
  });
}

function waveRow(w) {
  const sel = w.id === state.selectedWaveId;
  const tpl = w.framework_template_id;
  return ''
    + '<div class="card" data-wave="' + esc(w.id) + '" style="cursor:pointer;padding:10px 12px;margin:6px 0;'
    + (sel ? 'border-color:var(--teal)' : '') + '">'
    + '<div class="name">' + esc(w.name || w.id) + '</div>'
    + '<div class="desc mono">' + esc(w.id) + (tpl ? ' &middot; template ' + esc(tpl) : ' &middot; <span class="warn">no template</span>') + '</div>'
    + '<div style="margin-top:6px">phase <span class="chip teal">' + esc(w.state || 'unknown') + '</span></div>'
    + '</div>';
}

async function onAddWave() {
  const id = ($('waveId').value || '').trim();
  const name = ($('waveName').value || '').trim();
  const templateId = ($('waveTpl').value || '').trim();
  if (!id || !name) { toast('Wave needs an ID and a name', 'error'); return; }
  if (!templateId) { toast('Pick a framework template for the wave', 'error'); return; }
  const r = await apiPost('/api/waves', { id, name, templateId });
  if (!r.ok) { toast('Create wave failed: ' + (r.error || 'error'), 'error'); return; }
  toast('Wave created: ' + id, 'ok');
  $('waveId').value = ''; $('waveName').value = '';
  await Promise.all([loadWaves(), loadHealth()]);
  selectWave(id);
}

// ---------------------------------------------------------------------------
// Wave detail + gate sign — the valid next states + gate come from the wave's
// bound template (transitions where from === wave.state, gated by the exit gate
// of the current phase). The wave row itself carries only state + template id.
// ---------------------------------------------------------------------------
function selectWave(id) {
  state.selectedWaveId = id;
  renderWaves(); // re-highlight selection
  renderWaveDetailAndGate();
}

function currentWave() { return state.waves.find((w) => w.id === state.selectedWaveId) || null; }
function phaseById(tpl, pid) { return (tpl.phases || []).find((p) => p.id === pid) || null; }
function validTransitions(tpl, fromState) {
  return (tpl.transitions || []).filter((t) => t.from === fromState);
}
function gateById(tpl, gateId) {
  for (const p of (tpl.phases || [])) if (p.gate && p.gate.id === gateId) return p.gate;
  return null;
}

async function renderWaveDetailAndGate() {
  const detail = $('waveDetail');
  const gates = $('gatesPanel');
  const w = currentWave();
  if (!w) {
    detail.innerHTML = '<div class="empty">No wave selected.</div>';
    gates.innerHTML = '<div class="empty">Select a wave to see its current gate.</div>';
    return;
  }
  $('waveDetailHint').textContent = 'Wave ' + w.id + ' — current phase ' + (w.state || '?');
  if (!w.framework_template_id) {
    detail.innerHTML = bannerHtml('This wave has no pinned framework template; it cannot transition.');
    gates.innerHTML = '<div class="empty">No template bound — nothing to sign.</div>';
    return;
  }
  const tpl = await getFullTemplate(w.framework_template_id);
  if (!tpl) { detail.innerHTML = bannerHtml('Could not load the wave template.'); gates.innerHTML = ''; return; }
  detail.innerHTML = waveDetailHtml(w, tpl);
  gates.innerHTML = gatePanelHtml(w, tpl);
  gates.querySelectorAll('button[data-to]').forEach((b) => {
    b.addEventListener('click', () => onSignGate(w.id, b.getAttribute('data-to')));
  });
}

function waveDetailHtml(w, tpl) {
  const phase = phaseById(tpl, w.state);
  const nexts = validTransitions(tpl, w.state).map((t) => t.to);
  if (!phase) return bannerHtml('Current state "' + w.state + '" is not a phase of template ' + tpl.id + '.');
  return ''
    + '<div class="gtitle">' + esc(phase.id) + ' &middot; ' + esc(phase.name)
    + ' <span class="chip teal">station ' + esc(phase.station) + '</span></div>'
    + (phase.goal ? '<p class="hint">' + esc(phase.goal) + '</p>' : '')
    + '<div class="kv">next: ' + (nexts.length ? nexts.map((n) => '<span class="chip">' + esc(n) + '</span>').join(' ') : '<span class="muted">terminal phase</span>') + '</div>';
}

function gatePanelHtml(w, tpl) {
  const trs = validTransitions(tpl, w.state);
  if (!trs.length) return '<div class="empty">Terminal phase — no further gate to sign.</div>';
  return trs.map((t) => {
    const gate = gateById(tpl, t.gateId) || {};
    const toPhase = phaseById(tpl, t.to);
    const cutover = Boolean(toPhase && toPhase.station === 'J');
    const crit = Array.isArray(gate.criteria) ? gate.criteria : [];
    return ''
      + '<div class="gate' + (cutover ? ' cutover' : '') + '" style="margin:8px 0">'
      + '<div class="gtitle">&rarr; ' + esc(t.to) + (cutover ? ' <span class="chip warn">cutover</span>' : '')
      + ' <span class="chip">role ' + esc(gate.signerRole || '?') + '</span></div>'
      + (gate.name ? '<div class="desc">' + esc(gate.name) + '</div>' : '')
      + (crit.length ? '<ul class="criteria">' + crit.map((c) => '<li>' + esc(c) + '</li>').join('') + '</ul>' : '')
      + '<button class="small" data-to="' + esc(t.to) + '">Sign gate &rarr; ' + esc(t.to) + '</button>'
      + '</div>';
  }).join('');
}

async function onSignGate(waveId, to) {
  const signerId = ($('signerId').value || '').trim();
  const role = ($('signerRole').value || '').trim();
  if (!signerId) { toast('Enter a Signer ID in the Human Gate Sign panel first', 'error'); return; }
  const body = { to, signer: { id: signerId, kind: 'human', role: role || undefined } };
  const r = await apiPost('/api/waves/' + encodeURIComponent(waveId) + '/transition', body);
  if (!r.ok) { toast('Gate sign rejected: ' + (r.error || 'failed'), 'error'); return; }
  toast('Gate signed → ' + to, 'ok');
  await Promise.all([loadWaves(), loadLedger(), loadHealth()]);
  await renderWaveDetailAndGate();
  await verifyChain();
}

// ---------------------------------------------------------------------------
// Reconcile & Jump
// ---------------------------------------------------------------------------
async function onReconcile() {
  const workloadId = ($('recUnit').value || '').trim();
  const connector = ($('recConn').value || 'demo').trim();
  if (!workloadId) { toast('Pick a unit to reconcile', 'error'); return; }
  const host = $('reconcileResult');
  host.innerHTML = '<div class="empty">Reconciling ' + esc(workloadId) + '…</div>';
  const r = await apiPost('/api/reconcile', { workloadId, connector });
  if (!r.ok) { host.innerHTML = bannerHtml(r.error || 'reconcile failed'); return; }
  host.innerHTML = reconcileHtml(r);
  await loadLedger();
}

function reconcileHtml(r) {
  // categories is an ARRAY of { name, ok, detail, preSwitch } (src/engine/reconcile.js).
  const cats = Array.isArray(r.categories) ? r.categories : [];
  const catRows = cats.map((c) => ''
    + '<li>' + esc(c.name) + ' '
    + '<span class="chip ' + (c.ok ? 'ok' : 'bad') + '">' + (c.ok ? 'PASS' : 'FAIL') + '</span>'
    + (c.preSwitch === false ? ' <span class="chip">post-cutover</span>' : '')
    + (c.detail ? ' <span class="desc">' + esc(c.detail) + '</span>' : '')
    + '</li>').join('');
  return ''
    + '<div class="gtitle">' + esc(r.workloadId) + ' via ' + esc(r.connector)
    + ' <span class="chip ' + (r.proofOk ? 'ok' : 'bad') + '">proof ' + (r.proofOk ? 'PASS' : 'FAIL') + '</span>'
    + ' <span class="chip ' + (r.baselineFresh ? 'ok' : 'warn') + '">baseline ' + (r.baselineFresh ? 'fresh' : 'stale') + '</span></div>'
    + (catRows ? '<ul class="criteria">' + catRows + '</ul>' : '')
    + (r.proofOk
      ? '<p class="hint">Equivalence proven — this unit is eligible for a human-signed Jump.</p>'
      : '<p class="hint">No passing proof — the Jump stays unreachable (verified-before-Jump, Invariant&nbsp;6).</p>');
}

// ---------------------------------------------------------------------------
// Tamper-evident ledger
// ---------------------------------------------------------------------------
async function loadLedger() {
  const body = $('ledgerBody');
  const r = await apiGet('/api/ledger');
  if (!r.ok) { body.innerHTML = '<tr><td colspan="7">' + bannerHtml(r.error || 'failed') + '</td></tr>'; return; }
  const rows = Array.isArray(r.entries) ? r.entries : [];
  if (!rows.length) { body.innerHTML = '<tr><td colspan="7" class="empty">Ledger empty.</td></tr>'; return; }
  body.innerHTML = rows.map(ledgerRow).join('');
}

function ledgerRow(row) {
  const ev = row.evidenceHashes || [];
  const hash = String(row.hash || '');
  return ''
    + '<tr class="ledger-row">'
    + '<td>' + esc(row.seq) + '</td>'
    + '<td>' + esc(row.ts) + '</td>'
    + '<td>' + esc(row.actor || '&mdash;') + '</td>'
    + '<td>' + esc(row.signerRole || '&mdash;') + '</td>'
    + '<td>' + esc(row.action) + '</td>'
    + '<td>' + esc(Array.isArray(ev) ? ev.length : 0) + '</td>'
    + '<td class="hash">' + esc(hash.slice(0, 16)) + (hash.length > 16 ? '&hellip;' : '') + '</td>'
    + '</tr>';
}

async function verifyChain() {
  const badge = $('chainStatus');
  badge.className = 'chip';
  badge.textContent = 'verifying…';
  const r = await apiGet('/api/ledger/verify');
  if (!r.ok) { badge.className = 'chip bad'; badge.textContent = 'chain: ' + (r.error || 'error'); return; }
  if (r.verified === true || r.brokenAt === null || r.brokenAt === undefined) {
    badge.className = 'chip ok'; badge.textContent = 'chain: intact';
  } else {
    // textContent is injection-safe and literal — no esc() (esc would corrupt display).
    badge.className = 'chip bad'; badge.textContent = 'chain: BROKEN at seq ' + r.brokenAt;
  }
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------
async function refreshAll() {
  await Promise.all([loadHealth(), loadTemplates(), loadWaves(), loadWorkloads(), loadLedger()]);
  await verifyChain();
  await renderWaveDetailAndGate();
}

function init() {
  loadToken();
  $('saveToken').addEventListener('click', saveToken);
  $('refreshAll').addEventListener('click', refreshAll);
  $('addWorkload').addEventListener('click', onAddWorkload);
  $('addWave').addEventListener('click', onAddWave);
  $('runReconcile').addEventListener('click', onReconcile);
  $('verifyChain').addEventListener('click', verifyChain);
  $('refreshLedger').addEventListener('click', loadLedger);
  refreshAll();
}

document.addEventListener('DOMContentLoaded', init);
