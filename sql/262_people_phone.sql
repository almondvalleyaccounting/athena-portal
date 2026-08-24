-- ============================================================
-- people.phone — stop discarding BrightManager's Mobile Number, 24/08/2026
--
-- The BM client export carries "Mobile Number" (and "Secondary Mobile
-- Number") for both person blocks. The parser has always read it and
-- import_bm_people has always accepted it, but `people` had no column to put
-- it in, so it was assigned to a variable and dropped on the floor. 304 of
-- the 348 people in the 15/04/2026 export have one; 299 are plausible UK
-- mobiles.
--
-- Storing it is only worth doing because something is waiting for it. The
-- Communications module matches inbound SMS and WhatsApp to a name by phone
-- suffix (contactsByPhoneSuffix in src/modules/communications/api.js), and its
-- only source today is the Google Contacts mirror — 918 contacts of which
-- exactly 10 carry a phone number. So every client texting in shows as a bare
-- number. This takes the matchable pool from 10 to ~300.
--
-- That test matters: CLAUDE.md's rule is that removing data beats defending
-- it. A personal mobile number with no consumer would be worse held than
-- discarded, so this migration ships with the consumer wired up in the same
-- change — people are a THIRD tier behind the client record and the Google
-- contact book, filling gaps rather than overriding either.
-- ============================================================

begin;

alter table public.people add column if not exists phone text;

comment on column public.people.phone is
  'Mobile number from BrightManager''s "Mobile Number" / "Secondary Mobile '
  'Number". Normalised to E.164 for UK mobiles by the importer; anything with '
  'fewer than 10 or more than 13 digits is rejected rather than stored, which '
  'is how the two prose values in the export ("As above" and ".") are kept '
  'out. Consumed by the Communications SMS/WhatsApp name matcher.';

-- Last nine digits, the same key contactsByPhoneSuffix() uses, so a number
-- stored as +447810553033 matches a Google contact stored as "07810 553033".
-- Generated rather than written by the importer: a suffix that can drift out
-- of step with its number is worse than no suffix.
alter table public.people
  add column if not exists phone_suffix text
  generated always as (
    nullif(right(regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g'), 9), '')
  ) stored;

comment on column public.people.phone_suffix is
  'Last 9 digits of phone, generated. Matches phoneSuffix(raw, 9) in '
  'src/modules/communications/api.js — keep the two in step.';

create index if not exists people_phone_suffix_idx
  on public.people (phone_suffix)
  where phone_suffix is not null;

-- import_bm_people: write the phone it was already being handed.
-- Identical to sql/255 except for the two phone lines (insert list, update set).
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
  -- Same gate as import_bm_clients. `authenticated` is not staff - client
  -- portal users hold that role too - so the flag is checked explicitly.
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
          'reason', 'no entity for this Internal Reference - client row skipped or not imported');
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
          'reason', 'reference with no name - nothing to identify');
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

      -- (c) Still nothing - a person BM knows and Athena does not. Most of
      -- these are the Secondary block, which was never imported.
      if v_person is null then
        insert into people (
          name, first_name, last_name, preferred_name, email, phone,
          ni_number, ch_personal_code, bm_person_ref, date_of_birth, source
        ) values (
          coalesce(v_full, v_pref, '(unknown)'),
          v_first, v_last, v_pref, v_email, v_phone,
          v_ni, v_code, v_ref, v_dob, 'brightmanager'
        )
        returning id into v_person;
        v_created := v_created + 1;
        if not v_is_primary then v_secondary := v_secondary + 1; end if;
      end if;

      -- (d) Refresh from BM. Name, email and phone are BM's to set - it is
      -- the system of record for contact details. NI, code and DOB only fill
      -- a gap, so a code Athena chased down is never overwritten by a BM
      -- placeholder.
      update people set
        name             = coalesce(v_full, v_pref, name),
        first_name       = coalesce(v_first, first_name),
        last_name        = coalesce(v_last, last_name),
        preferred_name   = coalesce(v_pref, preferred_name),
        email            = coalesce(v_email, email),
        phone            = coalesce(v_phone, phone),
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
      -- deleted - it may be a real person we hold data on, and deleting it
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

  -- Propose merges. A legacy row is a candidate when it is an unidentified
  -- brightmanager person sharing an entity with a stamped canonical. How
  -- either of them came to be linked to that entity is irrelevant - keying on
  -- the link source missed Anne Muir, whose canonical reaches the shared
  -- company through Companies House while the duplicate holds the BM link.
  -- Name agrees -> proposed. Name disagrees -> blocked, with the reason, so
  -- it is visible instead of silently merged or silently ignored. Nothing is
  -- moved here.
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
     where legacy.source = 'brightmanager'
       and legacy.bm_person_ref is null
       and canon.bm_person_ref is not null
       and legacy.id <> canon.id
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
                   || '. Same person reference, different name - either a family '
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
    'merges_proposed',   v_proposed,
    'merges_blocked',    v_blocked,
    'skipped',           v_skipped,
    'errors',            v_errors
  );
end $$;

revoke all on function public.import_bm_people(uuid, jsonb) from public;
grant execute on function public.import_bm_people(uuid, jsonb) to authenticated, service_role;

-- merge_person: carry the phone onto the survivor, like every other contact
-- field. phone_suffix is generated, so it follows automatically.
--
-- Applied as a targeted in-place edit rather than a full CREATE OR REPLACE:
-- the change is one line, and re-stating the whole body (see sql/255 for it)
-- invites the two copies drifting apart. It raises rather than silently
-- no-opping if the anchor line is not found.
do $do$
declare src text; before text;
begin
  select pg_get_functiondef(p.oid) into src
    from pg_proc p
   where p.proname = 'merge_person' and p.pronamespace = 'public'::regnamespace;
  before := src;

  src := replace(src,
    'email            = coalesce(nullif(email,''''), src.email),',
    'email            = coalesce(nullif(email,''''), src.email),' || chr(10) ||
    '    phone            = coalesce(nullif(phone,''''), src.phone),');

  if src = before then
    raise exception 'merge_person: phone line did not apply - anchor not found';
  end if;
  if src not like '%phone            = coalesce(nullif(phone%' then
    raise exception 'merge_person: phone line missing after replace';
  end if;

  execute src;
end $do$;

revoke all on function public.merge_person(uuid, uuid) from public;
grant execute on function public.merge_person(uuid, uuid) to authenticated, service_role;

commit;
