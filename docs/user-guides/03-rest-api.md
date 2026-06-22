# 03 — Vosj CE REST API Reference

This guide is the complete, source-accurate reference for the Vosj Community
Edition HTTP API. Every route, capability, auth mode, request body, and response
envelope below is grounded in the running code:

- Routes: [`src/api/routes.js`](../../src/api/routes.js)
- Auth + capabilities: [`src/api/auth.js`](../../src/api/auth.js)
- RBAC registry: [`src/api/rbac.js`](../../src/api/rbac.js)
- Server / mounting + `/health`: [`src/server.js`](../../src/server.js)
- Config / env vars: [`src/config.js`](../../src/config.js), [`.env.example`](../../.env.example)
- Engine facade (the work behind each route): [`src/engine/index.js`](../../src/engine/index.js)

> Sibling guides: **01 — Getting Started**, **02 — Concepts (V·O·S·J, the 7-R
> disposition engine, gates, the ledger)**, and **04 — MCP / Agent Integration**
> (the same engine driven by AI agents over MCP rather than REST). This guide
> assumes you have a Vosj instance running per guide 01.

---

## 1. Conventions

### 1.1 Base URL and mounting

The API is **mounted at the root path under `/api`** by `server.js`
(`mountOptional('./api/routes', …)`). There is no version prefix in CE. In the
examples below the base URL is:

```
VOSJ=http://localhost:8080
```

The static UI is served from `/` and the operational probe `/health` is served
**outside** the `/api` tree (it is not authenticated — see §6).

### 1.2 Response envelope

Every `/api` route returns one of exactly two JSON shapes (see `ok()` / `fail()`
in `routes.js`):

```jsonc
// success — HTTP 200
{ "ok": true,  /* ...route-specific fields... */ }

// failure — HTTP 4xx/5xx
{ "ok": false, "error": "human-readable message" }
```

Errors never leak a stack trace to the client: the `handler()` wrapper catches a
thrown error, logs it server-side, and returns `{ ok: false, error: <message> }`
with status `400` unless the route set a more specific status first (e.g. `404`).

### 1.3 Content type and body limit

All mutating routes accept `Content-Type: application/json`. The server installs
`express.json({ limit: '1mb' })`, so request bodies above **1 MB** are rejected
by Express before reaching the route.

### 1.4 Capability naming

Capabilities follow the `{domain}:{resource}:{action}` convention. Every
capability in CE is in the `migration:` domain. The full CE capability set
(`CE_CAPABILITIES` in `auth.js`) is:

```
migration:workload:write
migration:disposition:write
migration:wave:write
migration:wave:plan
migration:wave:shift
migration:reconcile:run
migration:gate:sign
migration:jump:execute
```

In CE, an authenticated principal holds the **entire set** (see §2.3), so once
you are authenticated, every `requireCapability` check below passes. The
capability annotations on each route still matter: they are recorded on the
request (`req.capability`) and document the privilege a route exercises, and they
become enforceable per-role the moment you configure RBAC (§2.4).

---

## 2. Authentication & Authorization

Authn/authz is enforced by two middlewares from `src/api/auth.js`:

- `requireAuth(ctx)` — gates **every** `/api` route. Attaches `req.principal`.
- `requireCapability(cap)` — gates **every mutation**. Requires the named
  capability on top of authentication.

### 2.1 Auth modes (`VOSJ_AUTH_MODE`)

`config.AUTH_MODE` selects the mode; the default is `token`.

| Mode | Env | Behaviour |
|------|-----|-----------|
| `token` | `VOSJ_AUTH_MODE=token` (default) | A bearer token is required on every `/api` request. **Production mode.** |
| `open` | `VOSJ_AUTH_MODE=open` | No token required — **but only for localhost callers**. A remote caller is rejected with `401`. **Localhost dev only.** |

**Fail-closed details from `auth.js`:**

- In `token` mode, if `VOSJ_AUTH_TOKEN` is **not set**, every request returns
  `503 { ok:false, error:"authentication not configured: set VOSJ_AUTH_TOKEN" }`.
  The server refuses to serve an unauthenticated API rather than defaulting open.
- In `open` mode, a non-localhost request returns
  `401 { ok:false, error:"auth mode 'open' is restricted to localhost" }`.
  "Localhost" = remote IP in `{127.0.0.1, ::1, ::ffff:127.0.0.1}` or hostname
  `localhost`/`127.0.0.1` (`isLocalRequest`).

### 2.2 Sending the token (`token` mode)

Pass the configured token as an RFC 6750 bearer token. The token is compared in
constant time (`safeEqual`):

```bash
curl -s "$VOSJ/api/templates" \
  -H "Authorization: Bearer $VOSJ_AUTH_TOKEN"
```

A missing or wrong token returns
`401 { ok:false, error:"invalid or missing bearer token" }`.

**Optional audit attribution.** Send `X-Vosj-Actor: <id>` to label the principal
for the audit ledger; otherwise the principal id defaults to `token-principal`
(see `tokenPrincipal()`). The value is truncated to 200 chars.

```bash
curl -s -X POST "$VOSJ/api/workloads" \
  -H "Authorization: Bearer $VOSJ_AUTH_TOKEN" \
  -H "X-Vosj-Actor: alice@example.com" \
  -H "Content-Type: application/json" \
  -d '{"id":"erp-core","name":"ERP Core"}'
```

### 2.3 The principal

On success `requireAuth` attaches:

```jsonc
// token mode (tokenPrincipal)
{ "id": "<X-Vosj-Actor or 'token-principal'>", "kind": "agent",
  "mode": "token", "capabilities": <full CE_CAPABILITIES set> }

// open mode (openPrincipal)
{ "id": "localhost-dev", "kind": "agent",
  "mode": "open", "capabilities": <full CE_CAPABILITIES set> }
```

> **Important — the principal is always `kind:'agent'`.** Holding a capability
> lets you *invoke* the engine; it does **not** make you a gate signer. The human
> who signs a gate is a separate identity supplied in the request body
> (`signer`), and the engine's `HumanGateSigner` rejects any signer that is not
> `kind:'human'` and independent of the actor (Invariants 1 & 2). The REST layer
> cannot grant a signature. See §4 and guide 02.

### 2.4 Optional RBAC (`VOSJ_RBAC_ROLE_CAPABILITIES`)

By default the registry is **unconfigured** and `requireCapability` uses the
principal's own capability Set (the full CE set — every mutation is allowed once
authenticated). You can additively narrow per-role behaviour by setting a JSON
map of `role → [capabilities]` (`src/api/rbac.js`). Resolution
(`holdsCapability`) is: the principal holds a capability if **either** its own
Set holds it **or** the configured registry grants it to the principal's role.

```bash
# Example registry: a 'director' may sign gates, a 'dba' may run reconciliation.
export VOSJ_RBAC_ROLE_CAPABILITIES='{"director":["migration:gate:sign"],"dba":["migration:reconcile:run"]}'
```

The registry is **fail-closed and never throws at boot**: a malformed JSON value
parses to an empty (unconfigured) registry, falling back to today's behaviour.
It only ever *grants* via an explicit role mapping — it never removes a
capability the principal already carried.

### 2.5 Failure status codes

| Status | When |
|--------|------|
| `401` | Not authenticated: bad/missing bearer token, or `open` mode from a non-localhost caller. |
| `403` | Authenticated but missing the route's capability: `{ ok:false, error:"missing capability: <cap>" }`. |
| `404` | Named resource not found (wave / workload). |
| `400` | Validation failure or any error thrown by a handler. |
| `503` | `token` mode but `VOSJ_AUTH_TOKEN` is unset (fail-closed). |

---

## 3. Route catalog (summary)

| Method | Path | Auth | Capability | Mutates |
|--------|------|------|-----------|---------|
| `GET`  | `/api/templates` | required | — | no |
| `GET`  | `/api/templates/:id` | required | — | no |
| `GET`  | `/api/workloads` | required | — | no |
| `POST` | `/api/workloads` | required | `migration:workload:write` | yes |
| `GET`  | `/api/waves` | required | — | no |
| `POST` | `/api/waves` | required | `migration:wave:write` | yes |
| `POST` | `/api/waves/:id/transition` | required | `migration:gate:sign` | yes |
| `GET`  | `/api/classify/:workloadId` | required | — | no |
| `POST` | `/api/reconcile` | required | `migration:reconcile:run` | yes (proof) |
| `GET`  | `/api/ledger` | required | — | no |
| `GET`  | `/api/ledger/verify` | required | — | no |
| `GET`  | `/health` | **none** | — | no |

All examples below assume `VOSJ` and `VOSJ_AUTH_TOKEN` are exported and add the
`Authorization: Bearer` header. In `open` localhost dev you may drop the header.

---

## 4. Routes — full reference

### 4.1 `GET /api/templates` — list framework templates

Returns the summary of every methodology template loaded from `templates/*.json`
at boot (`engine.listTemplates()`). CE ships the flagship `caf.json` template.

- **Auth:** required. **Capability:** none.
- **Request body:** none.

**Response** — each summary is built by `summary()` in `engine/index.js`:

```jsonc
{
  "ok": true,
  "templates": [
    {
      "id": "caf",
      "name": "Cloud Adoption Framework (7-phase gated)",
      "version": "1",
      "source": "flagship",
      "description": "VOSJ flagship reference framework: …",
      "phases": 7,
      "stations": ["V", "V", "O", "O", "S", "J", "J"]
    }
  ]
}
```

```bash
curl -s "$VOSJ/api/templates" -H "Authorization: Bearer $VOSJ_AUTH_TOKEN"
```

---

### 4.2 `GET /api/templates/:id` — fetch one template (full, compiled)

Returns the fully compiled, normalised template (`engine.getTemplate(id)`):
phases with their gates, the derived `states`, derived `transitions`, and the
fixed `unitStates`.

- **Auth:** required. **Capability:** none.
- **Path param:** `id` — e.g. `caf`.
- **Errors:** an unknown id throws `unknown template: <id>` → `400`.

**Response** (abridged — see `templates/caf.json` and `engine/template.js` for
the complete shape; each phase carries `id, ordinal, name, goal, station,
activities[], deliverables[], entryCriteria[], roles[], gate`):

```jsonc
{
  "ok": true,
  "template": {
    "id": "caf",
    "name": "Cloud Adoption Framework (7-phase gated)",
    "version": "1",
    "source": "flagship",
    "description": "…",
    "phases": [
      {
        "id": "P1",
        "ordinal": 1,
        "name": "Envision",
        "station": "V",
        "goal": "Strategy & business case …",
        "activities": ["motivation", "tco-value-case", "readiness-assessment", "target-platform-selection"],
        "deliverables": ["business-case", "readiness-report", "target-platforms"],
        "entryCriteria": [],
        "roles": ["director", "customer-sponsor"],
        "gate": {
          "id": "g-discovery-signoff",
          "name": "Discovery sign-off",
          "signerRole": "director",
          "signoffRoles": ["director", "customer-sponsor"],
          "requiresSignature": true,
          "criteria": ["business case approved", "readiness assessed", "target platform chosen"],
          "cutover": false
        }
      }
      /* … P2 … P7. P6 (g-reconciliation-pass) carries "cutover": true … */
    ],
    "states": ["P1", "P2", "P3", "P4", "P5", "P6", "P7"],
    "transitions": [
      { "from": "P1", "to": "P2", "gateId": "g-discovery-signoff" }
      /* … one per phase boundary, gated by the source phase's exit gate … */
    ],
    "unitStates": ["legacy", "dual_running", "reconciled", "migrated"]
  }
}
```

```bash
curl -s "$VOSJ/api/templates/caf" -H "Authorization: Bearer $VOSJ_AUTH_TOKEN"
```

---

### 4.3 `GET /api/workloads` — list workloads

Lists stored workloads (`store.listWorkloads`). Optionally filter by the wave a
workload belongs to.

- **Auth:** required. **Capability:** none.
- **Query param:** `waveId` (optional) — return only workloads with that
  `wave_id`.

**Response** — rows are stored snake_case (see `statestore.js`):

```jsonc
{
  "ok": true,
  "workloads": [
    {
      "id": "erp-core",
      "name": "ERP Core",
      "disposition": null,
      "state": "legacy",
      "wave_id": null,
      "baseline_at": null,
      "attributes": {},
      "created_at": "2026-06-22T10:00:00.000Z",
      "updated_at": "2026-06-22T10:00:00.000Z"
    }
  ]
}
```

```bash
curl -s "$VOSJ/api/workloads?waveId=wave-1" \
  -H "Authorization: Bearer $VOSJ_AUTH_TOKEN"
```

---

### 4.4 `POST /api/workloads` — create / upsert a workload

Validates and upserts a workload (`buildWorkload()` → `store.saveWorkload()`).
Upsert by `id`: posting an existing id updates that row.

- **Auth:** required. **Capability:** `migration:workload:write`.

**Request body:**

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `id` | string | **yes** | Non-empty after trim. Else `400 "workload requires an id"`. |
| `name` | string | **yes** | Non-empty after trim. Else `400 "workload requires a name"`. |
| `disposition` | string | no | A 7-R key (`Rehost`, `Replatform`, `Refactor`, `Repurchase`, `Retain`, `Retire`, `Relocate`). Stored as-is; drives `/api/classify`. Default `null`. |
| `state` | string | no | Defaults to `"legacy"`. |
| `waveId` | string | no | Stored as `wave_id`. Default `null`. |
| `baselineAt` | string | no | ISO timestamp of the reconciliation baseline. Stored as `baseline_at`. Used by the baseline-drift guard (§4.9). |
| `attributes` | object | no | Free-form. Merged into classification heuristics; may carry `rowCount`. Default `{}`. |

**Response:** `{ "ok": true, "workload": <saved row> }` (same shape as §4.3).

```bash
curl -s -X POST "$VOSJ/api/workloads" \
  -H "Authorization: Bearer $VOSJ_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
        "id": "erp-core",
        "name": "ERP Core",
        "disposition": "Replatform",
        "waveId": "wave-1",
        "baselineAt": "2026-06-22T09:00:00.000Z",
        "attributes": { "rowCount": 845231, "managedServiceTarget": true }
      }'
```

---

### 4.5 `GET /api/waves` — list waves

Lists migration waves (a wave = a run of a pinned framework template through its
phase gates). `store.listWaves()`.

- **Auth:** required. **Capability:** none.

**Response:**

```jsonc
{
  "ok": true,
  "waves": [
    {
      "id": "wave-1",
      "name": "Finance domain — wave 1",
      "state": "P1",
      "framework_template_id": "caf",
      "framework_version": "1",
      "plan": {},
      "created_at": "2026-06-22T10:00:00.000Z",
      "updated_at": "2026-06-22T10:00:00.000Z"
    }
  ]
}
```

```bash
curl -s "$VOSJ/api/waves" -H "Authorization: Bearer $VOSJ_AUTH_TOKEN"
```

---

### 4.6 `POST /api/waves` — create / upsert a wave

Validates and upserts a wave (`buildWave()` → `store.saveWave()`). Upsert by `id`.

- **Auth:** required. **Capability:** `migration:wave:write`.

**Request body:**

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `id` | string | **yes** | Non-empty after trim. Else `400 "wave requires an id"`. |
| `name` | string | **yes** | Non-empty after trim. Else `400 "wave requires a name"`. |
| `templateId` | string | no (recommended) | The framework template to run, e.g. `caf`. Stored as `framework_template_id`. **An unknown id throws `unknown template: <id>` → `400`.** A wave with no `templateId` cannot be transitioned (§4.7). |
| `state` | string | no | Initial phase state. Default `"P1"`. |
| `plan` | object | no | Free-form wave plan. Default `{}`. |

> **Version pinning.** When `templateId` is supplied, `buildWave` resolves and
> stores `framework_version` from the template at creation time. This pins the
> framework so a later template edit cannot retroactively mutate an in-flight run.

**Response:** `{ "ok": true, "wave": <saved row> }` (shape as §4.5).

```bash
curl -s -X POST "$VOSJ/api/waves" \
  -H "Authorization: Bearer $VOSJ_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "id": "wave-1", "name": "Finance domain — wave 1", "templateId": "caf" }'
```

---

### 4.7 `POST /api/waves/:id/transition` — sign a gate transition

Advance a wave from its current phase to a target phase by applying a
**human signature** to the phase's exit gate. This is the signed-gate path:
`transitionHandler` looks up the wave, builds the human signer from the body,
and calls `machine.signTransition(...)` on the wave's pinned template. The
engine validates the transition exists, requires the human signature
(`HumanGateSigner.sign`), and on success appends a row to the tamper-evident
ledger and saves the new wave state.

- **Auth:** required. **Capability:** `migration:gate:sign`.
- **Path param:** `id` — the wave id.

**Request body:**

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `to` | string | **yes** | Target phase state, e.g. `"P2"`. A transition `current → to` must exist in the pinned template, else the engine throws `no transition <from> -> <to> …`. Empty `to` → `400 "transition requires a target state: to"`. |
| `signer` | object | **yes** | The **human** approver. `signer.id` is required (`400 "transition requires signer.id"`). `signer.kind` defaults to `"human"`; the engine **rejects** a non-human signer (Invariant 1). `signer.role` should satisfy the gate's `signerRole` (e.g. `director` for `g-discovery-signoff`) — a mismatch is rejected by the engine. |
| `actor` | string | no | The agent/operator performing the step. Defaults to `req.principal.id`. **Must differ from `signer.id`** — the engine enforces separation of duties (Invariant 2) and throws if author === signer. |
| `evidence` | array | no | Evidence references (strings or objects) hashed into the ledger row. Default `[]`. |
| `proof` | object | no | A reconciliation proof object (see §4.9). **Required for a cutover gate** — the engine rejects a cutover sign without a passing proof (`proof.ok === true` and `proof.hash`). For the `caf` template the cutover gate is the P5→P6 boundary (`g-reconciliation-pass`, `cutover:true`). |

**Pre-flight 4xx from the route itself:**

- Unknown wave id → `404 "wave not found"`.
- Wave has no pinned template → `400 "wave has no pinned framework template to transition"`.

**Engine-enforced 400s (surfaced as `{ ok:false, error }`):**

- Signer is not human / actor equals signer (Invariants 1 & 2).
- Signer role does not match the gate's required `signerRole`.
- Target transition does not exist in the template.
- Cutover gate signed without a passing reconciliation proof (Invariant 6).

**Response** — note the ledger row is redacted to its audited fields
(`redactLedger`):

```jsonc
{
  "ok": true,
  "wave": { "id": "wave-1", "state": "P2", "framework_template_id": "caf", "...": "..." },
  "gate": "g-discovery-signoff",
  "ledger": {
    "seq": 1,
    "ts": "2026-06-22T10:05:00.000Z",
    "actor": "alice@example.com",
    "signerRole": "director",
    "action": "gate.sign",
    "evidenceHashes": ["readiness-report#sha256:…"],
    "meta": {
      "gateId": "g-discovery-signoff",
      "migrationId": "wave-1",
      "unitId": null,
      "fromState": "P1",
      "toState": "P2",
      "signerId": "bob@example.com",
      "capability": null
    },
    "prevHash": "0000…0000",
    "hash": "a1b2…"
  }
}
```

> The `action` is `"gate.sign.cutover"` (not `"gate.sign"`) when the gate is the
> cutover gate.

**Example — sign the P1→P2 discovery gate** (actor ≠ signer; `director` role):

```bash
curl -s -X POST "$VOSJ/api/waves/wave-1/transition" \
  -H "Authorization: Bearer $VOSJ_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
        "to": "P2",
        "actor": "alice@example.com",
        "signer": { "id": "bob@example.com", "kind": "human", "role": "director" },
        "evidence": ["readiness-report#sha256:9f86d0…"]
      }'
```

**Example — sign the cutover gate** (P5→P6 on `caf`): you must include a passing
`proof` obtained from `/api/reconcile` (§4.9). Omitting it returns
`{ ok:false, error:"gate sign rejected: cutover requires a passing reconciliation proof" }`.

```bash
curl -s -X POST "$VOSJ/api/waves/wave-1/transition" \
  -H "Authorization: Bearer $VOSJ_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
        "to": "P6",
        "actor": "alice@example.com",
        "signer": { "id": "carol@example.com", "kind": "human", "role": "dba" },
        "proof": { "ok": true, "hash": "…from /api/reconcile…", "categories": [] }
      }'
```

---

### 4.8 `GET /api/classify/:workloadId` — 7-R disposition

Runs the 7-R disposition engine (`engine.classify`) over a stored workload's
`disposition` (if set) merged with its `attributes`. If no explicit disposition
is set, a conservative heuristic chooses one; a high-risk reshape is **never**
classified as a big-bang cutover (`disposition.js`).

- **Auth:** required. **Capability:** none.
- **Path param:** `workloadId`.
- **Errors:** unknown workload → `404 "workload not found"`.

**Response:**

```jsonc
{
  "ok": true,
  "workloadId": "erp-core",
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

```bash
curl -s "$VOSJ/api/classify/erp-core" \
  -H "Authorization: Bearer $VOSJ_AUTH_TOKEN"
```

> The 7-R keys and their contracts (which are high-risk, which force
> Strangler-Fig) are documented in guide 02.

---

### 4.9 `POST /api/reconcile` — produce the equivalence proof `π(w)`

Runs the reconciliation engine against a connector to produce the equivalence
proof required before any cutover (`engine.reconcile`). The returned `proof` is
the object you hand to the cutover transition in §4.7 — no proof, no Jump.

- **Auth:** required. **Capability:** `migration:reconcile:run`.

**Request body:**

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `workloadId` | string | **yes** | Empty → `400 "reconcile requires a workloadId"`. Unknown → `404 "workload not found"`. |
| `connector` | string | no | Connector id. Defaults to `"demo"` (the built-in `DemoConnector`). An unregistered id throws `unknown connector: <id>` → `400`. |

**How `ok` is decided** (`reconcile.js`): the proof passes only when **all** of —

1. the connector reports `ok`,
2. every pre-switch category is proven `ok`
   (`replication_lag`, `row_counts`, `checksums`, `sequence_identity`,
   `constraints`, `smoke` — any unreported category fails closed), and
3. the baseline is **fresh** (`baselineFresh`): the workload's `baseline_at` is
   within `VOSJ_BASELINE_MAX_AGE_MS` (default 24h). A missing baseline is **not**
   fresh — the baseline-drift guard rejects a proof against a stale/absent
   baseline.

**Response:**

```jsonc
{
  "ok": true,
  "workloadId": "erp-core",
  "connector": "demo",
  "proofOk": true,
  "baselineFresh": true,
  "categories": [
    { "name": "replication_lag",  "ok": true, "detail": "in-flight rows: 0", "preSwitch": true },
    { "name": "row_counts",       "ok": true, "detail": "source=845231 target=845231", "preSwitch": true },
    { "name": "checksums",        "ok": true, "detail": "content hashes match (simulated)", "preSwitch": true },
    { "name": "sequence_identity","ok": true, "detail": "…", "preSwitch": true },
    { "name": "constraints",      "ok": true, "detail": "…", "preSwitch": true },
    { "name": "smoke",            "ok": true, "detail": "…", "preSwitch": true }
  ],
  "proof": {
    "ok": true,
    "unitId": "erp-core",
    "connector": "demo",
    "baselineFresh": true,
    "categories": [ /* same as above */ ],
    "connectorProof": { "...": "..." },
    "ts": "2026-06-22T10:10:00.000Z",
    "hash": "c0ffee…"
  }
}
```

```bash
curl -s -X POST "$VOSJ/api/reconcile" \
  -H "Authorization: Bearer $VOSJ_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "workloadId": "erp-core", "connector": "demo" }'
```

> **End-to-end cutover.** A passing reconcile makes `proof.ok === true`. Pass that
> whole `proof` object into the cutover transition (§4.7). If `proofOk` is
> `false` — e.g. because `baselineFresh` is `false` for a workload with no recent
> `baseline_at` — the cutover gate will reject the signature. Refresh the
> workload's `baselineAt` (§4.4) within the freshness window first.

---

### 4.10 `GET /api/ledger` — read the audit ledger

Returns every ledger row (`ledger.list({})`), redacted to its audited fields
(`redactLedger`). The ledger is a hash-chained, HMAC-signed record of every
signed gate transition.

- **Auth:** required. **Capability:** none.

**Response:**

```jsonc
{
  "ok": true,
  "entries": [
    {
      "seq": 1,
      "ts": "2026-06-22T10:05:00.000Z",
      "actor": "alice@example.com",
      "signerRole": "director",
      "action": "gate.sign",
      "evidenceHashes": ["readiness-report#sha256:…"],
      "meta": { "gateId": "g-discovery-signoff", "migrationId": "wave-1", "...": "..." },
      "prevHash": "0000…0000",
      "hash": "a1b2…"
    }
  ]
}
```

```bash
curl -s "$VOSJ/api/ledger" -H "Authorization: Bearer $VOSJ_AUTH_TOKEN"
```

---

### 4.11 `GET /api/ledger/verify` — verify the hash chain

Recomputes the HMAC-SHA256 chain over the entire ledger and reports whether it
is intact (`ledger.verifyChain()`). Detects any forged, edited, or back-dated
row.

- **Auth:** required. **Capability:** none.

**Response:**

```jsonc
// intact chain
{ "ok": true, "verified": true,  "brokenAt": null }

// tampered chain — brokenAt is the seq of the first bad row
{ "ok": true, "verified": false, "brokenAt": 3 }
```

> `ok:true` here means the *request* succeeded; **`verified`** is the integrity
> result. Treat `verified:false` (or a non-null `brokenAt`) as a tamper alarm.

```bash
curl -s "$VOSJ/api/ledger/verify" -H "Authorization: Bearer $VOSJ_AUTH_TOKEN"
```

> **Fail-closed key.** Signing/verifying requires `VOSJ_LEDGER_HMAC_KEY` (no
> default). If it is unset, gate signing in §4.7 fails closed
> (`ledger fail-closed: VOSJ_LEDGER_HMAC_KEY is not set`) and `/health` reports
> `ledgerOk:false`. See guide 01 / `.env.example`.

---

## 5. The end-to-end flow over REST

Putting the routes together for one wave, against the in-memory store with the
built-in demo connector:

```bash
export VOSJ=http://localhost:8080
export AUTH="-H Authorization:Bearer $VOSJ_AUTH_TOKEN -H Content-Type:application/json"

# 1. See the flagship template and its gates.
curl -s "$VOSJ/api/templates/caf" $AUTH

# 2. Create a wave that runs the caf template (pins framework_version).
curl -s -X POST "$VOSJ/api/waves" $AUTH \
  -d '{"id":"wave-1","name":"Finance — wave 1","templateId":"caf"}'

# 3. Register a workload (set a fresh baselineAt for the drift guard).
curl -s -X POST "$VOSJ/api/workloads" $AUTH \
  -d '{"id":"erp-core","name":"ERP Core","disposition":"Replatform",
       "waveId":"wave-1","baselineAt":"'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'",
       "attributes":{"rowCount":845231}}'

# 4. Confirm the disposition (Replatform => strangler-fig, no big-bang).
curl -s "$VOSJ/api/classify/erp-core" $AUTH

# 5. Walk the phase gates with human signatures (actor != signer, correct role).
curl -s -X POST "$VOSJ/api/waves/wave-1/transition" $AUTH \
  -d '{"to":"P2","actor":"alice","signer":{"id":"bob","kind":"human","role":"director"}}'
#    … repeat for each phase boundary up to the cutover gate (P5 -> P6) …

# 6. Produce the equivalence proof before cutover.
PROOF=$(curl -s -X POST "$VOSJ/api/reconcile" $AUTH \
  -d '{"workloadId":"erp-core","connector":"demo"}')
echo "$PROOF"   # proofOk should be true; copy the .proof object

# 7. Sign the cutover gate, passing the passing proof.
curl -s -X POST "$VOSJ/api/waves/wave-1/transition" $AUTH \
  -d '{"to":"P6","actor":"alice","signer":{"id":"carol","kind":"human","role":"dba"},
       "proof": '"$(echo "$PROOF" | node -e 'process.stdin.on("data",d=>process.stdout.write(JSON.stringify(JSON.parse(d).proof)))')"' }'

# 8. Read and verify the audit trail.
curl -s "$VOSJ/api/ledger" $AUTH
curl -s "$VOSJ/api/ledger/verify" $AUTH   # expect verified:true
```

---

## 6. `/health` (not part of `/api`, unauthenticated)

`server.js` mounts an operational probe at `/health` that returns **real**
metrics — store kind/health, ledger integrity, and live workload/wave counts. It
is intentionally unauthenticated so liveness/readiness probes (and the Helm
chart) can reach it.

```jsonc
{
  "ok": true,
  "version": "0.1.0",
  "uptime": 123.45,
  "store": "memory",        // or "pg"
  "storeOk": true,
  "dbConfigured": false,
  "ledgerOk": true,         // false if VOSJ_LEDGER_HMAC_KEY is unset or chain broken
  "workloads": 1,
  "waves": 1
}
```

```bash
curl -s "$VOSJ/health"
```

---

## 7. Configuration reference (env vars that affect the API)

From `src/config.js` / `.env.example`:

| Env var | Default | Effect on the API |
|---------|---------|-------------------|
| `VOSJ_PORT` | `8080` | HTTP listen port. |
| `VOSJ_AUTH_MODE` | `token` | `token` (bearer required) or `open` (localhost only). |
| `VOSJ_AUTH_TOKEN` | _(empty)_ | Bearer token for `token` mode. Empty in `token` mode → `503` on every `/api` call. |
| `VOSJ_RBAC_ROLE_CAPABILITIES` | _(empty)_ | Optional JSON `role→[caps]` map; additively grants capabilities by role (§2.4). |
| `VOSJ_LEDGER_HMAC_KEY` | _(empty, REQUIRED)_ | Signs/verifies the ledger. Empty → gate signing fails closed, `ledgerOk:false`. |
| `VOSJ_BASELINE_MAX_AGE_MS` | `86400000` (24h) | Baseline-freshness window for `/api/reconcile` (drift guard). |
| `VOSJ_STATE_STORE` | `pg` if DB configured, else `memory` | Backing store for workloads/waves/ledger. |
| `PG_HOST` / `PG_PORT` / `PG_USER` / `PG_PASSWORD` / `PG_DATABASE` | _(empty)_ | When all of host/user/database are set, the DB is "configured" and the default store becomes `pg`. |
| `VOSJ_DB_SSL_REJECT_UNAUTHORIZED` | `true` | Set `false` to accept a CloudNativePG self-signed cert. |

---

## 8. Quick error map

| `{ ok:false, error }` | Status | Fix |
|-----------------------|--------|-----|
| `authentication not configured: set VOSJ_AUTH_TOKEN` | 503 | Set `VOSJ_AUTH_TOKEN` (token mode). |
| `invalid or missing bearer token` | 401 | Send the correct `Authorization: Bearer` header. |
| `auth mode 'open' is restricted to localhost` | 401 | Use `token` mode for remote callers. |
| `missing capability: <cap>` | 403 | The principal's role lacks the capability (only possible with a configured RBAC registry). |
| `wave not found` / `workload not found` | 404 | Create the resource first (§4.4 / §4.6). |
| `workload requires an id` / `… a name` | 400 | Supply non-empty `id` and `name`. |
| `wave has no pinned framework template to transition` | 400 | Create the wave with a `templateId`. |
| `no transition <from> -> <to> …` | 400 | Target a state reachable from the current one. |
| `transition requires signer.id` | 400 | Supply `signer.id`. |
| `gate requires role '<r>', signer is '<s>'` | 400 | Use a signer whose `role` matches the gate's `signerRole`. |
| `gate sign rejected: cutover requires a passing reconciliation proof` | 400 | Run `/api/reconcile` and pass the resulting `proof` (with `ok:true`). |
| `unknown template: <id>` / `unknown connector: <id>` | 400 | Use a known template/connector id. |

---

*See also: guide 02 for the conceptual model behind gates, the 7-R engine and the
ledger; guide 04 for driving the same engine via the MCP server.*
