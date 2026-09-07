-- 280 — "Send them the link": recording that we have told a client how to sign in.
--
-- Granting dashboard access has always been silent. grant_dashboard_access writes
-- the grant, writes the portal invite, and sends nothing — which is correct as a
-- default (a grant is not an announcement) but leaves a gap nobody can see: Marc
-- Kelly held a Puddleduck invite from 2026-08-19 and a full dashboard grant, and
-- had never signed in, because no one had told him the portal existed. Nothing on
-- the screen distinguished "invited and ignoring us" from "invited and never told".
--
-- The email itself belongs in an edge function (it needs the Resend key, and a
-- new mutating path is an edge function — CLAUDE.md). What belongs here is the
-- record of it, so the screen can answer "has anybody actually told them?" without
-- someone having to remember.
--
-- It hangs off client_portal_invites, not client_dashboard_access, because the
-- email is about signing in to the portal at all — the same link works for an
-- onboarding client with no dashboard grant, and PortalAccessPanel can use these
-- columns later without a second store.

begin;

alter table public.client_portal_invites
  add column if not exists link_sent_at    timestamptz,
  add column if not exists link_sent_count integer not null default 0,
  add column if not exists link_sent_by    uuid references public.staff_profiles(id);

comment on column public.client_portal_invites.link_sent_at is
  'When we last emailed this person their portal sign-in instructions (portal-send-link). Null means nobody has told them.';
comment on column public.client_portal_invites.link_sent_count is
  'How many times we have sent it. A second send is a chase, and reads differently from a first.';
comment on column public.client_portal_invites.link_sent_by is
  'Which staff member sent it. Taken from the verified caller in the edge function, never from the request body.';

-- Grants on this table are table-level (anon/authenticated/service_role each hold
-- SELECT/INSERT/UPDATE across every column), so the new columns inherit them and
-- need no grant of their own. Reachability is decided by RLS —
-- client_portal_invites_staff, USING is_active_staff() — which is why an anon
-- SELECT grant on this table returns nothing. Nothing here is a secret: a
-- timestamp, a count, and a staff id.

-- ── list_dashboard_access: carry link_sent_at through ─────────────────────────
-- The return type changes, so this is a drop + create, not a CREATE OR REPLACE.
-- Two consequences, both handled below:
--   1. A recreated function does NOT inherit the old ACL, and this schema's
--      default privileges hand EXECUTE to anon at creation. So the grants are
--      restated explicitly, matching what the function held before
--      (postgres=X authenticated=X service_role=X — no anon, no PUBLIC).
--   2. The internal authorisation check has to survive the copy. It does, verbatim:
--      is_active_staff() AND can_manage_portal. A definer function granted to
--      `authenticated` with no internal check is callable by a portal client.
drop function if exists public.list_dashboard_access();

create function public.list_dashboard_access()
returns table (
  id uuid,
  email text,
  entity_id uuid,
  entity_name text,
  realm_id text,
  company_name text,
  show_overview boolean,
  show_pl boolean,
  show_balance boolean,
  show_underlying boolean,
  show_projection boolean,
  show_debtors boolean,
  show_creditors boolean,
  show_kpis boolean,
  show_reports boolean,
  granted_at timestamptz,
  granted_by_name text,
  revoked_at timestamptz,
  last_viewed_at timestamptz,
  has_portal_login boolean,
  has_invite boolean,
  note text,
  link_sent_at timestamptz,
  link_sent_count integer
)
language sql
stable
security definer
set search_path to 'public'
as $function$
  select a.id, a.email, a.entity_id, e.name, c.realm_id, c.company_name,
         a.show_overview, a.show_pl, a.show_balance, a.show_underlying, a.show_projection,
         a.show_debtors, a.show_creditors, a.show_kpis, a.show_reports,
         a.granted_at, sp.name, a.revoked_at, a.last_viewed_at,
         exists (select 1 from users u where lower(u.email) = lower(a.email)),
         i.id is not null,
         a.note,
         i.link_sent_at,
         coalesce(i.link_sent_count, 0)
  from client_dashboard_access a
  join entities e on e.id = a.entity_id
  left join qbo_report_connections c on c.entity_id = a.entity_id and c.status = 'active'
  left join staff_profiles sp on sp.id = a.granted_by
  -- One row at most: idx_portal_invites_email_entity is unique on
  -- (lower(email), entity_id), so this cannot fan the result out.
  left join client_portal_invites i
         on lower(i.email) = lower(a.email) and i.entity_id = a.entity_id
  where is_active_staff()
    and coalesce((select x.can_manage_portal from staff_profiles x where x.id = auth.uid()), false)
  order by e.name, a.email;
$function$;

revoke all on function public.list_dashboard_access() from public;
revoke all on function public.list_dashboard_access() from anon;
grant execute on function public.list_dashboard_access() to authenticated, service_role;

commit;
