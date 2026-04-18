-- Fix tg_quotes_validate_status_fn to match the app's canonical state
-- machine in src/lib/quoteStatus.js.
--
-- The previous trigger rejected at minimum:
--   * draft -> pending_approval   (blocked the "Submit for Approval" button)
--   * accepted -> sent            (blocked the "Revert to Sent" button)
--
-- Both transitions are first-class UI actions. Rather than patch case by
-- case, this migration replaces the function with an explicit allowlist
-- that covers every transition the app exposes, plus a universal escape
-- hatch to 'deleted' (soft delete) and an idempotent same-status update.
--
-- If this migration is run on a DB where the trigger doesn't exist, the
-- CREATE OR REPLACE simply defines the function. The trigger binding is
-- assumed to already exist; if it doesn't, append:
--   create trigger tg_quotes_validate_status
--     before update on quotes
--     for each row execute function tg_quotes_validate_status_fn();

create or replace function tg_quotes_validate_status_fn()
returns trigger as $$
declare
  allowed boolean;
begin
  -- Idempotent update: no change, nothing to validate.
  if OLD.status is not distinct from NEW.status then
    return NEW;
  end if;

  allowed :=
    -- draft
    (OLD.status = 'draft'
      and NEW.status in ('pending_approval', 'deleted'))
    -- pending_approval
    or (OLD.status = 'pending_approval'
      and NEW.status in ('approved', 'draft', 'deleted'))
    -- approved
    or (OLD.status = 'approved'
      and NEW.status in ('sent', 'deleted'))
    -- sent
    or (OLD.status = 'sent'
      and NEW.status in ('accepted', 'declined', 'expired', 'committed', 'deleted'))
    -- accepted
    or (OLD.status = 'accepted'
      and NEW.status in ('sent', 'committed', 'deleted'))
    -- terminal states can only be soft-deleted
    or (OLD.status in ('committed', 'declined', 'expired')
      and NEW.status = 'deleted');

  if not allowed then
    raise exception 'Invalid quote status transition: % -> %',
      OLD.status, NEW.status;
  end if;

  return NEW;
end;
$$ language plpgsql;
