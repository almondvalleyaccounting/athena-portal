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
