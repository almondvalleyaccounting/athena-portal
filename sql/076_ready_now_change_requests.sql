-- Queue of edits made in the Work Planner Ready Now view for fields
-- that live in BrightManager (Grade, BM Target, Assignee). Users edit
-- inline; rows are exported as CSV for the admin to apply in BM, then
-- marked applied (or cancelled) once done.

create table if not exists ready_now_change_requests (
  id              uuid primary key default gen_random_uuid(),
  entity_id       uuid not null references entities(id) on delete cascade,
  service         text not null,
  period_end      date,
  field           text not null check (field in ('grade','bm_target','assignee')),
  current_value   text,
  proposed_value  text,
  note            text,
  status          text not null default 'pending' check (status in ('pending','applied','cancelled')),
  created_by      uuid default auth.uid() references auth.users(id) on delete set null,
  applied_by      uuid references auth.users(id) on delete set null,
  applied_at      timestamptz,
  cancelled_at    timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists rncr_status_idx on ready_now_change_requests(status, created_at desc);
create index if not exists rncr_entity_idx on ready_now_change_requests(entity_id, service);

create or replace function ready_now_change_requests_touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists rncr_touch_updated_at on ready_now_change_requests;
create trigger rncr_touch_updated_at
  before update on ready_now_change_requests
  for each row execute function ready_now_change_requests_touch_updated_at();

alter table ready_now_change_requests enable row level security;

drop policy if exists "Authenticated can read ready_now_change_requests" on ready_now_change_requests;
create policy "Authenticated can read ready_now_change_requests"
  on ready_now_change_requests for select to authenticated using (true);

drop policy if exists "Authenticated can insert ready_now_change_requests" on ready_now_change_requests;
create policy "Authenticated can insert ready_now_change_requests"
  on ready_now_change_requests for insert to authenticated
  with check (created_by = auth.uid() or created_by is null);

drop policy if exists "Authenticated can update ready_now_change_requests" on ready_now_change_requests;
create policy "Authenticated can update ready_now_change_requests"
  on ready_now_change_requests for update to authenticated using (true);

drop policy if exists "Authenticated can delete ready_now_change_requests" on ready_now_change_requests;
create policy "Authenticated can delete ready_now_change_requests"
  on ready_now_change_requests for delete to authenticated using (true);

comment on table ready_now_change_requests is 'Queued edits made in the Work Planner Ready Now view (Grade, BM Target, Assignee). Exported as CSV for the admin to apply in BrightManager.';
