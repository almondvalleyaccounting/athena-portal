import { getServiceClient, qboFetch, jsonResponse, corsHeaders } from "../_shared/qbo-client.ts";

// Refresh qbo_next_run_date on a set of live_billing rows by fetching
// each linked RecurringTransaction template from QBO and reading
// RecurringInfo.NextDate (falling back to ScheduleInfo.NextDate).
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

  const updates: Array<{ billing_id: string; next_run: string | null; error?: string }> = [];
  for (const row of rows || []) {
    try {
      const resp = await qboFetch(`recurringtransaction/${row.qbo_recurring_txn_id}`);
      if (!resp.ok) {
        updates.push({ billing_id: row.id, next_run: null, error: `${resp.status}` });
        continue;
      }
      const json = await resp.json() as Record<string, unknown>;
      const inner = (json.Invoice || json.SalesReceipt) as Record<string, unknown> | undefined;
      const ri = (inner?.RecurringInfo as Record<string, unknown> | undefined) || {};
      const sched = (ri.ScheduleInfo as Record<string, unknown> | undefined) || {};
      const next = String(ri.NextDate || sched.NextDate || "").slice(0, 10) || null;
      await sb.from("live_billing").update({ qbo_next_run_date: next }).eq("id", row.id);
      updates.push({ billing_id: row.id, next_run: next });
    } catch (e) {
      updates.push({ billing_id: row.id, next_run: null, error: (e as Error).message });
    }
  }

  return jsonResponse({ success: true, updates });
});
