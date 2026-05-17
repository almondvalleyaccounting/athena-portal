import { getServiceClient, qboFetch, logSync, jsonResponse, corsHeaders } from "../_shared/qbo-client.ts";

// Push staged fee uplifts (pending_monthly_amount on each service)
// out to the corresponding QBO RecurringTransaction template. We
// fetch the existing template, swap line amounts to the pending
// values, then POST it back — preserving the schedule, customer,
// memo, and everything else QBO already has.
//
// Inputs:
//   { billing_ids: string[]  }  → push these rows
//   { all_pending: true       }  → push every active row with at
//                                  least one pending uplift
//   { dry_run: true           }  → return proposed bodies, don't POST
//
// On success per row: monthly_amount is set to pending_monthly_amount
// and the pending_* fields are cleared. last_synced_qbo is stamped.
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }
  if (req.method !== "POST") {
    return jsonResponse({ success: false, error: "POST required" }, 405);
  }

  let body: { billing_ids?: string[]; all_pending?: boolean; dry_run?: boolean; initiated_by?: string };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ success: false, error: "Invalid JSON" }, 400);
  }

  const sb = getServiceClient();

  // 1. Resolve target rows.
  let rows: Array<Record<string, unknown>> = [];
  if (body.all_pending) {
    const { data, error } = await sb
      .from("live_billing")
      .select("*, entity:entities(id, name, qbo_customer_id)")
      .eq("status", "active")
      .not("qbo_recurring_txn_id", "is", null);
    if (error) return jsonResponse({ success: false, error: error.message }, 500);
    rows = (data || []).filter((r) =>
      Array.isArray(r.services) && (r.services as Array<Record<string, unknown>>).some((s) => s.pending_monthly_amount != null)
    );
  } else if (Array.isArray(body.billing_ids) && body.billing_ids.length) {
    const { data, error } = await sb
      .from("live_billing")
      .select("*, entity:entities(id, name, qbo_customer_id)")
      .in("id", body.billing_ids);
    if (error) return jsonResponse({ success: false, error: error.message }, 500);
    rows = data || [];
  } else {
    return jsonResponse({ success: false, error: "Provide billing_ids or all_pending" }, 400);
  }

  const results: Array<Record<string, unknown>> = [];
  let pushed = 0, skipped = 0, errored = 0;

  for (const row of rows) {
    const billing = row as Record<string, unknown>;
    const entity = (billing.entity as Record<string, unknown> | null) || null;
    const entityName = (entity?.name as string) || "Unknown";
    const txnId = billing.qbo_recurring_txn_id as string | null;
    const services = (billing.services as Array<Record<string, unknown>>) || [];

    if (!txnId) {
      skipped++;
      results.push({ billing_id: billing.id, entity: entityName, status: "skipped", reason: "no qbo_recurring_txn_id" });
      continue;
    }

    const pendingServices = services.filter((s) => s.pending_monthly_amount != null);
    if (pendingServices.length === 0) {
      skipped++;
      results.push({ billing_id: billing.id, entity: entityName, status: "skipped", reason: "no pending uplifts" });
      continue;
    }

    // Defense in depth: require explicit row-level approval before we
    // overwrite a QBO template. The UI should only call with approved
    // rows, but enforce here too.
    if (billing.uplift_review_status !== "approved") {
      skipped++;
      results.push({ billing_id: billing.id, entity: entityName, status: "skipped", reason: `uplift_review_status=${billing.uplift_review_status || "null"} (not approved)` });
      continue;
    }

    try {
      // 2. Fetch current template from QBO. The recurringtransaction
      //    endpoint can return either { Invoice: {...} } or
      //    { SalesReceipt: {...} } depending on the underlying type.
      const getResp = await qboFetch(`recurringtransaction/${txnId}`);
      if (!getResp.ok) {
        const errText = await getResp.text();
        throw new Error(`GET recurringtransaction/${txnId} failed: ${getResp.status} ${errText}`);
      }
      const getBody = await getResp.json() as Record<string, unknown>;
      const innerKey = getBody.Invoice ? "Invoice" : getBody.SalesReceipt ? "SalesReceipt" : null;
      if (!innerKey) throw new Error("RecurringTransaction response missing Invoice/SalesReceipt");
      const template = getBody[innerKey] as Record<string, unknown>;

      const recurringInfo = (template.RecurringInfo as Record<string, unknown> | undefined) || {};
      const schedule = (recurringInfo.ScheduleInfo as Record<string, unknown> | undefined)
        || (template.ScheduleInfo as Record<string, unknown> | undefined);
      const factor = monthlyFactor(schedule);
      const reverseFactor = 1 / factor; // monthly → per-occurrence

      // 3. Modify lines. Match each existing QBO line to a local
      //    service by ItemRef.name (== service_id from pull) and
      //    description as fallback. Only lines with a matching local
      //    service AND a pending amount get changed.
      const existingLines = (template.Line as Array<Record<string, unknown>>) || [];
      const matchLog: Array<Record<string, unknown>> = [];
      const newLines = existingLines.map((line) => {
        if (line.DetailType !== "SalesItemLineDetail") return line;
        const detail = (line.SalesItemLineDetail as Record<string, unknown>) || {};
        const itemRef = (detail.ItemRef as Record<string, unknown>) || {};
        const itemName = String(itemRef.name || "");
        const desc = String(line.Description || "");

        const match = pendingServices.find((s) => {
          if (s.service_id && s.service_id === itemName) return true;
          if (s.description && s.description === desc) return true;
          return false;
        });
        if (!match) return line;

        const newMonthly = Number(match.pending_monthly_amount);
        const newPerOccurrence = Math.round(newMonthly * reverseFactor * 100) / 100;
        matchLog.push({
          item: itemName || desc,
          old_per_occurrence: Number(line.Amount) || 0,
          new_per_occurrence: newPerOccurrence,
          new_monthly: newMonthly,
        });
        return {
          ...line,
          Amount: newPerOccurrence,
          SalesItemLineDetail: {
            ...detail,
            UnitPrice: newPerOccurrence,
          },
        };
      });

      const proposedBody = {
        [innerKey]: {
          ...template,
          SyncToken: template.SyncToken,
          Line: newLines,
        },
      };

      if (body.dry_run) {
        results.push({
          billing_id: billing.id,
          entity: entityName,
          status: "dry_run",
          match_count: matchLog.length,
          changes: matchLog,
          proposed: proposedBody,
        });
        continue;
      }

      if (matchLog.length === 0) {
        skipped++;
        results.push({ billing_id: billing.id, entity: entityName, status: "skipped", reason: "no QBO lines matched local pending services" });
        continue;
      }

      // 4. POST the update.
      const postResp = await qboFetch("recurringtransaction", {
        method: "POST",
        body: JSON.stringify(proposedBody),
      });
      if (!postResp.ok) {
        const errText = await postResp.text();
        throw new Error(`POST recurringtransaction failed: ${postResp.status} ${errText}`);
      }

      // 5. Swap local state: pending → current, clear pending fields.
      const newServices = services.map((s) => {
        if (s.pending_monthly_amount == null) return s;
        const newMonthly = Number(s.pending_monthly_amount);
        return {
          ...s,
          monthly_amount: newMonthly,
          annual_amount: Math.round(newMonthly * 12 * 100) / 100,
          last_uplift_at: s.pending_uplift_staged_at || new Date().toISOString(),
          last_uplift_reason: s.pending_uplift_reason || null,
          last_uplift_pushed_at: new Date().toISOString(),
          pending_monthly_amount: null,
          pending_effective_at: null,
          pending_uplift_reason: null,
          pending_uplift_staged_at: null,
        };
      });

      const rowMonthlyNet = newServices.reduce((sum: number, sv: Record<string, unknown>) => {
        return sv.cadence === "monthly" && sv.approval_status === "approved"
          ? sum + (Number(sv.monthly_amount) || 0)
          : sum;
      }, 0);
      const rowAnnualTotal = newServices.reduce((sum: number, sv: Record<string, unknown>) => sum + (Number(sv.annual_amount) || 0), 0);

      await sb.from("live_billing").update({
        services: newServices,
        monthly_net: Math.round(rowMonthlyNet * 100) / 100,
        monthly_vat: Math.round(rowMonthlyNet * 0.2 * 100) / 100,
        monthly_gross: Math.round(rowMonthlyNet * 1.2 * 100) / 100,
        annual_total: Math.round(rowAnnualTotal * 100) / 100,
        last_synced_qbo: new Date().toISOString(),
        qbo_sync_status: "synced",
        uplift_review_status: null,
        uplift_reviewed_by: null,
        uplift_reviewed_at: null,
      }).eq("id", billing.id);

      pushed++;
      results.push({ billing_id: billing.id, entity: entityName, status: "pushed", match_count: matchLog.length, changes: matchLog });

      await logSync({
        direction: "push",
        entity_id: (entity?.id as string) || null,
        entity_name: entityName,
        qbo_entity_type: "RecurringTransaction",
        qbo_entity_id: txnId,
        status: "success",
        detail: { billing_id: billing.id, changes: matchLog },
        initiated_by: body.initiated_by || null,
      });
    } catch (err) {
      errored++;
      const message = (err as Error).message;
      results.push({ billing_id: billing.id, entity: entityName, status: "error", error: message });
      await logSync({
        direction: "push",
        entity_id: (entity?.id as string) || null,
        entity_name: entityName,
        qbo_entity_type: "RecurringTransaction",
        qbo_entity_id: txnId,
        status: "error",
        error_message: message,
        detail: { billing_id: billing.id },
        initiated_by: body.initiated_by || null,
      });
    }
  }

  return jsonResponse({
    success: true,
    summary: { total: rows.length, pushed, skipped, errored },
    results,
  });
});

// Same factor logic as qbo-pull — keep in lockstep.
function monthlyFactor(schedule: Record<string, unknown> | undefined): number {
  if (!schedule) return 1;
  const type = String(schedule.IntervalType || "Monthly");
  const n = Math.max(1, Number(schedule.NumInterval || 1));
  switch (type) {
    case "Daily":  return (365 / 12) / n;
    case "Weekly": return (52 / 12) / n;
    case "Yearly": return 1 / (12 * n);
    case "Monthly":
    default:       return 1 / n;
  }
}
