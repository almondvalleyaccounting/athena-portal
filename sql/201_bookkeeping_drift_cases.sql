-- 201_bookkeeping_drift_cases.sql
--
-- The nudge ladder. Detection is already done (199); this is what happens
-- afterwards, and who hears about it.
--
-- DISARMED ON PURPOSE. Nudges are generated and queued in full, with their real
-- recipient and real wording, but bk_drift_settings.nudges_armed is false and
-- the sender refuses to send while it is. That gives a week or two of "here is
-- exactly what would have gone out" before anything reaches a colleague — which
-- matters, because thresholds tuned on no data are how a new alert becomes
-- background noise in a fortnight.
--
-- Cases are opened only where WE keep the books. On a client-kept file the
-- drift is information, and the eventual answer is a client chaser through
-- Communications, not a nudge to a team member. Same detection, different
-- target; keeping them apart is what makes the board trustworthy.
--
-- A case persists across snapshots, so how long cases stay open — per person,
-- per reason — is the actual management question this can answer. That is what
-- the reason codes are for: after a quarter you know how much drift is client-
-- caused and how much is capacity, which is a different conversation from
-- chasing individuals.

/* ── Settings ────────────────────────────────────────────────────────────── */

create table if not exists public.bk_drift_settings (
  id             int primary key default 1,
  nudges_armed   boolean not null default false,
  armed_by       uuid references auth.users(id),
  armed_at       timestamptz,
  first_nudge_days      int not null default 0,   -- days after a case opens
  reminder_after_days   int not null default 5,   -- no movement → remind
  escalate_after_days   int not null default 10,  -- no movement → escalate
  constraint bk_settings_single check (id = 1)
);

insert into public.bk_drift_settings (id) values (1) on conflict (id) do nothing;

comment on column public.bk_drift_settings.nudges_armed is
  'False = queue nudges but never send. Flip only when Bobby has reviewed the queue.';

/* ── Cases ───────────────────────────────────────────────────────────────── */

create table if not exists public.bk_drift_cases (
  id                bigserial primary key,
  entity_id         uuid not null references public.entities(id) on delete cascade,

  opened_on         date not null default current_date,
  opened_severity   text,
  opened_recon_to   date,
  opened_days_over  int,

  state             text not null default 'detected',
  assignee_id       uuid references auth.users(id),
  manager_id        uuid references auth.users(id),

  -- Acknowledging requires a reason. "Seen it" is not an answer that tells
  -- anyone whether to help, wait, or escalate.
  reason_code       text,
  reason_note       text,
  promised_by       date,
  acknowledged_by   uuid references auth.users(id),
  acknowledged_at   timestamptz,

  escalated_at      timestamptz,
  last_nudged_at    timestamptz,
  nudge_count       int not null default 0,

  resolved_at       timestamptz,
  resolved_by       uuid references auth.users(id),
  resolution        text,
  closed_recon_to   date,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint bk_case_state_ck  check (state in ('detected','nudged','acknowledged','escalated','resolved','dismissed')),
  constraint bk_case_reason_ck check (reason_code is null or reason_code in
    ('waiting_on_client','records_incomplete','feed_broken','capacity','client_dispute','work_in_progress','other')),
  constraint bk_case_res_ck    check (resolution is null or resolution in
    ('caught_up','manual','no_longer_watched','dismissed'))
);

-- One open case per client. A second case for the same drift is noise.
create unique index if not exists bk_case_one_open
  on public.bk_drift_cases (entity_id)
  where state not in ('resolved', 'dismissed');

create index if not exists bk_case_assignee_idx on public.bk_drift_cases (assignee_id)
  where state not in ('resolved', 'dismissed');

/* ── Queued nudges ───────────────────────────────────────────────────────── */

create table if not exists public.bk_drift_nudges (
  id            bigserial primary key,
  case_id       bigint references public.bk_drift_cases(id) on delete cascade,
  entity_id     uuid references public.entities(id) on delete cascade,
  kind          text not null,          -- first | reminder | escalation
  recipient_id  uuid references auth.users(id),
  subject       text,
  body          text,
  state         text not null default 'queued',
  queued_at     timestamptz not null default now(),
  sent_at       timestamptz,
  suppressed_reason text,

  constraint bk_nudge_kind_ck  check (kind in ('first','reminder','escalation')),
  constraint bk_nudge_state_ck check (state in ('queued','sent','cancelled','suppressed'))
);

create index if not exists bk_nudge_queued_idx on public.bk_drift_nudges (state, queued_at)
  where state = 'queued';

/* ── The tick: open, escalate, close ─────────────────────────────────────── */

-- Run after each sweep. Pure bookkeeping on cases — it sends nothing itself,
-- it only queues. Idempotent: running it twice in a day changes nothing.
create or replace function public.bk_drift_tick()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_opened int := 0; v_closed int := 0; v_escalated int := 0; v_queued int := 0;
  v_settings public.bk_drift_settings;
begin
  select * into v_settings from public.bk_drift_settings where id = 1;

  -- 1. Open a case for every breach we are responsible for.
  with candidates as (
    select d.entity_id, d.entity_name, d.drift_status, d.reconciled_to, d.days_over_tolerance,
           d.assignee_id, d.manager_id
    from public.v_bk_drift_current d
    where d.books_owner = 'us'
      and d.watch_enabled
      and d.drift_status in ('breach', 'critical')
  )
  insert into public.bk_drift_cases
    (entity_id, opened_severity, opened_recon_to, opened_days_over, assignee_id, manager_id)
  select c.entity_id, c.drift_status, c.reconciled_to, c.days_over_tolerance, c.assignee_id, c.manager_id
  from candidates c
  where not exists (
    select 1 from public.bk_drift_cases x
    where x.entity_id = c.entity_id and x.state not in ('resolved', 'dismissed')
  );
  get diagnostics v_opened = row_count;

  -- 2. Close cases that have caught up. Resolution is recorded as 'caught_up'
  --    rather than deleted, so the time-to-resolve history survives.
  with recovered as (
    select d.entity_id, d.reconciled_to
    from public.v_bk_drift_current d
    where d.drift_status in ('ok', 'watch', 'paused')
  )
  update public.bk_drift_cases c
     set state = 'resolved', resolved_at = now(), resolution = 'caught_up',
         closed_recon_to = r.reconciled_to, updated_at = now()
    from recovered r
   where c.entity_id = r.entity_id
     and c.state not in ('resolved', 'dismissed');
  get diagnostics v_closed = row_count;

  -- Also close cases for clients who left the watch entirely (unwatched,
  -- unlinked, no longer a client). Otherwise they sit open forever.
  update public.bk_drift_cases c
     set state = 'resolved', resolved_at = now(), resolution = 'no_longer_watched', updated_at = now()
   where c.state not in ('resolved', 'dismissed')
     and not exists (select 1 from public.v_bk_drift_current d where d.entity_id = c.entity_id);

  -- 3. Escalate: no acknowledgement and no movement past the ladder, or a
  --    critical-tier client, which skips the queue entirely.
  update public.bk_drift_cases c
     set state = 'escalated', escalated_at = now(), updated_at = now()
    from public.v_bk_drift_current d
   where d.entity_id = c.entity_id
     and c.state in ('detected', 'nudged')
     and (
       current_date - c.opened_on >= v_settings.escalate_after_days
       or (d.tier = 'critical' and current_date > c.opened_on)
     );
  get diagnostics v_escalated = row_count;

  -- 4. Queue what would be sent. Nothing here decides to deliver — that is the
  --    sender's job, and it refuses while nudges_armed is false.
  with due as (
    select c.id as case_id, c.entity_id, c.state, c.assignee_id, c.manager_id,
           d.entity_name, d.reconciled_to, d.days_over_tolerance, d.tolerance_days,
           d.tier, d.next_deadline,
           case
             when c.nudge_count = 0                                              then 'first'
             when c.state = 'escalated' and c.escalated_at > coalesce(c.last_nudged_at, 'epoch') then 'escalation'
             when current_date - coalesce(c.last_nudged_at::date, c.opened_on)
                  >= v_settings.reminder_after_days                              then 'reminder'
           end as kind
    from public.bk_drift_cases c
    join public.v_bk_drift_current d on d.entity_id = c.entity_id
    where c.state in ('detected', 'nudged', 'escalated')
  ),
  ins as (
    insert into public.bk_drift_nudges (case_id, entity_id, kind, recipient_id, subject, body)
    select
      due.case_id, due.entity_id, due.kind,
      case when due.kind = 'escalation' then coalesce(due.manager_id, due.assignee_id)
           else due.assignee_id end,
      case when due.kind = 'escalation'
           then format('Escalated: %s bookkeeping is %s days past tolerance', due.entity_name, due.days_over_tolerance)
           else format('%s — books reconciled only to %s', due.entity_name,
                       coalesce(to_char(due.reconciled_to, 'DD Mon YYYY'), 'no reconciliation in 6 months')) end,
      format(
        'Reconciled to: %s%sTolerance for a %s client is %s days; this is %s days past it.%s%s',
        coalesce(to_char(due.reconciled_to, 'DD Mon YYYY'), 'nothing reconciled in the last 6 months'),
        E'\n',
        due.tier, due.tolerance_days, due.days_over_tolerance, E'\n',
        case when due.next_deadline is not null
             then format('Next filing deadline: %s.', to_char(due.next_deadline, 'DD Mon YYYY'))
             else '' end
      )
    from due
    where due.kind is not null
    returning case_id, kind
  )
  select count(*) into v_queued from ins;

  update public.bk_drift_cases c
     set last_nudged_at = now(),
         nudge_count = c.nudge_count + 1,
         state = case when c.state = 'detected' then 'nudged' else c.state end,
         updated_at = now()
   where exists (
     select 1 from public.bk_drift_nudges n
     where n.case_id = c.id and n.state = 'queued'
       and n.queued_at > coalesce(c.last_nudged_at, 'epoch'::timestamptz)
   );

  return jsonb_build_object(
    'opened', v_opened, 'closed', v_closed, 'escalated', v_escalated,
    'queued', v_queued, 'armed', v_settings.nudges_armed
  );
end;
$$;

revoke all on function public.bk_drift_tick() from public, anon;
grant execute on function public.bk_drift_tick() to authenticated, service_role;

/* ── Human actions on a case ─────────────────────────────────────────────── */

create or replace function public.bk_case_acknowledge(
  p_case_id bigint, p_reason_code text, p_promised_by date default null, p_note text default null
)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not public.is_active_staff() then raise exception 'Not authorised'; end if;
  update public.bk_drift_cases
     set state = 'acknowledged', reason_code = p_reason_code, reason_note = p_note,
         promised_by = p_promised_by, acknowledged_by = auth.uid(), acknowledged_at = now(),
         updated_at = now()
   where id = p_case_id and state not in ('resolved', 'dismissed');
  -- An acknowledgement answers the outstanding nudges; they should not go out
  -- after someone has already picked the job up.
  update public.bk_drift_nudges
     set state = 'cancelled', suppressed_reason = 'acknowledged'
   where case_id = p_case_id and state = 'queued';
end;
$$;

create or replace function public.bk_case_dismiss(p_case_id bigint, p_note text default null)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not public.is_active_staff() then raise exception 'Not authorised'; end if;
  update public.bk_drift_cases
     set state = 'dismissed', resolution = 'dismissed', reason_note = coalesce(p_note, reason_note),
         resolved_at = now(), resolved_by = auth.uid(), updated_at = now()
   where id = p_case_id;
  update public.bk_drift_nudges
     set state = 'cancelled', suppressed_reason = 'case dismissed'
   where case_id = p_case_id and state = 'queued';
end;
$$;

revoke all on function public.bk_case_acknowledge(bigint, text, date, text) from public, anon;
revoke all on function public.bk_case_dismiss(bigint, text)                  from public, anon;
grant execute on function public.bk_case_acknowledge(bigint, text, date, text) to authenticated;
grant execute on function public.bk_case_dismiss(bigint, text)                 to authenticated;

/* ── Board view ──────────────────────────────────────────────────────────── */

-- Everything the Drifting board needs in one read: the scored snapshot, the
-- open case, the trend, and the assignee's name.
create or replace view public.v_bk_drift_board as
select
  d.*,
  c.id            as case_id,
  c.state         as case_state,
  c.opened_on     as case_opened_on,
  c.reason_code   as case_reason,
  c.reason_note   as case_note,
  c.promised_by   as case_promised_by,
  c.nudge_count   as case_nudges,
  sa.name         as assignee_name,
  sm.name         as manager_name,
  t.recon_stuck_21d,
  t.error_days,
  (select count(*) from public.bk_drift_nudges n
    where n.case_id = c.id and n.state = 'queued') as nudges_queued
from public.v_bk_drift_current d
left join public.bk_drift_cases c
       on c.entity_id = d.entity_id and c.state not in ('resolved', 'dismissed')
left join public.staff_profiles sa on sa.id = d.assignee_id
left join public.staff_profiles sm on sm.id = d.manager_id
left join public.v_bk_drift_trend t on t.entity_id = d.entity_id;

comment on view public.v_bk_drift_board is
  'One row per watched client for the Work → Drifting board. books_owner splits it: "us" is our action, "client" is information.';

/* ── RLS ─────────────────────────────────────────────────────────────────── */

alter table public.bk_drift_cases    enable row level security;
alter table public.bk_drift_nudges   enable row level security;
alter table public.bk_drift_settings enable row level security;

drop policy if exists "staff read cases"     on public.bk_drift_cases;
drop policy if exists "staff write cases"    on public.bk_drift_cases;
drop policy if exists "staff read nudges"    on public.bk_drift_nudges;
drop policy if exists "staff read settings"  on public.bk_drift_settings;
drop policy if exists "owner write settings" on public.bk_drift_settings;

create policy "staff read cases" on public.bk_drift_cases
  for select to authenticated using (public.is_active_staff());
create policy "staff write cases" on public.bk_drift_cases
  for update to authenticated using (public.is_active_staff()) with check (public.is_active_staff());

-- Nudges are readable so the queue can be reviewed before it is armed, but
-- only the tick and the sender write them.
create policy "staff read nudges" on public.bk_drift_nudges
  for select to authenticated using (public.is_active_staff());

create policy "staff read settings" on public.bk_drift_settings
  for select to authenticated using (public.is_active_staff());

-- Arming is a director decision, not a staff toggle.
create policy "owner write settings" on public.bk_drift_settings
  for update to authenticated
  using (exists (select 1 from public.staff_profiles p where p.id = auth.uid() and p.can_manage_portal))
  with check (exists (select 1 from public.staff_profiles p where p.id = auth.uid() and p.can_manage_portal));
