-- src/db/schema.sql — Vosj CE system-of-record (schema-per-domain isolation, §14).
-- Idempotent: every object is IF NOT EXISTS. Apply via `npm run migrate` or psql.
-- Tables: templates, workloads, waves, gates, ledger, waivers, tool_log.

CREATE SCHEMA IF NOT EXISTS vosj;

-- Framework templates (the data-driven methodology source, §8.2).
CREATE TABLE IF NOT EXISTS vosj.templates (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  source             TEXT NOT NULL DEFAULT 'custom',
  version            TEXT NOT NULL DEFAULT '1',
  parent_template_id TEXT,
  visibility         TEXT NOT NULL DEFAULT 'public',   -- public | tenant | private
  status             TEXT NOT NULL DEFAULT 'published', -- draft | published | archived
  body               JSONB NOT NULL,                    -- compiled phases/gates/states/transitions
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Template lifecycle columns (PKG-TEMPLATE-LIFECYCLE, §8.2/§8.3 — clone/lineage,
-- create/edit/publish, tenant scoping). Additive & idempotent so the DB-backed
-- loader (src/engine/template-store.js) persists the compiled body alongside
-- lineage/owner/tenant without forking the core template engine (gap 63).
-- updated_at stamps the last edit; owner/tenant_id scope a tenant-private template.
-- NOTE: schema.sql is shared with PKG-VAULT/PKG-METERING/PKG-FOUR-EYES — this
-- ALTER block is self-contained and IF NOT EXISTS so packages can land in any order.
ALTER TABLE IF EXISTS vosj.templates ADD COLUMN IF NOT EXISTS owner      TEXT;
ALTER TABLE IF EXISTS vosj.templates ADD COLUMN IF NOT EXISTS tenant_id  TEXT;
ALTER TABLE IF EXISTS vosj.templates ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- Per-tenant data isolation (PKG-TENANT-ISOLATION, §14.3 — "per-tenant data
-- isolation on every query"). CE floor: add a tenant_id discriminator to every
-- tenant-scoped store table and default it to a single CE tenant ('default') so
-- existing single-tenant data is unaffected and existing single-tenant CE keeps
-- working. The per-tenant query FILTER is applied parameterised in
-- src/db/statestore.js (every list/get/save carries the tenant predicate); this
-- column is the structural floor it filters on. Multi-tenant ENFORCEMENT at scale
-- + EE RBAC is EE — this delivers the CE column + composite index + default-tenant
-- floor only. Idempotent (IF NOT EXISTS) so it can land in any order; the existing
-- vosj.templates.tenant_id column above is left as-is (nullable, visibility-scoped).
-- NOTE: schema.sql is shared with PKG-VAULT/PKG-METERING/PKG-FOUR-EYES/
-- PKG-TEMPLATE-LIFECYCLE — this block is self-contained and IF NOT EXISTS so the
-- packages can land in any order without colliding.
ALTER TABLE IF EXISTS vosj.workloads ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE IF EXISTS vosj.waves     ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE IF EXISTS vosj.gates     ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE IF EXISTS vosj.metering  ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default';

CREATE INDEX IF NOT EXISTS vosj_workloads_tenant_idx ON vosj.workloads (tenant_id, wave_id);
CREATE INDEX IF NOT EXISTS vosj_waves_tenant_idx     ON vosj.waves     (tenant_id, created_at);
CREATE INDEX IF NOT EXISTS vosj_gates_tenant_idx     ON vosj.gates     (tenant_id, migration_id);
CREATE INDEX IF NOT EXISTS vosj_metering_tenant_idx  ON vosj.metering  (tenant_id, wave_id);

CREATE INDEX IF NOT EXISTS vosj_templates_visibility_idx ON vosj.templates (visibility, tenant_id);
CREATE INDEX IF NOT EXISTS vosj_templates_lineage_idx    ON vosj.templates (parent_template_id);

-- Framework roles (§8.2, gap 54/55) — generalises the hardcoded role set into a
-- data-driven, per-template table so a template can declare its own signoff roles
-- and bind each to an RBAC capability. PK (template_id, role_key) makes save idempotent.
CREATE TABLE IF NOT EXISTS vosj.framework_roles (
  template_id     TEXT NOT NULL,
  role_key        TEXT NOT NULL,
  display         TEXT,
  rbac_capability TEXT,
  PRIMARY KEY (template_id, role_key)
);

-- Workloads — one in-scope application/unit, carrying its 7-R disposition (§7).
CREATE TABLE IF NOT EXISTS vosj.workloads (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  disposition   TEXT,                       -- one of the 7 R's (set in Examine)
  state         TEXT NOT NULL DEFAULT 'legacy', -- legacy|dual_running|reconciled|migrated
  wave_id       TEXT,
  baseline_at   TIMESTAMPTZ,                -- freshness drives the baseline-drift guard (§13.1)
  attributes    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Revocable-acceptance columns (PKG-REVOCABLE-ACCEPTANCE, §13.2 / §6 P6).
-- accepted_at stamps a SUCCESSFUL cutover so the 30-min revocation window can be
-- evaluated; acceptance_status tracks the post-cutover acceptance lifecycle
-- (pending -> accepted -> revoked|reversed). Idempotent — safe on an existing table.
-- NOTE: schema.sql is shared with PKG-VAULT and PKG-METERING; this ALTER block is
-- self-contained and IF NOT EXISTS so the packages can land in any order.
ALTER TABLE IF EXISTS vosj.workloads ADD COLUMN IF NOT EXISTS accepted_at       TIMESTAMPTZ;
ALTER TABLE IF EXISTS vosj.workloads ADD COLUMN IF NOT EXISTS acceptance_status TEXT DEFAULT 'pending';

-- Waves — a planned migration batch bound to a framework template (pinned at kickoff).
CREATE TABLE IF NOT EXISTS vosj.waves (
  id                   TEXT PRIMARY KEY,
  name                 TEXT NOT NULL,
  state                TEXT NOT NULL DEFAULT 'P1', -- current phase state in the FSM
  framework_template_id TEXT,
  framework_version    TEXT,                        -- pinned so a template edit can't mutate a run
  plan                 JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Gate sign-off records (§14.1). The signed ledger row is authoritative; this is
-- the queryable projection of "who signed which gate, on what evidence hash".
CREATE TABLE IF NOT EXISTS vosj.gates (
  id           TEXT NOT NULL,
  migration_id TEXT,
  unit_id      TEXT,
  signed_by    TEXT,
  signer_role  TEXT,
  ledger_hash  TEXT,
  signed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id, migration_id)
);

-- Tamper-evident, hash-chained ledger (§12.2/§14.4). hash = HMAC over prev+row.
CREATE TABLE IF NOT EXISTS vosj.ledger (
  seq            BIGSERIAL PRIMARY KEY,
  ts             TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor          TEXT,
  signer_role    TEXT,
  action         TEXT NOT NULL,
  evidence_hashes JSONB NOT NULL DEFAULT '[]'::jsonb,
  meta           JSONB NOT NULL DEFAULT '{}'::jsonb,
  prev_hash      TEXT NOT NULL,
  hash           TEXT NOT NULL
);

-- Waivers — exceptions to an ADVISORY (soft) gate criterion only, themselves
-- audited (second-line control). A waiver may NEVER bypass a hard invariant
-- (verified-before-cutover, no-agent-self-sign, separation-of-duties, ledger
-- fail-closed, baseline-drift) — those are structurally unwaivable in the engine;
-- the engine refuses to apply any waiver whose check_class is not 'advisory'.
CREATE TABLE IF NOT EXISTS vosj.waivers (
  id          TEXT PRIMARY KEY,
  gate_id     TEXT,
  reason      TEXT NOT NULL,
  granted_by  TEXT NOT NULL,
  expires_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Additive scoping columns (idempotent — safe on an existing waivers table).
ALTER TABLE vosj.waivers ADD COLUMN IF NOT EXISTS check_name  TEXT;        -- the advisory check waived
ALTER TABLE vosj.waivers ADD COLUMN IF NOT EXISTS check_class TEXT NOT NULL DEFAULT 'advisory'; -- only 'advisory' is honoured
ALTER TABLE vosj.waivers ADD COLUMN IF NOT EXISTS scope       TEXT;        -- optional workload/wave id the waiver applies to
ALTER TABLE vosj.waivers ADD COLUMN IF NOT EXISTS status      TEXT NOT NULL DEFAULT 'active'; -- active | revoked

CREATE INDEX IF NOT EXISTS vosj_waivers_lookup_idx
  ON vosj.waivers (gate_id, check_name, status);

-- MCP tool-call log (§14.2) — the audit substrate for external interaction (R8).
CREATE TABLE IF NOT EXISTS vosj.tool_log (
  id         BIGSERIAL PRIMARY KEY,
  ts         TIMESTAMPTZ NOT NULL DEFAULT now(),
  server     TEXT,
  tool       TEXT NOT NULL,
  actor      TEXT,
  arguments  JSONB NOT NULL DEFAULT '{}'::jsonb,
  result     JSONB,
  duration_ms INTEGER
);

-- Durable work-order queue (the bring-your-own-AI seam, R8). An external planner
-- enqueues orders; a worker claims the next pending one with FOR UPDATE SKIP LOCKED
-- so concurrent workers never grab the same row, then markDone/markFailed.
CREATE TABLE IF NOT EXISTS vosj.orders (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  payload     JSONB NOT NULL DEFAULT '{}'::jsonb,
  status      TEXT NOT NULL DEFAULT 'pending', -- pending | claimed | done | failed
  claimed_by  TEXT,
  claimed_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Encrypted credential vault (§15.2/§15.5). FAIL-CLOSED authenticated encryption
-- (AES-256-GCM) under an operationally-supplied master key (VOSJ_VAULT_MASTER_KEY,
-- never persisted). Stores ONLY ciphertext + iv + auth_tag — never plaintext.
-- Credentials are addressed by an opaque `ref` (secret indirection): connectors
-- reference, never embed, a secret. rotated_at stamps a re-encrypt (rotation).
-- NOTE: schema.sql is shared with PKG-FOUR-EYES and PKG-METERING — this block is
-- self-contained and idempotent (IF NOT EXISTS) so the packages can land in any
-- order without colliding.
CREATE TABLE IF NOT EXISTS vosj.credentials (
  ref         TEXT PRIMARY KEY,
  alg         TEXT NOT NULL,
  ciphertext  TEXT NOT NULL,
  iv          TEXT NOT NULL,
  auth_tag    TEXT NOT NULL,
  meta        JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ DEFAULT now(),
  rotated_at  TIMESTAMPTZ
);

-- Change-request register (PKG-FOUR-EYES, §12 Invariant 3 / §6 P3). Four-eyes
-- change validation: a change authored by actor A is "validated" only when an
-- INDEPENDENT human validator V (V !== A) records a diff-impact report; the
-- queryable projection of "who authored which change, validated by whom, on what
-- diff-impact" backs the P3 planning-gate precondition (the authoritative event is
-- the 'change.validated' ledger row). status: pending -> validated. diff_impact
-- holds the independent validator's diff-impact report.
-- NOTE: schema.sql is shared with PKG-VAULT/PKG-METERING/PKG-TEMPLATE-LIFECYCLE —
-- this block is self-contained and IF NOT EXISTS so the packages can land in any
-- order without colliding.
CREATE TABLE IF NOT EXISTS vosj.change_requests (
  id          TEXT PRIMARY KEY,
  wave_id     TEXT,
  author      TEXT NOT NULL,
  validator   TEXT,
  diff_impact JSONB,
  status      TEXT DEFAULT 'pending',
  created_at  TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS vosj_change_requests_wave_idx ON vosj.change_requests (wave_id, status);

-- Metering (PKG-METERING-OBSERVABILITY, §18 economics) — per-workload effort/cost
-- capture so the four stations are not only audited but METERED. recordEffort()
-- appends one row per signed transition / executor step; aggregate(wave_id) sums
-- effort + cost and groups by phase. cost_units is the charged cost (effort priced
-- by the config knob VOSJ_COST_PER_EFFORT_UNIT, never hardcoded at the call site).
-- NOTE: schema.sql is shared with PKG-VAULT/PKG-FOUR-EYES/PKG-TEMPLATE-LIFECYCLE —
-- this block is self-contained and IF NOT EXISTS so the packages can land in any
-- order without colliding.
CREATE TABLE IF NOT EXISTS vosj.metering (
  id          BIGSERIAL PRIMARY KEY,
  wave_id     TEXT,
  workload_id TEXT,
  phase       TEXT,
  actor       TEXT,
  effort_ms   BIGINT,
  cost_units  NUMERIC,
  ts          TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS vosj_metering_wave_idx ON vosj.metering (wave_id);

CREATE INDEX IF NOT EXISTS vosj_workloads_wave_idx ON vosj.workloads (wave_id);
CREATE INDEX IF NOT EXISTS vosj_ledger_ts_idx ON vosj.ledger (ts);
CREATE INDEX IF NOT EXISTS vosj_tool_log_ts_idx ON vosj.tool_log (ts);
CREATE INDEX IF NOT EXISTS vosj_orders_status_idx ON vosj.orders (status, created_at);

-- Implementation gap tracker (whitepaper claim -> code status + work progress +
-- the virtual persona assigned to execute it). Seeded from src/db/gaps-seed.json
-- on first boot; an engineer tracks AI-implementation progress here (live at
-- /progress.html, edited via PATCH /api/gaps/:id).
CREATE TABLE IF NOT EXISTS vosj.gaps (
  id           SERIAL PRIMARY KEY,
  area         TEXT NOT NULL,
  wp_section   TEXT,
  claim        TEXT NOT NULL,
  wp_status    TEXT,           -- vs whitepaper: implemented|partial|missing|divergent|aspirational
  severity     TEXT,           -- none|minor|major|critical
  scope        TEXT,           -- CE | EE
  evidence     TEXT,
  work_status  TEXT NOT NULL DEFAULT 'todo',   -- todo|in_progress|done|ee_deferred|wont_fix
  pct_complete INT  NOT NULL DEFAULT 0,
  assignee     TEXT,           -- the virtual persona who executes this task
  validator    TEXT,
  priority     INT  NOT NULL DEFAULT 5,         -- 1 critical .. 9 trivial
  notes        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS vosj_gaps_status_idx ON vosj.gaps (work_status);
CREATE INDEX IF NOT EXISTS vosj_gaps_assignee_idx ON vosj.gaps (assignee);
