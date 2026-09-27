-- ============================================================
-- 334 — BM client import: a changed Internal Reference is not a departure
--
-- On 2026-09-27 BrightManager re-referenced two clients (LITT01 → LMG001,
-- GLAM001 → LTVAC001) with the company numbers unchanged. The import read that
-- as two clients leaving and two arriving:
--   * the incoming rows failed — entities_company_number_uniq, the number was
--     still held under the old reference;
--   * the old rows were offered for archiving, ticked by default.
-- Approving would have archived both live clients and imported neither.
--
-- The archive sweep compared references only. These two functions let the
-- preview recognise the same client under a new reference and move Athena's
-- record across before the upsert, so the upsert lands on the existing entity
-- and nothing is archived.
--
--   preview_bm_ref_changes(rows)       read-only: which would-be archive
--                                      candidates are in the upload under
--                                      another reference
--   rekey_bm_clients(run_id, pairs)    moves entities.bm_client_id old → new
--
-- entities is the only table that stores a BM client reference; everything
-- else hangs off entity_id, so re-keying the one column is the whole change.
-- ============================================================

-- Match rules, strongest first:
--   company_number — same company number, and the incoming reference is not
--                    already bound to any entity. Unambiguous (the number is
--                    unique on entities).
--   name           — neither side has a company number, the names are equal
--                    after case/space folding, the types agree, and exactly
--                    one incoming row carries that name. Offered, not assumed.
create or replace function public.preview_bm_ref_changes(p_rows jsonb)
returns table (
  entity_id        uuid,
  name             text,
  old_bm_client_id text,
  new_bm_client_id text,
  new_name         text,
  company_number   text,
  match            text
)
language sql
security definer
set search_path to 'public'
as $function$
  with gate as (
    select (
      coalesce(is_portal_admin(), false)
      or coalesce((select can_import_data from staff_profiles where id = auth.uid()), false)
    ) as ok
  ),
  incoming as (
    select nullif(trim(r->>'bm_client_id'), '')   as bm_client_id,
           nullif(trim(r->>'company_number'), '') as company_number,
           nullif(trim(r->>'name'), '')           as name,
           nullif(r->>'type', '')                 as type,
           lower(regexp_replace(trim(coalesce(r->>'name', '')), '\s+', ' ', 'g')) as name_key
    from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) r
  ),
  -- Incoming references no entity holds yet: the only ones a record can move to.
  unbound as (
    select i.* from incoming i
    where i.bm_client_id is not null
      and not exists (select 1 from entities e where e.bm_client_id = i.bm_client_id)
  ),
  -- Same set preview_bm_archive_candidates returns.
  missing as (
    select e.* from entities e
    where e.source = 'brightmanager'
      and e.entity_status = 'active'
      and e.bm_client_id is not null
      and not exists (select 1 from incoming i where i.bm_client_id = e.bm_client_id)
  ),
  by_number as (
    select m.id, m.name, m.bm_client_id as old_ref, u.bm_client_id as new_ref,
           u.name as new_name, m.company_number, 'company_number'::text as match
    from missing m
    join unbound u on u.company_number = m.company_number
    where m.company_number is not null
  ),
  name_counts as (
    select name_key, count(*) as n from unbound
    where company_number is null and name_key <> ''
    group by name_key
  ),
  by_name as (
    select m.id, m.name, m.bm_client_id as old_ref, u.bm_client_id as new_ref,
           u.name as new_name, null::text as company_number, 'name'::text as match
    from missing m
    join unbound u
      on u.company_number is null
     and u.name_key = lower(regexp_replace(trim(m.name), '\s+', ' ', 'g'))
     and (u.type is null or u.type = m.type::text)
    join name_counts nc on nc.name_key = u.name_key and nc.n = 1
    where m.company_number is null
      and m.id not in (select id from by_number)
  )
  select distinct on (x.id) x.*
  from (select * from by_number union all select * from by_name) x
  where (select ok from gate)
  order by x.id, (x.match = 'company_number') desc;
$function$;

create or replace function public.rekey_bm_clients(run_id uuid, p_pairs jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  pair jsonb;
  done jsonb := '[]'::jsonb;
  refused jsonb := '[]'::jsonb;
  hit uuid;
begin
  if not (
    coalesce(is_portal_admin(), false)
    or coalesce((select can_import_data from staff_profiles where id = auth.uid()), false)
  ) then
    raise exception 'forbidden: can_import_data required' using errcode = '42501';
  end if;

  if not exists (select 1 from import_log where id = run_id and status = 'running') then
    raise exception 'import_log % not in running status', run_id;
  end if;

  for pair in select * from jsonb_array_elements(coalesce(p_pairs, '[]'::jsonb))
  loop
    hit := null;
    -- Only an active BM entity still on the old reference, and only onto a
    -- reference nothing else holds. Anything else is refused, not forced.
    if not exists (select 1 from entities where bm_client_id = pair->>'new_bm_client_id') then
      update entities
         set bm_client_id = pair->>'new_bm_client_id',
             updated_at   = now()
       where id = (pair->>'entity_id')::uuid
         and bm_client_id = pair->>'old_bm_client_id'
         and source = 'brightmanager'
         and entity_status = 'active'
      returning id into hit;
    end if;

    if hit is not null then
      done := done || jsonb_build_object('old', pair->>'old_bm_client_id', 'new', pair->>'new_bm_client_id');
    else
      refused := refused || jsonb_build_object('old', pair->>'old_bm_client_id', 'new', pair->>'new_bm_client_id');
    end if;
  end loop;

  return jsonb_build_object(
    'rekeyed', jsonb_array_length(done),
    'rekeyed_pairs', done,
    'refused', refused
  );
end;
$function$;

-- New functions pick up the schema default grant to anon; revoke it by name
-- as well as from PUBLIC.
revoke all on function public.preview_bm_ref_changes(jsonb) from public, anon;
revoke all on function public.rekey_bm_clients(uuid, jsonb) from public, anon;
grant execute on function public.preview_bm_ref_changes(jsonb) to authenticated, service_role;
grant execute on function public.rekey_bm_clients(uuid, jsonb) to authenticated, service_role;
