-- ============================================================
-- 336 — BM client import: don't offer a prospect for a client we already have
--
-- match_bm_prospects offered BM's Riverbank Commercial Ltd (CLUB01) as a
-- conversion of the prospect "Agn Commercial Ltd" on a 52% name similarity.
-- CLUB01 is already an active client. A name-only (tier 3) match blocks
-- Approve until someone clicks, so this was a forced click on every import
-- for a match that can never be right — and confirming it would have tried
-- to move CLUB01 onto the prospect row.
--
-- The name-only step now skips an incoming row whose BM reference, or
-- company number, already belongs to an entity that is not a prospect. Tiers
-- 1 and 2 are unchanged: company_number and bm_client_id are unique on
-- entities, so a row that matches a prospect on either cannot also belong to
-- an existing client.
-- ============================================================

create or replace function public.match_bm_prospects(rows jsonb)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  result jsonb := '[]'::jsonb;
  r jsonb;
  matched record;
  tier int;
  prospect_id uuid;
  prospect_name text;
  score numeric;
begin
  if not (
    coalesce(is_portal_admin(), false)
    or coalesce((select can_import_data from staff_profiles where id = auth.uid()), false)
  ) then
    raise exception 'forbidden: can_import_data required';
  end if;

  for r in select * from jsonb_array_elements(rows)
  loop
    tier := null; prospect_id := null; prospect_name := null; score := null;

    if nullif(r->>'company_number', '') is not null then
      select id, name into prospect_id, prospect_name
      from entities
      where entity_status = 'prospect'
        and company_number = r->>'company_number'
      limit 1;
      if prospect_id is not null then tier := 1; end if;
    end if;

    if tier is null and nullif(r->>'bm_client_id', '') is not null then
      select id, name into prospect_id, prospect_name
      from entities
      where entity_status = 'prospect'
        and bm_client_id = r->>'bm_client_id'
      limit 1;
      if prospect_id is not null then tier := 2; end if;
    end if;

    -- Tier 3: fuzzy match. Threshold 0.5 (pg_trgm scale — calibrated
    -- against real prospect vs BM name pairs 2026-04-19: "Cloudbreak
    -- Capital Ltd" vs "Cloudbreak Capital Limited" = 0.66, same-stem
    -- near-matches cluster 0.55-0.75). Only for a row that is not already
    -- one of our clients, by reference or by company number.
    if tier is null and nullif(r->>'name', '') is not null
       and not exists (
         select 1 from entities e
         where e.entity_status <> 'prospect'
           and (
             (nullif(r->>'bm_client_id', '') is not null and e.bm_client_id = r->>'bm_client_id')
             or (nullif(r->>'company_number', '') is not null and e.company_number = r->>'company_number')
           )
       ) then
      select id, name, similarity(lower(name), lower(r->>'name')) as s
        into matched
      from entities
      where entity_status = 'prospect'
        and similarity(lower(name), lower(r->>'name')) >= 0.5
      order by s desc
      limit 1;
      if matched.id is not null then
        tier := 3;
        prospect_id := matched.id;
        prospect_name := matched.name;
        score := matched.s;
      end if;
    end if;

    result := result || jsonb_build_object(
      'bm_client_id', r->>'bm_client_id',
      'tier', tier,
      'prospect_id', prospect_id,
      'prospect_name', prospect_name,
      'score', score
    );
  end loop;

  return result;
end;
$function$;

-- Keep the grants as they were: staff-gated inside, no PUBLIC or anon.
revoke all on function public.match_bm_prospects(jsonb) from public, anon;
grant execute on function public.match_bm_prospects(jsonb) to authenticated, service_role;
