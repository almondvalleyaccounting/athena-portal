// Client comms for job-plan stages — shared by job-plan (Preview & send from
// Today) and job-plan-tick (automatic sends when Client comms is armed).
//
// One stage, one email: the template is chosen from the stage key and the
// plan (a gap request where VAT covers the year), rendered with the client's
// details, sent through the Gmail connection so it leaves a Sent item, logged
// on the client page via client_communications, and stamped on the
// milestone. Request and chase stages are complete once sent; a meeting
// invite and an approval chase are not (the meeting still has to happen).

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getValidGmailToken, base64UrlEncode, formatSender } from "./gmail-client.ts";

export const COMMS_STAGES = new Set(["request_records", "chase_1", "chase_2", "client_meeting", "approval"]);
const COMPLETES_ON_SEND = new Set(["request_records", "chase_1", "chase_2"]);

const PRACTICE_NAME = "Almond Valley Accounting";

function esc(s: unknown): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function renderStr(s: string, vars: Record<string, string>): string {
  return String(s ?? "").replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, k) => (k in vars ? String(vars[k] ?? "") : ""));
}
function wrapShell(inner: string): string {
  return `<!doctype html><html><body style="margin:0;padding:0;background:#ffffff;"><div style="max-width:640px;margin:0;padding:14px 6px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#222222;">${inner}</div></body></html>`;
}
function fmtLong(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(`${String(iso).slice(0, 10)}T12:00:00Z`);
  return isNaN(d.getTime()) ? String(iso) : d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}
function greetingName(name: string | null | undefined): string {
  const n = String(name ?? "").trim();
  if (!n) return "there";
  if (/\b(ltd|limited|llp|plc|lp|partnership|associates|company|co\.)\b/i.test(n)) return n;
  let base = n;
  if (n.includes(",")) { const after = n.split(",")[1]; if (after && after.trim()) base = after.trim(); }
  return base.split(/\s+/)[0];
}
function encodeSubject(s: string): string {
  if (/^[\x20-\x7e]*$/.test(s)) return s;
  const b64 = base64UrlEncode(s).replace(/-/g, "+").replace(/_/g, "/");
  return `=?UTF-8?B?${b64 + "=".repeat((4 - b64.length % 4) % 4)}?=`;
}
function buildMime(to: string, subject: string, text: string, html: string, fromEmail: string, fromName?: string | null): string {
  const boundary = `=_athena_${crypto.randomUUID()}`;
  return [
    `From: ${formatSender(fromName, fromEmail)}`,
    `To: ${to}`,
    `Subject: ${encodeSubject(subject)}`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "", `--${boundary}`, `Content-Type: text/plain; charset="UTF-8"`, `Content-Transfer-Encoding: 7bit`, "", text,
    `--${boundary}`, `Content-Type: text/html; charset="UTF-8"`, `Content-Transfer-Encoding: 7bit`, "", html, `--${boundary}--`,
  ].join("\r\n");
}

// The gap list is the request stage's note (set by job-plan when VAT covers
// the year). Bullets become list items in the HTML version.
function gapListHtml(note: string): string {
  const lines = note.split("\n").map((l) => l.trim()).filter(Boolean);
  const items = lines.filter((l) => l.startsWith("•")).map((l) => `<li>${esc(l.replace(/^•\s*/, ""))}</li>`);
  const intro = lines.filter((l) => !l.startsWith("•")).map(esc).join(" ");
  return `${intro ? `${intro}` : ""}${items.length ? `<ul>${items.join("")}</ul>` : ""}`;
}

export interface Rendered {
  kind: string;
  to: string | null;
  to_reason: string | null;
  subject: string;
  text: string;
  html: string;
  completes: boolean;
}

/** Which template a stage uses, or null when the stage is not a comms stage. */
export function templateKindFor(stageKey: string, plan: { records_via_vat?: boolean | null }): string | null {
  switch (stageKey) {
    case "request_records": return plan.records_via_vat ? "gap_request" : "records_request";
    case "chase_1":
    case "chase_2": return "records_chase";
    case "client_meeting": return "meeting_invite";
    case "approval": return "approval_chase";
    default: return null;
  }
}

/** Render the email for a milestone without sending it. */
export async function renderForMilestone(db: SupabaseClient, milestone: Record<string, any>, plan: Record<string, any>, allMilestones: Array<Record<string, any>>): Promise<Rendered> {
  const kind = templateKindFor(milestone.stage_key, plan);
  if (!kind) throw new Error("Not a comms stage");

  const [{ data: tmpl }, { data: ent }, { data: ms }] = await Promise.all([
    db.from("comm_templates").select("subject, body_text, body_html").eq("comm_type", "job_plan").eq("kind", kind).maybeSingle(),
    db.from("entities").select("id, name, billing_email, prospect_email, entity_status").eq("id", plan.entity_id).maybeSingle(),
    db.from("job_milestones").select("stage_key, due_date, comms_sent_at, note, owner_id").eq("plan_id", plan.id),
  ]);
  if (!tmpl) throw new Error(`No template for ${kind} — add it under Communications`);
  if (!ent) throw new Error("Client not found");
  const stages = (ms || allMilestones) as Array<Record<string, any>>;
  const stage = (k: string) => stages.find((m) => m.stage_key === k);

  // Recipient: the same chain the tax reminders use.
  let to = (ent.billing_email || "").trim() || (ent.prospect_email || "").trim();
  let toReason = to ? "client record" : null;
  if (!to) {
    const { data: rec } = await db.from("v_email_reconciliation").select("bm_contact_email").eq("entity_id", ent.id).limit(1);
    to = (rec?.[0]?.bm_contact_email || "").trim();
    toReason = to ? "BrightManager contact" : null;
  }
  if (!to.includes("@")) { to = ""; toReason = null; }

  // Sender: the stage's owner (client manager for requests and chases).
  let senderName = PRACTICE_NAME;
  const ownerId = milestone.owner_id;
  if (ownerId) {
    const { data: sp } = await db.from("staff_profiles").select("name").eq("id", ownerId).maybeSingle();
    if (sp?.name) senderName = `${sp.name}\n${PRACTICE_NAME}`;
  }

  const recordsDue = stage("records_in")?.due_date || stage("close_books")?.due_date || null;
  const meetingDue = stage("client_meeting")?.due_date || null;
  const sent = stage("send_for_approval")?.comms_sent_at || stage("client_meeting")?.due_date || null;
  const filing = stage("file_ch")?.due_date || plan.ch_deadline || null;
  const note = stage("request_records")?.note || "";

  const vars: Record<string, string> = {
    greeting: greetingName(ent.name),
    client_name: ent.name,
    year_end: fmtLong(plan.period_end),
    records_due: fmtLong(recordsDue),
    meeting_week: fmtLong(meetingDue),
    sent_date: fmtLong(sent ? String(sent).slice(0, 10) : null),
    filing_date: fmtLong(filing),
    sender_name: senderName,
    gap_list: note,
  };
  const htmlVars: Record<string, string> = {};
  for (const [k, v] of Object.entries(vars)) htmlVars[k] = k === "gap_list" ? gapListHtml(v) : k === "sender_name" ? esc(v).replace(/\n/g, "<br>") : esc(v);

  return {
    kind,
    to: to || null,
    to_reason: toReason,
    subject: renderStr(tmpl.subject, vars),
    text: renderStr(tmpl.body_text, vars),
    html: wrapShell(renderStr(tmpl.body_html, htmlVars)),
    completes: COMPLETES_ON_SEND.has(milestone.stage_key),
  };
}

export interface SendOptions {
  mailbox?: string | null;     // gmail account_email; null = practice default
  toOverride?: string | null;  // a test recipient, or a corrected address
  actorId?: string | null;     // staff id, null for the tick
  testOnly?: boolean;          // when true the milestone is not stamped
}

/** Render, send through Gmail, log on the client, stamp the milestone. */
export async function sendForMilestone(db: SupabaseClient, milestoneId: string, opts: SendOptions = {}) {
  const { data: m, error } = await db.from("job_milestones").select("*, job_plans(*)").eq("id", milestoneId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!m) throw new Error("Stage not found");
  const plan = m.job_plans as Record<string, any>;
  if (plan.status !== "committed") throw new Error("The plan is not committed");
  if (m.status !== "pending") throw new Error("That stage is already closed");
  if (m.comms_sent_at && !opts.testOnly) throw new Error(`Already sent on ${String(m.comms_sent_at).slice(0, 10)}`);

  const r = await renderForMilestone(db, m, plan, []);
  const to = (opts.toOverride || "").trim() || r.to;
  if (!to) throw new Error("No email address on file for this client");

  const token = await getValidGmailToken(opts.mailbox || undefined);
  const mime = buildMime(to, r.subject, r.text, r.html, token.accountEmail, token.displayName);
  const resp = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { Authorization: `Bearer ${token.accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ raw: base64UrlEncode(mime) }),
  });
  if (!resp.ok) throw new Error(`Gmail ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
  const sent = await resp.json();
  const now = new Date().toISOString();

  if (opts.testOnly) return { to, subject: r.subject, gmail_message_id: sent.id || null, test: true };

  // On the client page, like every other email we hold.
  await db.from("client_communications").upsert({
    entity_id: plan.entity_id, mailbox: token.accountEmail,
    gmail_message_id: sent.id || null, gmail_thread_id: sent.threadId || null,
    direction: "out", from_email: token.accountEmail, from_name: token.displayName || null,
    to_emails: [to], cc_emails: [], subject: r.subject, snippet: r.text.slice(0, 200),
    body_html: r.html, body_text: r.text, matched_email: to, occurred_at: now,
  }, { onConflict: "entity_id,mailbox,gmail_message_id", ignoreDuplicates: true });

  const patch: Record<string, unknown> = {
    comms_sent_at: now, comms_to: to, comms_message_id: sent.id || null, comms_thread_id: sent.threadId || null,
    comms_sent_by: opts.actorId ?? null, updated_at: now,
  };
  if (r.completes) { patch.status = "done"; patch.done_at = now; patch.done_signal = "email"; }
  const { error: uErr } = await db.from("job_milestones").update(patch).eq("id", milestoneId);
  if (uErr) throw new Error(uErr.message);

  return { to, subject: r.subject, gmail_message_id: sent.id || null, completed: r.completes };
}
