-- 141: Client Reminders auto-queue cron. Every 4 hours during January and
-- July, fill the reminder queue (opt-in invites for undecided clients,
-- reminders for opted-in unpaid clients) — QUEUE ONLY, a human releases.
-- Mirrors the CH-code queue-fill pattern (sql/103): a gated run_* function
-- posts to the edge function with an x-cron-secret. Dormant until the
-- `enabled` flag is turned on (from the Client Reminders page).

create table if not exists public.reminder_autoqueue_config (
  id          boolean primary key default true,
  enabled     boolean not null default false,
  comm_type   text not null default 'tax_reminders',
  cron_secret text not null default encode(gen_random_bytes(24), 'hex'),
  last_run_at timestamptz,
  constraint reminder_autoqueue_singleton check (id)
);
insert into public.reminder_autoqueue_config (id) values (true) on conflict (id) do nothing;

alter table public.reminder_autoqueue_config enable row level security;

-- No SELECT policy for authenticated → the cron_secret never reaches the
-- client. Managers may flip `enabled`; the edge function (service role)
-- bypasses RLS to read the secret.
drop policy if exists raqc_write on public.reminder_autoqueue_config;
create policy raqc_write on public.reminder_autoqueue_config
  for update
  using (exists (select 1 from public.staff_profiles p where p.id = auth.uid() and (p.can_manage_portal or p.is_portal_admin)))
  with check (exists (select 1 from public.staff_profiles p where p.id = auth.uid() and (p.can_manage_portal or p.is_portal_admin)));

-- Staff-safe view for the toggle UI (no cron_secret).
create or replace view public.v_reminder_autoqueue as
  select id, enabled, comm_type, last_run_at from public.reminder_autoqueue_config;
grant select on public.v_reminder_autoqueue to authenticated;

-- Cron entrypoint: gated post to the edge function.
create or replace function public.run_reminders_autoqueue()
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare cfg reminder_autoqueue_config%rowtype;
begin
  select * into cfg from reminder_autoqueue_config where id = true;
  if cfg is null or not cfg.enabled then
    return;
  end if;
  perform net.http_post(
    url := 'https://neksyvneljgxvpchwgch.supabase.co/functions/v1/reminders-autoqueue',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', cfg.cron_secret),
    body := jsonb_build_object('dry_run', false)
  );
end;
$function$;

-- Every 15 minutes during January and July only. cron.schedule upserts by
-- job name. The schedule is armed now but no-ops while disabled.
select cron.schedule('reminders-autoqueue', '*/15 * * 1,7 *', $$select public.run_reminders_autoqueue()$$);
