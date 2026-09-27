// Writes behind Staff & Permissions go through the staff-access edge function
// (portal admins only). Reads are direct: the tables are SELECT-only for the
// browser and their policies show an admin everyone's rows.

import { supabase } from '../../lib/supabase';
import { fetchAllRows } from '../../lib/fetchAllRows';

export async function staffAccess(action, body = {}) {
  const { data: { session } } = await supabase.auth.getSession();
  const resp = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/staff-access`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
    body: JSON.stringify({ action, ...body }),
  });
  const result = await resp.json().catch(() => ({}));
  if (!resp.ok || !result.success) throw new Error(result.error || `Couldn't save (${resp.status})`);
  return result;
}

export async function loadAccessData() {
  const [meta, access, counts, setting] = await Promise.all([
    supabase.from('app_modules').select('key, parent_key, grantable, status'),
    fetchAllRows(() => supabase.from('staff_module_access').select('staff_id, module_key, level').order('staff_id').order('module_key')),
    supabase.from('v_staff_client_access_counts').select('staff_id, clients_on, clients_total'),
    supabase.from('app_settings').select('setting_value').eq('setting_key', 'new_client_figures_default').maybeSingle(),
  ]);
  if (meta.error) throw meta.error;
  if (counts.error) throw counts.error;
  const byStaff = {};
  for (const r of access) (byStaff[r.staff_id] ||= {})[r.module_key] = r.level;
  return {
    meta: Object.fromEntries((meta.data || []).map((r) => [r.key, { parent: r.parent_key, grantable: r.grantable, status: r.status }])),
    access: byStaff,
    counts: Object.fromEntries((counts.data || []).map((r) => [r.staff_id, r])),
    newClientDefault: setting.data ? setting.data.setting_value !== false : true,
  };
}

export async function loadClients() {
  return fetchAllRows(() => supabase.from('entities').select('id, name, manager, entity_status').order('name').order('id'));
}

export async function loadClientAccess(staffId) {
  const rows = await fetchAllRows(() => supabase.from('staff_client_access')
    .select('entity_id, enabled').eq('staff_id', staffId).order('entity_id'));
  return Object.fromEntries(rows.map((r) => [r.entity_id, r.enabled]));
}
