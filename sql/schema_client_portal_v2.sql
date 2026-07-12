-- Client portal v2 — interactive workflow surface.
-- Applied as migrations client_portal_v2_interactive +
-- client_portal_v2_software_from_price (12/07/2026).
--
-- Supersedes the RPC definitions in schema_client_portal.sql (v1) and the
-- portal_register_document definition in schema_onboarding_documents.sql:
-- portal_my_onboarding, portal_step_reply and portal_register_document are
-- redefined here. New in v2:
--   portal_step_action(step, action, note) — done_claim / sent_elsewhere /
--     not_received; the first two flip the step to 'received'
--   portal_service_requests + portal_request_service — client asks for an
--     extra service, with an indicative from-price snapshot
--   portal_service_catalogue — client-safe "from" prices off quote_defaults
--   portal_notify_async — pg_net → portal-notify edge fn; every client
--     action emails the onboarding owner (sent_elsewhere / service_request
--     also email info@)
-- Related edge-fn behaviour (not in this file):
--   onboarding-emails kind=welcome now RELEASES client steps
--     (pending → waiting_client, requested_at=today)
--   onboarding-chase adds a "running late with us" digest section and a
--     one-shot service-condition heal for quotes linked after creation.

-- ── Service requests ─────────────────────────────────────────
create table if not exists portal_service_requests (
  id                 uuid primary key default gen_random_uuid(),
  entity_id          uuid not null references entities(id) on delete cascade,
  onboarding_id      uuid references onboardings(id) on delete set null,
  requested_by       uuid,
  requested_email    text,
  service_id         text not null,
  service_title      text,
  note               text,
  indicative_monthly numeric,
  indicative_annual  numeric,
  status             text not null default 'new' check (status in ('new','quoted','actioned','dismissed')),
  created_at         timestamptz not null default now()
);
comment on table portal_service_requests is 'Additional-service requests raised by clients from the portal. indicative_* is the from-price snapshot shown to the client at request time.';
create index if not exists idx_portal_service_requests_entity on portal_service_requests(entity_id);

alter table portal_service_requests enable row level security;
drop policy if exists portal_service_requests_staff on portal_service_requests;
create policy portal_service_requests_staff on portal_service_requests
  for all using (is_active_staff()) with check (is_active_staff());
drop policy if exists portal_service_requests_client_read on portal_service_requests;
create policy portal_service_requests_client_read on portal_service_requests
  for select using (entity_id in (select entity_id from entity_memberships where user_id = auth.uid()));

-- ── Async staff notification on client actions ───────────────
create or replace function portal_notify_async(p_kind text, p_activity_id uuid, p_request_id uuid default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  secret text;
begin
  select cron_secret into secret from onboarding_chase_config where id = true;
  if secret is not null then
    perform net.http_post(
      url := 'https://neksyvneljgxvpchwgch.supabase.co/functions/v1/portal-notify',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-cron-secret', secret
      ),
      body := jsonb_build_object('kind', p_kind, 'activity_id', p_activity_id, 'request_id', p_request_id)
    );
  end if;
exception when others then
  null; -- notification is best-effort
end;
$$;

-- ── Client step actions ──────────────────────────────────────
create or replace function portal_step_action(p_step_id uuid, p_action text, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v record;
  act_id uuid;
  body text;
  new_status text := null;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  if p_action not in ('done_claim','sent_elsewhere','not_received') then
    raise exception 'unknown action';
  end if;
  select o.id as onboarding_id, o.entity_id, s.status as step_status,
         coalesce(s.client_label, s.name) as label
    into v
    from onboarding_steps s
    join onboardings o on o.id = s.onboarding_id
   where s.id = p_step_id;
  if v is null or v.entity_id not in (select entity_id from entity_memberships where user_id = auth.uid()) then
    raise exception 'not authorised';
  end if;

  if p_action in ('done_claim','sent_elsewhere')
     and v.step_status in ('pending','waiting_client','blocked','waiting_external') then
    new_status := 'received';
    update onboarding_steps set status = 'received', updated_at = now() where id = p_step_id;
  end if;

  body := case p_action
    when 'done_claim' then 'Client marked as done — '
    when 'sent_elsewhere' then 'Client sent this another way — '
    else 'Client says this hasn''t arrived yet — '
  end || v.label
     || case when nullif(trim(coalesce(p_note,'')), '') is not null
             then ': ' || left(trim(p_note), 2000) else '' end;

  insert into onboarding_activity (onboarding_id, step_id, kind, body)
  values (v.onboarding_id, p_step_id, 'client_reply', body)
  returning id into act_id;

  -- client is responsive again — reset the escalation ladder
  update onboardings set escalation_status = 'none', paused_at = null
   where id = v.onboarding_id and escalation_status <> 'none';

  perform portal_notify_async(p_action, act_id);
  return jsonb_build_object('ok', true, 'new_status', new_status);
end;
$$;

-- ── Indicative service pricing (client-safe "from" prices) ───
create or replace function portal_service_catalogue()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'service_id', c.service_id,
    'from_monthly', c.from_monthly,
    'from_annual', c.from_annual,
    'unit', c.unit)), '[]'::jsonb)
  from quote_defaults qd,
  lateral (values
    ('accounts_ct',            round(((qd.rates->'accounts_bands'->0->>'rate')::numeric)/12, 0), (qd.rates->'accounts_bands'->0->>'rate')::numeric, null),
    ('confirmation_statement', null::numeric, (qd.rates->'confirmation_statement'->>'fee')::numeric + (qd.rates->'confirmation_statement'->>'ch_filing_fee')::numeric, null),
    ('directors_tax_return',   null::numeric, (qd.rates->>'director_base')::numeric, null),
    ('vat_returns',            round(((qd.rates->>'vat_per_return')::numeric)*4/12, 0), (qd.rates->>'vat_per_return')::numeric * 4, null),
    ('payroll',                (qd.rates->'payroll'->>'monthly_ee_rate')::numeric, null::numeric, 'per employee'),
    ('registered_office',      null::numeric, (qd.rates->>'registered_office')::numeric, null),
    ('management_accounts',    (qd.rates->>'management_accounts_per_set')::numeric, null::numeric, 'per set'),
    ('review_meetings',        (qd.rates->>'review_meeting_rate')::numeric, null::numeric, 'per meeting'),
    ('software_accounting',    (select min((s->>'monthly')::numeric) from jsonb_array_elements(qd.rates->'software') s
                                 where (s->>'monthly')::numeric > 0 and s->>'id' not in ('none','qb_ledger')), null::numeric, null),
    ('bookkeeping_vat',        null::numeric, null::numeric, null),
    ('auto_enrolment',         null::numeric, null::numeric, null),
    ('modulr',                 null::numeric, null::numeric, null)
  ) as c(service_id, from_monthly, from_annual, unit)
  where qd.is_current = true;
$$;

-- ── Request an additional service ────────────────────────────
create or replace function portal_request_service(p_entity_id uuid, p_service_id text, p_service_title text, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  uemail text := lower(coalesce(auth.jwt() ->> 'email', ''));
  ob_id uuid;
  req_id uuid;
  act_id uuid := null;
  price record;
begin
  if uid is null then
    raise exception 'not authenticated';
  end if;
  if p_entity_id not in (select entity_id from entity_memberships where user_id = uid) then
    raise exception 'not authorised';
  end if;
  if length(coalesce(p_service_id,'')) < 1 or length(p_service_id) > 80 then
    raise exception 'invalid service';
  end if;

  select (c->>'from_monthly')::numeric as m, (c->>'from_annual')::numeric as a
    into price
    from jsonb_array_elements(portal_service_catalogue()) c
   where c->>'service_id' = p_service_id;

  select o.id into ob_id
    from onboardings o
   where o.entity_id = p_entity_id and o.status in ('active','on_hold','issues')
   order by o.created_at desc limit 1;

  insert into portal_service_requests
    (entity_id, onboarding_id, requested_by, requested_email, service_id, service_title, note, indicative_monthly, indicative_annual)
  values
    (p_entity_id, ob_id, uid, uemail, p_service_id, left(coalesce(p_service_title, p_service_id), 120),
     nullif(left(trim(coalesce(p_note,'')), 2000), ''), price.m, price.a)
  returning id into req_id;

  if ob_id is not null then
    insert into onboarding_activity (onboarding_id, kind, body)
    values (ob_id, 'client_reply',
            'Service request — ' || left(coalesce(p_service_title, p_service_id), 120)
            || case when nullif(trim(coalesce(p_note,'')), '') is not null then ': ' || left(trim(p_note), 2000) else '' end)
    returning id into act_id;
  end if;

  perform portal_notify_async('service_request', act_id, req_id);
  return jsonb_build_object('ok', true, 'request_id', req_id);
end;
$$;

-- ── Reply + upload now notify staff ──────────────────────────
create or replace function portal_step_reply(p_step_id uuid, p_message text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v record;
  act_id uuid;
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
          'Client reply — ' || v.label || ': ' || left(coalesce(p_message, ''), 2000))
  returning id into act_id;
  update onboardings set escalation_status = 'none', paused_at = null
   where id = v.onboarding_id and escalation_status <> 'none';
  perform portal_notify_async('reply', act_id);
  return true;
end;
$$;

create or replace function portal_register_document(
  p_step_id uuid, p_path text, p_name text, p_mime text, p_size bigint)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v record;
  act_id uuid;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  select o.id as onboarding_id, o.entity_id, s.status as step_status,
         coalesce(s.client_label, s.name) as label
    into v
    from onboarding_steps s
    join onboardings o on o.id = s.onboarding_id
   where s.id = p_step_id;
  if v is null
     or v.entity_id not in (select entity_id from entity_memberships where user_id = auth.uid())
     or split_part(p_path, '/', 1) <> v.entity_id::text then
    raise exception 'not authorised';
  end if;

  insert into onboarding_documents
    (onboarding_id, step_id, entity_id, uploaded_by_kind, storage_path, original_name, mime_type, size_bytes)
  values (v.onboarding_id, p_step_id, v.entity_id, 'client', p_path, left(coalesce(p_name,'document'), 200), p_mime, p_size);

  if v.step_status in ('pending', 'waiting_client', 'blocked') then
    update onboarding_steps set status = 'received', updated_at = now() where id = p_step_id;
  end if;

  insert into onboarding_activity (onboarding_id, step_id, kind, body)
  values (v.onboarding_id, p_step_id, 'client_reply',
          'Document uploaded — ' || v.label || ': ' || left(coalesce(p_name,'document'), 200))
  returning id into act_id;
  update onboardings set escalation_status = 'none', paused_at = null
   where id = v.onboarding_id and escalation_status <> 'none';
  perform portal_notify_async('upload', act_id);
  return true;
end;
$$;

-- ── Client-safe onboarding read, v2 ──────────────────────────
-- Adds: quote block (sent/accepted/committed only), all client steps with
-- timeline fields + doc counts, behind-the-scenes groups restricted to OUR
-- work (owner_type <> 'client') and only once a group has actually started —
-- so irrelevant groups (e.g. CIS on a quote-less onboarding) never show.
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
        'services', case
          when o.quote_id is not null then (
            select coalesce(jsonb_agg(distinct li.service_id), '[]'::jsonb)
            from quote_line_items li
            where li.quote_id = o.quote_id
          )
          else (
            select coalesce(jsonb_agg(distinct svc->>'service_id'), '[]'::jsonb)
            from live_billing lb, jsonb_array_elements(lb.services) svc
            where lb.entity_id = o.entity_id and lb.status = 'active'
          )
        end,
        'quote', (
          select jsonb_build_object(
            'ref', q.quote_ref,
            'status', q.status,
            'monthly_gross', q.monthly_gross,
            'monthly_net', q.monthly_net,
            'monthly_vat', q.monthly_vat,
            'annual_total', q.annual_total,
            'one_off_total', q.one_off_total,
            'valid_until', q.valid_until,
            'accepted_at', q.accepted_at,
            'line_items', (
              select coalesce(jsonb_agg(jsonb_build_object(
                'service_id', li.service_id,
                'description', li.description,
                'detail', li.detail,
                'monthly_amount', li.monthly_amount,
                'annual_amount', li.annual_amount,
                'is_recurring', li.is_recurring)
                order by li.sort_order), '[]'::jsonb)
              from quote_line_items li where li.quote_id = q.id
            )
          )
          from quotes q
          where q.id = o.quote_id and q.status in ('sent','accepted','committed')
        ),
        'progress', (
          select jsonb_build_object(
            'done', count(*) filter (where s.status = 'complete'),
            'total', count(*))
          from onboarding_steps s
          where s.onboarding_id = o.id and s.status <> 'na'
        ),
        'groups', (
          select coalesce(jsonb_agg(jsonb_build_object(
            'name', gg.group_name, 'done', gg.done, 'total', gg.total,
            'waiting_external', gg.waiting_ext,
            'expected_days', gg.max_expected,
            'waiting_since', gg.min_requested)
            order by gg.group_sort), '[]'::jsonb)
          from (
            select s.group_name, min(s.group_sort) as group_sort,
                   count(*) filter (where s.status = 'complete') as done,
                   count(*) as total,
                   count(*) filter (where s.status = 'waiting_external') as waiting_ext,
                   max(s.expected_days) filter (where s.status = 'waiting_external') as max_expected,
                   min(s.requested_at) filter (where s.status = 'waiting_external') as min_requested,
                   bool_or(s.status <> 'pending') as started
            from onboarding_steps s
            where s.onboarding_id = o.id and s.status <> 'na' and s.owner_type <> 'client'
            group by s.group_name
          ) gg
          where gg.started
        ),
        'client_steps', (
          select coalesce(jsonb_agg(jsonb_build_object(
            'id', s.id,
            'label', coalesce(s.client_label, s.name),
            'status', s.status,
            'requested_at', s.requested_at,
            'expected_days', s.expected_days,
            'completed_at', s.completed_at,
            'documents', (select count(*) from onboarding_documents d where d.step_id = s.id))
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

-- ── Grants ───────────────────────────────────────────────────
revoke all on function portal_notify_async(text, uuid, uuid) from public, anon, authenticated;
revoke all on function portal_step_action(uuid, text, text) from public, anon;
revoke all on function portal_service_catalogue() from public, anon;
revoke all on function portal_request_service(uuid, text, text, text) from public, anon;
grant execute on function portal_step_action(uuid, text, text) to authenticated;
grant execute on function portal_service_catalogue() to authenticated;
grant execute on function portal_request_service(uuid, text, text, text) to authenticated;
