// public/app.js — Vosj CE Command Center (focused board). Vanilla JS, fetch + DOM
// only; NO framework, NO CDN. Talks to the API module mounted under /api by
// src/api/routes. Every server-supplied value is run through esc() before it
// reaches the DOM (XSS). { ok:false } envelopes + HTTP errors surface as inline
// banners + toasts, never thrown into the console.
'use strict';

// --- DOM + escaping helpers ---
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

// --- Auth token (field mirrored to localStorage) ---
const TOKEN_KEY = 'vosj.token';
function getToken() { return ($('token').value || '').trim(); }
function loadToken() {
  try { $('token').value = localStorage.getItem(TOKEN_KEY) || ''; } catch (_) { /* no storage */ }
}
function saveToken() {
  try { localStorage.setItem(TOKEN_KEY, getToken()); } catch (_) { /* no storage */ }
  toast('Token saved', 'ok');
}

// --- API client: returns { ok, ...data } or { ok:false, error } (never throws) ---
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
    if (!res.ok && data && data.ok === undefined) {
      return { ok: false, error: 'HTTP ' + res.status, status: res.status };
    }
    if (data && typeof data.ok === 'boolean') return Object.assign({ status: res.status }, data);
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    return { ok: false, error: 'network error: ' + (e && e.message ? e.message : e) };
  }
}

const apiGet = (p) => api('GET', p);
const apiPost = (p, b) => api('POST', p, b);
// --- Health strip ---
async function loadHealth() {
  const strip = $('healthStrip');
  const r = await apiGet('/health');
  if (!r.ok) {
    strip.innerHTML = '<span><span class="dot bad"></span>health unreachable &mdash; ' + esc(r.error) + '</span>';
    return;
  }
  strip.innerHTML = healthHtml(r);
}

function dot(ok) { return '<span class="dot ' + (ok ? 'ok' : 'bad') + '"></span>'; }

function healthHtml(h) {
  return [
    '<span>' + dot(true) + 'version <b>' + esc(h.version) + '</b></span>',
    '<span>' + dot(h.storeOk) + 'store <b>' + esc(h.store) + '</b></span>',
    '<span>' + dot(h.ledgerOk) + 'ledger <b>' + (h.ledgerOk ? 'ok' : 'unsigned') + '</b></span>',
    '<span>workloads <b>' + esc(h.workloads) + '</b></span>',
    '<span>waves <b>' + esc(h.waves) + '</b></span>',
    '<span>uptime <b>' + Math.round(h.uptime || 0) + 's</b></span>',
  ].join('');
}

// --- WAVES: current phase + valid next states + per-state sign-gate action ---
function showError(container, r) {
  container.innerHTML = '<div class="err-banner">' + esc(r.error || 'request failed') + '</div>';
}

async function loadWaves() {
  const host = $('wavesList');
  const r = await apiGet('/api/waves');
  if (!r.ok) { showError(host, r); $('wavesCount').textContent = ''; return; }
  const waves = Array.isArray(r.waves) ? r.waves : (Array.isArray(r.data) ? r.data : []);
  $('wavesCount').innerHTML = '<b>' + waves.length + '</b> wave(s)';
  if (!waves.length) { host.innerHTML = '<div class="empty">No waves yet.</div>'; return; }
  host.innerHTML = waves.map(waveCard).join('');
  bindSignForms();
}

function waveField(w, names) {
  for (const n of names) if (w[n] !== undefined && w[n] !== null) return w[n];
  return null;
}

function waveCard(w) {
  const id = waveField(w, ['id']);
  const name = waveField(w, ['name']) || id;
  const phase = waveField(w, ['state', 'phase', 'currentState', 'current_state']);
  const tpl = waveField(w, ['template', 'framework_template_id', 'frameworkTemplateId', 'templateId']);
  const nexts = waveField(w, ['nextStates', 'validNext', 'next_states', 'transitions']) || [];
  return ''
    + '<div class="wave">'
    + '<div class="whead"><span class="wname">' + esc(name) + '</span>'
    + '<span class="wmeta">' + esc(id) + (tpl ? ' &middot; template ' + esc(tpl) : '') + '</span></div>'
    + '<div class="phase">Current phase: <span class="chip teal">' + esc(phase || 'unknown') + '</span></div>'
    + nextStatesHtml(id, nexts)
    + '</div>';
}

function nextStatesHtml(waveId, nexts) {
  if (!Array.isArray(nexts) || !nexts.length) {
    return '<div class="empty">No valid next states (terminal phase or no template bound).</div>';
  }
  return '<div class="nexts">' + nexts.map((n) => nextCard(waveId, n)).join('') + '</div>';
}

function nextCard(waveId, n) {
  const to = (typeof n === 'string') ? n : (n.to || n.state || '');
  const gate = (n && typeof n === 'object') ? (n.gate || null) : null;
  const gateId = (n && n.gateId) || (gate && gate.id) || '';
  const cutover = Boolean(gate && gate.cutover);
  return ''
    + '<div class="next-card' + (cutover ? ' cutover' : '') + '">'
    + '<div class="to">&rarr; ' + esc(to) + (cutover ? ' <span class="chip warn">cutover</span>' : '') + '</div>'
    + '<div class="gate">gate: ' + esc(gateId || '(none)')
    + (gate && gate.signerRole ? ' &middot; role ' + esc(gate.signerRole) : '') + '</div>'
    + criteriaHtml(gate)
    + signForm(waveId, to, gate && gate.signerRole)
    + '</div>';
}

function criteriaHtml(gate) {
  const c = gate && Array.isArray(gate.criteria) ? gate.criteria : [];
  if (!c.length) return '';
  return '<ul class="criteria">' + c.map((x) => '<li>' + esc(x) + '</li>').join('') + '</ul>';
}

function signForm(waveId, to, role) {
  return ''
    + '<form class="signrow" data-wave="' + esc(waveId) + '" data-to="' + esc(to) + '">'
    + '<div class="field"><label>Signer ID</label><input class="sgn-id" placeholder="jane.doe" required /></div>'
    + '<div class="field"><label>Role</label><input class="sgn-role" value="' + esc(role || '') + '" placeholder="dba" /></div>'
    + '<button class="small" type="submit">Sign gate</button>'
    + '</form>';
}

function bindSignForms() {
  const forms = document.querySelectorAll('#wavesList form.signrow');
  forms.forEach((f) => { f.addEventListener('submit', onSignSubmit); });
}

async function onSignSubmit(ev) {
  ev.preventDefault();
  const f = ev.currentTarget;
  const waveId = f.getAttribute('data-wave');
  const to = f.getAttribute('data-to');
  const signerId = (f.querySelector('.sgn-id').value || '').trim();
  const role = (f.querySelector('.sgn-role').value || '').trim();
  if (!signerId) { toast('Signer ID is required', 'error'); return; }
  await submitTransition(waveId, to, signerId, role);
}

async function submitTransition(waveId, to, signerId, role) {
  const body = { to, signer: { id: signerId, kind: 'human', role: role || undefined } };
  const r = await apiPost('/api/waves/' + encodeURIComponent(waveId) + '/transition', body);
  if (!r.ok) { toast('Gate sign rejected: ' + (r.error || 'failed'), 'error'); return; }
  toast('Gate signed → ' + to, 'ok');
  await Promise.all([loadWaves(), loadLedger(), loadHealth()]);
}
// --- 7-R DISPOSITION board (falls back to the static contract table if no API) ---
const FALLBACK_DISPOSITIONS = [
  { disposition: 'Retire', meaning: 'Decommission; no migration.', executorClass: 'none', cutoverStyle: 'none', highRisk: false },
  { disposition: 'Retain', meaning: 'Keep at source (regulatory/technical).', executorClass: 'none', cutoverStyle: 'none', highRisk: false },
  { disposition: 'Rehost', meaning: 'Lift-and-shift to IaaS.', executorClass: 'rehost', cutoverStyle: 'big-bang', highRisk: false },
  { disposition: 'Relocate', meaning: 'Move hypervisor wholesale.', executorClass: 'relocate', cutoverStyle: 'strangler-fig', highRisk: true },
  { disposition: 'Repurchase', meaning: 'Drop-and-shop to SaaS.', executorClass: 'repurchase', cutoverStyle: 'big-bang', highRisk: false },
  { disposition: 'Replatform', meaning: 'Lift-and-reshape (e.g. managed database).', executorClass: 'replatform', cutoverStyle: 'strangler-fig', highRisk: true },
  { disposition: 'Refactor', meaning: 'Re-architect cloud-native.', executorClass: 'refactor', cutoverStyle: 'strangler-fig', highRisk: true },
];

async function loadDispositions() {
  const host = $('dispBoard');
  const r = await apiGet('/api/dispositions');
  let list = FALLBACK_DISPOSITIONS;
  if (r.ok) {
    const got = Array.isArray(r.dispositions) ? r.dispositions : (Array.isArray(r.data) ? r.data : null);
    if (got && got.length) list = got.map(normaliseDisp);
  }
  host.innerHTML = list.map(dispCard).join('');
}

function normaliseDisp(d) {
  if (typeof d === 'string') return { disposition: d, meaning: '', cutoverStyle: '', highRisk: false };
  const c = d.contract || d;
  return {
    disposition: d.disposition || d.id || d.name || '',
    meaning: c.meaning || '',
    executorClass: c.executorClass || '',
    cutoverStyle: c.cutoverStyle || '',
    highRisk: Boolean(c.highRisk),
  };
}

function dispCard(d) {
  const strangler = d.cutoverStyle === 'strangler-fig';
  const cutChip = strangler
    ? '<span class="chip warn">Strangler-Fig only</span>'
    : '<span class="chip">' + esc(d.cutoverStyle || 'n/a') + '</span>';
  return ''
    + '<div class="disp' + (d.highRisk ? ' high' : '') + '">'
    + '<div class="dname">' + esc(d.disposition) + '</div>'
    + '<div class="dmeaning">' + esc(d.meaning) + '</div>'
    + '<div class="drow">executor: <b>' + esc(d.executorClass || 'none') + '</b></div>'
    + '<div class="dtags">' + cutChip
    + (d.highRisk ? ' <span class="chip bad">high-risk</span>' : ' <span class="chip ok">standard</span>')
    + '</div></div>';
}

// --- LEDGER console + chain-verify badge ---
async function loadLedger() {
  const body = $('ledgerBody');
  const r = await apiGet('/api/ledger');
  if (!r.ok) {
    body.innerHTML = '<tr><td colspan="7"><div class="err-banner">' + esc(r.error || 'failed') + '</div></td></tr>';
    return;
  }
  const rows = Array.isArray(r.entries) ? r.entries : (Array.isArray(r.ledger) ? r.ledger : (Array.isArray(r.data) ? r.data : []));
  if (!rows.length) { body.innerHTML = '<tr><td colspan="7" class="empty">Ledger empty.</td></tr>'; return; }
  body.innerHTML = rows.map(ledgerRow).join('');
}

function ledgerField(row, names) {
  for (const n of names) if (row[n] !== undefined && row[n] !== null) return row[n];
  return null;
}

function ledgerRow(row) {
  const ev = ledgerField(row, ['evidenceHashes', 'evidence_hashes']) || [];
  const role = ledgerField(row, ['signerRole', 'signer_role']);
  const hash = String(ledgerField(row, ['hash']) || '');
  return ''
    + '<tr class="ledger-row">'
    + '<td>' + esc(row.seq) + '</td>'
    + '<td>' + esc(row.ts) + '</td>'
    + '<td>' + esc(row.actor || '&mdash;') + '</td>'
    + '<td>' + esc(role || '&mdash;') + '</td>'
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
  setChainBadge(badge, r);
}

function setChainBadge(badge, r) {
  if (!r.ok) { badge.className = 'chip bad'; badge.textContent = 'chain: ' + (r.error || 'error'); return; }
  const v = r.verify || r.data || r; // tolerate { ok, brokenAt } at top level or nested
  const intact = v.ok === true || (v.brokenAt === null && r.ok);
  if (intact) { badge.className = 'chip ok'; badge.textContent = 'chain: intact'; return; }
  badge.className = 'chip bad';
  badge.textContent = 'chain: BROKEN at seq ' + esc(v.brokenAt);
}

// --- Wiring ---
async function refreshAll() {
  await Promise.all([loadHealth(), loadWaves(), loadDispositions(), loadLedger()]);
  await verifyChain();
}

function init() {
  loadToken();
  $('saveToken').addEventListener('click', saveToken);
  $('refreshAll').addEventListener('click', refreshAll);
  $('verifyChain').addEventListener('click', verifyChain);
  $('refreshLedger').addEventListener('click', loadLedger);
  refreshAll();
}

document.addEventListener('DOMContentLoaded', init);
