-- 136: Tighten the "possible duplicate person" data-quality scan.
--
-- Two problems reported (2026-07-21):
--   * Former clients leaked in: the scan never filtered entity_status, so a
--     duplicate director at an nlac/archived client (Gordon Hunter / Scotia
--     Supply Co. Ltd.) still raised a task. Former clients belong nowhere but
--     the nlac_bm_mirror task (see project_nlac_read_time_filter).
--   * False positives on same surname + birth month/year but DIFFERENT first
--     name (Gemma Ali / Iraj Ali). Companies House only exposes birth
--     YEAR+MONTH (never the day), so DOB alone can't separate them — but the
--     forenames plainly can. We only want pairs that are plausibly ONE person
--     written two ways (missing middle name, a title, a spelling of the SAME
--     forename), i.e. the first forename token matches.

-- Shared helper: leading title stripped, commas → spaces, first forename token.
create or replace function public._person_first_token(p_name text)
returns text language sql immutable as $$
  select lower(split_part(
    btrim(regexp_replace(
      regexp_replace(coalesce(p_name, ''), ',', ' ', 'g'),
      '^\s*(dr|mr|mrs|ms|miss|prof|professor|rev|sir|dame|lord|lady)\.?\s+', '', 'i')),
    ' ', 1));
$$;

create or replace function public.raise_person_dedup_tasks()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  n int := 0;
  rec record;
begin
  for rec in
    with base as (
      select distinct ep.entity_id, p.id as person_id, p.name, p.dob_year, p.dob_month,
        lower(regexp_replace(regexp_replace(p.name, ',', ' ', 'g'), '^.* ', '')) as last_token,
        public._person_first_token(p.name) as first_token
      from entity_people ep
      join people p on p.id = ep.person_id
      join entities e on e.id = ep.entity_id
      where coalesce(p.name, '') <> ''
        and e.entity_status not in ('nlac', 'archived')   -- no work for former clients
    )
    select a.entity_id, a.person_id as pa, b.person_id as pb,
           a.name as name_a, b.name as name_b, e.name as entity_name
    from base a
    join base b on b.entity_id = a.entity_id
              and b.last_token = a.last_token
              and b.person_id > a.person_id
    join entities e on e.id = a.entity_id
    where a.dob_year is not null and a.dob_year = b.dob_year
      and a.dob_month is not null and a.dob_month = b.dob_month
      -- Same forename → plausibly one person (title / middle-name / spelling
      -- variant). Different forename (Gemma vs Iraj) → two people, skip.
      and a.first_token is not null and a.first_token <> ''
      and a.first_token = b.first_token
  loop
    if not exists (
      select 1 from admin_tasks
      where source = 'person_dedup'
        and value = rec.pa::text || '|' || rec.pb::text
    ) then
      insert into admin_tasks (kind, source, entity_id, title, detail, value)
      values (
        'manual', 'person_dedup', rec.entity_id,
        'Possible duplicate person: ' || rec.name_a || ' / ' || rec.name_b || ' (' || rec.entity_name || ')',
        'Two people records at the same client share a forename, surname and date of birth — likely the same person under two spellings, or with/without a middle name or title. Review and merge (or dismiss if they really are two people; a dismissed pair is never raised again).',
        rec.pa::text || '|' || rec.pb::text
      );
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;

grant execute on function public.raise_person_dedup_tasks() to authenticated;

-- ── Clean up existing open person_dedup tasks that the tighter rules reject ──
-- (a) former-client entities, (b) the two people have different forenames.
update admin_tasks t
   set dismissed_at = now()
 where t.source = 'person_dedup'
   and t.confirmed_at is null and t.dismissed_at is null
   and (
     exists (select 1 from entities e where e.id = t.entity_id and e.entity_status in ('nlac', 'archived'))
     or exists (
       select 1 from people pa, people pb
       where pa.id = split_part(t.value, '|', 1)::uuid
         and pb.id = split_part(t.value, '|', 2)::uuid
         and public._person_first_token(pa.name) <> public._person_first_token(pb.name)
     )
   );
