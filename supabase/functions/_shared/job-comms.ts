// Client comms for job-plan stages — shared by job-plan (Preview & send from
// Today) and job-plan-tick (automatic sends when Client comms is armed).
//
// The email should read like a normal one from the team member, not a
// system message (Bobby, 2026-09-26): plain text, short, addressed to the
// primary contact by their preferred name, signed with the owner's first
// name, and sent from the owner's own mailbox when one is connected —
// otherwise from the practice mailbox with the owner's name on the From.
//
// Requests and chases carry a picked list of what we need from this client
// (records_items, remembered per client in client_records_items so next
// year starts from it). Requests and chases close on send; a meeting
// invite and an approval chase do not.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getValidGmailToken, base64UrlEncode, formatSender } from "./gmail-client.ts";

export const COMMS_STAGES = new Set(["request_records", "chase_1", "chase_2", "client_meeting", "approval"]);
const COMPLETES_ON_SEND = new Set(["request_records", "chase_1", "chase_2"]);
const ITEM_STAGES = new Set(["request_records", "chase_1", "chase_2"]);

function renderStr(s: string, vars: Record<string, string>): string {
  return String(s ?? "").replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, k) => (k in vars ? String(vars[k] ?? "") : ""));
}
function fmtLong(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(`${String(iso).slice(0, 10)}T12:00:00Z`);
  return isNaN(d.getTime()) ? String(iso) : d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}
function firstWord(name: string | null | undefined): string {
  return String(name ?? "").trim().split(/\s+/)[0] || "";
}
function encodeSubject(s: string): string {
  if (/^[\x20-\x7e]*$/.test(s)) return s;
  const b64 = base64UrlEncode(s).replace(/-/g, "+").replace(/_/g, "/");
  return `=?UTF-8?B?${b64 + "=".repeat((4 - b64.length % 4) % 4)}?=`;
}
// Plain text only: no HTML part, no shell, so it looks hand-typed.
function buildMime(to: string, subject: string, text: string, fromEmail: string, fromName?: string | null): string {
  return [
    `From: ${formatSender(fromName, fromEmail)}`,
    `To: ${to}`,
    `Subject: ${encodeSubject(subject)}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset="UTF-8"`,
    `Content-Transfer-Encoding: 8bit`,
    "",
    text,
  ].join("\r\n");
}

export interface PickedItem { key?: string | null; text?: string | null }
export interface PickerItem { key: string | null; label: string; grp: string; ticked: boolean; remembered: boolean }
export interface Rendered {
  kind: string;
  to: string | null;
  to_reason: string | null;
  greeting: string;
  from_email: string | null;
  from_name: string;
  subject: string;
  text: string;
  completes: boolean;
  picker: PickerItem[] | null;
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

/** The primary contact: preferred name and email. BrightManager's first. */
async function primaryContact(db: SupabaseClient, entityId: string) {
  const { data } = await db.from("entity_people")
    .select("source, is_primary_contact, people(preferred_name, first_name, name, email)")
    .eq("entity_id", entityId).eq("is_primary_contact", true).is("ended_on", null);
  const rows = (data || []).sort((a, b) => (a.source === "brightmanager" ? -1 : 0) - (b.source === "brightmanager" ? -1 : 0));
  const p = rows[0]?.people as Record<string, string | null> | undefined;
  if (!p) return null;
  const greeting = (p.preferred_name || "").trim() || (p.first_name || "").trim() || firstWord(p.name);
  return { greeting, email: (p.email || "").trim() || null };
}

// ── Per-person defaults (sql/316): opener, sign-off, name or signature ──
export interface CommsPrefs { opener_enabled: boolean; opener_text: string; signoff: string; signature_mode: "name" | "signature" }
const DEFAULT_PREFS: CommsPrefs = { opener_enabled: true, opener_text: "Hope you’re well.", signoff: "Thanks", signature_mode: "name" };
const SIGNOFFS = new Set(["Kind regards", "Best regards", "Thanks", "Cheers", "Many thanks"]);

export function cleanPrefs(v: unknown, base: CommsPrefs = DEFAULT_PREFS): CommsPrefs {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  return {
    opener_enabled: typeof o.opener_enabled === "boolean" ? o.opener_enabled : base.opener_enabled,
    opener_text: typeof o.opener_text === "string" ? o.opener_text.trim().slice(0, 200) : base.opener_text,
    signoff: SIGNOFFS.has(String(o.signoff)) ? String(o.signoff) : base.signoff,
    signature_mode: o.signature_mode === "signature" ? "signature" : o.signature_mode === "name" ? "name" : base.signature_mode,
  };
}

/** The sender's saved defaults, with an optional unsaved override from the draft screen on top. */
export async function loadPrefs(db: SupabaseClient, staffId: string | null, override?: unknown): Promise<CommsPrefs> {
  let base = DEFAULT_PREFS;
  if (staffId) {
    const { data } = await db.from("staff_comms_prefs").select("opener_enabled, opener_text, signoff, signature_mode").eq("staff_id", staffId).maybeSingle();
    if (data) base = cleanPrefs(data);
  }
  return override ? cleanPrefs(override, base) : base;
}

/** The person's saved signature as plain text (comms_signatures: exact mailbox first, then '*'). */
async function signatureText(db: SupabaseClient, staffId: string | null, mailbox: string | null): Promise<string | null> {
  if (!staffId) return null;
  const { data } = await db.from("comms_signatures").select("mailbox_email, body").eq("staff_id", staffId);
  const row = (data || []).find((s) => mailbox && s.mailbox_email === mailbox) || (data || []).find((s) => s.mailbox_email === "*");
  if (!row?.body) return null;
  const text = String(row.body).replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|tr)>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\n{3,}/g, "\n\n").trim();
  return text || null;
}

/** {{opener}} and {{signoff}} for the templates. */
async function closingVars(db: SupabaseClient, staffId: string | null, mailbox: string | null, firstName: string, prefs: CommsPrefs) {
  const opener = prefs.opener_enabled && prefs.opener_text ? `${prefs.opener_text.trim()} ` : "";
  const sig = prefs.signature_mode === "signature" ? await signatureText(db, staffId, mailbox) : null;
  const signoff = `${prefs.signoff},\n${sig || firstName}`;
  return { opener, signoff };
}

/** The picker for a request/chase: catalogue, defaults for the kind, and what this client was asked for before. */
export async function pickerFor(db: SupabaseClient, entityId: string, kind: string): Promise<PickerItem[]> {
  const [{ data: cat }, { data: mine }] = await Promise.all([
    db.from("records_items").select("key, label, grp, default_full, default_gap").eq("active", true).order("sort_order"),
    db.from("client_records_items").select("item_key, custom_text").eq("entity_id", entityId).eq("active", true),
  ]);
  const remembered = new Set((mine || []).filter((m) => m.item_key).map((m) => m.item_key));
  const hasMemory = remembered.size > 0;
  const out: PickerItem[] = (cat || []).map((c) => ({
    key: c.key, label: c.label, grp: c.grp,
    remembered: remembered.has(c.key),
    ticked: hasMemory ? remembered.has(c.key) : (kind === "gap_request" ? c.default_gap : c.default_full),
  }));
  for (const m of mine || []) {
    if (!m.item_key && m.custom_text) out.push({ key: null, label: m.custom_text, grp: "other", ticked: true, remembered: true });
  }
  return out;
}

function itemsText(items: PickedItem[], picker: PickerItem[] | null): string {
  const labels: string[] = [];
  for (const it of items) {
    if (it.key) { const p = picker?.find((x) => x.key === it.key); if (p) labels.push(p.label); }
    else if (it.text && it.text.trim()) labels.push(it.text.trim());
  }
  return labels.length ? labels.map((l) => `• ${l}`).join("\n") : "• whatever you have for the year – we’ll tell you if anything is missing";
}

/** Render the email for a milestone without sending it. */
export async function renderForMilestone(
  db: SupabaseClient, milestone: Record<string, any>, plan: Record<string, any>, items?: PickedItem[] | null, prefsOverride?: unknown,
): Promise<Rendered & { prefs: CommsPrefs }> {
  const kind = templateKindFor(milestone.stage_key, plan);
  if (!kind) throw new Error("Not a comms stage");

  const [{ data: tmpl }, { data: ent }, { data: ms }, contact] = await Promise.all([
    db.from("comm_templates").select("subject, body_text").eq("comm_type", "job_plan").eq("kind", kind).maybeSingle(),
    db.from("entities").select("id, name, billing_email, prospect_email").eq("id", plan.entity_id).maybeSingle(),
    db.from("job_milestones").select("stage_key, due_date, comms_sent_at, owner_id").eq("plan_id", plan.id),
    primaryContact(db, plan.entity_id),
  ]);
  if (!tmpl) throw new Error(`No template for ${kind} — add it under Communications`);
  if (!ent) throw new Error("Client not found");
  const stage = (k: string) => (ms || []).find((m) => m.stage_key === k);

  // To: the contact's own address first, then what the client record holds.
  let to = contact?.email || "";
  let toReason: string | null = to ? "primary contact" : null;
  if (!to) { to = (ent.billing_email || "").trim() || (ent.prospect_email || "").trim(); toReason = to ? "client record" : null; }
  if (!to.includes("@")) { to = ""; toReason = null; }
  const greeting = contact?.greeting || "there";

  // From: the owner's own mailbox if connected, else the practice mailbox
  // carrying the owner's name.
  let fromName = "";
  let fromEmail: string | null = null;
  const ownerId = milestone.owner_id;
  if (ownerId) {
    const [{ data: sp }, { data: gc }] = await Promise.all([
      db.from("staff_profiles").select("name").eq("id", ownerId).maybeSingle(),
      db.from("gmail_connections").select("account_email").eq("owner_staff_id", ownerId).eq("status", "active").limit(1),
    ]);
    fromName = sp?.name || "";
    fromEmail = gc?.[0]?.account_email || null;
  }

  const picker = ITEM_STAGES.has(milestone.stage_key) ? await pickerFor(db, plan.entity_id, kind) : null;
  const picked: PickedItem[] = items ?? (picker || []).filter((p) => p.ticked).map((p) => (p.key ? { key: p.key } : { text: p.label }));
  const prefs = await loadPrefs(db, ownerId || null, prefsOverride);
  const closing = await closingVars(db, ownerId || null, fromEmail, firstWord(fromName) || "Almond Valley Accounting", prefs);

  const vars: Record<string, string> = {
    ...closing,
    greeting,
    client_name: ent.name,
    year_end: fmtLong(plan.period_end),
    records_due: fmtLong(stage("records_in")?.due_date || stage("close_books")?.due_date || null),
    meeting_week: fmtLong(stage("client_meeting")?.due_date || null),
    sent_date: fmtLong((stage("send_for_approval")?.comms_sent_at || stage("client_meeting")?.due_date || "").slice(0, 10) || null),
    filing_date: fmtLong(stage("file_ch")?.due_date || plan.ch_deadline || null),
    sender_first_name: firstWord(fromName) || "Almond Valley Accounting",
    items: itemsText(picked, picker),
  };

  return {
    kind, to: to || null, to_reason: toReason, greeting,
    from_email: fromEmail, from_name: fromName,
    subject: renderStr(tmpl.subject, vars),
    text: renderStr(tmpl.body_text, vars),
    completes: COMPLETES_ON_SEND.has(milestone.stage_key),
    picker,
    prefs,
  };
}

// ── Generic emails from a task (Day Plan, Overview) ─────────────────────
//
// Not tied to a plan stage: a blank email about a task, or a records
// request for a client with no committed plan. Same voice, same From rules,
// same log on the client page.

async function rememberItems(db: SupabaseClient, entityId: string, picked: PickedItem[], periodEnd: string | null, actorId: string | null, now: string) {
  const keys = picked.filter((p) => p.key).map((p) => p.key as string);
  const customs = picked.filter((p) => !p.key && p.text && p.text.trim()).map((p) => p.text!.trim());
  await db.from("client_records_items").update({ active: false }).eq("entity_id", entityId);
  if (keys.length) {
    await db.from("client_records_items").upsert(
      keys.map((k) => ({ entity_id: entityId, item_key: k, active: true, last_period_end: periodEnd, last_requested_at: now, requested_by: actorId })),
      { onConflict: "entity_id,item_key" },
    );
  }
  await db.from("client_records_items").delete().eq("entity_id", entityId).is("item_key", null);
  if (customs.length) {
    await db.from("client_records_items").insert(
      customs.map((t) => ({ entity_id: entityId, item_key: null, custom_text: t, active: true, last_period_end: periodEnd, last_requested_at: now, requested_by: actorId })),
    );
  }
}

const GENERIC_RECORDS = "Hi {{greeting}},\n\n{{opener}}Could you send over the following when you get a chance?\n\n{{items}}\n\nUpload them to the portal or just reply to this email, whichever is easier.\n\n{{signoff}}";

export interface GenericOptions {
  entityId: string | null;
  kind: "blank" | "records_request";
  ownerId: string;
  taskLabel?: string | null;
  items?: PickedItem[] | null;
  prefs?: unknown;   // unsaved draft-screen choices
}

export async function renderGeneric(db: SupabaseClient, o: GenericOptions): Promise<Rendered & { period_end: string | null }> {
  const [{ data: sp }, { data: gc }] = await Promise.all([
    db.from("staff_profiles").select("name").eq("id", o.ownerId).maybeSingle(),
    db.from("gmail_connections").select("account_email").eq("owner_staff_id", o.ownerId).eq("status", "active").limit(1),
  ]);
  const fromName = sp?.name || "";
  const fromEmail = gc?.[0]?.account_email || null;
  const sender = firstWord(fromName) || "Almond Valley Accounting";

  let to = "", toReason: string | null = null, greeting = "there", clientName = "", periodEnd: string | null = null, recordsDue: string | null = null;
  if (o.entityId) {
    const [{ data: ent }, contact, { data: plan }] = await Promise.all([
      db.from("entities").select("id, name, billing_email, prospect_email").eq("id", o.entityId).maybeSingle(),
      primaryContact(db, o.entityId),
      db.from("job_plans").select("id, period_end, status").eq("entity_id", o.entityId).eq("status", "committed").order("period_end", { ascending: false }).limit(1),
    ]);
    if (!ent) throw new Error("Client not found");
    clientName = ent.name;
    to = contact?.email || "";
    toReason = to ? "primary contact" : null;
    if (!to) { to = (ent.billing_email || "").trim() || (ent.prospect_email || "").trim(); toReason = to ? "client record" : null; }
    if (!to.includes("@")) { to = ""; toReason = null; }
    greeting = contact?.greeting || "there";
    const p = plan?.[0];
    if (p) {
      periodEnd = p.period_end;
      const { data: ri } = await db.from("job_milestones").select("due_date").eq("plan_id", p.id).in("stage_key", ["records_in", "close_books"]).limit(1);
      recordsDue = ri?.[0]?.due_date || null;
    } else {
      // The year end most recently passed, if BM knows one.
      const today = new Date().toISOString().slice(0, 10);
      const { data: aj } = await db.from("v_accounts_jobs").select("period_end").eq("entity_id", o.entityId).lte("period_end", today).order("period_end", { ascending: false }).limit(1);
      periodEnd = aj?.[0]?.period_end || null;
    }
  }

  const prefs = await loadPrefs(db, o.ownerId, o.prefs);
  const closing = await closingVars(db, o.ownerId, fromEmail, sender, prefs);
  if (o.kind === "blank") {
    const subject = [clientName, o.taskLabel].filter(Boolean).join(" – ");
    return { kind: "blank", to: to || null, to_reason: toReason, greeting, from_email: fromEmail, from_name: fromName, subject, text: `Hi ${greeting},\n\n${closing.opener.trim()}${closing.opener ? "\n\n" : ""}\n\n${closing.signoff}`, completes: false, picker: null, period_end: periodEnd };
  }

  if (!o.entityId) throw new Error("A records request needs a client");
  const picker = await pickerFor(db, o.entityId, "records_request");
  const picked: PickedItem[] = o.items ?? picker.filter((p) => p.ticked).map((p) => (p.key ? { key: p.key } : { text: p.label }));
  const { data: tmpl } = await db.from("comm_templates").select("subject, body_text").eq("comm_type", "job_plan").eq("kind", "records_request").maybeSingle();
  const useTemplate = !!(tmpl && periodEnd);
  const vars: Record<string, string> = {
    ...closing,
    greeting, client_name: clientName, year_end: fmtLong(periodEnd),
    records_due: fmtLong(recordsDue || new Date(Date.now() + 21 * 86400000).toISOString().slice(0, 10)),
    sender_first_name: sender, items: itemsText(picked, picker),
  };
  return {
    kind: "records_request", to: to || null, to_reason: toReason, greeting, from_email: fromEmail, from_name: fromName,
    subject: useTemplate ? renderStr(tmpl!.subject, vars) : `${clientName} – records`,
    text: renderStr(useTemplate ? tmpl!.body_text : GENERIC_RECORDS, vars),
    completes: false, picker, period_end: periodEnd,
  };
}

export interface GenericSend {
  entityId: string | null;
  to: string;
  subject: string;
  text: string;
  ownerId: string;
  mailbox?: string | null;
  testOnly?: boolean;
  remember?: PickedItem[] | null;  // records request: what was asked for
  periodEnd?: string | null;
}

/** Send a composed email through the sender's Gmail and log it on the client. */
export async function sendGeneric(db: SupabaseClient, s: GenericSend) {
  const [{ data: sp }, { data: gc }] = await Promise.all([
    db.from("staff_profiles").select("name").eq("id", s.ownerId).maybeSingle(),
    db.from("gmail_connections").select("account_email").eq("owner_staff_id", s.ownerId).eq("status", "active").limit(1),
  ]);
  const ownEmail = gc?.[0]?.account_email || null;
  const token = await getValidGmailToken(ownEmail || s.mailbox || undefined);
  const fromName = ownEmail ? (token.displayName || sp?.name || "") : (sp?.name || token.displayName);
  const mime = buildMime(s.to, s.subject, s.text, token.accountEmail, fromName);
  const resp = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { Authorization: `Bearer ${token.accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ raw: base64UrlEncode(mime) }),
  });
  if (!resp.ok) throw new Error(`Gmail ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
  const sent = await resp.json();
  const now = new Date().toISOString();
  if (s.testOnly) return { to: s.to, subject: s.subject, from: token.accountEmail, gmail_message_id: sent.id || null, test: true };

  if (s.entityId) {
    await db.from("client_communications").upsert({
      entity_id: s.entityId, mailbox: token.accountEmail,
      gmail_message_id: sent.id || null, gmail_thread_id: sent.threadId || null,
      direction: "out", from_email: token.accountEmail, from_name: fromName || null,
      to_emails: [s.to], cc_emails: [], subject: s.subject, snippet: s.text.slice(0, 200),
      body_html: null, body_text: s.text, matched_email: s.to, occurred_at: now,
    }, { onConflict: "entity_id,mailbox,gmail_message_id", ignoreDuplicates: true });
    if (s.remember) await rememberItems(db, s.entityId, s.remember, s.periodEnd ?? null, s.ownerId, now);
  }
  return { to: s.to, subject: s.subject, from: token.accountEmail, gmail_message_id: sent.id || null };
}

export interface SendOptions {
  mailbox?: string | null;     // gmail account_email to fall back to; null = practice default
  toOverride?: string | null;  // a test recipient, or a corrected address
  actorId?: string | null;     // staff id, null for the tick
  testOnly?: boolean;          // when true the milestone and the client memory are not touched
  items?: PickedItem[] | null; // the picker's ticks; undefined = remembered or defaults
  prefs?: unknown;             // draft-screen choices (opener, sign-off, signature)
  subjectOverride?: string | null; // the edited subject and text from the second screen
  textOverride?: string | null;
}

/** Render, send through Gmail, log on the client, remember the items, stamp the milestone. */
export async function sendForMilestone(db: SupabaseClient, milestoneId: string, opts: SendOptions = {}) {
  const { data: m, error } = await db.from("job_milestones").select("*, job_plans(*)").eq("id", milestoneId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!m) throw new Error("Stage not found");
  const plan = m.job_plans as Record<string, any>;
  if (plan.status !== "committed") throw new Error("The plan is not committed");
  if (m.status !== "pending") throw new Error("That stage is already closed");
  if (m.comms_sent_at && !opts.testOnly) throw new Error(`Already sent on ${String(m.comms_sent_at).slice(0, 10)}`);

  const r = await renderForMilestone(db, m, plan, opts.items ?? null, opts.prefs);
  const to = (opts.toOverride || "").trim() || r.to;
  if (!to) throw new Error("No email address on file for this client");
  // What was on the screen is what goes.
  if (opts.subjectOverride && opts.subjectOverride.trim()) r.subject = opts.subjectOverride.trim().slice(0, 200);
  if (opts.textOverride && opts.textOverride.trim()) r.text = opts.textOverride.slice(0, 20000);

  // The owner's own mailbox when connected; otherwise the configured or
  // practice mailbox, with the owner's name on the From line.
  const token = await getValidGmailToken(r.from_email || opts.mailbox || undefined);
  const fromName = r.from_email ? (token.displayName || r.from_name) : (r.from_name || token.displayName);
  const mime = buildMime(to, r.subject, r.text, token.accountEmail, fromName);
  const resp = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { Authorization: `Bearer ${token.accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ raw: base64UrlEncode(mime) }),
  });
  if (!resp.ok) throw new Error(`Gmail ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
  const sent = await resp.json();
  const now = new Date().toISOString();

  if (opts.testOnly) return { to, subject: r.subject, from: token.accountEmail, gmail_message_id: sent.id || null, test: true };

  // On the client page, like every other email we hold.
  await db.from("client_communications").upsert({
    entity_id: plan.entity_id, mailbox: token.accountEmail,
    gmail_message_id: sent.id || null, gmail_thread_id: sent.threadId || null,
    direction: "out", from_email: token.accountEmail, from_name: fromName || null,
    to_emails: [to], cc_emails: [], subject: r.subject, snippet: r.text.slice(0, 200),
    body_html: null, body_text: r.text, matched_email: to, occurred_at: now,
  }, { onConflict: "entity_id,mailbox,gmail_message_id", ignoreDuplicates: true });

  // Remember what this client was asked for, so next year starts from it.
  if (ITEM_STAGES.has(m.stage_key)) {
    const picked = opts.items ?? (r.picker || []).filter((p) => p.ticked).map((p) => (p.key ? { key: p.key } : { text: p.label }));
    await rememberItems(db, plan.entity_id, picked, plan.period_end, opts.actorId ?? null, now);
  }

  const patch: Record<string, unknown> = {
    comms_sent_at: now, comms_to: to, comms_message_id: sent.id || null, comms_thread_id: sent.threadId || null,
    comms_sent_by: opts.actorId ?? null, updated_at: now,
  };
  if (r.completes) { patch.status = "done"; patch.done_at = now; patch.done_signal = "email"; }
  const { error: uErr } = await db.from("job_milestones").update(patch).eq("id", milestoneId);
  if (uErr) throw new Error(uErr.message);

  return { to, subject: r.subject, from: token.accountEmail, gmail_message_id: sent.id || null, completed: r.completes };
}
