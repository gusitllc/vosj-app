# Vosj Community Edition — User Guides

These guides are for **operators and engineers running Vosj CE** — driving a real
application-migration through the four stations **Vault → Orchestrate → Shift → Jump**.
They are not contributor docs (for those, see [`CONTRIBUTING.md`](../../CONTRIBUTING.md)
and the design suite in [`docs/`](../)).

Vosj is **fail-closed**: a cutover ("Jump") is structurally unreachable until a
passing reconciliation proof and an independent human signature exist, and every
gate signature is written to a tamper-evident, hash-chained ledger. The guides
below walk you through that discipline from a clean install to a verified Jump.

| Guide | What it covers |
|-------|----------------|
| [01 — Getting Started](./01-getting-started.md) | Install (Node ≥ 20), configure `.env` (the two required fail-closed secrets), run `npm start`, check `/health`, and a full first end-to-end walkthrough: create a workload → classify (7-R) → create a wave from a template → sign the gates → reconcile → reach Jump. |
| [06 — The Command Center](./06-command-center.md) | The built-in web UI (`/app.html`): the auth-token (Bearer) field, the live health strip, the Waves panel (phase + gate signing via `POST /api/waves/:id/transition`), the 7-R disposition board, and the ledger console with one-click chain-verify. |
| [07 — Operations](./07-operations.md) | Running Vosj in production: the full `src/config.js` env reference, the tamper-evident ledger + chain verification & key custody, the RBAC capability model, advisory waivers (what can and cannot be waived), `/health` metrics, Postgres vs. in-memory, and backups. |
| [08 — The POC Demo: Command Center, Seats & Devstations](./08-poc-demo-and-seats.md) | The live `vosj-poc` demo: the public URLs (`demo`/`seats`/`seat1-5.vosj.com`), how to log in to each surface, and how to assign a Claude credential to a devstation seat (Hybrid → OAuth key, AI-only → API key) with the **Seat Manager**. |

> Additional guides (templates & frameworks, the 7-R disposition contracts,
> connectors, and the reconciliation/equivalence proof) cross-link from here as
> they are added. Start with **01 — Getting Started**; it is self-contained.

## Quick orientation

- **Stations** — every framework template maps its phases onto four stations:
  **V**ault (discover/baseline/decide), **O**rchestrate (plan/landing-zone),
  **S**hift (execute the cutover), **J**ump (verify/reconcile and hand to BAU).
- **The engine facade** (`ctx.engine`) is what the REST API, MCP, and UI all call:
  template loading, the 7-R disposition classifier, the signed-gate state machine,
  the gate signer, and the reconciliation engine.
- **The ledger** (`ctx.ledger`) is the system of record for every signature.
  `GET /api/ledger/verify` re-checks the whole hash chain.
- **Fail-closed secrets** — `VOSJ_LEDGER_HMAC_KEY` and `VOSJ_VAULT_MASTER_KEY`
  have **no defaults**. Their absence is detected at use-time and the operation
  refuses to proceed; Vosj never silently substitutes a development key.

## Reference source (read these if a guide and the code ever disagree — the code wins)

| Concern | File |
|---------|------|
| Entrypoint, `ctx` assembly, `/health` | [`src/server.js`](../../src/server.js) |
| Configuration & env vars | [`src/config.js`](../../src/config.js), [`.env.example`](../../.env.example) |
| REST API routes & envelopes | [`src/api/routes.js`](../../src/api/routes.js) |
| Auth & capabilities | [`src/api/auth.js`](../../src/api/auth.js) |
| 7-R disposition contracts | [`src/engine/disposition.js`](../../src/engine/disposition.js) |
| Signed-gate state machine | [`src/engine/state-machine.js`](../../src/engine/state-machine.js) |
| Gate signing rules | [`src/engine/gate.js`](../../src/engine/gate.js) |
| Reconciliation / equivalence proof | [`src/engine/reconcile.js`](../../src/engine/reconcile.js) |
| Tamper-evident ledger | [`src/ledger/ledger.js`](../../src/ledger/ledger.js) |
| Flagship CAF template | [`templates/caf.json`](../../templates/caf.json) |
