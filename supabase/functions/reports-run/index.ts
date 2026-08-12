// reports-run — dispatch ONE QBO report to the Apps Script report runner.
//
// Replaces the unauthenticated /api/run-qbo-reports Vercel proxy. Two things
// that proxy got wrong and this fixes:
//
//  1. No auth. Anyone who knew the URL could pull any client's financials into
//     the shared Drive. Here: staff JWT + can_view_reports, and the practice's
//     own books need can_view_practice_financials on top.
//
//  2. Stale tokens. The Apps Script keeps its own copy of each client's QBO
//     tokens in the Control Panel spreadsheet's Clients tab, written once at
//     connect time. Every Athena-side refresh rotates the refresh token at
//     Intuit, which kills that copy — and the script then writes nothing while
//     still answering {success:true}. So: refresh here, push the live pair into
//     the sheet, and only then dispatch. If the push fails we say so instead of
//     dispatching a run that cannot succeed.
//
// One report per call, on purpose. A 15-report run takes minutes; the per-report
// shape keeps every invocation short and gives the run log a truthful row each.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getValidTokenPair } from "../_shared/qbo-client.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const APPS_SCRIPT_URL = Deno.env.get("APPS_SCRIPT_REPORT_URL") || "";
const PORTAL_SYNC_SECRET = Deno.env.get("PORTAL_SYNC_SECRET") || "";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Business failures come back 200 with success:false so the browser client can
// read the message — supabase.functions.invoke() throws away non-2xx bodies.
// Only auth failures use a real status code.
function jr(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jr({ success: false, error: "Method not allowed" }, 405);

  const svc = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  try {
    // ── Who's asking ──
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return jr({ success: false, error: "Missing authorization" }, 401);

    const { data: { user }, error: authErr } = await createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    }).auth.getUser();
    if (authErr || !user) return jr({ success: false, error: "Invalid token" }, 401);

    const { data: profile } = await svc
      .from("staff_profiles")
      .select("name, email, can_view_reports, can_view_practice_financials")
      .eq("id", user.id)
      .maybeSingle();

    if (!profile) return jr({ success: false, error: "Staff profile not found" }, 403);
    if (!profile.can_view_reports) {
      return jr({ success: false, error: "Not authorised to run reports" }, 403);
    }

    // ── What they asked for ──
    const body = await req.json();
    const {
      clientName,
      realmId,
      reportIndex,
      reportName,
      reportLabel,
      startDate,
      endDate,
      reportDate,
      accountingMethod,
      outputFormat,
    } = body ?? {};

    if (!realmId || typeof reportIndex !== "number" || !reportName || !reportLabel) {
      return jr({ success: false, error: "Missing required fields" }, 400);
    }
    if (!APPS_SCRIPT_URL || !PORTAL_SYNC_SECRET) {
      return jr({ success: false, error: "Report runner not configured (APPS_SCRIPT_REPORT_URL / PORTAL_SYNC_SECRET)" });
    }

    const { data: conn } = await svc
      .from("qbo_report_connections")
      .select("company_name, status, is_practice")
      .eq("realm_id", realmId)
      .maybeSingle();

    if (!conn || conn.status !== "active") {
      return jr({ success: false, error: "That client is not connected to QuickBooks" });
    }
    if (conn.is_practice && !profile.can_view_practice_financials) {
      return jr({ success: false, error: "Not authorised for practice financials" }, 403);
    }

    // The sheet keys its Clients tab on realm_id but names files from the client
    // name — take the name from the connection, not the caller.
    const name = conn.company_name || clientName || `QBO Company ${realmId}`;

    const logRun = (status: string, error_message: string | null) =>
      svc.from("report_runs").insert({
        triggered_by: user.id,
        triggered_by_name: profile.name || profile.email || user.email,
        client_name: name,
        realm_id: realmId,
        report_type: reportName,
        report_label: reportLabel,
        accounting_method: accountingMethod || "Accrual",
        start_date: startDate || null,
        end_date: endDate || null,
        report_date: reportDate || null,
        status,
        error_message,
      });

    // ── Live token into the sheet, then dispatch ──
    // 30-minute margin: the token has to outlive the whole run, not just this call.
    let tokens;
    try {
      tokens = await getValidTokenPair(realmId, 30 * 60 * 1000);
    } catch (e) {
      const msg = `QuickBooks token unusable — ${name} needs reconnecting (${e instanceof Error ? e.message : String(e)})`;
      await logRun("failed", msg);
      return jr({ success: false, error: msg });
    }

    const syncResp = await fetch(APPS_SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "sync_tokens",
        auth: `Bearer ${PORTAL_SYNC_SECRET}`,
        realmId,
        clientName: name,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
      }),
      redirect: "follow",
    });
    const syncText = await syncResp.text();
    if (!syncResp.ok) {
      const msg = `Could not refresh the report runner's token copy (${syncResp.status}): ${syncText.slice(0, 200)}`;
      await logRun("failed", msg);
      return jr({ success: false, error: msg });
    }

    const runResp = await fetch(APPS_SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        auth: `Bearer ${PORTAL_SYNC_SECRET}`,
        clientName: name,
        realmId,
        startDate: startDate || "",
        endDate: endDate || "",
        reportDate: reportDate || "",
        accountingMethod: accountingMethod || "Accrual",
        reportIndices: [reportIndex],
        outputFormat: outputFormat || "excel",
      }),
      redirect: "follow",
    });
    const runText = await runResp.text();

    // Apps Script answers with HTML on an unhandled error, so a body that
    // won't parse is a failure however healthy the status code looks.
    let result: Record<string, unknown> | null = null;
    try { result = JSON.parse(runText); } catch { /* not JSON */ }

    if (!runResp.ok || !result || result.success === false) {
      const msg = (result?.error as string) || `Report runner returned ${runResp.status}: ${runText.slice(0, 300)}`;
      await logRun("failed", msg);
      return jr({ success: false, error: msg });
    }

    await logRun("triggered", null);
    return jr({ success: true, ran: result.ran ?? 1 });
  } catch (err) {
    console.error("reports-run error:", err);
    return jr({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
});
