# Vosj Community Edition — PURPOSE

> **Formation artifact 2 of 7.** Read order: CORE-IDEA → **PURPOSE** → DESIGN → COST-MODEL → IMPLEMENTATION-PLAN → DEPLOYMENT → IMPLEMENTATION-TRACKER.csv.
>
> **Status: FORMATION** (no code is written for this suite until the independent PhD Senior-Engineer review in IMPLEMENTATION-PLAN.md signs off).
>
> **Authoring discipline:** every factual claim is anchored to the authoritative design — the IP white paper at `e:/apps/vosj/site/whitepaper.html` (cited by section id, e.g. §5/§9/§12/§14/§15) — or to the CE positioning in `change-management/vosj-community-edition/site/index.html`. Every forward-looking number is marked **[ASSUMPTION]**. No metrics are fabricated.
>
> **Binding foundation:** the white paper (authoritative design) and the Formation Standard in `e:/apps/Luca-express-prod/CLAUDE.md` ("App / Game / Big-Task Formation Standard").
>
> «Chaque migration est un voyage» — every migration is a voyage.

---

## §0. One-sentence purpose

Vosj Community Edition exists to give any team a **free, source-available, self-hosted engine that turns application migration and replatforming from an artisanal, vendor-siloed, unaudited craft into an observable, gated, verified, repeatable assembly line** — with the migration *plumbing* fully open and **bring-your-own-AI**, while the managed AI labour force (the moat) remains the closed Enterprise add-on.

---

## §1. What it is

Vosj CE is the **open part of the Vosj migration factory**: the four-station V·O·S·J engine, the data-driven gated framework, the plugin contracts that make it extensible, and the AI-native execution fabric that an operator drives with their *own* AI — packaged as a standalone, self-hosted artifact (Helm chart / container / CLI), not a hosted SaaS.

### 1.1 The engine — four named stations (white paper §5.1, Fig 1)

The brand letters **are** the finite-state-machine stages of every migration. Each station is observable, audited, and metered (§5.3).

| Letter | Station | What it does |
|--------|---------|--------------|
| **V** | **Vault** | Discover & assess: inventory, dependency DAG, data model, risk/effort/TCO, 7-R recommendation, CI/CD 365° maturity — produces the signed bill-of-materials. |
| **O** | **Orchestrate** | Plan the wave: target + landing zone, the 7-R decision per workload, executor selection, cutover sequence, an **independently authored** rollback runbook, feature-flag strategy. |
| **S** | **Shift** | Migrate incrementally: Strangler-Fig parallel run (old + new serve together); each piece tracked `legacy → dual-running → migrated`. |
| **J** | **Jump** | Cut over & verify: flagged final cutover, target-vs-source equivalence proof `π(w)`, record the deploy, decommission legacy — **fail-closed: a non-verified cutover is an unreachable state, not a policy violation** (§6.1, §13). |

### 1.2 The contribution surface — five plugin contracts (CE site `index.html`; white paper §16.2, §8)

CE is built to be extended by the community. Everything specific to a *source platform*, a *target platform*, a *storage backend*, a *signing authority*, or a *CI/CD scanner* enters through a stable seam:

- **`Connector`** — `discover · replicate · verify · cutover · rollback`. **`verify()` is mandatory** on every connector; a connector that cannot prove equivalence cannot reach Jump.
- **`Executor`** — a point-to-point `migrate-<source>-to-<target>` engine with its own internal state machine (`draft → validated → executing → completed | failed → rolling-back → rolled-back`) and pre-flight checks the station conductor invokes but never bypasses (§16.2).
- **`StateStore`** — the system-of-record persistence (migrations, station events, inventory items, gate sign-offs); PostgreSQL by default (white paper §14).
- **`GateSigner`** — **human-only, fail-closed** authorisation of a gate transition (HMAC-signed, RBAC-bound). No agent identity is ever minted with a `sign-as-<role>` capability (Invariant 1 / VG-01, §12).
- **`AssessmentProvider`** — the CI/CD & DevOps 365° scorecard plug-in (§17).

### 1.3 The AI-native execution fabric (in CE — BYO-AI)

CE ships the *substrate* an operator uses to put AI to work, but supplies **no AI of its own**:

- **MCP Hub / server** — the open, JSON-RPC 2.0 control plane (transports: `stdio` + Streamable HTTP) over which AI clients reach governed tools and the platform exposes services. Acts as an OAuth 2.1 resource server (audience-validated per RFC 8707) (white paper §9; MCP spec). **The MCP server is the CE↔EE seam: CE supplies the server; you bring the AI client.**
- **Devstation pods** — identity-isolated, hardened-`RuntimeClass` in-cluster agent/IDE pods that claim work from a durable DB-backed queue and execute on their own clone (white paper §10). In CE these run under the operator's **own model credentials/seats**; in EE they are driven by the managed Luca AI.
- **Command Center + live infra view** — the control surface for the fabric (CE site `index.html`).

### 1.4 The CE bill-of-materials (what you actually get)

The V·O·S·J station engine · the signed phase-gate FSM + all six structural invariants (Inv. 1–6 / VG-01, VG-05, VG-07, VG-10, VG-14, VG-15) · the data-driven framework **template engine** + the CAF flagship template + clone/create · the **7-R disposition engine** · the **MCP Hub** (outbound + inbound, durable order queue, per-tool RBAC, allow-lists, tool-call audit) · the **devstation fleet** as BYO-AI in-cluster pods · the **reconciliation engine** · the **executor catalog + provider registry + fail-closed credential vault** · the **CI/CD 365° assessment** · the **exportable governance evidence package** (VG-26).

---

## §2. Why it exists

### 2.1 The migration tax is a manufacturing problem dressed as an engineering problem (white paper §2.1, §3)

The individual steps of a migration — disk replication, image conversion, database migration, DNS cutover — are each solved problems. The cost is not the steps; it is that the steps are **uncoordinated, unrepeatable, unaudited, and human-bound**. The white paper names five components of this "migration tax": (1) toolchain churn, (2) reinvention per engagement, (3) opaque risk and big-bang cutovers, (4) unaudited execution, (5) the human bottleneck — throughput scaling linearly with a scarce supply of senior migration engineers. Vosj's reason to exist is to **structurally remove that tax** rather than to add one more point tool to the churn.

### 2.2 There is no neutral, open, governed migration engine

Every existing migration accelerator is either (a) a *vendor-specific* tool that pulls you toward one cloud, (b) a *proprietary* consultancy framework locked in slideware, or (c) a *point tool* with no audit, no gates, and no concept of "verified before cutover." Vosj CE exists to be the missing **neutral control plane** (white paper requirement R1) — open, source-available, and self-hosted, so that the safety properties (signed gates, separation of authority, verified-before-Jump, fail-closed vault) belong to the operator, not to a vendor's roadmap.

### 2.3 Open-core wedge: productize the substrate we already own

The platform already owns a real ~60–75% migration substrate — a library of `migrate-<source>-to-<target>` executors, a provider registry, a credential vault, reconciliation, and CI/CD scanners (white paper §16.2; CE site). Vosj CE **productizes and unifies** that substrate under one open engine ("extend, do not fork" — §5). Giving the plumbing away builds adoption, a contributor community, and trust; the **managed AI labour + per-engineer digital twins** — the part that turns the factory autonomous — is what converts adoption into Enterprise revenue. The plumbing is open; the AI brain is the add-on.

### 2.4 AI can finally do the toil — but only inside a governance envelope (white paper §2.2)

Tool-using LLM agents can now perform migration toil *if* they are given (a) a standard way to reach tools (MCP) and (b) a governance envelope (the gated framework engine + the six safety invariants). Vosj is the composition of those two around the migration domain. CE ships the envelope and the tool channel as open source so that **anyone can run autonomous migration safely**, regardless of which AI they bring.

---

## §3. Who it serves

| Persona | Who they are | What CE gives them | Why they choose CE over EE |
|---------|--------------|--------------------|----------------------------|
| **Self-hosting platform/DevOps team** | Runs their own AKS / on-prem K8s; migrating their own estate | The full V·O·S·J engine, gates, reconciliation, and executor catalog inside their own cluster — no data leaves their boundary | Data residency and control; no per-seat AI bill; bring their existing AI seats |
| **Migration / cloud MSP** | Delivers migrations for clients | A repeatable, audited factory they can stand up per engagement and walk an auditor through (VG-26 export) | Brand-neutral, self-hosted per client; upgrade to EE only when they want managed AI labour |
| **Regulated enterprise (eval / pilot)** | Large, heterogeneous, audit-sensitive estate | A POC-ready engine where the safety properties are *structural* and re-derivable (white paper App I), not promised in a slide | Proves the governance model on their own tenant before committing to managed AI |
| **Open-source contributor** | Wants to add a source/target/storage/signer/scanner | A clean five-contract plugin seam (`Connector`/`Executor`/`StateStore`/`GateSigner`/`AssessmentProvider`) and a public CAF template to clone | Open source under Apache-2.0; contributions land in the open core (inbound = outbound, §5) |
| **Primary test/reference operator** | Deploys onto **AKS enabled by Azure Arc on Azure Local (Azure Stack HCI)** | A fully documented reference deployment on the hardest realistic substrate (on-prem K8s, MetalLB, CSI VHDX, CloudNativePG) | The exact target the engine is hardened and end-to-end tested against (DESIGN §3; DEPLOYMENT) |

**Buyer-vs-contributor split.** The *buyer* of CE wants a safe, neutral, self-hosted migration engine and is the upgrade path to EE. The *contributor* wants a clean, well-documented seam to extend; CE serves them with the five plugin contracts and the Apache-2.0 grant (inbound = outbound, with its explicit patent grant). Both are first-class.

---

## §4. What success looks like

Success is measured against the white paper's evaluation dimensions (§20, App I.4). Structurally-enforced properties have an **expected violation count of zero** — any non-zero value is a defect in the engine, not a bad outcome to be tolerated.

### 4.1 Hard requirements (must be true; non-negotiable)

- **Zero unverified cutovers.** Every workload that reaches Jump carries a complete verified-before-cutover proof `π(w)`. The count of cutovers without proof is **0** — and is *structurally* 0, because Jump is unreachable without it (white paper §6.1, §13, VG-10).
- **Zero self-signed gates.** The count of gates signed by the same identity that performed the work, or by any agent identity, is **0** (Invariant 1 / VG-01, §12).
- **Fail-closed vault verified.** With no master key present, the credential vault refuses (no dev-key fallback); the deliberate negative test passes (Invariant 5 / VG-15, §15.2, App I.3).
- **Tamper-evident ledger re-derivable.** The exportable evidence package (VG-26) — hash-chained HMAC-SHA256 gate ledger with the key custodied **outside** the database — can be independently re-computed, not screenshotted (§12.6, §14.4, App I.3).

### 4.2 Adoption & community signals (open-core funnel — leading indicators)

- **Time-to-first-verified-Jump (TTV):** the median elapsed time from `helm install` (or container/CLI start) to a contributor's first workload reaching a verified Jump on a representative wave. **[ASSUMPTION]** target measured during the POC and tracked thereafter.
- **Contributed connectors/executors:** count of community-authored `Connector`/`Executor`/`AssessmentProvider` plugins merged into the open core — the primary health metric for the contribution surface.
- **Verified cutovers performed by CE operators** across the install base (self-reported / telemetry-opt-in only, since CE is self-hosted).
- **CE → EE / consulting conversion rate:** the share of CE adopters who request the managed Luca AI add-on or consulting — the open-core monetisation signal (see COST-MODEL.md).

### 4.3 Engine-quality signals (white paper §20)

- **Throughput:** workloads cut over per unit of *human supervision* (review, not headcount, is the real ceiling — §20).
- **Reconciliation rigor:** post-cutover defect-escape rate trends to zero.
- **Reversibility:** fraction of waves with a *rehearsed* (tabletop) rollback; rollback MTTR.
- **Delivery maturity:** customer DORA metrics before vs after the CI/CD 365° engagement (§17).

---

## §5. What it is NOT

Stating the boundaries explicitly is part of the purpose — it keeps the CE↔EE line, and the safety line, unambiguous.

- **NOT the managed AI.** CE is **bring-your-own-AI**. It does **not** include the managed Luca AI personas or the per-engineer digital twins, nor the self-improvement / "dreaming" learning loop run as a service. Those are the **closed Enterprise add-on** (white paper §11; CE site). CE ships the *fabric* (MCP server + devstation pods + Command Center); the *AI brain that drives it autonomously off-hours* is EE. **The plumbing is open; the AI brain is the add-on.**
- **NOT a hosted SaaS.** CE is self-hosted, local-first, **no account required**. There is no Vosj-operated control plane, no Stripe billing, no per-tenant SaaS namespace isolation, no metering bill on us. Multi-tenant SaaS isolation and managed hosting belong to the closed/managed plane, not CE.
- **NOT closed.** CE source is open under **Apache-2.0** (see §6). The migration *content* (7-R taxonomy, Strangler-Fig, public APIs) is public knowledge; the open core is the *operationalised combination* of that content into a governed engine — and that engine is in the open.
- **NOT a lift-without-verify tool.** Vosj will not produce a big-bang plan for a high-risk disposition: Refactor and Relocate dispositions resolve only to runbook templates that emit incremental, parallel-run (Strangler-Fig) steps — a big-bang plan for those is *physically unavailable* (white paper §7 callout, VG-05). And no cutover can complete without a verified equivalence proof (VG-10). If you want "copy the disk and pray," Vosj is the wrong tool.
- **NOT a single-VM express tool (today).** The full Vault→Verify discipline is overkill for a single-VM lift-and-shift; an "express" template that streamlines the gate set is acknowledged future work and must **never** drop the verified-before-cutover gate (white paper §22, §23).
- **NOT a Luca Express module.** CE is its **own standalone repository** (`e:/apps/vosj/vosj-app`), not a domain inside the Luca gateway. The Luca Golden Rules (token-engine bridge, `aios-core-db` facade, AIOS Shell) are **not literally binding** on the CE codebase; CE carries over their *spirit* (config-driven, fail-closed gates, mandatory `verify()`, auth on every route, parameterised SQL) and DESIGN.md states precisely which apply (DESIGN §2, §7).
- **NOT a guarantee against a poisoned agent.** The invariants bound *capability*, not *intent*; a prompt-injected or poisoned agent can misuse tools it already holds. The **human-signed gate is the load-bearing backstop** for every irreversible step (cutover, decommission, credential rotation) — Vosj is honest that this, not the agent, is what makes irreversible actions safe (white paper §12 warn callout, §15.5).

---

## §6. Compliance & license posture (baked into purpose)

### 6.1 License — Apache 2.0, permissive open source with an explicit patent grant

CE is licensed under the **Apache License 2.0** (`Apache-2.0`) — stated on the CE site: *"open source under the Apache License 2.0."* This means:

- **Permissive open source.** Anyone may use, read, modify, self-host, distribute, and sell the source — including inside closed or proprietary products — free of charge.
- **Explicit patent grant + retaliation.** Every contributor grants a royalty-free, irrevocable patent license to their contribution; that grant terminates for any party that brings patent litigation against the work — protecting the prior art behind the design (created and authored by Gustavo Assuncao, backed by technical publications).
- **Attribution propagates.** Redistribution must retain the `LICENSE`, mark modified files, and reproduce the `NOTICE` file — which credits **Gustavo Assuncao / Gus IT LLC** as the original creator and author (Apache §4(d)).
- The **managed AI personas + per-engineer digital twins remain proprietary EE** — they are *not* under Apache-2.0 and *not* part of CE.

Project owner: **Gus IT LLC**; original creator & author **Gustavo Assuncao** ("Vosj — an open-source project of Gus IT LLC.").

### 6.2 Data handling is the operator's responsibility (because CE is self-hosted)

Because CE runs **inside the operator's own cluster** with the operator's **own credentials and AI seats**, the data-protection posture (white paper §15.4 — DPA, sub-processor disclosure, SCCs, data-loss liability) is the **operator's** to satisfy, not a Vosj-operated obligation. CE *enables* that posture structurally — schema-per-domain isolation, per-tenant filtering, default-deny egress, fail-closed vault, external HMAC key, exportable VG-26 evidence (§14, §15.8) — but the legal sign-off before processing live regulated data sits with the self-hosting operator. (When the operator wants Vosj to carry that responsibility, that is the managed EE plane.)

### 6.3 Governance posture CE delivers out of the box

CE bakes the six structural invariants and the engine-enforced, **non-waivable** controls into the data model and engine itself: VG-01 (no self-sign), VG-05 (Strangler-Fig forced for high-risk dispositions), VG-07 (baseline-drift guard), VG-10 (verified-before-cutover), VG-14 (tamper-evident ledger), VG-15 (fail-closed vault) (white paper §12, App G). The exportable evidence package (VG-26) cross-references each artifact to **ISO/IEC 38500, COBIT 2019, ITIL 4, SOC 2 CC8.1, and SOX ITGC** (§12.6) — so an operator can hand an auditor a re-derivable control story, in CE, at no cost.

---

## §7. Cross-references

- **CORE-IDEA.md** — the one-sentence essence, the V·O·S·J table, the plugin seam, the non-negotiables, the CE↔EE editions split.
- **DESIGN.md** — where CE lives (standalone repo), the engine + five plugin contracts, the AKS-on-Azure-Local execution fabric, the phase-gate FSM, connector lifecycle, CI/CD 365° scorecard, the StateStore data model, the BYO-AI (MCP) vs closed Luca-AI EE seam — with mermaid diagrams.
- **COST-MODEL.md** — the open-core funnel economics (near-zero CE COGS; revenue is EE upsell + consulting).
- **IMPLEMENTATION-PLAN.md** — phased plan, engineering roster, stage-gate mechanics, the end-to-end test use case on AKS-Arc-on-Azure-Local, Research Foundations, and the independent PhD Senior-Engineer review & sign-off (the Formation gate).
- **DEPLOYMENT.md** — the self-hosted CE install runbook (Helm chart / container / CLI) on AKS enabled by Azure Arc on Azure Local — distinct from the Luca-gateway deploy airlock.
- **Authoritative design:** `e:/apps/vosj/site/whitepaper.html` (cite §5/§9/§12/§14/§15).
- **CE positioning:** `change-management/vosj-community-edition/site/index.html`.
