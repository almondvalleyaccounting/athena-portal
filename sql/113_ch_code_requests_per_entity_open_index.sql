-- ============================================================
-- CH-code chase: one open request per person PER COMPANY, not per person
-- globally (16/07/2026).
--
-- Bug: ch_code_requests_open_person_idx was a unique index on person_id
-- alone (partial, open statuses only) — enforcing "a person can have at
-- most one open chase, ever." That's wrong: the personal code identifies
-- the INDIVIDUAL, but the chase workflow (Inform Direct entry, BM entry,
-- Confirmation Statement submission) happens PER COMPANY. A director of
-- two companies genuinely needs two concurrent open chases. Surfaced by
-- Lewis Mckechnie / Lewis James Mckechnie — director of both Ljm Gas
-- Glasgow Ltd and Gnorth Properties Ltd — who couldn't be safely merged
-- into one person under the old constraint without merge_person silently
-- collapsing (deleting) one company's open chase.
--
-- Fix: move the uniqueness to (person_id, entity_id) — still forbids a
-- genuine duplicate open chase for the SAME person at the SAME company,
-- but allows one person to have open chases on multiple companies at once.
-- merge_person is updated to match: it now only collapses/deletes open
-- requests when source and target share an open request on the SAME
-- entity (a true duplicate); open requests on different entities are just
-- repointed to the survivor so both companies stay tracked.
-- ============================================================

drop index if exists public.ch_code_requests_open_person_idx;

create unique index ch_code_requests_open_person_entity_idx
  on public.ch_code_requests (person_id, entity_id)
  where (status <> ALL (ARRAY['entered_on_bm'::text, 'stalled'::text]));

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
  rec record;
begin
  if p_target = p_source or p_target is null or p_source is null then return; end if;
  select * into src from people where id = p_source; if not found then return; end if;
  select * into tgt from people where id = p_target; if not found then return; end if;

  -- ── ch_code_requests ──────────────────────────────────────────────────
  -- Terminal source requests (submitted / rejected) simply repoint — the
  -- partial unique index only covers non-terminal statuses so duplicates are ok.
  update ch_code_requests set person_id = p_target
   where person_id = p_source and status in ('entered_on_bm','stalled');

  -- Open requests: pair up source's and target's open requests by entity.
  -- Same entity on both sides = a genuine duplicate chase for one company —
  -- collapse to the furthest stage, drop the other. Different entities =
  -- the person is mid-chase on more than one company at once — repoint,
  -- don't delete, so every company's chase stays live under the survivor.
  for rec in
    select coalesce(s.entity_id, t.entity_id) as ent_id, s.id as source_req, t.id as target_req
    from (select * from ch_code_requests where person_id = p_source and status not in ('entered_on_bm','stalled')) s
    full outer join (select * from ch_code_requests where person_id = p_target and status not in ('entered_on_bm','stalled')) t
      on t.entity_id = s.entity_id
  loop
    if rec.source_req is not null and rec.target_req is not null then
      select id into best_open from (
        select id,
          case stage
            when 's5_entered'  then 6 when 's4_code'    then 5 when 's3b_us'     then 4
            when 's3a_client'  then 3 when 's2_decision' then 2 when 's1_offer'  then 1
            else 0 end as rk
        from ch_code_requests where id in (rec.source_req, rec.target_req)
      ) q order by rk desc, id limit 1;
      delete from ch_code_requests where id in (rec.source_req, rec.target_req) and id <> best_open;
      update ch_code_requests set person_id = p_target where id = best_open;
    elsif rec.source_req is not null then
      update ch_code_requests set person_id = p_target where id = rec.source_req;
    end if;
  end loop;

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
