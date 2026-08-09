-- 197 — HMRC module: public read surface + triage layer over the `hmrc` schema.
--
-- The scraper writes into a private `hmrc` schema (run / client / position /
-- charge / credit / payment / overdue_item / link_exception / disengage). That
-- schema is NOT served by PostgREST — same reason as `payroll` (see sql/192):
-- exposing it would publish the whole scraper state, including its working
-- tables, to the API surface.
--
-- sql/192 solved that with SECURITY DEFINER functions because the caller was an
-- edge function fetching a handful of rows. Here the caller is a browser list
-- UI that wants to sort, filter and page, so the accessors are DEFINER VIEWS in
-- `public` instead — supabase-js can .select() them like any other table.
--
-- Because a definer view runs as its owner, the `where hmrc_can_read()` guard on
-- each one IS the access control: the views are granted to `authenticated`, and
-- client-portal users hold `authenticated` sessions too. Without the guard a
-- logged-in client could read every other client's PAYE debt.
--
-- MONEY: the scraper stores pence (bigint). Every view here converts to pounds
-- (numeric, 2dp) so the frontend can hand values straight to fmtGbp. Nothing
-- downstream should ever see pence.
--
-- Only PAYE is scraped today; `hmrc.run.service` and `hmrc.disengage.service`
-- already carry a service discriminator, so the views expose it and the module
-- is built to grow a VAT / CT / SA tab beside the PAYE one.

-- ── who may read ───────────────────────────────────────────────────
-- is_active_staff() exists but is VOLATILE, so Postgres would re-evaluate it
-- per row inside a view. This is the same predicate marked STABLE, which lets
-- the planner fold it into a one-time filter.
create or replace function public.hmrc_can_read()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from staff_profiles
    where id = auth.uid() and is_active = true
  );
$$;

comment on function public.hmrc_can_read() is
  'STABLE staff check used as the access guard inside the definer v_hmrc_* views. Same rule as is_active_staff(); separate function only so it folds into a one-time filter.';

revoke all on function public.hmrc_can_read() from public, anon;
grant execute on function public.hmrc_can_read() to authenticated, service_role;

-- ── triage layer ───────────────────────────────────────────────────
-- The scrape tells us who owes what. It cannot tell us what we have DONE about
-- it, and that is the whole point of the module: a debt list nobody has marked
-- up is just a report. Keyed on paye_ref rather than entity_id because a scheme
-- can appear on our agent list before (or after) it is an Athena entity, and
-- those unlinked ones are exactly the rows that need chasing.
create table if not exists public.hmrc_debt_reviews (
  paye_ref    text primary key,
  service     text not null default 'paye',
  status      text not null default 'pending'
    check (status in ('pending', 'chasing', 'awaiting_client', 'plan_agreed', 'resolved', 'ignore')),
  notes       text,
  reviewed_at timestamptz,
  reviewed_by uuid references staff_profiles(id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on table public.hmrc_debt_reviews is
  'Per-scheme triage of HMRC debt (see v_hmrc_paye_clients): pending / chasing / '
  'awaiting_client / plan_agreed / resolved / ignore. Mirrors fee_engine_gap_reviews. '
  'Keyed on paye_ref, not entity_id — unlinked schemes still need working.';

alter table public.hmrc_debt_reviews enable row level security;

drop policy if exists "staff read hmrc debt reviews" on public.hmrc_debt_reviews;
create policy "staff read hmrc debt reviews" on public.hmrc_debt_reviews
  for select using (is_active_staff());

drop policy if exists "staff write hmrc debt reviews" on public.hmrc_debt_reviews;
create policy "staff write hmrc debt reviews" on public.hmrc_debt_reviews
  for all using (is_active_staff()) with check (is_active_staff());

-- ── one row per scheme: the working list ───────────────────────────
create or replace view public.v_hmrc_paye_clients as
with latest as (
  -- The scraper appends a position row per run; the module always means "as at
  -- the most recent scrape of this scheme".
  select distinct on (p.client_id) p.*
  from hmrc.position p
  order by p.client_id, p.scraped_at desc
),
od as (
  select
    o.client_id,
    count(*)                                                          as overdue_items,
    count(*) filter (where o.section = 'monthly')                     as overdue_monthly_items,
    count(*) filter (where o.section = 'additional')                  as overdue_additional_items,
    count(*) filter (where o.charge_type = 'Penalty')                 as penalty_items,
    min(to_date(o.due_date, 'DD Mon YYYY'))                           as oldest_due_date,
    min(o.tax_year)                                                   as oldest_overdue_year,
    round(sum(o.interest)             / 100.0, 2)                     as overdue_interest,
    round(sum(o.amount_due) filter (where o.charge_type = 'Penalty')
                                      / 100.0, 2)                     as penalties
  from hmrc.overdue_item o
  group by o.client_id
)
select
  c.id                                          as hmrc_client_id,
  c.paye_ref,
  c.district,
  c.reference,
  c.name                                        as hmrc_name,
  c.your_reference,
  c.accounts_office_ref,
  c.entity_id,
  coalesce(c.entity_name, e.name)               as entity_name,
  c.link_method,
  coalesce(e.entity_status::text, 'no_athena_record') as athena_status,
  case
    when c.entity_id is null                                     then 'not_a_client'
    when e.entity_status::text = 'active'                        then 'client'
    when e.entity_status::text in ('archived', 'nlac')           then 'former_client'
    else 'unclear'
  end                                           as standing,
  l.tax_year,
  round(l.total_debt          / 100.0, 2)       as total_debt,
  round(l.overdue_monthly     / 100.0, 2)       as overdue_monthly,
  round(l.overdue_additional  / 100.0, 2)       as overdue_additional,
  round(l.accruing_interest   / 100.0, 2)       as accruing_interest,
  round(l.amount_due_year     / 100.0, 2)       as amount_due_year,
  round(l.charges             / 100.0, 2)       as charges,
  round(l.credits             / 100.0, 2)       as credits,
  round(l.payments            / 100.0, 2)       as payments,
  l.payment_plan,
  l.variable_dd,
  l.claiming_ea,
  l.scraped_at,
  coalesce(od.overdue_items, 0)                 as overdue_items,
  coalesce(od.overdue_monthly_items, 0)         as overdue_monthly_items,
  coalesce(od.overdue_additional_items, 0)      as overdue_additional_items,
  coalesce(od.penalty_items, 0)                 as penalty_items,
  coalesce(od.penalties, 0)                     as penalties,
  coalesce(od.overdue_interest, 0)              as overdue_interest,
  od.oldest_due_date,
  od.oldest_overdue_year,
  case when od.oldest_due_date is not null
       then (current_date - od.oldest_due_date) end as days_oldest_overdue,
  -- Chase tiering. The distinction that matters operationally is not "how big"
  -- but "is this a scheme that has stopped paying". Arrears carried from an
  -- earlier tax year is a different (and worse) problem from being one month
  -- behind, and a scheme already on a payment plan is being handled by HMRC.
  case
    when coalesce(l.total_debt, 0) <= 0                                     then 4
    when l.payment_plan is true                                             then 3
    when od.oldest_overdue_year is not null
     and od.oldest_overdue_year < l.tax_year                                then 1
    else 2
  end                                           as chase_tier,
  coalesce(r.status, 'pending')                 as review_status,
  r.notes                                       as review_notes,
  r.reviewed_at                                 as review_reviewed_at
from hmrc.client c
left join latest l           on l.client_id = c.id
left join od                 on od.client_id = c.id
left join public.entities e  on e.id = c.entity_id
left join public.hmrc_debt_reviews r on r.paye_ref = c.paye_ref
where public.hmrc_can_read();

comment on view public.v_hmrc_paye_clients is
  'One row per PAYE scheme as at its latest scrape: debt, arrears age, chase tier and triage status. Amounts in POUNDS.';

-- ── drill-down: what makes up the debt ─────────────────────────────
create or replace view public.v_hmrc_paye_overdue as
select
  o.id,
  c.paye_ref,
  c.entity_id,
  o.section,
  o.period,
  o.tax_year,
  o.tax_month,
  o.due_date                                    as due_date_text,
  to_date(o.due_date, 'DD Mon YYYY')            as due_date,
  o.charge_type,
  round(o.interest   / 100.0, 2)                as interest,
  round(o.amount_due / 100.0, 2)                as amount_due
from hmrc.overdue_item o
join hmrc.client c on c.id = o.client_id
where public.hmrc_can_read();

comment on view public.v_hmrc_paye_overdue is
  'Individual overdue PAYE charges behind each scheme''s debt figure. Amounts in POUNDS.';

-- Monthly grid for the scraped year: charged, relieved, paid, still due.
create or replace view public.v_hmrc_paye_months as
select
  ch.id,
  c.paye_ref,
  c.entity_id,
  ch.tax_year,
  ch.tax_month,
  ch.label,
  round(ch.charges    / 100.0, 2)               as charges,
  round(ch.credits    / 100.0, 2)               as credits,
  round(ch.payments   / 100.0, 2)               as payments,
  round(ch.net_charge / 100.0, 2)               as net_charge,
  round(ch.amount_due / 100.0, 2)               as amount_due,
  ch.overdue
from hmrc.charge ch
join hmrc.client c on c.id = ch.client_id
where public.hmrc_can_read();

comment on view public.v_hmrc_paye_months is
  'Per-tax-month PAYE position for the scraped year. Amounts in POUNDS.';

create or replace view public.v_hmrc_paye_payments as
select
  p.id,
  c.paye_ref,
  c.entity_id,
  p.tax_year,
  p.received_on                                 as received_on_text,
  to_date(p.received_on, 'DD Mon YYYY')         as received_on,
  p.allocated_to,
  p.allocated_year,
  p.allocated_month,
  round(p.amount / 100.0, 2)                    as amount
from hmrc.payment p
join hmrc.client c on c.id = p.client_id
where public.hmrc_can_read();

comment on view public.v_hmrc_paye_payments is
  'Payments HMRC has received against a PAYE scheme, and where they were allocated. Amounts in POUNDS.';

create or replace view public.v_hmrc_paye_credits as
select
  cr.id,
  c.paye_ref,
  c.entity_id,
  cr.tax_year,
  cr.credit_type,
  cr.allocated_to,
  cr.tax_month,
  round(cr.amount / 100.0, 2)                   as amount
from hmrc.credit cr
join hmrc.client c on c.id = cr.client_id
where public.hmrc_can_read();

comment on view public.v_hmrc_paye_credits is
  'Credits set against PAYE charges — Employment Allowance, statutory pay recovery, CIS suffered, early-payment interest. Amounts in POUNDS.';

-- ── reconciliation: agent list vs Athena ───────────────────────────
-- For a scheme HMRC knows about but Athena does not, the useful next step is
-- almost always "is this the same client under a slightly different name?".
-- Normalising away the legal suffix and punctuation catches most of them
-- without needing pg_trgm.
create or replace view public.v_hmrc_link_exceptions as
with norm as (
  select
    id,
    name,
    entity_status,
    regexp_replace(
      regexp_replace(lower(name), '\s+(limited|ltd|llp|plc)\.?$', ''),
      '[^a-z0-9]', '', 'g'
    ) as key
  from public.entities
)
select
  x.id,
  x.run_id,
  x.paye_ref,
  x.hmrc_name,
  x.entity_id,
  x.entity_name,
  x.kind,
  x.athena_value,
  x.hmrc_value,
  x.proposed_sql,
  x.resolved,
  x.resolved_at,
  x.note,
  x.raised_at,
  s.id                    as suggested_entity_id,
  s.name                  as suggested_entity_name,
  s.entity_status::text   as suggested_entity_status
from hmrc.link_exception x
left join lateral (
  select n.id, n.name, n.entity_status
  from norm n
  where n.key = regexp_replace(
          regexp_replace(lower(x.hmrc_name), '\s+(limited|ltd|llp|plc)\.?$', ''),
          '[^a-z0-9]', '', 'g')
  order by (n.entity_status::text = 'active') desc, n.name
  limit 1
) s on true
where public.hmrc_can_read();

comment on view public.v_hmrc_link_exceptions is
  'Mismatches between the HMRC agent list and Athena, with a normalised-name suggestion where one exists. Work list for keeping the two in step.';

-- Schemes on our agent list that are not (or are no longer) a client — the
-- authorisation we should be handing back.
create or replace view public.v_hmrc_authorisation_review as
select
  d.id,
  d.service,
  d.paye_ref,
  d.hmrc_name,
  d.entity_id,
  d.entity_name,
  d.reason,
  round(coalesce(d.last_known_debt, 0) / 100.0, 2) as last_known_debt,
  d.first_flagged,
  d.last_seen_on_list,
  (current_date - d.first_flagged::date)           as days_outstanding,
  d.removed_at,
  d.removed_by,
  d.note
from hmrc.disengage d
where public.hmrc_can_read();

comment on view public.v_hmrc_authorisation_review is
  'Schemes we still hold HMRC authorisation for with no matching active Athena client. Open rows have removed_at is null. Amounts in POUNDS.';

-- ── scrape health ──────────────────────────────────────────────────
create or replace view public.v_hmrc_runs as
select
  r.id,
  r.service,
  r.tax_year,
  r.started_at,
  r.finished_at,
  r.clients_seen,
  r.clients_ok,
  r.clients_failed,
  r.notes
from hmrc.run r
where public.hmrc_can_read();

comment on view public.v_hmrc_runs is
  'Scrape history — is the HMRC data current, and did the last run get everybody?';

-- ── the two writes back into the private schema ────────────────────
-- Same reasoning as sql/192: the scraper owns these tables, so Athena gets
-- named entry points rather than an UPDATE grant.
create or replace function public.hmrc_set_exception_resolved(
  p_id       bigint,
  p_resolved boolean
)
returns void
language plpgsql
security definer
set search_path = public, hmrc
as $$
begin
  if not is_active_staff() then
    raise exception 'Not authorised';
  end if;

  update hmrc.link_exception
     set resolved    = p_resolved,
         resolved_at = case when p_resolved then now() else null end
   where id = p_id;
end;
$$;

create or replace function public.hmrc_set_exception_note(
  p_id   bigint,
  p_note text
)
returns void
language plpgsql
security definer
set search_path = public, hmrc
as $$
begin
  if not is_active_staff() then
    raise exception 'Not authorised';
  end if;

  update hmrc.link_exception
     set note = nullif(p_note, '')
   where id = p_id;
end;
$$;

-- Closing an authorisation review means "we have dealt with this scheme" —
-- either the authorisation was handed back or it turned out to be ours after
-- all. It never deletes: the row stays for the audit trail, stamped with who
-- closed it. A later scrape re-flagging the same scheme raises a fresh row.
create or replace function public.hmrc_close_authorisation_review(
  p_id   bigint,
  p_note text default null
)
returns void
language plpgsql
security definer
set search_path = public, hmrc
as $$
declare
  v_who text;
begin
  if not is_active_staff() then
    raise exception 'Not authorised';
  end if;

  select name into v_who from public.staff_profiles where id = auth.uid();

  update hmrc.disengage
     set removed_at = now(),
         removed_by = coalesce(v_who, 'athena'),
         note       = coalesce(nullif(p_note, ''), note)
   where id = p_id
     and removed_at is null;
end;
$$;

create or replace function public.hmrc_reopen_authorisation_review(p_id bigint)
returns void
language plpgsql
security definer
set search_path = public, hmrc
as $$
begin
  if not is_active_staff() then
    raise exception 'Not authorised';
  end if;

  update hmrc.disengage
     set removed_at = null, removed_by = null
   where id = p_id;
end;
$$;

-- ── grants ─────────────────────────────────────────────────────────
-- Views: definer, so the guard inside each one is the access control. anon must
-- never reach them.
do $$
declare v text;
begin
  foreach v in array array[
    'v_hmrc_paye_clients', 'v_hmrc_paye_overdue', 'v_hmrc_paye_months',
    'v_hmrc_paye_payments', 'v_hmrc_paye_credits', 'v_hmrc_link_exceptions',
    'v_hmrc_authorisation_review', 'v_hmrc_runs'
  ] loop
    execute format('revoke all on public.%I from public, anon', v);
    execute format('grant select on public.%I to authenticated, service_role', v);
  end loop;
end $$;

revoke all on function public.hmrc_set_exception_resolved(bigint, boolean)     from public, anon;
revoke all on function public.hmrc_set_exception_note(bigint, text)            from public, anon;
revoke all on function public.hmrc_close_authorisation_review(bigint, text)    from public, anon;
revoke all on function public.hmrc_reopen_authorisation_review(bigint)         from public, anon;

grant execute on function public.hmrc_set_exception_resolved(bigint, boolean)  to authenticated, service_role;
grant execute on function public.hmrc_set_exception_note(bigint, text)         to authenticated, service_role;
grant execute on function public.hmrc_close_authorisation_review(bigint, text) to authenticated, service_role;
grant execute on function public.hmrc_reopen_authorisation_review(bigint)      to authenticated, service_role;
