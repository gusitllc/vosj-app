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
const SEAT_DEFAULT = parseInt(process.env.SEAT_COUNT || '5', 10);
const SEAT_MAX = parseInt(process.env.SEAT_MAX || '50', 10); // Community Edition cap
const ADMIN_KEY = process.env.SEAT_MANAGER_ADMIN_KEY || '';
const PUBLIC_DIR = path.join(__dirname, 'public');

// Devstation spec parameters (for provisioning new seats on scale-up). Mirror
// deploy/poc/devstation.yaml + config.env; supplied to the Seat Manager via env.
const DEVSTATION_IMAGE = process.env.DEVSTATION_IMAGE || 'lucaexpressacr.azurecr.io/vosj-devstation:poc';
const DEVSTATION_PORT = parseInt(process.env.DEVSTATION_PORT || '8080', 10);
const ACR_PULL_SECRET = process.env.ACR_PULL_SECRET || 'vosj-acr-pull';
const DS_CPU_REQUEST = process.env.DEVSTATION_CPU_REQUEST || '100m';
const DS_CPU_LIMIT = process.env.DEVSTATION_CPU_LIMIT || '1';
const DS_MEM_REQUEST = process.env.DEVSTATION_MEM_REQUEST || '300Mi';
const DS_MEM_LIMIT = process.env.DEVSTATION_MEM_LIMIT || '1Gi';
const DS_CLAUDE_MODEL = process.env.DEVSTATION_CLAUDE_MODEL || 'opus';
const DS_CLAUDE_FALLBACK = process.env.DEVSTATION_CLAUDE_FALLBACK_MODEL || 'sonnet';

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

// --- seat provisioning (scale up/down) ---------------------------------------
// Scaling creates/deletes a devstation's Deployment + Service + per-seat Secret
// via the k8s API. The specs MIRROR deploy/poc/devstation.yaml (lean code-server
// image, port 8080, envFrom the -env Secret, ephemeral emptyDir, no SA token).
const SEAT_SELECTOR = 'app.kubernetes.io/name=devstation';
const secretsColl = `/api/v1/namespaces/${NAMESPACE}/secrets`;
const servicesColl = `/api/v1/namespaces/${NAMESPACE}/services`;
const deploysColl = `/apis/apps/v1/namespaces/${NAMESPACE}/deployments`;
const servicePath = (name) => `${servicesColl}/${encodeURIComponent(name)}`;

const seatName = (i) => `devstation-${i}`;
const seatSecret = (i) => `devstation-${i}-env`;
function seatLabels(i) {
  return {
    'app.kubernetes.io/name': 'devstation',
    'app.kubernetes.io/instance': seatName(i),
    'app.kubernetes.io/part-of': 'vosj-poc',
  };
}
function genPassword() { return crypto.randomBytes(32).toString('hex'); }

function seatSecretSpec(i) {
  const pw = genPassword();
  return {
    apiVersion: 'v1', kind: 'Secret',
    metadata: { name: seatSecret(i), namespace: NAMESPACE, labels: seatLabels(i) },
    stringData: {
      CODE_SERVER_PASSWORD: pw, PASSWORD: pw, DEVSTATION_NAME: seatName(i),
      DEVSTATION_WORKER_ENABLED: 'false', VOSJ_SEAT_MODE: 'unassigned',
      CLAUDE_MODEL: DS_CLAUDE_MODEL, CLAUDE_FALLBACK_MODEL: DS_CLAUDE_FALLBACK,
      CLAUDE_CODE_OAUTH_TOKEN: '', ANTHROPIC_API_KEY: '',
      // Extension policy (empty = install nothing; the Seat Manager "Push" fills these).
      VOSJ_SEAT_TIER: 'none', CODE_SERVER_EXTENSIONS: '', CODE_SERVER_EXT_POLICY_VERSION: '0',
    },
  };
}

function seatDeploymentSpec(i) {
  const name = seatName(i);
  return {
    apiVersion: 'apps/v1', kind: 'Deployment',
    metadata: { name, namespace: NAMESPACE, labels: { ...seatLabels(i), 'devstation/seat': name } },
    spec: {
      replicas: 1, strategy: { type: 'Recreate' },
      selector: { matchLabels: { 'app.kubernetes.io/name': 'devstation', 'app.kubernetes.io/instance': name } },
      template: {
        metadata: { labels: seatLabels(i) },
        spec: {
          automountServiceAccountToken: false,
          securityContext: { runAsNonRoot: false, seccompProfile: { type: 'RuntimeDefault' } },
          imagePullSecrets: ACR_PULL_SECRET ? [{ name: ACR_PULL_SECRET }] : [],
          containers: [{
            name: 'code-server', image: DEVSTATION_IMAGE, imagePullPolicy: 'Always',
            args: ['--bind-addr', `0.0.0.0:${DEVSTATION_PORT}`, '/home/coder/project'],
            envFrom: [{ secretRef: { name: seatSecret(i) } }],
            ports: [{ name: 'http', containerPort: DEVSTATION_PORT }],
            resources: {
              requests: { cpu: DS_CPU_REQUEST, memory: DS_MEM_REQUEST },
              limits: { cpu: DS_CPU_LIMIT, memory: DS_MEM_LIMIT },
            },
            readinessProbe: { httpGet: { path: '/healthz', port: 'http' }, initialDelaySeconds: 10, periodSeconds: 10, timeoutSeconds: 3, failureThreshold: 6 },
            livenessProbe: { tcpSocket: { port: 'http' }, initialDelaySeconds: 30, periodSeconds: 20, timeoutSeconds: 5, failureThreshold: 3 },
            volumeMounts: [
              { name: 'project', mountPath: '/home/coder/project' },
              { name: 'config', mountPath: '/home/coder/.config' },
              { name: 'local', mountPath: '/home/coder/.local' },
            ],
          }],
          volumes: [
            { name: 'project', emptyDir: {} },
            { name: 'config', emptyDir: {} },
            { name: 'local', emptyDir: {} },
          ],
        },
      },
    },
  };
}

function seatServiceSpec(i) {
  const name = seatName(i);
  return {
    apiVersion: 'v1', kind: 'Service',
    metadata: { name, namespace: NAMESPACE, labels: seatLabels(i) },
    spec: {
      type: 'ClusterIP',
      selector: { 'app.kubernetes.io/name': 'devstation', 'app.kubernetes.io/instance': name },
      ports: [{ name: 'http', port: 80, targetPort: 'http' }],
    },
  };
}

// Discover the actually-provisioned seat indices (sorted) from the cluster.
async function listSeatIds() {
  const r = await kube('GET', `${deploysColl}?labelSelector=${encodeURIComponent(SEAT_SELECTOR)}`);
  const items = (r.json && r.json.items) || [];
  return items
    .map((d) => { const m = /^devstation-(\d+)$/.exec(d.metadata && d.metadata.name); return m ? parseInt(m[1], 10) : null; })
    .filter((n) => n !== null)
    .sort((a, b) => a - b);
}

// Detect which seats the cluster CANNOT schedule (Pending / Unschedulable due to
// insufficient resources) — so the UI can auto-warn when a scale-up won't fit.
async function seatSchedulingMap() {
  const podsColl = `/api/v1/namespaces/${NAMESPACE}/pods`;
  const r = await kube('GET', `${podsColl}?labelSelector=${encodeURIComponent(SEAT_SELECTOR)}`);
  const items = (r.json && r.json.items) || [];
  const map = {};
  for (const p of items) {
    const labels = (p.metadata && p.metadata.labels) || {};
    const m = /^devstation-(\d+)$/.exec(labels['app.kubernetes.io/instance'] || '');
    if (!m) continue;
    const conds = (p.status && p.status.conditions) || [];
    const sched = conds.find((c) => c.type === 'PodScheduled');
    if (sched && sched.status === 'False' && sched.reason === 'Unschedulable') {
      map[parseInt(m[1], 10)] = sched.message || 'insufficient cluster resources';
    }
  }
  return map;
}

const ok2xx = (s) => s >= 200 && s < 300;

// Create a seat's Secret + Deployment + Service when absent (idempotent; 409 ok).
async function ensureSeat(i) {
  if ((await kube('GET', secretsPath(seatSecret(i)))).status === 404) {
    const r = await kube('POST', secretsColl, seatSecretSpec(i));
    if (!ok2xx(r.status) && r.status !== 409) throw httpError(502, `seat ${i} secret create failed (HTTP ${r.status})`);
  }
  if ((await kube('GET', deployPath(seatName(i)))).status === 404) {
    const r = await kube('POST', deploysColl, seatDeploymentSpec(i));
    if (!ok2xx(r.status) && r.status !== 409) throw httpError(502, `seat ${i} deployment create failed (HTTP ${r.status})`);
  }
  if ((await kube('GET', servicePath(seatName(i)))).status === 404) {
    const r = await kube('POST', servicesColl, seatServiceSpec(i));
    if (!ok2xx(r.status) && r.status !== 409) throw httpError(502, `seat ${i} service create failed (HTTP ${r.status})`);
  }
}

// Delete a seat's Deployment + Service + Secret (404s are fine).
async function removeSeat(i) {
  await kube('DELETE', deployPath(seatName(i)));
  await kube('DELETE', servicePath(seatName(i)));
  await kube('DELETE', secretsPath(seatSecret(i)));
}

// Reconcile the provisioned seats to exactly `target` (1..SEAT_MAX): create any
// missing 1..target, then delete any seat above the target.
async function scaleSeats(target) {
  const current = await listSeatIds();
  const created = [];
  const removed = [];
  for (let i = 1; i <= target; i += 1) {
    if (current.includes(i)) continue;
    await ensureSeat(i);
    created.push(i);
  }
  for (const i of current) {
    if (i <= target) continue;
    await removeSeat(i);
    removed.push(i);
  }
  return { created, removed };
}

// --- extension policy (per-tier, Open-VSX-clean only) ------------------------
// One ConfigMap `devstation-extension-policy` is the source of truth. On "Push",
// the resolved id[@version] list lands in the seat's CODE_SERVER_EXTENSIONS (-env
// Secret) and the devstation entrypoint installs it from Open VSX on boot. Every
// item is license-clean — NO Marketplace-only / paid items (e.g. Copilot).
const POLICY_CM = 'devstation-extension-policy';
const cmPath = (name) => `/api/v1/namespaces/${NAMESPACE}/configmaps/${encodeURIComponent(name)}`;
const cmColl = `/api/v1/namespaces/${NAMESPACE}/configmaps`;
const EXT_TIERS = ['none', 'beginner', 'intermediate', 'advanced'];

const ext = (id, pin) => ({ id, version: '', registry: 'open-vsx', pin: pin || 'minor' });
const BEGINNER_EXT = [
  ext('ms-python.python', 'exact'), ext('dbaeumer.vscode-eslint'), ext('esbenp.prettier-vscode'),
  ext('redhat.vscode-yaml'), ext('eamodio.gitlens'), ext('humao.rest-client'),
];
const INTERMEDIATE_EXT = BEGINNER_EXT.concat([
  ext('ms-kubernetes-tools.vscode-kubernetes-tools', 'exact'), ext('ms-azuretools.vscode-docker', 'exact'),
  ext('ms-azuretools.vscode-azureresourcegroups', 'exact'), ext('ms-azuretools.vscode-bicep', 'exact'),
  ext('jeanp413.open-remote-ssh', 'exact'),
]);
const ADVANCED_EXT = INTERMEDIATE_EXT.concat([ext('anthropic.claude-code', 'exact')]);
const DEFAULT_POLICY = {
  version: 1,
  tiers: {
    beginner: { extensions: BEGINNER_EXT },
    intermediate: { extensions: INTERMEDIATE_EXT },
    advanced: { extensions: ADVANCED_EXT },
  },
};

// Read the policy CM; fall back to the built-in default until one is saved.
async function readPolicy() {
  const r = await kube('GET', cmPath(POLICY_CM));
  if (r.status === 200 && r.json && r.json.data && r.json.data['policy.json']) {
    try { return JSON.parse(r.json.data['policy.json']); } catch (_) { /* fall through */ }
  }
  return DEFAULT_POLICY;
}

// Create (POST) or update (merge-patch) the policy CM.
async function writePolicy(policy) {
  const ex = await kube('GET', cmPath(POLICY_CM));
  if (ex.status === 200) {
    const r = await kube('PATCH', cmPath(POLICY_CM), { data: { 'policy.json': JSON.stringify(policy) } }, 'application/merge-patch+json');
    if (!ok2xx(r.status)) throw httpError(502, `policy update failed (HTTP ${r.status})`);
  } else {
    const cm = {
      apiVersion: 'v1', kind: 'ConfigMap',
      metadata: { name: POLICY_CM, namespace: NAMESPACE, labels: { 'app.kubernetes.io/part-of': 'vosj-poc' } },
      data: { 'policy.json': JSON.stringify(policy) },
    };
    const r = await kube('POST', cmColl, cm);
    if (!ok2xx(r.status) && r.status !== 409) throw httpError(502, `policy create failed (HTTP ${r.status})`);
  }
}

// Resolve a tier -> the comma-separated `id[@version]` list to install.
function resolveTierCsv(policy, tier) {
  if (tier === 'none') return '';
  const t = policy && policy.tiers && policy.tiers[tier];
  const exts = (t && Array.isArray(t.extensions)) ? t.extensions : [];
  return exts.map((e) => (e.version ? `${e.id}@${e.version}` : e.id)).join(',');
}

function buildExtensionPatch(tier, csv, policyVersion) {
  return { data: {
    VOSJ_SEAT_TIER: b64enc(tier),
    CODE_SERVER_EXTENSIONS: b64enc(csv),
    CODE_SERVER_EXT_POLICY_VERSION: b64enc(String(policyVersion)),
  } };
}

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
    seat.tier = b64dec(data.VOSJ_SEAT_TIER) || 'none';
    seat.extPolicyVersion = b64dec(data.CODE_SERVER_EXT_POLICY_VERSION) || '0';
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
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

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
  const ids = await listSeatIds();
  const [seats, schedMap] = await Promise.all([
    Promise.all(ids.map(readSeat)),
    seatSchedulingMap(),
  ]);
  let unschedulable = 0;
  for (const s of seats) {
    if (schedMap[s.id]) { s.schedulable = false; s.scheduleReason = schedMap[s.id]; unschedulable += 1; }
    else s.schedulable = true;
  }
  const capacityWarning = unschedulable > 0
    ? `The cluster can't fit all ${ids.length} seats — ${unschedulable} unschedulable (insufficient resources). `
      + 'Reduce the seat count or add cluster capacity.'
    : '';
  sendJson(res, 200, { ok: true, seats, count: ids.length, max: SEAT_MAX, default: SEAT_DEFAULT, unschedulable, capacityWarning });
}

// POST /api/scale { count } — provision/de-provision seats to match (1..SEAT_MAX).
async function handleScale(req, res) {
  const raw = await readBody(req);
  let body;
  try { body = raw ? JSON.parse(raw) : {}; } catch (_) { throw httpError(400, 'invalid JSON body'); }
  const target = parseInt(body.count, 10);
  if (!(target >= 1 && target <= SEAT_MAX)) throw httpError(400, `count must be between 1 and ${SEAT_MAX}`);
  const { created, removed } = await scaleSeats(target);
  sendJson(res, 200, { ok: true, count: target, max: SEAT_MAX, created, removed });
}

// GET /api/ext-policy — the current extension policy + the tier names.
async function handleGetPolicy(_req, res) {
  const policy = await readPolicy();
  sendJson(res, 200, { ok: true, policy, tiers: EXT_TIERS });
}

// PUT /api/ext-policy { policy } — save the edited policy (bumps the version).
async function handlePutPolicy(req, res) {
  const raw = await readBody(req);
  let body;
  try { body = raw ? JSON.parse(raw) : {}; } catch (_) { throw httpError(400, 'invalid JSON body'); }
  const policy = (body && body.policy) || body;
  if (!policy || typeof policy !== 'object' || !policy.tiers) throw httpError(400, 'policy.tiers is required');
  const cur = await readPolicy();
  policy.version = (parseInt(cur.version, 10) || 0) + 1;
  await writePolicy(policy);
  sendJson(res, 200, { ok: true, version: policy.version });
}

// POST /api/seats/:id/extensions { tier } — push the tier's extensions to a seat
// (write the -env Secret + restart, reusing the assign path).
async function handleExtensions(req, res, id) {
  const raw = await readBody(req);
  let body;
  try { body = raw ? JSON.parse(raw) : {}; } catch (_) { throw httpError(400, 'invalid JSON body'); }
  const tier = String(body.tier || '').trim();
  if (!EXT_TIERS.includes(tier)) throw httpError(400, 'tier must be one of: ' + EXT_TIERS.join(', '));
  if (!(id >= 1 && id <= SEAT_MAX)) throw httpError(400, `invalid seat id (1..${SEAT_MAX})`);
  const policy = await readPolicy();
  const csv = resolveTierCsv(policy, tier);
  const sp = await kube('PATCH', secretsPath(seatSecret(id)),
    buildExtensionPatch(tier, csv, policy.version), 'application/merge-patch+json');
  if (sp.status < 200 || sp.status >= 300) {
    throw httpError(sp.status === 404 ? 404 : 502, `seat ${id} extension patch failed (HTTP ${sp.status})`);
  }
  const restartPatch = { spec: { template: { metadata: { annotations: { 'vosj.seat-manager/restartedAt': new Date().toISOString() } } } } };
  const dp = await kube('PATCH', deployPath(seatName(id)), restartPatch, 'application/strategic-merge-patch+json');
  if (dp.status < 200 || dp.status >= 300) throw httpError(502, `seat ${id} restart failed (HTTP ${dp.status})`);
  sendJson(res, 200, { ok: true, id, tier, policyVersion: policy.version, extensions: csv ? csv.split(',') : [] });
}

function validateAssign(id, body) {
  if (!(id >= 1 && id <= SEAT_MAX)) throw httpError(400, `invalid seat id (1..${SEAT_MAX})`);
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
    if (req.method === 'POST' && url === '/api/scale') { await handleScale(req, res); return; }
    if (req.method === 'GET' && url === '/api/ext-policy') { await handleGetPolicy(req, res); return; }
    if (req.method === 'PUT' && url === '/api/ext-policy') { await handlePutPolicy(req, res); return; }
    const m = url.match(/^\/api\/seats\/(\d+)\/assign$/);
    if (req.method === 'POST' && m) { await handleAssign(req, res, parseInt(m[1], 10)); return; }
    const me = url.match(/^\/api\/seats\/(\d+)\/extensions$/);
    if (req.method === 'POST' && me) { await handleExtensions(req, res, parseInt(me[1], 10)); return; }
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
  console.log(`[seat-manager] listening :${PORT} ns=${NAMESPACE} seats=${SEAT_DEFAULT}/${SEAT_MAX} adminKey=${ADMIN_KEY ? 'set' : 'MISSING(fail-closed)'}`);
});

module.exports = { server };
