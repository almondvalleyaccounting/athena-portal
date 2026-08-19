import { getServiceClient, qboFetch, qboQuery, logSync, jsonResponse, corsHeaders } from "../_shared/qbo-client.ts";
import { requireStaffOrService, authErrorResponse } from "../_shared/require-staff.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  if (req.method !== "POST") {
    return jsonResponse({ success: false, error: "POST required" }, 405);
  }

  // Writes up to 50k QBO records. Also invoked by the qbo-pull-nightly cron, which
  // is why service-role callers pass — sql/235 moves that cron off the anon key.
  try { await requireStaffOrService(req); }
  catch (err) { return authErrorResponse(err, corsHeaders()); }

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

    // Pull the QBO Item catalog and mirror it into qbo_items. Powers
    // the Add Billing service dropdown and gives future qbo-push the
    // canonical ItemRef.value for each line.
    const qboItems = await pageAll<Record<string, unknown>>(
      (start, n) => qboQuery(`SELECT * FROM Item STARTPOSITION ${start} MAXRESULTS ${n}`),
      "Item",
    );
    const nowIso = new Date().toISOString();
    const seenItemIds: string[] = [];
    for (const item of qboItems) {
      const qboItemId = String(item.Id || "");
      if (!qboItemId) continue;
      seenItemIds.push(qboItemId);
      await sb.from("qbo_items").upsert({
        qbo_item_id: qboItemId,
        name: String(item.Name || item.FullyQualifiedName || ""),
        fully_qualified_name: item.FullyQualifiedName ? String(item.FullyQualifiedName) : null,
        description: item.Description ? String(item.Description) : null,
        type: item.Type ? String(item.Type) : null,
        unit_price: item.UnitPrice != null ? Number(item.UnitPrice) : null,
        active: item.Active !== false,
        last_seen: nowIso,
      }, { onConflict: "qbo_item_id" });
    }

    // Anything not in this pull has been deactivated in QBO. `SELECT * FROM
    // Item` returns active items only, so without this the mirror keeps a
    // retired item marked active for ever — which is how a deleted product
    // stayed selectable in the mapping UI, and how two items ended up sharing
    // a name after a rebuild renamed the live one.
    //
    // Guarded on a plausible pull: if QBO returned nothing (auth blip, partial
    // failure) we must not flag the entire catalogue inactive.
    if (seenItemIds.length > 5) {
      const { error: deactErr } = await sb.from("qbo_items")
        .update({ active: false })
        .eq("active", true)
        .not("qbo_item_id", "in", `(${seenItemIds.join(",")})`);
      if (deactErr) console.error("qbo_items deactivate sweep failed:", deactErr.message);
    }

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
        // QBO's PrimaryEmailAddr.Address is a single string that can
        // hold multiple addresses (comma- or semicolon-separated). Store
        // raw; consumers split at display time.
        const qboEmailRaw = (cust.PrimaryEmailAddr as Record<string, unknown> | undefined)?.Address;
        const qboEmail = qboEmailRaw ? String(qboEmailRaw).trim() : null;
        mapStats.seen++;

        const existing = mapByQboId.get(qboId);
        if (existing) {
          const nameChanged = !!existing.qbo_customer_name && !!name && existing.qbo_customer_name !== name;
          const flagForReview = nameChanged && existing.role === 'not_a_client';
          const updateFields: Record<string, unknown> = {
            qbo_customer_name: name,
            qbo_email: qboEmail,
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
            qbo_email: qboEmail,
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
      duplicates_cancelled: 0,
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

        // Skip dormant templates. A template is dormant if either:
        //   - RecurringInfo.Active === false (explicitly paused), or
        //   - RecurringInfo.ScheduleInfo.NextDate is missing (no upcoming
        //     run — typically a Reminder-type template, or one whose
        //     schedule has expired)
        // Either way it won't auto-generate invoices in QBO, so it
        // shouldn't be counted as live recurring billing. If we
        // previously linked one, the row gets unlinked so it falls
        // back to invoice-inference.
        const scheduleInfo = (recurringInfo?.ScheduleInfo as Record<string, unknown> | undefined);
        const nextDate = String(recurringInfo?.NextDate || scheduleInfo?.NextDate || "");
        const isActive = recurringInfo?.Active !== false;
        const hasNextRun = nextDate.length > 0;
        if (!isActive || !hasNextRun) {
          const txnId = String(txn.Id || innerTxn.Id || "");
          if (txnId) {
            const { error: unlinkErr } = await sb.from("live_billing")
              .update({ qbo_recurring_txn_id: null, qbo_sync_status: "synced", last_synced_qbo: now })
              .eq("qbo_recurring_txn_id", txnId);
            if (unlinkErr) stats.errors.push(`RecTxn ${txnId} (dormant unlink): ${unlinkErr.message}`);
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
        // ScheduleInfo is nested under RecurringInfo, not at the top level.
        // This used to read innerTxn.ScheduleInfo, which is always undefined —
        // so monthlyFactor fell back to its default of 1 and EVERY template
        // was treated as monthly, whatever its real schedule. An annual
        // template was therefore recorded at 12x: Stand Jacey's £500-a-year
        // template read as £500/month = £6,000/year. scheduleInfo above is
        // derived correctly; reuse it.
        const factor = monthlyFactor(scheduleInfo);
        // Occurrences per year, so the services can carry the true cadence
        // rather than claiming monthly for a template that bills yearly.
        // cadence stays a two-value field (monthly | annual) to match the
        // invoice-inference path; cadence_months carries the real interval,
        // so quarterly reads as annual/3 rather than being flattened.
        const perYear = factor * 12;
        const tplCadence = perYear >= 12 ? "monthly" as const : "annual" as const;
        const tplCadenceMonths = Math.max(1, Math.round(12 / (perYear || 12)));
        const monthlyNet = Math.round(totalAmount * factor * 100) / 100;
        const monthlyVat = Math.round(monthlyNet * 0.2 * 100) / 100;
        const monthlyGross = Math.round((monthlyNet + monthlyVat) * 100) / 100;
        const annualTotal = Math.round(monthlyNet * 12 * 100) / 100;

        // Used by the prior-services lookup AND the write target below.
        // Declared once here so both can reference it.
        const txnId = String(txn.Id || innerTxn.Id);

        // Load prior services on this row's existing live_billing entry.
        // Staff-set flags must survive the rebuild from QBO:
        //   - recurring_status ('ending')
        //   - duplicate_acknowledged + ack metadata
        //   - pending_monthly_amount and pending_* (staged uplifts)
        //   - last_uplift_* (history of pushed uplifts)
        // QBO is authoritative for amounts/cadence/description — those
        // come from the template each pull.
        //
        // Lookup priority (matters!):
        //   1. The row already linked to THIS template by qbo_recurring_txn_id.
        //   2. Fallback to the entity's unlinked manual row (orphan-attach case).
        //
        // The earlier .or() + ORDER BY last_synced_qbo picked whichever
        // row was synced most recently — which meant if an entity had
        // both a template-linked row and an orphan, the orphan's blank
        // services could "win" and overwrite the template's acknowledged
        // flags. Bug surfaced as the Import tab forgetting acknowledged
        // duplicates after every QBO refresh.
        // Rows already linked to this template. This used to be
        // .maybeSingle(), which ERRORS when more than one row matches —
        // and the error was silently discarded, so the code fell through
        // to "no existing row" and inserted a fresh duplicate. Four
        // templates with legacy dup rows therefore minted one new row
        // EACH per nightly pull (~100 phantom rows, ~£23k/mo of phantom
        // recurring by 2026-08-06, sql/188). Fetch the whole set, pick a
        // canonical row, and cancel the surplus so the book self-heals.
        const { data: linkedRowsRaw, error: linkedErr } = await sb
          .from("live_billing")
          .select("id, status, services")
          .eq("qbo_recurring_txn_id", txnId)
          .order("last_synced_qbo", { ascending: false, nullsFirst: false });
        if (linkedErr) throw new Error(`linked-row lookup: ${linkedErr.message}`);
        const linkedRows = (linkedRowsRaw || []) as Array<{ id: string; status: string; services: unknown }>;
        const canonical = linkedRows.find((r) => r.status === "active") || linkedRows[0] || null;
        const extraActive = canonical
          ? linkedRows.filter((r) => r.status === "active" && r.id !== canonical.id)
          : [];
        if (extraActive.length > 0) {
          const { error: dupErr } = await sb
            .from("live_billing")
            .update({ status: "cancelled", qbo_sync_status: "synced", last_synced_qbo: now })
            .in("id", extraActive.map((r) => r.id));
          if (dupErr) throw new Error(`duplicate cancel: ${dupErr.message}`);
          stats.duplicates_cancelled += extraActive.length;
        }

        // No linked row → fall back to the entity's biggest unlinked
        // manual row (orphan-attach). One row serves as BOTH the prior-
        // services source and the write target below — previously two
        // separate lookups with different orderings could pick two
        // different rows.
        let orphan: { id: string; services: unknown } | null = null;
        if (!canonical) {
          const { data: orphanArr, error: orphanErr } = await sb
            .from("live_billing")
            .select("id, services")
            .eq("entity_id", entity.id)
            .eq("status", "active")
            .is("qbo_recurring_txn_id", null)
            .order("monthly_net", { ascending: false })
            .limit(1);
          if (orphanErr) throw new Error(`orphan lookup: ${orphanErr.message}`);
          orphan = (orphanArr && orphanArr[0]) || null;
        }
        const priorRow: { services: unknown } | null = canonical || orphan;
        const priorTplServicesById = new Map<string, Record<string, unknown>>();
        for (const s of (priorRow?.services as Array<Record<string, unknown>> | null) || []) {
          if (s.service_id) priorTplServicesById.set(String(s.service_id), s);
        }
        const preserveKeys = [
          "recurring_status",
          "duplicate_acknowledged",
          "duplicate_acknowledged_by",
          "duplicate_acknowledged_at",
          "pending_monthly_amount",
          "pending_effective_at",
          "pending_uplift_reason",
          "pending_uplift_staged_at",
          "pending_uplift_strategy",
          "last_uplift_at",
          "last_uplift_reason",
          "last_uplift_pushed_at",
          "qbo_item_id",
        ];

        // Recurring-txn services are auto-approved — a QBO template is
        // explicit staff intent, not an inference. Staff can still edit
        // via the review queue.
        const services = lines.map((l: Record<string, unknown>) => {
          const detail = l.SalesItemLineDetail as Record<string, unknown> | undefined;
          const itemRef = detail?.ItemRef as Record<string, unknown> | undefined;
          const perOccurrence = Number(l.Amount) || 0;
          const monthly = Math.round(perOccurrence * factor * 100) / 100;
          const sid = itemRef ? String(itemRef.name || "service") : "service";
          const prior = priorTplServicesById.get(sid);
          const preserved: Record<string, unknown> = {};
          if (prior) {
            for (const k of preserveKeys) {
              if (prior[k] !== undefined && prior[k] !== null) preserved[k] = prior[k];
            }
          }
          return {
            service_id: sid,
            description: String(l.Description || ""),
            cadence: tplCadence,
            cadence_months: tplCadenceMonths,
            monthly_amount: monthly,
            annual_amount: Math.round(monthly * 12 * 100) / 100,
            approval_status: "approved" as const,
            approved_by: "system:qbo_template",
            approved_at: now,
            billing_type: "recurring" as const,
            ...preserved,
            // QBO item ID, fresh from the template each pull — the durable
            // join key. service_id above is the item NAME, which broke 456
            // service entries when the 2026-08-04 rebuild renamed 14 items
            // (see billingComparison.js RENAMED). Consumers should migrate
            // to matching on qbo_item_id; set AFTER ...preserved so the
            // live value always wins over a stale preserved one.
            ...(itemRef?.value != null ? { qbo_item_id: String(itemRef.value) } : {}),
          };
        });

        // Write into the canonical linked row, else the orphan found
        // above (attach the template to it rather than insert a
        // duplicate), else insert a new row. Writes are CHECKED — an
        // unchecked write + unconditional stats.updated++ is how a
        // check-constraint rejection stayed invisible for 3.5 months
        // (sql/182); a thrown error lands in stats.errors via the
        // per-template catch below.
        const existing = canonical || orphan;

        if (existing) {
          const { error: upErr } = await sb.from("live_billing").update({
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
          if (upErr) throw new Error(`live_billing update: ${upErr.message}`);
          stats.updated++;
        } else {
          const { error: insErr } = await sb.from("live_billing").insert({
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
          if (insErr) throw new Error(`live_billing insert: ${insErr.message}`);
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
    // Also track which ENTITIES already have a template-linked row,
    // so historic invoices on a sibling/legacy QBO customer (e.g.
    // "Mark Cruse Joinery" #317 mapped to Cruse Joinery Limited) don't
    // create a parallel manual row.
    const entitiesWithRecurring = new Set<string>();
    for (const txn of recurringTxns) {
      const innerTxn = (txn.Invoice || txn.SalesReceipt || txn) as Record<string, unknown>;
      const customerRef = (innerTxn.CustomerRef || txn.CustomerRef) as Record<string, unknown> | undefined;
      const recurringInfo = (innerTxn.RecurringInfo || txn.RecurringInfo) as Record<string, unknown> | undefined;
      const scheduleInfo = (recurringInfo?.ScheduleInfo as Record<string, unknown> | undefined);
      const nextDate = String(recurringInfo?.NextDate || scheduleInfo?.NextDate || "");
      const isActive = recurringInfo?.Active !== false;
      // Only count live templates — dormant ones don't bill and
      // shouldn't suppress invoice-inference for an entity.
      if (!customerRef || !isActive || !nextDate) continue;
      const qboCustomerId = String(customerRef.value);
      customersWithRecurring.add(qboCustomerId);
      const entId = entityIdByQboId.get(qboCustomerId);
      if (entId) entitiesWithRecurring.add(entId);
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

        // Sibling-customer guard: if this entity already has a live
        // QBO template (e.g. Cruse Joinery Limited's primary customer
        // #826 has template 22556), don't synthesise a manual row
        // from a different customer (#317 "Mark Cruse Joinery") whose
        // historic invoices roll into the same entity.
        if (entitiesWithRecurring.has(entity.id as string)) {
          stats.one_off_skipped++;
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
        // .maybeSingle() errors when multiple matches exist (legacy
        // dup rows from earlier pulls) — order+limit instead so we
        // deterministically pick the latest manual row and merge into
        // it, leaving duplicates alone. Also filter on status='active'
        // so we don't reactivate cancelled rows.
        const { data: existingForMergeArr } = await sb
          .from("live_billing")
          .select("id, services")
          .eq("entity_id", entity.id)
          .eq("status", "active")
          .is("qbo_recurring_txn_id", null)
          .order("last_synced_qbo", { ascending: false, nullsFirst: false })
          .limit(1);
        const existingForMerge = (existingForMergeArr && existingForMergeArr[0]) || null;
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

          // Staff-set flags that must survive an invoice-inference
          // re-pull (mirroring the template-path preservation just
          // above). Without this, marking a service as 'ending' or
          // acknowledging a duplicate gets wiped every pull.
          const preserveKeys = [
            "recurring_status",
            "duplicate_acknowledged",
            "duplicate_acknowledged_by",
            "duplicate_acknowledged_at",
            "pending_monthly_amount",
            "pending_effective_at",
            "pending_uplift_reason",
            "pending_uplift_staged_at",
            "pending_uplift_strategy",
            "last_uplift_at",
            "last_uplift_reason",
            "last_uplift_pushed_at",
            "qbo_item_id",
          ];
          const preserved: Record<string, unknown> = {};
          if (prior) {
            for (const k of preserveKeys) {
              if (prior[k] !== undefined && prior[k] !== null) preserved[k] = prior[k];
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
            ...preserved,
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

        // Check the write. This used to be fire-and-forget with an
        // unconditional stats.updated++, which hid a check-constraint
        // rejection for 3.5 months: billing_type 'annual' was not in the
        // allowed list (sql/182), so every all-annual-cadence customer's row
        // silently failed to update and froze — 65 rows, £244k of stated
        // annual value, still carrying pre-rebuild names and a 12x annual
        // overstatement. A pull that cannot write must say so.
        if (existingRow) {
          const { error: upErr } = await sb.from("live_billing").update(writeFields).eq("id", existingRow.id);
          if (upErr) {
            stats.errors.push(`${entity.name} (live_billing update): ${upErr.message}`);
          } else {
            stats.updated++;
          }
        } else {
          const { error: insErr } = await sb.from("live_billing").insert({
            entity_id: entity.id,
            status: "active",
            ...writeFields,
          });
          if (insErr) {
            stats.errors.push(`${entity.name} (live_billing insert): ${insErr.message}`);
          } else {
            stats.one_off_created++;
            stats.created++;
          }
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
