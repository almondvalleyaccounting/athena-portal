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
      if (!billing) return jsonResponse({ success: false, error: `${mode} requires billing_id` }, 400);
      const services = (billing.services as ServiceLine[]) || [];
      recurringLines = services.map((s) => ({ service_id: s.service_id, description: s.description, monthly_amount: Number(s.monthly_amount) || 0, annual_amount: Number(s.annual_amount) || 0 }));
    }

    const entityName = (entity?.name as string) || (entity?.qbo_customer_name as string) || "Unknown Client";
    // A caller-supplied bill_email (e.g. chosen from group members in the
    // commit modal) overrides the entity's stored email for this push.
    const clientEmail = billEmailOverride || (entity?.billing_email as string) || (entity?.prospect_email as string) || null;

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

      return jsonResponse({
        success: true,
        dry_run: true,
        plan: {
          mode,
          customer: { action: customerExists ? "existing" : "create", name: entityName, qbo_customer_id: existingCustomerId },
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

    let qboCustomerId = (entity?.qbo_customer_id as string) || null;
    if (!qboCustomerId) qboCustomerId = await ensureQboCustomer(sb, entity, entityName);

    let setupInvoiceId: string | null = null;
    let setupSent = false;
    if (hasSetup) {
      const setupLineItems = setupLines.map((l) => buildLineItem(l, itemMap, l.amount ?? 0, defaultTaxCodeId));
      const inv = await createQboInvoice(qboCustomerId, setupLineItems, `Setup — ${entityName}`, dueDateOffsetDays, clientEmail);
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
        recurringTxnId = await updateQboRecurringInvoice({ id: target.id, syncToken: target.syncToken, customerId: qboCustomerId, lineItems, templateName: recurringTemplateName, startDate, dueDateOffsetDays });
        recurringAction = "overwrite";
      } else {
        recurringTxnId = await createQboRecurringInvoice({ customerId: qboCustomerId, lineItems, templateName: recurringTemplateName, startDate, dueDateOffsetDays });
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
      else { const inv = await createQboInvoice(qboCustomerId, lineItems, entityName, dueDateOffsetDays, clientEmail); flatInvoiceId = inv.invoiceId; }
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

async function createQboInvoice(customerId: string, lineItems: Array<Record<string, unknown>>, clientName: string, dueDateOffsetDays: number, email: string | null): Promise<{ invoiceId: string }> {
  const txnDate = new Date().toISOString().slice(0, 10);
  const dueDate = addDays(txnDate, dueDateOffsetDays);
  const payload: Record<string, unknown> = { CustomerRef: { value: customerId }, Line: lineItems, TxnDate: txnDate, DueDate: dueDate, PrivateNote: `Created from Athena Portal for ${clientName}` };
  if (email) payload.BillEmail = { Address: email };
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

function buildRecurringPayload(opts: { customerId: string; lineItems: Array<Record<string, unknown>>; templateName: string; startDate: string; dueDateOffsetDays: number; }): Record<string, unknown> {
  const day = parseInt(opts.startDate.slice(8, 10), 10) || 1;
  const dueDate = addDays(opts.startDate, opts.dueDateOffsetDays);
  return { Invoice: { RecurringInfo: { Name: opts.templateName.substring(0, 50), Active: true, RecurType: "Automated", ScheduleInfo: { IntervalType: "Monthly", NumInterval: 1, DayOfMonth: day, StartDate: opts.startDate } }, CustomerRef: { value: opts.customerId }, Line: opts.lineItems, TxnDate: opts.startDate, DueDate: dueDate } };
}

async function createQboRecurringInvoice(opts: { customerId: string; lineItems: Array<Record<string, unknown>>; templateName: string; startDate: string; dueDateOffsetDays: number; }): Promise<string> {
  const payload = buildRecurringPayload(opts);
  const resp = await qboFetch("recurringtransaction", { method: "POST", body: JSON.stringify(payload) });
  if (!resp.ok) throw new Error(`Failed to create QBO recurring transaction: ${resp.status} ${await resp.text()}`);
  const created = await resp.json();
  const rt = created.RecurringTransaction || created;
  const inv = rt.Invoice || rt;
  return String(inv.Id);
}

async function updateQboRecurringInvoice(opts: { id: string; syncToken: string; customerId: string; lineItems: Array<Record<string, unknown>>; templateName: string; startDate: string; dueDateOffsetDays: number; }): Promise<string> {
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
