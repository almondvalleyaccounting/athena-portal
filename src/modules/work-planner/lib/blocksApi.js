import { supabase } from '../../../lib/supabase';

// Standing blocks (sql/312) are written through the standing-blocks edge
// function; the browser only reads them.

export const BLOCK_KINDS = [
  { id: 'mail',                    label: 'Mail handling',           service: 'Admin',               hours: 1 },
  { id: 'onboarding',              label: 'Onboarding',              service: 'Admin',               hours: 2 },
  { id: 'confirmation_statements', label: 'Confirmation statements', service: 'Company Secretarial', hours: 2 },
  { id: 'payroll_weekly',          label: 'Weekly payroll',          service: 'Payroll',             hours: 3, byClient: true },
  { id: 'payroll_monthly',         label: 'Monthly payroll',         service: 'Payroll',             hours: 4, byClient: true },
  { id: 'bookkeeping',             label: 'Bookkeeping',             service: 'Bookkeeping',         hours: 3, byClient: true },
  { id: 'admin',                   label: 'Admin',                   service: 'Admin',               hours: 1 },
  { id: 'other',                   label: 'Other',                   service: 'Admin',               hours: 1 },
];
export const kindOf = (id) => BLOCK_KINDS.find((k) => k.id === id) || BLOCK_KINDS[BLOCK_KINDS.length - 1];

export const BLOCK_CADENCES = [
  { id: 'daily',   label: 'Every working day' },
  { id: 'days',    label: 'Certain days each week' },
  { id: 'monthly', label: 'Monthly, from the start date' },
];

export function cadenceLabel(block) {
  if (block.recurrence === 'monthly') return `Monthly on the ${new Date(block.planned_date).getDate()}${ordinal(new Date(block.planned_date).getDate())}`;
  const days = (block.weekdays || 'mon,tue,wed,thu,fri').split(',').filter(Boolean);
  if (days.length === 5 && !days.includes('sat') && !days.includes('sun')) return 'Every working day';
  return days.map((d) => d.charAt(0).toUpperCase() + d.slice(1)).join(', ');
}
function ordinal(n) { const s = ['th', 'st', 'nd', 'rd']; const v = n % 100; return s[(v - 20) % 10] || s[v] || s[0]; }

export async function callStandingBlocks(payload) {
  const { data, error } = await supabase.functions.invoke('standing-blocks', { body: payload });
  if (error || !data?.success) {
    let msg = data?.error || 'Could not save';
    try { const j = await error?.context?.json?.(); if (j?.error) msg = j.error; } catch { /* body already read */ }
    throw new Error(msg);
  }
  return data;
}

export async function fetchBlockItems() {
  const { data, error } = await supabase.from('standing_block_items').select('*').order('sort_order').limit(5000);
  if (error) throw error;
  return data || [];
}

// The clients a person runs payroll (or another service) for, from the BM
// jobs they hold and the service allocations. Suggestions for a block's list.
export async function suggestClients(assigneeId, kindId) {
  const service = kindId === 'bookkeeping' ? 'Bookkeeping' : 'Payroll';
  const allocService = kindId === 'bookkeeping' ? 'bookkeeping_vat' : 'payroll';
  const [{ data: bm }, { data: alloc }] = await Promise.all([
    supabase.from('bm_task_schedule').select('entity_id, entities(name, entity_status)').eq('service', service).eq('state', 'planned').eq('assignee_id', assigneeId).limit(500),
    supabase.from('client_service_allocations').select('entity_id, entities(name, entity_status)').eq('service_id', allocService).eq('fee_earner_id', assigneeId).limit(500),
  ]);
  const seen = new Map();
  [...(bm || []), ...(alloc || [])].forEach((r) => {
    if (!r.entity_id || !r.entities || ['nlac', 'archived'].includes(r.entities.entity_status)) return;
    if (!seen.has(r.entity_id)) seen.set(r.entity_id, r.entities.name);
  });
  return [...seen.entries()].map(([entity_id, name]) => ({ entity_id, name })).sort((a, b) => a.name.localeCompare(b.name));
}
