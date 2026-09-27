-- ============================================================
-- 334 — A payroll client is always an Athena client
--
-- Bobby, 2026-09-27: no free-text payroll client names. Every row on the
-- Payroll tab is tagged to an entity (current, prospect or former). The
-- last untagged rows were worked through by hand today; two former clients
-- that pre-date Athena (never recorded) were dropped rather than invented.
-- The edge function already refuses a create without entity_id and sets
-- the display name from the entity; this makes the table say the same.
-- ============================================================

alter table public.payroll_clients
  alter column entity_id set not null;

comment on column public.payroll_clients.entity_id is
  'The Athena client this payroll belongs to. Required (sql/334); name mirrors entities.name.';
