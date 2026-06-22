// src/db/pool.js — PostgreSQL connection pool + parameterised query facade.
// SSL honours config.db.sslRejectUnauthorized (CloudNativePG self-signed certs
// need it false, §14.4). All access is via query() with $1..$n parameters only —
// NEVER string concatenation. Guards every call when the DB is not configured.

'use strict';

const config = require('../config');

let _pool = null;

function getPool() {
  if (!config.dbConfigured) {
    throw new Error('database not configured (set PG_HOST/PG_USER/PG_DATABASE)');
  }
  if (_pool) return _pool;
  const { Pool } = require('pg');
  _pool = new Pool({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    database: config.db.database,
    // ssl:false disables TLS entirely — a plain self-hosted PG serves no TLS, and
    // passing any ssl object then fails with "server does not support SSL
    // connections". When TLS IS used, rejectUnauthorized honours the
    // self-signed-cert flag (CloudNativePG).
    ssl: config.db.ssl
      ? { rejectUnauthorized: config.db.sslRejectUnauthorized }
      : false,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  });
  return _pool;
}

// query(text, params) — parameterised only.
async function query(text, params = []) {
  const pool = getPool();
  return pool.query(text, params);
}

async function close() {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
}

// migrate() — applies src/db/schema.sql (idempotent, IF NOT EXISTS). Used by `npm run migrate`.
async function migrate() {
  if (!config.dbConfigured) {
    return { ok: false, error: 'database not configured; nothing to migrate' };
  }
  const fs = require('fs');
  const path = require('path');
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await query(sql);
  return { ok: true, applied: 'schema.sql' };
}

module.exports = { getPool, query, close, migrate, dbConfigured: config.dbConfigured };
