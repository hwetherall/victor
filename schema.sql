-- Agent Victor schema. Verbatim from SPEC §5.1.
-- Apply to InsForge project b3ce8f41 once SDK + migration tooling are wired (STORY-002).

create extension if not exists vector;

-- Cases: one per question being analyzed
create table cases (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  question text not null,
  framework_id text not null,        -- references frameworks/*.yaml
  weights jsonb not null,             -- keyed by framework slot id, e.g. {market-attractive: 0.25, tech-resilient: 0.20, ...}
  thresholds jsonb not null,          -- {minRevenue: 100000000, timeYears: 3, ...}
  brief_extract jsonb,                -- structured output of brief parser
  created_at timestamptz default now()
);

-- Tree nodes: every node in the decision tree
create table tree_nodes (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references cases(id) on delete cascade,
  parent_id uuid references tree_nodes(id) on delete cascade,
  type text not null check (type in (
    'decision', 'hypothesis', 'sub_hypothesis',
    'evidence', 'question'
  )),
  label text not null,                -- short human-readable
  content jsonb not null,             -- type-specific payload, see SPEC §5.2
  confidence numeric check (confidence >= 0 and confidence <= 1),
  evidence_strength integer default 0,
  weight numeric,                     -- only set for top-level hypotheses
  scenario_id uuid,                   -- null = baseline; v2 feature
  model_used text,                    -- which LLM produced this node
  status text default 'pending'
    check (status in ('pending','running','complete','failed')),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index on tree_nodes(case_id);
create index on tree_nodes(parent_id);
create index on tree_nodes(scenario_id);

-- Sources: documents, URLs, user inputs
create table sources (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references cases(id) on delete cascade,
  type text not null check (type in ('web','pdf','docx','user_input')),
  uri text,                           -- URL or storage path
  title text,
  content_extract text,
  embedding vector(1536),
  metadata jsonb,                     -- author, page, stake, ingestion_date, etc.
  created_at timestamptz default now()
);

create index on sources using ivfflat (embedding vector_cosine_ops);

-- Evidence-to-source linkage (many-to-many)
create table evidence_sources (
  evidence_node_id uuid references tree_nodes(id) on delete cascade,
  source_id uuid references sources(id) on delete cascade,
  quote text,                         -- the specific extract supporting the claim
  page_number integer,                -- for PDFs
  primary key (evidence_node_id, source_id)
);

-- HITL questions: schema kept for v2; never written to in v1 (Q3 decision)
create table user_questions (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references cases(id) on delete cascade,
  question text not null,
  question_type text not null check (question_type in ('yes_no','yes_no_context','open')),
  options jsonb,
  affects_node_ids uuid[] not null,
  answer text,
  answered_at timestamptz,
  created_at timestamptz default now()
);

-- Runs: an execution of a case (baseline or scenario)
create table runs (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references cases(id) on delete cascade,
  scenario_id uuid,                   -- null = baseline
  status text not null default 'pending'
    check (status in ('pending','running','awaiting_input','complete','failed')),
  started_at timestamptz default now(),
  completed_at timestamptz,
  error text
);
