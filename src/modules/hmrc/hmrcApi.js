import { supabase } from '../../lib/supabase';

// Data access for the HMRC module. Everything here reads the v_hmrc_* definer
// views from sql/197 — the `hmrc` schema itself is not served by PostgREST.
//
// Amounts arriving from these views are already POUNDS (the views divide the
// scraper's pence). Nothing in this module should ever divide by 100 again.

export async function fetchSchemes() {
  const { data, error } = await supabase
    .from('v_hmrc_paye_clients')
    .select('*')
    .order('total_debt', { ascending: false, nullsFirst: false });
  if (error) throw error;
  return data || [];
}

// A client can hold more than one PAYE scheme (the scrape raises a
// `second_scheme` exception when it spots one), so this returns a list.
export async function fetchSchemesForEntity(entityId) {
  const { data, error } = await supabase
    .from('v_hmrc_paye_clients')
    .select('*')
    .eq('entity_id', entityId)
    .order('total_debt', { ascending: false, nullsFirst: false });
  if (error) throw error;
  return data || [];
}

export async function fetchLastRun() {
  const { data, error } = await supabase
    .from('v_hmrc_runs')
    .select('*')
    .order('started_at', { ascending: false })
    .limit(1);
  if (error) throw error;
  return (data || [])[0] || null;
}

// The four drill-down sets for one scheme, in one round trip.
export async function fetchSchemeDetail(payeRef) {
  const [overdue, months, payments, credits] = await Promise.all([
    supabase.from('v_hmrc_paye_overdue').select('*').eq('paye_ref', payeRef)
      .order('due_date', { ascending: true, nullsFirst: false }),
    supabase.from('v_hmrc_paye_months').select('*').eq('paye_ref', payeRef)
      .order('tax_month', { ascending: true }),
    supabase.from('v_hmrc_paye_payments').select('*').eq('paye_ref', payeRef)
      .order('received_on', { ascending: false, nullsFirst: false }),
    supabase.from('v_hmrc_paye_credits').select('*').eq('paye_ref', payeRef)
      .order('tax_month', { ascending: true, nullsFirst: false }),
  ]);
  const err = overdue.error || months.error || payments.error || credits.error;
  if (err) throw err;
  return {
    overdue: overdue.data || [],
    months: months.data || [],
    payments: payments.data || [],
    credits: credits.data || [],
  };
}

export async function saveReview({ payeRef, status, notes, staffId }) {
  const row = {
    paye_ref: payeRef,
    service: 'paye',
    updated_at: new Date().toISOString(),
  };
  if (status !== undefined) {
    row.status = status;
    row.reviewed_at = new Date().toISOString();
    row.reviewed_by = staffId || null;
  }
  if (notes !== undefined) row.notes = notes;

  const { error } = await supabase
    .from('hmrc_debt_reviews')
    .upsert(row, { onConflict: 'paye_ref' });
  if (error) throw error;
}

export async function fetchExceptions() {
  const { data, error } = await supabase
    .from('v_hmrc_link_exceptions')
    .select('*')
    .order('kind', { ascending: true })
    .order('hmrc_name', { ascending: true });
  if (error) throw error;
  return data || [];
}

export async function setExceptionResolved(id, resolved) {
  const { error } = await supabase.rpc('hmrc_set_exception_resolved', {
    p_id: id, p_resolved: resolved,
  });
  if (error) throw error;
}

export async function setExceptionNote(id, note) {
  const { error } = await supabase.rpc('hmrc_set_exception_note', {
    p_id: id, p_note: note || '',
  });
  if (error) throw error;
}

// Balance Analysis reads two views: one row per scheme per tax year for the
// bridge, and one row per assessed line for the make-up of a charge.
//
// Both come back in pounds like everything else here. The line view is a few
// thousand rows across the practice, which is small enough to pull once and
// pivot in the browser rather than round-tripping per client as you drill.
export async function fetchBalanceByYear() {
  const { data, error } = await supabase
    .from('v_hmrc_paye_balance')
    .select('*')
    .order('paye_ref', { ascending: true })
    .order('tax_year', { ascending: true });
  if (error) throw error;
  return data || [];
}

export async function fetchChargeLines() {
  const { data, error } = await supabase
    .from('v_hmrc_paye_charge_lines')
    .select('*')
    .order('tax_month', { ascending: true });
  if (error) throw error;
  return data || [];
}

export async function fetchAuthorisations() {
  const { data, error } = await supabase
    .from('v_hmrc_authorisation_review')
    .select('*')
    .order('last_known_debt', { ascending: false, nullsFirst: false })
    .order('hmrc_name', { ascending: true });
  if (error) throw error;
  return data || [];
}

export async function closeAuthorisation(id, note) {
  const { error } = await supabase.rpc('hmrc_close_authorisation_review', {
    p_id: id, p_note: note || null,
  });
  if (error) throw error;
}

export async function reopenAuthorisation(id) {
  const { error } = await supabase.rpc('hmrc_reopen_authorisation_review', { p_id: id });
  if (error) throw error;
}
