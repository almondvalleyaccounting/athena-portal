-- 238 — Client-portal access to the Client Dashboard
--
-- Until now the portal showed onboarding progress and nothing financial. This
-- opens a second surface: a client can be given their own dashboard — the same
-- QuickBooks figures staff read, on the same arithmetic.
--
-- ACCESS MODEL. A grant is (email, entity), not (user, entity), for the same
-- reason client_portal_invites is: access is usually given before the person has
-- ever signed in, and a user row only exists after their first sign-in. The
-- portal RPC matches on the JWT's verified email claim.
--
-- Granting is deliberately narrow and deliberately explicit:
--   • It is NOT implied by entity_memberships. A client who can see their
--     onboarding steps does not thereby get their P&L. Somebody has to decide.
--   • Each section is a separate flag. Overview is the default; the balance
--     sheet, the underlying (owner-costs-removed) view and the projection are
--     each off unless switched on. A forecast shown to a client is a commitment,
--     so it never appears by accident.
--   • One row per (email, entity). Marc Kelly holding a grant on Puddleduck
--     gives him Puddleduck and nothing else — there is no "all my clients"
--     shape in this table, by design.
--
-- Nothing here reads QuickBooks. The portal-dashboard edge function resolves the
-- realm and does the pulling; this table is only the question "may they?".

begin;

create table if not exists client_dashboard_access (
  id              uuid primary key default gen_random_uuid(),
  email           text not null,
  entity_id       uuid not null references entities(id) on delete cascade,

  -- Sections. Overview is the point of the thing; the rest are opt-in.
  show_overview   boolean not null default true,
  show_pl         boolean not null default true,
  show_balance    boolean not null default false,
  show_underlying boolean not null default false,
  show_projection boolean not null default false,

  granted_by      uuid references staff_profiles(id),
  granted_at      timestamptz not null default now(),
  revoked_at      timestamptz,
  last_viewed_at  timestamptz,
  note            text
);
comment on table client_dashboard_access is
  'Which client-portal logins may see which client dashboard, and which sections. Keyed on email so access can be granted before the person has ever signed in. Never implied by entity_memberships — always an explicit decision.';
comment on column client_dashboard_access.show_underlying is
  'The owner-costs-removed view. Off by default: it exposes which nominal codes we have classed as the owner''s personal spending.';
comment on column client_dashboard_access.show_projection is
  'The linked forecast scenario. Off by default: a forecast a client can see is a commitment.';

create unique index if not exists idx_cda_email_entity
  on client_dashboard_access (lower(email), entity_id);
create index if not exists idx_cda_entity on client_dashboard_access (entity_id);

-- ── RLS ──────────────────────────────────────────────────────
-- Staff with can_manage_portal administer it. Clients NEVER read this table
-- directly — portal_my_dashboards() is the only door, and it filters to the
-- caller's own verified email.
alter table client_dashboard_access enable row level security;

drop policy if exists client_dashboard_access_admin on client_dashboard_access;
create policy client_dashboard_access_admin on client_dashboard_access
  for all
  using (
    is_active_staff()
    and coalesce((select sp.can_manage_portal from staff_profiles sp where sp.id = auth.uid()), false)
  )
  with check (
    is_active_staff()
    and coalesce((select sp.can_manage_portal from staff_profiles sp where sp.id = auth.uid()), false)
  );

-- ── Client-side read ─────────────────────────────────────────
-- The portal calls this on load to learn which dashboards it may show and which
-- sections to render. It deliberately does NOT return realm_id: the client has
-- no business holding a QuickBooks company id, and the edge function resolves it
-- server-side from the grant anyway.
create or replace function portal_my_dashboards()
returns table (
  entity_id       uuid,
  entity_name     text,
  show_overview   boolean,
  show_pl         boolean,
  show_balance    boolean,
  show_underlying boolean,
  show_projection boolean
)
language sql
stable
security definer
set search_path = public
as $$
  select a.entity_id, e.name,
         a.show_overview, a.show_pl, a.show_balance, a.show_underlying, a.show_projection
  from client_dashboard_access a
  join entities e on e.id = a.entity_id
  where a.revoked_at is null
    and auth.uid() is not null
    and lower(a.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
    -- An empty email claim must never match an empty stored email.
    and coalesce(auth.jwt() ->> 'email', '') <> ''
  order by e.name;
$$;
comment on function portal_my_dashboards is
  'Dashboards the signed-in portal user may see, with their section flags. Matches on the JWT email claim; returns nothing for staff, for anon, and for anyone without a live grant.';

revoke execute on function portal_my_dashboards() from public, anon;
grant execute on function portal_my_dashboards() to authenticated, service_role;

-- ── Staff control panel ──────────────────────────────────────
create or replace function list_dashboard_access()
returns table (
  id              uuid,
  email           text,
  entity_id       uuid,
  entity_name     text,
  realm_id        text,
  company_name    text,
  show_overview   boolean,
  show_pl         boolean,
  show_balance    boolean,
  show_underlying boolean,
  show_projection boolean,
  granted_at      timestamptz,
  granted_by_name text,
  revoked_at      timestamptz,
  last_viewed_at  timestamptz,
  has_portal_login boolean,
  has_invite      boolean,
  note            text
)
language sql
stable
security definer
set search_path = public
as $$
  select a.id, a.email, a.entity_id, e.name, c.realm_id, c.company_name,
         a.show_overview, a.show_pl, a.show_balance, a.show_underlying, a.show_projection,
         a.granted_at, sp.name, a.revoked_at, a.last_viewed_at,
         exists (select 1 from users u where lower(u.email) = lower(a.email)),
         exists (select 1 from client_portal_invites i
                 where lower(i.email) = lower(a.email) and i.entity_id = a.entity_id),
         a.note
  from client_dashboard_access a
  join entities e on e.id = a.entity_id
  left join qbo_report_connections c on c.entity_id = a.entity_id and c.status = 'active'
  left join staff_profiles sp on sp.id = a.granted_by
  where is_active_staff()
    and coalesce((select x.can_manage_portal from staff_profiles x where x.id = auth.uid()), false)
  order by e.name, a.email;
$$;

revoke execute on function list_dashboard_access() from public, anon;
grant execute on function list_dashboard_access() to authenticated, service_role;

/*
  grant_dashboard_access(email, entity, flags)

  Also issues a portal invite if the person has none for that entity. Dashboard
  access without a way to sign in is a grant that does nothing, and having to
  remember two screens is how people end up "granted" but locked out.
*/
create or replace function grant_dashboard_access(
  p_email     text,
  p_entity_id uuid,
  p_flags     jsonb default '{}'::jsonb,
  p_note      text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text := lower(trim(coalesce(p_email, '')));
  v_id uuid;
  b boolean;
begin
  if not (is_active_staff()
          and coalesce((select can_manage_portal from staff_profiles where id = auth.uid()), false)) then
    raise exception 'Not authorised' using errcode = '42501';
  end if;
  if v_email = '' or v_email not like '%@%' then
    raise exception 'A valid email is required';
  end if;
  if p_entity_id is null then
    raise exception 'A client is required';
  end if;

  insert into client_dashboard_access (
    email, entity_id, granted_by, note,
    show_overview, show_pl, show_balance, show_underlying, show_projection
  )
  values (
    v_email, p_entity_id, auth.uid(), p_note,
    coalesce((p_flags ->> 'show_overview')::boolean, true),
    coalesce((p_flags ->> 'show_pl')::boolean, true),
    coalesce((p_flags ->> 'show_balance')::boolean, false),
    coalesce((p_flags ->> 'show_underlying')::boolean, false),
    coalesce((p_flags ->> 'show_projection')::boolean, false)
  )
  on conflict (lower(email), entity_id) do update
    set show_overview   = excluded.show_overview,
        show_pl         = excluded.show_pl,
        show_balance    = excluded.show_balance,
        show_underlying = excluded.show_underlying,
        show_projection = excluded.show_projection,
        note            = coalesce(excluded.note, client_dashboard_access.note),
        revoked_at      = null,
        granted_by      = auth.uid(),
        granted_at      = now()
  returning id into v_id;

  -- Give them a way in, if they haven't one already.
  insert into client_portal_invites (email, entity_id, invited_by)
  values (v_email, p_entity_id, auth.uid())
  on conflict do nothing;

  return v_id;
end;
$$;

revoke execute on function grant_dashboard_access(text, uuid, jsonb, text) from public, anon;
grant execute on function grant_dashboard_access(text, uuid, jsonb, text) to authenticated, service_role;

/*
  set_dashboard_access_flags / revoke_dashboard_access

  Revoke is a soft revoke — the row stays with revoked_at set, so "who could see
  what, when" is answerable later. The portal RPC filters on revoked_at is null,
  so the effect is immediate. p_hard deletes it outright for a grant made in
  error that should never have existed.
*/
create or replace function set_dashboard_access_flags(p_id uuid, p_flags jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not (is_active_staff()
          and coalesce((select can_manage_portal from staff_profiles where id = auth.uid()), false)) then
    raise exception 'Not authorised' using errcode = '42501';
  end if;
  update client_dashboard_access set
    show_overview   = coalesce((p_flags ->> 'show_overview')::boolean, show_overview),
    show_pl         = coalesce((p_flags ->> 'show_pl')::boolean, show_pl),
    show_balance    = coalesce((p_flags ->> 'show_balance')::boolean, show_balance),
    show_underlying = coalesce((p_flags ->> 'show_underlying')::boolean, show_underlying),
    show_projection = coalesce((p_flags ->> 'show_projection')::boolean, show_projection)
  where id = p_id;
end;
$$;

revoke execute on function set_dashboard_access_flags(uuid, jsonb) from public, anon;
grant execute on function set_dashboard_access_flags(uuid, jsonb) to authenticated, service_role;

create or replace function revoke_dashboard_access(p_id uuid, p_hard boolean default false)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not (is_active_staff()
          and coalesce((select can_manage_portal from staff_profiles where id = auth.uid()), false)) then
    raise exception 'Not authorised' using errcode = '42501';
  end if;
  if p_hard then
    delete from client_dashboard_access where id = p_id;
  else
    update client_dashboard_access set revoked_at = now() where id = p_id;
  end if;
end;
$$;

revoke execute on function revoke_dashboard_access(uuid, boolean) from public, anon;
grant execute on function revoke_dashboard_access(uuid, boolean) to authenticated, service_role;

-- Clients the control panel can offer: those with a live QuickBooks connection,
-- excluding the practice's own books.
create or replace function dashboard_grantable_clients()
returns table (entity_id uuid, entity_name text, realm_id text, company_name text)
language sql
stable
security definer
set search_path = public
as $$
  select e.id, e.name, c.realm_id, c.company_name
  from qbo_report_connections c
  join entities e on e.id = c.entity_id
  where c.status = 'active'
    and not coalesce(c.is_practice, false)
    and is_active_staff()
    and coalesce((select sp.can_manage_portal from staff_profiles sp where sp.id = auth.uid()), false)
  order by e.name;
$$;

revoke execute on function dashboard_grantable_clients() from public, anon;
grant execute on function dashboard_grantable_clients() to authenticated, service_role;

commit;
