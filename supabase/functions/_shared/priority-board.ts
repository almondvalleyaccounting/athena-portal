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
//
// Self assessment splits in two (sql/351, Bobby 2026-10-07):
//   * group "director": the person is a current director of a company client
//     whose accounts are on the board and not yet reviewed. The return rides
//     with that company — its internal review date is the company's (the
//     earliest, if several), capped at 31 Jan less the buffer — and it is not
//     dragged. It is delayed while any personal item (sa_income_items) is
//     outstanding.
//   * group "sole_trader": everyone else, in their own draggable capacity
//     queue. A director whose company is done or off the board goes to the
//     top of it until someone drags it.
//
// Deprioritised (Bobby, 2026-10-07): the client-level flag Ready Now and the
// Job Selector already use (entities.deprioritised_at / deprioritise_reason).
// A deprioritised job leaves the queue — no hours, no dates — and sits at the
// bottom of its column, greyed, until the flag is cleared.
//
// Target window (Bobby, 2026-10-07), accounts only: aim for internal review
// between year end + target_from and + target_to months (3 and 6), not just
// before the statutory limit. The queue won't date a review before the
// floor, and one landing after the target shows "Behind target".
// Expedited clients (entities.expedite) whose year end has passed skip the
// floor and are placed just below the last job in the column that is within
// expedite_guard_days of its filing deadline — never above one of those.

import { runQueue, daysOffMap } from "./priority.ts";
import { parseISO, toISO, minusWorkingDays, addMonths, addDays } from "./workflow.ts";

export const PRIORITY_TEMPLATES = ["annual_accounts", "self_assessment"];
export const BM_RANK: Record<string, number> = {
  "No Latest Action": 0, "No Progress": 0, "Records Requested": 1, "Part Records Received": 2,
  "Records Received": 3, "In Progress": 4, "Queries Requested": 5, "Queries Received": 6,
  "To Review": 7, "Reviewed": 8, "To Send to Client to Approve": 9, "Awaiting Approval": 10,
};
export const jobKey = (e: string, pe: string) => `${e}|${pe}`;
export const todayISO = () => new Date().toISOString().slice(0, 10);

export async function prioritySettings(db: any) {
  const { data } = await db.from("job_plan_settings").select("priority_buffer_wd, priority_target_from_months, priority_target_to_months, priority_expedite_guard_days").maybeSingle();
  return {
    buffer_wd: data?.priority_buffer_wd ?? 10,
    target_from_months: data?.priority_target_from_months ?? 3,
    target_to_months: data?.priority_target_to_months ?? 6,
    expedite_guard_days: data?.priority_expedite_guard_days ?? 30,
  };
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
  const depri = new Map<string, { reason: string | null; at: string }>();
  const expedited = new Set<string>();
  for (let i = 0; i < entityIds.length; i += 150) {
    const ids = entityIds.slice(i, i + 150);
    const [pl, rk, up, dp] = await Promise.all([
      db.from("job_plans").select("id, entity_id, period_end, status").eq("template_id", t.id).in("entity_id", ids),
      db.from("job_priority").select("entity_id, period_end, staff_id, rank").eq("template_key", templateKey).in("entity_id", ids),
      db.from("job_progress_updates").select("entity_id, period_end, confidence, reason_code, escalate, note, author_id, created_at").eq("template_key", templateKey).in("entity_id", ids).order("created_at", { ascending: false }),
      db.from("entities").select("id, deprioritise_reason, deprioritised_at, expedite").in("id", ids).or("deprioritised_at.not.is.null,expedite.eq.true"),
    ]);
    for (const r of [pl, rk, up, dp]) if (r.error) throw new Error(r.error.message);
    for (const x of dp.data || []) {
      if (x.deprioritised_at) depri.set(x.id, { reason: x.deprioritise_reason, at: x.deprioritised_at });
      if (x.expedite) expedited.add(x.id);
    }
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

  // ── Self assessment: who rides with a company, and outstanding income ──
  const follow = new Map<string, { company_id: string; company: string; review: string | null }>(); // SA entity -> company
  const orphanDirector = new Set<string>(); // directors whose company is done or off the board
  const incomeOpen = new Map<string, string[]>(); // job key -> outstanding item labels
  if (templateKey === "self_assessment" && jobs.length) {
    const saIds = [...new Set(jobs.map((j) => j.entity_id))] as string[];
    const personOf = new Map<string, string>();
    for (let i = 0; i < saIds.length; i += 150) {
      const { data, error } = await db.from("entities").select("id, linked_person_id").in("id", saIds.slice(i, i + 150)).not("linked_person_id", "is", null);
      if (error) throw new Error(error.message);
      for (const e of data || []) personOf.set(e.id, e.linked_person_id);
    }
    const persons = [...new Set(personOf.values())];
    const companiesOf = new Map<string, string[]>();
    for (let i = 0; i < persons.length; i += 150) {
      const { data, error } = await db.from("entity_people").select("entity_id, person_id, entities!inner(entity_status)")
        .eq("role", "director").is("ended_on", null).in("person_id", persons.slice(i, i + 150));
      if (error) throw new Error(error.message);
      for (const r of (data || []) as Record<string, any>[]) {
        if (["nlac", "archived"].includes(r.entities?.entity_status)) continue;
        companiesOf.set(r.person_id, [...(companiesOf.get(r.person_id) || []), r.entity_id]);
      }
    }
    if (companiesOf.size) {
      const acc = await buildBoard(db, "annual_accounts", null);
      const accOpen = new Map<string, Record<string, any>>(); // company -> its open job with the earliest review
      for (const c of acc.columns) for (const j of c.jobs) {
        if (j.review_done || j.deprioritised) continue;
        const when = j.review_saved || j.review_computed;
        const cur = accOpen.get(j.entity_id);
        if (!cur || String(when) < String(cur.when)) accOpen.set(j.entity_id, { ...j, when });
      }
      for (const [saId, person] of personOf) {
        const cos = companiesOf.get(person);
        if (!cos?.length) continue;
        const open = cos.map((c) => accOpen.get(c)).filter(Boolean) as Record<string, any>[];
        if (!open.length) { orphanDirector.add(saId); continue; }
        open.sort((a, b) => String(a.when).localeCompare(String(b.when)));
        follow.set(saId, { company_id: open[0].entity_id, company: open[0].client, review: open[0].when || null });
      }
    }
    const { data: cat } = await db.from("records_items").select("key, label");
    const labelOf = new Map(((cat || []) as Record<string, any>[]).map((c) => [c.key, c.label]));
    for (let i = 0; i < saIds.length; i += 150) {
      const { data, error } = await db.from("sa_income_items").select("entity_id, period_end, item_key, custom_text").in("entity_id", saIds.slice(i, i + 150)).is("received_at", null);
      if (error) throw new Error(error.message);
      for (const r of data || []) {
        const k = jobKey(r.entity_id, r.period_end);
        incomeOpen.set(k, [...(incomeOpen.get(k) || []), r.item_key ? (labelOf.get(r.item_key) || r.item_key) : r.custom_text]);
      }
    }
  }
  const limitOf = (statutory: string | null) => (statutory ? toISO(minusWorkingDays(parseISO(statutory), settings.buffer_wd)) : null);

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
        group: follow.has(j.entity_id) ? "director" : "sole_trader",
        is_director: follow.has(j.entity_id) || orphanDirector.has(j.entity_id),
        follows: follow.get(j.entity_id) || null,
        income_outstanding: incomeOpen.get(k) || [],
        deprioritised: depri.has(j.entity_id),
        expedite: expedited.has(j.entity_id) && String(j.period_end) < today,
        deprioritise_reason: depri.get(j.entity_id)?.reason ?? null,
      };
    });
    const parked = mine.filter((j) => j.deprioritised);
    const riders = mine.filter((j) => !j.deprioritised && j.group === "director");
    const queued = mine.filter((j) => !j.deprioritised && j.group !== "director");
    // Ranked jobs in their order; an unranked one goes in ahead of the first
    // ranked job with a later statutory date, so new work lands where its
    // deadline says rather than at the bottom.
    const ranked = queued.filter((j) => j.rank != null).sort((a, b) => a.rank! - b.rank!);
    const unranked = queued.filter((j) => j.rank == null).sort((a, b) => String(a.ch_deadline).localeCompare(String(b.ch_deadline)) || String(a.client).localeCompare(String(b.client)));
    // An unranked director whose company is done goes to the top (sql/351).
    const ordered = [...unranked.filter((u) => u.is_director), ...ranked];
    for (const u of unranked.filter((x) => !x.is_director)) {
      const at = ordered.findIndex((o) => String(o.ch_deadline) > String(u.ch_deadline));
      if (at < 0) ordered.push(u); else ordered.splice(at, 0, u);
    }
    if (templateKey === "annual_accounts") {
      const exp = ordered.filter((j) => j.expedite);
      if (exp.length) {
        const rest = ordered.filter((j) => !j.expedite);
        const guard = toISO(addDays(parseISO(today), settings.expedite_guard_days));
        let at = 0;
        rest.forEach((j, i) => { if (!j.review_done && String(j.ch_deadline) <= guard) at = i + 1; });
        ordered.splice(0, ordered.length, ...rest.slice(0, at), ...exp, ...rest.slice(at));
      }
    }
    const capRow = (cap.data || []).find((c: Record<string, any>) => c.staff_id === s.id);
    const defaultHours = Math.round((Number(s.weekly_capacity_hours) || 0) / 2 * 4) / 4;
    const weekly = capRow ? Number(capRow.weekly_hours) : defaultHours;
    const accounts = templateKey === "annual_accounts";
    const pe = (j: Record<string, any>) => parseISO(String(j.period_end));
    const slots = runQueue(ordered.map((j) => ({
      key: j.key, prepHours: j.prep_hours, prepDone: j.prep_done, reviewDone: j.review_done, statutory: j.ch_deadline,
      floor: accounts && !j.expedite ? toISO(addMonths(pe(j), settings.target_from_months)) : null,
      target: accounts ? toISO(addMonths(pe(j), settings.target_to_months)) : null,
    })), {
      today, weeklyHours: weekly, workingDays: s.working_days,
      daysOff: daysOffMap(((hol.data || []) as Array<Record<string, any>>).filter((h) => h.staff_id === s.id) as any), bufferWd: settings.buffer_wd,
    });
    const bySlot = new Map(slots.map((x) => [x.key, x]));
    const tiles: Record<string, any>[] = ordered.map((j, i) => {
      const slot = bySlot.get(j.key)!;
      // Out of date = the queue now says something materially different
      // (more than three days). The queue starts from today, so without a
      // tolerance every saved date would be "out" by a day each morning.
      // Prepared work keeps a saved date that is still ahead of us.
      const keepPrepared = j.prep_done && !!j.review_saved && j.review_saved >= today;
      const drift = slot.review_date && j.review_saved ? Math.abs(Date.parse(slot.review_date) - Date.parse(j.review_saved)) / 86400000 : null;
      const outOfDate = !j.review_done && !keepPrepared && !!slot.review_date && (drift === null || drift > 3);
      return { ...j, position: i + 1, review_computed: slot.review_date, limit: slot.limit, capped: slot.capped, overdue: slot.overdue, behind_target: slot.behind_target, prep_from: slot.prep_from, prep_to: slot.prep_to, out_of_date: outOfDate };
    });
    // Directors riding with a company: the company's date, capped at the safe
    // date; listed after the queue in their companies' order.
    riders.sort((a, b) => String(a.follows?.review).localeCompare(String(b.follows?.review)) || String(a.client).localeCompare(String(b.client)));
    for (const j of riders) {
      const limit = limitOf(j.ch_deadline);
      let review = j.follows?.review || limit;
      const capped = !!(limit && review && review > limit);
      if (capped) review = limit;
      const drift = review && j.review_saved ? Math.abs(Date.parse(review) - Date.parse(j.review_saved)) / 86400000 : null;
      tiles.push({
        ...j, position: null, review_computed: review, limit, capped, overdue: !!limit && limit < today, prep_from: null, prep_to: null,
        out_of_date: !j.review_done && !!review && (drift === null || drift > 3),
      });
    }
    parked.sort((a, b) => String(a.ch_deadline).localeCompare(String(b.ch_deadline)));
    for (const j of parked) tiles.push({ ...j, position: null, review_computed: null, limit: limitOf(j.ch_deadline), capped: false, overdue: false, prep_from: null, prep_to: null, out_of_date: false });
    columns.push({ staff_id: s.id, name: s.name, is_active: s.is_active, weekly_hours: weekly, default_hours: defaultHours, hours_set: !!capRow, working_days: s.working_days, jobs: tiles });
  }
  columns.sort((a, b) => b.jobs.length - a.jobs.length || String(a.name).localeCompare(String(b.name)));
  return { settings, today, window_end: windowEnd, template: templateKey, columns };
}
