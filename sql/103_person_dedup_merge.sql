-- ============================================================
-- Person de-duplication (15/07/2026).
--
-- Root issue (see project-ch-code-data-quality): the same human exists as
-- multiple people rows — a Companies-House officer/PSC record (full legal name,
-- holds the CH-code chase) plus a BrightManager primary-contact record
-- (informal name, holds the code + contact info), sometimes a duplicate officer
-- row too. They were never linked, so codes and chases live on different rows.
--
-- This provides:
--   merge_person(target, source)  — repoints EVERY FK to people, collapses the
--     chase to one open request (furthest stage) to respect the one-open-per-
--     person index, carries the code / CH ids / contact fields, audits, deletes.
--   dedupe_ch_clusters(dry)       — finds same-first+last, same-entity clusters
--     (excludes "Surname, First" comma names and any cluster with >1 distinct
--     real code), picks the fullest-legal-name / chase-holding survivor and
--     merges the rest in. Dry mode returns a preview; execute mode performs it.
--
-- One-off maintenance: NOT granted to authenticated; run via admin/MCP only.
-- ============================================================

create or replace function public.merge_person(p_target uuid, p_source uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  src people%rowtype;
  tgt people%rowtype;
  best_open uuid;
begin
  if p_target = p_source or p_target is null or p_source is null then return; end if;
  select * into src from people where id = p_source; if not found then return; end if;
  select * into tgt from people where id = p_target; if not found then return; end if;

  -- ── ch_code_requests ──────────────────────────────────────────────────
  -- Terminal source requests (submitted / rejected) simply repoint — the
  -- partial unique index only covers non-terminal statuses so duplicates are ok.
  update ch_code_requests set person_id = p_target
   where person_id = p_source and status in ('entered_on_bm','stalled');

  -- Open requests across BOTH rows must collapse to one. Keep the furthest stage.
  select id into best_open from (
    select id,
      case stage
        when 's5_entered'  then 6 when 's4_code'    then 5 when 's3b_us'     then 4
        when 's3a_client'  then 3 when 's2_decision' then 2 when 's1_offer'  then 1
        else 0 end as rk
    from ch_code_requests
    where person_id in (p_source, p_target)
      and status not in ('entered_on_bm','stalled')
  ) q order by rk desc, id limit 1;

  if best_open is not null then
    -- Delete the losing open requests FIRST, otherwise moving best_open onto the
    -- target collides with the target's own (not-yet-deleted) open request under
    -- the one-open-per-person partial unique index.
    delete from ch_code_requests
     where person_id in (p_source, p_target) and id <> best_open
       and status not in ('entered_on_bm','stalled');
    update ch_code_requests set person_id = p_target where id = best_open;
  end if;

  -- ── admin_tasks ───────────────────────────────────────────────────────
  update admin_tasks set person_id = p_target where person_id = p_source;

  -- ── entity_people (drop conflicting (entity, role), then move) ─────────
  delete from entity_people sp
   where sp.person_id = p_source
     and exists (select 1 from entity_people tp
                  where tp.person_id = p_target and tp.entity_id = sp.entity_id and tp.role = sp.role);
  update entity_people set person_id = p_target where person_id = p_source;

  -- ── entities.linked_person_id ─────────────────────────────────────────
  update entities set linked_person_id = p_target where linked_person_id = p_source;

  -- Delete source first to free ch_officer_id / ch_psc_id unique constraints.
  delete from people where id = p_source;

  -- Backfill missing fields onto target from the source snapshot (carry the
  -- code + CH ids + contact). Name is set by the cluster driver to the fullest
  -- legal name, so it is not overwritten here.
  update people set
    ch_personal_code = coalesce(nullif(ch_personal_code,''), src.ch_personal_code),
    ch_officer_id    = coalesce(ch_officer_id,    src.ch_officer_id),
    ch_psc_id        = coalesce(ch_psc_id,        src.ch_psc_id),
    dob_year         = coalesce(dob_year,         src.dob_year),
    dob_month        = coalesce(dob_month,        src.dob_month),
    ni_number        = coalesce(ni_number,        src.ni_number),
    email            = coalesce(nullif(email,''), src.email),
    preferred_name   = coalesce(preferred_name,   src.preferred_name),
    updated_at       = now()
  where id = p_target;

  insert into audit_log(action, entity_type, entity_id, detail)
  values ('person_merge','person', p_target,
          jsonb_build_object('source_id', p_source, 'source_name', src.name,
                             'source_source', src.source, 'source_code', src.ch_personal_code,
                             'target_name', tgt.name));
end $$;


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
  -- are normalised to spaces so those records still cluster by first/last token.
  for cl in
    with base as (
      select distinct ep.entity_id, p.id as person_id,
             lower(split_part(regexp_replace(p.name,',',' ','g'),' ',1)) as f,
             lower(regexp_replace(regexp_replace(p.name,',',' ','g'),'^.* ','')) as l
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
           and lower(split_part(regexp_replace(p.name,',',' ','g'),' ',1))=cl.f
           and lower(regexp_replace(regexp_replace(p.name,',',' ','g'),'^.* ',''))=cl.l
           and coalesce(p.ch_personal_code,'')<>'' and p.ch_personal_code not like '%*%') > 1 then
      n_skipped_code := n_skipped_code + 1;
      continue;
    end if;

    -- pick survivor: chase-holder first, then CH record, then longest name
    select p.id into target_id
      from entity_people ep join people p on p.id=ep.person_id
     where ep.entity_id=cl.entity_id
       and lower(split_part(regexp_replace(p.name,',',' ','g'),' ',1))=cl.f
       and lower(regexp_replace(regexp_replace(p.name,',',' ','g'),'^.* ',''))=cl.l
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
       and lower(split_part(regexp_replace(p.name,',',' ','g'),' ',1))=cl.f
       and lower(regexp_replace(regexp_replace(p.name,',',' ','g'),'^.* ',''))=cl.l
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
                         and lower(split_part(regexp_replace(p.name,',',' ','g'),' ',1))=cl.f
                         and lower(regexp_replace(regexp_replace(p.name,',',' ','g'),'^.* ',''))=cl.l
                         and p.id<>target_id));
      end if;
      continue;
    end if;

    -- execute: merge every other cluster member into the survivor
    perform merge_person(target_id, p.id)
      from (select distinct p.id
              from entity_people ep join people p on p.id=ep.person_id
             where ep.entity_id=cl.entity_id
               and lower(split_part(regexp_replace(p.name,',',' ','g'),' ',1))=cl.f
               and lower(regexp_replace(regexp_replace(p.name,',',' ','g'),'^.* ',''))=cl.l
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
