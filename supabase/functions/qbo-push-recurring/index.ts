import { getServiceClient, qboFetch, recurringInner, logSync, jsonResponse, corsHeaders } from "../_shared/qbo-client.ts";
import { requireStaffOrService, authErrorResponse } from "../_shared/require-staff.ts";

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

  // This rewrites what clients are billed every month, from caller-supplied
  // ids, and had no check of its own — so verify_jwt alone left it open to
  // anyone holding the anon key out of the frontend bundle. Its two siblings,
  // qbo-push and qbo-push-billing-items, have always required staff; this one
  // was simply missed. Only the two browser pages call it, both with the
  // signed-in user's JWT.
  let callerUserId: string | null = null;
  try {
    callerUserId = (await requireStaffOrService(req)).userId;
  } catch (err) {
    return authErrorResponse(err, corsHeaders());
  }

  let body: { billing_ids?: string[]; all_pending?: boolean; dry_run?: boolean; initiated_by?: string };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ success: false, error: "Invalid JSON" }, 400);
  }

  const sb = getServiceClient();

  // Who to credit: the authenticated staff member. body.initiated_by is
  // caller-supplied and so forgeable, and stands in only for a service-role
  // caller, which has no user of its own.
  const initiatedBy = callerUserId ?? body.initiated_by ?? null;

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

  // Service → QBO item map, plus the connection's VAT code. Both are
  // needed only when a pending service has to be ADDED to a template
  // rather than repriced on it, but one query up front beats one per row.
  const serviceIds = new Set<string>();
  for (const r of rows) {
    for (const s of ((r.services as Array<Record<string, unknown>>) || [])) {
      if (s.pending_monthly_amount != null && s.service_id) serviceIds.add(String(s.service_id));
    }
  }
  const itemMap = await loadItemMappings(sb, Array.from(serviceIds));
  const { data: conn } = await sb
    .from("qbo_connections")
    .select("default_tax_code_id")
    .eq("status", "active")
    .maybeSingle();
  const defaultTaxCodeId = (conn?.default_tax_code_id as string | null) || null;

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

    // Carry each pending service's index: step 5 must clear the pending
    // fields of exactly the ones this push got into QBO, and no others.
    // It used to clear every one of them whenever the row pushed at all,
    // so a service QBO never received still read locally as billed.
    const pending = services
      .map((s, i) => ({ s, i }))
      .filter(({ s }) => s.pending_monthly_amount != null);
    if (pending.length === 0) {
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
      // The read endpoint nests the txn under RecurringTransaction; the query
      // endpoint does not. This used to look only at the query shape, so every
      // staged uplift push failed here with "missing Invoice/SalesReceipt".
      const found = recurringInner(getBody);
      if (!found) throw new Error("RecurringTransaction response missing Invoice/SalesReceipt");
      const { key: innerKey, txn: template } = found;

      const recurringInfo = (template.RecurringInfo as Record<string, unknown> | undefined) || {};
      const schedule = (recurringInfo.ScheduleInfo as Record<string, unknown> | undefined)
        || (template.ScheduleInfo as Record<string, unknown> | undefined);
      const factor = monthlyFactor(schedule);
      const reverseFactor = 1 / factor; // monthly → per-occurrence

      // 3. Reprice existing lines. Match each QBO line to a local service
      //    by QBO item id first, then ItemRef.name (== service_id from
      //    pull), then description. Item id leads because a QBO item
      //    renamed since the pull no longer matches by name — and a
      //    near-miss now costs more than no change: step 3b would read the
      //    fee as absent and add a second line for it.
      const existingLines = (template.Line as Array<Record<string, unknown>>) || [];
      const matchLog: Array<Record<string, unknown>> = [];
      const committed = new Set<number>(); // services this push actually got into QBO
      const newLines = existingLines.map((line) => {
        if (line.DetailType !== "SalesItemLineDetail") return line;
        const detail = (line.SalesItemLineDetail as Record<string, unknown>) || {};
        const itemRef = (detail.ItemRef as Record<string, unknown>) || {};
        const itemId = String(itemRef.value || "");
        const itemName = String(itemRef.name || "");
        const desc = String(line.Description || "");

        const hit = pending.find(({ s }) => {
          const mapped = itemMap[String(s.service_id || "")];
          if (mapped && itemId && mapped.qbo_item_id === itemId) return true;
          if (s.service_id && s.service_id === itemName) return true;
          if (s.description && s.description === desc) return true;
          return false;
        });
        if (!hit) return line;

        const newMonthly = Number(hit.s.pending_monthly_amount);
        const newPerOccurrence = Math.round(newMonthly * reverseFactor * 100) / 100;
        committed.add(hit.i);
        matchLog.push({
          action: "repriced",
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

      // 3b. Add lines for pending services the template does not carry.
      //     A fee that is NEW to the client is not a raise on an existing
      //     line, so there is nothing to overwrite — and repricing was all
      //     this function could do, which meant such a row could never be
      //     pushed at all. It reported "Skipped: 1" and sat approved for
      //     ever (Orthopaedic Consultancy, Fee Protection Insurance,
      //     2026-08-28). Every refusal below names itself: a fee that
      //     quietly fails to reach QBO is a fee we never bill.
      const blocked: string[] = [];
      const takenItemIds = new Set(
        existingLines
          .filter((l) => l.DetailType === "SalesItemLineDetail")
          .map((l) => String(
            (((l.SalesItemLineDetail as Record<string, unknown>)?.ItemRef as Record<string, unknown>)?.value) || "",
          ))
          .filter(Boolean),
      );

      // VAT on a new line: use the code the template's own lines already
      // carry — that is this client's setting, not ours — then the
      // connection default. Never add a line without one: QBO accepts a
      // missing TaxCodeRef and silently bills zero VAT, the same trap
      // qbo-push refuses to walk into.
      const siblingTaxRef = existingLines
        .filter((l) => l.DetailType === "SalesItemLineDetail")
        .map((l) => ((l.SalesItemLineDetail as Record<string, unknown>)?.TaxCodeRef as Record<string, unknown> | undefined))
        .find((ref) => ref && ref.value);
      const taxRef = siblingTaxRef || (defaultTaxCodeId ? { value: defaultTaxCodeId } : null);

      for (const { s, i } of pending) {
        if (committed.has(i)) continue;
        const label = String(s.description || s.service_id || "a service");
        const prefix = `${label}: not on the QBO template`;
        const mapping = itemMap[String(s.service_id || "")];
        const monthly = Number(s.pending_monthly_amount);
        const cadence = String(s.cadence || "monthly");
        const approval = String(s.approval_status || "approved");

        if (approval !== "approved") {
          blocked.push(`${prefix}, and approval_status=${approval} — no line added`);
        } else if (s.recurring_status === "ending") {
          blocked.push(`${prefix}, and the service is ending — no line added`);
        } else if (cadence !== "monthly") {
          blocked.push(`${prefix}, and it is a ${cadence} service — only monthly lines belong on a recurring template`);
        } else if (!(monthly > 0)) {
          blocked.push(`${prefix}, and the pending amount is ${monthly} — nothing to add`);
        } else if (!mapping?.qbo_item_id) {
          blocked.push(`${prefix}, and service "${s.service_id}" has no QBO item mapping — map it on the Products ↔ QBO tab first`);
        } else if (takenItemIds.has(String(mapping.qbo_item_id))) {
          blocked.push(`${prefix}, yet the template already bills QBO item "${mapping.qbo_item_name || mapping.qbo_item_id}" — fix the mapping rather than risk a duplicate line`);
        } else if (!taxRef) {
          blocked.push(`${prefix}, and neither the template nor the QuickBooks connection carries a VAT code — a line without one bills zero VAT`);
        } else {
          const perOccurrence = Math.round(monthly * reverseFactor * 100) / 100;
          takenItemIds.add(String(mapping.qbo_item_id));
          committed.add(i);
          newLines.push({
            DetailType: "SalesItemLineDetail",
            Amount: perOccurrence,
            Description: String(s.description || mapping.default_description || mapping.qbo_item_name || s.service_id),
            SalesItemLineDetail: {
              ItemRef: { value: mapping.qbo_item_id, name: mapping.qbo_item_name || undefined },
              Qty: 1,
              UnitPrice: perOccurrence,
              TaxCodeRef: taxRef,
            },
          });
          matchLog.push({
            action: "added",
            item: mapping.qbo_item_name || String(s.service_id || label),
            old_per_occurrence: 0,
            new_per_occurrence: perOccurrence,
            new_monthly: monthly,
          });
        }
      }

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
          added_count: matchLog.filter((m) => m.action === "added").length,
          repriced_count: matchLog.filter((m) => m.action === "repriced").length,
          blocked,
          changes: matchLog,
          proposed: proposedBody,
        });
        continue;
      }

      if (matchLog.length === 0) {
        skipped++;
        results.push({
          billing_id: billing.id,
          entity: entityName,
          status: "skipped",
          reason: blocked.length
            ? blocked.join("; ")
            : "no QBO line matched the pending service and none could be added",
          blocked,
        });
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

      // 5. Swap local state: pending → current, clear pending fields —
      //    but only for the services this push actually got into QBO. A
      //    service left behind (nothing to reprice, and blocked from being
      //    added) keeps its pending amount, so the row comes back to the
      //    Push tab with the work still on it. Clearing it would have left
      //    Athena billing a fee QBO had never heard of.
      const newServices = services.map((s, i) => {
        if (s.pending_monthly_amount == null || !committed.has(i)) return s;
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
      results.push({
        billing_id: billing.id,
        entity: entityName,
        status: "pushed",
        match_count: matchLog.length,
        added_count: matchLog.filter((m) => m.action === "added").length,
        repriced_count: matchLog.filter((m) => m.action === "repriced").length,
        blocked,
        changes: matchLog,
      });

      await logSync({
        direction: "push",
        entity_id: (entity?.id as string) || null,
        entity_name: entityName,
        qbo_entity_type: "RecurringTransaction",
        qbo_entity_id: txnId,
        status: "success",
        detail: { billing_id: billing.id, changes: matchLog },
        initiated_by: initiatedBy,
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
        initiated_by: initiatedBy,
      });
    }
  }

  return jsonResponse({
    success: true,
    summary: { total: rows.length, pushed, skipped, errored },
    results,
  });
});

// Service → QBO item map (qbo_service_items). The one map, as everywhere
// else: never a name guessed against the QBO catalogue.
type ItemMapping = { qbo_item_id: string; qbo_item_name: string | null; default_description: string | null };

async function loadItemMappings(
  sb: ReturnType<typeof getServiceClient>,
  serviceIds: string[],
): Promise<Record<string, ItemMapping>> {
  if (serviceIds.length === 0) return {};
  const { data } = await sb
    .from("qbo_service_items")
    .select("service_id, qbo_item_id, qbo_item_name, default_description")
    .in("service_id", serviceIds);
  const map: Record<string, ItemMapping> = {};
  for (const row of data || []) {
    map[row.service_id as string] = {
      qbo_item_id: row.qbo_item_id as string,
      qbo_item_name: (row.qbo_item_name as string | null) ?? null,
      default_description: (row.default_description as string | null) ?? null,
    };
  }
  return map;
}

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
