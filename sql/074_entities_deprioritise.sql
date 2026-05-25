-- Adds deprioritise_reason + deprioritised_at to entities so the Work
-- Planner Ready Now view can move impending tasks into a separate
-- Deprioritised box with a recorded reason (Client Unresponsive,
-- Being Struck Off, Awaiting Client, or free text).

alter table entities
  add column if not exists deprioritise_reason text,
  add column if not exists deprioritised_at timestamptz;

comment on column entities.deprioritise_reason is 'When set, the entity is deprioritised in Ready Now (moved out of Impending into its own box). Free text or one of: Client Unresponsive, Being Struck Off, Awaiting Client.';
comment on column entities.deprioritised_at is 'Set when deprioritise_reason is set; cleared when reactivated.';
