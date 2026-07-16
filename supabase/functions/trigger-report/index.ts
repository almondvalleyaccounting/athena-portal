import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const APPS_SCRIPT_REPORT_URL = Deno.env.get("APPS_SCRIPT_REPORT_URL")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ success: false, error: "Method not allowed" }, 405);
  }

  try {
    // 1. Verify JWT
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return jsonResponse({ success: false, error: "Missing authorization" }, 401);
    }

    const anonClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: { user }, error: authError } = await anonClient.auth.getUser();
    if (authError || !user) {
      return jsonResponse({ success: false, error: "Invalid token" }, 401);
    }

    // 2. Check can_view_reports permission
    const serviceClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const { data: profile, error: profileError } = await serviceClient
      .from("staff_profiles")
      .select("can_view_reports, can_view_practice_financials, name, email")
      .eq("id", user.id)
      .single();

    if (profileError || !profile) {
      return jsonResponse({ success: false, error: "Staff profile not found" }, 403);
    }

    if (!profile.can_view_reports) {
      return jsonResponse({ success: false, error: "Not authorised to run reports" }, 403);
    }

    // 3. Parse request body
    const body = await req.json();
    const {
      client_name,
      realm_id,
      report_type,
      report_label,
      start_date,
      end_date,
      report_date,
      accounting_method,
    } = body;

    if (!client_name || !realm_id || !report_type || !report_label) {
      return jsonResponse({ success: false, error: "Missing required fields" }, 400);
    }

    // Practice books (AVA's own QBO) need the dedicated flag — this function
    // runs service-role, so the restrictive RLS doesn't apply here on its own.
    const { data: connRow } = await serviceClient
      .from("qbo_report_connections")
      .select("is_practice")
      .eq("realm_id", realm_id)
      .maybeSingle();
    if (connRow?.is_practice && !profile.can_view_practice_financials) {
      return jsonResponse({ success: false, error: "Not authorised for practice financials" }, 403);
    }

    // 4. POST to Apps Script — must follow redirects (Apps Script returns 302)
    const appsScriptPayload = {
      client_name,
      realm_id,
      report_type,
      report_label,
      start_date: start_date || "",
      end_date: end_date || "",
      report_date: report_date || "",
      accounting_method: accounting_method || "Accrual",
    };

    const scriptResp = await fetch(APPS_SCRIPT_REPORT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(appsScriptPayload),
      redirect: "follow",
    });

    const scriptResult = await scriptResp.text();
    const scriptOk = scriptResp.ok;

    // 5. Write record to report_runs
    const { data: run, error: insertError } = await serviceClient
      .from("report_runs")
      .insert({
        user_id: user.id,
        user_email: user.email,
        user_name: profile.name || profile.email,
        client_name,
        realm_id,
        report_type,
        report_label,
        start_date: start_date || null,
        end_date: end_date || null,
        report_date: report_date || null,
        accounting_method: accounting_method || "Accrual",
        status: scriptOk ? "triggered" : "failed",
        detail: scriptOk ? scriptResult : null,
        error_message: scriptOk ? null : scriptResult,
      })
      .select("id")
      .single();

    if (insertError) {
      console.error("Failed to insert report_runs record:", insertError);
      return jsonResponse({ success: false, error: "Report dispatched but failed to log run" }, 500);
    }

    if (!scriptOk) {
      return jsonResponse({
        success: false,
        error: `Apps Script error: ${scriptResp.status}`,
        run_id: run.id,
      }, 502);
    }

    return jsonResponse({ success: true, run_id: run.id });
  } catch (err) {
    console.error("trigger-report error:", err);
    return jsonResponse({ success: false, error: String(err) }, 500);
  }
});
