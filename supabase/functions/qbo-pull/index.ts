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
    // entities.display_name doesn't exist — select only real columns,
    // or PostgREST errors and entities comes back null (silently killing
    // every lookup). Bitten 2026-04-19.
    const { data: entities, error: entitiesErr } = await sb.from("entities").select("id, name, qbo_customer_id");
    if (entitiesErr) {
      return jsonResponse({ success: false, error: `entities select failed: ${entitiesErr.message}` }, 500);
    }
    const entityMap = new Map<string, Record<string, unknown>>();

    for (const e of entities || []) {
      const name = (e.name || "").toLowerCase().trim();
      if (name) entityMap.set(name, e);
    }

    const { data: existingMaps } = await sb.from("qbo_customer_mappings").select("qbo_customer_id, entity_id, role, qbo_customer_name");
    const mapByQboId = new Map<string, { entity_id: string | null; role: string; qbo_customer_name: string | null }>();
    for (const m of existingMaps || []) {
      mapByQboId.set(m.qbo_customer_id as string, {
        entity_id: (m.entity_id as string) || null,
        role: (m.role as string) || 'primary',
        qbo_customer_name: (m.qbo_customer_name as string) || null,
      });
    }

    // ──────────────────────────────────────────────────────────
    // 3. Upsert every QBO customer into qbo_customer_mappings.
    //    - Existing rows: refresh name + last_seen. If the row was
    //      Ignored (role='not_a_client') and the name has *changed*,
    //      record the previous name and raise needs_review so staff
    //      re-evaluate (handles the pre-provisioned-licence case).
    //    - New rows: attempt a name-based auto-match to an entity;
    //      unmatched rows are stored with entity_id=null for later
    //      manual resolution in the Mapping UI.
    // ──────────────────────────────────────────────────────────
    const now = new Date().toISOString();
    const mapStats = { seen: 0, new: 0, auto_matched: 0, refreshed: 0, flagged_needs_review: 0, errors: [] as string[] };

    for (const cust of qboCustomers) {
      try {
        const qboId = String(cust.Id || "");
        if (!qboId) continue;
        const name = String(cust.DisplayName || cust.CompanyName || cust.FullyQualifiedName || "").trim();
        mapStats.seen++;

        const existing = mapByQboId.get(qboId);
        if (existing) {
          const nameChanged = !!existing.qbo_customer_name && !!name && existing.qbo_customer_name !== name;
          const flagForReview = nameChanged && existing.role === 'not_a_client';
          const updateFields: Record<string, unknown> = {
            qbo_customer_name: name,
            last_seen: now,
          };
          if (flagForReview) {
            updateFields.needs_review = true;
            updateFields.previous_qbo_customer_name = existing.qbo_customer_name;
            mapStats.flagged_needs_review++;
          }
          await sb.from("qbo_customer_mappings")
            .update(updateFields)
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
            mapByQboId.set(qboId, { entity_id: matchedEntity.id as string, role: 'primary', qbo_customer_name: name });
          } else {
            mapByQboId.set(qboId, { entity_id: null, role: 'primary', qbo_customer_name: name });
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
    // 4. Fetch recurring txns and invoices (last 12 months only —
    //    one-off revenue is scored over a rolling 12-month window).
    // ──────────────────────────────────────────────────────────
    let recurringTxns: Array<Record<string, unknown>> = [];
    try {
      const result = await qboQuery("SELECT * FROM RecurringTransaction") as Record<string, unknown>;
      const queryResponse = result?.QueryResponse as Record<string, unknown>;
      recurringTxns = (queryResponse?.RecurringTransaction || []) as Array<Record<string, unknown>>;
    } catch (e) {
      console.log("RecurringTransaction query failed (may not be available):", (e as Error).message);
    }

    // Rolling 12-month window for invoice aggregation.
    const twelveMonthsAgo = new Date();
    twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 12);
    const twelveMonthsAgoIso = twelveMonthsAgo.toISOString().slice(0, 10);

    const invoiceResult = await qboQuery(
      `SELECT * FROM Invoice WHERE TxnDate >= '${twelveMonthsAgoIso}' MAXRESULTS 1000`,
    ) as Record<string, unknown>;
    const invoiceResponse = invoiceResult?.QueryResponse as Record<string, unknown>;
    const invoices = (invoiceResponse?.Invoice || []) as Array<Record<string, unknown>>;

    const stats = {
      created: 0, updated: 0, skipped: 0, matched: 0,
      errors: [] as string[], unmatched_customers: [] as string[],
      one_off_created: 0, one_off_skipped: 0,
    };

    // ScheduleInfo → monthly factor. Any QBO recurring template stores
    // an amount *per-occurrence*; to normalise to a monthly figure we
    // divide by "occurrences per month" (inverted: multiply by months
    // per occurrence, then invert when summing).
    //   Monthly,  N=1  → monthly = total / 1
    //   Monthly,  N=3  → quarterly: monthly = total / 3
    //   Yearly,   N=1  → annual:    monthly = total / 12
    //   Weekly,   N=1  → monthly = total * 52/12
    //   Daily,    N=1  → monthly = total * 365/12
    const monthlyFactor = (schedule: Record<string, unknown> | undefined): number => {
      if (!schedule) return 1;
      const type = String(schedule.IntervalType || "Monthly");
      const n = Math.max(1, Number(schedule.NumInterval || 1));
      switch (type) {
        case "Daily":   return (365 / 12) / n;
        case "Weekly":  return (52 / 12) / n;
        case "Yearly":  return 1 / (12 * n);
        case "Monthly":
        default:        return 1 / n;
      }
    };

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

        // Normalise per-occurrence amount to a monthly equivalent using
        // the template's ScheduleInfo. Defaults to monthly if absent.
        const schedule = (innerTxn.ScheduleInfo || txn.ScheduleInfo) as Record<string, unknown> | undefined;
        const factor = monthlyFactor(schedule);
        const monthlyNet = Math.round(totalAmount * factor * 100) / 100;
        const monthlyVat = Math.round(monthlyNet * 0.2 * 100) / 100;
        const monthlyGross = Math.round((monthlyNet + monthlyVat) * 100) / 100;
        const annualTotal = Math.round(monthlyNet * 12 * 100) / 100;

        const services = lines.map((l: Record<string, unknown>) => {
          const detail = l.SalesItemLineDetail as Record<string, unknown> | undefined;
          const perOccurrence = Number(l.Amount) || 0;
          const monthly = Math.round(perOccurrence * factor * 100) / 100;
          return {
            service_id: detail?.ItemRef ? String((detail.ItemRef as Record<string, unknown>).name || "service") : "service",
            description: String(l.Description || ""),
            monthly_amount: monthly,
            annual_amount: Math.round(monthly * 12 * 100) / 100,
            billing_type: "recurring" as const,
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
            last_synced_qbo: now,
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
            qbo_recurring_txn_id: txnId,
            qbo_customer_id: qboCustomerId,
            last_synced_qbo: now,
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
    // 6. Process one-off invoices — aggregate last-12-months invoices
    //    per customer into a single `billing_type='one_off'` row.
    //    No monthly extrapolation; annual_total is the actual sum.
    //    A customer with a RecurringTransaction gets BOTH rows: the
    //    recurring template (above) *and* a one-off row for invoices
    //    outside the recurring pattern (ad-hoc work, etc.) — but for
    //    v1 we only emit one-off rows for customers with no recurring
    //    template to keep the signal clean. Extending to "extras on
    //    top of recurring" is a future refinement.
    // ──────────────────────────────────────────────────────────
    const invoicesByCustomer = new Map<string, Array<Record<string, unknown>>>();
    for (const inv of invoices) {
      const customerRef = inv.CustomerRef as Record<string, unknown> | undefined;
      if (!customerRef) continue;
      const custId = String(customerRef.value);
      if (!invoicesByCustomer.has(custId)) invoicesByCustomer.set(custId, []);
      invoicesByCustomer.get(custId)!.push(inv);
    }

    // Customers already covered by a recurring txn — skip for the
    // one-off path.
    const customersWithRecurring = new Set<string>();
    for (const txn of recurringTxns) {
      const innerTxn = (txn.Invoice || txn.SalesReceipt || txn) as Record<string, unknown>;
      const customerRef = (innerTxn.CustomerRef || txn.CustomerRef) as Record<string, unknown> | undefined;
      if (customerRef) customersWithRecurring.add(String(customerRef.value));
    }

    for (const [qboCustomerId, custInvoices] of invoicesByCustomer) {
      try {
        if (customersWithRecurring.has(qboCustomerId)) {
          stats.one_off_skipped++;
          continue;
        }

        const customerName = String(
          (custInvoices[0].CustomerRef as Record<string, unknown>).name || "Unknown",
        );

        const entityId = entityIdByQboId.get(qboCustomerId);
        const entity = entityId ? entityById.get(entityId) : null;

        if (!entity) {
          if (!stats.unmatched_customers.includes(customerName)) {
            stats.unmatched_customers.push(customerName);
          }
          continue;
        }

        // Aggregate line-items across all 12-month invoices for this
        // customer. Group by service (ItemRef name) so the dashboard
        // can show "one-off revenue by service type".
        const svcAgg = new Map<string, { service_id: string; description: string; amount: number; count: number }>();
        let totalNet = 0;
        let invoiceCount = 0;

        for (const inv of custInvoices) {
          const lines = ((inv.Line || []) as Array<Record<string, unknown>>)
            .filter((l: Record<string, unknown>) => l.DetailType === "SalesItemLineDetail");
          if (lines.length === 0) continue;
          invoiceCount++;
          for (const l of lines) {
            const detail = l.SalesItemLineDetail as Record<string, unknown> | undefined;
            const svcId = detail?.ItemRef
              ? String((detail.ItemRef as Record<string, unknown>).name || "service")
              : "service";
            const amt = Number(l.Amount) || 0;
            totalNet += amt;
            const prev = svcAgg.get(svcId);
            if (prev) {
              prev.amount += amt;
              prev.count += 1;
            } else {
              svcAgg.set(svcId, {
                service_id: svcId,
                description: String(l.Description || svcId),
                amount: amt,
                count: 1,
              });
            }
          }
        }

        if (invoiceCount === 0 || totalNet === 0) continue;

        const annualTotal = Math.round(totalNet * 100) / 100;
        const services = [...svcAgg.values()].map((s) => ({
          service_id: s.service_id,
          description: s.description,
          monthly_amount: 0,
          annual_amount: Math.round(s.amount * 100) / 100,
          invoice_count: s.count,
          billing_type: "one_off" as const,
        }));

        // Upsert: one one_off row per entity. If one exists from a
        // prior pull, refresh it; otherwise insert new.
        const { data: existingOneOff } = await sb
          .from("live_billing")
          .select("id")
          .eq("entity_id", entity.id)
          .eq("billing_type", "one_off")
          .maybeSingle();

        if (existingOneOff) {
          await sb.from("live_billing").update({
            monthly_net: 0,
            monthly_vat: 0,
            monthly_gross: 0,
            annual_total: annualTotal,
            services,
            qbo_customer_id: qboCustomerId,
            last_synced_qbo: now,
            qbo_sync_status: "synced",
          }).eq("id", existingOneOff.id);
          stats.updated++;
        } else {
          await sb.from("live_billing").insert({
            entity_id: entity.id,
            billing_type: "one_off",
            monthly_net: 0,
            monthly_vat: 0,
            monthly_gross: 0,
            annual_total: annualTotal,
            services,
            status: "active",
            qbo_customer_id: qboCustomerId,
            last_synced_qbo: now,
            qbo_sync_status: "synced",
          });
          stats.one_off_created++;
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
          entity_name: entity.name as string,
          qbo_entity_type: "Invoice",
          qbo_entity_id: `${invoiceCount}-invoices-12mo`,
          status: "success",
          detail: { annual_total: annualTotal, invoice_count: invoiceCount, services_count: services.length },
          initiated_by: initiatedBy,
        });
      } catch (err) {
        stats.errors.push(`Customer ${qboCustomerId} (one-off): ${(err as Error).message}`);
      }
    }

    return jsonResponse({
      success: true,
      data: {
        qbo_customers_seen: mapStats.seen,
        qbo_customers_new: mapStats.new,
        qbo_customers_auto_matched: mapStats.auto_matched,
        qbo_customers_refreshed: mapStats.refreshed,
        qbo_customers_flagged_review: mapStats.flagged_needs_review,
        qbo_customers_unmapped: (mapStats.seen - [...mapByQboId.values()].filter(m => m.entity_id).length),
        recurring_found: recurringTxns.length,
        invoices_found: invoices.length,
        unique_customers: invoicesByCustomer.size,
        ...stats,
      },
    });
  } catch (err) {
    console.error("qbo-pull error:", err);
    return jsonResponse({ success: false, error: (err as Error).message }, 500);
  }
});
