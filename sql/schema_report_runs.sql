-- report_runs — dispatch log for QBO report extraction via Apps Script
-- Referenced by: ReportsPage.jsx (run log), trigger-report Edge Function
-- Protected: do not modify without explicit instruction

CREATE TABLE report_runs (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  triggered_by       UUID,
  triggered_by_name  TEXT,
  client_name        TEXT NOT NULL,
  realm_id           TEXT NOT NULL,
  report_type        TEXT NOT NULL,              -- API name e.g. 'ProfitAndLoss'
  report_label       TEXT NOT NULL,              -- Display name e.g. 'Profit & Loss'
  accounting_method  TEXT,                       -- 'Accrual' or 'Cash'
  start_date         DATE,
  end_date           DATE,
  report_date        DATE,                       -- for point-in-time reports
  status             TEXT DEFAULT 'triggered',   -- 'triggered', 'complete', 'failed'
  output_sheet_url   TEXT,
  error_message      TEXT,
  created_at         TIMESTAMPTZ DEFAULT now()
);
