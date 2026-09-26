-- ============================================================
-- 319 — Records-in signals beyond BrightManager, and hold the chase
--
-- Bobby, 2026-09-26. Until now "records in" came only from BM's status.
-- Two more signals: the client replies to our request or chase (an inbound
-- email on the thread, or from the address we wrote to, after we sent), or
-- the client uploads something through the portal. Neither proves the
-- records are complete, so a signal does not close the stage: it holds the
-- automatic chases and asks the owner — "Records in?" or "Still waiting".
-- Must be in place before client comms are armed.
-- ============================================================

alter table public.job_plans
  add column if not exists client_signal_at    timestamptz,
  add column if not exists client_signal_kind  text check (client_signal_kind is null or client_signal_kind in ('reply','upload')),
  add column if not exists client_signal_ref   text,          -- gmail message id or document id, so the same signal is not raised twice
  add column if not exists signal_handled_at   timestamptz,
  add column if not exists chases_held         boolean not null default false;
comment on column public.job_plans.chases_held is 'True while a client reply or upload awaits the owner''s decision; the nightly pass sends no chase meanwhile (sql/319).';
