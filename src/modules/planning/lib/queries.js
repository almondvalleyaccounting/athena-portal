import { supabase } from '../../../lib/supabase';

export async function loadActiveScenario() {
  const { data, error } = await supabase
    .from('plan_scenarios')
    .select('*')
    .order('is_active', { ascending: false })
    .order('updated_at', { ascending: false })
    .limit(1);
  if (error) throw error;
  return data?.[0] || null;
}

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
  // Deactivate others
  await supabase.from('plan_scenarios').update({ is_active: false }).neq('id', data.id);
  return data;
}

export async function updateScenario(id, patch) {
  const { error } = await supabase
    .from('plan_scenarios')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw error;
}

export async function setActiveScenario(id) {
  await supabase.from('plan_scenarios').update({ is_active: false }).neq('id', id);
  await supabase.from('plan_scenarios').update({ is_active: true }).eq('id', id);
}

export async function deleteScenario(id) {
  const { error } = await supabase.from('plan_scenarios').delete().eq('id', id);
  if (error) throw error;
}

export async function loadStaffLines(scenarioId) {
  const { data, error } = await supabase
    .from('plan_staff_lines')
    .select('*')
    .eq('scenario_id', scenarioId)
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data || [];
}

export async function upsertStaffLine(line) {
  if (line.id) {
    const { id, created_at, ...rest } = line;
    const { error } = await supabase
      .from('plan_staff_lines')
      .update({ ...rest, updated_at: new Date().toISOString() })
      .eq('id', id);
    if (error) throw error;
    return id;
  } else {
    const { data, error } = await supabase
      .from('plan_staff_lines')
      .insert(line)
      .select()
      .single();
    if (error) throw error;
    return data.id;
  }
}

export async function deleteStaffLine(id) {
  const { error } = await supabase.from('plan_staff_lines').delete().eq('id', id);
  if (error) throw error;
}

export async function loadOverheadLines(scenarioId) {
  const { data, error } = await supabase
    .from('plan_overhead_lines')
    .select('*')
    .eq('scenario_id', scenarioId)
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data || [];
}

export async function upsertOverheadLine(line) {
  if (line.id) {
    const { id, created_at, ...rest } = line;
    const { error } = await supabase
      .from('plan_overhead_lines')
      .update({ ...rest, updated_at: new Date().toISOString() })
      .eq('id', id);
    if (error) throw error;
    return id;
  } else {
    const { data, error } = await supabase
      .from('plan_overhead_lines')
      .insert(line)
      .select()
      .single();
    if (error) throw error;
    return data.id;
  }
}

export async function deleteOverheadLine(id) {
  const { error } = await supabase.from('plan_overhead_lines').delete().eq('id', id);
  if (error) throw error;
}

// --- Data sources ---

export async function loadBaseMonthlyRevenue() {
  const { data, error } = await supabase
    .from('live_billing')
    .select('monthly_net, status')
    .eq('status', 'active');
  if (error) throw error;
  const total = (data || []).reduce((s, b) => s + (Number(b.monthly_net) || 0), 0);
  return { monthly: total, count: (data || []).length };
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
  const { data, error } = await supabase
    .from('plan_qbo_pl_cache')
    .select('*')
    .order('period_end', { ascending: false });
  if (error) throw error;
  return data || [];
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
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`QBO pull failed: ${resp.status} ${body}`);
  }
  return resp.json();
}

// Seed a new scenario from current staff + (optional) QBO cache
export async function seedScenarioFromCurrent(scenarioId) {
  // Seed staff lines from active staff profiles
  const staff = await loadStaffProfiles();
  const existing = await loadStaffLines(scenarioId);
  if (existing.length === 0 && staff.length > 0) {
    const rows = staff.map((s, i) => ({
      scenario_id: scenarioId,
      staff_id: s.id,
      name: s.name,
      role: null,
      annual_salary: 0,
      on_costs_pct: null,
      sort_order: i,
    }));
    await supabase.from('plan_staff_lines').insert(rows);
  }

  // Seed overhead lines from most recent QBO cache
  const cached = await loadCachedPL();
  const existingOverheads = await loadOverheadLines(scenarioId);
  if (existingOverheads.length === 0 && cached.length > 0) {
    const latestPeriod = cached[0].period_end;
    const expenseRows = cached.filter((r) => r.period_end === latestPeriod && r.account_type !== 'Income');
    const rows = expenseRows.map((r, i) => ({
      scenario_id: scenarioId,
      category: r.account_name,
      qbo_account: r.account_name,
      monthly_amount: Math.round((Number(r.amount) / 12) * 100) / 100,
      qbo_actual_ltm: r.amount,
      sort_order: i,
    }));
    if (rows.length > 0) {
      await supabase.from('plan_overhead_lines').insert(rows);
    }
  }
}
