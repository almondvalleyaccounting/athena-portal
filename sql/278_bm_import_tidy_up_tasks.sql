-- 278_bm_import_tidy_up_tasks.sql
--
-- The BrightManager clients import has always *found* the tidy-ups. It found
-- them and then drew them on a page you leave: a client row with no Internal
-- Reference (skipped whole, so nothing about that client comes across), one
-- Person Internal Reference carrying two people (imports correctly, wrong at
-- source, collides again on every re-import), and the row the write itself
-- refused (a company number already held by another record — that client's
-- update is silently dropped).
--
-- Nothing wrote any of it down. `import_log.warnings` / `skipped_rows` /
-- `errors` keep the audit trail, but an audit trail is not a to-do list, so
-- "someone should fix that in BM" survived exactly as long as the browser tab.
-- BLACR01, COLLS02 and SHAWW01 have been reported on every import since
-- 15/04/2026 and are still shared.
--
-- raise_bm_import_tasks(run_id) reads the findings the run already recorded
-- and puts each one on the admin task list, in the existing "BM Data Errors"
-- group. Three properties matter more than the tasks themselves:
--
--   * Idempotent. A finding with an open task is not raised again, so a
--     weekly import does not mint a fifth copy of BLACR01.
--   * Dismissal is final. Dismiss one and it is never raised again — the
--     judgement sticks (same contract as raise_person_dedup_tasks).
--   * Self-closing. A finding absent from the newest import is marked done,
--     so fixing it in BrightManager clears the task with nobody ticking it.
--
-- Deliberately NOT raised: the per-row warnings that are advisory rather than
-- actionable at source (no person reference on the row, no primary email,
-- a US "Inc" with no Company Number). Fifteen tasks a week nobody actions is
-- how a task list stops being read.
--
-- entity_id is left null on purpose. Three other functions
-- (sql/116, sql/255, schema_ch_code_bm_reconcile) confirm *any* open
-- 'bm_data_error' task for an entity when a valid CH code lands for it. An
-- entity_id here would let a Companies House code silently close a
-- shared-person-reference task it has nothing to do with.

create or replace function public.raise_bm_import_tasks(p_run_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_source    text;
  v_warnings  jsonb;
  v_skipped   jsonb;
  v_errors    jsonb;
  rec         record;
  v_key       text;
  v_name      text;
  v_cn        text;
  v_live      boolean;
  v_raised    int := 0;
  v_closed    int := 0;
  v_book      int;
  v_rows      int;
  n           int;
  live_ref    text[] := '{}';   -- missing Internal Reference
  live_person text[] := '{}';   -- shared Person Internal Reference
  live_clash  text[] := '{}';   -- write refused: duplicate company number
begin
  if not is_staff_or_service() then
    raise exception 'not authorised' using errcode = '42501';
  end if;

  -- The three arrays in import_log are written by the importer: warnings and
  -- skipped_rows at validation, errors at completion. jsonb_typeof guards
  -- because import_bm_clients also appends an object ({duplicate_names:...})
  -- to warnings on some runs.
  select source_key,
         case when jsonb_typeof(warnings)     = 'array' then warnings     else '[]'::jsonb end,
         case when jsonb_typeof(skipped_rows) = 'array' then skipped_rows else '[]'::jsonb end,
         case when jsonb_typeof(errors)       = 'array' then errors       else '[]'::jsonb end
    into v_source, v_warnings, v_skipped, v_errors
    from import_log
   where id = p_run_id;

  if v_source is distinct from 'bm_clients' then
    return jsonb_build_object('raised', 0, 'closed', 0, 'reason', 'not a bm_clients run');
  end if;

  ---------------------------------------------------------------------------
  -- 1. Client row with no Internal Reference — skipped entirely.
  --    The name is the only identifier the row has, so it is the key.
  ---------------------------------------------------------------------------
  for rec in
    select distinct btrim(w->>'name') as client_name
      from jsonb_array_elements(v_skipped) w
     where w->>'field' = 'bm_client_id'
       and coalesce(btrim(w->>'name'), '') <> ''
  loop
    v_key := 'import:missing_ref:' || lower(rec.client_name);
    live_ref := live_ref || v_key;

    if not exists (
      select 1 from admin_tasks
       where value = v_key
         and (dismissed_at is not null
              or (done_at is null and confirmed_at is null))
    ) then
      insert into admin_tasks (kind, source, title, detail, value)
      values (
        'manual', 'bm_data_error',
        'BrightManager: give ' || rec.client_name || ' an Internal Reference',
        'The clients import skipped this row completely. With no Internal Reference there is '
        || 'nothing to link the client across systems, so no part of the row came across — no '
        || 'entity, no contact, no tax references — and none will on any future import either. '
        || 'Add an Internal Reference in BrightManager, then re-run the Clients import. This '
        || 'task closes itself once the row imports.',
        v_key
      );
      v_raised := v_raised + 1;
    end if;
  end loop;

  ---------------------------------------------------------------------------
  -- 2. One Person Internal Reference, two different people.
  --    Not blocking — identity is (reference, DOB), so they import as
  --    separate people — but wrong at source, and it collides every time.
  ---------------------------------------------------------------------------
  for rec in
    select distinct
           substring(w->>'message' from 'Person Internal Reference "([^"]+)"') as person_ref,
           w->>'message' as message
      from jsonb_array_elements(v_warnings) w
     where w->>'field' = 'person_ref'
       and w->>'message' like 'Person Internal Reference %is shared by%'
  loop
    continue when rec.person_ref is null;
    v_key := 'import:person_ref:' || upper(rec.person_ref);
    live_person := live_person || v_key;

    if not exists (
      select 1 from admin_tasks
       where value = v_key
         and (dismissed_at is not null
              or (done_at is null and confirmed_at is null))
    ) then
      insert into admin_tasks (kind, source, title, detail, value)
      values (
        'manual', 'bm_data_error',
        'BrightManager: person reference ' || upper(rec.person_ref) || ' is shared by two people',
        rec.message
        || E'\n\nNothing is blocked and nothing is merged — Athena identifies a person by their '
        || 'reference AND their date of birth, so these two import as separate people. But the '
        || 'reference is wrong in BrightManager and will collide again on every import until the '
        || 'second person gets their own. This task closes itself once the collision stops '
        || 'appearing in an import.',
        v_key
      );
      v_raised := v_raised + 1;
    end if;
  end loop;

  ---------------------------------------------------------------------------
  -- 3. The write refused the row: its company number is already held by
  --    another entity. This one loses data — the client's whole update is
  --    dropped — and it recurs on every import (JGTI001 failed twice, in
  --    August and September, seen by nobody).
  ---------------------------------------------------------------------------
  for rec in
    select distinct e->>'bm_client_id' as bm_client_id
      from jsonb_array_elements(v_errors) e
     where e->>'message' like '%entities_company_number_uniq%'
       and coalesce(e->>'bm_client_id', '') <> ''
  loop
    v_key := 'import:company_number:' || upper(rec.bm_client_id);
    live_clash := live_clash || v_key;

    -- Where the reference stands NOW, which is not necessarily where it stood
    -- during the run. The unique index means that if this reference's own
    -- record holds a company number, no other record can — so the clash has
    -- been resolved since, and the task should say so instead of sending
    -- somebody hunting for a duplicate that is not there. The task is still
    -- raised: the import genuinely dropped this client's row, and it is the
    -- next clean import that proves the fix, not this function.
    select name, company_number into v_name, v_cn
      from entities where bm_client_id = rec.bm_client_id;
    v_live := v_name is null or v_cn is null;

    if not exists (
      select 1 from admin_tasks
       where value = v_key
         and (dismissed_at is not null
              or (done_at is null and confirmed_at is null))
    ) then
      insert into admin_tasks (kind, source, title, detail, value, urgent)
      values (
        'manual', 'bm_data_error',
        'Import blocked: two client records hold one company number ('
          || coalesce(v_name, rec.bm_client_id) || ')',
        'BrightManager sent Internal Reference ' || rec.bm_client_id || ' for a company whose '
        || 'Companies House number is already recorded against a different client record in '
        || 'Athena, and a company number can only belong to one record. The import wrote nothing '
        || 'at all for this client — no name change, no tax references, no contact — and will '
        || 'fail the same way on every import until the duplicate is resolved.'
        || case when v_live then
             E'\n\nFind the other record: search the company number in Clients. Usually it is the '
             || 'same company entered twice — once from BrightManager and once from onboarding or '
             || 'a Companies House lookup — in which case keep the record that carries the history '
             || 'and clear the company number from the other. This task closes itself on the next '
             || 'clean import.'
           else
             E'\n\nChecked just now: reference ' || rec.bm_client_id || ' is linked to '
             || v_name || ', holding company number ' || v_cn || ' — and the unique index means '
             || 'no other record can hold that number, so the duplicate has been resolved since '
             || 'the import ran. Nothing to fix; re-run the Clients import when convenient and '
             || 'this task closes itself. Raised anyway because that import did drop this '
             || 'client''s row.'
           end,
        v_key, v_live
      );
      v_raised := v_raised + 1;
    end if;
  end loop;

  ---------------------------------------------------------------------------
  -- Self-close. Every one of these three checks runs on every bm_clients
  -- import, so a finding this run did NOT report has been fixed at source —
  -- but only if the run actually looked at the whole book. A one-client
  -- re-run, or a CSV somebody filtered before exporting it, reports none of
  -- the other findings for the simple reason that it never saw those rows,
  -- and closing five open BM data errors off the back of a single-row upload
  -- would be worse than never having raised them. So coverage is measured
  -- against the largest recent upload, in the spirit of the archive panel's
  -- own partial-upload heuristic: below 80% we raise but never close.
  --
  -- Scoped by value prefix so it can never touch the other things that live
  -- under source='bm_data_error'.
  ---------------------------------------------------------------------------
  select coalesce(max(source_row_count), 0) into v_book
    from import_log
   where source_key = 'bm_clients' and status = 'complete'
     and created_at > now() - interval '120 days';

  select coalesce(source_row_count, 0) into v_rows from import_log where id = p_run_id;

  if v_book > 0 and v_rows < (v_book * 0.8) then
    return jsonb_build_object(
      'raised', v_raised,
      'closed', 0,
      'partial_upload', true,
      'rows', v_rows,
      'book', v_book,
      'missing_reference', array_length(live_ref, 1),
      'shared_person_reference', array_length(live_person, 1),
      'company_number_clash', array_length(live_clash, 1)
    );
  end if;

  update admin_tasks set done_at = now(), confirmed_at = now()
   where value like 'import:missing_ref:%'
     and done_at is null and confirmed_at is null and dismissed_at is null
     and not (value = any(live_ref));
  get diagnostics n = row_count;  v_closed := v_closed + n;

  update admin_tasks set done_at = now(), confirmed_at = now()
   where value like 'import:person_ref:%'
     and done_at is null and confirmed_at is null and dismissed_at is null
     and not (value = any(live_person));
  get diagnostics n = row_count;  v_closed := v_closed + n;

  update admin_tasks set done_at = now(), confirmed_at = now()
   where value like 'import:company_number:%'
     and done_at is null and confirmed_at is null and dismissed_at is null
     and not (value = any(live_clash));
  get diagnostics n = row_count;  v_closed := v_closed + n;

  return jsonb_build_object(
    'raised', v_raised,
    'closed', v_closed,
    'missing_reference', array_length(live_ref, 1),
    'shared_person_reference', array_length(live_person, 1),
    'company_number_clash', array_length(live_clash, 1)
  );
end;
$$;

comment on function public.raise_bm_import_tasks(uuid) is
  'Turns one BM clients import run''s recorded findings (missing Internal Reference, shared Person Internal Reference, duplicate company number) into admin_tasks in the BM Data Errors group. Idempotent, dismissal-respecting and self-closing.';

-- Called from the browser by the importer, immediately after the run is
-- marked complete (errors are only recorded at that point). Staff-gated
-- inside; is_staff_or_service also passes service_role and no-JWT callers so
-- a future cron can re-run it.
-- `anon` and `public` both, in that order and both explicitly. A default
-- privilege on this schema grants EXECUTE on every new function to anon as
-- it is created, and `revoke from public` does not touch a named-role grant —
-- so the posture audit found this function anon-executable on the first pass
-- with the public revoke already in place. Revoking from public alone is not
-- the same statement as revoking from anon.
revoke all on function public.raise_bm_import_tasks(uuid) from anon, public;
grant execute on function public.raise_bm_import_tasks(uuid) to authenticated, service_role;
