import { supabase } from '../../../lib/supabase';
import { fetchAllRows } from '../../../lib/fetchAllRows';

// ── Scenarios ─────────────────────────────────────────────

export async function listScenarios() {
  const { data, error } = await supabase
    .from('plan_scenarios')
    .select('*')
    .order('is_active', { ascending: false })
    .order('updated_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function createScenario(name) {
  const { data, error } = await supabase
    .from('plan_scenarios')
    .insert({ name, is_active: true })
    .select()
    .single();
  if (error) throw error;
  await supabase.from('plan_scenarios').update({ is_active: false }).neq('id', data.id);
  return data;
}

export async function duplicateScenario(sourceId, newName) {
  const { data: source, error: srcErr } = await supabase
    .from('plan_scenarios').select('*').eq('id', sourceId).single();
  if (srcErr) throw srcErr;

  const { id, created_at, updated_at, is_active, ...copy } = source;
  const { data: newScen, error: insErr } = await supabase
    .from('plan_scenarios')
    .insert({ ...copy, name: newName, is_active: false })
    .select().single();
  if (insErr) throw insErr;

  const [staffRes, ohRes, cliRes, ownRes] = await Promise.all([
    supabase.from('plan_staff_lines').select('*').eq('scenario_id', sourceId),
    supabase.from('plan_overhead_lines').select('*').eq('scenario_id', sourceId),
    supabase.from('plan_client_overrides').select('*').eq('scenario_id', sourceId),
    supabase.from('plan_owner_comp_lines').select('*').eq('scenario_id', sourceId),
  ]);

  const stripMeta = (r) => { const { id, created_at, updated_at, ...rest } = r; return { ...rest, scenario_id: newScen.id }; };

  if (staffRes.data?.length) await supabase.from('plan_staff_lines').insert(staffRes.data.map(stripMeta));
  if (ohRes.data?.length) await supabase.from('plan_overhead_lines').insert(ohRes.data.map(stripMeta));
  if (cliRes.data?.length) await supabase.from('plan_client_overrides').insert(cliRes.data.map(stripMeta));
  if (ownRes.data?.length) await supabase.from('plan_owner_comp_lines').insert(ownRes.data.map(stripMeta));

  return newScen;
}

export async function updateScenario(id, patch) {
  const { error } = await supabase
    .from('plan_scenarios')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw error;
}

export async function setActiveScenario(id) {
  await supabase.from('plan_scenarios').update({ is_active: true }).eq('id', id);
  await supabase.from('plan_scenarios').update({ is_active: false }).neq('id', id);
}

export async function deleteScenario(id) {
  const { error } = await supabase.from('plan_scenarios').delete().eq('id', id);
  if (error) throw error;
}

// ── Staff lines ──────────────────────────────────────────

export async function loadStaffLines(scenarioId) {
  const { data, error } = await supabase
    .from('plan_staff_lines').select('*')
    .eq('scenario_id', scenarioId)
    .order('sort_order').order('created_at');
  if (error) throw error;
  return data || [];
}

export async function upsertStaffLine(line) {
  if (line.id) {
    const { id, created_at, ...rest } = line;
    const { error } = await supabase.from('plan_staff_lines')
      .update({ ...rest, updated_at: new Date().toISOString() }).eq('id', id);
    if (error) throw error;
    return id;
  }
  const { data, error } = await supabase.from('plan_staff_lines').insert(line).select().single();
  if (error) throw error;
  return data.id;
}

export async function deleteStaffLine(id) {
  const { error } = await supabase.from('plan_staff_lines').delete().eq('id', id);
  if (error) throw error;
}

// ── Overhead lines ────────────────────────────────────────

export async function loadOverheadLines(scenarioId) {
  const { data, error } = await supabase
    .from('plan_overhead_lines').select('*')
    .eq('scenario_id', scenarioId)
    .order('sort_order').order('created_at');
  if (error) throw error;
  return data || [];
}

export async function upsertOverheadLine(line) {
  if (line.id) {
    const { id, created_at, ...rest } = line;
    const { error } = await supabase.from('plan_overhead_lines')
      .update({ ...rest, updated_at: new Date().toISOString() }).eq('id', id);
    if (error) throw error;
    return id;
  }
  const { data, error } = await supabase.from('plan_overhead_lines').insert(line).select().single();
  if (error) throw error;
  return data.id;
}

export async function deleteOverheadLine(id) {
  const { error } = await supabase.from('plan_overhead_lines').delete().eq('id', id);
  if (error) throw error;
}

// ── Owner comp lines ──────────────────────────────────────

export async function loadOwnerCompLines(scenarioId) {
  const { data, error } = await supabase
    .from('plan_owner_comp_lines').select('*')
    .eq('scenario_id', scenarioId)
    .order('sort_order').order('created_at');
  if (error) throw error;
  return data || [];
}

export async function upsertOwnerCompLine(line) {
  if (line.id) {
    const { id, created_at, ...rest } = line;
    const { error } = await supabase.from('plan_owner_comp_lines')
      .update({ ...rest, updated_at: new Date().toISOString() }).eq('id', id);
    if (error) throw error;
    return id;
  }
  const { data, error } = await supabase.from('plan_owner_comp_lines').insert(line).select().single();
  if (error) throw error;
  return data.id;
}

export async function deleteOwnerCompLine(id) {
  const { error } = await supabase.from('plan_owner_comp_lines').delete().eq('id', id);
  if (error) throw error;
}

// ── Client overrides (risk flags, end dates, fee overrides) ───

export async function loadClientOverrides(scenarioId) {
  const { data, error } = await supabase
    .from('plan_client_overrides').select('*')
    .eq('scenario_id', scenarioId);
  if (error) throw error;
  return data || [];
}

export async function upsertClientOverride(row) {
  // Use conflict on (scenario_id, live_billing_id) when available
  if (row.id) {
    const { id, created_at, ...rest } = row;
    const { error } = await supabase.from('plan_client_overrides')
      .update({ ...rest, updated_at: new Date().toISOString() }).eq('id', id);
    if (error) throw error;
    return id;
  }
  const { data, error } = await supabase
    .from('plan_client_overrides')
    .upsert(row, { onConflict: 'scenario_id,live_billing_id' })
    .select().single();
  if (error) throw error;
  return data.id;
}

export async function deleteClientOverride(id) {
  const { error } = await supabase.from('plan_client_overrides').delete().eq('id', id);
  if (error) throw error;
}

// ── Source data ───────────────────────────────────────────

export async function loadClientBillings() {
  const { data, error } = await supabase
    .from('live_billing')
    .select('id, entity_id, monthly_net, annual_total, services, status, billing_type, qbo_recurring_txn_id, entities:entity_id (name)')
    .eq('status', 'active');
  if (error) throw error;
  return (data || []).map((r) => ({
    id: r.id,
    entity_id: r.entity_id,
    entity_name: r.entities?.name || 'Unknown',
    monthly_net: Number(r.monthly_net) || 0,
    annual_total: Number(r.annual_total) || 0,
    services: r.services,
    billing_type: r.billing_type,
    // Contracted = backed by a QBO recurring template (a signed instruction
    // QBO will execute). Everything else is invoice-inference — an estimate.
    // Downstream views should never blend the two silently.
    template_linked: !!r.qbo_recurring_txn_id,
  }));
}

// ── Baseline trust layer ──────────────────────────────────

// One row of aggregates over active live_billing (sql/189):
// contracted vs inferred split + the health signals (duplicate template
// sets, stale rows, sync freshness).
export async function loadBaselineHealth() {
  const { data, error } = await supabase.from('v_plan_baseline_health').select('*').single();
  if (error) throw error;
  return data;
}

// Latest balance-sheet snapshot (plan_bs_cache, written by
// planning-qbo-pull v11 granularity 'balance_sheet').
export async function loadBsCache() {
  const { data: latest, error: e1 } = await supabase
    .from('plan_bs_cache')
    .select('snapshot_date')
    .order('snapshot_date', { ascending: false })
    .limit(1);
  if (e1) throw e1;
  const snap = latest?.[0]?.snapshot_date;
  if (!snap) return [];
  const { data, error } = await supabase
    .from('plan_bs_cache')
    .select('snapshot_date, account_name, section, amount')
    .eq('snapshot_date', snap);
  if (error) throw error;
  return data || [];
}

export async function pullQboBalanceSheet() {
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;
  const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/planning-qbo-pull`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
    },
    body: JSON.stringify({ granularity: 'balance_sheet' }),
  });
  const text = await resp.text();
  try { return JSON.parse(text); } catch { throw new Error(`QBO balance sheet pull: ${resp.status} ${text.slice(0, 200)}`); }
}

// When the monthly P&L cache was last refreshed from QBO.
export async function loadPlCacheFreshness() {
  const { data, error } = await supabase
    .from('plan_qbo_pl_cache')
    .select('fetched_at')
    .order('fetched_at', { ascending: false })
    .limit(1);
  if (error) throw error;
  return data?.[0]?.fetched_at || null;
}

// One-off invoices pushed through Athena's billing module, by month.
// Used to explain the gap between P&L income and the recurring run-rate.
// Returns Map<'YYYY-MM', net £>. RLS may hide billing_items from some
// roles — callers should treat a failure as "unknown", not zero.
export async function loadOneOffsByMonth(monthsBack = 13) {
  const start = new Date();
  start.setMonth(start.getMonth() - monthsBack);
  start.setDate(1);
  const { data, error } = await supabase
    .from('billing_items')
    .select('pushed_at, net_amount')
    .eq('status', 'pushed')
    .gte('pushed_at', start.toISOString());
  if (error) throw error;
  const byMonth = new Map();
  for (const r of data || []) {
    if (!r.pushed_at) continue;
    const key = String(r.pushed_at).slice(0, 7);
    byMonth.set(key, (byMonth.get(key) || 0) + (Number(r.net_amount) || 0));
  }
  return byMonth;
}

export async function loadStaffProfiles() {
  const { data, error } = await supabase
    .from('staff_profiles')
    .select('id, name, email, is_active')
    .eq('is_active', true)
    .order('name');
  if (error) throw error;
  return data || [];
}

export async function loadCachedPL() {
  // 955 rows and growing a month at a time. Paged, because past 1000 the API
  // returns a prefix with no error and the Planning actuals would quietly lose
  // their oldest months.
  return fetchAllRows(() => supabase
    .from('plan_qbo_pl_cache').select('*')
    .order('period_end', { ascending: false }).order('id'));
}

export async function pullQboPL() {
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;
  const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/planning-qbo-pull`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
    },
    body: JSON.stringify({}),
  });
  // The edge function now returns structured errors as 200 with { success: false, error, raw }.
  // Only throw for non-200s, which indicate function-level failures.
  const text = await resp.text();
  try {
    const body = JSON.parse(text);
    if (!resp.ok && !body.error) throw new Error(`QBO pull failed: ${resp.status}`);
    return body;
  } catch (e) {
    if (!resp.ok) throw new Error(`QBO pull failed: ${resp.status} ${text.slice(0, 200)}`);
    throw e;
  }
}

// ── Timesheet-derived cost-to-serve and capacity ─────────

// Pulls LTM timesheet entries grouped by (entity_id, staff_id, service).
// Returns minutes — caller multiplies by staff hourly cost to get cost-to-serve.
export async function loadTimesheetLTM() {
  const now = new Date();
  const start = new Date(now.getFullYear() - 1, now.getMonth(), 1);
  const { data, error } = await supabase
    .from('timesheet_entries')
    .select('staff_id, entity_id, service, work_date, minutes')
    .gte('work_date', start.toISOString().slice(0, 10))
    .gt('minutes', 0);
  if (error) throw error;
  return data || [];
}

// Aggregate LTM hours per staff (for utilisation calc)
export async function loadTimesheetByStaffLTM() {
  const entries = await loadTimesheetLTM();
  const byStaff = new Map();
  for (const e of entries) {
    if (!byStaff.has(e.staff_id)) byStaff.set(e.staff_id, { minutes: 0, clients: new Set() });
    const s = byStaff.get(e.staff_id);
    s.minutes += e.minutes || 0;
    if (e.entity_id) s.clients.add(e.entity_id);
  }
  return Array.from(byStaff.entries()).map(([staffId, v]) => ({
    staff_id: staffId,
    hours_ltm: v.minutes / 60,
    clients_worked: v.clients.size,
  }));
}

// ── Quote pipeline ────────────────────────────────────────

// Unconverted quotes — pipeline contribution to future MRR.
// Status meaning:
//   draft     -> probability lowest (often still being drawn up)
//   sent      -> awaiting client decision
//   accepted  -> signed but not yet billed (very high probability)
//   committed -> already flowing into live_billing — EXCLUDED (no double count)
//   rejected  -> EXCLUDED
export async function loadQuotePipeline() {
  const { data, error } = await supabase
    .from('quotes')
    .select('id, quote_ref, entity_id, status, annual_total, monthly_net, one_off_total, valid_until, created_at, updated_at, accepted_at, sent_at, entities:entity_id (name)')
    .in('status', ['draft', 'sent', 'accepted'])
    .order('updated_at', { ascending: false });
  if (error) throw error;
  return (data || []).map((q) => ({
    id: q.id, quote_ref: q.quote_ref, entity_id: q.entity_id,
    entity_name: q.entities?.name || 'Unknown',
    status: q.status,
    annual_total: Number(q.annual_total) || 0,
    monthly_net: Number(q.monthly_net) || 0,
    one_off_total: Number(q.one_off_total) || 0,
    valid_until: q.valid_until,
    created_at: q.created_at,
    updated_at: q.updated_at,
    accepted_at: q.accepted_at,
    sent_at: q.sent_at,
  }));
}

// ── Monthly QBO P&L actuals (for rolling forecast + variance) ─

// Returns one row per (month, account_name) from plan_qbo_pl_cache.
// period_start is always the 1st of the month.
export async function loadMonthlyActuals() {
  return fetchAllRows(() => supabase
    .from('plan_qbo_pl_cache')
    .select('id, period_start, period_end, account_name, account_type, amount')
    .order('period_start', { ascending: true }).order('id'));
}

// Triggers the monthly-granularity QBO pull (overwrites the month-by-month cache).
// ── Nightly cron status ──

export async function loadQboSyncRuns(limit = 10) {
  const { data, error } = await supabase
    .from('plan_qbo_sync_runs')
    .select('*')
    .order('run_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data || [];
}

export async function pullQboMonthly(monthsBack = 12) {
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;
  const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/planning-qbo-pull`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
    },
    body: JSON.stringify({ granularity: 'monthly', months_back: monthsBack }),
  });
  const text = await resp.text();
  try { return JSON.parse(text); } catch { throw new Error(`QBO monthly pull: ${resp.status} ${text.slice(0, 200)}`); }
}

// ── Seeding ───────────────────────────────────────────────

export async function seedScenarioFromCurrent(scenarioId) {
  const staff = await loadStaffProfiles();
  const existingStaff = await loadStaffLines(scenarioId);
  if (existingStaff.length === 0 && staff.length > 0) {
    const rows = staff.map((s, i) => ({
      scenario_id: scenarioId, staff_id: s.id, name: s.name, role: null,
      annual_salary: 0, on_costs_pct: null, sort_order: i,
    }));
    await supabase.from('plan_staff_lines').insert(rows);
  }

  const cached = await loadCachedPL();
  const existingOverheads = await loadOverheadLines(scenarioId);
  if (existingOverheads.length === 0 && cached.length > 0) {
    const latestPeriod = cached[0].period_end;
    const expenseRows = cached.filter((r) => r.period_end === latestPeriod && r.account_type !== 'Income');
    const rows = expenseRows.map((r, i) => ({
      scenario_id: scenarioId, category: r.account_name, qbo_account: r.account_name,
      monthly_amount: Math.round((Number(r.amount) / 12) * 100) / 100,
      qbo_actual_ltm: r.amount, sort_order: i,
    }));
    if (rows.length) await supabase.from('plan_overhead_lines').insert(rows);
  }
}
