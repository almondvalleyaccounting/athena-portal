-- 276: the whole-team deadline digest moves to midday, and Bobby gets a
--      third "update Athena" nudge at 08:00 on the Monday morning.
--
-- Why: the digest was landing at 08:30, before the week's BrightManager export
-- had been imported, so the team read Friday's picture of what was due. Moving
-- it to 12:00 gives the morning to get Athena current; the 08:00 reminder is
-- the last call before it sends.
--
-- The Monday reminder is a third `moment` on the same athena-reminder edge
-- function (moment=monday), which now carries its own subject and lead. That
-- function must be deployed before this cron fires, or the email falls back to
-- the generic wording — it will not fail.
--
-- Times are UTC, which is BST-1 in the current season. House convention (see
-- sql/112) is to honour the literal time asked for now and accept the winter
-- drift: from late October these land at 11:00 and 07:00 UK.

-- 1. Digest 07:30 → 11:00 UTC (12:00 BST). Same job name, so this replaces
--    the schedule rather than adding a second send.
select cron.schedule('deadline-digest', '0 11 * * 1', $$select run_deadline_digest()$$);

-- 2. Monday 07:00 UTC (08:00 BST) reminder to Bobby.
select cron.schedule('athena-reminder-mon', '0 7 * * 1', $$select run_athena_reminder('monday')$$);

-- 3. /admin/schedules describes each job in words, so the words have to move too.
update public.scheduled_job_docs
   set mechanism = 'Automatic, Mondays at 11:00 UTC (12:00 UK in summer). pg_cron calls the deadline-digest edge function; recipients come from deadline_digest_config.recipient_ids (all 10 staff).',
       purpose   = 'The Monday midday email to the whole team: Companies House accounts deadlines and self-assessment run-rate, with what is due and what is slipping. It sends at midday, not first thing, so the morning''s BrightManager import is in it.',
       updated_at = now()
 where job_key = 'deadline-digest';

insert into public.scheduled_job_docs
  (job_key, source, title, category, purpose, data_source, mechanism, run_as, gate_label, sort_order)
values
  ('athena-reminder-mon', 'pg_cron',
   'Athena reminder (Monday)',
   'Internal digests & alerts',
   'Monday morning version of the personal nudge — the last call to import the latest BrightManager export before the team''s deadline digest goes out at midday. Goes to Bobby only.',
   'Open items across Athena.',
   'Automatic, Mondays at 07:00 UTC (08:00 UK in summer). pg_cron calls the athena-reminder edge function with moment=monday.',
   'System — single recipient.',
   null, 37)
on conflict (job_key) do update
  set title      = excluded.title,
      category   = excluded.category,
      purpose    = excluded.purpose,
      mechanism  = excluded.mechanism,
      run_as     = excluded.run_as,
      sort_order = excluded.sort_order,
      updated_at = now();
