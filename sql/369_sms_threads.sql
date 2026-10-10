-- 369: Text Messages / WhatsApp as a queue to clear.
--
-- The practice number is one shared inbox, so a conversation (channel + the
-- other party's number) is worked like a shared mailbox: assign it, raise an
-- action from it, or clear it. A conversation is OPEN while it holds an inbound
-- message newer than its last clear — so a fresh text reopens it by itself and
-- nothing has to remember to.
--
-- Writes go through the sms-thread edge function (staff-gated). The browser
-- reads v_sms_threads; it has no write path to either table.
--
-- Client match, in order: a client set by hand on the thread → the client the
-- messages were filed against (sms-send / telnyx-inbound) → the only active
-- client the number belongs to (people.phone_suffix via entity_people, or a
-- prospect's prospect_phone). Several candidates = pick one; none = "Other".

-- Superseded by the thread-level clear below (added earlier the same day).
alter table public.sms_messages drop column if exists read_at;
alter table public.sms_messages drop column if exists read_by;
drop index if exists public.sms_messages_unread_idx;

create table if not exists public.sms_threads (
  channel      text not null check (channel in ('sms', 'whatsapp')),
  number       text not null,
  entity_id    uuid references public.entities(id) on delete set null,
  assigned_to  uuid references public.staff_profiles(id) on delete set null,
  assigned_by  uuid references public.staff_profiles(id) on delete set null,
  assigned_at  timestamptz,
  cleared_at   timestamptz,
  cleared_by   uuid references public.staff_profiles(id) on delete set null,
  cleared_note text,
  updated_at   timestamptz not null default now(),
  primary key (channel, number)
);

alter table public.sms_threads enable row level security;
revoke all on public.sms_threads from public, anon, authenticated;
grant select on public.sms_threads to authenticated;
grant all on public.sms_threads to service_role;
drop policy if exists "Staff read sms threads" on public.sms_threads;
create policy "Staff read sms threads" on public.sms_threads
  for select to authenticated using (is_active_staff());

-- Start clean: everything received so far counts as cleared.
insert into public.sms_threads (channel, number, cleared_at, cleared_note)
select channel, from_number, now(), 'Cleared when the queue started'
  from public.sms_messages
 where direction = 'in'
 group by channel, from_number
on conflict (channel, number) do nothing;

create or replace view public.v_sms_threads
with (security_invoker = true) as
with m as (
  select channel,
         case when direction = 'out' then to_number else from_number end as number,
         direction, created_at, entity_id
    from public.sms_messages
), agg as (
  select channel, number,
         max(created_at) as last_at,
         max(created_at) filter (where direction = 'in') as last_in_at,
         count(*) filter (where direction = 'in') as inbound,
         (array_agg(entity_id order by created_at desc) filter (where entity_id is not null))[1] as msg_entity_id,
         right(regexp_replace(number, '\D', '', 'g'), 9) as suffix
    from m
   group by channel, number
)
select a.channel, a.number, a.last_at, a.last_in_at, a.inbound,
       (a.last_in_at is not null and a.last_in_at > coalesce(t.cleared_at, '-infinity')) as is_open,
       t.assigned_to, t.assigned_by, t.assigned_at,
       t.cleared_at, t.cleared_by, t.cleared_note,
       t.entity_id as set_entity_id,
       coalesce(t.entity_id, a.msg_entity_id,
                case when cardinality(c.ids) = 1 then c.ids[1] end) as entity_id,
       coalesce(c.ids, '{}') as candidate_entity_ids
  from agg a
  left join public.sms_threads t on t.channel = a.channel and t.number = a.number
  left join lateral (
    select array_agg(distinct x.id) as ids from (
      select ep.entity_id as id
        from public.people p
        join public.entity_people ep on ep.person_id = p.id and ep.ended_on is null
        join public.entities e on e.id = ep.entity_id and e.entity_status = 'active'
       where length(a.suffix) >= 7 and p.phone_suffix = a.suffix
      union
      select e.id
        from public.entities e
       where length(a.suffix) >= 7
         and e.entity_status in ('active', 'prospect')
         and e.prospect_phone is not null
         and right(regexp_replace(e.prospect_phone, '\D', '', 'g'), 9) = a.suffix
    ) x
  ) c on true;

revoke all on public.v_sms_threads from public, anon, authenticated;
grant select on public.v_sms_threads to authenticated, service_role;
