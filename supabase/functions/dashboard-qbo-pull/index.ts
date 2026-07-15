// dashboard-qbo-pull
// Pulls a slice of dashboard metrics for ONE client's QuickBooks (by realm_id),
// caches each metric in qbo_dashboard_cache, and returns them. Cached + refresh
// model: returns cache if fresh unless { refresh:true }.
//
// Self-contained (inlines token logic) — mirrors the deployed planning-qbo-pull,
// which is the divergence-proof pattern for MCP deploys in this project.
//
// Auth: verify_jwt=true at the gateway AND an in-function staff check
// (can_view_reports) — because portal clients share auth.users, so a valid JWT
// alone is NOT sufficient to read a client's financials.
//
// Token resolution per realm: prefer qbo_report_tokens (per-client, populated on
// reconnect); fall back to an active qbo_connections row on the same realm (lets
// AVA's own books work before any client reconnect).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const QBO_CLIENT_ID = Deno.env.get("QBO_CLIENT_ID")!;
const QBO_CLIENT_SECRET = Deno.env.get("QBO_CLIENT_SECRET")!;
const QBO_API_BASE = Deno.env.get("QBO_API_BASE") || "https://quickbooks.api.intuit.com";
const QBO_TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";

const DEFAULT_MAX_AGE_MIN = 24 * 60; // 24h

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
function jr(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...cors } });
}
function svc() { return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY); }

/* ── Token resolution + QBO fetch (per realm) ─────────────────────── */

type Src = { table: "qbo_connections" | "qbo_report_tokens"; keyCol: "id" | "realm_id"; conn: any };

async function resolveSource(sb: any, realmId: string): Promise<Src> {
  const { data: rt } = await sb.from("qbo_report_tokens").select("*").eq("realm_id", realmId).maybeSingle();
  if (rt && rt.refresh_token) return { table: "qbo_report_tokens", keyCol: "realm_id", conn: rt };
  const { data: bc } = await sb.from("qbo_connections").select("*").eq("realm_id", realmId).eq("status", "active").maybeSingle();
  if (bc) return { table: "qbo_connections", keyCol: "id", conn: bc };
  throw new Error(`No stored QBO tokens for realm ${realmId}. The client needs to reconnect QuickBooks.`);
}

async function refreshToken(sb: any, src: Src) {
  const basicAuth = btoa(`${QBO_CLIENT_ID}:${QBO_CLIENT_SECRET}`);
  const resp = await fetch(QBO_TOKEN_URL, {
    method: "POST",
    headers: { "Authorization": `Basic ${basicAuth}`, "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: src.conn.refresh_token }),
  });
  const keyVal = src.conn[src.keyCol];
  if (!resp.ok) {
    const err = await resp.text();
    await sb.from(src.table).update({ status: "error", error_message: `Token refresh failed: ${resp.status} ${err}`, updated_at: new Date().toISOString() }).eq(src.keyCol, keyVal);
    throw new Error(`QBO token refresh failed: ${resp.status}`);
  }
  const tokens = await resp.json();
  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);
  const refreshExpiresAt = tokens.x_refresh_token_expires_in ? new Date(Date.now() + tokens.x_refresh_token_expires_in * 1000) : null;
  await sb.from(src.table).update({
    access_token: tokens.access_token, refresh_token: tokens.refresh_token,
    token_expires_at: expiresAt.toISOString(),
    refresh_token_expires_at: refreshExpiresAt?.toISOString() || src.conn.refresh_token_expires_at,
    last_refreshed_at: new Date().toISOString(), status: "active", error_message: null, updated_at: new Date().toISOString(),
  }).eq(src.keyCol, keyVal);
  return tokens.access_token as string;
}

async function tokenFor(sb: any, realmId: string): Promise<string> {
  const src = await resolveSource(sb, realmId);
  const expiresAt = new Date(src.conn.token_expires_at);
  if (expiresAt.getTime() - Date.now() < 5 * 60 * 1000) return await refreshToken(sb, src);
  return src.conn.access_token;
}

async function qboFetch(sb: any, realmId: string, path: string): Promise<Response> {
  let token = await tokenFor(sb, realmId);
  const url = `${QBO_API_BASE}/v3/company/${realmId}/${path}`;
  let resp = await fetch(url, { headers: { "Authorization": `Bearer ${token}`, "Accept": "application/json" } });
  if (resp.status === 401) {
    const src = await resolveSource(sb, realmId);
    token = await refreshToken(sb, src);
    resp = await fetch(url, { headers: { "Authorization": `Bearer ${token}`, "Accept": "application/json" } });
  }
  return resp;
}
async function qboQuery(sb: any, realmId: string, query: string): Promise<any> {
  const resp = await qboFetch(sb, realmId, `query?query=${encodeURIComponent(query)}&minorversion=75`);
  if (!resp.ok) throw new Error(`QBO query failed: ${resp.status} ${(await resp.text()).slice(0, 300)}`);
  return resp.json();
}

/* ── Date helpers ─────────────────────────────────────────────────── */
function fmt(d: Date) { return d.toISOString().slice(0, 10); }
function lastDay(y: number, m: number) { return new Date(y, m + 1, 0); }

/* ── Metric pulls ─────────────────────────────────────────────────── */

async function pullCompany(sb: any, realmId: string) {
  const resp = await qboFetch(sb, realmId, `companyinfo/${realmId}?minorversion=75`);
  if (!resp.ok) throw new Error(`companyinfo ${resp.status}`);
  const j = await resp.json();
  const ci = j?.CompanyInfo || {};
  return {
    name: ci.CompanyName || null,
    legal_name: ci.LegalName || null,
    country: ci.Country || null,
    fiscal_year_start_month: ci?.NameValue?.find?.((n: any) => n.Name === "FiscalYearStartMonth")?.Value || null,
  };
}

// P&L headline for the last 12 full months.
async function pullPlSummary(sb: any, realmId: string) {
  const now = new Date();
  const endMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const startMonthStart = new Date(endMonthStart.getFullYear(), endMonthStart.getMonth() - 11, 1);
  const start = fmt(startMonthStart);
  const end = fmt(lastDay(endMonthStart.getFullYear(), endMonthStart.getMonth()));

  const resp = await qboFetch(sb, realmId, `reports/ProfitAndLoss?start_date=${start}&end_date=${end}&accounting_method=Accrual&minorversion=75`);
  if (!resp.ok) throw new Error(`P&L ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const report = await resp.json();
  const rows = report?.Rows?.Row || [];

  // Top-level P&L rows carry a `group` and a Summary total. Collect them.
  const groups: Record<string, number> = {};
  const walk = (rs: any[]) => {
    for (const r of rs || []) {
      if (r.group && r.Summary?.ColData) {
        const v = parseFloat(r.Summary.ColData[r.Summary.ColData.length - 1]?.value || "0");
        if (!isNaN(v)) groups[r.group] = v;
      }
      if (r.Rows?.Row) walk(r.Rows.Row);
    }
  };
  walk(rows);

  const num = (k: string) => (typeof groups[k] === "number" ? groups[k] : null);
  return {
    period: { start, end },
    currency: report?.Header?.Currency || null,
    income: num("Income"),
    cogs: num("COGS"),
    gross_profit: num("GrossProfit"),
    expenses: num("Expenses"),
    net_operating_income: num("NetOperatingIncome"),
    net_income: num("NetIncome"),
    groups, // raw for reference
  };
}

// Bookkeeping "file health" signals from the chart of accounts.
async function pullFileHealth(sb: any, realmId: string) {
  const j = await qboQuery(sb, realmId, "SELECT * FROM Account MAXRESULTS 1000");
  const accounts: any[] = j?.QueryResponse?.Account || [];
  const bal = (a: any) => Number(a.CurrentBalance || 0);

  const byName = (re: RegExp) => accounts.filter((a) => re.test(a.Name || ""));
  const bySub = (sub: string) => accounts.filter((a) => a.AccountSubType === sub);

  const sum = (arr: any[]) => arr.reduce((s, a) => s + bal(a), 0);

  const uncategorised = byName(/uncategori[sz]ed/i);
  const undeposited = bySub("UndepositedFunds");
  const obe = accounts.filter((a) => a.AccountSubType === "OpeningBalanceEquity" || /opening balance equity/i.test(a.Name || ""));
  const askMyAccountant = byName(/ask my accountant/i);
  const reconDiscrepancy = byName(/reconciliation discrepanc/i);

  const signals = {
    uncategorised_total: sum(uncategorised),
    uncategorised_accounts: uncategorised.map((a) => ({ name: a.Name, balance: bal(a) })),
    undeposited_funds: sum(undeposited),
    opening_balance_equity: sum(obe),
    ask_my_accountant: sum(askMyAccountant),
    reconciliation_discrepancies: sum(reconDiscrepancy),
    account_count: accounts.length,
  };

  // Simple traffic-light: any nonzero hygiene balance = a flag.
  const flags: string[] = [];
  if (Math.abs(signals.uncategorised_total) > 0.005) flags.push("Uncategorised balance");
  if (Math.abs(signals.undeposited_funds) > 0.005) flags.push("Undeposited funds");
  if (Math.abs(signals.opening_balance_equity) > 0.005) flags.push("Opening balance equity ≠ 0");
  if (Math.abs(signals.ask_my_accountant) > 0.005) flags.push("Ask My Accountant balance");
  if (Math.abs(signals.reconciliation_discrepancies) > 0.005) flags.push("Reconciliation discrepancies");

  const score = flags.length === 0 ? "green" : flags.length <= 2 ? "amber" : "red";
  return { ...signals, flags, score };
}

const METRICS: Record<string, (sb: any, realmId: string) => Promise<any>> = {
  company: pullCompany,
  pl_summary: pullPlSummary,
  file_health: pullFileHealth,
};

/* ── Handler ──────────────────────────────────────────────────────── */

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return jr({ success: false, error: "POST required" }, 405);

  try {
    // 1. Auth — valid JWT + active staff with can_view_reports
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return jr({ success: false, error: "Missing authorization" }, 401);
    const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { headers: { Authorization: authHeader } } });
    const { data: { user }, error: authErr } = await anon.auth.getUser();
    if (authErr || !user) return jr({ success: false, error: "Invalid token" }, 401);

    const sb = svc();
    const { data: profile } = await sb.from("staff_profiles").select("can_view_reports").eq("id", user.id).single();
    if (!profile?.can_view_reports) return jr({ success: false, error: "Not authorised" }, 403);

    // 2. Body
    const body = await req.json().catch(() => ({}));
    const realmId = String(body.realmId || body.realm_id || "");
    if (!realmId) return jr({ success: false, error: "realmId required" }, 400);
    const refresh = body.refresh === true;
    const maxAgeMin = Number(body.maxAgeMinutes || DEFAULT_MAX_AGE_MIN);
    const wanted: string[] = Array.isArray(body.metrics) && body.metrics.length
      ? body.metrics.filter((m: string) => m in METRICS)
      : Object.keys(METRICS);

    // 3. Cache read
    const { data: cacheRows } = await sb.from("qbo_dashboard_cache").select("*").eq("realm_id", realmId);
    const cacheByKey: Record<string, any> = {};
    for (const row of cacheRows || []) cacheByKey[row.metric_key] = row;

    const cutoff = Date.now() - maxAgeMin * 60 * 1000;
    const isFresh = (row: any) => row && new Date(row.pulled_at).getTime() >= cutoff;

    const metrics: Record<string, any> = {};
    const errors: Record<string, string> = {};
    let anyPulled = false;

    for (const key of wanted) {
      const cached = cacheByKey[key];
      if (!refresh && isFresh(cached)) {
        metrics[key] = cached.data;
        continue;
      }
      try {
        const data = await METRICS[key](sb, realmId);
        metrics[key] = data;
        anyPulled = true;
        // upsert cache (one row per realm+metric)
        await sb.from("qbo_dashboard_cache").delete().eq("realm_id", realmId).eq("metric_key", key);
        await sb.from("qbo_dashboard_cache").insert({
          realm_id: realmId, metric_key: key,
          period_start: data?.period?.start || null,
          period_end: data?.period?.end || null,
          data, pulled_at: new Date().toISOString(),
        });
      } catch (e) {
        errors[key] = (e as Error).message;
        if (cached) metrics[key] = cached.data; // fall back to stale cache
      }
    }

    return jr({
      success: Object.keys(errors).length === 0,
      realmId,
      metrics,
      errors: Object.keys(errors).length ? errors : undefined,
      cached: !anyPulled,
      pulled_at: new Date().toISOString(),
    });
  } catch (err) {
    return jr({ success: false, error: (err as Error).message }, 500);
  }
});
