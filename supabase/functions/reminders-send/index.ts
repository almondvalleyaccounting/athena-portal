// reminders-send — Athena Portal
// Sends client-communication emails as REAL Gmail messages through the
// connected info@ mailbox (Client Reminders module). Two kinds:
//   * promo    — "can we send you tax reminders?" opt-in invitation with
//                yes/no buttons that hit the public comm-optin function
//   * reminder — "your payment on account of £X is due 31 July" for
//                clients who opted in
//
// Deployed with verify_jwt OFF, so it verifies the caller itself:
// a staff JWT whose staff_profiles row has can_manage_portal (or
// is_portal_admin) — same pattern as chase-reply-scan / ch-refresh-report.
//
// Body: {
//   kind          : 'promo' | 'reminder'          required
//   comm_type     : 'tax_reminders'               default 'tax_reminders'
//   targets       : [{ entity_id, payment_id? }]  required (payment_id
//                    required per-target when kind = 'reminder')
//   due_date      : 'YYYY-MM-DD'                  optional fallback
//   test_recipient: string (email)                optional — overrides
//                    every To: address; use with ONE target. Test sends
//                    skip the pending-preference upsert and the
//                    last_reminded_at stamp.
// }
//
// For each target the reminder_emails row is inserted FIRST so its
// token exists before the email that carries it goes out. On a Gmail
// send failure the row is deleted again (no orphan tokens).
//
// Returns { success, sent, skipped: [{entity_id, reason}], errors }.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getValidGmailToken, base64UrlEncode, corsHeaders } from "../_shared/gmail-client.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...corsHeaders } });
}

type Target = { entity_id: string; payment_id?: string };

// ── Email content ─────────────────────────────────────────────────────
// Deliberately plain/typed-looking (Arial 14px, dark text, no images or
// branding) — mirrors the tone of the CH-code chase emails so it reads
// like a personal note, signed off generically.

function esc(s: unknown): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// First name for people, full name for companies — personal-tax clients
// are usually individuals, but don't say "Hi Smith" to "Smith Ltd".
function greetingName(name: string | null | undefined): string {
  const n = String(name ?? "").trim();
  if (!n) return "there";
  if (/\b(ltd|limited|llp|plc|lp|partnership|associates|company|co\.)\b/i.test(n)) return n;
  return n.split(/\s+/)[0];
}

// Minimal shell — no card/border/logo. Looks like a normal typed email.
function wrapShell(innerHtml: string): string {
  return `<!doctype html><html><body style="margin:0;padding:0;background:#ffffff;">
    <div style="max-width:640px;margin:0;padding:14px 6px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#222222;">
      ${innerHtml}
    </div>
  </body></html>`;
}

const P = `style="margin:0 0 14px;"`;
const SIGN_OFF_HTML = `<p style="margin:18px 0 0;">Thanks,<br/>Almond Valley Accounting</p>`;
const SIGN_OFF_TEXT = "Thanks,\nAlmond Valley Accounting";

function fmtMoney(amount: number): string {
  return Number(amount).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// '2026-07-31' → '31 July 2026'
function fmtDateLong(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(`${String(iso).slice(0, 10)}T00:00:00Z`);
  if (isNaN(d.getTime())) return String(iso);
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}

function promoEmail(name: string, optInUrl: string, optOutUrl: string): { subject: string; html: string; text: string } {
  const subject = "Tax payment reminders — yes or no?";
  const hi = esc(greetingName(name));
  const html = wrapShell(`
    <p ${P}>Hi ${hi},</p>
    <p ${P}>We're setting up payment reminders for personal tax &mdash; a short email before each deadline (31 July payments on account, 31 January balancing payments) so nothing gets missed.</p>
    <p ${P}>Because those reminders include your personal tax figures, we'd like your OK first &mdash; we understand not everyone wants tax amounts arriving by email.</p>
    <div style="margin:18px 0;">
      <a href="${esc(optInUrl)}" style="display:inline-block;padding:10px 20px;background:#0e7fe0;color:#ffffff;text-decoration:none;border-radius:6px;font-family:Arial,Helvetica,sans-serif;font-size:14px;">Yes &mdash; send me reminders</a>
      <a href="${esc(optOutUrl)}" style="display:inline-block;padding:10px 20px;background:#ffffff;color:#444444;border:1px solid #cccccc;text-decoration:none;border-radius:6px;font-family:Arial,Helvetica,sans-serif;font-size:14px;margin-left:10px;">No thanks</a>
    </div>
    <p ${P}>If the buttons don't work, just reply to this email with yes or no and we'll set it for you.</p>
    ${SIGN_OFF_HTML}
  `);
  const text = [
    `Hi ${greetingName(name)},`,
    "",
    "We're setting up payment reminders for personal tax — a short email before each deadline (31 July payments on account, 31 January balancing payments) so nothing gets missed.",
    "",
    "Because those reminders include your personal tax figures, we'd like your OK first — we understand not everyone wants tax amounts arriving by email.",
    "",
    `Yes — send me reminders: ${optInUrl}`,
    `No thanks: ${optOutUrl}`,
    "",
    "If the links don't work, just reply to this email with yes or no and we'll set it for you.",
    "",
    SIGN_OFF_TEXT,
  ].join("\n");
  return { subject, html, text };
}

function reminderEmail(name: string, amount: number, dueDateIso: string): { subject: string; html: string; text: string } {
  const due = fmtDateLong(dueDateIso);
  const subject = `Reminder: personal tax payment due ${due.replace(/\s\d{4}$/, "")}`;
  const hi = esc(greetingName(name));
  const html = wrapShell(`
    <p ${P}>Hi ${hi},</p>
    <p ${P}>A quick reminder that your personal tax payment on account of <strong>&pound;${fmtMoney(amount)}</strong> is due by ${esc(due)}.</p>
    <p ${P}>You can pay HMRC at <a href="https://www.gov.uk/pay-self-assessment-tax-bill" style="color:#0e7fe0;">https://www.gov.uk/pay-self-assessment-tax-bill</a> &mdash; use your UTR as the payment reference.</p>
    <p ${P}>If you've already paid, you can ignore this. If anything looks wrong or you'd like to talk it through, just reply.</p>
    ${SIGN_OFF_HTML}
  `);
  const text = [
    `Hi ${greetingName(name)},`,
    "",
    `A quick reminder that your personal tax payment on account of £${fmtMoney(amount)} is due by ${due}.`,
    "",
    "You can pay HMRC at https://www.gov.uk/pay-self-assessment-tax-bill — use your UTR as the payment reference.",
    "",
    "If you've already paid, you can ignore this. If anything looks wrong or you'd like to talk it through, just reply.",
    "",
    SIGN_OFF_TEXT,
  ].join("\n");
  return { subject, html, text };
}

// ── MIME (mirrors gmail-create-draft) ────────────────────────────────

function encodeSubject(s: string): string {
  if (/^[\x20-\x7e]*$/.test(s)) return s;
  const b64 = base64UrlEncode(s).replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - b64.length % 4) % 4);
  return `=?UTF-8?B?${padded}?=`;
}

function buildMime(to: string, subject: string, text: string, html: string, fromEmail: string): string {
  const boundary = `=_athena_${crypto.randomUUID()}`;
  const headers = [
    `From: ${fromEmail}`,
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

  // ── Body ──
  let body: {
    kind?: string; comm_type?: string; targets?: Target[];
    due_date?: string; test_recipient?: string;
  };
  try { body = await req.json(); } catch { return json({ success: false, error: "Invalid JSON" }, 400); }

  const kind = body.kind;
  if (kind !== "promo" && kind !== "reminder") return json({ success: false, error: "kind must be 'promo' or 'reminder'" }, 400);
  const commType = body.comm_type || "tax_reminders";
  const targets = Array.isArray(body.targets) ? body.targets : [];
  if (!targets.length) return json({ success: false, error: "targets required" }, 400);
  if (targets.length > 200) return json({ success: false, error: "Max 200 targets per call" }, 400);
  const testRecipient = (body.test_recipient || "").trim() || null;
  const isTest = !!testRecipient;

  // ── Gmail connection ──
  let token: { accessToken: string; accountEmail: string };
  try {
    token = await getValidGmailToken();
  } catch (e) {
    return json({ success: false, error: `No usable Gmail connection: ${(e as Error).message}`, code: "no_gmail_connection" }, 400);
  }

  let sent = 0;
  const skipped: { entity_id: string; reason: string }[] = [];
  const errors: { entity_id: string; error: string }[] = [];
  let first = true;

  for (const target of targets) {
    if (!target?.entity_id) { skipped.push({ entity_id: target?.entity_id || "?", reason: "missing entity_id" }); continue; }
    const entityId = target.entity_id;

    // Entity + email.
    const { data: ent } = await service.from("entities")
      .select("id, name, billing_email, prospect_email")
      .eq("id", entityId).maybeSingle();
    if (!ent) { skipped.push({ entity_id: entityId, reason: "entity not found" }); continue; }
    const to = testRecipient || (ent.billing_email || "").trim() || (ent.prospect_email || "").trim();
    if (!to || !to.includes("@")) { skipped.push({ entity_id: entityId, reason: "no email address on file" }); continue; }

    // Payment details for reminders.
    let payment: { id: string; batch_id: string; amount: number } | null = null;
    let dueDate = body.due_date || null;
    if (kind === "reminder") {
      if (!target.payment_id) { skipped.push({ entity_id: entityId, reason: "payment_id required for reminders" }); continue; }
      const { data: pay } = await service.from("tax_payments_due")
        .select("id, batch_id, amount, status, batch:tax_payment_batches(id, due_date)")
        .eq("id", target.payment_id).maybeSingle();
      if (!pay) { skipped.push({ entity_id: entityId, reason: "payment row not found" }); continue; }
      if (pay.amount == null) { skipped.push({ entity_id: entityId, reason: "payment has no amount" }); continue; }
      payment = { id: pay.id, batch_id: pay.batch_id, amount: Number(pay.amount) };
      dueDate = (pay.batch as { due_date?: string } | null)?.due_date || dueDate;
      if (!dueDate) { skipped.push({ entity_id: entityId, reason: "no due date on batch" }); continue; }
    }

    const subject = kind === "promo"
      ? "Tax payment reminders — yes or no?"
      : reminderEmail(ent.name, payment!.amount, dueDate!).subject;

    // Insert the reminder_emails row FIRST — its token goes into the email.
    const { data: emailRow, error: insErr } = await service.from("reminder_emails")
      .insert({
        kind,
        comm_type: commType,
        entity_id: entityId,
        batch_id: payment?.batch_id || null,
        payment_id: payment?.id || null,
        to_email: to,
        subject,
        sent_by: user.id,
      })
      .select("id, token")
      .single();
    if (insErr || !emailRow?.token) {
      errors.push({ entity_id: entityId, error: `Could not create tracking row: ${insErr?.message || "no token"}` });
      continue;
    }

    // Compose.
    let content: { subject: string; html: string; text: string };
    if (kind === "promo") {
      const base = `${SUPABASE_URL}/functions/v1/comm-optin?token=${encodeURIComponent(emailRow.token)}`;
      content = promoEmail(ent.name, `${base}&choice=in`, `${base}&choice=out`);
    } else {
      content = reminderEmail(ent.name, payment!.amount, dueDate!);
    }

    // Space the sends out a little (skip the delay before the first one).
    if (!first) await sleep(300);
    first = false;

    // Send via Gmail as a real message from the connected account.
    const mime = buildMime(to, content.subject, content.text, content.html, token.accountEmail);
    let gmailResp: Response;
    try {
      gmailResp = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
        method: "POST",
        headers: { "Authorization": `Bearer ${token.accessToken}`, "Content-Type": "application/json" },
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

    const now = new Date().toISOString();
    await service.from("reminder_emails").update({
      gmail_message_id: sentMsg.id || null,
      gmail_thread_id: sentMsg.threadId || null,
      sent_at: now,
    }).eq("id", emailRow.id);

    if (!isTest) {
      if (kind === "reminder" && payment) {
        await service.from("tax_payments_due").update({ last_reminded_at: now }).eq("id", payment.id);
      }
      if (kind === "promo") {
        // Mark the client as "asked" — but never clobber an existing
        // decision (ignoreDuplicates inserts only when no row exists).
        await service.from("client_comm_preferences").upsert(
          { entity_id: entityId, comm_type: commType, status: "pending", updated_at: now },
          { onConflict: "entity_id,comm_type", ignoreDuplicates: true },
        );
      }
    }

    await service.from("audit_log").insert({
      user_id: user.id,
      action: kind === "promo" ? "reminder_promo_sent" : "reminder_sent",
      entity_type: "entity",
      entity_id: entityId,
      detail: {
        comm_type: commType, to, subject: content.subject, test: isTest,
        reminder_email_id: emailRow.id, payment_id: payment?.id || null,
        gmail_message_id: sentMsg.id || null,
      },
    });

    sent++;
  }

  return json({ success: true, sent, skipped, errors });
});
