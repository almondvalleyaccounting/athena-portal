import { supabase } from './supabase';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;

/** Get QBO connection status */
export async function getQboStatus() {
  const { data, error } = await supabase.functions.invoke('qbo-status');
  if (error) throw error;
  return data;
}

/**
 * Push a billing record to QBO.
 *
 * `opts` mirrors the qbo-push edge function contract:
 *   mode: 'flat_invoice' | 'recurring_template' | 'setup_invoice_only'
 *   quoteId: needed for setup lines and recurring template
 *   alsoPushSetup: also create a one-off setup invoice from the quote's
 *                  non-recurring lines (used with recurring_template)
 *   recurringStartDate: ISO date for the recurring schedule start
 *   sendSetupNow: email the one-off setup invoice immediately (else draft)
 *   dryRun: return a read-only plan (no QBO/DB writes) for confirmation
 */
export async function pushToQbo(billingId, initiatedBy, opts = {}) {
  const body = { billing_id: billingId, initiated_by: initiatedBy };
  if (opts.mode) body.mode = opts.mode;
  if (opts.quoteId) body.quote_id = opts.quoteId;
  if (opts.alsoPushSetup) body.also_push_setup = true;
  if (opts.recurringStartDate) body.recurring_start_date = opts.recurringStartDate;
  if (opts.sendSetupNow) body.send_setup_now = true;
  if (opts.dryRun) body.dry_run = true;

  const { data, error } = await supabase.functions.invoke('qbo-push', { body });
  if (error) throw error;
  return data;
}

/** Push one-off Billing module items (billing_items) to QBO as invoices.
 *  send=true emails the invoice immediately; send=false creates a draft.
 *  dryRun=true returns a read-only plan (no QBO/DB writes) for confirmation. */
export async function pushBillingItems(billingItemIds, send, initiatedBy, dryRun = false) {
  const { data, error } = await supabase.functions.invoke('qbo-push-billing-items', {
    body: { billing_item_ids: billingItemIds, send, initiated_by: initiatedBy, dry_run: dryRun },
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

/** Get the QBO OAuth authorization URL (billing connection) */
export function getQboAuthUrl(userId) {
  return `${SUPABASE_URL}/functions/v1/qbo-auth?action=authorize&user_id=${encodeURIComponent(userId)}`;
}

/** Get the QBO OAuth authorization URL for reports (separate connection) */
export function getReportsAuthUrl(userId) {
  return `${SUPABASE_URL}/functions/v1/qbo-auth?action=authorize&user_id=${encodeURIComponent(userId)}&purpose=reports`;
}
