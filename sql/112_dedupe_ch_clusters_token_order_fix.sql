-- ============================================================
-- Fix dedupe_ch_clusters' name-token matching (16/07/2026).
--
-- Bug: the cluster key compared the FIRST word to the FIRST word and the
-- LAST word to the LAST word, positionally. "Burt, Chris" (comma normalised
-- to a space -> tokens "Burt","Chris") produced (f=burt, l=chris), while
-- "Chris Burt" produced (f=chris, l=burt) — the same two name tokens, in
-- opposite order, so the two records never landed in the same group-by
-- bucket and same-entity duplicates written in different name conventions
-- (sole_trader_auto's "Surname, First" vs BrightManager's "First Surname")
-- were invisible to this pass. Surfaced investigating Chris Burt, who had
-- an unmerged duplicate on his own sole-trader entity for exactly this
-- reason (see project-ch-code-data-quality memory).
--
-- Fix: store the two boundary tokens canonically (alphabetically sorted via
-- least/greatest) everywhere the cluster key is built or re-matched, so
-- order no longer matters. Middle names/titles are still ignored either way
-- (only the first and last word of the normalised name are ever compared),
-- preserving the original "Iraj Ali" / "Iraj Leo Kiryakos Keverian Ali"
-- middle-name tolerance. The >1-distinct-real-code skip guard is untouched,
-- so genuinely different same-named people (e.g. father/son) are still
-- protected from a wrongful merge.
-- ============================================================

create or replace function public.dedupe_ch_clusters(p_dry boolean default true)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  cl record;
  target_id uuid;
  full_name text; full_first text; full_last text;
  n_clusters int := 0; n_merged int := 0; n_skipped_code int := 0;
  sample jsonb := '[]'::jsonb;
begin
  -- Token helper: commas (embedded titles like "…, Dr Ali", "…, Sir Cuddihy")
  -- are normalised to spaces; first/last word are then taken and stored as
  -- an order-independent pair (least/greatest) so "Burt, Chris" and
  -- "Chris Burt" — same two boundary words, opposite order — cluster together.
  for cl in
    with base as (
      select distinct ep.entity_id, p.id as person_id,
             least(
               lower(split_part(regexp_replace(p.name,',',' ','g'),' ',1)),
               lower(regexp_replace(regexp_replace(p.name,',',' ','g'),'^.* ',''))
             ) as f,
             greatest(
               lower(split_part(regexp_replace(p.name,',',' ','g'),' ',1)),
               lower(regexp_replace(regexp_replace(p.name,',',' ','g'),'^.* ',''))
             ) as l
      from entity_people ep join people p on p.id = ep.person_id
      where coalesce(p.name,'') <> ''
    )
    select entity_id, f, l
    from base
    group by entity_id, f, l
    having count(distinct person_id) > 1
  loop
    n_clusters := n_clusters + 1;

    -- skip clusters with >1 distinct real (non-masked) code
    if (select count(distinct p.ch_personal_code)
          from entity_people ep join people p on p.id=ep.person_id
         where ep.entity_id=cl.entity_id
           and least(lower(split_part(regexp_replace(p.name,',',' ','g'),' ',1)), lower(regexp_replace(regexp_replace(p.name,',',' ','g'),'^.* ','')))=cl.f
           and greatest(lower(split_part(regexp_replace(p.name,',',' ','g'),' ',1)), lower(regexp_replace(regexp_replace(p.name,',',' ','g'),'^.* ','')))=cl.l
           and coalesce(p.ch_personal_code,'')<>'' and p.ch_personal_code not like '%*%') > 1 then
      n_skipped_code := n_skipped_code + 1;
      continue;
    end if;

    -- pick survivor: chase-holder first, then CH record, then longest name
    select p.id into target_id
      from entity_people ep join people p on p.id=ep.person_id
     where ep.entity_id=cl.entity_id
       and least(lower(split_part(regexp_replace(p.name,',',' ','g'),' ',1)), lower(regexp_replace(regexp_replace(p.name,',',' ','g'),'^.* ','')))=cl.f
       and greatest(lower(split_part(regexp_replace(p.name,',',' ','g'),' ',1)), lower(regexp_replace(regexp_replace(p.name,',',' ','g'),'^.* ','')))=cl.l
     order by
       (exists(select 1 from ch_code_requests r where r.person_id=p.id
                and r.status not in ('entered_on_bm','stalled'))) desc,
       (p.ch_officer_id is not null or p.ch_psc_id is not null) desc,
       length(p.name) desc,
       p.id
     limit 1;

    -- fullest legal name in the cluster (for the surviving display name)
    select p.name, p.first_name, p.last_name into full_name, full_first, full_last
      from entity_people ep join people p on p.id=ep.person_id
     where ep.entity_id=cl.entity_id
       and least(lower(split_part(regexp_replace(p.name,',',' ','g'),' ',1)), lower(regexp_replace(regexp_replace(p.name,',',' ','g'),'^.* ','')))=cl.f
       and greatest(lower(split_part(regexp_replace(p.name,',',' ','g'),' ',1)), lower(regexp_replace(regexp_replace(p.name,',',' ','g'),'^.* ','')))=cl.l
     order by length(p.name) desc, p.id
     limit 1;

    if p_dry then
      if jsonb_array_length(sample) < 25 then
        sample := sample || jsonb_build_object(
          'entity', (select name from entities where id=cl.entity_id),
          'survivor', (select name from people where id=target_id),
          'survivor_name_after', full_name,
          'merging', (select jsonb_agg(p.name order by p.name)
                        from entity_people ep join people p on p.id=ep.person_id
                       where ep.entity_id=cl.entity_id
                         and least(lower(split_part(regexp_replace(p.name,',',' ','g'),' ',1)), lower(regexp_replace(regexp_replace(p.name,',',' ','g'),'^.* ','')))=cl.f
                         and greatest(lower(split_part(regexp_replace(p.name,',',' ','g'),' ',1)), lower(regexp_replace(regexp_replace(p.name,',',' ','g'),'^.* ','')))=cl.l
                         and p.id<>target_id));
      end if;
      continue;
    end if;

    -- execute: merge every other cluster member into the survivor
    perform merge_person(target_id, p.id)
      from (select distinct p.id
              from entity_people ep join people p on p.id=ep.person_id
             where ep.entity_id=cl.entity_id
               and least(lower(split_part(regexp_replace(p.name,',',' ','g'),' ',1)), lower(regexp_replace(regexp_replace(p.name,',',' ','g'),'^.* ','')))=cl.f
               and greatest(lower(split_part(regexp_replace(p.name,',',' ','g'),' ',1)), lower(regexp_replace(regexp_replace(p.name,',',' ','g'),'^.* ','')))=cl.l
               and p.id<>target_id) p;

    -- set the survivor's display name to the fullest legal name
    update people set name=full_name,
           first_name=coalesce(full_first, first_name),
           last_name=coalesce(full_last, last_name),
           updated_at=now()
     where id=target_id;

    n_merged := n_merged + 1;
  end loop;

  return jsonb_build_object(
    'clusters_seen', n_clusters,
    'clusters_merged', n_merged,
    'clusters_skipped_conflicting_code', n_skipped_code,
    'dry_run', p_dry,
    'sample', sample);
end $$;
