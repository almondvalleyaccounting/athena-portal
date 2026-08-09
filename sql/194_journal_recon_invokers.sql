-- 194_journal_recon_invokers.sql
--
-- SQL entry points that invoke the qbo-journal-recon edge function.
--
-- Why via pg_net + Vault rather than an unauthenticated endpoint: the function
-- keeps verify_jwt=true, and these callers present the service-role JWT held in
-- Vault. Nothing about the control check is reachable without a valid JWT, and
-- no new secret is introduced. Same pattern as trigger_qbo_monthly_pull.
--
-- Note the edge function reads the ROLE CLAIM from the (already gateway-
-- verified) JWT rather than string-matching SUPABASE_SERVICE_ROLE_KEY, because
-- the Vault-held key is a different but equally valid service-role JWT for this
-- project. String equality fails; the claim check is correct.

-- ── one realm: probe (shape) or recon (findings, not persisted) ────
create or replace function public.run_qbo_journal_recon(
  p_realm_id text,
  p_start    date default '2026-04-01',
  p_end      date default '2026-07-31',
  p_mode     text default 'recon',
  p_limit    int  default 10
)
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
    raise exception 'vault secrets not set: planning_project_url and/or planning_service_role_key';
  end if;

  select net.http_post(
    url := v_url || '/functions/v1/qbo-journal-recon',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_service_key,
      'apikey', v_service_key
    ),
    body := jsonb_build_object(
      'realm_id', p_realm_id,
      'start', to_char(p_start, 'YYYY-MM-DD'),
      'end',   to_char(p_end,   'YYYY-MM-DD'),
      'mode',  p_mode,
      'limit', p_limit
    ),
    timeout_milliseconds := 120000
  ) into v_request_id;

  return v_request_id;
end;
$$;

-- ── many realms: persisted to journal_recon_findings ───────────────
-- Chunked deliberately. Intuit throttles per realm and edge functions time out;
-- 15 realms per invocation leaves headroom. Pass the returned run_id back with
-- the next offset to keep one logical run together.
create or replace function public.run_journal_recon_batch(
  p_offset  int    default 0,
  p_limit   int    default 15,
  p_run_id  bigint default null,
  p_start   date   default '2026-04-01',
  p_end     date   default '2026-07-31',
  p_trigger text   default 'manual'
)
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
    url := v_url || '/functions/v1/qbo-journal-recon',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_service_key,
      'apikey', v_service_key
    ),
    body := jsonb_build_object(
      'mode', 'batch',
      'offset', p_offset,
      'limit', p_limit,
      'run_id', p_run_id,
      'start', to_char(p_start, 'YYYY-MM-DD'),
      'end',   to_char(p_end,   'YYYY-MM-DD'),
      'trigger', p_trigger
    ),
    timeout_milliseconds := 240000
  ) into v_request_id;

  return v_request_id;
end;
$$;

revoke all on function public.run_qbo_journal_recon(text, date, date, text, int)        from public, anon, authenticated;
revoke all on function public.run_journal_recon_batch(int, int, bigint, date, date, text) from public, anon, authenticated;
grant execute on function public.run_qbo_journal_recon(text, date, date, text, int)        to service_role;
grant execute on function public.run_journal_recon_batch(int, int, bigint, date, date, text) to service_role;
