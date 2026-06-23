// src/api/events.js — observability event stream (PKG-METERING-OBSERVABILITY, gap 3).
// "Every signed transition emits an event" was previously unrealised: the live board
// required a manual refresh. This module provides a tiny IN-PROCESS EventBus (no new
// dependency — it wraps Node's core EventEmitter) and a Server-Sent-Events endpoint
//   GET /api/events  ->  text/event-stream
// that streams transition events to a subscribed client as they happen, so the board
// is no longer refresh-driven. Closing the observable half of "the four stations are
// observable + audited + metered" (gap 1).
//
// SEAM (one line, file-disjoint from state-machine.js / routes.js owned by sibling
// packages): mount() installs the shared bus at ctx.events when absent. The engine
// publishes on EVERY signed transition via
//   ctx.events.emit('transition', { event:'transition', ... })
// from the ledger.append site or a thin wrapper — NOT by editing state-machine.js.
// publishTransition() below is the canonical helper that site calls.

'use strict';

const { EventEmitter } = require('events');
const { requireAuth } = require('./auth');

const SSE_RETRY_MS = 3000;
const KEEPALIVE_MS = 25000;

// EventBus — a process-local pub/sub over Node's EventEmitter. Listeners are
// uncapped (a board may hold many SSE clients) and an emit never throws into the
// caller (a transition must not fail because nobody is listening).
class EventBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(0);
  }

  // publish(event, payload) — fire-and-forget. Always tags the payload with `event`
  // and a server timestamp so a subscriber can render without a refresh.
  publish(event, payload = {}) {
    const enriched = Object.assign({ event, ts: new Date().toISOString() }, payload);
    try { this.emit(event, enriched); } catch (_) { /* never throw into the emitter */ }
    return enriched;
  }
}

// getBus(ctx) — install/return the shared bus on ctx (the seam). Idempotent: the
// first caller (events.mount or the engine) wins, everyone shares the same bus.
function getBus(ctx) {
  if (ctx && ctx.events && typeof ctx.events.publish === 'function') return ctx.events;
  const bus = new EventBus();
  if (ctx) ctx.events = bus;
  return bus;
}

// publishTransition(ctx, info) — canonical helper the signed-transition site calls.
// Emits the 'transition' event carrying the move + the signed ledger hash so the
// board can show "who signed which gate, on what evidence" live.
function publishTransition(ctx, info = {}) {
  const bus = getBus(ctx);
  return bus.publish('transition', {
    waveId: info.waveId || null,
    from: info.from || null,
    to: info.to || null,
    gate: info.gate || null,
    actor: info.actor || null,
    signerRole: info.signerRole || null,
    ledgerHash: info.ledgerHash || null,
  });
}

// writeSse(res, payload) — encode one SSE frame. Named `transition` so EventSource
// clients can addEventListener('transition', ...).
function writeSse(res, payload) {
  const data = JSON.stringify(payload);
  res.write(`event: ${payload.event || 'message'}\n`);
  res.write(`data: ${data}\n\n`);
}

function mount(app, ctx) {
  const bus = getBus(ctx);
  const auth = requireAuth(ctx);

  // GET /api/events — SSE stream of transition events. Data route => requireAuth.
  app.get('/api/events', auth, (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`retry: ${SSE_RETRY_MS}\n\n`);
    writeSse(res, { event: 'ready', ts: new Date().toISOString() });

    const onTransition = (payload) => writeSse(res, payload);
    bus.on('transition', onTransition);

    const keepalive = setInterval(() => {
      try { res.write(': keepalive\n\n'); } catch (_) { /* socket gone */ }
    }, KEEPALIVE_MS);
    if (keepalive.unref) keepalive.unref();

    req.on('close', () => {
      clearInterval(keepalive);
      bus.removeListener('transition', onTransition);
    });
  });

  if (ctx && ctx.log) ctx.log('INFO', 'event stream mounted at /api/events');
}

module.exports = { mount, EventBus, getBus, publishTransition, writeSse };
