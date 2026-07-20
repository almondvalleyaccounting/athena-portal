-- 128: Auto-raise admin tasks for suspected duplicate people.
--
-- The CH ingest now auto-merges confident duplicates (same surname + DOB +
-- first initial). Pairs it CAN'T safely merge (different first names, e.g.
-- one record with a middle name, one with a title, or a genuine misspelling)
-- are a clear data error and belong on the admin task list. This function
-- scans for them (same client, same surname token, same DOB month+year) and
-- inserts one admin task per pair — once ever per pair, so a dismissed task
-- (staff judged "actually two different people") never comes back.
--
-- Called daily by the ch-refresh-report edge function; safe to run manually.

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
        lower(regexp_replace(regexp_replace(p.name, ',', ' ', 'g'), '^.* ', '')) as last_token
      from entity_people ep
      join people p on p.id = ep.person_id
      where coalesce(p.name, '') <> ''
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
        'Two people records at the same client share a surname and date of birth — likely the same person under two spellings, or with/without a middle name or title. Review and merge (or dismiss if they really are two people; a dismissed pair is never raised again).',
        rec.pa::text || '|' || rec.pb::text
      );
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;
