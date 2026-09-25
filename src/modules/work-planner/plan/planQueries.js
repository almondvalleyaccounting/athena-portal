import { supabase } from '../../../lib/supabase';
import { fetchAllRows } from '../../../lib/fetchAllRows';

// Reads are direct (RLS: active staff). Every write goes through the
// job-plan edge function — the browser holds SELECT only on these tables.

export async function fetchAccountsJobs() {
  return fetchAllRows(() => supabase
    .from('v_accounts_jobs')
    .select('*')
    .order('ch_deadline', { ascending: true, nullsFirst: false })
    .order('entity_id'));
}

export async function fetchAccountsJob(entityId, periodEnd) {
  const { data, error } = await supabase
    .from('v_accounts_jobs')
    .select('*')
    .eq('entity_id', entityId)
    .eq('period_end', periodEnd)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function fetchPlan(planId) {
  const [{ data: plan, error: pErr }, { data: milestones, error: mErr }] = await Promise.all([
    supabase.from('job_plans').select('*').eq('id', planId).maybeSingle(),
    supabase.from('job_milestones').select('*').eq('plan_id', planId).order('seq'),
  ]);
  if (pErr) throw pErr;
  if (mErr) throw mErr;
  return { plan, milestones: milestones || [] };
}

export async function fetchActiveStaff() {
  const { data, error } = await supabase
    .from('staff_profiles')
    .select('id, name, is_active, working_days')
    .eq('is_active', true)
    .order('name');
  if (error) throw error;
  return data || [];
}

/** Call the job-plan function. Resolves to the JSON body; throws on failure. */
export async function callJobPlan(payload) {
  const { data, error } = await supabase.functions.invoke('job-plan', { body: payload });
  if (error || !data?.success) {
    let msg = data?.error || 'Could not save';
    try { const j = await error?.context?.json?.(); if (j?.error) msg = j.error; } catch { /* body already read */ }
    throw new Error(msg);
  }
  return data;
}
