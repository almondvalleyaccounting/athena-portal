-- 110: Notifications spine + fold Bugs into Issues.
--
-- One personal notifications table, filled from two directions:
--   * event hooks (issue assigned, idea comment/reply, admin-task escalation,
--     chase replies) via notify_staff() from the app, or direct inserts from
--     service-role edge functions;
--   * a nightly sweep (notification-sweep edge fn) for stuck states —
--     accepted-uncommitted quotes, suggested billing lines, mandatory
--     training due — idempotent via (recipient_id, source_key).
-- The top-bar bell reads it; a daily INTERNAL digest email covers the last
-- 24h of unread. Staff-only — no client email is ever involved.

create table if not exists notifications (
  id uuid primary key default gen_random_uuid(),
  recipient_id uuid not null references staff_profiles(id) on delete cascade,
  kind text not null,
  title text not null,
  body text,
  link_path text,
  source_key text,          -- sweep idempotence; null for one-off events
  created_at timestamptz not null default now(),
  read_at timestamptz
);
create unique index if not exists notifications_dedupe
  on notifications (recipient_id, source_key) where source_key is not null;
create index if not exists notifications_recipient_unread
  on notifications (recipient_id, created_at desc) where read_at is null;

alter table notifications enable row level security;
drop policy if exists notifications_select_own on notifications;
create policy notifications_select_own on notifications
  for select using (recipient_id = auth.uid());
drop policy if exists notifications_update_own on notifications;
create policy notifications_update_own on notifications
  for update using (recipient_id = auth.uid());
-- No insert policy: writes go through notify_staff() or service role.

-- App-side event hook. Any active staff member can notify any other —
-- the guard is authentication, not hierarchy (assigning an issue is itself
-- unguarded). Dedupe key optional.
create or replace function public.notify_staff(
  p_recipient uuid, p_kind text, p_title text,
  p_body text default null, p_link text default null, p_source_key text default null
) returns void
language plpgsql security definer
set search_path to 'public'
as $function$
begin
  if not is_active_staff() then
    raise exception 'forbidden';
  end if;
  if p_recipient is null then return; end if;
  insert into notifications (recipient_id, kind, title, body, link_path, source_key)
  values (p_recipient, p_kind, p_title, p_body, p_link, p_source_key)
  on conflict (recipient_id, source_key) where source_key is not null do nothing;
end $function$;

-- Mark mine read: specific ids, or everything when null.
create or replace function public.mark_notifications_read(p_ids uuid[] default null)
returns void
language sql security definer
set search_path to 'public'
as $$
  update notifications set read_at = now()
  where recipient_id = auth.uid() and read_at is null
    and (p_ids is null or id = any(p_ids));
$$;

-- Config singleton for the sweep/digest cron.
create table if not exists notification_config (
  id boolean primary key default true check (id),
  sweep_enabled boolean not null default true,
  digest_enabled boolean not null default true,
  cron_secret uuid not null default gen_random_uuid(),
  updated_at timestamptz not null default now()
);
insert into notification_config (id) values (true) on conflict (id) do nothing;
alter table notification_config enable row level security;
drop policy if exists notification_config_admin on notification_config;
create policy notification_config_admin on notification_config
  for select using (is_portal_admin());

create or replace function public.run_notification_sweep()
returns void
language plpgsql security definer
set search_path to 'public'
as $function$
declare cfg notification_config%rowtype;
begin
  select * into cfg from notification_config where id = true;
  if cfg is null or not (cfg.sweep_enabled or cfg.digest_enabled) then
    return;
  end if;
  perform net.http_post(
    url := 'https://neksyvneljgxvpchwgch.supabase.co/functions/v1/notification-sweep',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', cfg.cron_secret::text),
    body := jsonb_build_object()
  );
end;
$function$;

select cron.schedule('notification-sweep', '30 6 * * 1-5', $$select run_notification_sweep()$$);

-- ── 5b: fold Bugs into Issues ──
-- bug_reports rows become issues (category Software); the table stays as
-- history but the app no longer reads or writes it. Status mapping:
-- open→open, in_progress→in_progress, closed→closed.
insert into issues_log (title, description, priority, category, status,
                        reported_by, reported_by_name, created_at, closed_at)
select
  case when length(coalesce(b.description, '')) > 140
       then left(b.description, 137) || '…' else coalesce(b.description, '(no description)') end,
  b.description,
  'medium', 'Software',
  case b.status when 'closed' then 'closed' when 'in_progress' then 'in_progress' else 'open' end,
  b.submitted_by, b.submitted_by_name, b.created_at,
  case when b.status = 'closed' then now() end
from bug_reports b;
