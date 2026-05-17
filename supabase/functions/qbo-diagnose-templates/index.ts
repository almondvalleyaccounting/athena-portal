import { getServiceClient, qboQuery, jsonResponse, corsHeaders } from "../_shared/qbo-client.ts";

// Walk every QBO RecurringTransaction template and report whether it's
// linked to a live_billing row in Athena. For each unlinked template
// we also report *why* — either the QBO customer isn't mapped to any
// entity, or the entity exists but no live_billing row carries this
// template id.
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });
  if (req.method !== "POST" && req.method !== "GET") {
    return jsonResponse({ success: false, error: "POST or GET required" }, 405);
  }

  const sb = getServiceClient();

  // 1. Pull every RecurringTransaction from QBO.
  // Paginate via STARTPOSITION — without it QBO caps at 1000 results
  // (and at 100 if MAXRESULTS isn't specified).
  let templates: Array<Record<string, unknown>> = [];
  try {
    let start = 1;
    const pageSize = 1000;
    for (let i = 0; i < 50; i++) {
      const result = await qboQuery(`SELECT * FROM RecurringTransaction STARTPOSITION ${start} MAXRESULTS ${pageSize}`) as Record<string, unknown>;
      const qr = result?.QueryResponse as Record<string, unknown>;
      const page = (qr?.RecurringTransaction || []) as Array<Record<string, unknown>>;
      if (page.length === 0) break;
      templates = templates.concat(page);
      if (page.length < pageSize) break;
      start += pageSize;
    }
  } catch (e) {
    return jsonResponse({ success: false, error: `QBO query failed: ${(e as Error).message}` }, 500);
  }

  // 2. Build lookup maps.
  //    - qbo_customer_id → entity_id (via qbo_customer_mappings, with
  //      entities.qbo_customer_id as fallback).
  //    - txn_id → live_billing row.
  const { data: mappings } = await sb.from("qbo_customer_mappings").select("qbo_customer_id, entity_id");
  const entityByQboId = new Map<string, string>();
  for (const m of mappings || []) entityByQboId.set(String(m.qbo_customer_id), String(m.entity_id));

  const { data: entities } = await sb.from("entities").select("id, name, qbo_customer_id");
  const entityById = new Map<string, { id: string; name: string }>();
  for (const e of entities || []) {
    entityById.set(String(e.id), { id: String(e.id), name: String(e.name) });
    if (e.qbo_customer_id && !entityByQboId.has(String(e.qbo_customer_id))) {
      entityByQboId.set(String(e.qbo_customer_id), String(e.id));
    }
  }

  const { data: billings } = await sb
    .from("live_billing")
    .select("id, entity_id, qbo_recurring_txn_id, status")
    .eq("status", "active")
    .not("qbo_recurring_txn_id", "is", null);
  const billingByTxn = new Map<string, { id: string; entity_id: string }>();
  for (const b of billings || []) {
    billingByTxn.set(String(b.qbo_recurring_txn_id), { id: String(b.id), entity_id: String(b.entity_id) });
  }

  // 3. Classify each template.
  let linked = 0;
  const unlinkedNoEntity: Array<Record<string, unknown>> = [];
  const unlinkedNoBilling: Array<Record<string, unknown>> = [];
  const linkedRows: Array<Record<string, unknown>> = [];

  for (const t of templates) {
    const inner = (t.Invoice || t.SalesReceipt || t) as Record<string, unknown>;
    const txnId = String(t.Id || inner.Id || "");
    const customerRef = (inner.CustomerRef || t.CustomerRef) as Record<string, unknown> | undefined;
    const qboCustomerId = customerRef ? String(customerRef.value) : "";
    const qboCustomerName = customerRef ? String(customerRef.name || "") : "(no customer)";
    const recurringInfo = (inner.RecurringInfo as Record<string, unknown> | undefined) || {};
    const templateName = String(recurringInfo.Name || "");
    const active = recurringInfo.Active !== false;

    const entityId = qboCustomerId ? entityByQboId.get(qboCustomerId) : null;
    const billing = billingByTxn.get(txnId);

    if (billing) {
      linked++;
      const entity = entityById.get(billing.entity_id);
      linkedRows.push({ txn_id: txnId, template_name: templateName, customer: qboCustomerName, entity_name: entity?.name || "?", active });
      continue;
    }
    if (!entityId) {
      unlinkedNoEntity.push({ txn_id: txnId, template_name: templateName, qbo_customer_id: qboCustomerId, qbo_customer_name: qboCustomerName, active, reason: "QBO customer not mapped to any Athena entity" });
    } else {
      const entity = entityById.get(entityId);
      unlinkedNoBilling.push({ txn_id: txnId, template_name: templateName, qbo_customer_id: qboCustomerId, qbo_customer_name: qboCustomerName, entity_id: entityId, entity_name: entity?.name || "?", active, reason: "entity matched, but no live_billing row carries this txn_id (re-run qbo-pull)" });
    }
  }

  return jsonResponse({
    success: true,
    summary: {
      qbo_templates_total: templates.length,
      linked,
      unlinked_no_entity_mapping: unlinkedNoEntity.length,
      unlinked_no_billing_row: unlinkedNoBilling.length,
    },
    unlinked_no_entity_mapping: unlinkedNoEntity,
    unlinked_no_billing_row: unlinkedNoBilling,
    linked: linkedRows,
  });
});
