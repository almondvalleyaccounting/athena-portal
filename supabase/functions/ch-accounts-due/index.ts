// ch-accounts-due — Athena Portal
//
// The morning email to the whole team: whose accounts are due at Companies
// House TODAY. Cron: run_ch_accounts_due(), weekdays 07:00 UTC.
//
// Where the dates come from, and why it matters:
//   v_ch_accounts_due → deadlines(tag = 'CH Accounts') → written every night by
//   ch-ingest-officers straight off the Companies House profile. NOT the
//   BrightManager import. A BM export that is a couple of days stale would have
//   us emailing the whole team about a deadline that has since moved, or worse,
//   staying silent on one that has arrived. The register is the only source
//   that is right at 8am.
//
// Scope: prospects IN (a prospect on the register has the same deadline, and we
// may well be the ones filing it), former clients OUT, dissolved and
// in-liquidation companies OUT. All of that lives in the view, not here.
//
// Weekends: Companies House does not move a deadline that lands on a Saturday.
// Nobody is here on Saturday. So the email goes out on the last working day
// before, and covers everything up to the next working day — Friday's email
// carries Friday, Saturday and Sunday. With bank_holiday_shift on (default),
// bank holidays are treated the same way. Nothing is sent on a non-working day.
//
// Auth: x-cron-secret matching ch_accounts_due_config.cron_secret, OR staff JWT.
// Deployed verify_jwt=false, like deadline-digest: pg_net posts the cron secret
// with no Authorization header, so gateway JWT verification would 401 the cron
// before this file ran. verify_jwt is not authentication anyway — it accepts the
// anon key that ships in the frontend bundle. The check below is the control.
// Body: { dry_run?: boolean (default true), test_recipient?: string,
//         as_of?: 'YYYY-MM-DD' (pretend it is this day — testing only) }

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sendEmail } from "../_shared/resend.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

type Row = Record<string, unknown>;

// The overnight refresh finishes by 04:00 UTC. If the freshest thing we hold is
// older than this, the email says so rather than pretending it is today's news.
const STALE_HOURS = 30;

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}
function esc(s: unknown): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function ymd(d: Date): string { return d.toISOString().slice(0, 10); }
function parseYmd(s: string): Date { return new Date(`${s}T00:00:00Z`); }
function addDays(d: Date, n: number): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + n));
}
function fmtLong(d: Date): string {
  return d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}
function fmtShort(d: Date): string {
  return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
}

// Same list, same fallback, as the Monday deadline digest.
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

function isWorkingDay(d: Date, holidays: Set<string>): boolean {
  const dow = d.getUTCDay();
  if (dow === 0 || dow === 6) return false;
  return !holidays.has(ymd(d));
}

// Everything this email is responsible for: today, plus every non-working day
// that follows it before the next working day. On a Tuesday that is just
// Tuesday; on the Friday of a normal week it is Fri/Sat/Sun; on the Thursday
// before Easter it runs through to the Monday.
function coverWindow(today: Date, holidays: Set<string>): Date[] {
  const days = [today];
  let cur = addDays(today, 1);
  while (!isWorkingDay(cur, holidays)) {
    days.push(cur);
    cur = addDays(cur, 1);
    if (days.length > 10) break; // paranoia: never run away
  }
  return days;
}

const shell = (inner: string, athenaUrl: string) =>
  `<!doctype html><html><body style="margin:0;padding:0;background:#f6f8f9;font-family:'Outfit',-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;color:#1e293b;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f8f9;padding:32px 16px;"><tr><td align="center">
      <table role="presentation" width="640" cellpadding="0" cellspacing="0" style="background:#fff;border:1px solid #e2e8f0;border-radius:14px;padding:28px;">
        ${inner}
        <tr><td style="padding:22px 0 4px;">
          <a href="${esc(athenaUrl)}/planner/ready" style="display:inline-block;background:#1E4560;color:#fff;text-decoration:none;padding:11px 20px;border-radius:10px;font-weight:600;font-size:14px;">Open Ready Now in the work planner</a>
        </td></tr>
        <tr><td style="padding-top:22px;border-top:1px solid #f1f5f9;font-size:11px;color:#94a3b8;text-align:center;">Almond Valley Accounting · Filing deadlines read from Companies House overnight · a filed set of accounts drops off this list by itself</td></tr>
      </table>
    </td></tr></table>
  </body></html>`;

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ success: false, error: "POST required" }, 405);
  const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { data: cfg } = await service.from("ch_accounts_due_config").select("*").eq("id", true).maybeSingle();
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
  const asOf: string | null = typeof body.as_of === "string" ? body.as_of : null;

  const now = new Date();
  const today = asOf ? parseYmd(asOf) : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (Number.isNaN(today.getTime())) return json({ success: false, error: "as_of must be YYYY-MM-DD" }, 400);

  const holidays = (cfg?.bank_holiday_shift ?? true) ? await bankHolidays() : new Set<string>();

  // Never write to the team on a day nobody is working — Friday's email
  // already carried it. A dry run still reports what it would have done.
  if (!isWorkingDay(today, holidays)) {
    const reason = `${ymd(today)} is not a working day — the last working day before it carried these deadlines.`;
    if (!dryRun) return json({ success: true, skipped: true, reason });
    return json({ success: true, dry_run: true, skipped: true, reason });
  }

  const days = coverWindow(today, holidays);
  const windowStart = ymd(days[0]);
  const windowEnd = ymd(days[days.length - 1]);

  const { data: dueRaw, error: dueErr } = await service
    .from("v_ch_accounts_due")
    .select("entity_id, entity_name, company_number, company_status, company_status_detail, entity_status, manager, title, due_date, ch_last_refreshed_at")
    .gte("due_date", windowStart).lte("due_date", windowEnd)
    .order("due_date").order("entity_name");
  if (dueErr) return json({ success: false, error: `due query: ${dueErr.message}` }, 500);
  const due = (dueRaw || []) as Row[];

  // Already past their filing deadline and still not filed at CH. One line,
  // not a second list — the point of this email is today.
  const { count: overdueCount } = await service
    .from("v_ch_accounts_due")
    .select("entity_id", { count: "exact", head: true })
    .lt("due_date", ymd(today));

  // How fresh is the register data behind all this?
  const { data: freshest } = await service
    .from("v_ch_accounts_due")
    .select("ch_last_refreshed_at")
    .order("ch_last_refreshed_at", { ascending: false }).limit(1).maybeSingle();
  const refreshedAt = (freshest?.ch_last_refreshed_at as string) || null;
  const staleHours = refreshedAt ? (Date.now() - new Date(refreshedAt).getTime()) / 3600000 : null;
  const stale = staleHours === null || staleHours > STALE_HOURS;

  const summary = {
    as_of: ymd(today),
    covers: days.map(ymd),
    due_count: due.length,
    overdue_count: overdueCount ?? 0,
    ch_refreshed_at: refreshedAt,
    stale,
  };

  // A clear day is not news. Quiet by default; the switch is in Scheduled Jobs.
  if (!due.length && (cfg?.skip_when_empty ?? true) && !testRecipient) {
    return json({ success: true, ...summary, skipped: true, reason: "nothing due; skip_when_empty is on" });
  }

  const multiDay = days.length > 1;
  const weekendTail = days.slice(1);

  const rowHtml = (r: Row, athenaUrl: string) => {
    const statusFlag = (() => {
      const s = String(r.company_status || "").toLowerCase();
      const detail = String(r.company_status_detail || "");
      if (!s || s === "active") return "";
      return `<div style="font-size:11px;color:#b45309;padding-top:2px;">${esc(s)}${detail ? ` · ${esc(detail)}` : ""}</div>`;
    })();
    const prospect = r.entity_status === "prospect"
      ? ` <span style="font-size:10px;font-weight:700;color:#7c3aed;background:#f3e8ff;border-radius:4px;padding:1px 5px;vertical-align:middle;">PROSPECT</span>`
      : "";
    return `
      <tr>
        <td style="padding:8px 12px;border-top:1px solid #f1f5f9;">
          <a href="${esc(athenaUrl)}/clients/${esc(r.entity_id)}" style="color:#0f172a;font-weight:600;text-decoration:none;">${esc(r.entity_name)}</a>${prospect}
          <div style="font-size:11px;color:#94a3b8;padding-top:2px;">${esc(r.company_number || "—")} · ${esc(r.title || "Annual Accounts")}</div>
          ${statusFlag}
        </td>
        <td style="padding:8px 12px;border-top:1px solid #f1f5f9;color:#475569;white-space:nowrap;">${esc(r.manager || "—")}</td>
        <td style="padding:8px 12px;border-top:1px solid #f1f5f9;color:#0f172a;text-align:right;white-space:nowrap;font-weight:600;">${fmtShort(parseYmd(r.due_date as string))}</td>
      </tr>`;
  };

  const athenaUrl = Deno.env.get("PORTAL_PUBLIC_URL") || "https://portal.almondvalleyaccounting.co.uk";

  const table = due.length
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb;border-radius:10px;overflow:hidden;font-size:13px;">
         <tr style="background:#f8fafc;">
           <td style="padding:7px 12px;font-weight:600;color:#475569;">Client</td>
           <td style="padding:7px 12px;font-weight:600;color:#475569;">Manager</td>
           <td style="padding:7px 12px;font-weight:600;color:#475569;text-align:right;">Due</td>
         </tr>
         ${due.map((r) => rowHtml(r, athenaUrl)).join("")}
       </table>`
    : `<div style="font-size:14px;color:#16a34a;font-weight:600;">Nothing due at Companies House ${multiDay ? "before Monday" : "today"}.</div>`;

  const headline = due.length
    ? `${due.length} ${due.length === 1 ? "set of accounts is" : "sets of accounts are"} due at Companies House ${multiDay ? "between now and the next working day" : "today"}`
    : `Nothing due at Companies House ${multiDay ? "over the weekend" : "today"}`;

  const inner = `
    <tr><td style="font-size:19px;font-weight:700;color:#1E4560;padding-bottom:2px;">Due at Companies House ${multiDay ? "today &amp; over the weekend" : "today"}</td></tr>
    <tr><td style="font-size:13px;color:#64748b;">${esc(fmtLong(today))}</td></tr>
    ${multiDay ? `<tr><td style="font-size:12px;color:#64748b;padding-top:8px;background:#fffbeb;border:1px solid #fde68a;border-radius:8px;">
      <div style="padding:9px 12px;">⚠️ This email also carries ${weekendTail.map((d) => esc(fmtShort(d))).join(", ")}. Companies House does not move a deadline that falls on a non-working day — anything below dated after today has to be filed <strong>before you leave</strong>.</div>
    </td></tr>` : ""}
    ${stale ? `<tr><td style="font-size:12px;color:#b45309;padding-top:8px;">⚠️ The Companies House refresh last completed ${refreshedAt ? esc(new Date(refreshedAt).toLocaleString("en-GB", { timeZone: "Europe/London" })) : "— never"}, so this list may be behind the register.</td></tr>` : ""}

    <tr><td style="padding-top:18px;font-size:14px;font-weight:700;color:#0f172a;">${esc(headline)}</td></tr>
    <tr><td style="padding-top:10px;">${table}</td></tr>
    ${(overdueCount ?? 0) > 0 ? `<tr><td style="padding-top:14px;font-size:12px;color:#dc2626;">${overdueCount} ${overdueCount === 1 ? "company is" : "companies are"} already past the filing deadline and still not filed at Companies House.</td></tr>` : ""}
    <tr><td style="padding-top:16px;font-size:11px;color:#94a3b8;">Read from the Companies House register overnight, not from BrightManager. Once accounts are filed the company drops off this list on the next refresh.</td></tr>`;

  const text = [
    `DUE AT COMPANIES HOUSE ${multiDay ? "TODAY & OVER THE WEEKEND" : "TODAY"} — ${fmtLong(today)}`,
    multiDay ? `(Also carries ${weekendTail.map(fmtShort).join(", ")} — CH does not move a weekend deadline.)` : "",
    stale ? `(WARNING: CH refresh last completed ${refreshedAt || "never"} — this list may be behind the register.)` : "",
    ``,
    headline.toUpperCase(),
    ``,
    ...(due.length
      ? due.map((r) => `  - ${r.entity_name}${r.entity_status === "prospect" ? " [PROSPECT]" : ""} (${r.company_number || "—"}) · ${r.title || "Annual Accounts"} · ${r.manager || "no manager"} · due ${fmtShort(parseYmd(r.due_date as string))}`)
      : ["  Nothing outstanding."]),
    ``,
    (overdueCount ?? 0) > 0 ? `${overdueCount} already past the filing deadline and still not filed.` : "",
    ``,
    `Open Ready Now: ${athenaUrl}/planner/ready`,
  ].filter((l) => l !== "").join("\n");

  const wantIds = (cfg?.recipient_ids as string[]) || [];
  const { data: staff } = await service.from("staff_profiles").select("id, email").eq("is_active", true);
  const emailOf = (list: Row[]) => list.map((s) => (s.email as string)?.trim()).filter((e: string) => e?.includes("@"));
  const recipients = testRecipient
    ? [testRecipient]
    : wantIds.length
      ? emailOf((staff || []).filter((s: Row) => wantIds.includes(s.id as string)))
      : emailOf((staff || []) as Row[]);

  const out = { ...summary, recipients: recipients.length, clients: due.map((r) => r.entity_name) };

  if (dryRun) return json({ success: true, dry_run: true, ...out });
  if (!recipients.length) return json({ success: false, error: "no recipients" }, 400);
  if (!testRecipient && !(cfg?.sending_enabled)) {
    return json({ success: false, error: "Team sending disabled (ch_accounts_due_config.sending_enabled=false). Use test_recipient, or enable once tested." }, 409);
  }

  const subject = due.length
    ? `Companies House: ${due.length} due ${multiDay ? `by Monday (incl. weekend)` : "today"} — ${fmtShort(today)}`
    : `Companies House: nothing due ${multiDay ? "over the weekend" : "today"} — ${fmtShort(today)}`;
  const r = await sendEmail({ to: recipients, subject, html: shell(inner, athenaUrl), text });

  if (!testRecipient) {
    await service.from("ch_accounts_due_config")
      .update({ last_sent_on: ymd(today), updated_at: new Date().toISOString() })
      .eq("id", true);
  }

  await service.from("audit_log").insert({
    action: "ch_accounts_due_sent", entity_type: "ch_accounts_due", entity_id: null,
    detail: { ...out, test: Boolean(testRecipient), ok: r.ok, resend_id: r.id, error: r.error },
  });

  return json({ success: r.ok, ...out, resend_id: r.id, error: r.error });
});
