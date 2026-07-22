-- 158: Weekly Friday bug-review digest.
--
-- Every Friday afternoon, compile the week's bug picture and drop a
-- notification (via the notifications spine, sql/110) to each triager so the
-- review session has a ready agenda: N new to triage, the accepted this-week
-- queue, fixes awaiting verification, and any needs-info going stale.
--
-- Deliberately NOT a cloud agent (no DB access there) and NOT the Work triage
-- board (that's client work). Purely internal — no client email is involved.
-- Self-gates: if there's nothing worth reviewing, it stays quiet.

create extension if not exists pg_cron;

-- Lightweight on/off switch, portal-admin managed.
create table if not exists public.bug_review_config (
  id          boolean primary key default true,
  enabled     boolean not null default true,
  last_run_at timestamptz,
  constraint bug_review_singleton check (id)
);
insert into public.bug_review_config (id) values (true) on conflict (id) do nothing;

alter table public.bug_review_config enable row level security;
drop policy if exists brc_write on public.bug_review_config;
create policy brc_write on public.bug_review_config
  for update
  using (exists (select 1 from public.staff_profiles p where p.id = auth.uid() and (p.can_manage_portal or p.is_portal_admin)))
  with check (exists (select 1 from public.staff_profiles p where p.id = auth.uid() and (p.can_manage_portal or p.is_portal_admin)));

create or replace view public.v_bug_review_config as
  select id, enabled, last_run_at from public.bug_review_config;
grant select on public.v_bug_review_config to authenticated;

-- The digest builder. Security definer so the cron (auth.uid() null) can read
-- bugs + write notifications, bypassing RLS. Idempotent per ISO week via
-- source_key, so a re-run refreshes rather than duplicates.
create or replace function public.run_bug_review_digest()
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_enabled boolean;
  v_new int; v_week int; v_verify int; v_stale int;
  v_week_key text := to_char(now(), 'IYYY"W"IW');
  v_title text; v_body text;
  r record;
begin
  select enabled into v_enabled from bug_review_config where id;
  if not coalesce(v_enabled, false) then return; end if;

  select
    count(*) filter (where status = 'new'),
    count(*) filter (where status in ('accepted','in_progress') and target = 'this_week'),
    count(*) filter (where status = 'fixed'),
    count(*) filter (where status = 'needs_info' and triaged_at < now() - interval '7 days')
  into v_new, v_week, v_verify, v_stale
  from bugs;

  -- Nothing worth a Friday ping.
  if v_new = 0 and v_week = 0 and v_verify = 0 then
    update bug_review_config set last_run_at = now() where id;
    return;
  end if;

  v_title := 'Weekly bug review: ' || v_new || ' new, ' || v_week || ' queued for this week';
  v_body  := v_new || ' new to triage · ' || v_week || ' accepted for this week · '
             || v_verify || ' fixed awaiting verify'
             || case when v_stale > 0 then ' · ' || v_stale || ' needs-info going stale' else '' end;

  for r in select id from staff_profiles where is_active and can_triage_bugs loop
    insert into notifications (recipient_id, kind, title, body, link_path, source_key)
    values (r.id, 'bug_review', v_title, v_body, '/bugs', 'bug_review_' || v_week_key)
    on conflict (recipient_id, source_key) where source_key is not null
      do update set title = excluded.title, body = excluded.body,
                    created_at = now(), read_at = null;
  end loop;

  update bug_review_config set last_run_at = now() where id;
end;
$$;

-- Arm it: Fridays 13:00 UTC (~14:00 London BST / 13:00 GMT). Internal-only, so
-- armed live rather than left disarmed. cron.schedule upserts by job name.
select cron.schedule('bug-review-digest', '0 13 * * 5', $$select public.run_bug_review_digest()$$);
