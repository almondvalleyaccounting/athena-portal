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
  // For the review (dry-run) step before a commit is written, the recurring
  // lines are passed inline so qbo-push can build a plan without a saved
  // live_billing row.
  if (opts.services) body.services = opts.services;
  if (opts.alsoPushSetup) body.also_push_setup = true;
  if (opts.recurringStartDate) body.recurring_start_date = opts.recurringStartDate;
  if (opts.sendSetupNow) body.send_setup_now = true;
  if (opts.billEmail) body.bill_email = opts.billEmail;
  if (opts.dueDateOffsetDays != null) body.due_date_offset_days = opts.dueDateOffsetDays;
  if (opts.dryRun) body.dry_run = true;

  const { data, error } = await supabase.functions.invoke('qbo-push', { body });
  if (error) {
    // supabase-js wraps a non-2xx response in a FunctionsHttpError and hides
    // the body on error.context. That body carries the real reason (e.g.
    // missing_mappings / missing_contact), so surface it rather than the
    // generic "Edge Function returned a non-2xx status code" message.
    let payload = null;
    try {
      payload = error.context && typeof error.context.json === 'function' ? await error.context.json() : null;
    } catch { /* response wasn't JSON */ }
    if (payload && typeof payload === 'object') return payload;
    return { success: false, error: error.message || 'QBO request failed' };
  }
  return data;
}

/** Push one-off Billing module items (billing_items) to QBO as invoices.
 *  send=true emails the invoice immediately; send=false creates a draft.
 *  sendMap ({ [billingItemId]: boolean }) overrides `send` per item, so one
 *  batch can mix invoices to email now with drafts to send later.
 *  dryRun=true returns a read-only plan (no QBO/DB writes) for confirmation. */
export async function pushBillingItems(billingItemIds, send, initiatedBy, dryRun = false, dueDays = 14, sendMap = null) {
  const { data, error } = await supabase.functions.invoke('qbo-push-billing-items', {
    body: { billing_item_ids: billingItemIds, send, send_map: sendMap || undefined, initiated_by: initiatedBy, dry_run: dryRun, due_days: dueDays },
  });
  if (error) throw error;
  return data;
}

/** One-off: ask QBO to assign numbers to pushed invoices left blank by the
 *  old "custom transaction numbers" setting. Pass ids, or omit for all blank. */
export async function assignInvoiceNumbers(billingItemIds) {
  const { data, error } = await supabase.functions.invoke('qbo-push-billing-items', {
    body: { assign_numbers: true, billing_item_ids: billingItemIds || [] },
  });
  if (error) throw error;
  return data;
}

/** Read QBO sales preferences — currently just whether "Custom transaction
 *  numbers" is on (which leaves API-created invoices without a number). */
export async function fetchQboSettings() {
  const { data, error } = await supabase.functions.invoke('qbo-push-billing-items', {
    body: { check_settings: true },
  });
  if (error) throw error;
  return data;
}

/** Pull the last 24 months of a client's QBO invoices (with line detail)
 *  so a past invoice can be copied into a new bill. */
export async function fetchClientInvoices(entityId) {
  const { data, error } = await supabase.functions.invoke('qbo-push-billing-items', {
    body: { list_invoices: true, entity_id: entityId },
  });
  if (error) throw error;
  return data;
}

/** Re-confirm invoice number + email status from QBO for pushed billing
 *  items. Pass ids to refresh specific rows, or omit to refresh all pushed. */
export async function refreshBillingItems(billingItemIds, initiatedBy) {
  const { data, error } = await supabase.functions.invoke('qbo-push-billing-items', {
    body: { refresh: true, billing_item_ids: billingItemIds || [], initiated_by: initiatedBy },
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

/** Get the QBO OAuth authorization URL for reports/dashboard (separate
 *  connection). Pass returnTo (a relative app path, e.g. '/client-dashboard')
 *  to land back there after the OAuth round-trip instead of the default /reports. */
export function getReportsAuthUrl(userId, returnTo) {
  const rt = returnTo ? `&return_to=${encodeURIComponent(returnTo)}` : '';
  return `${SUPABASE_URL}/functions/v1/qbo-auth?action=authorize&user_id=${encodeURIComponent(userId)}&purpose=reports${rt}`;
}
