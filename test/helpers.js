// test/helpers.js — shared test fixtures for Vosj CE.
// Builds a minimal, in-memory ctx (memory StateStore + a ledger with a test HMAC
// key) so the engine / gate / ledger behaviour can be exercised without a DB or
// real cloud. Mirrors the ctx shape src/server.js builds (§ Foundation contract).

'use strict';

const path = require('path');
const { Ledger } = require('../src/ledger/ledger');
const { MemoryStateStore } = require('../src/db/statestore');
const { buildEngine } = require('../src/engine');
const { DemoConnector } = require('../src/connectors/demo');

// A non-default HMAC key. The ledger is FAIL-CLOSED without one (§12.2), so tests
// that want a working ledger must supply it; tests for fail-closed omit it.
const TEST_HMAC_KEY = 'test-ledger-key-0123456789abcdef0123456789abcdef';

// A frozen config stand-in. We do not require src/config.js because it reads
// process.env at load time — tests control the key explicitly instead.
function testConfig(overrides = {}) {
  return Object.freeze(Object.assign({
    version: 'test',
    PORT: 0,
    STATE_STORE: 'memory',
    dbConfigured: false,
    LEDGER_HMAC_KEY: TEST_HMAC_KEY,
    VAULT_MASTER_KEY: 'test-vault-key',
    AUTH_MODE: 'token',
    AUTH_TOKEN: 'test-token',
    baselineMaxAgeMs: 24 * 60 * 60 * 1000,
  }, overrides));
}

// buildTestCtx() -> a ctx like server.js builds, all in memory.
async function buildTestCtx(configOverrides = {}) {
  const config = testConfig(configOverrides);
  const store = new MemoryStateStore();
  await store.init();
  const ledger = new Ledger({ store, config });
  const engine = buildEngine({ config, store, ledger });
  const connectors = new Map([['demo', new DemoConnector()]]);
  const log = () => {}; // silent in tests
  return { config, engine, store, ledger, connectors, log };
}

// A fresh baseline timestamp so reconcile() does not fail-closed on staleness.
function freshBaseline() {
  return new Date().toISOString();
}

const CAF_TEMPLATE = path.join(__dirname, '..', 'templates', 'caf.json');

module.exports = { TEST_HMAC_KEY, testConfig, buildTestCtx, freshBaseline, CAF_TEMPLATE };
