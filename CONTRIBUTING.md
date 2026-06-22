# Contributing to Vosj — Community Edition

Thank you for helping turn migration into an engineering discipline. **Connectors and
Executors are the heart of this project** — a Connector teaches Vosj how to move one
kind of workload between one source/target pair, and proves the result is equivalent.
This guide focuses on writing one.

Vosj CE is **MIT-licensed** (© 2026 Gus IT LLC). By contributing you agree your
contribution is licensed under the same MIT terms.

---

## Code of conduct

Be kind, be precise, assume good faith. Migration is risky work; reviews are about the
code and the invariants, never the person.

---

## Dev setup

Requires **Node.js >= 20** (the engine uses `node:test` and core built-ins only).

```bash
git clone https://github.com/gusitllc/vosj-app.git
cd vosj-app
npm ci            # install (express + pg + dotenv; nothing else)
npm test          # run the node:test suites — must be green before you start
npm run dev       # run the server with --watch (memory store, demo connector)
```

With no database configured the engine runs fully in-memory (`VOSJ_STATE_STORE=memory`)
with the **demo connector** registered, so the engine, REST API, MCP, and UI all work
out of the box for evaluation. Copy `.env.example` to `.env` to configure secrets,
auth, and PostgreSQL.

---

## House rules (non-negotiable)

These are enforced in review and mirror the style of the existing code:

- **CommonJS** only (`require` / `module.exports`), `'use strict';` at the top.
- **No new dependencies.** The allowed runtime deps are `express`, `pg`, and
  `dotenv`; everything else must be Node.js built-ins (`crypto`, `path`, …). A PR that
  adds a dependency will be declined — extend with built-ins instead.
- **Small units.** Files **< 300 lines**, functions **< 30 lines**, **<= 3** levels of
  indentation. Split when you exceed these.
- **Parameterised SQL only** (`$1`, `$2`, …). Never build SQL with string
  concatenation or interpolation.
- **Result envelopes.** Return `{ ok: true, ...data }` on success and
  `{ ok: false, error: 'message' }` on failure. Methods that throw should throw `Error`
  objects with clear messages, not strings.
- **Escape HTML.** Any user-supplied value rendered into a page must go through the
  `esc()` helper (XSS). Never inline raw input into markup.
- **Fail-closed on missing secrets.** Never substitute a default for a missing secret
  (ledger HMAC key, vault master key). Absence must cause a loud failure, not a silent
  weak default. See `src/config.js`.
- **Run `node --check`** on every `.js` file you add or edit before opening a PR.

Run the full suite (`npm test`) before pushing. CI runs the same on Node 20.

---

## The plugin model

Vosj is organised around five plugin contracts in
[`src/contracts/index.js`](src/contracts/index.js). The two you will most often
implement are the **Connector** and the **Executor**. Each base method is `async` and
throws `not implemented`, so a partial plugin fails loudly rather than silently.

| Contract | Responsibility |
|----------|----------------|
| `Connector` | Move one migration unit for a source/target pair, and **prove** equivalence. |
| `Executor` | Run a single runbook step (the conductor steps the runbook). |
| `GateSigner` | Apply a human sign-off to a gate (human-only, separation of duties). |
| `AssessmentProvider` | Produce a readiness/risk score for a target (Vault station). |
| `StateStore` | Persistence (PostgreSQL by default; in-memory for eval). |

---

## Writing a Connector (step by step)

A `Connector` is a point-to-point migration executor for one source → target pair. The
**reference implementation is [`src/connectors/demo.js`](src/connectors/demo.js)** — read
it first; copy its shape. It simulates a migration entirely in memory and returns a
**genuine** `verify()` proof, so the verified-before-Jump gate can clear without a real
cloud.

### 1. Extend the base class

```js
'use strict';

const crypto = require('crypto');
const { Connector } = require('../contracts');

class MyConnector extends Connector {
  constructor(meta = {}) {
    super(Object.assign({ id: 'my-connector' }, meta));
    // initialise your client / simulated state here
  }
  // ... implement the contract methods below ...
}

module.exports = { MyConnector };
```

### 2. Implement the contract methods

All methods are `async(unit, ctx)` (except `discover(ctx)`). `unit` is the migration
unit (`{ id, name, kind, rowCount, baselineAt, ... }`); `ctx` carries `{ config, ... }`.

| Method | Returns | Notes |
|--------|---------|-------|
| `discover(ctx)` | `{ ok, units: [...] }` | Inventory of migratable units at the source. |
| `replicate(unit, ctx)` | `{ ok, unitId, replicated }` | Stand up the target / copy data. |
| **`verify(unit, ctx)`** | **`{ ok, proof, categories }`** | **MANDATORY** — see below. |
| `cutover(unit, ctx)` | `{ ok, unitId, cutOver }` | Final switch. Refuse if not replicated. |
| `rollback(unit, ctx)` | `{ ok, unitId, rolledBack }` | Revoke the cutover. |

### 3. The mandatory `verify()` — equivalence proof

**A cutover cannot be proven — and therefore cannot happen — without a genuine
`verify()`.** This is the whole point of Vosj (Invariant 6, *Verified-before-Jump*). A
`verify()` that always returns `ok: true` is not acceptable and will be rejected in
review; it must actually compare the target against the source.

`verify(unit, ctx)` must return:

```js
{
  ok: <boolean>,                  // true only if every category genuinely passed
  proof: { categories: [...], hash: <sha256 hex> },
  categories: [ { name, ok, detail }, ... ]
}
```

It must report **the six pre-switch categories** the reconciliation engine hard-gates on
(see `PRE_SWITCH_CATEGORIES` in [`src/engine/reconcile.js`](src/engine/reconcile.js)):

| Category | Proves |
|----------|--------|
| `replication_lag` | No rows are still in flight. |
| `row_counts` | Source and target row counts match. |
| `checksums` | Content hashes match. |
| `sequence_identity` | Identity/sequence continuity is preserved. |
| `constraints` | Keys / FKs / checks re-validate on the target. |
| `smoke` | Critical user journeys pass on the target. |

The engine **fails closed**: any of the six that is missing or not `ok` blocks the
cutover, even if you set `ok: true`. Build each category with a real check and hash the
proof body:

```js
async verify(unit, ctx) {
  const categories = [
    cat('replication_lag', lag === 0, `in-flight rows: ${lag}`),
    cat('row_counts', src === tgt, `source=${src} target=${tgt}`),
    cat('checksums', checksumsMatch, 'content hashes match'),
    cat('sequence_identity', sequencesOk, 'identity/sequence continuity verified'),
    cat('constraints', constraintsOk, 'keys/FKs/checks re-validated'),
    cat('smoke', smokeOk, 'critical user journeys pass'),
  ];
  const ok = categories.every((c) => c.ok);
  const proof = { categories, hash: hashOf({ unitId: unit.id, categories }) };
  return { ok, proof, categories };
}

function cat(name, ok, detail) { return { name, ok: Boolean(ok), detail }; }
function hashOf(obj) {
  return crypto.createHash('sha256').update(JSON.stringify(obj), 'utf8').digest('hex');
}
```

You may report **extra** categories (e.g. post-cutover performance/plan parity); the
engine carries them through as informational and does not pre-switch-block on them.

### 4. Register the connector

Connectors are registered into the `connectors` Map on the shared `ctx` in
[`src/server.js`](src/server.js):

```js
const { MyConnector } = require('./connectors/my-connector');
// ...
connectors.set('my-connector', new MyConnector());
```

The REST API and MCP resolve a connector by this key (see `connectorFor()` in
`src/api/routes.js`). Use a short, stable, lowercase id.

---

## Writing an Executor

An `Executor` runs a single runbook step — the conductor steps the runbook and calls
`run(step, ctx)` for each.

```js
'use strict';

const { Executor } = require('../contracts');

class MyExecutor extends Executor {
  async run(step, ctx) {
    // do the step's work; return an envelope
    return { ok: true, step: step.id };
  }
}

module.exports = { MyExecutor };
```

Return `{ ok: true, ... }` on success or `{ ok: false, error }` on failure so the
conductor can record the outcome and the ledger can capture it.

---

## Every Connector PR must include a test

**A Connector (or Executor) PR without a test will not be merged.** Tests use the
built-in `node:test` runner — no test framework dependency. Add a file under `test/`
named `<connector>.test.js`. The clearest model is
[`test/reconcile.test.js`](test/reconcile.test.js), which drives the demo connector's
`verify()`.

A connector test must cover, at minimum:

1. **A passing case** — after `replicate()`, `verify()` returns `ok: true` and reports
   all six pre-switch categories as `ok`.
2. **At least one broken case** — a deliberate defect (e.g. a row-count mismatch, lag,
   or skipping `replicate()`) makes the relevant category — and `verify().ok` — `false`.

```js
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { MyConnector } = require('../src/connectors/my-connector');
const { PRE_SWITCH_CATEGORIES } = require('../src/engine/reconcile');

test('verify() reports the six pre-switch categories after replication', async () => {
  const conn = new MyConnector();
  const unit = { id: 'u1', rowCount: 1000, baselineAt: new Date().toISOString() };
  await conn.replicate(unit, {});
  const v = await conn.verify(unit, {});
  assert.equal(v.ok, true);
  const names = v.categories.map((c) => c.name).sort();
  assert.deepEqual(names, [...PRE_SWITCH_CATEGORIES].sort());
});

test('verify() fails closed on a deliberate defect', async () => {
  const conn = new MyConnector();
  const unit = { id: 'u1', rowCount: 1000, baselineAt: new Date().toISOString() };
  // induce drift, then assert verify().ok === false
  const v = await conn.verify(unit, {});
  assert.equal(v.ok, false);
});
```

Run `npm test` and confirm everything (your new test and the existing suites) is green.

---

## Pull-request workflow

1. **Branch** from `main`.
2. **Keep it small.** One connector / one concern per PR. Stay within the house rules.
3. **`node --check`** every changed `.js` file; run `npm test` — all green.
4. **Include a test** (mandatory for connectors/executors) with a passing and a broken
   case.
5. **Conventional commit titles** — `feat(connector): add my-connector`,
   `fix(reconcile): ...`, `docs: ...`, etc.
6. **Fill in the PR template** checklist (tests pass, `verify()` implemented, no new
   deps, invariants respected).
7. **Do not weaken an invariant.** Verified-before-Jump, no-agent-self-sign, separation
   of duties, the tamper-evident ledger, Strangler-Fig-for-high-risk, and the
   baseline-drift guard are not waivable. A PR that bypasses one will be declined.

CI (`.github/workflows/ci.yml`) runs `npm ci` and `npm test` on Node 20 for every push
and pull request; both must pass.

Thank you for contributing — and welcome aboard the voyage.
