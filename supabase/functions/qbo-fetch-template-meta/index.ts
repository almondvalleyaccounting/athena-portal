import { getServiceClient, qboFetch, recurringInner, jsonResponse, corsHeaders } from "../_shared/qbo-client.ts";

// Refresh qbo_next_run_date on a set of live_billing rows by fetching
// each linked RecurringTransaction template from QBO and reading
// RecurringInfo.NextDate (falling back to ScheduleInfo.NextDate).
//
// Also records whether the template will EMAIL what it bills — BillEmail plus
// EmailStatus 'NeedToSend' — since it already has the template in hand. Both
// fields together are the difference between an invoice the client receives
// and a balance that grows in silence (sql/263, qbo-recurring-delivery).
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });
  if (req.method !== "POST") return jsonResponse({ success: false, error: "POST required" }, 405);

  let body: { billing_ids?: string[] };
  try { body = await req.json(); } catch { return jsonResponse({ success: false, error: "Invalid JSON" }, 400); }

  if (!Array.isArray(body.billing_ids) || body.billing_ids.length === 0) {
    return jsonResponse({ success: false, error: "billing_ids required" }, 400);
  }

  const sb = getServiceClient();
  const { data: rows, error } = await sb
    .from("live_billing")
    .select("id, qbo_recurring_txn_id")
    .in("id", body.billing_ids)
    .not("qbo_recurring_txn_id", "is", null);
  if (error) return jsonResponse({ success: false, error: error.message }, 500);

  const updates: Array<{ billing_id: string; next_run: string | null; will_email?: boolean; error?: string }> = [];
  for (const row of rows || []) {
    try {
      const resp = await qboFetch(`recurringtransaction/${row.qbo_recurring_txn_id}`);
      if (!resp.ok) {
        updates.push({ billing_id: row.id, next_run: null, error: `${resp.status}` });
        continue;
      }
      const json = await resp.json() as Record<string, unknown>;
      // The single-template read nests under RecurringTransaction, unlike the
      // query. Reading json.Invoice directly is why this wrote a null next run
      // date for all 146 templates and still reported success.
      const inner = recurringInner(json)?.txn;
      if (!inner) {
        updates.push({ billing_id: row.id, next_run: null, error: "no Invoice/SalesReceipt in RecurringTransaction response" });
        continue;
      }
      const ri = (inner.RecurringInfo as Record<string, unknown> | undefined) || {};
      const sched = (ri.ScheduleInfo as Record<string, unknown> | undefined) || {};
      const next = String(ri.NextDate || sched.NextDate || "").slice(0, 10) || null;
      const billEmail = String(((inner.BillEmail as Record<string, unknown> | undefined)?.Address) ?? "").trim() || null;
      const emailStatus = String(inner.EmailStatus ?? "").trim() || null;
      await sb.from("live_billing").update({
        qbo_next_run_date: next,
        qbo_bill_email: billEmail,
        qbo_email_status: emailStatus,
        qbo_email_checked_at: new Date().toISOString(),
      }).eq("id", row.id);
      updates.push({ billing_id: row.id, next_run: next, will_email: !!billEmail && emailStatus === "NeedToSend" });
    } catch (e) {
      updates.push({ billing_id: row.id, next_run: null, error: (e as Error).message });
    }
  }

  return jsonResponse({ success: true, updates });
});
