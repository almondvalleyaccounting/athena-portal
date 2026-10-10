// debt-chase — Athena Portal
//
// Debt chasing inside the fee engine (/manage/billing/debt). Replaces the
// stand-alone DCM app: same two tones, same four stages plus an escalation,
// same rule for moving a client up a stage. What changes is where the pieces
// live — the overdue invoices are read live from the firm's QuickBooks, the
// tracker is the debt_chases table (sql/371), the templates are comm_templates
// rows (comm_type debt_chase), and the email goes out of a connected Gmail
// mailbox with the sender's own signature.
//
//   { action: "queue" }
//       Every client with an overdue invoice, the stage the rules suggest and
//       why. Read-only.
//
//   { action: "preview", entity_id, stage?, mailbox? }
//       The rendered email for one client: subject, HTML body with the
//       sender's signature, recipient. stage overrides the suggestion.
//
//   { action: "send", entity_id, stage, mailbox, to, subject, body_html,
//     acknowledged? }
//       Sends it and logs a debt_chases row. Invoices are re-read from QBO at
//       send time, so the log records what was actually owed.
//
//   { action: "mark", chase_id, status: "contact"|"responded"|"sent", note? }
//       The client got in touch. The next chase starts again at stage 1.
//
//   { action: "pause", entity_id, until, reason } / { action: "unpause", entity_id }
//       Payment plan agreed or invoice disputed: left out of the queue.
//
//   { action: "set_grade", entity_id, grade }   (grade null clears the override)
//       Athena's grade for the client. Wins over BrightManager's (sql/371).
//
// Stage rules (DCM's escalation.js, unchanged):
//   no chase yet                                   → 1
//   last chase marked contact / responded           → 1
//   an invoice on the last chase has since cleared  → 1
//   last chase under 7 days ago                     → same stage, not due yet
//   otherwise                                       → last stage + 1, max 5
// Tone: grade A+, A, B, C → A (gentle); D, E, F or none → B (factual).
// Stage 5 is the escalation from the Manager, whatever the tone.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { qboQuery } from "../_shared/qbo-client.ts";
import { getValidGmailToken, jsonResponse, corsHeaders, getServiceClient } from "../_shared/gmail-client.ts";
import { sendEmail, checkSend } from "../_shared/gmail-send.ts";
import { primaryContact, firstWord } from "../_shared/job-comms.ts";
import { escapeHtml, formatGBP } from "../_shared/email-format.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const CHASE_GAP_DAYS = 7;
const PAY_BY_DAYS = 7;
const GENTLE = new Set(["A+", "A", "B", "C"]);
const GRADES = ["A+", "A", "B", "C", "D", "E", "F"];

// deno-lint-ignore no-explicit-any
type Db = any;

interface Invoice { number: string; txnDate: string; dueDate: string; total: number; balance: number; customerId: string; customerName: string }

const todayIso = () => new Date().toISOString().slice(0, 10);
const addDays = (iso: string, n: number) => {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const daysBetween = (a: string, b: string) =>
  Math.floor((new Date(b.slice(0, 10) + "T00:00:00Z").getTime() - new Date(a.slice(0, 10) + "T00:00:00Z").getTime()) / 86400000);
const longDate = (iso: string) =>
  new Date(iso.slice(0, 10) + "T00:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
const shortDate = (iso: string) =>
  new Date(iso.slice(0, 10) + "T00:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

const toneFor = (grade: string | null) => (grade && GENTLE.has(grade) ? "A" : "B");
const kindFor = (tone: string, stage: number) => (stage >= 5 ? "dc_esc" : `dc_${tone.toLowerCase()}${stage}`);

// ── QuickBooks: the firm's own overdue invoices ───────────────────────────
// An Invoice query gives today's balance, which is what a chaser needs.
// deno-lint-ignore no-explicit-any
function toInvoice(r: any): Invoice {
  return {
    number: String(r.DocNumber || r.Id),
    txnDate: String(r.TxnDate || ""),
    dueDate: String(r.DueDate || r.TxnDate || ""),
    total: Number(r.TotalAmt) || 0,
    balance: Number(r.Balance) || 0,
    customerId: String(r.CustomerRef?.value || ""),
    customerName: String(r.CustomerRef?.name || ""),
  };
}

async function overdueInvoices(customerId?: string): Promise<Invoice[]> {
  const today = todayIso();
  const out: Invoice[] = [];
  const where = `Balance > '0'` + (customerId ? ` AND CustomerRef = '${customerId.replace(/'/g, "")}'` : "");
  for (let start = 1; start < 20000; start += 1000) {
    // deno-lint-ignore no-explicit-any
    const res = await qboQuery(`SELECT * FROM Invoice WHERE ${where} STARTPOSITION ${start} MAXRESULTS 1000`) as any;
    const rows = res?.QueryResponse?.Invoice || [];
    for (const r of rows) {
      const inv = toInvoice(r);
      if (inv.dueDate && inv.dueDate < today) out.push(inv);
    }
    if (rows.length < 1000) break;
  }
  return out.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
}

function invoiceTableHtml(invs: Invoice[]): string {
  const today = todayIso();
  const th = 'style="text-align:left;padding:6px 10px;border-bottom:1px solid #cbd5e1;font-size:13px;color:#475569;"';
  const thr = 'style="text-align:right;padding:6px 10px;border-bottom:1px solid #cbd5e1;font-size:13px;color:#475569;"';
  const td = 'style="padding:6px 10px;border-bottom:1px solid #e2e8f0;font-size:14px;"';
  const tdr = 'style="padding:6px 10px;border-bottom:1px solid #e2e8f0;font-size:14px;text-align:right;"';
  const rows = invs.map((i) =>
    `<tr><td ${td}>${escapeHtml(i.number)}</td><td ${td}>${shortDate(i.txnDate)}</td><td ${td}>${shortDate(i.dueDate)}</td>` +
    `<td ${tdr}>${daysBetween(i.dueDate, today)}</td><td ${tdr}>${formatGBP(i.balance)}</td></tr>`).join("");
  const total = invs.reduce((s, i) => s + i.balance, 0);
  return `<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:0 0 14px 0;">` +
    `<tr><th ${th}>Invoice</th><th ${th}>Date</th><th ${th}>Due</th><th ${thr}>Days overdue</th><th ${thr}>Amount due</th></tr>` +
    rows +
    `<tr><td colspan="4" style="padding:8px 10px;font-size:14px;font-weight:bold;">Total overdue</td>` +
    `<td style="padding:8px 10px;font-size:14px;font-weight:bold;text-align:right;">${formatGBP(total)}</td></tr></table>`;
}

// ── The stage engine ──────────────────────────────────────────────────────
// deno-lint-ignore no-explicit-any
function suggestStage(history: any[], invoices: Invoice[]) {
  if (!history.length) return { stage: 1, due: true, reason: "First chase" };
  const last = history[0];
  if (last.status === "contact" || last.status === "responded") {
    return { stage: 1, due: true, reason: "Client got in touch after the last chase: back to stage 1" };
  }
  const now = new Set(invoices.map((i) => i.number));
  const cleared = (last.invoice_numbers || []).filter((n: string) => !now.has(n));
  if (cleared.length) {
    return { stage: 1, due: true, reason: `${cleared.length} invoice(s) paid since the last chase: back to stage 1` };
  }
  const days = daysBetween(last.sent_at, todayIso());
  if (days < CHASE_GAP_DAYS) {
    return { stage: Number(last.stage) || 1, due: false, reason: `Chased ${days} day(s) ago: next chase due in ${CHASE_GAP_DAYS - days}` };
  }
  const stage = Math.min((Number(last.stage) || 1) + 1, 5);
  return { stage, due: true, reason: `${days} days since stage ${last.stage}, no reply and nothing paid` };
}

// ── Rendering ─────────────────────────────────────────────────────────────
const fill = (s: string, vars: Record<string, string>, raw: Set<string>) =>
  s.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, k) => {
    const v = vars[k] ?? "";
    return raw.has(k) ? v : escapeHtml(v);
  });
const fillText = (s: string, vars: Record<string, string>) => s.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, k) => vars[k] ?? "");

function htmlToText(html: string): string {
  return html
    .replace(/<\/(p|div|tr|h\d)>/gi, "\n").replace(/<br\s*\/?>/gi, "\n").replace(/<\/t[dh]>/gi, "  ")
    .replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\n{3,}/g, "\n\n").trim();
}

/** The sender's "New email" signature for this mailbox (sql/365): exact mailbox first, then '*'. */
async function signatureHtml(db: Db, staffId: string, mailbox: string): Promise<string> {
  const { data: uses } = await db.from("comms_signature_use").select("mailbox_email, signature_id")
    .eq("staff_id", staffId).eq("action", "new").in("mailbox_email", [mailbox, "*"]);
  // deno-lint-ignore no-explicit-any
  const use = (uses || []).find((u: any) => u.mailbox_email === mailbox) || (uses || []).find((u: any) => u.mailbox_email === "*");
  if (!use?.signature_id) return "";
  const { data: t } = await db.from("comms_signature_templates").select("body_html").eq("id", use.signature_id).maybeSingle();
  return t?.body_html ? `<div style="margin-top:4px;">${t.body_html}</div>` : "";
}

async function entityContext(db: Db, entityId: string) {
  const { data: e } = await db.from("entities")
    .select("id, name, grade, grade_override, billing_email, prospect_email, qbo_customer_id").eq("id", entityId).maybeSingle();
  if (!e) throw new Error("Client not found");
  const pc = await primaryContact(db, entityId);
  const to = (e.billing_email || "").trim() || pc?.email || (e.prospect_email || "").trim() || "";
  return { e, firstName: pc?.greeting || "", to };
}

async function history(db: Db, entityId: string) {
  const { data } = await db.from("debt_chases")
    .select("id, stage, tone, status, sent_at, invoice_numbers, amount, from_mailbox, to_email, subject, sent_by, status_note")
    .eq("entity_id", entityId).order("sent_at", { ascending: false }).limit(50);
  return data || [];
}

async function render(db: Db, staffId: string, entityId: string, stageIn: number | null, mailbox: string) {
  const { e, firstName, to } = await entityContext(db, entityId);
  if (!e.qbo_customer_id) throw new Error(`${e.name} has no QuickBooks customer linked.`);
  const invoices = await overdueInvoices(e.qbo_customer_id);
  if (!invoices.length) throw new Error(`${e.name} has nothing overdue in QuickBooks.`);
  const hist = await history(db, entityId);
  const sug = suggestStage(hist, invoices);
  const stage = Math.min(Math.max(Number(stageIn) || sug.stage, 1), 5);
  const tone = stage >= 5 ? "ESC" : toneFor(e.grade);
  const kind = kindFor(tone === "ESC" ? "a" : tone, stage);
  const { data: tpl } = await db.from("comm_templates").select("subject, body_html")
    .eq("comm_type", "debt_chase").eq("kind", kind).maybeSingle();
  if (!tpl) throw new Error(`Template ${kind} is missing.`);
  const today = todayIso();
  const vars: Record<string, string> = {
    first_name: firstName || "there",
    client_name: e.name,
    invoice_table: invoiceTableHtml(invoices),
    pay_by: longDate(addDays(today, PAY_BY_DAYS)),
    final_date: longDate(addDays(today, PAY_BY_DAYS)),
    last_chase_date: hist[0] ? longDate(hist[0].sent_at) : longDate(today),
    chase_count: String(Math.max(stage - 1, 1)),
  };
  const subject = fillText(tpl.subject, { ...vars, invoice_table: "" });
  // Inline paragraph margins, as DCM had: some mail clients (and the
  // contentEditable preview) drop default <p> spacing.
  const body = fill(tpl.body_html, vars, new Set(["invoice_table"])).replace(/<p>/g, '<p style="margin:0 0 14px 0;">');
  const sig = await signatureHtml(db, staffId, mailbox);
  return {
    entity_id: e.id, client_name: e.name, grade: e.grade, tone, stage, template_kind: kind,
    suggested_stage: sug.stage, reason: sug.reason, to, first_name: firstName,
    subject, body_html: body + sig, signature_found: !!sig,
    invoices, amount: invoices.reduce((s, i) => s + i.balance, 0), qbo_customer_id: e.qbo_customer_id,
  };
}

// ── Handler ───────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ success: false, error: "POST required" }, 405);

  // Staff only, and only those who may see invoice balances (mirrors can_chase_debt()).
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return jsonResponse({ success: false, error: "Missing authorization" }, 401);
  const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { headers: { Authorization: authHeader } } });
  const { data: { user }, error: authErr } = await anon.auth.getUser();
  if (authErr || !user) return jsonResponse({ success: false, error: "Invalid token" }, 401);
  const db = getServiceClient();
  const { data: prof } = await db.from("staff_profiles")
    .select("id, is_active, is_portal_admin, can_view_client_fees, can_approve_billing").eq("id", user.id).maybeSingle();
  if (!prof?.is_active || !(prof.can_view_client_fees || prof.can_approve_billing || prof.is_portal_admin)) {
    return jsonResponse({ success: false, error: "Debt chasing needs fee or billing-approval access." }, 403);
  }

  const body = await req.json().catch(() => ({}));
  const action = String(body.action || "");

  try {
    switch (action) {
      case "queue": {
        const invoices = await overdueInvoices();
        const byCustomer = new Map<string, Invoice[]>();
        for (const i of invoices) {
          if (!byCustomer.has(i.customerId)) byCustomer.set(i.customerId, []);
          byCustomer.get(i.customerId)!.push(i);
        }
        const ids = [...byCustomer.keys()];
        const { data: ents } = ids.length
          ? await db.from("entities").select("id, name, grade, grade_override, billing_email, prospect_email, qbo_customer_id, entity_status").in("qbo_customer_id", ids)
          : { data: [] };
        // deno-lint-ignore no-explicit-any
        const entByCustomer = new Map<string, any>();
        for (const e of ents || []) {
          const prev = entByCustomer.get(e.qbo_customer_id);
          if (!prev || (prev.entity_status === "archived" && e.entity_status !== "archived")) entByCustomer.set(e.qbo_customer_id, e);
        }
        const entityIds = [...entByCustomer.values()].map((e) => e.id);
        const [{ data: chases }, { data: pauses }] = await Promise.all([
          entityIds.length
            ? db.from("debt_chases").select("id, entity_id, stage, status, sent_at, invoice_numbers").in("entity_id", entityIds).order("sent_at", { ascending: false })
            : { data: [] },
          entityIds.length ? db.from("debt_chase_pauses").select("*").in("entity_id", entityIds) : { data: [] },
        ]);
        // deno-lint-ignore no-explicit-any
        const histBy = new Map<string, any[]>();
        for (const c of chases || []) {
          if (!histBy.has(c.entity_id)) histBy.set(c.entity_id, []);
          histBy.get(c.entity_id)!.push(c);
        }
        // deno-lint-ignore no-explicit-any
        const pauseBy = new Map((pauses || []).map((p: any) => [p.entity_id, p]));
        const contacts = new Map(await Promise.all(entityIds.map(async (id) => [id, await primaryContact(db, id)] as const)));
        const today = todayIso();

        const rows = [];
        for (const [customerId, invs] of byCustomer) {
          const e = entByCustomer.get(customerId);
          const amount = invs.reduce((s, i) => s + i.balance, 0);
          const oldest = invs[0].dueDate;
          if (!e) {
            rows.push({
              entity_id: null, client_name: invs[0].customerName, qbo_customer_id: customerId,
              invoices: invs, amount, oldest_due: oldest, max_days_overdue: daysBetween(oldest, today),
              ready: false, blocked: "Not linked to a client in Athena",
            });
            continue;
          }
          const hist = histBy.get(e.id) || [];
          const sug = suggestStage(hist, invs);
          const pause = pauseBy.get(e.id);
          const paused = pause && pause.until_date >= today ? pause : null;
          const pc = contacts.get(e.id);
          const to = (e.billing_email || "").trim() || pc?.email || (e.prospect_email || "").trim() || "";
          const tone = sug.stage >= 5 ? "ESC" : toneFor(e.grade);
          const blocked = paused ? `Paused until ${shortDate(paused.until_date)}: ${paused.reason}`
            : !to ? "No email address on the client record" : null;
          rows.push({
            entity_id: e.id, client_name: e.name, grade: e.grade, grade_overridden: !!e.grade_override,
            entity_status: e.entity_status, qbo_customer_id: customerId,
            invoices: invs, amount, oldest_due: oldest, max_days_overdue: daysBetween(oldest, today),
            last_chase: hist[0] || null, chases_total: hist.length,
            suggested_stage: sug.stage, tone, template_kind: kindFor(tone === "ESC" ? "a" : tone, sug.stage),
            due: sug.due, reason: sug.reason, to, first_name: pc?.greeting || firstWord(e.name),
            paused, blocked, ready: sug.due && !blocked,
          });
        }
        rows.sort((a, b) => (b.amount || 0) - (a.amount || 0));
        return jsonResponse({ success: true, rows, as_at: today });
      }

      case "preview": {
        const entityId = String(body.entity_id || "");
        const mailbox = String(body.mailbox || "").toLowerCase();
        if (!entityId || !mailbox) return jsonResponse({ success: false, error: "entity_id and mailbox required" }, 400);
        const r = await render(db, user.id, entityId, body.stage ? Number(body.stage) : null, mailbox);
        return jsonResponse({ success: true, ...r });
      }

      case "send": {
        const entityId = String(body.entity_id || "");
        const mailbox = String(body.mailbox || "").toLowerCase();
        const to = String(body.to || "").trim();
        const subject = String(body.subject || "").trim();
        const bodyHtml = String(body.body_html || "");
        const stage = Math.min(Math.max(Number(body.stage) || 1, 1), 5);
        if (!entityId || !mailbox || !to || !subject || !bodyHtml.trim()) {
          return jsonResponse({ success: false, error: "entity_id, mailbox, to, subject and body_html are required" }, 400);
        }
        let tok;
        try { tok = await getValidGmailToken(mailbox); }
        catch (e) { return jsonResponse({ success: false, error: (e as Error).message, code: "no_gmail_connection" }, 400); }
        if (tok.kind === "personal" && tok.ownerStaffId !== user.id && !prof.is_portal_admin) {
          return jsonResponse({ success: false, error: `${mailbox} is a personal mailbox.` }, 403);
        }
        const check = await checkSend(db, { mailbox: tok.accountEmail, to, mode: "new", context: null });
        if (check.blocked) return jsonResponse({ success: false, error: check.blocked }, 400);
        if (check.warnings.length && !body.acknowledged) {
          return jsonResponse({ success: false, code: "needs_confirmation", error: check.warnings.join(" "), warnings: check.warnings });
        }
        const { e } = await entityContext(db, entityId);
        const invoices = e.qbo_customer_id ? await overdueInvoices(e.qbo_customer_id) : [];
        const tone = stage >= 5 ? "ESC" : toneFor(e.grade);
        const hist = await history(db, entityId);
        const sug = suggestStage(hist, invoices);
        const sent = await sendEmail(tok, db, user.id, { to, subject, bodyHtml, bodyText: htmlToText(bodyHtml) }, "debt-chase");
        const { data: row, error } = await db.from("debt_chases").insert({
          entity_id: entityId, qbo_customer_id: e.qbo_customer_id, stage, tone,
          template_kind: kindFor(tone === "ESC" ? "a" : tone, stage),
          invoice_numbers: invoices.map((i) => i.number), invoice_count: invoices.length,
          amount: Math.round(invoices.reduce((s, i) => s + i.balance, 0) * 100) / 100,
          to_email: to, from_mailbox: tok.accountEmail, subject, body_html: bodyHtml,
          stage_reason: stage === sug.stage ? sug.reason : `Stage ${stage} chosen by hand (suggested ${sug.stage}: ${sug.reason})`,
          gmail_message_id: sent.id, gmail_thread_id: sent.threadId, sent_by: user.id,
        }).select("id").single();
        if (error) throw new Error(`Sent, but the chase was not logged: ${error.message}`);
        return jsonResponse({ success: true, chase_id: row.id, gmail_message_id: sent.id });
      }

      case "mark": {
        const status = String(body.status || "");
        if (!["contact", "responded", "sent"].includes(status)) return jsonResponse({ success: false, error: "Bad status" }, 400);
        const { error } = await db.from("debt_chases").update({
          status, status_note: body.note ? String(body.note).slice(0, 500) : null,
          status_set_by: user.id, status_set_at: new Date().toISOString(),
        }).eq("id", String(body.chase_id || ""));
        if (error) throw new Error(error.message);
        return jsonResponse({ success: true });
      }

      case "pause": {
        const until = String(body.until || "");
        const reason = String(body.reason || "").trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(until) || !reason) return jsonResponse({ success: false, error: "A date and a reason are required" }, 400);
        const { error } = await db.from("debt_chase_pauses").upsert({
          entity_id: String(body.entity_id || ""), until_date: until, reason: reason.slice(0, 300),
          set_by: user.id, set_at: new Date().toISOString(),
        });
        if (error) throw new Error(error.message);
        return jsonResponse({ success: true });
      }

      case "unpause": {
        const { error } = await db.from("debt_chase_pauses").delete().eq("entity_id", String(body.entity_id || ""));
        if (error) throw new Error(error.message);
        return jsonResponse({ success: true });
      }

      case "set_grade": {
        const grade = body.grade == null || body.grade === "" ? null : String(body.grade);
        if (grade !== null && !GRADES.includes(grade)) return jsonResponse({ success: false, error: "Grade must be A+ to F" }, 400);
        const { data, error } = await db.from("entities").update({ grade_override: grade })
          .eq("id", String(body.entity_id || "")).select("grade, grade_override").single();
        if (error) throw new Error(error.message);
        await db.from("audit_log").insert({
          user_id: user.id, action: "client_grade_set", entity_type: "entities", entity_id: String(body.entity_id || ""),
          detail: { grade_override: grade },
        });
        return jsonResponse({ success: true, ...data });
      }

      default:
        return jsonResponse({ success: false, error: `Unknown action: ${action}` }, 400);
    }
  } catch (e) {
    return jsonResponse({ success: false, error: (e as Error).message }, 500);
  }
});
