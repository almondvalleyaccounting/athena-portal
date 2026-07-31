-- 171: Restore the QBO billing config lost on reconnect.
--
-- qbo-auth's billing callback marks the current connection `disconnected` and
-- INSERTs a fresh row. It never carried the per-realm settings across, so the
-- 2026-07-21 reconnect silently dropped:
--   default_tax_code_id   '18' ("20.0% S")  -> NULL
--   default_due_date_offset_days      14    -> 1   (column default)
--
-- With no tax code configured, qbo-push-billing-items falls through to
-- resolveStandardTaxCode(), whose name-regex can land on a reverse-charge
-- code — QBO then rejects the invoice with "error while calculating tax"
-- (code 6000). That is what broke the 2026-07-31 push.
--
-- This restores the active row from the most recent disconnected row for the
-- same realm, and makes 14 the column default so a future insert that misses
-- the carry-forward still gets sane terms rather than 1-day payment terms.

update qbo_connections active
set default_tax_code_id   = coalesce(active.default_tax_code_id, prev.default_tax_code_id),
    default_tax_code_name = coalesce(active.default_tax_code_name, prev.default_tax_code_name),
    default_due_date_offset_days = coalesce(
      nullif(active.default_due_date_offset_days, 1),
      prev.default_due_date_offset_days
    ),
    updated_at = now()
from (
  select distinct on (realm_id)
         realm_id, default_tax_code_id, default_tax_code_name, default_due_date_offset_days
  from qbo_connections
  where status = 'disconnected' and default_tax_code_id is not null
  order by realm_id, updated_at desc
) prev
where active.status = 'active'
  and active.realm_id = prev.realm_id
  and active.default_tax_code_id is null;

alter table qbo_connections
  alter column default_due_date_offset_days set default 14;
