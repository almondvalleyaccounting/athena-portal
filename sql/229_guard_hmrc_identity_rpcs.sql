-- 229: hmrc_confirm_identity / hmrc_reject_identity were unauthenticated writes
--
-- Both are SECURITY DEFINER functions that write into the private `hmrc` schema,
-- both had EXECUTE granted to `anon`, and neither checked who was calling. The
-- hmrc module's read path is properly gated behind hmrc_can_read(), but these two
-- write RPCs were not — so anyone with the (public) anon key could POST to
-- /rest/v1/rpc/hmrc_confirm_identity and create or overwrite HMRC identity
-- aliases, or mark identity reviews resolved via hmrc_reject_identity.
--
-- Fix: the same hmrc_can_read() active-staff predicate the views use, plus taking
-- anon off the grant list so a body is never even reached.

CREATE OR REPLACE FUNCTION public.hmrc_reject_identity(p_service text, p_reference text, p_note text DEFAULT NULL::text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'hmrc'
AS $function$
BEGIN
  IF NOT hmrc_can_read() THEN
    RAISE EXCEPTION 'not authorised' USING ERRCODE = '42501';
  END IF;

  UPDATE hmrc.identity_review
     SET resolved_at = now(),
         athena_name = coalesce(p_note, athena_name)
   WHERE service = p_service AND reference = p_reference;
END $function$;

CREATE OR REPLACE FUNCTION public.hmrc_confirm_identity(p_service text, p_reference text, p_entity_id uuid, p_hmrc_name text, p_note text DEFAULT NULL::text, p_by uuid DEFAULT NULL::uuid)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'hmrc'
AS $function$
DECLARE v_id bigint;
BEGIN
  IF NOT hmrc_can_read() THEN
    RAISE EXCEPTION 'not authorised' USING ERRCODE = '42501';
  END IF;

  INSERT INTO hmrc.identity_alias (service, reference, entity_id, hmrc_name, note, confirmed_by)
  VALUES (p_service, p_reference, p_entity_id, p_hmrc_name, p_note, coalesce(p_by, auth.uid()))
  ON CONFLICT (service, reference) DO UPDATE
    SET entity_id = EXCLUDED.entity_id,
        hmrc_name = EXCLUDED.hmrc_name,
        note = coalesce(EXCLUDED.note, hmrc.identity_alias.note),
        confirmed_at = now(),
        confirmed_by = EXCLUDED.confirmed_by
  RETURNING id INTO v_id;

  UPDATE hmrc.identity_review
     SET resolved_at = now()
   WHERE service = p_service AND reference = p_reference;

  RETURN v_id;
END $function$;

REVOKE EXECUTE ON FUNCTION public.hmrc_confirm_identity(text, text, uuid, text, text, uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.hmrc_reject_identity(text, text, text) FROM anon;

-- pd_prep_notify_* are trigger functions; triggers fire as the definer regardless,
-- so a direct EXECUTE grant to the API roles serves no purpose.
REVOKE EXECUTE ON FUNCTION public.pd_prep_notify_request() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.pd_prep_notify_contribution() FROM anon, authenticated;
