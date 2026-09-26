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
//   add_comment   { task: { type, id, occurrence_date? }, body, entity_id?, task_label? }   notifies the thread (sql/315)
//   set_day_order { day, keys[] }                           Day Plan tile order (sql/313)
//   complete_bm_job { schedule_id, minutes?, note? }        a BM job done in Athena (sql/311)
//   confirm_bm_completion { completion_id }                 ticked off in BrightManager by hand
//   mark_done     { milestone_id, minutes?, note? }
//                 the Done button on Today. Minutes > 0 also write a
//                 timesheet_entries row against the job (source 'completed').
//   skip          { milestone_id }   not needed on this job
//   reopen        { milestone_id }   back to pending
//
// Returns { success, plan, milestones } for single-plan actions.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireStaffOrService, authErrorResponse } from "../_shared/require-staff.ts";
import { computeChain, type StageRule, type JobContext } from "../_shared/workflow.ts";
import { renderForMilestone, sendForMilestone, renderGeneric, sendGeneric } from "../_shared/job-comms.ts";

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
function pickedItems(v: unknown[]): Array<{ key?: string | null; text?: string | null }> {
  return v.slice(0, 60).map((x) => {
    const o = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
    const key = o.key ? String(o.key).slice(0, 60) : null;
    const text = o.text ? String(o.text).slice(0, 300) : null;
    return key ? { key } : { text };
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
function taskUrl(t: { type: string; id: string; occurrence_date: string | null }): string {
  return `${PORTAL_URL}/planner/day?task=${t.type}:${t.id}${t.occurrence_date ? `:${t.occurrence_date}` : ""}`;
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

  async function template() {
    const { data: t, error } = await db.from("workflow_templates").select("id, key").eq("key", TEMPLATE_KEY).eq("active", true).maybeSingle();
    if (error) throw new Error(error.message);
    if (!t) throw new BadRequest("Annual accounts template is not set up", 500);
    const { data: stages, error: sErr } = await db.from("workflow_stages").select("*").eq("template_id", t.id).order("seq");
    if (sErr) throw new Error(sErr.message);
    return { id: t.id as string, stages: (stages || []) as StageRule[] };
  }

  async function accountsJob(entityId: string, periodEnd: string) {
    const { data, error } = await db.from("v_accounts_jobs").select("*").eq("entity_id", entityId).eq("period_end", periodEnd).maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new BadRequest("No planned accounts job for that client and year end", 404);
    return data;
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
    const t = await template();
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

  async function propose(entityId: string, periodEnd: string, hasMeeting: boolean | null, booksWithUs: boolean | null, replan: boolean) {
    const job = await accountsJob(entityId, periodEnd);
    const t = await template();
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

  try {
    switch (p.action) {
      case "propose": {
        const out = await propose(
          uuid(p.entity_id, "entity_id"), isoDate(p.period_end, "period_end"),
          optBool(p.has_meeting), optBool(p.books_with_us), p.replan === true,
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
          const job = await accountsJob(plan.entity_id, plan.period_end);
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
            await propose(entityId, periodEnd, null, null, false);
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
            const { data: found } = await db.from("job_plans").select("id, status").eq("entity_id", entityId).eq("period_end", periodEnd).maybeSingle();
            const planId = found?.status === "draft" ? (found.id as string) : (await propose(entityId, periodEnd, null, null, false)).plan.id as string;
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
        const r = await renderForMilestone(db, m, m.job_plans as Record<string, unknown>, items);
        return json({ success: true, preview: r, sent_at: m.comms_sent_at, sent_to: m.comms_to });
      }

      case "send_comms": {
        const id = uuid(p.milestone_id, "milestone_id");
        const { data: settings } = await db.from("job_plan_settings").select("comms_mailbox").eq("id", true).maybeSingle();
        const toOverride = p.to ? String(p.to).trim() : null;
        if (toOverride && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(toOverride)) throw new BadRequest("That does not look like an email address");
        const testOnly = p.test === true;
        if (testOnly && !toOverride) throw new BadRequest("A test send needs an address");
        const items = Array.isArray(p.items) ? pickedItems(p.items) : undefined;
        const out = await sendForMilestone(db, id, { mailbox: settings?.comms_mailbox || null, toOverride, actorId: me, testOnly, items });
        const { data: m } = await db.from("job_milestones").select("plan_id").eq("id", id).maybeSingle();
        return json({ success: true, ...out, plan: m ? await loadPlan(m.plan_id) : null, milestones: m ? await milestonesOf(m.plan_id) : [] });
      }

      // Email from a task (Day Plan / Overview): a blank email about it, or
      // a records request for a client with no plan stage to hang it on.
      case "preview_email": {
        const entityId = p.entity_id ? uuid(p.entity_id, "entity_id") : null;
        const kind = p.kind === "records_request" ? "records_request" : "blank";
        const items = Array.isArray(p.items) ? pickedItems(p.items) : null;
        const r = await renderGeneric(db, { entityId, kind, ownerId: me, taskLabel: p.task_label ? String(p.task_label).slice(0, 160) : null, items });
        return json({ success: true, preview: r });
      }

      case "send_email": {
        const entityId = p.entity_id ? uuid(p.entity_id, "entity_id") : null;
        const to = String(p.to || "").trim();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) throw new BadRequest("That does not look like an email address");
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
        const { data: row, error } = await db.from("task_comments").insert({
          task_type: task.type, task_id: task.id, occurrence_date: task.occurrence_date, entity_id: entityId, task_label: label, author_id: me, body, kind: "comment",
        }).select("id").single();
        if (error) throw new Error(error.message);

        const { data: thread } = await db.from("task_comments").select("author_id, to_staff_id").eq("task_type", task.type).eq("task_id", task.id);
        const others = new Set<string>();
        (thread || []).forEach((c) => { if (c.author_id && c.author_id !== me) others.add(c.author_id); if (c.to_staff_id && c.to_staff_id !== me) others.add(c.to_staff_id); });
        let notified = 0;
        if (others.size) {
          const [{ data: people }, { data: meRow }, { data: ent }] = await Promise.all([
            db.from("staff_profiles").select("id, name, email").in("id", [...others]).eq("is_active", true),
            db.from("staff_profiles").select("name").eq("id", me).maybeSingle(),
            entityId ? db.from("entities").select("name").eq("id", entityId).maybeSingle() : Promise.resolve({ data: null }),
          ]);
          const { data: settings } = await db.from("job_plan_settings").select("comms_mailbox").eq("id", true).maybeSingle();
          const myFirst = String(meRow?.name || "").split(" ")[0] || "A colleague";
          const subject = `Re: ${[ent?.name, label].filter(Boolean).join(" – ") || "a task"}`;
          for (const person of people || []) {
            if (!person.email) continue;
            const text = `Hi ${String(person.name || "").split(" ")[0]},\n\n${myFirst} replied on ${label || "the task"}${ent?.name ? ` (${ent.name})` : ""} in Athena:\n\n${body}\n\n—\nReply in Athena: ${taskUrl(task)}`;
            try {
              await sendGeneric(db, { entityId: null, to: person.email, subject, text, ownerId: me, mailbox: settings?.comms_mailbox || null });
              notified++;
            } catch (e) { console.error("[job-plan] comment notify", (e as Error).message); }
          }
          if (notified) await db.from("task_comments").update({ notified_at: now }).eq("id", row.id);
        }
        return json({ success: true, id: row.id, notified });
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

      default:
        throw new BadRequest("Unknown action");
    }
  } catch (e) {
    if (e instanceof BadRequest) return json({ success: false, error: e.message }, e.status);
    return json({ success: false, error: (e as Error).message }, 500);
  }
});
