-- deadlines — statutory/filing deadlines linked to entities
-- Referenced by: scheduled_tasks.deadline_id FK
-- tag column uses custom enum: deadline_tag (values TBC)
-- status column uses custom enum: deadline_status (default 'filing')

CREATE TABLE deadlines (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  entity_id       UUID NOT NULL,
  title           TEXT NOT NULL,
  due_date        DATE NOT NULL,
  tag             deadline_tag NOT NULL,         -- USER-DEFINED enum
  status          deadline_status NOT NULL DEFAULT 'filing',
  bm_deadline_id  TEXT,                          -- BrightManager external ID
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
