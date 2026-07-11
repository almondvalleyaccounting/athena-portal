-- Client portal v1 — onboarding surface (applied as migration client_portal_onboarding_v1).
-- Separate client-only app: https://athena-client-portal.vercel.app
-- (repo C:\Users\bobby\athena-client-portal, deploys via Vercel CLI).
--
-- Access model: staff invite a client email against an entity
-- (client_portal_invites, managed from the onboarding detail screen).
-- The client signs in with a magic link / one-time code; on first sign-in
-- portal_claim_invites() creates their public.users row and
-- entity_memberships link. All portal reads go through SECURITY DEFINER
-- RPCs that expose ONLY client-safe fields (client_label wording, progress
-- counts, group tallies) — never internal notes, staff names or staff steps.

create table if not exists client_portal_invites (
  id              uuid primary key default gen_random_uuid(),
  email           text not null,
  entity_id       uuid not null references entities(id) on delete cascade,
  invited_by      uuid references staff_profiles(id),
  created_at      timestamptz not null default now(),
  claimed_at      timestamptz,
  claimed_user_id uuid
);
comment on table client_portal_invites is 'Staff-issued portal invites. Claimed automatically when a user signs in with a matching email.';
create unique index if not exists idx_portal_invites_email_entity on client_portal_invites (lower(email), entity_id);

alter table client_portal_invites enable row level security;
drop policy if exists client_portal_invites_staff on client_portal_invites;
create policy client_portal_invites_staff on client_portal_invites for all using (is_active_staff()) with check (is_active_staff());

-- Staff can see portal users/memberships (for the access panel in Athena)
drop policy if exists entity_memberships_staff_read on entity_memberships;
create policy entity_memberships_staff_read on entity_memberships for select using (is_active_staff());
drop policy if exists users_staff_read on users;
create policy users_staff_read on users for select using (is_active_staff());

-- ── Claim invites on sign-in ─────────────────────────────────
create or replace function portal_claim_invites()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  uemail text := lower(coalesce(auth.jwt() ->> 'email', ''));
  inv record;
  n int := 0;
begin
  if uid is null or uemail = '' then
    return 0;
  end if;
  insert into users (id, email) values (uid, uemail)
  on conflict (id) do nothing;
  for inv in
    select * from client_portal_invites
    where lower(email) = uemail and claimed_at is null
  loop
    insert into entity_memberships (user_id, entity_id, role)
    values (uid, inv.entity_id, 'authorised')
    on conflict (user_id, entity_id) do nothing;
    update client_portal_invites
       set claimed_at = now(), claimed_user_id = uid
     where id = inv.id;
    n := n + 1;
  end loop;
  return n;
end;
$$;

-- ── Client-safe onboarding read ──────────────────────────────
create or replace function portal_my_onboarding()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'entity_id', e.id,
    'entity_name', e.name,
    'onboardings', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', o.id,
        'status', o.status,
        'started_at', o.started_at,
        'progress', (
          select jsonb_build_object(
            'done', count(*) filter (where s.status = 'complete'),
            'total', count(*))
          from onboarding_steps s
          where s.onboarding_id = o.id and s.status <> 'na'
        ),
        'groups', (
          select coalesce(jsonb_agg(jsonb_build_object(
            'name', gg.group_name, 'done', gg.done, 'total', gg.total)
            order by gg.group_sort), '[]'::jsonb)
          from (
            select s.group_name, min(s.group_sort) as group_sort,
                   count(*) filter (where s.status = 'complete') as done,
                   count(*) as total
            from onboarding_steps s
            where s.onboarding_id = o.id and s.status <> 'na'
            group by s.group_name
          ) gg
        ),
        'client_steps', (
          select coalesce(jsonb_agg(jsonb_build_object(
            'id', s.id,
            'label', coalesce(s.client_label, s.name),
            'status', s.status,
            'requested_at', s.requested_at,
            'completed_at', s.completed_at)
            order by s.group_sort, s.sort), '[]'::jsonb)
          from onboarding_steps s
          where s.onboarding_id = o.id
            and s.owner_type = 'client'
            and s.status <> 'na'
        )
      ) order by o.created_at desc), '[]'::jsonb)
      from onboardings o
      where o.entity_id = e.id
        and o.status in ('active', 'on_hold', 'issues', 'complete')
    )
  )), '[]'::jsonb)
  from entities e
  where e.id in (select entity_id from entity_memberships where user_id = auth.uid());
$$;

-- ── Client reply on a step ───────────────────────────────────
create or replace function portal_step_reply(p_step_id uuid, p_message text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v record;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  select o.id as onboarding_id, o.entity_id, coalesce(s.client_label, s.name) as label
    into v
    from onboarding_steps s
    join onboardings o on o.id = s.onboarding_id
   where s.id = p_step_id;
  if v is null or v.entity_id not in (select entity_id from entity_memberships where user_id = auth.uid()) then
    raise exception 'not authorised';
  end if;
  insert into onboarding_activity (onboarding_id, step_id, kind, body)
  values (v.onboarding_id, p_step_id, 'client_reply',
          'Client reply — ' || v.label || ': ' || left(coalesce(p_message, ''), 2000));
  return true;
end;
$$;

revoke all on function portal_claim_invites() from public, anon;
revoke all on function portal_my_onboarding() from public, anon;
revoke all on function portal_step_reply(uuid, text) from public, anon;
grant execute on function portal_claim_invites() to authenticated;
grant execute on function portal_my_onboarding() to authenticated;
grant execute on function portal_step_reply(uuid, text) to authenticated;
