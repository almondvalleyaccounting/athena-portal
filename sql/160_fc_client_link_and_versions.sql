-- 160: Client Forecast — link forecasts to real Athena clients and
-- surface named forecast versions.
--
-- New hierarchy (Bobby, 2026-07-23):
--   Group client  (free text, e.g. "Marc Kelly" — may not exist as a client)
--     └─ Client   (linked to the Athena `entities` client record, e.g. Puddleduck)
--          └─ Forecast (name, e.g. "Childcare Scotland")
--               └─ Version (fc_version, named: "Budget", "Rolling Forecast", "v1", …)
--
-- fc_version already existed (one hidden "Working" row per forecast);
-- the UI now surfaces it with create/duplicate/rename.
--
-- client_name is REPURPOSED: it used to hold the group-client label
-- ("Marc Kelly"); that moves to group_client_name, and client_name
-- becomes the client-company label (denormalised from the linked
-- entities row, editable when unlinked).

alter table fc_forecast add column if not exists group_client_name text;
alter table fc_forecast add column if not exists client_entity_id uuid references entities(id) on delete set null;

create index if not exists idx_fc_forecast_client_entity on fc_forecast(client_entity_id);

-- Existing rows: what sat in client_name was the group client.
update fc_forecast
set group_client_name = client_name, client_name = null
where group_client_name is null and client_name is not null;
