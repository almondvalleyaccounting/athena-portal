-- 290 — Strike-off triage cases in plain English.
--
-- The trigger wrote Companies House's raw status pair, so the board read
-- "Companies House status changed: active → active (active-proposal-to-strike-off)".
-- It now says what has happened to the company. Existing cases and their notes are
-- rewritten from the ch_status_events row they came from.

create or replace function public.ch_status_label(p_status text, p_detail text)
returns text
language sql
immutable
set search_path = public
as $$
  select case
    when p_detail = 'active-proposal-to-strike-off'
      then 'Companies House has proposed striking off this company. Check for overdue accounts or a missed confirmation statement and act before the Gazette notice runs out.'
    when p_status = 'voluntary-arrangement' or p_detail = 'voluntary-arrangement'
      then 'The company has entered a voluntary arrangement (CVA).'
    when p_status = 'liquidation'            then 'The company has gone into liquidation.'
    when p_status = 'administration'         then 'The company is in administration.'
    when p_status = 'receivership'           then 'A receiver has been appointed to the company.'
    when p_status = 'insolvency-proceedings' then 'Insolvency proceedings have started against the company.'
    when p_status = 'dissolved'              then 'The company has been dissolved and removed from the register.'
    when p_status = 'converted-closed'       then 'The company has been converted or closed.'
    when p_status = 'petition-to-restore-dissolved' then 'A petition has been made to restore this company to the register.'
    else 'Companies House status is now ' || coalesce(replace(p_status, '-', ' '), 'unknown')
         || coalesce(' (' || replace(p_detail, '-', ' ') || ')', '') || '.'
  end
$$;

revoke all on function public.ch_status_label(text, text) from public, anon;
grant execute on function public.ch_status_label(text, text) to authenticated, service_role;

create or replace function public.triage_from_ch_status_event()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_case_id uuid;
  v_status  entity_status;
begin
  if (new.new_status || ' ' || coalesce(new.new_detail, '')) !~* '(strike|liquidat|administrat|insolven|dissolv|receiver)' then
    return new;
  end if;
  -- No work is done for former clients — they don't belong on the board.
  select entity_status into v_status from entities where id = new.entity_id;
  if v_status in ('nlac', 'archived') then
    return new;
  end if;
  -- One open strike_off case per client; add a note instead of a duplicate.
  select id into v_case_id from triage_cases
   where entity_id = new.entity_id and category = 'strike_off' and status = 'open'
   limit 1;
  if v_case_id is null then
    insert into triage_cases (entity_id, category, description, source, ch_status_event_id)
    values (new.entity_id, 'strike_off', ch_status_label(new.new_status, new.new_detail), 'ch_status', new.id)
    returning id into v_case_id;
  else
    insert into triage_case_notes (case_id, body)
    values (v_case_id, 'Further change at Companies House: ' || ch_status_label(new.new_status, new.new_detail));
  end if;
  update ch_status_events set triage_case_id = v_case_id where id = new.id;
  return new;
end $$;

-- Rewrite what is already on the board.
update triage_cases tc
   set description = ch_status_label(e.new_status, e.new_detail)
  from ch_status_events e
 where e.id = tc.ch_status_event_id
   and tc.description like 'Companies House status changed:%';

update triage_case_notes n
   set body = 'Further change at Companies House: ' || ch_status_label(e.new_status, e.new_detail)
  from ch_status_events e
 where e.triage_case_id = n.case_id
   and n.body like 'Further Companies House status change: %'
   and n.body = 'Further Companies House status change: ' || e.new_status || coalesce(' (' || e.new_detail || ')', '');
