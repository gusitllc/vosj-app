<div align="center">

# Vosj — Community Edition

**An open-source, self-hosted, AI-native migration factory.**

*Turn artisanal, vendor-siloed application migration into an observable, audited, gated, verified, repeatable assembly line.*

</div>

---

## What is Vosj?

Migrating and replatforming applications is usually a bespoke, risky, one-off project: tribal knowledge, manual runbooks, "big-bang" cutovers, and no proof that the new system actually behaves like the old one. **Vosj makes migration an engineering discipline** — a factory with stations, gates, and verification, where every step is recorded in a tamper-evident ledger and **no cutover can happen until equivalence is proven**.

The brand letters **are** the engine. A workload moves through four stations:

| | Station | What it does | Exit gate |
|---|---------|--------------|-----------|
| **V** | **Vault** | **Discover & assess** — inventory, dependency graph, data model, risk/effort/TCO, and a 7‑R disposition (Rehost, Replatform, Refactor, Repurchase, Retain, Retire, Relocate) → a signed bill‑of‑materials. | Discovery sign‑off *(human)* |
| **O** | **Orchestrate** | **Plan the wave** — target & landing zone, the 7‑R decision, executor selection, cutover sequence, an **independently authored** rollback runbook, and a feature‑flag strategy. | Planning sign‑off *(human)* |
| **S** | **Shift** | **Migrate incrementally** — Strangler‑Fig parallel run: old and new serve together while each unit moves `legacy → dual‑running → migrated`. No big‑bang for high‑risk workloads. | Go / No‑Go *(human panel)* |
| **J** | **Jump** | **Cut over & verify** — flag‑gated final cutover, an equivalence proof `π(w)` across six categories, then decommission the legacy. | **Verified‑before‑Jump *(human, mandatory, non‑removable)*** |

### Non‑negotiable invariants (baked into the code, not waivable)

- **🔒 Verified‑before‑Jump** — a non‑verified cutover is *structurally unreachable*. The cutover gate is injected into every template and cannot be removed.
- **✍️ No agent self‑sign** — gates are signed by **humans only**; the author of a step can never be its approver.
- **🧾 Tamper‑evident ledger** — every transition is hash‑chained (HMAC‑SHA256); the chain is independently verifiable and the signing key is **fail‑closed** (no default).
- **🪢 Strangler‑Fig forced for high‑risk** — the disposition engine refuses a big‑bang for high‑risk workloads.
- **🕰️ Baseline‑drift guard** — an equivalence proof against a stale baseline is rejected.

## Community Edition (this repo)

The **Community Edition (CE)** is the complete migration engine, **self‑hosted** and **bring‑your‑own‑AI**:

- ✅ The full V·O·S·J engine: templates, signed‑gate state machine, 7‑R disposition, reconciliation/equivalence proof, tamper‑evident ledger.
- ✅ Plugin contracts so you can write your own **Connectors** and **Executors**.
- ✅ An MCP server + devstation substrate so *your* AI agents can drive the factory.
- ✅ PostgreSQL‑backed (with an in‑memory mode for evaluation), container + Helm deploy.
- ❌ No SaaS, no per‑seat billing, no cloud control plane.

> The CE is **bring‑your‑own‑AI**. Managed Luca AI personas and per‑engineer digital twins are part of the commercial **Enterprise Edition** — they are *not* in this repository.

## Quick start

```bash
# 1. Install (Node.js >= 20)
npm install

# 2. Configure — copy the example and set the two fail-closed secrets
cp .env.example .env
#   VOSJ_LEDGER_HMAC_KEY  and  VOSJ_VAULT_MASTER_KEY  are REQUIRED (no defaults).
#   Generate strong values, e.g.:  openssl rand -hex 32
#   With no PG_* set, Vosj runs against an in-memory store (great for a first look).

# 3. Run the tests (engine invariants, FSM, 7-R, gates)
npm test

# 4. Start it
npm start
#   -> Vosj CE listening on :8080
curl localhost:8080/health     # real metrics: store/ledger health, workload/wave counts
```

### Docker

```bash
docker build -t vosj-ce .
docker run --rm -p 8080:8080 \
  -e VOSJ_LEDGER_HMAC_KEY=$(openssl rand -hex 32) \
  -e VOSJ_VAULT_MASTER_KEY=$(openssl rand -hex 32) \
  vosj-ce
```

### Kubernetes (Helm)

A Helm chart lives in [`deploy/helm/vosj`](deploy/helm/vosj). The primary tested target is **AKS enabled by Azure Arc on Azure Local**; managed cloud AKS works too. See [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

## Architecture

Vosj is a small, dependency‑light Node.js engine (Express + `pg`) organized around **five plugin contracts** — the contribution surface:

| Contract | Responsibility | Notes |
|----------|----------------|-------|
| **`Connector`** | `discover · replicate · verify · cutover · rollback` for a source/target pair | **`verify()` is mandatory** |
| **`Executor`** | run one runbook step (internal `draft → validated → executing → completed \| failed → rolling-back → rolled-back` FSM) | |
| **`StateStore`** | persistence | PostgreSQL by default; in‑memory for eval |
| **`GateSigner`** | record human gate signatures | **human‑only, fail‑closed, no agent self‑sign** |
| **`AssessmentProvider`** | CI/CD & DevOps 365° readiness scorecard | |

The **engine facade** (`buildEngine({ config, store, ledger })`) composes the template engine, signed‑gate state machine, 7‑R disposition engine, reconciliation/equivalence proof, gate signer, and ledger. The HTTP spine (`src/server.js`) mounts optional feature modules (`api`, `mcp`, `ui`) so the server always boots and serves a real `/health`.

```
src/
├── server.js          HTTP spine; mounts /health + optional api/mcp/ui
├── config.js          frozen, env-driven config; fail-closed secrets
├── contracts/         the five plugin base classes
├── engine/            template · state-machine · disposition (7-R) · gate · reconcile
├── ledger/            tamper-evident HMAC hash-chained ledger
├── db/                pool · schema.sql · statestore (memory + pg)
├── connectors/        demo (working reference) + azure-arc/hyperv/sdk scaffolds
├── api/               REST surface (requireAuth / requireCapability)
├── mcp/               MCP server + durable order queue   (bring-your-own-AI seam)
└── ui/                Command Center · live infra view · ledger console
templates/             framework templates (e.g. caf.json — Cloud Adoption Framework)
deploy/helm/vosj/      Helm chart (AKS Arc primary target)
docs/                  CORE-IDEA · PURPOSE · DESIGN · DEPLOYMENT
test/                  node:test suites (invariants, FSM, 7-R)
```

## Configuration

All behavior is config‑driven (`.env` / environment). Key variables (see [`.env.example`](.env.example)):

| Variable | Required | Purpose |
|----------|----------|---------|
| `VOSJ_PORT` | no (8080) | HTTP port |
| `VOSJ_LEDGER_HMAC_KEY` | **yes** | HMAC key for the tamper‑evident ledger — fail‑closed, no default |
| `VOSJ_VAULT_MASTER_KEY` | **yes** | Master key for vaulted secrets — fail‑closed, no default |
| `PG_HOST/PORT/USER/PASSWORD/DATABASE` | no | PostgreSQL; omit for in‑memory eval mode |
| `VOSJ_AUTH_MODE` | no (`token`) | `token` (set `VOSJ_AUTH_TOKEN`) or `open` (localhost dev only) |
| `VOSJ_DB_SSL_REJECT_UNAUTHORIZED` | no (`true`) | set `false` for self‑signed CNPG certs |

## Status & roadmap

The engine core (templates, signed‑gate FSM, 7‑R disposition, reconciliation, ledger, demo connector, invariant tests) is **built and green**. Surfaces are being completed in the open:

- ✅ **Engine, ledger, contracts, 7‑R, gates, reconciliation, demo connector, tests**
- 🔨 **REST API** (`src/api`) · **MCP server + durable order queue** (`src/mcp`) · **UI** (`src/ui`) · **Helm manifests** (`deploy`)

Track progress in the repo's Issues/Projects.

## Contributing

Connectors and Executors are the heart of the community. See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the plugin guide and contribution workflow. Every `Connector` **must** implement a genuine `verify()` — equivalence proof is the whole point.

## License

**Business Source License 1.1 (BSL‑1.1)** — source‑available; free for internal and non‑production use. The Additional Use Grant permits production use *except* offering Vosj to third parties as a competing hosted/managed migration service. Each release converts to **Apache‑2.0** on its Change Date (4 years). See [`LICENSE`](LICENSE).

*Managed Luca AI and per‑engineer digital twins (Enterprise Edition) are proprietary and not covered by this license.*
