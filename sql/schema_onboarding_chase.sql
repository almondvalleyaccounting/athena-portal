-- Onboarding chaser engine v1 (applied as migration onboarding_chase_v1).
-- Client email chasers for waiting_client steps + internal owner digest for
-- overdue external waits / non-responsive clients. Mirrors the job-review
-- notify pattern: singleton config, sending disabled by default, pg_cron
-- self-gating wrapper, edge function (onboarding-chase) does the work.

alter table onboarding_steps add column if not exists last_chased_at date;
alter table onboarding_steps add column if not exists chase_count int not null default 0;

create table if not exists onboarding_chase_config (
  id boolean primary key default true check (id),
  sending_enabled boolean not null default false,
  first_chase_after_days int not null default 3,   -- fallback when step has no chase_after_days
  chase_every_days int not null default 3,         -- cadence after the first chase
  max_chases int not null default 3,               -- then flag non-responsive instead
  internal_digest_enabled boolean not null default true,
  cron_secret text not null default gen_random_uuid()::text,
  updated_at timestamptz not null default now()
);
comment on table onboarding_chase_config is 'Singleton config for onboarding chasers. sending_enabled=false blocks all real sends (test_recipient still allowed for end-to-end testing).';

insert into onboarding_chase_config (id) values (true) on conflict do nothing;

alter table onboarding_chase_config enable row level security;
drop policy if exists onboarding_chase_config_read on onboarding_chase_config;
create policy onboarding_chase_config_read on onboarding_chase_config for select using (is_active_staff());
drop policy if exists onboarding_chase_config_write on onboarding_chase_config;
create policy onboarding_chase_config_write on onboarding_chase_config for update using (is_active_staff()) with check (is_active_staff());

-- Self-gating cron wrapper: safe to schedule daily; does nothing until
-- sending_enabled is flipped on.
create or replace function run_onboarding_chase()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  cfg onboarding_chase_config%rowtype;
begin
  select * into cfg from onboarding_chase_config where id = true;
  if cfg is null or not cfg.sending_enabled then
    return;
  end if;
  perform net.http_post(
    url := 'https://neksyvneljgxvpchwgch.supabase.co/functions/v1/onboarding-chase',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', cfg.cron_secret
    ),
    body := jsonb_build_object('dry_run', false)
  );
end;
$$;

-- DISARMED: schedule manually once tested, e.g.
--   select cron.schedule('onboarding-chase', '0 8 * * 1-5', $$select run_onboarding_chase()$$);
-- (weekdays 08:00; the wrapper no-ops while sending_enabled = false anyway)
