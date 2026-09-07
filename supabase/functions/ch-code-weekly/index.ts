// ch-code-weekly — Athena Portal
// Monday-morning team email for the Companies House personal-code chaser
// (cron: run_ch_code_weekly, Mon 09:00 UTC).
//
// Shape, in reading order — actions first, history second:
//   1. Summary: codes still needed / received & entered this week / calls logged.
//   2. "Codes still needed" — every open request that has no code yet, one row
//      each, ranked by what to do: call needed, CS deadline close, chase due,
//      waiting on client.
//   3. "Codes received & entered this week" — one row per person.
//   4. "Calls logged this week" — one row per person.
//   5. "Other activity" — a single count line. Reminders and offers sent are
//      counts, not rows; nobody acts on them.
//
// It used to group last week's raw ch_code_activity by client and print every
// row. Two things made that unreadable: reconcile_ch_codes re-logged a code it
// had already landed on every BM import, and 700 duplicate entity_people links
// fanned its insert out two or three ways. So the same "code received" line
// appeared six times for one person. sql/279 makes the reconciler idempotent,
// and this function dedupes on top of it regardless — an email should not be
// the thing that notices a double-write. 249 rows last week became 34.
//
// Auth: x-cron-secret matching ch_code_chase_config.cron_secret, OR an
// active staff JWT (manual test runs).
// Body: { dry_run?: boolean, test_recipient?: string }

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;
const RESEND_FROM_EMAIL = Deno.env.get("RESEND_FROM_EMAIL") || "info@almondvalleyaccounting.co.uk";
const RESEND_FROM_NAME = Deno.env.get("RESEND_FROM_NAME") || "Almond Valley Accounting";
const ATHENA_URL = Deno.env.get("PORTAL_PUBLIC_URL") || "https://portal.almondvalleyaccounting.co.uk";

type Row = Record<string, unknown>;

// Stages that already hold a code. "Still needed" is everything before these.
const HAS_CODE = new Set(["s5_entered", "s6_submitted", "s7_rejected"]);

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}
function esc(s: unknown): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function daysUntil(dateStr: string | null): number | null {
  if (!dateStr) return null;
  return Math.ceil((new Date(dateStr + "T00:00:00Z").getTime() - Date.now()) / 86400000);
}
function dayKey(iso: string): string {
  return String(iso).slice(0, 10);
}
function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
}
function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
async function sendEmail(to: string[], subject: string, html: string, text: string) {
  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${RESEND_API_KEY}` },
    body: JSON.stringify({ from: `${RESEND_FROM_NAME} <${RESEND_FROM_EMAIL}>`, to, subject, html, text }),
  });
  const j = await resp.json().catch(() => ({}));
  return { ok: resp.ok, id: (j?.id as string) || null, error: resp.ok ? undefined : (j?.message || j) };
}

// Activity bodies → a label, and which section the line belongs in.
// "received" and "call" get their own rows; "other" is counted, never listed.
type Bucket = "received" | "call" | "other";
const ACTIVITY_LABELS: Array<[RegExp, string, Bucket]> = [
  [/^code received/i, "Code received & entered", "received"],
  [/found on brightmanager/i, "Code found on BrightManager & entered", "received"],
  [/submitted via inform direct/i, "Submitted via Inform Direct", "received"],
  [/call logged/i, "Call logged", "call"],
  [/^escalated/i, "Escalated", "call"],
  [/^offer emailed/i, "Offer sent", "other"],
  [/^chase #\d+ emailed/i, "Reminder sent", "other"],
  // Queue-sent emails (ch-code-queue-send bodies) — specific before generic.
  [/id\/poa reminder emailed/i, "ID/POA reminder sent", "other"],
  [/code reminder emailed/i, "Code reminder sent", "other"],
  [/self-verify reminder emailed/i, "Self-verify reminder sent", "other"],
  [/reminder emailed/i, "Reminder sent", "other"],
  [/^decision: we verify/i, "Decision: we verify", "other"],
  [/^decision: client is self/i, "Decision: client self-verifies", "other"],
  [/id\/poa received/i, "ID/proof of address received", "other"],
  [/moved to stage/i, "Stage moved", "other"],
  // Staff closing a request by hand. The free-text reason varies in case and
  // spelling ("Code recieved ."), so it is labelled, not echoed.
  [/^rejected \/ exited/i, "Removed from the chase", "other"],
];
function classify(body: string): { label: string; bucket: Bucket } {
  for (const [re, label, bucket] of ACTIVITY_LABELS) if (re.test(body)) return { label, bucket };
  // An unrecognised body still gets a line, but a shared key — otherwise two
  // near-identical free-text notes count as two different kinds of thing.
  return { label: body.trim().replace(/\s+/g, " "), bucket: "other" };
}

const shell = (inner: string) =>
  `<!doctype html><html><body style="margin:0;padding:0;background:#f6f8f9;font-family:'Outfit',-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;color:#1e293b;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f8f9;padding:32px 16px;"><tr><td align="center">
      <table role="presentation" width="620" cellpadding="0" cellspacing="0" style="background:#fff;border:1px solid #e2e8f0;border-radius:14px;padding:28px;">
        ${inner}
        <tr><td style="padding:20px 0 4px;">
          <a href="${esc(ATHENA_URL)}/onboarding/ch-codes" style="display:inline-block;background:#1E4560;color:#fff;text-decoration:none;padding:11px 20px;border-radius:10px;font-weight:600;font-size:14px;">Open in Athena</a>
        </td></tr>
        <tr><td style="padding-top:22px;border-top:1px solid #f1f5f9;font-size:11px;color:#94a3b8;text-align:center;">Almond Valley Accounting · CH personal code weekly</td></tr>
      </table>
    </td></tr></table>
  </body></html>`;

const heading = (text: string, count: number) => `
  <tr><td style="padding-top:22px;">
    <div style="font-size:12px;font-weight:700;color:#475569;text-transform:uppercase;letter-spacing:.5px;padding-bottom:7px;">${esc(text)} (${count})</div>`;

const tableOpen = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb;border-radius:10px;overflow:hidden;font-size:13px;">`;
const tableClose = `</table></td></tr>`;

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ success: false, error: "POST required" }, 405);
  const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { data: cfg } = await service.from("ch_code_chase_config").select("*").eq("id", true).maybeSingle();
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
  const dryRun = body.dry_run === true;
  const testRecipient: string | null = body.test_recipient || null;

  const since = new Date(Date.now() - 7 * 86400000).toISOString();
  const [{ data: activityRaw }, { data: staff }, { data: openReqsRaw }] = await Promise.all([
    service.from("ch_code_activity")
      .select("request_id, body, created_at, kind, request:ch_code_requests(person:people(name), entity:entities!ch_code_requests_entity_id_fkey(name, entity_status))")
      .in("kind", ["email_out", "system", "status_change"]).gte("created_at", since).order("created_at"),
    service.from("staff_profiles").select("id, email").eq("is_active", true),
    service.from("ch_code_requests")
      .select("id, chase_count, emails_sent, status, stage, handling, escalation_status, last_chased_at, person:people(name), entity:entities!ch_code_requests_entity_id_fkey(name, id, entity_status)")
      .not("stage", "in", "(s6_submitted,s7_rejected)"),
  ]);

  // Former clients (nlac/archived) never appear — not in the actions, not in
  // the history. We do no work for them.
  const FORMER = new Set(["nlac", "archived"]);
  const activity = (activityRaw || []).filter((a: Row) =>
    !FORMER.has(((((a.request as Row)?.entity) as Row)?.entity_status as string) ?? "active"));
  const openReqs = (openReqsRaw || []).filter((r: Row) =>
    !FORMER.has(((r.entity as Row)?.entity_status as string) ?? "active"));

  // Recipients: the configured people (Bobby + Tracy) resolved to emails from
  // staff_profiles; fall back to all active staff if none are configured.
  const wantIds = (cfg?.weekly_recipient_ids as string[]) || [];
  const emailOf = (list: Row[]) => list.map((s) => (s.email as string)?.trim()).filter((e: string) => e?.includes("@"));
  const recipients = testRecipient
    ? [testRecipient]
    : wantIds.length
      ? emailOf((staff || []).filter((s: Row) => wantIds.includes(s.id as string)))
      : emailOf((staff || []) as Row[]);

  // ── Last week's activity, deduped ──
  // A code lands once, so "received" dedupes on (request, label) across the
  // whole week: the rows reconcile_ch_codes minted on two separate imports
  // for one unchanged code are one event, not two. Everything else dedupes
  // per day — two reminders to the same person on the same day are one line,
  // but the same thing a week apart is genuinely two.
  type Event = { requestId: string; who: string; label: string; bucket: Bucket; at: string };
  const seen = new Set<string>();
  const events: Event[] = [];
  for (const a of (activity || []) as Row[]) {
    const { label, bucket } = classify(a.body as string);
    const key = bucket === "received"
      ? `${a.request_id}|${label}`
      : `${a.request_id}|${label}|${dayKey(a.created_at as string)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const req = a.request as Row;
    const person = ((req?.person as Row)?.name as string) || "Unknown";
    const entity = ((req?.entity as Row)?.name as string) || "Unknown";
    events.push({ requestId: a.request_id as string, who: `${person} — ${entity}`, label, bucket, at: a.created_at as string });
  }
  // A landing already logged before this window is not news, however many
  // times the reconciler has re-minted it since. reconcile_ch_codes no longer
  // re-logs (sql/279), but the rows it wrote before that fix are still in the
  // table, so "received this week" means *first* logged this week.
  const receivedRaw = events.filter((e) => e.bucket === "received");
  let received = receivedRaw;
  if (receivedRaw.length) {
    const ids = [...new Set(receivedRaw.map((e) => e.requestId).filter(Boolean))];
    const { data: priorRaw } = await service.from("ch_code_activity")
      .select("request_id, body").in("request_id", ids as string[]).lt("created_at", since);
    const prior = new Set(((priorRaw || []) as Row[]).map((p) =>
      `${p.request_id}|${classify(p.body as string).label}`));
    received = receivedRaw.filter((e) => !prior.has(`${e.requestId}|${e.label}`));
  }
  const calls = events.filter((e) => e.bucket === "call");
  const otherCounts = new Map<string, number>();
  for (const e of events.filter((x) => x.bucket === "other")) {
    otherCounts.set(e.label, (otherCounts.get(e.label) || 0) + 1);
  }

  // ── Codes still needed: the action list ──
  const stillNeeded = (openReqs as Row[]).filter((r) => !HAS_CODE.has(r.stage as string));
  const entityIds = [...new Set(stillNeeded.map((r) => (r.entity as Row)?.id).filter(Boolean))];
  const dueByEntity = new Map<string, string>();
  if (entityIds.length) {
    const { data: deadlines } = await service.from("deadlines")
      .select("entity_id, due_date").eq("tag", "Confirmation Statement").neq("status", "complete").in("entity_id", entityIds as string[]);
    for (const d of (deadlines || []) as Row[]) {
      const eid = d.entity_id as string;
      const prev = dueByEntity.get(eid);
      // Soonest live CS deadline wins.
      if (!prev || (d.due_date as string) < prev) dueByEntity.set(eid, d.due_date as string);
    }
  }

  const maxChases = (cfg?.max_chases as number) ?? 3;
  type Action = { who: string; next: string; rank: number; daysLeft: number | null };
  const actions: Action[] = stillNeeded.map((r) => {
    const person = ((r.person as Row)?.name as string) || "Unknown";
    const entity = ((r.entity as Row)?.name as string) || "Unknown";
    const eid = (r.entity as Row)?.id as string;
    const daysLeft = daysUntil(dueByEntity.get(eid) ?? null);
    const chases = (r.chase_count as number) || 0;
    const sent = (r.emails_sent as number) || 0;

    let next: string;
    let rank: number;
    if (r.escalation_status && r.escalation_status !== "none") {
      next = `Escalated — call ${person.split(" ")[0]}`;
      rank = 0;
    } else if (chases >= maxChases) {
      next = "Chases exhausted — call needed";
      rank = 0;
    } else if (daysLeft != null && daysLeft >= 0 && daysLeft <= 30) {
      next = "CS deadline close — chase now";
      rank = 1;
    } else if (!r.handling) {
      next = "Decision needed — we verify or client self-verifies";
      rank = 2;
    } else if (sent === 0) {
      next = "Nothing sent yet — send the offer";
      rank = 2;
    } else {
      const last = r.last_chased_at ? `, last ${shortDate(r.last_chased_at as string)}` : "";
      next = `Waiting on client (${plural(sent, "email")}${last})`;
      rank = 3;
    }
    return { who: `${person} — ${entity}`, next, rank, daysLeft };
  });
  // Rank first, then soonest deadline, then name — so the top of the list is
  // always the thing to do first.
  actions.sort((a, b) =>
    a.rank - b.rank ||
    (a.daysLeft ?? 9999) - (b.daysLeft ?? 9999) ||
    a.who.localeCompare(b.who));

  // ── Render ──
  const summaryChip = (n: number, label: string, colour: string) => `
    <td width="33%" style="padding:12px 10px;background:#f8fafc;border:1px solid #e5e7eb;border-radius:10px;text-align:center;">
      <div style="font-size:24px;font-weight:800;color:${colour};line-height:1.1;">${n}</div>
      <div style="font-size:11px;color:#64748b;padding-top:3px;">${esc(label)}</div>
    </td>`;

  const summaryHtml = `
    <tr><td style="padding-top:16px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="6"><tr>
        ${summaryChip(actions.length, "codes still needed", actions.length ? "#dc2626" : "#16a34a")}
        ${summaryChip(received.length, "received & entered this week", "#1E4560")}
        ${summaryChip(calls.length, "calls logged this week", "#1E4560")}
      </tr></table>
    </td></tr>`;

  const actionsHtml = actions.length ? `
    ${heading("Codes still needed", actions.length)}
      ${tableOpen}
        ${actions.map((a) => `<tr>
          <td style="padding:8px 12px;border-top:1px solid #f1f5f9;color:#0f172a;font-weight:600;">${esc(a.who)}<div style="font-weight:400;color:#64748b;font-size:12px;padding-top:2px;">${esc(a.next)}</div></td>
          <td style="padding:8px 12px;border-top:1px solid #f1f5f9;text-align:right;white-space:nowrap;color:${a.daysLeft != null && a.daysLeft <= 30 ? "#dc2626" : "#94a3b8"};font-size:12px;">${a.daysLeft != null ? `CS ${a.daysLeft}d` : ""}</td>
        </tr>`).join("")}
      ${tableClose}` : `
    <tr><td style="padding-top:22px;font-size:13.5px;color:#16a34a;font-weight:600;">✅ No codes outstanding — every open request has its code.</td></tr>`;

  const historyRows = (list: Event[]) => `
      ${tableOpen}
        ${list.map((e) => `<tr>
          <td style="padding:7px 12px;border-top:1px solid #f1f5f9;color:#0f172a;">${esc(e.who)}</td>
          <td style="padding:7px 12px;border-top:1px solid #f1f5f9;color:#94a3b8;text-align:right;white-space:nowrap;">${esc(shortDate(e.at))}</td>
        </tr>`).join("")}
      ${tableClose}`;

  const receivedHtml = received.length
    ? `${heading("Codes received & entered this week", received.length)}${historyRows(received)}`
    : "";
  const callsHtml = calls.length
    ? `${heading("Calls logged this week", calls.length)}${historyRows(calls)}`
    : "";
  const otherHtml = otherCounts.size ? `
    <tr><td style="padding-top:20px;font-size:12.5px;color:#64748b;">
      <span style="font-weight:600;color:#475569;">Also this week:</span>
      ${[...otherCounts.entries()].sort((a, b) => b[1] - a[1]).map(([label, n]) => `${n} × ${esc(label.toLowerCase())}`).join(" · ")}
    </td></tr>` : "";

  const quiet = !received.length && !calls.length && !otherCounts.size;

  const html = shell(`
    <tr><td style="font-size:18px;font-weight:700;color:#1E4560;padding-bottom:4px;">Companies House codes — weekly round-up</td></tr>
    <tr><td style="font-size:13px;color:#64748b;">What needs doing, then what moved last week.</td></tr>
    ${summaryHtml}
    ${actionsHtml}
    ${receivedHtml}
    ${callsHtml}
    ${otherHtml}
    ${quiet ? `<tr><td style="padding-top:18px;font-size:12.5px;color:#94a3b8;">Nothing moved last week.</td></tr>` : ""}`);

  const text = `Companies House codes — weekly round-up\n\n` +
    `${actions.length} codes still needed · ${received.length} received & entered this week · ${calls.length} calls logged\n\n` +
    (actions.length
      ? `CODES STILL NEEDED (${actions.length})\n${actions.map((a) => `- ${a.who} — ${a.next}${a.daysLeft != null ? ` (CS ${a.daysLeft}d)` : ""}`).join("\n")}\n`
      : `No codes outstanding.\n`) +
    (received.length ? `\nCODES RECEIVED & ENTERED THIS WEEK (${received.length})\n${received.map((e) => `- ${e.who} (${shortDate(e.at)})`).join("\n")}\n` : "") +
    (calls.length ? `\nCALLS LOGGED THIS WEEK (${calls.length})\n${calls.map((e) => `- ${e.who} (${shortDate(e.at)})`).join("\n")}\n` : "") +
    (otherCounts.size ? `\nAlso this week: ${[...otherCounts.entries()].sort((a, b) => b[1] - a[1]).map(([label, n]) => `${n} × ${label.toLowerCase()}`).join(", ")}\n` : "");

  const stats = {
    still_needed: actions.length,
    received: received.length,
    calls: calls.length,
    other: [...otherCounts.values()].reduce((a, b) => a + b, 0),
    activity_rows_read: (activity || []).length,
    activity_rows_after_dedupe: events.length,
  };

  if (dryRun) return json({ success: true, dry_run: true, recipients: recipients.length, ...stats, html });
  if (!recipients.length) return json({ success: false, error: "no recipients" }, 400);

  const subject = actions.length
    ? `CH codes — ${plural(actions.length, "code")} still needed`
    : "CH codes — nothing outstanding";
  const r = await sendEmail(recipients, subject, html, text);
  await service.from("audit_log").insert({
    action: "ch_code_weekly_sent", entity_type: "ch_code_request", entity_id: null,
    detail: { recipients: recipients.length, ...stats, test: Boolean(testRecipient), ok: r.ok, resend_id: r.id, error: r.error },
  });

  return json({ success: r.ok, recipients: recipients.length, ...stats });
});
