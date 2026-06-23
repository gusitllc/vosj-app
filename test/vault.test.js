// test/vault.test.js — fail-closed encrypted credential vault (§15.2/§15.5) plus
// the material-defect cover for the §7 disposition guarantee.
//
// Vault asserts:
//   - round-trip encrypt/decrypt under a master key;
//   - FAIL-CLOSED: a missing VOSJ_VAULT_MASTER_KEY throws (never a default key);
//   - a tampered authTag (or ciphertext/iv) is REJECTED on decrypt (authenticated
//     encryption — the GCM tag is verified);
//   - resolveRef / getCredential never return plaintext for an unknown ref, and the
//     store persists ONLY ciphertext (no plaintext leaks into the record);
//   - ciphertext differs across calls for identical plaintext (random IV);
//   - rotation re-encrypts the same ref and stamps rotated_at.
//
// Material-defect cover (§7 structural guarantee):
//   - a high-risk disposition (Refactor/Replatform/Relocate) is FORCED onto
//     Strangler-Fig — big-bang is structurally unavailable;
//   - the P2 kickoff gate (the "Jump" toward cutover) is BLOCKED when the
//     disposition rule is violated (a workload lacks a valid 7-R disposition).

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { Vault } = require('../src/vault/vault');
const disposition = require('../src/engine/disposition');
const { Ledger } = require('../src/ledger/ledger');
const { MemoryStateStore } = require('../src/db/statestore');
const { buildEngine } = require('../src/engine');

const MASTER = 'test-vault-master-key-0123456789';

function vaultWith({ store = null, key = MASTER } = {}) {
  const config = Object.freeze({ VAULT_MASTER_KEY: key, version: 'test' });
  return new Vault({ store, config });
}

// ---- encryption primitives --------------------------------------------------

test('round-trips plaintext through encrypt -> decrypt', () => {
  const v = vaultWith();
  const secret = 'super-secret-pg-password!@#$';
  const rec = v.encrypt(secret);
  assert.equal(rec.alg, 'aes-256-gcm');
  assert.ok(rec.ciphertext && rec.iv && rec.authTag, 'record carries ciphertext+iv+authTag');
  assert.notEqual(rec.ciphertext, secret, 'ciphertext is not the plaintext');
  assert.equal(v.decrypt(rec), secret);
});

test('ciphertext differs across calls for identical plaintext (random IV)', () => {
  const v = vaultWith();
  const a = v.encrypt('same-input');
  const b = v.encrypt('same-input');
  assert.notEqual(a.iv, b.iv, 'each encrypt uses a fresh random IV');
  assert.notEqual(a.ciphertext, b.ciphertext, 'identical plaintext -> different ciphertext');
  // Both still decrypt back to the same plaintext.
  assert.equal(v.decrypt(a), 'same-input');
  assert.equal(v.decrypt(b), 'same-input');
});

test('a long, arbitrary-length master key works via the KDF', () => {
  const v = vaultWith({ key: 'x'.repeat(7) });   // short
  const w = vaultWith({ key: 'y'.repeat(4096) }); // very long
  assert.equal(v.decrypt(v.encrypt('a')), 'a');
  assert.equal(w.decrypt(w.encrypt('b')), 'b');
});

// ---- FAIL-CLOSED (Invariant 5) ----------------------------------------------

test('encrypt fails closed when the master key is missing', () => {
  const v = vaultWith({ key: '' });
  assert.throws(() => v.encrypt('x'), /vault fail-closed: VOSJ_VAULT_MASTER_KEY is not set/);
});

test('decrypt fails closed when the master key is missing', () => {
  const enc = vaultWith().encrypt('x');
  const v = vaultWith({ key: '' });
  assert.throws(() => v.decrypt(enc), /vault fail-closed: VOSJ_VAULT_MASTER_KEY is not set/);
});

test('putCredential / resolveRef fail closed without a master key', async () => {
  const v = vaultWith({ key: '' });
  await assert.rejects(() => v.putCredential('db/pw', 'secret'), /vault fail-closed/);
  await assert.rejects(() => v.resolveRef('db/pw'), /vault fail-closed/);
});

test('the vault NEVER substitutes a default key', () => {
  // A vault with no key cannot decrypt material written by a real key — there is no
  // implicit/default key that would let it succeed.
  const real = vaultWith({ key: 'the-real-key' });
  const rec = real.encrypt('data');
  const keyless = vaultWith({ key: '' });
  assert.throws(() => keyless.decrypt(rec), /vault fail-closed/);
});

// ---- authenticated encryption: tamper rejection -----------------------------

test('a tampered authTag is rejected on decrypt', () => {
  const v = vaultWith();
  const rec = v.encrypt('integrity-protected');
  const tagBuf = Buffer.from(rec.authTag, 'base64');
  tagBuf[0] = tagBuf[0] ^ 0xff; // flip a bit in the GCM tag
  const tampered = Object.assign({}, rec, { authTag: tagBuf.toString('base64') });
  assert.throws(() => v.decrypt(tampered)); // GCM auth failure -> throws, no plaintext
});

test('a tampered ciphertext is rejected on decrypt', () => {
  const v = vaultWith();
  const rec = v.encrypt('integrity-protected');
  const ctBuf = Buffer.from(rec.ciphertext, 'base64');
  ctBuf[0] = ctBuf[0] ^ 0xff;
  const tampered = Object.assign({}, rec, { ciphertext: ctBuf.toString('base64') });
  assert.throws(() => v.decrypt(tampered));
});

test('a wrong master key cannot authenticate another key\'s ciphertext', () => {
  const a = vaultWith({ key: 'key-a' });
  const rec = a.encrypt('secret');
  const b = vaultWith({ key: 'key-b' });
  assert.throws(() => b.decrypt(rec)); // tag verification fails under the wrong key
});

// ---- secret indirection (§9.3/§15.5): store + resolve by ref ----------------

test('putCredential stores ONLY ciphertext — never plaintext', async () => {
  const store = new MemoryStateStore();
  await store.init();
  const v = vaultWith({ store });
  const secret = 'pg://user:p@ss@host/db';
  const meta = await v.putCredential('connector/azure-arc/pg', secret, { kind: 'pg' });

  // The returned metadata never carries the secret.
  assert.equal(meta.ok, true);
  assert.ok(!('value' in meta) && !('plaintext' in meta), 'metadata exposes no secret');
  assert.ok(!JSON.stringify(meta).includes('p@ss'), 'metadata does not leak the secret');

  // The persisted record carries ciphertext+iv+authTag, NOT the plaintext.
  const record = await store.getCredential('connector/azure-arc/pg');
  assert.ok(record, 'a record was persisted');
  assert.ok(record.ciphertext && record.iv && record.authTag);
  const blob = JSON.stringify(record);
  assert.ok(!blob.includes(secret), 'stored record does not contain the plaintext secret');
  assert.ok(!blob.includes('p@ss'), 'stored record does not contain any plaintext fragment');
});

test('getCredential round-trips the secret through the store', async () => {
  const store = new MemoryStateStore();
  await store.init();
  const v = vaultWith({ store });
  await v.putCredential('db/admin', 'admin-pw');
  assert.equal(await v.getCredential('db/admin'), 'admin-pw');
});

test('resolveRef returns the secret only to the caller for a known ref', async () => {
  const v = vaultWith();
  await v.putCredential('svc/token', 'opaque-bearer-token');
  const r = await v.resolveRef('svc/token');
  assert.equal(r.ok, true);
  assert.equal(r.ref, 'svc/token');
  assert.equal(r.value, 'opaque-bearer-token');
});

test('resolveRef NEVER returns plaintext for an unknown ref (fail-closed)', async () => {
  const v = vaultWith();
  const r = await v.resolveRef('does/not/exist');
  assert.equal(r.ok, false);
  assert.ok(/no credential for ref/.test(r.error));
  assert.ok(!('value' in r), 'no value field is present on a miss');
});

test('getCredential returns null (never a default) for an unknown ref', async () => {
  const v = vaultWith();
  assert.equal(await v.getCredential('nope'), null);
  assert.equal(await v.hasCredential('nope'), false);
});

test('rotation re-encrypts the same ref and stamps rotated_at', async () => {
  const store = new MemoryStateStore();
  await store.init();
  const v = vaultWith({ store });
  const first = await v.putCredential('rotate/me', 'v1');
  assert.equal(first.rotated, false);
  assert.equal(first.rotated_at, null);

  const before = await store.getCredential('rotate/me');
  const second = await v.putCredential('rotate/me', 'v2');
  assert.equal(second.rotated, true);
  assert.ok(second.rotated_at, 'rotation stamps rotated_at');
  assert.equal(second.created_at, first.created_at, 'created_at is preserved across rotation');

  const after = await store.getCredential('rotate/me');
  assert.notEqual(after.ciphertext, before.ciphertext, 'rotation produces fresh ciphertext');
  assert.equal(await v.getCredential('rotate/me'), 'v2', 'resolves to the rotated value');
});

test('putCredential rejects a non-string ref', async () => {
  const v = vaultWith();
  await assert.rejects(() => v.putCredential(null, 'x'), /a string ref is required/);
});

test('healthy() reflects key presence without throwing', () => {
  assert.equal(vaultWith().healthy(), true);
  assert.equal(vaultWith({ key: '' }).healthy(), false);
});

// ---- material-defect cover: §7 disposition structural guarantee -------------

test('material: high-risk dispositions are FORCED onto Strangler-Fig (no big-bang)', () => {
  for (const key of ['Refactor', 'Replatform', 'Relocate']) {
    const c = disposition.classify({ disposition: key });
    assert.equal(c.contract.highRisk, true, `${key} is high-risk`);
    assert.equal(c.strangler, true, `${key} must be Strangler-Fig`);
    assert.equal(c.bigBangAvailable, false, `${key} must NOT allow a big-bang plan`);
    assert.equal(c.contract.cutoverStyle, disposition.CUTOVER.STRANGLER_FIG);
  }
});

test('material: the kickoff gate (Jump toward cutover) is BLOCKED when the disposition rule is violated', async () => {
  const store = new MemoryStateStore();
  await store.init();
  const config = Object.freeze({ LEDGER_HMAC_KEY: 'test-key', version: 'test' });
  const ledger = new Ledger({ store, config });
  const engine = buildEngine({ config, store, ledger });
  const machine = engine.machineFor('caf');
  const run = { id: 'wave-mat', state: 'P2' }; // at the kickoff gate (P2 -> P3)
  const itLead = { id: 'ian-itlead', kind: 'human', role: 'it-lead' };

  // Disposition rule VIOLATED: an in-scope workload carries no valid 7-R disposition.
  await store.saveWorkload({ id: 'w1', name: 'App', wave_id: 'wave-mat', disposition: null });
  await assert.rejects(
    () => machine.signTransition({ run, to: 'P3', actor: 'author-1', signer: itLead }),
    /machine-checkable criteria not satisfied/,
    'a missing disposition must BLOCK the gate'
  );

  // An INVALID disposition string is equally blocked (fail-closed, not best-effort).
  await store.saveWorkload({ id: 'w1', name: 'App', wave_id: 'wave-mat', disposition: 'NotAReal-R' });
  await assert.rejects(
    () => machine.signTransition({ run, to: 'P3', actor: 'author-1', signer: itLead }),
    /machine-checkable criteria not satisfied/
  );

  // Rule SATISFIED: a valid high-risk disposition lets the (independently-signed) gate pass.
  await store.saveWorkload({ id: 'w1', name: 'App', wave_id: 'wave-mat', disposition: 'Refactor' });
  const ok = await machine.signTransition({ run, to: 'P3', actor: 'author-1', signer: itLead });
  assert.equal(ok.state, 'P3', 'a valid disposition allows the gate to fire');
  assert.ok(ok.ledger && ok.ledger.hash, 'the passing gate writes a signed ledger row');
});
