import { getServiceClient, qboFetch, qboQuery, logSync, jsonResponse, corsHeaders } from "../_shared/qbo-client.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  if (req.method !== "POST") {
    return jsonResponse({ success: false, error: "POST required" }, 405);
  }

  try {
    const { billing_id, initiated_by } = await req.json();
    if (!billing_id) {
      return jsonResponse({ success: false, error: "billing_id required" }, 400);
    }

    const sb = getServiceClient();

    // 1. Load billing record with entity
    const { data: billing, error: billingErr } = await sb
      .from("live_billing")
      .select("*, entities(*)")
      .eq("id", billing_id)
      .single();

    if (billingErr || !billing) {
      return jsonResponse({ success: false, error: "Billing record not found" }, 404);
    }

    const entity = billing.entities;
    const entityName = entity?.name || entity?.display_name || "Unknown Client";

    // Mark as pending
    await sb.from("live_billing").update({ qbo_sync_status: "pending" }).eq("id", billing_id);

    // 2. Ensure QBO Customer exists
    let qboCustomerId = entity?.qbo_customer_id;
    if (!qboCustomerId) {
      qboCustomerId = await ensureQboCustomer(sb, entity, entityName);
    }

    // 3. Ensure QBO Items (services) exist
    const services = billing.services || [];
    const lineItems = [];
    for (const svc of services) {
      const itemId = await ensureQboItem(svc.service_id, svc.description || svc.service_id);
      lineItems.push({
        DetailType: "SalesItemLineDetail",
        Amount: svc.monthly_amount || (svc.annual_amount ? svc.annual_amount / 12 : 0),
        Description: svc.description || svc.service_id,
        SalesItemLineDetail: {
          ItemRef: { value: itemId },
          Qty: 1,
          UnitPrice: svc.monthly_amount || (svc.annual_amount ? svc.annual_amount / 12 : 0),
        },
      });
    }

    // 4. Create or update Invoice in QBO
    let qboInvoiceId = billing.qbo_invoice_id;
    let qboRecurringTxnId = billing.qbo_recurring_txn_id;

    if (qboInvoiceId) {
      // Update existing invoice
      await updateQboInvoice(qboInvoiceId, qboCustomerId, lineItems);
    } else {
      // Create new invoice
      const result = await createQboInvoice(qboCustomerId, lineItems, entityName);
      qboInvoiceId = result.invoiceId;
    }

    // 5. Update billing record
    await sb.from("live_billing").update({
      qbo_invoice_id: qboInvoiceId,
      qbo_recurring_txn_id: qboRecurringTxnId,
      qbo_customer_id: qboCustomerId,
      last_qbo_sync: new Date().toISOString(),
      qbo_sync_status: "synced",
    }).eq("id", billing_id);

    // 6. Log sync
    await logSync({
      direction: "push",
      entity_id: entity?.id,
      entity_name: entityName,
      qbo_entity_type: "Invoice",
      qbo_entity_id: qboInvoiceId,
      status: "success",
      detail: { billing_id, services_count: services.length, monthly_gross: billing.monthly_gross },
      initiated_by: initiated_by || null,
    });

    return jsonResponse({
      success: true,
      data: {
        qbo_invoice_id: qboInvoiceId,
        qbo_customer_id: qboCustomerId,
        services_pushed: services.length,
      },
    });
  } catch (err) {
    console.error("qbo-push error:", err);

    // Try to log the error
    try {
      const body = await req.clone().json().catch(() => ({}));
      await logSync({
        direction: "push",
        status: "error",
        error_message: (err as Error).message,
        detail: { billing_id: body.billing_id },
        initiated_by: body.initiated_by || null,
      });
    } catch { /* best effort */ }

    return jsonResponse({ success: false, error: (err as Error).message }, 500);
  }
});

// Ensure a QBO customer exists, creating if needed
async function ensureQboCustomer(
  sb: ReturnType<typeof getServiceClient>,
  entity: Record<string, unknown>,
  entityName: string,
): Promise<string> {
  // Search QBO for existing customer
  const escapedName = entityName.replace(/'/g, "\\'");
  const result = await qboQuery(`SELECT * FROM Customer WHERE DisplayName = '${escapedName}'`) as Record<string, unknown>;
  const queryResponse = result?.QueryResponse as Record<string, unknown>;
  const customers = queryResponse?.Customer as Array<Record<string, unknown>>;

  if (customers && customers.length > 0) {
    const qboId = String(customers[0].Id);
    // Store the mapping
    if (entity?.id) {
      await sb.from("entities").update({
        qbo_customer_id: qboId,
        qbo_customer_name: customers[0].DisplayName as string,
      }).eq("id", entity.id);
    }
    return qboId;
  }

  // Create new customer in QBO
  const resp = await qboFetch("customer", {
    method: "POST",
    body: JSON.stringify({
      DisplayName: entityName,
      CompanyName: entityName,
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Failed to create QBO customer: ${resp.status} ${errText}`);
  }

  const created = await resp.json();
  const qboId = String(created.Customer.Id);

  // Store the mapping
  if (entity?.id) {
    await sb.from("entities").update({
      qbo_customer_id: qboId,
      qbo_customer_name: created.Customer.DisplayName,
    }).eq("id", entity.id);
  }

  return qboId;
}

// Ensure a QBO Item (service) exists
async function ensureQboItem(serviceId: string, description: string): Promise<string> {
  const name = description.substring(0, 100); // QBO item name max 100 chars
  const escapedName = name.replace(/'/g, "\\'");

  const result = await qboQuery(`SELECT * FROM Item WHERE Name = '${escapedName}'`) as Record<string, unknown>;
  const queryResponse = result?.QueryResponse as Record<string, unknown>;
  const items = queryResponse?.Item as Array<Record<string, unknown>>;

  if (items && items.length > 0) {
    return String(items[0].Id);
  }

  // Create new item
  const resp = await qboFetch("item", {
    method: "POST",
    body: JSON.stringify({
      Name: name,
      Description: description,
      Type: "Service",
      IncomeAccountRef: { value: "1" }, // Default income account - may need configuration
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Failed to create QBO item '${name}': ${resp.status} ${errText}`);
  }

  const created = await resp.json();
  return String(created.Item.Id);
}

// Create a QBO Invoice
async function createQboInvoice(
  customerId: string,
  lineItems: Array<Record<string, unknown>>,
  clientName: string,
): Promise<{ invoiceId: string }> {
  const resp = await qboFetch("invoice", {
    method: "POST",
    body: JSON.stringify({
      CustomerRef: { value: customerId },
      Line: lineItems,
      PrivateNote: `Created from Athena Portal for ${clientName}`,
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Failed to create QBO invoice: ${resp.status} ${errText}`);
  }

  const created = await resp.json();
  return { invoiceId: String(created.Invoice.Id) };
}

// Update an existing QBO Invoice
async function updateQboInvoice(
  invoiceId: string,
  customerId: string,
  lineItems: Array<Record<string, unknown>>,
): Promise<void> {
  // Get current invoice to get SyncToken
  const getResp = await qboFetch(`invoice/${invoiceId}`);
  if (!getResp.ok) {
    throw new Error(`Failed to fetch QBO invoice ${invoiceId}: ${getResp.status}`);
  }
  const current = await getResp.json();

  const resp = await qboFetch("invoice", {
    method: "POST",
    body: JSON.stringify({
      Id: invoiceId,
      SyncToken: current.Invoice.SyncToken,
      CustomerRef: { value: customerId },
      Line: lineItems,
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Failed to update QBO invoice: ${resp.status} ${errText}`);
  }
}
