// =============================================================================
// deploy/poc/seat-manager/server.js — Vosj POC Seat Manager.
//
// A standalone credential-assignment console for the devstation seats. Each of
// the SEAT_COUNT seats is a Deployment `devstation-<i>` in DEVSTATIONS_NAMESPACE,
// fed (envFrom) by a per-seat Secret `devstation-<i>-env`. The console lets an
// admin pick a MODE per seat and paste the matching credential:
//   * hybrid  → interactive code-server + Claude Code (Max OAuth) → needs
//               CLAUDE_CODE_OAUTH_TOKEN.
//   * ai-only → headless/programmatic Claude → needs ANTHROPIC_API_KEY.
// "Assign" PATCHes that seat's Secret and restarts the Deployment.
//
// Talks to the Kubernetes API IN-CLUSTER via the mounted ServiceAccount (token +
// CA), using Node's global fetch + an https.Agent pinned to the cluster CA. NO
// @kubernetes/client-node, NO extra deps. Zero secrets are stored or logged; the
// actual credential is never read back — the API returns only a last-4 keyHint.
//
// Envelope on every JSON route: { ok:true, ... } | { ok:false, error }. A throw
// in any handler becomes a clean JSON error — never a stack, never the SA token.
// =============================================================================
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// --- config (every tunable from env; zero hardcoded ids/paths) ---------------
const PORT = parseInt(process.env.PORT || '8080', 10);
const NAMESPACE = process.env.DEVSTATIONS_NAMESPACE || 'devstations';
const SEAT_COUNT = parseInt(process.env.SEAT_COUNT || '5', 10);
const ADMIN_KEY = process.env.SEAT_MANAGER_ADMIN_KEY || '';
const PUBLIC_DIR = path.join(__dirname, 'public');

// In-cluster ServiceAccount material (mounted by Kubernetes into every pod).
const SA_DIR = '/var/run/secrets/kubernetes.io/serviceaccount';
const SA_TOKEN_PATH = path.join(SA_DIR, 'token');
const KUBE_HOST = process.env.KUBERNETES_SERVICE_HOST || 'kubernetes.default.svc';
const KUBE_PORT = process.env.KUBERNETES_SERVICE_PORT || '443';

// Read SA token fresh per call (it is rotated on disk by the kubelet).
function saToken() {
  return fs.readFileSync(SA_TOKEN_PATH, 'utf8').trim();
}

// Cluster API base. TLS trust for the cluster's self-signed API CA comes from
// NODE_EXTRA_CA_CERTS (set to the SA ca.crt in the Deployment): Node's global
// fetch (undici) IGNORES a per-request https agent, so the CA must be trusted
// process-wide rather than passed per call.
const KUBE_BASE = `https://${KUBE_HOST}:${KUBE_PORT}`;

// --- Kubernetes API client (global fetch + CA-pinned agent) ------------------
// Returns { status, json } — never throws on an HTTP error code; only a network
// failure rejects. Content-Type carries the PATCH strategy for merge patches.
async function kube(method, apiPath, body, contentType) {
  const headers = { Authorization: 'Bearer ' + saToken(), Accept: 'application/json' };
  if (body) headers['Content-Type'] = contentType || 'application/json';
  const res = await fetch(KUBE_BASE + apiPath, {
    method, headers,
    body: body ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (_) { json = null; }
  return { status: res.status, json };
}

const secretsPath = (name) =>
  `/api/v1/namespaces/${NAMESPACE}/secrets/${encodeURIComponent(name)}`;
const deployPath = (name) =>
  `/apis/apps/v1/namespaces/${NAMESPACE}/deployments/${encodeURIComponent(name)}`;

// --- base64 helpers for Secret .data (Secret values are base64-encoded) ------
const b64enc = (s) => Buffer.from(String(s), 'utf8').toString('base64');
const b64dec = (s) => Buffer.from(String(s || ''), 'base64').toString('utf8');

// --- seat state read ---------------------------------------------------------
// Derive a seat's view from its Secret + Deployment. NEVER returns a credential —
// only mode, a last-4 keyHint, and booleans.
function seatModeFrom(data) {
  const claude = b64dec(data.CLAUDE_CODE_OAUTH_TOKEN);
  const apiKey = b64dec(data.ANTHROPIC_API_KEY);
  const declared = b64dec(data.VOSJ_SEAT_MODE);
  if (declared === 'hybrid' || declared === 'ai-only') return declared;
  if (claude) return 'hybrid';
  if (apiKey) return 'ai-only';
  return 'unassigned';
}

function keyHintFrom(data, mode) {
  const raw = mode === 'ai-only' ? b64dec(data.ANTHROPIC_API_KEY) : b64dec(data.CLAUDE_CODE_OAUTH_TOKEN);
  return raw ? raw.slice(-4) : '';
}

async function readSeat(id) {
  const seat = { id, mode: 'unassigned', assigned: false, keyHint: '', workerEnabled: false, ready: false };
  const sec = await kube('GET', secretsPath(`devstation-${id}-env`));
  if (sec.status === 200 && sec.json && sec.json.data) {
    const data = sec.json.data;
    seat.mode = seatModeFrom(data);
    seat.assigned = seat.mode !== 'unassigned';
    seat.keyHint = keyHintFrom(data, seat.mode);
    seat.workerEnabled = b64dec(data.DEVSTATION_WORKER_ENABLED) === 'true';
  }
  const dep = await kube('GET', deployPath(`devstation-${id}`));
  if (dep.status === 200 && dep.json && dep.json.status) {
    seat.ready = (dep.json.status.readyReplicas || 0) > 0;
  }
  return seat;
}

// --- seat assign (PATCH Secret + restart Deployment) -------------------------
function buildSecretPatch(mode, credential) {
  const data = {
    VOSJ_SEAT_MODE: b64enc(mode),
    DEVSTATION_WORKER_ENABLED: b64enc('true'),
  };
  if (mode === 'hybrid') {
    data.CLAUDE_CODE_OAUTH_TOKEN = b64enc(credential);
    data.ANTHROPIC_API_KEY = b64enc('');
  } else {
    data.ANTHROPIC_API_KEY = b64enc(credential);
    data.CLAUDE_CODE_OAUTH_TOKEN = b64enc('');
  }
  return { data };
}

async function assignSeat(id, mode, credential) {
  // 1. merge-patch the per-seat Secret's .data (base64-set the relevant keys).
  const sp = await kube('PATCH', secretsPath(`devstation-${id}-env`),
    buildSecretPatch(mode, credential), 'application/merge-patch+json');
  if (sp.status < 200 || sp.status >= 300) {
    throw httpError(sp.status === 404 ? 404 : 502,
      `secret patch failed (HTTP ${sp.status})`);
  }
  // 2. restart the Deployment by bumping a pod-template annotation.
  const stamp = new Date().toISOString();
  const restartPatch = {
    spec: { template: { metadata: { annotations: { 'vosj.seat-manager/restartedAt': stamp } } } },
  };
  const dp = await kube('PATCH', deployPath(`devstation-${id}`),
    restartPatch, 'application/strategic-merge-patch+json');
  if (dp.status < 200 || dp.status >= 300) {
    throw httpError(502, `deployment restart failed (HTTP ${dp.status})`);
  }
  return { ok: true, id, mode };
}

// --- HTTP plumbing -----------------------------------------------------------
function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

// Constant-time admin-key check. Fails CLOSED (503) when no key is configured.
function authorized(req) {
  if (!ADMIN_KEY) return { ok: false, status: 503, error: 'admin key not configured (fail-closed)' };
  let supplied = req.headers['x-admin-key'] || '';
  const bearer = req.headers['authorization'] || '';
  if (!supplied && bearer.startsWith('Bearer ')) supplied = bearer.slice(7);
  const a = Buffer.from(String(supplied));
  const b = Buffer.from(ADMIN_KEY);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, status: 401, error: 'unauthorized' };
  }
  return { ok: true };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (c) => { buf += c; if (buf.length > 64 * 1024) reject(httpError(413, 'body too large')); });
    req.on('end', () => resolve(buf));
    req.on('error', reject);
  });
}

// --- static file serving (public/) ------------------------------------------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

function serveStatic(req, res) {
  let rel = req.url.split('?')[0];
  if (rel === '/' || rel === '') rel = '/index.html';
  // Resolve within PUBLIC_DIR and reject any traversal outside it.
  const full = path.join(PUBLIC_DIR, path.normalize(rel));
  if (!full.startsWith(PUBLIC_DIR)) { sendJson(res, 403, { ok: false, error: 'forbidden' }); return; }
  fs.readFile(full, (err, data) => {
    if (err) { sendJson(res, 404, { ok: false, error: 'not found' }); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
    res.end(data);
  });
}

// --- route handlers ----------------------------------------------------------
async function handleListSeats(_req, res) {
  const ids = Array.from({ length: SEAT_COUNT }, (_, i) => i + 1);
  const seats = await Promise.all(ids.map(readSeat));
  sendJson(res, 200, { ok: true, seats });
}

function validateAssign(id, body) {
  if (!(id >= 1 && id <= SEAT_COUNT)) throw httpError(400, `invalid seat id (1..${SEAT_COUNT})`);
  const mode = body && body.mode;
  if (mode !== 'hybrid' && mode !== 'ai-only') throw httpError(400, 'mode must be hybrid or ai-only');
  const credential = body && typeof body.credential === 'string' ? body.credential.trim() : '';
  if (!credential) throw httpError(400, 'credential is required');
  return { mode, credential };
}

async function handleAssign(req, res, id) {
  const raw = await readBody(req);
  let body;
  try { body = raw ? JSON.parse(raw) : {}; } catch (_) { throw httpError(400, 'invalid JSON body'); }
  const { mode, credential } = validateAssign(id, body);
  const result = await assignSeat(id, mode, credential);
  sendJson(res, 200, result);
}

// --- request router ----------------------------------------------------------
async function route(req, res) {
  const url = req.url.split('?')[0];

  // health is unauthenticated.
  if (req.method === 'GET' && url === '/healthz') { sendJson(res, 200, { ok: true }); return; }

  if (url.startsWith('/api/')) {
    const auth = authorized(req);
    if (!auth.ok) { sendJson(res, auth.status, { ok: false, error: auth.error }); return; }

    if (req.method === 'GET' && url === '/api/seats') { await handleListSeats(req, res); return; }
    const m = url.match(/^\/api\/seats\/(\d+)\/assign$/);
    if (req.method === 'POST' && m) { await handleAssign(req, res, parseInt(m[1], 10)); return; }
    sendJson(res, 404, { ok: false, error: 'no such route' });
    return;
  }

  // everything else is static (index.html + assets).
  if (req.method === 'GET') { serveStatic(req, res); return; }
  sendJson(res, 405, { ok: false, error: 'method not allowed' });
}

const server = http.createServer((req, res) => {
  // Wrap the router so ANY throw becomes a clean JSON envelope (no stack leak).
  Promise.resolve()
    .then(() => route(req, res))
    .catch((err) => {
      const status = err && err.status ? err.status : 500;
      const error = err && err.message ? err.message : 'internal error';
      if (!res.headersSent) sendJson(res, status, { ok: false, error });
    });
});

server.listen(PORT, () => {
  // Boot log carries config posture but NEVER the admin key or SA token.
  console.log(`[seat-manager] listening :${PORT} ns=${NAMESPACE} seats=${SEAT_COUNT} adminKey=${ADMIN_KEY ? 'set' : 'MISSING(fail-closed)'}`);
});

module.exports = { server };
