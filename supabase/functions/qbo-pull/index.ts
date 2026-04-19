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

    // ──────────────────────────────────────────────────────────
    // 1. Fetch every QBO customer (not just those with invoices).
    //    Populates qbo_customer_mappings so legacy / billing-initiator /
    //    dormant customers appear in the Mapping UI even when they have
    //    no current recurring txn or invoice.
    // ──────────────────────────────────────────────────────────
    const custResult = await qboQuery("SELECT * FROM Customer MAXRESULTS 1000") as Record<string, unknown>;
    const customerResponse = custResult?.QueryResponse as Record<string, unknown>;
    const qboCustomers = (customerResponse?.Customer || []) as Array<Record<string, unknown>>;

    // ──────────────────────────────────────────────────────────
    // 2. Load entities (for name-based auto-matching on first-seen)
    //    and existing mappings.
    // ──────────────────────────────────────────────────────────
    const { data: entities } = await sb.from("entities").select("id, name, display_name, qbo_customer_id");
    const entityMap = new Map<string, Record<string, unknown>>();

    for (const e of entities || []) {
      const name = (e.name || "").toLowerCase().trim();
      if (name) entityMap.set(name, e);
      if (e.display_name) entityMap.set(String(e.display_name).toLowerCase().trim(), e);
    }

    const { data: existingMaps } = await sb.from("qbo_customer_mappings").select("qbo_customer_id, entity_id, role");
    const mapByQboId = new Map<string, { entity_id: string | null; role: string }>();
    for (const m of existingMaps || []) {
      mapByQboId.set(m.qbo_customer_id as string, {
        entity_id: (m.entity_id as string) || null,
        role: (m.role as string) || 'primary',
      });
    }

    // ──────────────────────────────────────────────────────────
    // 3. Upsert every QBO customer into qbo_customer_mappings.
    //    - Existing rows: refresh name + last_seen only; leave the
    //      staff-set entity_id / role / notes alone.
    //    - New rows: attempt a name-based auto-match to an entity;
    //      unmatched rows are stored with entity_id=null for later
    //      manual resolution in the Mapping UI.
    // ──────────────────────────────────────────────────────────
    const now = new Date().toISOString();
    const mapStats = { seen: 0, new: 0, auto_matched: 0, refreshed: 0, errors: [] as string[] };

    for (const cust of qboCustomers) {
      try {
        const qboId = String(cust.Id || "");
        if (!qboId) continue;
        const name = String(cust.DisplayName || cust.CompanyName || cust.FullyQualifiedName || "").trim();
        mapStats.seen++;

        const existing = mapByQboId.get(qboId);
        if (existing) {
          await sb.from("qbo_customer_mappings")
            .update({ qbo_customer_name: name, last_seen: now })
            .eq("qbo_customer_id", qboId);
          mapStats.refreshed++;
        } else {
          // First time we've seen this QBO customer — try to auto-link
          const matchedEntity = entityMap.get(name.toLowerCase());
          await sb.from("qbo_customer_mappings").insert({
            qbo_customer_id: qboId,
            qbo_customer_name: name,
            entity_id: matchedEntity ? (matchedEntity.id as string) : null,
            role: 'primary',
            first_seen: now,
            last_seen: now,
          });
          mapStats.new++;
          if (matchedEntity) {
            mapStats.auto_matched++;
            mapByQboId.set(qboId, { entity_id: matchedEntity.id as string, role: 'primary' });
          } else {
            mapByQboId.set(qboId, { entity_id: null, role: 'primary' });
          }
        }
      } catch (err) {
        mapStats.errors.push(`Customer ${cust.Id}: ${(err as Error).message}`);
      }
    }

    // Build resolver: qbo_customer_id → entity_id (via mappings table,
    // now fully populated). Primary source of truth for billing processing.
    const entityIdByQboId = new Map<string, string>();
    for (const [qboId, m] of mapByQboId) {
      if (m.entity_id && m.role !== 'not_a_client') {
        entityIdByQboId.set(qboId, m.entity_id);
      }
    }
    const entityById = new Map<string, Record<string, unknown>>();
    for (const e of entities || []) entityById.set(e.id as string, e);

    // ──────────────────────────────────────────────────────────
    // 4. Fetch recurring txns and invoices.
    // ──────────────────────────────────────────────────────────
    let recurringTxns: Array<Record<string, unknown>> = [];
    try {
      const result = await qboQuery("SELECT * FROM RecurringTransaction") as Record<string, unknown>;
      const queryResponse = result?.QueryResponse as Record<string, unknown>;
      recurringTxns = (queryResponse?.RecurringTransaction || []) as Array<Record<string, unknown>>;
    } catch (e) {
      console.log("RecurringTransaction query failed (may not be available):", (e as Error).message);
    }

    const invoiceResult = await qboQuery("SELECT * FROM Invoice MAXRESULTS 500") as Record<string, unknown>;
    const invoiceResponse = invoiceResult?.QueryResponse as Record<string, unknown>;
    const invoices = (invoiceResponse?.Invoice || []) as Array<Record<string, unknown>>;

    const stats = { created: 0, updated: 0, skipped: 0, matched: 0, errors: [] as string[], unmatched_customers: [] as string[] };

    // ──────────────────────────────────────────────────────────
    // 5. Process recurring transactions. Entity resolution now
    //    goes through qbo_customer_mappings — so a legacy QBO
    //    customer correctly rolls into its consolidated entity.
    // ──────────────────────────────────────────────────────────
    for (const txn of recurringTxns) {
      try {
        const innerTxn = (txn.Invoice || txn.SalesReceipt || txn) as Record<string, unknown>;
        const customerRef = (innerTxn.CustomerRef || txn.CustomerRef) as Record<string, unknown> | undefined;

        if (!customerRef) {
          stats.skipped++;
          continue;
        }

        const qboCustomerId = String(customerRef.value);
        const customerName = String(customerRef.name || "Unknown");

        const entityId = entityIdByQboId.get(qboCustomerId);
        const entity = entityId ? entityById.get(entityId) : null;

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
            last_qbo_sync: now,
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
            last_qbo_sync: now,
            qbo_sync_status: "synced",
          });
          stats.created++;
        }

        // Legacy: keep entities.qbo_customer_id in sync with the primary
        // QBO id for the matched entity. qbo_customer_mappings is the
        // real source of truth; this column is deprecated but still read
        // by a few places.
        if (!entity.qbo_customer_id) {
          await sb.from("entities").update({
            qbo_customer_id: qboCustomerId,
            qbo_customer_name: customerName,
          }).eq("id", entity.id);
        }

        await logSync({
          direction: "pull",
          entity_id: entity.id as string,
          entity_name: (entity.name as string) || (entity.display_name as string),
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

    // ──────────────────────────────────────────────────────────
    // 6. Process invoices (one per customer — the latest).
    // ──────────────────────────────────────────────────────────
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

        const entityId = entityIdByQboId.get(qboCustomerId);
        const entity = entityId ? entityById.get(entityId) : null;

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

        if (existingBilling) continue;

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
          last_qbo_sync: now,
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
        qbo_customers_seen: mapStats.seen,
        qbo_customers_new: mapStats.new,
        qbo_customers_auto_matched: mapStats.auto_matched,
        qbo_customers_refreshed: mapStats.refreshed,
        qbo_customers_unmapped: (mapStats.seen - [...mapByQboId.values()].filter(m => m.entity_id).length),
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
