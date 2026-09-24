-- 292 — The Planning "nightly sync" reported an error every night that wasn't one.
--
-- trigger_qbo_monthly_pull() posted to planning-qbo-pull with pg_net's default
-- 5-second timeout. The pull takes longer, so pg_net recorded "Timeout of 5000 ms
-- reached" while the edge function carried on and filled plan_qbo_pl_cache. The
-- reconciler then marked the run 'error' with a blank message, because
-- 'HTTP ' || NULL is NULL. The Overheads tab showed "Last error: … —".
--
-- Now: a 150-second timeout (as sql/125 uses for the same kind of pull), and the
-- reconciler records pg_net's own error text when there is no HTTP status.
-- Both bodies are otherwise the live definitions, with their live grants.

CREATE OR REPLACE FUNCTION public.trigger_qbo_monthly_pull(p_trigger text DEFAULT 'cron'::text)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'net', 'vault'
AS $function$
DECLARE
  v_run_id bigint;
  v_request_id bigint;
  v_url text;
  v_service_key text;
BEGIN
  IF NOT is_staff_or_service() THEN
    RAISE EXCEPTION 'not authorised' USING ERRCODE = '42501';
  END IF;

  SELECT decrypted_secret INTO v_url FROM vault.decrypted_secrets WHERE name = 'planning_project_url' LIMIT 1;
  SELECT decrypted_secret INTO v_service_key FROM vault.decrypted_secrets WHERE name = 'planning_service_role_key' LIMIT 1;

  IF v_url IS NULL OR v_service_key IS NULL THEN
    INSERT INTO plan_qbo_sync_runs (trigger, status, error_message, completed_at)
    VALUES (p_trigger, 'error', 'vault secrets not set: planning_project_url and/or planning_service_role_key', now())
    RETURNING id INTO v_run_id;
    RETURN v_run_id;
  END IF;

  INSERT INTO plan_qbo_sync_runs (trigger, status) VALUES (p_trigger, 'pending') RETURNING id INTO v_run_id;

  SELECT net.http_post(
    url := v_url || '/functions/v1/planning-qbo-pull',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_service_key,
      'apikey', v_service_key
    ),
    body := jsonb_build_object('granularity', 'monthly', 'months_back', 12),
    timeout_milliseconds := 150000
  ) INTO v_request_id;

  UPDATE plan_qbo_sync_runs SET request_id = v_request_id WHERE id = v_run_id;
  RETURN v_run_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.trigger_qbo_monthly_pull(text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.trigger_qbo_monthly_pull(text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.reconcile_qbo_sync_responses()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'net'
AS $function$
BEGIN
  UPDATE plan_qbo_sync_runs r
  SET
    response_status = resp.status_code,
    response_body = left(resp.content, 2000),
    status = CASE
      WHEN resp.status_code BETWEEN 200 AND 299 AND (resp.content::jsonb ->> 'success')::boolean IS TRUE THEN 'success'
      ELSE 'error'
    END,
    error_message = CASE
      WHEN resp.status_code BETWEEN 200 AND 299 AND (resp.content::jsonb ->> 'success')::boolean IS TRUE THEN NULL
      ELSE coalesce(resp.content::jsonb ->> 'error', resp.error_msg, 'HTTP ' || resp.status_code, 'No response recorded')
    END,
    completed_at = now()
  FROM net._http_response resp
  WHERE r.request_id = resp.id AND r.status = 'pending';
END;
$function$;

REVOKE ALL ON FUNCTION public.reconcile_qbo_sync_responses() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_qbo_sync_responses() TO service_role;
