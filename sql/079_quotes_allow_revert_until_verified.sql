-- 079_quotes_allow_revert_until_verified.sql
-- Lets a committed quote be reverted to 'accepted' until it's verified in QB.
-- Previously 'committed' was a hard terminal state in the state-machine
-- trigger (020_semantic_fixes.sql), which blocked the Revert-to-Accepted
-- action. Now: committed → accepted is allowed while qbo_verified_at IS NULL;
-- once verified the quote is locked. 'deleted' stays fully terminal.

CREATE OR REPLACE FUNCTION tg_quotes_validate_status_fn()
RETURNS TRIGGER AS $$
BEGIN
  -- Self-transition (status unchanged, other fields modified): always allowed.
  IF OLD.status = NEW.status THEN
    RETURN NEW;
  END IF;

  -- 'deleted' is fully terminal.
  IF OLD.status = 'deleted' THEN
    RAISE EXCEPTION 'Quote is in terminal state (%) — transitions not permitted', OLD.status;
  END IF;

  -- 'committed' is locked once verified in QB. Before verification it can be
  -- reverted to 'accepted' (e.g. when the QBO push didn't actually land).
  IF OLD.status = 'committed' THEN
    IF OLD.qbo_verified_at IS NOT NULL THEN
      RAISE EXCEPTION 'Quote is locked (verified in QB) — transitions not permitted';
    END IF;
    IF NEW.status = 'accepted' THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Invalid quote status transition: % → %', OLD.status, NEW.status;
  END IF;

  -- Soft delete is always available from any non-terminal status.
  IF NEW.status = 'deleted' THEN
    RETURN NEW;
  END IF;

  -- Explicit transition table for all other cases.
  IF NOT (
       (OLD.status = 'draft'            AND NEW.status = 'pending_approval')
    OR (OLD.status = 'pending_approval' AND NEW.status IN ('approved', 'declined'))
    OR (OLD.status = 'approved'         AND NEW.status = 'sent')
    OR (OLD.status = 'sent'             AND NEW.status IN ('accepted', 'declined', 'expired'))
    OR (OLD.status = 'accepted'         AND NEW.status = 'committed')
    OR (OLD.status = 'declined'         AND NEW.status = 'draft')
    OR (OLD.status = 'expired'          AND NEW.status = 'draft')
  ) THEN
    RAISE EXCEPTION 'Invalid quote status transition: % → %', OLD.status, NEW.status;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
