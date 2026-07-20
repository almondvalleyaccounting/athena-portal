// deadline-digest — Athena Portal
// Monday-morning email to the team (cron: run_deadline_digest, Mon 07:30 UTC):
//   1. Companies House filing deadlines grouped by calendar month, per client,
//      with the owner's first name and sorted by owner.
//   2. Submissions needed for each of the next 6 calendar months, w/w change.
//   3. Self Assessment returns due 31 Jan, w/w change.
//   4. A working-week run-rate target to clear each pile by its deadline.
// Data source: bm_task_schedule (work module, from BrightManager).
//   CH filing       = bm_task_name like 'Companies House Submission%'
//   Self Assessment = bm_task_name like 'Self Assessment Submission%'
//   "not yet filed" = state = 'planned'.
// Auth: x-cron-secret matching deadline_digest_config.cron_secret, OR staff JWT.
// Body: { dry_run?: boolean (default true), test_recipient?: string }
//
// The weekly snapshot (deadline_digest_snapshots) also carries overdue counts
// (ch_overdue / overdue_total / overdue_by_service) — not shown in the email,
// but the home-screen deadline cards read them for week-on-week deltas.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sendEmail } from "../_shared/resend.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

type Row = Record<string, unknown>;

// The "Companies House filing" unit is the "Companies House Submission …" task,
// NOT the sibling "Accounts Preparation …" task under the same job.
const CH_FILING_NAME = "Companies House Submission%";
const SA_FILING_NAME = "Self Assessment Submission%";
const HORIZON_MONTHS = 6;

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}
function esc(s: unknown): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function todayUTC(): Date {
  const n = new Date();
  return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()));
}
function ymd(d: Date): string { return d.toISOString().slice(0, 10); }
function monthKey(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
function monthKeyOf(iso: string): string { return iso.slice(0, 7); }
function addMonths(d: Date, n: number): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
}
function monthStart(d: Date): Date { return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)); }
function monthEnd(d: Date): Date { return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)); }
function monthLabelFromKey(key: string): string {
  const [y, m] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
}
function shortMonthFromKey(key: string): string {
  const [y, m] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-GB", { month: "short", year: "numeric", timeZone: "UTC" });
}
function fmtDate(iso: string): string {
  return new Date(iso + "T00:00:00Z").toLocaleDateString("en-GB", { day: "2-digit", month: "short", timeZone: "UTC" });
}
function ownerFirstName(r: Row): string {
  const full = ((r.owner as Row)?.name as string) || "";
  return full.trim().split(/\s+/)[0] || "";
}
// Sort a month's jobs by owner first name (unassigned last), then client name.
function byOwnerThenClient(a: Row, b: Row): number {
  const oa = ownerFirstName(a), ob = ownerFirstName(b);
  if (!!oa !== !!ob) return oa ? -1 : 1;
  if (oa !== ob) return oa.localeCompare(ob);
  const ca = ((a.entity as Row)?.name as string) || "", cb = ((b.entity as Row)?.name as string) || "";
  return ca.localeCompare(cb);
}

function nextJanEnd(from: Date): { start: string; end: string; year: number } {
  const year = from.getUTCMonth() === 0 ? from.getUTCFullYear() : from.getUTCFullYear() + 1;
  return { start: `${year}-01-01`, end: `${year}-01-31`, year };
}

const FALLBACK_BANK_HOLIDAYS = new Set<string>([
  "2026-01-01", "2026-04-03", "2026-04-06", "2026-05-04", "2026-05-25",
  "2026-08-31", "2026-12-25", "2026-12-28",
  "2027-01-01", "2027-03-26", "2027-03-29", "2027-05-03", "2027-05-31",
  "2027-08-30", "2027-12-27", "2027-12-28",
]);
async function bankHolidays(): Promise<Set<string>> {
  try {
    const r = await fetch("https://www.gov.uk/bank-holidays.json", { signal: AbortSignal.timeout(4000) });
    if (!r.ok) throw new Error(String(r.status));
    const j = await r.json();
    const events = j?.["england-and-wales"]?.events ?? [];
    const set = new Set<string>(events.map((e: Row) => e.date as string));
    return set.size ? set : FALLBACK_BANK_HOLIDAYS;
  } catch {
    return FALLBACK_BANK_HOLIDAYS;
  }
}
function workingSpan(from: Date, to: Date, holidays: Set<string>): { days: number; weeks: number } {
  let days = 0;
  const cur = new Date(from.getTime() + 86400000);
  while (cur <= to) {
    const dow = cur.getUTCDay();
    if (dow !== 0 && dow !== 6 && !holidays.has(ymd(cur))) days++;
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  days = Math.max(days, 1);
  return { days, weeks: days / 5 };
}
function runRate(outstanding: number, weeks: number): number {
  if (outstanding <= 0) return 0;
  return Math.ceil(outstanding / Math.max(weeks, 0.2));
}
function arrow(delta: number): string {
  if (delta > 0) return `▲ ${delta}`;
  if (delta < 0) return `▼ ${Math.abs(delta)}`;
  return "–";
}

const HOUSE_STATUS: Record<string, string> = { "No Latest Action": "Not started" };

const shell = (inner: string, athenaUrl: string) =>
  `<!doctype html><html><body style="margin:0;padding:0;background:#f6f8f9;font-family:'Outfit',-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;color:#1e293b;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f8f9;padding:32px 16px;"><tr><td align="center">
      <table role="presentation" width="640" cellpadding="0" cellspacing="0" style="background:#fff;border:1px solid #e2e8f0;border-radius:14px;padding:28px;">
        ${inner}
        <tr><td style="padding:22px 0 4px;">
          <a href="${esc(athenaUrl)}/planner/ready" style="display:inline-block;background:#1E4560;color:#fff;text-decoration:none;padding:11px 20px;border-radius:10px;font-weight:600;font-size:14px;">Open Ready Now in the work planner</a>
        </td></tr>
        <tr><td style="padding-top:22px;border-top:1px solid #f1f5f9;font-size:11px;color:#94a3b8;text-align:center;">Almond Valley Accounting · Weekly deadline digest · figures from the work module (BrightManager)</td></tr>
      </table>
    </td></tr></table>
  </body></html>`;

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ success: false, error: "POST required" }, 405);
  const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { data: cfg } = await service.from("deadline_digest_config").select("*").eq("id", true).maybeSingle();
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

  const today = todayUTC();
  const horizonStart = monthStart(today);
  const horizonEnd = monthEnd(addMonths(today, HORIZON_MONTHS - 1));
  const jan = nextJanEnd(today);

  const [{ data: chRows, error: chErr }, { data: saRows, error: saErr }] = await Promise.all([
    service.from("bm_task_schedule")
      .select("bm_deadline, bm_status, entity:entities!bm_task_schedule_entity_id_fkey(name), owner:staff_profiles!bm_task_schedule_assignee_id_fkey(name)")
      .ilike("bm_task_name", CH_FILING_NAME).eq("state", "planned").is("excluded_at", null)
      .gte("bm_deadline", ymd(horizonStart)).lte("bm_deadline", ymd(horizonEnd))
      .order("bm_deadline"),
    service.from("bm_task_schedule")
      .select("service, bm_task_name").eq("state", "planned").is("excluded_at", null)
      .gte("bm_deadline", jan.start).lte("bm_deadline", jan.end)
      .or(`bm_task_name.ilike.${SA_FILING_NAME},service.eq.Personal Tax`),
  ]);
  if (chErr) return json({ success: false, error: `CH query: ${chErr.message}` }, 500);
  if (saErr) return json({ success: false, error: `SA query: ${saErr.message}` }, 500);

  // Overdue counts — not rendered in the email, but snapshotted so the home
  // screen's deadline cards can show week-on-week deltas on the same baseline.
  const [{ count: chOverdueCount }, { data: overdueRows }] = await Promise.all([
    service.from("bm_task_schedule")
      .select("id", { count: "exact", head: true })
      .ilike("bm_task_name", CH_FILING_NAME).eq("state", "planned").is("excluded_at", null)
      .lt("bm_deadline", ymd(today)),
    service.from("bm_task_schedule")
      .select("service").eq("state", "planned").is("excluded_at", null).lt("bm_deadline", ymd(today)),
  ]);
  const overdueByService: Record<string, number> = {};
  for (const r of (overdueRows || []) as Row[]) {
    const s = (r.service as string) || "Other";
    overdueByService[s] = (overdueByService[s] || 0) + 1;
  }
  const overdueTotal = (overdueRows || []).length;

  const chByMonth = new Map<string, Row[]>();
  for (const r of (chRows || []) as Row[]) {
    const key = monthKeyOf(r.bm_deadline as string);
    if (!chByMonth.has(key)) chByMonth.set(key, []);
    chByMonth.get(key)!.push(r);
  }
  const monthKeys: string[] = [];
  for (let i = 0; i < HORIZON_MONTHS; i++) monthKeys.push(monthKey(addMonths(today, i)));
  const chCounts: Record<string, number> = {};
  for (const k of monthKeys) chCounts[k] = (chByMonth.get(k) || []).length;
  const chTotal = monthKeys.reduce((s, k) => s + chCounts[k], 0);

  const saCount = (saRows || []).filter((r: Row) => /^self assessment submission/i.test(String(r.bm_task_name || ""))).length;
  const personalTaxCount = (saRows || []).filter((r: Row) => r.service === "Personal Tax").length;

  const { data: prevSnap } = await service.from("deadline_digest_snapshots")
    .select("snapshot_date, payload").lt("snapshot_date", ymd(today))
    .order("snapshot_date", { ascending: false }).limit(1).maybeSingle();
  const prev = (prevSnap?.payload as Row) || null;
  const prevCh = (prev?.ch as Record<string, number>) || {};
  const prevSa = (prev?.sa_jan as number | undefined);
  const hasPrev = Boolean(prev);

  const holidays = await bankHolidays();
  const thisMonthKey = monthKeys[0];
  const spanThisMonth = workingSpan(today, monthEnd(today), holidays);
  const spanHorizon = workingSpan(today, horizonEnd, holidays);
  const spanJan = workingSpan(today, new Date(jan.end + "T00:00:00Z"), holidays);
  const rrThisMonth = runRate(chCounts[thisMonthKey], spanThisMonth.weeks);
  const rrHorizon = runRate(chTotal, spanHorizon.weeks);
  const rrSa = runRate(saCount, spanJan.weeks);
  const rrCombined = rrHorizon + rrSa;

  const wcLabel = today.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

  const listMonths = monthKeys.slice(0, 3);
  const monthColours = ["#dc2626", "#ea580c", "#ca8a04"];
  const monthEmoji = ["🔴", "🟠", "🟡"];
  const chSections = listMonths.map((key, idx) => {
    const items = (chByMonth.get(key) || []).slice().sort(byOwnerThenClient);
    const daysLeft = idx === 0 ? Math.max(0, Math.ceil((monthEnd(today).getTime() - today.getTime()) / 86400000)) : null;
    const heading = `${monthEmoji[idx]} ${monthLabelFromKey(key)} deadlines`
      + (idx === 0 ? ` <span style="color:#94a3b8;font-weight:500;">· ${daysLeft} days left this month</span>` : "");
    const rows = items.length
      ? items.map((i) => `
        <tr>
          <td style="padding:6px 12px;border-top:1px solid #f1f5f9;color:#475569;white-space:nowrap;">${esc(ownerFirstName(i) || "—")}</td>
          <td style="padding:6px 12px;border-top:1px solid #f1f5f9;color:#0f172a;">${esc((i.entity as Row)?.name || "—")}</td>
          <td style="padding:6px 12px;border-top:1px solid #f1f5f9;color:#64748b;white-space:nowrap;">${fmtDate(i.bm_deadline as string)}</td>
          <td style="padding:6px 12px;border-top:1px solid #f1f5f9;color:#64748b;text-align:right;white-space:nowrap;">${esc(HOUSE_STATUS[i.bm_status as string] || i.bm_status || "—")}</td>
        </tr>`).join("")
      : `<tr><td colspan="4" style="padding:8px 12px;border-top:1px solid #f1f5f9;color:#94a3b8;">Nothing outstanding.</td></tr>`;
    return `
    <tr><td style="padding-top:18px;">
      <div style="font-size:14px;font-weight:700;color:${monthColours[idx]};padding-bottom:6px;">${heading}</div>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb;border-radius:10px;overflow:hidden;font-size:13px;">
        <tr style="background:#f8fafc;">
          <td style="padding:7px 12px;font-weight:600;color:#475569;">Owner</td>
          <td style="padding:7px 12px;font-weight:600;color:#475569;">Client</td>
          <td style="padding:7px 12px;font-weight:600;color:#475569;">Due</td>
          <td style="padding:7px 12px;font-weight:600;color:#475569;text-align:right;">Status</td>
        </tr>
        ${rows}
      </table>
      <div style="font-size:12px;color:#94a3b8;padding-top:4px;">${items.length} outstanding</div>
    </td></tr>`;
  }).join("");

  const countRows = monthKeys.map((k) => {
    const now = chCounts[k];
    const then = prevCh[k];
    const delta = hasPrev && typeof then === "number" ? now - then : null;
    return `<tr>
      <td style="padding:6px 12px;border-top:1px solid #f1f5f9;color:#0f172a;">${shortMonthFromKey(k)}</td>
      <td style="padding:6px 12px;border-top:1px solid #f1f5f9;color:#0f172a;text-align:right;">${now}</td>
      <td style="padding:6px 12px;border-top:1px solid #f1f5f9;color:#94a3b8;text-align:right;">${hasPrev && typeof then === "number" ? then : "—"}</td>
      <td style="padding:6px 12px;border-top:1px solid #f1f5f9;text-align:right;color:${delta && delta > 0 ? "#dc2626" : delta && delta < 0 ? "#16a34a" : "#94a3b8"};">${delta === null ? "—" : arrow(delta)}</td>
    </tr>`;
  }).join("");
  const totalPrev = hasPrev ? monthKeys.reduce((s, k) => s + (typeof prevCh[k] === "number" ? prevCh[k] : 0), 0) : null;
  const totalDelta = totalPrev === null ? null : chTotal - totalPrev;

  const saDelta = hasPrev && typeof prevSa === "number" ? saCount - prevSa : null;

  const inner = `
    <tr><td style="font-size:19px;font-weight:700;color:#1E4560;padding-bottom:2px;">Weekly deadline digest</td></tr>
    <tr><td style="font-size:13px;color:#64748b;padding-bottom:2px;">Week commencing ${esc(wcLabel)} · Companies House accounts &amp; Self Assessment</td></tr>
    ${!hasPrev ? `<tr><td style="font-size:12px;color:#94a3b8;padding-top:4px;">First run — this week is the baseline, so there are no week-on-week changes yet.</td></tr>` : ""}

    <tr><td style="padding-top:22px;font-size:13px;font-weight:700;color:#475569;text-transform:uppercase;letter-spacing:.5px;">Companies House — accounts deadlines by month</td></tr>
    ${chSections}

    <tr><td style="padding-top:26px;font-size:13px;font-weight:700;color:#475569;text-transform:uppercase;letter-spacing:.5px;">Submissions needed — next 6 months</td></tr>
    <tr><td style="padding-top:8px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb;border-radius:10px;overflow:hidden;font-size:13px;">
        <tr style="background:#f8fafc;">
          <td style="padding:7px 12px;font-weight:600;color:#475569;">Month</td>
          <td style="padding:7px 12px;font-weight:600;color:#475569;text-align:right;">Due</td>
          <td style="padding:7px 12px;font-weight:600;color:#475569;text-align:right;">Last week</td>
          <td style="padding:7px 12px;font-weight:600;color:#475569;text-align:right;">Change</td>
        </tr>
        ${countRows}
        <tr style="background:#f8fafc;">
          <td style="padding:8px 12px;border-top:2px solid #e5e7eb;font-weight:700;color:#0f172a;">Total</td>
          <td style="padding:8px 12px;border-top:2px solid #e5e7eb;font-weight:700;color:#0f172a;text-align:right;">${chTotal}</td>
          <td style="padding:8px 12px;border-top:2px solid #e5e7eb;color:#94a3b8;text-align:right;">${totalPrev === null ? "—" : totalPrev}</td>
          <td style="padding:8px 12px;border-top:2px solid #e5e7eb;text-align:right;color:${totalDelta && totalDelta > 0 ? "#dc2626" : totalDelta && totalDelta < 0 ? "#16a34a" : "#94a3b8"};">${totalDelta === null ? "—" : arrow(totalDelta)}</td>
        </tr>
      </table>
      <div style="font-size:11px;color:#94a3b8;padding-top:5px;">▲ = more than last week (new/rolled-forward jobs); ▼ = fewer (filed or reassigned).</div>
    </td></tr>

    <tr><td style="padding-top:26px;font-size:13px;font-weight:700;color:#475569;text-transform:uppercase;letter-spacing:.5px;">Self Assessment — due 31 Jan ${jan.year}</td></tr>
    <tr><td style="padding-top:8px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb;border-radius:10px;overflow:hidden;">
        <tr>
          <td style="padding:14px 16px;font-size:28px;font-weight:800;color:#1E4560;">${saCount}</td>
          <td style="padding:14px 16px;font-size:13px;color:#64748b;">returns outstanding${
            saDelta === null ? "" : ` &nbsp;·&nbsp; <span style=\"color:${saDelta > 0 ? "#dc2626" : saDelta < 0 ? "#16a34a" : "#94a3b8"};font-weight:600;\">${arrow(saDelta)}</span> vs last week (${prevSa})`
          }</td>
        </tr>
      </table>
      <div style="font-size:11px;color:#94a3b8;padding-top:5px;">Plus ${personalTaxCount} tagged &ldquo;Personal Tax&rdquo; in BM with the same 31 Jan deadline — tell me if you want those folded into the headline.</div>
    </td></tr>

    <tr><td style="padding-top:26px;font-size:13px;font-weight:700;color:#475569;text-transform:uppercase;letter-spacing:.5px;">🎯 Run-rate targets <span style="font-weight:500;color:#94a3b8;">(working weeks, excl. weekends &amp; bank holidays)</span></td></tr>
    <tr><td style="padding-top:8px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb;border-radius:10px;overflow:hidden;font-size:13px;">
        <tr style="background:#f8fafc;">
          <td style="padding:7px 12px;font-weight:600;color:#475569;">Pile</td>
          <td style="padding:7px 12px;font-weight:600;color:#475569;text-align:right;">Outstanding</td>
          <td style="padding:7px 12px;font-weight:600;color:#475569;text-align:right;">Working weeks</td>
          <td style="padding:7px 12px;font-weight:600;color:#475569;text-align:right;">Target / week</td>
        </tr>
        <tr>
          <td style="padding:6px 12px;border-top:1px solid #f1f5f9;color:#0f172a;">CH accounts — ${shortMonthFromKey(thisMonthKey)}</td>
          <td style="padding:6px 12px;border-top:1px solid #f1f5f9;text-align:right;">${chCounts[thisMonthKey]}</td>
          <td style="padding:6px 12px;border-top:1px solid #f1f5f9;text-align:right;color:#64748b;">${spanThisMonth.weeks.toFixed(1)}</td>
          <td style="padding:6px 12px;border-top:1px solid #f1f5f9;text-align:right;font-weight:700;">${rrThisMonth} / wk</td>
        </tr>
        <tr>
          <td style="padding:6px 12px;border-top:1px solid #f1f5f9;color:#0f172a;">CH accounts — next 6 months</td>
          <td style="padding:6px 12px;border-top:1px solid #f1f5f9;text-align:right;">${chTotal}</td>
          <td style="padding:6px 12px;border-top:1px solid #f1f5f9;text-align:right;color:#64748b;">${spanHorizon.weeks.toFixed(1)}</td>
          <td style="padding:6px 12px;border-top:1px solid #f1f5f9;text-align:right;font-weight:700;">${rrHorizon} / wk</td>
        </tr>
        <tr>
          <td style="padding:6px 12px;border-top:1px solid #f1f5f9;color:#0f172a;">Self Assessment — to 31 Jan</td>
          <td style="padding:6px 12px;border-top:1px solid #f1f5f9;text-align:right;">${saCount}</td>
          <td style="padding:6px 12px;border-top:1px solid #f1f5f9;text-align:right;color:#64748b;">${spanJan.weeks.toFixed(1)}</td>
          <td style="padding:6px 12px;border-top:1px solid #f1f5f9;text-align:right;font-weight:700;">${rrSa} / wk</td>
        </tr>
        <tr style="background:#f0f7f4;">
          <td colspan="3" style="padding:8px 12px;border-top:2px solid #e5e7eb;font-weight:700;color:#0f172a;">Combined run-rate to stay on track</td>
          <td style="padding:8px 12px;border-top:2px solid #e5e7eb;text-align:right;font-weight:800;color:#16a34a;">~${rrCombined} / wk</td>
        </tr>
      </table>
    </td></tr>`;

  const text = [
    `WEEKLY DEADLINE DIGEST — w/c ${wcLabel}`,
    !hasPrev ? `(First run — baseline week, no week-on-week changes yet.)` : "",
    ``,
    `COMPANIES HOUSE ACCOUNTS — BY MONTH`,
    ...listMonths.map((key) => {
      const items = (chByMonth.get(key) || []).slice().sort(byOwnerThenClient);
      return `\n${monthLabelFromKey(key)} (${items.length}):\n` +
        (items.length ? items.map((i) => `  - ${ownerFirstName(i) || "—"} · ${(i.entity as Row)?.name || "—"} — due ${fmtDate(i.bm_deadline as string)} (${HOUSE_STATUS[i.bm_status as string] || i.bm_status || "—"})`).join("\n") : "  Nothing outstanding.");
    }),
    ``,
    `SUBMISSIONS NEEDED — NEXT 6 MONTHS`,
    ...monthKeys.map((k) => {
      const then = prevCh[k];
      const delta = hasPrev && typeof then === "number" ? chCounts[k] - then : null;
      return `  ${shortMonthFromKey(k)}: ${chCounts[k]}${delta === null ? "" : ` (last week ${then}, ${arrow(delta)})`}`;
    }),
    `  TOTAL: ${chTotal}${totalDelta === null ? "" : ` (${arrow(totalDelta)})`}`,
    ``,
    `SELF ASSESSMENT — due 31 Jan ${jan.year}: ${saCount}${saDelta === null ? "" : ` (${arrow(saDelta)} vs last week)`}`,
    `  (+${personalTaxCount} tagged "Personal Tax" same deadline)`,
    ``,
    `RUN-RATE TARGETS (working weeks)`,
    `  CH accounts ${shortMonthFromKey(thisMonthKey)}: ${chCounts[thisMonthKey]} over ${spanThisMonth.weeks.toFixed(1)}wk → ${rrThisMonth}/wk`,
    `  CH accounts next 6mo: ${chTotal} over ${spanHorizon.weeks.toFixed(1)}wk → ${rrHorizon}/wk`,
    `  Self Assessment: ${saCount} over ${spanJan.weeks.toFixed(1)}wk → ${rrSa}/wk`,
    `  Combined: ~${rrCombined}/wk`,
    ``,
    `Open Ready Now: ${Deno.env.get("PORTAL_PUBLIC_URL") || "https://portal.almondvalleyaccounting.co.uk"}/planner/ready`,
  ].filter((l) => l !== "").join("\n");

  const wantIds = (cfg?.recipient_ids as string[]) || [];
  const { data: staff } = await service.from("staff_profiles").select("id, email").eq("is_active", true);
  const emailOf = (list: Row[]) => list.map((s) => (s.email as string)?.trim()).filter((e: string) => e?.includes("@"));
  const recipients = testRecipient
    ? [testRecipient]
    : wantIds.length
      ? emailOf((staff || []).filter((s: Row) => wantIds.includes(s.id as string)))
      : emailOf((staff || []) as Row[]);

  const summary = {
    week_commencing: ymd(today),
    ch: chCounts, ch_total: chTotal,
    sa_jan: saCount, personal_tax_jan: personalTaxCount, jan_year: jan.year,
    run_rate: { this_month: rrThisMonth, horizon: rrHorizon, sa: rrSa, combined: rrCombined },
    week_on_week: hasPrev ? { since: prevSnap?.snapshot_date, ch_total_delta: totalDelta, sa_delta: saDelta } : "baseline",
    recipients: recipients.length,
  };

  if (dryRun) return json({ success: true, dry_run: true, ...summary });
  if (!recipients.length) return json({ success: false, error: "no recipients" }, 400);
  if (!testRecipient && !cfg?.sending_enabled) {
    return json({ success: false, error: "Team sending disabled (deadline_digest_config.sending_enabled=false). Use test_recipient, or enable once tested." }, 409);
  }

  const athenaUrl = Deno.env.get("PORTAL_PUBLIC_URL") || "https://portal.almondvalleyaccounting.co.uk";
  const subject = `Deadlines: ${chCounts[thisMonthKey]} CH accounts due ${shortMonthFromKey(thisMonthKey)}, ${saCount} SA for Jan — w/c ${wcLabel}`;
  const r = await sendEmail({ to: recipients, subject, html: shell(inner, athenaUrl), text });

  if (!testRecipient) {
    await service.from("deadline_digest_snapshots").upsert({
      snapshot_date: ymd(today),
      payload: {
        ch: chCounts, sa_jan: saCount, personal_tax_jan: personalTaxCount,
        ch_overdue: chOverdueCount ?? 0,
        overdue_total: overdueTotal,
        overdue_by_service: overdueByService,
        generated_at: new Date().toISOString(),
      },
    }, { onConflict: "snapshot_date" });
  }

  await service.from("audit_log").insert({
    action: "deadline_digest_sent", entity_type: "deadline_digest", entity_id: null,
    detail: { ...summary, test: Boolean(testRecipient), ok: r.ok, resend_id: r.id, error: r.error },
  });

  return json({ success: r.ok, ...summary, resend_id: r.id, error: r.error });
});
