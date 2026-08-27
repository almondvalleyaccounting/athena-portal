import { getServiceClient, qboFetch, qboQuery, recurringInner, logSync, jsonResponse, corsHeaders } from "../_shared/qbo-client.ts";
import { requireStaffOrService, authErrorResponse } from "../_shared/require-staff.ts";

// qbo-recurring-delivery — does each live recurring template actually EMAIL
// the client, and if not, fix it.
//
// A QBO recurring template bills on schedule regardless of whether anyone is
// told. Two fields decide whether the client hears about it:
//
//   BillEmail.Address            somewhere to send it
//   EmailStatus = "NeedToSend"   what the QBO UI calls "Automatically send
//                                emails"
//
// Miss either and QBO still generates the invoice, still grows the client's
// balance, and sends nothing. Athena recorded neither field, so this failure
// was invisible on every surface: Bonny Braes billed silently from its
// 2026-05-27 commit until a human noticed months later.
//
// qbo-push has refused a commit without a client email since v24 and sets
// EmailStatus on everything it writes, so the door is shut. This is for the
// templates already through it.
//
// Modes:
//   { mode: "sweep" }    read every template from QBO, record bill email +
//                        email status on live_billing, return the gaps.
//                        No QBO writes. Staff.
//   { mode: "repair", billing_ids?: [...], dry_run?: bool }
//                        set BillEmail + EmailStatus="NeedToSend" on the
//                        flagged templates. dry_run defaults TRUE — an apply
//                        needs dry_run:false explicitly, because it starts
//                        real invoice emails to real clients.
//                        Needs can_approve_billing.
//
// The repair writes the template back the way qbo-push-recurring does: fetch,
// spread, POST with Id + SyncToken. Everything QBO already holds — schedule,
// next run date, lines, memo, terms — is preserved by the spread.

type Tpl = {
  txnId: string;
  customerId: string;
  customerName: string;
  templateName: string;
  nextDate: string | null;
  active: boolean;
  billEmail: string | null;
  emailStatus: string | null;
};

const AUTO_SEND = "NeedToSend";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });
  if (req.method !== "POST") return jsonResponse({ success: false, error: "POST required" }, 405);

  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const mode = String((body as Record<string, unknown>).mode ?? "sweep");
  // Repair changes what Intuit emails to clients, so it needs the billing
  // approval flag — not merely staff. The sweep only reads.
  try {
    await requireStaffOrService(req, mode === "repair" ? { flag: "can_approve_billing" } : undefined);
  } catch (err) {
    return authErrorResponse(err, corsHeaders());
  }

  const sb = getServiceClient();

  try {
    if (mode === "sweep") return await sweep(sb, (body as { initiated_by?: string }).initiated_by ?? null);
    if (mode === "repair") {
      return await repair(
        sb,
        (body as { billing_ids?: string[] }).billing_ids ?? null,
        // Default-on dry run. Omitting the flag must never send email.
        (body as { dry_run?: boolean }).dry_run !== false,
        (body as { initiated_by?: string }).initiated_by ?? null,
      );
    }
    return jsonResponse({ success: false, error: `Unknown mode "${mode}" (expected sweep or repair)` }, 400);
  } catch (e) {
    return jsonResponse({ success: false, error: (e as Error).message }, 500);
  }
});

// ── Read every recurring template QBO holds ────────────────────────────────
// Paginated. QBO caps a query at 100 rows without MAXRESULTS and 1000 with it,
// and the AVA file carries 156 templates — an unpaged read silently misses the
// tail, which for this sweep would read as "no gap".
async function loadTemplates(): Promise<Tpl[]> {
  const out: Tpl[] = [];
  const page = 1000;
  let start = 1;
  for (let guard = 0; guard < 50; guard++) {
    const result = (await qboQuery(`SELECT * FROM RecurringTransaction STARTPOSITION ${start} MAXRESULTS ${page}`)) as Record<string, unknown>;
    const qr = (result?.QueryResponse as Record<string, unknown>) || {};
    const rows = (qr.RecurringTransaction as Array<Record<string, unknown>>) || [];
    for (const row of rows) {
      const inv = (row.Invoice as Record<string, unknown>) || null;
      if (!inv) continue; // SalesReceipt/Bill/JournalEntry templates never email an invoice
      const info = (inv.RecurringInfo as Record<string, unknown>) || {};
      const sched = (info.ScheduleInfo as Record<string, unknown>) || {};
      const cust = (inv.CustomerRef as Record<string, unknown>) || {};
      out.push({
        txnId: String(inv.Id),
        customerId: String(cust.value || ""),
        customerName: String(cust.name || ""),
        templateName: String(info.Name || ""),
        nextDate: String(info.NextDate || sched.NextDate || "").slice(0, 10) || null,
        active: info.Active !== false,
        billEmail: String(((inv.BillEmail as Record<string, unknown> | undefined)?.Address) ?? "").trim() || null,
        emailStatus: String(inv.EmailStatus ?? "").trim() || null,
      });
    }
    if (rows.length < page) break;
    start += page;
  }
  return out;
}

async function sweep(sb: ReturnType<typeof getServiceClient>, initiatedBy: string | null) {
  const templates = await loadTemplates();
  const byTxn = new Map<string, Tpl>();
  for (const t of templates) byTxn.set(t.txnId, t);

  const { data: rows, error } = await sb
    .from("live_billing")
    .select("id, entity_id, qbo_recurring_txn_id, monthly_net, entities(name, billing_email, prospect_email)")
    .eq("status", "active")
    .not("qbo_recurring_txn_id", "is", null);
  if (error) return jsonResponse({ success: false, error: error.message }, 500);

  const now = new Date().toISOString();
  const gaps: Array<Record<string, unknown>> = [];
  let checked = 0, willEmail = 0, notInQbo = 0;

  for (const row of rows || []) {
    const tpl = byTxn.get(String(row.qbo_recurring_txn_id));
    if (!tpl) {
      // The stored template id is not an Invoice template in QBO any more.
      // Leave the recorded state alone rather than writing a misleading
      // "no email" — qbo-diagnose-templates owns the linkage problem.
      notInQbo++;
      continue;
    }
    const { error: upErr } = await sb.from("live_billing").update({
      qbo_bill_email: tpl.billEmail,
      qbo_email_status: tpl.emailStatus,
      qbo_email_checked_at: now,
      // Free with the same read, and the gap list is far more actionable with
      // it: "will never email, next runs Monday" is a different urgency from
      // "will never email, next runs in March".
      ...(tpl.nextDate ? { qbo_next_run_date: tpl.nextDate } : {}),
    }).eq("id", row.id);
    if (upErr) continue;
    checked++;

    if (tpl.billEmail && tpl.emailStatus === AUTO_SEND) { willEmail++; continue; }

    const ent = (row.entities as Record<string, unknown> | null) || null;
    const athenaEmail = (ent?.billing_email as string) || (ent?.prospect_email as string) || null;
    gaps.push({
      billing_id: row.id,
      entity_id: row.entity_id,
      entity_name: (ent?.name as string) || tpl.customerName,
      txn_id: tpl.txnId,
      monthly_net: row.monthly_net,
      next_date: tpl.nextDate,
      active: tpl.active,
      bill_email: tpl.billEmail,
      email_status: tpl.emailStatus,
      athena_email: athenaEmail,
      // A gap needing a human to find an address is a different job from one
      // that is a button press away. The QBO customer record is a third
      // source, only consulted during the repair itself.
      repairable_now: !!(tpl.billEmail || athenaEmail),
      problem: !tpl.billEmail && tpl.emailStatus !== AUTO_SEND
        ? "no email address and auto-send off"
        : !tpl.billEmail
          ? "auto-send on but no email address"
          : "email address set but auto-send off",
    });
  }

  gaps.sort((a, b) => Number(b.monthly_net ?? 0) - Number(a.monthly_net ?? 0));

  await logSync({
    direction: "pull",
    qbo_entity_type: "RecurringTransaction",
    qbo_entity_id: `delivery-sweep-${checked}`,
    status: gaps.length ? "pending" : "success",
    detail: { checked, will_email: willEmail, gaps: gaps.length, monthly_net_at_risk: round2(gaps.reduce((s, g) => s + Number(g.monthly_net ?? 0), 0)) },
    initiated_by: initiatedBy,
  });

  return jsonResponse({
    success: true,
    mode: "sweep",
    summary: {
      qbo_invoice_templates: templates.length,
      billing_rows_checked: checked,
      will_email_client: willEmail,
      will_not_email_client: gaps.length,
      not_found_in_qbo: notInQbo,
      monthly_net_at_risk: round2(gaps.reduce((s, g) => s + Number(g.monthly_net ?? 0), 0)),
    },
    gaps,
  });
}

async function repair(
  sb: ReturnType<typeof getServiceClient>,
  billingIds: string[] | null,
  dryRun: boolean,
  initiatedBy: string | null,
) {
  // Target set. Explicit ids win; otherwise every recorded gap. Either way
  // each target is re-read from QBO below, so a stale record cannot cause a
  // write to a template that is already fine.
  let q = sb
    .from("live_billing")
    .select("id, entity_id, qbo_recurring_txn_id, monthly_net, entities(name, billing_email, prospect_email)")
    .eq("status", "active")
    .not("qbo_recurring_txn_id", "is", null);
  if (billingIds && billingIds.length) {
    q = q.in("id", billingIds);
  } else {
    // Only rows the sweep has actually assessed, and only those it found
    // wanting — the same predicate as v_recurring_delivery_gaps. Targeting
    // every row with a null email status instead swept in templates never
    // checked at all, whose stored txn ids include stale ones QBO rejects.
    q = q
      .not("qbo_email_checked_at", "is", null)
      .or(`qbo_bill_email.is.null,qbo_email_status.neq.${AUTO_SEND}`);
  }
  const { data: rows, error } = await q;
  if (error) return jsonResponse({ success: false, error: error.message }, 500);
  if (!rows || rows.length === 0) {
    return jsonResponse({ success: true, mode: "repair", dry_run: dryRun, summary: { targets: 0, fixed: 0, skipped: 0, errored: 0 }, results: [] });
  }

  const results: Array<Record<string, unknown>> = [];
  let fixed = 0, skipped = 0, errored = 0;

  for (const row of rows) {
    const txnId = String(row.qbo_recurring_txn_id);
    const ent = (row.entities as Record<string, unknown> | null) || null;
    const entityName = (ent?.name as string) || "Unknown";

    try {
      const getResp = await qboFetch(`recurringtransaction/${txnId}`);
      if (!getResp.ok) throw new Error(`GET recurringtransaction/${txnId}: ${getResp.status} ${await getResp.text()}`);
      const getBody = await getResp.json() as Record<string, unknown>;
      // Read endpoint, so the txn is nested under RecurringTransaction.
      const found = recurringInner(getBody);
      const template = found?.key === "Invoice" ? found.txn : undefined;
      if (!template) {
        skipped++;
        results.push({ billing_id: row.id, entity: entityName, txn_id: txnId, status: "skipped", reason: "not an Invoice recurring template" });
        continue;
      }

      const currentEmail = String(((template.BillEmail as Record<string, unknown> | undefined)?.Address) ?? "").trim() || null;
      const currentStatus = String(template.EmailStatus ?? "").trim() || null;

      if (currentEmail && currentStatus === AUTO_SEND) {
        // Already fine. Record the truth so the row stops showing as a gap.
        await sb.from("live_billing").update({
          qbo_bill_email: currentEmail,
          qbo_email_status: currentStatus,
          qbo_email_checked_at: new Date().toISOString(),
        }).eq("id", row.id);
        skipped++;
        results.push({ billing_id: row.id, entity: entityName, txn_id: txnId, status: "skipped", reason: "already emails the client" });
        continue;
      }

      // Resolve an address. The template's own is the most authoritative — a
      // human put it there for this bill. Then Athena's, then the QBO
      // customer record. We never invent one, and we never repair a
      // template we cannot address: turning auto-send on with no recipient
      // just changes one silent failure into another.
      let email = currentEmail;
      let emailSource = "template";
      if (!email) {
        email = (ent?.billing_email as string) || null;
        emailSource = "entities.billing_email";
      }
      if (!email) {
        email = (ent?.prospect_email as string) || null;
        emailSource = "entities.prospect_email";
      }
      if (!email) {
        const cust = (template.CustomerRef as Record<string, unknown> | undefined)?.value;
        if (cust) {
          const cResp = await qboFetch(`customer/${cust}`);
          if (cResp.ok) {
            const c = ((await cResp.json()) as { Customer: Record<string, unknown> }).Customer;
            email = String(((c?.PrimaryEmailAddr as Record<string, unknown>)?.Address) ?? "").trim() || null;
            emailSource = "qbo customer";
          }
        }
      }
      if (!email) {
        skipped++;
        results.push({
          billing_id: row.id, entity: entityName, txn_id: txnId, status: "skipped",
          reason: "no email address anywhere (template, Athena, QBO customer) — someone has to find one",
        });
        continue;
      }

      const change = {
        billing_id: row.id,
        entity: entityName,
        txn_id: txnId,
        monthly_net: row.monthly_net,
        email,
        email_source: emailSource,
        from: { bill_email: currentEmail, email_status: currentStatus },
        to: { bill_email: email, email_status: AUTO_SEND },
      };

      if (dryRun) {
        results.push({ ...change, status: "dry_run" });
        continue;
      }

      // Full-object update with Id + SyncToken. The spread carries the
      // schedule, lines, memo and terms through untouched — same shape
      // qbo-push-recurring uses for uplifts.
      const proposed = {
        Invoice: {
          ...template,
          BillEmail: { Address: email },
          EmailStatus: AUTO_SEND,
        },
      };
      const postResp = await qboFetch("recurringtransaction", { method: "POST", body: JSON.stringify(proposed) });
      if (!postResp.ok) throw new Error(`POST recurringtransaction: ${postResp.status} ${await postResp.text()}`);

      await sb.from("live_billing").update({
        qbo_bill_email: email,
        qbo_email_status: AUTO_SEND,
        qbo_email_checked_at: new Date().toISOString(),
      }).eq("id", row.id);

      fixed++;
      results.push({ ...change, status: "fixed" });

      await logSync({
        direction: "push",
        entity_id: (row.entity_id as string) || null,
        entity_name: entityName,
        qbo_entity_type: "RecurringTransaction",
        qbo_entity_id: txnId,
        status: "success",
        detail: { repair: "delivery", ...change },
        initiated_by: initiatedBy,
      });
    } catch (e) {
      errored++;
      const message = (e as Error).message;
      results.push({ billing_id: row.id, entity: entityName, txn_id: txnId, status: "error", error: message });
      await logSync({
        direction: "push",
        entity_id: (row.entity_id as string) || null,
        entity_name: entityName,
        qbo_entity_type: "RecurringTransaction",
        qbo_entity_id: txnId,
        status: "error",
        error_message: message,
        detail: { repair: "delivery" },
        initiated_by: initiatedBy,
      });
    }
  }

  return jsonResponse({
    success: true,
    mode: "repair",
    dry_run: dryRun,
    summary: { targets: rows.length, fixed, skipped, errored, would_fix: dryRun ? results.filter((r) => r.status === "dry_run").length : undefined },
    results,
  });
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
