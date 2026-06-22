# 05 · Writing a Connector

> **Audience.** An operator or engineer adding support for a new migration
> source/target pair to Vosj Community Edition (CE). You should already be
> comfortable running Vosj (see
> [01 · Getting Started](./01-getting-started.md)) and understand the four
> stations and the verified-before-Jump gate (see
> [03 · Running a Migration](./03-running-a-migration.md) and
> [04 · The Verification Gate](./04-the-verification-gate.md)).
>
> **What you'll build.** A `Connector` — a point-to-point migration executor for
> one source→target pair — that the engine resolves by id and drives through the
> four stations (Vault → Orchestrate → Shift → Jump). The whole point of the
> plugin boundary is that *adding or swapping a provider is a config + connector
> task, not a redesign.*

This guide is grounded in the actual CE source. The files you will read and edit
alongside it are:

| File | What it gives you |
|------|-------------------|
| `src/contracts/index.js` | The bare `Connector` interface (the five methods). |
| `src/connectors/sdk.js` | `BaseConnector`, the SDK helpers, the registry, the six verify categories. |
| `src/connectors/demo.js` | A complete in-memory connector with a genuinely passing proof. |
| `src/connectors/azure-arc.js` | A contract-complete, honest connector that fails closed until its SDK seams are wired. |
| `src/connectors/hyperv.js` | A second honest stub — a useful second pattern (block/image moves). |
| `src/connectors/index.js` | The connector catalog / registry assembly. |
| `src/engine/reconcile.js` | The verification engine that consumes your `verify()` proof. |
| `test/connectors.test.js` | The contract tests every connector must pass — read this as the spec. |

---

## 1. The Connector contract

A connector is a class that implements **five async methods**. The bare contract
lives in `src/contracts/index.js`:

```js
class Connector {
  constructor(meta = {}) {
    this.id = meta.id || this.constructor.name;
    this.meta = meta;
  }
  async discover(ctx) { /* … */ }
  async replicate(unit, ctx) { /* … */ }
  // MANDATORY. Returns { ok, proof:{ categories:[{name,ok,detail}], hash } }.
  async verify(unit, ctx) { /* … */ }
  async cutover(unit, ctx) { /* … */ }
  async rollback(unit, ctx) { /* … */ }
}
```

Every method is `async`. In the base class each one throws
`Connector.<method>() not implemented` — this is deliberate: **a partial plugin
fails loudly rather than passing silently.** The contract test
(`test/connectors.test.js`) asserts that every connector exposes all five
methods, so a connector missing one will not pass CI.

### 1.1 The migration unit

Each method (except `discover`) takes a **unit** — one migration unit (a VM, a
database, an app). The shape Vosj passes in is normalised from the stored
workload (`unitFromWorkload()` in `src/api/routes.js`); the fields a connector
can rely on are:

| Field | Meaning |
|-------|---------|
| `id` | Stable unit id (e.g. `arc-sql01`). Used for executor + session bookkeeping. |
| `name` | Human-readable name. |
| `kind` | `'vm'`, `'database'`, `'app'`, … — lets a connector branch behaviour. |
| `baselineAt` | ISO timestamp of the last baseline. Read by the reconcile engine for freshness (see §6). |
| `rowCount` / `attributes` | Optional provider-specific hints carried from the workload. |

### 1.2 The execution context (`ctx`)

The second argument, `ctx`, is the shared engine context
(`{ config, engine, store, ledger, connectors, log }`). For connector code you
mainly use:

- **`ctx.env`** — the place to read provider configuration from (see §5). In
  tests it is injected directly; in production it falls back to `process.env`.
- **`ctx.config`** — the frozen CE config from `src/config.js` (e.g.
  `baselineMaxAgeMs`).

### 1.3 What each method must do

| Method | Station | Responsibility | Return shape |
|--------|---------|----------------|--------------|
| `discover(ctx)` | Vault | Inventory the source estate; map each item to a migration unit. | `{ ok, units:[…] }` (or `{ ok:false, pending:'sdk', detail, units:[] }` when not wired). |
| `replicate(unit, ctx)` | Shift | Start/seed continuous replication into the target. Open a session; record **only** what is actually measured. | `{ ok, unitId, … }`. |
| `verify(unit, ctx)` | Jump (pre-switch) | **Measure** equivalence across the six categories and return a structured proof. **Mandatory and honest.** | `{ ok, proof:{ categories, hash }, categories }`. |
| `cutover(unit, ctx)` | Jump | Final delta, stop source, commit/repoint the target. | `{ ok, unitId, cutOver:true }`. |
| `rollback(unit, ctx)` | Jump (revoke) | Reverse-protect / fail back to source. | `{ ok, unitId, rolledBack:true }`. |

Use the platform response convention everywhere: `{ ok: true, … }` on success,
`{ ok: false, error: '…' }` on a handled failure.

---

## 2. The MANDATORY `verify()` — and the six reconcile categories

`verify()` is the heart of the connector. The
[verification gate](./04-the-verification-gate.md) is *unreachable* without a
genuine proof, because the reconcile engine (`src/engine/reconcile.js`) binds the
proof hash before any cutover is authorised. There is no override flag, no
`force`, no "skip verify" — **the only path to a passing gate is a real
measurement.**

### 2.1 The six pre-switchover categories

`verify()` must report on exactly these six categories. They are frozen in both
`src/connectors/sdk.js` (`VERIFY_CATEGORIES`) and `src/engine/reconcile.js`
(`PRE_SWITCH_CATEGORIES`):

| # | Category | What it proves before switchover |
|---|----------|----------------------------------|
| 1 | `replication_lag` | In-flight delta is **zero** at the probe — no un-replicated data. |
| 2 | `row_counts` | Source and target object/row (or written-block) counts are equal. |
| 3 | `checksums` | Content/BLOB hashes match between source and replicated target. |
| 4 | `sequence_identity` | Identity/sequence continuity preserved (DB sequences; or VM identity for image moves). |
| 5 | `constraints` | Keys / FKs / checks re-validate on the target (or no in-guest integrity errors on first boot). |
| 6 | `smoke` | Critical user journeys / a service probe pass against the migrated target. |

These six are **hard gates**. Performance and query-plan parity are intentionally
**not** in this list: they are assessed *post*-cutover in the revocable window, so
the reconcile engine treats any extra category your connector volunteers as
informational (`preSwitch: false`), never a pre-switch blocker.

### 2.2 The proof shape

`verify()` returns:

```js
{
  ok,                         // true ONLY if every pre-switch category is ok
  proof: {
    connector,                // your connector id
    unitId,
    categories: [             // one entry per category
      { name, ok, detail },
    ],
    hash,                     // sha256 over the proof body — what the gate binds
  },
  categories,                 // same array, surfaced for convenience
}
```

The reconcile engine recomputes and re-normalises this; the `hash` is what the
human gate signer ultimately approves (see §6).

### 2.3 The fail-closed rule (read this twice)

> **A category may be reported `ok: true` ONLY when a probe has actually
> *measured* equivalence. If the underlying measurement has not run, the category
> is `not verified` — never a fabricated pass.**

This is the single most important rule in the whole connector boundary. The SDK
encodes it for you with two helper results (see §4.2): `verified(detail)` and
`notVerified(reason)`. When you cannot measure a category — because the SDK seam
isn't wired yet, or replication hasn't reached initial sync — you **must** return
`notVerified(...)`. The connector then fails closed: every probe is
not-verified, `verify().ok` is `false`, and the verified-before-Jump gate stays
unreachable until the real measurement exists.

`azure-arc.js` and `hyperv.js` are shipped exactly this way on purpose — they are
contract-complete but their probes read only real replication telemetry, which is
never populated until the SDK seams are implemented. So they **always** fail
closed. `test/connectors.test.js` asserts this and would catch a regression that
made them fabricate a pass:

```js
// from test/connectors.test.js
test(`${name}: verify() fails closed after replicate (SDK seam unwired)`, async () => {
  await conn.replicate(u, { env });
  const v = await conn.verify(u, { env });
  assert.equal(v.ok, false,
    `${name} must NOT report verified while its measurement seam is unwired`);
});
```

---

## 3. Two ways to build: bare `Connector` vs. `BaseConnector`

You can extend either class, but **prefer `BaseConnector`** for any real
provider. The bare `Connector` is for trivial / fully in-memory cases.

### 3.1 The bare `Connector` (the demo pattern)

`src/connectors/demo.js` extends `Connector` directly. It simulates a
source→target migration entirely in memory so the engine, API, and UI all work
out-of-the-box with `VOSJ_STATE_STORE=memory` and **no real cloud**. Because the
demo *actually mirrors* row counts during `replicate()`, its `verify()` returns a
genuine passing proof — it is the only shipped connector that can clear the gate:

```js
// demo.js — replicate() records a real (simulated) measurement…
async replicate(unit, ctx) {
  const st = this._stateFor(unit);
  st.replicated = true;
  st.sourceRows = unit.rowCount || 1000;
  st.targetRows = st.sourceRows;   // a clean replication mirrors row counts
  st.lagRows = 0;
  return { ok: true, unitId: unit.id, replicated: true };
}

// …and verify() reports each category from that recorded state.
const categories = [
  cat('replication_lag', lag === 0, `in-flight rows: ${lag}`),
  cat('row_counts', sourceRows === targetRows, `source=${sourceRows} target=${targetRows}`),
  // …
];
```

Use this pattern only when "the measurement" is something you can compute
locally. For anything that talks to a real cloud or hypervisor, use
`BaseConnector`.

### 3.2 `BaseConnector` (the recommended pattern)

`BaseConnector` (in `src/connectors/sdk.js`) gives you, for free:

1. The **executor state machine** (§16.2) — a per-unit FSM so the conductor can
   step `draft → validated → executing → completed`, plus the rollback path.
2. A **fail-closed config gate** (`requireConfig`) — no silent defaults.
3. A **pre-flight guard** (`validate` / `_preflight`).
4. The **probe-driven `verify()` scaffold** — you supply `_probes()`, the base
   assembles the six-category proof and hashes it, applying the fail-closed rule
   automatically.
5. **Replication-session bookkeeping** (`_sessionFor`) — a place to record only
   what you actually measured.

You implement: `discover`, `replicate`, `cutover`, `rollback`, and `_probes()`.
You do **not** override `verify()` — the base handles it.

---

## 4. The SDK helpers (`src/connectors/sdk.js`)

### 4.1 Executor state machine

`BaseConnector` tracks a per-unit FSM (`EXECUTOR_STATES` /
`EXECUTOR_TRANSITIONS`):

```
draft → validated → executing → completed
   ↑         ↓           ↓           ↓
   └── failed ───────────┴──── rolling_back → rolled_back → draft
```

Methods you call from inside `replicate`/`cutover`/`rollback`:

- `this.executorState(unit)` → the current state.
- `this.canAdvance(unit, to)` → boolean; is the transition legal?
- `this.advance(unit, to)` → perform it, or throw `executor: illegal transition …`.

`validate()` advances `draft → validated` automatically when pre-flight passes,
so a typical `replicate()` calls `await this.validate(...)` then
`this.advance(unit, 'executing')`.

### 4.2 The verify helpers

These three functions are exported from the SDK and used inside your probes:

```js
const { verified, notVerified } = require('./sdk');

verified('replication lag 0s at probe')   // → { ok: true,  detail: '…' }
notVerified('replication lag not measured') // → { ok: false, detail: 'not verified: …' }
```

- `verified(detail)` — an affirmative result from a **real measurement**.
- `notVerified(reason)` — the honest result of a probe whose measurement has not
  run. It **never** returns `ok: true`.
- `category(name, ok, detail)` — builds a normalised category object (you rarely
  call this directly; the scaffold does).
- `sha256(obj)` — the canonical hash used for the proof.

### 4.3 Fail-closed config gating

```js
const cfg = this.requireConfig(ctx, ['AZURE_SUBSCRIPTION_ID', 'AZURE_LOCAL_CLUSTER']);
```

`requireConfig(ctx, keys)` reads from `ctx.env` first (so tests can inject), then
`process.env`. **There are no silent defaults** — any missing/empty key throws a
`MissingConfigError` listing the missing keys, and the caller fails closed. The
contract test asserts that `replicate()` rejects with `MissingConfigError` when
required config is absent:

```js
// from test/connectors.test.js
await assert.rejects(
  () => conn.replicate(unit(), { env: {} }),
  (e) => e instanceof MissingConfigError,
);
```

This implements Golden Rule 5 (everything configurable, nothing hardcoded): a
connector declares its required env keys and refuses to act without them.

### 4.4 The probe set — `_probes(unit, ctx)`

This is the one method that carries your real measurements. It returns a map of
`{ categoryName: async () => result }`. The base scaffold runs every probe in
`VERIFY_CATEGORIES`; a probe that is **missing, returns no result, or throws** is
recorded as `not verified` (fail-closed). The base `_probes()` *throws* — so a
half-built connector fails loudly:

```js
// sdk.js
_probes(_unit, _ctx) {
  throw new Error(`${this.constructor.name}._probes() not implemented`);
}
```

Each probe reads from the **replication session** (`this._sessionFor(unit)`),
which only holds values you measured during `replicate()` / cutover. The
`azure-arc` pattern:

```js
_probes(unit, ctx) {
  const m = (this._sessionFor(unit).measured) || {};
  return {
    replication_lag: async () => {
      if (typeof m.lagSeconds !== 'number') return notVerified('replication lag not measured');
      return m.lagSeconds === 0
        ? verified('replication lag 0s at probe')
        : notVerified(`replication lag ${m.lagSeconds}s (must be 0 at switchover)`);
    },
    // …row_counts, checksums, sequence_identity, constraints, smoke…
  };
}
```

Note the discipline: the probe never *assumes* a value. If `m.lagSeconds` was
never written by a real measurement, it returns `notVerified` — it does not
default to zero. **Wiring a connector means populating `sess.measured` from real
telemetry in `replicate()`/`cutover()`, then having the probes read it.**

---

## 5. Worked example — a minimal `BaseConnector`

Here is the smallest connector that follows every rule. It models a fictional
"Acme Cloud" target whose SDK is wired enough to measure lag and counts but not
the rest (so it correctly fails closed on the unwired categories):

```js
// src/connectors/acme.js
'use strict';

const { BaseConnector, verified, notVerified } = require('./sdk');

const REQUIRED_ENV = Object.freeze(['ACME_API_TOKEN', 'ACME_REGION']);

class AcmeConnector extends BaseConnector {
  constructor(meta = {}) {
    super(Object.assign({
      id: 'acme',
      name: 'Acme Cloud',
      modes: ['api-orchestration'],
      env: REQUIRED_ENV.slice(),
    }, meta));
  }

  async discover(ctx) {
    const cfg = this.requireConfig(ctx, REQUIRED_ENV); // fail-closed on missing config
    // TODO[SDK]: call the Acme inventory API and map items to units.
    return { ok: false, source: 'acme', pending: 'sdk',
      detail: 'Acme discovery not wired', region: cfg.ACME_REGION, units: [] };
  }

  async replicate(unit, ctx) {
    this.requireConfig(ctx, REQUIRED_ENV);
    const pre = await this.validate(unit, ctx);
    if (!pre.ok) return { ok: false, unitId: unit && unit.id, error: 'pre-flight failed', checks: pre.checks };
    this.advance(unit, 'executing');

    const sess = this._sessionFor(unit);
    sess.started = true;
    sess.startedAt = new Date().toISOString();
    // REAL MEASUREMENTS go into sess.measured — and ONLY real ones.
    // e.g. once the API reports initial sync complete:
    //   sess.measured.lagSeconds = await acme.getReplicationLag(unit.id);
    //   sess.measured.sourceRows = ...; sess.measured.targetRows = ...;
    return { ok: true, unitId: unit.id, replicationStarted: true, sessionAt: sess.startedAt };
  }

  _probes(unit, ctx) {
    const m = (this._sessionFor(unit).measured) || {};
    return {
      replication_lag: async () =>
        typeof m.lagSeconds !== 'number' ? notVerified('lag not measured')
          : (m.lagSeconds === 0 ? verified('lag 0s') : notVerified(`lag ${m.lagSeconds}s`)),
      row_counts: async () =>
        (typeof m.sourceRows !== 'number' || typeof m.targetRows !== 'number')
          ? notVerified('row counts not measured')
          : (m.sourceRows === m.targetRows ? verified(`counts equal (${m.sourceRows})`)
              : notVerified(`source=${m.sourceRows} target=${m.targetRows}`)),
      checksums: async () => notVerified('content checksums not compared'),
      sequence_identity: async () => notVerified('sequence continuity not validated'),
      constraints: async () => notVerified('constraints not re-validated'),
      smoke: async () => notVerified('target smoke probe not run'),
    };
  }

  async cutover(unit, ctx) {
    this.requireConfig(ctx, REQUIRED_ENV);
    const sess = this._sessionFor(unit);
    if (!sess.started) return { ok: false, unitId: unit && unit.id, error: 'cannot cut over before replication' };
    // TODO[SDK]: final delta + commit + repoint.
    this.advance(unit, 'completed');
    sess.cutOver = true;
    return { ok: true, unitId: unit.id, cutOver: true };
  }

  async rollback(unit, ctx) {
    this.requireConfig(ctx, REQUIRED_ENV);
    const sess = this._sessionFor(unit);
    if (this.canAdvance(unit, 'rolling_back')) this.advance(unit, 'rolling_back');
    // TODO[SDK]: reverse-protect / fail back to source.
    sess.cutOver = false;
    if (this.canAdvance(unit, 'rolled_back')) this.advance(unit, 'rolled_back');
    return { ok: true, unitId: unit.id, rolledBack: true };
  }
}

module.exports = { AcmeConnector };
```

Because `checksums`, `sequence_identity`, `constraints`, and `smoke` are not yet
measured, this connector **fails closed** — exactly as `azure-arc` and `hyperv`
do — until you wire those probes. That is correct, safe behaviour: it can be
registered and shipped, and the verified-before-Jump gate simply stays unreachable
for that unit until the work is genuinely done.

---

## 6. How `verify()` feeds the gate (`src/engine/reconcile.js`)

When you run a reconcile, the engine calls **your** `connector.verify(unit, ctx)`
and then applies two checks on top of it:

1. **Per-category fail-closed.** Any of the six pre-switch categories not proven
   `ok` makes the whole proof `ok: false` — even if your connector forgot to
   report it (`'not reported (fail-closed)'`).
2. **Baseline freshness.** `isFreshBaseline(unit, config)` requires
   `unit.baselineAt` to be within `config.baselineMaxAgeMs` (default 24h, env
   `VOSJ_BASELINE_MAX_AGE_MS`). No baseline ⇒ not fresh ⇒ fail-closed.

The combined result is:

```js
const ok = Boolean(result && result.ok) && preSwitchOk && baselineFresh;
```

It returns `{ ok, categories, proof, baselineFresh }`, and `proof.hash` is what
the human gate signer binds. So three independent things must all hold for the
Jump gate to be reachable: your connector measured a genuine pass **and** every
pre-switch category is `ok` **and** the baseline is fresh. See
[04 · The Verification Gate](./04-the-verification-gate.md) for the signing flow.

---

## 7. Registering your connector

A connector becomes usable when it is registered into a `ConnectorRegistry` (the
provider catalog) and resolvable by id.

### 7.1 Add it to the catalog

Edit `src/connectors/index.js` — this is a **one-line edit** by design:

```js
const { AcmeConnector } = require('./acme');

function buildRegistry() {
  const registry = new ConnectorRegistry();
  registry.register(new DemoConnector());
  registry.register(new AzureArcConnector());
  registry.register(new HyperVConnector());
  registry.register(new AcmeConnector());   // ← your connector
  return registry;
}
```

`ConnectorRegistry` (in `sdk.js`) enforces that every connector has an `id` and
**rejects duplicate ids** — so two connectors cannot collide. `registry.list()`
returns `{ id, meta }` for each, which is how the catalog is surfaced.

### 7.2 How the engine resolves it

The connector map is placed on `ctx.connectors` (a `Map<id, connector>`).
Currently `src/server.js` builds a minimal map directly:

```js
// server.js (current wiring)
const connectors = new Map();
connectors.set('demo', new DemoConnector());
```

To expose the full catalog, swap that for the registry's map:

```js
const { buildConnectorMap } = require('./connectors');
const connectors = buildConnectorMap();   // Map<id, connector> of every registered connector
```

The API resolves a connector by name at reconcile time
(`connectorFor(ctx, name)` in `src/api/routes.js`), defaulting to `'demo'`:

```js
function connectorFor(ctx, name) {
  const id = name || 'demo';
  const conn = ctx.connectors && ctx.connectors.get(id);
  if (!conn) throw new Error(`unknown connector: ${id}`);
  return conn;
}
```

### 7.3 Declare config in `.env.example`

Because your connector reads its config via `requireConfig`, add its keys to
`.env.example` (next to the existing entries) so operators know what to set:

```bash
# --- Acme Cloud connector ---
ACME_API_TOKEN=
ACME_REGION=
```

Never hardcode hosts, tokens, regions, or ids — declare them as required env and
let `requireConfig` fail closed when they are absent.

---

## 8. Using your connector end-to-end

Once registered, drive it through the normal flow (see
[03 · Running a Migration](./03-running-a-migration.md)). The reconcile call is
the one that exercises your `verify()`:

```bash
curl -sS -X POST http://localhost:8080/api/reconcile \
  -H "Authorization: Bearer $VOSJ_AUTH_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"workloadId":"acme-sql01","connector":"acme"}'
```

The response surfaces your proof verbatim:

```json
{
  "ok": true,
  "workloadId": "acme-sql01",
  "connector": "acme",
  "proofOk": false,
  "baselineFresh": true,
  "categories": [ { "name": "replication_lag", "ok": true, "detail": "lag 0s" }, … ],
  "proof": { "hash": "…", "categories": [ … ] }
}
```

`proofOk: false` here is the correct, honest outcome for a partly-wired connector
— the gate will not open until every category is genuinely `ok`.

> This route requires the `migration:reconcile:run` capability. Auth is
> bearer-token by default (`VOSJ_AUTH_MODE=token`, `VOSJ_AUTH_TOKEN`); see
> [02 · Configuration & Auth](./02-configuration-and-auth.md).

---

## 9. The checklist — what CI / the contract test expects

Before you open a PR, make sure your connector satisfies every assertion in
`test/connectors.test.js`. Run the suite:

```bash
npm test
# or just the connector contract tests:
node --test test/connectors.test.js
```

- [ ] Implements all five contract methods (`discover`, `replicate`, `verify`,
      `cutover`, `rollback`) and has a non-empty `id`.
- [ ] `replicate()` **fails closed** without required config (throws
      `MissingConfigError`).
- [ ] `verify()` reports **exactly** the six pre-switch categories.
- [ ] `verify()` **fails closed** before *and* after `replicate()` while the
      measurement seam is unwired — never a fabricated pass.
- [ ] A probe that is missing, returns no result, or throws is recorded
      `not verified` (the base scaffold does this for you — don't defeat it).
- [ ] A single failing/unmeasured category forces `verify().ok === false`.
- [ ] A genuinely-measured proof (all six probes `verified`) is the *only* way
      `verify().ok === true` — and it carries a `proof.hash`.
- [ ] `reconcile()` refuses a passing proof while the connector is unwired.
- [ ] Registered in `src/connectors/index.js`; config keys added to
      `.env.example`.

---

## 10. The golden rule, restated

> **Never report `verified` without measuring.** The entire safety property of
> Vosj — fail-closed, verified-before-Jump, signed by a human, recorded in a
> tamper-evident ledger — rests on the connector telling the truth about what it
> measured. When in doubt, return `notVerified()`. An unreachable gate is a
> safe state; a fabricated pass is a defect.

---

### Related guides

- [03 · Running a Migration](./03-running-a-migration.md) — the four-station flow your connector plugs into.
- [04 · The Verification Gate](./04-the-verification-gate.md) — how the proof your `verify()` produces is signed and bound.
- [06 · The Tamper-Evident Ledger](./06-the-tamper-evident-ledger.md) — where every gate decision and reconcile is recorded.
