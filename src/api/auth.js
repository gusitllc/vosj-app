// src/api/auth.js — REST authentication & capability gating (§12.1).
// Authorisation is capability-based: actions are named {domain}:{resource}:{action}
// and every data route requires authentication while every mutation requires an
// explicit capability. CE auth is intentionally simple: a single bearer token
// (config.AUTH_TOKEN) in 'token' mode, or 'open' mode which is permitted for
// LOCALHOST DEV ONLY — a remote caller in 'open' mode is still rejected.
//
// IMPORTANT: this layer bounds *capability* (can the caller mutate at all). It does
// NOT, and must not, grant the human gate sign-off — Invariant 1 (no agent
// self-sign) and separation of duties are enforced structurally in the engine's
// HumanGateSigner, never here.

'use strict';

const { buildRegistry } = require('./rbac');

const LOCAL_HOSTS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost']);

// Module-level RBAC registry. Empty (unconfigured) by default => requireCapability
// preserves today's behaviour (the principal's own capability Set). configureRbac()
// is called once by requireAuth(ctx) so routes need not change their call sites.
let RBAC = buildRegistry(null);

// configureRbac(config) -> install a role->capability registry from config. Idempotent.
function configureRbac(config) {
  RBAC = buildRegistry(config && config.RBAC_ROLE_CAPABILITIES);
  return RBAC;
}

// getRbacRegistry() -> the currently-installed module-level registry. Lets other
// seams (e.g. the MCP per-tool pre-filter) reuse the SAME configured registry that
// requireCapability consults, rather than building a divergent one.
function getRbacRegistry() {
  return RBAC;
}

function isLocalRequest(req) {
  const ip = (req.ip || (req.socket && req.socket.remoteAddress) || '').toString();
  if (LOCAL_HOSTS.has(ip)) return true;
  const host = (req.hostname || '').toString();
  return host === 'localhost' || host === '127.0.0.1';
}

function bearerToken(req) {
  const h = req.headers && req.headers.authorization;
  if (!h || typeof h !== 'string') return '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : '';
}

function fail(res, code, error) {
  return res.status(code).json({ ok: false, error });
}

// requireAuth(ctx) -> express middleware. Authenticates the caller and attaches
// req.principal = { id, kind:'agent'|'human', capabilities:Set, mode }.
function requireAuth(ctx) {
  const { config, log } = ctx;
  configureRbac(config); // install the (possibly empty) RBAC registry from config.
  return function authMiddleware(req, res, next) {
    // 'open' mode: localhost dev only. A remote caller is denied (fail-closed).
    if (config.AUTH_MODE === 'open') {
      if (!isLocalRequest(req)) {
        return fail(res, 401, "auth mode 'open' is restricted to localhost");
      }
      req.principal = openPrincipal();
      return next();
    }

    // 'token' mode: a bearer token must be configured AND must match.
    if (!config.AUTH_TOKEN) {
      if (log) log('WARN', 'auth: token mode but no AUTH_TOKEN configured (fail-closed)');
      return fail(res, 503, 'authentication not configured: set VOSJ_AUTH_TOKEN');
    }
    const tok = bearerToken(req);
    if (!tok || !safeEqual(tok, config.AUTH_TOKEN)) {
      return fail(res, 401, 'invalid or missing bearer token');
    }
    req.principal = tokenPrincipal(req);
    return next();
  };
}

// requireCapability(cap, registry?) -> middleware. Caller must be authenticated
// AND hold the named {domain}:{resource}:{action} capability. The capability is
// recorded on the request so the route can bind it into the ledger meta (§12.2).
//
// Capability resolution (fail-closed, additive):
//   - registry UNCONFIGURED -> today's behaviour: the principal's own Set.
//   - registry CONFIGURED   -> the principal holds `cap` if EITHER its own Set
//     holds it OR the registry grants it to the principal's role. A configured
//     registry only ever GRANTS via an explicit role mapping; it never removes a
//     capability the principal already carried, so it cannot break callers.
function requireCapability(cap, registry) {
  return function capabilityMiddleware(req, res, next) {
    const p = req.principal;
    if (!p) return fail(res, 401, 'authentication required');
    if (!holdsCapability(p, cap, registry || RBAC)) {
      return fail(res, 403, `missing capability: ${cap}`);
    }
    req.capability = cap;
    return next();
  };
}

// holdsCapability(principal, cap, registry) -> boolean. Set first (today's path),
// then a configured role grant. Unconfigured registry => Set-only (no change).
function holdsCapability(principal, cap, registry) {
  if (principal.capabilities && principal.capabilities.has(cap)) return true;
  if (registry && registry.configured && principal.role) {
    return registry.grants(principal.role, cap);
  }
  return false;
}

// Constant-time-ish comparison to avoid trivial token length/early-exit leaks.
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// CE capability set: an authenticated caller is a 'contributor' principal that may
// perform engine mutations. It is deliberately an 'agent' principal — it CANNOT be
// the human gate signer (that identity is supplied explicitly in the sign payload
// and validated by the engine). 'jump.execute' is included because the cutover gate
// itself fails closed without a passing proof + human signature in the engine.
const CE_CAPABILITIES = Object.freeze([
  'migration:workload:write',
  'migration:disposition:write',
  'migration:disposition:read',
  'migration:wave:write',
  'migration:wave:plan',
  'migration:wave:shift',
  'migration:reconcile:run',
  'migration:gate:sign',
  'migration:jump:execute',
  'migration:ledger:read',
  'migration:template:read',
  // PKG-TEMPLATE-LIFECYCLE: authoring framework templates (create/clone/edit/
  // publish). NOTE for eng-director: NEW capability — overlaps PKG-PER-TOOL-RBAC's
  // one-new-cap convention; ensure the RBAC_ROLE_CAPABILITIES grant for the
  // template-author role includes it when role-based grants are configured.
  'migration:template:write',
  // PKG-PER-TOOL-RBAC: read capabilities the MCP tool seam binds to its read-only
  // tools (list_templates -> :template:read, classify_workload -> :disposition:read,
  // ledger_verify -> :ledger:read). The default CE contributor principal holds them
  // so legitimate read tools are callable; a CONFIGURED RBAC registry can still deny
  // a narrower role per-tool (the seam consults the same registry as requireCapability).
  // PKG-EVIDENCE-PACKAGE: reading the exportable, control-mapped governance evidence
  // package (GET /api/waves/:id/evidence-package). NOTE for eng-director: NEW
  // capability — same one-new-cap convention as PKG-TEMPLATE-LIFECYCLE's
  // migration:template:write; when RBAC_ROLE_CAPABILITIES is configured, grant it to
  // the auditor/reviewer role so an external auditor can pull the bundle read-only.
  'migration:evidence:read',
]);

function capabilitySet() {
  return new Set(CE_CAPABILITIES);
}

function tokenPrincipal(req) {
  // A subject hint may be passed for audit attribution; defaults to a generic id.
  const subject = (req.headers && req.headers['x-vosj-actor']) || 'token-principal';
  return {
    id: String(subject).slice(0, 200),
    kind: 'agent',
    mode: 'token',
    capabilities: capabilitySet(),
  };
}

function openPrincipal() {
  return { id: 'localhost-dev', kind: 'agent', mode: 'open', capabilities: capabilitySet() };
}

module.exports = {
  requireAuth, requireCapability, configureRbac, getRbacRegistry, holdsCapability,
  CE_CAPABILITIES, isLocalRequest,
};
