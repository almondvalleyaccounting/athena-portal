-- 302 — The client accepts a fee proposal by link.
--
-- sql/300 had staff record acceptance only (written, by email, with the
-- date and inbox). The client now accepts by clicking the link in the
-- email instead (decided 2026-09-25) — the same signed-link approach as
-- quote acceptance (/accept-quote), with its own token purpose so neither
-- link can be used on the other's endpoint. Staff recording stays as the
-- fallback for a client who replies by email.
--
-- accepted_via says which, and the CHECK requires the evidence for each:
--   client_link     the recipient address the link was sent to, the name
--                   they typed, and when
--   staff_recorded  as before: confirmed in writing by email, the date it
--                   arrived and the inbox

alter table public.fee_proposals
  add column if not exists accepted_via text
    check (accepted_via is null or accepted_via in ('client_link', 'staff_recorded')),
  add column if not exists accepted_client_email text,
  add column if not exists accepted_name text,
  add column if not exists accepted_ip text,
  add column if not exists accepted_user_agent text,
  add column if not exists link_opened_at timestamptz;

alter table public.fee_proposals drop constraint if exists fee_proposals_acceptance_is_written;
alter table public.fee_proposals add constraint fee_proposals_acceptance_is_written
  check (status <> 'accepted' or (
    kind = 'proposal'
    and accepted_at is not null
    and (
      (accepted_via = 'client_link'
        and accepted_client_email is not null
        and accepted_name is not null and length(trim(accepted_name)) > 1)
      or
      (coalesce(accepted_via, 'staff_recorded') = 'staff_recorded'
        and acceptance_email_confirmed
        and acceptance_received_on is not null
        and acceptance_inbox is not null and length(trim(acceptance_inbox)) > 0)
    )
  ));
