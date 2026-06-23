// public/app.js — Vosj POC Seat Manager UI. Vanilla JS, fetch + DOM only; NO
// framework, NO CDN. Talks to the backend under /api with an X-Admin-Key header
// (mirrored to localStorage). EVERY server-supplied value is run through esc()
// before it reaches innerHTML (XSS). The credential input is type=password and
// is NEVER populated from a server response — only a last-4 keyHint is shown.
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

// --- Admin key (field mirrored to localStorage, sent as X-Admin-Key) ---
const KEY_STORE = 'vosj.seatmgr.adminKey';
function getKey() { return ($('adminKey').value || '').trim(); }
function loadKey() {
  try { $('adminKey').value = localStorage.getItem(KEY_STORE) || ''; } catch (_) { /* no storage */ }
}
function saveKey() {
  try { localStorage.setItem(KEY_STORE, getKey()); } catch (_) { /* no storage */ }
  toast('Admin key saved', 'ok');
}

// --- API client: returns { ok, ...data } or { ok:false, error } (never throws) ---
function authHeaders(extra) {
  const h = Object.assign({ Accept: 'application/json' }, extra || {});
  const k = getKey();
  if (k) h['X-Admin-Key'] = k;
  return h;
}

async function api(method, path, body) {
  const init = { method, headers: authHeaders(body ? { 'Content-Type': 'application/json' } : null) };
  if (body) init.body = JSON.stringify(body);
  try {
    const res = await fetch(path, init);
    const data = await res.json().catch(() => ({ ok: false, error: 'invalid JSON from server' }));
    if (data && typeof data.ok === 'boolean') return Object.assign({ status: res.status }, data);
    return { ok: res.ok, status: res.status, error: 'HTTP ' + res.status };
  } catch (e) {
    return { ok: false, error: 'network error: ' + (e && e.message ? e.message : e) };
  }
}

// --- per-card local mode selection (which key field label to show) ---
// Keyed by seat id; defaults to the seat's server mode (or hybrid if unassigned).
const selectedMode = {};

function modeFor(seat) {
  if (selectedMode[seat.id]) return selectedMode[seat.id];
  return seat.mode === 'ai-only' ? 'ai-only' : 'hybrid';
}

// --- rendering ---
function modeBadge(mode) {
  const label = mode === 'hybrid' ? 'Hybrid' : (mode === 'ai-only' ? 'AI-only' : 'Unassigned');
  const cls = mode === 'unassigned' ? 'warn' : 'teal';
  return '<span class="chip ' + cls + '">' + esc(label) + '</span>';
}

function statusBadge(seat) {
  const assigned = seat.assigned
    ? '<span class="chip ok">assigned</span>'
    : '<span class="chip">unassigned</span>';
  let ready;
  if (seat.schedulable === false) ready = '<span class="chip bad">unschedulable</span>';
  else if (seat.ready) ready = '<span class="chip ok">ready</span>';
  else ready = '<span class="chip warn">starting</span>';
  return assigned + ' ' + ready;
}

function keyLabel(mode) {
  return mode === 'ai-only' ? 'Anthropic API key' : 'Claude Code OAuth token';
}

function hintLine(seat) {
  if (!seat.assigned) return '<div class="hint small">No credential set.</div>';
  const tail = seat.keyHint ? '…' + esc(seat.keyHint) : '(empty)';
  return '<div class="hint small">Current key ends in <code>' + tail + '</code>'
    + ' · worker <b>' + (seat.workerEnabled ? 'enabled' : 'disabled') + '</b></div>';
}

function modeToggle(seat, mode) {
  const opt = (val, label) =>
    '<button type="button" class="mode-btn' + (mode === val ? ' active' : '')
    + '" data-seat="' + esc(seat.id) + '" data-mode="' + esc(val) + '">' + esc(label) + '</button>';
  return '<div class="mode-toggle">' + opt('hybrid', 'Hybrid') + opt('ai-only', 'AI-only') + '</div>';
}

function seatCard(seat) {
  const mode = modeFor(seat);
  return ''
    + '<div class="seat-card" data-seat="' + esc(seat.id) + '">'
    + '<div class="seat-head">'
    + '<span class="seat-id">Seat ' + esc(seat.id) + '</span>'
    + modeBadge(seat.mode)
    + '</div>'
    + '<div class="seat-status">' + statusBadge(seat) + '</div>'
    + hintLine(seat)
    + modeToggle(seat, mode)
    + '<label class="field-label" id="lbl-' + esc(seat.id) + '">' + esc(keyLabel(mode)) + '</label>'
    + '<input class="cred" type="password" autocomplete="off" placeholder="paste credential" data-seat="' + esc(seat.id) + '" />'
    + '<button class="assign" type="button" data-seat="' + esc(seat.id) + '">Assign</button>'
    + tierRow(seat)
    + '</div>';
}

// Per-seat extension tier selector + Push button.
function tierRow(seat) {
  const cur = seat.tier || 'none';
  const opt = (v, label) => '<option value="' + v + '"' + (cur === v ? ' selected' : '') + '>' + label + '</option>';
  return '<div class="seat-tier">'
    + '<select class="tier-sel" data-seat="' + esc(seat.id) + '">'
    + opt('none', 'No extensions') + opt('beginner', 'Beginner')
    + opt('intermediate', 'Intermediate') + opt('advanced', 'Advanced')
    + '</select>'
    + '<button class="push small" type="button" data-seat="' + esc(seat.id) + '">Push ext</button>'
    + '</div>';
}

async function loadSeats() {
  const host = $('seats');
  if (!getKey()) { host.innerHTML = '<div class="empty">Enter your admin key, then Refresh.</div>'; return; }
  host.innerHTML = '<div class="empty">Loading seats…</div>';
  const r = await api('GET', '/api/seats');
  if (!r.ok) {
    host.innerHTML = '<div class="err-banner">' + esc(r.error || 'failed to load seats') + '</div>';
    return;
  }
  updateScaleBar(r);
  renderCapacityWarning(r);
  const seats = Array.isArray(r.seats) ? r.seats : [];
  if (!seats.length) { host.innerHTML = '<div class="empty">No seats yet — set a count above and Apply.</div>'; return; }
  host.innerHTML = seats.map(seatCard).join('');
  bindCards();
}

// --- scaling (provision/de-provision seats, 1..max) ---
let lastSeatCount = 0;
function updateScaleBar(r) {
  const count = typeof r.count === 'number' ? r.count : (Array.isArray(r.seats) ? r.seats.length : 0);
  const max = r.max || 50;
  lastSeatCount = count;
  const inp = $('scaleCount');
  if (inp) { inp.max = String(max); if (document.activeElement !== inp) inp.value = String(count); }
  const lbl = $('seatCount');
  if (lbl) lbl.textContent = count + ' of ' + max + ' seats provisioned';
}

async function onScaleApply() {
  if (!getKey()) { toast('Enter your admin key first', 'error'); return; }
  const target = parseInt(($('scaleCount').value || '').trim(), 10);
  const max = parseInt($('scaleCount').max || '50', 10);
  if (!(target >= 1 && target <= max)) { toast('Seats must be between 1 and ' + max, 'error'); return; }
  if (target < lastSeatCount) {
    const msg = 'Scale down to ' + target + ' seats? Seats ' + (target + 1) + '–' + lastSeatCount
      + ' will be removed (along with any credential assigned to them).';
    // eslint-disable-next-line no-alert
    if (!window.confirm(msg)) return;
  }
  const btn = $('scaleApply');
  btn.disabled = true;
  toast('Scaling to ' + target + ' seats…', 'ok');
  const r = await api('POST', '/api/scale', { count: target });
  btn.disabled = false;
  if (!r.ok) { toast('Scale failed: ' + (r.error || 'error'), 'error'); return; }
  toast('Now ' + r.count + ' seats (+' + (r.created || []).length + ' / -' + (r.removed || []).length + ')', 'ok');
  await loadSeats();
}

// Auto capacity warning: the cluster can't schedule all requested seats.
function renderCapacityWarning(r) {
  const el = $('capacityWarning');
  if (!el) return;
  if (r.capacityWarning) { el.textContent = '⚠ ' + r.capacityWarning; el.style.display = 'block'; }
  else { el.textContent = ''; el.style.display = 'none'; }
}

// Log out: clear the admin key and return to the gate.
function onLogout() {
  try { localStorage.removeItem(KEY_STORE); } catch (_) { /* no storage */ }
  $('adminKey').value = '';
  const gk = $('gateKey');
  if (gk) gk.value = '';
  document.body.classList.add('locked');
}

// --- extension policy tab ----------------------------------------------------
function extToLines(exts) {
  return (exts || []).map((e) => (e.version ? e.id + '@' + e.version : e.id)).join('\n');
}
function linesToExts(text) {
  return String(text || '').split(/[\n,]+/).map((s) => s.trim()).filter(Boolean).map((s) => {
    const at = s.lastIndexOf('@');
    if (at > 0 && /^\d/.test(s.slice(at + 1))) {
      return { id: s.slice(0, at), version: s.slice(at + 1), registry: 'open-vsx', pin: 'minor' };
    }
    return { id: s, version: '', registry: 'open-vsx', pin: 'minor' };
  });
}

let loadedPolicy = null;
async function loadPolicy() {
  const r = await api('GET', '/api/ext-policy');
  if (!r.ok) { toast('Load policy failed: ' + (r.error || 'error'), 'error'); return; }
  loadedPolicy = r.policy || {};
  const t = loadedPolicy.tiers || {};
  $('extBeginner').value = extToLines((t.beginner || {}).extensions);
  $('extIntermediate').value = extToLines((t.intermediate || {}).extensions);
  $('extAdvanced').value = extToLines((t.advanced || {}).extensions);
  const pv = $('policyVersion');
  if (pv) pv.textContent = 'Policy v' + (loadedPolicy.version || '?') + ' · Open VSX only';
}

async function savePolicy() {
  const policy = {
    version: loadedPolicy ? loadedPolicy.version : 1,
    tiers: {
      beginner: { extensions: linesToExts($('extBeginner').value) },
      intermediate: { extensions: linesToExts($('extIntermediate').value) },
      advanced: { extensions: linesToExts($('extAdvanced').value) },
    },
  };
  $('savePolicy').disabled = true;
  const r = await api('PUT', '/api/ext-policy', { policy });
  $('savePolicy').disabled = false;
  if (!r.ok) { toast('Save failed: ' + (r.error || 'error'), 'error'); return; }
  toast('Policy saved (v' + r.version + ')', 'ok');
  const ps = $('policySaved'); if (ps) ps.textContent = 'Saved v' + r.version;
  await loadPolicy();
}

function showTab(which) {
  const seats = which === 'seats';
  $('seatsView').style.display = seats ? '' : 'none';
  $('policyView').style.display = seats ? 'none' : '';
  $('tabSeats').classList.toggle('active', seats);
  $('tabPolicy').classList.toggle('active', !seats);
  if (!seats && !loadedPolicy) loadPolicy();
}

async function onPushExtensions(id, tier) {
  toast('Pushing ' + tier + ' extensions to seat ' + id + '…', 'ok');
  const r = await api('POST', '/api/seats/' + encodeURIComponent(id) + '/extensions', { tier });
  if (!r.ok) { toast('Push failed: ' + (r.error || 'error'), 'error'); return; }
  toast('Seat ' + id + ': ' + (r.extensions || []).length + ' extension(s) [' + tier + '] + restarting', 'ok');
  await loadSeats();
}

function onPushClick(ev) {
  const id = ev.currentTarget.getAttribute('data-seat');
  const card = ev.currentTarget.closest('.seat-card');
  const sel = card.querySelector('.tier-sel');
  onPushExtensions(id, sel ? sel.value : 'none');
}

// --- interactions ---
function bindCards() {
  document.querySelectorAll('.mode-btn').forEach((b) => b.addEventListener('click', onModeToggle));
  document.querySelectorAll('button.assign').forEach((b) => b.addEventListener('click', onAssign));
  document.querySelectorAll('button.push').forEach((b) => b.addEventListener('click', onPushClick));
}

function onModeToggle(ev) {
  const btn = ev.currentTarget;
  const id = btn.getAttribute('data-seat');
  const mode = btn.getAttribute('data-mode');
  selectedMode[id] = mode;
  // Re-label the key field and flip the active button WITHOUT a full refetch.
  const card = btn.closest('.seat-card');
  card.querySelectorAll('.mode-btn').forEach((x) => {
    x.classList.toggle('active', x.getAttribute('data-mode') === mode);
  });
  const lbl = card.querySelector('.field-label');
  if (lbl) lbl.textContent = keyLabel(mode);
}

async function onAssign(ev) {
  const id = ev.currentTarget.getAttribute('data-seat');
  const card = ev.currentTarget.closest('.seat-card');
  const mode = selectedMode[id] || (card.querySelector('.mode-btn.active')
    ? card.querySelector('.mode-btn.active').getAttribute('data-mode') : 'hybrid');
  const input = card.querySelector('input.cred');
  const credential = (input.value || '').trim();
  if (!credential) { toast('Paste a credential first', 'error'); return; }
  ev.currentTarget.disabled = true;
  const r = await api('POST', '/api/seats/' + encodeURIComponent(id) + '/assign', { mode, credential });
  ev.currentTarget.disabled = false;
  if (!r.ok) { toast('Assign failed: ' + (r.error || 'error'), 'error'); return; }
  input.value = '';
  toast('Seat ' + id + ' set to ' + mode + ' + restarting', 'ok');
  await loadSeats();
}

// --- wiring ---
// Pre-auth gate: proceed from the minimal landing into the seat list.
function onGateGo() {
  $('adminKey').value = ($('gateKey').value || '').trim();
  saveKey();
  document.body.classList.remove('locked');
  loadSeats();
}

function init() {
  loadKey();
  $('saveKey').addEventListener('click', () => { saveKey(); loadSeats(); });
  $('refresh').addEventListener('click', loadSeats);
  $('adminKey').addEventListener('keydown', (e) => { if (e.key === 'Enter') loadSeats(); });
  $('gateGo').addEventListener('click', onGateGo);
  $('gateKey').addEventListener('keydown', (e) => { if (e.key === 'Enter') onGateGo(); });
  $('scaleApply').addEventListener('click', onScaleApply);
  $('logout').addEventListener('click', onLogout);
  $('tabSeats').addEventListener('click', () => showTab('seats'));
  $('tabPolicy').addEventListener('click', () => showTab('policy'));
  $('savePolicy').addEventListener('click', savePolicy);
  // Already have a key? Unlock straight to the seats; else show the gate.
  if (getKey()) { document.body.classList.remove('locked'); loadSeats(); }
}

document.addEventListener('DOMContentLoaded', init);
