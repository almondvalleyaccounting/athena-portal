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

// P&L headline for a QBO date macro (QBO resolves the fiscal calendar from
// company settings — AVA's year starts 1 October). "This Fiscal Year-to-date"
// = current FYTD; "Last Fiscal Year-to-date" = the same span a year earlier,
// which is what the home-screen pulse compares against for YoY.
async function pullPlMacro(sb: any, realmId: string, macro: string) {
  const resp = await qboFetch(sb, realmId, `reports/ProfitAndLoss?date_macro=${encodeURIComponent(macro)}&accounting_method=Accrual&minorversion=75`);
  if (!resp.ok) throw new Error(`P&L ${macro} ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const report = await resp.json();

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
  walk(report?.Rows?.Row || []);

  const num = (k: string) => (typeof groups[k] === "number" ? groups[k] : null);
  return {
    period: { start: report?.Header?.StartPeriod || null, end: report?.Header?.EndPeriod || null },
    currency: report?.Header?.Currency || null,
    income: num("Income"),
    cogs: num("COGS"),
    gross_profit: num("GrossProfit"),
    expenses: num("Expenses"),
    net_operating_income: num("NetOperatingIncome"),
    net_income: num("NetIncome"),
  };
}
const pullPlFytd = (sb: any, realmId: string) => pullPlMacro(sb, realmId, "This Fiscal Year-to-date");
const pullPlFytdPrior = (sb: any, realmId: string) => pullPlMacro(sb, realmId, "Last Fiscal Year-to-date");

// Balance snapshot from the Account list: cash in bank, debtors, creditors.
// CurrentBalance is only meaningful on balance-sheet accounts, which is all
// we read here.
async function pullBalances(sb: any, realmId: string) {
  const j = await qboQuery(sb, realmId, "SELECT * FROM Account MAXRESULTS 1000");
  const accounts = j?.QueryResponse?.Account || [];
  const ofType = (t: string) => accounts.filter((a: any) => a.AccountType === t);
  const sum = (arr: any[]) => arr.reduce((s, a) => s + Number(a.CurrentBalance || 0), 0);
  return {
    cash: sum(ofType("Bank")),
    debtors: sum(ofType("Accounts Receivable")),
    creditors: sum(ofType("Accounts Payable")),
    credit_cards: sum(ofType("Credit Card")),
    bank_account_count: ofType("Bank").length,
  };
}

// Bookkeeping "file health" signals.
// NOTE on what QBO's API can and can't see:
//  - Balance-sheet hygiene accounts (Undeposited Funds, Opening Balance Equity,
//    Ask My Accountant, Reconciliation Discrepancies, Uncategorised ASSET) →
//    read via Account.CurrentBalance (only meaningful for balance-sheet accounts).
//  - Uncategorised INCOME/EXPENSE are P&L accounts whose CurrentBalance is ~0
//    even when posted, so they're read from the P&L report instead.
//  - Unreconciled bank transactions → TransactionList with cleared=Uncleared.
//  - The bank-feed "For Review" queue (un-added imported transactions) is NOT
//    exposed by the QBO API at all, so it cannot appear here.
async function pullFileHealth(sb: any, realmId: string) {
  const j = await qboQuery(sb, realmId, "SELECT * FROM Account MAXRESULTS 1000");
  const accounts: any[] = j?.QueryResponse?.Account || [];
  const bal = (a: any) => Number(a.CurrentBalance || 0);
  const byName = (re: RegExp) => accounts.filter((a) => re.test(a.Name || ""));
  const bySub = (sub: string) => accounts.filter((a) => a.AccountSubType === sub);
  const sum = (arr: any[]) => arr.reduce((s, a) => s + bal(a), 0);

  const undeposited = sum(bySub("UndepositedFunds"));
  const obe = sum(accounts.filter((a) => a.AccountSubType === "OpeningBalanceEquity" || /opening balance equity/i.test(a.Name || "")));
  const askMyAccountant = sum(byName(/ask my accountant/i));
  const reconDiscrepancy = sum(byName(/reconciliation discrepanc/i));
  const uncatAsset = sum(accounts.filter((a) => /uncategori[sz]ed/i.test(a.Name || "") && a.Classification === "Asset"));
  const bankAccounts = accounts.filter((a) => a.AccountType === "Bank" || a.AccountType === "Credit Card");

  // Uncategorised income/expense from the P&L (last 12 months).
  let uncatPL = 0;
  try {
    const now = new Date();
    const start = fmt(new Date(now.getFullYear() - 1, now.getMonth(), 1));
    const end = fmt(now);
    const plResp = await qboFetch(sb, realmId, `reports/ProfitAndLoss?start_date=${start}&end_date=${end}&accounting_method=Accrual&minorversion=75`);
    if (plResp.ok) {
      const pl = await plResp.json();
      const walk = (rs: any[]) => {
        for (const r of rs || []) {
          if (r.ColData && /uncategori[sz]ed/i.test(r.ColData[0]?.value || "")) {
            const v = parseFloat(r.ColData[r.ColData.length - 1]?.value || "0");
            if (!isNaN(v)) uncatPL += Math.abs(v);
          }
          if (r.Rows?.Row) walk(r.Rows.Row);
        }
      };
      walk(pl?.Rows?.Row);
    }
  } catch { /* non-fatal */ }

  const uncategorised_total = Math.abs(uncatAsset) + uncatPL;

  // Unreconciled bank transactions via TransactionList (cleared=Uncleared).
  let unreconciled_count = 0;
  let unreconciled_total = 0;
  let unrecError: string | undefined;
  let tlColumns: string[] = [];
  try {
    const bankIds = bankAccounts.map((a) => a.Id).filter(Boolean);
    const bankNames = new Set(bankAccounts.map((a) => a.Name));
    const end = fmt(new Date());
    let path = `reports/TransactionList?start_date=2018-01-01&end_date=${end}&cleared=Uncleared&minorversion=75`;
    if (bankIds.length) path += `&account=${bankIds.join(",")}`;
    const tlResp = await qboFetch(sb, realmId, path);
    if (!tlResp.ok) {
      unrecError = `TransactionList ${tlResp.status}`;
    } else {
      const tl = await tlResp.json();
      const cols = tl?.Columns?.Column || [];
      tlColumns = cols.map((c: any) => c.ColTitle || c.ColType);
      let amtIdx = cols.findIndex((c: any) => /amount/i.test(c.ColTitle || "") || c.ColType === "Money");
      const acctIdx = cols.findIndex((c: any) => /account/i.test(c.ColTitle || "") || c.ColType === "account_name");
      if (amtIdx < 0) amtIdx = cols.length - 1;
      const walk = (rs: any[]) => {
        for (const r of rs || []) {
          if (r.ColData && Array.isArray(r.ColData) && r.type !== "Section") {
            const hasDate = (r.ColData[0]?.value || "").length > 0;
            const acctName = acctIdx >= 0 ? (r.ColData[acctIdx]?.value || "") : "";
            // If an account column is present, restrict to bank/CC accounts.
            const okAcct = acctIdx < 0 || !acctName || bankNames.size === 0 || bankNames.has(acctName);
            if (hasDate && okAcct) {
              unreconciled_count++;
              const amt = parseFloat(r.ColData[amtIdx]?.value || "0");
              if (!isNaN(amt)) unreconciled_total += amt;
            }
          }
          if (r.Rows?.Row) walk(r.Rows.Row);
        }
      };
      walk(tl?.Rows?.Row);
    }
  } catch (e) {
    unrecError = (e as Error).message;
  }

  const signals = {
    uncategorised_total,
    uncategorised_asset: Math.abs(uncatAsset),
    uncategorised_pl: uncatPL,
    undeposited_funds: undeposited,
    opening_balance_equity: obe,
    ask_my_accountant: askMyAccountant,
    reconciliation_discrepancies: reconDiscrepancy,
    unreconciled_count,
    unreconciled_total,
    bank_account_count: bankAccounts.length,
    account_count: accounts.length,
  };

  const flags: string[] = [];
  const nz = (v: number) => Math.abs(v) > 0.005;
  if (nz(uncategorised_total)) flags.push("Uncategorised transactions");
  if (nz(undeposited)) flags.push("Undeposited funds");
  if (nz(obe)) flags.push("Opening balance equity ≠ 0");
  if (nz(askMyAccountant)) flags.push("Ask My Accountant balance");
  if (nz(reconDiscrepancy)) flags.push("Reconciliation discrepancies");
  if (unreconciled_count > 0) flags.push(`Unreconciled bank items (${unreconciled_count})`);

  const score = flags.length === 0 ? "green" : flags.length <= 2 ? "amber" : "red";
  return { ...signals, flags, score, _debug: { unrecError, tlColumns } };
}

const METRICS: Record<string, (sb: any, realmId: string) => Promise<any>> = {
  company: pullCompany,
  pl_summary: pullPlSummary,
  pl_fytd: pullPlFytd,
  pl_fytd_prior: pullPlFytdPrior,
  balances: pullBalances,
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
    const { data: profile } = await sb.from("staff_profiles").select("can_view_reports, can_view_practice_financials").eq("id", user.id).single();
    if (!profile?.can_view_reports) return jr({ success: false, error: "Not authorised" }, 403);

    // 2. Body
    const body = await req.json().catch(() => ({}));
    const realmId = String(body.realmId || body.realm_id || "");
    if (!realmId) return jr({ success: false, error: "realmId required" }, 400);

    // 2b. Practice books (AVA's own QBO) are locked behind a separate flag —
    // this mirrors the restrictive RLS on qbo_report_connections/cache, and
    // matters because this function reads with the service role.
    const { data: connRow } = await sb.from("qbo_report_connections").select("is_practice").eq("realm_id", realmId).maybeSingle();
    if (connRow?.is_practice && !profile?.can_view_practice_financials) {
      return jr({ success: false, error: "Not authorised for practice financials" }, 403);
    }
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
