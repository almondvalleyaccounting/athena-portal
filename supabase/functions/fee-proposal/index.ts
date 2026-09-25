// fee-proposal — Athena Portal
//
// The one write path for fee_proposals (sql/300): a fee change issued to a
// client from the single-client fee review, and its sign-off.
//
//   { action: "issue", entity_id, kind: "notice"|"proposal", effective_at,
//     billing_ids, lines, summary, subject?, recipient_email?, gmail_draft_id? }
//       Records what was issued and tags every pending service on those
//       billing rows with pending_proposal_id. Lines that add a service carry
//       pending_needs_acceptance; qbo-push-recurring holds those back until
//       this proposal is accepted, and pushes everything else from the
//       effective date. An open fee change already on the same rows is
//       superseded (withdrawn): one per client in flight at a time.
//
//       For a proposal the response carries accept_url: the signed link the
//       client clicks to accept (fee-change-accept, /accept-fee-change).
//
//   { action: "set_draft", proposal_id, gmail_draft_id }
//       Notes the Gmail draft the letter went out in. The modal issues first
//       (it needs the link to write the email), then drafts.
//
//   { action: "record_acceptance", proposal_id, email_confirmed: true,
//     received_on: "YYYY-MM-DD", inbox, note? }
//       Staff record the client's WRITTEN acceptance. Verbal acceptance is not
//       enough (decided 2026-09-25): email_confirmed must be true, and the date
//       it arrived and the inbox it arrived in are required. The table's CHECK
//       enforces the same, so no other path can skip it.
//
//   { action: "decline" | "withdraw", proposal_id, note?, clear_pending? }
//       Closes it. clear_pending removes the staged amounts it tagged, so the
//       client's current fees stand.
//
//   { action: "preview_go_live" | "approve_go_live", billing_id, go_live_date,
//     catchup?: { reason: "approval_late"|"template_late"|"other", note? } }
//       The go-live date must be approved before anything is pushed
//       (sql/303). Approving writes the date onto every staged line of the
//       row and records who and when. If the date is already past — the
//       template has invoiced at the old fee since — preview says how much
//       was missed, and approve can raise a draft one-off catch-up invoice
//       for it (Billing module), which needs a reason.
//
//   { action: "mark_sent", proposal_id, sent_from }
//       Records that the email went out from Athena, and from which inbox.
//
//   { action: "ensure_billing_row", entity_id }
//       A client with no recurring bill yet gets an empty one (no QBO
//       template) so the fee review can stage fees against it.
//
//   { action: "save_drivers", entity_id, drivers: { turnover, accounts_type,
//     properties, directors, monthly_employees, weekly_employees } }
//       Keeps the client's pricing drivers (sql/301) so the next fee review
//       starts from them. Blank means unknown and is stored as null.
//
// Callers: staff who can see client fees (can_view_client_fees), as for
// live_billing itself.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireStaffOrService, authErrorResponse } from "../_shared/require-staff.ts";
import { signFeeAcceptToken, feeAcceptUrl } from "../_shared/fee-accept-token.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...corsHeaders } });
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
type Service = Record<string, unknown>;

// Today in the UK, as YYYY-MM-DD — the date staff mean by "today".
function londonToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date());
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST") return json({ success: false, error: "POST required" }, 405);

  let caller;
  try { caller = await requireStaffOrService(req, "can_view_client_fees"); }
  catch (err) { return authErrorResponse(err, corsHeaders); }
  const userId = caller.userId;

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ success: false, error: "Invalid JSON" }, 400); }

  const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  const audit = (action: string, id: string, detail: Record<string, unknown>) =>
    sb.from("audit_log").insert({ user_id: userId, action, entity_type: "fee_proposal", entity_id: id, detail });

  switch (body.action) {
    case "issue": return await issue(sb, body, userId, audit);
    case "record_acceptance": return await recordAcceptance(sb, body, userId, audit);
    case "decline":
    case "withdraw": return await close(sb, body, userId, audit, body.action === "decline" ? "declined" : "withdrawn");
    case "save_drivers": return await saveDrivers(sb, body, userId);
    case "preview_go_live": return await goLive(sb, body, userId, false);
    case "approve_go_live": return await goLive(sb, body, userId, true);
    case "mark_sent": {
      const id = String(body.proposal_id || "");
      if (!id) return json({ success: false, error: "proposal_id required" }, 400);
      const { error } = await sb.from("fee_proposals").update({
        sent_at: new Date().toISOString(), sent_by: userId, sent_from: body.sent_from ? String(body.sent_from) : null, updated_at: new Date().toISOString(),
      }).eq("id", id);
      if (error) return json({ success: false, error: error.message }, 500);
      await audit("fee_proposal_sent", id, { sent_from: body.sent_from || null });
      return json({ success: true });
    }
    case "ensure_billing_row": {
      const entityId = String(body.entity_id || "");
      if (!entityId) return json({ success: false, error: "entity_id required" }, 400);
      const { data: existing } = await sb.from("live_billing").select("*").eq("entity_id", entityId).eq("status", "active").limit(1);
      if (existing && existing.length) return json({ success: true, row: existing[0], created: false });
      const { data: row, error } = await sb.from("live_billing").insert({
        entity_id: entityId, billing_type: "recurring", status: "active", services: [],
        monthly_net: 0, monthly_vat: 0, monthly_gross: 0, annual_total: 0,
        review_reason: "Started from the fee review — no QuickBooks template yet",
      }).select("*").single();
      if (error) return json({ success: false, error: error.message }, 500);
      await sb.from("audit_log").insert({ user_id: userId, action: "live_billing_started_from_fee_review", entity_type: "live_billing", entity_id: row.id, detail: { entity_id: entityId } });
      return json({ success: true, row, created: true });
    }
    case "set_draft": {
      const id = String(body.proposal_id || ""), draft = String(body.gmail_draft_id || "");
      if (!id || !draft) return json({ success: false, error: "proposal_id and gmail_draft_id required" }, 400);
      const { error } = await sb.from("fee_proposals").update({ gmail_draft_id: draft, updated_at: new Date().toISOString() }).eq("id", id);
      return error ? json({ success: false, error: error.message }, 500) : json({ success: true });
    }
    default: return json({ success: false, error: "Unknown action" }, 400);
  }
});

// deno-lint-ignore no-explicit-any
type Sb = any;
type Audit = (action: string, id: string, detail: Record<string, unknown>) => unknown;

async function issue(sb: Sb, b: Record<string, unknown>, userId: string | null, audit: Audit) {
  const entityId = String(b.entity_id || "");
  const kind = String(b.kind || "");
  const effectiveAt = String(b.effective_at || "");
  const billingIds = Array.isArray(b.billing_ids) ? (b.billing_ids as unknown[]).map(String) : [];
  if (!entityId) return json({ success: false, error: "entity_id required" }, 400);
  if (kind !== "notice" && kind !== "proposal") return json({ success: false, error: "kind must be notice or proposal" }, 400);
  if (!ISO_DATE.test(effectiveAt)) return json({ success: false, error: "effective_at must be YYYY-MM-DD" }, 400);
  if (billingIds.length === 0) return json({ success: false, error: "billing_ids required" }, 400);

  // The rows must be this client's, and something must actually be staged.
  const { data: rows, error: rowErr } = await sb
    .from("live_billing").select("id, entity_id, services").in("id", billingIds);
  if (rowErr) return json({ success: false, error: rowErr.message }, 500);
  if (!rows || rows.length !== billingIds.length || rows.some((r: Service) => r.entity_id !== entityId)) {
    return json({ success: false, error: "billing_ids do not all belong to this client" }, 400);
  }
  const pendingCount = rows.reduce((n: number, r: Service) =>
    n + ((r.services as Service[]) || []).filter((s) => s.pending_monthly_amount != null).length, 0);
  if (pendingCount === 0) return json({ success: false, error: "Nothing is staged on these rows — save the new fees first" }, 400);

  const { data: created, error: insErr } = await sb.from("fee_proposals").insert({
    entity_id: entityId,
    kind,
    status: "issued",
    effective_at: effectiveAt,
    billing_ids: billingIds,
    lines: Array.isArray(b.lines) ? b.lines : [],
    summary: (b.summary && typeof b.summary === "object") ? b.summary : {},
    subject: b.subject ? String(b.subject) : null,
    recipient_email: b.recipient_email ? String(b.recipient_email) : null,
    gmail_draft_id: b.gmail_draft_id ? String(b.gmail_draft_id) : null,
    issued_by: userId,
  }).select("id").single();
  if (insErr || !created) return json({ success: false, error: insErr?.message || "insert failed" }, 500);
  const proposalId = created.id as string;

  // Tag the staged lines, noting any open fee change they were tagged with.
  const superseded = new Set<string>();
  for (const r of rows as Service[]) {
    const services = ((r.services as Service[]) || []).map((s) => {
      if (s.pending_monthly_amount == null) return s;
      if (s.pending_proposal_id && s.pending_proposal_id !== proposalId) superseded.add(String(s.pending_proposal_id));
      return { ...s, pending_proposal_id: proposalId, pending_effective_at: effectiveAt };
    });
    const { error } = await sb.from("live_billing").update({ services }).eq("id", r.id);
    if (error) return json({ success: false, error: `tagging ${r.id}: ${error.message}` }, 500);
  }
  if (superseded.size) {
    await sb.from("fee_proposals").update({
      status: "withdrawn", closed_at: new Date().toISOString(), closed_by: userId,
      close_note: `Superseded by fee change ${proposalId}`, updated_at: new Date().toISOString(),
    }).in("id", [...superseded]).in("status", ["issued", "accepted"]);
  }

  // A proposal's new services are accepted by the client through a signed
  // link, tied to the address it goes to.
  const acceptUrl = kind === "proposal"
    ? feeAcceptUrl(await signFeeAcceptToken(proposalId, String(b.recipient_email || "").trim().toLowerCase()))
    : null;

  await audit("fee_proposal_issued", proposalId, { entity_id: entityId, kind, effective_at: effectiveAt, billing_ids: billingIds, superseded: [...superseded] });
  return json({ success: true, proposal_id: proposalId, accept_url: acceptUrl, superseded: [...superseded] });
}

async function recordAcceptance(sb: Sb, b: Record<string, unknown>, userId: string | null, audit: Audit) {
  const id = String(b.proposal_id || "");
  const receivedOn = String(b.received_on || "");
  const inbox = String(b.inbox || "").trim();
  if (!id) return json({ success: false, error: "proposal_id required" }, 400);
  if (b.email_confirmed !== true) {
    return json({ success: false, error: "Confirm that the client's acceptance was received in writing by email — verbal acceptance is not enough" }, 400);
  }
  if (!ISO_DATE.test(receivedOn)) return json({ success: false, error: "received_on must be YYYY-MM-DD" }, 400);
  if (receivedOn > londonToday()) return json({ success: false, error: "The acceptance can't have been received in the future" }, 400);
  if (!inbox) return json({ success: false, error: "Say which inbox the acceptance email arrived in" }, 400);

  const { data: p } = await sb.from("fee_proposals").select("id, kind, status, issued_at").eq("id", id).maybeSingle();
  if (!p) return json({ success: false, error: "Proposal not found" }, 404);
  if (p.kind !== "proposal") return json({ success: false, error: "A fee notice needs no acceptance" }, 400);
  if (p.status !== "issued") return json({ success: false, error: `This proposal is ${p.status}` }, 409);
  const issuedOn = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date(p.issued_at));
  if (receivedOn < issuedOn) return json({ success: false, error: `The acceptance is dated before the proposal was issued (${issuedOn})` }, 400);

  const now = new Date().toISOString();
  const { error } = await sb.from("fee_proposals").update({
    status: "accepted",
    accepted_via: "staff_recorded",
    acceptance_email_confirmed: true,
    acceptance_received_on: receivedOn,
    acceptance_inbox: inbox,
    acceptance_note: b.note ? String(b.note) : null,
    accepted_at: now,
    accepted_recorded_by: userId,
    updated_at: now,
  }).eq("id", id).eq("status", "issued");
  if (error) return json({ success: false, error: error.message }, 500);

  await audit("fee_proposal_accepted", id, { received_on: receivedOn, inbox, note: b.note || null, via: "staff_recorded_email" });
  return json({ success: true });
}

async function close(sb: Sb, b: Record<string, unknown>, userId: string | null, audit: Audit, status: "declined" | "withdrawn") {
  const id = String(b.proposal_id || "");
  if (!id) return json({ success: false, error: "proposal_id required" }, 400);
  const { data: p } = await sb.from("fee_proposals").select("id, status, billing_ids").eq("id", id).maybeSingle();
  if (!p) return json({ success: false, error: "Proposal not found" }, 404);
  if (p.status !== "issued" && p.status !== "accepted") return json({ success: false, error: `This fee change is already ${p.status}` }, 409);

  const now = new Date().toISOString();
  const { error } = await sb.from("fee_proposals").update({
    status, closed_at: now, closed_by: userId, close_note: b.note ? String(b.note) : null, updated_at: now,
  }).eq("id", id);
  if (error) return json({ success: false, error: error.message }, 500);

  // Optionally undo the staging, so the client's current fees stand.
  let cleared = 0;
  if (b.clear_pending === true && Array.isArray(p.billing_ids) && p.billing_ids.length) {
    const { data: rows } = await sb.from("live_billing").select("id, services").in("id", p.billing_ids);
    for (const r of (rows || []) as Service[]) {
      let touched = false;
      const services = ((r.services as Service[]) || []).map((s) => {
        if (s.pending_proposal_id !== id) return s;
        touched = true; cleared += 1;
        return {
          ...s,
          pending_monthly_amount: null, pending_effective_at: null, pending_uplift_reason: null,
          pending_uplift_reason_key: null, pending_uplift_staged_at: null, pending_proposal_id: null,
          pending_changes: null, pending_needs_acceptance: null,
        };
      });
      if (!touched) continue;
      const stillPending = services.some((s) => s.pending_monthly_amount != null);
      await sb.from("live_billing").update({
        services,
        ...(stillPending ? {} : { uplift_review_status: null, uplift_reviewed_by: null, uplift_reviewed_at: null }),
      }).eq("id", r.id);
    }
  }

  await audit(`fee_proposal_${status}`, id, { note: b.note || null, cleared_pending_lines: cleared });
  return json({ success: true, cleared });
}

async function saveDrivers(sb: Sb, b: Record<string, unknown>, userId: string | null) {
  const entityId = String(b.entity_id || "");
  const d = (b.drivers && typeof b.drivers === "object") ? b.drivers as Record<string, unknown> : {};
  if (!entityId) return json({ success: false, error: "entity_id required" }, 400);
  // Blank → null; anything else must be a non-negative number.
  const num = (v: unknown, whole = false) => {
    if (v === "" || v == null) return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) throw new Error(`Invalid number: ${v}`);
    return whole ? Math.round(n) : n;
  };
  let row;
  try {
    const type = d.accounts_type == null || d.accounts_type === "" ? null : String(d.accounts_type);
    if (type && !["trading", "dormant", "property"].includes(type)) throw new Error("accounts_type must be trading, dormant or property");
    row = {
      entity_id: entityId,
      turnover: num(d.turnover),
      accounts_type: type,
      properties: num(d.properties, true),
      directors: num(d.directors, true),
      monthly_employees: num(d.monthly_employees, true),
      weekly_employees: num(d.weekly_employees, true),
      updated_at: new Date().toISOString(),
      updated_by: userId,
    };
  } catch (e) {
    return json({ success: false, error: (e as Error).message }, 400);
  }
  const { error } = await sb.from("client_pricing_drivers").upsert(row, { onConflict: "entity_id" });
  if (error) return json({ success: false, error: error.message }, 500);
  return json({ success: true });
}

const CATCHUP_REASON_LABEL: Record<string, string> = {
  approval_late: "client approval not received on time",
  template_late: "invoice template not updated on time",
  other: "other",
};

// Invoices the template has already raised on or after the go-live date:
// step back a month at a time from its next run. Recurring templates here
// are monthly (qbo-pull stores monthly amounts); a missing next run means
// the template can't be read, so nothing is assumed missed.
function missedInvoices(nextRun: string | null, goLiveDate: string): string[] {
  if (!nextRun || !ISO_DATE.test(nextRun)) return [];
  const out: string[] = [];
  const d = new Date(`${nextRun}T00:00:00Z`);
  for (let i = 0; i < 36; i++) {
    d.setUTCMonth(d.getUTCMonth() - 1);
    const iso = d.toISOString().slice(0, 10);
    if (iso < goLiveDate) break;
    out.unshift(iso);
  }
  return out;
}

async function goLive(sb: Sb, b: Record<string, unknown>, userId: string | null, commit: boolean) {
  const billingId = String(b.billing_id || "");
  const date = String(b.go_live_date || "");
  if (!billingId) return json({ success: false, error: "billing_id required" }, 400);
  if (!ISO_DATE.test(date)) return json({ success: false, error: "go_live_date must be YYYY-MM-DD" }, 400);

  const { data: row } = await sb.from("live_billing")
    .select("id, entity_id, services, qbo_next_run_date").eq("id", billingId).maybeSingle();
  if (!row) return json({ success: false, error: "Billing row not found" }, 404);
  const services = ((row.services as Service[]) || []);
  const staged = services.filter((s) => s.pending_monthly_amount != null);
  if (!staged.length) return json({ success: false, error: "Nothing is staged on this row" }, 400);

  // Fee-review lines must have gone to the client, and new services must be
  // accepted, before a date can be approved — so a catch-up covers the whole
  // change and nothing approved is still waiting on the client.
  const pids = [...new Set(staged.map((s) => s.pending_proposal_id).filter(Boolean).map(String))];
  const { data: props } = pids.length ? await sb.from("fee_proposals").select("id, status").in("id", pids) : { data: [] };
  const statusOf = Object.fromEntries(((props || []) as Service[]).map((p) => [String(p.id), String(p.status)]));
  const waiting = staged.filter((s) => {
    const st = s.pending_proposal_id ? statusOf[String(s.pending_proposal_id)] : null;
    if (Array.isArray(s.pending_changes) && !(st === "issued" || st === "accepted")) return true;
    return !!s.pending_needs_acceptance && st !== "accepted";
  });
  if (waiting.length) {
    return json({ success: false, error: "Some changes are still with the client (not sent yet, or new services not accepted). Approve the go-live date once they are." }, 409);
  }

  // What was missed since the go-live date, line by line.
  const nextRun = row.qbo_next_run_date ? String(row.qbo_next_run_date).slice(0, 10) : null;
  const missed = missedInvoices(nextRun, date);
  const { data: adhoc } = await sb.from("qbo_service_items").select("service_id, qbo_item_id").eq("is_adhoc", true);
  const labelFor = (s: Service) => {
    const hit = ((adhoc || []) as Service[]).find((a) => s.qbo_item_id && String(a.qbo_item_id) === String(s.qbo_item_id));
    const name = String(s.service_id || "");
    return hit ? String(hit.service_id) : (name.includes(":") ? name.slice(name.lastIndexOf(":") + 1) : name);
  };
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const fmtMonth = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
  const period = missed.length ? (missed.length === 1 ? fmtMonth(missed[0]) : `${fmtMonth(missed[0])} to ${fmtMonth(missed[missed.length - 1])}`) : "";
  const lines = missed.length ? staged.map((s) => {
    const delta = r2((Number(s.pending_monthly_amount) || 0) - (Number(s.monthly_amount) || 0));
    return { service: labelFor(s), delta, net: r2(delta * missed.length) };
  }).filter((l) => l.net !== 0) : [];
  const net = r2(lines.reduce((t, l) => t + l.net, 0));
  const vat = r2(net * 0.2);
  const catchup = { next_run: nextRun, missed_invoices: missed, period, lines, net, vat, gross: r2(net + vat) };

  if (!commit) return json({ success: true, catchup });

  // Approve: the date goes on every staged line, and the row is approved.
  const now = new Date().toISOString();
  const nextServices = services.map((s) => (s.pending_monthly_amount != null ? { ...s, pending_effective_at: date } : s));
  const upd: Record<string, unknown> = {
    services: nextServices,
    uplift_review_status: "approved", uplift_reviewed_by: userId, uplift_reviewed_at: now,
    uplift_go_live_date: date, uplift_go_live_approved_at: now, uplift_go_live_approved_by: userId,
  };

  let billingItemId: string | null = null;
  const c = (b.catchup && typeof b.catchup === "object") ? b.catchup as Record<string, unknown> : null;
  if (c) {
    const reason = String(c.reason || "");
    const note = c.note ? String(c.note).trim() : "";
    if (!CATCHUP_REASON_LABEL[reason]) return json({ success: false, error: "Pick why the catch-up is needed" }, 400);
    if (reason === "other" && note.length < 3) return json({ success: false, error: "Explain the reason when you pick Other" }, 400);
    if (!(net > 0)) return json({ success: false, error: "Nothing was under-billed, so there is no catch-up to raise" }, 400);
    const { data: ent } = await sb.from("entities").select("qbo_customer_id").eq("id", row.entity_id).maybeSingle();
    const why = reason === "other" ? note : CATCHUP_REASON_LABEL[reason];
    const itemLines = lines.filter((l) => l.net > 0).map((l) => {
      const lv = r2(l.net * 0.2);
      return {
        service: l.service,
        description: `${l.service}: new fee from ${period} (${missed.length} month${missed.length === 1 ? "" : "s"} at +£${l.delta.toFixed(2)}), not yet billed — ${why}`,
        net: l.net, vat: lv, gross: r2(l.net + lv), qty: 1, rate: l.net,
      };
    });
    const inet = r2(itemLines.reduce((t, l) => t + l.net, 0));
    const ivat = r2(itemLines.reduce((t, l) => t + l.vat, 0));
    const { data: bi, error: biErr } = await sb.from("billing_items").insert({
      entity_id: row.entity_id,
      service: itemLines.length > 1 ? `${itemLines[0].service} +${itemLines.length - 1} more` : itemLines[0].service,
      description: `Catch-up: new fees from ${period}`,
      net_amount: inet, vat_amount: ivat, gross_amount: r2(inet + ivat),
      status: "draft", created_by: userId, lines: itemLines,
      qbo_customer_id: ent?.qbo_customer_id || null,
      catchup_reason: reason, catchup_note: note || null, catchup_for_billing_id: row.id,
    }).select("id").single();
    if (biErr) return json({ success: false, error: `Catch-up invoice: ${biErr.message}` }, 500);
    billingItemId = bi.id as string;
    upd.uplift_catchup_billing_item_id = billingItemId;
  }

  const { error } = await sb.from("live_billing").update(upd).eq("id", row.id);
  if (error) return json({ success: false, error: error.message }, 500);
  await sb.from("audit_log").insert({
    user_id: userId, action: "uplift_go_live_approved", entity_type: "live_billing", entity_id: row.id,
    detail: { go_live_date: date, next_run: nextRun, missed_invoices: missed.length, catchup_billing_item_id: billingItemId, catchup_net: billingItemId ? net : 0 },
  });
  return json({ success: true, catchup, billing_item_id: billingItemId });
}
