-- ============================================================
-- 332 — Tracker: Margaret's client control file, in Athena
--
-- One row per bookkeeping client with her columns (preparer, cadence, VAT
-- quarter, bank recs, month-end journals, year end, payroll, payroll journal
-- checked, notes) and a drawer per client for control-account lines and
-- queries. Cells Athena can know are live; the rest are typed.
--
--   tracker_cells          typed cells (cadence, me_journals, notes, payroll, vat_qtr)
--   tracker_control_lines  per-client control accounts / queries with a date, note, author
--   tracker_bank_recs      per QBO bank/card account: reconciled-to date, from the
--                          TransactionList report filtered to reconciled (bank_recs
--                          metric in dashboard-qbo-pull), refreshed nightly
--   v_tracker              the grid
--
-- Reads: active staff. Writes: service_role only, through the tracker edge
-- function and the dashboard-qbo-pull metric.
-- ============================================================

create table if not exists public.tracker_cells (
  entity_id  uuid not null references public.entities(id) on delete cascade,
  col        text not null check (col in ('cadence', 'me_journals', 'notes', 'payroll', 'vat_qtr')),
  value      text,
  updated_by uuid references public.staff_profiles(id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (entity_id, col)
);

create table if not exists public.tracker_control_lines (
  id          uuid primary key default gen_random_uuid(),
  entity_id   uuid not null references public.entities(id) on delete cascade,
  account     text not null,
  kind        text not null default 'control' check (kind in ('control', 'query')),
  last_date   date,
  amount      numeric,
  note        text,
  created_by  uuid references public.staff_profiles(id) on delete set null,
  updated_by  uuid references public.staff_profiles(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references public.staff_profiles(id) on delete set null
);
create index if not exists tracker_control_lines_entity_idx on public.tracker_control_lines (entity_id);

create table if not exists public.tracker_bank_recs (
  realm_id         text not null,
  qbo_account_id   text not null,
  entity_id        uuid references public.entities(id) on delete set null,
  account_name     text,
  account_type     text,
  account_sub_type text,
  current_balance  numeric,
  active           boolean,
  reconciled_to    date,
  reconciled_count integer,
  checked_at       timestamptz not null default now(),
  primary key (realm_id, qbo_account_id)
);
create index if not exists tracker_bank_recs_entity_idx on public.tracker_bank_recs (entity_id);

alter table public.tracker_cells         enable row level security;
alter table public.tracker_control_lines enable row level security;
alter table public.tracker_bank_recs     enable row level security;

drop policy if exists tracker_cells_read on public.tracker_cells;
create policy tracker_cells_read on public.tracker_cells for select using (public.is_active_staff());
drop policy if exists tracker_control_lines_read on public.tracker_control_lines;
create policy tracker_control_lines_read on public.tracker_control_lines for select using (public.is_active_staff());
drop policy if exists tracker_bank_recs_read on public.tracker_bank_recs;
create policy tracker_bank_recs_read on public.tracker_bank_recs for select using (public.is_active_staff());

revoke all on public.tracker_cells, public.tracker_control_lines, public.tracker_bank_recs from public, anon;
grant select on public.tracker_cells, public.tracker_control_lines, public.tracker_bank_recs to authenticated;
grant all on public.tracker_cells, public.tracker_control_lines, public.tracker_bank_recs to service_role;

-- The payroll schema belongs to the BrightPay runner; staff cannot read it
-- directly. This is the one fact the grid needs: which realms have an active
-- BrightPay employer. Guarded, and exposes nothing else.
create or replace function public.tracker_payroll_realms()
returns table (realm_id text)
language sql
security definer
set search_path = public, payroll
stable
as $$
  select distinct e.destination_realm
  from payroll.employer e
  where e.active and e.destination = 'quickbooks' and e.destination_realm is not null
    and public.is_active_staff();
$$;
revoke all on function public.tracker_payroll_realms() from public, anon;
grant execute on function public.tracker_payroll_realms() to authenticated, service_role;

-- The grid. A client is on it when they have bookkeeping / VAT / management
-- accounts work in BrightManager, a QuickBooks connection, or a typed cell.
create or replace view public.v_tracker with (security_invoker = true) as
with conn as materialized (
  select c.entity_id, c.realm_id from public.qbo_report_connections c
  where c.status = 'active' and not coalesce(c.is_practice, false) and c.entity_id is not null
), book as materialized (
  select distinct b.entity_id from public.bm_task_schedule b
  where b.state = 'planned' and b.excluded_at is null and b.service in ('Bookkeeping', 'VAT', 'Management Accounts')
), members as materialized (
  select e.id as entity_id from public.entities e
  where e.entity_status not in ('nlac', 'archived')
    and (exists (select 1 from book b where b.entity_id = e.id)
      or exists (select 1 from conn c where c.entity_id = e.id)
      or exists (select 1 from public.tracker_cells t where t.entity_id = e.id)
      or exists (select 1 from public.tracker_control_lines l where l.entity_id = e.id))
), prep as materialized (
  select entity_id,
         coalesce(max(assignee_id::text) filter (where canonical_service_id = 'bookkeeping'),
                  max(assignee_id::text) filter (where canonical_service_id = 'vat_review'),
                  max(assignee_id::text) filter (where canonical_service_id = 'accounts_preparation'))::uuid as preparer_id
  from public.v_inferred_allocations
  where entity_id in (select entity_id from members)
  group by entity_id
), vat as materialized (
  select distinct on (b.entity_id) b.entity_id,
         (b.bm_task_name ~* 'Monthly End') as monthly,
         to_date(substring(b.bm_task_name from '(\d{2}/\d{2}/\d{4})'), 'DD/MM/YYYY') as period_end
  from public.bm_task_schedule b
  where b.state = 'planned' and b.excluded_at is null and b.service = 'VAT'
    and b.bm_task_name ~* '^VAT Submission' and b.bm_task_name ~ '\d{2}/\d{2}/\d{4}'
  order by b.entity_id, to_date(substring(b.bm_task_name from '(\d{2}/\d{2}/\d{4})'), 'DD/MM/YYYY')
), ye as materialized (
  select b.entity_id, min(to_date(substring(b.bm_task_name from 'Year End\s+(\d{2}/\d{2}/\d{4})'), 'DD/MM/YYYY')) filter (where to_date(substring(b.bm_task_name from 'Year End\s+(\d{2}/\d{2}/\d{4})'), 'DD/MM/YYYY') >= current_date - 400) as year_end
  from public.bm_task_schedule b
  where b.state = 'planned' and b.excluded_at is null and b.bm_task_name ~ 'Accounts Preparation Year End\s+\d{2}/\d{2}/\d{4}'
  group by b.entity_id
), recs as materialized (
  select r.entity_id,
         count(*) filter (where coalesce(r.active, true)) as accounts,
         min(r.reconciled_to) filter (where coalesce(r.active, true)) as oldest_reconciled_to,
         max(r.checked_at) as checked_at
  from public.tracker_bank_recs r
  where r.entity_id is not null
  group by r.entity_id
), main as materialized (
  select distinct on (r.entity_id) r.entity_id, r.account_name as main_account, r.reconciled_to as main_reconciled_to
  from public.tracker_bank_recs r
  where r.entity_id is not null and coalesce(r.active, true)
  order by r.entity_id, (r.account_sub_type = 'Checking') desc, r.reconciled_count desc nulls last, r.account_name
), jrn as materialized (
  select c.realm_id, max(m.period) as jrn_checked
  from public.journal_month_coverage m join conn c on c.realm_id = m.realm_id
  where m.status = 'checked'
  group by c.realm_id
), cells as materialized (
  select entity_id,
         max(value) filter (where col = 'cadence')     as cadence,
         max(value) filter (where col = 'me_journals') as me_journals,
         max(value) filter (where col = 'notes')       as notes,
         max(value) filter (where col = 'payroll')     as payroll_typed,
         max(value) filter (where col = 'vat_qtr')     as vat_typed,
         max(updated_at) as cells_updated_at
  from public.tracker_cells group by entity_id
), lines as materialized (
  select entity_id,
         count(*) filter (where resolved_at is null) as open_lines,
         count(*) filter (where resolved_at is null and kind = 'query') as open_queries,
         max(coalesce(updated_at, created_at)) as lines_updated_at
  from public.tracker_control_lines group by entity_id
), payroll_realms as materialized (
  select realm_id from public.tracker_payroll_realms()
)
select m.entity_id,
       e.name as client,
       e.entity_status,
       e.type as entity_type,
       c.realm_id,
       p.preparer_id,
       sp.name as preparer_name,
       ce.cadence,
       coalesce(ce.vat_typed,
         case when v.entity_id is null then null
              when v.monthly then 'Monthly'
              else to_char(v.period_end - interval '2 months', 'Mon') || '–' || to_char(v.period_end, 'Mon') end) as vat_qtr,
       v.period_end as vat_next_period_end,
       mn.main_account,
       mn.main_reconciled_to,
       r.accounts as bank_accounts,
       r.oldest_reconciled_to,
       r.checked_at as recs_checked_at,
       ce.me_journals,
       y.year_end,
       coalesce(ce.payroll_typed, case when pr.realm_id is not null then 'BP' end) as payroll,
       j.jrn_checked,
       ce.notes,
       coalesce(l.open_lines, 0) as open_lines,
       coalesce(l.open_queries, 0) as open_queries,
       greatest(ce.cells_updated_at, l.lines_updated_at) as last_touched
from members m
join public.entities e on e.id = m.entity_id
left join conn c on c.entity_id = m.entity_id
left join prep p on p.entity_id = m.entity_id
left join public.staff_profiles sp on sp.id = p.preparer_id
left join cells ce on ce.entity_id = m.entity_id
left join vat v on v.entity_id = m.entity_id
left join main mn on mn.entity_id = m.entity_id
left join recs r on r.entity_id = m.entity_id
left join ye y on y.entity_id = m.entity_id
left join payroll_realms pr on pr.realm_id = c.realm_id
left join jrn j on j.realm_id = c.realm_id
left join lines l on l.entity_id = m.entity_id;

revoke all on public.v_tracker from public, anon;
grant select on public.v_tracker to authenticated, service_role;

-- Nightly: every active client realm gets its bank recs refreshed.
create or replace function public.run_tracker_bank_recs_nightly()
returns integer
language plpgsql
security definer
set search_path to 'public', 'net', 'extensions', 'vault'
as $$
declare
  v_service_key text;
  v_realm text;
  v_n integer := 0;
begin
  if not public.is_staff_or_service() or coalesce(auth.role(), '') = 'authenticated' then
    raise exception 'not authorised' using errcode = '42501';
  end if;
  select decrypted_secret into v_service_key from vault.decrypted_secrets where name = 'planning_service_role_key' limit 1;
  if v_service_key is null then
    raise warning 'run_tracker_bank_recs_nightly: vault secret planning_service_role_key not set';
    return 0;
  end if;
  for v_realm in
    select c.realm_id from public.qbo_report_connections c
    where c.status = 'active' and not coalesce(c.is_practice, false) and c.entity_id is not null
  loop
    perform net.http_post(
      url := 'https://neksyvneljgxvpchwgch.supabase.co/functions/v1/dashboard-qbo-pull',
      headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_service_key, 'apikey', v_service_key),
      body := jsonb_build_object('realmId', v_realm, 'refresh', true, 'metrics', jsonb_build_array('bank_recs')),
      timeout_milliseconds := 150000
    );
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;
revoke all on function public.run_tracker_bank_recs_nightly() from public, anon, authenticated;

select cron.unschedule('tracker-bank-recs-nightly') where exists (select 1 from cron.job where jobname = 'tracker-bank-recs-nightly');
select cron.schedule('tracker-bank-recs-nightly', '0 5 * * *', $$select public.run_tracker_bank_recs_nightly()$$);

insert into public.scheduled_job_docs
  (job_key, source, title, category, purpose, data_source, mechanism, run_as, gate_label, external_cron, external_schedule, sort_order)
values ('tracker-bank-recs-nightly', 'pg_cron',
 'Tracker: bank reconciliation dates',
 'Client data ingest',
 'For every connected client, reads the reconciled-to date of each bank and card account from QuickBooks so the Tracker tab shows how far each rec has got without anyone typing it.',
 'QuickBooks Online: the TransactionList report filtered to reconciled transactions, per realm.',
 'Automatic. pg_cron calls dashboard-qbo-pull with the bank_recs metric for each active client realm at 05:00 UTC; the metric upserts tracker_bank_recs.',
 'The practice Intuit account, read-only: nothing is written back to QuickBooks.',
 null, null, null, 46)
on conflict (job_key) do nothing;
