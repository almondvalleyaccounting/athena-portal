-- 200_bookkeeping_drift_invokers.sql
--
-- SQL entry points for qbo-drift-sweep, in the shape of 194.
--
-- Via pg_net + a Vault-held service-role JWT, because the function keeps
-- verify_jwt=true and no new secret should be introduced to run it. Same
-- pattern as run_journal_recon_batch.

create or replace function public.run_bk_drift_probe(p_realm_id text, p_skip_baseline boolean default false)
returns bigint
language plpgsql security definer
set search_path = public, extensions, net, vault
as $$
declare v_url text; v_key text; v_req bigint;
begin
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'planning_project_url' limit 1;
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'planning_service_role_key' limit 1;
  if v_url is null or v_key is null then raise exception 'vault secrets not set'; end if;

  select net.http_post(
    url := v_url || '/functions/v1/qbo-drift-sweep',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||v_key,'apikey',v_key),
    body := jsonb_build_object('mode','probe','realm_id',p_realm_id,'skip_baseline',p_skip_baseline),
    timeout_milliseconds := 180000
  ) into v_req;
  return v_req;
end;
$$;

create or replace function public.run_bk_drift_batch(
  p_offset int default 0, p_limit int default 12,
  p_run_id bigint default null, p_trigger text default 'manual'
)
returns bigint
language plpgsql security definer
set search_path = public, extensions, net, vault
as $$
declare v_url text; v_key text; v_req bigint;
begin
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'planning_project_url' limit 1;
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'planning_service_role_key' limit 1;
  if v_url is null or v_key is null then raise exception 'vault secrets not set'; end if;

  select net.http_post(
    url := v_url || '/functions/v1/qbo-drift-sweep',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||v_key,'apikey',v_key),
    body := jsonb_build_object('mode','sweep','offset',p_offset,'limit',p_limit,'run_id',p_run_id,'trigger',p_trigger),
    timeout_milliseconds := 240000
  ) into v_req;
  return v_req;
end;
$$;

-- Self-chunking driver, in the shape of run_journal_recon_chunk. A starter opens
-- the run; a continuation picks up the unfinished one every few minutes until
-- the estate is covered. Chunked because Intuit throttles per realm and edge
-- functions time out: 12 realms per invocation leaves headroom at ~6 API calls
-- each (7 in the month the baseline is rebuilt).
--
-- The offset is counted from what has ACTUALLY been snapshotted today, not from
-- a running total on the run row. The continuation fires every five minutes and
-- a slow chunk can still be in flight when the next starts; with a counter,
-- two overlapping chunks each added 12 while covering the same 12 realms, and
-- the chunk after that skipped 12 clients — who then had no snapshot for the
-- day and silently disappeared from the board. Counting real rows makes overlap
-- harmless repeated work instead of a hole, and retries a failed chunk rather
-- than stepping over it.
create or replace function public.run_bk_drift_chunk(p_start_new boolean default false)
returns bigint
language plpgsql security definer
set search_path = public, extensions, net, vault
as $$
declare v_id bigint; v_done int;
begin
  select id into v_id
  from public.bk_drift_runs where finished_at is null
  order by id desc limit 1;

  if v_id is null and not p_start_new then return null; end if;

  select count(*) into v_done
  from public.bk_drift_snapshots
  where snapshot_date = current_date;

  return public.run_bk_drift_batch(coalesce(v_done, 0), 12, v_id, 'cron');
end;
$$;

revoke all on function public.run_bk_drift_probe(text, boolean)          from public, anon;
revoke all on function public.run_bk_drift_batch(int, int, bigint, text) from public, anon;
revoke all on function public.run_bk_drift_chunk(boolean)                from public, anon;
grant execute on function public.run_bk_drift_probe(text, boolean)          to service_role;
grant execute on function public.run_bk_drift_batch(int, int, bigint, text) to service_role;
grant execute on function public.run_bk_drift_chunk(boolean)                to service_role;
