-- ============================================================
-- 367 — Cross-check: a BrightPay link that keeps itself current,
--       and per-mark overrides with a comment
--
-- 1. hmrc.brightpay_link (BrightPay employer → Athena client) was filled once,
--    on 2026-08-09, and nothing ever wrote to it again. Every payroll set up in
--    BrightPay since then read as "payroll not on BrightPay" on the Cross-check
--    (Neon Fizz, Barnarlo Design, Waterfall Communications, Carrick Pension
--    Scheme). sync_brightpay_link() now runs whenever payroll.employer or a
--    client's name changes, using the same normalised-name match as the
--    original fill (lowercase, drop the legal suffix, drop punctuation):
--      * an employer with no link row gets one (matched, or 'unmatched' so it
--        shows on the orphans list rather than vanishing);
--      * an 'unmatched' row is retried, so a client created in Athena after its
--        payroll links itself;
--      * a renamed employer is re-matched.
--    A row that matched and still carries the same employer name is left
--    alone, so a link never drifts under someone who relied on it.
--
-- 2. onboarding_crosscheck_overrides: a person can look at a mark, decide it
--    is explained (e.g. payroll billed through another company in the group),
--    and say why. The override is bound to the exact wording of the issue it
--    was made against (`issue`); if the check later says something different,
--    the override stops applying and the mark comes back. Written only by the
--    crosscheck-override edge function.
-- ============================================================

-- ── 1. BrightPay link ────────────────────────────────────────────────
create or replace function hmrc.brightpay_name_key(name text)
returns text
language sql immutable
set search_path = ''
as $$
  select regexp_replace(
           regexp_replace(lower(coalesce(name, '')), '\s+(limited|ltd|llp|plc)\.?$', ''),
           '[^a-z0-9]', '', 'g');
$$;

create or replace function hmrc.sync_brightpay_link()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  with emp as (
    select em.id as employer_id,
           coalesce(nullif(btrim(em.sheet_name), ''), em.brightpay_name) as employer_name
    from payroll.employer em
  ),
  todo as (
    select e.employer_id, e.employer_name
    from emp e
    left join hmrc.brightpay_link l on l.employer_id = e.employer_id
    where l.employer_id is null
       or l.entity_id is null
       or l.employer_name is distinct from e.employer_name
  ),
  matched as (
    select t.employer_id, t.employer_name, m.id as entity_id, m.name as entity_name
    from todo t
    left join lateral (
      select en.id, en.name
      from public.entities en
      where hmrc.brightpay_name_key(en.name) = hmrc.brightpay_name_key(t.employer_name)
        and hmrc.brightpay_name_key(t.employer_name) <> ''
      order by (en.entity_status::text = 'active') desc, en.name
      limit 1
    ) m on true
  )
  insert into hmrc.brightpay_link (employer_id, employer_name, entity_id, entity_name, method, linked_at)
  select employer_id, employer_name, entity_id, entity_name,
         case when entity_id is null then 'unmatched' else 'name' end, now()
  from matched
  on conflict (employer_id) do update
    set employer_name = excluded.employer_name,
        entity_id     = excluded.entity_id,
        entity_name   = excluded.entity_name,
        method        = excluded.method,
        linked_at     = excluded.linked_at;
end;
$$;

create or replace function hmrc.trg_sync_brightpay_link()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Never let the link block a client or payroll write (the BM import, the
  -- journal runner). A failed sync leaves the link as it was; the next write retries.
  begin
    perform hmrc.sync_brightpay_link();
  exception when others then
    raise warning 'sync_brightpay_link failed: %', sqlerrm;
  end;
  return null;
end;
$$;

-- Statement-level: one sync per import statement, not per row.
drop trigger if exists sync_brightpay_link on payroll.employer;
create trigger sync_brightpay_link
  after insert or update of sheet_name, brightpay_name on payroll.employer
  for each statement execute function hmrc.trg_sync_brightpay_link();

drop trigger if exists sync_brightpay_link on public.entities;
create trigger sync_brightpay_link
  after insert or update of name on public.entities
  for each statement execute function hmrc.trg_sync_brightpay_link();

revoke all on function hmrc.brightpay_name_key(text) from public, anon, authenticated;
revoke all on function hmrc.sync_brightpay_link() from public, anon, authenticated;
revoke all on function hmrc.trg_sync_brightpay_link() from public, anon, authenticated;
grant execute on function hmrc.sync_brightpay_link() to service_role;

select hmrc.sync_brightpay_link();

-- ── 2. Overrides ─────────────────────────────────────────────────────
create table if not exists public.onboarding_crosscheck_overrides (
  entity_id   uuid not null references public.entities(id) on delete cascade,
  check_key   text not null check (check_key in ('loe','ct','sa','vat','paye','bp','tc','qbo','fee')),
  issue       text not null,                          -- the check's wording when overridden
  comment     text not null check (length(btrim(comment)) > 0),
  created_by  uuid references public.staff_profiles(id),
  created_at  timestamptz not null default now(),
  primary key (entity_id, check_key)
);

comment on table public.onboarding_crosscheck_overrides is
  'A Cross-check mark a person has reviewed and explained. Applies only while the check still reports the same issue text. Written by the crosscheck-override edge function.';

alter table public.onboarding_crosscheck_overrides enable row level security;
revoke all on public.onboarding_crosscheck_overrides from public, anon, authenticated;
grant select on public.onboarding_crosscheck_overrides to authenticated;
grant all on public.onboarding_crosscheck_overrides to service_role;

drop policy if exists crosscheck_overrides_staff_read on public.onboarding_crosscheck_overrides;
create policy crosscheck_overrides_staff_read on public.onboarding_crosscheck_overrides
  for select to authenticated using (is_active_staff());
