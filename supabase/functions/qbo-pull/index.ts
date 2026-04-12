import { getServiceClient, qboQuery, logSync, jsonResponse, corsHeaders } from "../_shared/qbo-client.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  if (req.method !== "POST") {
    return jsonResponse({ success: false, error: "POST required" }, 405);
  }

  try {
    const body = await req.json().catch(() => ({}));
    const initiatedBy = body.initiated_by || null;

    const sb = getServiceClient();

    // 1. Query QBO for all recurring transactions (invoices)
    const result = await qboQuery("SELECT * FROM RecurringTransaction") as Record<string, unknown>;
    const queryResponse = result?.QueryResponse as Record<string, unknown>;
    const recurringTxns = (queryResponse?.RecurringTransaction || []) as Array<Record<string, unknown>>;

    // Also get regular invoices as fallback
    const invoiceResult = await qboQuery("SELECT * FROM Invoice WHERE Balance > '0'") as Record<string, unknown>;
    const invoiceResponse = invoiceResult?.QueryResponse as Record<string, unknown>;
    const invoices = (invoiceResponse?.Invoice || []) as Array<Record<string, unknown>>;

    // 2. Load all entities for matching
    const { data: entities } = await sb.from("entities").select("id, name, display_name, qbo_customer_id");
    const entityMap = new Map<string, Record<string, unknown>>();
    const entityByQboId = new Map<string, Record<string, unknown>>();

    for (const e of entities || []) {
      entityMap.set((e.name || "").toLowerCase(), e);
      if (e.display_name) entityMap.set(e.display_name.toLowerCase(), e);
      if (e.qbo_customer_id) entityByQboId.set(e.qbo_customer_id, e);
    }

    const stats = { created: 0, updated: 0, skipped: 0, errors: [] as string[] };

    // 3. Process recurring transactions
    for (const txn of recurringTxns) {
      try {
        // Only process invoice-type recurring transactions
        if (txn.TxnType !== "Invoice" && txn.RecurringInfo?.RecurType !== "Invoice") {
          continue;
        }

        const customerRef = txn.CustomerRef as Record<string, unknown> | undefined;
        if (!customerRef) {
          stats.skipped++;
          continue;
        }

        const qboCustomerId = String(customerRef.value);
        const customerName = String(customerRef.name || "Unknown");

        // Match to entity
        const entity = entityByQboId.get(qboCustomerId)
          || entityMap.get(customerName.toLowerCase());

        if (!entity) {
          stats.skipped++;
          await logSync({
            direction: "pull",
            entity_name: customerName,
            qbo_entity_type: "RecurringTransaction",
            qbo_entity_id: String(txn.Id),
            status: "skipped",
            detail: { reason: "No matching entity found", customer_name: customerName },
            initiated_by: initiatedBy,
          });
          continue;
        }

        // Calculate amounts from line items
        const lines = (txn.Line || []) as Array<Record<string, unknown>>;
        const totalAmount = lines.reduce((sum: number, line: Record<string, unknown>) => {
          return sum + (Number(line.Amount) || 0);
        }, 0);

        const monthlyNet = totalAmount;
        const monthlyVat = Math.round(monthlyNet * 0.2 * 100) / 100;
        const monthlyGross = Math.round((monthlyNet + monthlyVat) * 100) / 100;
        const annualTotal = Math.round(monthlyNet * 12 * 100) / 100;

        // Build services array from line items
        const services = lines
          .filter((l: Record<string, unknown>) => l.DetailType === "SalesItemLineDetail")
          .map((l: Record<string, unknown>) => {
            const detail = l.SalesItemLineDetail as Record<string, unknown> | undefined;
            return {
              service_id: detail?.ItemRef ? String((detail.ItemRef as Record<string, unknown>).name || "service") : "service",
              description: String(l.Description || ""),
              monthly_amount: Number(l.Amount) || 0,
              annual_amount: (Number(l.Amount) || 0) * 12,
            };
          });

        // Check if billing record already exists
        const { data: existing } = await sb
          .from("live_billing")
          .select("id")
          .eq("qbo_recurring_txn_id", String(txn.Id))
          .single();

        if (existing) {
          // Update
          await sb.from("live_billing").update({
            monthly_net: monthlyNet,
            monthly_vat: monthlyVat,
            monthly_gross: monthlyGross,
            annual_total: annualTotal,
            services,
            qbo_customer_id: qboCustomerId,
            last_qbo_sync: new Date().toISOString(),
            qbo_sync_status: "synced",
          }).eq("id", existing.id);
          stats.updated++;
        } else {
          // Insert new
          await sb.from("live_billing").insert({
            entity_id: entity.id,
            billing_type: "recurring",
            monthly_net: monthlyNet,
            monthly_vat: monthlyVat,
            monthly_gross: monthlyGross,
            annual_total: annualTotal,
            services,
            status: "active",
            source: "qbo_pull",
            qbo_recurring_txn_id: String(txn.Id),
            qbo_customer_id: qboCustomerId,
            last_qbo_sync: new Date().toISOString(),
            qbo_sync_status: "synced",
          });
          stats.created++;
        }

        // Update entity QBO mapping if not set
        if (!entity.qbo_customer_id) {
          await sb.from("entities").update({
            qbo_customer_id: qboCustomerId,
            qbo_customer_name: customerName,
          }).eq("id", entity.id);
        }

        await logSync({
          direction: "pull",
          entity_id: entity.id as string,
          entity_name: entity.name as string || entity.display_name as string,
          qbo_entity_type: "RecurringTransaction",
          qbo_entity_id: String(txn.Id),
          status: "success",
          detail: { monthly_net: monthlyNet, services_count: services.length },
          initiated_by: initiatedBy,
        });
      } catch (err) {
        stats.errors.push(`${txn.Id}: ${(err as Error).message}`);
        await logSync({
          direction: "pull",
          qbo_entity_type: "RecurringTransaction",
          qbo_entity_id: String(txn.Id),
          status: "error",
          error_message: (err as Error).message,
          initiated_by: initiatedBy,
        });
      }
    }

    return jsonResponse({
      success: true,
      data: {
        recurring_found: recurringTxns.length,
        invoices_found: invoices.length,
        ...stats,
      },
    });
  } catch (err) {
    console.error("qbo-pull error:", err);
    return jsonResponse({ success: false, error: (err as Error).message }, 500);
  }
});
