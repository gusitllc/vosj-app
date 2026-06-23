# Vosj CE — Database HA, RPO & RTO (whitepaper §14.4)

**Package:** `PKG-PG-HA-VALUES` · **Gap:** 146 (whitepaper §14.4 durability) ·
**Status:** chart-codified (config-as-code); live provisioning is a deploy-time action.

> **The ledger is the system-of-record whose durability this RPO protects.**
> Vosj CE persists its tamper-evident, HMAC-SHA256, hash-chained **ledger** —
> together with templates, workloads, waves, gates, waivers, and the tool log —
> in PostgreSQL (`vosj` schema, `src/db/schema.sql`). The ledger is the audit
> spine of every signed gate and every Jump. **A lost WAL segment is a lost audit
> row.** The RPO below is therefore an *audit-integrity* target, not merely a
> data-loss target: the durability guarantee exists to keep the chain complete
> and verifiable (`Ledger.verifyChain`, `src/ledger/ledger.js`).

---

## 1. What §14.4 requires, and what is codifiable today

Whitepaper §14.4 states the PostgreSQL system-of-record runs with **quorum-based
synchronous replication (≥3 instances), continuous backup, WAL archiving, and
point-in-time recovery (PITR), with a stated ledger RPO/RTO**, and that the HMAC
signing key is custodied **outside** the database.

That requirement splits cleanly:

| Aspect | Where it lives | Honest status |
|--------|----------------|---------------|
| Quorum sync replication (≥3), WAL archiving, base backups, PITR window | **Chart config** (`deploy/helm/vosj/templates/postgres-cluster.yaml` + `values.postgresHA`) | **Codified now** — the chart renders a valid CloudNativePG (CNPG) `Cluster` CR. |
| HMAC signing key custodied outside the DB | App + chart (`src/config.js` reads `VOSJ_LEDGER_HMAC_KEY` from env/Secret; never persisted) | **Already implemented** (gap 314/315 in the §14.4 audit). |
| A *running* quorum-replicated cluster + a **tested restore** | The live cluster | **Deploy-time / operator action** (DEPLOYMENT.md §7.1). Not CE runtime code. |

This is an **infra (build/config) deliverable**: the actual quorum-replicated
cluster cannot honestly be marked "done" as CE code, but the **manifest plus the
stated RPO/RTO** are codifiable and are codified here.

---

## 2. The codified HA posture (rendered by the chart)

`postgresHA.enabled` defaults to **false** so the in-memory and single-PVC POC
paths (`deploy/poc`, the `postgres:16-alpine` StatefulSet) are unaffected. When an
operator opts in, `templates/postgres-cluster.yaml` renders a CNPG `Cluster` with:

- **`instances: 3`** (≥3 enforced — the template **fails the render** if set
  below 3 while enabled; quorum needs an odd majority);
- **Quorum-based synchronous replication** via `.spec.postgresql.synchronous`
  (`method: any`, `number: 1`, `dataDurability: required`) — equivalent to
  `synchronous_standby_names = "ANY 1 (...)"`. A commit is acknowledged to the
  client only after **at least one standby** has confirmed the WAL write, so a
  confirmed ledger append is on **≥2 nodes** before the client sees `ok`. Legacy
  `minSyncReplicas`/`maxSyncReplicas` are emitted alongside for older CNPG;
- **`dataDurability: required`** (the fail-closed durability mode) — CNPG does
  **not** silently degrade to asynchronous on standby loss. This is the
  configurable knob that trades availability for the durability the ledger needs;
- **Continuous backup** (`.spec.backup.barmanObjectStore`) — WAL archiving + base
  backups to an object store (S3 or Azure Blob), with WAL/data compression;
- **PITR recovery window** (`.spec.backup.retentionPolicy`, default `30d`) — CNPG
  turns this into a `RECOVERY WINDOW OF 30 days` retention policy and prunes older
  base backups/WAL, bounding how far back a point-in-time restore can target.

**Fail-closed render guards (no insecure default ever silently ships):**

| Condition | Behaviour |
|-----------|-----------|
| `postgresHA.enabled` and `instances < 3` | hard render error (`fail`) |
| `backup.enabled` and empty `barmanObjectStore.destinationPath` | hard render error (`fail`) |
| `backup.enabled` with no `credentials.secretName` | backup stanza **not rendered** (a backup that cannot authenticate is not durability — deny, do not pretend) |

These three guards are proven by `test/db-ha.test.js`.

---

## 3. Stated RPO / RTO

These are the **target** objectives the codified posture is designed to meet. They
become *operational* guarantees only after the live cluster is provisioned and a
restore has been **tested** (DEPLOYMENT.md §7 checklist).

### RPO (Recovery Point Objective) — how much can be lost

| Scope | Stated RPO | Why |
|-------|-----------|-----|
| **Committed ledger rows** (and all committed writes) | **0 (zero data loss)** for a single-instance failure | Quorum **synchronous** replication with `dataDurability: required`: a commit the client saw as `ok` is durably on the primary **and ≥1 standby**. Losing the primary cannot lose an acknowledged ledger append. |
| **Beyond a single failure** (e.g. loss of primary + the confirming standby before WAL ships to object store) | **≤ the WAL-archive interval** | Continuous WAL archiving to the object store bounds the worst case to the not-yet-archived WAL segment(s); tune CNPG's `archive_timeout` to set this ceiling explicitly. |
| **Full-cluster loss, restore from object store** | **≤ the WAL-archive interval** (last archived WAL) | PITR replays archived WAL up to the last shipped segment. |

> **Headline ledger RPO = 0 for a single-node failure** (synchronous quorum), and
> **≤ the WAL-archive interval** for a correlated multi-failure / full-cluster
> rebuild. The default is fail-closed: durability is `required`, not `preferred`.

### RTO (Recovery Time Objective) — how long to recover

| Event | Stated RTO target | Mechanism |
|-------|-------------------|-----------|
| Primary failure (automated failover) | **≤ ~60 s** target | CNPG promotes a synchronous standby automatically; the engine is stateless and reconnects (`src/db/pool.js`). |
| Restore from object store (PITR) | **bounded by base-backup size + WAL replay**; target **≤ a few hours** for the CE schema | `kubectl cnpg` / a `Cluster` `bootstrap.recovery` from the latest base backup + WAL replay to the chosen point in time. |
| PITR target horizon | up to the **retention window** (`retentionPolicy`, default `30d`) | Restore to any point within the recovery window. |

RTO is dominated by base-backup size and WAL replay distance; for the compact CE
schema both are small, so the binding constraint is operator/runbook time, not data
volume. Measure and record the real numbers during the **tested restore**.

---

## 4. Why these numbers (assumptions & knobs)

- **Synchronous quorum, not async.** Async streaming replication would make the
  ledger RPO non-zero even for a single-node failure (the last commits may not have
  shipped). §14.4 says *quorum synchronous*; the chart defaults to it.
- **`dataDurability: required` over `preferred`.** `preferred` self-heals by
  dropping to async when no standby is available — higher availability, but it
  reopens the non-zero-RPO window. The CE default prioritises ledger durability;
  an operator who needs the availability trade-off sets it explicitly (informed,
  not silent).
- **WAL-archive interval is the second-order RPO knob.** It is a CNPG/PostgreSQL
  setting (`archive_timeout`), not a chart value; the audit states the *relationship*
  (RPO ≤ archive interval) so the operator can set a concrete ceiling.
- **Key custody is independent of DB durability.** Even a full DB restore cannot
  forge ledger rows: the HMAC key lives outside the database
  (`VOSJ_LEDGER_HMAC_KEY`, never persisted), so a restored chain is still verifiable
  and still tamper-evident.

---

## 5. Honest scope & operator obligations

The chart **renders** a correct, lint-passing CNPG `Cluster` CR — that is the
config-as-code deliverable for gap 146. To turn the stated objectives into
operational reality the operator must (DEPLOYMENT.md §7.1):

1. Install the **CNPG operator** in the cluster.
2. Provide a reachable **object store** + a credentials `Secret`, and set
   `postgresHA.backup.enabled=true` with `destinationPath` + `credentials.secretName`.
3. Provision the cluster (`postgresHA.enabled=true`) and wait for *healthy*.
4. **Test a restore** (PITR to a chosen timestamp) and **record the measured
   RPO/RTO** against the targets above. An untested backup is not a guarantee.
5. Verify the ledger chain after restore (`POST /ledger/verify` →
   `Ledger.verifyChain`) to confirm audit integrity survived the recovery.

---

## 6. Cross-references

- Chart template: `deploy/helm/vosj/templates/postgres-cluster.yaml`
- Values stanza: `deploy/helm/vosj/values.yaml` → `postgresHA`
- Tests: `test/db-ha.test.js` (render + fail-closed guards + ledger-durability framing)
- Deploy runbook: `docs/DEPLOYMENT.md` §7.1 (CloudNativePG), §7 checklist (tested restore)
- Design: `docs/DESIGN.md` (CloudNativePG HA, ledger hash-chain)
- §14.4 audit rows: `docs/audits/WHITEPAPER-GAP-ANALYSIS-2026-06-23.md` (gaps 314–316)
- Upstream: CloudNativePG Replication & Backup docs —
  https://cloudnative-pg.io/docs/ (synchronous `method: any`, `dataDurability`,
  `barmanObjectStore`, `retentionPolicy`).
