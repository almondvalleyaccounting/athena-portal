// standing-blocks — the Calendar's repeating blocks of time (sql/312).
//
// A block is a scheduled_tasks master with block_kind set. Its sub-tasks live
// in standing_block_items. Completing an occurrence writes completed_tasks
// (so the instance drops off the planner, as before) and timesheet_entries —
// one per client when the minutes were logged by client, one for the block
// otherwise. Browser writes to the items table are not granted; this is the
// only path.
//
// Actions (POST, staff JWT):
//   save_block   { block: { id?, title, block_kind, assignee_id, recurrence, weekdays?, planned_date, duration, service?, span_days?, span_end_day?, until?, carry_over? }, items?: [{ entity_id?, label?, minutes_default? }] }
//   delete_block { id }
//   complete     { block_id, occurrence_date, minutes?, items?: [{ entity_id?, label?, minutes }], note?, not_required? }

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireStaffOrService, authErrorResponse } from "../_shared/require-staff.ts";

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
const KINDS = new Set(["mail", "onboarding", "confirmation_statements", "payroll_weekly", "payroll_monthly", "bookkeeping", "admin", "other"]);
const CADENCES = new Set(["daily", "weekly", "fortnightly", "monthly"]);
const SERVICES = new Set(["Admin", "Accounts Production", "Corporation Tax", "Self Assessment", "VAT Returns", "Bookkeeping", "Payroll", "Management Accounts", "Company Secretarial", "Advisory", "SA302s", "Accountant Certificates"]);
const DOW = new Set(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);
const SERVICE_FOR_KIND: Record<string, string> = {
  mail: "Admin", onboarding: "Admin", confirmation_statements: "Company Secretarial",
  payroll_weekly: "Payroll", payroll_monthly: "Payroll", bookkeeping: "Bookkeeping", admin: "Admin", other: "Admin",
};

class BadRequest extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}
function uuid(v: unknown, field: string): string {
  const s = String(v ?? "");
  if (!UUID.test(s)) throw new BadRequest(`${field} must be a uuid`);
  return s;
}
function optUuid(v: unknown, field: string): string | null {
  if (v === null || v === undefined || v === "") return null;
  return uuid(v, field);
}
function isoDate(v: unknown, field: string): string {
  const s = String(v ?? "");
  if (!ISO.test(s) || Number.isNaN(new Date(`${s}T12:00:00Z`).getTime())) throw new BadRequest(`${field} must be YYYY-MM-DD`);
  return s;
}
function minutes(v: unknown, field: string, max = 1440): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > max) throw new BadRequest(`${field} must be 0–${max} minutes`);
  return Math.round(n);
}
function text(v: unknown, max: number): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim().slice(0, max);
  return s || null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ success: false, error: "POST required" }, 405);

  let caller;
  try { caller = await requireStaffOrService(req, { allowService: false }); }
  catch (e) { return authErrorResponse(e, cors); }
  const me = caller.userId!;

  const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const p = await req.json().catch(() => ({}));
  const now = new Date().toISOString();

  try {
    switch (String(p.action || "")) {
      case "save_block": {
        const b = (p.block && typeof p.block === "object" ? p.block : {}) as Record<string, unknown>;
        const id = optUuid(b.id, "block.id");
        const title = text(b.title, 120);
        if (!title) throw new BadRequest("A title is needed");
        const kind = String(b.block_kind || "other");
        if (!KINDS.has(kind)) throw new BadRequest("Unknown block kind");
        const recurrence = String(b.recurrence || "daily");
        if (!CADENCES.has(recurrence)) throw new BadRequest("Cadence must be daily, weekly, fortnightly or monthly");
        let weekdays: string | null = null;
        if (recurrence !== "monthly") {
          const days = String(b.weekdays || "mon,tue,wed,thu,fri").split(",").map((x) => x.trim().toLowerCase()).filter((x) => DOW.has(x));
          if (!days.length) throw new BadRequest("Pick at least one day");
          weekdays = [...new Set(days)].join(",");
        }
        const plannedDate = isoDate(b.planned_date, "block.planned_date");
        const duration = minutes(b.duration, "block.duration", 720);
        if (!duration || duration < 5) throw new BadRequest("Hours per occurrence must be at least 5 minutes");
        const service = SERVICES.has(String(b.service || "")) ? String(b.service) : SERVICE_FOR_KIND[kind];
        const assignee = optUuid(b.assignee_id, "block.assignee_id");
        const spanDays = recurrence === "monthly" && b.span_days != null && b.span_days !== "" ? Number(b.span_days) : null;
        const spanEnd = recurrence === "monthly" && b.span_end_day != null && b.span_end_day !== "" ? Number(b.span_end_day) : null;
        if (spanDays != null && !(Number.isInteger(spanDays) && spanDays >= 1 && spanDays <= 23)) throw new BadRequest("Working days must be 1–23");
        if (spanEnd != null && !(Number.isInteger(spanEnd) && spanEnd >= 1 && spanEnd <= 31)) throw new BadRequest("The end day must be 1–31");
        const until = b.until ? isoDate(b.until, "block.until") : null;
        if (until && until < plannedDate) throw new BadRequest("The end date is before the start");
        const carryOver = b.carry_over === true;

        const row = {
          title, task_type: "block_out", block_kind: kind, service, assignee_id: assignee,
          recurring: true, recurrence, weekdays, status: "not_started", source: "manual",
          planned_date: new Date(`${plannedDate}T00:00:00`).toISOString(), planned_hour: null, planned_min: 0,
          duration, entity_id: null, updated_at: now,
          span_days: recurrence === "monthly" && !spanEnd ? (spanDays ?? 1) : null, span_end_day: spanEnd, until, carry_over: carryOver,
        };
        let blockId = id;
        if (blockId) {
          const { error } = await db.from("scheduled_tasks").update(row).eq("id", blockId);
          if (error) throw new Error(error.message);
        } else {
          const { data, error } = await db.from("scheduled_tasks").insert({ ...row, created_by: me }).select("id").single();
          if (error) throw new Error(error.message);
          blockId = data.id as string;
        }

        // Items: replace the set. Minutes per item are defaults for the
        // completion form, not commitments.
        const items = Array.isArray(p.items) ? p.items.slice(0, 200) : null;
        if (items) {
          const rows = items.map((it: Record<string, unknown>, i: number) => ({
            block_id: blockId,
            entity_id: optUuid(it?.entity_id, `items[${i}].entity_id`),
            label: text(it?.label, 120),
            minutes_default: minutes(it?.minutes_default, `items[${i}].minutes_default`),
            sort_order: i,
          })).filter((r: { entity_id: string | null; label: string | null }) => r.entity_id || r.label);
          const { error: dErr } = await db.from("standing_block_items").delete().eq("block_id", blockId);
          if (dErr) throw new Error(dErr.message);
          if (rows.length) {
            const { error: iErr } = await db.from("standing_block_items").insert(rows);
            if (iErr) throw new Error(iErr.message);
          }
        }
        return json({ success: true, id: blockId });
      }

      case "delete_block": {
        const id = uuid(p.id, "id");
        const { error } = await db.from("scheduled_tasks").delete().eq("id", id);
        if (error) throw new Error(error.message);
        return json({ success: true });
      }

      case "complete": {
        const blockId = uuid(p.block_id, "block_id");
        const occ = isoDate(p.occurrence_date, "occurrence_date");
        const { data: block, error } = await db.from("scheduled_tasks").select("id, title, service, assignee_id, block_kind, carry_over").eq("id", blockId).maybeSingle();
        if (error) throw new Error(error.message);
        if (!block) throw new BadRequest("Block not found", 404);
        const notRequired = p.not_required === true;
        // A block that does not carry over is explained, not silently dropped.
        if (notRequired && !block.carry_over && !text(p.note, 1000)) throw new BadRequest("Say briefly why it did not happen");
        const items = Array.isArray(p.items) ? p.items.slice(0, 200) : [];
        const perItem = items.map((it: Record<string, unknown>, i: number) => ({
          entity_id: optUuid(it?.entity_id, `items[${i}].entity_id`),
          label: text(it?.label, 120),
          minutes: minutes(it?.minutes, `items[${i}].minutes`) || 0,
        })).filter((x: { minutes: number }) => x.minutes > 0);
        const itemTotal = perItem.reduce((s: number, x: { minutes: number }) => s + x.minutes, 0);
        const overall = minutes(p.minutes, "minutes") || 0;
        const total = notRequired ? null : (itemTotal > 0 ? itemTotal : overall);
        const note = text(p.note, 1000);

        // Already done? completed_tasks is what makes the instance disappear.
        const { data: dup } = await db.from("completed_tasks").select("id").eq("source_type", "scheduled_instance").eq("source_id", blockId).eq("occurrence_date", occ).maybeSingle();
        if (dup) throw new BadRequest("That occurrence is already marked");

        const { error: cErr } = await db.from("completed_tasks").insert({
          source_type: "scheduled_instance", source_id: blockId, occurrence_date: occ, title: block.title,
          entity_id: null, service: block.service, assignee_id: block.assignee_id || me, completed_by: me,
          completion_mins: total, not_required: notRequired,
        });
        if (cErr) throw new Error(cErr.message);

        if (note) {
          await db.from("task_progress_notes").insert({
            task_type: "scheduled", task_id: blockId, note, created_by: me, created_by_name: null, is_completion: true, occurrence_date: occ,
          });
        }

        // Timesheet: the work date is the occurrence, never a future day.
        const today = now.slice(0, 10);
        const workDate = occ > today ? today : occ;
        const service = block.service || "Admin";
        const tsRows = !notRequired && itemTotal > 0
          ? perItem.map((x: { entity_id: string | null; label: string | null; minutes: number }) => ({
              staff_id: me, entity_id: x.entity_id, service, work_date: workDate, minutes: x.minutes,
              notes: x.label ? `${block.title} — ${x.label}` : block.title, source: "completed", source_task_id: blockId,
            }))
          : (!notRequired && overall > 0
              ? [{ staff_id: me, entity_id: null, service, work_date: workDate, minutes: overall, notes: block.title, source: "completed", source_task_id: blockId }]
              : []);
        if (tsRows.length) {
          const { error: tErr } = await db.from("timesheet_entries").insert(tsRows);
          if (tErr) throw new Error(tErr.message);
        }
        return json({ success: true, minutes: total, timesheet_rows: tsRows.length });
      }

      default:
        throw new BadRequest("Unknown action");
    }
  } catch (e) {
    const status = e instanceof BadRequest ? e.status : 500;
    console.error("[standing-blocks]", (e as Error).message);
    return json({ success: false, error: (e as Error).message }, status);
  }
});
