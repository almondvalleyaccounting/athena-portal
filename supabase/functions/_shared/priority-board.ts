// Priority board (sql/349): shared by job-plan (the board, reorder, apply,
// progress updates) and priority-email (the Monday email per person), so the
// board and the email can never disagree about a column or a date.
//
// One column per submitter: the owner of the job's Submission task, who does
// the review (Bobby, 2026-10-06), else the preparer. The jobs are those with a
// filing in the six months the Overview counts (this month and the next five).
// The column order drives the capacity queue (./priority.ts) that dates each
// job's internal review. Dates here are computed, never written.
//
// "Update due" (no update for N days) was removed on 2026-10-07: Bobby only
// wants to hear about delays, so silence means on track.

import { runQueue, daysOffMap } from "./priority.ts";

export const PRIORITY_TEMPLATES = ["annual_accounts", "self_assessment"];
export const BM_RANK: Record<string, number> = {
  "No Latest Action": 0, "No Progress": 0, "Records Requested": 1, "Part Records Received": 2,
  "Records Received": 3, "In Progress": 4, "Queries Requested": 5, "Queries Received": 6,
  "To Review": 7, "Reviewed": 8, "To Send to Client to Approve": 9, "Awaiting Approval": 10,
};
export const jobKey = (e: string, pe: string) => `${e}|${pe}`;
export const todayISO = () => new Date().toISOString().slice(0, 10);

export async function prioritySettings(db: any) {
  const { data } = await db.from("job_plan_settings").select("priority_buffer_wd").maybeSingle();
  return { buffer_wd: data?.priority_buffer_wd ?? 10 };
}

/** Every column of the board, or one person's. */
export async function buildBoard(db: any, templateKey: string, onlyStaff?: string | null) {
  const settings = await prioritySettings(db);
  const today = todayISO();
  const d = new Date(`${today}T12:00:00Z`);
  const windowEnd = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 6, 1)).toISOString().slice(0, 10);
  const view = templateKey === "self_assessment" ? "v_sa_jobs" : "v_accounts_jobs";
  const { data: t, error: tErr } = await db.from("workflow_templates").select("id").eq("key", templateKey).maybeSingle();
  if (tErr) throw new Error(tErr.message);
  if (!t) throw new Error(`Workflow template ${templateKey} is not set up`);

  const jobs: Record<string, any>[] = [];
  for (let from = 0; ; from += 1000) {
    const q = db.from(view).select("*").not("ch_deadline", "is", null).lt("ch_deadline", windowEnd).order("entity_id").order("period_end").range(from, from + 999);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    jobs.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  const entityIds = [...new Set(jobs.map((j) => j.entity_id))];

  // Plans of this template (v_accounts_jobs joins plans of any template).
  const plans = new Map<string, Record<string, any>>();
  const milestones = new Map<string, Record<string, any>>(); // `${plan}|${stage}`
  const ranks = new Map<string, Record<string, any>>();
  const lastUpdate = new Map<string, Record<string, any>>();
  const prepHoursBm = new Map<string, number>();
  for (let i = 0; i < entityIds.length; i += 150) {
    const ids = entityIds.slice(i, i + 150);
    const [pl, rk, up] = await Promise.all([
      db.from("job_plans").select("id, entity_id, period_end, status").eq("template_id", t.id).in("entity_id", ids),
      db.from("job_priority").select("entity_id, period_end, staff_id, rank").eq("template_key", templateKey).in("entity_id", ids),
      db.from("job_progress_updates").select("entity_id, period_end, confidence, reason_code, escalate, note, author_id, created_at").eq("template_key", templateKey).in("entity_id", ids).order("created_at", { ascending: false }),
    ]);
    for (const r of [pl, rk, up]) if (r.error) throw new Error(r.error.message);
    for (const x of pl.data || []) plans.set(jobKey(x.entity_id, x.period_end), x);
    for (const x of rk.data || []) ranks.set(jobKey(x.entity_id, x.period_end), x);
    for (const x of up.data || []) { const k = jobKey(x.entity_id, x.period_end); if (!lastUpdate.has(k)) lastUpdate.set(k, x); }
  }
  const planIds = [...plans.values()].map((x) => x.id);
  for (let i = 0; i < planIds.length; i += 150) {
    const { data, error } = await db.from("job_milestones").select("plan_id, stage_key, status, due_date, hours, pinned_by")
      .in("plan_id", planIds.slice(i, i + 150)).in("stage_key", ["prepare", "internal_review"]);
    if (error) throw new Error(error.message);
    for (const m of data || []) milestones.set(`${m.plan_id}|${m.stage_key}`, m);
  }
  // The column is the Submission task's owner (Bobby, 2026-10-06: "my
  // reviews will be with the submitter"), else the preparer when a job has
  // no Submission task. 31 of 110 accounts jobs had different people on
  // the two tasks, e.g. the bookkeeper holding Preparation.
  const submitter = new Map<string, string>();
  const bmIds = [...new Set(jobs.flatMap((j) => [j.prep_job_id, j.ch_job_id]).filter(Boolean))] as string[];
  for (let i = 0; i < bmIds.length; i += 150) {
    const { data, error } = await db.from("bm_task_schedule").select("id, scheduled_hours, assignee_id").in("id", bmIds.slice(i, i + 150));
    if (error) throw new Error(error.message);
    for (const r of data || []) {
      prepHoursBm.set(r.id, Number(r.scheduled_hours) || 0);
      if (r.assignee_id) submitter.set(r.id, r.assignee_id);
    }
  }
  for (const j of jobs) j.board_owner = (j.ch_job_id && submitter.get(j.ch_job_id)) || j.preparer_id || null;
  if (onlyStaff) jobs.splice(0, jobs.length, ...jobs.filter((j) => j.board_owner === onlyStaff));

  // People: whoever owns a column in the window (or the one asked for).
  const staffIds = [...new Set(jobs.map((j) => j.board_owner).filter(Boolean))] as string[];
  if (onlyStaff && !staffIds.includes(onlyStaff)) staffIds.push(onlyStaff);
  const [st, cap, hol] = await Promise.all([
    staffIds.length ? db.from("staff_profiles").select("id, name, weekly_capacity_hours, working_days, is_active").in("id", staffIds) : Promise.resolve({ data: [], error: null }),
    staffIds.length ? db.from("priority_capacity").select("staff_id, weekly_hours").eq("template_key", templateKey).in("staff_id", staffIds) : Promise.resolve({ data: [], error: null }),
    staffIds.length ? db.from("staff_holidays").select("staff_id, date_from, date_to, half_day").in("staff_id", staffIds).gte("date_to", today) : Promise.resolve({ data: [], error: null }),
  ]);
  for (const r of [st, cap, hol]) if (r.error) throw new Error(r.error.message);

  const columns = [];
  for (const s of (st.data || []) as Record<string, any>[]) {
    const mine = jobs.filter((j) => j.board_owner === s.id).map((j) => {
      const k = jobKey(j.entity_id, j.period_end);
      const plan = plans.get(k) || null;
      const prep = plan ? milestones.get(`${plan.id}|prepare`) : null;
      const rev = plan ? milestones.get(`${plan.id}|internal_review`) : null;
      const rank = BM_RANK[j.bm_status as string] ?? -1;
      return {
        key: k, entity_id: j.entity_id, client: j.client, period_end: j.period_end, template_key: templateKey,
        ch_deadline: j.ch_deadline, ct_deadline: j.ct_deadline ?? null, bm_status: j.bm_status ?? null,
        prep_job_id: j.prep_job_id ?? null, ch_job_id: j.ch_job_id ?? null,
        plan_id: plan?.id ?? null, plan_status: plan?.status ?? null,
        prep_hours: Number(prep?.hours ?? prepHoursBm.get(j.prep_job_id) ?? 5) || 5,
        prep_done: ["done", "skipped"].includes(prep?.status) || rank >= 7,
        review_done: ["done", "skipped"].includes(rev?.status) || rank >= 8,
        review_saved: rev && rev.status === "pending" ? rev.due_date : null,
        review_pinned: !!rev?.pinned_by,
        rank: ranks.get(k)?.rank ?? null,
        last_update: lastUpdate.get(k) || null,
      };
    });
    // Ranked jobs in their order; an unranked one goes in ahead of the first
    // ranked job with a later statutory date, so new work lands where its
    // deadline says rather than at the bottom.
    const ranked = mine.filter((j) => j.rank != null).sort((a, b) => a.rank! - b.rank!);
    const unranked = mine.filter((j) => j.rank == null).sort((a, b) => String(a.ch_deadline).localeCompare(String(b.ch_deadline)) || String(a.client).localeCompare(String(b.client)));
    const ordered = [...ranked];
    for (const u of unranked) {
      const at = ordered.findIndex((o) => String(o.ch_deadline) > String(u.ch_deadline));
      if (at < 0) ordered.push(u); else ordered.splice(at, 0, u);
    }
    const capRow = (cap.data || []).find((c: Record<string, any>) => c.staff_id === s.id);
    const defaultHours = Math.round((Number(s.weekly_capacity_hours) || 0) / 2 * 4) / 4;
    const weekly = capRow ? Number(capRow.weekly_hours) : defaultHours;
    const slots = runQueue(ordered.map((j) => ({ key: j.key, prepHours: j.prep_hours, prepDone: j.prep_done, reviewDone: j.review_done, statutory: j.ch_deadline })), {
      today, weeklyHours: weekly, workingDays: s.working_days,
      daysOff: daysOffMap(((hol.data || []) as Array<Record<string, any>>).filter((h) => h.staff_id === s.id) as any), bufferWd: settings.buffer_wd,
    });
    const bySlot = new Map(slots.map((x) => [x.key, x]));
    const tiles = ordered.map((j, i) => {
      const slot = bySlot.get(j.key)!;
      // Out of date = the queue now says something materially different
      // (more than three days). The queue starts from today, so without a
      // tolerance every saved date would be "out" by a day each morning.
      // Prepared work keeps a saved date that is still ahead of us.
      const keepPrepared = j.prep_done && !!j.review_saved && j.review_saved >= today;
      const drift = slot.review_date && j.review_saved ? Math.abs(Date.parse(slot.review_date) - Date.parse(j.review_saved)) / 86400000 : null;
      const outOfDate = !j.review_done && !keepPrepared && !!slot.review_date && (drift === null || drift > 3);
      return { ...j, position: i + 1, review_computed: slot.review_date, limit: slot.limit, capped: slot.capped, overdue: slot.overdue, prep_from: slot.prep_from, prep_to: slot.prep_to, out_of_date: outOfDate };
    });
    columns.push({ staff_id: s.id, name: s.name, is_active: s.is_active, weekly_hours: weekly, default_hours: defaultHours, hours_set: !!capRow, working_days: s.working_days, jobs: tiles });
  }
  columns.sort((a, b) => b.jobs.length - a.jobs.length || String(a.name).localeCompare(String(b.name)));
  return { settings, today, window_end: windowEnd, template: templateKey, columns };
}
