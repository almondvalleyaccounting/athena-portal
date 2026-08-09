-- 204_bookkeeping_drift_cron.sql
--
-- Runs the bookkeeping drift sweep every night, then advances the cases.
--
-- Slotted at 05:00 UTC, behind the traffic already on the QuickBooks
-- connections: ch-refresh-nightly runs 01:00–03:00, planning-qbo-nightly-pull
-- at 03:00, qbo-pull-nightly at 04:15. Intuit throttles per realm, and the
-- sweep is the only one of them that touches every client file.
--
-- Self-chunking in the shape of journal-recon: a starter opens the run, and a
-- continuation picks up whatever is unfinished every five minutes until the
-- estate is covered. 65 clients at 12 per invocation is about half an hour.
--
-- The tick runs afterwards and is idempotent, so a sweep that hasn't finished
-- simply means fewer cases move that morning — it never double-opens.
--
-- NOTE: the tick QUEUES nudges. It does not send them. Sending is gated on
-- bk_drift_settings.nudges_armed, which is false until Bobby has read the
-- queue and released it.

select cron.schedule('bk-drift-nightly',  '0 5 * * *',       $$select public.run_bk_drift_chunk(true)$$);
select cron.schedule('bk-drift-continue', '*/5 5-7 * * *',   $$select public.run_bk_drift_chunk(false)$$);

-- Open, escalate and close cases once the sweep has had time to land.
select cron.schedule('bk-drift-tick',     '30 7 * * *',      $$select public.bk_drift_tick()$$);

-- The baseline (13 months of transactions per client) is rebuilt inside the
-- sweep whenever it's more than 25 days old, so it doesn't need its own job —
-- it spreads itself naturally across the month.
