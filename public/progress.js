// public/progress.js — Vosj Implementation Progress tracker.
// Wires progress.html to the gaps API (src/api/gaps.js):
//   GET   /api/gaps       -> { ok, gaps[] } — every whitepaper claim mapped to code
//   PATCH /api/gaps/:id    -> save one edited field (work_status | pct_complete | assignee)
// It renders an overall progress summary, a per-area breakdown, and a
// filterable/sortable claim table whose three editable cells PATCH inline.
// Vanilla JS, fetch + DOM only — NO framework, NO CDN. Every server-supplied
// value passes through esc() before it touches the DOM (XSS). { ok:false }
// envelopes + HTTP errors surface as inline banners + toasts, never thrown to the
// console. Shares the proven app.js helper PATTERNS ($, esc, toast, token, api).
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
const apiPatch = (p, b) => api('PATCH', p, b);

// ---------------------------------------------------------------------------
// Client state + domain enums (mirror src/api/gaps.js contracts)
// ---------------------------------------------------------------------------
const state = {
  gaps: [],          // GET /api/gaps — every claim
  autoTimer: null,   // setInterval handle for the 30s auto-refresh
};

// the 5 work_status values the editable <select> offers (gaps.js EDITABLE set).
const WORK_STATUS = ['todo', 'in_progress', 'done', 'ee_deferred', 'wont_fix'];
// severity order: drives the "by severity" chips + the severity sort.
const SEVERITY_ORDER = { critical: 0, major: 1, minor: 2, none: 3 };

// A gap that is EE-deferred is intentionally out of CE scope; it is excluded from
// the "done out of total" denominator and from the maturity average.
function isDeferred(g) { return g.work_status === 'ee_deferred'; }
function pctOf(g) { const n = Number(g.pct_complete); return Number.isFinite(n) ? n : 0; }

// ---------------------------------------------------------------------------
// Colour helpers — map a status/severity to a chip/bar class (the page palette:
// done=ok/green, in_progress=teal/warn, todo=muted, ee_deferred=dim, critical=bad).
// ---------------------------------------------------------------------------
function workClass(ws) {
  if (ws === 'done') return 'ok';
  if (ws === 'in_progress') return 'teal';
  if (ws === 'wont_fix') return 'bad';
  if (ws === 'ee_deferred') return 'dim';
  return ''; // todo → muted/default
}
function sevClass(sev) {
  if (sev === 'critical') return 'bad';
  if (sev === 'major') return 'warn';
  return '';
}
function wpClass(wp) {
  if (wp === 'implemented') return 'ok';
  if (wp === 'partial') return 'warn';
  if (wp === 'missing' || wp === 'divergent') return 'bad';
  return ''; // aspirational → default
}
// a progress bar's fill colour follows completion: full=green, some=teal, none=muted.
function barClass(pct) {
  if (pct >= 100) return 'bar-ok';
  if (pct > 0) return '';
  return 'bar-warn';
}

// ---------------------------------------------------------------------------
// Load — pull all gaps, then render the three panels off the cached list.
// ---------------------------------------------------------------------------
async function loadGaps() {
  const r = await apiGet('/api/gaps');
  if (!r.ok) {
    $('overall').innerHTML = bannerHtml(r.error || 'failed to load gaps');
    $('areaList').innerHTML = bannerHtml(r.error || 'failed to load gaps');
    $('gapsBody').innerHTML = '<tr><td colspan="8">' + bannerHtml(r.error || 'failed') + '</td></tr>';
    return;
  }
  state.gaps = Array.isArray(r.gaps) ? r.gaps : [];
  populateFilterOptions();
  renderAll();
}

function renderAll() {
  renderSummary();
  renderAreas();
  renderTable();
}

// ---------------------------------------------------------------------------
// Overall summary — done %, maturity (avg pct), and chips by work_status/severity.
// ---------------------------------------------------------------------------
function renderSummary() {
  const all = state.gaps;
  const scoped = all.filter((g) => !isDeferred(g)); // non-EE-deferred denominator
  const done = scoped.filter((g) => g.work_status === 'done').length;
  const donePct = scoped.length ? Math.round((done / scoped.length) * 100) : 0;
  const maturity = scoped.length
    ? Math.round(scoped.reduce((s, g) => s + pctOf(g), 0) / scoped.length) : 0;

  const ws = countBy(all, 'work_status');
  const sev = countBy(all, 'severity');
  $('summaryMeta').innerHTML = '<b>' + all.length + '</b> claims &middot; <b>' + scoped.length + '</b> in scope';
  $('overall').innerHTML = ''
    + '<div class="ohead">'
    + '<span class="opct">' + donePct + '%</span>'
    + '<span class="osub"><b>' + done + '</b> of <b>' + scoped.length + '</b> in-scope claims done'
    + ' &middot; overall maturity <b>' + maturity + '%</b></span>'
    + '</div>'
    + '<div class="pbar pbar-lg ' + barClass(donePct) + '"><span style="width:' + donePct + '%"></span></div>'
    + '<div class="chips">'
    + statusChip('done', ws.done || 0, 'ok')
    + statusChip('in_progress', ws.in_progress || 0, 'teal')
    + statusChip('todo', ws.todo || 0, '')
    + statusChip('ee_deferred', ws.ee_deferred || 0, 'dim')
    + statusChip('wont_fix', ws.wont_fix || 0, 'bad')
    + '</div>'
    + '<div class="chips">'
    + statusChip('critical', sev.critical || 0, 'bad')
    + statusChip('major', sev.major || 0, 'warn')
    + '</div>';
}

// count rows by a field value → { value: n }
function countBy(rows, field) {
  const out = {};
  rows.forEach((r) => { const k = r[field] || ''; out[k] = (out[k] || 0) + 1; });
  return out;
}

function statusChip(label, n, cls) {
  return '<span class="chip ' + (cls || '') + '">'
    + esc(label.replace(/_/g, ' ')) + ' <span class="c-n">' + esc(n) + '</span></span>';
}

// ---------------------------------------------------------------------------
// Per-area breakdown — group by area, show avg pct + counts, collapsible claims.
// ---------------------------------------------------------------------------
function renderAreas() {
  const host = $('areaList');
  if (!state.gaps.length) { host.innerHTML = '<div class="empty">No claims.</div>'; return; }
  const groups = groupByArea(state.gaps);
  host.innerHTML = Object.keys(groups).sort().map((area) => areaRow(area, groups[area])).join('');
  host.querySelectorAll('.area .ahead').forEach((h) => {
    h.addEventListener('click', () => h.parentElement.classList.toggle('open'));
  });
}

function groupByArea(rows) {
  const out = {};
  rows.forEach((r) => { const a = r.area || '(unsorted)'; (out[a] = out[a] || []).push(r); });
  return out;
}

function areaRow(area, rows) {
  const scoped = rows.filter((g) => !isDeferred(g));
  const avg = scoped.length ? Math.round(scoped.reduce((s, g) => s + pctOf(g), 0) / scoped.length) : 0;
  const done = scoped.filter((g) => g.work_status === 'done').length;
  const inprog = rows.filter((g) => g.work_status === 'in_progress').length;
  return ''
    + '<div class="area">'
    + '<div class="ahead">'
    + '<div class="aname"><span class="caret">&#9656;</span>' + esc(area) + '</div>'
    + '<div class="pbar ' + barClass(avg) + '"><span style="width:' + avg + '%"></span></div>'
    + '<div class="acounts"><b>' + avg + '%</b> avg &middot; ' + done + ' done &middot; '
    + inprog + ' in&nbsp;prog &middot; ' + rows.length + ' claims</div>'
    + '</div>'
    + '<div class="abody"><ul>' + rows.map(areaClaimLi).join('') + '</ul></div>'
    + '</div>';
}

function areaClaimLi(g) {
  const cls = workClass(g.work_status);
  return ''
    + '<li>'
    + '<span class="chip ' + cls + '">' + esc((g.work_status || '').replace(/_/g, ' ')) + '</span>'
    + '<span class="li-claim">' + esc(g.claim) + '</span>'
    + '<span>' + esc(pctOf(g)) + '%</span>'
    + '</li>';
}

// ---------------------------------------------------------------------------
// Claim table — filter + sort the cached list, then render editable rows.
// ---------------------------------------------------------------------------
function populateFilterOptions() {
  fillSelect($('fWork'), WORK_STATUS);
  fillSelect($('fSeverity'), uniqueSorted(state.gaps, 'severity'));
  fillSelect($('fArea'), uniqueSorted(state.gaps, 'area'));
}

function fillSelect(sel, values) {
  const cur = sel.value;
  sel.innerHTML = '<option value="">(all)</option>'
    + values.map((v) => '<option value="' + esc(v) + '">' + esc(v) + '</option>').join('');
  if (values.indexOf(cur) !== -1) sel.value = cur; // preserve selection across reloads
}

function uniqueSorted(rows, field) {
  const set = {};
  rows.forEach((r) => { if (r[field]) set[r[field]] = true; });
  return Object.keys(set).sort();
}

function currentFilters() {
  return {
    search: ($('fSearch').value || '').trim().toLowerCase(),
    work: $('fWork').value || '',
    severity: $('fSeverity').value || '',
    area: $('fArea').value || '',
    assignee: ($('fAssignee').value || '').trim().toLowerCase(),
    sort: $('fSort').value || 'priority',
  };
}

function applyFilters(rows, f) {
  return rows.filter((g) => {
    if (f.work && g.work_status !== f.work) return false;
    if (f.severity && g.severity !== f.severity) return false;
    if (f.area && g.area !== f.area) return false;
    if (f.assignee && !String(g.assignee || '').toLowerCase().includes(f.assignee)) return false;
    if (f.search && !String(g.claim || '').toLowerCase().includes(f.search)) return false;
    return true;
  });
}

function sortRows(rows, key) {
  const r = rows.slice();
  if (key === 'severity') return r.sort((a, b) => sevRank(a) - sevRank(b));
  if (key === 'pct_complete') return r.sort((a, b) => pctOf(b) - pctOf(a));
  if (key === 'area' || key === 'work_status') {
    return r.sort((a, b) => String(a[key] || '').localeCompare(String(b[key] || '')));
  }
  // default: priority ascending (1 = highest), then area.
  return r.sort((a, b) => (numOr(a.priority, 1e9) - numOr(b.priority, 1e9))
    || String(a.area || '').localeCompare(String(b.area || '')));
}

function sevRank(g) {
  const v = SEVERITY_ORDER[g.severity];
  return v === undefined ? 99 : v;
}
function numOr(v, dflt) { const n = Number(v); return Number.isFinite(n) ? n : dflt; }

function renderTable() {
  const body = $('gapsBody');
  if (!state.gaps.length) {
    body.innerHTML = '<tr><td colspan="8" class="empty">No claims.</td></tr>';
    $('tableCount').textContent = '';
    return;
  }
  const f = currentFilters();
  const rows = sortRows(applyFilters(state.gaps, f), f.sort);
  $('tableCount').innerHTML = '<b>' + rows.length + '</b> of ' + state.gaps.length + ' shown';
  if (!rows.length) { body.innerHTML = '<tr><td colspan="8" class="empty">No claims match the filters.</td></tr>'; return; }
  body.innerHTML = rows.map(gapRow).join('');
  bindRowEditors();
}

function gapRow(g) {
  const id = esc(g.id);
  const rowCls = 'ws-' + esc(g.work_status || 'todo') + (g.severity === 'critical' ? ' sev-critical' : '');
  return ''
    + '<tr class="' + rowCls + '" data-id="' + id + '">'
    + '<td class="claim-cell" title="' + esc(g.claim) + '">' + esc(g.claim) + '</td>'
    + '<td><span class="chip ' + sevClass(g.severity) + '">' + esc(g.severity || '&mdash;') + '</span></td>'
    + '<td>' + esc(g.scope || '&mdash;') + '</td>'
    + '<td><span class="chip ' + wpClass(g.wp_status) + '">' + esc(g.wp_status || '&mdash;') + '</span></td>'
    + '<td>' + statusSelect(g) + '</td>'
    + '<td><input class="ed-pct" type="number" min="0" max="100" step="1" value="' + esc(pctOf(g)) + '" data-id="' + id + '" /></td>'
    + '<td><input class="ed-assignee" type="text" value="' + esc(g.assignee || '') + '" placeholder="&mdash;" data-id="' + id + '" /></td>'
    + '<td>' + esc(g.validator || '&mdash;') + '</td>'
    + '</tr>';
}

function statusSelect(g) {
  const cur = g.work_status || 'todo';
  const opts = WORK_STATUS.map((v) => ''
    + '<option value="' + esc(v) + '"' + (v === cur ? ' selected' : '') + '>'
    + esc(v.replace(/_/g, ' ')) + '</option>').join('');
  return '<select class="ed-status" data-id="' + esc(g.id) + '">' + opts + '</select>';
}

// ---------------------------------------------------------------------------
// Inline editing — each editable cell PATCHes just its own field on change/blur.
// ---------------------------------------------------------------------------
function bindRowEditors() {
  document.querySelectorAll('#gapsBody select.ed-status').forEach((el) => {
    el.addEventListener('change', () => onStatusChange(el));
  });
  document.querySelectorAll('#gapsBody input.ed-pct').forEach((el) => {
    el.addEventListener('blur', () => onPctCommit(el));
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter') el.blur(); });
  });
  document.querySelectorAll('#gapsBody input.ed-assignee').forEach((el) => {
    el.addEventListener('blur', () => onAssigneeCommit(el));
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter') el.blur(); });
  });
}

function gapById(id) { return state.gaps.find((g) => String(g.id) === String(id)) || null; }

async function onStatusChange(el) {
  const id = el.getAttribute('data-id');
  const ws = el.value;
  await patchField(id, { work_status: ws }, 'work status → ' + ws.replace(/_/g, ' '));
  // courtesy: when marking done, offer to bump pct to 100 (user keeps control).
  const g = gapById(id);
  if (ws === 'done' && g && pctOf(g) < 100 && window.confirm('Marked done — set % complete to 100?')) {
    await patchField(id, { pct_complete: 100 }, '% complete → 100');
  }
}

async function onPctCommit(el) {
  const id = el.getAttribute('data-id');
  const g = gapById(id);
  let pct = parseInt(el.value, 10);
  if (!Number.isFinite(pct)) { el.value = g ? pctOf(g) : 0; return; }
  pct = Math.max(0, Math.min(100, pct));
  el.value = pct;
  if (g && pct === pctOf(g)) return; // unchanged — no write
  await patchField(id, { pct_complete: pct }, '% complete → ' + pct);
}

async function onAssigneeCommit(el) {
  const id = el.getAttribute('data-id');
  const g = gapById(id);
  const v = (el.value || '').trim();
  if (g && v === String(g.assignee || '')) return; // unchanged — no write
  await patchField(id, { assignee: v }, 'assignee → ' + (v || '(cleared)'));
}

// Single-field PATCH: on success update the cached row + recompute everything.
async function patchField(id, patch, label) {
  const r = await apiPatch('/api/gaps/' + encodeURIComponent(id), patch);
  if (!r.ok) { toast('Save failed: ' + (r.error || 'error'), 'error'); return false; }
  const idx = state.gaps.findIndex((g) => String(g.id) === String(id));
  if (idx !== -1) state.gaps[idx] = r.gap || Object.assign(state.gaps[idx], patch);
  toast('Saved: ' + label, 'ok');
  renderSummary();
  renderAreas();
  renderTable();
  return true;
}

// ---------------------------------------------------------------------------
// Auto-refresh (pausable, 30s) — re-pulls the list; off by default.
// ---------------------------------------------------------------------------
function setAutoRefresh(on) {
  if (state.autoTimer) { clearInterval(state.autoTimer); state.autoTimer = null; }
  if (on) state.autoTimer = setInterval(loadGaps, 30000);
}

// ---------------------------------------------------------------------------
// Filters wiring — re-render the table (only) on any filter change.
// ---------------------------------------------------------------------------
function onFilterChange() { renderTable(); }

function clearFilters() {
  $('fSearch').value = '';
  $('fWork').value = '';
  $('fSeverity').value = '';
  $('fArea').value = '';
  $('fAssignee').value = '';
  $('fSort').value = 'priority';
  renderTable();
}

// debounce a noisy text input so we don't re-render on every keystroke.
function debounce(fn, ms) {
  let t = null;
  return function () { clearTimeout(t); t = setTimeout(fn, ms); };
}

// ---------------------------------------------------------------------------
// Orchestration + gate
// ---------------------------------------------------------------------------
async function refreshAll() { await loadGaps(); }

// Pre-auth gate: proceed from the minimal landing into the board.
function onGateGo() {
  $('token').value = ($('gateToken').value || '').trim();
  saveToken();
  document.body.classList.remove('locked');
  refreshAll();
}

// Log out: drop the stored token, clear both token fields, return to the gate.
function onLogout() {
  try { localStorage.removeItem(TOKEN_KEY); } catch (_) { /* no storage */ }
  $('token').value = '';
  $('gateToken').value = '';
  setAutoRefresh(false);
  $('autoRefresh').checked = false;
  document.body.classList.add('locked');
  toast('Logged out', 'ok');
}

function init() {
  loadToken();
  $('saveToken').addEventListener('click', saveToken);
  $('refreshAll').addEventListener('click', refreshAll);
  $('logout').addEventListener('click', onLogout);
  $('gateGo').addEventListener('click', onGateGo);
  $('gateToken').addEventListener('keydown', (e) => { if (e.key === 'Enter') onGateGo(); });

  // filters
  $('fSearch').addEventListener('input', debounce(onFilterChange, 300));
  $('fAssignee').addEventListener('input', debounce(onFilterChange, 300));
  ['fWork', 'fSeverity', 'fArea', 'fSort'].forEach((idn) => {
    $(idn).addEventListener('change', onFilterChange);
  });
  $('clearFilters').addEventListener('click', clearFilters);
  $('autoRefresh').addEventListener('change', (e) => setAutoRefresh(e.target.checked));

  // Already have a token? Unlock straight to the board; else show the gate.
  if (getToken()) { document.body.classList.remove('locked'); refreshAll(); }
}

document.addEventListener('DOMContentLoaded', init);
