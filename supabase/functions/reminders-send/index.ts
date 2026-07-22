// reminders-send — Athena Portal
// Client Reminders sender with a human review queue. Emails go out as
// REAL Gmail messages from the connected mailbox. Two kinds:
//   * promo    — opt-in invitation with yes/no buttons (no tax figures)
//   * reminder — payment figure + HMRC bank details + payment reference
//                (UTR + K) for clients who opted in
//
// Copy is NOT hardcoded: both kinds render from the comm_templates row
// for (comm_type, kind) via {{token}} substitution — edit it in
// Communications → Client Reminders → "Email templates".
//
// Modes (body.mode):
//   * 'queue'   — validate + render each target and STORE it on a
//                 reminder_emails row (status 'queued', body frozen),
//                 without sending. Returns { queued, skipped }.
//   * 'release' — send the stored body of the given queued row ids and
//                 mark them 'sent'. Returns { sent, skipped, errors }.
//   * 'send'    — (default) render + send immediately; used for the
//                 "send test to me" preview. Returns { sent, ... }.
//
// A reminder is skipped when the payment row has no readable UTR (we
// never send bank details without a reference). Former clients
// (nlac/archived) are hard-stopped at queue AND release.
//
// Deployed with verify_jwt OFF; verifies the caller itself: a staff JWT
// whose staff_profiles row has can_manage_portal (or is_portal_admin).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getValidGmailToken, base64UrlEncode, corsHeaders, formatSender } from "../_shared/gmail-client.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...corsHeaders } });
}

type Target = { entity_id: string; payment_id?: string };

// ── Content helpers ───────────────────────────────────────────────────
function esc(s: unknown): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function greetingName(name: string | null | undefined): string {
  const n = String(name ?? "").trim();
  if (!n) return "there";
  if (/\b(ltd|limited|llp|plc|lp|partnership|associates|company|co\.)\b/i.test(n)) return n;
  // Names are often stored "Surname, Forename" — take the forename part.
  let base = n;
  if (n.includes(",")) {
    const after = n.split(",")[1];
    if (after && after.trim()) base = after.trim();
  }
  return base.split(/\s+/)[0];
}

function wrapShell(innerHtml: string): string {
  return `<!doctype html><html><body style="margin:0;padding:0;background:#ffffff;">
    <div style="max-width:640px;margin:0;padding:14px 6px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#222222;">
      ${innerHtml}
    </div>
  </body></html>`;
}

function fmtMoney(amount: number): string {
  return Number(amount).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtDateLong(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(`${String(iso).slice(0, 10)}T00:00:00Z`);
  if (isNaN(d.getTime())) return String(iso);
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}

const PAY_URL = "https://www.gov.uk/pay-self-assessment-tax-bill";       // how to pay
const PTA_URL = "https://www.gov.uk/personal-tax-account";               // view balance/payments

// UTR → Self Assessment payment reference: 10-digit UTR + 'K'. Idempotent
// if a 'K' is already present; '' when no 10-digit UTR can be read.
function taxPaymentRef(raw: string | null | undefined): string {
  const digits = String(raw ?? "").replace(/\D/g, "");
  if (digits.length >= 10) return `${digits.slice(0, 10)}K`;
  return "";
}

function renderStr(s: string, vars: Record<string, string>): string {
  return String(s ?? "").replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, k) => (k in vars ? String(vars[k] ?? "") : ""));
}

// A url-safe token, matching the reminder_emails default format (hex).
function genToken(): string {
  const b = crypto.getRandomValues(new Uint8Array(18));
  return Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
}

// Render subject/html/text for one recipient from the template + values.
function renderEmail(
  tmpl: { subject: string; body_html: string; body_text: string },
  vars: Record<string, string>,
): { subject: string; html: string; text: string } {
  const htmlVars: Record<string, string> = {};
  for (const [k, v] of Object.entries(vars)) htmlVars[k] = esc(v);
  return {
    subject: renderStr(tmpl.subject, vars),
    html: wrapShell(renderStr(tmpl.body_html, htmlVars)),
    text: renderStr(tmpl.body_text, vars),
  };
}

// ── MIME ──────────────────────────────────────────────────────────────
function encodeSubject(s: string): string {
  if (/^[\x20-\x7e]*$/.test(s)) return s;
  const b64 = base64UrlEncode(s).replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - b64.length % 4) % 4);
  return `=?UTF-8?B?${padded}?=`;
}

// The Gmail API sends From verbatim and does NOT apply the mailbox's
// "Send mail as" name, so we stamp the mailbox's display name here (from
// gmail_connections.display_name). fromName omitted → bare address.
function buildMime(to: string, subject: string, text: string, html: string, fromEmail: string, fromName?: string | null): string {
  const boundary = `=_athena_${crypto.randomUUID()}`;
  const headers = [
    `From: ${formatSender(fromName, fromEmail)}`,
    `To: ${to}`,
    `Subject: ${encodeSubject(subject)}`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ].join("\r\n");
  const body = [
    "",
    `--${boundary}`,
    `Content-Type: text/plain; charset="UTF-8"`,
    `Content-Transfer-Encoding: 7bit`,
    "",
    text,
    `--${boundary}`,
    `Content-Type: text/html; charset="UTF-8"`,
    `Content-Transfer-Encoding: 7bit`,
    "",
    html,
    `--${boundary}--`,
    "",
  ].join("\r\n");
  return `${headers}\r\n${body}`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Handler ──────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ success: false, error: "POST required" }, 405);

  const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // ── Auth: staff JWT with can_manage_portal (verify_jwt is OFF) ──
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ success: false, error: "Missing authorization" }, 401);
  const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { headers: { Authorization: authHeader } } });
  const { data: { user }, error: authErr } = await anon.auth.getUser();
  if (authErr || !user) return json({ success: false, error: "Invalid token" }, 401);
  const { data: prof } = await service.from("staff_profiles").select("is_portal_admin, can_manage_portal").eq("id", user.id).single();
  if (!prof || !(prof.is_portal_admin || prof.can_manage_portal)) return json({ success: false, error: "Not authorised" }, 403);

  let body: {
    mode?: string; kind?: string; comm_type?: string; targets?: Target[];
    ids?: string[]; due_date?: string; test_recipient?: string; mailbox?: string;
  };
  try { body = await req.json(); } catch { return json({ success: false, error: "Invalid JSON" }, 400); }

  // Which connected mailbox to send from (account email). Omitted → the
  // practice-default (info@). getValidGmailToken resolves + validates it.
  const mailbox = (body.mailbox || "").trim() || undefined;

  const mode = body.mode === "queue" || body.mode === "release" ? body.mode : "send";
  const commType = body.comm_type || "tax_reminders";

  // ── RELEASE: send the stored body of queued rows ──────────────────────
  if (mode === "release") {
    const ids = Array.isArray(body.ids) ? body.ids.slice(0, 200) : [];
    if (!ids.length) return json({ success: false, error: "ids required" }, 400);

    let token: { accessToken: string; accountEmail: string; displayName: string | null };
    try { token = await getValidGmailToken(mailbox); }
    catch (e) { return json({ success: false, error: `No usable Gmail connection: ${(e as Error).message}`, code: "no_gmail_connection" }, 400); }

    const { data: rows } = await service.from("reminder_emails")
      .select("id, kind, comm_type, entity_id, payment_id, to_email, subject, body_html, body_text")
      .in("id", ids).eq("status", "queued");

    let sent = 0;
    const skipped: { entity_id: string; reason: string }[] = [];
    const errors: { entity_id: string; error: string }[] = [];
    let first = true;

    for (const r of rows || []) {
      // Re-check the client hasn't left between queue and release.
      const { data: ent } = await service.from("entities").select("entity_status").eq("id", r.entity_id).maybeSingle();
      if (ent && ["nlac", "archived"].includes(ent.entity_status as string)) {
        await service.from("reminder_emails").update({ status: "dropped" }).eq("id", r.id);
        skipped.push({ entity_id: r.entity_id, reason: "no longer a client" });
        continue;
      }

      if (!first) await sleep(300);
      first = false;

      const mime = buildMime(r.to_email, r.subject, r.body_text || "", r.body_html || "", token.accountEmail, token.displayName);
      let resp: Response;
      try {
        resp = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
          method: "POST",
          headers: { "Authorization": `Bearer ${token.accessToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({ raw: base64UrlEncode(mime) }),
        });
      } catch (e) { errors.push({ entity_id: r.entity_id, error: `Gmail request failed: ${(e as Error).message}` }); continue; }
      if (!resp.ok) { const t = await resp.text(); errors.push({ entity_id: r.entity_id, error: `Gmail API ${resp.status}: ${t.slice(0, 300)}` }); continue; }
      const sentMsg = await resp.json();

      const now = new Date().toISOString();
      await service.from("reminder_emails").update({
        status: "sent", sent_at: now, sent_by: user.id,
        gmail_message_id: sentMsg.id || null, gmail_thread_id: sentMsg.threadId || null,
      }).eq("id", r.id);

      if ((r.kind === "reminder" || r.kind === "no_utr") && r.payment_id) {
        await service.from("tax_payments_due").update({ last_reminded_at: now }).eq("id", r.payment_id);
      }
      if (r.kind === "promo") {
        await service.from("client_comm_preferences").upsert(
          { entity_id: r.entity_id, comm_type: r.comm_type, status: "pending", updated_at: now },
          { onConflict: "entity_id,comm_type", ignoreDuplicates: true },
        );
      }
      await service.from("audit_log").insert({
        user_id: user.id,
        action: r.kind === "promo" ? "reminder_promo_sent" : "reminder_sent",
        entity_type: "entity", entity_id: r.entity_id,
        detail: { comm_type: r.comm_type, to: r.to_email, subject: r.subject, released: true, reminder_email_id: r.id, payment_id: r.payment_id || null, gmail_message_id: sentMsg.id || null },
      });
      sent++;
    }
    return json({ success: true, sent, skipped, errors });
  }

  // ── QUEUE / SEND: render each target from the template ────────────────
  const kind = body.kind;
  if (kind !== "promo" && kind !== "reminder") return json({ success: false, error: "kind must be 'promo' or 'reminder'" }, 400);
  const targets = Array.isArray(body.targets) ? body.targets : [];
  if (!targets.length) return json({ success: false, error: "targets required" }, 400);
  if (targets.length > 200) return json({ success: false, error: "Max 200 targets per call" }, 400);
  const testRecipient = mode === "send" ? ((body.test_recipient || "").trim() || null) : null;
  const isTest = !!testRecipient;

  const { data: tmpl, error: tErr } = await service.from("comm_templates")
    .select("subject, body_html, body_text")
    .eq("comm_type", commType).eq("kind", kind).maybeSingle();
  if (tErr) return json({ success: false, error: `Template lookup failed: ${tErr.message}` }, 500);
  if (!tmpl) return json({ success: false, error: `No ${kind} template configured for '${commType}'` }, 400);

  // No-UTR variant of the reminder: for a client who will owe a payment
  // but has no UTR (not registered with HMRC yet). Routed to per-target.
  let tmplNoUtr: { subject: string; body_html: string; body_text: string } | null = null;
  if (kind === "reminder") {
    const { data: nu } = await service.from("comm_templates")
      .select("subject, body_html, body_text").eq("comm_type", commType).eq("kind", "no_utr").maybeSingle();
    tmplNoUtr = nu || null;
  }

  // Gmail is only needed when we actually send now (mode 'send').
  let token: { accessToken: string; accountEmail: string; displayName: string | null } | null = null;
  if (mode === "send") {
    try { token = await getValidGmailToken(mailbox); }
    catch (e) { return json({ success: false, error: `No usable Gmail connection: ${(e as Error).message}`, code: "no_gmail_connection" }, 400); }
  }

  let sent = 0;
  let queued = 0;
  const skipped: { entity_id: string; reason: string }[] = [];
  const errors: { entity_id: string; error: string }[] = [];
  let first = true;

  for (const target of targets) {
    if (!target?.entity_id) { skipped.push({ entity_id: target?.entity_id || "?", reason: "missing entity_id" }); continue; }
    const entityId = target.entity_id;

    const { data: ent } = await service.from("entities")
      .select("id, name, utr, billing_email, prospect_email, entity_status")
      .eq("id", entityId).maybeSingle();
    if (!ent) { skipped.push({ entity_id: entityId, reason: "entity not found" }); continue; }
    if (["nlac", "archived"].includes(ent.entity_status as string)) {
      skipped.push({ entity_id: entityId, reason: "no longer a client" }); continue;
    }

    // Recipient: entity billing/prospect first, then BM contact email.
    let to = testRecipient || (ent.billing_email || "").trim() || (ent.prospect_email || "").trim();
    if (!to) {
      const { data: rec } = await service.from("v_email_reconciliation")
        .select("bm_contact_email").eq("entity_id", entityId).limit(1);
      to = (rec?.[0]?.bm_contact_email || "").trim();
    }
    if (!to || !to.includes("@")) { skipped.push({ entity_id: entityId, reason: "no email address on file" }); continue; }

    let payment: { id: string; batch_id: string; amount: number } | null = null;
    let dueDate = body.due_date || null;
    let paymentRef = "";
    let effKind: string = kind;
    let effTmpl = tmpl;
    if (kind === "reminder") {
      if (!target.payment_id) { skipped.push({ entity_id: entityId, reason: "payment_id required for reminders" }); continue; }
      const { data: pay } = await service.from("tax_payments_due")
        .select("id, batch_id, amount, status, reference_raw, batch:tax_payment_batches(id, due_date)")
        .eq("id", target.payment_id).maybeSingle();
      if (!pay) { skipped.push({ entity_id: entityId, reason: "payment row not found" }); continue; }
      if (pay.amount == null) { skipped.push({ entity_id: entityId, reason: "payment has no amount" }); continue; }
      payment = { id: pay.id, batch_id: pay.batch_id, amount: Number(pay.amount) };
      dueDate = (pay.batch as { due_date?: string } | null)?.due_date || dueDate;
      if (!dueDate) { skipped.push({ entity_id: entityId, reason: "no due date on batch" }); continue; }
      // Reference from the TaxCalc row, falling back to the client's UTR on
      // the entity (e.g. added to BM after the file was uploaded).
      paymentRef = taxPaymentRef(pay.reference_raw as string | null) || taxPaymentRef(ent.utr as string | null);
      if (!paymentRef) {
        // No UTR anywhere → not registered with HMRC yet. Send the 'no_utr'
        // variant (no bank details, no reference) rather than skipping.
        if (!tmplNoUtr) { skipped.push({ entity_id: entityId, reason: "no UTR and no 'no_utr' template" }); continue; }
        effKind = "no_utr"; effTmpl = tmplNoUtr;
      }
    }

    // Mint the token up front so the opt-in URLs can be baked into the
    // stored body (queue) or the sent body (send) alike.
    const tok = genToken();
    const optBase = `${SUPABASE_URL}/functions/v1/comm-optin?token=${encodeURIComponent(tok)}`;
    const vars: Record<string, string> = {
      first_name: greetingName(ent.name),
      amount: payment ? fmtMoney(payment.amount) : "",
      due_date: dueDate ? fmtDateLong(dueDate) : "",
      payment_ref: paymentRef,
      pay_url: PAY_URL,
      pta_url: PTA_URL,
      opt_in_url: kind === "promo" ? `${optBase}&choice=in` : "",
      opt_out_url: kind === "promo" ? `${optBase}&choice=out` : "",
    };
    const content = renderEmail(effTmpl, vars);
    const now = new Date().toISOString();

    // ── QUEUE: store the rendered email, don't send ──
    if (mode === "queue") {
      const { error: qErr } = await service.from("reminder_emails").insert({
        kind: effKind, comm_type: commType, entity_id: entityId,
        batch_id: payment?.batch_id || null, payment_id: payment?.id || null,
        to_email: to, subject: content.subject, token: tok,
        body_html: content.html, body_text: content.text,
        status: "queued", queued_at: now, queued_by: user.id,
      });
      if (qErr) { errors.push({ entity_id: entityId, error: `Could not queue: ${qErr.message}` }); continue; }
      queued++;
      continue;
    }

    // ── SEND (test): persist then send immediately ──
    const { data: emailRow, error: insErr } = await service.from("reminder_emails")
      .insert({
        kind: effKind, comm_type: commType, entity_id: entityId,
        batch_id: payment?.batch_id || null, payment_id: payment?.id || null,
        to_email: to, subject: content.subject, token: tok,
        body_html: content.html, body_text: content.text, status: "sent",
      })
      .select("id")
      .single();
    if (insErr || !emailRow?.id) {
      errors.push({ entity_id: entityId, error: `Could not create tracking row: ${insErr?.message || "no id"}` });
      continue;
    }

    if (!first) await sleep(300);
    first = false;

    const mime = buildMime(to, content.subject, content.text, content.html, token!.accountEmail, token!.displayName);
    let gmailResp: Response;
    try {
      gmailResp = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
        method: "POST",
        headers: { "Authorization": `Bearer ${token!.accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ raw: base64UrlEncode(mime) }),
      });
    } catch (e) {
      await service.from("reminder_emails").delete().eq("id", emailRow.id);
      errors.push({ entity_id: entityId, error: `Gmail request failed: ${(e as Error).message}` });
      continue;
    }
    if (!gmailResp.ok) {
      const txt = await gmailResp.text();
      await service.from("reminder_emails").delete().eq("id", emailRow.id);
      errors.push({ entity_id: entityId, error: `Gmail API ${gmailResp.status}: ${txt.slice(0, 300)}` });
      continue;
    }
    const sentMsg = await gmailResp.json();
    await service.from("reminder_emails").update({
      gmail_message_id: sentMsg.id || null, gmail_thread_id: sentMsg.threadId || null,
      sent_at: now, sent_by: user.id,
    }).eq("id", emailRow.id);

    // Test sends never touch the client's preference or reminder history.
    await service.from("audit_log").insert({
      user_id: user.id,
      action: kind === "promo" ? "reminder_promo_sent" : "reminder_sent",
      entity_type: "entity", entity_id: entityId,
      detail: { comm_type: commType, to, subject: content.subject, test: isTest, reminder_email_id: emailRow.id, payment_id: payment?.id || null, gmail_message_id: sentMsg.id || null },
    });
    sent++;
  }

  return json({ success: true, sent, queued, skipped, errors });
});
