import { getServiceClient, qboFetch, qboQuery, logSync, jsonResponse, corsHeaders } from "../_shared/qbo-client.ts";

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

    // 1. Query QBO for invoices (recurring transactions may not be available on all plans)
    let recurringTxns: Array<Record<string, unknown>> = [];
    try {
      const result = await qboQuery("SELECT * FROM RecurringTransaction") as Record<string, unknown>;
      const queryResponse = result?.QueryResponse as Record<string, unknown>;
      recurringTxns = (queryResponse?.RecurringTransaction || []) as Array<Record<string, unknown>>;
    } catch (e) {
      // RecurringTransaction endpoint may not be available — continue with invoices
      console.log("RecurringTransaction query failed (may not be available):", (e as Error).message);
    }

    // Get recent invoices
    const invoiceResult = await qboQuery("SELECT * FROM Invoice MAXRESULTS 500") as Record<string, unknown>;
    const invoiceResponse = invoiceResult?.QueryResponse as Record<string, unknown>;
    const invoices = (invoiceResponse?.Invoice || []) as Array<Record<string, unknown>>;

    // 2. Load all entities for matching
    const { data: entities } = await sb.from("entities").select("id, name, display_name, qbo_customer_id");
    const entityMap = new Map<string, Record<string, unknown>>();
    const entityByQboId = new Map<string, Record<string, unknown>>();

    for (const e of entities || []) {
      const name = (e.name || "").toLowerCase().trim();
      if (name) entityMap.set(name, e);
      if (e.display_name) entityMap.set(e.display_name.toLowerCase().trim(), e);
      if (e.qbo_customer_id) entityByQboId.set(e.qbo_customer_id, e);
    }

    const stats = { created: 0, updated: 0, skipped: 0, matched: 0, errors: [] as string[], unmatched_customers: [] as string[] };

    // 3. Process recurring transactions (if available)
    for (const txn of recurringTxns) {
      try {
        // RecurringTransaction wraps the inner transaction
        const innerTxn = (txn.Invoice || txn.SalesReceipt || txn) as Record<string, unknown>;
        const customerRef = (innerTxn.CustomerRef || txn.CustomerRef) as Record<string, unknown> | undefined;

        if (!customerRef) {
          stats.skipped++;
          continue;
        }

        const qboCustomerId = String(customerRef.value);
        const customerName = String(customerRef.name || "Unknown");

        const entity = entityByQboId.get(qboCustomerId)
          || entityMap.get(customerName.toLowerCase().trim());

        if (!entity) {
          stats.skipped++;
          if (!stats.unmatched_customers.includes(customerName)) {
            stats.unmatched_customers.push(customerName);
          }
          continue;
        }

        stats.matched++;
        const lines = ((innerTxn.Line || txn.Line || []) as Array<Record<string, unknown>>)
          .filter((l: Record<string, unknown>) => l.DetailType === "SalesItemLineDetail");

        const totalAmount = lines.reduce((sum: number, line: Record<string, unknown>) => {
          return sum + (Number(line.Amount) || 0);
        }, 0);

        const monthlyNet = totalAmount;
        const monthlyVat = Math.round(monthlyNet * 0.2 * 100) / 100;
        const monthlyGross = Math.round((monthlyNet + monthlyVat) * 100) / 100;
        const annualTotal = Math.round(monthlyNet * 12 * 100) / 100;

        const services = lines.map((l: Record<string, unknown>) => {
          const detail = l.SalesItemLineDetail as Record<string, unknown> | undefined;
          return {
            service_id: detail?.ItemRef ? String((detail.ItemRef as Record<string, unknown>).name || "service") : "service",
            description: String(l.Description || ""),
            monthly_amount: Number(l.Amount) || 0,
            annual_amount: (Number(l.Amount) || 0) * 12,
          };
        });

        const txnId = String(txn.Id || innerTxn.Id);

        const { data: existing } = await sb
          .from("live_billing")
          .select("id")
          .eq("qbo_recurring_txn_id", txnId)
          .single();

        if (existing) {
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
            qbo_recurring_txn_id: txnId,
            qbo_customer_id: qboCustomerId,
            last_qbo_sync: new Date().toISOString(),
            qbo_sync_status: "synced",
          });
          stats.created++;
        }

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
          qbo_entity_id: txnId,
          status: "success",
          detail: { monthly_net: monthlyNet, services_count: services.length },
          initiated_by: initiatedBy,
        });
      } catch (err) {
        stats.errors.push(`RecTxn ${txn.Id}: ${(err as Error).message}`);
      }
    }

    // 4. Process invoices — group by customer, take the latest
    const customerInvoices = new Map<string, Record<string, unknown>>();
    for (const inv of invoices) {
      const customerRef = inv.CustomerRef as Record<string, unknown> | undefined;
      if (!customerRef) continue;
      const custId = String(customerRef.value);
      const existing = customerInvoices.get(custId);
      if (!existing || String(inv.TxnDate || "") > String(existing.TxnDate || "")) {
        customerInvoices.set(custId, inv);
      }
    }

    for (const [qboCustomerId, inv] of customerInvoices) {
      try {
        const customerRef = inv.CustomerRef as Record<string, unknown>;
        const customerName = String(customerRef.name || "Unknown");

        const entity = entityByQboId.get(qboCustomerId)
          || entityMap.get(customerName.toLowerCase().trim());

        if (!entity) {
          if (!stats.unmatched_customers.includes(customerName)) {
            stats.unmatched_customers.push(customerName);
          }
          continue;
        }

        // Skip if we already have a billing record for this entity from recurring txns
        const { data: existingBilling } = await sb
          .from("live_billing")
          .select("id")
          .eq("entity_id", entity.id)
          .eq("source", "qbo_pull")
          .single();

        if (existingBilling) continue; // Already handled

        // Also skip if entity already has a billing record from any source
        const { data: anyBilling } = await sb
          .from("live_billing")
          .select("id")
          .eq("entity_id", entity.id)
          .single();

        if (anyBilling) continue;

        const lines = ((inv.Line || []) as Array<Record<string, unknown>>)
          .filter((l: Record<string, unknown>) => l.DetailType === "SalesItemLineDetail");

        if (lines.length === 0) continue;

        const totalAmount = lines.reduce((sum: number, line: Record<string, unknown>) => {
          return sum + (Number(line.Amount) || 0);
        }, 0);

        const monthlyNet = totalAmount;
        const monthlyVat = Math.round(monthlyNet * 0.2 * 100) / 100;
        const monthlyGross = Math.round((monthlyNet + monthlyVat) * 100) / 100;
        const annualTotal = Math.round(monthlyNet * 12 * 100) / 100;

        const services = lines.map((l: Record<string, unknown>) => {
          const detail = l.SalesItemLineDetail as Record<string, unknown> | undefined;
          return {
            service_id: detail?.ItemRef ? String((detail.ItemRef as Record<string, unknown>).name || "service") : "service",
            description: String(l.Description || ""),
            monthly_amount: Number(l.Amount) || 0,
            annual_amount: (Number(l.Amount) || 0) * 12,
          };
        });

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
          qbo_invoice_id: String(inv.Id),
          qbo_customer_id: qboCustomerId,
          last_qbo_sync: new Date().toISOString(),
          qbo_sync_status: "synced",
        });
        stats.created++;

        if (!entity.qbo_customer_id) {
          await sb.from("entities").update({
            qbo_customer_id: qboCustomerId,
            qbo_customer_name: customerName,
          }).eq("id", entity.id);
        }

        await logSync({
          direction: "pull",
          entity_id: entity.id as string,
          entity_name: entity.name as string,
          qbo_entity_type: "Invoice",
          qbo_entity_id: String(inv.Id),
          status: "success",
          detail: { monthly_net: monthlyNet, services_count: services.length },
          initiated_by: initiatedBy,
        });
      } catch (err) {
        stats.errors.push(`Invoice ${inv.Id}: ${(err as Error).message}`);
      }
    }

    return jsonResponse({
      success: true,
      data: {
        recurring_found: recurringTxns.length,
        invoices_found: invoices.length,
        unique_customers: customerInvoices.size,
        ...stats,
      },
    });
  } catch (err) {
    console.error("qbo-pull error:", err);
    return jsonResponse({ success: false, error: (err as Error).message }, 500);
  }
});
