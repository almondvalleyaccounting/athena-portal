-- ============================================================
-- Cross-entity person de-duplication by shared personal code (15/07/2026).
--
-- Second dedup pass. The within-entity pass (sql/103) merged officer + BM-contact
-- rows per company. This pass merges the SAME human across their MULTIPLE
-- companies, keyed on the CH personal code — which is globally unique per person,
-- so an identical non-masked code = the same human (spelling / maiden-vs-married /
-- "Surname, First" / sole-trader-auto rows all collapse). Runs AFTER the code
-- over-application cleanup (a code shared by genuinely different people would be a
-- data error, not a dup) — belt-and-braces, groups where the first name disagrees
-- are SKIPPED and reported rather than merged.
--
-- Reuses merge_person() from sql/103. One-off maintenance; not granted to authenticated.
-- ============================================================

create or replace function public.dedupe_people_by_code(p_dry boolean default true)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  g record; target_id uuid; full_name text; full_first text; full_last text;
  n_groups int := 0; n_merged int := 0; n_skipped int := 0;
  sample jsonb := '[]'::jsonb;
begin
  for g in
    select ch_personal_code as code
    from people
    where coalesce(ch_personal_code,'') <> '' and ch_personal_code not like '%*%'
    group by ch_personal_code having count(*) > 1
  loop
    n_groups := n_groups + 1;

    -- Safety: never merge a code group whose members disagree on first name
    -- (comma / surname-first aware) — that would be residual over-application.
    if (select count(distinct case when name like '%,%'
              then lower(split_part(btrim(split_part(name,',',2)),' ',1))
              else lower(split_part(name,' ',1)) end)
          from people where ch_personal_code = g.code) > 1 then
      n_skipped := n_skipped + 1;
      if p_dry and jsonb_array_length(sample) < 40 then
        sample := sample || jsonb_build_object('code', g.code, 'SKIP_first_name_conflict',
          (select jsonb_agg(name order by name) from people where ch_personal_code = g.code));
      end if;
      continue;
    end if;

    -- Survivor: chase-holder → CH record → normal-order name → fullest.
    select p.id into target_id from people p where p.ch_personal_code = g.code
     order by (exists(select 1 from ch_code_requests r where r.person_id=p.id and r.status not in ('entered_on_bm','stalled'))) desc,
              (p.ch_officer_id is not null or p.ch_psc_id is not null) desc,
              (p.name not like '%,%') desc,
              length(p.name) desc, p.id
     limit 1;

    -- Fullest normal-order (non-comma) legal name for the surviving display name.
    select name, first_name, last_name into full_name, full_first, full_last
      from people where ch_personal_code = g.code and name not like '%,%'
     order by length(name) desc, id limit 1;
    if full_name is null then
      select name, first_name, last_name into full_name, full_first, full_last
        from people where ch_personal_code = g.code order by length(name) desc, id limit 1;
    end if;

    if p_dry then
      if jsonb_array_length(sample) < 40 then
        sample := sample || jsonb_build_object('code', g.code, 'survivor_name_after', full_name,
          'merging', (select jsonb_agg(name order by name) from people where ch_personal_code=g.code and id<>target_id));
      end if;
      continue;
    end if;

    perform merge_person(target_id, p.id)
      from (select id from people where ch_personal_code = g.code and id <> target_id) p;

    update people set name=full_name, first_name=coalesce(full_first, first_name),
           last_name=coalesce(full_last, last_name), updated_at=now()
     where id=target_id;

    n_merged := n_merged + 1;
  end loop;

  return jsonb_build_object('groups', n_groups, 'merged', n_merged,
    'skipped_first_name_conflict', n_skipped, 'dry_run', p_dry, 'sample', sample);
end $$;
