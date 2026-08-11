-- 220 — Per-client refresh: make the queue callable, and close a hole.
--
-- Athena cannot scrape HMRC. A scrape needs a live Government Gateway session,
-- which needs a person and an access code from a second device. So the button
-- ENQUEUES and the scraper's `npm run refresh` drains the queue next time a
-- session is live (~/HMRC-Scraper/src/refresh/drain.js, which already exists and
-- names public.hmrc_request_refresh as its producer). The wait is shown in Athena
-- rather than hidden behind a spinner that never resolves.
--
-- THE HOLE. The 4-argument hmrc_request_refresh from sql/197 was SECURITY DEFINER
-- with NO permission check and EXECUTE granted to `anon`. The anon key ships in
-- the frontend bundle, so anyone could enqueue HMRC scrape requests for any
-- entity_id, with any reason text, and could name any user as the requester —
-- unauthenticated writes into the scraper's private schema, and real scrapes
-- pointed at clients of their choosing. Same class of mistake as the
-- v_hmrc_paye_balance grant in sql/202. Dropped and replaced.
--
-- Four changes in the replacement:
--
-- 1. is_active_staff() first, and requested_by comes from auth.uid() rather than
--    an argument, so it cannot be spoofed.
--
-- 2. References are derived HERE, from HMRC's own records, rather than accepted
--    from the caller. HMRC's record is what we must quote back to HMRC, and it
--    does not always agree with ours: 3 of 141 PAYE references on `entities`
--    differ from hmrc.client, and 1 is missing. entities is the fallback only.
--    Corporation Tax reads v_hmrc_ct_link so it inherits the sql/219 prefix fix.
--
-- 3. ONE ROW PER SERVICE, not one row listing several. The worker reads a single
--    `utr` column and uses it for BOTH corporation-tax and self-assessment. No
--    entity is currently both a CT and an SA client, so nothing is broken today,
--    but a sole trader who incorporates would be — and then one of the two would
--    be scraped under the other's UTR. A row per service makes each carry its own
--    reference, and gives per-tax status in the UI for free.
--
-- 4. It reports what it did NOT queue. A service with no reference held is a fact
--    about the client, not a failure — but a button that silently does nothing is
--    worse than one that says "no VAT number on file".
--
-- KNOWN LIMIT, reported not hidden: the queue is unique on (entity_id, services),
-- so it cannot express two PAYE schemes for one client. One client has two
-- (120/LF09269 and 120/UE41300). The scheme carrying the larger debt is queued and
-- the other is returned as 'second-scheme' for the UI to show. Expressing both
-- needs a reference column in the queue key, which is the scraper's to decide.

drop function if exists public.hmrc_request_refresh(uuid, text[], text, uuid);

create or replace function public.hmrc_request_refresh(
  p_entity_id uuid,
  p_services  text[] default array['paye', 'corporation-tax', 'vat', 'self-assessment'],
  p_reason    text    default null
) returns table (request_id bigint, service text, reference text, state text)
language plpgsql
security definer
set search_path to 'public', 'hmrc'
as $$
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
  -- An unknown name would sit in the queue until the worker rejected it.
  if exists (select 1 from unnest(p_services) s where not (s = any (v_valid))) then
    raise exception 'Unknown service in %', p_services using errcode = '22023';
  end if;

  -- HMRC's own reference wins; ours is the fallback. For the one client with two
  -- PAYE schemes, the larger debt is the one worth refreshing.
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
  -- back to it blindly is unsafe: the first smoke test asked for all four taxes on
  -- a limited company and the Self Assessment row was handed the company's CT UTR
  -- (8265528810) — an SA scrape aimed at a reference that is not an SA taxpayer,
  -- or worse, at somebody else's. The fallback is only allowed when the entity
  -- type says which kind of UTR it must be. Otherwise no reference, which the UI
  -- reports plainly. A wrong reference quoted to HMRC beats no refresh in nobody's
  -- book.
  select coalesce(
    (select lk.utr from public.v_hmrc_ct_link lk where lk.entity_id = p_entity_id limit 1),
    (select e.utr from public.entities e
      where e.id = p_entity_id and e.type::text = 'limited_company'))
  into v_ct;

  select coalesce(
    (select v.vrn from hmrc.vat_client v where v.entity_id = p_entity_id limit 1),
    (select e.vat_number from public.entities e where e.id = p_entity_id))
  into v_vat;

  select coalesce(
    (select s.utr from hmrc.sa_client s where s.entity_id = p_entity_id limit 1),
    (select e.utr from public.entities e
      where e.id = p_entity_id and e.type::text in ('sole_trader', 'partnership')))
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
    -- xmax = 0 only for a genuine insert, so a repeat click reads as "already
    -- queued" instead of pretending it created new work.
    returning id, services[1] as service,
              coalesce(paye_ref, utr, vrn) as reference,
              case when xmax = 0 then 'queued' else 'already-queued' end as state
  )
  select i.id, i.service, i.reference, i.state from ins i
  union all
  select null::bigint, w.service, null::text, 'no-reference'
    from wanted w where w.reference is null
  union all
  -- Cannot be queued (see the note above), so say so rather than lose it.
  select null::bigint, 'paye', c.paye_ref, 'second-scheme'
    from hmrc.client c
   where c.entity_id = p_entity_id
     and exists (select 1 from asked a where a.service = 'paye')
     and v_paye is not null
     and c.paye_ref <> v_paye;
end $$;

comment on function public.hmrc_request_refresh(uuid, text[], text) is
  'Enqueue a per-client HMRC re-scrape for the scraper to drain when a Government Gateway session is live. '
  'Staff only; requester taken from the session. Inserts one row per tax so each carries its own reference — '
  'the worker reads a single utr column for both CT and SA. Returns a row per tax asked for, stating whether '
  'it was queued, was already queued, has no reference held, or is a second PAYE scheme the queue cannot express.';

-- Cancel is a status change, not a delete: it keeps the history and frees the
-- partial unique index so the tax can be asked for again.
create or replace function public.hmrc_cancel_refresh(p_id bigint)
returns boolean
language plpgsql
security definer
set search_path to 'public', 'hmrc'
as $$
declare v_n int;
begin
  if not public.is_active_staff() then
    raise exception 'Not permitted' using errcode = '42501';
  end if;
  -- Only while pending. A running request is a live browser session at HMRC and
  -- stopping it from here would leave a half-published scrape.
  update hmrc.refresh_request
     set status = 'cancelled', finished_at = now(),
         note = concat_ws('; ', note, 'cancelled in Athena')
   where id = p_id and status = 'pending';
  get diagnostics v_n = row_count;
  return v_n > 0;
end $$;

comment on function public.hmrc_cancel_refresh(bigint) is
  'Cancel a pending refresh request. Returns false if it had already started — a running request is a live '
  'HMRC session and must not be interrupted from here.';

-- What the UI shows: the queue with names attached.
create or replace view public.v_hmrc_refresh_queue as
select
  r.id,
  r.entity_id,
  e.name                          as entity_name,
  r.services[1]                   as service,
  coalesce(r.paye_ref, r.utr, r.vrn) as reference,
  r.status,
  r.reason,
  r.note,
  r.attempts,
  r.requested_at,
  r.started_at,
  r.finished_at,
  r.requested_by,
  sp.name                         as requested_by_name
from hmrc.refresh_request r
left join public.entities e       on e.id = r.entity_id
left join public.staff_profiles sp on sp.id = r.requested_by
where public.hmrc_can_read();

comment on view public.v_hmrc_refresh_queue is
  'Per-client HMRC refresh requests with client and requester names. Drained by the scraper''s npm run refresh '
  'when a Government Gateway session is live, so pending can sit for a while by design.';

revoke all on function public.hmrc_request_refresh(uuid, text[], text) from public, anon;
revoke all on function public.hmrc_cancel_refresh(bigint)             from public, anon;
grant execute on function public.hmrc_request_refresh(uuid, text[], text) to authenticated, service_role;
grant execute on function public.hmrc_cancel_refresh(bigint)              to authenticated, service_role;

revoke all on public.v_hmrc_refresh_queue from public, anon;
grant select on public.v_hmrc_refresh_queue to authenticated, service_role;
