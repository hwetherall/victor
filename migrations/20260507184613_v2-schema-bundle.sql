-- STORY-004 + STORY-002b + STORY-004b: V2 schema bundle.
--
-- One migration covers everything the V2 leaf runtime persists, so the schema
-- moves forward atomically:
--   * artifacts                — files produced by Investigator skills
--                                (spec-v2.md §8). Day-1 spike confirmed
--                                sandbox files are NOT auto-tracked by the
--                                Files API; the agent uploads via the
--                                upload_artifact custom tool, which writes
--                                to InsForge storage and inserts a row here.
--   * reasoning_traces         — OODA steps + rejected_alternatives
--                                (spec-v2.md §8). trace_id added per
--                                STORY-002b for cross-system correlation.
--   * session_costs            — per-Anthropic-session usage telemetry
--                                (STORY-004b). Captured from session.usage
--                                after session.status_idle.
--   * tree_nodes.trace_id      — STORY-002b. Nullable — only V2 leaves write
--                                it; V1 leaves leave it NULL.
--   * user_questions.created_by, accessed_at — LEGAL-004 audit columns.
--
-- Rollback (kept as comments):
--   alter table user_questions drop column accessed_at;
--   alter table user_questions drop column created_by;
--   alter table tree_nodes drop column trace_id;
--   drop table session_costs;
--   drop table reasoning_traces;
--   drop table artifacts;

-- ─── artifacts (spec-v2.md §8) ──────────────────────────────────────────────

create table if not exists artifacts (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references cases(id) on delete cascade,
  -- Nullable: a future skill might produce a case-level artifact not bound
  -- to a single leaf (e.g. cross-cutting pre-mortem).
  evidence_node_id uuid references tree_nodes(id) on delete cascade,
  type text not null check (type in (
    'xlsx', 'csv', 'png', 'md', 'json', 'model_lineage'
  )),
  -- Storage bucket path (e.g. artifacts/{case_id}/{node_id}/{filename}).
  -- Relative — do not embed the storage provider host.
  uri text not null,
  version integer not null default 1,
  parent_artifact_id uuid references artifacts(id),
  -- Skill name, inputs used, change_reason for v1→v2 diffs (STORY-026).
  metadata jsonb,
  created_at timestamptz default now()
);

create index if not exists artifacts_evidence_node_id_idx
  on artifacts(evidence_node_id);
create index if not exists artifacts_parent_artifact_id_idx
  on artifacts(parent_artifact_id);

-- ─── reasoning_traces (spec-v2.md §8 + STORY-002b trace_id) ─────────────────

create table if not exists reasoning_traces (
  id uuid primary key default gen_random_uuid(),
  node_id uuid not null references tree_nodes(id) on delete cascade,
  agent_type text not null check (agent_type in (
    'investigator', 'researcher', 'micky'
  )),
  -- Anthropic session ID (sesn_…). Used to build a Console URL for replay.
  managed_agent_session_id text,
  -- STORY-002b: same trace_id we set on session.title at creation time, so
  -- a single string ties orchestrator logs ↔ Anthropic Console ↔ DB rows.
  trace_id text,
  -- Array of {phase, content, timestamp, skill_used?}. Sorted by timestamp
  -- at read time per spike finding N1 (event ordering not guaranteed).
  steps jsonb not null,
  rejected_alternatives jsonb,
  -- Pass/fail history if a rubric was applied. Shape:
  -- [{ result, explanation, iteration, failedConditions?, ... }, ...]
  outcomes_grades jsonb,
  created_at timestamptz default now()
);

create index if not exists reasoning_traces_node_id_idx
  on reasoning_traces(node_id);
create index if not exists reasoning_traces_trace_id_idx
  on reasoning_traces(trace_id);

-- ─── session_costs (STORY-004b) ─────────────────────────────────────────────
--
-- One row per Anthropic Managed Agents session that we run, populated after
-- session.status_idle from session.usage. parent_session_id ties a
-- Researcher's cost into its calling Investigator's leaf so we can total
-- per-leaf cost via a self-join.

create table if not exists session_costs (
  -- Anthropic session ID (sesn_…); naturally unique.
  session_id text primary key,
  parent_session_id text,
  run_id uuid references runs(id) on delete cascade,
  node_id uuid references tree_nodes(id) on delete cascade,
  agent_type text not null check (agent_type in (
    'investigator', 'researcher', 'micky'
  )),
  model text not null,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  cached_tokens integer not null default 0,
  cost_usd numeric(10, 4) not null default 0,
  created_at timestamptz default now()
);

create index if not exists session_costs_run_id_idx on session_costs(run_id);
create index if not exists session_costs_node_id_idx on session_costs(node_id);
create index if not exists session_costs_parent_session_id_idx
  on session_costs(parent_session_id);

-- Convenience view for run-level totals (avoids repeating the agg in code).
create or replace view v_run_costs as
select
  run_id,
  count(*)                              as session_count,
  sum(input_tokens)                     as input_tokens,
  sum(output_tokens)                    as output_tokens,
  sum(cached_tokens)                    as cached_tokens,
  sum(cost_usd)                         as cost_usd_total,
  sum(cost_usd) filter (where agent_type = 'investigator') as cost_usd_investigator,
  sum(cost_usd) filter (where agent_type = 'researcher')   as cost_usd_researcher
from session_costs
where run_id is not null
group by run_id;

-- ─── tree_nodes.trace_id (STORY-002b) ───────────────────────────────────────
--
-- Nullable: only V2 leaves write a trace_id. V1 leaves leave it NULL. Used
-- by scripts/trace.ts to correlate across orchestrator logs, the Console,
-- the webhook handler logs, and the reasoning_traces table.

alter table tree_nodes
  add column if not exists trace_id text;

create index if not exists tree_nodes_trace_id_idx
  on tree_nodes(trace_id) where trace_id is not null;

-- ─── user_questions audit columns (LEGAL-004) ──────────────────────────────
--
-- Cheap to add now, expensive to retrofit. created_by tracks which Innovera
-- user answered the HITL escalation; accessed_at is touched on each read so
-- we can purge stale rows per a future retention policy. Both nullable for
-- backwards compatibility — V1 never wrote to user_questions, V2 will.

alter table user_questions
  add column if not exists created_by uuid,
  add column if not exists accessed_at timestamptz;

create index if not exists user_questions_created_by_idx
  on user_questions(created_by) where created_by is not null;
