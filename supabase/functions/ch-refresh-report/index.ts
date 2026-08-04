// ch-refresh-report
// Morning confirmation email for the nightly Companies House refresh.
// Invoked by pg_cron at 06:00 UTC (see sql/122_ch_nightly_refresh.sql) with
// x-cron-secret, or manually by a portal admin JWT (with { dry_run: true }
// to preview without sending).
//
// Contents: last night's run summary (companies processed, chunks, duration),
// any errors in plain English, and every company whose Companies House status
// changed. Threatening changes (strike-off, liquidation, administration,
// dissolution) are highlighted and — when present — the email goes to ALL
// active staff rather than just the configured recipients.
//
// The email only goes out when something needs looking at: a real error, a
// client under threat, or a night the refresh didn't run. Clean nights are
// silent — the run detail is on the CH dashboard in Athena either way.
// Prospects mid-onboarding never count as errors (see IGNORED_FOR_ERRORS).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sendEmail } from "../_shared/resend.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

const THREAT_RE = /(strike|liquidat|administrat|insolven|dissolv|receiver)/i;

function statusLabel(status: string | null, detail: string | null): string {
  const s = (status || "unknown").replace(/-/g, " ");
  const d = detail ? ` (${detail.replace(/-/g, " ")})` : "";
  return s.charAt(0).toUpperCase() + s.slice(1) + d;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  try {
    const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const body = await req.json().catch(() => ({}));
    const dryRun = body?.dry_run === true;

    const { data: cfg } = await service.from("ch_refresh_config").select("*").eq("id", true).maybeSingle();
    if (!cfg) return jsonResponse({ error: "ch_refresh_config missing" }, 500);

    // Auth: cron secret, or a portal-admin JWT (manual test).
    const cronSecret = req.headers.get("x-cron-secret");
    if (cronSecret) {
      if (cronSecret !== cfg.cron_secret) return jsonResponse({ error: "Bad cron secret" }, 401);
    } else {
      const authHeader = req.headers.get("Authorization");
      if (!authHeader) return jsonResponse({ error: "Missing authorization" }, 401);
      const anonClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        global: { headers: { Authorization: authHeader } },
      });
      const { data: { user: caller } } = await anonClient.auth.getUser();
      if (!caller) return jsonResponse({ error: "Invalid token" }, 401);
      const { data: prof } = await service.from("staff_profiles").select("is_portal_admin").eq("id", caller.id).single();
      if (!prof?.is_portal_admin) return jsonResponse({ error: "Not authorised" }, 403);
    }

    // Last night's run: the row for today (chunks run 01:00–03:55 UTC today).
    const runDate = new Date().toISOString().slice(0, 10);
    const { data: run } = await service.from("ch_refresh_runs").select("*").eq("run_date", runDate).maybeSingle();

    // Status changes detected in the last 24h and not yet notified.
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const { data: events } = await service.from("ch_status_events")
      .select("*, entity:entities(id, name, company_number, entity_status)")
      .gte("detected_at", since)
      .is("notified_at", null)
      .order("detected_at", { ascending: true });

    // Former clients (nlac/archived) must never appear here. We do no work for
    // them, so their strike-off / status changes are none of our concern. Mark
    // their events notified so they drop out and don't get re-scanned nightly.
    const FORMER = new Set(["nlac", "archived"]);
    const allEvents = events || [];
    const formerEvents = allEvents.filter((c) => FORMER.has(c.entity?.entity_status));
    if (!dryRun && formerEvents.length) {
      await service.from("ch_status_events")
        .update({ notified_at: new Date().toISOString() })
        .in("id", formerEvents.map((c) => c.id));
    }

    const changes = allEvents.filter((c) => !FORMER.has(c.entity?.entity_status));
    const threats = changes.filter((c) =>
      THREAT_RE.test(c.new_status || "") || THREAT_RE.test(c.new_detail || ""));

    // Prospects mid-onboarding are not an error worth an email. Their company
    // number is often provisional or wrong until they're properly on board, so
    // a nightly "not found" for them is noise. Former clients go for the same
    // reason the status changes above do — we do no work for them.
    const IGNORED_FOR_ERRORS = new Set(["prospect", ...FORMER]);
    const rawErrors: { name: string; error: string; entity_id?: string }[] = (run?.errors || []);
    const errorEntityIds = [...new Set(rawErrors.map((e) => e.entity_id).filter(Boolean))] as string[];
    const ignoredIds = new Set<string>();
    if (errorEntityIds.length) {
      const { data: errEntities } = await service.from("entities")
        .select("id, entity_status").in("id", errorEntityIds);
      for (const e of errEntities || []) {
        if (IGNORED_FOR_ERRORS.has(e.entity_status)) ignoredIds.add(e.id);
      }
    }
    // An error with no entity_id can't be classified — keep it rather than hide it.
    const errors = rawErrors.filter((e) => !(e.entity_id && ignoredIds.has(e.entity_id)));
    const suppressedErrors = rawErrors.length - errors.length;
    const warnings: string[] = [...new Set(run?.warnings || [])] as string[];

    // Daily data-quality sweep: raise admin tasks for suspected duplicate
    // people (same client, same surname + DOB — sql/128). Non-fatal.
    let dupTasksRaised = 0;
    try {
      const { data: dupCount } = await service.rpc("raise_person_dedup_tasks");
      dupTasksRaised = Number(dupCount) || 0;
    } catch (_) { /* scan is best-effort */ }

    // Recipients: configured ids, else portal admins. Threats widen to all staff.
    const { data: staff } = await service.from("staff_profiles")
      .select("id, name, email, is_active, is_portal_admin")
      .eq("is_active", true);
    const active = (staff || []).filter((s) => (s.email || "").includes("@"));
    let recipients = active.filter((s) =>
      cfg.recipient_ids?.length ? cfg.recipient_ids.includes(s.id) : s.is_portal_admin);
    if (threats.length) recipients = active;
    if (cfg.test_recipient) recipients = [{ id: null, name: "Test", email: cfg.test_recipient } as any];

    const duration = run?.started_at && run?.last_chunk_at
      ? Math.round((new Date(run.last_chunk_at).getTime() - new Date(run.started_at).getTime()) / 60000)
      : null;

    const ok = run && errors.length === 0;

    // Nothing wrong → no email. Status changes on their own are not a reason to
    // write to anyone: they already land on the Triage Board.
    const worthSending = errors.length > 0 || threats.length > 0 || !run;
    const subject = threats.length
      ? `⚠ Companies House: ${threats.length} client${threats.length === 1 ? "" : "s"} under threat — nightly refresh report`
      : run
        ? `Companies House nightly refresh: ${run.processed} companies checked${ok ? ", no errors" : `, ${errors.length} error${errors.length === 1 ? "" : "s"}`}`
        : "Companies House nightly refresh did not run last night";

    const rowStyle = "padding:6px 10px;border-bottom:1px solid #f1f5f9;font-size:13px;color:#334155;";
    const html = `
<div style="font-family:Arial,Helvetica,sans-serif;max-width:640px;margin:0 auto;color:#0f172a;">
  <h2 style="font-size:17px;margin:16px 0 4px;">Companies House nightly refresh — ${runDate}</h2>
  ${run ? `
  <p style="font-size:13.5px;color:#334155;margin:6px 0 14px;">
    ${run.processed} companies checked across ${run.chunks} batch${run.chunks === 1 ? "" : "es"}${duration != null ? ` in about ${duration} minutes` : ""}.
    ${run.status_changes} status change${run.status_changes === 1 ? "" : "s"} detected.
    ${errors.length ? `${errors.length} error${errors.length === 1 ? "" : "s"} below.` : "No errors."}
  </p>` : `
  <p style="font-size:13.5px;color:#b91c1c;margin:6px 0 14px;">
    No refresh run was recorded last night — the schedule may be disabled or something failed before any batch completed. Worth checking.
  </p>`}

  ${threats.length ? `
  <div style="border:1px solid #fecaca;background:#fef2f2;border-radius:8px;padding:12px 14px;margin:0 0 16px;">
    <div style="font-size:14px;font-weight:bold;color:#b91c1c;margin-bottom:6px;">⚠ Clients under threat — status changed at Companies House</div>
    ${threats.map((c) => `
      <div style="font-size:13px;color:#7f1d1d;padding:3px 0;">
        <strong>${c.entity?.name || "Unknown"}</strong> (${c.entity?.company_number || "—"}):
        ${statusLabel(c.old_status, c.old_detail)} → <strong>${statusLabel(c.new_status, c.new_detail)}</strong>
      </div>`).join("")}
    <div style="font-size:12px;color:#991b1b;margin-top:6px;">These appear on the Triage Board in Athena.</div>
  </div>` : ""}

  ${changes.length > threats.length ? `
  <h3 style="font-size:14px;margin:14px 0 6px;">Other status changes</h3>
  <div style="border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
    ${changes.filter((c) => !threats.includes(c)).map((c) => `
      <div style="${rowStyle}">
        <strong>${c.entity?.name || "Unknown"}</strong>:
        ${statusLabel(c.old_status, c.old_detail)} → ${statusLabel(c.new_status, c.new_detail)}
      </div>`).join("")}
  </div>` : ""}

  ${errors.length ? `
  <h3 style="font-size:14px;margin:14px 0 6px;">Errors</h3>
  <div style="border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
    ${errors.slice(0, 30).map((er) => `<div style="${rowStyle}"><strong>${er.name}</strong>: ${er.error}</div>`).join("")}
    ${errors.length > 30 ? `<div style="${rowStyle}">…and ${errors.length - 30} more.</div>` : ""}
  </div>` : ""}

  ${dupTasksRaised ? `
  <p style="font-size:13px;color:#334155;margin-top:12px;">
    ${dupTasksRaised} possible duplicate ${dupTasksRaised === 1 ? "person was" : "people were"} flagged to the admin task list (Data quality section).
  </p>` : ""}

  ${warnings.length ? `
  <p style="font-size:12px;color:#64748b;margin-top:12px;">${warnings.join("<br/>")}</p>` : ""}

  <p style="font-size:12px;color:#94a3b8;margin-top:18px;">Sent automatically by Athena.</p>
</div>`;

    const text = [
      `Companies House nightly refresh — ${runDate}`,
      run ? `${run.processed} companies checked, ${run.status_changes} status changes, ${errors.length} errors.` : "No refresh run recorded last night.",
      ...threats.map((c) => `THREAT: ${c.entity?.name}: ${statusLabel(c.old_status, c.old_detail)} -> ${statusLabel(c.new_status, c.new_detail)}`),
      ...errors.slice(0, 30).map((er) => `ERROR: ${er.name}: ${er.error}`),
    ].join("\n");

    if (dryRun) {
      return jsonResponse({
        dry_run: true, subject, worth_sending: worthSending,
        recipients: worthSending ? recipients.map((r) => r.email) : [],
        changes: changes.length, threats: threats.length, errors: errors.length,
        suppressed_errors: suppressedErrors,
        dup_tasks_raised: dupTasksRaised, html,
      });
    }

    let sent = 0;
    const sendErrors: unknown[] = [];
    if (worthSending && recipients.length) {
      const res = await sendEmail({
        to: recipients.map((r) => r.email),
        subject, html, text,
      });
      if (res.ok) sent = recipients.length; else sendErrors.push(res.error);
    }

    if (sent && changes.length) {
      await service.from("ch_status_events")
        .update({ notified_at: new Date().toISOString() })
        .in("id", changes.map((c) => c.id));
    }
    if (run) {
      await service.from("ch_refresh_runs").update({ reported_at: new Date().toISOString() }).eq("run_date", runDate);
    }
    await service.from("audit_log").insert({
      action: "ch_refresh_report", entity_type: "system", entity_id: null,
      detail: {
        run_date: runDate, sent_to: sent ? recipients.map((r) => r.email) : [],
        emailed: worthSending, threats: threats.length, changes: changes.length,
        errors: errors.length, suppressed_errors: suppressedErrors,
        dup_tasks_raised: dupTasksRaised,
      },
    });

    return jsonResponse({
      success: true, sent, emailed: worthSending,
      recipients: sent ? recipients.map((r) => r.email) : [],
      threats: threats.length, errors: errors.length,
      suppressed_errors: suppressedErrors, send_errors: sendErrors,
    });
  } catch (err: any) {
    return jsonResponse({ error: err?.message || String(err) }, 500);
  }
});
