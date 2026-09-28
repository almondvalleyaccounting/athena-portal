// reassign-digest — Athena Portal
//
// The Wednesday email to info@: every reassignment made in Athena that
// BrightManager hasn't caught up with yet, so someone can key it into BM
// (Bobby, 2026-09-28). Cron: run_reassign_digest(), Wednesdays 08:00 UTC.
//
// Two sources, the same ones the Admin Task List works from:
//   1. allocation_changes drafts — a client × service moved to someone else.
//      Written by a permanent reassign (job-plan reassign_bm_job, sql/330) and
//      by the capacity planner. They sit on the Admin Task List under "Task
//      reallocations to apply in BM" until someone marks them done there.
//   2. One-off task reassignments (bm_task_schedule.assignee_override_kind =
//      'one_off') — this task only, no allocation draft. They clear themselves
//      the night BM shows the new owner.
// "BM shows" is the live BM-inferred assignee (v_inferred_allocations) for a
// draft, and bm_assignee_name for a task.
//
// Nothing is ticked off here. The email is a view of the list, not a queue.
//
// Auth: x-cron-secret matching reassign_digest_config.cron_secret, OR an
// active staff JWT. Deployed verify_jwt=false like the other cron emails:
// pg_net posts the secret with no Authorization header. The check below is
// the control.
// Body: { dry_run?: boolean (default true), test_recipient?: string }

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sendEmail } from "../_shared/resend.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

type Row = Record<string, any>;

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}
function esc(s: unknown): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(String(iso).slice(0, 10) + "T00:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}
function daysSince(iso: string | null, today: Date): number {
  if (!iso) return 0;
  return Math.max(0, Math.floor((today.getTime() - new Date(String(iso).slice(0, 10) + "T00:00:00Z").getTime()) / 86400000));
}
// 'accounts_submission' → 'Accounts submission'
function serviceLabel(id: string | null): string {
  const s = String(id || "").replace(/_/g, " ").trim();
  return s ? s[0].toUpperCase() + s.slice(1) : "—";
}
const shortTask = (name: string | null) => String(name || "").replace(/\s*(Year End|Quarterly End|Monthly End|Period End|Tax Year).*$/i, "");

interface Item {
  to: string;          // who it moves to
  client: string;
  what: string;        // service or task
  bmNow: string;       // who BM shows today
  since: string | null;
  kind: "service" | "task";
  note: string | null;
}

const FORMER = new Set(["nlac", "archived"]);

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ success: false, error: "POST required" }, 405);
  const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { data: cfg } = await service.from("reassign_digest_config").select("*").eq("id", true).maybeSingle();
  const expected = (cfg?.cron_secret as string) || "";
  const got = req.headers.get("x-cron-secret") || "";
  if (!(expected && got === expected)) {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ success: false, error: "Missing authorization" }, 401);
    const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { headers: { Authorization: authHeader } } });
    const { data: { user }, error: authErr } = await anon.auth.getUser();
    if (authErr || !user) return json({ success: false, error: "Invalid token" }, 401);
    const { data: prof } = await service.from("staff_profiles").select("is_active").eq("id", user.id).single();
    if (!prof?.is_active) return json({ success: false, error: "Not authorised" }, 403);
  }

  const body = await req.json().catch(() => ({}));
  const dryRun = body.dry_run !== false;
  const testRecipient: string | null = body.test_recipient || null;
  const now = new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  const [drafts, oneOffs, inferred, staff, overridden] = await Promise.all([
    service.from("allocation_changes")
      .select("id, entity_id, canonical_service_id, proposed_fee_earner_id, proposed_manager_id, note, created_at, entity:entities!allocation_changes_entity_id_fkey(name, entity_status)")
      .eq("status", "draft"),
    service.from("bm_task_schedule")
      .select("id, bm_task_name, bm_assignee_name, assignee_override_id, assignee_override_at, assignee_override_note, entity:entities!bm_task_schedule_entity_id_fkey(name, entity_status)")
      .eq("assignee_override_kind", "one_off").eq("state", "planned").is("excluded_at", null).not("assignee_override_id", "is", null),
    service.from("v_inferred_allocations").select("entity_id, canonical_service_id, assignee_id"),
    service.from("staff_profiles").select("id, name"),
    // What BM itself says on the tasks Athena has overridden. The inferred
    // allocation above is built from assignee_id, which the override has
    // already changed, so it would report the new owner as BM's.
    service.from("bm_task_schedule").select("entity_id, assignee_override_id, bm_assignee_name")
      .eq("state", "planned").is("excluded_at", null).not("assignee_override_id", "is", null),
  ]);
  for (const [label, r] of [["drafts", drafts], ["one-offs", oneOffs], ["BM allocations", inferred], ["staff", staff], ["overrides", overridden]] as const) {
    if (r.error) return json({ success: false, error: `${label}: ${r.error.message}` }, 500);
  }
  const nameOf = new Map<string, string>((staff.data || []).map((s: Row) => [s.id, s.name]));
  const bmOf = new Map<string, string>((inferred.data || []).map((v: Row) => [`${v.entity_id}|${v.canonical_service_id}`, v.assignee_id]));
  const current = (r: Row) => !FORMER.has(r.entity?.entity_status ?? "active");
  const bmNameOf = new Map<string, string>();
  for (const o of (overridden.data || []) as Row[]) if (o.bm_assignee_name) bmNameOf.set(`${o.entity_id}|${o.assignee_override_id}`, o.bm_assignee_name);
  // A draft BM already agrees with has been keyed in and only needs ticking
  // off the Admin Task List; it isn't listed as something to move.
  let alreadyInBm = 0;

  const items: Item[] = [
    ...(drafts.data || []).filter(current).flatMap((d: Row): Item[] => {
      const viaOverride = d.proposed_fee_earner_id ? bmNameOf.get(`${d.entity_id}|${d.proposed_fee_earner_id}`) : null;
      const bm = bmOf.get(`${d.entity_id}|${d.canonical_service_id}`);
      if (!viaOverride && d.proposed_fee_earner_id && bm === d.proposed_fee_earner_id) { alreadyInBm++; return []; }
      const to = d.proposed_fee_earner_id ? nameOf.get(d.proposed_fee_earner_id) : null;
      const mgr = d.proposed_manager_id ? nameOf.get(d.proposed_manager_id) : null;
      return [{
        to: to || (mgr ? `${mgr} (as manager)` : "No one named"),
        client: d.entity?.name || "—",
        what: serviceLabel(d.canonical_service_id),
        bmNow: viaOverride || (bm ? (nameOf.get(bm) || "—") : "—"),
        since: d.created_at, kind: "service", note: d.note,
      }];
    }),
    ...(oneOffs.data || []).filter(current).map((t: Row): Item => ({
      to: nameOf.get(t.assignee_override_id) || "—",
      client: t.entity?.name || "—",
      what: shortTask(t.bm_task_name),
      bmNow: t.bm_assignee_name || "—",
      since: t.assignee_override_at, kind: "task", note: t.assignee_override_note,
    })),
  ].sort((a, b) => a.to.localeCompare(b.to) || a.client.localeCompare(b.client) || a.what.localeCompare(b.what));

  const services = items.filter((i) => i.kind === "service").length;
  const tasks = items.length - services;
  const summary = { items: items.length, services, tasks, oldest_days: items.reduce((m, i) => Math.max(m, daysSince(i.since, today)), 0), already_in_bm: alreadyInBm };

  const recipients: string[] = testRecipient ? [testRecipient] : ((cfg?.recipient_emails as string[]) || []).filter((e) => e?.includes("@"));
  if (dryRun) return json({ success: true, dry_run: true, recipients: recipients.length, ...summary, preview: items.slice(0, 10) });
  if (!items.length && cfg?.skip_when_empty !== false && !testRecipient) return json({ success: true, skipped: true, reason: "nothing to reassign", ...summary });
  if (!recipients.length) return json({ success: false, error: "no recipients" }, 400);
  if (!testRecipient && !cfg?.sending_enabled) return json({ success: false, error: "sending disabled (reassign_digest_config.sending_enabled=false)" }, 409);

  const athenaUrl = Deno.env.get("PORTAL_PUBLIC_URL") || "https://portal.almondvalleyaccounting.co.uk";
  const wcLabel = today.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
  const groups = new Map<string, Item[]>();
  for (const i of items) { if (!groups.has(i.to)) groups.set(i.to, []); groups.get(i.to)!.push(i); }

  const td = "padding:6px 10px;border-top:1px solid #f1f5f9;";
  const sections = [...groups.entries()].map(([to, list]) => `
    <tr><td style="padding-top:16px;">
      <div style="font-size:14px;font-weight:700;color:#1E4560;padding-bottom:6px;">To ${esc(to)} <span style="color:#94a3b8;font-weight:500;">· ${list.length}</span></div>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb;border-radius:10px;overflow:hidden;font-size:13px;">
        <tr style="background:#f8fafc;">
          <td style="padding:7px 10px;font-weight:600;color:#475569;">Client</td>
          <td style="padding:7px 10px;font-weight:600;color:#475569;">What moves</td>
          <td style="padding:7px 10px;font-weight:600;color:#475569;">BM shows now</td>
          <td style="padding:7px 10px;font-weight:600;color:#475569;text-align:right;">Waiting</td>
        </tr>
        ${list.map((i) => `<tr>
          <td style="${td}color:#0f172a;">${esc(i.client)}</td>
          <td style="${td}color:#475569;">${esc(i.what)}${i.kind === "task" ? ` <span style="color:#b45309;">(this task only)</span>` : ""}</td>
          <td style="${td}color:#64748b;white-space:nowrap;">${esc(i.bmNow)}</td>
          <td style="${td}color:#64748b;text-align:right;white-space:nowrap;" title="${esc(fmtDate(i.since))}">${daysSince(i.since, today)}d</td>
        </tr>`).join("")}
      </table>
    </td></tr>`).join("");

  const inner = `
    <tr><td style="font-size:19px;font-weight:700;color:#1E4560;padding-bottom:2px;">Reassignments to make in BrightManager</td></tr>
    <tr><td style="font-size:13px;color:#64748b;padding-bottom:4px;">${esc(wcLabel)} · ${items.length} outstanding${tasks ? ` (${services} by service, ${tasks} single task${tasks === 1 ? "" : "s"})` : ""}</td></tr>
    <tr><td style="font-size:13px;color:#475569;padding-top:8px;line-height:1.5;">
      These were moved in Athena and BrightManager still shows the old owner. For a service, change the assignee on the client's service in BM so future jobs follow; for "this task only", change just that task.
      Service moves stay on the Admin Task List until they're marked done there; single tasks drop off the night BM shows the new owner.
    </td></tr>
    ${items.length ? sections : `<tr><td style="padding-top:16px;color:#94a3b8;">Nothing outstanding — Athena and BrightManager agree.</td></tr>`}
    ${alreadyInBm ? `<tr><td style="padding-top:14px;font-size:12.5px;color:#64748b;">${alreadyInBm} more on the Admin Task List already show the new owner in BrightManager — they just need marking done there.</td></tr>` : ""}
    <tr><td style="padding:22px 0 4px;">
      <a href="${esc(athenaUrl)}/planner/tasks" style="display:inline-block;background:#1E4560;color:#fff;text-decoration:none;padding:11px 20px;border-radius:10px;font-weight:600;font-size:14px;">Open the Admin Task List</a>
    </td></tr>
    <tr><td style="padding-top:22px;border-top:1px solid #f1f5f9;font-size:11px;color:#94a3b8;text-align:center;">Almond Valley Accounting · Weekly reassignment list · from Athena's Work module</td></tr>`;
  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f6f8f9;font-family:'Outfit',-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;color:#1e293b;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f8f9;padding:32px 16px;"><tr><td align="center">
      <table role="presentation" width="640" cellpadding="0" cellspacing="0" style="background:#fff;border:1px solid #e2e8f0;border-radius:14px;padding:28px;">${inner}</table>
    </td></tr></table></body></html>`;
  const text = [
    `REASSIGNMENTS TO MAKE IN BRIGHTMANAGER — ${wcLabel}`,
    `${items.length} outstanding. For a service, change the assignee on the client's service in BM; for "this task only", just that task.`,
    ...[...groups.entries()].map(([to, list]) => `\nTo ${to} (${list.length}):\n` + list.map((i) => `  - ${i.client} · ${i.what}${i.kind === "task" ? " (this task only)" : ""} · BM shows ${i.bmNow} · ${daysSince(i.since, today)}d`).join("\n")),
    alreadyInBm ? `
${alreadyInBm} more already show the new owner in BM and just need marking done on the Admin Task List.` : "",
    ``, `Admin Task List: ${athenaUrl}/planner/tasks`,
  ].join("\n");

  const subject = `BrightManager: ${items.length} reassignment${items.length === 1 ? "" : "s"} to make — ${today.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" })}`;
  const r = await sendEmail({ to: recipients, subject, html, text });

  if (!testRecipient && r.ok) await service.from("reassign_digest_config").update({ last_sent_on: today.toISOString().slice(0, 10), updated_at: new Date().toISOString() }).eq("id", true);
  await service.from("audit_log").insert({
    action: "reassign_digest_sent", entity_type: "reassign_digest", entity_id: null,
    detail: { ...summary, recipients: recipients.length, test: Boolean(testRecipient), ok: r.ok, resend_id: r.id, error: r.error },
  });
  return json({ success: r.ok, ...summary, resend_id: r.id, error: r.error });
});
