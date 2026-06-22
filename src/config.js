// src/config.js — Vosj CE configuration.
// Reads process.env once, applies safe defaults, and exports a FROZEN object.
// Fail-closed secrets (ledger HMAC, vault master key) have NO default value:
// their absence is detected at use-time, never silently substituted (§12.2/§15.2).

'use strict';

// dotenv is optional — load .env if the package is present, ignore if not.
try { require('dotenv').config(); } catch (_) { /* dotenv not installed */ }

function int(v, dflt) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : dflt;
}

const PG_HOST = process.env.PG_HOST || '';
const PG_USER = process.env.PG_USER || '';
const PG_DATABASE = process.env.PG_DATABASE || '';

// DB is "configured" only when host, user, and database are all present.
const dbConfigured = Boolean(PG_HOST && PG_USER && PG_DATABASE);

const config = Object.freeze({
  version: require('../package.json').version,

  PORT: int(process.env.VOSJ_PORT, 8080),

  // State store selection — explicit env wins, else pg when DB configured, else memory.
  STATE_STORE: process.env.VOSJ_STATE_STORE || (dbConfigured ? 'pg' : 'memory'),

  dbConfigured,
  db: Object.freeze({
    host: PG_HOST,
    port: int(process.env.PG_PORT, 5432),
    user: PG_USER,
    password: process.env.PG_PASSWORD || '',
    database: PG_DATABASE,
    // Default TRUE (verify). Set VOSJ_DB_SSL_REJECT_UNAUTHORIZED=false for
    // CloudNativePG self-signed certs.
    sslRejectUnauthorized: process.env.VOSJ_DB_SSL_REJECT_UNAUTHORIZED !== 'false',
  }),

  // REQUIRED to sign the ledger. Absent => signing fails closed (never a default key).
  LEDGER_HMAC_KEY: process.env.VOSJ_LEDGER_HMAC_KEY || '',

  // REQUIRED for vault operations. Absent => vault refuses to operate (§15.2).
  VAULT_MASTER_KEY: process.env.VOSJ_VAULT_MASTER_KEY || '',

  // Auth: 'token' (bearer) by default; 'open' permitted for localhost dev only.
  AUTH_MODE: process.env.VOSJ_AUTH_MODE || 'token',
  AUTH_TOKEN: process.env.VOSJ_AUTH_TOKEN || '',

  // RBAC capability registry (optional). A JSON object string mapping a signer
  // role to the capabilities it may exercise, e.g.
  //   {"director":["migration:gate:sign"],"dba":["migration:reconcile:run"]}
  // ABSENT/empty => the capability check falls back to the principal's own Set
  // (today's behaviour). Malformed JSON fails closed to "unconfigured".
  RBAC_ROLE_CAPABILITIES: process.env.VOSJ_RBAC_ROLE_CAPABILITIES || '',

  // Reconciliation / baseline tuning (configurable, never hardcoded at call sites).
  baselineMaxAgeMs: int(process.env.VOSJ_BASELINE_MAX_AGE_MS, 24 * 60 * 60 * 1000),
});

module.exports = config;
