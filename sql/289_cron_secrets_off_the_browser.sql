-- 289 — the same exposure as 288, on five more config singletons.
--
-- Each of these holds a cron_secret and was SELECT-able by authenticated (and by
-- anon at the grant level), with read policies of is_active_staff() or an admin
-- check. deadline_digest_config and ch_code_chase_config also let any active staff
-- member UPDATE the row — cron_secret and sending_enabled included.
--
-- Browser use, checked across src/:
--   ch_code_chase_config  — reads and writes email_signature_html only
--                           (src/modules/ch-codes/api.js getEmailSignature/saveEmailSignature)
--   the other four        — none. Edge functions read them as service_role and the
--                           Scheduled Jobs page edits settings through definer RPCs.
--
-- So four lose the browser roles entirely and ch_code_chase_config keeps exactly the
-- signature column. Rotate the secrets afterwards: they have already been readable.

revoke all on public.notification_config       from anon, authenticated;
revoke all on public.deadline_digest_config    from anon, authenticated;
revoke all on public.ch_refresh_config         from anon, authenticated;
revoke all on public.reminder_autoqueue_config from anon, authenticated;

revoke all on public.ch_code_chase_config from anon, authenticated;
grant select (id, email_signature_html)             on public.ch_code_chase_config to authenticated;
grant update (email_signature_html, updated_at)     on public.ch_code_chase_config to authenticated;
