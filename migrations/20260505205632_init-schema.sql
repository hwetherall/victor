-- Agent Victor — initial schema (SPEC §5.1).
-- Migrations run inside a backend-managed transaction: no BEGIN/COMMIT/ROLLBACK.

create extension if not exists vector;

-- Cases: one per question being analyzed
create table cases (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  question text not null,
  framework_id text not null,
  weights jsonb not null,
  thresholds jsonb not null,
  brief_extract jsonb,
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
  label text not null,
  content jsonb not null,
  confidence numeric check (confidence >= 0 and confidence <= 1),
  evidence_strength integer default 0,
  weight numeric,
  scenario_id uuid,
  model_used text,
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
  uri text,
  title text,
  content_extract text,
  embedding vector(1536),
  metadata jsonb,
  created_at timestamptz default now()
);

create index on sources using ivfflat (embedding vector_cosine_ops);

-- Evidence-to-source linkage (many-to-many)
create table evidence_sources (
  evidence_node_id uuid references tree_nodes(id) on delete cascade,
  source_id uuid references sources(id) on delete cascade,
  quote text,
  page_number integer,
  primary key (evidence_node_id, source_id)
);

-- HITL questions: schema kept for v2 parity; never written to in v1 (Q3 decision)
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
  scenario_id uuid,
  status text not null default 'pending'
    check (status in ('pending','running','awaiting_input','complete','failed')),
  started_at timestamptz default now(),
  completed_at timestamptz,
  error text
);
