// public/intake.js — Vosj Intake "Plot the Voyage". A 6-step guided wizard that
// walks ONE application into Vosj end to end. Vanilla JS, fetch + DOM only; NO
// framework, NO CDN. Reuses the proven primitives from app.js VERBATIM ($, esc,
// toast, getToken/loadToken/saveToken, api/apiGet/apiPost). Every server/user value
// is run through esc() before it reaches the DOM (XSS) — including data-* attributes.
// { ok:false } envelopes + HTTP errors surface as inline banners/toasts, never console.
'use strict';

// --- DOM + escaping helpers (verbatim from app.js) ---
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

// 7-R fallback table (copied from app.js) — used when GET /api/dispositions is absent.
const FALLBACK_DISPOSITIONS = [
  { disposition: 'Retire', meaning: 'Decommission; no migration.', executorClass: 'none', cutoverStyle: 'none', highRisk: false },
  { disposition: 'Retain', meaning: 'Keep at source (regulatory/technical).', executorClass: 'none', cutoverStyle: 'none', highRisk: false },
  { disposition: 'Rehost', meaning: 'Lift-and-shift to IaaS.', executorClass: 'rehost', cutoverStyle: 'big-bang', highRisk: false },
  { disposition: 'Relocate', meaning: 'Move hypervisor wholesale.', executorClass: 'relocate', cutoverStyle: 'strangler-fig', highRisk: true },
  { disposition: 'Repurchase', meaning: 'Drop-and-shop to SaaS.', executorClass: 'repurchase', cutoverStyle: 'big-bang', highRisk: false },
  { disposition: 'Replatform', meaning: 'Lift-and-reshape (e.g. managed database).', executorClass: 'replatform', cutoverStyle: 'strangler-fig', highRisk: true },
  { disposition: 'Refactor', meaning: 'Re-architect cloud-native.', executorClass: 'refactor', cutoverStyle: 'strangler-fig', highRisk: true },
];

// ==========================================================================
// Static wizard configuration — kept declarative so render() stays tiny.
// ==========================================================================
const STEP_TITLES = [
  'Identify the application', 'Business criticality', 'Migration shape',
  'Confirm the strategy', 'Baseline & verification', 'Wave assignment & review',
];
const STEP_COUNT = STEP_TITLES.length;
const DRAFT_KEY = 'vosj.intake.draft';
const ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;

// The 8 decision toggles in their EXACT classify-heuristic priority order. Each maps
// to a boolean attribute consumed by the engine's classify() heuristic.
const TOGGLES = [
  { key: 'decommission', label: 'Decommission it', example: 'No longer needed — retire instead of migrating.' },
  { key: 'endOfLife', label: 'End of life', example: 'Vendor/tech is EOL; will not be carried forward.' },
  { key: 'mustStaySource', label: 'Must stay at source', example: 'Technical or contractual reason to keep it where it is.' },
  { key: 'regulatoryHold', label: 'Regulatory hold', example: 'Data residency / compliance forbids moving it now.' },
  { key: 'saasReplacement', label: 'Replace with SaaS', example: 'A commercial SaaS product will replace it (drop-and-shop).' },
  { key: 'cloudNativeRewrite', label: 'Cloud-native rewrite', example: 'Re-architecting it cloud-native (containers, managed services).' },
  { key: 'managedServiceTarget', label: 'Move to a managed service', example: 'Reshape onto a managed DB/runtime (lift-and-reshape).' },
  { key: 'hypervisorMove', label: 'Move the hypervisor wholesale', example: 'Relocate the VM estate as-is to a cloud host.' },
];
// Cloud-target toggles that get grayed out when Retire/Retain is chosen.
const CLOUD_TOGGLE_KEYS = ['saasReplacement', 'cloudNativeRewrite', 'managedServiceTarget', 'hypervisorMove'];

const FACING_OPTS = [
  { v: 'internal', label: 'Internal', note: 'Used by staff only.' },
  { v: 'external', label: 'External', note: 'Customer / public facing.' },
];
const REVENUE_OPTS = [
  { v: 'no', label: 'No', note: 'Does not directly generate revenue.' },
  { v: 'yes', label: 'Yes', note: 'Directly generates revenue.' },
];
const TIER_OPTS = [
  { v: 'Tier1', label: 'Tier 1', note: 'Mission-critical' },
  { v: 'Tier2', label: 'Tier 2', note: 'Business-important' },
  { v: 'Tier3', label: 'Tier 3', note: 'Supporting' },
  { v: 'Tier4', label: 'Tier 4', note: 'Experimental' },
];
const ROLE_OPTS = [
  { v: 'strategic', label: 'Strategic', note: 'Differentiating capability.' },
  { v: 'supporting-business', label: 'Supporting business', note: 'Runs the business.' },
  { v: 'core-shared-infra', label: 'Core shared infra', note: 'Shared platform/service.' },
];
const DISP_NAMES = ['Retire', 'Retain', 'Rehost', 'Relocate', 'Repurchase', 'Replatform', 'Refactor'];
// The 6 pre-switch reconciliation categories (read-only checklist, step 5).
const RECON_CATEGORIES = ['replication_lag', 'row_counts', 'checksums', 'sequence_identity', 'constraints', 'smoke'];

// ==========================================================================
// Draft state — a single in-memory object persisted to localStorage.
// ==========================================================================
let step = 0;
let dispCache = null; // cached disposition table for the step-4 picker

function freshDraft() {
  return {
    name: '', id: '', idLocked: true, desc: '', facing: 'internal', revenue: 'no',
    tier: 'Tier3', role: '', peakUsers: '', tz: tzDefault(), freeze: '',
    toggles: {}, rowCount: '', escapeOn: false, escapeDisp: '',
    disposition: '', baselineAt: '', connector: 'demo', rpo: '', rto: '',
    waveMode: '', waveId: '', newWaveId: '', newWaveName: '',
  };
}
let draft = freshDraft();

function tzDefault() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (_) { return 'UTC'; }
}

function saveDraft() {
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify(draft)); } catch (_) { /* no storage */ }
}
function clearDraft() {
  try { localStorage.removeItem(DRAFT_KEY); } catch (_) { /* no storage */ }
}
function restoreDraft() {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (raw) draft = Object.assign(freshDraft(), JSON.parse(raw));
  } catch (_) { draft = freshDraft(); }
}

// slugify() — derive the machine key from a display name (matches ID_RE shape).
function slugify(s) {
  return String(s || '').toLowerCase().trim()
    .replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').slice(0, 64);
}

// ==========================================================================
// Step rendering — show ONLY the active step + sync its widgets from `draft`.
// ==========================================================================
function render(idx) {
  step = Math.max(0, Math.min(STEP_COUNT - 1, idx));
  renderStepbar();
  document.querySelectorAll('.step').forEach((el) => {
    el.classList.toggle('active', Number(el.getAttribute('data-step')) === step);
  });
  syncNav();
  const h1 = document.querySelector('.step.active h1');
  if (h1) h1.focus(); // move focus to the step heading on change (a11y)
  if (step === 3) prepareStrategy();      // step 4 needs an upsert + classify
  if (step === 5) { prepareWaves(); renderSummary(); }
  saveDraft();
}

function renderStepbar() {
  const bar = $('stepbar');
  bar.innerHTML = STEP_TITLES.map((t, i) => {
    const cls = i === step ? 'active' : (i < step ? 'done' : '');
    return '<li class="' + cls + '" data-go="' + i + '"><span class="n">' + (i + 1)
      + '</span><br>' + esc(t) + '</li>';
  }).join('');
  bar.querySelectorAll('li.done').forEach((li) => {
    li.addEventListener('click', () => { commitStep(); render(Number(li.getAttribute('data-go'))); });
  });
}

function syncNav() {
  $('wizBack').style.visibility = step === 0 ? 'hidden' : 'visible';
  $('wizNext').style.display = step === STEP_COUNT - 1 ? 'none' : '';
  $('wizSubmit').style.display = step === STEP_COUNT - 1 ? '' : 'none';
}

// ---- option-group rendering (radio / segmented) ----
function renderOpts(host, opts, current, onPick) {
  host.innerHTML = opts.map((o) =>
    '<label data-v="' + esc(o.v) + '" class="' + (o.v === current ? 'sel' : '') + '">'
    + '<input type="radio" ' + (o.v === current ? 'checked' : '') + ' /> '
    + '<span>' + esc(o.label) + (o.note ? '<small>' + esc(o.note) + '</small>' : '') + '</span></label>'
  ).join('');
  host.querySelectorAll('label').forEach((l) => {
    l.addEventListener('click', (e) => {
      e.preventDefault();
      onPick(l.getAttribute('data-v'));
      host.querySelectorAll('label').forEach((x) => x.classList.remove('sel'));
      l.classList.add('sel');
    });
  });
}

// ==========================================================================
// STEP 1 — Identify the application
// ==========================================================================
function initStep1() {
  $('s1Name').value = draft.name;
  $('s1Id').value = draft.id;
  $('s1Desc').value = draft.desc;
  setIdEditable(!draft.idLocked);
  renderOpts($('s1Facing'), FACING_OPTS, draft.facing, (v) => { draft.facing = v; });
  renderOpts($('s1Revenue'), REVENUE_OPTS, draft.revenue, (v) => { draft.revenue = v; });

  $('s1Name').addEventListener('input', () => {
    draft.name = $('s1Name').value;
    if (draft.idLocked) { draft.id = slugify(draft.name); $('s1Id').value = draft.id; }
  });
  $('s1Name').addEventListener('blur', validateName);
  $('s1Id').addEventListener('input', () => { draft.id = $('s1Id').value.trim(); });
  $('s1Id').addEventListener('blur', validateId);
  $('s1IdEdit').addEventListener('click', () => { draft.idLocked = false; setIdEditable(true); $('s1Id').focus(); });
}

function setIdEditable(on) {
  const inp = $('s1Id');
  inp.readOnly = !on;
  inp.classList.toggle('ro', !on);
  $('s1IdEdit').textContent = on ? 'auto' : 'edit';
}

function validateName() {
  const ok = !!$('s1Name').value.trim();
  $('s1NameErr').textContent = ok ? '' : 'A display name is required.';
  return ok;
}

async function validateId() {
  const id = $('s1Id').value.trim();
  draft.id = id;
  if (!ID_RE.test(id)) {
    $('s1IdErr').textContent = 'Use lowercase letters, digits and hyphens (2–64 chars).';
    return false;
  }
  $('s1IdErr').textContent = '';
  await warnIfIdExists(id); // soft warning only — upsert is allowed
  return true;
}

async function warnIfIdExists(id) {
  const r = await apiGet('/api/workloads');
  if (!r.ok) return; // pre-check is best-effort; a failure here is not blocking
  const list = Array.isArray(r.workloads) ? r.workloads : (Array.isArray(r.data) ? r.data : []);
  if (list.some((w) => w && w.id === id)) {
    $('s1IdErr').textContent = 'Heads up: a workload with this id already exists — submitting will update it.';
  }
}

// ==========================================================================
// STEP 2 — Business criticality (metadata only, captured first)
// ==========================================================================
function initStep2() {
  renderOpts($('s2Tier'), TIER_OPTS, draft.tier, (v) => { draft.tier = v; });
  renderOpts($('s2Role'), ROLE_OPTS, draft.role, (v) => { draft.role = v; });
  $('s2Users').value = draft.peakUsers;
  $('s2Tz').value = draft.tz;
  $('s2Freeze').value = draft.freeze;
  $('s2Users').addEventListener('input', () => { draft.peakUsers = $('s2Users').value; });
  $('s2Users').addEventListener('blur', () => validateNonNegInt('s2Users', 's2UsersErr'));
  $('s2Tz').addEventListener('input', () => { draft.tz = $('s2Tz').value; });
  $('s2Freeze').addEventListener('input', () => { draft.freeze = $('s2Freeze').value; });
}

function validateNonNegInt(inputId, errId) {
  const v = $(inputId).value.trim();
  const ok = v === '' || (/^\d+$/.test(v) && Number(v) >= 0);
  $(errId).textContent = ok ? '' : 'Enter a non-negative whole number.';
  return ok;
}

// ==========================================================================
// STEP 3 — Migration shape (the 8 decision toggles + escape hatch)
// ==========================================================================
function initStep3() {
  renderToggles();
  $('s3Rows').value = draft.rowCount;
  $('s3Rows').addEventListener('input', () => { draft.rowCount = $('s3Rows').value; });
  $('s3Rows').addEventListener('blur', () => validateNonNegInt('s3Rows', 's3RowsErr'));

  renderOpts($('s3Disp'), DISP_NAMES.map((d) => ({ v: d, label: d })), draft.escapeDisp,
    (v) => { draft.escapeDisp = v; });
  $('s3Escape').checked = draft.escapeOn;
  $('s3EscapeBox').style.display = draft.escapeOn ? 'block' : 'none';
  $('s3Escape').addEventListener('change', () => {
    draft.escapeOn = $('s3Escape').checked;
    $('s3EscapeBox').style.display = draft.escapeOn ? 'block' : 'none';
  });
}

function renderToggles() {
  const retainOrRetire = draft.toggles.decommission || draft.toggles.endOfLife;
  $('s3Toggles').innerHTML = TOGGLES.map((t) => toggleRow(t, retainOrRetire)).join('');
  $('s3Toggles').querySelectorAll('.toggle .yn button').forEach((b) => {
    b.addEventListener('click', onToggleClick);
  });
}

function toggleRow(t, retainOrRetire) {
  const disabled = retainOrRetire && CLOUD_TOGGLE_KEYS.indexOf(t.key) !== -1;
  const val = draft.toggles[t.key] === true;
  return ''
    + '<div class="toggle' + (disabled ? ' off' : '') + '" data-key="' + esc(t.key) + '">'
    + '<div><div class="tlabel">' + esc(t.label) + '</div>'
    + '<div class="texample">' + esc(t.example) + (disabled ? ' (Retire/Retain skips migration)' : '') + '</div></div>'
    + '<div class="yn">'
    + '<button type="button" data-yn="yes"' + (disabled ? ' disabled' : '')
    + (val ? ' class="on-yes"' : '') + '>Yes</button>'
    + '<button type="button" data-yn="no"' + (disabled ? ' disabled' : '')
    + (!val ? ' class="on-no"' : '') + '>No</button>'
    + '</div></div>';
}

function onToggleClick(e) {
  const btn = e.currentTarget;
  const key = btn.closest('.toggle').getAttribute('data-key');
  draft.toggles[key] = btn.getAttribute('data-yn') === 'yes';
  renderToggles(); // re-render so conditional disclosure (gray-out) updates live
}

// ==========================================================================
// STEP 4 — Confirm the strategy (upsert + classify, then a 7-R override picker)
// ==========================================================================
async function prepareStrategy() {
  const host = $('s4Verdict');
  host.innerHTML = '<div class="empty">Saving draft &amp; classifying&hellip;</div>';
  const up = await upsertWorkload(false); // upsert so /classify has a row to read
  if (!up.ok) { host.innerHTML = banner(up.error || 'could not save the draft workload'); return; }
  const r = await apiGet('/api/classify/' + encodeURIComponent(draft.id));
  if (!r.ok) { host.innerHTML = banner(r.error || 'classification failed'); return; }
  const cls = r.classification || {};
  if (!draft.disposition) draft.disposition = cls.disposition || '';
  renderVerdict(cls);
  await renderDispPicker();
}

function renderVerdict(cls) {
  const c = cls.contract || {};
  const strangler = cls.strangler || c.cutoverStyle === 'strangler-fig';
  let h = '<div class="verdict' + (c.highRisk ? ' high' : '') + '">'
    + '<div class="vtitle">Vosj recommends: ' + esc(cls.disposition) + '</div>'
    + '<div class="vmeaning">' + esc(c.meaning) + '</div>'
    + '<div class="vtags">'
    + '<span class="chip ' + (strangler ? 'warn' : 'teal') + '">cutover: ' + esc(c.cutoverStyle || 'n/a') + '</span>'
    + (c.highRisk ? '<span class="chip bad">high-risk</span>' : '<span class="chip ok">standard risk</span>')
    + '</div>';
  if (c.deliverySystemPrecondition) {
    h += '<div class="vwarn">Requires CI/CD readiness before execution (delivery-system precondition).</div>';
  }
  if (strangler) {
    h += '<div class="vwarn">Big-bang cutover is structurally unavailable for this strategy.</div>';
  }
  $('s4Verdict').innerHTML = h + '</div>';
}

async function renderDispPicker() {
  const list = await loadDispositionTable();
  $('s4Picker').innerHTML = list.map((d) => dispChoice(d)).join('');
  $('s4Picker').querySelectorAll('.disp').forEach((el) => {
    el.addEventListener('click', () => onDispOverride(el.getAttribute('data-d'), list));
  });
}

function dispChoice(d) {
  const sel = d.disposition === draft.disposition;
  return '<div class="disp' + (sel ? ' sel' : '') + (d.highRisk ? ' high' : '') + '" data-d="' + esc(d.disposition) + '">'
    + '<div class="dname">' + esc(d.disposition) + '</div>'
    + '<div class="dmeaning">' + esc(d.meaning) + '</div></div>';
}

// Overriding AWAY from a strangler-fig recommendation to a big-bang disposition
// raises risk — confirm before accepting. Otherwise just set the override.
function onDispOverride(name, list) {
  const picked = list.find((d) => d.disposition === name) || {};
  const prev = list.find((d) => d.disposition === draft.disposition) || {};
  const toBigBang = picked.cutoverStyle === 'big-bang';
  const fromStrangler = prev.cutoverStyle === 'strangler-fig';
  if (toBigBang && fromStrangler &&
      !window.confirm('This app was flagged high-risk; big-bang cutover raises risk — proceed?')) {
    return;
  }
  draft.disposition = name;
  renderDispPicker();
  saveDraft();
}

async function loadDispositionTable() {
  if (dispCache) return dispCache;
  const r = await apiGet('/api/dispositions');
  let list = FALLBACK_DISPOSITIONS;
  if (r.ok) {
    const got = Array.isArray(r.dispositions) ? r.dispositions : (Array.isArray(r.data) ? r.data : null);
    if (got && got.length) list = got.map(normaliseDisp);
  }
  dispCache = list;
  return list;
}

function normaliseDisp(d) {
  if (typeof d === 'string') return { disposition: d, meaning: '', cutoverStyle: '', highRisk: false };
  const c = d.contract || d;
  return {
    disposition: d.disposition || d.id || d.name || '',
    meaning: c.meaning || '', executorClass: c.executorClass || '',
    cutoverStyle: c.cutoverStyle || '', highRisk: Boolean(c.highRisk),
  };
}

// ==========================================================================
// STEP 5 — Baseline & verification readiness
// ==========================================================================
function initStep5() {
  if (!draft.baselineAt) draft.baselineAt = new Date().toISOString();
  $('s5Baseline').value = toLocalInput(draft.baselineAt);
  $('s5Conn').value = draft.connector || 'demo';
  $('s5Rpo').value = draft.rpo;
  $('s5Rto').value = draft.rto;
  $('s5Checklist').innerHTML = RECON_CATEGORIES.map((c) => '<li>' + esc(c) + '</li>').join('');
  $('s5Baseline').addEventListener('change', () => { draft.baselineAt = fromLocalInput($('s5Baseline').value); });
  $('s5Conn').addEventListener('change', () => { draft.connector = $('s5Conn').value; });
  $('s5Rpo').addEventListener('input', () => { draft.rpo = $('s5Rpo').value; });
  $('s5Rto').addEventListener('input', () => { draft.rto = $('s5Rto').value; });
}

// datetime-local <-> ISO helpers (the input wants local "YYYY-MM-DDTHH:mm").
function toLocalInput(iso) {
  const d = iso ? new Date(iso) : new Date();
  if (isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
    + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}
function fromLocalInput(v) {
  if (!v) return '';
  const d = new Date(v);
  return isNaN(d.getTime()) ? '' : d.toISOString();
}

// ==========================================================================
// STEP 6 — Wave assignment + review & submit
// ==========================================================================
const WAVE_MODE_OPTS = [
  { v: 'existing', label: 'Assign to an existing wave', note: 'Pick from current waves.' },
  { v: 'new', label: 'Create a new wave', note: 'Starts at P1 Envision (template caf).' },
];

async function prepareWaves() {
  const r = await apiGet('/api/waves');
  const waves = r.ok ? (Array.isArray(r.waves) ? r.waves : (Array.isArray(r.data) ? r.data : [])) : [];
  const sel = $('s6Wave');
  sel.innerHTML = waves.map((w) =>
    '<option value="' + esc(w.id) + '">' + esc((w.name || w.id) + ' (' + w.id + ')') + '</option>'
  ).join('');
  // Default mode: existing if any waves, else create-new with a suggested id/name.
  if (!draft.waveMode) draft.waveMode = waves.length ? 'existing' : 'new';
  if (waves.length && !draft.waveId) draft.waveId = waves[0].id;
  if (!waves.length && !draft.newWaveId) {
    draft.newWaveId = (draft.id || 'wave') + '-wave';
    draft.newWaveName = (draft.name || draft.id || 'Pilot') + ' wave';
  }
  renderOpts($('s6Mode'), WAVE_MODE_OPTS, draft.waveMode, (v) => { draft.waveMode = v; syncWaveMode(); });
  bindWaveInputs();
  syncWaveMode();
}

function bindWaveInputs() {
  $('s6Wave').value = draft.waveId || '';
  $('s6WaveId').value = draft.newWaveId;
  $('s6WaveName').value = draft.newWaveName;
  $('s6Wave').onchange = () => { draft.waveId = $('s6Wave').value; renderSummary(); };
  $('s6WaveId').oninput = () => { draft.newWaveId = $('s6WaveId').value.trim(); };
  $('s6WaveName').oninput = () => { draft.newWaveName = $('s6WaveName').value; };
}

function syncWaveMode() {
  const isNew = draft.waveMode === 'new';
  $('s6ExistingBox').style.display = isNew ? 'none' : '';
  $('s6NewBox').style.display = isNew ? '' : 'none';
  renderSummary();
}

// ---- grouped review summary with per-section "edit" links ----
function renderSummary() {
  const wave = draft.waveMode === 'new'
    ? (draft.newWaveName || '—') + ' (' + (draft.newWaveId || '—') + ', new)'
    : (draft.waveId || '(unassigned)');
  $('s6Summary').innerHTML = [
    summaryGroup('Identity', 0, {
      'Display name': draft.name, 'Workload ID': draft.id,
      'Facing': draft.facing, 'Revenue': draft.revenue,
    }),
    summaryGroup('Criticality', 1, {
      'Tier': draft.tier, 'Business role': draft.role || '—',
      'Peak users': draft.peakUsers || '—', 'Timezone': draft.tz,
    }),
    summaryGroup('Strategy', 3, {
      'Disposition': draft.disposition || '(auto)',
      'Decided via': draft.escapeOn ? 'manual pick' : 'recommendation',
    }),
    summaryGroup('Baseline', 4, {
      'Baseline at': draft.baselineAt, 'Connector': draft.connector,
      'RPO': draft.rpo || '—', 'RTO': draft.rto || '—',
    }),
    summaryGroup('Wave', 5, { 'Assignment': wave }),
  ].join('');
  $('s6Summary').querySelectorAll('.sedit').forEach((b) => {
    b.addEventListener('click', () => { commitStep(); render(Number(b.getAttribute('data-go'))); });
  });
}

function summaryGroup(title, goStep, kv) {
  const rows = Object.keys(kv).map((k) =>
    '<dt>' + esc(k) + '</dt><dd>' + esc(kv[k]) + '</dd>').join('');
  return '<div class="sgroup"><div class="shead"><b>' + esc(title) + '</b>'
    + '<button class="sedit" type="button" data-go="' + goStep + '">edit</button></div>'
    + '<dl>' + rows + '</dl></div>';
}

// ==========================================================================
// Persistence — build the attributes blob + upsert the workload / wave.
// ==========================================================================
function buildAttributes() {
  const attrs = {
    description: draft.desc || undefined,
    externallyFacing: draft.facing === 'external',
    revenueGenerating: draft.revenue === 'yes',
    criticality: draft.tier, businessRole: draft.role || undefined,
    operatingWindow: draft.tz || undefined, changeFreeze: draft.freeze || undefined,
    connector: draft.connector || undefined, rpo: draft.rpo || undefined, rto: draft.rto || undefined,
  };
  if (draft.peakUsers !== '') attrs.peakConcurrentUsers = Number(draft.peakUsers);
  if (draft.rowCount !== '') attrs.rowCount = Number(draft.rowCount);
  TOGGLES.forEach((t) => { attrs[t.key] = draft.toggles[t.key] === true; }); // 8 heuristic booleans
  return attrs;
}

// Upsert the draft workload. `withWave` attaches waveId + an explicit disposition
// (used at final submit + when overriding); the step-4 pre-classify upsert omits both.
async function upsertWorkload(withWave) {
  const body = { id: draft.id, name: draft.name, attributes: buildAttributes() };
  if (draft.escapeOn && draft.escapeDisp) body.disposition = draft.escapeDisp;
  else if (draft.disposition) body.disposition = draft.disposition;
  if (draft.baselineAt) body.baselineAt = draft.baselineAt;
  if (withWave && draft.waveMode === 'existing' && draft.waveId) body.waveId = draft.waveId;
  if (withWave && draft.waveMode === 'new' && draft.newWaveId) body.waveId = draft.newWaveId;
  return apiPost('/api/workloads', body);
}

function banner(msg) { return '<div class="err-banner">' + esc(msg) + '</div>'; }

// ==========================================================================
// Navigation + validation gating
// ==========================================================================
// Pull the live field values for the current step back into `draft` before moving.
function commitStep() {
  if (step === 0) { draft.name = $('s1Name').value; draft.id = $('s1Id').value.trim(); draft.desc = $('s1Desc').value; }
  if (step === 1) { draft.peakUsers = $('s2Users').value; draft.tz = $('s2Tz').value; draft.freeze = $('s2Freeze').value; }
  if (step === 2) { draft.rowCount = $('s3Rows').value; }
  if (step === 4) { draft.baselineAt = fromLocalInput($('s5Baseline').value); draft.rpo = $('s5Rpo').value; draft.rto = $('s5Rto').value; }
  saveDraft();
}

// Block Next only on step 1 (the only hard gate); later steps have sane defaults.
async function canAdvance() {
  if (step === 0) {
    const nameOk = validateName();
    const idOk = await validateId();
    if (!nameOk || !idOk) { toast('Fix the highlighted fields to continue', 'error'); return false; }
  }
  return true;
}

async function onNext() {
  commitStep();
  if (!(await canAdvance())) return;
  render(step + 1);
}

function onBack() { commitStep(); render(step - 1); }

// Final submit: create the wave first if new, then upsert the workload with waveId.
async function onSubmit() {
  commitStep();
  $('wizSubmit').disabled = true;
  try {
    if (draft.waveMode === 'new') {
      if (!draft.newWaveId || !draft.newWaveName) { toast('Give the new wave an id and name', 'error'); return; }
      const wv = await apiPost('/api/waves', { id: draft.newWaveId, name: draft.newWaveName, templateId: 'caf', state: 'P1' });
      if (!wv.ok) { toast('Could not create wave: ' + (wv.error || 'failed'), 'error'); return; }
    }
    const up = await upsertWorkload(true);
    if (!up.ok) { toast('Submit failed: ' + (up.error || 'could not save workload'), 'error'); return; }
    onSubmitSuccess();
  } finally {
    $('wizSubmit').disabled = false;
  }
}

function onSubmitSuccess() {
  clearDraft();
  toast('Voyage plotted — ' + (draft.name || draft.id) + ' is now in Vosj', 'ok');
  const host = $('s6Summary');
  host.insertAdjacentHTML('afterbegin',
    '<div class="sgroup" style="border-color:var(--ok)">Created &mdash; '
    + 'open the <a href="app.html">Command Center</a> to drive its wave through the gates.</div>');
}

// ==========================================================================
// Gate + wiring
// ==========================================================================
function onGateGo() {
  const v = ($('gateToken').value || '').trim();
  if (!v) { $('gateToken').focus(); return; }
  $('token').value = v;
  saveToken();
  document.body.classList.remove('locked');
  startWizard();
}

function setAdvanced(on) {
  document.body.classList.toggle('show-advanced', on);
  $('advToggle').checked = on;
}

// Build every step's widgets once, then show the (restored) current step.
function startWizard() {
  initStep1(); initStep2(); initStep3(); initStep5();
  render(0);
}

function init() {
  loadToken();
  restoreDraft();
  $('saveToken').addEventListener('click', saveToken);
  $('gateGo').addEventListener('click', onGateGo);
  $('gateToken').addEventListener('keydown', (e) => { if (e.key === 'Enter') onGateGo(); });
  $('advToggle').addEventListener('change', () => setAdvanced($('advToggle').checked));
  $('wizNext').addEventListener('click', onNext);
  $('wizBack').addEventListener('click', onBack);
  $('wizSubmit').addEventListener('click', onSubmit);
  // If a token is already saved, skip the gate straight into the wizard.
  if (getToken()) { document.body.classList.remove('locked'); startWizard(); }
  else { $('gateToken').focus(); }
}

document.addEventListener('DOMContentLoaded', init);
