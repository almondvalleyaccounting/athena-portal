// job-plan-tick — Athena Portal
//
// The nightly engine behind committed job plans (sql/304, sql/305). Called
// by pg_cron as service_role (run_job_plan_tick), or by a staff member for
// an on-demand run. Idempotent: running it twice in a morning changes nothing
// the second time.
//
// For every committed plan:
//   1. Done signals. A stage whose done_signal is bm_status:<X> is done once
//      the job's BrightManager status has reached X on the ladder. ch_filed
//      and bm_gone are done when the matching BM row has left the export.
//      Request and chase stages are skipped once records are in.
//   2. Recompute. Stages still pending and not pinned are recomputed with
//      the shared chain maths, with done stages fixed at the date they were
//      done and an overdue external gate (records in, approval) treated as
//      "today" so everything behind it slides until it lands.
//   3. Risk. urgent | at_risk | waiting_on_client | slipped | none, with a
//      one-line reason, written to job_plans.
// Then, if job_plan_settings.nudges_armed: every accounts job a month past
// its year end with no committed plan gets its preparer nudged from the
// configured mailbox, once per nudge_every_days.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireStaffOrService, authErrorResponse } from "../_shared/require-staff.ts";
import { computeChain, parseISO, toISO, addDays, addMonths, minusWorkingDays, type StageRule, type JobContext } from "../_shared/workflow.ts";
import { getValidGmailToken, base64UrlEncode, formatSender } from "../_shared/gmail-client.ts";
import { sendForMilestone } from "../_shared/job-comms.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const APP_URL = "https://portal.almondvalleyaccounting.co.uk";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...cors } });
}

// Mirrors bm_status_rank() in sql/089.
const BM_RANK: Record<string, number> = {
  "No Latest Action": 0, "No Progress": 0, "Records Requested": 1, "Part Records Received": 2,
  "Records Received": 3, "In Progress": 4, "Queries Requested": 5, "Queries Received": 6,
  "To Review": 7, "Reviewed": 8, "To Send to Client to Approve": 9, "Awaiting Approval": 10,
};
const rank = (s: string | null | undefined) => (s && s in BM_RANK ? BM_RANK[s] : -1);

const EXTERNAL_GATES = new Set(["records_in", "approval"]);
const RECORDS_COMMS = new Set(["request_records", "chase_1", "chase_2"]);

function todayISO() { return toISO(new Date()); }

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ success: false, error: "POST required" }, 405);

  let caller;
  try { caller = await requireStaffOrService(req); }
  catch (e) { return authErrorResponse(e, cors); }

  const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const startedAt = new Date().toISOString();
  const today = todayISO();
  const stats = { plans: 0, doneMarked: 0, skipped: 0, datesMoved: 0, riskChanged: 0, nudged: 0, nudgeErrors: 0, commsSent: 0, commsErrors: 0, errors: [] as string[] };

  const { data: run } = await db.from("scheduled_job_runs")
    .insert({ job_key: "job-plan-tick", status: "running", reported_by: caller.kind === "service" ? "pg_cron" : "staff" })
    .select("id").single();

  try {
    // ── Load everything once ─────────────────────────────────────────────
    const { data: tmpl, error: tErr } = await db.from("workflow_templates").select("id").eq("key", "annual_accounts").maybeSingle();
    if (tErr) throw new Error(tErr.message);
    const { data: stagesRaw, error: sErr } = await db.from("workflow_stages").select("*").eq("template_id", tmpl?.id).order("seq");
    if (sErr) throw new Error(sErr.message);
    const stages = (stagesRaw || []) as StageRule[];

    const { data: plans, error: pErr } = await db.from("job_plans").select("*").eq("status", "committed");
    if (pErr) throw new Error(pErr.message);

    const planIds = (plans || []).map((p) => p.id);
    const milestonesByPlan = new Map<string, Array<Record<string, any>>>();
    for (let i = 0; i < planIds.length; i += 200) {
      const { data: ms, error } = await db.from("job_milestones").select("*").in("plan_id", planIds.slice(i, i + 200)).order("seq");
      if (error) throw new Error(error.message);
      for (const m of ms || []) {
        if (!milestonesByPlan.has(m.plan_id)) milestonesByPlan.set(m.plan_id, []);
        milestonesByPlan.get(m.plan_id)!.push(m);
      }
    }

    const bmIds = [...new Set((plans || []).flatMap((p) => [p.prep_job_id, p.ch_job_id, p.ct_job_id].filter(Boolean)))] as string[];
    const bmRows = new Map<string, { state: string; bm_status: string | null }>();
    for (let i = 0; i < bmIds.length; i += 200) {
      const { data, error } = await db.from("bm_task_schedule").select("id, state, bm_status").in("id", bmIds.slice(i, i + 200));
      if (error) throw new Error(error.message);
      for (const r of data || []) bmRows.set(r.id, { state: r.state, bm_status: r.bm_status });
    }

    const { data: staff, error: stErr } = await db.from("staff_profiles").select("id, working_days, email, name");
    if (stErr) throw new Error(stErr.message);
    const workingDays: Record<string, string | null> = {};
    const staffById = new Map<string, { email: string | null; name: string | null }>();
    for (const s of staff || []) { workingDays[s.id] = s.working_days; staffById.set(s.id, { email: s.email, name: s.name }); }

    // ── Each committed plan ──────────────────────────────────────────────
    for (const plan of plans || []) {
      stats.plans++;
      try {
        const ms = milestonesByPlan.get(plan.id) || [];
        const prep = plan.prep_job_id ? bmRows.get(plan.prep_job_id) : null;
        const ch = plan.ch_job_id ? bmRows.get(plan.ch_job_id) : null;
        const ct = plan.ct_job_id ? bmRows.get(plan.ct_job_id) : null;
        const jobRank = Math.max(rank(prep?.bm_status), rank(ch?.bm_status));
        const now = new Date().toISOString();
        const byKey = new Map(ms.map((m) => [m.stage_key, m]));
        const isDone = (k: string) => { const m = byKey.get(k); return !!m && (m.status === "done" || m.status === "skipped"); };
        // A client-owned gate (records in, approval) only counts as overdue
        // once whatever precedes it has happened: approval cannot be late
        // while the accounts have not been sent.
        const gateKeyOf = (m: Record<string, any>) => {
          const rule = stages.find((s) => s.key === m.stage_key);
          const alts = (rule?.gate_stage_key || "").split("|").map((x) => x.trim()).filter(Boolean);
          return alts.find((k) => byKey.has(k)) || null;
        };
        const externalOverdue = (m: Record<string, any>) => {
          if (!EXTERNAL_GATES.has(m.stage_key) || m.status !== "pending" || m.due_date >= today) return false;
          // Records are only "waiting on the client" once a request or chase
          // has actually gone (Bobby, 2026-09-26: Accona read as waiting when
          // nothing had been sent). Until then the lateness is ours.
          if (m.stage_key === "records_in" && !ms.some((x) => RECORDS_COMMS.has(x.stage_key) && (x.comms_sent_at || x.status === "done"))) return false;
          const g = gateKeyOf(m);
          return !g || isDone(g);
        };

        // 1. Done signals
        for (const m of ms) {
          if (m.status !== "pending") continue;
          let done = false;
          const sig: string = m.done_signal || "manual";
          if (sig.startsWith("bm_status:")) done = jobRank >= rank(sig.slice("bm_status:".length));
          else if (sig === "ch_filed") done = ch?.state === "completed";
          else if (sig === "bm_gone") done = ct ? ct.state === "completed" : ch?.state === "completed";
          if (done) {
            const { error } = await db.from("job_milestones").update({ status: "done", done_at: now, done_signal: sig.split(":")[0], updated_at: now }).eq("id", m.id);
            if (error) throw new Error(error.message);
            m.status = "done"; m.done_at = now; stats.doneMarked++;
          }
        }
        // Records in (or the books closed) makes the request and chases moot.
        if (isDone("records_in") || isDone("close_books")) {
          for (const m of ms) {
            if (m.status === "pending" && RECORDS_COMMS.has(m.stage_key)) {
              const { error } = await db.from("job_milestones").update({ status: "skipped", updated_at: now }).eq("id", m.id);
              if (error) throw new Error(error.message);
              m.status = "skipped"; stats.skipped++;
            }
          }
        }

        // 2. Recompute the stages still ahead
        const pinned: Record<string, string> = {};
        for (const m of ms) {
          if (m.status === "done") pinned[m.stage_key] = (m.done_at || m.due_date).slice(0, 10);
          else if (m.status === "skipped" || m.status === "removed") pinned[m.stage_key] = m.due_date;
          else if (m.pinned_by) pinned[m.stage_key] = m.due_date;
          else if (externalOverdue(m)) pinned[m.stage_key] = today; // slides daily until it lands
        }
        const owners: Record<string, string | null> = {};
        for (const m of ms) if (m.owner_id && !(m.owner_role in owners)) owners[m.owner_role] = m.owner_id;
        const ctx: JobContext = {
          periodEnd: plan.period_end,
          chDeadline: plan.ch_deadline, ctDeadline: plan.ct_deadline,
          hasMeeting: plan.has_meeting ?? byKey.has("client_meeting"),
          booksWithUs: plan.books_with_us ?? byKey.has("close_books"),
          owners, workingDays, pinned,
        };
        const chain = computeChain(stages, ctx);
        for (const c of chain) {
          const m = byKey.get(c.stage_key);
          if (!m || m.status !== "pending" || m.pinned_by) continue;
          if (externalOverdue(m)) continue; // keep the original date so lateness shows
          if (c.due_date !== m.due_date) {
            const { error } = await db.from("job_milestones").update({ due_date: c.due_date, planned_date: m.kind === "work" ? c.due_date : m.planned_date, updated_at: now }).eq("id", m.id);
            if (error) throw new Error(error.message);
            m.due_date = c.due_date; stats.datesMoved++;
          }
        }

        // 3. Risk
        let risk = "none"; let reason: string | null = null;
        const fileCh = byKey.get("file_ch");
        const limit = plan.ch_deadline ? toISO(minusWorkingDays(parseISO(plan.ch_deadline), 10)) : null;
        const lateExternal = ms.find((m) => externalOverdue(m));
        const lateStaff = ms.filter((m) => m.status === "pending" && !EXTERNAL_GATES.has(m.stage_key) && m.owner_role !== "client" && m.due_date < today);
        const unasked = ms.find((m) => m.stage_key === "records_in" && m.status === "pending" && m.due_date < today && !externalOverdue(m));
        const daysLate = (iso: string) => Math.round((parseISO(today).getTime() - parseISO(iso).getTime()) / 86400000);
        if (fileCh && fileCh.status === "pending" && limit && today > limit) {
          risk = "urgent"; reason = `Inside the Companies House buffer (deadline ${plan.ch_deadline})`;
        } else if (fileCh && fileCh.status === "pending" && limit && fileCh.due_date >= limit) {
          risk = "at_risk"; reason = lateExternal
            ? `${lateExternal.label} ${daysLate(lateExternal.due_date)} days late; filing pushed to the buffer`
            : "Filing date sits on the statutory buffer";
        } else if (lateExternal) {
          risk = "waiting_on_client"; reason = `${lateExternal.label} ${daysLate(lateExternal.due_date)} days overdue`;
        } else if (unasked) {
          risk = "slipped"; reason = `Records not yet requested; they were due ${daysLate(unasked.due_date)} days ago`;
        } else if (lateStaff.length) {
          const worst = lateStaff.sort((a, b) => a.due_date.localeCompare(b.due_date))[0];
          risk = "slipped"; reason = `${worst.label} ${daysLate(worst.due_date)} days overdue`;
        }
        const patch: Record<string, unknown> = { last_tick_at: now, updated_at: now };
        if (risk !== plan.risk || reason !== plan.risk_reason) {
          patch.risk = risk; patch.risk_reason = reason;
          if (risk !== plan.risk) { patch.risk_at = now; stats.riskChanged++; }
        }
        const { error: uErr } = await db.from("job_plans").update(patch).eq("id", plan.id);
        if (uErr) throw new Error(uErr.message);
      } catch (e) {
        stats.errors.push(`${plan.entity_id}/${plan.period_end}: ${(e as Error).message}`);
      }
    }

    // ── BM completions (sql/311): confirmed once the import shows the job gone ──
    try {
      const { data: openC } = await db.from("bm_task_completions").select("id, bm_task_schedule_id").is("confirmed_at", null).not("bm_task_schedule_id", "is", null).limit(1000);
      const ids = (openC || []).map((c) => c.bm_task_schedule_id);
      if (ids.length) {
        const { data: gone } = await db.from("bm_task_schedule").select("id").in("id", ids).eq("state", "completed");
        const goneIds = new Set((gone || []).map((g) => g.id));
        const confirm = (openC || []).filter((c) => goneIds.has(c.bm_task_schedule_id)).map((c) => c.id);
        if (confirm.length) {
          await db.from("bm_task_completions").update({ confirmed_at: new Date().toISOString(), confirmed_by: "bm_import" }).in("id", confirm);
          (stats as Record<string, unknown>).completionsConfirmed = confirm.length;
        }
      }
    } catch (e) { stats.errors.push(`completions: ${(e as Error).message}`); }

    // ── Records-in signals from the client (sql/319) ─────────────────────
    // A reply on the request/chase thread (or from the address we wrote
    // to), or a portal upload, after we sent. It holds the chases and asks
    // the owner; it never closes the stage by itself.
    const notify = async (recipient: string, kind: string, title: string, body: string | null, link: string | null, sourceKey: string) => {
      const { data: dup } = await db.from("notifications").select("id").eq("source_key", sourceKey).limit(1);
      if (dup && dup.length) return false;
      const { error } = await db.from("notifications").insert({ recipient_id: recipient, kind, title, body, link_path: link, source_key: sourceKey });
      return !error;
    };
    try {
      let signals = 0;
      for (const plan of plans || []) {
        const ms = milestonesByPlan.get(plan.id) || [];
        const recordsIn = ms.find((m) => m.stage_key === "records_in");
        if (!recordsIn || recordsIn.status !== "pending") continue;
        const sent = ms.filter((m) => RECORDS_COMMS.has(m.stage_key) && m.comms_sent_at);
        if (!sent.length) continue;
        const since = sent.map((m) => m.comms_sent_at).sort().pop() as string;
        const threads = sent.map((m) => m.comms_thread_id).filter(Boolean);
        const tos = [...new Set(sent.map((m) => String(m.comms_to || "").toLowerCase()).filter(Boolean))];
        const { data: inbound } = await db.from("client_communications")
          .select("gmail_message_id, gmail_thread_id, from_email, occurred_at, subject")
          .eq("entity_id", plan.entity_id).eq("direction", "in").gt("occurred_at", since).order("occurred_at", { ascending: false }).limit(20);
        const reply = (inbound || []).find((c) => (c.gmail_thread_id && threads.includes(c.gmail_thread_id)) || tos.includes(String(c.from_email || "").toLowerCase()));
        const { data: uploads } = await db.from("onboarding_documents").select("id, original_name, created_at")
          .eq("entity_id", plan.entity_id).eq("uploaded_by_kind", "client").gt("created_at", since).order("created_at", { ascending: false }).limit(1);
        const upload = uploads?.[0];
        const cand = reply && (!upload || reply.occurred_at >= upload.created_at)
          ? { kind: "reply", ref: reply.gmail_message_id, at: reply.occurred_at, what: reply.subject ? `replied: "${String(reply.subject).slice(0, 80)}"` : "replied" }
          : upload ? { kind: "upload", ref: upload.id, at: upload.created_at, what: `uploaded ${upload.original_name || "a document"}` } : null;
        if (!cand || cand.ref === plan.client_signal_ref) continue;
        const { error } = await db.from("job_plans").update({
          client_signal_at: cand.at, client_signal_kind: cand.kind, client_signal_ref: cand.ref, signal_handled_at: null, chases_held: true, updated_at: new Date().toISOString(),
        }).eq("id", plan.id);
        if (error) throw new Error(error.message);
        plan.chases_held = true; signals++;
        const owner = recordsIn.owner_id || ms.find((m) => m.owner_role === "preparer")?.owner_id;
        const { data: ent } = await db.from("entities").select("name").eq("id", plan.entity_id).maybeSingle();
        if (owner) await notify(owner, "records_signal", `${ent?.name || "A client"} ${cand.what}`, "Records in, or still waiting? Chases are on hold until you say.", "/planner", `records_signal:${plan.id}:${cand.ref}`);
      }
      (stats as Record<string, unknown>).clientSignals = signals;
    } catch (e) { stats.errors.push(`signals: ${(e as Error).message}`); }

    // ── Client comms (sql/309) ───────────────────────────────────────────
    // Armed and past the start date: send the comms stages that are due.
    // Requests and chases on their date; the meeting invite three weeks
    // ahead of the meeting; the approval chase once approval is overdue.
    // One send per stage, ever, and a stage only when its gate is done.
    const { data: settings } = await db.from("job_plan_settings").select("*").eq("id", true).maybeSingle();
    const commsLive = !!settings?.comms_armed && (!settings?.comms_from || today >= settings.comms_from);
    if (commsLive) {
      const inviteFrom = toISO(new Date(parseISO(today).getTime() + 21 * 86400000));
      let sentThisRun = 0;
      for (const plan of plans || []) {
        const ms = milestonesByPlan.get(plan.id) || [];
        const byKey = new Map(ms.map((m) => [m.stage_key, m]));
        const gateDone = (m: Record<string, any>) => {
          const rule = stages.find((s) => s.key === m.stage_key);
          const alts = (rule?.gate_stage_key || "").split("|").map((x) => x.trim()).filter(Boolean);
          const g = alts.find((k) => byKey.has(k));
          if (!g) return true;
          const gm = byKey.get(g)!;
          return gm.status === "done" || gm.status === "skipped";
        };
        for (const m of ms) {
          if (sentThisRun >= 100) break;
          if (m.status !== "pending" || m.comms_sent_at) continue;
          let due = false;
          // A chase waits while the client's reply or upload is unreviewed (sql/319).
          if (["chase_1", "chase_2"].includes(m.stage_key) && plan.chases_held) continue;
          if (["request_records", "chase_1", "chase_2"].includes(m.stage_key)) due = m.due_date <= today && gateDone(m);
          else if (m.stage_key === "client_meeting") due = m.due_date <= inviteFrom && gateDone(m);
          else if (m.stage_key === "approval") due = m.due_date < today && gateDone(m);
          if (!due) continue;
          try {
            await sendForMilestone(db, m.id, { mailbox: settings?.comms_mailbox || null, actorId: null });
            stats.commsSent++; sentThisRun++;
          } catch (e) {
            stats.commsErrors++;
            stats.errors.push(`comms ${m.stage_key} ${plan.entity_id}: ${(e as Error).message}`);
          }
        }
      }
    }

    // ── Holiday handovers (sql/320): remind, then escalate; never send ────
    try {
      const { data: hols } = await db.from("staff_holidays").select("id, staff_id, date_from, date_to, handover_due").gte("date_from", today).order("date_from").limit(200);
      const { data: managers } = await db.from("staff_profiles").select("id").eq("is_active", true).eq("can_manage_portal", true);
      const dow = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
      let reminded = 0, escalated = 0;
      for (const h of hols || []) {
        if (!h.handover_due) continue;
        const { data: rows } = await db.from("staff_holiday_handovers").select("decision, sent_at, cover_staff_id").eq("holiday_id", h.id);
        // "Undecided" needs the task list; the browser holds the block engine, so
        // here we count the server-known tasks against the decisions taken.
        const { data: ms } = await db.from("job_milestones").select("id, job_plans!inner(status)").eq("owner_id", h.staff_id).eq("status", "pending").eq("job_plans.status", "committed").gte("due_date", h.date_from).lte("due_date", h.date_to);
        const { data: bm } = await db.from("bm_task_schedule").select("id").eq("assignee_id", h.staff_id).eq("state", "planned").is("excluded_at", null).or(`and(scheduled_for_date.gte.${h.date_from},scheduled_for_date.lte.${h.date_to}),and(bm_deadline.gte.${h.date_from},bm_deadline.lte.${h.date_to})`);
        const known = (ms?.length || 0) + (bm?.length || 0);
        const decided = (rows || []).length;
        const unsent = (rows || []).some((r) => r.decision === "covered" && r.cover_staff_id && !r.sent_at);
        const undecided = Math.max(0, known - decided);
        if (!undecided && !unsent) continue;
        const wd = new Set(String(workingDays[h.staff_id] || "mon,tue,wed,thu,fri").split(",").map((x) => x.trim().toLowerCase()));
        // The owner's first working day of the week the deadline falls in.
        const due = new Date(`${h.handover_due}T12:00:00Z`);
        const monday = new Date(due); monday.setUTCDate(due.getUTCDate() - ((due.getUTCDay() + 6) % 7));
        let firstWorking = new Date(monday);
        for (let i = 0; i < 7 && !wd.has(dow[firstWorking.getUTCDay()]); i++) firstWorking.setUTCDate(firstWorking.getUTCDate() + 1);
        if (today === firstWorking.toISOString().slice(0, 10) && today <= h.handover_due) {
          if (await notify(h.staff_id, "handover_reminder", `Handover due ${h.handover_due}`, `${undecided ? `${undecided} task${undecided === 1 ? "" : "s"} with no plan. ` : ""}${unsent ? "Handovers not yet sent. " : ""}Open Holidays to sort it.`, "/planner", `handover:${h.id}:remind`)) reminded++;
        }
        if (today > h.handover_due && unsent) {
          const { name } = staffById.get(h.staff_id) || { name: null };
          for (const m of managers || []) {
            if (await notify(m.id, "handover_overdue", `Handover overdue: ${String(name || "a team member").split(" ")[0]}`, `Off from ${h.date_from}; handovers were due ${h.handover_due} and have not been sent.`, "/planner", `handover:${h.id}:overdue:${m.id}`)) escalated++;
          }
        }
      }
      (stats as Record<string, unknown>).handoverReminders = reminded;
      (stats as Record<string, unknown>).handoverEscalations = escalated;
    } catch (e) { stats.errors.push(`handovers: ${(e as Error).message}`); }

    // ── Nudges ───────────────────────────────────────────────────────────
    // Armed, and past the start date if one is set (sql/308): the team has a
    // deadline to commit their lists before anyone is chased.
    const nudgesLive = !!settings?.nudges_armed && (!settings?.nudges_from || today >= settings.nudges_from);
    if (nudgesLive) {
      // A month past the year end, month end to month end: YE 31 Jan is due a
      // nudge on 28 Feb, YE 30 Sep on 31 Oct — the same day Plan the Job shows
      // its nudge flag. The query takes anything 28+ days past (a superset)
      // and the filter decides. setUTCMonth(−1) on today used to roll 31 Mar
      // back to 3 Mar and 31 Oct to 1 Oct, a day or so off at month ends.
      const todayNoon = parseISO(today);
      const { data: jobs, error: jErr } = await db.from("v_accounts_jobs")
        .select("entity_id, client, period_end, ch_deadline, preparer_id, plan_status")
        .lte("period_end", toISO(addDays(todayNoon, -28))).not("preparer_id", "is", null)
        .order("ch_deadline").limit(500);
      if (jErr) throw new Error(jErr.message);
      const candidates = (jobs || []).filter((j) =>
        j.plan_status !== "committed" && addMonths(parseISO(j.period_end), 1) <= todayNoon);
      const since = new Date(Date.now() - (settings.nudge_every_days || 7) * 86400000).toISOString();
      const { data: recent } = await db.from("job_plan_nudges").select("entity_id, period_end").gte("sent_at", since);
      const recentKeys = new Set((recent || []).map((r) => `${r.entity_id}|${r.period_end}`));

      let token: Awaited<ReturnType<typeof getValidGmailToken>> | null = null;
      let sentThisRun = 0;
      for (const j of candidates) {
        if (recentKeys.has(`${j.entity_id}|${j.period_end}`)) continue;
        if (sentThisRun >= 50) break;
        const who = staffById.get(j.preparer_id);
        if (!who?.email) continue;
        try {
          if (!token) token = await getValidGmailToken(settings.nudge_mailbox || undefined);
          const link = `${APP_URL}/planner/plan/${j.entity_id}/${j.period_end}`;
          const ye = new Date(`${j.period_end}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
          const subject = `Plan the job: ${j.client}, year end ${ye}`;
          const text = [
            `Hi ${(who.name || "").split(" ")[0]},`,
            "",
            `${j.client}'s accounts for the year to ${ye} are a month past the year end and there's no plan on them yet.`,
            "",
            `Open the job and confirm the chain (or change it): ${link}`,
            "",
            `The default puts records in by month 3 and the filing by month 7; Companies House needs them by ${j.ch_deadline ? new Date(`${j.ch_deadline}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }) : "the statutory date"}.`,
            "",
            "Thanks",
          ].join("\n");
          const html = `<p>${text.replace(/\n/g, "<br>").replace(link, `<a href="${link}">${link}</a>`)}</p>`;
          const boundary = `=_athena_${crypto.randomUUID()}`;
          const mime = [
            `From: ${formatSender(token.displayName, token.accountEmail)}`,
            `To: ${who.email}`,
            `Subject: ${subject}`,
            `MIME-Version: 1.0`,
            `Content-Type: multipart/alternative; boundary="${boundary}"`,
            "", `--${boundary}`, `Content-Type: text/plain; charset="UTF-8"`, "", text,
            `--${boundary}`, `Content-Type: text/html; charset="UTF-8"`, "", html, `--${boundary}--`,
          ].join("\r\n");
          const resp = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
            method: "POST",
            headers: { Authorization: `Bearer ${token.accessToken}`, "Content-Type": "application/json" },
            body: JSON.stringify({ raw: base64UrlEncode(mime) }),
          });
          if (!resp.ok) throw new Error(`Gmail ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
          const sent = await resp.json();
          await db.from("job_plan_nudges").insert({
            entity_id: j.entity_id, period_end: j.period_end, preparer_id: j.preparer_id,
            mailbox: token.accountEmail, gmail_message_id: sent.id || null,
          });
          stats.nudged++; sentThisRun++;
        } catch (e) {
          stats.nudgeErrors++;
          stats.errors.push(`nudge ${j.client}: ${(e as Error).message}`);
          if (!token) break; // no mailbox: no point continuing
        }
      }
    }

    if (run?.id) {
      await db.from("scheduled_job_runs").update({
        finished_at: new Date().toISOString(),
        status: stats.errors.length ? (stats.plans ? "partial" : "failed") : "ok",
        stats, notes: stats.errors.slice(0, 5).join("; ") || null,
      }).eq("id", run.id);
    }
    return json({ success: true, started_at: startedAt, ...stats });
  } catch (e) {
    if (run?.id) {
      await db.from("scheduled_job_runs").update({ finished_at: new Date().toISOString(), status: "failed", notes: (e as Error).message, stats }).eq("id", run.id);
    }
    return json({ success: false, error: (e as Error).message, ...stats }, 500);
  }
});
