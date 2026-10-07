// priority-email — Athena Portal
//
// The Monday priorities email, one per person (Bobby, 2026-10-07; sql/350).
// It follows the "Team Deadlines" digest (11:00 UTC) at 11:15 and tells each
// person what is needed from them and when, straight off their Priority
// column (sql/349, _shared/priority-board.ts), so the email and the board can
// never disagree:
//   1. Can't make its safe date — the queue clamps these; talk to the manager.
//   2. Due for internal review in the next `window_days`, in board order.
//   3. Coming up — the next `upcoming_count` jobs in the column.
// Accounts only (Bobby, 2026-10-07): self assessment will get its own email
// later, not triggered yet, so EMAIL_TEMPLATES leaves it out.
//
// It is a briefing, not a questionnaire: no reply is expected and nobody is
// chased. Each job has one link, "Report a delay or I'm stuck", which opens
// Athena (signed in) with that job's progress update pre-filled. A report
// emails the manager straight away (job-plan progress_update).
//
// Auth: x-cron-secret matching priority_email_config.cron_secret, OR an
// active staff JWT. Deployed verify_jwt=false like the other cron emails:
// pg_net posts the secret with no Authorization header. The check below is
// the control.
// Body: { dry_run?: boolean (default true), test_recipient?: string, staff_id?: uuid }
//   test_recipient sends every email (or just staff_id's) to that one address.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sendEmail } from "../_shared/resend.ts";
import { buildBoard } from "../_shared/priority-board.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const EMAIL_TEMPLATES = ["annual_accounts"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Row = Record<string, any>;

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}
function esc(s: unknown): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function fmt(iso: string | null): string {
  if (!iso) return "—";
  return new Date(`${String(iso).slice(0, 10)}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
}
function fmtY(iso: string | null): string {
  if (!iso) return "—";
  return new Date(`${String(iso).slice(0, 10)}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}
const addDays = (iso: string, n: number) => { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const LABEL: Record<string, { name: string; filing: string }> = {
  annual_accounts: { name: "Accounts", filing: "CH" },
  self_assessment: { name: "Self assessment", filing: "HMRC" },
};

interface Section { template: string; problems: Row[]; due: Row[]; upcoming: Row[] }

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ success: false, error: "POST required" }, 405);
  const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  const { data: cfg } = await db.from("priority_email_config").select("*").eq("id", true).maybeSingle();
  const expected = (cfg?.cron_secret as string) || "";
  const got = req.headers.get("x-cron-secret") || "";
  if (!(expected && got === expected)) {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ success: false, error: "Missing authorization" }, 401);
    const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { headers: { Authorization: authHeader } } });
    const { data: { user }, error: authErr } = await anon.auth.getUser();
    if (authErr || !user) return json({ success: false, error: "Invalid token" }, 401);
    const { data: prof } = await db.from("staff_profiles").select("is_active").eq("id", user.id).single();
    if (!prof?.is_active) return json({ success: false, error: "Not authorised" }, 403);
  }

  const body = await req.json().catch(() => ({}));
  const dryRun = body.dry_run !== false;
  const testRecipient: string | null = body.test_recipient ? String(body.test_recipient) : null;
  if (testRecipient && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(testRecipient)) return json({ success: false, error: "test_recipient is not an email address" }, 400);
  const onlyStaff: string | null = body.staff_id && UUID.test(String(body.staff_id)) ? String(body.staff_id) : null;
  const windowDays = Number(cfg?.window_days) || 14;
  const upcomingCount = Number(cfg?.upcoming_count ?? 5);

  // Everyone's columns, both kinds of work.
  const people = new Map<string, { name: string; sections: Section[] }>();
  let today = "";
  for (const tKey of EMAIL_TEMPLATES) {
    let board;
    try { board = await buildBoard(db, tKey, onlyStaff); }
    catch (e) { return json({ success: false, error: `${tKey}: ${(e as Error).message}` }, 500); }
    today = board.today;
    const until = addDays(today, windowDays);
    for (const col of board.columns) {
      if (!col.is_active) continue;
      const open = col.jobs.filter((j: Row) => !j.review_done && !j.deprioritised);
      const when = (j: Row) => j.review_saved || j.review_computed;
      const problems = open.filter((j: Row) => j.capped || j.overdue);
      const rest = open.filter((j: Row) => !(j.capped || j.overdue));
      const due = rest.filter((j: Row) => when(j) && when(j) <= until);
      const upcoming = rest.filter((j: Row) => !due.includes(j)).slice(0, upcomingCount);
      if (!problems.length && !due.length && !upcoming.length) continue;
      if (!people.has(col.staff_id)) people.set(col.staff_id, { name: col.name, sections: [] });
      people.get(col.staff_id)!.sections.push({ template: tKey, problems, due, upcoming });
    }
  }

  const ids = [...people.keys()];
  const { data: staff } = ids.length ? await db.from("staff_profiles").select("id, name, email, is_active").in("id", ids) : { data: [] };
  const emailOf = new Map<string, string>(((staff || []) as Row[]).filter((s) => s.is_active && s.email).map((s) => [s.id, s.email]));
  const summary = [...people.entries()].map(([id, p]) => ({
    staff_id: id, name: p.name, has_email: emailOf.has(id),
    problems: p.sections.reduce((n, s) => n + s.problems.length, 0),
    due: p.sections.reduce((n, s) => n + s.due.length, 0),
    upcoming: p.sections.reduce((n, s) => n + s.upcoming.length, 0),
  }));
  if (dryRun) return json({ success: true, dry_run: true, today, window_days: windowDays, people: summary });
  if (!testRecipient && !cfg?.sending_enabled) return json({ success: false, error: "sending disabled (priority_email_config.sending_enabled=false)" }, 409);

  const athena = Deno.env.get("PORTAL_PUBLIC_URL") || "https://portal.almondvalleyaccounting.co.uk";
  const reportUrl = (j: Row) => `${athena}/planner/priority?template=${j.template_key}&job=${encodeURIComponent(j.key)}&report=new`;
  const td = "padding:7px 10px;border-top:1px solid #f1f5f9;vertical-align:top;";
  const table = (rows: Row[], tKey: string, showPos: boolean) => `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb;border-radius:10px;overflow:hidden;font-size:13px;margin-top:6px;">
      <tr style="background:#f8fafc;">
        ${showPos ? `<td style="padding:7px 10px;font-weight:600;color:#475569;width:28px;">#</td>` : ""}
        <td style="padding:7px 10px;font-weight:600;color:#475569;">Client</td>
        <td style="padding:7px 10px;font-weight:600;color:#475569;white-space:nowrap;">Internal review</td>
        <td style="padding:7px 10px;font-weight:600;color:#475569;white-space:nowrap;">${LABEL[tKey].filing} deadline</td>
        <td style="padding:7px 10px;"></td>
      </tr>
      ${rows.map((j) => `<tr>
        ${showPos ? `<td style="${td}color:#94a3b8;">${j.position}</td>` : ""}
        <td style="${td}color:#0f172a;font-weight:600;">${esc(j.client)}${j.prep_done ? ` <span style="color:#6d28d9;font-weight:500;">· prepared</span>` : ""}</td>
        <td style="${td}color:#0f172a;white-space:nowrap;">${esc(fmt(j.review_saved || j.review_computed))}</td>
        <td style="${td}color:#64748b;white-space:nowrap;">${esc(fmtY(j.ch_deadline))}</td>
        <td style="${td}text-align:right;white-space:nowrap;"><a href="${esc(reportUrl(j))}" style="color:#b45309;font-size:12px;">Report a delay or I'm stuck</a></td>
      </tr>`).join("")}
    </table>`;
  const textRows = (rows: Row[], tKey: string) => rows.map((j) => `  - ${j.client} · review ${fmt(j.review_saved || j.review_computed)} · ${LABEL[tKey].filing} ${fmtY(j.ch_deadline)}\n    Delay or stuck? ${reportUrl(j)}`).join("\n");

  const results: Row[] = [];
  for (const [id, p] of people) {
    const to = testRecipient || emailOf.get(id);
    if (!to) { results.push({ staff_id: id, name: p.name, ok: false, error: "no email address" }); continue; }
    const first = String(p.name || "").split(" ")[0] || "there";
    const sectionsHtml = p.sections.map((s) => `
      <tr><td style="padding-top:18px;font-size:15px;font-weight:700;color:#1E4560;">${LABEL[s.template].name}</td></tr>
      ${s.problems.length ? `<tr><td style="padding-top:8px;">
        <div style="font-size:13px;font-weight:700;color:#991b1b;">Can't make the safe date · ${s.problems.length}</div>
        <div style="font-size:12.5px;color:#7f1d1d;">At the current order and hours these miss the statutory date less the buffer. Raise them with the manager.</div>
        ${table(s.problems, s.template, true)}</td></tr>` : ""}
      ${s.due.length ? `<tr><td style="padding-top:10px;">
        <div style="font-size:13px;font-weight:700;color:#0f172a;">Ready for review in the next ${windowDays} days · ${s.due.length}</div>
        <div style="font-size:12.5px;color:#64748b;">In the order to work them.</div>
        ${table(s.due, s.template, true)}</td></tr>` : ""}
      ${s.upcoming.length ? `<tr><td style="padding-top:10px;">
        <div style="font-size:13px;font-weight:700;color:#475569;">Coming up next</div>
        ${table(s.upcoming, s.template, true)}</td></tr>` : ""}`).join("");
    const inner = `
      <tr><td style="font-size:19px;font-weight:700;color:#1E4560;padding-bottom:2px;">Priorities</td></tr>
      <tr><td style="font-size:13px;color:#64748b;">${esc(fmtY(today))}${testRecipient ? ` · <b style="color:#b45309;">TEST — this is ${esc(p.name)}'s email</b>` : ""}</td></tr>
      <tr><td style="font-size:13.5px;color:#334155;padding-top:12px;line-height:1.55;">
        Hi ${esc(first)}, here's what's needed from you and when, from the Priority board. The internal review date is when each job should be ready for review.
        <b>No need to reply.</b> If anything here is going to be late, or you're stuck, use the link beside it and the manager is told straight away.
      </td></tr>
      ${sectionsHtml}
      <tr><td style="padding:22px 0 4px;">
        <a href="${esc(athena)}/planner/priority" style="display:inline-block;background:#1E4560;color:#fff;text-decoration:none;padding:11px 20px;border-radius:10px;font-weight:600;font-size:14px;">Open the Priority board</a>
      </td></tr>
      <tr><td style="padding-top:22px;border-top:1px solid #f1f5f9;font-size:11px;color:#94a3b8;text-align:center;">Almond Valley Accounting · Monday priorities · from Athena's Work module</td></tr>`;
    const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f6f8f9;font-family:'Outfit',-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;color:#1e293b;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f8f9;padding:32px 16px;"><tr><td align="center">
        <table role="presentation" width="680" cellpadding="0" cellspacing="0" style="background:#fff;border:1px solid #e2e8f0;border-radius:14px;padding:28px;">${inner}</table>
      </td></tr></table></body></html>`;
    const text = [
      `PRIORITIES — ${fmtY(today)}${testRecipient ? ` (TEST: ${p.name}'s email)` : ""}`,
      `Hi ${first}, here's what's needed from you and when. No need to reply. If anything is going to be late, or you're stuck, use the link beside it and the manager is told straight away.`,
      ...p.sections.map((s) => [
        `\n${LABEL[s.template].name.toUpperCase()}`,
        s.problems.length ? `Can't make the safe date (${s.problems.length}):\n${textRows(s.problems, s.template)}` : "",
        s.due.length ? `Ready for review in the next ${windowDays} days (${s.due.length}), in order:\n${textRows(s.due, s.template)}` : "",
        s.upcoming.length ? `Coming up next:\n${textRows(s.upcoming, s.template)}` : "",
      ].filter(Boolean).join("\n\n")),
      ``, `Priority board: ${athena}/planner/priority`,
    ].join("\n");
    const subject = `${testRecipient ? `[Test: ${first}] ` : ""}Priorities — ${fmt(today)}`;
    const r = await sendEmail({ to, subject, html, text });
    results.push({ staff_id: id, name: p.name, ok: r.ok, resend_id: r.id, error: r.error });
  }

  const sent = results.filter((r) => r.ok).length;
  if (!testRecipient && sent) await db.from("priority_email_config").update({ last_sent_on: today, updated_at: new Date().toISOString() }).eq("id", true);
  await db.from("audit_log").insert({
    action: "priority_email_sent", entity_type: "priority_email", entity_id: null,
    detail: { today, people: results.length, sent, test: Boolean(testRecipient), failures: results.filter((r) => !r.ok) },
  });
  return json({ success: sent === results.length, sent, results });
});
