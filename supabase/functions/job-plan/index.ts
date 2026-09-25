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
//   batch_commit  { items: [{ entity_id, period_end }] }
//                 propose with defaults then commit, for the jobs that take
//                 the template unchanged.
//
// Returns { success, plan, milestones } for single-plan actions.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireStaffOrService, authErrorResponse } from "../_shared/require-staff.ts";
import { computeChain, type StageRule, type JobContext } from "../_shared/workflow.ts";

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
    const [inferred, alloc, reviewers, services] = await Promise.all([
      db.from("v_inferred_allocations").select("canonical_service_id, assignee_id").eq("entity_id", entityId),
      db.from("client_service_allocations").select("service_id, fee_earner_id, fee_earner_manager_id").eq("entity_id", entityId),
      db.from("service_reviewers").select("canonical_service_id, reviewer_id").eq("entity_id", entityId),
      db.from("services").select("canonical_service_id, service_name, status").eq("entity_id", entityId),
    ]);
    for (const r of [inferred, alloc, reviewers, services]) if (r.error) throw new Error(r.error.message);
    const inf = (k: string) => inferred.data?.find((x) => x.canonical_service_id === k)?.assignee_id ?? null;
    const al = (k: string) => alloc.data?.find((x) => x.service_id === k) ?? null;

    const preparer = (job.preparer_id as string | null) ?? inf("accounts_preparation") ?? null;
    const clientManager = al("accounts_ct")?.fee_earner_manager_id ?? inf("accounts_submission") ?? preparer;
    const reviewer = reviewers.data?.find((x) => x.canonical_service_id === "accounts_preparation")?.reviewer_id ?? clientManager;
    const bookkeeper = inf("bookkeeping") ?? al("bookkeeping_vat")?.fee_earner_id ?? preparer;

    const meetingDefault = !!al("review_meetings")
      || !!services.data?.some((s) => s.canonical_service_id === "review_meetings"
        || /meeting/i.test(String(s.service_name ?? "")) && String(s.status ?? "active") === "active");
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
      meetingDefault, booksDefault,
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
    const rows = chain.filter((m) => !keep.has(m.stage_key)).map((m) => {
      const prior = existing.find((x) => x.stage_key === m.stage_key);
      return {
        plan_id: plan.id, stage_key: m.stage_key, seq: m.seq, label: m.label, kind: m.kind, hours: m.hours,
        owner_role: m.owner_role,
        owner_id: prior?.owner_id ?? m.owner_id,
        due_date: m.due_date, planned_date: m.planned_date,
        status: "pending", note: prior?.note ?? null, updated_at: now,
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
      planned_by: me, planned_at: now, updated_at: now,
    }).eq("id", plan.id);
    if (pErr) throw new Error(pErr.message);
    return { defaults: { has_meeting: ctx0.meetingDefault, books_with_us: ctx0.booksDefault, owners: ctx0.owners } };
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

      case "batch_commit": {
        const items: Array<Record<string, unknown>> = Array.isArray(p.items) ? p.items : [];
        if (!items.length) throw new BadRequest("items required");
        if (items.length > 200) throw new BadRequest("At most 200 jobs per batch");
        const results: Array<{ entity_id: string; period_end: string; ok: boolean; error?: string }> = [];
        for (const it of items) {
          const entityId = uuid(it.entity_id, "entity_id");
          const periodEnd = isoDate(it.period_end, "period_end");
          try {
            const { plan } = await propose(entityId, periodEnd, null, null, false);
            await commit(plan.id as string);
            results.push({ entity_id: entityId, period_end: periodEnd, ok: true });
          } catch (e) {
            results.push({ entity_id: entityId, period_end: periodEnd, ok: false, error: (e as Error).message });
          }
        }
        return json({ success: true, committed: results.filter((r) => r.ok).length, results });
      }

      default:
        throw new BadRequest("Unknown action");
    }
  } catch (e) {
    if (e instanceof BadRequest) return json({ success: false, error: e.message }, e.status);
    return json({ success: false, error: (e as Error).message }, 500);
  }
});
