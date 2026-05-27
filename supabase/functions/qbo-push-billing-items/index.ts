import { getServiceClient, qboFetch, qboQuery, logSync, jsonResponse, corsHeaders } from "../_shared/qbo-client.ts";

// Push one-off Billing module items (billing_items) to QBO as real
// invoices. For each approved item we ensure the QBO customer + item
// exist, build a single line at the net amount with the standard 20%
// UK tax code (so QBO computes VAT to match the stored amount), create
// the invoice, then either email it immediately or leave it as a draft
// for the team to send from QBO later.
//
// Input: { billing_item_ids: string[], send: boolean, dry_run?: boolean, initiated_by?: string }
//   send=true  → create + email the invoice (QBO SendInvoice)
//   send=false → create only; team sends from QBO later
//   dry_run=true → return a read-only plan (no QBO writes, no DB writes):
//                  whether each customer exists or will be created, the
//                  client email, and the net/vat/gross — so the UI can
//                  show a confirmation summary before committing.
//
// Per-item isolation: one failure never aborts the batch.

interface ItemResult {
  billing_item_id: string;
  entity: string;
  status: "sent" | "created_unsent" | "error";
  qbo_invoice_id?: string;
  reason?: string;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }
  if (req.method !== "POST") {
    return jsonResponse({ success: false, error: "POST required" }, 405);
  }

  let body: { billing_item_ids?: string[]; send?: boolean; dry_run?: boolean; initiated_by?: string };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ success: false, error: "Invalid JSON" }, 400);
  }

  const ids = Array.isArray(body.billing_item_ids) ? body.billing_item_ids : [];
  const send = body.send !== false; // default to sending
  if (ids.length === 0) {
    return jsonResponse({ success: false, error: "billing_item_ids required" }, 400);
  }

  const sb = getServiceClient();

  const { data: items, error: itemsErr } = await sb
    .from("billing_items")
    .select("*, entity:entities(id, name, qbo_customer_id, qbo_customer_name, billing_email, prospect_email)")
    .in("id", ids);

  if (itemsErr) {
    return jsonResponse({ success: false, error: itemsErr.message }, 500);
  }

  // Resolve the standard-rate (20%) tax code once for the whole batch.
  let taxCodeId: string | null = null;
  try {
    taxCodeId = await resolveStandardTaxCode();
  } catch (err) {
    return jsonResponse({ success: false, error: `Could not resolve 20% tax code: ${(err as Error).message}` }, 500);
  }
  if (!taxCodeId) {
    return jsonResponse({ success: false, error: "No standard-rate (20%) sales tax code found in QBO. Set QBO_STANDARD_TAX_CODE_ID." }, 500);
  }

  // Dry run: read-only plan for the confirmation summary. No QBO or DB
  // writes. Reports per item whether the customer/item already exist.
  if (body.dry_run) {
    const plan = [];
    const custCache = new Map<string, { exists: boolean; email: string | null }>();
    for (const item of (items || [])) {
      const entity = (item.entity as Record<string, unknown> | null) || null;
      const entityName = (entity?.name as string) || "Unknown Client";
      const localEmail = (entity?.billing_email as string) || (entity?.prospect_email as string) || null;
      const serviceName = String(item.service || "Professional Services");

      // Look up the QBO customer (by stored id, else by name) to learn
      // whether it exists and what email QBO already has on file.
      const cacheKey = (entity?.qbo_customer_id as string) || entityName;
      let cust = custCache.get(cacheKey);
      if (!cust) {
        cust = entity?.qbo_customer_id
          ? await fetchQboCustomer("Id", String(entity.qbo_customer_id))
          : await fetchQboCustomer("DisplayName", entityName);
        custCache.set(cacheKey, cust);
      }

      // Effective send address: local record wins, else QBO's BillEmail.
      const email = localEmail || cust.email;
      const itemExists = await qboRecordExists("Item", "Name", serviceName.substring(0, 100));

      plan.push({
        billing_item_id: item.id,
        entity: entityName,
        service: serviceName,
        approved: item.status === "approved",
        customer_action: cust.exists ? "existing" : "create",
        item_action: itemExists ? "existing" : "create",
        has_email: !!email,
        email,
        email_source: email ? (localEmail ? "athena" : "quickbooks") : null,
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

  const itemCache = new Map<string, string>(); // service name → QBO item id
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
      // 1. Ensure QBO customer.
      let qboCustomerId = (entity?.qbo_customer_id as string) || null;
      if (!qboCustomerId) {
        qboCustomerId = await ensureQboCustomer(sb, entity, entityName);
      }

      // 2. Ensure QBO item for the service.
      const serviceName = String(item.service || "Professional Services");
      let qboItemId = itemCache.get(serviceName);
      if (!qboItemId) {
        qboItemId = await ensureQboItem(serviceName, item.description || serviceName, incomeAccountId);
        itemCache.set(serviceName, qboItemId);
      }

      const net = Number(item.net_amount) || 0;
      // Effective send address: local record wins, else QBO's BillEmail.
      let email = (entity?.billing_email as string) || (entity?.prospect_email as string) || null;
      if (!email) {
        const cust = await fetchQboCustomer("Id", qboCustomerId);
        email = cust.email;
      }

      // 3. Build + create the invoice. Net amount per line + the 20% tax
      //    code with TaxExcluded lets QBO add VAT matching vat_amount.
      const invoiceBody: Record<string, unknown> = {
        CustomerRef: { value: qboCustomerId },
        GlobalTaxCalculation: "TaxExcluded",
        Line: [{
          DetailType: "SalesItemLineDetail",
          Amount: net,
          Description: item.description || serviceName,
          SalesItemLineDetail: {
            ItemRef: { value: qboItemId },
            Qty: 1,
            UnitPrice: net,
            TaxCodeRef: { value: taxCodeId },
          },
        }],
        PrivateNote: `Created from Athena Portal (Billing) for ${entityName}`,
      };
      if (email) invoiceBody.BillEmail = { Address: email };

      const createResp = await qboFetch("invoice", {
        method: "POST",
        body: JSON.stringify(invoiceBody),
      });
      if (!createResp.ok) {
        throw new Error(`create invoice failed: ${createResp.status} ${await createResp.text()}`);
      }
      const created_ = await createResp.json();
      const qboInvoiceId = String(created_.Invoice.Id);

      // 4. Send now, or leave as draft.
      let finalStatus: ItemResult["status"];
      if (send && email) {
        const sendResp = await qboFetch(`invoice/${qboInvoiceId}/send?sendTo=${encodeURIComponent(email)}`, {
          method: "POST",
        });
        if (!sendResp.ok) {
          throw new Error(`invoice created (${qboInvoiceId}) but send failed: ${sendResp.status} ${await sendResp.text()}`);
        }
        finalStatus = "sent";
        sent++;
      } else {
        finalStatus = "created_unsent";
        created++;
      }

      // 5. Write back.
      await sb.from("billing_items").update({
        status: "pushed",
        qbo_invoice_id: qboInvoiceId,
        qbo_customer_id: qboCustomerId,
        qbo_sync_status: finalStatus,
        qbo_synced_at: new Date().toISOString(),
        qbo_sync_error: null,
        pushed_by: body.initiated_by || null,
        pushed_at: new Date().toISOString(),
      }).eq("id", item.id);

      results.push({
        billing_item_id: item.id,
        entity: entityName,
        status: finalStatus,
        qbo_invoice_id: qboInvoiceId,
        reason: finalStatus === "created_unsent" && send && !email ? "no client email on file — created as draft" : undefined,
      });

      await logSync({
        direction: "push",
        entity_id: (entity?.id as string) || undefined,
        entity_name: entityName,
        qbo_entity_type: "Invoice",
        qbo_entity_id: qboInvoiceId,
        status: "success",
        detail: { billing_item_id: item.id, net, sent: finalStatus === "sent" },
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

// Find the standard-rate 20% sales tax code. Env override wins; else
// pick an active sales TaxCode whose name mentions 20 / "S" standard.
async function resolveStandardTaxCode(): Promise<string | null> {
  const override = Deno.env.get("QBO_STANDARD_TAX_CODE_ID");
  if (override) return override;

  const result = await qboQuery("SELECT * FROM TaxCode") as Record<string, unknown>;
  const qr = (result?.QueryResponse as Record<string, unknown>) || {};
  const codes = (qr.TaxCode as Array<Record<string, unknown>>) || [];

  const active = codes.filter((c) => c.Active !== false);
  // Prefer a name containing "20" (e.g. "20.0% S (VAT on Income)").
  const byTwenty = active.find((c) => /20/.test(String(c.Name || "")));
  if (byTwenty) return String(byTwenty.Id);
  // Fallback: a standard "S" code.
  const byStandard = active.find((c) => /\bS\b/.test(String(c.Name || "")) || /standard/i.test(String(c.Description || "")));
  if (byStandard) return String(byStandard.Id);
  return null;
}

// Look up a QBO customer by a field, returning whether it exists and the
// email QBO has on file (PrimaryEmailAddr / BillEmail).
async function fetchQboCustomer(field: string, value: string): Promise<{ exists: boolean; email: string | null }> {
  const escaped = value.replace(/'/g, "\\'");
  const result = await qboQuery(`SELECT Id, PrimaryEmailAddr FROM Customer WHERE ${field} = '${escaped}'`) as Record<string, unknown>;
  const qr = (result?.QueryResponse as Record<string, unknown>) || {};
  const rows = (qr.Customer as Array<Record<string, unknown>>) || [];
  if (rows.length === 0) return { exists: false, email: null };
  const primary = rows[0].PrimaryEmailAddr as Record<string, unknown> | undefined;
  const email = primary && primary.Address ? String(primary.Address) : null;
  return { exists: true, email };
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
