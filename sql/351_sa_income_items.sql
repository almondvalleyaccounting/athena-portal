-- 351_sa_income_items.sql
--
-- Directors' other income, per director, ticked as it arrives (Bobby,
-- 2026-10-07).
--
-- On the Priority board, self assessment splits in two (job-plan /
-- _shared/priority-board.ts):
--   * Directors of a current company client ride with the company: their
--     internal review date is the company accounts' internal review date
--     (never later than 31 Jan less the buffer) and they aren't dragged.
--   * Sole traders (everyone else) keep their own draggable capacity queue.
--     A director whose company has no accounts job on the board goes to the
--     top of it.
-- A director's return is delayed while any of their personal items is
-- outstanding. The items come from the records request picker's "personal"
-- group (records_items.grp = 'personal'): when a company's request is sent,
-- each ticked personal item is tagged to a named director and lands here
-- against that director's next open self assessment. The team ticks each one
-- received; later an agent will do the ticking (through an edge function, as
-- an Athena user, never as staff or service_role).
--
-- Browser: SELECT only. Writes go through the job-plan edge function.

create table if not exists public.sa_income_items (
  id                uuid primary key default gen_random_uuid(),
  entity_id         uuid not null references public.entities(id) on delete cascade,  -- the director's own (individual) client
  period_end        date not null,                                                   -- the self assessment it belongs to (v_sa_jobs.period_end)
  company_entity_id uuid references public.entities(id) on delete set null,          -- the company whose request asked for it
  item_key          text references public.records_items(key),
  custom_text       text check (custom_text is null or char_length(custom_text) <= 300),
  requested_at      timestamptz,
  requested_by      uuid references public.staff_profiles(id) on delete set null,
  received_at       timestamptz,
  received_by       uuid references public.staff_profiles(id) on delete set null,
  created_by        uuid references public.staff_profiles(id) on delete set null,
  created_at        timestamptz not null default now(),
  check (item_key is not null or (custom_text is not null and char_length(trim(custom_text)) > 0))
);
comment on table public.sa_income_items is
  'A director''s other-income item for one self assessment (sql/351): requested on the company''s records request, ticked when received. Outstanding items delay the return on the Priority board.';
-- A real constraint, not a partial index, so PostgREST upserts can target it;
-- custom items (item_key null) never collide because nulls are distinct.
alter table public.sa_income_items add constraint sa_income_items_key_uq unique (entity_id, period_end, item_key);
create index if not exists sa_income_items_job_idx on public.sa_income_items (entity_id, period_end);
create index if not exists sa_income_items_open_idx on public.sa_income_items (entity_id, period_end) where received_at is null;

alter table public.sa_income_items enable row level security;
drop policy if exists sa_income_items_read on public.sa_income_items;
create policy sa_income_items_read on public.sa_income_items for select using (public.is_active_staff());
revoke all on public.sa_income_items from public, anon, authenticated;
grant select on public.sa_income_items to authenticated;
grant all on public.sa_income_items to service_role;
