-- DSAR runbook note: Micky attempts are in scope for personal-data deletion
-- requests. A single Micky attempt can be soft-deleted without deleting the
-- parent run or tree.

alter table micky_runs
  add column if not exists deleted_at timestamptz;

alter table runs
  add column if not exists last_accessed_at timestamptz;

create index if not exists micky_runs_deleted_at_idx on micky_runs(deleted_at);

create or replace function expire_stale_micky_runs()
returns trigger
language plpgsql
as $$
begin
  update micky_runs mr
  set deleted_at = now()
  from runs r
  where mr.run_id = r.id
    and mr.deleted_at is null
    and coalesce(r.last_accessed_at, r.started_at) < now() - interval '90 days';
  return null;
end;
$$;

drop trigger if exists expire_stale_micky_runs_on_insert on micky_runs;

create trigger expire_stale_micky_runs_on_insert
after insert on micky_runs
execute function expire_stale_micky_runs();
