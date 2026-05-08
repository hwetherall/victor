-- STORY-003: V1/V2 leaf-runtime feature flag.
-- Adds a per-run column recording which leaf execution path was used.
-- Defaults to 'v1' so existing runs (and any forgotten env var) keep the
-- pre-V2 behavior. Per spec-v2.md §12.7 (V1 stays runnable), the orchestrator
-- reads this column on every run and dispatches accordingly.

alter table runs
  add column if not exists leaf_runtime text not null default 'v1'
    check (leaf_runtime in ('v1', 'v2'));

-- Optional rollback (kept as a comment so we don't have to maintain a
-- separate down migration):
-- alter table runs drop column leaf_runtime;
