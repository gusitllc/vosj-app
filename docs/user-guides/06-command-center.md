# 06 — The Command Center (Web UI)

The **Command Center** is Vosj CE's built-in web console. It is a single focused
board — three live panels backed by the REST API — that lets a human operator
watch a migration's phases, see the 7-R disposition contracts the engine will
enforce, **sign a gate transition**, and **verify the tamper-evident ledger** with
one click.

It is intentionally minimal: vanilla JavaScript + `fetch` + DOM, no framework, no
CDN. Every server-supplied value is HTML-escaped before it touches the page
([`public/app.js`](../../public/app.js) `esc()`), so the board is safe to point at
a live system.

> The Command Center is a *read-mostly* control surface. The only mutation it
> performs is **signing a gate** (`POST /api/waves/:id/transition`). Creating
> workloads, waves, and running reconciliation are driven from the API — see
> [01 — Getting Started](./01-getting-started.md) for the full create→classify→
> wave→sign→reconcile→Jump walkthrough.

Reference source: [`public/app.html`](../../public/app.html),
[`public/app.js`](../../public/app.js), and the routes it calls in
[`src/api/routes.js`](../../src/api/routes.js).

---

## 1. Accessing the board

The UI is served as **static files from `public/`** at the web root. `server.js`
mounts it with `express.static(public/)` *after* the API and MCP modules
([`src/server.js`](../../src/server.js)), so once Vosj is running:

```
http://<host>:<VOSJ_PORT>/app.html
```

`VOSJ_PORT` defaults to `8080` ([`src/config.js`](../../src/config.js)), so the
local URL is usually:

```
http://localhost:8080/app.html
```

`index.html` (the home/landing page) is at `/`; the Command Center board is the
`app.html` page linked from it (the board's header carries a "← Home" link back).

There is no separate build step or login page — the board loads, immediately
calls `GET /health`, and renders. If your deployment requires a bearer token
(the default), the data panels will show an auth error until you enter the token
(next section).

---

## 2. The auth token field (the "Bearer" box)

In the top bar there is a **`Bearer`** field — a password-style input labelled
`AUTH_TOKEN (blank = open/localhost)` — plus **Save** and **Refresh** buttons.

```
[ Bearer  ●●●●●●●● ]  [ Save ]  [ Refresh ]
```

How it works ([`public/app.js`](../../public/app.js)):

- Whatever you type becomes the `Authorization: Bearer <token>` header on **every**
  API call (`authHeaders()`). This is exactly the scheme
  [`src/api/auth.js`](../../src/api/auth.js) expects in `token` mode.
- **Save** persists the token to the browser's `localStorage` under the key
  `vosj.token`, so it survives a page reload (it is loaded back into the field on
  `DOMContentLoaded`). It is *not* sent anywhere on Save — it is only used as the
  bearer header on subsequent requests.
- **Refresh** re-runs all four panel loads + a chain verify (`refreshAll()`).

What token to enter:

| `VOSJ_AUTH_MODE` | What to put in the Bearer field |
|------------------|---------------------------------|
| `token` (default) | The exact value of `VOSJ_AUTH_TOKEN`. A blank or wrong value → every data panel shows `HTTP 401 — invalid or missing bearer token`. |
| `open` (localhost dev only) | Leave it **blank**. In `open` mode a localhost request is auto-authenticated; a remote caller is still rejected `401`. |

> Security note: the field is a password input and the token lives only in this
> browser's `localStorage`. Treat the bearer token like a shared secret — anyone
> with it can drive every mutation the CE principal is allowed (it cannot, however,
> forge a human gate signature; see [07 — Operations](./07-operations.md#rbac)).

---

## 3. The health strip

Directly under the top bar is a live **health strip** populated from
`GET /health` ([`src/server.js`](../../src/server.js) `mountHealth`). It is the
fastest way to confirm the server, store, and ledger are sound. Each item is a
coloured dot + a value drawn straight from the `/health` envelope:

| Strip item | `/health` field | Meaning |
|------------|------------------|---------|
| `version` | `version` | The running CE version (from `package.json`). |
| `store` | `store` + `storeOk` | The active StateStore kind — `pg` or `memory` — and whether it answered a health probe. |
| `ledger` | `ledgerOk` | `ok` when the HMAC key is set **and** the chain currently verifies; `unsigned` when no `VOSJ_LEDGER_HMAC_KEY` is configured (fail-closed). |
| `workloads` | `workloads` | Count of workloads in the store. |
| `waves` | `waves` | Count of waves in the store. |
| `uptime` | `uptime` | Process uptime in seconds. |

If `/health` is unreachable the strip shows a red dot and the network error inline
— it never throws into the console.

> A `ledger` reading of `unsigned` is your warning that signing will **fail
> closed**: `POST /api/waves/:id/transition` cannot write a ledger row without a
> key. See [07 — Operations §2](./07-operations.md#ledger).

---

## 4. Panel 1 — Waves (phase & gate signing)

The **Waves** panel (`GET /api/waves`) is the operational heart of the board. Each
wave is rendered as a card showing:

- **Name** and **id**, plus the bound **framework template** (e.g. `caf`). A wave's
  template is pinned at kickoff (`framework_version`), so a later template edit
  can never mutate a running wave.
- **Current phase** — the wave's `state` (e.g. `P1`, `P5`), shown as a teal chip.
- **Valid next states** — one *next-card* per allowed transition. These come from
  the bound template's transition rows
  ([`src/engine/state-machine.js`](../../src/engine/state-machine.js)
  `listValidNextStates`), not from a hardcoded list. If there are none you'll see
  *"No valid next states (terminal phase or no template bound)."*

Each next-card shows the **gate** that guards the transition: its gate id, the
required **signer role** (e.g. `director`, `dba`, `infosec`), and the gate's
machine-checkable **criteria** as a bullet list (e.g. *"business case approved",
"readiness assessed"* for the CAF P1 gate). A **cutover** gate is highlighted and
tagged with a `cutover` chip — that is the verified-before-Jump gate that requires
a passing reconciliation proof.

### Signing a gate

Inside each next-card is a small **sign form** with two inputs and a **Sign gate**
button:

| Field | Maps to | Notes |
|-------|---------|-------|
| **Signer ID** | `signer.id` | Required. The human's identity, e.g. `jane.doe`. |
| **Role** | `signer.role` | Pre-filled with the gate's required `signerRole`; editable. |

Pressing **Sign gate** sends:

```http
POST /api/waves/<waveId>/transition
Authorization: Bearer <token>
Content-Type: application/json

{ "to": "<target state>",
  "signer": { "id": "jane.doe", "kind": "human", "role": "director" } }
```

The UI always sends `kind: "human"` for the signer. The engine
([`src/engine/gate.js`](../../src/engine/gate.js)) then **structurally** enforces,
and will reject the sign with a clear error if violated:

- **No agent self-sign** — `signer.kind` must be `human` (Invariant 1).
- **Separation of duties** — the signer cannot be the same identity as the change
  author (Invariant 2).
- **Role match** — if the gate names a `signerRole`, the signer's role must equal
  it, else: *"gate requires role 'director', signer is 'dba'"*.
- **Criteria** — machine-checkable criteria must be satisfied.
- **Verified-before-cutover** — a `cutover` gate requires a passing reconciliation
  proof (`proof.ok === true` with a `proof.hash`), else the sign is refused.

On success a toast shows `Gate signed → <state>`, the wave advances, a new ledger
row is written, and the board re-loads the Waves, Ledger, and health panels. On
rejection a red toast surfaces the engine's reason — nothing partially applies.

> The Command Center supplies the *human signer identity* in the request body; the
> bearer token only authorises that the caller may *attempt* a sign
> (`migration:gate:sign`). The token can never **be** the signer — that identity is
> validated by the engine. See [07 — Operations §3](./07-operations.md#rbac).

---

## 5. Panel 2 — The 7-R disposition board

The **7-R Disposition Board** renders the typed migration contracts the engine
applies to every in-scope workload (`GET /api/dispositions`; if the API does not
expose it, the board falls back to the same canonical static table). Each card is
a contract `⟨executor, runbook, reconciliation profile, cutover style⟩`:

| Disposition | Meaning | Executor | Cutover style | Risk |
|-------------|---------|----------|---------------|------|
| **Retire** | Decommission; no migration. | none | none | standard |
| **Retain** | Keep at source (regulatory/technical). | none | none | standard |
| **Rehost** | Lift-and-shift to IaaS. | rehost | big-bang | standard |
| **Relocate** | Move hypervisor wholesale. | relocate | **strangler-fig** | high-risk |
| **Repurchase** | Drop-and-shop to SaaS. | repurchase | big-bang | standard |
| **Replatform** | Lift-and-reshape (e.g. managed DB). | replatform | **strangler-fig** | high-risk |
| **Refactor** | Re-architect cloud-native. | refactor | **strangler-fig** | high-risk |

The board exists to make one safety property *visible*: a **high-risk reshape**
(Relocate / Replatform / Refactor) resolves **only** to incremental
**Strangler-Fig** cutover — those cards carry a `Strangler-Fig only` chip and a
`high-risk` tag. A big-bang plan for these is **structurally unavailable** in the
engine; the board is the read-only confirmation of that contract, not a place to
override it.

This panel is informational — it has no controls. To classify a specific workload,
call `GET /api/classify/:workloadId` (see [01 — Getting Started](./01-getting-started.md)).

---

## 6. Panel 3 — The tamper-evident ledger console

The **Tamper-Evident Ledger** panel is the audit surface. It has two controls —
**Verify Chain** and **Reload** — a status chip, and a table.

### The ledger table

`GET /api/ledger` returns the redacted, queryable rows
([`src/api/routes.js`](../../src/api/routes.js) `redactLedger`). The table columns:

| Column | Field | Notes |
|--------|-------|-------|
| **Seq** | `seq` | Monotonic sequence number (the chain order). |
| **Time** | `ts` | ISO timestamp of the signed event. |
| **Actor** | `actor` | Who/what initiated (may be `—`). |
| **Role** | `signerRole` | The signing role recorded on the row. |
| **Action** | `action` | e.g. `gate.sign`, `gate.sign.cutover`, `waiver.use`. |
| **Evidence** | `evidenceHashes` | The *count* of evidence hashes bound to the row (e.g. a `proof:<hash>`). |
| **Hash** | `hash` | The row's HMAC-SHA256, truncated to the first 16 hex chars + `…`. |

Each row is one immutable, signed event. The `hash` is computed over the previous
row's hash plus this row's canonical content, which is what makes the log a *chain*
rather than a list.

### Verify Chain

Clicking **Verify Chain** calls `GET /api/ledger/verify`, which re-walks the entire
chain server-side ([`src/ledger/ledger.js`](../../src/ledger/ledger.js)
`verifyChain`) and returns `{ verified, brokenAt }`. The status chip reflects the
result:

| Chip | Condition |
|------|-----------|
| `chain: intact` (green) | `verified === true`, `brokenAt === null`. Every row's `prevHash` links and every HMAC recomputes. |
| `chain: BROKEN at seq N` (red) | The first row whose link or HMAC fails — `N` is its `seq`. Indicates a forged, back-dated, deleted, or re-ordered row. |
| `chain: <error>` (red) | Verify could not run — most often the HMAC key is not configured (the ledger is `unsigned`). |

`Reload` re-fetches the rows without re-verifying. A full **Refresh** (top bar) does
both: it reloads every panel and then verifies the chain.

> If you ever see `chain: BROKEN`, **stop**: the audit trail has been tampered
> with at or after `seq N`. The operational response — and how to confirm the same
> result from the CLI — is in [07 — Operations §2](./07-operations.md#ledger).

---

## 7. Error handling & the response envelope

Every API call the board makes returns the standard envelope, and the UI handles
both shapes uniformly:

- **Success** — `{ "ok": true, ... }` → the panel renders.
- **Failure** — `{ "ok": false, "error": "<message>" }` (or a non-2xx HTTP status)
  → the panel shows an inline red banner and/or a toast carrying `error`, and the
  rest of the board keeps working. The UI never throws an uncaught error into the
  browser console.

Common messages and what they mean:

| You see | Cause |
|---------|-------|
| `HTTP 401` / `invalid or missing bearer token` | Wrong/blank Bearer in `token` mode. |
| `authentication not configured: set VOSJ_AUTH_TOKEN` (`503`) | `token` mode but the server has no `VOSJ_AUTH_TOKEN`. |
| `missing capability: migration:gate:sign` (`403`) | The principal lacks the capability for the sign (see [07 §3](./07-operations.md#rbac)). |
| `Gate sign rejected: ...` | The engine refused the signature (role mismatch, self-sign, missing proof). |
| `chain: <error>` on verify | Ledger HMAC key not set — signing/verifying is failing closed. |

---

## See also

- [01 — Getting Started](./01-getting-started.md) — the full end-to-end CLI/API
  walkthrough that creates the waves this board displays.
- [07 — Operations](./07-operations.md) — running Vosj in production: config,
  ledger custody & chain verification, RBAC, waivers, health, and Postgres vs.
  memory.
- Source of truth if a guide and the code disagree (the code wins):
  [`public/app.html`](../../public/app.html),
  [`public/app.js`](../../public/app.js),
  [`src/api/routes.js`](../../src/api/routes.js).
