// test/metering.test.js — PKG-METERING-OBSERVABILITY.
// Proves the two halves that make the four stations "observable + audited + metered"
// (gaps 1/3/5):
//   METERED   — recordEffort() captures effort/cost; aggregate() sums + groups by
//               phase; cost uses the CONFIGURED unit price (VOSJ_COST_PER_EFFORT_UNIT),
//               never a hardcoded value; an explicit cost overrides the derived one;
//               an unattributable row (no waveId) fails CLOSED.
//   OBSERVABLE — a tiny in-process EventBus + GET /api/events SSE endpoint streams a
//               'transition' event to a subscribed client (board no longer refresh-driven).
//   AUDITED   — already real via the ledger; here we prove the MATERIAL DEFECT guard
//               still holds alongside metering/observability: a high-risk disposition
//               is forced onto Strangler-Fig AND a gate/Jump is BLOCKED when the
//               disposition rule is violated (fail-closed), exercised through the
//               engine facade (no edit to the sibling-owned state-machine.js).
// In-memory, no DB, no real network (a loopback http server for SSE only).

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const express = require('express');

const { buildMetering, summarise } = require('../src/engine/metering');
const events = require('../src/api/events');
const { buildTestCtx } = require('./helpers');

// A config stand-in carrying only what metering reads (the unit price knob).
function meterConfig(costPerEffortUnit = 0) {
  return Object.freeze({ costPerEffortUnit });
}

// ---------------------------------------------------------------------------
// Metering: recordEffort + aggregate math, config-driven cost
// ---------------------------------------------------------------------------

test('recordEffort + aggregate: sums effort and groups by phase', async () => {
  const m = buildMetering({ config: meterConfig(0) });
  await m.recordEffort({ waveId: 'w1', workloadId: 'a', phase: 'P2', actor: 'eng', effortMs: 1000 });
  await m.recordEffort({ waveId: 'w1', workloadId: 'b', phase: 'P2', actor: 'eng', effortMs: 500 });
  await m.recordEffort({ waveId: 'w1', workloadId: 'c', phase: 'P3', actor: 'eng', effortMs: 250 });
  // a row for a DIFFERENT wave must not leak into w1's aggregate.
  await m.recordEffort({ waveId: 'w2', workloadId: 'z', phase: 'P2', actor: 'eng', effortMs: 9999 });

  const agg = await m.aggregate('w1');
  assert.equal(agg.ok, true);
  assert.equal(agg.totalEffortMs, 1750);
  assert.equal(agg.count, 3);
  assert.equal(agg.byPhase.P2.effortMs, 1500);
  assert.equal(agg.byPhase.P2.count, 2);
  assert.equal(agg.byPhase.P3.effortMs, 250);
  assert.equal(agg.byPhase.P3.count, 1);
});

test('cost is derived from the CONFIGURED unit price (never hardcoded)', async () => {
  const m = buildMetering({ config: meterConfig(0.002) }); // $0.002 per effort-ms
  await m.recordEffort({ waveId: 'w', phase: 'P2', effortMs: 1000 }); // -> 2.0
  await m.recordEffort({ waveId: 'w', phase: 'P3', effortMs: 500 });  // -> 1.0
  const agg = await m.aggregate('w');
  assert.equal(agg.totalCost, 3);
  assert.equal(agg.byPhase.P2.cost, 2);
  assert.equal(agg.byPhase.P3.cost, 1);
});

test('the SAME effort costs differently when the unit price changes (config-driven, not constant)', async () => {
  const cheap = buildMetering({ config: meterConfig(0.001) });
  const dear = buildMetering({ config: meterConfig(0.010) });
  await cheap.recordEffort({ waveId: 'w', effortMs: 1000 });
  await dear.recordEffort({ waveId: 'w', effortMs: 1000 });
  const a = await cheap.aggregate('w');
  const b = await dear.aggregate('w');
  assert.equal(a.totalCost, 1);
  assert.equal(b.totalCost, 10);
  assert.ok(b.totalCost > a.totalCost, 'a higher unit price yields a higher cost');
});

test('an explicit costUnits overrides the derived cost', async () => {
  const m = buildMetering({ config: meterConfig(0.5) });
  await m.recordEffort({ waveId: 'w', effortMs: 1000, costUnits: 42 }); // explicit wins over 500
  const agg = await m.aggregate('w');
  assert.equal(agg.totalCost, 42);
});

test('default unit price is 0 (fail-quiet, no synthetic cost until an operator sets a price)', async () => {
  const m = buildMetering({ config: meterConfig() });
  await m.recordEffort({ waveId: 'w', effortMs: 5000 });
  const agg = await m.aggregate('w');
  assert.equal(agg.totalCost, 0);
  assert.equal(agg.totalEffortMs, 5000);
});

test('recordEffort fails CLOSED on a missing waveId (unattributable usage rejected)', async () => {
  const m = buildMetering({ config: meterConfig(0.01) });
  const r = await m.recordEffort({ workloadId: 'a', effortMs: 100 });
  assert.equal(r.ok, false);
  assert.match(r.error, /waveId is required/);
  // nothing was recorded.
  const agg = await m.aggregate('w');
  assert.equal(agg.count, 0);
});

test('aggregate fails closed on a missing waveId', async () => {
  const m = buildMetering({ config: meterConfig() });
  const r = await m.aggregate('');
  assert.equal(r.ok, false);
  assert.match(r.error, /waveId is required/);
});

test('negative / non-numeric effort is clamped to 0 (no negative effort or cost)', async () => {
  const m = buildMetering({ config: meterConfig(0.01) });
  await m.recordEffort({ waveId: 'w', effortMs: -500 });
  await m.recordEffort({ waveId: 'w', effortMs: 'nonsense' });
  const agg = await m.aggregate('w');
  assert.equal(agg.totalEffortMs, 0);
  assert.equal(agg.totalCost, 0);
});

test('summarise() labels phaseless rows as "unphased"', () => {
  const s = summarise('w', [{ phase: null, effort_ms: 10, cost_units: 1 }]);
  assert.equal(s.byPhase.unphased.effortMs, 10);
  assert.equal(s.byPhase.unphased.cost, 1);
});

test('metering requires config (fail loud)', () => {
  assert.throws(() => buildMetering({}), /requires config/);
});

// metering persists via an injected pool stub (pg-mode path, parameterised SQL only).
test('recordEffort writes via the pool facade in pg mode (parameterised SQL)', async () => {
  const calls = [];
  const stubPool = {
    dbConfigured: true,
    async query(text, params) {
      calls.push({ text, params });
      // assert no string-concatenated values — only $1..$n placeholders.
      assert.match(text, /\$1/, 'uses parameter placeholders');
      assert.doesNotMatch(text, /VALUES\s*\([^$)]*'/, 'no inlined string literals');
      return { rows: [{ id: 1, wave_id: params[0], phase: params[2], effort_ms: params[4], cost_units: params[5] }] };
    },
  };
  const m = buildMetering({ config: meterConfig(0.01), pool: stubPool });
  const r = await m.recordEffort({ waveId: 'w', phase: 'P2', effortMs: 1000 });
  assert.equal(r.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].params[0], 'w');     // wave_id
  assert.equal(calls[0].params[4], 1000);    // effort_ms
  assert.equal(calls[0].params[5], 10);      // cost_units = 1000 * 0.01
});

// ---------------------------------------------------------------------------
// Observability: the EventBus + GET /api/events SSE endpoint
// ---------------------------------------------------------------------------

test('EventBus.publish tags the payload with event + ts and never throws with no listener', () => {
  const bus = new events.EventBus();
  const out = bus.publish('transition', { waveId: 'w', to: 'P3' });
  assert.equal(out.event, 'transition');
  assert.ok(out.ts, 'a server timestamp is attached');
  assert.equal(out.waveId, 'w');
});

test('getBus installs the shared bus on ctx (the ctx.events seam) and is idempotent', () => {
  const ctx = {};
  const a = events.getBus(ctx);
  const b = events.getBus(ctx);
  assert.strictEqual(a, b, 'same bus is reused');
  assert.strictEqual(ctx.events, a, 'bus is attached to ctx.events');
});

test('publishTransition emits a transition event carrying the signed ledger hash', async () => {
  const ctx = {};
  const bus = events.getBus(ctx);
  const seen = new Promise((resolve) => bus.once('transition', resolve));
  events.publishTransition(ctx, {
    waveId: 'w', from: 'P2', to: 'P3', gate: 'g-kickoff-complete',
    actor: 'eng', signerRole: 'it-lead', ledgerHash: 'abc123',
  });
  const evt = await seen;
  assert.equal(evt.event, 'transition');
  assert.equal(evt.to, 'P3');
  assert.equal(evt.ledgerHash, 'abc123');
});

// closeServer(server) — fully tear an http server down so the test process exits.
// server.close() alone only STOPS ACCEPTING new sockets; an SSE stream is a kept-
// alive connection that would keep the event loop (and the test runner) alive
// forever. closeAllConnections() force-drops live sockets first (Node >=18.2),
// then close() resolves. Without this the file hangs after the last assertion.
function closeServer(server) {
  return new Promise((resolve) => {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    server.close(() => resolve());
  });
}

// SSE: a subscribed client receives a transition event streamed live.
test('GET /api/events streams a transition event to a subscribed SSE client', async () => {
  const ctx = await buildTestCtx({ AUTH_MODE: 'token', AUTH_TOKEN: 'test-token' });
  const app = express();
  events.mount(app, ctx);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const chunks = [];
  let client = null;
  const transition = new Promise((resolve, reject) => {
    client = http.request(
      { host: '127.0.0.1', port, path: '/api/events', method: 'GET',
        headers: { Authorization: 'Bearer test-token', Accept: 'text/event-stream' } },
      (res) => {
        assert.equal(res.statusCode, 200);
        assert.match(res.headers['content-type'], /text\/event-stream/);
        res.setEncoding('utf8');
        res.on('data', (c) => {
          chunks.push(c);
          const buf = chunks.join('');
          if (buf.includes('"event":"transition"')) resolve(buf);
        });
      });
    client.on('error', reject);
    client.end();
    // once connected, emit a transition on the shared bus; the client should get it.
    setTimeout(() => events.publishTransition(ctx, { waveId: 'w', to: 'P3', ledgerHash: 'deadbeef' }), 50);
  });

  try {
    const body = await transition;
    assert.match(body, /event: transition/);
    assert.match(body, /"to":"P3"/);
    assert.match(body, /"ledgerHash":"deadbeef"/);
  } finally {
    // Tear the kept-alive SSE client + server down so the process can exit.
    if (client) client.destroy();
    await closeServer(server);
  }
});

test('GET /api/events requires authentication (data route, fail-closed)', async () => {
  const ctx = await buildTestCtx({ AUTH_MODE: 'token', AUTH_TOKEN: 'test-token' });
  const app = express();
  events.mount(app, ctx);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  try {
    const status = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/api/events', method: 'GET' },
        (res) => { resolve(res.statusCode); res.resume(); });
      req.on('error', reject);
      req.end();
    });
    assert.equal(status, 401, 'no bearer token => 401');
  } finally {
    await closeServer(server);
  }
});

// ---------------------------------------------------------------------------
// AUDITED (material defect): observable + metered coexist with the real audited
// property. The disposition rule must STILL hold — proven through the engine facade.
// ---------------------------------------------------------------------------

test('material defect: a high-risk disposition is FORCED onto Strangler-Fig (no big-bang)', async () => {
  const ctx = await buildTestCtx();
  for (const r of ['Refactor', 'Replatform', 'Relocate']) {
    const c = ctx.engine.classify({ disposition: r });
    assert.equal(c.contract.highRisk, true, `${r} is high-risk`);
    assert.equal(c.strangler, true, `${r} resolves to Strangler-Fig`);
    assert.equal(c.bigBangAvailable, false, `${r} cannot use a big-bang plan`);
  }
});

test('material defect: the kickoff gate is BLOCKED when a workload violates the disposition rule (null disposition), and the Jump fails closed without proof', async () => {
  const ctx = await buildTestCtx();
  const { HumanGateSigner } = require('../src/engine/gate');
  const { StateMachine } = require('../src/engine/state-machine');
  const template = require('../src/engine/template');
  const { CAF_TEMPLATE } = require('./helpers');
  const signer = new HumanGateSigner({ ledger: ctx.ledger, store: ctx.store });
  const sm = new StateMachine(template.loadFile(CAF_TEMPLATE), { signer, store: ctx.store });
  const ITLEAD = { id: 'iv-9', kind: 'human', role: 'it-lead' };
  const DBA = { id: 'dba-9', kind: 'human', role: 'dba' };

  // A wave whose workload carries a NULL disposition violates the kickoff rule.
  await ctx.store.saveWorkload({ id: 'mx', name: 'X', disposition: null, wave_id: 'wm', attributes: {} });
  await assert.rejects(
    () => sm.signTransition({ run: { id: 'wm', state: 'P2' }, to: 'P3', actor: 'eng', signer: ITLEAD }),
    /machine-checkable criteria not satisfied/,
    'P2->P3 must be BLOCKED while the disposition rule is violated',
  );

  // The Jump (unit cutover) is fail-closed without a passing reconciliation proof.
  await assert.rejects(
    () => sm.cutoverUnit({ unit: { id: 'mx', state: 'reconciled', migrationId: 'wm' },
      actor: 'eng', signer: DBA, proof: null }),
    /passing reconciliation proof required/,
    'the Jump must be BLOCKED without a passing proof',
  );
});
