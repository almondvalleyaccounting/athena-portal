import { supabase } from './supabase';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;

/** Get QBO connection status */
export async function getQboStatus() {
  const { data, error } = await supabase.functions.invoke('qbo-status');
  if (error) throw error;
  return data;
}

/** Push a billing record to QBO */
export async function pushToQbo(billingId, initiatedBy) {
  const { data, error } = await supabase.functions.invoke('qbo-push', {
    body: { billing_id: billingId, initiated_by: initiatedBy },
  });
  if (error) throw error;
  return data;
}

/** Pull recurring invoices from QBO into live_billing */
export async function pullFromQbo(initiatedBy) {
  const { data, error } = await supabase.functions.invoke('qbo-pull', {
    body: { initiated_by: initiatedBy },
  });
  if (error) throw error;
  return data;
}

/** Disconnect from QBO */
export async function disconnectQbo() {
  const { data, error } = await supabase.functions.invoke('qbo-auth', {
    body: { action: 'disconnect' },
  });
  if (error) throw error;
  return data;
}

/** Get the QBO OAuth authorization URL */
export function getQboAuthUrl(userId) {
  return `${SUPABASE_URL}/functions/v1/qbo-auth?action=authorize&user_id=${encodeURIComponent(userId)}`;
}
