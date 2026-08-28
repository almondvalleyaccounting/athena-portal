// dashboard-qbo-pull
// Pulls a slice of dashboard metrics for ONE client's QuickBooks (by realm_id),
// caches each metric in qbo_dashboard_cache, and returns them. Cached + refresh
// model: returns cache if fresh unless { refresh:true }.
//
// Inlines its own token logic — mirrors the deployed planning-qbo-pull. (The
// only shared import is the authorisation helper, which scripts/deploy-edge-
// function.cjs follows off disk, so what deploys is what is in the repo.)
//
// Auth: verify_jwt=true at the gateway AND an in-function check — because portal
// clients share auth.users, so a valid JWT alone is NOT sufficient to read a
// client's financials. requireStaffOrService admits exactly two kinds of caller:
// active staff holding can_view_reports, and a service-role caller.
//
// The service-role branch is what lets portal-dashboard exist. A client-portal
// user never reaches this function; portal-dashboard authenticates them, checks
// their client_dashboard_access grant, resolves the realm ITSELF, and then calls
// here server-side with the service key. That keeps every QuickBooks call and
// every report parser in one place, so a client can never be shown a figure
// derived differently from the one staff see.
//
// Note that a service caller has no staff profile, so the practice-books guard
// below refuses AVA's own realm on that path. That is deliberate: fail closed.
//
// Token resolution per realm: prefer qbo_report_tokens (per-client, populated on
// reconnect); fall back to an active qbo_connections row on the same realm (lets
// AVA's own books work before any client reconnect).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { failureUpdate, refreshWithRetry } from "../_shared/oauth-refresh.ts";
import { requireStaffOrService, authErrorResponse, type Caller } from "../_shared/require-staff.ts";

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
  // A 5xx or a dropped connection is retried and leaves the connection enabled
  // so the next run picks it up; only a dead grant disables it. A transient
  // blip once took accounts@ dark for 36 days. See _shared/oauth-refresh.ts.
  const outcome = await refreshWithRetry(
    QBO_TOKEN_URL,
    new URLSearchParams({ grant_type: "refresh_token", refresh_token: src.conn.refresh_token }),
    { "Authorization": `Basic ${basicAuth}`, "Accept": "application/json" },
  );
  const keyVal = src.conn[src.keyCol];
  if (!outcome.ok) {
    await sb.from(src.table).update(failureUpdate(outcome)).eq(src.keyCol, keyVal);
    throw new Error(
      `QBO token refresh failed after ${outcome.attempts} attempt(s): ${outcome.status} ${outcome.body}` +
      (outcome.permanent ? " — reconnect required" : " — transient, will retry"),
    );
  }
  const tokens = outcome.tokens as Record<string, any>;
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
// Last day of the month `n` calendar months before `base` (n=0 → this month
// end, n=1 → last month end, n=3 → three months ago, …). Handles year rollover.
function monthEndOffset(base: Date, n: number) { return new Date(base.getFullYear(), base.getMonth() - n + 1, 0); }

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

// Chart of accounts, P&L accounts only (Revenue/Expense classification) — the
// picker for tagging owner-cost / one-off nominal codes on the Underlying
// Performance tab. Account.Id matches the P&L report row ids, so tagged codes
// map exactly onto report lines.
async function pullAccounts(sb: any, realmId: string) {
  const j = await qboQuery(sb, realmId, "SELECT * FROM Account MAXRESULTS 1000");
  const all: any[] = j?.QueryResponse?.Account || [];
  const byId: Record<string, any> = {};
  for (const a of all) byId[String(a.Id)] = a;
  const pl = all
    .filter((a) => a.Classification === "Revenue" || a.Classification === "Expense")
    .map((a) => {
      const parentId = a.ParentRef?.value ? String(a.ParentRef.value) : null;
      const parent = parentId ? byId[parentId] : null;
      return {
        id: String(a.Id),
        acct_num: a.AcctNum || null,
        name: a.Name || "",
        fq_name: a.FullyQualifiedName || a.Name || "",
        type: a.AccountType || null,        // Income / Other Income / Cost of Goods Sold / Expense / Other Expense
        sub_type: a.AccountSubType || null,
        classification: a.Classification || null, // Revenue | Expense
        is_sub: a.SubAccount === true,
        parent_id: parentId,
        parent_num: parent?.AcctNum || null, // nominal code of the parent account, for hierarchy ordering
        parent_name: parent?.Name || null,
        active: a.Active !== false,
      };
    });
  return { accounts: pl };
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

/* ── Dashboard v2 metrics ─────────────────────────────────────────── */

// Monthly P&L, last 12 months INCLUDING the current month, one column per
// month (summarize_column_by=Month). Stores the raw report (the UI renders
// expandable section→account rows from it) plus pre-parsed per-month series
// for the trend chart and portfolio sparklines.
// period_end = end of the current month → the snapshot upserts in place all
// month, then a new row starts each month (monthly history, not daily).
async function pullPnlMonthly(sb: any, realmId: string) {
  const now = new Date();
  const start = fmt(new Date(now.getFullYear(), now.getMonth() - 11, 1));
  const end = fmt(lastDay(now.getFullYear(), now.getMonth()));
  const resp = await qboFetch(sb, realmId, `reports/ProfitAndLoss?start_date=${start}&end_date=${end}&summarize_column_by=Month&accounting_method=Accrual&minorversion=75`);
  if (!resp.ok) throw new Error(`P&L monthly ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const report = await resp.json();

  const cols = (report?.Columns?.Column || []).map((c: any) => c.ColTitle ?? "");
  // Value columns = everything after the account-name column; the trailing
  // "Total" column is excluded from the month series.
  const months = cols.slice(1).filter((t: string) => !/^total$/i.test(t));
  const nMonths = months.length;

  const series: Record<string, number[]> = {};
  const walk = (rs: any[]) => {
    for (const r of rs || []) {
      const cd = r.Summary?.ColData;
      if (r.group && cd) {
        series[r.group] = cd.slice(1, 1 + nMonths).map((c: any) => {
          const v = parseFloat(c?.value ?? "");
          return isNaN(v) ? 0 : v;
        });
      }
      if (r.Rows?.Row) walk(r.Rows.Row);
    }
  };
  walk(report?.Rows?.Row || []);

  return {
    period: { start, end },
    currency: report?.Header?.Currency || null,
    months,
    series: {
      income: series.Income || null,
      cogs: series.COGS || null,
      gross_profit: series.GrossProfit || null,
      expenses: series.Expenses || null,
      net_income: series.NetIncome || null,
    },
    report,
  };
}

// Named balance-sheet lines from a group map. Works for both the UK
// "net assets" format (AVA and clients — Fixed Assets / Current Assets /
// Creditors <1yr = CurrentLiabilities / Creditors >1yr = LongTermLiabilities /
// Net Assets) and the US "TotalAssets / Liabilities" format.
//   * Total liabilities = Creditors falling due within one year + Creditors
//     falling due after more than one year (Bobby's rule). The UK report has
//     NO single "Liabilities" group total, so it must be summed — the old code
//     picked a non-existent key and showed nothing.
function bsLines(groups: Record<string, number>) {
  const pick = (...keys: string[]) => {
    for (const k of keys) if (typeof groups[k] === "number") return groups[k];
    return null;
  };
  const within1yr = pick("CurrentLiabilities", "TotalCurrentLiabilities");
  const after1yr = pick("LongTermLiabilities", "TotalLongTermLiabilities", "LongTermLiability");
  const total_liabilities = (within1yr != null || after1yr != null)
    ? (within1yr || 0) + (after1yr || 0)
    : pick("Liabilities", "TotalLiabilities", "Liability");
  const fixed_assets = pick("FixedAssets", "TotalFixedAssets");
  const other_assets = pick("OtherAssets");
  const current_assets = pick("totCurAsset", "TotalCurrentAssets", "CurrentAssets");
  // Meaningful total assets: UK "TotalAssets" is only NON-current, so sum the
  // parts when we have current assets; otherwise trust a US "TotalAssets".
  const total_assets = current_assets != null
    ? (fixed_assets || 0) + (other_assets || 0) + current_assets
    : pick("TotalAssets", "Asset", "Assets");
  const equity = pick("NetAssets", "Equity", "TotalEquity", "ShareholdersEquity");
  return {
    total_assets,
    fixed_assets,
    other_assets,
    current_assets,
    cash: pick("BankAccounts", "TotalBankAccounts"),
    debtors: pick("AR"),
    // Trade creditors (Accounts Payable group) — the "Creditors" headline tile
    // wants trade payables, NOT the whole current-liabilities group (which also
    // carries VAT/PAYE/etc). Falls back to within-1yr when AP isn't a group.
    accounts_payable: pick("AccountsPayable", "AP"),
    creditors_within_1yr: within1yr,
    creditors_after_1yr: after1yr,
    total_liabilities,
    net_assets: pick("NetAssets"),
    equity,
    current_liabilities: within1yr, // alias kept for the current-ratio
  };
}

// Balance sheet AS AT an explicit date: single-period snapshot (headline +
// expandable detail) PLUS monthly comparatives ending in the as-at month
// (that month / last month / 3 months ago / 12 months ago) and a convenience
// `prev` (the prior-month lines, for month-on-month tile deltas).
async function balanceSheetAsAt(sb: any, realmId: string, asAt: string, withComp: boolean) {
  const base = new Date(`${asAt}T00:00:00`);
  const end = asAt;

  // 1. Single-period report — powers the expandable account detail and the
  //    headline figures, as at `end`. NOTE: QBO's BalanceSheet defaults the
  //    as-of date to TODAY when only end_date is supplied (it returned current
  //    balances for every historic end_date); supplying a start_date makes it
  //    honour end_date. A balance sheet is cumulative, so an early start_date
  //    does not truncate the figures (confirmed against the monthly report).
  const startAsAt = fmt(new Date(base.getFullYear() - 10, 0, 1));
  const resp = await qboFetch(sb, realmId, `reports/BalanceSheet?start_date=${startAsAt}&end_date=${end}&accounting_method=Accrual&minorversion=75`);
  if (!resp.ok) throw new Error(`BalanceSheet ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const report = await resp.json();
  const groups: Record<string, number> = {};
  const walkCur = (rs: any[]) => {
    for (const r of rs || []) {
      if (r.group && r.Summary?.ColData) {
        const v = parseFloat(r.Summary.ColData[r.Summary.ColData.length - 1]?.value || "0");
        if (!isNaN(v)) groups[r.group] = v;
      }
      if (r.Rows?.Row) walkCur(r.Rows.Row);
    }
  };
  walkCur(report?.Rows?.Row || []);
  const lines = bsLines(groups);

  // 2. Monthly comparatives — 13 month-end columns (as-at month + 12 prior).
  let comparatives: any = null;
  let prev: any = null;
  if (withComp) try {
    const startM = fmt(new Date(base.getFullYear(), base.getMonth() - 12, 1));
    const endM = fmt(lastDay(base.getFullYear(), base.getMonth()));
    const mResp = await qboFetch(sb, realmId, `reports/BalanceSheet?start_date=${startM}&end_date=${endM}&summarize_column_by=Month&accounting_method=Accrual&minorversion=75`);
    if (mResp.ok) {
      const mRep = await mResp.json();
      const cols = (mRep?.Columns?.Column || []).map((c: any) => c.ColTitle ?? "");
      // Value columns after the account-name column, excluding a trailing Total.
      const monthIdx: number[] = [];
      const monthLabels: string[] = [];
      cols.forEach((t: string, i: number) => {
        if (i === 0) return;
        if (/^total$/i.test(t)) return;
        monthIdx.push(i); monthLabels.push(t);
      });
      const series: Record<string, (number | null)[]> = {};
      const walkM = (rs: any[]) => {
        for (const r of rs || []) {
          const cd = r.Summary?.ColData;
          if (r.group && cd) {
            series[r.group] = monthIdx.map((ci) => {
              const v = parseFloat(cd[ci]?.value ?? "");
              return isNaN(v) ? null : v;
            });
          }
          if (r.Rows?.Row) walkM(r.Rows.Row);
        }
      };
      walkM(mRep?.Rows?.Row || []);

      const n = monthIdx.length;
      // now = last column; then 1 / 3 / 12 months back by position.
      const offsets = [
        { key: "now", label: "This month", back: 0 },
        { key: "m1", label: "Last month", back: 1 },
        { key: "m3", label: "3 months ago", back: 3 },
        { key: "m12", label: "12 months ago", back: 12 },
      ];
      const columns = offsets
        .map((o) => ({ ...o, idx: n - 1 - o.back }))
        .filter((o) => o.idx >= 0)
        .map((o) => ({ key: o.key, label: o.label, date: monthLabels[o.idx], _idx: o.idx }));

      const groupsAt = (idx: number) => {
        const g: Record<string, number> = {};
        for (const k in series) { const v = series[k][idx]; if (v != null) g[k] = v; }
        return g;
      };
      const perCol = columns.map((c) => ({ col: c, lines: bsLines(groupsAt(c._idx)) }));
      const lineDefs: [string, keyof ReturnType<typeof bsLines>][] = [
        ["Fixed assets", "fixed_assets"],
        ["Current assets", "current_assets"],
        ["Cash at bank", "cash"],
        ["Debtors", "debtors"],
        ["Creditors < 1 year", "creditors_within_1yr"],
        ["Creditors > 1 year", "creditors_after_1yr"],
        ["Total liabilities", "total_liabilities"],
        ["Net assets", "net_assets"],
      ];
      comparatives = {
        columns: columns.map((c) => ({ key: c.key, label: c.label, date: c.date })),
        rows: lineDefs.map(([label, key]) => ({
          label,
          values: perCol.map((pc) => pc.lines[key] ?? null),
        })),
      };
      // Prior-month lines (the "m1" column) — used for the month-on-month
      // deltas on the Overview cash/debtors/creditors tiles.
      prev = (perCol.find((pc) => pc.col.key === "m1") || null)?.lines || null;
    }
  } catch { /* comparatives are best-effort; headline+detail still render */ }

  return {
    period: { start: null, end },
    currency: report?.Header?.Currency || null,
    ...lines,
    comparatives,
    prev,
    groups,
    report,
  };
}
// Back-compat wrapper: the "current state" balance-sheet snapshot (as at today,
// with comparatives) that Home/Portfolio and the default pull rely on.
const pullBalanceSheet = (sb: any, realmId: string) => balanceSheetAsAt(sb, realmId, fmt(new Date()), true);

// Aged receivables / payables summary — rows are customers/suppliers, columns
// are ageing buckets. Parses buckets + per-name balances; keeps the raw report
// too. period_end = today → daily snapshots, month-on-month change in the UI.
function parseAged(report: any) {
  const cols = (report?.Columns?.Column || []).map((c: any) => c.ColTitle ?? "");
  const idx: Record<string, number> = {};
  cols.forEach((t: string, i: number) => {
    if (/^current$/i.test(t)) idx.current = i;
    else if (/^1\s*[-–]\s*30/.test(t)) idx.b1_30 = i;
    else if (/^31\s*[-–]\s*60/.test(t)) idx.b31_60 = i;
    else if (/^61\s*[-–]\s*90/.test(t)) idx.b61_90 = i;
    else if (/91/.test(t)) idx.b91_plus = i;
    else if (/^total$/i.test(t)) idx.total = i;
  });
  const num = (cd: any[], i?: number) => {
    if (i === undefined || !cd?.[i]) return 0;
    const v = parseFloat(cd[i].value || "0");
    return isNaN(v) ? 0 : v;
  };
  const mk = (cd: any[]) => ({
    name: cd?.[0]?.value || "",
    current: num(cd, idx.current),
    b1_30: num(cd, idx.b1_30),
    b31_60: num(cd, idx.b31_60),
    b61_90: num(cd, idx.b61_90),
    b91_plus: num(cd, idx.b91_plus),
    total: num(cd, idx.total),
  });

  const dataRows: any[] = [];
  let totalRow: any[] | null = null;
  const walk = (rs: any[]) => {
    for (const r of rs || []) {
      if (r.Summary?.ColData && (r.group === "GrandTotal" || /^total$/i.test(r.Summary.ColData[0]?.value || ""))) {
        totalRow = r.Summary.ColData;
      } else if (r.ColData && (r.ColData[0]?.value || "").length) {
        dataRows.push(r.ColData);
      }
      if (r.Rows?.Row) walk(r.Rows.Row);
    }
  };
  walk(report?.Rows?.Row || []);

  const rows = dataRows.map(mk).filter((r) => Math.abs(r.total) > 0.004);
  rows.sort((a, b) => Math.abs(b.total) - Math.abs(a.total));
  const sumKey = (k: string) => rows.reduce((s, r) => s + (r as any)[k], 0);
  const buckets = totalRow ? mk(totalRow) : {
    name: "TOTAL",
    current: sumKey("current"), b1_30: sumKey("b1_30"), b31_60: sumKey("b31_60"),
    b61_90: sumKey("b61_90"), b91_plus: sumKey("b91_plus"), total: sumKey("total"),
  };
  return { buckets, rows, top: rows.slice(0, 25) };
}

// Aged report as at a given date → { name: total } over ALL named rows.
async function agedByName(sb: any, realmId: string, endpoint: string, reportDate: string): Promise<Record<string, number>> {
  const resp = await qboFetch(sb, realmId, `reports/${endpoint}?report_date=${reportDate}&minorversion=75`);
  if (!resp.ok) throw new Error(`${endpoint} @${reportDate} ${resp.status}`);
  const parsed = parseAged(await resp.json());
  const map: Record<string, number> = {};
  for (const r of parsed.rows) map[r.name] = r.total;
  return map;
}

async function agedAsAt(sb: any, realmId: string, endpoint: "AgedReceivables" | "AgedPayables", asAt: string) {
  const base = new Date(`${asAt}T00:00:00`);
  const end = asAt;
  const resp = await qboFetch(sb, realmId, `reports/${endpoint}?report_date=${end}&minorversion=75`);
  if (!resp.ok) throw new Error(`${endpoint} ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const report = await resp.json();
  const parsed = parseAged(report);

  // Same-client comparison: take the customers/suppliers on the as-at report
  // and total THEIR balances one and three month-ends earlier. We do NOT
  // introduce names that weren't on the file at the as-at date (Bobby's rule).
  const currentNames = parsed.rows.map((r) => r.name);
  const currentTotal = parsed.rows.reduce((s, r) => s + r.total, 0);
  const m1Date = fmt(monthEndOffset(base, 1));
  const m3Date = fmt(monthEndOffset(base, 3));
  const sameTotal = async (dateStr: string) => {
    try {
      const map = await agedByName(sb, realmId, endpoint, dateStr);
      return currentNames.reduce((s, n) => s + (map[n] || 0), 0);
    } catch { return null; }
  };
  const [m1Total, m3Total] = await Promise.all([sameTotal(m1Date), sameTotal(m3Date)]);

  return {
    period: { start: null, end },
    currency: report?.Header?.Currency || null,
    buckets: parsed.buckets,
    top: parsed.top, // largest balances first, capped at 25 (UI shows top 10)
    same_clients: {
      names: currentNames.length,
      current_total: currentTotal,
      last_month: { date: m1Date, total: m1Total },
      three_months: { date: m3Date, total: m3Total },
    },
    report,
  };
}
// Back-compat wrappers: aged as at today (the default-pull snapshots).
const pullAgedReceivables = (sb: any, realmId: string) => agedAsAt(sb, realmId, "AgedReceivables", fmt(new Date()));
const pullAgedPayables = (sb: any, realmId: string) => agedAsAt(sb, realmId, "AgedPayables", fmt(new Date()));

/* ── Windowed (date-filtered) P&L ─────────────────────────────────── */
// P&L over an explicit [start,end]. When `monthly`, QBO adds one column per
// month plus a trailing Total column: we read the WHOLE-range totals from the
// last (Total) cell of each group's Summary, and the per-month series from the
// month columns. Serves the period tiles (totals), the P&L-by-month table (raw
// report) and the trend chart (months + series). Non-monthly returns totals
// only (used for the prior-period comparison).
async function plReport(sb: any, realmId: string, start: string, end: string, monthly: boolean) {
  const path = `reports/ProfitAndLoss?start_date=${start}&end_date=${end}`
    + (monthly ? `&summarize_column_by=Month` : ``)
    + `&accounting_method=Accrual&minorversion=75`;
  const resp = await qboFetch(sb, realmId, path);
  if (!resp.ok) throw new Error(`P&L ${start}..${end} ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const report = await resp.json();

  const cols = (report?.Columns?.Column || []).map((c: any) => c.ColTitle ?? "");
  const months = monthly ? cols.slice(1).filter((t: string) => !/^total$/i.test(t)) : [];
  const nMonths = months.length;

  const groups: Record<string, number> = {};
  const series: Record<string, number[]> = {};
  const walk = (rs: any[]) => {
    for (const r of rs || []) {
      const cd = r.Summary?.ColData;
      if (r.group && cd) {
        const tv = parseFloat(cd[cd.length - 1]?.value || "0"); // Total column (or the single value col)
        if (!isNaN(tv)) groups[r.group] = tv;
        if (monthly && nMonths) {
          series[r.group] = cd.slice(1, 1 + nMonths).map((c: any) => {
            const v = parseFloat(c?.value ?? ""); return isNaN(v) ? 0 : v;
          });
        }
      }
      if (r.Rows?.Row) walk(r.Rows.Row);
    }
  };
  walk(report?.Rows?.Row || []);

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
    months,
    series: monthly ? {
      income: series.Income || null,
      cogs: series.COGS || null,
      gross_profit: series.GrossProfit || null,
      expenses: series.Expenses || null,
      net_income: series.NetIncome || null,
    } : null,
    report: monthly ? report : null,
  };
}

// P&L account-level detail over [start,end] (single column) — per-account totals
// for the Underlying Performance tab. Returns leaf rows { id, acct_num, name,
// classification, amount } so tagged owner-cost / one-off nominal codes map by
// account id (with an acct_num / name fallback).
async function plAccountDetail(sb: any, realmId: string, start: string, end: string) {
  const resp = await qboFetch(sb, realmId, `reports/ProfitAndLoss?start_date=${start}&end_date=${end}&accounting_method=Accrual&minorversion=75`);
  if (!resp.ok) throw new Error(`P&L detail ${start}..${end} ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const report = await resp.json();

  // Track the enclosing top-level group (Income / COGS / Expenses / …) so each
  // leaf carries whether it is income or a cost.
  const rowsOut: any[] = [];
  const walk = (rs: any[], group: string | null) => {
    for (const r of rs || []) {
      const g = r.group || group;
      if (r.ColData && Array.isArray(r.ColData) && r.type !== "Section") {
        const c0 = r.ColData[0] || {};
        const name = c0.value || "";
        const id = c0.id ? String(c0.id) : null;
        if (name) {
          const v = parseFloat(r.ColData[r.ColData.length - 1]?.value || "0");
          rowsOut.push({ id, name, group: g, amount: isNaN(v) ? 0 : v });
        }
      }
      if (r.Rows?.Row) walk(r.Rows.Row, g);
    }
  };
  walk(report?.Rows?.Row || [], null);

  return {
    period: { start, end },
    currency: report?.Header?.Currency || null,
    net_income: (() => {
      // Net income summary line, if present.
      let ni: number | null = null;
      const w = (rs: any[]) => {
        for (const r of rs || []) {
          if (r.group === "NetIncome" && r.Summary?.ColData) {
            const v = parseFloat(r.Summary.ColData[r.Summary.ColData.length - 1]?.value || "0");
            if (!isNaN(v)) ni = v;
          }
          if (r.Rows?.Row) w(r.Rows.Row);
        }
      };
      w(report?.Rows?.Row || []);
      return ni;
    })(),
    rows: rowsOut,
  };
}

// P&L account-level detail BY MONTH over [start,end] — the single source the
// Overview tab aggregates into months / quarters / years, reported or
// underlying. One QBO report (summarize_column_by=Month) gives both the group
// summaries (income, net income, …) and every leaf account's monthly amounts,
// so owner-cost add-backs can be applied per bucket rather than only over one
// flat range.
//
// Month keys come from the column MetaData (StartDate/EndDate) when QBO sends
// it, and are otherwise derived by walking calendar months from `start` — QBO
// always returns one column per calendar month in the range, so the fallback
// lines up. `month_keys` are YYYY-MM and drive fiscal/calendar bucketing on the
// client; `months` are the QBO column titles, kept for labels.
async function plMonthlyDetail(sb: any, realmId: string, start: string, end: string) {
  const resp = await qboFetch(sb, realmId, `reports/ProfitAndLoss?start_date=${start}&end_date=${end}&summarize_column_by=Month&accounting_method=Accrual&minorversion=75`);
  if (!resp.ok) throw new Error(`P&L monthly detail ${start}..${end} ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const report = await resp.json();

  const allCols: any[] = report?.Columns?.Column || [];
  // Value columns after the account-name column, excluding a trailing Total.
  const monthCols: { idx: number; title: string; key: string | null }[] = [];
  allCols.forEach((c, i) => {
    if (i === 0) return;
    const title = c?.ColTitle ?? "";
    if (/^total$/i.test(title)) return;
    const meta = Array.isArray(c?.MetaData) ? c.MetaData : [];
    const sd = meta.find((m: any) => m?.Name === "StartDate")?.Value || null;
    monthCols.push({ idx: i, title, key: sd ? String(sd).slice(0, 7) : null });
  });

  // Fill any missing keys by walking calendar months from the range start.
  const base = new Date(`${start}T00:00:00`);
  monthCols.forEach((c, n) => {
    if (c.key) return;
    const d = new Date(base.getFullYear(), base.getMonth() + n, 1);
    c.key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  });

  const cellsFrom = (cd: any[]) => monthCols.map((c) => {
    const v = parseFloat(cd?.[c.idx]?.value ?? "");
    return isNaN(v) ? 0 : v;
  });

  const groupSeries: Record<string, number[]> = {};
  const rowsOut: any[] = [];
  const walk = (rs: any[], group: string | null) => {
    for (const r of rs || []) {
      const g = r.group || group;
      if (r.group && r.Summary?.ColData) groupSeries[r.group] = cellsFrom(r.Summary.ColData);
      if (r.ColData && Array.isArray(r.ColData) && r.type !== "Section") {
        const c0 = r.ColData[0] || {};
        const name = c0.value || "";
        const id = c0.id ? String(c0.id) : null;
        if (name) rowsOut.push({ id, name, group: g, amounts: cellsFrom(r.ColData) });
      }
      if (r.Rows?.Row) walk(r.Rows.Row, g);
    }
  };
  walk(report?.Rows?.Row || [], null);

  const s = (k: string) => groupSeries[k] || null;
  return {
    period: { start, end },
    currency: report?.Header?.Currency || null,
    months: monthCols.map((c) => c.title),
    month_keys: monthCols.map((c) => c.key),
    series: {
      income: s("Income"),
      cogs: s("COGS"),
      gross_profit: s("GrossProfit"),
      expenses: s("Expenses"),
      net_operating_income: s("NetOperatingIncome"),
      other_income: s("OtherIncome"),
      other_expenses: s("OtherExpenses"),
      net_income: s("NetIncome"),
    },
    rows: rowsOut,
  };
}

/* ── Monthly actuals for the Projection tab ───────────────────────── */
// Balance sheet BY MONTH over [start,end] — one column per month end, each run
// through bsLines so the actual columns arrive already shaped like the
// dashboard's own balance-sheet categories. balanceSheetAsAt does a fixed
// 13-month comparative for its own tiles; this takes an arbitrary range,
// because a projection's actuals run can be any length.
async function bsMonthlySeries(sb: any, realmId: string, start: string, end: string) {
  const resp = await qboFetch(sb, realmId, `reports/BalanceSheet?start_date=${start}&end_date=${end}&summarize_column_by=Month&accounting_method=Accrual&minorversion=75`);
  if (!resp.ok) throw new Error(`BalanceSheet monthly ${start}..${end} ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const report = await resp.json();

  const allCols: any[] = report?.Columns?.Column || [];
  const cols: { idx: number; title: string; key: string }[] = [];
  const base = new Date(`${start}T00:00:00`);
  allCols.forEach((c, i) => {
    if (i === 0) return;
    const title = c?.ColTitle ?? "";
    if (/^total$/i.test(title)) return;
    const meta = Array.isArray(c?.MetaData) ? c.MetaData : [];
    const ed = meta.find((m: any) => m?.Name === "EndDate")?.Value
      || meta.find((m: any) => m?.Name === "StartDate")?.Value || null;
    const n = cols.length;
    const d = new Date(base.getFullYear(), base.getMonth() + n, 1);
    cols.push({
      idx: i, title,
      key: ed ? String(ed).slice(0, 7) : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`,
    });
  });

  const series: Record<string, (number | null)[]> = {};
  const walk = (rs: any[]) => {
    for (const r of rs || []) {
      const cd = r.Summary?.ColData;
      if (r.group && cd) {
        series[r.group] = cols.map((c) => {
          const v = parseFloat(cd[c.idx]?.value ?? "");
          return isNaN(v) ? null : v;
        });
      }
      if (r.Rows?.Row) walk(r.Rows.Row);
    }
  };
  walk(report?.Rows?.Row || []);

  const groupsAt = (n: number) => {
    const g: Record<string, number> = {};
    for (const k in series) { const v = series[k][n]; if (v != null) g[k] = v; }
    return g;
  };
  const perMonth = cols.map((_, n) => bsLines(groupsAt(n)));
  const lineKeys = ["fixed_assets", "other_assets", "current_assets", "cash", "debtors",
    "accounts_payable", "creditors_within_1yr", "creditors_after_1yr",
    "total_assets", "total_liabilities", "net_assets", "equity", "current_liabilities"] as const;
  const lines: Record<string, (number | null)[]> = {};
  for (const k of lineKeys) lines[k] = perMonth.map((m: any) => m[k] ?? null);

  return {
    period: { start, end },
    currency: report?.Header?.Currency || null,
    months: cols.map((c) => c.title),
    month_keys: cols.map((c) => c.key),
    lines,
    // The raw report as well, so the Balance Sheet tab can render ONE table:
    // the comparative columns and the expandable account tree together. It used
    // to show a summary table and then a second, single-column expandable table
    // underneath — the same figures twice, neither of them the whole picture.
    report,
  };
}

// Cash flow statement BY MONTH. QBO's group keys vary a little by locale and
// report version, so the raw group series come back untouched and the client
// picks the line it wants with a fallback list (see projectionMapping.CF_LINES)
// rather than this function guessing once, server-side, for everyone.
async function cashFlowMonthly(sb: any, realmId: string, start: string, end: string) {
  const resp = await qboFetch(sb, realmId, `reports/CashFlow?start_date=${start}&end_date=${end}&summarize_column_by=Month&minorversion=75`);
  if (!resp.ok) throw new Error(`CashFlow ${start}..${end} ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const report = await resp.json();

  const allCols: any[] = report?.Columns?.Column || [];
  const cols: { idx: number; title: string; key: string }[] = [];
  const base = new Date(`${start}T00:00:00`);
  allCols.forEach((c, i) => {
    if (i === 0) return;
    const title = c?.ColTitle ?? "";
    if (/^total$/i.test(title)) return;
    const meta = Array.isArray(c?.MetaData) ? c.MetaData : [];
    const sd = meta.find((m: any) => m?.Name === "StartDate")?.Value || null;
    const n = cols.length;
    const d = new Date(base.getFullYear(), base.getMonth() + n, 1);
    cols.push({
      idx: i, title,
      key: sd ? String(sd).slice(0, 7) : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`,
    });
  });

  const series: Record<string, number[]> = {};
  const walk = (rs: any[]) => {
    for (const r of rs || []) {
      const cd = r.Summary?.ColData;
      if (r.group && cd) {
        series[r.group] = cols.map((c) => {
          const v = parseFloat(cd[c.idx]?.value ?? "");
          return isNaN(v) ? 0 : v;
        });
      }
      if (r.Rows?.Row) walk(r.Rows.Row);
    }
  };
  walk(report?.Rows?.Row || []);

  return {
    period: { start, end },
    currency: report?.Header?.Currency || null,
    months: cols.map((c) => c.title),
    month_keys: cols.map((c) => c.key),
    series,
  };
}

const METRICS: Record<string, (sb: any, realmId: string) => Promise<any>> = {
  company: pullCompany,
  pl_summary: pullPlSummary,
  pl_fytd: pullPlFytd,
  pl_fytd_prior: pullPlFytdPrior,
  balances: pullBalances,
  accounts: pullAccounts,
  file_health: pullFileHealth,
  // Dashboard v2
  pnl_monthly: pullPnlMonthly,
  balance_sheet: pullBalanceSheet,
  aged_receivables: pullAgedReceivables,
  aged_payables: pullAgedPayables,
};

/* ── Handler ──────────────────────────────────────────────────────── */

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return jr({ success: false, error: "POST required" }, 405);

  try {
    // 1. Auth — active staff with can_view_reports, or a service-role caller.
    let caller: Caller;
    try { caller = await requireStaffOrService(req, "can_view_reports"); }
    catch (e) { return authErrorResponse(e, cors); }

    const sb = svc();
    // Only a staff caller can hold the practice-financials flag; a service
    // caller has no profile and therefore never clears the guard below.
    const { data: profile } = caller.kind === "staff"
      ? await sb.from("staff_profiles").select("can_view_practice_financials").eq("id", caller.userId).single()
      : { data: null };

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

    // 3. Cache read — snapshots accumulate per (realm, metric, period_end),
    // so take the LATEST row per metric for freshness checks / fallbacks.
    const { data: cacheRows } = await sb.from("qbo_dashboard_cache").select("*")
      .eq("realm_id", realmId).order("pulled_at", { ascending: false });
    const cacheByKey: Record<string, any> = {};
    for (const row of cacheRows || []) if (!cacheByKey[row.metric_key]) cacheByKey[row.metric_key] = row;

    const cutoff = Date.now() - maxAgeMin * 60 * 1000;
    const isFresh = (row: any) => row && new Date(row.pulled_at).getTime() >= cutoff;

    // 3b. Windowed (date-filtered) mode — the Client Dashboard sends a `window`
    // describing the selected period (Overview/P&L) and/or as-at date (Balance
    // Sheet / Debtors & Creditors). Results come back under stable base keys;
    // cache rows are keyed by the actual date range so re-selecting a preset
    // reuses them, while custom ranges pull live and are never stored. These
    // keys never collide with the Home/Portfolio metric keys above.
    const win = body.window;
    if (win) {
      const store = win.kind !== "custom";
      const out: Record<string, any> = {};
      const werr: Record<string, string> = {};

      const windowMetric = async (
        storeKey: string, periodStart: string | null, periodEnd: string | null,
        baseName: string, fn: () => Promise<any>,
      ) => {
        const cached = cacheByKey[storeKey];
        if (!refresh && isFresh(cached)) { out[baseName] = cached.data; return; }
        try {
          const data = await fn();
          out[baseName] = data;
          if (store) {
            const row = {
              realm_id: realmId, metric_key: storeKey,
              period_start: periodStart, period_end: periodEnd || fmt(new Date()),
              data, pulled_at: new Date().toISOString(),
            };
            const { error: upErr } = await sb.from("qbo_dashboard_cache")
              .upsert(row, { onConflict: "realm_id,metric_key,period_end" });
            if (upErr) {
              await sb.from("qbo_dashboard_cache").delete()
                .eq("realm_id", realmId).eq("metric_key", storeKey).eq("period_end", row.period_end);
              await sb.from("qbo_dashboard_cache").insert(row);
            }
          }
        } catch (e) {
          werr[baseName] = (e as Error).message;
          if (cached) out[baseName] = cached.data; // fall back to stale cache
        }
      };

      if (win.period) {
        const p = win.period;
        await windowMetric(`pl_range#${p.plStart}_${p.plEnd}`, p.plStart, p.plEnd, "pl_range",
          () => plReport(sb, realmId, p.plStart, p.plEnd, true));
        await windowMetric(`pl_prior#${p.priorStart}_${p.priorEnd}`, p.priorStart, p.priorEnd, "pl_range_prior",
          () => plReport(sb, realmId, p.priorStart, p.priorEnd, false));
        // Chart window. `chartDetail` (the Overview's grain / basis / underlying
        // controls) needs per-account monthly amounts, not just group series, so
        // it takes the account-level monthly report INSTEAD of the plain one —
        // same single QBO call, strictly more data. Callers that don't ask for
        // detail keep the old behaviour: 12 months ending at the period-end
        // month, reusing pl_range when the windows coincide.
        if (p.chartDetail) {
          await windowMetric(`pnl_chart_detail#${p.chartStart}_${p.chartEnd}`, p.chartStart, p.chartEnd, "pnl_chart_detail",
            () => plMonthlyDetail(sb, realmId, p.chartStart, p.chartEnd));
        } else if (p.chartStart === p.plStart && p.chartEnd === p.plEnd && out.pl_range) {
          out.pnl_chart = out.pl_range;
        } else {
          await windowMetric(`pnl_chart#${p.chartStart}_${p.chartEnd}`, p.chartStart, p.chartEnd, "pnl_chart",
            () => plReport(sb, realmId, p.chartStart, p.chartEnd, true));
        }
        // Balance figures for the Overview tiles. `bsAsAt` is the end of the
        // Overview's latest complete bucket, which is NOT always the period end
        // — a quarter grain snaps back to the last closed quarter — and the
        // tiles have to describe the same moment as the P&L beside them.
        // Shares a cache key with the Balance-Sheet-tab as-at pull (same date ⇒
        // one row).
        const bsDate = String(p.bsAsAt || p.plEnd);
        await windowMetric(`bs_asat#${bsDate}`, null, bsDate, "bs_period",
          () => balanceSheetAsAt(sb, realmId, bsDate, true));
        // Account-level P&L detail for the Underlying Performance tab (owner-cost
        // add-backs matched by account id over the selected range) — current and
        // prior period, so the underlying tiles can show a vs-prior delta.
        await windowMetric(`pl_detail#${p.plStart}_${p.plEnd}`, p.plStart, p.plEnd, "pl_detail",
          () => plAccountDetail(sb, realmId, p.plStart, p.plEnd));
        await windowMetric(`pl_detail#${p.priorStart}_${p.priorEnd}`, p.priorStart, p.priorEnd, "pl_detail_prior",
          () => plAccountDetail(sb, realmId, p.priorStart, p.priorEnd));
      }

      // Projection actuals — the three statements by month over the actuals
      // run, so the Projection tab can put actual and forecast columns on the
      // same rows. Separate from `period` because the projection's timeline is
      // the scenario's, not the rail's date filter.
      if (win.projection) {
        const pr = win.projection;
        const ps = String(pr.start);
        const pe = String(pr.end);
        await windowMetric(`pnl_chart_detail#${ps}_${pe}`, ps, pe, "proj_pl",
          () => plMonthlyDetail(sb, realmId, ps, pe));
        await windowMetric(`bs_monthly#${ps}_${pe}`, ps, pe, "proj_bs",
          () => bsMonthlySeries(sb, realmId, ps, pe));
        await windowMetric(`cf_monthly#${ps}_${pe}`, ps, pe, "proj_cf",
          () => cashFlowMonthly(sb, realmId, ps, pe));
      }

      if (win.asat) {
        const d = String(win.asat.date);
        await windowMetric(`bs_asat#${d}`, null, d, "bs_asat",
          () => balanceSheetAsAt(sb, realmId, d, true));
        // Comparative grid for the Balance Sheet tab: a monthly balance sheet
        // across whatever window the grain/basis toggles ask for, carrying its
        // report tree so the columns and the expandable detail are one table.
        if (win.asat.gridStart) {
          const gs = String(win.asat.gridStart);
          await windowMetric(`bs_monthly#${gs}_${d}`, gs, d, "bs_grid",
            () => bsMonthlySeries(sb, realmId, gs, d));
        }
        await windowMetric(`ar_asat#${d}`, null, d, "ar_asat",
          () => agedAsAt(sb, realmId, "AgedReceivables", d));
        await windowMetric(`ap_asat#${d}`, null, d, "ap_asat",
          () => agedAsAt(sb, realmId, "AgedPayables", d));
      }

      return jr({
        success: Object.keys(werr).length === 0,
        realmId,
        metrics: out,
        errors: Object.keys(werr).length ? werr : undefined,
        pulled_at: new Date().toISOString(),
      });
    }

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
        // Snapshot upsert — one row per (realm, metric, period_end). Old
        // snapshots are KEPT so the UI can compare month-on-month (aged debt,
        // balances). period_end always non-null (falls back to the pull date
        // for point-in-time metrics) so the unique index (sql/131) is hit.
        const periodEnd = data?.period?.end || fmt(new Date());
        const row = {
          realm_id: realmId, metric_key: key,
          period_start: data?.period?.start || null,
          period_end: periodEnd,
          data, pulled_at: new Date().toISOString(),
        };
        const { error: upErr } = await sb.from("qbo_dashboard_cache")
          .upsert(row, { onConflict: "realm_id,metric_key,period_end" });
        if (upErr) {
          // Unique index not applied yet (pre-sql/131) → emulate the upsert.
          await sb.from("qbo_dashboard_cache").delete()
            .eq("realm_id", realmId).eq("metric_key", key).eq("period_end", periodEnd);
          await sb.from("qbo_dashboard_cache").insert(row);
        }
        // Tidy legacy rows written before period_end was mandatory.
        await sb.from("qbo_dashboard_cache").delete()
          .eq("realm_id", realmId).eq("metric_key", key).is("period_end", null);
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
