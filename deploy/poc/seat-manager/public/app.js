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
  const ready = seat.ready
    ? '<span class="chip ok">ready</span>'
    : '<span class="chip bad">not ready</span>';
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

// --- interactions ---
function bindCards() {
  document.querySelectorAll('.mode-btn').forEach((b) => b.addEventListener('click', onModeToggle));
  document.querySelectorAll('button.assign').forEach((b) => b.addEventListener('click', onAssign));
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
  // Already have a key? Unlock straight to the seats; else show the gate.
  if (getKey()) { document.body.classList.remove('locked'); loadSeats(); }
}

document.addEventListener('DOMContentLoaded', init);
