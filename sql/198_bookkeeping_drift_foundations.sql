-- 198_bookkeeping_drift_foundations.sql
--
-- Foundations for the bookkeeping drift watch.
--
-- Two things have to exist before drift can be measured at all:
--
--   1. A LINK from a QuickBooks realm to an Athena client. Every one of the 146
--      rows in qbo_report_connections had entity_id NULL, so the live QBO estate
--      and the client record had nothing joining them — no cadence, no owner, no
--      deadline, no Work item. The dashboard got away with it because it renders
--      per realm using QuickBooks' own company name.
--
--   2. A statement of WHO KEEPS THE BOOKS and how closely each client is
--      watched. Drift on a file we keep is our failure and belongs to a team
--      member; drift on a client-kept file is information, and eventually a
--      client chaser. Same detection, different target — and mixing the two is
--      what makes this kind of alerting untrustworthy.
--
-- Nothing here reads a fee. The cadence comes from the work schedule
-- (v_service_cadence, derived from bm_task_schedule), so the whole drift stack
-- stays outside the fee-confidentiality boundary — see 176.

/* ── 1. Realm → client link ──────────────────────────────────────────────── */

-- entity_id already exists on qbo_report_connections (unused). These columns
-- record HOW it was set, so an auto-match can be told from a human decision and
-- re-running the matcher never silently overwrites someone's judgement.
alter table public.qbo_report_connections
  add column if not exists entity_link_source text,
  add column if not exists entity_linked_at   timestamptz,
  add column if not exists entity_linked_by   uuid references auth.users(id),
  add column if not exists link_dismissed     boolean not null default false;

comment on column public.qbo_report_connections.entity_link_source is
  'auto_exact = matched on normalised name (Ltd/Limited/punctuation ignored); manual = a human chose it. Manual always wins.';
comment on column public.qbo_report_connections.link_dismissed is
  'True for realms deliberately left unlinked — practice books, test files, a company we no longer act for. Keeps them out of the review queue without inventing a client.';

-- Name normalisation used by the matcher. Punctuation, spaces and case are
-- noise; so is the Ltd/Limited suffix, which QuickBooks and BrightManager
-- disagree about constantly ("Amy Plumbing Limited" vs "Amy Plumbing Ltd.").
create or replace function public.bk_norm_name(p text)
returns text
language sql
immutable
as $$
  select regexp_replace(
           upper(regexp_replace(coalesce(p, ''), '[^a-zA-Z0-9]', '', 'g')),
           '(LIMITED|LTD)$', ''
         );
$$;

-- Candidate matches for a realm, best first. Confidence is deliberately coarse:
--   exact  — normalised names are equal. Safe to apply without asking.
--   prefix — one name starts with the other ("Mechair" / "Mechair Technical
--            Services Limited"). Plausible, often right, never auto-applied.
-- Former clients are still returned but ranked last and labelled, because a
-- realm matching only an nlac/archived entity is itself a finding: we're holding
-- live API access to the books of a company we no longer act for.
create or replace view public.v_bk_realm_link_candidates as
with r as (
  select realm_id, company_name, public.bk_norm_name(company_name) k
  from public.qbo_report_connections
  where status = 'active' and coalesce(is_practice, false) = false
),
e as (
  select id, name, entity_status::text st, public.bk_norm_name(name) k
  from public.entities
)
select
  r.realm_id,
  r.company_name,
  e.id      as entity_id,
  e.name    as entity_name,
  e.st      as entity_status,
  (e.st in ('nlac', 'archived')) as is_former,
  case when e.k = r.k then 'exact' else 'prefix' end as confidence
from r
join e on e.k = r.k
       or (length(r.k) >= 5 and length(e.k) >= 5
           and (e.k like r.k || '%' or r.k like e.k || '%'))
where r.k <> '';

-- One row per realm: where it stands, and what it could be linked to.
-- linked            — has an entity_id
-- ambiguous         — several live clients share the name; a human must pick
-- former_client_only— the only match is a client we no longer act for
-- suggested         — one plausible candidate, needs a click
-- unmatched         — nothing found, search by hand
create or replace view public.v_bk_realm_link_review as
with c as (
  select * from public.v_bk_realm_link_candidates
),
agg as (
  select realm_id,
         count(*) filter (where confidence = 'exact' and not is_former) as n_exact_live,
         count(*) filter (where not is_former)                          as n_live,
         count(*)                                                       as n_any
  from c group by realm_id
)
select
  rc.realm_id,
  rc.company_name,
  rc.entity_id,
  ent.name        as entity_name,
  rc.entity_link_source,
  rc.entity_linked_at,
  rc.link_dismissed,
  case
    when rc.entity_id is not null           then 'linked'
    when rc.link_dismissed                  then 'dismissed'
    when coalesce(a.n_exact_live, 0) > 1    then 'ambiguous'
    when coalesce(a.n_live, 0) = 0
     and coalesce(a.n_any, 0) > 0           then 'former_client_only'
    when coalesce(a.n_live, 0) >= 1         then 'suggested'
    else 'unmatched'
  end as review_state,
  coalesce((
    select jsonb_agg(jsonb_build_object(
             'entity_id', c.entity_id, 'entity_name', c.entity_name,
             'entity_status', c.entity_status, 'is_former', c.is_former,
             'confidence', c.confidence)
           order by c.is_former, (c.confidence = 'exact') desc, c.entity_name)
    from c where c.realm_id = rc.realm_id
  ), '[]'::jsonb) as candidates
from public.qbo_report_connections rc
left join public.entities ent on ent.id = rc.entity_id
left join agg a on a.realm_id = rc.realm_id
where rc.status = 'active' and coalesce(rc.is_practice, false) = false;

-- Apply the unambiguous matches. Only ever fills a NULL entity_id, and only
-- where exactly one LIVE client matches exactly — so re-running is safe and a
-- manual correction is never clobbered.
create or replace function public.bk_autolink_realms()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare v_n int;
begin
  with one as (
    select realm_id, (array_agg(entity_id))[1] entity_id
    from public.v_bk_realm_link_candidates
    where confidence = 'exact' and not is_former
    group by realm_id
    having count(*) = 1
  )
  update public.qbo_report_connections rc
     set entity_id = one.entity_id,
         entity_link_source = 'auto_exact',
         entity_linked_at = now()
    from one
   where rc.realm_id = one.realm_id
     and rc.entity_id is null
     and coalesce(rc.is_practice, false) = false
     and rc.status = 'active';
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

revoke all on function public.bk_autolink_realms() from public, anon;
grant execute on function public.bk_autolink_realms() to authenticated, service_role;

-- Human link/unlink. Manual always outranks the matcher.
create or replace function public.bk_link_realm(p_realm_id text, p_entity_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_active_staff() then
    raise exception 'Not authorised';
  end if;
  update public.qbo_report_connections
     set entity_id = p_entity_id,
         entity_link_source = case when p_entity_id is null then null else 'manual' end,
         entity_linked_at = case when p_entity_id is null then null else now() end,
         entity_linked_by = case when p_entity_id is null then null else auth.uid() end,
         link_dismissed = false
   where realm_id = p_realm_id;
end;
$$;

create or replace function public.bk_dismiss_realm(p_realm_id text, p_dismissed boolean default true)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_active_staff() then
    raise exception 'Not authorised';
  end if;
  update public.qbo_report_connections
     set link_dismissed = p_dismissed
   where realm_id = p_realm_id;
end;
$$;

revoke all on function public.bk_link_realm(text, uuid)      from public, anon;
revoke all on function public.bk_dismiss_realm(text, boolean) from public, anon;
grant execute on function public.bk_link_realm(text, uuid)      to authenticated;
grant execute on function public.bk_dismiss_realm(text, boolean) to authenticated;

/* ── 2. Who keeps the books, and how closely we watch ────────────────────── */

create table if not exists public.bk_watch_config (
  entity_id            uuid primary key references public.entities(id) on delete cascade,

  -- 'us'    — we do the bookkeeping. Drift is ours; it nudges a team member.
  -- 'client'— the client keeps the books, we review/file VAT. Drift is
  --           information, and later a client chaser. Never a team nudge.
  books_owner          text not null default 'unknown',
  books_owner_source   text,                       -- auto_service_cadence | manual

  cadence              text,                       -- null → derive from v_service_cadence
  tolerance_days       int,                        -- null → derive from cadence + tier

  -- Tier is a judgement call, so it is proposed by rule and confirmed by a
  -- human. tier is what the watch uses; tier_suggested is what is waiting for
  -- an answer. Nothing is promoted without approval.
  tier                 text not null default 'standard',
  tier_suggested       text,
  tier_suggested_why   text,
  tier_suggested_at    timestamptz,
  tier_approved_by     uuid references auth.users(id),
  tier_approved_at     timestamptz,

  assignee_id          uuid references auth.users(id),
  manager_id           uuid references auth.users(id),

  -- Pausing is always time-boxed. An open-ended mute is how a watch quietly
  -- stops being a watch.
  paused_until         date,
  pause_reason         text,
  paused_by            uuid references auth.users(id),

  watch_enabled        boolean not null default true,
  notes                text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  constraint bk_watch_owner_ck  check (books_owner in ('us', 'client', 'third_party', 'unknown')),
  constraint bk_watch_tier_ck   check (tier in ('standard', 'priority', 'critical')),
  constraint bk_watch_sugg_ck   check (tier_suggested is null or tier_suggested in ('standard', 'priority', 'critical')),
  constraint bk_watch_cadence_ck check (cadence is null or cadence in ('monthly', 'quarterly', 'annual'))
);

create index if not exists bk_watch_owner_idx on public.bk_watch_config (books_owner) where watch_enabled;

comment on table public.bk_watch_config is
  'Per-client bookkeeping watch settings. books_owner splits the drift board into "ours" (team action) and "theirs" (information).';

-- Tolerance ladder. Days a file may sit behind its reconciliation frontier
-- before it counts as drifting. Deliberately generous at standard/quarterly —
-- the deadline-aware tightening in the scoring view does the sharp end.
create or replace function public.bk_tolerance_days(p_cadence text, p_tier text)
returns int
language sql
immutable
as $$
  select case coalesce(p_cadence, 'quarterly')
    when 'monthly' then case coalesce(p_tier, 'standard')
                          when 'critical' then 21 when 'priority' then 30 else 45 end
    when 'quarterly' then case coalesce(p_tier, 'standard')
                          when 'critical' then 40 when 'priority' then 55 else 75 end
    else case coalesce(p_tier, 'standard')
                          when 'critical' then 120 when 'priority' then 180 else 270 end
  end;
$$;

-- Seed / refresh books_owner from the work schedule.
--   a Bookkeeping job in BrightManager        → we keep the books
--   VAT submissions but no bookkeeping job    → the client keeps them, we file
-- Only ever fills rows whose books_owner is still auto-derived; a manual answer
-- is never overwritten.
create or replace function public.bk_seed_watch_config()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare v_n int;
begin
  with src as (
    select entity_id,
           bool_or(canonical_service_id = 'bookkeeping') as does_bk,
           bool_or(canonical_service_id = 'vat_review')  as does_vat,
           min(cadence) filter (where canonical_service_id in ('bookkeeping', 'vat_review')) as cadence
    from public.v_service_cadence
    where canonical_service_id in ('bookkeeping', 'vat_review')
    group by entity_id
  ),
  linked as (
    -- Only clients whose books we can actually see. A watch on a file with no
    -- live connection would be permanently "unknown", which reads as noise.
    select distinct rc.entity_id
    from public.qbo_report_connections rc
    join public.qbo_report_tokens t on t.realm_id = rc.realm_id and t.status = 'active'
    where rc.entity_id is not null and rc.status = 'active'
  )
  insert into public.bk_watch_config as w (entity_id, books_owner, books_owner_source, cadence)
  select s.entity_id,
         case when s.does_bk then 'us' else 'client' end,
         'auto_service_cadence',
         s.cadence
  from src s
  join linked l on l.entity_id = s.entity_id
  on conflict (entity_id) do update
    set books_owner = case when w.books_owner_source = 'manual' then w.books_owner else excluded.books_owner end,
        cadence     = coalesce(w.cadence, excluded.cadence),
        updated_at  = now();
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

revoke all on function public.bk_seed_watch_config() from public, anon;
grant execute on function public.bk_seed_watch_config() to authenticated, service_role;

/* ── 3. Priority tier: suggested by rule, approved by a human ────────────── */

-- A new flag rather than reusing can_view_client_fees, which three people hold.
-- Seeded to portal admins so the screen isn't dead on arrival; untick whoever
-- shouldn't have it in Admin → Staff.
alter table public.staff_profiles
  add column if not exists can_approve_bk_priority boolean not null default false;

update public.staff_profiles
   set can_approve_bk_priority = true
 where can_manage_portal = true
   and can_approve_bk_priority = false;

-- Propose a tier. Rules are deliberately explainable — the reason is shown to
-- the approver, because "the system says so" is not a reason to promise a
-- client we'll never let their books slip.
--   critical: monthly VAT (a late month is a late return, every month)
--   priority: monthly bookkeeping cadence, or a history of confirmed drift
create or replace function public.bk_suggest_tiers()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare v_n int;
begin
  with sig as (
    select w.entity_id,
           bool_or(c.canonical_service_id = 'vat_review'  and c.cadence = 'monthly') as monthly_vat,
           bool_or(c.canonical_service_id = 'bookkeeping' and c.cadence = 'monthly') as monthly_bk
    from public.bk_watch_config w
    left join public.v_service_cadence c on c.entity_id = w.entity_id
    group by w.entity_id
  ),
  proposal as (
    select entity_id,
           case when monthly_vat then 'critical'
                when monthly_bk  then 'priority' end as tier,
           case when monthly_vat then 'Monthly VAT returns — a month behind is a late return'
                when monthly_bk  then 'Monthly bookkeeping cadence' end as why
    from sig
    where monthly_vat or monthly_bk
  )
  update public.bk_watch_config w
     set tier_suggested = p.tier,
         tier_suggested_why = p.why,
         tier_suggested_at = now(),
         updated_at = now()
    from proposal p
   where w.entity_id = p.entity_id
     and w.tier <> p.tier                        -- already there, nothing to ask
     and coalesce(w.tier_suggested, '') <> p.tier; -- already asked, don't re-ask
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- Approve or reject a suggestion, or set a tier outright.
create or replace function public.bk_set_tier(p_entity_id uuid, p_tier text, p_accept boolean default true)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from public.staff_profiles
    where id = auth.uid() and can_approve_bk_priority = true
  ) then
    raise exception 'Not authorised to set bookkeeping priority';
  end if;

  if p_accept then
    update public.bk_watch_config
       set tier = coalesce(p_tier, tier),
           tier_approved_by = auth.uid(), tier_approved_at = now(),
           tier_suggested = null, tier_suggested_why = null, tier_suggested_at = null,
           updated_at = now()
     where entity_id = p_entity_id;
  else
    -- Rejected: clear the suggestion so it stops asking, leave the tier alone.
    update public.bk_watch_config
       set tier_suggested = null, tier_suggested_why = null, tier_suggested_at = null,
           updated_at = now()
     where entity_id = p_entity_id;
  end if;
end;
$$;

revoke all on function public.bk_suggest_tiers()                    from public, anon;
revoke all on function public.bk_set_tier(uuid, text, boolean)      from public, anon;
grant execute on function public.bk_suggest_tiers()                 to authenticated, service_role;
grant execute on function public.bk_set_tier(uuid, text, boolean)   to authenticated;

/* ── 4. RLS ──────────────────────────────────────────────────────────────── */

alter table public.bk_watch_config enable row level security;

drop policy if exists "staff read bk watch"   on public.bk_watch_config;
drop policy if exists "staff write bk watch"  on public.bk_watch_config;

create policy "staff read bk watch" on public.bk_watch_config
  for select to authenticated using (public.is_active_staff());

-- Any active staff member can set who keeps the books, the assignee or a pause;
-- tier changes go through bk_set_tier(), which checks the approval flag.
create policy "staff write bk watch" on public.bk_watch_config
  for all to authenticated
  using (public.is_active_staff())
  with check (public.is_active_staff());

/* ── 5. Backfill ─────────────────────────────────────────────────────────── */

select public.bk_autolink_realms()   as realms_linked;
select public.bk_seed_watch_config() as clients_watched;
select public.bk_suggest_tiers()     as tiers_suggested;
