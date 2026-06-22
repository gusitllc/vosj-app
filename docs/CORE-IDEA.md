# Vosj Community Edition — CORE-IDEA

> **Motto:** «Chaque migration est un voyage.» — *Every migration is a voyage.*
> **Status:** FORMATION (artifact 1 of 7). **Read order:** CORE-IDEA → PURPOSE → DESIGN → COST-MODEL → IMPLEMENTATION-PLAN → DEPLOYMENT → IMPLEMENTATION-TRACKER.csv.
> **Authoring discipline:** every factual claim is anchored to the authoritative design — the IP white paper at `e:/apps/vosj/site/whitepaper.html` (cited by section id, e.g. §5/§9/§12/§14/§15) — and to this repo. Every number that is not in the white paper is marked `[ASSUMPTION]`. No fabricated metrics.
> **Binding foundation:** the white paper (authoritative design) + the Luca *App / Game / Big-Task Formation Standard* (`e:/apps/Luca-express-prod/CLAUDE.md`). The locked invariants below are not settings — they are laws of the product, drawn from the white paper's structural guarantees (§6.1, §7, §12, §13, §14.1) and the CE program positioning.
> **Owner:** Gus IT LLC. **License:** Business Source License 1.1 (`BUSL-1.1`), converting to a GPL-compatible Change License on the Change Date.

---

## 1. One-sentence essence

Vosj Community Edition is an **open-source, self-hosted, AI-native migration factory** that turns artisanal, vendor-siloed application migration and replatforming into an **observable, audited, metered, largely autonomous assembly line** — four named stations (**V·O·S·J**), a data-driven gated framework engine, and an MCP-commanded fleet of identity-isolated coding agents — where **no agent can authorise (sign) its own gate** and **no workload can cut over before it is proven equivalent to its source** (white paper Abstract, §1.2, §6.1).

---

## 2. The name & the motto — the letters *are* the stations

Vosj is not an acronym bolted onto a product; the four brand letters **are** the stages of the migration state machine (white paper Claim 1, §5.1). A migration is a voyage through four stations, in order:

| Letter | Station | What happens here (white paper §5.1) | Hard exit |
|--------|---------|--------------------------------------|-----------|
| **V** | **Vault** | *Discover & assess.* Build the inventory, the dependency DAG, the data model; score risk / effort / TCO; run the CI/CD & DevOps 365° maturity scan; assign a **7-R disposition** to every in-scope workload → emit the signed bill-of-materials. | Discovery sign-off (human) |
| **O** | **Orchestrate** | *Plan the wave.* Choose target + landing zone, the 7-R decision per workload, the executor, the cutover sequence, the **independently authored** rollback runbook, and the feature-flag strategy. | Planning sign-off (human) |
| **S** | **Shift** | *Migrate incrementally.* Strangler-Fig parallel run — old and new serve together; each piece tracked `legacy → dual-running → migrated`. Big-bang is structurally unavailable for high-risk dispositions. | Go/No-Go (human panel) |
| **J** | **Jump** | *Cut over & verify.* Flagged final cutover, the source-vs-target **equivalence proof** `π(w)`, record the deploy, decommission legacy. **Fail-closed: a non-verified cutover is an unreachable state.** | Verified-before-Jump (human, mandatory on every template) |

The motto «Chaque migration est un voyage» is the product's organising metaphor: a voyage has stations, a manifest, a captain who signs, and a destination you can prove you reached.

---

## 3. The problem

Migration is a **manufacturing problem dressed as an engineering problem** (white paper §2.1, §3). The individual steps — disk replication, image conversion, database migration — are *already solved*. The cost, the "migration tax," is that those steps are **uncoordinated, unrepeatable, unaudited, and human-bound**. The white paper decomposes the tax into five components (§3):

1. **Toolchain churn** — every engagement re-assembles a different, throwaway pipeline of point tools.
2. **Reinvention per engagement** — methodology lives in people's heads and slide decks, not in executable form.
3. **Opaque risk / big-bang cutovers** — high-risk transforms are pushed through all-at-once switchovers with no rehearsed reverse.
4. **Unaudited execution** — who did what, against which evidence, with whose authority, is not attributable or tamper-evident.
5. **The human bottleneck** — throughput scales linearly with a scarce, expensive pool of senior migration engineers.

On top of this sits a market gap: there is **no neutral, open, self-hostable engine** for running migrations as a governed assembly line. Existing tools are vendor-locked to a single cloud, are closed SaaS, or are loose collections of scripts with no gate, no proof, and no separation of duties. An audit-sensitive organisation that wants to *own* its migration control plane — on its own cluster, with its own AI seats, with a tamper-evident record it can hand to an auditor — has nowhere to go.

---

## 4. The solution

Vosj CE composes two maturing technologies around the migration domain (white paper §2.2): **tool-using LLM agents** that can perform the toil, and a **governance envelope** that bounds what they can do. The result is a four-station factory with a small, sharp set of moving parts.

### 4.1 The four-station factory

The V·O·S·J state machine (§3) is the spine. Each station is **observable, audited, and metered** (§5.3). Every phase exits through a **gate** — an FSM transition that requires *both* (a) machine-checked criteria **and** (b) a human cryptographic signature by a named role: *"machines verify facts; humans accept accountability"* (§6.1). The whole pass is governed by five formal constraints from the white paper's formal framing (§3.1): **Ordering** (cutover respects the dependency DAG), **Continuity** (source serves until the equivalence proof holds), **Reversibility** (rehearsed independent rollback), **Auditability** (attributable + tamper-evident), and **Authority separation** (the performer is never the authoriser).

### 4.2 The five plugin contracts — the contribution surface

Vosj CE is built to be *extended, not forked* (white paper §5). Everything cloud- or tool-specific lives behind five small contracts, which are also the open-source contribution surface:

- **`Connector`** — the source/target adapter. Implements `discover · replicate · verify · cutover · rollback`. **`verify()` is mandatory** — a connector that cannot prove equivalence cannot be registered.
- **`Executor`** — a point-to-point `migrate-<source>-to-<target>` engine with its own internal state machine (`draft → validated → executing → completed | failed → rolling-back → rolled-back`) and pre-flight checks the station conductor invokes but never bypasses (§16.2).
- **`StateStore`** — the system-of-record (default: PostgreSQL, schema-per-domain, §14).
- **`GateSigner`** — the signing authority for gate transitions. **Human-only and fail-closed** — agent identities are minted *without* any `sign-as-<role>` capability (§12 Invariant 1, Claim 7).
- **`AssessmentProvider`** — the CI/CD & DevOps 365° scorecard producer (§17).

### 4.3 The AI-native execution substrate

Work is dispatched through an **MCP Hub** (JSON-RPC 2.0; `stdio` + Streamable HTTP transports; §9) and a **durable DB-backed order queue** — an operator (human or supervising agent) enqueues a work order; a target **devstation** claims it atomically and executes on its own isolated clone (§9.2, Claim 4). A devstation is an autonomous, sandboxed software-engineering agent running under a **hardened RuntimeClass** (gVisor / Kata / Firecracker) with its **own identity, own repository clone, own model credential, and own source-control credential** (§10). The fleet mirrors a human org — architect, builder, reviewer, tester, migrator, fixer, deployer — which is exactly how it **enforces separation of duties** (§10.1). **In CE you bring your own AI**: the MCP server and the devstation pods are open; the model seats are the operator's.

---

## 5. What makes it different

1. **Open-source and self-hosted, not a vendor's SaaS.** Source-available under **BSL 1.1**; runs entirely on the operator's own cluster, local-first, no account required, no data leaves the operator's tenant.
2. **The letters are the engine.** V·O·S·J is a literal finite state machine, not branding (Claim 1) — the product *is* its governance.
3. **Methodology is data, not code.** A data-driven framework template engine lets a consultant **select / clone / create** a methodology (CAF flagship, factory-style, cloned, or custom); signing, gate persistence, oversight roles, and RBAC are reused unchanged (Claim 2, §8).
4. **Disposition is a typed contract, not advice.** The 7-R engine treats each workload's disposition as a gate *precondition*: the kickoff gate cannot pass until every in-scope workload carries one, and the plan selects runbook + executor *strictly* from it (Claim 3, §7).
5. **The riskiest transforms physically cannot do a big-bang.** Refactor and Relocate dispositions resolve only to runbook templates that emit incremental, parallel-run steps — a big-bang plan for them is *uninstantiable* (§7 callout).
6. **Verified-before-Jump is structural.** The final Shift→Jump gate is injected by the engine on *every* template and cannot be removed by a template author — a non-verified cutover is an **unreachable state**, not a policy violation (Claim 8 — the strongest claim, §6.1, §14.1).
7. **No agent signs its own gate.** Authority separation is enforced in the identity model, not by convention (Claim 7, §12).
8. **Open plumbing, closed brain.** The V·O·S·J engine, framework-template model, MCP server, devstation substrate, Command Center, live infra view, connector/executor catalog, reconciliation engine, fail-closed vault, CI/CD 365° assessment, and the exportable evidence package are **all open in CE**. The **moat that stays closed** is the **managed Luca AI** — the AI personas + per-engineer digital twins that drive the fabric autonomously off-hours (§11) — plus SSO/RBAC/audit/support. **The plumbing is open; the AI brain is the add-on.**
9. **Primary test target is on-prem hybrid.** Vosj CE is validated first on **AKS enabled by Azure Arc on Azure Local (Azure Stack HCI)** — proving the factory runs where regulated, audit-sensitive estates actually live, not only on a hyperscaler.

### Editions at a glance

| | **Community Edition (CE)** | **Enterprise Edition (EE)** |
|---|---|---|
| License | BSL 1.1 (→ GPL-compatible on Change Date) | Proprietary |
| Hosting | Self-hosted, local-first | Self-hosted or Vosj-managed |
| AI | **Bring your own** (own MCP client + model seats), or drive by hand | **Managed Luca AI** — personas + per-engineer digital twins, self-improvement/"dreaming" loop |
| Engine, gates, invariants, templates, MCP server, devstation pods, connectors, vault, CI/CD 365°, evidence package | ✅ Included | ✅ Included |
| Managed AI labour, SSO, enterprise RBAC, hosted audit, support/SLA | — | ✅ Add-on |

---

## 6. Non-negotiables

These are immutable for Vosj CE. They derive from the white paper's structural invariants (§12, Appendix G controls VG-01/05/07/10/14/15) and the CE positioning; the engine enforces them in the data model and refuses to operate without them.

1. **Verified-before-Jump is fail-closed and non-removable.** No workload cuts over without a passing equivalence proof `π(w)`; the gate is engine-injected on every template (VG-10, §6.1).
2. **No agent self-signs a gate.** Persona identities are minted without any `sign-as-<role>` capability; the human-signed gate is the load-bearing backstop for every irreversible step (VG-01, Invariant 1).
3. **Separation of authoring and authorising.** Performer ≠ approver; the rollback runbook is authored by a *different* agent than the migration runbook (Invariant 2).
4. **Tamper-evident transitions.** Every gate transition is an HMAC-SHA256-signed, hash-chained row; the signing key is custodied **outside** the database (VG-14, §14.1, §14.4).
5. **Fail-closed by default.** No key → the vault refuses (no dev-key fallback); a stale baseline blocks readiness; missing verification blocks cutover. **Absence of positive proof is failure** (VG-15, VG-07, Invariant 5).
6. **`verify()` is mandatory on every Connector.** A connector that cannot prove equivalence cannot be registered or run.
7. **Strangler-Fig is forced for high-risk dispositions.** Refactor/Relocate emit only incremental, parallel-run steps (VG-05, §7).
8. **Auth on every data route; capability check on every mutation.** `requireAuth` + `requireCapability`; advancing, cutover, and decommission are owner/admin-gated (§12.1).
9. **Config-driven, zero hardcoding.** Every value that controls behaviour — endpoints, thresholds, residency/region pins, IP pools, model seat references — is configurable; secrets are env/secret-referenced, never inlined.
10. **Feature-flagged incomplete surface.** Any unfinished user-facing capability ships behind `VOSJ_CE_ENABLED` (and finer per-surface flags), never half-built and live.
11. **CE never ships the moat.** The managed Luca AI personas/twins and the self-improvement loop are EE-only; CE ships the substrate and the BYO-AI seam, never the managed brain.

> **Applicability note (CE is its own codebase).** Vosj CE is a *standalone* repository (`e:/apps/vosj/vosj-app`), not part of Luca Express. The Luca Golden Rules that name Luca-internal primitives (the `token-engine.js` bridge, the `aios-core-db` facade, the AIOS Shell components) are **not literally binding** here. Their *spirit* is carried over and made CE-native: a single LLM bridge abstraction (no direct provider SDK in engine code), a single DB facade with parameterised SQL only, escape all user-rendered content, uniform `{ ok, ... }` response envelopes, and config-driven everything.

---

## 7. Open questions (resolved downstream)

These are surfaced here and answered in DESIGN / IMPLEMENTATION-PLAN — no code is written until the Formation suite (incl. the PhD sign-off) exists.

- **Q1 — Default StateStore HA shape.** Single PostgreSQL vs CloudNativePG quorum-sync (≥3) for CE out-of-the-box? *(→ DESIGN §7; white paper §14.4 mandates quorum-sync + external HMAC key for the ledger in production.)*
- **Q2 — Starter connector/executor set for CE v1.** Which `migrate-<source>-to-<target>` executors and connectors ship in the box vs. arrive via community contribution? *(→ DESIGN §5, IMPLEMENTATION-PLAN; primary test target = AKS Arc on Azure Local.)*
- **Q3 — Framework templates seeded in CE.** CAF flagship only, or also a factory-style and a skeleton? *(→ DESIGN §4; white paper §8.3.)*
- **Q4 — BYO-AI client reference.** Does CE ship a reference MCP client / CLI driver so the engine is usable with no AI at all (hand-driven)? *(→ DESIGN §8.)*
- **Q5 — "Express" single-VM template.** Out of scope for v1 (it must never drop verified-before-cutover); tracked as future work (white paper §22/§23).
- **Q6 — BSL Additional Use Grant + Change Date wording.** Exact grant (self-hosted, non-competing production use) and the ≤4-year Change Date per release. *(→ PURPOSE §6, COST-MODEL.)*

---

## 8. Research foundations (pointer)

The cited external research — AKS enabled by Azure Arc on Azure Local, on-prem networking (MetalLB + ingress-nginx), CSI storage, the Model Context Protocol (transports + OAuth 2.1 / RFC 8707 audience binding), the 7-R taxonomy, the Strangler-Fig and migration-factory precedents, CloudNativePG, and BSL 1.1 — is consolidated in the **Research Foundations** appendix of `IMPLEMENTATION-PLAN.md`, with full URLs. The authoritative product design remains the white paper at `e:/apps/vosj/site/whitepaper.html`.
