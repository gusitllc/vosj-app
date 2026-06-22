// src/ledger/ledger.js — tamper-evident, hash-chained audit ledger (§12.2/§14.4).
// Each row carries an HMAC-SHA256 over (prevHash + canonical(entry)) using the
// externally-custodied signing key. FAIL-CLOSED: without a key, append() throws —
// it NEVER falls back to a default key. verifyChain() detects any forge/back-date.

'use strict';

const crypto = require('crypto');

const GENESIS = '0'.repeat(64);

// Deterministic canonical JSON (sorted keys) so the HMAC is reproducible.
function canonical(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(canonical).join(',') + ']';
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(obj[k])).join(',') + '}';
}

function hmac(key, payload) {
  return crypto.createHmac('sha256', key).update(payload, 'utf8').digest('hex');
}

class Ledger {
  // store: StateStore-like with appendLedger/listLedger/lastLedger (optional — pure
  // in-memory if omitted). config: must expose LEDGER_HMAC_KEY.
  constructor({ store = null, config }) {
    if (!config) throw new Error('Ledger requires config');
    this.store = store;
    this.config = config;
    this._mem = []; // in-memory mirror / fallback sink
  }

  _key() {
    const key = this.config.LEDGER_HMAC_KEY;
    if (!key) {
      // Fail-closed (Invariant 5): no key => cannot sign, refuse to proceed.
      throw new Error('ledger fail-closed: VOSJ_LEDGER_HMAC_KEY is not set');
    }
    return key;
  }

  async _prevHash() {
    if (this.store && typeof this.store.lastLedger === 'function') {
      const last = await this.store.lastLedger();
      if (last && last.hash) return last.hash;
    }
    const tail = this._mem[this._mem.length - 1];
    return tail ? tail.hash : GENESIS;
  }

  // append({ actor, signerRole, action, evidenceHashes, ...meta }) -> signed row.
  async append(entry) {
    const key = this._key();
    const prevHash = await this._prevHash();
    const seq = this._mem.length + 1;
    const base = {
      seq,
      ts: entry.ts || new Date().toISOString(),
      actor: entry.actor || null,
      signerRole: entry.signerRole || null,
      action: entry.action || 'unknown',
      evidenceHashes: Array.isArray(entry.evidenceHashes) ? entry.evidenceHashes : [],
      meta: entry.meta || {},
      prevHash,
    };
    const hash = hmac(key, prevHash + canonical(base));
    const row = Object.assign({}, base, { hash });
    this._mem.push(row);
    if (this.store && typeof this.store.appendLedger === 'function') {
      await this.store.appendLedger(row);
    }
    return row;
  }

  // verifyChain(rows?) -> { ok, brokenAt }. brokenAt = seq of first bad row, or null.
  async verifyChain(rows) {
    const key = this._key();
    let chain = rows;
    if (!chain) {
      chain = (this.store && typeof this.store.listLedger === 'function')
        ? await this.store.listLedger({})
        : this._mem;
    }
    let prevHash = GENESIS;
    for (const row of chain) {
      if (row.prevHash !== prevHash) return { ok: false, brokenAt: row.seq };
      const { hash, ...base } = row;
      const expect = hmac(key, prevHash + canonical(base));
      if (expect !== hash) return { ok: false, brokenAt: row.seq };
      prevHash = hash;
    }
    return { ok: true, brokenAt: null };
  }

  async list(filter = {}) {
    if (this.store && typeof this.store.listLedger === 'function') {
      return this.store.listLedger(filter);
    }
    return this._mem.slice();
  }

  // Lightweight health probe for /health — does not throw on missing key.
  async healthy() {
    if (!this.config.LEDGER_HMAC_KEY) return false;
    try {
      const r = await this.verifyChain();
      return r.ok;
    } catch (_) {
      return false;
    }
  }
}

module.exports = { Ledger, canonical, hmac, GENESIS };
