-- ============================================================
-- 341: An escalated CH personal-code chase reaches someone the moment it is
-- escalated.
--
-- Until now "Escalate" on the CH-codes pipeline set
-- ch_code_requests.escalation_status = 'escalated_tracy' and nothing else. It
-- stopped the automatic reminders (ch-code-queue-fill skips it), took the
-- person off the Wednesday call list (ch-code-calls wants 'none'), and the only
-- place it surfaced was the Monday ch-code-weekly email, worded the same as a
-- plain "call needed". ch-code-chase, which has an "Escalated" digest section,
-- is not scheduled. So an escalation stopped the chasing and waited up to a
-- week for someone to notice. Two had been sitting since 19 Aug.
--
-- A trigger rather than a UI call, so every write path is covered: the
-- pipeline button, the detail page, a hand edit.
--
-- Recipients are the people who own this chaser: ch_code_chase_config
-- .weekly_recipient_ids (the Monday-email list). If that is empty, portal
-- admins. The person escalating is excluded. source_key dedupes, so
-- re-escalating after a removal notifies again only because escalated_at is
-- part of the key.
-- ============================================================

create or replace function public.ch_code_escalation_notify()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_person text;
  v_entity text;
  v_ids    uuid[];
begin
  if new.escalation_status is distinct from 'escalated_tracy' then return new; end if;
  if tg_op = 'UPDATE' and old.escalation_status is not distinct from 'escalated_tracy' then return new; end if;

  select p.name into v_person from people p where p.id = new.person_id;
  select e.name into v_entity from entities e where e.id = new.entity_id;
  select c.weekly_recipient_ids into v_ids from ch_code_chase_config c limit 1;

  insert into notifications (recipient_id, kind, title, body, link_path, source_key)
  select sp.id,
         'ch_code_escalated',
         'CH code escalated: ' || coalesce(v_person, 'a director'),
         coalesce(v_entity, 'Unknown company')
           || ' — ' || coalesce(new.emails_sent, 0) || ' email(s) sent'
           || case when new.called_at is not null
                   then ', last called ' || to_char(new.called_at, 'DD Mon') else ', no call logged' end
           || '. Automatic reminders have stopped; this needs a decision.',
         '/onboarding/ch-codes/' || new.id::text,
         'ch_esc:' || new.id::text || ':' || coalesce(new.escalated_at::text, '')
    from staff_profiles sp
   where sp.is_active is not false
     and (auth.uid() is null or sp.id <> auth.uid())
     and (
       (coalesce(array_length(v_ids, 1), 0) > 0 and sp.id = any(v_ids))
       or (coalesce(array_length(v_ids, 1), 0) = 0 and sp.is_portal_admin)
     )
  on conflict (recipient_id, source_key) where source_key is not null do nothing;

  return new;
end $$;

revoke all on function public.ch_code_escalation_notify() from public, anon, authenticated;

drop trigger if exists ch_code_escalation_notify on public.ch_code_requests;
create trigger ch_code_escalation_notify
  after insert or update of escalation_status on public.ch_code_requests
  for each row execute function public.ch_code_escalation_notify();

-- The escalations already standing: notify once now, same shape.
insert into notifications (recipient_id, kind, title, body, link_path, source_key)
select sp.id,
       'ch_code_escalated',
       'CH code escalated: ' || coalesce(p.name, 'a director'),
       coalesce(e.name, 'Unknown company')
         || ' — escalated ' || to_char(r.escalated_at, 'DD Mon') || ', '
         || coalesce(r.emails_sent, 0) || ' email(s) sent. Automatic reminders have stopped; this needs a decision.',
       '/onboarding/ch-codes/' || r.id::text,
       'ch_esc:' || r.id::text || ':' || coalesce(r.escalated_at::text, '')
  from ch_code_requests r
  left join people p on p.id = r.person_id
  left join entities e on e.id = r.entity_id
  cross join ch_code_chase_config c
  join staff_profiles sp on sp.id = any(c.weekly_recipient_ids) and sp.is_active is not false
 where r.escalation_status = 'escalated_tracy'
   and coalesce(e.entity_status::text, 'active') not in ('nlac', 'archived')
   and r.stage not in ('s6_submitted', 's7_rejected')
on conflict (recipient_id, source_key) where source_key is not null do nothing;
