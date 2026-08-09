-- 196_journal_recon_digest.sql
--
-- Monthly review process for the payroll journal control check.
--
-- Schedule (all on the 10th):
--   06:00  journal-recon-monthly   start the sweep
--   06:05+ journal-recon-continue  every 5 min until it finishes (~4 min for ~70 clients)
--   10:00  journal-recon-digest    email duplicates + missing journals
--
-- The digest is silent when there is nothing to report. An empty email every
-- month teaches people to ignore it.

create table if not exists public.journal_recon_config (
  id            boolean primary key default true check (id),
  recipient_ids uuid[] not null default '{}',
  enabled       boolean not null default true,
  updated_at    timestamptz not null default now()
);

alter table public.journal_recon_config enable row level security;

drop policy if exists jrc_staff_read on public.journal_recon_config;
create policy jrc_staff_read on public.journal_recon_config for select
  to authenticated
  using (exists (select 1 from public.staff_profiles sp where sp.id = auth.uid() and sp.can_view_reports));

-- Recipients are staff IDS, not addresses: emails resolve from staff_profiles
-- at send time, so a changed address follows automatically and a deactivated
-- staff member drops out without an edit here.
insert into public.journal_recon_config (id, recipient_ids)
select true, array_agg(sp.id)
from public.staff_profiles sp
where sp.is_active
  and sp.email in (
    'bobby@almondvalleyaccounting.co.uk',
    'stephanie@almondvalleyaccounting.co.uk',
    'tracy@almondvalleyaccounting.co.uk'
  )
on conflict (id) do update set recipient_ids = excluded.recipient_ids, updated_at = now();

comment on table public.journal_recon_config is
  'Who gets the monthly journal control-check digest. Staff ids; addresses resolved from staff_profiles at send time.';

create or replace function public.run_journal_recon_digest()
returns bigint
language plpgsql
security definer
set search_path = public, extensions, net, vault
as $$
declare
  v_url text; v_service_key text; v_request_id bigint;
begin
  select decrypted_secret into v_url         from vault.decrypted_secrets where name = 'planning_project_url' limit 1;
  select decrypted_secret into v_service_key from vault.decrypted_secrets where name = 'planning_service_role_key' limit 1;
  if v_url is null or v_service_key is null then
    raise exception 'vault secrets not set';
  end if;

  select net.http_post(
    url := v_url || '/functions/v1/journal-recon-digest',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_service_key,
      'apikey', v_service_key
    ),
    body := jsonb_build_object('dry_run', false),
    timeout_milliseconds := 60000
  ) into v_request_id;

  return v_request_id;
end;
$$;

revoke all on function public.run_journal_recon_digest() from public, anon, authenticated;
grant execute on function public.run_journal_recon_digest() to service_role;

-- Move the sweep from the 12th to the 10th and add the digest.
select cron.unschedule('journal-recon-monthly');
select cron.unschedule('journal-recon-continue');
select cron.schedule('journal-recon-monthly',  '0 6 10 * *',     $$select public.run_journal_recon_chunk(true)$$);
select cron.schedule('journal-recon-continue', '*/5 6-9 10 * *', $$select public.run_journal_recon_chunk(false)$$);
select cron.schedule('journal-recon-digest',   '0 10 10 * *',    $$select public.run_journal_recon_digest()$$);
