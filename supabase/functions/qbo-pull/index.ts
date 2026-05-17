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
    // Same pagination treatment as RecurringTransaction below — without
    // STARTPOSITION we'd silently cap at 1000 customers.
    const qboCustomers: Array<Record<string, unknown>> = await pageAll<Record<string, unknown>>(
      (start, n) => qboQuery(`SELECT * FROM Customer STARTPOSITION ${start} MAXRESULTS ${n}`),
      "Customer",
    );

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
    // QBO's default MAXRESULTS is 100 — without explicit paging we were
    // silently losing every template past the 100th. pageAll loops
    // STARTPOSITION until we get a short page.
    let recurringTxns: Array<Record<string, unknown>> = [];
    try {
      recurringTxns = await pageAll<Record<string, unknown>>(
        (start, n) => qboQuery(`SELECT * FROM RecurringTransaction STARTPOSITION ${start} MAXRESULTS ${n}`),
        "RecurringTransaction",
      );
    } catch (e) {
      console.log("RecurringTransaction query failed (may not be available):", (e as Error).message);
    }

    // Rolling 12-month window for invoice aggregation.
    const twelveMonthsAgo = new Date();
    twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 12);
    const twelveMonthsAgoIso = twelveMonthsAgo.toISOString().slice(0, 10);

    const invoices: Array<Record<string, unknown>> = await pageAll<Record<string, unknown>>(
      (start, n) => qboQuery(`SELECT * FROM Invoice WHERE TxnDate >= '${twelveMonthsAgoIso}' STARTPOSITION ${start} MAXRESULTS ${n}`),
      "Invoice",
    );

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
        const recurringInfo = (innerTxn.RecurringInfo || txn.RecurringInfo) as Record<string, unknown> | undefined;

        // Skip inactive templates. They're paused/disabled in QBO and
        // won't auto-generate invoices, so they shouldn't be counted
        // as live recurring billing. If we previously linked one, the
        // row gets unlinked so it falls back to invoice-inference.
        if (recurringInfo && recurringInfo.Active === false) {
          const txnId = String(txn.Id || innerTxn.Id || "");
          if (txnId) {
            await sb.from("live_billing")
              .update({ qbo_recurring_txn_id: null, qbo_sync_status: "synced", last_synced_qbo: now })
              .eq("qbo_recurring_txn_id", txnId);
          }
          stats.skipped++;
          continue;
        }

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

        // Recurring-txn services are auto-approved — a QBO template is
        // explicit staff intent, not an inference. Staff can still edit
        // via the review queue.
        const services = lines.map((l: Record<string, unknown>) => {
          const detail = l.SalesItemLineDetail as Record<string, unknown> | undefined;
          const perOccurrence = Number(l.Amount) || 0;
          const monthly = Math.round(perOccurrence * factor * 100) / 100;
          return {
            service_id: detail?.ItemRef ? String((detail.ItemRef as Record<string, unknown>).name || "service") : "service",
            description: String(l.Description || ""),
            cadence: "monthly" as const,
            cadence_months: 1,
            monthly_amount: monthly,
            annual_amount: Math.round(monthly * 12 * 100) / 100,
            approval_status: "approved" as const,
            approved_by: "system:qbo_template",
            approved_at: now,
            billing_type: "recurring" as const,
          };
        });

        const txnId = String(txn.Id || innerTxn.Id);

        // Find the row to write into. Preference order:
        //   1. Existing row already linked to THIS template (txn id)
        //   2. The entity's invoice-inferred row that has no template
        //      yet — attach the template to it rather than insert a
        //      duplicate.
        //   3. Otherwise insert a new row.
        let { data: existing } = await sb
          .from("live_billing")
          .select("id")
          .eq("qbo_recurring_txn_id", txnId)
          .maybeSingle();

        if (!existing) {
          const { data: orphan } = await sb
            .from("live_billing")
            .select("id")
            .eq("entity_id", entity.id)
            .eq("status", "active")
            .is("qbo_recurring_txn_id", null)
            .order("monthly_net", { ascending: false })
            .limit(1)
            .maybeSingle();
          if (orphan) existing = orphan;
        }

        if (existing) {
          await sb.from("live_billing").update({
            qbo_recurring_txn_id: txnId,
            billing_type: "recurring",
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
    // 6. Process invoice history — classify each service LINE per
    //    customer by its own cadence. A client with a monthly
    //    bookkeeping line + an annual year-end line gets both
    //    tagged correctly.
    //
    //    Rule (per service line):
    //      - Bucket invoice lines by calendar month (sum within).
    //      - Let L = latest month this service appears in, P = the
    //        prior calendar month.
    //      - If service appears in both L and P:
    //          within ±10%  → cadence='monthly' (clean)
    //          outside ±10% → cadence='monthly', needs_review=true
    //      - If service appears in L only → cadence='annual'.
    //
    //    A customer with a QBO RecurringTransaction template (v1:
    //    whole customer excluded) is still handled upstream. This
    //    loop only runs for customers without a template.
    // ──────────────────────────────────────────────────────────
    const invoicesByCustomer = new Map<string, Array<Record<string, unknown>>>();
    for (const inv of invoices) {
      const customerRef = inv.CustomerRef as Record<string, unknown> | undefined;
      if (!customerRef) continue;
      const custId = String(customerRef.value);
      if (!invoicesByCustomer.has(custId)) invoicesByCustomer.set(custId, []);
      invoicesByCustomer.get(custId)!.push(inv);
    }

    const customersWithRecurring = new Set<string>();
    for (const txn of recurringTxns) {
      const innerTxn = (txn.Invoice || txn.SalesReceipt || txn) as Record<string, unknown>;
      const customerRef = (innerTxn.CustomerRef || txn.CustomerRef) as Record<string, unknown> | undefined;
      if (customerRef) customersWithRecurring.add(String(customerRef.value));
    }

    // "YYYY-MM" → prior-month "YYYY-MM" helper.
    const priorMonth = (ym: string): string => {
      const [y, m] = ym.split("-").map(Number);
      const d = new Date(y, m - 1, 1);
      d.setMonth(d.getMonth() - 1);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    };

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

        // Per-service monthly buckets:
        //   svcBuckets: service_id → { description, monthsSeen: Map<'YYYY-MM', amount> }
        const svcBuckets = new Map<string, {
          service_id: string;
          description: string;
          monthsSeen: Map<string, number>;
        }>();

        for (const inv of custInvoices) {
          const txnDate = String(inv.TxnDate || "");
          if (!txnDate) continue;
          const ym = txnDate.slice(0, 7); // YYYY-MM
          const lines = ((inv.Line || []) as Array<Record<string, unknown>>)
            .filter((l: Record<string, unknown>) => l.DetailType === "SalesItemLineDetail");

          for (const l of lines) {
            const detail = l.SalesItemLineDetail as Record<string, unknown> | undefined;
            const svcId = detail?.ItemRef
              ? String((detail.ItemRef as Record<string, unknown>).name || "service")
              : "service";
            const amt = Number(l.Amount) || 0;
            if (amt === 0) continue;
            let bucket = svcBuckets.get(svcId);
            if (!bucket) {
              bucket = {
                service_id: svcId,
                description: String(l.Description || svcId),
                monthsSeen: new Map<string, number>(),
              };
              svcBuckets.set(svcId, bucket);
            }
            bucket.monthsSeen.set(ym, (bucket.monthsSeen.get(ym) || 0) + amt);
          }
        }

        if (svcBuckets.size === 0) continue;

        // Preserve prior approval state across re-pulls.
        // Read the existing row's services once; for each newly-classified
        // service, if a prior service with the same service_id was
        // 'approved' AND its monthly_amount is still within ±10% of the
        // new one, keep it approved — otherwise revert to 'suggested'
        // with a review_reason noting the drift. 'rejected' is sticky.
        const { data: existingForMerge } = await sb
          .from("live_billing")
          .select("id, services")
          .eq("entity_id", entity.id)
          .is("qbo_recurring_txn_id", null)
          .maybeSingle();
        const priorServicesById = new Map<string, Record<string, unknown>>();
        for (const s of (existingForMerge?.services as Array<Record<string, unknown>> | null) || []) {
          priorServicesById.set(String(s.service_id || ""), s);
        }

        // Classify each service and build enriched services array.
        let rowMonthlyNet = 0;
        let rowAnnualTotal = 0;
        let rowNeedsReview = false;
        let firstReviewReason: string | null = null;

        const services = [...svcBuckets.values()].map((bucket) => {
          const months = [...bucket.monthsSeen.entries()].sort(([a], [b]) => a.localeCompare(b));
          const [latestYm, latestAmt] = months[months.length - 1];
          const priorYm = priorMonth(latestYm);
          const priorAmt = bucket.monthsSeen.get(priorYm);

          const annualSum = Math.round(
            months.reduce((s, [, v]) => s + v, 0) * 100,
          ) / 100;

          let cadence: "monthly" | "annual";
          let cadence_months: number;
          let monthlyAmount: number;
          let annualAmount: number;
          let needs_review = false;
          let review_reason: string | null = null;

          if (priorAmt !== undefined) {
            // Service appears in both latest and prior month.
            const lo = priorAmt * 0.9;
            const hi = priorAmt * 1.1;
            const withinTolerance = latestAmt >= lo && latestAmt <= hi;

            cadence = "monthly";
            cadence_months = 1;
            monthlyAmount = Math.round(latestAmt * 100) / 100;
            annualAmount = Math.round(monthlyAmount * 12 * 100) / 100;

            if (!withinTolerance) {
              needs_review = true;
              const diffPct = Math.round(
                Math.abs(latestAmt - priorAmt) / priorAmt * 100,
              );
              review_reason = `Prior month ${priorYm} £${priorAmt.toFixed(2)} differs from latest ${latestYm} £${latestAmt.toFixed(2)} by ${diffPct}%`;
            }
          } else {
            // Service appears in latest month only (across 12mo window).
            cadence = "annual";
            cadence_months = 12;
            annualAmount = annualSum;
            monthlyAmount = Math.round(annualAmount / 12 * 100) / 100;
          }

          rowMonthlyNet += monthlyAmount;
          rowAnnualTotal += annualAmount;
          if (needs_review) {
            rowNeedsReview = true;
            if (!firstReviewReason) {
              firstReviewReason = `${bucket.description}: ${review_reason}`;
            }
          }

          // Approval-state merge with prior-pull data.
          //   Invoice-inferred monthly  → default 'suggested' (user gate).
          //   Invoice-inferred annual   → default 'approved' (mechanical).
          //   Prior 'approved' within ±10% of new monthly → stays approved.
          //   Prior 'rejected' → stays rejected.
          //   Drift >10% → reverts to 'suggested' with review_reason.
          const prior = priorServicesById.get(bucket.service_id);
          let approval_status: "suggested" | "approved" | "rejected" =
            cadence === "annual" ? "approved" : "suggested";
          let approved_by: string | null = cadence === "annual" ? "system:annual_default" : null;
          let approved_at: string | null = cadence === "annual" ? now : null;

          if (prior) {
            const priorStatus = String(prior.approval_status || "");
            const priorMonthly = Number(prior.monthly_amount) || 0;
            if (priorStatus === "rejected") {
              approval_status = "rejected";
              approved_by = (prior.approved_by as string) || null;
              approved_at = (prior.approved_at as string) || null;
            } else if (priorStatus === "approved") {
              const within = priorMonthly === 0
                ? monthlyAmount === 0
                : Math.abs(monthlyAmount - priorMonthly) / priorMonthly <= 0.10;
              if (within) {
                approval_status = "approved";
                approved_by = (prior.approved_by as string) || null;
                approved_at = (prior.approved_at as string) || null;
              } else {
                approval_status = "suggested";
                approved_by = null;
                approved_at = null;
                needs_review = true;
                if (!review_reason) {
                  review_reason = `Was approved at £${priorMonthly.toFixed(2)}/mo; latest £${monthlyAmount.toFixed(2)}/mo — re-review required`;
                }
                rowNeedsReview = true;
                if (!firstReviewReason) {
                  firstReviewReason = `${bucket.description}: ${review_reason}`;
                }
              }
            }
          }

          return {
            service_id: bucket.service_id,
            description: bucket.description,
            cadence,
            cadence_months,
            monthly_amount: monthlyAmount,
            annual_amount: annualAmount,
            months_seen: months.map(([ym]) => ym),
            latest_month: latestYm,
            latest_amount: Math.round(latestAmt * 100) / 100,
            prior_month: priorYm,
            prior_amount: priorAmt !== undefined ? Math.round(priorAmt * 100) / 100 : null,
            needs_review,
            review_reason,
            approval_status,
            approved_by,
            approved_at,
            billing_type: cadence === "monthly" ? "recurring" : "annual",
          };
        });

        rowMonthlyNet = Math.round(rowMonthlyNet * 100) / 100;
        rowAnnualTotal = Math.round(rowAnnualTotal * 100) / 100;
        const rowMonthlyVat = Math.round(rowMonthlyNet * 0.2 * 100) / 100;
        const rowMonthlyGross = Math.round((rowMonthlyNet + rowMonthlyVat) * 100) / 100;

        // Row-level billing_type = the dominant cadence. If any service
        // is monthly, the row is 'recurring'; otherwise 'annual'. This
        // keeps the existing dashboard filters sane while services
        // jsonb carries the true per-service cadence.
        const anyMonthly = services.some((s) => s.cadence === "monthly");
        const rowBillingType = anyMonthly ? "recurring" : "annual";

        const existingRow = existingForMerge;

        const writeFields: Record<string, unknown> = {
          billing_type: rowBillingType,
          monthly_net: rowMonthlyNet,
          monthly_vat: rowMonthlyVat,
          monthly_gross: rowMonthlyGross,
          annual_total: rowAnnualTotal,
          services,
          needs_review: rowNeedsReview,
          review_reason: firstReviewReason,
          qbo_customer_id: qboCustomerId,
          last_synced_qbo: now,
          qbo_sync_status: "synced",
        };

        if (existingRow) {
          await sb.from("live_billing").update(writeFields).eq("id", existingRow.id);
          stats.updated++;
        } else {
          await sb.from("live_billing").insert({
            entity_id: entity.id,
            status: "active",
            ...writeFields,
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
          qbo_entity_id: `${custInvoices.length}-invoices-12mo`,
          status: rowNeedsReview ? "pending" : "success",
          detail: {
            monthly_net: rowMonthlyNet,
            annual_total: rowAnnualTotal,
            services_count: services.length,
            needs_review: rowNeedsReview,
          },
          initiated_by: initiatedBy,
        });
      } catch (err) {
        stats.errors.push(`Customer ${qboCustomerId} (classify): ${(err as Error).message}`);
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

// Page through a QBO SQL-like query until exhausted. QBO caps each
// response at 1000 records (and at 100 if you don't specify
// MAXRESULTS), so anything bigger needs STARTPOSITION pagination.
//
//   queryFn(start, pageSize)  — runs the actual query for one page
//   responseKey               — the QBO entity name on QueryResponse
//
// pageAll stops when a page comes back shorter than the requested size
// (or empty). Hard-caps at 50 pages = 50k records as a runaway guard.
async function pageAll<T>(
  queryFn: (start: number, pageSize: number) => Promise<unknown>,
  responseKey: string,
): Promise<T[]> {
  const pageSize = 1000;
  const maxPages = 50;
  let start = 1;
  let out: T[] = [];
  for (let i = 0; i < maxPages; i++) {
    const result = await queryFn(start, pageSize) as Record<string, unknown>;
    const queryResponse = result?.QueryResponse as Record<string, unknown> | undefined;
    const page = (queryResponse?.[responseKey] || []) as T[];
    if (page.length === 0) break;
    out = out.concat(page);
    if (page.length < pageSize) break;
    start += pageSize;
  }
  return out;
}
