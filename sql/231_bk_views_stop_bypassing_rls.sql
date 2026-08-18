-- 231: the bookkeeping-drift views were an unauthenticated read of client data
--
-- v_bk_drift_board / _current / _trend and v_bk_realm_link_candidates / _review are
-- SECURITY DEFINER views (the pre-PG15 default), so they read their base tables as
-- the view owner and RLS never applies. Unlike the hmrc views, they carry no
-- gating predicate of their own, and anon held SELECT on all five. Verified against
-- prod with no auth context: 72 rows of client drift data, 121 realm/entity link
-- candidates — company names, QBO realm ids, reconciliation state, transaction
-- volumes, uncleared totals — readable by anyone with the public anon key.
--
-- The fix is not to bolt a predicate on: every base table already has precisely the
-- right policy (bk_drift_snapshots / bk_watch_config / entities / qbo_report_connections
-- all gate SELECT on is_active_staff(), and qbo_report_connections additionally hides
-- practice books behind can_view_practice_financials()). The views were simply
-- bypassing them. security_invoker = true makes them honour the caller's own
-- permissions, which closes the anon hole, closes it for portal clients too, and
-- restores the practice-books restriction these views had been side-stepping for
-- general staff.
--
-- Internal callers are unaffected: bk_autolink_realms() and friends are SECURITY
-- DEFINER owned by postgres, and pg_cron runs as postgres, both of which bypass RLS.

alter view public.v_bk_drift_board            set (security_invoker = true);
alter view public.v_bk_drift_current          set (security_invoker = true);
alter view public.v_bk_drift_trend            set (security_invoker = true);
alter view public.v_bk_realm_link_candidates  set (security_invoker = true);
alter view public.v_bk_realm_link_review      set (security_invoker = true);

-- Grants are the outer wall, the policy is the inner one. anon has no business
-- reading any of these, including the hmrc views that gate correctly already.
revoke select on public.v_bk_drift_board           from anon;
revoke select on public.v_bk_drift_current         from anon;
revoke select on public.v_bk_drift_trend           from anon;
revoke select on public.v_bk_realm_link_candidates from anon;
revoke select on public.v_bk_realm_link_review     from anon;
revoke select on public.v_hmrc_identity_reviews    from anon;
revoke select on public.v_hmrc_refresh_requests    from anon;
