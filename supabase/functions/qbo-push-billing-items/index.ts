import { getServiceClient, qboFetch, qboQuery, logSync, jsonResponse, corsHeaders } from "../_shared/qbo-client.ts";

// Push one-off Billing module items (billing_items) to QBO as real
// invoices. For each approved item we ensure the QBO customer exists, map
// every line's service to a real QBO item (via qbo_service_items — never a
// silent auto-create), ensure the customer carries an email + billing address, build a
// single line at the net amount with the company's configured sales VAT
// code, create the invoice (stamped with the billing address), then
// either email it immediately or leave it as a draft for the team to send
// from QBO later.
//
// Client billing details (email + address) are MANDATORY before any real
// QBO write — mirroring the Fee Engine commit flow. The dry-run resolves
// them with the same fallback chain so the confirm modal can pre-fill and
// the user can fix any gaps before committing:
//   Athena (entities.billing_*) -> the QBO customer record
//   -> the live recurring template's BillEmail/BillAddr -> a group member's
//   address. A portal-user address is surfaced as a read-only hint.
//
// Input: { billing_item_ids: string[], send: boolean, send_map?: Record<id, boolean>,
//          dry_run?: boolean, due_days?: number, initiated_by?: string }
//   send=true  -> create + email the invoice (QBO SendInvoice)
//   send=false -> create only; team sends from QBO later
//   send_map   -> per-item override of `send`, keyed by billing_item_id, so a
//                 single batch can mix invoices to email now with drafts
//   due_days   -> payment terms; DueDate = invoice date + due_days (default 14)
//   link_customer    -> { [entity_id]: qbo_customer_id } — map this client to an
//                       existing QBO customer (stored on the entity)
//   new_customer_ok  -> { [entity_id]: true } — explicit consent to create a
//                       brand-new QBO customer for this client
//   new_customer_name-> { [entity_id]: string } — the DisplayName to create it
//                       under. Defaults to the Athena name, which is usually
//                       BM's title-cased import ("Wmr Pensions And Investments
//                       Ltd"); the customer name shows on every invoice, so it
//                       has to be fixable before the customer exists.
//   dry_run=true -> read-only plan (no QBO/DB writes).
//
// Customer mapping is never guessed. An entity with a stored qbo_customer_id
// uses it; otherwise only an EXACT DisplayName match auto-links. Anything else
// is a decision for the user: the dry-run returns near-match candidates and the
// push refuses to invent a customer without new_customer_ok. Athena names
// clients "Surname, Firstname" while QBO often carries the trading name
// ("GJ Cummins Plumbing and Heating Services"), so an unguarded create silently
// splits a client's history across two QBO customers.
//
// Per-item isolation: one failure never aborts the batch.

interface ItemResult {
  billing_item_id: string;
  entity: string;
  status: "sent" | "created_unsent" | "error";
  qbo_invoice_id?: string;
  qbo_doc_number?: string | null;
  reason?: string;
}

type RecurringTpl = {
  id: string;
  syncToken: string;
  name: string;
  active: boolean;
  nextDate: string | null;
  billEmail: string | null;
  billAddr: Record<string, unknown> | null;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }
  if (req.method !== "POST") {
    return jsonResponse({ success: false, error: "POST required" }, 405);
  }

  let body: { billing_item_ids?: string[]; send?: boolean; send_map?: Record<string, boolean>; dry_run?: boolean; refresh?: boolean; list_invoices?: boolean; check_settings?: boolean; assign_numbers?: boolean; entity_id?: string; due_days?: number; initiated_by?: string; link_customer?: Record<string, string>; new_customer_ok?: Record<string, boolean>; new_customer_name?: Record<string, string> };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ success: false, error: "Invalid JSON" }, 400);
  }

  const ids = Array.isArray(body.billing_item_ids) ? body.billing_item_ids : [];
  const send = body.send !== false; // default to sending
  // Per-item send/draft override, keyed by billing_item_id. The confirm
  // modal sets one per row; `send` is only the fallback for ids it omits.
  const sendMap = (body.send_map && typeof body.send_map === "object") ? body.send_map : null;
  const sendFor = (id: string): boolean =>
    (sendMap && Object.prototype.hasOwnProperty.call(sendMap, id)) ? !!sendMap[id] : send;
  // Invoice payment terms: due N days after the invoice date (default 14).
  const dueDays = Number.isFinite(Number(body.due_days)) && Number(body.due_days) >= 0 ? Number(body.due_days) : 14;
  // Per-client customer decisions from the confirm modal, keyed by entity id.
  const linkCustomer = (body.link_customer && typeof body.link_customer === "object") ? body.link_customer : {};
  const newCustomerOk = (body.new_customer_ok && typeof body.new_customer_ok === "object") ? body.new_customer_ok : {};
  const newCustomerName = (body.new_customer_name && typeof body.new_customer_name === "object") ? body.new_customer_name : {};
  const sb = getServiceClient();

  // ── Refresh mode ── re-confirm DocNumber + EmailStatus from QBO for
  // already-pushed bills (no creates, no sends). Runs against the supplied
  // ids, or every pushed bill when none are given. Piggybacks the QBO
  // query layer rather than the heavy fee-engine pull.
  if (body.refresh) {
    const sel = sb.from("billing_items").select("id, qbo_invoice_id").eq("status", "pushed").not("qbo_invoice_id", "is", null);
    const { data: rows, error } = ids.length ? await sel.in("id", ids) : await sel;
    if (error) return jsonResponse({ success: false, error: error.message }, 500);
    const byInvId = new Map<string, string>(); // qbo_invoice_id -> billing_item id
    for (const r of rows || []) { if (r.qbo_invoice_id) byInvId.set(String(r.qbo_invoice_id), r.id as string); }
    const invIds = [...byInvId.keys()];
    if (invIds.length === 0) return jsonResponse({ success: true, refreshed: [] });
    const nowIso = new Date().toISOString();
    const refreshed: Array<Record<string, unknown>> = [];
    // Batch the IN clause to stay well under QBO query limits.
    for (let i = 0; i < invIds.length; i += 50) {
      const inList = invIds.slice(i, i + 50).map((x) => `'${x.replace(/'/g, "\\'")}'`).join(", ");
      const result = await qboQuery(`SELECT Id, DocNumber, EmailStatus FROM Invoice WHERE Id IN (${inList})`) as Record<string, unknown>;
      const qr = (result?.QueryResponse as Record<string, unknown>) || {};
      for (const inv of (qr.Invoice as Array<Record<string, unknown>>) || []) {
        const biId = byInvId.get(String(inv.Id));
        if (!biId) continue;
        const docNumber = inv.DocNumber != null ? String(inv.DocNumber) : null;
        const emailStatus = inv.EmailStatus ? String(inv.EmailStatus) : null;
        await sb.from("billing_items").update({
          qbo_doc_number: docNumber, qbo_email_status: emailStatus, qbo_last_checked_at: nowIso,
        }).eq("id", biId);
        refreshed.push({ billing_item_id: biId, doc_number: docNumber, email_status: emailStatus });
      }
    }
    return jsonResponse({ success: true, refreshed });
  }

  // ── List-invoices mode ── pull the last 24 months of a client's QBO
  // invoices (with line detail) so the user can copy a past invoice into a
  // new bill. Read-only; no DB writes.
  if (body.list_invoices) {
    if (!body.entity_id) return jsonResponse({ success: false, error: "entity_id required" }, 400);
    const { data: ent } = await sb.from("entities").select("id, name, qbo_customer_id").eq("id", body.entity_id).single();
    if (!ent) return jsonResponse({ success: false, error: "Client not found" }, 404);
    let custId = (ent.qbo_customer_id as string) || null;
    if (!custId) custId = await findCustomerByName(String(ent.name || ""));
    if (!custId) return jsonResponse({ success: true, customer_found: false, invoices: [] });

    const since = new Date();
    since.setMonth(since.getMonth() - 24);
    const sinceIso = since.toISOString().slice(0, 10);
    const result = await qboQuery(
      `SELECT * FROM Invoice WHERE CustomerRef = '${String(custId).replace(/'/g, "\\'")}' AND TxnDate >= '${sinceIso}' ORDERBY TxnDate DESC MAXRESULTS 1000`,
    ) as Record<string, unknown>;
    const qr = (result?.QueryResponse as Record<string, unknown>) || {};
    const rows = (qr.Invoice as Array<Record<string, unknown>>) || [];
    const invoices = rows.map((inv) => ({
      id: String(inv.Id),
      doc_number: inv.DocNumber != null ? String(inv.DocNumber) : null,
      txn_date: String(inv.TxnDate || ""),
      total_amt: Number(inv.TotalAmt) || 0,
      balance: Number(inv.Balance) || 0,
      lines: ((inv.Line as Array<Record<string, unknown>>) || [])
        .filter((l) => l.DetailType === "SalesItemLineDetail")
        .map((l) => {
          const d = (l.SalesItemLineDetail as Record<string, unknown>) || {};
          const ref = (d.ItemRef as Record<string, unknown>) || {};
          return {
            service: ref.name ? String(ref.name) : "",
            description: l.Description ? String(l.Description) : "",
            qty: Number(d.Qty) || 1,
            unit_price: Number(d.UnitPrice) || 0,
            amount: Number(l.Amount) || 0,
          };
        }),
    }));
    return jsonResponse({ success: true, customer_found: true, invoices });
  }

  // ── Check-settings mode ── read the QBO company's sales preferences so
  // the UI can confirm whether "Custom transaction numbers" is on (which
  // leaves API-created invoices without an auto-assigned DocNumber).
  if (body.check_settings) {
    try {
      const result = await qboQuery("SELECT * FROM Preferences") as Record<string, unknown>;
      const qr = (result?.QueryResponse as Record<string, unknown>) || {};
      const prefs = ((qr.Preferences as Array<Record<string, unknown>>) || [])[0] || {};
      const sales = (prefs.SalesFormsPrefs as Record<string, unknown>) || {};
      return jsonResponse({ success: true, custom_txn_numbers: sales.CustomTxnNumbers === true });
    } catch (e) {
      return jsonResponse({ success: false, error: (e as Error).message }, 500);
    }
  }

  // ── Assign-numbers mode ── one-off cleanup for invoices pushed while QBO
  // had "Custom transaction numbers" on (so they have no DocNumber). With
  // that setting now off, a full update with DocNumber omitted makes QBO
  // assign the next sequential number — the same as hitting Save in the UI.
  if (body.assign_numbers) {
    const sel = sb.from("billing_items").select("id, qbo_invoice_id").eq("status", "pushed").not("qbo_invoice_id", "is", null).is("qbo_doc_number", null);
    const { data: rows, error } = ids.length ? await sel.in("id", ids) : await sel;
    if (error) return jsonResponse({ success: false, error: error.message }, 500);
    const nowIso = new Date().toISOString();
    const assigned: Array<Record<string, unknown>> = [];
    for (const r of rows || []) {
      const invId = String(r.qbo_invoice_id);
      try {
        const getResp = await qboFetch(`invoice/${invId}`);
        if (!getResp.ok) throw new Error(`fetch failed: ${getResp.status} ${await getResp.text()}`);
        const inv = ((await getResp.json()) as { Invoice: Record<string, unknown> }).Invoice;
        if (inv.DocNumber) {
          const doc = String(inv.DocNumber);
          await sb.from("billing_items").update({ qbo_doc_number: doc, qbo_last_checked_at: nowIso }).eq("id", r.id);
          assigned.push({ billing_item_id: r.id, qbo_invoice_id: invId, doc_number: doc, action: "already_numbered" });
          continue;
        }
        // Full update (not sparse) with DocNumber omitted → QBO auto-assigns.
        const payload = { ...inv };
        delete payload.DocNumber;
        const upd = await qboFetch("invoice", { method: "POST", body: JSON.stringify(payload) });
        if (!upd.ok) throw new Error(`update failed: ${upd.status} ${await upd.text()}`);
        const updated = ((await upd.json()) as { Invoice: Record<string, unknown> }).Invoice;
        const doc = updated.DocNumber != null ? String(updated.DocNumber) : null;
        await sb.from("billing_items").update({ qbo_doc_number: doc, qbo_last_checked_at: nowIso }).eq("id", r.id);
        assigned.push({ billing_item_id: r.id, qbo_invoice_id: invId, doc_number: doc, action: doc ? "assigned" : "still_blank" });
      } catch (e) {
        assigned.push({ billing_item_id: r.id, qbo_invoice_id: invId, error: (e as Error).message });
      }
    }
    return jsonResponse({ success: true, assigned });
  }

  if (ids.length === 0) {
    return jsonResponse({ success: false, error: "billing_item_ids required" }, 400);
  }

  const { data: items, error: itemsErr } = await sb
    .from("billing_items")
    .select("*, entity:entities(id, name, qbo_customer_id, qbo_customer_name, billing_email, prospect_email, billing_line1, billing_line2, billing_city, billing_postcode)")
    .in("id", ids);

  if (itemsErr) {
    return jsonResponse({ success: false, error: itemsErr.message }, 500);
  }

  // Tax code: prefer the connection's configured default (a known-good
  // sales VAT code), else fall back to a 20% lookup. Mirrors qbo-push.
  let taxCodeId: string | null = null;
  try {
    const { data: conn } = await sb.from("qbo_connections").select("default_tax_code_id").eq("status", "active").single();
    taxCodeId = (conn?.default_tax_code_id as string) || await resolveStandardTaxCode();
  } catch (err) {
    return jsonResponse({ success: false, error: `Could not resolve VAT tax code: ${(err as Error).message}` }, 500);
  }
  if (!taxCodeId) {
    return jsonResponse({ success: false, error: "No sales VAT tax code configured. Set qbo_connections.default_tax_code_id or QBO_STANDARD_TAX_CODE_ID." }, 500);
  }

  // Service → QBO item map (qbo_service_items). Every billing line resolves
  // its product through this, so an ad-hoc service like "Admin" points at a
  // real QBO item + income account instead of silently auto-creating a
  // catch-all. Loaded once; used by both the dry-run plan and the push.
  const { map: serviceMap, names: itemNames } = await loadServiceItemMap(sb);

  // Which of these clients are VAT registered. Only needed by the handful of
  // services that exist as a VAT / non-VAT pair in QBO (see
  // VAT_VARIANT_SERVICES) — a generic "Bookkeeping" line has to pick one.
  const vatRegistered = await loadVatRegisteredEntities(
    sb,
    [...new Set((items || []).map((i) => (i.entity as Record<string, unknown> | null)?.id as string).filter(Boolean))],
    itemNames,
  );

  // Dry run: read-only plan for the confirmation summary. No QBO or DB
  // writes. Reports per item whether the customer/item already exist, and
  // the resolved billing contact (email + address) with picker options.
  if (body.dry_run) {
    const plan = [];
    // Cache the resolved contact per entity — billing items often share a
    // client, and the contact resolution can hit QBO multiple times.
    const contactCache = new Map<string, Awaited<ReturnType<typeof buildContact>>>();
    for (const item of (items || [])) {
      const entity = (item.entity as Record<string, unknown> | null) || null;
      const entityName = (entity?.name as string) || "Unknown Client";
      const serviceName = String(item.service || "Professional Services");

      const cacheKey = (entity?.id as string) || entityName;
      let contact = contactCache.get(cacheKey);
      if (!contact) {
        contact = await buildContact(sb, entity, entityName);
        contactCache.set(cacheKey, contact);
      }

      // Each distinct line service must resolve to a QBO item through the
      // map. Anything left over is UNMAPPED and will block the push, so
      // surface it in the plan. Shares resolveItemId with the push, so the
      // plan can't disagree with what the push will actually do.
      const isVatReg = vatRegistered.has((entity?.id as string) || "");
      const lineServices = [...new Set(normalizeLines(item).map((l) => l.service))];
      const unmapped = lineServices.filter((s) => !resolveItemId(s, serviceMap, isVatReg));
      // Which QBO product each line will actually land on. For a VAT-variant
      // service that is not the same as the service's own name, so the modal
      // can show the leaf that was picked rather than the label chosen.
      const products = lineServices.map((s) => {
        const id = resolveItemId(s, serviceMap, isVatReg);
        return { service: s, qbo_item_id: id, qbo_item_name: id ? (itemNames.get(id) || null) : null };
      });

      plan.push({
        billing_item_id: item.id,
        entity: entityName,
        service: serviceName,
        approved: item.status === "approved",
        customer_action: contact.customer_exists ? "existing" : "create",
        // Which QBO customer this invoice lands on, by name — Athena's
        // "Surname, Firstname" often maps to a trading name, and that's only
        // obvious if the modal says so before the push.
        qbo_customer_id: contact.customer_id,
        qbo_customer_name: contact.customer_name,
        customer_source: contact.customer_source,
        customer_inactive: contact.customer_inactive,
        customer_missing: contact.customer_missing,
        customer_candidates: contact.customer_candidates,
        entity_id: (entity?.id as string) || null,
        item_action: unmapped.length ? "unmapped" : "existing",
        unmapped,
        products,
        vat_registered: isVatReg,
        // Resolved contact + picker options (mirrors qbo-push contact block).
        has_email: contact.has_email,
        email: contact.email,
        email_source: contact.email_source,
        email_mismatch: contact.email_mismatch,
        athena_email: contact.athena_email,
        qbo_email: contact.qbo_email,
        has_address: contact.has_address,
        address: contact.address,
        address_hint: contact.address_hint,
        email_options: contact.email_options,
        address_options: contact.address_options,
        missing: contact.missing,
        net: Number(item.net_amount) || 0,
        vat: Number(item.vat_amount) || 0,
        gross: Number(item.gross_amount) || 0,
      });
    }
    return jsonResponse({ success: true, dry_run: true, plan });
  }

  // Resolve (or create) the QBO Term matching the due-date offset so each
  // invoice carries a Terms value (e.g. "Net 14"), not just a bare due
  // date. Non-fatal: if it can't be resolved we still set DueDate.
  const salesTermId = await ensureSalesTermId(dueDays);

  // service name -> QBO item id. Keyed with the client's VAT flag too: a
  // VAT-variant service resolves to a different product per client, so a
  // service-only key would leak the first client's leaf across the batch.
  const itemCache = new Map<string, string>();
  const results: ItemResult[] = [];
  let sent = 0, created = 0, errored = 0;

  for (const item of (items || [])) {
    const entity = (item.entity as Record<string, unknown> | null) || null;
    const entityName = (entity?.name as string) || "Unknown Client";

    if (item.status !== "approved") {
      results.push({ billing_item_id: item.id, entity: entityName, status: "error", reason: `status=${item.status} (not approved)` });
      errored++;
      continue;
    }

    try {
      // Resolve the mandatory billing contact (email + address). Athena
      // wins; anything missing falls back through QBO / recurring template
      // / group member. The confirm modal saves the chosen values to the
      // entity before pushing, so for a clean push these come straight
      // from Athena.
      const localEmail = (entity?.billing_email as string) || (entity?.prospect_email as string) || null;
      let email = localEmail;
      let billAddr = buildBillAddr(entity);
      if (!email || !billAddr) {
        const contact = await buildContact(sb, entity, entityName);
        if (!email) email = contact.email;
        if (!billAddr) billAddr = contact.address;
      }

      // Mandatory: client email + address must be present before we create
      // anything in QBO. Per-item — never aborts the rest of the batch.
      const missing: string[] = [];
      if (!email) missing.push("client email");
      if (!billAddr) missing.push("client address (line 1 + postcode)");
      if (missing.length > 0) {
        results.push({ billing_item_id: item.id, entity: entityName, status: "error", reason: `Mandatory client details missing: ${missing.join(", ")}. Add them before pushing.` });
        errored++;
        await sb.from("billing_items").update({ qbo_sync_status: "error", qbo_sync_error: `missing ${missing.join(", ")}` }).eq("id", item.id);
        continue;
      }

      // 1. Resolve the QBO customer — never guessed, and never invented
      //    without being asked. Stored mapping > the user's explicit pick >
      //    exact name match > explicit consent to create. Anything else stops
      //    this item, because the wrong branch here splits a client's billing
      //    history across two QBO customers and that's a pain to unpick.
      let qboCustomerId = (entity?.qbo_customer_id as string) || null;
      if (!qboCustomerId) {
        const entityId = (entity?.id as string) || "";
        const picked = entityId ? linkCustomer[entityId] : null;
        if (picked) {
          const all = await loadAllCustomers();
          const chosen = all.find((c) => c.id === String(picked));
          if (!chosen) {
            results.push({ billing_item_id: item.id, entity: entityName, status: "error", reason: `QuickBooks customer ${picked} not found — re-open the push and pick again.` });
            errored++;
            await sb.from("billing_items").update({ qbo_sync_status: "error", qbo_sync_error: `customer ${picked} not found` }).eq("id", item.id);
            continue;
          }
          qboCustomerId = chosen.id;
          await sb.from("entities").update({ qbo_customer_id: chosen.id, qbo_customer_name: chosen.name || chosen.companyName }).eq("id", entityId);
        } else {
          const exact = await matchCustomerByName(entityName);
          if (exact) {
            qboCustomerId = exact.id;
            if (entityId) await sb.from("entities").update({ qbo_customer_id: exact.id, qbo_customer_name: exact.name || exact.companyName }).eq("id", entityId);
          } else if (entityId && newCustomerOk[entityId] === true) {
            // The name to create under: the user's edit, else the Athena name.
            const wanted = String(newCustomerName[entityId] ?? "").trim() || entityName;
            // QBO enforces unique DisplayName and rejects a clash with a
            // terse duplicate-name error. Catch it here so the message names
            // the customer that's already sitting there.
            const clash = (await loadAllCustomers()).find((c) => c.name.toLowerCase() === wanted.toLowerCase());
            if (clash) {
              results.push({ billing_item_id: item.id, entity: entityName, status: "error", reason: `QuickBooks already has a customer called "${clash.name}" (#${clash.id}). Link this client to it instead of creating another.` });
              errored++;
              await sb.from("billing_items").update({ qbo_sync_status: "error", qbo_sync_error: "customer name already exists" }).eq("id", item.id);
              continue;
            }
            qboCustomerId = await ensureQboCustomer(sb, entity, wanted);
          } else {
            const near = await nearMatchCustomers(entityName, 3);
            const hint = near.length
              ? ` Similar customers already in QuickBooks: ${near.map((c) => c.name || c.companyName).join("; ")}.`
              : "";
            const reason = `No QuickBooks customer mapped to "${entityName}".${hint} Link it to the right customer, or confirm creating a new one, before pushing.`;
            results.push({ billing_item_id: item.id, entity: entityName, status: "error", reason });
            errored++;
            await sb.from("billing_items").update({ qbo_sync_status: "error", qbo_sync_error: "customer not mapped" }).eq("id", item.id);
            continue;
          }
        }
      }

      // 2. Make sure email + address are on the customer record itself,
      //    even when the customer already existed. Sparse update.
      await ensureCustomerContactDetails(qboCustomerId, email, billAddr);

      // 3. Build the invoice lines. Each billing line becomes one QBO
      //    SalesItemLineDetail at its net amount + the sales VAT code, so
      //    QBO computes VAT. Qty/rate carry through where the line has a
      //    genuine split, so "10 x £100" invoices as that rather than a flat
      //    £1,000. Ensure a QBO item per distinct service.
      const lines = normalizeLines(item);
      const isVatReg = vatRegistered.has((entity?.id as string) || "");
      const lineItems: Array<Record<string, unknown>> = [];
      for (const l of lines) {
        const cacheKey = `${isVatReg ? "vat" : "novat"}|${l.service}`;
        let qboItemId = itemCache.get(cacheKey);
        if (!qboItemId) {
          qboItemId = resolveQboItemId(l.service, serviceMap, isVatReg);
          itemCache.set(cacheKey, qboItemId);
        }
        lineItems.push({
          DetailType: "SalesItemLineDetail",
          Amount: l.net,
          Description: l.description || l.service,
          SalesItemLineDetail: { ItemRef: { value: qboItemId }, Qty: l.qty, UnitPrice: l.rate, TaxCodeRef: { value: taxCodeId } },
        });
      }
      const net = lines.reduce((s, l) => s + l.net, 0);

      // 4. Build + create the invoice, stamped with the billing address + email.
      const txnDate = new Date().toISOString().slice(0, 10);
      const invoiceBody: Record<string, unknown> = {
        CustomerRef: { value: qboCustomerId },
        TxnDate: txnDate,
        DueDate: addDays(txnDate, dueDays),
        Line: lineItems,
      };
      if (salesTermId) invoiceBody.SalesTermRef = { value: salesTermId };
      if (email) invoiceBody.BillEmail = { Address: email };
      if (billAddr) invoiceBody.BillAddr = billAddr;

      const createResp = await qboFetch("invoice", {
        method: "POST",
        body: JSON.stringify(invoiceBody),
      });
      if (!createResp.ok) {
        throw new Error(`create invoice failed: ${createResp.status} ${await createResp.text()}`);
      }
      const created_ = await createResp.json();
      const qboInvoiceId = String(created_.Invoice.Id);
      // Confirm the invoice number + send state straight from the response.
      const qboDocNumber = created_.Invoice.DocNumber != null ? String(created_.Invoice.DocNumber) : null;
      let qboEmailStatus = created_.Invoice.EmailStatus ? String(created_.Invoice.EmailStatus) : null;

      // 5. Send now, or leave as draft — per-item choice from the modal.
      const sendThis = sendFor(item.id);
      let finalStatus: ItemResult["status"];
      if (sendThis && email) {
        const sendResp = await qboFetch(`invoice/${qboInvoiceId}/send?sendTo=${encodeURIComponent(email)}`, {
          method: "POST",
        });
        if (!sendResp.ok) {
          throw new Error(`invoice created (${qboInvoiceId}) but send failed: ${sendResp.status} ${await sendResp.text()}`);
        }
        // The send response returns the updated invoice (EmailStatus=EmailSent).
        const sentInv = await sendResp.json().catch(() => null);
        qboEmailStatus = sentInv?.Invoice?.EmailStatus ? String(sentInv.Invoice.EmailStatus) : "EmailSent";
        finalStatus = "sent";
        sent++;
      } else {
        finalStatus = "created_unsent";
        created++;
      }

      // 6. Write back.
      await sb.from("billing_items").update({
        status: "pushed",
        qbo_invoice_id: qboInvoiceId,
        qbo_doc_number: qboDocNumber,
        qbo_email_status: qboEmailStatus,
        qbo_customer_id: qboCustomerId,
        qbo_sync_status: finalStatus,
        qbo_synced_at: new Date().toISOString(),
        qbo_last_checked_at: new Date().toISOString(),
        qbo_sync_error: null,
        pushed_by: body.initiated_by || null,
        pushed_at: new Date().toISOString(),
      }).eq("id", item.id);

      results.push({
        billing_item_id: item.id,
        entity: entityName,
        status: finalStatus,
        qbo_invoice_id: qboInvoiceId,
        qbo_doc_number: qboDocNumber,
        reason: finalStatus === "created_unsent" && sendThis && !email ? "no client email on file - created as draft" : undefined,
      });

      await logSync({
        direction: "push",
        entity_id: (entity?.id as string) || undefined,
        entity_name: entityName,
        qbo_entity_type: "Invoice",
        qbo_entity_id: qboInvoiceId,
        status: "success",
        detail: { billing_item_id: item.id, net, lines: lines.length, doc_number: qboDocNumber, sent: finalStatus === "sent", due_days: dueDays },
        initiated_by: body.initiated_by || undefined,
      });
    } catch (err) {
      errored++;
      const message = (err as Error).message;
      results.push({ billing_item_id: item.id, entity: entityName, status: "error", reason: message });
      await sb.from("billing_items").update({
        qbo_sync_status: "error",
        qbo_sync_error: message,
      }).eq("id", item.id);
      await logSync({
        direction: "push",
        entity_id: (entity?.id as string) || undefined,
        entity_name: entityName,
        qbo_entity_type: "Invoice",
        status: "error",
        error_message: message,
        detail: { billing_item_id: item.id },
        initiated_by: body.initiated_by || undefined,
      });
    }
  }

  return jsonResponse({
    success: true,
    summary: { total: ids.length, sent, created_unsent: created, errored },
    results,
  });
});

function addDays(isoDate: string, days: number): string {
  const d = new Date(isoDate + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Normalize a billing_item's lines: use the stored multi-line array, else
// fall back to a single line built from the legacy service/net fields so
// pre-multi-line rows still push correctly.
function normalizeLines(item: Record<string, unknown>): Array<{ service: string; description: string | null; net: number; qty: number; rate: number }> {
  const raw = Array.isArray(item.lines) ? (item.lines as Array<Record<string, unknown>>) : null;
  if (raw && raw.length) {
    return raw.map((l) => {
      const net = Number(l.net) || 0;
      return { service: String(l.service || "Professional Services"), description: (l.description as string) || null, net, ...splitOf(l.qty, l.rate, net) };
    });
  }
  const net = Number(item.net_amount) || 0;
  return [{
    service: String(item.service || "Professional Services"),
    description: (item.description as string) || null,
    net,
    ...splitOf(null, null, net),
  }];
}

// A line's qty/rate only reach QBO if they actually multiply out to the
// approved amount — anything else (a legacy line with no split, a stale
// pair) invoices as one unit at the amount, exactly as before.
function splitOf(qty: unknown, rate: unknown, net: number): { qty: number; rate: number } {
  const q = Number(qty), r = Number(rate);
  const ok = Number.isFinite(q) && q > 0 && Number.isFinite(r) && Math.abs(q * r - net) < 0.005;
  return ok ? { qty: q, rate: r } : { qty: 1, rate: net };
}

// Build a QBO BillAddr from the entity's billing_* fields. Returns null
// unless there's at least a first line and a postcode — a half address is
// worse than none for a UK invoice. (Mirrors qbo-push.)
function buildBillAddr(entity: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!entity) return null;
  const line1 = String(entity.billing_line1 ?? "").trim();
  const line2 = String(entity.billing_line2 ?? "").trim();
  const city = String(entity.billing_city ?? "").trim();
  const postcode = String(entity.billing_postcode ?? "").trim();
  if (!line1 || !postcode) return null;
  const addr: Record<string, unknown> = { Line1: line1 };
  if (line2) addr.Line2 = line2;
  if (city) addr.City = city;
  addr.PostalCode = postcode;
  return addr;
}

// Map a QBO BillAddr to our form shape. Lenient (Line1 required, postcode
// optional) — used to pre-fill a form the user reviews, so a street with a
// missing postcode still beats a blank box.
function mapQboBillAddr(a: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!a) return null;
  const line1 = String((a as Record<string, unknown>).Line1 ?? "").trim();
  if (!line1) return null;
  const out: Record<string, unknown> = { Line1: line1 };
  const line2 = String((a as Record<string, unknown>).Line2 ?? "").trim(); if (line2) out.Line2 = line2;
  const city = String((a as Record<string, unknown>).City ?? "").trim(); if (city) out.City = city;
  const postcode = String((a as Record<string, unknown>).PostalCode ?? "").trim(); if (postcode) out.PostalCode = postcode;
  return out;
}

function addrLabel(a: Record<string, unknown>): string {
  return [a.Line1, a.City, a.PostalCode].map((x) => String(x ?? "").trim()).filter(Boolean).join(", ");
}
function addrKey(a: Record<string, unknown>): string {
  return `${String(a.Line1 ?? "").toLowerCase().trim()}|${String(a.PostalCode ?? "").toLowerCase().trim()}`;
}

// Resolve the billing contact (email + address) for an entity, with the
// same fallback chain as the Fee Engine: Athena -> QBO customer record ->
// live recurring template -> group member; portal-user address as a hint.
// Returns resolved values plus picker options (deduped sources) and the
// list of still-missing details.
async function buildContact(
  sb: ReturnType<typeof getServiceClient>,
  entity: Record<string, unknown> | null,
  entityName: string,
): Promise<{
  customer_exists: boolean;
  customer_id: string | null; customer_name: string | null; customer_source: "stored" | "name_match" | null;
  customer_inactive: boolean; customer_missing: boolean;
  customer_candidates: Array<{ id: string; name: string; email: string | null; address_label: string | null; active: boolean }>;
  has_email: boolean; email: string | null; email_source: string | null; email_mismatch: boolean;
  athena_email: string | null; qbo_email: string | null;
  has_address: boolean; address: Record<string, unknown> | null; address_hint: string | null;
  email_options: string[]; address_options: Array<{ label: string; addr: Record<string, unknown> }>;
  missing: string[];
}> {
  const athenaEmail = (entity?.billing_email as string) || (entity?.prospect_email as string) || null;
  const athenaAddr = buildBillAddr(entity);

  // Which QBO customer this client maps to. A stored qbo_customer_id IS the
  // mapping; failing that, only an exact name match links automatically.
  const storedId = (entity?.qbo_customer_id as string) || null;
  let customerId = storedId;
  let customerSource: "stored" | "name_match" | null = storedId ? "stored" : null;
  let matched: QboCustomer | null = null;
  if (customerId) {
    const all = await loadAllCustomers();
    matched = all.find((c) => c.id === String(customerId)) || null;
  } else {
    matched = await matchCustomerByName(entityName);
    if (matched) { customerId = matched.id; customerSource = "name_match"; }
  }

  // Unmapped → offer the near matches, so the user links the right customer
  // instead of the push quietly creating a second one under the Athena name.
  const candidates = customerId ? [] : await nearMatchCustomers(entityName);

  // The customer's own email + billing address. Read off the cached list; a
  // stored id missing from it (deleted in QBO) falls back to a direct read.
  let qboEmail: string | null = null;
  let qboAddr: Record<string, unknown> | null = null;
  if (matched) {
    qboEmail = matched.email;
    qboAddr = matched.address;
  } else if (customerId) {
    const c = await fetchQboCustomerContact(customerId);
    qboEmail = c.email;
    qboAddr = c.address;
  }

  let email = athenaEmail || qboEmail;
  let address = athenaAddr || qboAddr;
  let emailSource: string | null = athenaEmail ? "athena" : (qboEmail ? "quickbooks" : null);

  // Still missing something → look at the live recurring template (where
  // contact details often actually live for clients with running billing).
  let recEmail: string | null = null;
  let recAddr: Record<string, unknown> | null = null;
  if ((!email || !address) && customerId) {
    const tpls = await findRecurringTemplatesForCustomer(customerId);
    const live = pickLiveTemplate(tpls);
    if (live) {
      recEmail = live.billEmail;
      recAddr = mapQboBillAddr(live.billAddr);
      if (!email && recEmail) { email = recEmail; emailSource = "recurring"; }
      if (!address && recAddr) address = recAddr;
    }
  }

  // Address can also be borrowed from another member of the same billing
  // group (the address is often shared across a group).
  if (!address) {
    const gm = await findGroupMemberAddr(sb, entity);
    if (gm) address = gm;
  }

  const addressHint = address ? null : await findPortalUserAddrHint(sb, entity);

  // Picker options — deduped union of every source we found.
  const emailOptions = [...new Set([athenaEmail, qboEmail, recEmail].filter(Boolean) as string[])];
  const addrPool: Array<{ label: string; addr: Record<string, unknown> }> = [];
  const seenAddr = new Set<string>();
  for (const a of [athenaAddr, qboAddr, recAddr]) {
    if (a && !seenAddr.has(addrKey(a))) { seenAddr.add(addrKey(a)); addrPool.push({ label: addrLabel(a), addr: a }); }
  }

  const missing: string[] = [];
  if (!email) missing.push("client email");
  if (!address) missing.push("client address (line 1 + postcode)");

  return {
    customer_exists: !!customerId,
    customer_id: customerId,
    customer_name: matched ? (matched.name || matched.companyName || null) : null,
    customer_source: customerSource,
    customer_inactive: !!(matched && !matched.active),
    // A stored mapping pointing at a customer QBO no longer returns — the
    // push will fail on it, so say so up front instead of at the error line.
    customer_missing: !!(customerId && !matched),
    customer_candidates: candidates.map((c) => ({
      id: c.id,
      name: c.name || c.companyName,
      email: c.email,
      address_label: c.address ? addrLabel(c.address) : null,
      active: c.active,
    })),
    has_email: !!email, email, email_source: emailSource,
    email_mismatch: !!(qboEmail && athenaEmail && qboEmail.toLowerCase() !== athenaEmail.toLowerCase()),
    athena_email: athenaEmail, qbo_email: qboEmail,
    has_address: !!address, address, address_hint: addressHint,
    email_options: emailOptions, address_options: addrPool,
    missing,
  };
}

// Find the standard-rate 20% sales tax code. Env override wins; else
// pick an active sales TaxCode whose name mentions 20 / standard.
async function resolveStandardTaxCode(): Promise<string | null> {
  const override = Deno.env.get("QBO_STANDARD_TAX_CODE_ID");
  if (override) return override;

  const result = await qboQuery("SELECT * FROM TaxCode") as Record<string, unknown>;
  const qr = (result?.QueryResponse as Record<string, unknown>) || {};
  const codes = (qr.TaxCode as Array<Record<string, unknown>>) || [];

  // A UK company's TaxCode list is mostly codes that are NOT usable on a
  // plain domestic sales invoice: reverse charge (RC), EC goods/services,
  // imports, CIS. Several are named "20.0% ..." too, so a bare /20/ match can
  // land on one — QBO then rejects the invoice with "error while calculating
  // tax". Keep only codes that carry a sales rate and aren't special-scheme.
  const SPECIAL = /\b(RC|EC[GS]?|MPCC|import|reverse|CIS)\b/i;
  const usable = codes.filter((c) => {
    if (c.Active === false) return false;
    const salesRates = (c.SalesTaxRateList as { TaxRateDetail?: unknown[] } | undefined)?.TaxRateDetail;
    if (!Array.isArray(salesRates) || salesRates.length === 0) return false;
    return !SPECIAL.test(String(c.Name || ""));
  });

  const exactStandard = usable.find((c) => /^20(\.0+)?%\s*S$/i.test(String(c.Name || "").trim()));
  if (exactStandard) return String(exactStandard.Id);
  const byTwenty = usable.find((c) => /20/.test(String(c.Name || "")));
  if (byTwenty) return String(byTwenty.Id);
  const byStandard = usable.find((c) => /\bS\b/.test(String(c.Name || "")) || /standard/i.test(String(c.Description || "")));
  if (byStandard) return String(byStandard.Id);
  return null;
}

// Resolve (or create) a QBO sales Term whose net days match the due-date
// offset, so invoices show a Terms value (e.g. "Net 14") rather than just
// a bare DueDate. Returns null (non-fatal) if it can't be resolved.
async function ensureSalesTermId(dueDays: number): Promise<string | null> {
  if (!Number.isFinite(dueDays) || dueDays < 0) return null;
  try {
    const result = (await qboQuery(`SELECT * FROM Term`)) as Record<string, unknown>;
    const qr = (result?.QueryResponse as Record<string, unknown>) || {};
    const terms = (qr.Term as Array<Record<string, unknown>>) || [];
    const byDays = terms.find((t) => Number(t.DueDays) === dueDays && (t.Type === undefined || t.Type === "STANDARD") && t.Active !== false);
    if (byDays) return String(byDays.Id);
    const name = dueDays === 0 ? "Due on receipt" : `Net ${dueDays}`;
    const byName = terms.find((t) => String(t.Name) === name);
    if (byName) return String(byName.Id);
    const resp = await qboFetch("term", { method: "POST", body: JSON.stringify({ Name: name, DueDays: dueDays }) });
    if (!resp.ok) {
      console.error(`Failed to create QBO term "${name}": ${resp.status} ${await resp.text()}`);
      return null;
    }
    const created = await resp.json();
    return String(created.Term.Id);
  } catch (e) {
    console.error("ensureSalesTermId failed:", (e as Error).message);
    return null;
  }
}

// ── Customer matching ────────────────────────────────────────────────────
// The whole QBO customer list, pulled once and reused. Every mapping
// decision (exact match, near matches, validating a user's pick) reads from
// this rather than firing its own query, so a 30-row batch costs one pull.
// Cached across invocations in the same isolate for a minute — long enough
// to cover a dry-run followed by its push, short enough that a customer
// added in QBO mid-session shows up.
type QboCustomer = { id: string; name: string; companyName: string; email: string | null; address: Record<string, unknown> | null; active: boolean };
let customerCache: { at: number; rows: QboCustomer[] } | null = null;
const CUSTOMER_CACHE_MS = 60_000;

async function loadAllCustomers(): Promise<QboCustomer[]> {
  if (customerCache && Date.now() - customerCache.at < CUSTOMER_CACHE_MS) return customerCache.rows;
  const rows: QboCustomer[] = [];
  const page = 1000;
  let start = 1;
  for (let guard = 0; guard < 50; guard++) {
    // Active IN (true, false) is required — QBO hides inactive customers from
    // a bare SELECT, and a client whose customer was made inactive must still
    // resolve to it rather than looking like a brand-new one.
    const result = (await qboQuery(`SELECT * FROM Customer WHERE Active IN (true, false) STARTPOSITION ${start} MAXRESULTS ${page}`)) as Record<string, unknown>;
    const qr = (result?.QueryResponse as Record<string, unknown>) || {};
    const batch = (qr.Customer as Array<Record<string, unknown>>) || [];
    for (const c of batch) {
      rows.push({
        id: String(c.Id),
        name: String(c.DisplayName ?? "").trim(),
        companyName: String(c.CompanyName ?? "").trim(),
        email: String(((c.PrimaryEmailAddr as Record<string, unknown>)?.Address) ?? "").trim() || null,
        address: mapQboBillAddr(c.BillAddr as Record<string, unknown>),
        active: c.Active !== false,
      });
    }
    if (batch.length < page) break;
    start += page;
  }
  customerCache = { at: Date.now(), rows };
  return rows;
}

// Words that carry no identifying weight, so "Cummins Ltd" and "Cummins"
// still score as the same client.
// Words that don't identify a client, so matching on them is worthless.
//
// Rarity alone can't decide this, which is worth recording because it looks
// like it should: across AVA's QBO file "investments" appears in 5 customer
// names and "cummins" in 3. The rare-token rule below therefore passed all
// five Investments companies as suggestions for "Wmr Pensions And Investments
// Ltd" while a threshold tight enough to exclude them would also have thrown
// away the "GJ Cummins Plumbing" match that the whole feature exists for.
// A company-name word is a company-name word regardless of how often it
// happens to occur in one firm's client list — so it gets listed. The df rule
// stays as a backstop for whatever isn't here yet.
const NAME_NOISE = new Set([
  // Legal form and filler
  "ltd", "limited", "llp", "plc", "llc", "inc", "co", "company", "the", "and", "of", "in", "at", "on", "by", "or",
  "uk", "scotland", "trading", "t/a", "it",
  // Structure
  "group", "holdings", "enterprises", "ventures", "partners", "partnership", "associates", "international", "global",
  // Sector / activity
  "investments", "investment", "properties", "property", "estates", "lettings", "developments", "development",
  "construction", "contractors", "contracting", "builders", "building", "services", "service", "solutions",
  "systems", "consulting", "consultancy", "consultants", "management", "supplies", "supply", "retail", "wholesale",
  "logistics", "transport", "haulage", "distribution", "engineering", "motors", "autos", "automotive", "garage",
  "joinery", "plumbing", "heating", "electrical", "roofing", "plastering", "decorating", "landscaping", "cleaning",
  "catering", "events", "hospitality", "care", "healthcare", "dental", "medical", "veterinary", "pharmacy",
  "media", "design", "designs", "studio", "studios", "digital", "marketing", "communications", "photography",
  "productions", "finance", "financial", "insurance", "mortgages", "pensions", "pension", "accounting",
  "accountants", "accountancy", "bookkeeping", "legal", "solicitors", "farms", "agriculture", "salon", "barbers",
  "beauty", "fitness", "security", "recruitment", "training", "education", "academy", "nursery", "childcare",
  "travel", "tours", "hire", "rentals", "leasing", "storage", "works", "workshop", "industries", "manufacturing",
  "products", "foods", "bakery", "butchers", "brewery", "restaurant", "kitchens", "interiors", "furniture",
  "flooring", "windows", "glazing", "bathrooms", "carpets", "sports", "club", "trust", "foundation",
]);

// Strip everything that differs between "Cummins, Gerald" and "Gerald
// Cummins" so the two compare equal as token sets. Two-character tokens are
// kept — "M3" and "GJ" are among the most identifying parts of a trading name.
function nameTokens(name: string): string[] {
  return String(name)
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((t) => t.length >= 2 && !NAME_NOISE.has(t));
}

// How many customers carry each token. "cummins" appears in a handful and so
// identifies a client; "pensions" or "investments" appear across the whole
// list and identify nothing. Without this, an unmapped client like "Wmr
// Pensions And Investments Ltd" gets six confident-looking suggestions that
// share only an industry word — worse than offering none.
function tokenFrequency(rows: QboCustomer[]): Map<string, number> {
  const df = new Map<string, number>();
  for (const c of rows) {
    for (const t of new Set([...nameTokens(c.name), ...nameTokens(c.companyName)])) {
      df.set(t, (df.get(t) || 0) + 1);
    }
  }
  return df;
}

// The one customer this client maps to, or null. Only an exact DisplayName
// match (case/whitespace-insensitive) counts — a near match is a suggestion
// for the user, never an automatic link.
async function matchCustomerByName(entityName: string): Promise<QboCustomer | null> {
  const target = String(entityName).trim().toLowerCase();
  if (!target) return null;
  const rows = await loadAllCustomers();
  return rows.find((c) => c.name.toLowerCase() === target)
    || rows.find((c) => c.companyName && c.companyName.toLowerCase() === target)
    || null;
}

// Customers that look like they could be this client, best first. Scored on
// shared name tokens (surname + forename beats surname alone), which is what
// catches "Cummins, Gerald" → "GJ Cummins Plumbing and Heating Services".
// Advisory only: shown in the confirm modal for the user to accept or reject.
async function nearMatchCustomers(entityName: string, limit = 6): Promise<QboCustomer[]> {
  const tokens = nameTokens(entityName);
  if (tokens.length === 0) return [];
  const rows = await loadAllCustomers();
  const df = tokenFrequency(rows);
  // A token carried by more than ~1% of the customer list is a business word,
  // not a name. Floor of 3 so a small customer list doesn't make everything
  // "generic".
  const genericDf = Math.max(3, Math.round(rows.length * 0.01));
  const scored: Array<{ c: QboCustomer; score: number }> = [];
  for (const c of rows) {
    const candTokens = new Set([...nameTokens(c.name), ...nameTokens(c.companyName)]);
    if (candTokens.size === 0) continue;
    const shared = tokens.filter((t) => candTokens.has(t));
    if (shared.length === 0) continue;
    // At least one shared token has to actually identify the client. A single
    // distinctive token is enough — a trading name usually keeps the surname
    // and drops the forename to initials ("Cummins, Gerald" → "GJ Cummins
    // Plumbing…"), so requiring two would miss the case this exists for. But
    // sharing only generic words is not evidence of anything, and offering it
    // as a suggestion invites a wrong link.
    if (!shared.some((t) => (df.get(t) || 0) <= genericDf)) continue;
    // Rarer shared tokens count for more.
    let score = shared.reduce((s, t) => s + 1 / Math.max(1, df.get(t) || 1), 0);
    if (!c.active) score *= 0.5;
    scored.push({ c, score });
  }
  scored.sort((a, b) => b.score - a.score || a.c.name.localeCompare(b.c.name));
  return scored.slice(0, limit).map((s) => s.c);
}

async function findCustomerByName(entityName: string): Promise<string | null> {
  const match = await matchCustomerByName(entityName);
  return match ? match.id : null;
}

// Read an existing QBO customer's primary email + billing address.
async function fetchQboCustomerContact(customerId: string): Promise<{ email: string | null; address: Record<string, unknown> | null }> {
  try {
    const resp = await qboFetch(`customer/${customerId}`);
    if (!resp.ok) return { email: null, address: null };
    const cust = ((await resp.json()) as { Customer: Record<string, unknown> }).Customer;
    const email = String(((cust?.PrimaryEmailAddr as Record<string, unknown>)?.Address) ?? "").trim() || null;
    return { email, address: mapQboBillAddr(cust?.BillAddr as Record<string, unknown>) };
  } catch { return { email: null, address: null }; }
}

// All recurring Invoice templates that belong to a given QBO customer.
// Paginated — an AVA file has far more than the default 100 rows. (Mirrors
// qbo-push: matching by customer id beats matching by template name.)
async function findRecurringTemplatesForCustomer(customerId: string): Promise<RecurringTpl[]> {
  const out: RecurringTpl[] = [];
  const page = 1000;
  let start = 1;
  for (let guard = 0; guard < 50; guard++) {
    const result = (await qboQuery(`SELECT * FROM RecurringTransaction STARTPOSITION ${start} MAXRESULTS ${page}`)) as Record<string, unknown>;
    const qr = (result?.QueryResponse as Record<string, unknown>) || {};
    const rows = (qr.RecurringTransaction as Array<Record<string, unknown>>) || [];
    for (const row of rows) {
      const inv = (row.Invoice as Record<string, unknown>) || null;
      if (!inv) continue;
      const cust = (inv.CustomerRef as Record<string, unknown>) || {};
      if (String(cust.value || "") !== String(customerId)) continue;
      const info = (inv.RecurringInfo as Record<string, unknown>) || {};
      const sched = (info.ScheduleInfo as Record<string, unknown>) || {};
      out.push({
        id: String(inv.Id),
        syncToken: String(inv.SyncToken ?? "0"),
        name: String(info.Name || ""),
        active: info.Active !== false,
        nextDate: String(sched.NextDate ?? "").trim() || null,
        billEmail: String(((inv.BillEmail as Record<string, unknown>)?.Address) ?? "").trim() || null,
        billAddr: (inv.BillAddr as Record<string, unknown>) || null,
      });
    }
    if (rows.length < page) break;
    start += page;
  }
  return out;
}

// The live template among a customer's templates: prefer active, then the
// latest NextDate, then the first.
function pickLiveTemplate(templates: RecurringTpl[]): RecurringTpl | null {
  if (templates.length === 0) return null;
  const active = templates.filter((t) => t.active);
  const pool = active.length ? active : templates;
  const dated = pool.filter((t) => t.nextDate);
  if (dated.length) {
    dated.sort((a, b) => (a.nextDate! < b.nextDate! ? 1 : a.nextDate! > b.nextDate! ? -1 : 0));
    return dated[0];
  }
  return pool[0];
}

// Borrow a usable billing address from another entity in the same billing
// group — the address is often shared across a group's members.
async function findGroupMemberAddr(sb: ReturnType<typeof getServiceClient>, entity: Record<string, unknown> | null): Promise<Record<string, unknown> | null> {
  const entId = entity?.id as string | undefined;
  if (!entId) return null;
  try {
    const { data: mine } = await sb.from("billing_group_members").select("group_id").eq("entity_id", entId);
    const groupIds = (mine || []).map((m: Record<string, unknown>) => m.group_id).filter(Boolean);
    if (groupIds.length === 0) return null;
    const { data: members } = await sb.from("billing_group_members").select("entity_id").in("group_id", groupIds);
    const idsArr = (members || []).map((m: Record<string, unknown>) => m.entity_id).filter((id) => id && id !== entId);
    if (idsArr.length === 0) return null;
    const { data: ents } = await sb.from("entities").select("billing_line1, billing_line2, billing_city, billing_postcode").in("id", idsArr);
    for (const e of ents || []) {
      const a = buildBillAddr(e as Record<string, unknown>);
      if (a) return a;
    }
    return null;
  } catch { return null; }
}

// users.address is a single freeform text field (client-portal user, reached
// via entity_memberships) — no structured postcode, so it can't fill the
// QBO address form. Surface it as a read-only hint for staff to copy.
async function findPortalUserAddrHint(sb: ReturnType<typeof getServiceClient>, entity: Record<string, unknown> | null): Promise<string | null> {
  const entId = entity?.id as string | undefined;
  if (!entId) return null;
  try {
    const { data: mems } = await sb.from("entity_memberships").select("user_id").eq("entity_id", entId).limit(10);
    const uids = (mems || []).map((m: Record<string, unknown>) => m.user_id).filter(Boolean);
    if (uids.length === 0) return null;
    const { data: us } = await sb.from("users").select("address").in("id", uids).not("address", "is", null);
    for (const u of us || []) {
      const a = String((u as Record<string, unknown>).address ?? "").trim();
      if (a) return a;
    }
    return null;
  } catch { return null; }
}

// Sparse-update a QBO customer so the email + billing address are present
// on the customer record itself. Safe when they're already set.
async function ensureCustomerContactDetails(customerId: string, email: string | null, addr: Record<string, unknown> | null): Promise<void> {
  if (!email && !addr) return;
  const getResp = await qboFetch(`customer/${customerId}`);
  if (!getResp.ok) throw new Error(`Failed to fetch QBO customer ${customerId}: ${getResp.status} ${await getResp.text()}`);
  const cur = ((await getResp.json()) as { Customer: Record<string, unknown> }).Customer;
  const sparse: Record<string, unknown> = { Id: customerId, SyncToken: cur.SyncToken, sparse: true };
  if (email) sparse.PrimaryEmailAddr = { Address: email };
  if (addr) sparse.BillAddr = addr;
  const resp = await qboFetch("customer", { method: "POST", body: JSON.stringify(sparse) });
  if (!resp.ok) throw new Error(`Failed to update QBO customer contact details: ${resp.status} ${await resp.text()}`);
}

async function ensureQboCustomer(
  sb: ReturnType<typeof getServiceClient>,
  entity: Record<string, unknown> | null,
  entityName: string,
): Promise<string> {
  const escapedName = entityName.replace(/'/g, "\\'");
  const result = await qboQuery(`SELECT * FROM Customer WHERE DisplayName = '${escapedName}'`) as Record<string, unknown>;
  const qr = (result?.QueryResponse as Record<string, unknown>) || {};
  const customers = (qr.Customer as Array<Record<string, unknown>>) || [];

  if (customers.length > 0) {
    const qboId = String(customers[0].Id);
    if (entity?.id) {
      await sb.from("entities").update({
        qbo_customer_id: qboId,
        qbo_customer_name: customers[0].DisplayName as string,
      }).eq("id", entity.id);
    }
    return qboId;
  }

  const resp = await qboFetch("customer", {
    method: "POST",
    body: JSON.stringify({ DisplayName: entityName, CompanyName: entityName }),
  });
  if (!resp.ok) {
    throw new Error(`create customer failed: ${resp.status} ${await resp.text()}`);
  }
  const createdC = await resp.json();
  const qboId = String(createdC.Customer.Id);
  customerCache = null; // a later item in this batch must see the new customer
  if (entity?.id) {
    await sb.from("entities").update({
      qbo_customer_id: qboId,
      qbo_customer_name: createdC.Customer.DisplayName,
    }).eq("id", entity.id);
  }
  return qboId;
}

// Load the service → QBO item map (qbo_service_items) once per push. Keyed
// by BOTH service_id and qbo_item_name (lowercased) so a billing line's
// service — whether a canonical slug or a product name — finds its item id.
// Also returns item id -> product name, so the dry-run plan can name the
// product a line will land on (which, for a VAT-variant service, is not the
// label the line carries).
async function loadServiceItemMap(
  sb: ReturnType<typeof getServiceClient>,
): Promise<{ map: Map<string, string>; names: Map<string, string> }> {
  const map = new Map<string, string>();
  const names = new Map<string, string>();
  const { data } = await sb.from("qbo_service_items").select("service_id, qbo_item_id, qbo_item_name");
  for (const r of (data as Array<Record<string, unknown>>) || []) {
    const id = r.qbo_item_id != null ? String(r.qbo_item_id) : "";
    if (!id) continue;
    if (r.service_id) map.set(String(r.service_id).toLowerCase().trim(), id);
    if (r.qbo_item_name) {
      map.set(String(r.qbo_item_name).toLowerCase().trim(), id);
      names.set(id, String(r.qbo_item_name));
    }
  }
  return { map, names };
}

// Services that exist in QBO as a VAT-registered / non-VAT-registered PAIR,
// where the generic label alone doesn't say which leaf the revenue belongs on.
// Keyed by the ambiguous service; the value names the two service ids to pick
// between. Only the generic label is steered — a line raised explicitly against
// "Bookkeeping (non-VAT registered)" or "VAT Returns" is a deliberate choice
// and resolves through the plain map untouched.
const VAT_VARIANT_SERVICES = new Map<string, { vat: string; novat: string }>([
  ["bookkeeping", { vat: "bookkeeping_vat", novat: "bookkeeping_novat" }],
]);

// Resolve a service to its QBO item id, or null if nothing is mapped. For a
// VAT-variant service the client's VAT status picks the leaf; if that leaf
// isn't mapped we fall through to the service's own mapping rather than
// blocking the push.
function resolveItemId(service: string, serviceMap: Map<string, string>, vatRegistered: boolean): string | null {
  const key = service.toLowerCase().trim();
  const variant = VAT_VARIANT_SERVICES.get(key);
  if (variant) {
    const leaf = serviceMap.get(vatRegistered ? variant.vat : variant.novat);
    if (leaf) return leaf;
  }
  return serviceMap.get(key) || null;
}

// Resolve a billing line's service to a real QBO item id through the explicit
// map, or ERROR. Two fallbacks used to sit here and both mis-coded revenue:
// auto-creating an item (which QBO put on a catch-all income account), and an
// exact Item.Name lookup — which quietly found those very auto-created items
// long after the auto-create was removed. A name collision is not a mapping.
// The error names the service so the fix (map it at /manage/billing/products)
// is obvious, and nothing reaches QuickBooks until it's mapped.
function resolveQboItemId(service: string, serviceMap: Map<string, string>, vatRegistered: boolean): string {
  const mapped = resolveItemId(service, serviceMap, vatRegistered);
  if (mapped) return mapped;
  throw new Error(`No QuickBooks product mapped for service "${service}". Map it at /manage/billing/products before billing — nothing was created in QuickBooks.`);
}

// Which of these clients are VAT registered, for the VAT-variant services
// above. Two signals, either is enough:
//   1. Athena holds a VAT number for them.
//   2. They carry a live recurring fee on a "(VAT Registered)" product —
//      the firm's own standing classification, which holds even when the
//      VAT number itself never made it into Athena.
// No evidence either way means not VAT registered: most clients aren't, and
// the alternative is billing a non-VAT client on the VAT-registered product.
async function loadVatRegisteredEntities(
  sb: ReturnType<typeof getServiceClient>,
  entityIds: string[],
  itemNames: Map<string, string>,
): Promise<Set<string>> {
  const vat = new Set<string>();
  if (!entityIds.length) return vat;

  const { data: ents } = await sb.from("entities").select("id, vat_number").in("id", entityIds);
  for (const e of (ents as Array<Record<string, unknown>>) || []) {
    if (e.vat_number && String(e.vat_number).trim()) vat.add(String(e.id));
  }

  const remaining = entityIds.filter((id) => !vat.has(id));
  if (!remaining.length) return vat;

  const vatItemIds = new Set(
    [...itemNames.entries()].filter(([, name]) => /\(VAT Registered\)/i.test(name)).map(([id]) => id),
  );
  if (!vatItemIds.size) return vat;

  const { data: lb } = await sb.from("live_billing").select("entity_id, services").in("entity_id", remaining);
  for (const row of (lb as Array<Record<string, unknown>>) || []) {
    const svcs = Array.isArray(row.services) ? (row.services as Array<Record<string, unknown>>) : [];
    if (svcs.some((s) => vatItemIds.has(String(s?.qbo_item_id || "")))) vat.add(String(row.entity_id));
  }
  return vat;
}
