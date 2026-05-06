create table micky_runs (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references runs(id) on delete cascade,
  attempt_number integer not null,
  status text not null default 'pending'
    check (status in ('pending','running','complete','failed')),
  output jsonb,
  error text,
  created_at timestamptz default now(),
  completed_at timestamptz,
  unique (run_id, attempt_number)
);

create index on micky_runs(run_id);
