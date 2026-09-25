// Workflow chain computation — shared by the job-plan function (propose) and,
// later, the nightly recompute. Pure: no database access. Dates are ISO
// YYYY-MM-DD strings handled at UTC noon so month arithmetic never drifts.
//
// Rules (docs/WORKFLOW_TEMPLATE_ACCOUNTS_2026-09-25.md):
//   due = anchor (year end | another stage | statutory date) + offset
//   due = max(due, minGapStage.due + minGapDays)          the one-month rule
//   due = min(due, statutory − N working days)            the hard limit
//   roll to the owner's next working day (forward for positive offsets,
//   back for negative ones), never crossing a hard limit.
// A stage whose `requires` does not match the job's variant is left out.

export interface StageRule {
  seq: number;
  key: string;
  label: string;
  kind: string;
  owner_role: string;
  anchor: "ye" | "stage" | "statutory_ch" | "statutory_ct";
  anchor_stage_key: string | null;
  offset_months: number;
  offset_days: number;
  gate_stage_key: string | null;
  done_signal: string;
  min_gap_stage_key: string | null;
  min_gap_days: number | null;
  hard_limit: "statutory_ch" | "statutory_ct" | null;
  hard_limit_buffer_wd: number;
  hours: number | null;
  requires: string | null;
}

export interface JobContext {
  periodEnd: string;                 // YYYY-MM-DD
  chDeadline: string | null;
  ctDeadline: string | null;
  hasMeeting: boolean;
  booksWithUs: boolean;
  /** owner_role -> staff id (null when unresolved) */
  owners: Record<string, string | null>;
  /** staff id -> working days e.g. "mon,tue,wed,thu,fri" */
  workingDays: Record<string, string | null>;
  /** stage_key -> due date to keep (pinned milestones) */
  pinned?: Record<string, string>;
}

export interface Milestone {
  stage_key: string;
  seq: number;
  label: string;
  kind: string;
  hours: number | null;
  owner_role: string;
  owner_id: string | null;
  due_date: string;
  planned_date: string | null;
  gate_stage_key: string | null;
  done_signal: string;
}

// ── Date helpers ─────────────────────────────────────────────────────────────

const DAY = 86400000;
const DOW = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

export function parseISO(s: string): Date {
  return new Date(`${s}T12:00:00Z`);
}
export function toISO(d: Date): string {
  return d.toISOString().slice(0, 10);
}
export function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * DAY);
}
export function addMonths(d: Date, n: number): Date {
  const out = new Date(d);
  const day = out.getUTCDate();
  out.setUTCDate(1);
  out.setUTCMonth(out.getUTCMonth() + n);
  const last = new Date(Date.UTC(out.getUTCFullYear(), out.getUTCMonth() + 1, 0)).getUTCDate();
  out.setUTCDate(Math.min(day, last));
  return out;
}

export function workingSet(wd: string | null | undefined): Set<string> {
  const s = new Set((wd || "mon,tue,wed,thu,fri").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean));
  return s.size ? s : new Set(["mon", "tue", "wed", "thu", "fri"]);
}
function isWorking(d: Date, set: Set<string>): boolean {
  return set.has(DOW[d.getUTCDay()]);
}
/** Roll to a working day: dir +1 forward, −1 back. */
export function roll(d: Date, set: Set<string>, dir: 1 | -1): Date {
  let x = new Date(d);
  for (let i = 0; i < 14 && !isWorking(x, set); i++) x = addDays(x, dir);
  return x;
}
/** N working days before a date (Mon–Fri), for statutory buffers. */
export function minusWorkingDays(d: Date, n: number): Date {
  const set = workingSet(null);
  let x = new Date(d);
  let left = n;
  while (left > 0) {
    x = addDays(x, -1);
    if (isWorking(x, set)) left--;
  }
  return roll(x, set, -1);
}

// ── Chain computation ────────────────────────────────────────────────────────

function applies(stage: StageRule, ctx: JobContext): boolean {
  switch (stage.requires) {
    case "meeting": return ctx.hasMeeting;
    case "no_meeting": return !ctx.hasMeeting;
    case "books_with_us": return ctx.booksWithUs;
    case "books_not_with_us": return !ctx.booksWithUs;
    default: return true;
  }
}

/** "a|b" → the first key that is in the chain. */
function firstPresent(keys: string | null, present: Set<string>): string | null {
  if (!keys) return null;
  for (const k of keys.split("|").map((x) => x.trim())) if (present.has(k)) return k;
  return null;
}

export function computeChain(stages: StageRule[], ctx: JobContext): Milestone[] {
  const active = stages.filter((s) => applies(s, ctx)).sort((a, b) => a.seq - b.seq);
  const byKey = new Map(active.map((s) => [s.key, s]));
  const present = new Set(byKey.keys());
  const due = new Map<string, Date>();
  const visiting = new Set<string>();

  const limitFor = (s: StageRule): Date | null => {
    const stat = s.hard_limit === "statutory_ch" ? ctx.chDeadline
      : s.hard_limit === "statutory_ct" ? ctx.ctDeadline : null;
    return stat ? minusWorkingDays(parseISO(stat), s.hard_limit_buffer_wd ?? 10) : null;
  };

  const resolve = (key: string): Date => {
    const cached = due.get(key);
    if (cached) return cached;
    const s = byKey.get(key)!;
    if (visiting.has(key)) throw new Error(`Workflow stage cycle at ${key}`);
    visiting.add(key);

    let d: Date;
    const pinnedISO = ctx.pinned?.[key];
    if (pinnedISO) {
      d = parseISO(pinnedISO);
    } else {
      // Anchor
      let base: Date | null = null;
      if (s.anchor === "ye") base = parseISO(ctx.periodEnd);
      else if (s.anchor === "statutory_ch") base = ctx.chDeadline ? parseISO(ctx.chDeadline) : null;
      else if (s.anchor === "statutory_ct") base = ctx.ctDeadline ? parseISO(ctx.ctDeadline) : null;
      else if (s.anchor === "stage") {
        const ak = firstPresent(s.anchor_stage_key, present);
        base = ak ? resolve(ak) : null;
      }
      if (!base) base = parseISO(ctx.periodEnd); // fall back rather than fail the whole chain
      d = addDays(addMonths(base, s.offset_months || 0), s.offset_days || 0);

      // Minimum gap (the one-month rule)
      const gk = firstPresent(s.min_gap_stage_key, present);
      if (gk && s.min_gap_days) {
        const floor = addDays(resolve(gk), s.min_gap_days);
        if (floor > d) d = floor;
      }

      // Working day for the owner
      const ownerId = ctx.owners[s.owner_role] ?? null;
      const set = workingSet(ownerId ? ctx.workingDays[ownerId] : null);
      d = roll(d, set, (s.offset_days || 0) < 0 ? -1 : 1);

      // Hard limit
      const lim = limitFor(s);
      if (lim && d > lim) d = lim;
    }

    visiting.delete(key);
    due.set(key, d);
    return d;
  };

  for (const s of active) resolve(s.key);

  return active.map((s) => ({
    stage_key: s.key,
    seq: s.seq,
    label: s.label,
    kind: s.kind,
    hours: s.hours,
    owner_role: s.owner_role,
    owner_id: ctx.owners[s.owner_role] ?? null,
    due_date: toISO(due.get(s.key)!),
    planned_date: s.kind === "work" ? toISO(due.get(s.key)!) : null,
    gate_stage_key: firstPresent(s.gate_stage_key, present),
    done_signal: s.done_signal,
  }));
}
