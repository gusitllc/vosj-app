// src/mcp/queue.js — durable work-order queue (the bring-your-own-AI seam, R8).
// An external planner enqueues orders; a worker claims the next pending order and
// reports markDone/markFailed. Two backends, picked by the store kind:
//   - pg:     atomic claim via `SELECT ... FOR UPDATE SKIP LOCKED` in a txn so two
//             concurrent workers never grab the same row (no double-execution).
//   - memory: an in-process fallback for STATE_STORE=memory (single-process only).
// Parameterised SQL ONLY ($1,$2) — never string concatenation.

'use strict';

const crypto = require('crypto');

const STATUS = Object.freeze({ PENDING: 'pending', CLAIMED: 'claimed', DONE: 'done', FAILED: 'failed' });

// createQueue(ctx) -> queue. Uses the pg pool when the store is pg, else memory.
function createQueue(ctx) {
  const store = ctx && ctx.store;
  const usePg = store && store.kind === 'pg' && store.pool && typeof store.pool.getPool === 'function';
  return usePg ? new PgOrderQueue(store.pool) : new MemoryOrderQueue();
}

function newId() {
  return `ord_${Date.now().toString(36)}_${crypto.randomBytes(6).toString('hex')}`;
}

function normaliseOrder(order = {}) {
  const kind = order.kind;
  if (!kind || typeof kind !== 'string') throw new Error('order requires a string kind');
  return {
    id: order.id || newId(),
    kind,
    payload: order.payload && typeof order.payload === 'object' ? order.payload : {},
  };
}

// ---------------------------------------------------------------------------
// PostgreSQL queue
// ---------------------------------------------------------------------------
class PgOrderQueue {
  constructor(poolFacade) {
    this.kind = 'pg';
    this.poolFacade = poolFacade; // src/db/pool.js ({ query, getPool })
  }

  async enqueue(order) {
    const o = normaliseOrder(order);
    const r = await this.poolFacade.query(
      `INSERT INTO vosj.orders (id, kind, payload, status)
       VALUES ($1,$2,$3,'pending') RETURNING *`,
      [o.id, o.kind, o.payload]);
    return r.rows[0];
  }

  // claimNext(workerId) — atomically take ONE pending order. FOR UPDATE SKIP LOCKED
  // lets concurrent workers each grab a distinct row without blocking each other.
  async claimNext(workerId) {
    const pool = this.poolFacade.getPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const sel = await client.query(
        `SELECT id FROM vosj.orders WHERE status = 'pending'
         ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1`);
      if (sel.rows.length === 0) { await client.query('COMMIT'); return null; }
      const r = await client.query(
        `UPDATE vosj.orders SET status='claimed', claimed_by=$2, claimed_at=now(), updated_at=now()
         WHERE id = $1 RETURNING *`,
        [sel.rows[0].id, workerId || null]);
      await client.query('COMMIT');
      return r.rows[0];
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) { /* already aborted */ }
      throw e;
    } finally {
      client.release();
    }
  }

  async markDone(id) { return this._finish(id, STATUS.DONE); }
  async markFailed(id) { return this._finish(id, STATUS.FAILED); }

  async _finish(id, status) {
    const r = await this.poolFacade.query(
      `UPDATE vosj.orders SET status=$2, updated_at=now() WHERE id = $1 RETURNING *`,
      [id, status]);
    return r.rows[0] || null;
  }

  async stats() {
    const r = await this.poolFacade.query(
      `SELECT status, count(*)::int AS n FROM vosj.orders GROUP BY status`);
    return tally(r.rows.map((row) => [row.status, row.n]));
  }
}

// ---------------------------------------------------------------------------
// In-memory queue (single-process fallback)
// ---------------------------------------------------------------------------
class MemoryOrderQueue {
  constructor() {
    this.kind = 'memory';
    this._orders = new Map();
  }

  async enqueue(order) {
    const o = normaliseOrder(order);
    const now = new Date().toISOString();
    const row = {
      id: o.id, kind: o.kind, payload: o.payload, status: STATUS.PENDING,
      claimed_by: null, claimed_at: null, created_at: now, updated_at: now,
    };
    this._orders.set(row.id, row);
    return row;
  }

  // Single-threaded JS: reading-then-updating the first pending row is already atomic.
  async claimNext(workerId) {
    const pending = [...this._orders.values()]
      .filter((o) => o.status === STATUS.PENDING)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
    const row = pending[0];
    if (!row) return null;
    row.status = STATUS.CLAIMED;
    row.claimed_by = workerId || null;
    row.claimed_at = new Date().toISOString();
    row.updated_at = row.claimed_at;
    return Object.assign({}, row);
  }

  async markDone(id) { return this._finish(id, STATUS.DONE); }
  async markFailed(id) { return this._finish(id, STATUS.FAILED); }

  async _finish(id, status) {
    const row = this._orders.get(id);
    if (!row) return null;
    row.status = status;
    row.updated_at = new Date().toISOString();
    return Object.assign({}, row);
  }

  async stats() {
    const out = {};
    for (const o of this._orders.values()) out[o.status] = (out[o.status] || 0) + 1;
    return out;
  }
}

function tally(pairs) {
  const out = {};
  for (const [k, n] of pairs) out[k] = n;
  return out;
}

module.exports = { createQueue, PgOrderQueue, MemoryOrderQueue, STATUS };
