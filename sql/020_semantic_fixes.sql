-- ══════════════════════════════════════════════════════════════
-- 020_semantic_fixes.sql
--
-- Architect's plan: "Migration 010 — semantic fixes"
-- (file-numbered 020 because sql/010_admin_module.sql already exists)
--
-- Addresses the following findings from DATABASE_SPEC_LIVE.md:
--   §0.3  — drop orphaned tg_completed_tasks_no_delete_fn()
--   §0.4  — reconcile quotes.status CHECK ↔ state-machine trigger
--   §0.16 — drop dead RPC insert_progress_note()
--   §4.4  — consolidate duplicate updated_at trigger functions
--   §5.4  — add missing updated_at triggers on 6 tables
--
-- Decisions (Bobby + architect, 2026-04-19):
--   D1  — Soft delete. Add 'deleted' to CHECK; any non-terminal → 'deleted'.
--   D2  — 'committed' is a terminal status. Add to CHECK; accepted → committed.
--
-- Status vocabulary (per QuoBu Spec v1.3 §4.4 — architect's ruling):
--   Uses 'pending_approval', NOT 'awaiting_approval'. The existing trigger
--   was written against an earlier draft and must conform to the contract.
--
-- Run in Supabase SQL Editor against project neksyvneljgxvpchwgch.
-- Single transaction — any failure rolls back the whole migration.
-- ══════════════════════════════════════════════════════════════

BEGIN;


-- ────────────────────────────────────────────────────────────
-- 1. Drop orphaned / dead functions
-- ────────────────────────────────────────────────────────────

-- Orphaned: function defined but no trigger wired to it.
-- completed_tasks DELETE is handled by tg_completed_tasks_audit_delete_fn.
-- Leaving this function in place is misleading — a future engineer
-- reading pg_proc will think deletes are blocked. They aren't.
DROP FUNCTION IF EXISTS tg_completed_tasks_no_delete_fn();


-- Dead RPC: body references a non-existent column ('full_name' — the
-- column is called 'name'). Diagnostic confirmed the UI bypasses this
-- RPC via direct INSERT (6 rows in task_progress_notes, all with
-- created_by_name populated, 2026-04-15 → 2026-04-16). Safe to drop.
DROP FUNCTION IF EXISTS insert_progress_note(text, uuid, text, boolean);


-- ────────────────────────────────────────────────────────────
-- 2. Consolidate updated_at trigger functions
-- ────────────────────────────────────────────────────────────
-- Two table-specific functions have identical bodies to the generic
-- set_updated_at(). Repoint the existing triggers at the generic
-- function, then drop the duplicates.

DROP TRIGGER IF EXISTS trg_quotes_updated_at ON quotes;
CREATE TRIGGER trg_quotes_updated_at
  BEFORE UPDATE ON quotes
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_staff_profiles_updated_at ON staff_profiles;
CREATE TRIGGER trg_staff_profiles_updated_at
  BEFORE UPDATE ON staff_profiles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Now-orphaned functions — safe to drop once triggers are repointed above.
DROP FUNCTION IF EXISTS update_quotes_updated_at();
DROP FUNCTION IF EXISTS update_staff_profiles_updated_at();


-- ────────────────────────────────────────────────────────────
-- 3. Add missing updated_at triggers (§5.4)
-- ────────────────────────────────────────────────────────────
-- These tables have an `updated_at` column but no trigger maintaining
-- it. The application has to remember to set it on every UPDATE,
-- which is error-prone. Attach the generic set_updated_at() to each.

CREATE TRIGGER trg_live_billing_updated_at
  BEFORE UPDATE ON live_billing
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_scheduled_tasks_updated_at
  BEFORE UPDATE ON scheduled_tasks
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_quick_tasks_updated_at
  BEFORE UPDATE ON quick_tasks
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_instance_overrides_updated_at
  BEFORE UPDATE ON instance_overrides
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_entity_fees_updated_at
  BEFORE UPDATE ON entity_fees
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_qbo_connections_updated_at
  BEFORE UPDATE ON qbo_connections
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ────────────────────────────────────────────────────────────
-- 4. Rewrite quotes.status CHECK (D1, D2)
-- ────────────────────────────────────────────────────────────
-- Add 'committed' and 'deleted' to the allowed vocabulary.
-- Order preserved from the original constraint for diff clarity.
-- All existing rows (draft, pending_approval, approved, sent,
-- accepted, declined, expired) remain valid — this is a widening.

ALTER TABLE quotes DROP CONSTRAINT quotes_status_check;

ALTER TABLE quotes ADD CONSTRAINT quotes_status_check
  CHECK (status = ANY (ARRAY[
    'draft'::text,
    'pending_approval'::text,
    'approved'::text,
    'sent'::text,
    'accepted'::text,
    'declined'::text,
    'expired'::text,
    'committed'::text,     -- D2: terminal, paired with committed_at/committed_by
    'deleted'::text        -- D1: soft delete, terminal
  ]));


-- ────────────────────────────────────────────────────────────
-- 5. Rewrite the state-machine trigger function
-- ────────────────────────────────────────────────────────────
-- The current function references 'awaiting_approval' (not in the
-- CHECK) so every transition off 'draft' fails. Replace with a
-- conformant version.
--
-- Transitions (final):
--   draft             → pending_approval | deleted
--   pending_approval  → approved | declined | deleted
--   approved          → sent | deleted
--   sent              → accepted | declined | expired | deleted
--   accepted          → committed | deleted
--   declined          → draft | deleted
--   expired           → draft | deleted
--   committed         → (terminal)
--   deleted           → (terminal)

CREATE OR REPLACE FUNCTION tg_quotes_validate_status_fn()
RETURNS TRIGGER AS $$
BEGIN
  -- Self-transition (status unchanged, other fields modified): always allowed.
  IF OLD.status = NEW.status THEN
    RETURN NEW;
  END IF;

  -- Terminal states reject all outbound transitions.
  -- If a quote was committed in error or deleted in error, recovery is
  -- an explicit service-role operation, not a normal UPDATE.
  IF OLD.status IN ('committed', 'deleted') THEN
    RAISE EXCEPTION 'Quote is in terminal state (%) — transitions not permitted', OLD.status;
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


-- ────────────────────────────────────────────────────────────
-- 6. Track migration
-- ────────────────────────────────────────────────────────────

INSERT INTO schema_migrations (filename) VALUES ('020_semantic_fixes.sql')
  ON CONFLICT (filename) DO NOTHING;


COMMIT;


-- ══════════════════════════════════════════════════════════════
-- POST-MIGRATION VERIFICATION (run separately, not inside the txn)
-- ══════════════════════════════════════════════════════════════

-- 1. Confirm dead/orphaned functions are gone (expect 0 rows)
-- SELECT proname FROM pg_proc
-- WHERE pronamespace = 'public'::regnamespace
--   AND proname IN (
--     'tg_completed_tasks_no_delete_fn',
--     'insert_progress_note',
--     'update_quotes_updated_at',
--     'update_staff_profiles_updated_at'
--   );

-- 2. Confirm new CHECK includes 'committed' and 'deleted'
-- SELECT pg_get_constraintdef(oid) FROM pg_constraint
-- WHERE conname = 'quotes_status_check';

-- 3. Confirm trigger function body references pending_approval, not awaiting_approval
-- SELECT prosrc FROM pg_proc WHERE proname = 'tg_quotes_validate_status_fn';

-- 4. Confirm all 8 intended updated_at triggers exist
-- SELECT c.relname, t.tgname
-- FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
-- WHERE t.tgname LIKE 'trg_%_updated_at' AND NOT t.tgisinternal
-- ORDER BY c.relname;
-- -- Expected: bookings, change_requests, deadlines, entities, entity_fees,
-- --           fees, instance_overrides, live_billing, payments, qbo_connections,
-- --           quick_tasks, quotes, referrals, rewards, scheduled_tasks,
-- --           service_requests, services, staff_profiles, users

-- 5. Smoke test: a full happy-path transition should succeed end-to-end.
-- Run against a disposable quote only. Wrap in a transaction and ROLLBACK.
-- BEGIN;
--   INSERT INTO quotes (quote_ref, status) VALUES ('MIGRATION_TEST_001', 'draft') RETURNING id;
--   UPDATE quotes SET status = 'pending_approval' WHERE quote_ref = 'MIGRATION_TEST_001';
--   UPDATE quotes SET status = 'approved'         WHERE quote_ref = 'MIGRATION_TEST_001';
--   UPDATE quotes SET status = 'sent'             WHERE quote_ref = 'MIGRATION_TEST_001';
--   UPDATE quotes SET status = 'accepted'         WHERE quote_ref = 'MIGRATION_TEST_001';
--   UPDATE quotes SET status = 'committed'        WHERE quote_ref = 'MIGRATION_TEST_001';
--   -- This should now raise 'Quote is in terminal state (committed)':
--   -- UPDATE quotes SET status = 'draft' WHERE quote_ref = 'MIGRATION_TEST_001';
-- ROLLBACK;


-- ══════════════════════════════════════════════════════════════
-- ROLLBACK (if needed — run in a fresh session)
-- ══════════════════════════════════════════════════════════════
-- This migration is largely additive. The irreversible parts are the two
-- dropped functions (bodies are recoverable from this file's git history
-- or from Supabase Snippet List Public Schema Functions.csv snapshot).
-- Rollback is a manual recreation exercise, not scripted here.
