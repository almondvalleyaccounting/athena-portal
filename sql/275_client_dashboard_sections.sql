-- 275 — The client's dashboard gets the rest of the reports
--
-- sql/238 opened four sections to a client: overview, P&L, balance sheet,
-- underlying, projection. In practice the standard offer is wider than that —
-- a client should see their aged debtors and creditors, their KPIs and any
-- custom report we have built for them, because those are the pages they ask
-- us about on the phone. So four flags are added and the standard set is
-- switched on by default:
--
--   show_debtors   — who owes them, aged. Their own sales ledger.
--   show_creditors — who they owe, aged. Their own purchase ledger.
--   show_kpis      — the KPI pack for their sector, plus their own overrides.
--   show_reports   — custom reports built against their file.
--
-- show_balance changes its default from false to true for the same reason: a
-- balance sheet is a statement a director signs, not a confidence.
--
-- The two that stay OFF by default are unchanged, and for the reasons 238 gave:
-- `show_underlying` names which of the client's nominal codes we have classed
-- as the owner's personal spending, and `show_projection` shows a forecast,
-- which a client reads as a commitment. Neither should ever arrive by accident.
--
-- DEFAULTS DO NOT REACH EXISTING ROWS. A column default applies to inserts, so
-- the four new flags are also backfilled to true on the grants that already
-- exist — there is one, unviewed, and this is the standard offer rather than an
-- expansion of somebody's settled arrangement. Anything narrower than the
-- standard set is then a deliberate choice made on the access screen.

begin;

alter table client_dashboard_access
  add column if not exists show_debtors   boolean not null default true,
  add column if not exists show_creditors boolean not null default true,
  add column if not exists show_kpis      boolean not null default true,
  add column if not exists show_reports   boolean not null default true;

alter table client_dashboard_access
  alter column show_balance set default true;

comment on column client_dashboard_access.show_debtors is
  'Aged debtors — the client''s own sales ledger. On by default.';
comment on column client_dashboard_access.show_creditors is
  'Aged creditors — the client''s own purchase ledger. On by default.';
comment on column client_dashboard_access.show_kpis is
  'The KPI pack for their sector plus any client-specific overrides. On by default.';
comment on column client_dashboard_access.show_reports is
  'Custom reports built against their file. On by default; a report is only visible at all once someone publishes it to the client.';

-- Bring the grants that predate the wider offer up to it.
update client_dashboard_access
   set show_debtors = true, show_creditors = true,
       show_kpis = true, show_reports = true, show_balance = true
 where revoked_at is null;

/*
  A published-to-client flag on custom reports.

  A report existing is not the same as a report being ready to show a client:
  most of them start as a staff working paper. `show_reports` on the grant says
  the client may see custom reports at all; `is_client_visible` on the report
  says whether THIS one is finished enough to be seen. Both have to be true,
  and the default is false, so building a report never publishes it.
*/
alter table dashboard_report
  add column if not exists is_client_visible boolean not null default false;

comment on column dashboard_report.is_client_visible is
  'Whether this report may appear on the client''s own dashboard. Off by default — a report is a working paper until somebody decides otherwise.';

/* ── Client-side read ──────────────────────────────────────────
   Return type changes, so these are dropped and recreated rather than
   replaced. Recreating means the grants have to be restated: a fresh function
   is owned by postgres with PUBLIC holding EXECUTE, which is the opposite of
   what 238 left behind. */

drop function if exists portal_my_dashboards();
create function portal_my_dashboards()
returns table (
  entity_id       uuid,
  entity_name     text,
  show_overview   boolean,
  show_pl         boolean,
  show_balance    boolean,
  show_underlying boolean,
  show_projection boolean,
  show_debtors    boolean,
  show_creditors  boolean,
  show_kpis       boolean,
  show_reports    boolean,
  fiscal_year_start_month smallint
)
language sql
stable
security definer
set search_path = public
as $$
  select a.entity_id, e.name,
         a.show_overview, a.show_pl, a.show_balance, a.show_underlying, a.show_projection,
         a.show_debtors, a.show_creditors, a.show_kpis, a.show_reports,
         /*
           The client's fiscal year START month, resolved the way the edge
           function and the staff dashboard resolve it: the staff override and
           BrightManager (v_client_year_end) ahead of the QuickBooks setting.
           It travels with the grant because the portal's fiscal date presets
           need it BEFORE the first figures request, and asking the figures
           endpoint for it would mean the first request asked about the wrong
           twelve months. A year end is public record, and says nothing about
           anybody else.

           A SCALAR SUBQUERY, not a join. qbo_report_connections is not one
           active row per entity -- AATT Ltd has two, one linked automatically
           and one by hand -- and a join would have returned that caller's own
           grant twice, listing their company twice in the picker with no way
           to tell the entries apart. A subquery cannot fan out whatever the
           data does. The tie-break is arbitrary but deterministic, and it only
           decides which year end the DATE PRESETS use; it cannot decide whose
           figures come back, because portal-dashboard resolves the realm
           itself and refuses outright when the connection is ambiguous.
         */
         (
           select case
                    when coalesce(ye.month, c.fiscal_year_end_month) between 1 and 12
                      then ((coalesce(ye.month, c.fiscal_year_end_month) % 12) + 1)::smallint
                  end
           from qbo_report_connections c
           left join v_client_year_end ye on ye.realm_id = c.realm_id
           where c.entity_id = a.entity_id
             and c.status = 'active'
           order by c.entity_linked_at desc nulls last, c.connected_at desc nulls last
           limit 1
         )
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
  'Dashboards the signed-in portal user may see, with their section flags and the client fiscal year start month. Matches on the JWT email claim; returns nothing for staff, for anon, and for anyone without a live grant.';

revoke execute on function portal_my_dashboards() from public, anon;
grant execute on function portal_my_dashboards() to authenticated, service_role;

/*
  The audit exemption follows the definition.

  portal_my_dashboards is a definer function callable by `authenticated` with no
  named gate, which check E flags on sight and rightly so -- that shape is how a
  portal client reads practice data. It is gated by its own predicate instead:
  the caller's verified JWT email. The exemption is bound to a hash of the
  definition, so changing the function voids it and forces a re-review rather
  than letting the old judgement carry silently. This re-binds it having done
  that review; nothing about the gate regex is loosened.
*/
update security_audit_exemptions x
   set definition_md5 = md5(pg_get_functiondef(p.oid)),
       reason = 'Portal, self-scoped: returns only rows of client_dashboard_access whose email matches the caller''s own verified JWT email (unrevoked), and requires auth.uid(); anon holds no EXECUTE. Re-reviewed 2026-09-04 for sql/275, which added the four new section flags and the client fiscal year start month. The flags describe what the caller may already see. The year end is the caller''s own company''s, is public record at Companies House, and travels with the grant so the portal''s fiscal date presets resolve on the first request. realm_id is still deliberately NOT returned, and the year-end lookup is a scalar subquery so an entity with two active QuickBooks connections cannot fan the caller''s own row out.'
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.oid::regprocedure::text = x.signature
   and x.signature = 'portal_my_dashboards()';

/* ── Staff control panel ────────────────────────────────────── */

drop function if exists list_dashboard_access();
create function list_dashboard_access()
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
  show_debtors    boolean,
  show_creditors  boolean,
  show_kpis       boolean,
  show_reports    boolean,
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
         a.show_debtors, a.show_creditors, a.show_kpis, a.show_reports,
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
  grant_dashboard_access — the standard set is the default.

  An absent flag means "the standard offer", not "off", which is why every
  coalesce below carries the column default rather than false. A caller that
  wants a section withheld has to say so.
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
    show_overview, show_pl, show_balance, show_underlying, show_projection,
    show_debtors, show_creditors, show_kpis, show_reports
  )
  values (
    v_email, p_entity_id, auth.uid(), p_note,
    coalesce((p_flags ->> 'show_overview')::boolean, true),
    coalesce((p_flags ->> 'show_pl')::boolean, true),
    coalesce((p_flags ->> 'show_balance')::boolean, true),
    coalesce((p_flags ->> 'show_underlying')::boolean, false),
    coalesce((p_flags ->> 'show_projection')::boolean, false),
    coalesce((p_flags ->> 'show_debtors')::boolean, true),
    coalesce((p_flags ->> 'show_creditors')::boolean, true),
    coalesce((p_flags ->> 'show_kpis')::boolean, true),
    coalesce((p_flags ->> 'show_reports')::boolean, true)
  )
  on conflict (lower(email), entity_id) do update
    set show_overview   = excluded.show_overview,
        show_pl         = excluded.show_pl,
        show_balance    = excluded.show_balance,
        show_underlying = excluded.show_underlying,
        show_projection = excluded.show_projection,
        show_debtors    = excluded.show_debtors,
        show_creditors  = excluded.show_creditors,
        show_kpis       = excluded.show_kpis,
        show_reports    = excluded.show_reports,
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
  set_dashboard_access_flags — a coalesce to the CURRENT value, so a partial
  payload toggles one section without disturbing the rest.
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
    show_projection = coalesce((p_flags ->> 'show_projection')::boolean, show_projection),
    show_debtors    = coalesce((p_flags ->> 'show_debtors')::boolean, show_debtors),
    show_creditors  = coalesce((p_flags ->> 'show_creditors')::boolean, show_creditors),
    show_kpis       = coalesce((p_flags ->> 'show_kpis')::boolean, show_kpis),
    show_reports    = coalesce((p_flags ->> 'show_reports')::boolean, show_reports)
  where id = p_id;
end;
$$;

revoke execute on function set_dashboard_access_flags(uuid, jsonb) from public, anon;
grant execute on function set_dashboard_access_flags(uuid, jsonb) to authenticated, service_role;

/*
  kpi_definitions_for_entity — staff OR service, not staff only.

  This resolves "sector pack + bespoke - hidden", and it is the ONLY place that
  rule lives. The client portal now shows a client their own KPIs, and the
  portal-dashboard edge function is what fetches them, running as service_role.
  Under is_active_staff() that call returned zero rows, because a service_role
  JWT carries no sub and so has no staff profile -- which would have left the
  edge function re-implementing the resolution rule, and a second copy of that
  rule is how the client's KPI list and ours come to disagree.

  is_staff_or_service() is the helper for exactly this: staff, service_role and
  no-JWT callers (pg_cron, psql) pass; a client-portal user holding
  `authenticated` still does not. So this widens the function to our own server
  and to nothing that runs in a browser.
*/
create or replace function public.kpi_definitions_for_entity(p_entity_id uuid)
returns table (
  id uuid, key text, label text, kind text, unit text, decimals smallint,
  aggregation text, dimension_id uuid, dimension_key text, dimension_label text,
  formula text, hint text, show_on_overview boolean, sort_order integer, origin text
)
language sql
stable
security definer
set search_path = public
as $$
  select d.id,
         d.key,
         coalesce(o.label, d.label),
         d.kind, d.unit, d.decimals, d.aggregation,
         d.dimension_id, dim.key, dim.label,
         d.formula, d.hint,
         coalesce(o.show_on_overview, d.show_on_overview),
         coalesce(o.sort_order, d.sort_order),
         case when d.sector_id is not null then 'pack' else 'client' end
  from kpi_definition d
  left join kpi_dimension dim on dim.id = d.dimension_id
  left join kpi_client_override o
         on o.definition_id = d.id and o.entity_id = p_entity_id
  where is_staff_or_service()
    and d.is_active
    and coalesce(o.is_hidden, false) = false
    and (
      d.entity_id = p_entity_id
      or d.sector_id = (select e.kpi_sector_id from entities e where e.id = p_entity_id)
    )
  order by coalesce(o.sort_order, d.sort_order), coalesce(o.label, d.label);
$$;

revoke execute on function public.kpi_definitions_for_entity(uuid) from public, anon;
grant execute on function public.kpi_definitions_for_entity(uuid) to authenticated, service_role;

/*
  set_report_client_visible(report, visible)

  Publishing a custom report to a client, as its own named mutation.

  Two reasons it is not a browser table write. First the project's rule: a new
  mutating path is a function, not a `.from().update()`, because every one of
  those the browser holds is another thing 402 RLS policies have to get right.

  Second, and more concretely, the RLS on dashboard_report answers a DIFFERENT
  question from the one being asked here. `dashboard_report_write` gates on who
  owns the report -- a sector or practice-wide report needs can_manage_kpi_packs,
  because editing one changes what every client in that sector sees. But
  publishing is not editing: it decides whether a CLIENT may look, which is a
  portal-access decision and belongs to can_manage_portal, the same permission
  that gates every other "may this client see this" switch. Under the table
  policy, somebody who administers portal access could not publish a
  practice-wide report to their own client, and somebody who owns the report but
  administers no access could.

  Nothing here changes the report's content, so the pack permission is not
  needed and is not asked for.
*/
create or replace function public.set_report_client_visible(p_id uuid, p_visible boolean)
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
  if p_id is null then
    raise exception 'A report is required';
  end if;
  update dashboard_report
     set is_client_visible = coalesce(p_visible, false),
         updated_at = now()
   where id = p_id;
end;
$$;

comment on function public.set_report_client_visible is
  'Publish or unpublish one custom report to the client dashboard. Gated on can_manage_portal: this decides whether a CLIENT may see the report, which is an access decision, not a report-ownership one.';

revoke execute on function public.set_report_client_visible(uuid, boolean) from public, anon;
grant execute on function public.set_report_client_visible(uuid, boolean) to authenticated, service_role;

commit;
