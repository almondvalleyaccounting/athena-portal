-- 195_journal_recon_cron.sql
--
-- Runs the BrightPay journal control check every month, after the payroll run.
--
-- Self-chunking, in the shape of ch-refresh-nightly: a starter fires on the
-- 12th, a continuation job picks up any unfinished run every 5 minutes for the
-- next few hours. Chunking matters — Intuit throttles per realm and edge
-- functions time out; ~70 realms takes about 3.5 minutes in 15-realm slices.
--
-- The check writes findings only. It sends no email, touches no client ledger,
-- and moves nothing in the payroll schema. A human reads the findings and
-- decides.

create or replace function public.run_journal_recon_chunk(p_start_new boolean default false)
returns bigint
language plpgsql
security definer
set search_path = public, extensions, net, vault
as $$
declare
  v_id   bigint;
  v_ws   date;
  v_we   date;
  v_done int;
begin
  select id, window_start, window_end, realms_checked + realms_error
    into v_id, v_ws, v_we, v_done
  from public.journal_recon_runs
  where finished_at is null
  order by id desc limit 1;

  if v_id is null then
    if not p_start_new then return null; end if;
    -- Trailing four complete months, ending at last month end. Wide enough to
    -- catch a late re-post of an earlier period, which is the failure mode
    -- actually observed (see below).
    v_ws := (date_trunc('month', current_date) - interval '4 months')::date;
    v_we := (date_trunc('month', current_date) - interval '1 day')::date;
    insert into public.journal_recon_runs (window_start, window_end, trigger)
    values (v_ws, v_we, 'cron')
    returning id into v_id;
    v_done := 0;
  end if;

  return public.run_journal_recon_batch(v_done, 15, v_id, v_ws, v_we, 'cron');
end;
$$;

revoke all on function public.run_journal_recon_chunk(boolean) from public, anon, authenticated;
grant execute on function public.run_journal_recon_chunk(boolean) to service_role;

select cron.schedule('journal-recon-monthly',  '0 6 12 * *',     $$select public.run_journal_recon_chunk(true)$$);
select cron.schedule('journal-recon-continue', '*/5 6-9 12 * *', $$select public.run_journal_recon_chunk(false)$$);

-- First run, 9 Aug 2026, window 2026-04-01..2026-07-31: 70 clients checked,
-- 0 errors, 180 findings in 3m32s. 17 duplicate postings across 10 clients
-- totalling £70,960.34, including one pair posted 83 minutes apart on the day
-- of the run itself.
