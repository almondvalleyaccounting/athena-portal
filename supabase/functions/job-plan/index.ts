// job-plan — Athena Portal
//
// The writes behind "Plan the Job" (sql/304). The browser holds SELECT on
// workflow_*, job_plans and job_milestones and nothing else; every change
// comes through here and is attributed to the JWT's user.
//
// Body: { action, ...fields }
//   propose       { entity_id, period_end, has_meeting?, books_with_us? }
//                 Build (or rebuild) the draft chain from the template. Pinned
//                 milestones keep their date and owner; everything else is
//                 recomputed. A committed plan is left alone unless replan=true.
//   save          { plan_id, note?, has_meeting?, books_with_us?, milestones: [
//                   { stage_key, due_date?, owner_id?, pinned?, status?, note? } ] }
//                 Edits on the draft. Changing a variant switch recomputes
//                 unpinned milestones.
//   commit        { plan_id }
//   uncommit      { plan_id }        back to draft
//   batch_propose { items: [{ entity_id, period_end }] }
//                 draft the default chain for many jobs, to review together
//   batch_commit  { items: [{ entity_id, period_end }] }
//                 commit reviewed drafts as they stand; a job with no plan
//                 yet gets the default proposed first.
//   set_client_meeting { entity_id, has_meeting (true|false|null), basis?, note? }
//                 the client-level answer (sql/306); null clears it back to
//                 what the billing says.
//   preview_comms { milestone_id }               the rendered email (to, subject, text)
//   send_comms    { milestone_id, to?, test? }   send it; test=true with `to` sends a copy
//                 to that address and leaves the stage untouched
//   move_milestone { milestone_id, due_date, owner_id? }   the week planner's drag; pins the stage
//   preview_email { entity_id?, kind: blank|records_request, task_label?, items? }  an email from a task
//   send_email    { entity_id?, to, subject, text, kind, items?, period_end?, test?, task?, task_label?, to_staff_id? }
//   add_comment   { task: { type, id, occurrence_date? }, body, entity_id?, task_label?, mentions?: [staff id] }   notifies the thread and the mentioned (sql/315, 318)
//   set_day_order { day, keys[] }                           Day Plan tile order (sql/313)
//   save_holiday / delete_holiday / handover_preview        holidays and handover drafts (sql/317)
//   complete_bm_job { schedule_id, minutes?, note? }        a BM job done in Athena (sql/311)
//   confirm_bm_completion { completion_id }                 ticked off in BrightManager by hand
//   mark_done     { milestone_id, minutes?, note? }
//                 the Done button on Today. Minutes > 0 also write a
//                 timesheet_entries row against the job (source 'completed').
//   skip          { milestone_id }   not needed on this job
//   reopen        { milestone_id }   back to pending
//   priority_board    { template?, staff_id? }                the Priority board (sql/349): columns, order, queue dates
//   priority_reorder  { template, staff_id, keys[], apply? }  a column's new order ("entity|period_end"); writes the dates
//   priority_apply    { template, staff_id }                  write the queue's dates for a column as it stands
//   priority_set_hours { template, staff_id, weekly_hours }   hours a week on this work; rewrites the dates
//   progress_update   { template, entity_id, period_end, confidence, reason_code?, escalate?, note?, review_date? }
//   progress_history  { template, entity_id, period_end }
//   progress_reports  {}                                      delay/stuck reports still open (sql/350)
//   report_dealt_with { id, note? }                           close a report
//   set_deprioritised { entity_id, reason | null }            the client-level flag (Ready Now, Job Selector, Priority)
//   records_candidates { entity_ids[] | emails[] }            a client's jobs still waiting on records (sql/366)
//   records_received { entity_id, period_end, template, email } records in from an email: workflow, preparer told, BM status asked for
//   company_directors { entity_id }                           directors with their next self assessment (sql/351)
//   income_items / income_item_add / income_item_received / income_item_remove   directors' other income
//
// Returns { success, plan, milestones } for single-plan actions.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireStaffOrService, authErrorResponse } from "../_shared/require-staff.ts";
import { computeChain, type StageRule, type JobContext } from "../_shared/workflow.ts";
import { renderForMilestone, sendForMilestone, renderGeneric, sendGeneric, loadPrefs, cleanPrefs } from "../_shared/job-comms.ts";
import { sendEmail } from "../_shared/resend.ts";
import { buildBoard as buildBoardShared, PRIORITY_TEMPLATES, jobKey } from "../_shared/priority-board.ts";
import { appendYearEndNote } from "../_shared/drive-notes.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...cors } });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// When a VAT return we prepare ends at or within two months of the year end
// we already hold most of the paperwork, so the request is for the gaps.
// Bobby, 2026-09-26. The list is the stage's note so it lands on Today.
const GAP_REQUEST_LABEL = "Request year-end gaps (VAT covers the year)";
const GAP_REQUEST_NOTE = [
  "Most records are already with us via the VAT returns. Ask only for the gaps:",
  "• loan statements at the year end; any new HP or finance agreements",
  "• payroll figures if payroll is not ours (P32s, P11Ds)",
  "• director's personal tax: P60/P45/P11D, savings interest, rental income, home-office costs, dividends from other companies, trust income, state pension, child benefit, student loan balance",
  "• free-form: specific invoices, explanations of unusual items (e.g. material donations)",
].join("\n");
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const TEMPLATE_KEY = "annual_accounts";

class BadRequest extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}
function uuid(v: unknown, field: string): string {
  const s = String(v ?? "");
  if (!UUID.test(s)) throw new BadRequest(`${field} must be a uuid`);
  return s;
}
function isoDate(v: unknown, field: string): string {
  const s = String(v ?? "");
  if (!ISO.test(s) || Number.isNaN(new Date(`${s}T12:00:00Z`).getTime())) throw new BadRequest(`${field} must be YYYY-MM-DD`);
  return s;
}
// The picker's ticks: [{ key }] for catalogue items, [{ text }] for free text.
function pickedItems(v: unknown[]): Array<{ key?: string | null; text?: string | null; for?: string[] }> {
  return v.slice(0, 60).map((x) => {
    const o = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
    const key = o.key ? String(o.key).slice(0, 60) : null;
    const text = o.text ? String(o.text).slice(0, 300) : null;
    // Directors a personal item is for (sql/351): their individual client ids.
    const forIds = Array.isArray(o.for) ? (o.for as unknown[]).map(String).filter((x) => UUID.test(x)).slice(0, 10) : [];
    const base = key ? { key } : { text };
    return forIds.length ? { ...base, for: forIds } : base;
  }).filter((x) => x.key || (x.text && x.text.trim()));
}
// A task reference from the browser: { type: ms|bm|quick|block, id, occurrence_date? }.
const TASK_TYPES = new Set(["ms", "bm", "quick", "block"]);
function taskRef(v: unknown): { type: string; id: string; occurrence_date: string | null } | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const type = String(o.type || "");
  if (!TASK_TYPES.has(type)) throw new BadRequest("task.type must be ms, bm, quick or block");
  const id = uuid(o.id, "task.id");
  const occ = o.occurrence_date ? isoDate(o.occurrence_date, "task.occurrence_date") : null;
  return { type, id, occurrence_date: occ };
}
const PORTAL_URL = Deno.env.get("PORTAL_PUBLIC_URL") || "https://portal.almondvalleyaccounting.co.uk";
// BrightManager's status ladder — the same as job-plan-tick's BM_RANK
// (mirrors bm_status_rank() in sql/089): how far a job has got.
const RECORDS_LADDER: Record<string, number> = {
  "No Latest Action": 0, "No Progress": 0, "Records Requested": 1, "Part Records Received": 2,
  "Records Received": 3, "In Progress": 4, "Queries Requested": 5, "Queries Received": 6,
  "To Review": 7, "Reviewed": 8, "To Send to Client to Approve": 9, "Awaiting Approval": 10,
};
function recordsRank(status: string | null | undefined): number {
  if (!status) return 0;
  return RECORDS_LADDER[status] ?? 99; // a status off the ladder (filed, approved…) is past records
}
// "2025/26" for a tax year ending 5 April 2026.
function saYear(taxYearEnd: string): string {
  const y = Number(String(taxYearEnd).slice(0, 4));
  return Number.isFinite(y) ? `${y - 1}/${String(y).slice(2)}` : String(taxYearEnd);
}
function taskUrl(t: { type: string; id: string; occurrence_date: string | null }): string {
  return `${PORTAL_URL}/planner/day?task=${t.type}:${t.id}${t.occurrence_date ? `:${t.occurrence_date}` : ""}`;
}
// Which Allocations column a BM task belongs to (mirrors v_inferred_allocations,
// sql/052) and which sibling tasks move with it when the allocation moves.
function allocationFamily(service: string | null, name: string | null): { canonical: string | null; siblings: (svc: string | null, nm: string | null) => boolean } {
  const n = (name || "").toLowerCase();
  const isPrep = (nm: string | null) => (nm || "").toLowerCase().startsWith("accounts preparation");
  const isSub = (svc: string | null, nm: string | null) => {
    const x = (nm || "").toLowerCase();
    return (svc === "Annual Accounts" && x.includes("companies house submission")) || (svc === "Corporation Tax" && x.startsWith("ct600 submission"));
  };
  if (service === "Bookkeeping") return { canonical: "bookkeeping", siblings: (svc) => svc === "Bookkeeping" };
  if (service === "VAT") return { canonical: "vat_review", siblings: (svc) => svc === "VAT" };
  if (service === "Self Assessment" || service === "Personal Tax") return { canonical: "self_assessment", siblings: (svc) => svc === "Self Assessment" || svc === "Personal Tax" };
  if (service === "Annual Accounts" && isPrep(name)) return { canonical: "accounts_preparation", siblings: (svc, nm) => svc === "Annual Accounts" && isPrep(nm) };
  if (isSub(service, name)) return { canonical: "accounts_submission", siblings: isSub };
  void n;
  return { canonical: null, siblings: (svc) => svc === service };
}

// Move a BM job to someone (sql/330). One-off: this task. Permanent: every
// planned task of the client in the same allocation family, plus the
// allocation_changes draft the Allocations screen would write.
// deno-lint-ignore no-explicit-any
async function reassignBmJob(db: any, me: string, now: string, row: { id: string; entity_id: string; bm_task_name: string | null; service: string | null; assignee_id: string | null }, to: string, mode: "one_off" | "permanent", note: string | null, targetName: string) {
  const override = { assignee_override_id: to, assignee_override_kind: mode, assignee_override_at: now, assignee_override_by: me, assignee_override_note: note, updated_at: now };
  let ids = [row.id];
  let canonical: string | null = null;
  let draftId: string | null = null;
  if (mode === "permanent") {
    const fam = allocationFamily(row.service, row.bm_task_name);
    canonical = fam.canonical;
    const { data: sib, error: sErr } = await db.from("bm_task_schedule").select("id, service, bm_task_name").eq("entity_id", row.entity_id).eq("state", "planned").is("excluded_at", null);
    if (sErr) throw new Error(sErr.message);
    ids = Array.from(new Set([row.id, ...(sib || []).filter((x: any) => fam.siblings(x.service, x.bm_task_name)).map((x: any) => x.id as string)]));
    if (canonical) {
      const payload = { entity_id: row.entity_id, canonical_service_id: canonical, proposed_fee_earner_id: to, proposed_manager_id: null, note: note || "Reassigned from the task in Athena", status: "draft", created_by: me };
      const { data: existing } = await db.from("allocation_changes").select("id").eq("entity_id", row.entity_id).eq("canonical_service_id", canonical).eq("status", "draft").maybeSingle();
      const w = existing ? db.from("allocation_changes").update(payload).eq("id", existing.id).select("id").single() : db.from("allocation_changes").insert(payload).select("id").single();
      const { data: d, error: dErr } = await w;
      if (dErr) throw new Error(dErr.message);
      draftId = d.id;
    }
  }
  const { error: uErr } = await db.from("bm_task_schedule").update(override).in("id", ids);
  if (uErr) throw new Error(uErr.message);
  await db.from("task_comments").insert({
    task_type: "bm", task_id: row.id, entity_id: row.entity_id, task_label: row.bm_task_name, author_id: me, kind: "comment",
    body: `${mode === "permanent" ? "Reassigned permanently" : "Reassigned (one-off)"} to ${targetName}${ids.length > 1 ? ` with ${ids.length - 1} related task${ids.length > 2 ? "s" : ""}` : ""}${draftId ? "; on the admin list to move in BrightManager" : ""}${note ? ` — ${note}` : ""}`,
  });
  return { ids, canonical, draftId };
}

function optUuid(v: unknown, field: string): string | null {
  if (v === null || v === undefined || v === "") return null;
  return uuid(v, field);
}
function optBool(v: unknown): boolean | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "boolean") return v;
  throw new BadRequest("expected true or false");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ success: false, error: "POST required" }, 405);

  // Staff only. The nightly recompute will be a separate function.
  let caller;
  try { caller = await requireStaffOrService(req, { allowService: false }); }
  catch (e) { return authErrorResponse(e, cors); }
  const me = caller.userId!;

  const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const p = await req.json().catch(() => ({}));
  const now = new Date().toISOString();

  // ── Lookups ────────────────────────────────────────────────────────────────

  // ── Holiday handover helpers (sql/320) ──
  const DOW = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  const shiftISO = (iso: string, n: number) => { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const shortName = (name: string | null) => String(name || "").replace(/\s*(Year End|Quarterly End|Monthly End|Period End|Tax Year).*$/i, "");

  /** Rule 8: two full working days before the last working day before the holiday, on the owner's pattern; booked days off do not count. */
  async function handoverDueFor(staffId: string, from: string, excludeHolidayId: string | null): Promise<string | null> {
    const [{ data: sp }, { data: others }] = await Promise.all([
      db.from("staff_profiles").select("working_days").eq("id", staffId).maybeSingle(),
      db.from("staff_holidays").select("id, date_from, date_to").eq("staff_id", staffId).lt("date_from", from),
    ]);
    const days = new Set(String(sp?.working_days || "mon,tue,wed,thu,fri").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean));
    if (!days.size) ["mon", "tue", "wed", "thu", "fri"].forEach((d) => days.add(d));
    const off = (iso: string) => (others || []).some((o) => o.id !== excludeHolidayId && iso >= o.date_from && iso <= o.date_to);
    const working = (iso: string) => days.has(DOW[new Date(`${iso}T12:00:00Z`).getUTCDay()]) && !off(iso);
    let d = shiftISO(from, -1); let guard = 0;
    while (!working(d) && guard++ < 60) d = shiftISO(d, -1);        // last working day before going off
    for (let n = 0; n < 2 && guard < 120; guard++) { d = shiftISO(d, -1); if (working(d)) n++; } // two full working days earlier
    return d;
  }

  interface TaskInfo { date: string | null; deadline: string | null; line: string; context: string | null }
  /** What a task is, when it falls, its hard deadline, and a line for the handover email. */
  async function taskInfo(t: { type: string; id: string; occurrence_date: string | null }, ownerId: string): Promise<TaskInfo | null> {
    const fmtD = (iso: string | null) => (iso ? new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }) : "");
    if (t.type === "ms") {
      const { data: m } = await db.from("job_milestones").select("id, label, due_date, hours, owner_id, status, note, job_plans(entity_id, period_end, ch_deadline, status, entities(name))").eq("id", t.id).maybeSingle();
      if (!m || m.owner_id !== ownerId) return null;
      const p = m.job_plans as Record<string, any>;
      return { date: m.due_date, deadline: p?.ch_deadline || null, line: `${p?.entities?.name || "Client"} – ${m.label} (plan stage, ${fmtD(m.due_date)}${m.hours ? `, ${Number(m.hours)}h` : ""})`, context: `Year end ${fmtD(p?.period_end)}; Companies House deadline ${fmtD(p?.ch_deadline)}.${m.note ? ` ${m.note}` : ""}` };
    }
    if (t.type === "bm") {
      const { data: b } = await db.from("bm_task_schedule").select("id, bm_task_name, scheduled_for_date, bm_deadline, bm_status, scheduled_hours, assignee_id, entities(name)").eq("id", t.id).maybeSingle();
      if (!b || b.assignee_id !== ownerId) return null;
      return { date: b.scheduled_for_date, deadline: b.bm_deadline, line: `${(b.entities as Record<string, any>)?.name || "Client"} – ${shortName(b.bm_task_name)} (${fmtD(b.scheduled_for_date)}${b.scheduled_hours ? `, ${Number(b.scheduled_hours)}h` : ""})`, context: `BM status ${b.bm_status || "—"}; statutory deadline ${fmtD(b.bm_deadline) || "none"}.` };
    }
    if (t.type === "quick") {
      const { data: q } = await db.from("quick_tasks").select("id, title, planned_date, due_date, notes, assignee_id, entities(name)").eq("id", t.id).maybeSingle();
      if (!q || q.assignee_id !== ownerId) return null;
      const date = (q.planned_date || q.due_date || "").slice(0, 10) || null;
      return { date, deadline: q.due_date ? String(q.due_date).slice(0, 10) : null, line: `${(q.entities as Record<string, any>)?.name ? `${(q.entities as Record<string, any>).name} – ` : ""}${q.title} (quick task${date ? `, ${fmtD(date)}` : ""})`, context: q.notes || null };
    }
    const { data: bl } = await db.from("scheduled_tasks").select("id, title, block_kind, duration, assignee_id, entity_id").eq("id", t.id).maybeSingle();
    if (!bl || bl.assignee_id !== ownerId) return null;
    const { data: items } = await db.from("standing_block_items").select("entity_id, entities(name)").eq("block_id", t.id);
    const names = (items || []).map((i) => (i.entities as Record<string, any>)?.name).filter(Boolean);
    return { date: t.occurrence_date, deadline: null, line: `${bl.title} (block, ${fmtD(t.occurrence_date)}, ${Math.round((bl.duration || 0) / 6) / 10}h)`, context: names.length ? `Clients: ${names.join(", ")}.` : null };
  }

  /** Rule 2: everything of the owner's whose date falls inside the holiday (blocks come from the browser). */
  async function holidayTasks(h: Record<string, any>) {
    const [{ data: ms }, { data: bm }, { data: qt }, { data: comps }] = await Promise.all([
      db.from("job_milestones").select("id, label, due_date, hours, job_plans!inner(status, entity_id, ch_deadline, entities(name))").eq("owner_id", h.staff_id).eq("status", "pending").eq("job_plans.status", "committed").gte("due_date", h.date_from).lte("due_date", h.date_to),
      db.from("bm_task_schedule").select("id, bm_task_name, scheduled_for_date, bm_deadline, scheduled_hours, entities(name)").eq("assignee_id", h.staff_id).eq("state", "planned").is("excluded_at", null).or(`and(scheduled_for_date.gte.${h.date_from},scheduled_for_date.lte.${h.date_to}),and(bm_deadline.gte.${h.date_from},bm_deadline.lte.${h.date_to})`),
      db.from("quick_tasks").select("id, title, planned_date, due_date, duration, entities(name)").eq("assignee_id", h.staff_id),
      db.from("bm_task_completions").select("bm_task_schedule_id").is("confirmed_at", null),
    ]);
    const done = new Set((comps || []).map((c) => c.bm_task_schedule_id));
    const out: Array<Record<string, unknown>> = [];
    for (const m of ms || []) out.push({ type: "ms", id: m.id, occurrence_date: null, date: m.due_date, deadline: (m.job_plans as Record<string, any>)?.ch_deadline || null, title: m.label, client: (m.job_plans as Record<string, any>)?.entities?.name || null, hours: Number(m.hours) || 0 });
    for (const b of bm || []) if (!done.has(b.id)) out.push({ type: "bm", id: b.id, occurrence_date: null, date: b.scheduled_for_date, deadline: b.bm_deadline, title: shortName(b.bm_task_name), client: (b.entities as Record<string, any>)?.name || null, hours: Number(b.scheduled_hours) || 0 });
    for (const q of qt || []) {
      const date = (q.planned_date || q.due_date || "").slice(0, 10);
      if (!date || date < h.date_from || date > h.date_to) continue;
      out.push({ type: "quick", id: q.id, occurrence_date: null, date, deadline: q.due_date ? String(q.due_date).slice(0, 10) : null, title: q.title, client: (q.entities as Record<string, any>)?.name || null, hours: (q.duration || 15) / 60 });
    }
    return out;
  }

  async function moveTask(t: { type: string; id: string }, iso: string) {
    if (t.type === "ms") {
      const { error } = await db.from("job_milestones").update({ due_date: iso, pinned_by: me, pinned_at: now, updated_at: now }).eq("id", t.id);
      if (error) throw new Error(error.message);
    } else if (t.type === "bm") {
      const { error } = await db.from("bm_task_schedule").update({ scheduled_for_date: iso, manually_overridden_at: now, manually_overridden_by: me }).eq("id", t.id);
      if (error) throw new Error(error.message);
    } else if (t.type === "quick") {
      const { error } = await db.from("quick_tasks").update({ planned_date: `${iso}T09:00:00+00:00`, updated_at: now }).eq("id", t.id);
      if (error) throw new Error(error.message);
    }
  }

  async function handoverUpdateEmail(coverId: string, h: Record<string, any>, line: string) {
    const [{ data: who }, { data: meRow }, { data: settings }] = await Promise.all([
      db.from("staff_profiles").select("name, email").eq("id", coverId).maybeSingle(),
      db.from("staff_profiles").select("name").eq("id", me).maybeSingle(),
      db.from("job_plan_settings").select("comms_mailbox").eq("id", true).maybeSingle(),
    ]);
    if (!who?.email) return;
    const first = String(meRow?.name || "").split(" ")[0];
    await sendGeneric(db, { entityId: null, to: who.email, subject: `Handover update – ${h.date_from} to ${h.date_to}`, text: `Hi ${String(who.name || "").split(" ")[0]},\n\nA change to my handover:\n\n• ${line}\n\nThanks,\n${first}`, ownerId: me, mailbox: settings?.comms_mailbox || null });
  }

  // Templates by key (annual_accounts, self_assessment — sql/304, sql/322)
  // or by the id a plan already carries.
  async function template(keyOrId?: string | null) {
    const byId = !!keyOrId && UUID.test(keyOrId);
    let q = db.from("workflow_templates").select("id, key").eq("active", true);
    q = byId ? q.eq("id", keyOrId!) : q.eq("key", keyOrId || TEMPLATE_KEY);
    const { data: t, error } = await q.maybeSingle();
    if (error) throw new Error(error.message);
    if (!t) throw new BadRequest("That workflow template is not set up", 500);
    const { data: stages, error: sErr } = await db.from("workflow_stages").select("*").eq("template_id", t.id).order("seq");
    if (sErr) throw new Error(sErr.message);
    return { id: t.id as string, key: t.key as string, stages: (stages || []) as StageRule[] };
  }

  /** The job at (client, period end): a set of accounts, or a self assessment. */
  async function accountsJob(entityId: string, periodEnd: string, templateKey?: string | null) {
    const tryView = async (view: string) => {
      const { data, error } = await db.from(view).select("*").eq("entity_id", entityId).eq("period_end", periodEnd).maybeSingle();
      if (error) throw new Error(error.message);
      return data;
    };
    const order = templateKey === "self_assessment" ? ["v_sa_jobs", "v_accounts_jobs"] : ["v_accounts_jobs", "v_sa_jobs"];
    for (const v of order) {
      const data = await tryView(v);
      if (data) return { ...data, template_key: data.template_key || "annual_accounts" };
    }
    throw new BadRequest("No planned accounts or self assessment job for that client and period end", 404);
  }

  async function loadPlan(planId: string) {
    const { data, error } = await db.from("job_plans").select("*").eq("id", planId).maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new BadRequest("Plan not found", 404);
    return data;
  }

  async function milestonesOf(planId: string) {
    const { data, error } = await db.from("job_milestones").select("*").eq("plan_id", planId).order("seq");
    if (error) throw new Error(error.message);
    return data || [];
  }

  /** Owners by role, and the variant defaults, from the allocations data. */
  async function resolveContext(entityId: string, job: Record<string, unknown>, plan: { has_meeting: boolean | null; books_with_us: boolean | null } | null) {
    const [inferred, alloc, reviewers, meeting] = await Promise.all([
      db.from("v_inferred_allocations").select("canonical_service_id, assignee_id").eq("entity_id", entityId),
      db.from("client_service_allocations").select("service_id, fee_earner_id, fee_earner_manager_id").eq("entity_id", entityId),
      db.from("service_reviewers").select("canonical_service_id, reviewer_id").eq("entity_id", entityId),
      // Does the client get an annual review meeting? sql/306: a manual
      // answer set by the team wins, else "billed" when the live QuickBooks
      // templates carry the Review Meetings line, else none.
      db.from("v_client_review_meeting").select("has_meeting, basis, note").eq("entity_id", entityId).maybeSingle(),
    ]);
    for (const r of [inferred, alloc, reviewers, meeting]) if (r.error) throw new Error(r.error.message);
    const inf = (k: string) => inferred.data?.find((x) => x.canonical_service_id === k)?.assignee_id ?? null;
    const al = (k: string) => alloc.data?.find((x) => x.service_id === k) ?? null;

    const preparer = (job.preparer_id as string | null) ?? inf("accounts_preparation") ?? null;
    const clientManager = al("accounts_ct")?.fee_earner_manager_id ?? inf("accounts_submission") ?? preparer;
    const reviewer = reviewers.data?.find((x) => x.canonical_service_id === "accounts_preparation")?.reviewer_id ?? clientManager;
    const bookkeeper = inf("bookkeeping") ?? al("bookkeeping_vat")?.fee_earner_id ?? preparer;

    const meetingDefault = !!meeting.data?.has_meeting;
    const meetingBasis = meeting.data?.basis ?? "none";
    const booksDefault = !!inf("bookkeeping") || !!al("bookkeeping_vat");

    const owners: Record<string, string | null> = {
      preparer, client_manager: clientManager, reviewer, bookkeeper, client: null,
    };
    const ids = [...new Set(Object.values(owners).filter(Boolean))] as string[];
    const workingDays: Record<string, string | null> = {};
    if (ids.length) {
      const { data: staff, error } = await db.from("staff_profiles").select("id, working_days").in("id", ids);
      if (error) throw new Error(error.message);
      for (const s of staff || []) workingDays[s.id] = s.working_days;
    }
    return {
      owners, workingDays,
      hasMeeting: plan?.has_meeting ?? meetingDefault,
      booksWithUs: plan?.books_with_us ?? booksDefault,
      meetingDefault, meetingBasis, booksDefault,
    };
  }

  /**
   * Build or rebuild the chain for a plan. Pinned milestones keep their date
   * and owner; done milestones keep everything; the rest are recomputed and
   * removed stages come back as pending (a variant switch may have brought
   * them back deliberately).
   */
  async function rebuild(plan: Record<string, unknown>, job: Record<string, unknown>) {
    const t = await template((plan.template_id as string) || (job.template_key as string));
    const ctx0 = await resolveContext(plan.entity_id as string, job, plan as { has_meeting: boolean | null; books_with_us: boolean | null });
    const existing = await milestonesOf(plan.id as string);
    const keep = new Map(existing.filter((m) => m.pinned_by || m.status === "done").map((m) => [m.stage_key, m]));
    const ctx: JobContext = {
      periodEnd: plan.period_end as string,
      chDeadline: (job.ch_deadline as string | null) ?? null,
      ctDeadline: (job.ct_deadline as string | null) ?? null,
      hasMeeting: ctx0.hasMeeting,
      booksWithUs: ctx0.booksWithUs,
      owners: ctx0.owners,
      workingDays: ctx0.workingDays,
      pinned: Object.fromEntries([...keep.values()].map((m) => [m.stage_key, m.due_date])),
    };
    const chain = computeChain(t.stages, ctx);
    const chainKeys = new Set(chain.map((m) => m.stage_key));

    // Stages no longer in the variant go; kept ones are untouched.
    const gone = existing.filter((m) => !chainKeys.has(m.stage_key)).map((m) => m.id);
    if (gone.length) {
      const { error } = await db.from("job_milestones").delete().in("id", gone);
      if (error) throw new Error(error.message);
    }
    const viaVat = !!job.vat_covers_year_end;
    const rows = chain.filter((m) => !keep.has(m.stage_key)).map((m) => {
      const prior = existing.find((x) => x.stage_key === m.stage_key);
      const gap = viaVat && m.stage_key === "request_records";
      return {
        plan_id: plan.id, stage_key: m.stage_key, seq: m.seq,
        label: gap ? GAP_REQUEST_LABEL : m.label, kind: m.kind, hours: m.hours,
        owner_role: m.owner_role,
        owner_id: prior?.owner_id ?? m.owner_id,
        due_date: m.due_date, planned_date: m.planned_date,
        status: "pending", note: prior?.note ?? (gap ? GAP_REQUEST_NOTE : null), updated_at: now,
      };
    });
    if (rows.length) {
      const { error } = await db.from("job_milestones").upsert(rows, { onConflict: "plan_id,stage_key" });
      if (error) throw new Error(error.message);
    }
    const { error: pErr } = await db.from("job_plans").update({
      has_meeting: plan.has_meeting ?? null, books_with_us: plan.books_with_us ?? null,
      prep_job_id: job.prep_job_id ?? null, ch_job_id: job.ch_job_id ?? null, ct_job_id: job.ct_job_id ?? null,
      ch_deadline: job.ch_deadline ?? null, ct_deadline: job.ct_deadline ?? null,
      records_via_vat: viaVat,
      planned_by: me, planned_at: now, updated_at: now,
    }).eq("id", plan.id);
    if (pErr) throw new Error(pErr.message);
    return { defaults: { has_meeting: ctx0.meetingDefault, meeting_basis: ctx0.meetingBasis, books_with_us: ctx0.booksDefault, owners: ctx0.owners } };
  }

  async function propose(entityId: string, periodEnd: string, hasMeeting: boolean | null, booksWithUs: boolean | null, replan: boolean, templateKey?: string | null) {
    const job = await accountsJob(entityId, periodEnd, templateKey);
    const t = await template(job.template_key as string);
    let plan: Record<string, unknown>;
    const { data: found, error } = await db.from("job_plans").select("*")
      .eq("entity_id", entityId).eq("period_end", periodEnd).eq("template_id", t.id).maybeSingle();
    if (error) throw new Error(error.message);
    if (found) {
      if (found.status === "committed" && !replan) throw new BadRequest("This job is already planned and committed", 409);
      plan = { ...found, status: "draft",
        has_meeting: hasMeeting ?? found.has_meeting, books_with_us: booksWithUs ?? found.books_with_us };
      const { error: uErr } = await db.from("job_plans").update({ status: "draft", committed_at: null, committed_by: null }).eq("id", found.id);
      if (uErr) throw new Error(uErr.message);
    } else {
      const { data: created, error: cErr } = await db.from("job_plans").insert({
        template_id: t.id, entity_id: entityId, period_end: periodEnd,
        has_meeting: hasMeeting, books_with_us: booksWithUs, status: "draft",
        planned_by: me, planned_at: now,
      }).select("*").single();
      if (cErr) throw new Error(cErr.message);
      plan = created;
    }
    const extra = await rebuild(plan, job);
    return { plan: await loadPlan(plan.id as string), milestones: await milestonesOf(plan.id as string), ...extra };
  }

  async function commit(planId: string) {
    const plan = await loadPlan(planId);
    const ms = await milestonesOf(planId);
    const open = ms.filter((m) => m.status === "pending");
    if (!open.length) throw new BadRequest("Nothing to commit — every stage is removed");
    const unowned = open.filter((m) => m.owner_role !== "client" && !m.owner_id);
    if (unowned.length) throw new BadRequest(`Choose an owner for: ${unowned.map((m) => m.label).join(", ")}`);
    const { error } = await db.from("job_plans").update({
      status: "committed", committed_by: me, committed_at: now, updated_at: now,
    }).eq("id", planId);
    if (error) throw new Error(error.message);
    return { plan: await loadPlan(planId), milestones: ms };
  }

  // ── Priority board and progress updates (sql/349) ─────────────────────────
  // The board itself lives in _shared/priority-board.ts, shared with the
  // Monday priority-email. "Applying" a column pins the queue's dates on the
  // workflows, creating a draft workflow for a job that has none.
  function priorityTemplate(v: unknown): string {
    const k = v ? String(v) : "annual_accounts";
    if (!PRIORITY_TEMPLATES.includes(k)) throw new BadRequest("template must be annual_accounts or self_assessment");
    return k;
  }
  const buildBoard = (templateKey: string, onlyStaff?: string | null) => buildBoardShared(db, templateKey, onlyStaff);

  /** Pin each job's Internal review to the queue's date. A job with no
   *  workflow gets a draft first. Returns how many dates moved. */
  async function applyColumn(templateKey: string, staffId: string) {
    const board = await buildBoard(templateKey, staffId);
    const col = board.columns.find((c) => c.staff_id === staffId);
    if (!col) return { moved: 0, created: 0, failed: [] as string[] };
    const todo = col.jobs.filter((j) => j.out_of_date && j.review_computed);
    let moved = 0, created = 0;
    const failed: string[] = [];
    const one = async (j: Record<string, any>) => {
      try {
        const job = await accountsJob(j.entity_id, j.period_end, templateKey);
        let planId = j.plan_id as string | null;
        let plan: Record<string, any>;
        if (!planId) {
          const out = await propose(j.entity_id, j.period_end, null, null, false, templateKey);
          plan = out.plan; planId = plan.id; created++;
        } else plan = await loadPlan(planId);
        const { data: rev } = await db.from("job_milestones").select("id, status, kind").eq("plan_id", planId).eq("stage_key", "internal_review").maybeSingle();
        if (!rev || rev.status !== "pending") return;
        const { error } = await db.from("job_milestones").update({
          due_date: j.review_computed, planned_date: rev.kind === "work" ? j.review_computed : null,
          pinned_by: me, pinned_at: now, updated_at: now,
        }).eq("id", rev.id);
        if (error) throw new Error(error.message);
        await rebuild(plan, job); // preparation and the client step follow the review
        moved++;
      } catch (e) { failed.push(`${j.client}: ${(e as Error).message}`); }
    };
    for (let i = 0; i < todo.length; i += 6) await Promise.all(todo.slice(i, i + 6).map(one));
    return { moved, created, failed };
  }

  async function writeRanks(templateKey: string, staffId: string, keys: string[]) {
    const rows = keys.map((k, i) => {
      const [entity_id, period_end] = k.split("|");
      return { template_key: templateKey, entity_id: uuid(entity_id, "entity_id"), period_end: isoDate(period_end, "period_end"), staff_id: staffId, rank: (i + 1) * 10, updated_by: me, updated_at: now };
    });
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await db.from("job_priority").upsert(rows.slice(i, i + 500), { onConflict: "template_key,entity_id,period_end" });
      if (error) throw new Error(error.message);
    }
  }

  try {
    switch (p.action) {
      case "priority_board": {
        const out = await buildBoard(priorityTemplate(p.template), p.staff_id ? uuid(p.staff_id, "staff_id") : null);
        return json({ success: true, ...out });
      }

      // The column in its new order (every job key "entity|period_end"),
      // then the dates written. apply=false only saves the order.
      case "priority_reorder": {
        const tKey = priorityTemplate(p.template);
        const staffId = uuid(p.staff_id, "staff_id");
        const keys: string[] = Array.isArray(p.keys) ? p.keys.map(String) : [];
        if (!keys.length) throw new BadRequest("keys required");
        if (keys.length > 400) throw new BadRequest("At most 400 jobs in a column");
        await writeRanks(tKey, staffId, keys);
        const applied = p.apply === false ? null : await applyColumn(tKey, staffId);
        const board = await buildBoard(tKey, staffId);
        return json({ success: true, applied, column: board.columns.find((c) => c.staff_id === staffId) || null });
      }

      case "priority_apply": {
        const tKey = priorityTemplate(p.template);
        const staffId = uuid(p.staff_id, "staff_id");
        const applied = await applyColumn(tKey, staffId);
        const board = await buildBoard(tKey, staffId);
        return json({ success: true, applied, column: board.columns.find((c) => c.staff_id === staffId) || null });
      }

      case "priority_set_hours": {
        const tKey = priorityTemplate(p.template);
        const staffId = uuid(p.staff_id, "staff_id");
        const hours = Number(p.weekly_hours);
        if (!Number.isFinite(hours) || hours < 0 || hours > 80) throw new BadRequest("Hours a week must be between 0 and 80");
        const { error } = await db.from("priority_capacity").upsert({ staff_id: staffId, template_key: tKey, weekly_hours: hours, updated_by: me, updated_at: now }, { onConflict: "staff_id,template_key" });
        if (error) throw new Error(error.message);
        const applied = p.apply === false ? null : await applyColumn(tKey, staffId);
        const board = await buildBoard(tKey, staffId);
        return json({ success: true, applied, column: board.columns.find((c) => c.staff_id === staffId) || null });
      }

      // ── Deprioritise (Bobby, 2026-10-07) ─────────────────────────────────
      // The client-level flag Ready Now and the Job Selector already read
      // (entities.deprioritise_reason / deprioritised_at), now written here
      // with a line in entity_priority_log. reason null = back in the queue.
      case "set_deprioritised": {
        const entityId = uuid(p.entity_id, "entity_id");
        const reason = p.reason ? String(p.reason).slice(0, 200).trim() : null;
        const { error } = await db.from("entities").update(reason ? { deprioritise_reason: reason, deprioritised_at: now } : { deprioritise_reason: null, deprioritised_at: null }).eq("id", entityId);
        if (error) throw new Error(error.message);
        await db.from("entity_priority_log").insert({ entity_id: entityId, action: reason ? "deprioritise" : "reprioritise", reason, user_id: me });

        // Triage (Bobby, 2026-10-07): deprioritising opens a case on the Triage
        // Board — one open case per client at any time, so an existing open
        // case gets a note instead. Putting the client back resolves a case
        // this opened; a case opened some other way just gets the note.
        const { data: openCases } = await db.from("triage_cases").select("id, source").eq("entity_id", entityId).eq("status", "open").order("created_at");
        const existing = (openCases || [])[0] || null;
        let triage: string | null = null;
        if (reason) {
          if (existing) {
            await db.from("triage_case_notes").insert({ case_id: existing.id, author_id: me, body: `Deprioritised on the Priority board: ${reason}` });
            triage = "noted";
          } else {
            const strike = /struck off/i.test(reason);
            const { error: tErr } = await db.from("triage_cases").insert({
              entity_id: entityId, category: strike ? "strike_off" : "on_hold", stage: strike ? "not_started" : "on_hold", status: "open",
              source: "deprioritised", title: `Deprioritised: ${reason}`,
              description: `Taken out of the work queues (Priority board, Ready Now, Job Selector) because: ${reason}.`,
              next_action: "Find out what's needed, then put the client back in the queue or close them off",
              created_by: me,
            });
            if (tErr) throw new Error(tErr.message);
            triage = "opened";
          }
        } else if (existing) {
          if (existing.source === "deprioritised") {
            await db.from("triage_cases").update({ status: "resolved", stage: "completed", resolved_at: now, resolved_by: me }).eq("id", existing.id);
            triage = "resolved";
          } else triage = "noted";
          await db.from("triage_case_notes").insert({ case_id: existing.id, author_id: me, body: "Put back in the queue on the Priority board" });
        }
        return json({ success: true, triage });
      }

      // ── Directors' other income (sql/351) ────────────────────────────────
      // A company's current directors who are clients in their own right, with
      // their next open self assessment: who a personal item can be for.
      case "company_directors": {
        const companyId = uuid(p.entity_id, "entity_id");
        const { data: eps, error } = await db.from("entity_people").select("person_id").eq("entity_id", companyId).eq("role", "director").is("ended_on", null);
        if (error) throw new Error(error.message);
        const persons = (eps || []).map((e: Record<string, any>) => e.person_id);
        if (!persons.length) return json({ success: true, directors: [] });
        const { data: ents } = await db.from("entities").select("id, name, entity_status").in("linked_person_id", persons);
        const out = [];
        for (const e of (ents || []) as Record<string, any>[]) {
          if (["nlac", "archived"].includes(e.entity_status)) continue;
          const { data: job } = await db.from("v_sa_jobs").select("period_end, ch_deadline").eq("entity_id", e.id).gte("ch_deadline", now.slice(0, 10)).order("ch_deadline").limit(1).maybeSingle();
          out.push({ entity_id: e.id, name: e.name, period_end: job?.period_end ?? null, deadline: job?.ch_deadline ?? null });
        }
        return json({ success: true, directors: out });
      }

      case "income_items": {
        const entityId = uuid(p.entity_id, "entity_id");
        const periodEnd = isoDate(p.period_end, "period_end");
        const [{ data, error }, { data: cat }] = await Promise.all([
          db.from("sa_income_items").select("*").eq("entity_id", entityId).eq("period_end", periodEnd).order("created_at"),
          db.from("records_items").select("key, label").eq("grp", "personal").eq("active", true).order("sort_order"),
        ]);
        if (error) throw new Error(error.message);
        return json({ success: true, items: data || [], catalogue: cat || [] });
      }

      case "income_item_add": {
        const entityId = uuid(p.entity_id, "entity_id");
        const periodEnd = isoDate(p.period_end, "period_end");
        const key = p.item_key ? String(p.item_key).slice(0, 60) : null;
        const text = p.custom_text ? String(p.custom_text).slice(0, 300).trim() : null;
        if (!key && !text) throw new BadRequest("Pick an item or type one");
        const row = { entity_id: entityId, period_end: periodEnd, item_key: key, custom_text: key ? null : text, requested_at: p.requested ? now : null, requested_by: p.requested ? me : null, created_by: me };
        const { error } = key
          ? await db.from("sa_income_items").upsert(row, { onConflict: "entity_id,period_end,item_key", ignoreDuplicates: true })
          : await db.from("sa_income_items").insert(row);
        if (error) throw new Error(error.message);
        return json({ success: true });
      }

      case "income_item_received": {
        const id = uuid(p.id, "id");
        const received = p.received !== false;
        const { error } = await db.from("sa_income_items").update(received ? { received_at: now, received_by: me } : { received_at: null, received_by: null }).eq("id", id);
        if (error) throw new Error(error.message);
        return json({ success: true });
      }

      case "income_item_remove": {
        const { error } = await db.from("sa_income_items").delete().eq("id", uuid(p.id, "id"));
        if (error) throw new Error(error.message);
        return json({ success: true });
      }

      // Delay and stuck reports still open (sql/350), newest first.
      case "progress_reports": {
        const { data, error } = await db.from("job_progress_updates").select("*, entities(name)").eq("status", "open").order("created_at", { ascending: false }).limit(200);
        if (error) throw new Error(error.message);
        return json({ success: true, reports: data || [] });
      }

      case "report_dealt_with": {
        const id = uuid(p.id, "id");
        const note = p.note ? String(p.note).slice(0, 2000) : null;
        const { data, error } = await db.from("job_progress_updates").update({ status: "dealt_with", dealt_with_by: me, dealt_with_at: now, dealt_with_note: note })
          .eq("id", id).eq("status", "open").select("id").maybeSingle();
        if (error) throw new Error(error.message);
        if (!data) throw new BadRequest("That report is not open", 409);
        return json({ success: true });
      }

      case "progress_history": {
        const tKey = priorityTemplate(p.template);
        const { data, error } = await db.from("job_progress_updates").select("*").eq("template_key", tKey)
          .eq("entity_id", uuid(p.entity_id, "entity_id")).eq("period_end", isoDate(p.period_end, "period_end")).order("created_at", { ascending: false }).limit(50);
        if (error) throw new Error(error.message);
        return json({ success: true, updates: data || [] });
      }

      // Progress update (replaces Job Review). A new date re-ranks the job in
      // its preparer's column, ahead of the first job the queue dates later,
      // and the column is re-applied: the order stays the one source of dates.
      case "progress_update": {
        const tKey = priorityTemplate(p.template);
        const entityId = uuid(p.entity_id, "entity_id");
        const periodEnd = isoDate(p.period_end, "period_end");
        const confidence = String(p.confidence || "");
        if (!["green", "amber", "red"].includes(confidence)) throw new BadRequest("Pick green, amber or red");
        const reason = p.reason_code ? String(p.reason_code) : null;
        if (reason) {
          const { data: r } = await db.from("job_review_reason").select("code").eq("code", reason).eq("active", true).maybeSingle();
          if (!r) throw new BadRequest("Unknown reason");
        }
        const note = p.note ? String(p.note).slice(0, 4000) : null;
        if (confidence !== "green" && !reason && !note) throw new BadRequest("Say what's in the way — a reason or a note");
        // amber = Delayed, red = Stuck: a report, open until dealt with (sql/350).
        const isReport = confidence !== "green";
        const requested = p.review_date ? isoDate(p.review_date, "review_date") : null;
        const job = await accountsJob(entityId, periodEnd, tKey);
        // Same column rule as buildBoard: the Submission task's owner, else the preparer.
        let staffId = (job.preparer_id as string | null) ?? null;
        if (job.ch_job_id) {
          const { data: ch } = await db.from("bm_task_schedule").select("assignee_id").eq("id", job.ch_job_id as string).maybeSingle();
          if (ch?.assignee_id) staffId = ch.assignee_id;
        }

        const before = staffId ? (await buildBoard(tKey, staffId)).columns.find((c) => c.staff_id === staffId) : null;
        const mineBefore = before?.jobs.find((j) => j.key === jobKey(entityId, periodEnd)) || null;
        let after: string | null = mineBefore?.review_saved ?? null;
        let applied = null;
        if (requested) {
          if (!before || !mineBefore) throw new BadRequest("This job isn't on the Priority board (no one on its Submission or Preparation task, or no filing in the next six months), so its date can't be moved from here");
          if (mineBefore.group === "director") throw new BadRequest(`${mineBefore.client}'s return rides with ${mineBefore.follows?.company || "their company"}: move the company's accounts instead`);
          if (mineBefore.limit && requested > mineBefore.limit) throw new BadRequest(`That's past the latest safe date (${mineBefore.limit}: the statutory date less the buffer)`);
          const others = before.jobs.filter((j) => j.key !== mineBefore.key);
          const at = others.findIndex((j) => !j.review_done && String(j.review_saved || j.review_computed) > requested);
          const keys = others.map((j) => j.key);
          keys.splice(at < 0 ? keys.length : at, 0, mineBefore.key);
          await writeRanks(tKey, staffId!, keys);
          applied = await applyColumn(tKey, staffId!);
          const col = (await buildBoard(tKey, staffId)).columns.find((c) => c.staff_id === staffId);
          after = col?.jobs.find((j) => j.key === mineBefore.key)?.review_saved ?? null;
        }
        const { data: plan } = await db.from("job_plans").select("id").eq("entity_id", entityId).eq("period_end", periodEnd).eq("template_id", (await template(tKey)).id).maybeSingle();
        const { data: row, error } = await db.from("job_progress_updates").insert({
          template_key: tKey, entity_id: entityId, period_end: periodEnd, plan_id: plan?.id ?? null, author_id: me,
          confidence, reason_code: reason, escalate: isReport, note, status: isReport ? "open" : null,
          review_date_before: mineBefore?.review_saved ?? null, review_date_requested: requested, review_date_after: after,
        }).select("*").single();
        if (error) throw new Error(error.message);

        // A report tells the people in priority_email_config.report_recipient_ids
        // straight away: the bell, and an email unless report_emails_enabled is off.
        let escalated = 0;
        if (isReport) {
          const { data: cfg } = await db.from("priority_email_config").select("report_recipient_ids, report_emails_enabled").eq("id", true).maybeSingle();
          const ids = ((cfg?.report_recipient_ids as string[]) || []).filter((x) => x !== me);
          const [{ data: people }, { data: author }, { data: ent }, { data: why }] = await Promise.all([
            ids.length ? db.from("staff_profiles").select("id, name, email").in("id", ids).eq("is_active", true) : Promise.resolve({ data: [] }),
            db.from("staff_profiles").select("name").eq("id", me).maybeSingle(),
            db.from("entities").select("name").eq("id", entityId).maybeSingle(),
            reason ? db.from("job_review_reason").select("label").eq("code", reason).maybeSingle() : Promise.resolve({ data: null }),
          ]);
          const who = String(author?.name || "A colleague");
          const client = ent?.name || "a client";
          const kind = confidence === "red" ? "Stuck" : "Delayed";
          const service = tKey === "self_assessment" ? "self assessment" : "accounts";
          const athena = Deno.env.get("PORTAL_PUBLIC_URL") || "https://portal.almondvalleyaccounting.co.uk";
          const link = `${athena}/planner/priority?template=${tKey}&report=${row.id}`;
          const fmtUk = (iso: string | null) => (iso ? new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "—");
          const escHtml = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
          const lines = [
            `${who} has reported ${client} (${service}, year end ${fmtUk(periodEnd)}) as ${kind.toUpperCase()}.`,
            why?.label ? `Reason: ${why.label}` : null,
            note ? `Note: ${note}` : null,
            requested
              ? `Asked to move internal review to ${fmtUk(requested)}; it is now ${fmtUk(after)} (was ${fmtUk(mineBefore?.review_saved ?? null)}).`
              : `Internal review: ${fmtUk(mineBefore?.review_saved ?? mineBefore?.review_computed ?? null)}.`,
            mineBefore?.ch_deadline ? `Statutory deadline: ${fmtUk(mineBefore.ch_deadline)}.` : null,
          ].filter((x): x is string => !!x);
          for (const m of (people || []) as Record<string, any>[]) {
            const { error: nErr } = await db.from("notifications").insert({
              recipient_id: m.id, kind: "progress_report",
              title: `${kind}: ${client} (${service})`,
              body: `${who.split(" ")[0]}: ${[why?.label, note].filter(Boolean).join(" — ")}`,
              link_path: `/planner/priority?template=${tKey}&report=${row.id}`, source_key: `progress:${row.id}:${m.id}`,
            });
            if (!nErr) escalated++;
            if (cfg?.report_emails_enabled !== false && m.email) {
              const html = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#1e293b;line-height:1.55">${lines.map((l) => `<p style="margin:0 0 8px">${escHtml(l)}</p>`).join("")}<p style="margin:14px 0 0"><a href="${link}" style="background:#1E4560;color:#fff;text-decoration:none;padding:9px 16px;border-radius:8px;font-weight:600">Open it on the Priority board</a></p></div>`;
              const r = await sendEmail({ to: m.email, subject: `${kind}: ${client} — reported by ${who.split(" ")[0]}`, html, text: [...lines, "", `Open it on the Priority board: ${link}`].join("\n") });
              if (!r.ok) console.error("report email failed", r.error);
            }
          }
        }
        return json({ success: true, update: row, applied, review_date: after, escalated });
      }

      case "propose": {
        const out = await propose(
          uuid(p.entity_id, "entity_id"), isoDate(p.period_end, "period_end"),
          optBool(p.has_meeting), optBool(p.books_with_us), p.replan === true, p.template ? String(p.template) : null,
        );
        return json({ success: true, ...out });
      }

      case "save": {
        const plan = await loadPlan(uuid(p.plan_id, "plan_id"));
        if (plan.status !== "draft") throw new BadRequest("Take the plan back to draft before editing it", 409);
        const hasMeeting = p.has_meeting === undefined ? plan.has_meeting : optBool(p.has_meeting);
        const booksWithUs = p.books_with_us === undefined ? plan.books_with_us : optBool(p.books_with_us);
        const note = p.note === undefined ? plan.note : (p.note ? String(p.note).slice(0, 4000) : null);
        const variantChanged = hasMeeting !== plan.has_meeting || booksWithUs !== plan.books_with_us;
        const { error } = await db.from("job_plans").update({ has_meeting: hasMeeting, books_with_us: booksWithUs, note, updated_at: now }).eq("id", plan.id);
        if (error) throw new Error(error.message);

        const items: Array<Record<string, unknown>> = Array.isArray(p.milestones) ? p.milestones : [];
        const existing = await milestonesOf(plan.id);
        for (const it of items) {
          const key = String(it.stage_key ?? "");
          const m = existing.find((x) => x.stage_key === key);
          if (!m) continue;
          const patch: Record<string, unknown> = { updated_at: now };
          if (it.due_date !== undefined) patch.due_date = isoDate(it.due_date, "due_date");
          if (it.planned_date !== undefined) patch.planned_date = it.planned_date ? isoDate(it.planned_date, "planned_date") : null;
          if (it.owner_id !== undefined) patch.owner_id = it.owner_id ? uuid(it.owner_id, "owner_id") : null;
          if (it.note !== undefined) patch.note = it.note ? String(it.note).slice(0, 2000) : null;
          if (it.status !== undefined) {
            const s = String(it.status);
            if (!["pending", "removed", "skipped"].includes(s)) throw new BadRequest("status must be pending, removed or skipped");
            patch.status = s;
          }
          if (it.pinned !== undefined) {
            patch.pinned_by = it.pinned ? me : null;
            patch.pinned_at = it.pinned ? now : null;
          }
          // A date or owner set by hand is a pin: the engine must not undo it.
          if ((it.due_date !== undefined && it.due_date !== m.due_date) || (it.owner_id !== undefined && it.owner_id !== m.owner_id)) {
            if (it.pinned === undefined) { patch.pinned_by = me; patch.pinned_at = now; }
          }
          const { error: mErr } = await db.from("job_milestones").update(patch).eq("id", m.id);
          if (mErr) throw new Error(mErr.message);
        }

        if (variantChanged) {
          const job = await accountsJob(plan.entity_id, plan.period_end, (await template(plan.template_id)).key);
          await rebuild({ ...plan, has_meeting: hasMeeting, books_with_us: booksWithUs }, job);
        }
        return json({ success: true, plan: await loadPlan(plan.id), milestones: await milestonesOf(plan.id) });
      }

      case "commit": {
        const out = await commit(uuid(p.plan_id, "plan_id"));
        return json({ success: true, ...out });
      }

      case "uncommit": {
        const plan = await loadPlan(uuid(p.plan_id, "plan_id"));
        const { error } = await db.from("job_plans").update({ status: "draft", committed_at: null, committed_by: null, updated_at: now }).eq("id", plan.id);
        if (error) throw new Error(error.message);
        return json({ success: true, plan: await loadPlan(plan.id), milestones: await milestonesOf(plan.id) });
      }

      // Draft the default chain for many jobs at once so a preparer can review
      // the whole list before committing it. Existing drafts are rebuilt
      // (pins kept); committed plans are left alone.
      case "batch_propose": {
        const items: Array<Record<string, unknown>> = Array.isArray(p.items) ? p.items : [];
        if (!items.length) throw new BadRequest("items required");
        if (items.length > 200) throw new BadRequest("At most 200 jobs per batch");
        const results: Array<{ entity_id: string; period_end: string; ok: boolean; error?: string }> = [];
        for (const it of items) {
          const entityId = uuid(it.entity_id, "entity_id");
          const periodEnd = isoDate(it.period_end, "period_end");
          try {
            await propose(entityId, periodEnd, null, null, false, it.template ? String(it.template) : null);
            results.push({ entity_id: entityId, period_end: periodEnd, ok: true });
          } catch (e) {
            results.push({ entity_id: entityId, period_end: periodEnd, ok: false, error: (e as Error).message });
          }
        }
        return json({ success: true, proposed: results.filter((r) => r.ok).length, results });
      }

      case "batch_commit": {
        const items: Array<Record<string, unknown>> = Array.isArray(p.items) ? p.items : [];
        if (!items.length) throw new BadRequest("items required");
        if (items.length > 200) throw new BadRequest("At most 200 jobs per batch");
        const results: Array<{ entity_id: string; period_end: string; ok: boolean; error?: string }> = [];
        for (const it of items) {
          const entityId = uuid(it.entity_id, "entity_id");
          const periodEnd = isoDate(it.period_end, "period_end");
          try {
            // A reviewed draft commits as it stands; only a job with no plan
            // yet gets the default proposed first.
            const tKey = it.template ? String(it.template) : null;
            let fq = db.from("job_plans").select("id, status").eq("entity_id", entityId).eq("period_end", periodEnd);
            if (tKey) fq = fq.eq("template_id", (await template(tKey)).id);
            const { data: found } = await fq.maybeSingle();
            const planId = found?.status === "draft" ? (found.id as string) : (await propose(entityId, periodEnd, null, null, false, tKey)).plan.id as string;
            await commit(planId);
            results.push({ entity_id: entityId, period_end: periodEnd, ok: true });
          } catch (e) {
            results.push({ entity_id: entityId, period_end: periodEnd, ok: false, error: (e as Error).message });
          }
        }
        return json({ success: true, committed: results.filter((r) => r.ok).length, results });
      }

      // "This client gets a review meeting" (or does not), set by the team
      // for the client rather than one job: included in their package, baked
      // into the accounts fee, or simply "we meet them". Clears back to the
      // billing-derived answer when has_meeting is null.
      case "set_client_meeting": {
        const entityId = uuid(p.entity_id, "entity_id");
        const has = optBool(p.has_meeting);
        if (has === null) {
          const { error } = await db.from("client_review_meetings").delete().eq("entity_id", entityId);
          if (error) throw new Error(error.message);
        } else {
          const basis = ["manual", "package", "included_in_accounts"].includes(String(p.basis)) ? String(p.basis) : "manual";
          const { error } = await db.from("client_review_meetings").upsert({
            entity_id: entityId, has_meeting: has, basis,
            note: p.note ? String(p.note).slice(0, 1000) : null, set_by: me, set_at: now,
          }, { onConflict: "entity_id" });
          if (error) throw new Error(error.message);
        }
        const { data: rm } = await db.from("v_client_review_meeting").select("has_meeting, basis, note").eq("entity_id", entityId).maybeSingle();
        return json({ success: true, meeting: rm });
      }

      // The comms stages: see the email before it goes, send it, or send a
      // copy to yourself first. Sends go through the practice mailbox (or the
      // one configured in Scheduled Jobs) and are logged on the client page.
      case "preview_comms": {
        const id = uuid(p.milestone_id, "milestone_id");
        const { data: m, error } = await db.from("job_milestones").select("*, job_plans(*)").eq("id", id).maybeSingle();
        if (error) throw new Error(error.message);
        if (!m) throw new BadRequest("Stage not found", 404);
        // items: the picker's current ticks, so the preview re-renders as
        // the sender changes them; omitted = remembered or defaults.
        const items = Array.isArray(p.items) ? pickedItems(p.items) : null;
        const r = await renderForMilestone(db, m, m.job_plans as Record<string, unknown>, items, p.prefs ?? undefined);
        return json({ success: true, preview: r, sent_at: m.comms_sent_at, sent_to: m.comms_to });
      }

      // The sender's defaults for the draft screen (sql/316).
      case "get_comms_prefs": {
        const prefs = await loadPrefs(db, me);
        const { data: sigs } = await db.from("comms_signatures").select("mailbox_email").eq("staff_id", me);
        return json({ success: true, prefs, has_signature: (sigs || []).length > 0 });
      }
      case "set_comms_prefs": {
        const prefs = cleanPrefs(p.prefs);
        const { error } = await db.from("staff_comms_prefs").upsert({ staff_id: me, ...prefs, updated_at: now }, { onConflict: "staff_id" });
        if (error) throw new Error(error.message);
        return json({ success: true, prefs });
      }

      case "send_comms": {
        const id = uuid(p.milestone_id, "milestone_id");
        const { data: settings } = await db.from("job_plan_settings").select("comms_mailbox").eq("id", true).maybeSingle();
        const toOverride = p.to ? String(p.to).trim() : null;
        if (toOverride && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(toOverride)) throw new BadRequest("That does not look like an email address");
        const testOnly = p.test === true;
        if (testOnly && !toOverride) throw new BadRequest("A test send needs an address");
        const items = Array.isArray(p.items) ? pickedItems(p.items) : undefined;
        const out = await sendForMilestone(db, id, {
          mailbox: settings?.comms_mailbox || null, toOverride, actorId: me, testOnly, items, prefs: p.prefs ?? undefined,
          subjectOverride: p.subject ? String(p.subject) : null, textOverride: p.text ? String(p.text) : null,
        });
        const { data: m } = await db.from("job_milestones").select("plan_id").eq("id", id).maybeSingle();
        return json({ success: true, ...out, plan: m ? await loadPlan(m.plan_id) : null, milestones: m ? await milestonesOf(m.plan_id) : [] });
      }

      // Email from a task (Day Plan / Overview): a blank email about it, or
      // a records request for a client with no plan stage to hang it on.
      case "preview_email": {
        const entityId = p.entity_id ? uuid(p.entity_id, "entity_id") : null;
        const kind = p.kind === "records_request" ? "records_request" : p.kind === "meeting_proposal" ? "meeting_proposal" : "blank";
        const items = Array.isArray(p.items) ? pickedItems(p.items) : null;
        const r = await renderGeneric(db, { entityId, kind, ownerId: me, taskLabel: p.task_label ? String(p.task_label).slice(0, 160) : null, items, prefs: p.prefs ?? undefined, fee: p.fee != null ? Number(p.fee) : null });
        return json({ success: true, preview: r });
      }

      case "send_email": {
        const entityId = p.entity_id ? uuid(p.entity_id, "entity_id") : null;
        // One address, or several separated by commas (a cover request to the team).
        const to = String(p.to || "").split(",").map((x) => x.trim()).filter(Boolean).join(", ");
        if (!to || !to.split(", ").every((x) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x))) throw new BadRequest("That does not look like an email address");
        const subject = String(p.subject || "").trim().slice(0, 200);
        let text = String(p.text || "").slice(0, 20000);
        if (!subject || !text.trim()) throw new BadRequest("Subject and message are needed");
        const { data: settings } = await db.from("job_plan_settings").select("comms_mailbox").eq("id", true).maybeSingle();
        const remember = p.kind === "records_request" && Array.isArray(p.items) ? pickedItems(p.items) : null;
        const task = taskRef(p.task);
        const toStaff = optUuid(p.to_staff_id, "to_staff_id");
        // A colleague is asked to reply in Athena, so the thread lives on the task.
        if (toStaff && task) text = `${text.trimEnd()}\n\n—\nReply in Athena: ${taskUrl(task)}`;
        const out = await sendGeneric(db, {
          entityId: toStaff ? null : entityId, to, subject, text, ownerId: me, mailbox: settings?.comms_mailbox || null,
          testOnly: p.test === true, remember, periodEnd: p.period_end ? isoDate(p.period_end, "period_end") : null,
        });
        // A meeting proposal is recorded on the client (sql/321).
        if (p.kind === "meeting_proposal" && entityId && p.test !== true) {
          const fee = p.fee != null && Number.isFinite(Number(p.fee)) ? Number(p.fee) : null;
          await db.from("client_review_meetings").upsert({ entity_id: entityId, has_meeting: false, basis: "proposed", proposed_at: now, meeting_fee: fee, note: `Review meeting proposed${fee ? ` at £${fee}` : ""}`, set_by: me, set_at: now }, { onConflict: "entity_id" });
        }
        if (task && p.test !== true) {
          await db.from("task_comments").insert({
            task_type: task.type, task_id: task.id, occurrence_date: task.occurrence_date, entity_id: entityId,
            task_label: p.task_label ? String(p.task_label).slice(0, 160) : null, author_id: me,
            body: `${subject}\n\n${String(p.text || "").slice(0, 20000)}`, kind: "email", to_staff_id: toStaff, to_email: to, notified_at: now,
          });
        }
        return json({ success: true, ...out });
      }

      // The task modal's comments (sql/315). A reply notifies everyone else on
      // the thread by email, from the author's mailbox, with the text.
      case "add_comment": {
        const task = taskRef(p.task);
        if (!task) throw new BadRequest("task is needed");
        const body = String(p.body || "").trim().slice(0, 20000);
        if (!body) throw new BadRequest("Nothing to say");
        const entityId = p.entity_id ? uuid(p.entity_id, "entity_id") : null;
        const label = p.task_label ? String(p.task_label).slice(0, 160) : null;
        // @mentions (sql/318): ids the picker inserted, checked against staff.
        const mentionIds = [...new Set((Array.isArray(p.mentions) ? p.mentions : []).map((x: unknown) => String(x)).filter((x: string) => UUID.test(x) && x !== me))].slice(0, 20);
        const { data: row, error } = await db.from("task_comments").insert({
          task_type: task.type, task_id: task.id, occurrence_date: task.occurrence_date, entity_id: entityId, task_label: label, author_id: me, body, kind: "comment", mentions: mentionIds,
        }).select("id").single();
        if (error) throw new Error(error.message);

        // A comment on a workflow stage also lands in that year end's notes Doc in
        // Drive (sql/362), when the Doc has been started. Best effort: Drive being
        // down must not lose the comment, which is already saved above.
        let driveSaved: boolean | null = null;
        if (task.type === "ms") {
          const { data: ms } = await db.from("job_milestones").select("label, plan:job_plans!inner(entity_id, period_end)").eq("id", task.id).maybeSingle();
          const plan = ms?.plan as { entity_id: string; period_end: string } | undefined;
          if (plan) {
            const { data: doc } = await db.from("drive_documents").select("id").eq("entity_id", plan.entity_id).eq("kind", "year_end_notes").eq("period_end", plan.period_end).maybeSingle();
            if (doc) {
              try {
                await appendYearEndNote(db, { entityId: plan.entity_id, periodEnd: plan.period_end, text: body, label: ms?.label || label, by: me, createIfMissing: false });
                driveSaved = true;
              } catch (e) { console.error("[job-plan] drive notes append", (e as Error).message); driveSaved = false; }
            }
          }
        }

        const { data: thread } = await db.from("task_comments").select("author_id, to_staff_id, mentions").eq("task_type", task.type).eq("task_id", task.id);
        const others = new Set<string>();
        (thread || []).forEach((c) => {
          if (c.author_id && c.author_id !== me) others.add(c.author_id);
          if (c.to_staff_id && c.to_staff_id !== me) others.add(c.to_staff_id);
          (c.mentions || []).forEach((id: string) => { if (id !== me) others.add(id); });
        });
        const mentioned = new Set(mentionIds);
        let notified = 0;
        if (others.size) {
          const [{ data: people }, { data: meRow }, { data: ent }] = await Promise.all([
            db.from("staff_profiles").select("id, name, email").in("id", [...others]).eq("is_active", true),
            db.from("staff_profiles").select("name").eq("id", me).maybeSingle(),
            entityId ? db.from("entities").select("name").eq("id", entityId).maybeSingle() : Promise.resolve({ data: null }),
          ]);
          const { data: settings } = await db.from("job_plan_settings").select("comms_mailbox").eq("id", true).maybeSingle();
          const myFirst = String(meRow?.name || "").split(" ")[0] || "A colleague";
          const what = [ent?.name, label].filter(Boolean).join(" – ") || "a task";
          for (const person of people || []) {
            if (!person.email) continue;
            const isMention = mentioned.has(person.id);
            const subject = isMention ? `${myFirst} mentioned you on ${what}` : `Re: ${what}`;
            const text = `Hi ${String(person.name || "").split(" ")[0]},\n\n${myFirst} ${isMention ? "mentioned you" : "replied"} on ${label || "the task"}${ent?.name ? ` (${ent.name})` : ""} in Athena:\n\n${body}\n\n—\nReply in Athena: ${taskUrl(task)}`;
            try {
              await sendGeneric(db, { entityId: null, to: person.email, subject, text, ownerId: me, mailbox: settings?.comms_mailbox || null });
              notified++;
            } catch (e) { console.error("[job-plan] comment notify", (e as Error).message); }
          }
          if (notified) await db.from("task_comments").update({ notified_at: now }).eq("id", row.id);
        }
        return json({ success: true, id: row.id, notified, drive_saved: driveSaved });
      }

      // The client's answer to a review-meeting proposal (sql/321).
      case "meeting_declined": {
        const entityId = uuid(p.entity_id, "entity_id");
        const { error } = await db.from("client_review_meetings").upsert({ entity_id: entityId, has_meeting: false, basis: "declined", note: p.note ? String(p.note).slice(0, 300) : "Review meeting declined", set_by: me, set_at: now }, { onConflict: "entity_id" });
        if (error) throw new Error(error.message);
        return json({ success: true });
      }
      case "meeting_agreed": {
        const entityId = uuid(p.entity_id, "entity_id");
        const fee = Number(p.fee_net);
        if (!Number.isFinite(fee) || fee < 0) throw new BadRequest("A net fee is needed (0 to price it later)");
        const meetingDate = p.meeting_date ? isoDate(p.meeting_date, "meeting_date") : null;
        const planId = optUuid(p.plan_id, "plan_id");
        const { data: ent } = await db.from("entities").select("name").eq("id", entityId).maybeSingle();
        // The bill: a draft in Billing, priced now or later, pushed when the meeting happens.
        const vat = Math.round(fee * 0.2 * 100) / 100, gross = Math.round((fee + vat) * 100) / 100;
        let periodEnd: string | null = null;
        if (planId) { const { data: pl } = await db.from("job_plans").select("period_end").eq("id", planId).maybeSingle(); periodEnd = pl?.period_end || null; }
        const desc = `Annual review meeting${periodEnd ? ` – year to ${new Date(`${periodEnd}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" })}` : ""}${meetingDate ? ` (${meetingDate})` : ""}`;
        const { data: bill, error: bErr } = await db.from("billing_items").insert({
          entity_id: entityId, service: "Review Meetings", description: desc, net_amount: fee, vat_amount: vat, gross_amount: gross, status: "draft", created_by: me,
          lines: [{ service: "Review Meetings", description: desc, qty: 1, rate: fee, net: fee, vat, gross }],
        }).select("id").single();
        if (bErr) throw new Error(bErr.message);
        const { error } = await db.from("client_review_meetings").upsert({
          entity_id: entityId, has_meeting: true, basis: "manual", agreed_at: now, meeting_fee: fee, billing_item_id: bill.id,
          note: `Review meeting agreed${fee ? ` at £${fee}` : ""}${meetingDate ? ` for ${meetingDate}` : ""}`, set_by: me, set_at: now,
        }, { onConflict: "entity_id" });
        if (error) throw new Error(error.message);
        // The job: meeting on, chain rebuilt, the date pinned if known.
        if (planId) {
          const plan = await loadPlan(planId);
          const job = await accountsJob(plan.entity_id, plan.period_end, (await template(plan.template_id)).key);
          await db.from("job_plans").update({ has_meeting: true, updated_at: now }).eq("id", planId);
          await rebuild({ ...plan, has_meeting: true }, job);
          if (meetingDate) await db.from("job_milestones").update({ due_date: meetingDate, pinned_by: me, pinned_at: now, updated_at: now }).eq("plan_id", planId).eq("stage_key", "client_meeting");
        }
        // Fee viewers: if it becomes regular, the monthly fee should carry it.
        const { data: viewers } = await db.from("staff_profiles").select("id").eq("is_active", true).eq("can_view_client_fees", true);
        for (const v of viewers || []) {
          const { data: dup } = await db.from("notifications").select("id").eq("source_key", `review_meeting:${entityId}:${bill.id}`).eq("recipient_id", v.id).limit(1);
          if (!dup?.length) await db.from("notifications").insert({ recipient_id: v.id, kind: "review_meeting_agreed", title: `${ent?.name || "A client"} agreed a review meeting`, body: `Billed once at £${fee}. If it becomes regular, add it to the monthly fee.`, link_path: `/clients/${entityId}`, source_key: `review_meeting:${entityId}:${bill.id}` });
        }
        return json({ success: true, billing_item_id: bill.id, plan: planId ? await loadPlan(planId) : null, milestones: planId ? await milestonesOf(planId) : [] });
      }

      // A client reply or upload (sql/319): the owner says whether the
      // records are in. Either way the chases are released.
      // ── Records received, from an email (sql/366) ───────────────────────
      // The open email's client(s) → their jobs still waiting on records.
      // "Waiting" = BrightManager short of Records Received AND, if there is
      // a workflow, its records_in stage still open. Year must have ended.
      case "records_candidates": {
        // By client (Create → Workflow update) or by email addresses.
        let ids: string[] = (Array.isArray(p.entity_ids) ? p.entity_ids : []).map(String).filter((x: string) => UUID.test(x)).slice(0, 10);
        if (!ids.length) {
          const emails = (Array.isArray(p.emails) ? p.emails : []).map((e: unknown) => String(e).toLowerCase().trim())
            .filter((e: string) => e.includes("@")).slice(0, 20);
          if (!emails.length) return json({ success: true, jobs: [] });
          const { data: hits, error: hErr } = await db.rpc("comms_recipient_entities", { p_emails: emails });
          if (hErr) throw new Error(hErr.message);
          ids = [...new Set((hits || []).map((h: { entity_id: string }) => h.entity_id))];
        }
        if (!ids.length) return json({ success: true, jobs: [] });
        const today = now.slice(0, 10);
        const [sa, acc] = await Promise.all([
          db.from("v_sa_jobs").select("entity_id, client, period_end, tax_year_end, prep_job_id, preparer_id, preparer_name, bm_status, plan_id, plan_status, template_key").in("entity_id", ids).lte("period_end", today),
          db.from("v_accounts_jobs").select("entity_id, client, period_end, prep_job_id, preparer_id, preparer_name, bm_status, plan_id, plan_status").in("entity_id", ids).lte("period_end", today),
        ]);
        if (sa.error) throw new Error(sa.error.message);
        if (acc.error) throw new Error(acc.error.message);
        const rows = [
          ...(sa.data || []).map((r) => ({ ...r, template_key: r.template_key || "self_assessment" })),
          ...(acc.data || []).map((r) => ({ ...r, template_key: "annual_accounts" })),
        ].filter((r) => recordsRank(r.bm_status) < recordsRank("Records Received"));
        // Drop jobs whose workflow already has records in.
        const planIds = rows.map((r) => r.plan_id).filter(Boolean);
        const doneIn = new Set<string>();
        if (planIds.length) {
          const { data: ms } = await db.from("job_milestones").select("plan_id, status").in("plan_id", planIds).eq("stage_key", "records_in");
          (ms || []).forEach((m) => { if (m.status !== "pending") doneIn.add(m.plan_id); });
        }
        const jobs = rows.filter((r) => !r.plan_id || !doneIn.has(r.plan_id)).map((r) => ({
          entity_id: r.entity_id, client: r.client, period_end: r.period_end, template_key: r.template_key,
          label: r.template_key === "self_assessment"
            ? `Self Assessment ${saYear((r as { tax_year_end?: string }).tax_year_end || r.period_end)}`
            : `Accounts, year end ${new Date(`${r.period_end}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}`,
          preparer_name: r.preparer_name, bm_status: r.bm_status, plan_status: r.plan_status,
        }));
        return json({ success: true, jobs });
      }

      case "records_received": {
        const entityId = uuid(p.entity_id, "entity_id");
        const periodEnd = isoDate(p.period_end, "period_end");
        const templateKey = p.template === "self_assessment" ? "self_assessment" : "annual_accounts";
        const em = (p.email && typeof p.email === "object" ? p.email : {}) as Record<string, unknown>;
        const emSubject = String(em.subject || "").slice(0, 300);
        const emFrom = String(em.from || "").slice(0, 200);
        const emLink = String(em.link || "").startsWith("https://mail.google.com/") ? String(em.link).slice(0, 500) : "";
        const emDate = em.date ? new Date(Number(em.date)).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "";
        const job = await accountsJob(entityId, periodEnd, templateKey);
        const t = await template(job.template_key as string);
        const jobLabel = job.template_key === "self_assessment"
          ? `Self Assessment ${saYear((job as { tax_year_end?: string }).tax_year_end || periodEnd)}`
          : "year-end accounts";

        // 1. The workflow: the existing one, else the default chain — committed
        //    if every stage has an owner, otherwise left as a draft.
        let created = false;
        let committed = false;
        let { data: plan } = await db.from("job_plans").select("*")
          .eq("entity_id", entityId).eq("period_end", periodEnd).eq("template_id", t.id).maybeSingle();
        if (!plan) {
          const out = await propose(entityId, periodEnd, null, null, false, job.template_key as string);
          plan = out.plan; created = true;
          try { await commit(plan.id); committed = true; } catch { /* unowned stage: stays a draft */ }
        } else committed = plan.status === "committed";

        const ms = await milestonesOf(plan.id);
        const rec = ms.find((m) => m.stage_key === "records_in");
        const extra = p.note ? String(p.note).trim().slice(0, 1000) : "";
        const note = (emSubject
          ? `Records received by email${emDate ? ` ${emDate}` : ""}: “${emSubject}”${emFrom ? ` from ${emFrom}` : ""}`
          : "Records received")
          + (extra ? ` — ${extra}` : "");
        if (rec && rec.status === "pending") {
          await db.from("job_milestones").update({ status: "done", done_at: now, done_signal: "client", note: rec.note ? `${rec.note}\n${note}` : note, updated_at: now }).eq("id", rec.id);
        }
        await db.from("job_plans").update({
          client_signal_at: now, client_signal_kind: "email", signal_handled_at: now, chases_held: false, updated_at: now,
        }).eq("id", plan.id);

        // 2. Tell the preparer: a note on the prepare stage (so it sits on the
        //    job's thread), the bell, and an email — unless that's me.
        const prep = ms.find((m) => m.stage_key === "prepare");
        const preparerId: string | null = prep?.owner_id || (job.preparer_id as string | null) || null;
        const [{ data: meRow }, { data: preparer }] = await Promise.all([
          db.from("staff_profiles").select("name").eq("id", me).maybeSingle(),
          preparerId ? db.from("staff_profiles").select("id, name, email, is_active").eq("id", preparerId).maybeSingle() : Promise.resolve({ data: null }),
        ]);
        const myFirst = String(meRow?.name || "").split(" ")[0] || "A colleague";
        const client = String(job.client || "the client");
        const body = `${client} has sent their records for the ${jobLabel} — ${note}.${emLink ? `\nEmail: ${emLink}` : ""}\nYou can make a start.`;
        if (prep) {
          await db.from("task_comments").insert({
            task_type: "ms", task_id: prep.id, entity_id: entityId, task_label: prep.label, author_id: me, body, kind: "comment",
            to_staff_id: preparerId && preparerId !== me ? preparerId : null, mentions: [],
          });
        }
        let notified = false;
        if (preparer?.is_active && preparer.id !== me) {
          const link = `/planner/plan/${entityId}/${periodEnd}${job.template_key === "self_assessment" ? "?template=self_assessment" : ""}`;
          await db.from("notifications").insert({
            recipient_id: preparer.id, kind: "records_received",
            title: `${client}: records received`, body: `${myFirst} marked the ${jobLabel} records received${emSubject ? ` (“${emSubject}”)` : ""}. You can start.`,
            link_path: link, source_key: `records_received:${plan.id}`,
          });
          if (preparer.email) {
            const { data: settings } = await db.from("job_plan_settings").select("comms_mailbox").eq("id", true).maybeSingle();
            try {
              await sendGeneric(db, {
                entityId: null, to: preparer.email, ownerId: me, mailbox: settings?.comms_mailbox || null,
                subject: `${client}: records received — ${jobLabel}`,
                text: `Hi ${String(preparer.name || "").split(" ")[0]},\n\n${body}\n\n—\nThe workflow in Athena: ${PORTAL_URL}${link}${prep ? `\nThe task: ${taskUrl({ type: "ms", id: prep.id, occurrence_date: null })}` : ""}`,
              });
              notified = true;
            } catch (e) { console.error("[job-plan] records notify", (e as Error).message); }
          }
        }

        // 3. BrightManager's status, which Athena can't set: an Admin Task List
        //    item, confirmed by the tick once the import shows it.
        let bmRequest = false;
        const prepJob = job.prep_job_id as string | null;
        if (prepJob && recordsRank(job.bm_status as string | null) < recordsRank("Records Received")) {
          const { data: open } = await db.from("bm_status_requests").select("id")
            .eq("bm_task_schedule_id", prepJob).eq("wanted_status", "Records Received").is("confirmed_at", null).maybeSingle();
          if (!open) {
            const { data: task, error: tErr } = await db.from("admin_tasks").insert({
              kind: "manual", stage: "todo", entity_id: entityId, created_by: me, source: "Records received (email)",
              title: `Set BrightManager status to Records Received — ${jobLabel}`,
              detail: [`${client}: ${note}.`, emLink ? `Email: ${emLink}` : null, "Clears itself once the BrightManager import shows Records Received."].filter(Boolean).join("\n"),
            }).select("id").single();
            if (tErr) throw new Error(tErr.message);
            await db.from("bm_status_requests").insert({
              bm_task_schedule_id: prepJob, entity_id: entityId, wanted_status: "Records Received",
              admin_task_id: task.id, plan_id: plan.id, requested_by: me, source_ref: emLink || null,
            });
          }
          bmRequest = true;
        }

        return json({
          success: true, plan_id: plan.id, created, committed,
          preparer: preparer?.name || null, notified, bm_request: bmRequest, label: jobLabel,
        });
      }

      case "records_signal_handle": {
        const planId = uuid(p.plan_id, "plan_id");
        const outcome = p.outcome === "records_in" ? "records_in" : "still_waiting";
        const { data: plan } = await db.from("job_plans").select("id, status").eq("id", planId).maybeSingle();
        if (!plan) throw new BadRequest("Plan not found", 404);
        if (outcome === "records_in") {
          const { data: m } = await db.from("job_milestones").select("id, status").eq("plan_id", planId).eq("stage_key", "records_in").maybeSingle();
          if (m && m.status === "pending") {
            await db.from("job_milestones").update({ status: "done", done_at: now, done_signal: "client", updated_at: now }).eq("id", m.id);
          }
        }
        const { error } = await db.from("job_plans").update({ signal_handled_at: now, chases_held: false, updated_at: now }).eq("id", planId);
        if (error) throw new Error(error.message);
        return json({ success: true, plan: await loadPlan(planId), milestones: await milestonesOf(planId) });
      }

      // Holidays (sql/317). Anyone edits their own; can_manage_portal edits anyone's.
      case "save_holiday": {
        const { data: meRow } = await db.from("staff_profiles").select("can_manage_portal").eq("id", me).maybeSingle();
        const staffId = optUuid(p.staff_id, "staff_id") || me;
        if (staffId !== me && !meRow?.can_manage_portal) throw new BadRequest("Only a manager can add holidays for someone else", 403);
        const from = isoDate(p.date_from, "date_from"), to = isoDate(p.date_to, "date_to");
        if (to < from) throw new BadRequest("The end is before the start");
        const kind = ["holiday", "sick", "other"].includes(String(p.kind)) ? String(p.kind) : "holiday";
        const id = optUuid(p.id, "id");
        const handoverDue = await handoverDueFor(staffId, from, id);
        const row = { staff_id: staffId, date_from: from, date_to: to, kind, half_day: p.half_day === true, note: p.note ? String(p.note).slice(0, 300) : null, handover_due: handoverDue };
        if (id) {
          const { data: cur } = await db.from("staff_holidays").select("staff_id").eq("id", id).maybeSingle();
          if (!cur) throw new BadRequest("Holiday not found", 404);
          if (cur.staff_id !== me && !meRow?.can_manage_portal) throw new BadRequest("Not yours to change", 403);
          const { error } = await db.from("staff_holidays").update(row).eq("id", id);
          if (error) throw new Error(error.message);
          return json({ success: true, id });
        }
        const { data, error } = await db.from("staff_holidays").insert({ ...row, created_by: me }).select("id").single();
        if (error) throw new Error(error.message);
        return json({ success: true, id: data.id });
      }
      case "delete_holiday": {
        const id = uuid(p.id, "id");
        const [{ data: cur }, { data: meRow }] = await Promise.all([
          db.from("staff_holidays").select("staff_id").eq("id", id).maybeSingle(),
          db.from("staff_profiles").select("can_manage_portal").eq("id", me).maybeSingle(),
        ]);
        if (!cur) throw new BadRequest("Holiday not found", 404);
        if (cur.staff_id !== me && !meRow?.can_manage_portal) throw new BadRequest("Not yours to remove", 403);
        const { error } = await db.from("staff_holidays").delete().eq("id", id);
        if (error) throw new Error(error.message);
        return json({ success: true });
      }

      // ── Task-by-task handover (sql/320) ──────────────────────────────────
      // The tasks inside a holiday's dates, computed now (not snapshotted),
      // with any decision already taken. Blocks are added by the browser,
      // which holds the occurrence engine.
      case "holiday_tasks": {
        const hid = uuid(p.holiday_id, "holiday_id");
        const { data: h } = await db.from("staff_holidays").select("*").eq("id", hid).maybeSingle();
        if (!h) throw new BadRequest("Holiday not found", 404);
        const tasks = await holidayTasks(h);
        const { data: decisions } = await db.from("staff_holiday_handovers").select("*").eq("holiday_id", hid);
        return json({ success: true, holiday: h, tasks, decisions: decisions || [] });
      }

      case "set_handover": {
        const hid = uuid(p.holiday_id, "holiday_id");
        const task = taskRef(p.task);
        if (!task) throw new BadRequest("task is needed");
        const decision = String(p.decision || "");
        if (!["covered", "done_before", "moved_after", "can_wait"].includes(decision)) throw new BadRequest("Unknown decision");
        const [{ data: h }, { data: meRow }] = await Promise.all([
          db.from("staff_holidays").select("*").eq("id", hid).maybeSingle(),
          db.from("staff_profiles").select("can_manage_portal").eq("id", me).maybeSingle(),
        ]);
        if (!h) throw new BadRequest("Holiday not found", 404);
        if (h.staff_id !== me && !meRow?.can_manage_portal) throw new BadRequest("Only the owner (or a manager) decides", 403);
        const info = await taskInfo(task, h.staff_id);
        if (!info) throw new BadRequest("That task is not theirs, or no longer exists", 404);
        const cover = decision === "covered" ? optUuid(p.cover_staff_id, "cover_staff_id") : null;
        if (decision === "covered" && (!cover || cover === h.staff_id)) throw new BadRequest("Pick who is covering");
        const newDate = decision === "done_before" || decision === "moved_after" ? isoDate(p.new_date, "new_date") : null;
        // Rule 4: a deadline inside the dates cannot wait, and a move stays on or before it.
        const deadlineInside = !!info.deadline && info.deadline >= h.date_from && info.deadline <= h.date_to;
        if (decision === "can_wait" && deadlineInside) throw new BadRequest(`That has a deadline on ${info.deadline} — it cannot wait`);
        if (newDate && info.deadline && newDate > info.deadline) throw new BadRequest(`A moved date must be on or before the deadline (${info.deadline})`);
        if (decision === "done_before" && newDate! >= h.date_from) throw new BadRequest("Done before I go: the date must be before the holiday starts");
        if (decision === "moved_after" && newDate! <= h.date_to) throw new BadRequest("Moved to after I'm back: the date must be after the holiday ends");
        if (task.type === "block" && newDate) throw new BadRequest("A block stays on its day; cover it or let it wait");
        if (newDate) await moveTask(task, newDate);

        let prevQ = db.from("staff_holiday_handovers").select("*").eq("holiday_id", hid).eq("task_type", task.type).eq("task_id", task.id);
        prevQ = task.occurrence_date ? prevQ.eq("occurrence_date", task.occurrence_date) : prevQ.is("occurrence_date", null);
        const { data: prev } = await prevQ.maybeSingle();
        const rowData = { holiday_id: hid, task_type: task.type, task_id: task.id, occurrence_date: task.occurrence_date, decision, cover_staff_id: cover, original_date: prev?.original_date || info.date, new_date: newDate, updated_at: now };
        let rowId = prev?.id as string | undefined;
        if (prev) {
          const { error } = await db.from("staff_holiday_handovers").update({ ...rowData, sent_at: cover && cover === prev.cover_staff_id ? prev.sent_at : null }).eq("id", prev.id);
          if (error) throw new Error(error.message);
        } else {
          const { data, error } = await db.from("staff_holiday_handovers").insert(rowData).select("id").single();
          if (error) throw new Error(error.message);
          rowId = data.id;
        }
        // Rule 7: a change after the handover went sends that colleague a short update.
        let updated = 0;
        if (prev?.sent_at && prev.cover_staff_id && (prev.cover_staff_id !== cover || decision !== "covered")) {
          try { await handoverUpdateEmail(prev.cover_staff_id, h, `No longer yours to cover: ${info.line}`); updated++; } catch (e) { console.error("[job-plan] handover update", (e as Error).message); }
        }
        if (cover && prev?.cover_staff_id !== cover) {
          const { data: already } = await db.from("staff_holiday_handovers").select("id").eq("holiday_id", hid).eq("cover_staff_id", cover).not("sent_at", "is", null).limit(1);
          if (already && already.length) {
            try { await handoverUpdateEmail(cover, h, `Added to your cover: ${info.line}`); await db.from("staff_holiday_handovers").update({ sent_at: now }).eq("id", rowId!); updated++; } catch (e) { console.error("[job-plan] handover update", (e as Error).message); }
          }
        }
        return json({ success: true, id: rowId, updated });
      }

      // One draft per colleague with covered tasks not yet sent. The browser
      // shows each in the editor; mark_handover_sent records the send.
      case "handover_drafts": {
        const hid = uuid(p.holiday_id, "holiday_id");
        const { data: h } = await db.from("staff_holidays").select("*").eq("id", hid).maybeSingle();
        if (!h) throw new BadRequest("Holiday not found", 404);
        if (h.staff_id !== me) throw new BadRequest("Only the owner sends their handovers", 403);
        const { data: rows } = await db.from("staff_holiday_handovers").select("*").eq("holiday_id", hid).eq("decision", "covered").is("sent_at", null).not("cover_staff_id", "is", null);
        const byCover = new Map<string, Array<Record<string, any>>>();
        for (const r of rows || []) { if (!byCover.has(r.cover_staff_id)) byCover.set(r.cover_staff_id, []); byCover.get(r.cover_staff_id)!.push(r); }
        const { data: meRow } = await db.from("staff_profiles").select("name").eq("id", me).maybeSingle();
        const first = String(meRow?.name || "").split(" ")[0];
        const fmtD = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
        const range = h.date_from === h.date_to ? fmtD(h.date_from) : `${fmtD(h.date_from)} to ${fmtD(h.date_to)}`;
        const drafts = [];
        for (const [coverId, list] of byCover) {
          const { data: who } = await db.from("staff_profiles").select("name, email").eq("id", coverId).maybeSingle();
          const lines: string[] = [];
          for (const r of list) {
            const info = await taskInfo({ type: r.task_type, id: r.task_id, occurrence_date: r.occurrence_date }, h.staff_id);
            if (info) lines.push(`• ${info.line}${info.context ? `\n  ${info.context}` : ""}`);
          }
          drafts.push({
            cover_staff_id: coverId, to: who?.email || "", name: who?.name || "",
            subject: `Handover – ${range}`,
            text: `Hi ${String(who?.name || "").split(" ")[0]},\n\nI’m off ${range}. Could you cover these while I’m away?\n\n${lines.join("\n")}\n\nAnything you need on any of them, ask before I go. They’ll show on your Planner for those dates and come back to me after.\n\nThanks,\n${first}`,
          });
        }
        return json({ success: true, drafts });
      }

      case "mark_handover_sent": {
        const hid = uuid(p.holiday_id, "holiday_id");
        const cover = uuid(p.cover_staff_id, "cover_staff_id");
        const { data: h } = await db.from("staff_holidays").select("staff_id").eq("id", hid).maybeSingle();
        if (!h || h.staff_id !== me) throw new BadRequest("Not your holiday", 403);
        const { error } = await db.from("staff_holiday_handovers").update({ sent_at: now }).eq("holiday_id", hid).eq("cover_staff_id", cover).is("sent_at", null);
        if (error) throw new Error(error.message);
        return json({ success: true });
      }

      // A handover draft: what I have not finished and what is planned while
      // I am away, pulled from the system, for the person to edit and send.
      case "handover_preview": {
        const from = isoDate(p.date_from, "date_from"), to = isoDate(p.date_to, "date_to");
        const mode = p.mode === "cover" ? "cover" : "handover";
        const today = now.slice(0, 10);
        const [{ data: meRow }, { data: ms }, { data: bm }, { data: qt }, { data: comps }] = await Promise.all([
          db.from("staff_profiles").select("name").eq("id", me).maybeSingle(),
          db.from("job_milestones").select("label, due_date, hours, job_plans!inner(status, entities(name))").eq("owner_id", me).eq("status", "pending").eq("job_plans.status", "committed").lte("due_date", to).order("due_date").limit(300),
          db.from("bm_task_schedule").select("id, bm_task_name, scheduled_for_date, bm_deadline, scheduled_hours, entities(name)").eq("assignee_id", me).eq("state", "planned").is("excluded_at", null).lte("scheduled_for_date", to).gte("scheduled_for_date", new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10)).order("scheduled_for_date").limit(300),
          db.from("quick_tasks").select("title, planned_date, due_date, duration, entities(name)").eq("assignee_id", me).limit(300),
          db.from("bm_task_completions").select("bm_task_schedule_id").is("confirmed_at", null),
        ]);
        const doneIds = new Set((comps || []).map((c) => c.bm_task_schedule_id));
        const fmtD = (iso: string | null) => (iso ? new Date(`${String(iso).slice(0, 10)}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }) : "");
        type Item = { when: string; line: string };
        const items: Item[] = [];
        for (const m of ms || []) items.push({ when: m.due_date, line: `${(m.job_plans as Record<string, any>)?.entities?.name || "Client"} – ${m.label}${m.hours ? ` (${Number(m.hours)}h)` : ""} – due ${fmtD(m.due_date)}` });
        for (const b of bm || []) if (!doneIds.has(b.id)) items.push({ when: b.scheduled_for_date, line: `${(b.entities as Record<string, any>)?.name || "Client"} – ${String(b.bm_task_name).replace(/\s*(Year End|Quarterly End|Monthly End|Period End|Tax Year).*$/i, "")}${b.bm_deadline ? ` – deadline ${fmtD(b.bm_deadline)}` : ""}` });
        for (const q of qt || []) {
          const when = (q.planned_date || q.due_date || "").slice(0, 10);
          if (!when || when > to) continue;
          items.push({ when, line: `${(q.entities as Record<string, any>)?.name ? `${(q.entities as Record<string, any>).name} – ` : ""}${q.title}` });
        }
        items.sort((a, b) => a.when.localeCompare(b.when));
        const before = items.filter((i) => i.when < from);
        const during = items.filter((i) => i.when >= from && i.when <= to);
        const bullets = (list: Item[]) => (list.length ? list.map((i) => `• ${i.line}`).join("\n") : "• (nothing)");
        const first = String(meRow?.name || "").split(" ")[0];
        const range = from === to ? fmtD(from) : `${fmtD(from)} to ${fmtD(to)}`;
        let subject: string, text: string;
        if (mode === "cover") {
          subject = `Cover while I’m off (${range})`;
          text = `Hi all,\n\nI’m off ${range}. Could someone pick these up while I’m away?\n\n${bullets(during)}\n\n${before.length ? `And still open from before I go:\n\n${bullets(before)}\n\n` : ""}Just reply with what you can take and I’ll hand over the detail.\n\nThanks,\n${first}`;
        } else {
          subject = `Handover – ${range}`;
          text = `Hi ,\n\nA handover for while I’m off ${range}.\n\nNot finished before I go:\n\n${bullets(before)}\n\nPlanned while I’m away:\n\n${bullets(during)}\n\nNotes on what’s needed:\n• \n\nThanks,\n${first}`;
        }
        void today;
        return json({ success: true, subject, text, counts: { before: before.length, during: during.length } });
      }

      // Day Plan (sql/313): the order of my tiles for a day.
      case "set_day_order": {
        const day = isoDate(p.day, "day");
        const keys = (Array.isArray(p.keys) ? p.keys : []).map((k: unknown) => String(k).slice(0, 80)).filter((k: string) => /^(ms|bm|quick|block):/.test(k)).slice(0, 300);
        const { error } = await db.from("day_plan_order").upsert({ staff_id: me, day, keys, updated_at: now }, { onConflict: "staff_id,day" });
        if (error) throw new Error(error.message);
        return json({ success: true });
      }

      // Right-click on the Calendar: a BrightManager job is done. Recorded
      // with the minutes (straight to the timesheet), the matching plan
      // stage closed, and the job put on the "update in BrightManager"
      // list until the next import shows it gone or a person ticks it off.
      case "complete_bm_job": {
        const sid = uuid(p.schedule_id, "schedule_id");
        const { data: row, error } = await db.from("bm_task_schedule").select("id, bm_task_id, entity_id, bm_task_name, service, bm_deadline, state").eq("id", sid).maybeSingle();
        if (error) throw new Error(error.message);
        if (!row) throw new BadRequest("Job not found", 404);
        const { data: open } = await db.from("bm_task_completions").select("id").eq("bm_task_schedule_id", sid).is("confirmed_at", null).maybeSingle();
        if (open) throw new BadRequest("Already marked complete — it is on the update-in-BrightManager list");
        const minutes = Number(p.minutes ?? 0);
        let timesheetId: string | null = null;
        if (Number.isFinite(minutes) && minutes > 0) {
          const { data: ts, error: tErr } = await db.from("timesheet_entries").insert({
            staff_id: me, entity_id: row.entity_id, service: row.service || "Other",
            work_date: now.slice(0, 10), minutes: Math.round(minutes),
            notes: row.bm_task_name, source: "completed", source_task_id: sid,
          }).select("id").single();
          if (tErr) throw new Error(tErr.message);
          timesheetId = ts.id;
        }
        const { data: c, error: cErr } = await db.from("bm_task_completions").insert({
          bm_task_schedule_id: sid, bm_task_id: row.bm_task_id, entity_id: row.entity_id,
          bm_task_name: row.bm_task_name, service: row.service, completed_by: me,
          minutes: Number.isFinite(minutes) ? Math.round(minutes) : null,
          note: p.note ? String(p.note).slice(0, 1000) : null, timesheet_entry_id: timesheetId,
        }).select("id").single();
        if (cErr) throw new Error(cErr.message);

        // Close the plan stage this job is, if the client has a committed plan.
        const stageFor = /^Accounts Preparation/.test(row.bm_task_name || "") ? "prepare"
          : /^Companies House Submission/.test(row.bm_task_name || "") ? "file_ch"
          : /^CT600 Submission/.test(row.bm_task_name || "") ? "file_ct600" : null;
        if (stageFor) {
          const col = stageFor === "file_ct600" ? "ct_job_id" : stageFor === "file_ch" ? "ch_job_id" : "prep_job_id";
          const { data: plan } = await db.from("job_plans").select("id").eq(col, sid).eq("status", "committed").maybeSingle();
          if (plan) {
            await db.from("job_milestones").update({ status: "done", done_at: now, done_signal: "manual", updated_at: now })
              .eq("plan_id", plan.id).eq("stage_key", stageFor).eq("status", "pending");
          }
        }
        return json({ success: true, completion_id: c.id, timesheet_id: timesheetId });
      }

      case "confirm_bm_completion": {
        const id = uuid(p.completion_id, "completion_id");
        const { error } = await db.from("bm_task_completions").update({ confirmed_at: now, confirmed_by: "staff" }).eq("id", id).is("confirmed_at", null);
        if (error) throw new Error(error.message);
        return json({ success: true });
      }

      // The week planner: drag a stage to another day (or person). The move
      // pins it, so the nightly pass leaves it where it was put.
      case "move_milestone": {
        const id = uuid(p.milestone_id, "milestone_id");
        const due = isoDate(p.due_date, "due_date");
        const { data: m, error } = await db.from("job_milestones").select("id, plan_id, kind, status, owner_id").eq("id", id).maybeSingle();
        if (error) throw new Error(error.message);
        if (!m) throw new BadRequest("Stage not found", 404);
        if (m.status !== "pending") throw new BadRequest("Only a pending stage can be moved");
        const patch: Record<string, unknown> = { due_date: due, pinned_by: me, pinned_at: now, updated_at: now };
        if (m.kind === "work") patch.planned_date = due;
        if (p.owner_id !== undefined && p.owner_id !== null) {
          const ownerId = uuid(p.owner_id, "owner_id");
          const { data: staff } = await db.from("staff_profiles").select("id, is_active").eq("id", ownerId).maybeSingle();
          if (!staff?.is_active) throw new BadRequest("Owner must be an active team member");
          patch.owner_id = ownerId;
        }
        const { error: uErr } = await db.from("job_milestones").update(patch).eq("id", id);
        if (uErr) throw new Error(uErr.message);
        return json({ success: true, plan: await loadPlan(m.plan_id), milestones: await milestonesOf(m.plan_id) });
      }

      case "mark_done":
      case "skip":
      case "reopen": {
        const id = uuid(p.milestone_id, "milestone_id");
        const { data: m, error } = await db.from("job_milestones").select("*, job_plans(id, entity_id, period_end, prep_job_id, ch_job_id)").eq("id", id).maybeSingle();
        if (error) throw new Error(error.message);
        if (!m) throw new BadRequest("Stage not found", 404);
        const plan = m.job_plans as Record<string, unknown>;
        if (p.action === "reopen") {
          const { error: uErr } = await db.from("job_milestones").update({ status: "pending", done_at: null, done_signal: null, updated_at: now }).eq("id", id);
          if (uErr) throw new Error(uErr.message);
          return json({ success: true, plan: await loadPlan(plan.id as string), milestones: await milestonesOf(plan.id as string) });
        }
        if (m.status !== "pending") throw new BadRequest("That stage is already closed");
        const status = p.action === "skip" ? "skipped" : "done";
        const patch: Record<string, unknown> = { status, updated_at: now };
        if (status === "done") { patch.done_at = now; patch.done_signal = "manual"; }
        if (p.note !== undefined) patch.note = p.note ? String(p.note).slice(0, 2000) : null;
        const { error: uErr } = await db.from("job_milestones").update(patch).eq("id", id);
        if (uErr) throw new Error(uErr.message);

        // Time logged on completion lands on the timesheet against the BM
        // job, which is what makes remaining hours and cost-to-serve true.
        const minutes = Number(p.minutes ?? 0);
        let timesheetId: string | null = null;
        if (status === "done" && Number.isFinite(minutes) && minutes > 0) {
          const today = new Date().toISOString().slice(0, 10);
          const { data: ts, error: tErr } = await db.from("timesheet_entries").insert({
            staff_id: me, entity_id: plan.entity_id, service: "Annual Accounts",
            work_date: today, minutes: Math.round(minutes),
            notes: `${m.label} — year end ${plan.period_end}`,
            source: "completed", source_task_id: (plan.prep_job_id ?? plan.ch_job_id) ?? null,
          }).select("id").single();
          if (tErr) throw new Error(tErr.message);
          timesheetId = ts.id;
        }
        return json({ success: true, timesheet_id: timesheetId, plan: await loadPlan(plan.id as string), milestones: await milestonesOf(plan.id as string) });
      }

      // Reassign a BM job (sql/330). One-off moves this task; permanent moves
      // every planned task of the client in the same allocation family and
      // writes the allocation_changes draft the Allocations screen would, so
      // it reaches the admin task list to be moved in BrightManager. The
      // override stands until an import shows BM agreeing.
      case "reassign_bm_job": {
        const sid = uuid(p.schedule_id, "schedule_id");
        const to = uuid(p.to_staff_id, "to_staff_id");
        const mode = p.mode === "permanent" ? "permanent" : "one_off";
        const note = p.note ? String(p.note).slice(0, 500) : null;
        const { data: row, error } = await db.from("bm_task_schedule").select("id, entity_id, bm_task_name, service, assignee_id, state").eq("id", sid).maybeSingle();
        if (error) throw new Error(error.message);
        if (!row) throw new BadRequest("Job not found", 404);
        const [{ data: meRow }, { data: target }] = await Promise.all([
          db.from("staff_profiles").select("can_manage_portal").eq("id", me).maybeSingle(),
          db.from("staff_profiles").select("id, name, is_active").eq("id", to).maybeSingle(),
        ]);
        if (!target?.is_active) throw new BadRequest("That person is not an active member of staff");
        if (row.assignee_id !== me && !meRow?.can_manage_portal) throw new BadRequest("Only the assignee or a manager can reassign a job", 403);
        if (row.assignee_id === to) throw new BadRequest(`${target.name} already has this job`);
        const r = await reassignBmJob(db, me, now, { ...row, id: sid }, to, mode, note, target.name);
        return json({ success: true, moved: r.ids.length, canonical_service_id: r.canonical, draft_id: r.draftId });
      }

      // Reassign a plan stage. One-off: this stage. Permanent: every pending
      // stage of that role on the job, and if the role is the preparer the
      // client's accounts preparation moves in BM terms too (override + draft).
      case "reassign_stage": {
        const mid = uuid(p.milestone_id, "milestone_id");
        const to = uuid(p.to_staff_id, "to_staff_id");
        const mode = p.mode === "permanent" ? "permanent" : "one_off";
        const note = p.note ? String(p.note).slice(0, 500) : null;
        const { data: m, error } = await db.from("job_milestones").select("id, plan_id, label, owner_id, owner_role, status, job_plans(id, entity_id, prep_job_id, entities(name))").eq("id", mid).maybeSingle();
        if (error) throw new Error(error.message);
        if (!m) throw new BadRequest("Stage not found", 404);
        if (m.status !== "pending") throw new BadRequest("Only a pending stage can be reassigned");
        const plan = m.job_plans as Record<string, any>;
        const [{ data: meRow }, { data: target }] = await Promise.all([
          db.from("staff_profiles").select("can_manage_portal").eq("id", me).maybeSingle(),
          db.from("staff_profiles").select("id, name, is_active").eq("id", to).maybeSingle(),
        ]);
        if (!target?.is_active) throw new BadRequest("That person is not an active member of staff");
        if (m.owner_id !== me && !meRow?.can_manage_portal) throw new BadRequest("Only the owner or a manager can reassign a stage", 403);
        if (m.owner_id === to) throw new BadRequest(`${target.name} already owns this stage`);
        let stagesMoved = 1;
        if (mode === "one_off") {
          const { error: uErr } = await db.from("job_milestones").update({ owner_id: to, updated_at: now }).eq("id", mid);
          if (uErr) throw new Error(uErr.message);
        } else {
          let q = db.from("job_milestones").update({ owner_id: to, updated_at: now }).eq("plan_id", m.plan_id).eq("status", "pending").eq("owner_role", m.owner_role);
          q = m.owner_id ? q.eq("owner_id", m.owner_id) : q.is("owner_id", null);
          const { data: moved, error: uErr } = await q.select("id");
          if (uErr) throw new Error(uErr.message);
          stagesMoved = (moved || []).length;
        }
        let bm: { ids: string[]; canonical: string | null; draftId: string | null } | null = null;
        if (mode === "permanent" && m.owner_role === "preparer" && plan?.prep_job_id) {
          const { data: row } = await db.from("bm_task_schedule").select("id, entity_id, bm_task_name, service, assignee_id").eq("id", plan.prep_job_id).maybeSingle();
          if (row && row.assignee_id !== to) bm = await reassignBmJob(db, me, now, row, to, "permanent", note, target.name);
        }
        await db.from("task_comments").insert({
          task_type: "ms", task_id: mid, entity_id: plan?.entity_id ?? null, task_label: m.label, author_id: me, kind: "comment",
          body: `${mode === "permanent" ? "Reassigned permanently" : "Reassigned (one-off)"} to ${target.name}${stagesMoved > 1 ? ` with ${stagesMoved - 1} other stage${stagesMoved > 2 ? "s" : ""} on this job` : ""}${bm?.draftId ? "; accounts preparation on the admin list to move in BrightManager" : ""}${note ? ` — ${note}` : ""}`,
        });
        return json({ success: true, stages_moved: stagesMoved, bm_moved: bm?.ids.length ?? 0, draft_id: bm?.draftId ?? null, plan: await loadPlan(m.plan_id), milestones: await milestonesOf(m.plan_id) });
      }

      // Log time against any task without completing it: a timesheet entry
      // for the caller, and a note on the task's thread.
      case "log_time": {
        const task = taskRef(p.task);
        if (!task) throw new BadRequest("task required");
        const minutes = Math.round(Number(p.minutes ?? 0));
        if (!Number.isFinite(minutes) || minutes <= 0) throw new BadRequest("minutes must be more than 0");
        let entityId: string | null = null; let service: string | null = null; let label = "";
        if (task.type === "bm") {
          const { data: b } = await db.from("bm_task_schedule").select("entity_id, service, bm_task_name").eq("id", task.id).maybeSingle();
          if (!b) throw new BadRequest("Job not found", 404);
          entityId = b.entity_id; service = b.service; label = b.bm_task_name;
        } else if (task.type === "quick") {
          const { data: q } = await db.from("quick_tasks").select("entity_id, service, title").eq("id", task.id).maybeSingle();
          if (!q) throw new BadRequest("Task not found", 404);
          entityId = q.entity_id; service = q.service; label = q.title;
        } else if (task.type === "ms") {
          const { data: m } = await db.from("job_milestones").select("label, job_plans(entity_id, period_end)").eq("id", task.id).maybeSingle();
          if (!m) throw new BadRequest("Stage not found", 404);
          const jp = m.job_plans as Record<string, any>;
          entityId = jp?.entity_id ?? null; service = "Annual Accounts"; label = `${m.label} — year end ${jp?.period_end ?? ""}`;
        } else {
          const { data: bl } = await db.from("scheduled_tasks").select("entity_id, service, title").eq("id", task.id).maybeSingle();
          if (!bl) throw new BadRequest("Block not found", 404);
          entityId = bl.entity_id; service = bl.service; label = bl.title + (task.occurrence_date ? ` (${task.occurrence_date})` : "");
        }
        const note = p.note ? String(p.note).slice(0, 500) : null;
        const { data: ts, error: tErr } = await db.from("timesheet_entries").insert({
          staff_id: me, entity_id: entityId, service: service || "Other", work_date: (p.work_date ? isoDate(p.work_date, "work_date") : now.slice(0, 10)),
          minutes, notes: note ? `${label} — ${note}` : label, source: "manual", source_task_id: task.id,
        }).select("id").single();
        if (tErr) throw new Error(tErr.message);
        await db.from("task_comments").insert({
          task_type: task.type, task_id: task.id, occurrence_date: task.occurrence_date, entity_id: entityId, task_label: label,
          author_id: me, kind: "comment", body: `Logged ${minutes} min${note ? ` — ${note}` : ""}`,
        });
        return json({ success: true, timesheet_id: ts.id });
      }

      // Edit a BM job's due date (sql/331): override that survives the import,
      // an admin task to change it in BrightManager, a note on the thread.
      case "set_bm_deadline": {
        const sid = uuid(p.schedule_id, "schedule_id");
        const due = isoDate(p.due_date, "due_date");
        const note = p.note ? String(p.note).slice(0, 500) : null;
        const { data: row, error } = await db.from("bm_task_schedule").select("id, bm_task_id, entity_id, bm_task_name, bm_deadline, deadline_override_admin_task_id, entities(name)").eq("id", sid).maybeSingle();
        if (error) throw new Error(error.message);
        if (!row) throw new BadRequest("Job not found", 404);
        if (row.bm_deadline === due) throw new BadRequest("That is already the due date");
        const fmtUk = (iso: string | null) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : "none");
        const client = (row.entities as Record<string, any> | null)?.name || "unknown client";
        // One open admin task per job: reuse it if the date is changed again.
        let taskId: string | null = row.deadline_override_admin_task_id ?? null;
        const title = `Change the due date of "${row.bm_task_name}" for ${client} in BrightManager to ${fmtUk(due)} (was ${fmtUk(row.bm_deadline)})`;
        const detail = `${note ? note + "\n\n" : ""}Athena already shows ${fmtUk(due)}. This task confirms itself when the next import shows BrightManager agreeing.`;
        if (taskId) {
          const { data: open } = await db.from("admin_tasks").select("id").eq("id", taskId).is("done_at", null).is("dismissed_at", null).maybeSingle();
          if (open) await db.from("admin_tasks").update({ title, detail, value: row.bm_task_id, deadline: due }).eq("id", taskId);
          else taskId = null;
        }
        if (!taskId) {
          const { data: t, error: aErr } = await db.from("admin_tasks").insert({
            kind: "manual", source: "bm_deadline_change", entity_id: row.entity_id, field: "bm_deadline", value: row.bm_task_id,
            title, detail, created_by: me, deadline: due,
          }).select("id").single();
          if (aErr) throw new Error(aErr.message);
          taskId = t.id;
        }
        const { error: uErr } = await db.from("bm_task_schedule").update({ deadline_override: due, deadline_override_at: now, deadline_override_by: me, deadline_override_admin_task_id: taskId, updated_at: now }).eq("id", sid);
        if (uErr) throw new Error(uErr.message);
        await db.from("task_comments").insert({
          task_type: "bm", task_id: sid, entity_id: row.entity_id, task_label: row.bm_task_name, author_id: me, kind: "comment",
          body: `Due date changed to ${fmtUk(due)} (was ${fmtUk(row.bm_deadline)}); on the admin list to change in BrightManager${note ? ` — ${note}` : ""}`,
        });
        return json({ success: true, admin_task_id: taskId });
      }

      default:
        throw new BadRequest("Unknown action");
    }
  } catch (e) {
    if (e instanceof BadRequest) return json({ success: false, error: e.message }, e.status);
    return json({ success: false, error: (e as Error).message }, 500);
  }
});
