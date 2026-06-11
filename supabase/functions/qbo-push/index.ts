// qbo-push — pushes Athena billing/quote data to QuickBooks Online.

import {
  getServiceClient,
  qboFetch,
  qboQuery,
  logSync,
  jsonResponse,
  corsHeaders,
} from "../_shared/qbo-client.ts";

type PushMode = "flat_invoice" | "recurring_template" | "setup_invoice_only";

type ServiceLine = {
  service_id: string;
  description?: string;
  monthly_amount?: number;
  annual_amount?: number;
  amount?: number;
};

type ItemMapping = {
  qbo_item_id: string;
  qbo_item_name: string;
  default_description: string | null;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });
  if (req.method !== "POST") return jsonResponse({ success: false, error: "POST required" }, 405);

  const body = await req.json().catch(() => ({}));
  const initiatedBy: string | null = body.initiated_by ?? null;
  const mode: PushMode = (body.mode as PushMode) || "flat_invoice";
  const billingId: string | null = body.billing_id ?? null;
  const quoteId: string | null = body.quote_id ?? null;
  const alsoPushSetup: boolean = Boolean(body.also_push_setup);
  const recurringStartDate: string | null = body.recurring_start_date ?? null;
  const sendSetupNow: boolean = Boolean(body.send_setup_now);
  const billEmailOverride: string | null = body.bill_email ?? null;
  const dueDateOffsetOverride: number | null =
    body.due_date_offset_days != null && Number.isFinite(Number(body.due_date_offset_days))
      ? Number(body.due_date_offset_days)
      : null;
  const dryRun: boolean = Boolean(body.dry_run);

  const sb = getServiceClient();

  try {
    let billing: Record<string, unknown> | null = null;
    let entity: Record<string, unknown> | null = null;

    if (billingId) {
      const { data, error } = await sb.from("live_billing").select("*, entities(*)").eq("id", billingId).single();
      if (error || !data) return jsonResponse({ success: false, error: "Billing record not found" }, 404);
      billing = data;
      entity = (data as { entities: Record<string, unknown> }).entities;
    }

    let quote: Record<string, unknown> | null = null;
    let setupLines: ServiceLine[] = [];

    const needQuote = mode === "setup_invoice_only" || alsoPushSetup || mode === "recurring_template";
    if (needQuote && quoteId) {
      const { data: q, error: qErr } = await sb.from("quotes").select("*, entities(*)").eq("id", quoteId).single();
      if (qErr || !q) return jsonResponse({ success: false, error: "Quote not found" }, 404);
      quote = q;
      if (!entity) entity = (q as { entities: Record<string, unknown> }).entities;

      const { data: items } = await sb.from("quote_line_items").select("service_id, description, annual_amount, monthly_amount, is_recurring").eq("quote_id", quoteId).order("sort_order");
      for (const row of items || []) {
        if (!row.is_recurring) {
          setupLines.push({ service_id: row.service_id, description: row.description, amount: Number(row.annual_amount) || Number(row.monthly_amount) || 0 });
        }
      }
    }

    if (mode === "setup_invoice_only" && setupLines.length === 0) {
      return jsonResponse({ success: false, error: "Quote has no setup (non-recurring) line items" }, 400);
    }

    let recurringLines: ServiceLine[] = [];
    if (mode === "flat_invoice" || mode === "recurring_template") {
      if (billing) {
        const services = (billing.services as ServiceLine[]) || [];
        recurringLines = services.map((s) => ({ service_id: s.service_id, description: s.description, monthly_amount: Number(s.monthly_amount) || 0, annual_amount: Number(s.annual_amount) || 0 }));
      } else if (dryRun && Array.isArray(body.services)) {
        // Review step before the commit is written: the recurring lines come
        // inline from the modal so we can build the plan without a saved
        // live_billing row. Nothing is persisted until the user commits.
        recurringLines = (body.services as ServiceLine[]).map((s) => ({ service_id: s.service_id, description: s.description, monthly_amount: Number(s.monthly_amount) || 0, annual_amount: Number(s.annual_amount) || 0 }));
      } else {
        return jsonResponse({ success: false, error: `${mode} requires billing_id` }, 400);
      }
    }

    const entityName = (entity?.name as string) || (entity?.qbo_customer_name as string) || "Unknown Client";
    // A caller-supplied bill_email (e.g. chosen from group members in the
    // commit modal) overrides everything for this push. Otherwise the quote
    // is the source of truth for the client's email (captured at accept),
    // falling back to the entity's stored billing/prospect email.
    const clientEmail = billEmailOverride
      || (quote?.accepted_client_email as string)
      || (entity?.billing_email as string)
      || (entity?.prospect_email as string)
      || null;
    // Billing address from the entity's billing_* fields. Mandatory on
    // commit (see missingContact below) — set on both the QBO customer and
    // the recurring/setup documents.
    const clientAddr = buildBillAddr(entity);

    // Mandatory client details: email + a usable address. Surfaced in the
    // dry-run plan so the commit modal can prompt, and enforced before any
    // real QBO write below.
    const missingContact: string[] = [];
    if (!clientEmail) missingContact.push("client email");
    if (!clientAddr) missingContact.push("client address (line 1 + postcode)");

    const allServiceIds = new Set<string>();
    [...recurringLines, ...setupLines].forEach((l) => l.service_id && allServiceIds.add(l.service_id));
    const itemMap = await loadItemMappings(sb, Array.from(allServiceIds));
    const missingMappings = Array.from(allServiceIds).filter((id) => !itemMap[id]);

    const { data: conn } = await sb.from("qbo_connections").select("default_tax_code_id, default_due_date_offset_days").eq("status", "active").single();
    const defaultTaxCodeId: string | null = conn?.default_tax_code_id || null;
    // Due-date offset: caller override wins, else the connection default,
    // else 14 days.
    const dueDateOffsetDays: number = dueDateOffsetOverride ?? Number(conn?.default_due_date_offset_days ?? 14);

    const hasSetup = mode === "setup_invoice_only" || (alsoPushSetup && setupLines.length > 0);
    const hasRecurring = mode === "recurring_template" && recurringLines.length > 0;
    const startDate = recurringStartDate || firstOfNextMonth();
    const recurringTemplateName = `${entityName} — Monthly`.substring(0, 50);

    // ---- Dry run: build a read-only plan for the confirmation summary. ----
    // No QBO writes, no DB writes. Reports customer create/existing, setup
    // invoice (send now vs draft), and recurring template new vs overwrite
    // with the next run date that will be set.
    if (dryRun) {
      let customerExists = !!(entity?.qbo_customer_id);
      let existingCustomerId = (entity?.qbo_customer_id as string) || null;
      if (!customerExists) {
        const found = await findCustomerByName(entityName);
        if (found) { customerExists = true; existingCustomerId = found; }
      }

      let recurringPlan: Record<string, unknown> | null = null;
      if (hasRecurring) {
        // Look up every existing template attached to this customer in QBO,
        // not just by auto-generated name — name drift between Athena and
        // QBO is the main cause of duplicate-template pushes (Apollo
        // Joinery hit this). If any exist, the plan defaults to overwrite.
        const existingForCustomer = existingCustomerId
          ? await findRecurringTemplatesForCustomer(existingCustomerId)
          : [];
        const target = pickTemplateToOverwrite(existingForCustomer, recurringTemplateName);
        recurringPlan = {
          action: target ? "overwrite" : "create",
          existing_template_id: target?.id ?? null,
          existing_templates: existingForCustomer.map((t) => ({ id: t.id, name: t.name })),
          template_name: recurringTemplateName,
          lines: recurringLines.map((l) => ({ description: l.description || itemMap[l.service_id]?.qbo_item_name || l.service_id, amount: l.monthly_amount ?? 0 })),
          monthly_total: recurringLines.reduce((s, l) => s + (l.monthly_amount ?? 0), 0),
          next_run_date: nextRunDate(startDate),
          day_of_month: parseInt(startDate.slice(8, 10), 10) || 1,
        };
      }

      let setupPlan: Record<string, unknown> | null = null;
      if (hasSetup) {
        setupPlan = {
          lines: setupLines.map((l) => ({ description: l.description || itemMap[l.service_id]?.qbo_item_name || l.service_id, amount: l.amount ?? 0 })),
          total: setupLines.reduce((s, l) => s + (l.amount ?? 0), 0),
          send: sendSetupNow ? "now" : "draft",
          has_email: !!clientEmail,
          email: clientEmail,
        };
      }

      // Prefill the client contact for the review step. Email and address
      // both fall back to the existing QBO customer record (one fetch) when
      // Athena has none on file; the address additionally falls back to a
      // group member. users.address is a single freeform field (no structured
      // postcode) so it can't fill the form — it's surfaced as a hint.
      let prefillEmail = clientEmail;
      let prefillAddr = clientAddr;
      if ((!prefillEmail || !prefillAddr) && existingCustomerId) {
        const qboContact = await fetchQboCustomerContact(existingCustomerId);
        if (!prefillEmail) prefillEmail = qboContact.email;
        if (!prefillAddr) prefillAddr = qboContact.address;
      }
      if (!prefillAddr) prefillAddr = await findGroupMemberAddr(sb, entity);
      const addrHint = prefillAddr ? null : await findPortalUserAddrHint(sb, entity);
      const dryMissing: string[] = [];
      if (!prefillEmail) dryMissing.push("client email");
      if (!prefillAddr) dryMissing.push("client address (line 1 + postcode)");

      return jsonResponse({
        success: true,
        dry_run: true,
        plan: {
          mode,
          customer: { action: customerExists ? "existing" : "create", name: entityName, qbo_customer_id: existingCustomerId },
          contact: {
            email: prefillEmail,
            has_email: !!prefillEmail,
            address: prefillAddr,
            has_address: !!prefillAddr,
            address_hint: addrHint,
            missing: dryMissing,
          },
          missing_mappings: missingMappings,
          setup_invoice: setupPlan,
          recurring: recurringPlan,
          due_date_offset_days: dueDateOffsetDays,
        },
      });
    }

    // ---- Real push below. Unmapped services block the whole push. ----
    if (missingMappings.length > 0) {
      return jsonResponse({ success: false, error: "Some services are not yet mapped to QBO items", missing_mappings: missingMappings }, 409);
    }

    // Mandatory: client email + address must be present before we create
    // anything in QBO.
    if (missingContact.length > 0) {
      return jsonResponse({ success: false, error: `Mandatory client details missing: ${missingContact.join(", ")}. Add them before committing to QuickBooks.`, missing_contact: missingContact }, 422);
    }

    // Resolve (or create) the QBO Term matching this due-date offset so the
    // documents carry a Terms value (e.g. "Net 14"), not just a bare due
    // date. Non-fatal: if it can't be resolved we still set DueDate.
    const salesTermId = await ensureSalesTermId(dueDateOffsetDays);

    let qboCustomerId = (entity?.qbo_customer_id as string) || null;
    if (!qboCustomerId) qboCustomerId = await ensureQboCustomer(sb, entity, entityName);
    // Make sure email + address are on the customer record itself, even when
    // the customer already existed in QBO. Sparse update — leaves other
    // fields untouched.
    await ensureCustomerContactDetails(qboCustomerId, clientEmail, clientAddr);

    let setupInvoiceId: string | null = null;
    let setupSent = false;
    if (hasSetup) {
      const setupLineItems = setupLines.map((l) => buildLineItem(l, itemMap, l.amount ?? 0, defaultTaxCodeId));
      const inv = await createQboInvoice(qboCustomerId, setupLineItems, `Setup — ${entityName}`, dueDateOffsetDays, clientEmail, clientAddr, salesTermId);
      setupInvoiceId = inv.invoiceId;
      if (sendSetupNow && clientEmail) {
        await sendQboInvoice(setupInvoiceId, clientEmail);
        setupSent = true;
      }
      if (quote) {
        await sb.from("quotes").update({ qbo_setup_invoice_id: setupInvoiceId, qbo_pushed_at: new Date().toISOString(), qbo_pushed_by: initiatedBy }).eq("id", (quote as { id: string }).id);
      }
    }

    let recurringTxnId: string | null = null;
    let recurringAction: "create" | "overwrite" | null = null;
    let flatInvoiceId: string | null = null;

    if (hasRecurring) {
      const lineItems = recurringLines.map((l) => buildLineItem(l, itemMap, l.monthly_amount ?? 0, defaultTaxCodeId));
      // Detect any existing recurring template attached to this QBO
      // customer — never blindly create a second one.
      const existingForCustomer = await findRecurringTemplatesForCustomer(qboCustomerId);
      const target = pickTemplateToOverwrite(existingForCustomer, recurringTemplateName);
      if (target) {
        recurringTxnId = await updateQboRecurringInvoice({ id: target.id, syncToken: target.syncToken, customerId: qboCustomerId, lineItems, templateName: recurringTemplateName, startDate, dueDateOffsetDays, email: clientEmail, billAddr: clientAddr, salesTermId });
        recurringAction = "overwrite";
      } else {
        recurringTxnId = await createQboRecurringInvoice({ customerId: qboCustomerId, lineItems, templateName: recurringTemplateName, startDate, dueDateOffsetDays, email: clientEmail, billAddr: clientAddr, salesTermId });
        recurringAction = "create";
      }
      await sb.from("live_billing").update({ qbo_recurring_txn_id: recurringTxnId, qbo_customer_id: qboCustomerId, qbo_sync_status: "synced", last_synced_qbo: new Date().toISOString() }).eq("id", (billing as { id: string }).id);
      if (quote) {
        await sb.from("quotes").update({ qbo_recurring_txn_id: recurringTxnId, qbo_push_mode: "recurring_template", recurring_start_date: startDate, qbo_pushed_at: new Date().toISOString(), qbo_pushed_by: initiatedBy, dd_mandate_status: "not_requested" }).eq("id", (quote as { id: string }).id);
      }
    } else if (mode === "flat_invoice" && recurringLines.length > 0) {
      const lineItems = recurringLines.map((l) => buildLineItem(l, itemMap, l.monthly_amount ?? 0, defaultTaxCodeId));
      const existingId = (billing as { qbo_invoice_id?: string }).qbo_invoice_id;
      if (existingId) { await updateQboInvoice(existingId, qboCustomerId, lineItems); flatInvoiceId = existingId; }
      else { const inv = await createQboInvoice(qboCustomerId, lineItems, entityName, dueDateOffsetDays, clientEmail, clientAddr, salesTermId); flatInvoiceId = inv.invoiceId; }
      await sb.from("live_billing").update({ qbo_invoice_id: flatInvoiceId, qbo_customer_id: qboCustomerId, qbo_sync_status: "synced", last_synced_qbo: new Date().toISOString() }).eq("id", (billing as { id: string }).id);
      if (quote) {
        await sb.from("quotes").update({ qbo_push_mode: "flat_invoice", qbo_pushed_at: new Date().toISOString(), qbo_pushed_by: initiatedBy }).eq("id", (quote as { id: string }).id);
      }
    }

    await logSync({ direction: "push", entity_id: (entity?.id as string) || undefined, entity_name: entityName, qbo_entity_type: recurringTxnId ? "RecurringTransaction" : "Invoice", qbo_entity_id: recurringTxnId || flatInvoiceId || setupInvoiceId || undefined, status: "success", detail: { mode, billing_id: billingId, quote_id: quoteId, setup_invoice_id: setupInvoiceId, setup_sent: setupSent, recurring_txn_id: recurringTxnId, recurring_action: recurringAction, flat_invoice_id: flatInvoiceId, setup_lines: setupLines.length, recurring_lines: recurringLines.length }, initiated_by: initiatedBy || undefined });

    return jsonResponse({ success: true, data: { mode, qbo_customer_id: qboCustomerId, qbo_setup_invoice_id: setupInvoiceId, setup_sent: setupSent, qbo_recurring_txn_id: recurringTxnId, recurring_action: recurringAction, recurring_next_run_date: hasRecurring ? nextRunDate(startDate) : null, qbo_invoice_id: flatInvoiceId } });
  } catch (err) {
    console.error("qbo-push error:", err);
    try { await logSync({ direction: "push", status: "error", error_message: (err as Error).message, detail: { mode, billing_id: billingId, quote_id: quoteId }, initiated_by: initiatedBy || undefined }); } catch { /* */ }
    return jsonResponse({ success: false, error: (err as Error).message }, 500);
  }
});

async function loadItemMappings(sb: ReturnType<typeof getServiceClient>, serviceIds: string[]): Promise<Record<string, ItemMapping>> {
  if (serviceIds.length === 0) return {};
  const { data } = await sb.from("qbo_service_items").select("service_id, qbo_item_id, qbo_item_name, default_description").in("service_id", serviceIds);
  const map: Record<string, ItemMapping> = {};
  for (const row of data || []) map[row.service_id] = { qbo_item_id: row.qbo_item_id, qbo_item_name: row.qbo_item_name, default_description: row.default_description };
  return map;
}

function buildLineItem(line: ServiceLine, itemMap: Record<string, ItemMapping>, amount: number, taxCodeId: string | null): Record<string, unknown> {
  const mapping = itemMap[line.service_id];
  const detail: Record<string, unknown> = { ItemRef: { value: mapping.qbo_item_id }, Qty: 1, UnitPrice: amount };
  if (taxCodeId) detail.TaxCodeRef = { value: taxCodeId };
  return { DetailType: "SalesItemLineDetail", Amount: amount, Description: line.description || mapping?.default_description || mapping?.qbo_item_name || line.service_id, SalesItemLineDetail: detail };
}

// Build a QBO BillAddr from the entity's billing_* fields. Returns null
// unless there's at least a first line and a postcode — a half address is
// worse than none for a UK invoice.
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

// Resolve (or create) a QBO sales Term whose net days match the due-date
// offset, so invoices/recurring templates show a Terms value (e.g. "Net 14")
// rather than just a bare DueDate — QBO keeps Terms as a separate entity.
// Returns null (non-fatal) if it can't be resolved; the caller still sets
// DueDate.
async function ensureSalesTermId(dueDays: number): Promise<string | null> {
  if (!Number.isFinite(dueDays) || dueDays < 0) return null;
  try {
    const result = (await qboQuery(`SELECT * FROM Term`)) as Record<string, unknown>;
    const qr = (result?.QueryResponse as Record<string, unknown>) || {};
    const terms = (qr.Term as Array<Record<string, unknown>>) || [];
    // Prefer an active standard (net-days) term with the same DueDays.
    const byDays = terms.find((t) => Number(t.DueDays) === dueDays && (t.Type === undefined || t.Type === "STANDARD") && t.Active !== false);
    if (byDays) return String(byDays.Id);
    const name = dueDays === 0 ? "Due on receipt" : `Net ${dueDays}`;
    // Reuse a same-named term before creating (QBO term names are unique).
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

// Read an existing QBO customer's primary email + billing address in one
// fetch, mapped to our shapes. Email is the customer's PrimaryEmailAddr;
// address is returned only if it has at least Line1 + PostalCode (matching
// buildBillAddr's "half address is worse than none" rule).
async function fetchQboCustomerContact(customerId: string): Promise<{ email: string | null; address: Record<string, unknown> | null }> {
  try {
    const resp = await qboFetch(`customer/${customerId}`);
    if (!resp.ok) return { email: null, address: null };
    const cust = ((await resp.json()) as { Customer: Record<string, unknown> }).Customer;
    const email = String(((cust?.PrimaryEmailAddr as Record<string, unknown>)?.Address) ?? "").trim() || null;
    let address: Record<string, unknown> | null = null;
    const a = (cust?.BillAddr as Record<string, unknown>) || null;
    if (a) {
      const line1 = String(a.Line1 ?? "").trim();
      const postcode = String(a.PostalCode ?? "").trim();
      if (line1 && postcode) {
        address = { Line1: line1 };
        const line2 = String(a.Line2 ?? "").trim(); if (line2) address.Line2 = line2;
        const city = String(a.City ?? "").trim(); if (city) address.City = city;
        address.PostalCode = postcode;
      }
    }
    return { email, address };
  } catch { return { email: null, address: null }; }
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
    const ids = (members || []).map((m: Record<string, unknown>) => m.entity_id).filter((id) => id && id !== entId);
    if (ids.length === 0) return null;
    const { data: ents } = await sb.from("entities").select("billing_line1, billing_line2, billing_city, billing_postcode").in("id", ids);
    for (const e of ents || []) {
      const a = buildBillAddr(e as Record<string, unknown>);
      if (a) return a;
    }
    return null;
  } catch { return null; }
}

// users.address is a single freeform text field (client-portal user, reached
// via entity_memberships) — it has no structured postcode so it can't fill
// the QBO address form. Surface it as a read-only hint for staff to copy.
async function findPortalUserAddrHint(sb: ReturnType<typeof getServiceClient>, entity: Record<string, unknown> | null): Promise<string | null> {
  const entId = entity?.id as string | undefined;
  if (!entId) return null;
  try {
    const { data: mems } = await sb.from("entity_memberships").select("user_id").eq("entity_id", entId).limit(10);
    const ids = (mems || []).map((m: Record<string, unknown>) => m.user_id).filter(Boolean);
    if (ids.length === 0) return null;
    const { data: us } = await sb.from("users").select("address").in("id", ids).not("address", "is", null);
    for (const u of us || []) {
      const a = String((u as Record<string, unknown>).address ?? "").trim();
      if (a) return a;
    }
    return null;
  } catch { return null; }
}

// Sparse-update a QBO customer so the email + billing address are present
// on the customer record itself. Safe to call when they're already set
// (sparse update only touches the fields we send).
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

function addDays(isoDate: string, days: number): string {
  const d = new Date(isoDate + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function firstOfNextMonth(): string {
  const d = new Date();
  const next = new Date(d.getFullYear(), d.getMonth() + 1, 1);
  return next.toISOString().slice(0, 10);
}

// The date QBO will first generate the invoice. If the chosen start date is
// still in the future it is the next run; if it's already past, roll forward
// to the same day-of-month next month.
function nextRunDate(startDate: string): string {
  const today = new Date().toISOString().slice(0, 10);
  if (startDate >= today) return startDate;
  const d = new Date(startDate + "T00:00:00Z");
  const day = d.getUTCDate();
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, day));
  return next.toISOString().slice(0, 10);
}

async function findCustomerByName(entityName: string): Promise<string | null> {
  const escaped = entityName.replace(/'/g, "\\'");
  const result = (await qboQuery(`SELECT Id FROM Customer WHERE DisplayName = '${escaped}'`)) as Record<string, unknown>;
  const qr = (result?.QueryResponse as Record<string, unknown>) || {};
  const customers = (qr.Customer as Array<Record<string, unknown>>) || [];
  return customers.length > 0 ? String(customers[0].Id) : null;
}

// All recurring Invoice templates that belong to a given QBO customer.
// Matching by customer id is far more reliable than matching by template
// name — Athena's auto-generated `${entity} — Monthly` can drift from
// what's actually in QBO when the customer's display name differs even
// slightly. Returns id + syncToken + name for each.
async function findRecurringTemplatesForCustomer(
  customerId: string,
): Promise<Array<{ id: string; syncToken: string; name: string }>> {
  const result = (await qboQuery(`SELECT * FROM RecurringTransaction`)) as Record<string, unknown>;
  const qr = (result?.QueryResponse as Record<string, unknown>) || {};
  const rows = (qr.RecurringTransaction as Array<Record<string, unknown>>) || [];
  const out: Array<{ id: string; syncToken: string; name: string }> = [];
  for (const row of rows) {
    const inv = (row.Invoice as Record<string, unknown>) || null;
    if (!inv) continue;
    const cust = (inv.CustomerRef as Record<string, unknown>) || {};
    if (String(cust.value || "") !== String(customerId)) continue;
    const info = (inv.RecurringInfo as Record<string, unknown>) || {};
    out.push({ id: String(inv.Id), syncToken: String(inv.SyncToken ?? "0"), name: String(info.Name || "") });
  }
  return out;
}

// Choose which existing template (if any) to overwrite. Prefer the one
// whose name matches the auto-generated template name exactly; otherwise
// fall back to the first.
function pickTemplateToOverwrite(
  templates: Array<{ id: string; syncToken: string; name: string }>,
  preferredName: string,
): { id: string; syncToken: string; name: string } | null {
  if (templates.length === 0) return null;
  const exact = templates.find((t) => t.name === preferredName);
  return exact || templates[0];
}

async function ensureQboCustomer(sb: ReturnType<typeof getServiceClient>, entity: Record<string, unknown> | null, entityName: string): Promise<string> {
  const escapedName = entityName.replace(/'/g, "\\'");
  const result = (await qboQuery(`SELECT * FROM Customer WHERE DisplayName = '${escapedName}'`)) as Record<string, unknown>;
  const queryResponse = result?.QueryResponse as Record<string, unknown>;
  const customers = queryResponse?.Customer as Array<Record<string, unknown>>;
  if (customers && customers.length > 0) {
    const qboId = String(customers[0].Id);
    if (entity?.id) await sb.from("entities").update({ qbo_customer_id: qboId, qbo_customer_name: customers[0].DisplayName as string }).eq("id", entity.id);
    return qboId;
  }
  const resp = await qboFetch("customer", { method: "POST", body: JSON.stringify({ DisplayName: entityName, CompanyName: entityName }) });
  if (!resp.ok) throw new Error(`Failed to create QBO customer: ${resp.status} ${await resp.text()}`);
  const created = await resp.json();
  const qboId = String(created.Customer.Id);
  if (entity?.id) await sb.from("entities").update({ qbo_customer_id: qboId, qbo_customer_name: created.Customer.DisplayName }).eq("id", entity.id);
  return qboId;
}

async function createQboInvoice(customerId: string, lineItems: Array<Record<string, unknown>>, clientName: string, dueDateOffsetDays: number, email: string | null, billAddr: Record<string, unknown> | null = null, salesTermId: string | null = null): Promise<{ invoiceId: string }> {
  const txnDate = new Date().toISOString().slice(0, 10);
  const dueDate = addDays(txnDate, dueDateOffsetDays);
  const payload: Record<string, unknown> = { CustomerRef: { value: customerId }, Line: lineItems, TxnDate: txnDate, DueDate: dueDate, PrivateNote: `Created from Athena Portal for ${clientName}` };
  if (salesTermId) payload.SalesTermRef = { value: salesTermId };
  if (email) payload.BillEmail = { Address: email };
  if (billAddr) payload.BillAddr = billAddr;
  const resp = await qboFetch("invoice", { method: "POST", body: JSON.stringify(payload) });
  if (!resp.ok) throw new Error(`Failed to create QBO invoice: ${resp.status} ${await resp.text()}`);
  const created = await resp.json();
  return { invoiceId: String(created.Invoice.Id) };
}

async function sendQboInvoice(invoiceId: string, email: string): Promise<void> {
  const resp = await qboFetch(`invoice/${invoiceId}/send?sendTo=${encodeURIComponent(email)}`, { method: "POST" });
  if (!resp.ok) throw new Error(`Invoice ${invoiceId} created but send failed: ${resp.status} ${await resp.text()}`);
}

async function updateQboInvoice(invoiceId: string, customerId: string, lineItems: Array<Record<string, unknown>>): Promise<void> {
  const getResp = await qboFetch(`invoice/${invoiceId}`);
  if (!getResp.ok) throw new Error(`Failed to fetch QBO invoice ${invoiceId}: ${getResp.status}`);
  const current = await getResp.json();
  const resp = await qboFetch("invoice", { method: "POST", body: JSON.stringify({ Id: invoiceId, SyncToken: current.Invoice.SyncToken, CustomerRef: { value: customerId }, Line: lineItems }) });
  if (!resp.ok) throw new Error(`Failed to update QBO invoice: ${resp.status} ${await resp.text()}`);
}

function buildRecurringPayload(opts: { customerId: string; lineItems: Array<Record<string, unknown>>; templateName: string; startDate: string; dueDateOffsetDays: number; email?: string | null; billAddr?: Record<string, unknown> | null; salesTermId?: string | null; }): Record<string, unknown> {
  const day = parseInt(opts.startDate.slice(8, 10), 10) || 1;
  const dueDate = addDays(opts.startDate, opts.dueDateOffsetDays);
  const invoice: Record<string, unknown> = { RecurringInfo: { Name: opts.templateName.substring(0, 50), Active: true, RecurType: "Automated", ScheduleInfo: { IntervalType: "Monthly", NumInterval: 1, DayOfMonth: day, StartDate: opts.startDate } }, CustomerRef: { value: opts.customerId }, Line: opts.lineItems, TxnDate: opts.startDate, DueDate: dueDate };
  if (opts.salesTermId) invoice.SalesTermRef = { value: opts.salesTermId };
  // Email + address on the template. EmailStatus "NeedToSend" tells QBO to
  // auto-email each invoice it generates from this automated template.
  if (opts.email) {
    invoice.BillEmail = { Address: opts.email };
    invoice.EmailStatus = "NeedToSend";
  }
  if (opts.billAddr) invoice.BillAddr = opts.billAddr;
  return { Invoice: invoice };
}

async function createQboRecurringInvoice(opts: { customerId: string; lineItems: Array<Record<string, unknown>>; templateName: string; startDate: string; dueDateOffsetDays: number; email?: string | null; billAddr?: Record<string, unknown> | null; salesTermId?: string | null; }): Promise<string> {
  const payload = buildRecurringPayload(opts);
  const resp = await qboFetch("recurringtransaction", { method: "POST", body: JSON.stringify(payload) });
  if (!resp.ok) throw new Error(`Failed to create QBO recurring transaction: ${resp.status} ${await resp.text()}`);
  const created = await resp.json();
  const rt = created.RecurringTransaction || created;
  const inv = rt.Invoice || rt;
  return String(inv.Id);
}

async function updateQboRecurringInvoice(opts: { id: string; syncToken: string; customerId: string; lineItems: Array<Record<string, unknown>>; templateName: string; startDate: string; dueDateOffsetDays: number; email?: string | null; billAddr?: Record<string, unknown> | null; salesTermId?: string | null; }): Promise<string> {
  const base = buildRecurringPayload(opts) as { Invoice: Record<string, unknown> };
  base.Invoice.Id = opts.id;
  base.Invoice.SyncToken = opts.syncToken;
  const resp = await qboFetch("recurringtransaction", { method: "POST", body: JSON.stringify(base) });
  if (!resp.ok) throw new Error(`Failed to update QBO recurring transaction: ${resp.status} ${await resp.text()}`);
  const updated = await resp.json();
  const rt = updated.RecurringTransaction || updated;
  const inv = rt.Invoice || rt;
  return String(inv.Id);
}
