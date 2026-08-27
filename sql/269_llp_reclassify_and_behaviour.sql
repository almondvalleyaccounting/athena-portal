-- ============================================================
-- Put the LLP type to work (sql/268 added the label).
--
-- Adding an enum value quietly changes behaviour everywhere a branch says
-- `type in ('sole_trader','partnership')`, because the LLP falls out of it. So
-- every live object that branches on entity type was enumerated from the
-- database — not from the migration files, which include superseded versions:
--
--   v_client_year_end        sole_trader/partnership → 31 March fallback
--   v_client_group_links     sole_trader vs everything else
--   v_fee_engine_gaps        = limited_company (tiering)
--   v_onboarding_crosscheck  = limited_company (×4 views)
--   hmrc_request_refresh     = limited_company (CT) and in (...) (SA)
--   create_prospect_for_bm_ref  default argument only
--
-- Every `= limited_company` branch already excluded the LLP when it was typed
-- `partnership`, and still does. Two need a decision:
--
--   * v_client_year_end — DELIBERATELY not extended. That branch defaults a
--     sole trader or partnership to a 31 March year end. An LLP has an
--     accounting reference date at Companies House like any registered body,
--     so the tax-year default would be wrong for it. Falling out is the fix,
--     not a regression. (It only bites when BrightManager has no Year End
--     task, which is the case this fallback exists for.)
--
--   * hmrc_request_refresh — MUST be extended. The Self Assessment reference
--     falls back to entities.utr only for types whose UTR is a self-assessment
--     one. An LLP files an SA800 under a partnership UTR, so without `llp` in
--     that list Ready Rentals silently loses its SA scrape reference. It keeps
--     its exclusion from the corporation-tax branch, which is correct: an LLP
--     pays no CT.
-- ============================================================

-- ── 1. Ready Rentals is an LLP ──────────────────────────────────────────────
-- The only partnership in the book holding a company number, and the only row
-- BrightManager sends as "Limited Liability Partnership". The parser change
-- (parsers/bmClients.js) is what stops the next import undoing this.
update public.entities
   set type = 'llp'
 where type = 'partnership'
   and company_number is not null
   and btrim(company_number) <> '';

-- ── 2. Self Assessment reference: an LLP files an SA800 ─────────────────────
-- Unchanged from the deployed definition except for 'llp' in the SA list.
create or replace function public.hmrc_request_refresh(
  p_entity_id uuid,
  p_services text[] default array['paye', 'corporation-tax', 'vat', 'self-assessment'],
  p_reason text default null
)
returns table(request_id bigint, service text, reference text, state text)
language plpgsql
security definer
set search_path to 'public', 'hmrc'
as $function$
declare
  v_uid   uuid := auth.uid();
  v_paye  text;
  v_ct    text;
  v_vat   text;
  v_sa    text;
  v_valid text[] := array['paye', 'corporation-tax', 'vat', 'self-assessment'];
begin
  if not public.is_active_staff() then
    raise exception 'Not permitted' using errcode = '42501';
  end if;
  if p_entity_id is null then
    raise exception 'A client is required' using errcode = '22004';
  end if;
  if p_services is null or cardinality(p_services) = 0 then
    raise exception 'At least one tax is required' using errcode = '22004';
  end if;
  if exists (select 1 from unnest(p_services) s where not (s = any (v_valid))) then
    raise exception 'Unknown service in %', p_services using errcode = '22023';
  end if;

  select coalesce(
    (select c.paye_ref
       from hmrc.client c
       left join public.v_hmrc_paye_clients pc on pc.paye_ref = c.paye_ref
      where c.entity_id = p_entity_id
      order by pc.total_debt desc nulls last, c.paye_ref
      limit 1),
    (select e.paye_ref from public.entities e where e.id = p_entity_id))
  into v_paye;

  -- entities.utr is ONE column holding whichever UTR the client has, so falling
  -- back to it blindly is unsafe: a limited company would hand its CT UTR to a
  -- Self Assessment scrape. Only allowed where the entity type says which kind of
  -- UTR it must be. An LLP pays no corporation tax, so it stays out of this one.
  select coalesce(
    (select lk.utr from public.v_hmrc_ct_link lk where lk.entity_id = p_entity_id limit 1),
    (select e.utr from public.entities e
      where e.id = p_entity_id and e.type::text = 'limited_company'))
  into v_ct;

  select coalesce(
    (select v.vrn from hmrc.vat_client v where v.entity_id = p_entity_id limit 1),
    (select e.vat_number from public.entities e where e.id = p_entity_id))
  into v_vat;

  -- 'llp' belongs here: an LLP is transparent for tax and files an SA800
  -- partnership return, so entities.utr on an LLP is a self-assessment UTR.
  select coalesce(
    (select s.utr from hmrc.sa_client s where s.entity_id = p_entity_id limit 1),
    (select e.utr from public.entities e
      where e.id = p_entity_id and e.type::text in ('sole_trader', 'partnership', 'llp')))
  into v_sa;

  return query
  with asked as (
    select distinct s as service from unnest(p_services) s
  ),
  wanted as (
    select a.service, nullif(btrim(r.reference), '') as reference
    from asked a
    join (values ('paye', v_paye), ('corporation-tax', v_ct),
                 ('vat', v_vat),  ('self-assessment', v_sa)) as r(service, reference)
      on r.service = a.service
  ),
  ins as (
    insert into hmrc.refresh_request
      (entity_id, services, reason, requested_by, paye_ref, utr, vrn)
    select p_entity_id, array[w.service], p_reason, v_uid,
           case when w.service = 'paye' then w.reference end,
           case when w.service in ('corporation-tax', 'self-assessment') then w.reference end,
           case when w.service = 'vat' then w.reference end
      from wanted w
     where w.reference is not null
    on conflict (entity_id, services) where status in ('pending', 'running')
      do update set reason = coalesce(excluded.reason, hmrc.refresh_request.reason)
    returning id, services[1] as service,
              coalesce(paye_ref, utr, vrn) as reference,
              case when xmax = 0 then 'queued' else 'already-queued' end as state
  )
  select i.id, i.service, i.reference, i.state from ins i
  union all
  select null::bigint, w.service, null::text, 'no-reference'
    from wanted w where w.reference is null
  union all
  select null::bigint, 'paye', c.paye_ref, 'second-scheme'
    from hmrc.client c
   where c.entity_id = p_entity_id
     and exists (select 1 from asked a where a.service = 'paye')
     and v_paye is not null
     and c.paye_ref <> v_paye;
end $function$;

-- Match the grants the deployed function already carried.
revoke execute on function public.hmrc_request_refresh(uuid, text[], text) from public, anon;
grant execute on function public.hmrc_request_refresh(uuid, text[], text) to authenticated, service_role;
