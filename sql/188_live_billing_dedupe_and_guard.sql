-- 188: live_billing — cancel machine-minted duplicate template rows, then
-- guarantee at most one ACTIVE row per QBO recurring template.
--
-- Cause: qbo-pull's template path looked rows up with .maybeSingle() on
-- qbo_recurring_txn_id. maybeSingle ERRORS when >1 row matches, the error
-- was discarded, and the code fell through to "no existing row" → INSERT.
-- So once an entity had two rows for one template, every nightly pull
-- minted one more: 4 templates (Protective Paint Coatings, Dog Bothwell,
-- Little Miss Glam, Shaw Gas Works) had grown to 106 active rows by
-- 2026-08-06 — ~£23.4k/mo of phantom recurring in any naive total, and
-- none of the duplicated rows could be updated, so all sat stale.
--
-- Fix here: keep the OLDEST row per (template) — it carries the original
-- lineage (quote_id, committed_*) and any staff-set service flags — and
-- cancel the clones. Its amounts may be stale until the next qbo-pull
-- run refreshes it (the pull is fixed in the same commit to self-heal
-- and to write checked). The partial unique index then makes any future
-- duplicate insert fail LOUDLY instead of silently forking the book.

with ranked as (
  select id,
         row_number() over (
           partition by qbo_recurring_txn_id
           order by created_at asc
         ) as rn
  from live_billing
  where status = 'active'
    and qbo_recurring_txn_id is not null
)
update live_billing lb
set status = 'cancelled',
    updated_at = now()
from ranked r
where lb.id = r.id
  and r.rn > 1;

create unique index if not exists live_billing_active_template_uniq
  on live_billing (qbo_recurring_txn_id)
  where status = 'active' and qbo_recurring_txn_id is not null;
