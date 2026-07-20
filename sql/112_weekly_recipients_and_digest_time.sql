-- 112: onboarding weekly recipient list + notification digest at 08:30.
--
-- 1. The onboarding weekly emails ("what moved last week" + "needs
--    attention") previously went to ALL active staff. Now configurable via
--    onboarding_chase_config.weekly_recipient_ids (same pattern as
--    ch_code_chase_config) — seeded Bobby, Tracy, Stephanie; empty array
--    falls back to all active staff.
-- 2. notification-sweep cron moves 06:30 → 07:30 UTC so the daily digest
--    lands 08:30 UK in summer (07:30 in winter — house convention: honour
--    the literal time Bobby asked for in the current season).

alter table onboarding_chase_config
  add column if not exists weekly_recipient_ids uuid[] not null default '{}';

update onboarding_chase_config
   set weekly_recipient_ids = (
     select coalesce(array_agg(id), '{}')
     from staff_profiles
     where name in ('Bobby Gallacher', 'Tracy Mitchell', 'Stephanie Campbell')
       and is_active = true
   )
 where id = true;

select cron.schedule('notification-sweep', '30 7 * * 1-5', $$select run_notification_sweep()$$);
