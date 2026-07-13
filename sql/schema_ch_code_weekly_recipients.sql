-- ============================================================
-- CH personal-code weekly digest — targeted recipients + schedule.
--
-- The ch-code-weekly edge function ("what moved last week + what's coming")
-- previously emailed ALL active staff. Bobby wants it to go to just him and
-- Tracy. weekly_recipient_ids drives that (resolved to emails from
-- staff_profiles in the edge fn); empty = fall back to all active staff.
-- ============================================================

alter table ch_code_chase_config add column if not exists weekly_recipient_ids uuid[];

-- Seed = Bobby + Tracy (resolved by name so no hardcoded ids), and make sure
-- the weekly is enabled.
update ch_code_chase_config
   set weekly_recipient_ids = (
         select array_agg(id) from staff_profiles
          where name in ('Bobby Gallacher','Tracy Mitchell') and is_active
       ),
       weekly_enabled = true
 where id = true;

-- Schedule: Monday 09:00 UTC = 10:00 UK (BST). Drifts to 09:00 UK in winter,
-- same convention as onboarding-weekly. run_ch_code_weekly() self-gates on
-- weekly_enabled, so this is safe to leave scheduled.
-- SCHEDULED LIVE 13/07/2026 (cron jobid 6):
select cron.schedule('ch-code-weekly', '0 9 * * 1', $$select run_ch_code_weekly()$$);
