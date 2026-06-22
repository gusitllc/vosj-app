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

CREATE INDEX IF NOT EXISTS vosj_workloads_wave_idx ON vosj.workloads (wave_id);
CREATE INDEX IF NOT EXISTS vosj_ledger_ts_idx ON vosj.ledger (ts);
CREATE INDEX IF NOT EXISTS vosj_tool_log_ts_idx ON vosj.tool_log (ts);
CREATE INDEX IF NOT EXISTS vosj_orders_status_idx ON vosj.orders (status, created_at);
