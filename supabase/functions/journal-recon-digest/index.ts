// journal-recon-digest
// Monthly email of what the journal control check found: duplicate postings and
// missing journals. Cron: 10th, after the sweep has finished.
//
// Sends ONLY duplicates and missing/mismatched journals — the two things that
// mean money is wrong in a client ledger. Everything else the check raises
// (orphans, uncategorised nominals, unverifiable amounts) is counted in a
// footer line so nothing is hidden, but it does not fill the email.
//
// Recipients come from journal_recon_config.recipient_ids → staff_profiles, so
// addresses are never hardcoded here and a deactivated staff member drops out
// without a redeploy.
//
// Silent when there is nothing to report — an empty digest every month trains
// people to ignore it.
//
// Auth: verify_jwt=true. Service-role JWT (cron) or staff with can_view_reports.
// Body: { dry_run?: boolean, run_id?: number, test_recipient?: string }

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;
const RESEND_FROM_EMAIL = Deno.env.get("RESEND_FROM_EMAIL") || "info@almondvalleyaccounting.co.uk";
const RESEND_FROM_NAME = Deno.env.get("RESEND_FROM_NAME") || "Almond Valley Accounting";
const ATHENA_URL = Deno.env.get("ATHENA_URL") || "https://portal.almondvalleyaccounting.co.uk";

const REPORTABLE = ["duplicate", "missing", "stopped_posting", "amount_mismatch"];

function jr(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}
function esc(s: unknown) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function money(n: unknown) {
  const v = Number(n);
  return Number.isFinite(v) ? v.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "";
}
function roleFromJwt(bearer: string): string | null {
  try {
    const p = bearer.split(".")[1];
    if (!p) return null;
    const pad = p.replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(pad + "=".repeat((4 - pad.length % 4) % 4)))?.role ?? null;
  } catch { return null; }
}

Deno.serve(async (req) => {
  try {
    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const authHeader = req.headers.get("Authorization") || "";
    const bearer = authHeader.replace(/^Bearer\s+/i, "").trim();
    const isService = bearer.length > 0
      && (bearer === SUPABASE_SERVICE_ROLE_KEY || roleFromJwt(bearer) === "service_role");
    if (!isService) {
      const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { headers: { Authorization: authHeader } } });
      const { data: { user } } = await anon.auth.getUser();
      if (!user) return jr({ error: "Invalid token" }, 401);
      const { data: p } = await sb.from("staff_profiles").select("can_view_reports").eq("id", user.id).maybeSingle();
      if (!p?.can_view_reports) return jr({ error: "Not authorised" }, 403);
    }

    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const dryRun = body.dry_run === true;

    const { data: cfg } = await sb.from("journal_recon_config").select("*").eq("id", true).maybeSingle();
    if (cfg && cfg.enabled === false) return jr({ ok: true, skipped: "digest disabled in config" });

    // Latest finished run unless one is named.
    let runId: number | null = body.run_id ?? null;
    let run: any = null;
    if (runId) {
      const { data } = await sb.from("journal_recon_runs").select("*").eq("id", runId).maybeSingle();
      run = data;
    } else {
      const { data } = await sb.from("journal_recon_runs").select("*")
        .not("finished_at", "is", null).order("id", { ascending: false }).limit(1).maybeSingle();
      run = data; runId = data?.id ?? null;
    }
    if (!run) return jr({ ok: true, skipped: "no completed run to report" });

    const { data: findings } = await sb.from("journal_recon_findings")
      .select("company_name, employer, kind, period, detail, data, severity")
      .eq("run_id", runId).eq("status", "open").order("company_name");

    const all = findings || [];
    const report = all.filter((f) => REPORTABLE.includes(f.kind));
    const otherCount = all.length - report.length;

    if (report.length === 0) {
      return jr({ ok: true, run_id: runId, sent: false, reason: "no duplicates or missing journals" });
    }

    // Recipients: config ids -> active staff addresses.
    let recipients: string[] = [];
    if (body.test_recipient) {
      recipients = [body.test_recipient];
    } else {
      const ids = (cfg?.recipient_ids || []) as string[];
      if (!ids.length) return jr({ ok: false, error: "no recipients configured" }, 400);
      const { data: staff } = await sb.from("staff_profiles")
        .select("email, is_active").in("id", ids);
      recipients = (staff || []).filter((s: any) => s.is_active && s.email).map((s: any) => s.email);
    }
    if (!recipients.length) return jr({ ok: false, error: "no active recipients resolved" }, 400);

    // Group by client.
    const byClient: Record<string, any[]> = {};
    for (const f of report) {
      const k = f.company_name || f.employer || f.kind;
      (byClient[k] ||= []).push(f);
    }

    const dupes = report.filter((f) => f.kind === "duplicate");
    const missing = report.filter((f) => f.kind === "missing" || f.kind === "stopped_posting");
    const mismatch = report.filter((f) => f.kind === "amount_mismatch");
    // Coverage caveat. Not a row in the table (Bobby asked for duplicates and
    // missing), but it must be stated: a control check that quietly skips
    // clients reads as an all-clear over ledgers it never opened.
    const notChecked = all.filter((f) => f.kind === "not_checked");
    const dupeValue = dupes.reduce((a, f) => a + Number(f.data?.amount ?? 0), 0);

    const windowLabel = `${run.window_start} to ${run.window_end}`;

    const rows = Object.entries(byClient).map(([client, fs]) => `
      <tr><td colspan="3" style="padding:14px 10px 4px;font-weight:600;border-top:1px solid #e2e8f0;">${esc(client)}</td></tr>
      ${fs.map((f) => `
        <tr>
          <td style="padding:4px 10px;color:#64748b;white-space:nowrap;vertical-align:top;">${esc(f.period || "")}</td>
          <td style="padding:4px 10px;white-space:nowrap;vertical-align:top;">
            <span style="display:inline-block;padding:1px 7px;border-radius:10px;font-size:11px;font-weight:600;
              background:${f.kind === "duplicate" ? "#fee2e2" : (f.kind === "missing" || f.kind === "stopped_posting") ? "#fef3c7" : "#e0e7ff"};
              color:${f.kind === "duplicate" ? "#991b1b" : (f.kind === "missing" || f.kind === "stopped_posting") ? "#92400e" : "#3730a3"};">
              ${f.kind === "duplicate" ? "DUPLICATE" : f.kind === "missing" ? "MISSING" : f.kind === "stopped_posting" ? "STOPPED" : "MISMATCH"}
            </span>
          </td>
          <td style="padding:4px 10px;vertical-align:top;">${esc(f.detail)}</td>
        </tr>`).join("")}
    `).join("");

    const summary = [
      dupes.length ? `<strong>${dupes.length}</strong> duplicate posting${dupes.length === 1 ? "" : "s"}${dupeValue ? ` (£${money(dupeValue)})` : ""}` : null,
      missing.length ? `<strong>${missing.length}</strong> missing journal${missing.length === 1 ? "" : "s"}` : null,
      mismatch.length ? `<strong>${mismatch.length}</strong> amount mismatch${mismatch.length === 1 ? "" : "es"}` : null,
    ].filter(Boolean).join(" &middot; ");

    const html = `
<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#0f172a;max-width:760px;margin:0 auto;padding:24px;">
  <h2 style="margin:0 0 4px;font-size:19px;">Payroll journal control check</h2>
  <p style="margin:0 0 18px;color:#64748b;font-size:13px;">
    ${esc(windowLabel)} &middot; ${run.realms_checked} client${run.realms_checked === 1 ? "" : "s"} checked
  </p>

  <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:12px 14px;margin-bottom:18px;font-size:14px;">
    ${summary}
  </div>

  ${notChecked.length ? `<p style="margin:0 0 14px;padding:10px 12px;background:#fffbeb;border:1px solid #fde68a;border-radius:6px;font-size:13px;color:#92400e;"><strong>${notChecked.length} client${notChecked.length === 1 ? " was" : "s were"} not checked</strong> — no QuickBooks connection in Athena, so their postings were not verified either way: ${esc(notChecked.map((f) => f.employer).join(", "))}</p>` : ""}

  <p style="margin:0 0 6px;font-size:13px;color:#475569;">
    These are journals where QuickBooks disagrees with what the payroll run recorded.
    Each needs a person to decide what to do — nothing is corrected automatically.
  </p>

  <table style="width:100%;border-collapse:collapse;font-size:13px;margin-top:10px;">${rows}</table>

  <p style="margin:22px 0 0;font-size:12px;color:#94a3b8;">
    ${otherCount ? `${otherCount} other finding${otherCount === 1 ? "" : "s"} (orphan journals, uncategorised nominals, amounts that could not be verified) are recorded but not listed here.` : ""}
    <br/><a href="${ATHENA_URL}" style="color:#64748b;">Athena</a>
  </p>
</div>`;

    const text = [
      `Payroll journal control check — ${windowLabel}`,
      `${run.realms_checked} clients checked`,
      "",
      ...Object.entries(byClient).flatMap(([client, fs]) =>
        [client, ...fs.map((f) => `  [${f.kind}] ${f.period || ""} ${f.detail}`), ""]),
      otherCount ? `${otherCount} other findings recorded but not listed.` : "",
    ].join("\n");

    const subject = `Payroll journals: ${dupes.length} duplicate${dupes.length === 1 ? "" : "s"}, ${missing.length} missing`;

    if (dryRun) {
      return jr({ ok: true, dry_run: true, run_id: runId, recipients, subject,
        counts: { duplicates: dupes.length, missing: missing.length, mismatch: mismatch.length,
                  not_checked: notChecked.length, other: otherCount },
        duplicate_value: dupeValue });
    }

    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${RESEND_API_KEY}` },
      body: JSON.stringify({
        from: `${RESEND_FROM_NAME} <${RESEND_FROM_EMAIL}>`,
        to: recipients, subject, html, text,
      }),
    });
    const rj = await resp.json().catch(() => ({}));
    return jr({ ok: resp.ok, run_id: runId, recipients, subject, email_id: rj?.id ?? null,
      counts: { duplicates: dupes.length, missing: missing.length, mismatch: mismatch.length, not_checked: notChecked.length, other: otherCount },
      error: resp.ok ? undefined : (rj?.message || rj) }, resp.ok ? 200 : 502);
  } catch (err) {
    return jr({ error: String((err as Error)?.message ?? err) }, 500);
  }
});
