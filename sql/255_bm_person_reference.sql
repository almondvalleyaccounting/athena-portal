-- ============================================================
-- BrightManager person references — 21/08/2026
--
-- BM's client export carries TWO reference fields, and until now Athena used
-- only one of them:
--
--   "Internal Reference"          -> entities.bm_client_id   (already used)
--   "Person Internal Reference"   -> people.bm_person_ref    (this migration)
--
-- Three facts from the 625-row export (All Clients, 15/04/2026) shape every
-- decision below. Each one killed a simpler design.
--
-- 1. THE TWO REFERENCES SHARE A NAMESPACE. 320 of the 344 person references
--    are byte-identical to some client's Internal Reference, because BM codes
--    an SA client after the person (323 rows have Internal Reference =
--    Person Internal Reference). Today no colliding string is ambiguous, but
--    nothing in BM enforces that. So the two live in separate columns and are
--    NEVER compared, joined or coalesced. There is no "match on reference"
--    fallback anywhere in this file.
--
-- 2. THE PERSON REFERENCE IS NOT UNIQUE PER PERSON. Four references carry two
--    different people each. All four differ on name and date of birth; three
--    also differ on National Insurance number:
--
--      BETTD01  Denise Bett      1981-01-05 JM242044A  CKQ-89WF-2223
--               Stephen Bett     1965-08-04 NE963031A  XCJ-VMH7-2223
--      BLACR01  Ronald Blacklaws 1954-06-26 YX863090D  X2P-4SN7-2223
--               James Blacklaw   1978-11-10 (no NI)    XJD-8698-2223
--      COLLS02  Sarah Collister  1982-07-29 JT144997B  (no code)
--               Simon Collister  1980-03-29 MA134838B  (no code)
--      SHAWW01  James Shaw       1994-06-18 JZ231572A  (no code)
--               William Shaw     1960-06-15 WK120911D  (no code)
--
--    Spouses and siblings. BM issues a second reference sometimes (BOYDD01 /
--    BOYDD02 are a father and son, both "David Boyd") and not others. So
--    `unique (bm_person_ref)` would collapse four families into four people,
--    each keeping one of two real Companies House identity codes. The
--    reference is a POINTER, not an identity.
--
--    Two of the four — BETTD01 and SHAWW01 — are ALSO duplicate CLIENT
--    Internal References: BM has two clients sharing each ("Bett, Denise" and
--    "Bett, Stephen"; "Shaw, James" and "Shaw, William"), because for an SA
--    client BM codes the client after the person. Those client rows are
--    already skipped upstream by the duplicate-reference guard in sql/066, so
--    in a real run both people still arrive, but via their other clients
--    (Denise through DSR Hair, Stephen through Muir Gordon and Segal).
--    COLLS02 and BLACR01 are person-reference collisions alone.
--
-- 3. DATE OF BIRTH IS THE DISCRIMINATOR. 336 of 344 references carry exactly
--    one DOB, the remaining 8 rows still carry a name, and (reference, DOB)
--    resolves all 344 references into 348 distinct people with nothing left
--    ambiguous. Hence the composite key below. Name+email was the other
--    candidate and it is wrong: it merges the two David Boyds, who share the
--    mailbox jordan@monumentssas.co.uk — which belongs to a third person.
--
-- What this migration changes:
--   * people.bm_person_ref (NOT unique) + people.date_of_birth
--   * unique index on (bm_person_ref, date_of_birth), NULLS NOT DISTINCT
--   * import_bm_people(): one people row per human, N entity links; imports
--     the Secondary person block, which was previously dropped entirely
--   * bm_person_merge_review: proposed merges of the legacy per-entity person
--     rows, written for review. NOTHING is merged by the import itself.
--   * apply_bm_person_merges(): applies reviewed merges via merge_person()
--   * import_bm_clients(): stops minting per-entity person rows when the
--     caller says it will run import_bm_people
--   * reconcile_ch_codes(): prefers an exact person-reference match, so a
--     code arriving for BOYDD01 cannot land on BOYDD02
-- ============================================================

begin;

-- ─────────────────────────────────────────────────────────────────────────
-- 1. Columns
-- ─────────────────────────────────────────────────────────────────────────

alter table public.people add column if not exists bm_person_ref text;
alter table public.people add column if not exists date_of_birth date;

comment on column public.people.bm_person_ref is
  'BrightManager "Person Internal Reference". A POINTER, not an identity: four '
  'references in the 15/04/2026 export carry two different people each '
  '(BETTD01, BLACR01, COLLS02, SHAWW01 — spouses and siblings, differing on '
  'name and date of birth). Never unique on its own; identity is '
  '(bm_person_ref, date_of_birth). Shares a namespace with '
  'entities.bm_client_id — 320 of 344 values are also a client reference — so '
  'the two columns must never be compared, joined or coalesced.';

comment on column public.people.date_of_birth is
  'Full DOB, from BrightManager''s "Date of Birth" column. Distinct from '
  'dob_year/dob_month, which exist because Companies House only publishes a '
  'partial DOB for officers. This is the field that separates the two David '
  'Boyds (1987-09-09 and 1961-11-04) and the four colliding person '
  'references — see the comment on bm_person_ref.';

-- Identity: the reference alone is not unique, the pair is. NULLS NOT
-- DISTINCT so a reference BM gave us with no DOB still resolves to one
-- person rather than silently multiplying. Partial, so the ~130 people rows
-- sourced from Companies House and manual entry are unaffected.
create unique index if not exists people_bm_person_ref_dob_key
  on public.people (bm_person_ref, date_of_birth)
  nulls not distinct
  where bm_person_ref is not null;

-- Populated by the CH-code work and by BM alike; a plain lookup index.
create index if not exists people_bm_person_ref_idx
  on public.people (bm_person_ref)
  where bm_person_ref is not null;

-- ─────────────────────────────────────────────────────────────────────────
-- 2. Name key
--
-- Surname + full first name, tolerating BM's two name shapes ("Hunter,
-- Gordon" and "Gordon Alexander Hunter" are one key) while keeping the
-- family pairs apart. Surname + initial was the first attempt and it fails
-- on Sarah/Simon Collister, who share both.
-- ─────────────────────────────────────────────────────────────────────────

create or replace function public._bm_name_key(p_name text)
returns text
language sql
immutable
set search_path = public
as $$
  with cleaned as (
    select regexp_replace(lower(btrim(coalesce(p_name, ''))), '[^a-z, ]', '', 'g') as s
  ),
  toks as (
    select s,
           position(',' in s) > 0 as comma_form,
           string_to_array(btrim(regexp_replace(replace(s, ',', ' '), '\s+', ' ', 'g')), ' ') as t
    from cleaned
  )
  select case
           when t is null or array_length(t, 1) is null or t[1] = '' then null
           when array_length(t, 1) = 1 then t[1]
           -- "Hunter, Gordon" -> surname first
           when comma_form then t[1] || ' ' || t[2]
           -- "Gordon Alexander Hunter" -> last token is the surname
           else t[array_length(t, 1)] || ' ' || t[1]
         end
  from toks;
$$;

comment on function public._bm_name_key(text) is
  'Surname + first name, normalised, for matching a BrightManager contact to '
  'an existing people row. Deliberately keeps Sarah and Simon Collister '
  'apart — see the comment on people.bm_person_ref.';

revoke all on function public._bm_name_key(text) from public;
grant execute on function public._bm_name_key(text) to authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────
-- 3. Merge review
--
-- The import proposes; a human disposes. Athena currently holds one person
-- row per (entity, BM contact) because the old lookup was "the brightmanager
-- primary contact of THIS entity" — 634 links over 417 rows for what BM says
-- are 348 people. Collapsing those is a merge of live records carrying CH
-- identity codes and open code chases, so it does not happen inside an
-- import run.
-- ─────────────────────────────────────────────────────────────────────────

create table if not exists public.bm_person_merge_review (
  id                     uuid primary key default gen_random_uuid(),
  run_id                 uuid references public.import_log(id) on delete set null,
  bm_person_ref          text not null,
  survivor_id            uuid not null references public.people(id) on delete cascade,
  absorbed_id            uuid not null references public.people(id) on delete cascade,
  survivor_name          text,
  absorbed_name          text,
  survivor_dob           date,
  absorbed_dob           date,
  survivor_code          text,
  absorbed_code          text,
  absorbed_links         int  not null default 0,
  absorbed_code_requests int  not null default 0,
  shared_entities        int  not null default 0,
  verdict                text not null default 'proposed'
    check (verdict in ('proposed', 'applied', 'rejected', 'blocked')),
  block_reason           text,
  decided_by             uuid,
  decided_at             timestamptz,
  created_at             timestamptz not null default now(),
  unique (survivor_id, absorbed_id)
);

comment on table public.bm_person_merge_review is
  'Proposed merges of Athena''s legacy per-entity BrightManager contact rows '
  'into the (bm_person_ref, date_of_birth) canonical person. verdict=proposed '
  'means name and reference agree; verdict=blocked means they do not and a '
  'human must look — that is where the four colliding references, the two '
  'David Boyds, and any contact that has drifted away from BM land.';

alter table public.bm_person_merge_review enable row level security;

drop policy if exists bm_person_merge_review_staff on public.bm_person_merge_review;
create policy bm_person_merge_review_staff
  on public.bm_person_merge_review
  for all
  to authenticated
  using (is_active_staff())
  with check (is_active_staff());

revoke all on public.bm_person_merge_review from public;
grant select, insert, update, delete on public.bm_person_merge_review to authenticated;
grant all on public.bm_person_merge_review to service_role;

create index if not exists bm_person_merge_review_open_idx
  on public.bm_person_merge_review (verdict, created_at desc);

-- ─────────────────────────────────────────────────────────────────────────
-- 4. merge_person(): carry the two new columns
--
-- Merges always run legacy -> canonical, so the survivor already holds the
-- reference. These lines matter for the other direction and for a survivor
-- that was never stamped. A survivor whose stamp would collide with another
-- person raises on the unique index, which aborts the merge — correct: that
-- is two people, not one.
-- ─────────────────────────────────────────────────────────────────────────

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
  -- Keep the surviving link's primary-contact flag if either side had it.
  update entity_people tp set is_primary_contact = true
   where tp.person_id = p_target
     and exists (select 1 from entity_people sp
                  where sp.person_id = p_source and sp.entity_id = tp.entity_id
                    and sp.role = tp.role and sp.is_primary_contact);

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
    date_of_birth    = coalesce(date_of_birth,    src.date_of_birth),
    bm_person_ref    = coalesce(bm_person_ref,    src.bm_person_ref),
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

revoke all on function public.merge_person(uuid, uuid) from public;
grant execute on function public.merge_person(uuid, uuid) to authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────
-- 5. import_bm_people()
--
-- One row per (person reference, DOB). Called after import_bm_clients, which
-- has already upserted the entities this links to.
--
-- Payload row:
--   { bm_client_id, person_ref, slot: 'primary'|'secondary',
--     first_name, last_name, preferred_name, email, phone,
--     ni_number, ch_personal_code, dob }
-- ─────────────────────────────────────────────────────────────────────────

create or replace function public.import_bm_people(run_id uuid, payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  r              jsonb;
  v_ent          uuid;
  v_person       uuid;
  v_ref          text;
  v_slot         text;
  v_dob          date;
  v_first        text;
  v_last         text;
  v_pref         text;
  v_email        text;
  v_phone        text;
  v_ni           text;
  v_code         text;
  v_full         text;
  v_is_primary   boolean;
  v_created      int := 0;
  v_adopted      int := 0;
  v_matched      int := 0;
  v_links        int := 0;
  v_secondary    int := 0;
  v_demoted      int := 0;
  v_skipped      jsonb := '[]'::jsonb;
  v_errors       jsonb := '[]'::jsonb;
  v_proposed     int := 0;
  v_blocked      int := 0;
begin
  -- Same gate as import_bm_clients. `authenticated` is not staff — client
  -- portal users hold that role too — so the flag is checked explicitly.
  if not (
    coalesce(is_portal_admin(), false)
    or coalesce((select can_import_data from staff_profiles where id = auth.uid()), false)
  ) then
    raise exception 'forbidden: can_import_data required';
  end if;

  if not exists (select 1 from import_log where id = run_id and status = 'running') then
    raise exception 'import_log % not in running status', run_id;
  end if;

  for r in select * from jsonb_array_elements(coalesce(payload->'rows', '[]'::jsonb))
  loop
    begin
      v_ref  := nullif(btrim(coalesce(r->>'person_ref', '')), '');
      v_slot := coalesce(nullif(r->>'slot', ''), 'primary');

      if v_ref is null then
        v_skipped := v_skipped || jsonb_build_object(
          'bm_client_id', r->>'bm_client_id', 'slot', v_slot,
          'reason', 'no Person Internal Reference on this row');
        continue;
      end if;

      select id into v_ent from entities
       where bm_client_id = nullif(r->>'bm_client_id', '')
       limit 1;

      if v_ent is null then
        v_skipped := v_skipped || jsonb_build_object(
          'bm_client_id', r->>'bm_client_id', 'person_ref', v_ref,
          'reason', 'no entity for this Internal Reference — client row skipped or not imported');
        continue;
      end if;

      v_dob   := nullif(btrim(coalesce(r->>'dob', '')), '')::date;
      v_first := nullif(btrim(coalesce(r->>'first_name', '')), '');
      v_last  := nullif(btrim(coalesce(r->>'last_name', '')), '');
      v_pref  := nullif(btrim(coalesce(r->>'preferred_name', '')), '');
      v_email := nullif(lower(btrim(coalesce(r->>'email', ''))), '');
      v_phone := nullif(btrim(coalesce(r->>'phone', '')), '');
      v_ni    := nullif(upper(replace(coalesce(r->>'ni_number', ''), ' ', '')), '');
      v_code  := nullif(btrim(coalesce(r->>'ch_personal_code', '')), '');
      v_full  := nullif(btrim(concat_ws(' ', v_first, v_last)), '');
      v_is_primary := (v_slot = 'primary');

      if v_full is null and v_pref is null then
        v_skipped := v_skipped || jsonb_build_object(
          'bm_client_id', r->>'bm_client_id', 'person_ref', v_ref,
          'reason', 'reference with no name — nothing to identify');
        continue;
      end if;

      -- (a) The canonical person for this (reference, DOB).
      v_person := null;
      select id into v_person from people
       where bm_person_ref = v_ref
         and date_of_birth is not distinct from v_dob
       limit 1;

      if v_person is not null then
        v_matched := v_matched + 1;
      else
        -- (b) Adopt the legacy per-entity row rather than orphan it: the
        -- contact already linked to THIS entity in THIS slot, not yet
        -- stamped, whose name agrees. Anything else is left alone and
        -- surfaces in the merge review below.
        select p.id into v_person
          from entity_people ep
          join people p on p.id = ep.person_id
         where ep.entity_id = v_ent
           and ep.source = 'brightmanager'
           and ep.is_primary_contact = v_is_primary
           and p.bm_person_ref is null
           and p.source = 'brightmanager'
           and _bm_name_key(p.name) is not null
           and _bm_name_key(p.name) = _bm_name_key(coalesce(v_full, v_pref))
         limit 1;

        if v_person is not null then
          -- Stamping can collide with a person already holding this
          -- (reference, DOB); if it does, leave the legacy row for review
          -- and fall through to a fresh insert.
          begin
            update people set
              bm_person_ref = v_ref,
              date_of_birth = coalesce(v_dob, date_of_birth),
              updated_at    = now()
            where id = v_person;
            v_adopted := v_adopted + 1;
          exception when unique_violation then
            v_person := null;
          end;
        end if;
      end if;

      -- (c) Still nothing — a person BM knows and Athena does not. Most of
      -- these are the Secondary block, which was never imported.
      if v_person is null then
        insert into people (
          name, first_name, last_name, preferred_name, email,
          ni_number, ch_personal_code, bm_person_ref, date_of_birth, source
        ) values (
          coalesce(v_full, v_pref, '(unknown)'),
          v_first, v_last, v_pref, v_email,
          v_ni, v_code, v_ref, v_dob, 'brightmanager'
        )
        returning id into v_person;
        v_created := v_created + 1;
        if not v_is_primary then v_secondary := v_secondary + 1; end if;
      end if;

      -- (d) Refresh from BM. Name and email are BM's to set — it is the
      -- system of record for contact details. NI, code and DOB only fill a
      -- gap, so a code Athena chased down is never overwritten by a BM
      -- placeholder.
      update people set
        name             = coalesce(v_full, v_pref, name),
        first_name       = coalesce(v_first, first_name),
        last_name        = coalesce(v_last, last_name),
        preferred_name   = coalesce(v_pref, preferred_name),
        email            = coalesce(v_email, email),
        ni_number        = coalesce(ni_number, v_ni),
        ch_personal_code = coalesce(nullif(ch_personal_code, ''), v_code),
        date_of_birth    = coalesce(date_of_birth, v_dob),
        dob_year         = coalesce(dob_year,  extract(year  from v_dob)::smallint),
        dob_month        = coalesce(dob_month, extract(month from v_dob)::smallint),
        source           = 'brightmanager',
        updated_at       = now()
      where id = v_person;

      -- (e) Link. A person can be a contact on many entities; the slot is a
      -- property of the link, not of the person. 53 of BM's 344 references
      -- are primary on one client and secondary on another, which is exactly
      -- why this flag does not live on people.
      insert into entity_people (entity_id, person_id, role, is_primary_contact, source)
      values (v_ent, v_person, 'contact', v_is_primary, 'brightmanager')
      on conflict (entity_id, person_id, role) do update
        set is_primary_contact = entity_people.is_primary_contact or excluded.is_primary_contact,
            source             = 'brightmanager';
      v_links := v_links + 1;

      -- (f) One primary contact per entity. A stale row is demoted, never
      -- deleted — it may be a real person we hold data on, and deleting it
      -- would take its CH code chase with it.
      if v_is_primary then
        update entity_people
           set is_primary_contact = false
         where entity_id = v_ent
           and source = 'brightmanager'
           and person_id <> v_person
           and is_primary_contact;
        if found then v_demoted := v_demoted + 1; end if;
      end if;

    exception when others then
      v_errors := v_errors || jsonb_build_object(
        'bm_client_id', r->>'bm_client_id',
        'person_ref', r->>'person_ref',
        'message', sqlerrm);
    end;
  end loop;

  -- ── Propose merges ────────────────────────────────────────────────────
  -- Every legacy row that shares an entity with a stamped canonical is a
  -- candidate. Name agrees -> proposed. Name disagrees -> blocked, with the
  -- reason, so it is visible instead of silently merged or silently ignored.
  -- Nothing is moved here.
  with legacy as (
    select distinct on (legacy.id)
           legacy.id                                       as absorbed_id,
           canon.id                                        as survivor_id,
           canon.bm_person_ref                             as bm_person_ref,
           canon.name                                      as survivor_name,
           legacy.name                                     as absorbed_name,
           canon.date_of_birth                             as survivor_dob,
           legacy.date_of_birth                            as absorbed_dob,
           canon.ch_personal_code                          as survivor_code,
           legacy.ch_personal_code                         as absorbed_code,
           _bm_name_key(canon.name) = _bm_name_key(legacy.name) as names_agree,
           (select count(*) from entity_people x where x.person_id = legacy.id)      as absorbed_links,
           (select count(*) from ch_code_requests x where x.person_id = legacy.id)   as absorbed_reqs,
           (select count(*) from entity_people a
              join entity_people b on b.entity_id = a.entity_id
             where a.person_id = legacy.id and b.person_id = canon.id)               as shared_entities
      from entity_people lep
      join people        legacy on legacy.id = lep.person_id
      join entity_people cep    on cep.entity_id = lep.entity_id
      join people        canon  on canon.id = cep.person_id
     where lep.source = 'brightmanager'
       and cep.source = 'brightmanager'
       and legacy.source = 'brightmanager'
       and legacy.bm_person_ref is null
       and canon.bm_person_ref is not null
       and legacy.id <> canon.id
     -- Prefer the canonical whose name agrees, then the best-connected one,
     -- so a legacy row linked to several entities gets one proposal.
     order by legacy.id,
              (_bm_name_key(canon.name) = _bm_name_key(legacy.name)) desc nulls last,
              (select count(*) from entity_people x where x.person_id = canon.id) desc,
              canon.id
  )
  insert into bm_person_merge_review (
    run_id, bm_person_ref, survivor_id, absorbed_id,
    survivor_name, absorbed_name, survivor_dob, absorbed_dob,
    survivor_code, absorbed_code, absorbed_links, absorbed_code_requests,
    shared_entities, verdict, block_reason
  )
  select run_id, bm_person_ref, survivor_id, absorbed_id,
         survivor_name, absorbed_name, survivor_dob, absorbed_dob,
         survivor_code, absorbed_code, absorbed_links, absorbed_reqs,
         shared_entities,
         case when names_agree then 'proposed' else 'blocked' end,
         case when names_agree then null
              else 'BrightManager says the contact on this client is '
                   || coalesce(survivor_name, '(unknown)')
                   || ', Athena has ' || coalesce(absorbed_name, '(unknown)')
                   || '. Same person reference, different name — either a family '
                   || 'member sharing a BM reference, or a contact that changed '
                   || 'and Athena never caught up. Do not merge without checking.'
         end
    from legacy
  on conflict (survivor_id, absorbed_id) do nothing;

  select count(*) filter (where verdict = 'proposed'),
         count(*) filter (where verdict = 'blocked')
    into v_proposed, v_blocked
    from bm_person_merge_review
   where bm_person_merge_review.run_id = import_bm_people.run_id;

  return jsonb_build_object(
    'people_created',    v_created,
    'people_adopted',    v_adopted,
    'people_matched',    v_matched,
    'secondary_created', v_secondary,
    'links_written',     v_links,
    'primaries_demoted', v_demoted,
    'merges_proposed',    v_proposed,
    'merges_blocked',     v_blocked,
    'skipped',            v_skipped,
    'errors',             v_errors
  );
end $$;

revoke all on function public.import_bm_people(uuid, jsonb) from public;
grant execute on function public.import_bm_people(uuid, jsonb) to authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────
-- 6. apply_bm_person_merges() / set_bm_person_merge_verdict()
--
-- Applying goes through merge_person(), which already knows how to move an
-- open CH-code chase without losing a company's place in the queue.
-- 'blocked' rows are refused: clearing the block is a separate, deliberate act.
-- ─────────────────────────────────────────────────────────────────────────

create or replace function public.apply_bm_person_merges(p_ids uuid[])
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  rec      record;
  v_done   int := 0;
  v_failed jsonb := '[]'::jsonb;
begin
  if not (
    coalesce(is_portal_admin(), false)
    or coalesce((select can_import_data from staff_profiles where id = auth.uid()), false)
  ) then
    raise exception 'forbidden: can_import_data required';
  end if;

  for rec in
    select * from bm_person_merge_review
     where id = any(coalesce(p_ids, '{}'::uuid[]))
       and verdict = 'proposed'
     order by created_at
  loop
    begin
      -- Both sides must still exist; an earlier merge in this batch may have
      -- already absorbed one of them.
      if not exists (select 1 from people where id = rec.survivor_id)
         or not exists (select 1 from people where id = rec.absorbed_id) then
        v_failed := v_failed || jsonb_build_object(
          'id', rec.id, 'message', 'one side no longer exists — already merged?');
        continue;
      end if;

      perform merge_person(rec.survivor_id, rec.absorbed_id);

      update bm_person_merge_review
         set verdict = 'applied', decided_by = auth.uid(), decided_at = now()
       where id = rec.id;
      v_done := v_done + 1;
    exception when others then
      v_failed := v_failed || jsonb_build_object('id', rec.id, 'message', sqlerrm);
    end;
  end loop;

  return jsonb_build_object('applied', v_done, 'failed', v_failed);
end $$;

revoke all on function public.apply_bm_person_merges(uuid[]) from public;
grant execute on function public.apply_bm_person_merges(uuid[]) to authenticated, service_role;

create or replace function public.set_bm_person_merge_verdict(p_ids uuid[], p_verdict text)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare v_n int;
begin
  if not (
    coalesce(is_portal_admin(), false)
    or coalesce((select can_import_data from staff_profiles where id = auth.uid()), false)
  ) then
    raise exception 'forbidden: can_import_data required';
  end if;

  -- 'applied' is only ever set by apply_bm_person_merges, which does the work.
  if p_verdict not in ('proposed', 'rejected', 'blocked') then
    raise exception 'verdict must be proposed, rejected or blocked (got %)', p_verdict;
  end if;

  update bm_person_merge_review
     set verdict = p_verdict, decided_by = auth.uid(), decided_at = now()
   where id = any(coalesce(p_ids, '{}'::uuid[]))
     and verdict <> 'applied';

  get diagnostics v_n = row_count;
  return v_n;
end $$;

revoke all on function public.set_bm_person_merge_verdict(uuid[], text) from public;
grant execute on function public.set_bm_person_merge_verdict(uuid[], text) to authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────
-- 7. import_bm_clients(): hand the people over
--
-- Identical to the live definition except for the `skip_people` guard on the
-- primary-contact block. The writer sets it, because it calls
-- import_bm_people straight afterwards. Old callers and replays that do not
-- set it keep the legacy behaviour.
-- ─────────────────────────────────────────────────────────────────────────

create or replace function public.import_bm_clients(run_id uuid, payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  row_input jsonb; ent_id uuid; convert_id uuid;
  errs jsonb := '[]'::jsonb; skipped jsonb := '[]'::jsonb;
  entities_written int := 0; prospects_converted int := 0; people_upserted int := 0;
  bm_first text; bm_last text; bm_pref text; bm_email text; bm_full text; existing_person uuid;
  overrides_flagged int := 0;
  skip_people boolean := coalesce((payload->>'skip_people')::boolean, false);
begin
  if not (coalesce(is_portal_admin(), false) or coalesce((select can_import_data from staff_profiles where id = auth.uid()), false)) then
    raise exception 'forbidden: can_import_data required';
  end if;
  if not exists (select 1 from import_log where id = run_id and status = 'running') then
    raise exception 'import_log % not in running status', run_id;
  end if;

  for row_input in select * from jsonb_array_elements(payload->'rows') loop
    begin
      if nullif(row_input->>'bm_client_id', '') is null then
        skipped := skipped || jsonb_build_object('bm_client_id', null, 'reason', 'missing bm_client_id (Internal Reference)'); continue;
      end if;
      if nullif(row_input->>'name', '') is null then
        skipped := skipped || jsonb_build_object('bm_client_id', row_input->>'bm_client_id', 'reason', 'missing name'); continue;
      end if;
      if nullif(row_input->>'type', '') is null then
        skipped := skipped || jsonb_build_object('bm_client_id', row_input->>'bm_client_id', 'reason', 'missing/unmapped type'); continue;
      end if;

      ent_id := null; convert_id := nullif(row_input->>'convert_prospect_id', '')::uuid;

      if convert_id is not null then
        update entities set
          name = row_input->>'name', type = (row_input->>'type')::entity_type, bm_client_id = row_input->>'bm_client_id',
          company_number = nullif(row_input->>'company_number', ''), utr = nullif(row_input->>'utr', ''),
          vat_number = nullif(row_input->>'vat_number', ''), paye_ref = nullif(row_input->>'paye_ref', ''),
          accounts_office_ref = nullif(row_input->>'accounts_office_ref', ''), ch_auth_code = nullif(row_input->>'ch_auth_code', ''),
          manager = nullif(row_input->>'manager', ''), grade = nullif(row_input->>'grade', ''),
          entity_status = case when entity_status in ('nlac','archived') then entity_status else 'active' end,
          source = 'brightmanager', updated_at = now()
        where id = convert_id returning id into ent_id;
        if ent_id is not null then prospects_converted := prospects_converted + 1; entities_written := entities_written + 1; end if;
      end if;

      if ent_id is null then
        insert into entities (name, type, bm_client_id, company_number, utr, vat_number, paye_ref, accounts_office_ref, ch_auth_code, manager, grade, entity_status, source)
        values (row_input->>'name', (row_input->>'type')::entity_type, row_input->>'bm_client_id',
          nullif(row_input->>'company_number', ''), nullif(row_input->>'utr', ''), nullif(row_input->>'vat_number', ''),
          nullif(row_input->>'paye_ref', ''), nullif(row_input->>'accounts_office_ref', ''), nullif(row_input->>'ch_auth_code', ''),
          nullif(row_input->>'manager', ''), nullif(row_input->>'grade', ''), 'active', 'brightmanager')
        on conflict (bm_client_id) where bm_client_id is not null do update set
          name = excluded.name, type = excluded.type, company_number = excluded.company_number, utr = excluded.utr,
          vat_number = excluded.vat_number, paye_ref = excluded.paye_ref, accounts_office_ref = excluded.accounts_office_ref,
          ch_auth_code = excluded.ch_auth_code, manager = excluded.manager, grade = excluded.grade,
          entity_status = case when entities.entity_status in ('nlac','archived') then entities.entity_status else 'active' end,
          source = 'brightmanager', updated_at = now()
        returning id into ent_id;
        entities_written := entities_written + 1;
      end if;

      -- Primary contact. Superseded by import_bm_people, which keys on the
      -- Person Internal Reference instead of on "the contact of this entity"
      -- and so does not mint a fresh person per entity. Retained for callers
      -- that do not run it.
      if not skip_people then
        bm_first := nullif(row_input->>'_primary_first_name', ''); bm_last := nullif(row_input->>'_primary_last_name', '');
        bm_pref := nullif(row_input->>'_primary_preferred_name', ''); bm_email := nullif(row_input->>'_primary_email', '');
        bm_full := nullif(row_input->>'_primary_name', '');

        if ent_id is not null and (bm_first is not null or bm_last is not null or bm_pref is not null or bm_full is not null) then
          select person_id into existing_person from entity_people where entity_id = ent_id and source = 'brightmanager' and is_primary_contact = true limit 1;
          if existing_person is not null then
            update people set name = coalesce(bm_full, name), first_name = coalesce(bm_first, first_name), last_name = coalesce(bm_last, last_name),
              preferred_name = coalesce(bm_pref, preferred_name), email = coalesce(bm_email, email), source = 'brightmanager', updated_at = now()
            where id = existing_person;
          else
            insert into people (name, first_name, last_name, preferred_name, email, source)
            values (coalesce(bm_full, nullif(trim(concat_ws(' ', bm_first, bm_last)), ''), bm_pref, '(unknown)'), bm_first, bm_last, bm_pref, bm_email, 'brightmanager')
            returning id into existing_person;
            insert into entity_people (entity_id, person_id, role, is_primary_contact, source)
            values (ent_id, existing_person, 'contact', true, 'brightmanager')
            on conflict (entity_id, person_id, role) do update set is_primary_contact = true;
          end if;
          people_upserted := people_upserted + 1;
        end if;
      end if;
    exception when others then
      errs := errs || jsonb_build_object('bm_client_id', row_input->>'bm_client_id', 'message', sqlerrm);
    end;
  end loop;

  -- Athena field overrides win over BM: restore them + refresh their flags.
  overrides_flagged := reconcile_field_overrides();

  return jsonb_build_object('entities_written', entities_written, 'prospects_converted', prospects_converted,
    'people_upserted', people_upserted, 'overrides_flagged', overrides_flagged, 'errors', errs, 'skipped', skipped);
end $$;

revoke all on function public.import_bm_clients(uuid, jsonb) from public;
grant execute on function public.import_bm_clients(uuid, jsonb) to authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────
-- 8. reconcile_ch_codes(): prefer an exact person reference
--
-- The old lookup found "the primary contact of this client", with a
-- first-name/last-name fallback. For the two David Boyds — father and son,
-- both contacts of the same two Monument companies — that fallback matches
-- either man, so BOYDD01's code could land on BOYDD02's row and close his
-- chase. When the caller supplies the person reference, use it and skip the
-- name fallback entirely. Behaviour is unchanged when it is absent.
-- ─────────────────────────────────────────────────────────────────────────

create or replace function public.reconcile_ch_codes(p_pairs jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  rec record; e_id uuid; pc_first text; pc_last text; pc_person uuid;
  q record; v_landed int := 0; v_closed int := 0; v_flagged int := 0; v_errors_cleared int := 0; v_targeted boolean;
  v_by_ref boolean;
begin
  if not is_active_staff() then raise exception 'forbidden: staff only'; end if;

  for rec in select * from jsonb_to_recordset(coalesce(p_pairs, '[]'::jsonb))
             as x(bm_client_id text, code text, person_ref text)
  loop
    if rec.code is null or btrim(rec.code) = '' or rec.code like '%*%' then continue; end if;

    select id into e_id from entities where bm_client_id = rec.bm_client_id;
    if e_id is null then continue; end if;

    -- Auto-clear a "fix the code in BM" data-error to-do once a valid, changed
    -- code arrives for this client (the tester: Sophie's fix shows up next import).
    update admin_tasks t set confirmed_at = now(), bm_value = btrim(rec.code)
     where t.entity_id = e_id and t.source = 'bm_data_error'
       and t.confirmed_at is null and t.dismissed_at is null
       and btrim(rec.code) ~ '^[A-Za-z0-9]{3}-[A-Za-z0-9]{4}-[A-Za-z0-9]{4}$'
       and _norm_code(rec.code) <> _norm_code(coalesce(t.value,''));
    if found then v_errors_cleared := v_errors_cleared + 1; end if;

    -- Confirm "add personal code to BM" to-dos once BM's export carries the
    -- matching code for this client (silent verification for the Completed tab).
    update admin_tasks t set confirmed_at = now(), done_at = coalesce(t.done_at, now())
     where t.entity_id = e_id and t.kind = 'bm_code' and t.field = 'ch_personal_code'
       and t.confirmed_at is null and t.dismissed_at is null
       and (t.reopened_at is null or t.done_at is not null)
       and _norm_code(coalesce(t.value,'')) = _norm_code(rec.code);

    -- Whose code is this? An exact person reference beats every heuristic.
    pc_person := null; v_by_ref := false;
    if nullif(btrim(coalesce(rec.person_ref, '')), '') is not null then
      select ep.person_id into pc_person
        from entity_people ep join people p on p.id = ep.person_id
       where ep.entity_id = e_id and p.bm_person_ref = btrim(rec.person_ref)
       limit 1;
      if pc_person is not null then v_by_ref := true; end if;
    end if;

    if pc_person is null then
      select ep.person_id into pc_person
        from entity_people ep
        where ep.entity_id = e_id and ep.is_primary_contact limit 1;
    end if;

    select lower(split_part(p.name,' ',1)), lower(regexp_replace(p.name,'^.* ',''))
      into pc_first, pc_last
      from people p where p.id = pc_person;

    v_targeted := false;

    for q in
      select r.id as req_id, r.person_id, r.stage, p.ch_personal_code, p.name
      from ch_code_requests r
      join people p on p.id = r.person_id
      join entity_people ep on ep.person_id = p.id and ep.entity_id = e_id
      where r.entity_id = e_id and r.stage not in ('s6_submitted','s7_rejected')
        and ( -- Reference matched: this person and nobody else. Without it,
              -- fall back to the primary contact or a name match as before.
              case when v_by_ref then r.person_id = pc_person
                   else ep.is_primary_contact
                     or ( pc_first is not null
                          and lower(split_part(p.name,' ',1)) = pc_first
                          and lower(regexp_replace(p.name,'^.* ','')) = pc_last )
              end )
    loop
      v_targeted := true;
      if coalesce(q.ch_personal_code,'') = '' or q.ch_personal_code like '%*%'
         or _norm_code(q.ch_personal_code) = _norm_code(rec.code) then
        update people set ch_personal_code = btrim(rec.code) where id = q.person_id;
        update ch_code_requests set stage = 's5_entered', status = 'code_received',
               entered_bm_at = now(), bm_code_mismatch = null,
               emails_sent = 0, escalation_status = 'none', escalated_at = null, called_at = null, updated_at = now()
          where id = q.req_id;
        insert into ch_code_activity (request_id, kind, body)
          values (q.req_id, 'status_change', 'Personal code ' || btrim(rec.code) || ' found on BrightManager — code received & entered (Stage 5).');
        v_landed := v_landed + 1; v_closed := v_closed + 1;
      else
        update ch_code_requests set bm_code_mismatch = btrim(rec.code) where id = q.req_id;
        v_flagged := v_flagged + 1;
      end if;
    end loop;

    if not v_targeted and pc_person is not null then
      update people set ch_personal_code = btrim(rec.code)
        where id = pc_person and (coalesce(ch_personal_code,'') = '' or ch_personal_code like '%*%');
      v_landed := v_landed + 1;
    end if;
  end loop;

  return jsonb_build_object('codes_landed', v_landed, 'chases_closed', v_closed, 'flagged', v_flagged, 'bm_errors_cleared', v_errors_cleared);
end $$;

revoke all on function public.reconcile_ch_codes(jsonb) from public;
grant execute on function public.reconcile_ch_codes(jsonb) to authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────
-- 9. Review view — what a human reads before applying anything.
--    security_invoker so the base-table policies apply; a definer view would
--    read people as the owner and bypass RLS entirely.
-- ─────────────────────────────────────────────────────────────────────────

create or replace view public.v_bm_person_merge_review
with (security_invoker = true) as
select r.id,
       r.verdict,
       r.bm_person_ref,
       r.survivor_name,
       r.absorbed_name,
       r.survivor_dob,
       r.absorbed_dob,
       r.survivor_code,
       r.absorbed_code,
       r.absorbed_links,
       r.absorbed_code_requests,
       r.shared_entities,
       r.block_reason,
       r.created_at,
       r.survivor_id,
       r.absorbed_id,
       (select string_agg(e.name, ' - ' order by e.name)
          from entity_people ep join entities e on e.id = ep.entity_id
         where ep.person_id = r.absorbed_id) as absorbed_entities,
       (select string_agg(e.name, ' - ' order by e.name)
          from entity_people ep join entities e on e.id = ep.entity_id
         where ep.person_id = r.survivor_id) as survivor_entities
  from bm_person_merge_review r;

revoke all on public.v_bm_person_merge_review from public;
grant select on public.v_bm_person_merge_review to authenticated, service_role;

commit;
