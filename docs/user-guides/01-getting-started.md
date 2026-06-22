# 01 — Getting Started

This guide takes you from a clean checkout to a **verified Jump**: install Vosj CE,
configure the two required fail-closed secrets, start the server, confirm `/health`,
and then drive one workload all the way through **Vault → Orchestrate → Shift → Jump**
using only `curl`.

Everything here is grounded in the actual code — real env vars
([`src/config.js`](../../src/config.js)), real routes
([`src/api/routes.js`](../../src/api/routes.js)), the real flagship template
([`templates/caf.json`](../../templates/caf.json)), and the real demo connector
([`src/connectors/demo.js`](../../src/connectors/demo.js)).

If you want the conceptual map first, read the
[user-guides index](./README.md). Otherwise, start here.

---

## 1. Prerequisites

| Requirement | Why |
|-------------|-----|
| **Node.js ≥ 20** | Declared in [`package.json`](../../package.json) `engines.node`. The test runner and `--watch` dev mode both assume ≥ 20. |
| **npm** | Installs `express`, `pg`, and `dotenv`. |
| `curl` + `jq` (optional) | The walkthrough uses `curl`; `jq` just makes responses readable. |
| PostgreSQL 13+ (optional) | Only if you want durable storage. The default in-memory store needs nothing. |

Check your Node version:

```bash
node --version   # must print v20.x or higher
```

---

## 2. Install

```bash
git clone https://github.com/gusitllc/vosj-app.git
cd vosj-app          # the package root (where package.json lives)
npm install
```

`npm install` pulls exactly three runtime dependencies (see
[`package.json`](../../package.json)): `express`, `pg`, and `dotenv`. There is no
build step — Vosj CE is plain CommonJS.

Run the test suite to confirm a healthy checkout (this exercises the full
end-to-end flow in memory, no network):

```bash
npm test
```

`npm test` runs `node --test`. You should see the e2e test
([`test/e2e.test.js`](../../test/e2e.test.js)) drive a workload V→O→S→J and verify
the ledger chain.

---

## 3. Configure (`.env`)

Copy the template and edit it:

```bash
cp .env.example .env
```

[`.env.example`](../../.env.example) ships with safe defaults for **every** value
**except the two fail-closed secrets**, which have no default anywhere in the code
(see [`src/config.js`](../../src/config.js) lines 43–47). You must generate them.

### 3.1 The two REQUIRED fail-closed secrets

These are the heart of Vosj's "verified-before-Jump" guarantee. The code **never**
substitutes a default — if either is missing, the dependent operation throws and
refuses to proceed (`src/ledger/ledger.js` `_key()` throws
`ledger fail-closed: VOSJ_LEDGER_HMAC_KEY is not set`).

Generate both with cryptographically strong random values:

```bash
# Ledger signing key — HMAC-SHA256 over the audit hash chain. Custody this OUTSIDE
# the database (a KMS/HSM/secret manager in production; .env for local dev).
openssl rand -hex 32

# Vault master key — required for any credential-vault operation.
openssl rand -hex 32
```

Paste each result into `.env`:

```ini
VOSJ_LEDGER_HMAC_KEY=<first 64-hex-char value>
VOSJ_VAULT_MASTER_KEY=<second 64-hex-char value>
```

> **Why two keys, not one?** They protect different surfaces and should have
> different custody/rotation lifecycles: `VOSJ_LEDGER_HMAC_KEY` signs the
> tamper-evident audit ledger; `VOSJ_VAULT_MASTER_KEY` protects stored target/source
> credentials. Rotating one must not weaken the other.

> **Fail-closed in practice:** if you start the server without
> `VOSJ_LEDGER_HMAC_KEY`, `/health` will report `"ledgerOk": false`, and any attempt
> to sign a gate returns `{ "ok": false, "error": "ledger fail-closed: ..." }`. This
> is intentional — it is not a bug to "work around."

### 3.2 Authentication

CE auth ([`src/api/auth.js`](../../src/api/auth.js)) is intentionally simple — a
single bearer token. Two modes:

- `VOSJ_AUTH_MODE=token` (the default) — every data route requires
  `Authorization: Bearer <VOSJ_AUTH_TOKEN>`. If you select `token` mode but leave
  `VOSJ_AUTH_TOKEN` blank, the API fails closed with HTTP 503
  `authentication not configured: set VOSJ_AUTH_TOKEN`.
- `VOSJ_AUTH_MODE=open` — **localhost only**. A non-local caller is still rejected
  with HTTP 401. Use this only for local development.

For this walkthrough we use `token` mode with a token you choose:

```ini
VOSJ_AUTH_MODE=token
VOSJ_AUTH_TOKEN=dev-walkthrough-token-change-me
```

### 3.3 State store: in-memory vs PostgreSQL

The store selection logic lives in [`src/config.js`](../../src/config.js) line 29:

```
STATE_STORE = VOSJ_STATE_STORE  ||  (dbConfigured ? 'pg' : 'memory')
```

`dbConfigured` is true only when **all three** of `PG_HOST`, `PG_USER`, and
`PG_DATABASE` are set.

- **In-memory (default, zero setup)** — leave the `PG_*` variables blank. Workloads,
  waves, and the ledger live in process memory and are **lost on restart**. Perfect
  for the walkthrough below and for evaluation.
- **PostgreSQL (durable)** — fill in the `PG_*` block in `.env` and the store
  switches to `pg` automatically. If your Postgres uses a self-signed certificate
  (e.g. CloudNativePG), set `VOSJ_DB_SSL_REJECT_UNAUTHORIZED=false`. Then run the
  schema migration once:

  ```bash
  npm run migrate
  ```

  You can force a store explicitly with `VOSJ_STATE_STORE=pg` or
  `VOSJ_STATE_STORE=memory` regardless of the `PG_*` values.

> **Heads-up on memory mode + fail-closed secrets:** even in memory mode the ledger
> still requires `VOSJ_LEDGER_HMAC_KEY`. In-memory is about *where rows are stored*,
> not *whether they are signed*. Signing is never optional.

### 3.4 Full minimal `.env` for the walkthrough

```ini
VOSJ_PORT=8080
VOSJ_STATE_STORE=memory
VOSJ_LEDGER_HMAC_KEY=<openssl rand -hex 32 #1>
VOSJ_VAULT_MASTER_KEY=<openssl rand -hex 32 #2>
VOSJ_AUTH_MODE=token
VOSJ_AUTH_TOKEN=dev-walkthrough-token-change-me
```

---

## 4. Run

```bash
npm start          # node src/server.js
# or, with auto-reload during development:
npm run dev        # node --watch src/server.js
```

On startup you'll see:

```
[<ISO timestamp>] INFO Vosj CE listening on :8080 (store=memory)
```

The static UI (if present under `public/`) is served at `/`. The API is under
`/api`. The MCP server, if built, mounts itself — the spine boots and serves a real
`/health` even when optional modules are absent
([`src/server.js`](../../src/server.js) `mountOptional`).

### 4.1 Check `/health`

`/health` is unauthenticated and returns **real metrics**, not a static `{ok:true}`
(see [`src/server.js`](../../src/server.js) `mountHealth`):

```bash
curl -s http://localhost:8080/health | jq
```

```json
{
  "ok": true,
  "version": "0.1.0",
  "uptime": 12.34,
  "store": "memory",
  "storeOk": true,
  "dbConfigured": false,
  "ledgerOk": true,
  "workloads": 0,
  "waves": 0
}
```

Field checklist before you proceed:

| Field | Want | If not |
|-------|------|--------|
| `storeOk` | `true` | Store failed to init — check `PG_*`/SSL if using Postgres. |
| `ledgerOk` | `true` | `VOSJ_LEDGER_HMAC_KEY` is missing or the chain is broken — fix the key. |
| `store` | `memory` or `pg` | Confirms which store you're actually on. |

If `ledgerOk` is `false`, **stop** — you have not set `VOSJ_LEDGER_HMAC_KEY`, and no
gate will sign.

---

## 5. First end-to-end walkthrough

Goal: take one database workload from `legacy` all the way to a **verified Jump**,
proving the fail-closed gate along the way. Every command below is a real route in
[`src/api/routes.js`](../../src/api/routes.js); every response is the
`{ ok: true, ... }` / `{ ok: false, error }` envelope the API guarantees.

Set two shell variables to keep the commands clean:

```bash
TOKEN=dev-walkthrough-token-change-me
BASE=http://localhost:8080
```

Every data route requires the bearer token. Mutations additionally require a
capability, which the token principal already holds (see `CE_CAPABILITIES` in
[`src/api/auth.js`](../../src/api/auth.js)).

### Step 0 — see what frameworks are available

```bash
curl -s -H "Authorization: Bearer $TOKEN" $BASE/api/templates | jq
```

You'll see the flagship **`caf`** template — the Cloud Adoption Framework compiled
into seven gated phases `P1..P7` mapped onto the V-O-S-J stations
([`templates/caf.json`](../../templates/caf.json)). We'll use it.

```bash
curl -s -H "Authorization: Bearer $TOKEN" $BASE/api/templates/caf | jq '.template.phases[] | {id, name, station, gate: .gate.id, signerRole: .gate.signerRole}'
```

This prints the phase→station→gate→required-signer map you'll follow:

| Phase | Station | Gate | Required signer role |
|-------|---------|------|----------------------|
| P1 → P2 | V → V | `g-discovery-signoff` | `director` |
| P2 → P3 | V → O | `g-kickoff-complete` | `it-lead` |
| P3 → P4 | O → O | `g-planning-signoff` | `director` |
| P4 → P5 | O → S | `g-execution-freeze` | `infosec` |
| P5 → P6 | S → J | `g-go-no-go` | `director` |
| P6 → P7 | J → J | `g-reconciliation-pass` (**cutover**) | `dba` |

The `P6 → P7` gate is marked `cutover: true` — it **cannot be signed without a
passing reconciliation proof**. That is the verified-before-Jump invariant at the
phase level.

### Step 1 — create a workload (Vault: the thing being migrated)

`POST /api/workloads` requires `migration:workload:write`. Required body fields are
`id` and `name`; everything else is optional
([`buildWorkload`](../../src/api/routes.js)). We give it a disposition hint and a
fresh `baselineAt` (a reconciliation needs a fresh baseline — see Step 6).

```bash
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{
    \"id\": \"demo-db\",
    \"name\": \"Demo Database\",
    \"disposition\": \"Replatform\",
    \"state\": \"legacy\",
    \"baselineAt\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",
    \"attributes\": { \"rowCount\": 845231, \"managedServiceTarget\": true }
  }" \
  $BASE/api/workloads | jq
```

Response (envelope `{ ok: true, workload }`):

```json
{ "ok": true, "workload": { "id": "demo-db", "name": "Demo Database", "disposition": "Replatform", "state": "legacy", "wave_id": null, "baseline_at": "2026-...Z", "attributes": { "rowCount": 845231, "managedServiceTarget": true } } }
```

### Step 2 — classify it (the 7-R disposition engine)

`GET /api/classify/:workloadId` runs the workload through the 7-R contract table
([`src/engine/disposition.js`](../../src/engine/disposition.js)). The seven
dispositions are **Retire, Retain, Rehost, Relocate, Repurchase, Replatform,
Refactor**. Each resolves to a *typed contract* (`executorClass`,
`runbookTemplate`, `reconciliationProfile`, `cutoverStyle`).

```bash
curl -s -H "Authorization: Bearer $TOKEN" $BASE/api/classify/demo-db | jq
```

```json
{
  "ok": true,
  "workloadId": "demo-db",
  "classification": {
    "disposition": "Replatform",
    "contract": {
      "meaning": "Lift-and-reshape (e.g. managed database).",
      "executorClass": "replatform",
      "runbookTemplate": "replatform-reshape",
      "reconciliationProfile": "tightened",
      "cutoverStyle": "strangler-fig",
      "highRisk": true,
      "deliverySystemPrecondition": true
    },
    "strangler": true,
    "bigBangAvailable": false
  }
}
```

Read the last two fields carefully. `Replatform` is **high-risk**, so the contract
table forces `cutoverStyle: "strangler-fig"` → `bigBangAvailable: false`. A big-bang
plan for a high-risk reshape is **structurally unavailable** — you cannot opt into
it, even by mistake. (The same is true for `Refactor` and `Relocate`.)

> If you omit `disposition` on the workload, `classify` falls back to a
> conservative heuristic (`heuristic()` in `disposition.js`) — e.g. the
> `managedServiceTarget: true` attribute we set would also resolve to `Replatform`.
> The heuristic **never** produces a big-bang plan for a high-risk reshape; that
> property comes from the contract table, not the guess.

### Step 3 — create a wave from a template

A **wave** is a governed run of the phase state machine. `POST /api/waves` requires
`migration:wave:write`. Required fields: `id`, `name`. Pass `templateId: "caf"` so
the engine **pins the framework version** at kickoff — a later template edit cannot
mutate an in-flight run ([`buildWave`](../../src/api/routes.js)).

```bash
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{ "id": "wave-1", "name": "Pilot wave", "templateId": "caf" }' \
  $BASE/api/waves | jq
```

```json
{
  "ok": true,
  "wave": {
    "id": "wave-1",
    "name": "Pilot wave",
    "state": "P1",
    "framework_template_id": "caf",
    "framework_version": "1",
    "plan": {}
  }
}
```

The wave starts at `state: "P1"` (Envision, Vault station). You now advance it phase
by phase, signing each exit gate.

### Step 4 — sign the gates (the human, phase by phase)

This is the structural core of Vosj. `POST /api/waves/:id/transition` is the **only**
way to move a wave forward, and it requires:

1. The caller capability `migration:gate:sign` (your bearer token holds it).
2. A **human signer** supplied in the request body. The engine
   ([`src/engine/gate.js`](../../src/engine/gate.js)) enforces, structurally:
   - **No agent self-sign** (Invariant 1): `signer.kind` must be `"human"`.
   - **Separation of duties** (Invariant 2): the `actor` (who did the work) must not
     equal the `signer` (who approves it).
   - **Role match**: the signer's `role` must equal the gate's `signerRole`.

The bearer-token layer can authorize the *call*, but it **cannot** be the gate
signer — that identity is named explicitly in the body and validated by the engine.

Advance **P1 → P2** (gate `g-discovery-signoff`, requires a `director`):

```bash
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{
    "to": "P2",
    "actor": "carol-engineer",
    "signer": { "id": "dana-director", "kind": "human", "role": "director" },
    "evidence": ["business-case approved", "readiness-report filed"]
  }' \
  $BASE/api/waves/wave-1/transition | jq
```

```json
{
  "ok": true,
  "wave": { "id": "wave-1", "state": "P2", ... },
  "gate": "g-discovery-signoff",
  "ledger": { "seq": 1, "action": "gate.sign", "actor": "carol-engineer", "signerRole": "director", "hash": "...", "prevHash": "0000...", ... }
}
```

The signed row is now on the tamper-evident ledger (`ledger.seq`, `ledger.hash`,
chained off `prevHash`).

Now walk the rest of the phases. **Use a different, correctly-roled human for each
gate** (the role must match the table in Step 0). Note that `actor` stays
`carol-engineer` to demonstrate separation of duties — the signer is always someone
else:

```bash
# P2 -> P3 : g-kickoff-complete (it-lead)
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{ "to": "P3", "actor": "carol-engineer",
        "signer": { "id": "ivan-itlead", "kind": "human", "role": "it-lead" },
        "evidence": ["every in-scope workload carries a disposition"] }' \
  $BASE/api/waves/wave-1/transition | jq '.gate, .wave.state'

# P3 -> P4 : g-planning-signoff (director)
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{ "to": "P4", "actor": "carol-engineer",
        "signer": { "id": "dana-director", "kind": "human", "role": "director" },
        "evidence": ["rollback authored independently", "tabletops passed"] }' \
  $BASE/api/waves/wave-1/transition | jq '.gate, .wave.state'

# P4 -> P5 : g-execution-freeze (infosec)
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{ "to": "P5", "actor": "carol-engineer",
        "signer": { "id": "sam-infosec", "kind": "human", "role": "infosec" },
        "evidence": ["infra/app frozen", "vendors verified"] }' \
  $BASE/api/waves/wave-1/transition | jq '.gate, .wave.state'

# P5 -> P6 : g-go-no-go (director)
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{ "to": "P6", "actor": "carol-engineer",
        "signer": { "id": "dana-director", "kind": "human", "role": "director" },
        "evidence": ["full-panel go decision"] }' \
  $BASE/api/waves/wave-1/transition | jq '.gate, .wave.state'
```

After these, the wave is at `P6` (Verify & Optimize, **Jump** station). The next gate
is the cutover gate — and it will refuse to sign without a proof.

### Step 5 — prove the gate fails closed (try to Jump with no proof)

Attempt `P6 → P7` (gate `g-reconciliation-pass`, `cutover: true`) **without** a proof:

```bash
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{ "to": "P7", "actor": "carol-engineer",
        "signer": { "id": "alice-dba", "kind": "human", "role": "dba" } }' \
  $BASE/api/waves/wave-1/transition | jq
```

The engine refuses — this is verified-before-Jump in action
([`src/engine/gate.js`](../../src/engine/gate.js), check (4)):

```json
{ "ok": false, "error": "gate sign rejected: cutover requires a passing reconciliation proof" }
```

The wave stays at `P6`. **You cannot Jump until you reconcile.**

### Step 6 — reconcile (produce the equivalence proof)

`POST /api/reconcile` requires `migration:reconcile:run`. It runs the
reconciliation engine ([`src/engine/reconcile.js`](../../src/engine/reconcile.js))
against a connector — here the built-in **demo** connector, which simulates a clean
source→target migration and reports every pre-switch category. The six pre-switch
categories that are **hard gates** are: `replication_lag`, `row_counts`,
`checksums`, `sequence_identity`, `constraints`, `smoke`.

```bash
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{ "workloadId": "demo-db", "connector": "demo" }' \
  $BASE/api/reconcile | jq
```

```json
{
  "ok": true,
  "workloadId": "demo-db",
  "connector": "demo",
  "proofOk": true,
  "baselineFresh": true,
  "categories": [
    { "name": "replication_lag", "ok": true, "preSwitch": true, "detail": "in-flight rows: 0" },
    { "name": "row_counts", "ok": true, "preSwitch": true, "detail": "source=845231 target=845231" },
    { "name": "checksums", "ok": true, "preSwitch": true, "detail": "..." },
    { "name": "sequence_identity", "ok": true, "preSwitch": true },
    { "name": "constraints", "ok": true, "preSwitch": true },
    { "name": "smoke", "ok": true, "preSwitch": true }
  ],
  "proof": { "ok": true, "hash": "<sha256>", "unitId": "demo-db", "baselineFresh": true, "categories": [ ... ], "ts": "2026-...Z" }
}
```

Two things must be true for `proofOk` to be `true`:

1. **Every pre-switch category is `ok`** (any unreported category fails closed as
   `"not reported (fail-closed)"`).
2. **The baseline is fresh** — `baselineAt` must be within
   `VOSJ_BASELINE_MAX_AGE_MS` (default 24h). This is why we set a fresh
   `baselineAt` back in Step 1; a missing or stale baseline makes `baselineFresh`
   false and `proofOk` false, even if every category passes.

Capture the proof hash for the next step:

```bash
PROOF=$(curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{ "workloadId": "demo-db", "connector": "demo" }' \
  $BASE/api/reconcile | jq -c '.proof')
echo "$PROOF"
```

### Step 7 — reach Jump (sign the cutover gate, binding the proof)

Now re-attempt `P6 → P7`, this time threading the **passing proof** into the body.
The gate signer binds the proof's hash into the ledger evidence
([`collectEvidence`](../../src/engine/gate.js) prepends `proof:<hash>`):

```bash
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{
    \"to\": \"P7\",
    \"actor\": \"carol-engineer\",
    \"signer\": { \"id\": \"alice-dba\", \"kind\": \"human\", \"role\": \"dba\" },
    \"evidence\": [\"go-no-go:approved\"],
    \"proof\": $PROOF
  }" \
  $BASE/api/waves/wave-1/transition | jq
```

```json
{
  "ok": true,
  "wave": { "id": "wave-1", "state": "P7", ... },
  "gate": "g-reconciliation-pass",
  "ledger": {
    "seq": 6,
    "action": "gate.sign.cutover",
    "signerRole": "dba",
    "evidenceHashes": ["proof:<sha256>", "go-no-go:approved"],
    "hash": "...", "prevHash": "...",
    "meta": { "gateId": "g-reconciliation-pass", "toState": "P7", "signerId": "alice-dba", ... }
  }
}
```

The wave is now at **`P7` — Jump to BAU**. Note the cutover row's `action` is
`gate.sign.cutover` and its `evidenceHashes` begin with `proof:<hash>` — the audit
record proves the Jump was verified, by whom, and against which proof.

### Step 8 — verify the audit chain

List the ledger and re-verify the hash chain end to end
([`src/ledger/ledger.js`](../../src/ledger/ledger.js) `verifyChain`):

```bash
curl -s -H "Authorization: Bearer $TOKEN" $BASE/api/ledger | jq '.entries | length, (.[] | {seq, action, signerRole, gate: .meta.gateId})'
curl -s -H "Authorization: Bearer $TOKEN" $BASE/api/ledger/verify | jq
```

```json
{ "ok": true, "verified": true, "brokenAt": null }
```

You should have **six** signed rows: five phase gates (`gate.sign`) plus the final
cutover (`gate.sign.cutover`). `verified: true` / `brokenAt: null` means the chain is
intact — every signature is accounted for and none was forged or back-dated. (If any
row were tampered with, `verified` would be `false` and `brokenAt` would be the `seq`
of the first bad row.)

---

## 6. What just happened (and what it guarantees)

You drove one workload through all four stations and proved the platform's core
invariants without writing any code:

| Station | Phases | What you did | Invariant demonstrated |
|---------|--------|--------------|------------------------|
| **V**ault | P1–P2 | created + classified the workload (7-R) | high-risk reshape ⇒ Strangler-Fig forced (`bigBangAvailable:false`) |
| **O**rchestrate | P3–P4 | signed planning + freeze gates | role-matched human signatures, separation of duties |
| **S**hift | P5 | signed go/no-go | every gate is human-signed and on the ledger |
| **J**ump | P6–P7 | reconciled, then signed the cutover gate | **verified-before-Jump** — no proof, no Jump |

Every one of those guarantees is **structural**, enforced in the engine — not a
convention you could forget. The bearer token authorizes API calls but can never be
the gate signer; the proof hash is bound into the cutover record; the whole chain is
independently re-verifiable.

---

## 7. Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `/health` shows `"ledgerOk": false` | `VOSJ_LEDGER_HMAC_KEY` not set, or chain broken | Set the key (`openssl rand -hex 32`), restart. |
| HTTP 503 `authentication not configured: set VOSJ_AUTH_TOKEN` | `token` mode with no token | Set `VOSJ_AUTH_TOKEN` in `.env`. |
| HTTP 401 `invalid or missing bearer token` | Wrong/absent `Authorization` header | Send `Authorization: Bearer $TOKEN`. |
| HTTP 401 `auth mode 'open' is restricted to localhost` | `open` mode from a remote host | Use `token` mode for anything non-local. |
| HTTP 403 `missing capability: ...` | Principal lacks the capability | The CE token holds all CE capabilities; check you're authenticated. |
| `gate sign rejected: gate requires role 'X', signer is 'Y'` | Signer role ≠ gate's `signerRole` | Use the correct role from the Step 0 table. |
| `gate sign rejected:` (separation-of-duties) | `actor` equals `signer.id` | The work author and the gate signer must be different people. |
| `gate sign rejected: cutover requires a passing reconciliation proof` | Tried to Jump with no/failing proof | Run `POST /api/reconcile` first; thread `proof` into the transition. |
| `reconcile ... baselineFresh:false` | `baselineAt` missing or older than `VOSJ_BASELINE_MAX_AGE_MS` | Set a fresh `baselineAt` on the workload (or raise the env). |
| Data gone after restart | In-memory store | Switch to Postgres (fill `PG_*`, run `npm run migrate`). |

---

## Next steps

- **Run it on Postgres.** Fill the `PG_*` block in `.env`, run `npm run migrate`, and
  confirm `/health` reports `"store": "pg"` and `"dbConfigured": true`. Your waves and
  ledger now survive restarts.
- **Use a real connector.** The walkthrough used the built-in `demo` connector. The
  connector contract (`discover`/`replicate`/`verify`/`cutover`/`rollback`) lives in
  [`src/connectors/`](../../src/connectors/); `verify()` is what feeds the
  reconciliation proof.
- **Author your own framework template.** `caf.json` is just one file in
  [`templates/`](../../templates/). Drop in another `*.json` with the same shape
  (`phases[]` each with a `gate`) and it loads automatically at startup.

See the [user-guides index](./README.md) for sibling guides as they land.
