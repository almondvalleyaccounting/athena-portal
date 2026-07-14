-- ============================================================
-- Athena field overrides vs BrightManager (the "Athena keeps your value,
-- flags where BM differs, and holds a Sophie to-do until aligned" model —
-- same shape as the capacity-planner reallocation drafts).
--
-- When a shared entity field (company_number / utr / vat_number / paye_ref /
-- ch_auth_code) is edited in Athena, we:
--   * keep the Athena value on the entity,
--   * raise ONE open admin_tasks row (kind 'bm_field') = Sophie's to-do to
--     update BM, carrying the differing BM value in the new bm_value column,
--   * and — critically — the BM import no longer wins: reconcile_field_overrides()
--     runs at the end of import_bm_clients, restoring the Athena value over
--     whatever BM sent and stamping bm_value with BM's current value. When BM
--     finally matches, the task auto-confirms and drops off (flag clears).
-- ============================================================

alter table admin_tasks add column if not exists bm_value text;

alter table admin_tasks drop constraint if exists admin_tasks_kind_check;
alter table admin_tasks add constraint admin_tasks_kind_check
  check (kind in ('bm_code','manual','bm_field'));

alter table admin_tasks drop constraint if exists admin_tasks_field_check;
alter table admin_tasks add constraint admin_tasks_field_check
  check (field is null or field in ('ch_auth_code','utr','vat_number','paye_ref','ch_personal_code','company_number'));

-- normalise for comparison (case/space/punctuation-insensitive)
create or replace function public._norm_code(t text) returns text
  language sql immutable as $$ select regexp_replace(lower(coalesce(t,'')), '[^a-z0-9]', '', 'g') $$;

-- Called from the client page after an Athena edit to a BM-shared field.
create or replace function public.record_field_override(p_entity_id uuid, p_field text, p_value text, p_bm_value text)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_name  text;
  v_label text := case p_field
    when 'company_number' then 'company number' when 'utr' then 'UTR'
    when 'vat_number' then 'VAT number' when 'paye_ref' then 'PAYE ref'
    when 'ch_auth_code' then 'CH auth code' else p_field end;
  v_title text; v_detail text;
begin
  if not is_active_staff() then raise exception 'forbidden: staff only'; end if;
  select name into v_name from entities where id = p_entity_id;
  v_title := 'Update ' || v_label || ' for ' || coalesce(v_name, 'client') || ' in BrightManager';
  v_detail := 'Athena value: ' || coalesce(nullif(p_value,''), '(blank)')
           || ' · BM value: ' || coalesce(nullif(p_bm_value,''), '(blank)') || '. Clears when BM matches.';

  -- If the new Athena value already equals BM, there's no inconsistency —
  -- close any open override and stop.
  if _norm_code(p_value) = _norm_code(p_bm_value) then
    update admin_tasks set confirmed_at = now(), bm_value = nullif(p_bm_value,'')
     where entity_id = p_entity_id and field = p_field and kind = 'bm_field'
       and confirmed_at is null and dismissed_at is null;
    return;
  end if;

  update admin_tasks
     set value = nullif(p_value,''), bm_value = nullif(p_bm_value,''), title = v_title, detail = v_detail
   where entity_id = p_entity_id and field = p_field and kind = 'bm_field'
     and confirmed_at is null and dismissed_at is null;
  if not found then
    insert into admin_tasks (kind, entity_id, field, value, bm_value, title, detail, source, created_by)
    values ('bm_field', p_entity_id, p_field, nullif(p_value,''), nullif(p_bm_value,''), v_title, v_detail, 'athena_override', v_actor);
  end if;
end;
$$;

-- Runs at the END of a BM import (see import_bm_clients): for every open
-- bm_field override, compare the entity's just-imported value to the Athena
-- value. Aligned → confirm & clear. Different → restore the Athena value over
-- BM's and record BM's value for the flag. Returns how many still differ.
create or replace function public.reconcile_field_overrides()
returns int
language plpgsql security definer set search_path = public
as $$
declare o record; v_bm text; v_diff int := 0;
begin
  for o in select id, entity_id, field, value from admin_tasks
            where kind = 'bm_field' and confirmed_at is null and dismissed_at is null
  loop
    execute format('select %I::text from entities where id = $1', o.field) into v_bm using o.entity_id;
    if _norm_code(v_bm) = _norm_code(o.value) then
      update admin_tasks set bm_value = v_bm, confirmed_at = now() where id = o.id;   -- aligned
    else
      execute format('update entities set %I = $1, updated_at = now() where id = $2', o.field)
        using nullif(o.value,''), o.entity_id;                                        -- keep Athena value
      update admin_tasks set bm_value = v_bm where id = o.id;                          -- flag BM's value
      v_diff := v_diff + 1;
    end if;
  end loop;
  return v_diff;
end;
$$;

grant execute on function public.record_field_override(uuid, text, text, text) to authenticated;
grant execute on function public.reconcile_field_overrides() to authenticated;
grant execute on function public._norm_code(text) to authenticated;
