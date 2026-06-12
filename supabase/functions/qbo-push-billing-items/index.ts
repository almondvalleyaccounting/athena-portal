import { getServiceClient, qboFetch, qboQuery, logSync, jsonResponse, corsHeaders } from "../_shared/qbo-client.ts";

// Push one-off Billing module items (billing_items) to QBO as real
// invoices. For each approved item we ensure the QBO customer + item
// exist, ensure the customer carries an email + billing address, build a
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
// Input: { billing_item_ids: string[], send: boolean, dry_run?: boolean, due_days?: number, initiated_by?: string }
//   send=true  -> create + email the invoice (QBO SendInvoice)
//   send=false -> create only; team sends from QBO later
//   due_days   -> payment terms; DueDate = invoice date + due_days (default 14)
//   dry_run=true -> read-only plan (no QBO/DB writes).
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

  let body: { billing_item_ids?: string[]; send?: boolean; dry_run?: boolean; refresh?: boolean; list_invoices?: boolean; check_settings?: boolean; entity_id?: string; due_days?: number; initiated_by?: string };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ success: false, error: "Invalid JSON" }, 400);
  }

  const ids = Array.isArray(body.billing_item_ids) ? body.billing_item_ids : [];
  const send = body.send !== false; // default to sending
  // Invoice payment terms: due N days after the invoice date (default 14).
  const dueDays = Number.isFinite(Number(body.due_days)) && Number(body.due_days) >= 0 ? Number(body.due_days) : 14;
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

      // Each distinct line service maps to a QBO item; the invoice exists
      // as "create" unless every one of them already exists.
      const lineServices = [...new Set(normalizeLines(item).map((l) => l.service))];
      let itemExists = true;
      for (const s of lineServices) {
        if (!(await qboRecordExists("Item", "Name", s.substring(0, 100)))) { itemExists = false; break; }
      }

      plan.push({
        billing_item_id: item.id,
        entity: entityName,
        service: serviceName,
        approved: item.status === "approved",
        customer_action: contact.customer_exists ? "existing" : "create",
        item_action: itemExists ? "existing" : "create",
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

  // Resolve a valid income account for any QBO items we need to create.
  let incomeAccountId: string | null = null;
  try {
    incomeAccountId = await resolveIncomeAccount();
  } catch (err) {
    return jsonResponse({ success: false, error: `Could not resolve an income account: ${(err as Error).message}` }, 500);
  }

  // Resolve (or create) the QBO Term matching the due-date offset so each
  // invoice carries a Terms value (e.g. "Net 14"), not just a bare due
  // date. Non-fatal: if it can't be resolved we still set DueDate.
  const salesTermId = await ensureSalesTermId(dueDays);

  const itemCache = new Map<string, string>(); // service name -> QBO item id
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

      // 1. Ensure QBO customer.
      let qboCustomerId = (entity?.qbo_customer_id as string) || null;
      if (!qboCustomerId) {
        qboCustomerId = await ensureQboCustomer(sb, entity, entityName);
      }

      // 2. Make sure email + address are on the customer record itself,
      //    even when the customer already existed. Sparse update.
      await ensureCustomerContactDetails(qboCustomerId, email, billAddr);

      // 3. Build the invoice lines. Each billing line becomes one QBO
      //    SalesItemLineDetail at its net amount + the sales VAT code, so
      //    QBO computes VAT. Ensure a QBO item per distinct service.
      const lines = normalizeLines(item);
      const lineItems: Array<Record<string, unknown>> = [];
      for (const l of lines) {
        let qboItemId = itemCache.get(l.service);
        if (!qboItemId) {
          qboItemId = await ensureQboItem(l.service, l.description || l.service, incomeAccountId);
          itemCache.set(l.service, qboItemId);
        }
        lineItems.push({
          DetailType: "SalesItemLineDetail",
          Amount: l.net,
          Description: l.description || l.service,
          SalesItemLineDetail: { ItemRef: { value: qboItemId }, Qty: 1, UnitPrice: l.net, TaxCodeRef: { value: taxCodeId } },
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

      // 5. Send now, or leave as draft.
      let finalStatus: ItemResult["status"];
      if (send && email) {
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
        reason: finalStatus === "created_unsent" && send && !email ? "no client email on file - created as draft" : undefined,
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
function normalizeLines(item: Record<string, unknown>): Array<{ service: string; description: string | null; net: number }> {
  const raw = Array.isArray(item.lines) ? (item.lines as Array<Record<string, unknown>>) : null;
  if (raw && raw.length) {
    return raw.map((l) => ({
      service: String(l.service || "Professional Services"),
      description: (l.description as string) || null,
      net: Number(l.net) || 0,
    }));
  }
  return [{
    service: String(item.service || "Professional Services"),
    description: (item.description as string) || null,
    net: Number(item.net_amount) || 0,
  }];
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
  has_email: boolean; email: string | null; email_source: string | null; email_mismatch: boolean;
  athena_email: string | null; qbo_email: string | null;
  has_address: boolean; address: Record<string, unknown> | null; address_hint: string | null;
  email_options: string[]; address_options: Array<{ label: string; addr: Record<string, unknown> }>;
  missing: string[];
}> {
  const athenaEmail = (entity?.billing_email as string) || (entity?.prospect_email as string) || null;
  const athenaAddr = buildBillAddr(entity);

  // Find the QBO customer (by stored id, else by name) and read its email
  // + billing address.
  let customerId = (entity?.qbo_customer_id as string) || null;
  if (!customerId) customerId = await findCustomerByName(entityName);
  let qboEmail: string | null = null;
  let qboAddr: Record<string, unknown> | null = null;
  if (customerId) {
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

  const active = codes.filter((c) => c.Active !== false);
  const byTwenty = active.find((c) => /20/.test(String(c.Name || "")));
  if (byTwenty) return String(byTwenty.Id);
  const byStandard = active.find((c) => /\bS\b/.test(String(c.Name || "")) || /standard/i.test(String(c.Description || "")));
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

// Resolve a valid income account for new Service items. Env override
// wins; else pick an active Income-classified account (prefer a sales /
// services account name, then any income account).
async function resolveIncomeAccount(): Promise<string | null> {
  const override = Deno.env.get("QBO_INCOME_ACCOUNT_ID");
  if (override) return override;

  const result = await qboQuery("SELECT Id, Name, AccountType, Classification, Active FROM Account WHERE Classification = 'Revenue'") as Record<string, unknown>;
  const qr = (result?.QueryResponse as Record<string, unknown>) || {};
  const accounts = ((qr.Account as Array<Record<string, unknown>>) || []).filter((a) => a.Active !== false);
  if (accounts.length === 0) return null;

  const preferred = accounts.find((a) => /sales|service|income|fees/i.test(String(a.Name || "")))
    || accounts.find((a) => a.AccountType === "Income");
  return String((preferred || accounts[0]).Id);
}

async function findCustomerByName(entityName: string): Promise<string | null> {
  const escaped = entityName.replace(/'/g, "\\'");
  const result = (await qboQuery(`SELECT Id FROM Customer WHERE DisplayName = '${escaped}'`)) as Record<string, unknown>;
  const qr = (result?.QueryResponse as Record<string, unknown>) || {};
  const customers = (qr.Customer as Array<Record<string, unknown>>) || [];
  return customers.length > 0 ? String(customers[0].Id) : null;
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

// Read-only existence check for the dry-run plan.
async function qboRecordExists(table: string, field: string, value: string): Promise<boolean> {
  const escaped = value.replace(/'/g, "\\'");
  const result = await qboQuery(`SELECT Id FROM ${table} WHERE ${field} = '${escaped}'`) as Record<string, unknown>;
  const qr = (result?.QueryResponse as Record<string, unknown>) || {};
  const rows = (qr[table] as Array<unknown>) || [];
  return rows.length > 0;
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
  if (entity?.id) {
    await sb.from("entities").update({
      qbo_customer_id: qboId,
      qbo_customer_name: createdC.Customer.DisplayName,
    }).eq("id", entity.id);
  }
  return qboId;
}

async function ensureQboItem(serviceName: string, description: string, incomeAccountId: string | null): Promise<string> {
  const name = serviceName.substring(0, 100);
  const escapedName = name.replace(/'/g, "\\'");
  const result = await qboQuery(`SELECT * FROM Item WHERE Name = '${escapedName}'`) as Record<string, unknown>;
  const qr = (result?.QueryResponse as Record<string, unknown>) || {};
  const items = (qr.Item as Array<Record<string, unknown>>) || [];
  if (items.length > 0) return String(items[0].Id);

  if (!incomeAccountId) {
    throw new Error(`cannot create item '${name}': no income account available. Set QBO_INCOME_ACCOUNT_ID.`);
  }
  const resp = await qboFetch("item", {
    method: "POST",
    body: JSON.stringify({
      Name: name,
      Description: description,
      Type: "Service",
      IncomeAccountRef: { value: incomeAccountId },
    }),
  });
  if (!resp.ok) {
    throw new Error(`create item '${name}' failed: ${resp.status} ${await resp.text()}`);
  }
  const createdI = await resp.json();
  return String(createdI.Item.Id);
}
