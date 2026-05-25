-- Audit trail for expedite / deprioritise actions on entities. Written
-- by the Work Planner Ready Now view whenever a user flips one of the
-- prioritisation flags on entities (expedite, deprioritise_reason).

create table if not exists entity_priority_log (
  id            uuid primary key default gen_random_uuid(),
  entity_id     uuid not null references entities(id) on delete cascade,
  action        text not null check (action in ('expedite','unexpedite','deprioritise','reactivate')),
  reason        text,
  user_id       uuid default auth.uid() references auth.users(id) on delete set null,
  created_at    timestamptz not null default now()
);

create index if not exists entity_priority_log_entity_idx on entity_priority_log(entity_id, created_at desc);
create index if not exists entity_priority_log_created_idx on entity_priority_log(created_at desc);

alter table entity_priority_log enable row level security;

drop policy if exists "Authenticated can read priority log" on entity_priority_log;
create policy "Authenticated can read priority log" on entity_priority_log
  for select to authenticated using (true);

drop policy if exists "Authenticated can insert priority log" on entity_priority_log;
create policy "Authenticated can insert priority log" on entity_priority_log
  for insert to authenticated with check (user_id = auth.uid() or user_id is null);

comment on table entity_priority_log is 'Audit trail for expedite / deprioritise actions on entities in the Ready Now view.';
comment on column entity_priority_log.reason is 'Free text — populated for deprioritise actions only.';
