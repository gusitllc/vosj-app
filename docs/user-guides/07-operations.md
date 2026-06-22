# 07 — Operations (Running Vosj in Production)

This guide is for the engineer **operating** a Vosj CE deployment: configuring it,
custodying the ledger key, understanding the RBAC capability model and what advisory
waivers can (and can never) do, reading the health endpoint, choosing Postgres vs.
in-memory, and backing it up.

Vosj CE is a single Node service ([`src/server.js`](../../src/server.js)) with an
optional PostgreSQL state store. It is **fail-closed by design**: the two secrets
below have *no defaults*, and their absence is detected at use-time rather than
silently substituted.

Reference source: [`src/config.js`](../../src/config.js),
[`.env.example`](../../.env.example),
[`src/ledger/ledger.js`](../../src/ledger/ledger.js),
[`src/engine/waiver.js`](../../src/engine/waiver.js),
[`src/api/rbac.js`](../../src/api/rbac.js),
[`src/api/auth.js`](../../src/api/auth.js),
[`src/db/schema.sql`](../../src/db/schema.sql). For the full deploy runbook see
[`docs/DEPLOYMENT.md`](../DEPLOYMENT.md).

---

## 1. Configuration reference

All configuration is read **once at boot** from `process.env`, defaulted, and
exported as a **frozen** object ([`src/config.js`](../../src/config.js)). `.env` is
loaded if `dotenv` is installed (optional). Copy [`.env.example`](../../.env.example)
to `.env` to start.

| Env var | Config field | Default | Purpose |
|---------|--------------|---------|---------|
| `VOSJ_PORT` | `PORT` | `8080` | HTTP listen port. |
| `VOSJ_STATE_STORE` | `STATE_STORE` | `pg` if DB configured, else `memory` | Explicitly force `pg` or `memory`. |
| `PG_HOST` | `db.host` | _(empty)_ | PostgreSQL host. |
| `PG_PORT` | `db.port` | `5432` | PostgreSQL port. |
| `PG_USER` | `db.user` | _(empty)_ | PostgreSQL user. |
| `PG_PASSWORD` | `db.password` | _(empty)_ | PostgreSQL password. |
| `PG_DATABASE` | `db.database` | _(empty)_ | PostgreSQL database name. |
| `VOSJ_DB_SSL_REJECT_UNAUTHORIZED` | `db.sslRejectUnauthorized` | `true` | Set `false` to accept a self-signed cert (e.g. CloudNativePG). |
| `VOSJ_LEDGER_HMAC_KEY` | `LEDGER_HMAC_KEY` | **none (fail-closed)** | HMAC key that signs the ledger. Absent ⇒ signing throws. |
| `VOSJ_VAULT_MASTER_KEY` | `VAULT_MASTER_KEY` | **none (fail-closed)** | Master key for credential vault ops. Absent ⇒ vault refuses to operate. |
| `VOSJ_AUTH_MODE` | `AUTH_MODE` | `token` | `token` (bearer) or `open` (localhost dev only). |
| `VOSJ_AUTH_TOKEN` | `AUTH_TOKEN` | _(empty)_ | The bearer token, required in `token` mode. |
| `VOSJ_RBAC_ROLE_CAPABILITIES` | `RBAC_ROLE_CAPABILITIES` | _(empty)_ | Optional JSON role→capability map (see §3). |
| `VOSJ_BASELINE_MAX_AGE_MS` | `baselineMaxAgeMs` | `86400000` (24h) | Max baseline age before the baseline-drift guard fires. |

### "DB configured" is derived

`dbConfigured` is `true` **only** when `PG_HOST`, `PG_USER`, and `PG_DATABASE` are
all present. When configured, `STATE_STORE` defaults to `pg`; otherwise it defaults
to `memory`. You can override with `VOSJ_STATE_STORE` explicitly.

### The two fail-closed secrets

`VOSJ_LEDGER_HMAC_KEY` and `VOSJ_VAULT_MASTER_KEY` have **no default value** — the
config does not substitute anything. Generate strong values and custody them
**outside the database** (KMS / HSM / secrets manager), never in the DB the ledger
protects:

```bash
openssl rand -hex 32   # use the output for VOSJ_LEDGER_HMAC_KEY (and the vault key)
```

> If you start the server **without** `VOSJ_LEDGER_HMAC_KEY`, it boots and serves a
> real `/health` (with `ledgerOk: false`), but **any gate sign or waiver-use will
> throw** `ledger fail-closed: VOSJ_LEDGER_HMAC_KEY is not set`. This is intentional:
> Vosj will not produce an unsigned audit record.

---

## 2. The ledger & chain verification {#ledger}

The ledger ([`src/ledger/ledger.js`](../../src/ledger/ledger.js)) is a
**tamper-evident, hash-chained** append-only log. Each row carries:

```
hash = HMAC-SHA256( VOSJ_LEDGER_HMAC_KEY,  prevHash + canonical(row-without-hash) )
```

where `canonical()` is deterministic, sorted-key JSON so the HMAC is reproducible.
The first row links to the genesis hash (`0` × 64). Persisted columns are in
[`src/db/schema.sql`](../../src/db/schema.sql) `vosj.ledger`
(`seq, ts, actor, signer_role, action, evidence_hashes, meta, prev_hash, hash`).

### What gets written

Every signed gate transition and every applied waiver appends a row, with `action`
one of:

- `gate.sign` — a phase-gate signature.
- `gate.sign.cutover` — a cutover (verified-before-Jump) signature.
- `waiver.use` — an advisory waiver was applied (see §4).

### Verifying the chain

The server re-walks the chain and reports the first break, if any
(`verifyChain()` → `{ ok, brokenAt }`):

```bash
# HTTP — returns { ok, verified, brokenAt }
curl -s http://localhost:8080/api/ledger/verify \
  -H "Authorization: Bearer $VOSJ_AUTH_TOKEN"
# => {"ok":true,"verified":true,"brokenAt":null}
```

A response of `"verified": false` with `"brokenAt": <seq>` means the row at that
sequence number is the **first** whose `prevHash` link or recomputed HMAC does not
match — evidence of a forged, back-dated, deleted, or re-ordered row. The
[Command Center ledger console](./06-command-center.md#6-panel-3--the-tamper-evident-ledger-console)
exposes the same check as a one-click badge.

### Operational responses

- **`verified: true`** — the audit trail is intact end-to-end.
- **`brokenAt: N`** — treat as a security incident. The DB has been modified outside
  the engine. Preserve the row(s) ≥ `N` as forensic evidence; do **not** "repair" by
  re-signing — that would launder the tamper. Restore from a known-good backup
  (§6) and investigate DB write access.
- **verify *errors* (not a clean `false`)** — almost always a missing/changed HMAC
  key. If the key changed, the chain it signed can no longer be verified with the
  new key; this is why key rotation requires care (treat the existing chain as
  closed under the old key and start a new chain, or keep the old key available for
  verification only).

> Custody rule: the HMAC key must live **outside** the database it protects. If an
> attacker who can edit `vosj.ledger` also holds the key, they can re-sign forged
> rows and `verifyChain()` will pass. Separation of the key from the data is the
> whole guarantee.

---

## 3. RBAC: the capability model {#rbac}

Authorisation is **capability-based**. Every action is named
`{domain}:{resource}:{action}` ([`src/api/auth.js`](../../src/api/auth.js)). Two
middlewares guard the API:

- **`requireAuth`** — on **every** data route. Authenticates the caller and attaches
  `req.principal = { id, kind, mode, capabilities, role }`.
- **`requireCapability(cap)`** — on **every mutation**. The principal must hold the
  named capability.

### Authentication modes

| `VOSJ_AUTH_MODE` | Behaviour |
|------------------|-----------|
| `token` (default) | A bearer token must be configured (`VOSJ_AUTH_TOKEN`) **and** match (constant-time compare). No token configured ⇒ `503 authentication not configured`. Wrong/missing token ⇒ `401`. |
| `open` | **Localhost only.** A request from `127.0.0.1`/`::1`/`localhost` is auto-authenticated as `localhost-dev`; a remote caller is rejected `401`. Use for dev only. |

The authenticated CE principal is an **`agent`** principal carrying this fixed
capability set (`CE_CAPABILITIES`):

```
migration:workload:write     migration:wave:plan      migration:reconcile:run
migration:disposition:write  migration:wave:shift     migration:gate:sign
migration:wave:write         migration:jump:execute
```

These map onto the mutating routes ([`src/api/routes.js`](../../src/api/routes.js)),
e.g.:

| Route | Required capability |
|-------|--------------------|
| `POST /api/workloads` | `migration:workload:write` |
| `POST /api/waves` | `migration:wave:write` |
| `POST /api/waves/:id/transition` | `migration:gate:sign` |
| `POST /api/reconcile` | `migration:reconcile:run` |

Read routes (`GET /api/templates`, `/api/workloads`, `/api/waves`, `/api/ledger`,
`/api/ledger/verify`, `/api/classify/:id`) require only `requireAuth`.

### The critical separation: capability ≠ signature

`requireCapability('migration:gate:sign')` only authorises the caller to *attempt* a
gate transition. It does **not**, and cannot, make the caller the human signer. The
CE principal's `kind` is `'agent'` precisely so it can never self-sign. The human
signer identity is supplied in the request body and validated **structurally** in
the engine ([`src/engine/gate.js`](../../src/engine/gate.js)): no agent self-sign
(Invariant 1) and separation of duties / author ≠ signer (Invariant 2). RBAC bounds
*who may act*; the engine bounds *who may sign*. They are different layers and the
engine wins.

### Optional config-driven role grants (additive)

By default `requireCapability` checks the principal's own capability `Set`. You can
*additionally* grant capabilities by role via `VOSJ_RBAC_ROLE_CAPABILITIES`
([`src/api/rbac.js`](../../src/api/rbac.js)) — a JSON object mapping a role to the
capabilities it may exercise:

```bash
export VOSJ_RBAC_ROLE_CAPABILITIES='{
  "director":["migration:gate:sign","migration:wave:write"],
  "dba":["migration:reconcile:run"]
}'
```

Semantics — designed to be **safe and additive**:

- **Unset / empty / malformed JSON** ⇒ the registry is *unconfigured*; behaviour is
  unchanged (the principal's own `Set` only). It never throws at boot and never
  silently grants.
- **Configured** ⇒ the principal holds a capability if **either** its own `Set` holds
  it **or** the registry grants it to the principal's `role`. A configured registry
  only ever **grants** via an explicit mapping — it never removes a capability a
  principal already carried, so it cannot break existing callers.
- It **never** broadens the structural human-gate guarantees — those live in the
  engine, not in this map.

---

## 4. Advisory waivers — what can and cannot be waived {#waivers}

A **waiver** is an audited, time-boxed exception to an **advisory (soft)** gate
criterion only ([`src/engine/waiver.js`](../../src/engine/waiver.js),
[`src/db/schema.sql`](../../src/db/schema.sql) `vosj.waivers`). It is a second-line
control: when an *advisory* readiness/scorecard check fails, the engine may consult
the waivers table for an active, non-expired, correctly-scoped waiver and, if one
exists, let that check pass — **recording a `waiver.use` row in the ledger** as it
does so.

### The hard line: what can NEVER be waived

A waiver can **never** bypass a **hard invariant**. These are structurally
unwaivable — defended in depth: `isWaivable()` refuses any check that is not classed
`advisory`, *and* refuses any check whose name is on the reserved hard-invariant
list, **even if a matching waiver row somehow exists**:

```
verified-before-cutover   no-agent-self-sign      separation-of-duties
ledger-fail-closed        baseline-drift          (+ snake_case aliases)
```

Concretely, a waiver can never let you:

- Cut over to "Jump" **without a passing reconciliation proof** (verified-before-cutover).
- Have an **agent self-sign** a gate, or have the **author also sign** it.
- Sign **without a working ledger** (a missing HMAC key makes `ledger.append` throw,
  and the waiver record itself fails closed because recording it requires the
  ledger).
- Proceed on a **stale baseline** past `VOSJ_BASELINE_MAX_AGE_MS` (baseline-drift).

So: **only an advisory-classed check whose name is not a reserved invariant can ever
be waived.** Default-deny for unknown classes.

### Waiver row shape & lifecycle

`vosj.waivers` columns ([`src/db/schema.sql`](../../src/db/schema.sql)):

| Column | Meaning |
|--------|---------|
| `id` | Primary key. |
| `gate_id` | The gate the waiver targets (optional). |
| `reason` | **Required** justification. |
| `granted_by` | **Required** — who granted it (audited). |
| `expires_at` | Optional expiry; once past, the waiver is no longer "active". |
| `check_name` | The advisory check being waived. |
| `check_class` | Must be `advisory` (default) — only `advisory` is honoured. |
| `scope` | Optional workload/wave id the waiver applies to. An **unscoped** waiver applies broadly; a **scoped** waiver needs a matching scope. |
| `status` | `active` or `revoked`. Only `active` is consulted. |

A waiver is *active* when `status = active` **and** it has not passed `expires_at`.
To withdraw one, set `status = revoked` (it is then ignored immediately). Every
*application* of a waiver leaves a `waiver.use` ledger row whose `meta` records the
`waiverId`, `gateId`, `checkName`, `scope`, `grantedBy`, and `reason` — so the
exception is itself fully auditable in the tamper-evident chain.

> Note: the CE REST API in [`src/api/routes.js`](../../src/api/routes.js) does not
> expose a waiver-management endpoint; waivers are managed through the store
> (`saveWaiver`) / SQL. The enforcement seam (`WaiverRegistry`) is wired into the
> engine and always refuses hard invariants regardless of table contents.

---

## 5. Health metrics {#health}

`GET /health` is **unauthenticated** and returns **real** metrics
([`src/server.js`](../../src/server.js) `mountHealth`) — it never returns a bare
`{ ok: true }`:

```bash
curl -s http://localhost:8080/health
```

```json
{
  "ok": true,
  "version": "1.0.0",
  "uptime": 1234.5,
  "store": "pg",
  "storeOk": true,
  "dbConfigured": true,
  "ledgerOk": true,
  "workloads": 42,
  "waves": 7
}
```

| Field | Source | Use |
|-------|--------|-----|
| `version` | `package.json` | Confirm the deployed build. |
| `uptime` | `process.uptime()` | Detect restarts/crash loops. |
| `store` / `storeOk` | `store.health()` | `pg` or `memory`; `storeOk` is a live probe (`SELECT 1` for pg). |
| `dbConfigured` | config | Whether PG env is set. |
| `ledgerOk` | `ledger.healthy()` | `true` only if the HMAC key is set **and** the chain currently verifies. |
| `workloads` / `waves` | `engine.counts()` | Live row counts. |

Recommended probes:

- **Liveness/readiness**: `GET /health` returns HTTP 200 with `ok: true`. Each
  sub-check is defensive — a store or ledger fault degrades the relevant field
  rather than crashing the endpoint.
- **Alert** on `storeOk: false` (DB down), `ledgerOk: false` in a signing
  deployment (signing will fail closed), or `dbConfigured: true` with `store:
  "memory"` (misconfiguration — you intended Postgres but fell back).

---

## 6. Postgres vs. in-memory, and backups

### Choosing a store

Vosj selects the StateStore at boot ([`src/db/statestore.js`](../../src/db/statestore.js)):

| Store | When | Durability |
|-------|------|------------|
| `memory` (`MemoryStateStore`) | No DB configured, or `VOSJ_STATE_STORE=memory` | **None** — all state (workloads, waves, **and the ledger**) is lost on restart. Dev / demo / evaluation only. |
| `pg` (`PgStateStore`) | DB configured, or `VOSJ_STATE_STORE=pg` | Durable, parameterised SQL, schema-per-domain isolation (`vosj.*`). **Required for production.** |

> Critical: in `memory` mode the ledger is in-process only. There is no durable,
> tamper-evident record across restarts. **Production must use Postgres.**

### Initialising the schema

The schema ([`src/db/schema.sql`](../../src/db/schema.sql)) is fully idempotent
(every object is `IF NOT EXISTS`). Apply it with the bundled migrate script (which
reads and runs `schema.sql` via the pool facade) or with `psql`:

```bash
npm run migrate                        # node -e require('./src/db/pool').migrate()
# or:
psql "$PG_CONN" -f src/db/schema.sql
```

Tables created: `vosj.templates`, `vosj.workloads`, `vosj.waves`, `vosj.gates`,
`vosj.ledger`, `vosj.waivers`, `vosj.tool_log`, `vosj.orders`. Re-running is safe.

### Connection & SSL

The pool ([`src/db/pool.js`](../../src/db/pool.js)) uses `max: 10` connections and
honours `VOSJ_DB_SSL_REJECT_UNAUTHORIZED`. For a self-signed-cert Postgres (e.g.
CloudNativePG) set `VOSJ_DB_SSL_REJECT_UNAUTHORIZED=false`; otherwise leave it `true`
to verify the server certificate.

### Backups

The ledger is the system of record, so back it up like one:

- **Full DB backup** — standard `pg_dump`/`pg_basebackup` or your platform's snapshot
  (e.g. CloudNativePG continuous backup). Because the ledger is a single ordered
  table (`vosj.ledger`), a consistent snapshot captures the whole chain.

  ```bash
  pg_dump --no-owner --schema=vosj "$PG_CONN" > vosj-backup.sql
  ```

- **Verify after restore** — after restoring, run `GET /api/ledger/verify`
  (or the Command Center "Verify Chain"). A `verified: true` proves the restored
  chain is internally consistent **and** that the restore did not drop/re-order rows
  (any gap would surface as `brokenAt`). This is a free integrity check that a plain
  DB restore cannot give you.
- **Key custody** — back up `VOSJ_LEDGER_HMAC_KEY` (and `VOSJ_VAULT_MASTER_KEY`)
  **separately** from the database, in your secrets manager. A DB backup without the
  key cannot be verified; the key stored next to the data defeats the tamper-evidence.

---

## See also

- [01 — Getting Started](./01-getting-started.md) — install, configure, and the first
  end-to-end migration.
- [06 — The Command Center](./06-command-center.md) — the web UI, including the
  one-click chain-verify badge and gate signing.
- [`docs/DEPLOYMENT.md`](../DEPLOYMENT.md) — the full production deploy runbook.
- Source of truth if a guide and the code disagree (the code wins):
  [`src/config.js`](../../src/config.js),
  [`src/ledger/ledger.js`](../../src/ledger/ledger.js),
  [`src/engine/waiver.js`](../../src/engine/waiver.js),
  [`src/api/rbac.js`](../../src/api/rbac.js),
  [`src/db/schema.sql`](../../src/db/schema.sql).
