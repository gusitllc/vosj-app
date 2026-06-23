// src/vault/vault.js — fail-closed encrypted credential vault (§15.2/§15.3/§15.5).
// Migration requires custody of powerful credentials; VOSJ stores them in an
// encrypted vault using AUTHENTICATED encryption (AES-256-GCM). The master key is
// supplied OPERATIONALLY (VOSJ_VAULT_MASTER_KEY) and is never persisted.
//
// FAIL-CLOSED (Invariant 5, mirrors ledger.js L34-41): without a master key, every
// vault operation throws — it NEVER falls back to a default/insecure key. This is
// the same posture as the tamper-evident ledger: a missing secret is detected at
// use-time and refused, never silently substituted.
//
// SECRET INDIRECTION (§9.3/§15.5): callers store and resolve credentials by an
// opaque reference. Only ciphertext+iv+authTag are persisted — plaintext is NEVER
// written to the store, returned into config, or logged. resolveRef() is the
// connect-time resolver; it returns the secret to the in-process caller only and
// never leaks it into configuration or the audit trail.

'use strict';

const crypto = require('node:crypto');

const ALG = 'aes-256-gcm';
const IV_BYTES = 12;        // 96-bit nonce — the recommended IV size for GCM.
const KEY_BYTES = 32;       // AES-256 => 32-byte derived key.
const AUTH_TAG_BYTES = 16;  // 128-bit GCM authentication tag.

// Deterministic salt for the KDF. The master key is the secret; the salt makes the
// derived key domain-specific to the vault. It is NOT a secret and is fixed so the
// same master key always derives the same encryption key (decrypt must reproduce it).
const KDF_SALT = Buffer.from('vosj.vault.v1.kdf-salt', 'utf8');

// Derive a 32-byte AES key from an arbitrary-length master key via scrypt, so any
// operator-supplied key length works and a short key is strengthened by the KDF.
function kdf(masterKey) {
  return crypto.scryptSync(Buffer.from(String(masterKey), 'utf8'), KDF_SALT, KEY_BYTES);
}

class Vault {
  // store: optional StateStore-like with putCredential/getCredential. When omitted,
  // the vault keeps an in-memory mirror (same fallback shape as the ledger).
  // config: must expose VAULT_MASTER_KEY.
  constructor({ store = null, config }) {
    if (!config) throw new Error('Vault requires config');
    this.store = store;
    this.config = config;
    this._mem = new Map(); // in-memory record sink keyed by ref (ciphertext only)
  }

  // Fail-closed (Invariant 5): no master key => cannot encrypt/decrypt, refuse.
  _key() {
    const master = this.config.VAULT_MASTER_KEY;
    if (!master) {
      throw new Error('vault fail-closed: VOSJ_VAULT_MASTER_KEY is not set');
    }
    return kdf(master);
  }

  // encrypt(plaintext) -> { ciphertext, iv, authTag, alg }. A fresh random 12-byte
  // IV per call means identical plaintexts produce different ciphertexts.
  encrypt(plaintext) {
    if (plaintext === undefined || plaintext === null) {
      throw new Error('vault encrypt rejected: plaintext required');
    }
    const key = this._key();
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv(ALG, key, iv);
    const enc = Buffer.concat([
      cipher.update(Buffer.from(String(plaintext), 'utf8')),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();
    return {
      alg: ALG,
      ciphertext: enc.toString('base64'),
      iv: iv.toString('base64'),
      authTag: authTag.toString('base64'),
    };
  }

  // decrypt(record) -> plaintext string. The GCM auth tag is VERIFIED: any tamper to
  // ciphertext, iv, or authTag makes cipher.final() throw (rejected, never returned).
  decrypt(record) {
    if (!record || !record.ciphertext || !record.iv || !record.authTag) {
      throw new Error('vault decrypt rejected: ciphertext, iv and authTag required');
    }
    if (record.alg && record.alg !== ALG) {
      throw new Error(`vault decrypt rejected: unsupported alg '${record.alg}'`);
    }
    const key = this._key();
    const iv = Buffer.from(record.iv, 'base64');
    const authTag = Buffer.from(record.authTag, 'base64');
    if (authTag.length !== AUTH_TAG_BYTES) {
      throw new Error('vault decrypt rejected: malformed authentication tag');
    }
    const decipher = crypto.createDecipheriv(ALG, key, iv);
    decipher.setAuthTag(authTag);
    // decipher.final() throws 'Unsupported state or unable to authenticate data'
    // when the tag does not match — authenticated-encryption guarantee.
    const dec = Buffer.concat([
      decipher.update(Buffer.from(record.ciphertext, 'base64')),
      decipher.final(),
    ]);
    return dec.toString('utf8');
  }

  // putCredential(ref, plaintext, meta) -> stored record metadata (NO plaintext).
  // Stores only ciphertext+iv+authTag. Storing an existing ref re-encrypts (rotation)
  // and stamps rotated_at; a fresh secret + fresh IV on every write.
  async putCredential(ref, plaintext, meta = {}) {
    if (!ref || typeof ref !== 'string') {
      throw new Error('vault putCredential rejected: a string ref is required');
    }
    const enc = this.encrypt(plaintext); // fail-closed key check happens here
    const existing = await this._load(ref);
    const now = new Date().toISOString();
    const record = {
      ref,
      alg: enc.alg,
      ciphertext: enc.ciphertext,
      iv: enc.iv,
      authTag: enc.authTag,
      meta: meta || {},
      created_at: (existing && existing.created_at) || now,
      rotated_at: existing ? now : null,
    };
    if (this.store && typeof this.store.putCredential === 'function') {
      await this.store.putCredential(record);
    }
    this._mem.set(ref, record);
    // Return metadata ONLY — never the plaintext, never the ciphertext material.
    return { ok: true, ref, alg: record.alg, rotated: Boolean(existing),
      created_at: record.created_at, rotated_at: record.rotated_at };
  }

  // getCredential(ref) -> plaintext string, or null if the ref is unknown.
  // This is the explicit "I want the secret" accessor (decrypts on the way out).
  // FAIL-CLOSED: the key is checked FIRST, so a keyless vault throws rather than
  // reporting "not found" (a missing key must never look like a clean miss).
  async getCredential(ref) {
    this._key(); // throws fail-closed when VOSJ_VAULT_MASTER_KEY is absent
    const record = await this._load(ref);
    if (!record) return null;
    return this.decrypt(record);
  }

  // resolveRef(ref) -> { ok, ref, value } where value is the resolved secret for the
  // in-process caller (connect-time resolution, §9.3). Fails closed when the ref is
  // unknown. The secret is returned to the caller ONLY; it is never written back into
  // config and must never be logged. On any unknown ref -> { ok:false, error }.
  async resolveRef(ref) {
    if (!ref || typeof ref !== 'string') {
      return { ok: false, error: 'vault resolveRef rejected: a string ref is required' };
    }
    const value = await this.getCredential(ref); // fail-closed key check inside
    if (value === null) {
      return { ok: false, error: `vault: no credential for ref '${ref}'` };
    }
    return { ok: true, ref, value };
  }

  // hasCredential(ref) -> boolean. A presence probe that does NOT decrypt or leak.
  async hasCredential(ref) {
    return Boolean(await this._load(ref));
  }

  // _load(ref) -> stored record (ciphertext only) from the store, else the in-memory
  // mirror. Never decrypts.
  async _load(ref) {
    if (this.store && typeof this.store.getCredential === 'function') {
      const r = await this.store.getCredential(ref);
      if (r) return r;
    }
    return this._mem.get(ref) || null;
  }

  // Lightweight health probe for /health — does not throw on a missing key.
  healthy() {
    return Boolean(this.config.VAULT_MASTER_KEY);
  }
}

module.exports = { Vault, kdf, ALG };
