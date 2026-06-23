// test/config.test.js — DB connection config (§14.4): the TLS off-switch.
// Regression cover for the POC fix: a plain self-hosted Postgres serves NO TLS,
// so passing any ssl object fails the handshake ("server does not support SSL
// connections"). VOSJ_DB_SSL toggles whether TLS is used AT ALL; when it IS used,
// VOSJ_DB_SSL_REJECT_UNAUTHORIZED controls certificate verification.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const CONFIG_PATH = require.resolve('../src/config');
const ENV_KEYS = ['PG_HOST', 'PG_USER', 'PG_DATABASE', 'VOSJ_DB_SSL', 'VOSJ_DB_SSL_REJECT_UNAUTHORIZED'];

// Load src/config FRESH under a given env (it reads process.env once and freezes),
// restoring the prior process.env afterwards so tests stay isolated.
function loadConfig(env) {
  const saved = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, env);
  delete require.cache[CONFIG_PATH];
  try {
    return require('../src/config');
  } finally {
    delete require.cache[CONFIG_PATH];
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

const PG = { PG_HOST: 'db', PG_USER: 'u', PG_DATABASE: 'd' };

test('db is configured when host+user+database are present', () => {
  assert.equal(loadConfig({ ...PG }).dbConfigured, true);
});

test('VOSJ_DB_SSL defaults to true (production CloudNativePG serves TLS)', () => {
  assert.equal(loadConfig({ ...PG }).db.ssl, true);
});

test('VOSJ_DB_SSL=false disables TLS entirely (plain no-TLS Postgres)', () => {
  assert.equal(loadConfig({ ...PG, VOSJ_DB_SSL: 'false' }).db.ssl, false);
});

test('sslRejectUnauthorized defaults to true (verify the cert chain)', () => {
  assert.equal(loadConfig({ ...PG }).db.sslRejectUnauthorized, true);
});

test('VOSJ_DB_SSL_REJECT_UNAUTHORIZED=false relaxes cert verification', () => {
  assert.equal(loadConfig({ ...PG, VOSJ_DB_SSL_REJECT_UNAUTHORIZED: 'false' }).db.sslRejectUnauthorized, false);
});
