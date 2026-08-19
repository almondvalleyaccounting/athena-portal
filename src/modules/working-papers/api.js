import { supabase } from '../../lib/supabase';

// Data access for Working Papers.
//
// Every read here is capped explicitly. PostgREST silently truncates at ~1000
// rows and returns a 200, so an uncapped select that grows past the cap starts
// quietly reporting a partial figure — which on a working paper is worse than
// an error. Nothing in this file totals in the browser: sums come from SQL.

/** Which clients can have a PAYE paper, and what is stopping the rest. */
export async function fetchPayeReadiness() {
  const { data, error } = await supabase
    .from('v_wp_paye_readiness')
    .select('*')
    .order('entity_name')
    .limit(2000);
  if (error) throw new Error(error.message);
  return data || [];
}

/** The HMRC leg, per tax year, for one client. */
export async function fetchHmrcTaxYears(entityId) {
  const { data, error } = await supabase
    .from('v_wp_paye_tax_year')
    .select('*')
    .eq('entity_id', entityId)
    .order('tax_year', { ascending: false })
    .limit(40);
  if (error) throw new Error(error.message);
  return data || [];
}

/**
 * Every credit line for a client with its recorded-vs-relates-to period.
 *
 * Not filtered to one tax year: a credit RECORDED in 2026-27 that relates to
 * 2022-23 has to be visible from either year's paper, and filtering on the
 * recorded year alone would hide it from the year it actually belongs to.
 */
export async function fetchCreditOrigin(entityId) {
  const { data, error } = await supabase
    .from('v_wp_paye_credit_origin')
    .select('*')
    .eq('entity_id', entityId)
    .order('recorded_tax_year', { ascending: false })
    .order('recorded_tax_month', { ascending: false })
    .limit(500);
  if (error) throw new Error(error.message);
  return data || [];
}

/** PAYE owed at a date, on the accounting-year footing (sql/239). */
export async function fetchPayeBalanceAt(payeRef, asAt) {
  const { data, error } = await supabase.rpc('hmrc_paye_balance_at', {
    p_paye_ref: payeRef, p_as_at: asAt,
  });
  if (error) throw new Error(error.message);
  return (data || [])[0] || null;
}

/** The QuickBooks leg: mapped-role balances for a client at a date. */
export async function fetchQboRoleBalances(entityId, asAt) {
  let q = supabase.from('v_wp_qbo_role_balance').select('*').eq('entity_id', entityId);
  if (asAt) q = q.eq('as_at', asAt);
  const { data, error } = await q.limit(200);
  if (error) throw new Error(error.message);
  return data || [];
}

/** The BrightPay leg, per tax month. Empty until the runner feeds it. */
export async function fetchBrightpayPeriods(entityId, taxYear) {
  let q = supabase.from('wp_brightpay_period').select('*').eq('entity_id', entityId);
  if (taxYear) q = q.eq('tax_year', taxYear);
  const { data, error } = await q.order('tax_month').limit(200);
  if (error) throw new Error(error.message);
  return data || [];
}

/* ── The nominal mapping ─────────────────────────────────────────── */

export const NOMINAL_ROLES = [
  { role: 'paye_control', label: 'PAYE control',
    hint: 'The PAYE/NIC creditor — what the ledger says is owed to HMRC for payroll.' },
  { role: 'cis_suffered', label: 'CIS suffered',
    hint: 'CIS deducted from the client by its contractors, recoverable against PAYE in the SAME tax year.' },
  { role: 'cis_withheld', label: 'CIS withheld',
    hint: 'CIS the client deducted from its own subcontractors and owes over to HMRC.' },
  { role: 'net_wages', label: 'Net wages',
    hint: 'Net pay owed to employees. The second working paper — BrightPay against the ledger.' },
  { role: 'wages_control', label: 'Wages control',
    hint: 'The clearing account, where the file uses one. Should be nil after a clean month.' },
  { role: 'pension_control', label: 'Pension control',
    hint: 'Employee and employer pension owed to the provider.' },
  { role: 'ct_liability', label: 'Corporation tax',
    hint: 'The CT creditor — for the corporation tax paper, next after PAYE.' },
];

export async function fetchNominalMap(entityId) {
  const { data, error } = await supabase
    .from('wp_nominal_map')
    .select('*')
    .eq('entity_id', entityId)
    .order('role')
    .limit(200);
  if (error) throw new Error(error.message);
  return data || [];
}

export async function fetchQboChart(realmId) {
  const { data, error } = await supabase
    .from('wp_qbo_account')
    .select('account_id, name, fully_qualified, account_type, account_sub_type, classification, active, current_balance')
    .eq('realm_id', realmId)
    .order('fully_qualified')
    .limit(2000);
  if (error) throw new Error(error.message);
  return data || [];
}

export async function addNominalMapping({ entityId, role, accountId, accountName, sign = 1, note = null }) {
  const { data: me } = await supabase.auth.getUser();
  const { error } = await supabase.from('wp_nominal_map').insert({
    entity_id: entityId,
    role,
    qbo_account_id: accountId,
    qbo_account_name: accountName,
    sign,
    note,
    created_by: me?.user?.id ?? null,
  });
  // A duplicate is the user mapping the same account twice, not a fault worth
  // an error banner — the unique constraint is doing its job.
  if (error && !/duplicate key/i.test(error.message)) throw new Error(error.message);
}

export async function removeNominalMapping(id) {
  const { error } = await supabase.from('wp_nominal_map').delete().eq('id', id);
  if (error) throw new Error(error.message);
}

export async function setMappingSign(id, sign) {
  const { error } = await supabase.from('wp_nominal_map')
    .update({ sign, updated_at: new Date().toISOString() }).eq('id', id);
  if (error) throw new Error(error.message);
}

/* ── QuickBooks fetches (edge function) ──────────────────────────── */

async function callWpQbo(body) {
  const { data: session } = await supabase.auth.getSession();
  const token = session?.session?.access_token;
  const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/wp-qbo-accounts`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
    },
    body: JSON.stringify(body),
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok || json.success === false) {
    throw new Error(json.error || `QuickBooks call failed (${resp.status})`);
  }
  return json;
}

/** Refresh the cached chart of accounts for a realm. */
export const pullQboChart = (realmId) => callWpQbo({ mode: 'chart', realm_id: realmId });

/** Value the mapped nominals at a date. */
export const pullQboBalances = (realmId, asAt) =>
  callWpQbo({ mode: 'balances', realm_id: realmId, as_at: asAt });

/* ── Sign-off ────────────────────────────────────────────────────── */

export async function fetchSignoff(paper, entityId, periodEnd) {
  const { data, error } = await supabase
    .from('wp_signoff')
    .select('*')
    .eq('paper', paper).eq('entity_id', entityId).eq('period_end', periodEnd)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

export async function saveSignoff({ paper, entityId, periodEnd, state, note, variance }) {
  const { data: me } = await supabase.auth.getUser();
  const now = new Date().toISOString();
  const row = {
    paper, entity_id: entityId, period_end: periodEnd, state, note,
    variance_at_signoff: variance ?? null,
    updated_at: now,
  };
  // Preparation and review are different acts by different people, so the
  // stamps are not interchangeable — signing off records a reviewer, anything
  // else records a preparer.
  if (state === 'signed_off') { row.reviewed_by = me?.user?.id ?? null; row.reviewed_at = now; }
  else { row.prepared_by = me?.user?.id ?? null; row.prepared_at = now; }
  const { error } = await supabase.from('wp_signoff')
    .upsert(row, { onConflict: 'paper,entity_id,period_end' });
  if (error) throw new Error(error.message);
}
