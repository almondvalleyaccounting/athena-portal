-- 124: Triage Board (Client Work).
--
-- Clients land on the board when something is wrong:
--   * strike_off — auto-created by a trigger when the nightly Companies House
--     refresh records a threatening status change (proposal to strike off,
--     liquidation, administration, ...) in ch_status_events,
--   * on_hold — no work should be done for this client while the case is open,
--   * general — anything else, added manually.
-- Each case: client + brief description, timestamped notes, next action,
-- target date. Automation to move clients OUT of triage comes later.

create table if not exists public.triage_cases (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references public.entities(id) on delete cascade,
  category text not null check (category in ('strike_off', 'on_hold', 'general')),
  description text not null,
  status text not null default 'open' check (status in ('open', 'resolved')),
  next_action text,
  target_date date,
  source text not null default 'manual',        -- manual | ch_status
  ch_status_event_id uuid references public.ch_status_events(id),
  created_by uuid references public.staff_profiles(id),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references public.staff_profiles(id)
);
create index if not exists triage_cases_open_idx on public.triage_cases(status, category);
create index if not exists triage_cases_entity_idx on public.triage_cases(entity_id);

create table if not exists public.triage_case_notes (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.triage_cases(id) on delete cascade,
  author_id uuid references public.staff_profiles(id),
  body text not null,
  created_at timestamptz not null default now()
);
create index if not exists triage_case_notes_case_idx on public.triage_case_notes(case_id);

alter table public.triage_cases enable row level security;
alter table public.triage_case_notes enable row level security;

drop policy if exists "Staff manage triage cases" on public.triage_cases;
create policy "Staff manage triage cases"
  on public.triage_cases for all
  using (is_active_staff()) with check (is_active_staff());

drop policy if exists "Staff manage triage notes" on public.triage_case_notes;
create policy "Staff manage triage notes"
  on public.triage_case_notes for all
  using (is_active_staff()) with check (is_active_staff());

-- Auto-create a strike_off case when a threatening CH status change lands.
create or replace function public.triage_from_ch_status_event()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_case_id uuid;
begin
  if (new.new_status || ' ' || coalesce(new.new_detail, '')) !~* '(strike|liquidat|administrat|insolven|dissolv|receiver)' then
    return new;
  end if;
  -- One open strike_off case per client; add a note instead of a duplicate.
  select id into v_case_id from triage_cases
   where entity_id = new.entity_id and category = 'strike_off' and status = 'open'
   limit 1;
  if v_case_id is null then
    insert into triage_cases (entity_id, category, description, source, ch_status_event_id)
    values (
      new.entity_id, 'strike_off',
      'Companies House status changed: ' || coalesce(new.old_status, 'unknown') ||
        coalesce(' (' || new.old_detail || ')', '') || ' → ' || new.new_status ||
        coalesce(' (' || new.new_detail || ')', ''),
      'ch_status', new.id
    )
    returning id into v_case_id;
  else
    insert into triage_case_notes (case_id, body)
    values (v_case_id, 'Further Companies House status change: ' || new.new_status ||
      coalesce(' (' || new.new_detail || ')', ''));
  end if;
  update ch_status_events set triage_case_id = v_case_id where id = new.id;
  return new;
end $$;

drop trigger if exists trg_triage_from_ch_status on public.ch_status_events;
create trigger trg_triage_from_ch_status
  after insert on public.ch_status_events
  for each row execute function public.triage_from_ch_status_event();
