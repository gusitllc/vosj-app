// src/api/rbac.js — config-driven RBAC capability registry (§12.1).
// Closes the "capability model" design open-question ADDITIVELY: instead of the
// hardcoded principal-capability Set, requireCapability may consult a role ->
// capability map sourced from config (VOSJ_RBAC_ROLE_CAPABILITIES, a JSON object).
//
// DEFAULT-SAFE: when no registry is configured the registry is "empty" and the
// caller falls back to today's behaviour (the principal's own capabilities Set),
// so existing deployments and the 38 existing tests are unchanged. A configured
// registry is ADDITIVE — it only ever GRANTS via an explicit role mapping; it
// never broadens the structural human-gate guarantees (those live in the engine).
//
// We pick the config-driven map over DB tables deliberately: a capability check
// runs on every mutation, the map is tiny, and config is already the frozen,
// fail-closed source of truth (§15.2) — no per-request DB round-trip is warranted.

'use strict';

// buildRegistry(source) -> { configured, capabilitiesForRole(role) -> Set }.
// source may be a JSON string (from env) or an already-parsed object:
//   { "<role>": ["domain:resource:action", ...], ... }
// A malformed source fails CLOSED to an empty (unconfigured) registry — it never
// throws at boot and never silently grants.
function buildRegistry(source) {
  const map = normalise(source);
  const roles = Object.keys(map);
  const configured = roles.length > 0;
  return Object.freeze({
    configured,
    roles,
    capabilitiesForRole(role) {
      const caps = (role && map[role]) || [];
      return new Set(caps);
    },
    grants(role, cap) {
      return Boolean(role) && map[role] ? map[role].includes(cap) : false;
    },
  });
}

// Parse + sanitise the source into { role: string[] }. Non-object => {} (empty).
function normalise(source) {
  const parsed = parse(source);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const out = {};
  for (const role of Object.keys(parsed)) {
    const caps = parsed[role];
    if (!Array.isArray(caps)) continue;
    const clean = caps.filter((c) => typeof c === 'string' && c.length > 0);
    if (clean.length > 0) out[String(role)] = Object.freeze(clean.slice());
  }
  return out;
}

function parse(source) {
  if (source == null) return null;
  if (typeof source === 'object') return source;
  if (typeof source !== 'string' || source.trim() === '') return null;
  try { return JSON.parse(source); } catch (_) { return null; }
}

// registryFromConfig(config) -> a registry built from config.RBAC_ROLE_CAPABILITIES.
function registryFromConfig(config) {
  return buildRegistry(config && config.RBAC_ROLE_CAPABILITIES);
}

module.exports = { buildRegistry, registryFromConfig };
