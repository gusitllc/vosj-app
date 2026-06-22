// src/server.js — Vosj CE entrypoint. Builds the shared ctx and mounts everything.
// MOUNT CONVENTION: feature modules export `function mount(app, ctx)`.
// ctx = { config, engine, store, ledger, connectors, log }.
// Optional modules (api, mcp, ui) are wrapped in try/catch so the spine boots and
// serves a REAL /health even before those modules exist.

'use strict';

const path = require('path');
const express = require('express');

const config = require('./config');
const { Ledger } = require('./ledger/ledger');
const { createStateStore } = require('./db/statestore');
const { buildEngine } = require('./engine');
const { DemoConnector } = require('./connectors/demo');

function log(level, msg, extra) {
  const line = `[${new Date().toISOString()}] ${level} ${msg}`;
  if (extra !== undefined) console.log(line, extra);
  else console.log(line);
}

async function buildContext() {
  // State store: pg only if configured AND selected, else in-memory.
  let pool = null;
  if (config.STATE_STORE === 'pg' && config.dbConfigured) {
    try { pool = require('./db/pool'); } catch (e) { log('WARN', 'pg pool unavailable, falling back', e.message); }
  }
  const store = createStateStore(config, pool);
  await store.init();

  const ledger = new Ledger({ store, config });
  const engine = buildEngine({ config, store, ledger });

  const connectors = new Map();
  connectors.set('demo', new DemoConnector());

  return { config, engine, store, ledger, connectors, log };
}

function mountHealth(app, ctx) {
  app.get('/health', async (_req, res) => {
    let storeHealth = { ok: false };
    let ledgerOk = false;
    let counts = { workloads: 0, waves: 0 };
    try { storeHealth = await ctx.store.health(); } catch (_) { /* report below */ }
    try { ledgerOk = await ctx.ledger.healthy(); } catch (_) { ledgerOk = false; }
    try { counts = await ctx.engine.counts(); } catch (_) { /* zeros */ }

    res.json({
      ok: true,
      version: ctx.config.version,
      uptime: process.uptime(),
      store: storeHealth.kind || ctx.config.STATE_STORE,
      storeOk: Boolean(storeHealth.ok),
      dbConfigured: ctx.config.dbConfigured,
      ledgerOk,
      workloads: counts.workloads,
      waves: counts.waves,
    });
  });
}

function mountOptional(name, app, ctx) {
  try {
    const mod = require(name);
    if (mod && typeof mod.mount === 'function') {
      mod.mount(app, ctx);
      log('INFO', `mounted ${name}`);
    }
  } catch (e) {
    log('INFO', `optional module ${name} not mounted: ${e.message}`);
  }
}

async function createApp() {
  const ctx = await buildContext();
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  mountHealth(app, ctx);

  // Optional feature modules (built by other agents). Order: API, then MCP.
  mountOptional('./api/routes', app, ctx);
  mountOptional('./mcp/server', app, ctx);

  // Static UI at '/'. Safe even if public/ has no files yet.
  app.use('/', express.static(path.join(__dirname, '..', 'public')));

  return { app, ctx };
}

async function start() {
  const { app } = await createApp();
  const server = app.listen(config.PORT, () => {
    log('INFO', `Vosj CE listening on :${config.PORT} (store=${config.STATE_STORE})`);
  });
  return server;
}

if (require.main === module) {
  start().catch((e) => { log('ERROR', 'failed to start', e); process.exit(1); });
}

module.exports = { createApp, buildContext, start };
