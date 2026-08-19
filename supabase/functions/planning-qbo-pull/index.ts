// v11 (2026-08-07): adds granularity "balance_sheet" — mirrors QBO's
// Balance Sheet report into plan_bs_cache, one row per leaf account per
// snapshot date, section = nearest report group (BankAccounts, AR,
// OtherCurrentLiabilities, …). Feeds the Planning module's Cash & Owner
// page (cash position, VAT/CT provisions to the report date).
// v10 (2026-08-07). History: the repo copy had fallen behind the
// deployment — deployed v9 gained monthly granularity ({ granularity:
// "monthly", months_back }) writing one row per (month, account) to
// plan_qbo_pl_cache, plus structured error responses, none of which the
// repo had. Repo was synced from v9 on 2026-08-06; v10 then made the
// delete-then-insert cache writes CHECKED — previously a failed insert
// after a successful delete silently emptied the cache for the period
// and the caller was told success. Diff against the deployment before
// any future edit + deploy.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireStaffOrService, authErrorResponse } from "../_shared/require-staff.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const QBO_CLIENT_ID = Deno.env.get("QBO_CLIENT_ID")!;
const QBO_CLIENT_SECRET = Deno.env.get("QBO_CLIENT_SECRET")!;
const QBO_API_BASE = Deno.env.get("QBO_API_BASE") || "https://quickbooks.api.intuit.com";
const QBO_TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";

function sb() { return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY); }

async function refreshToken(client, conn) {
  const basicAuth = btoa(`${QBO_CLIENT_ID}:${QBO_CLIENT_SECRET}`);
  const resp = await fetch(QBO_TOKEN_URL, {
    method: "POST",
    headers: { "Authorization": `Basic ${basicAuth}`, "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: conn.refresh_token }),
  });
  if (!resp.ok) {
    const err = await resp.text();
    await client.from("qbo_connections").update({ status: "error", error_message: `Token refresh failed: ${resp.status} ${err}`, updated_at: new Date().toISOString() }).eq("id", conn.id);
    throw new Error(`QBO token refresh failed: ${resp.status} ${err}`);
  }
  const tokens = await resp.json();
  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);
  await client.from("qbo_connections").update({
    access_token: tokens.access_token, refresh_token: tokens.refresh_token,
    token_expires_at: expiresAt.toISOString(), last_refreshed_at: new Date().toISOString(),
    status: "active", error_message: null, updated_at: new Date().toISOString(),
  }).eq("id", conn.id);
  return tokens;
}

async function getValidToken() {
  const client = sb();
  const { data: conn, error } = await client.from("qbo_connections").select("*").eq("status", "active").single();
  if (error || !conn) throw new Error("No active QBO connection");
  const expiresAt = new Date(conn.token_expires_at);
  if (expiresAt.getTime() - Date.now() < 10 * 60 * 1000) {
    const t = await refreshToken(client, conn);
    return { accessToken: t.access_token, realmId: conn.realm_id };
  }
  return { accessToken: conn.access_token, realmId: conn.realm_id };
}

async function qboFetch(path) {
  const { accessToken, realmId } = await getValidToken();
  const url = `${QBO_API_BASE}/v3/company/${realmId}/${path}`;
  let resp = await fetch(url, { headers: { "Authorization": `Bearer ${accessToken}`, "Accept": "application/json" } });
  if (resp.status === 401) {
    const client = sb();
    const { data: conn } = await client.from("qbo_connections").select("*").eq("status", "active").single();
    if (conn) {
      await refreshToken(client, conn);
      const { accessToken: newTok } = await getValidToken();
      resp = await fetch(url, { headers: { "Authorization": `Bearer ${newTok}`, "Accept": "application/json" } });
    }
  }
  return resp;
}

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function jr(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...cors } });
}

function fmt(d) { return d.toISOString().slice(0, 10); }
function addMonths(d, n) { const x = new Date(d); x.setMonth(x.getMonth() + n); return x; }
function lastDay(y, m) { return new Date(y, m + 1, 0); }

function flattenRows(rows, headers, out, section) {
  if (!rows) return;
  for (const r of rows) {
    if (r.ColData && Array.isArray(r.ColData) && r.type !== "Section") {
      const name = (r.ColData[0]?.value || "").trim();
      if (!name) continue;
      const values = [];
      for (let i = 1; i < Math.min(r.ColData.length, headers.length); i++) {
        const v = parseFloat(r.ColData[i]?.value || "0");
        values.push(isNaN(v) ? 0 : v);
      }
      out.push({ name, values, section });
    }
    if (r.Rows?.Row) flattenRows(r.Rows.Row, headers, out, r.group || section);
  }
}

function findSection(rows, groupName) {
  if (!rows) return null;
  for (const r of rows) {
    if (r.group === groupName) return r;
    const inner = findSection(r.Rows?.Row, groupName);
    if (inner) return inner;
  }
  return null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return jr({ success: false, error: "POST required" }, 405);

  // Default granularity returns the practice's entire P&L, so this carries the same
  // flag dashboard-qbo-pull already requires for practice books. The service role
  // passes, for the planning-qbo-nightly-pull cron.
  try { await requireStaffOrService(req, "can_view_practice_financials"); }
  catch (err) { return authErrorResponse(err, cors); }

  const body = await req.json().catch(() => ({}));
  const granularity = body.granularity || "ltm";
  const monthsBack = Number(body.months_back || 12);

  try {
    const now = new Date();
    const endMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const startMonthStart = new Date(endMonthStart.getFullYear(), endMonthStart.getMonth() - (monthsBack - 1), 1);
    const endDate = lastDay(endMonthStart.getFullYear(), endMonthStart.getMonth());
    const start = fmt(startMonthStart);
    const end = fmt(endDate);

    if (granularity === "balance_sheet") {
      const asOf = fmt(new Date());
      const resp = await qboFetch(`reports/BalanceSheet?end_date=${asOf}&accounting_method=Accrual`);
      if (!resp.ok) {
        const text = await resp.text();
        let friendly = `QBO returned ${resp.status}`;
        if (text.includes("UNAUTHORIZED_UNSUPPORTED_TOKEN_ALGORITHM")) friendly = "QBO rejected the access token — reconnect QuickBooks.";
        return jr({ success: false, error: friendly, raw: text.slice(0, 600), status: resp.status });
      }
      const report = await resp.json();
      const cols = report.Columns?.Column || [];
      const headers = cols.map((c) => c.ColTitle || c.ColType);
      const rows = report.Rows?.Row || [];
      // Walk the whole tree; every leaf carries its nearest group so the
      // client can classify (BankAccounts → cash, /vat/i → VAT, …).
      // Section-total rows are excluded by flattenRows, so no double count.
      const flat = [];
      flattenRows(rows, headers, flat, "root");

      const client = sb();
      const del = await client.from("plan_bs_cache").delete().eq("snapshot_date", asOf);
      if (del.error) return jr({ success: false, error: `bs cache clear failed: ${del.error.message}` });
      const inserts = flat
        .map((r) => ({ snapshot_date: asOf, account_name: r.name, section: r.section, amount: r.values[r.values.length - 1] ?? 0 }))
        .filter((r) => r.amount !== 0);
      if (inserts.length) {
        const ins = await client.from("plan_bs_cache").insert(inserts);
        if (ins.error) return jr({ success: false, error: `bs cache write failed AFTER clearing ${asOf} — snapshot is empty until a successful re-run: ${ins.error.message}` });
      }
      return jr({ success: true, granularity: "balance_sheet", snapshot_date: asOf, accounts: inserts.length });
    }

    if (granularity === "monthly") {
      const path = `reports/ProfitAndLoss?start_date=${start}&end_date=${end}&accounting_method=Accrual&summarize_column_by=Month`;
      const resp = await qboFetch(path);
      if (!resp.ok) {
        const text = await resp.text();
        let friendly = `QBO returned ${resp.status}`;
        if (text.includes("UNAUTHORIZED_UNSUPPORTED_TOKEN_ALGORITHM")) friendly = "QBO rejected the access token — reconnect QuickBooks.";
        return jr({ success: false, error: friendly, raw: text.slice(0, 600), status: resp.status });
      }
      const report = await resp.json();
      const cols = report.Columns?.Column || [];
      const headers = cols.map((c) => c.ColTitle || c.ColType);
      const rows = report.Rows?.Row || [];

      const sections = ["Income", "Expenses", "COGS", "OtherExpenses"];
      const flat = [];
      for (const sec of sections) {
        const node = findSection(rows, sec);
        if (node?.Rows?.Row) flattenRows(node.Rows.Row, headers, flat, sec);
      }

      const monthCount = headers.length - 2;
      const client = sb();
      const del = await client.from("plan_qbo_pl_cache").delete().gte("period_start", start).lte("period_end", end);
      if (del.error) return jr({ success: false, error: `cache clear failed: ${del.error.message}` });

      const inserts = [];
      const monthsList = [];
      for (let i = 0; i < monthCount; i++) {
        const mStart = addMonths(startMonthStart, i);
        const mEnd = lastDay(mStart.getFullYear(), mStart.getMonth());
        monthsList.push({ start: fmt(mStart), end: fmt(mEnd) });
      }

      for (const r of flat) {
        for (let i = 0; i < Math.min(r.values.length, monthCount); i++) {
          if (r.values[i] === 0) continue;
          inserts.push({
            period_start: monthsList[i].start,
            period_end: monthsList[i].end,
            account_name: r.name,
            account_type: r.section,
            amount: r.values[i],
          });
        }
      }
      if (inserts.length) {
        const ins = await client.from("plan_qbo_pl_cache").insert(inserts);
        if (ins.error) {
          // The delete above already succeeded, so the cache for this
          // period is now EMPTY — say so loudly rather than reporting
          // success over a hollowed-out cache.
          return jr({ success: false, error: `cache write failed AFTER clearing ${start}..${end} — cache is empty until a successful re-run: ${ins.error.message}` });
        }
      }

      return jr({
        success: true, granularity: "monthly",
        period: { start, end }, months: monthsList.length,
        accounts: flat.length, cells_written: inserts.length,
      });
    }

    const path = `reports/ProfitAndLoss?start_date=${start}&end_date=${end}&accounting_method=Accrual`;
    const resp = await qboFetch(path);
    if (!resp.ok) {
      const text = await resp.text();
      let friendly = `QBO returned ${resp.status}`;
      if (text.includes("UNAUTHORIZED_UNSUPPORTED_TOKEN_ALGORITHM")) friendly = "QBO rejected the access token — reconnect QuickBooks.";
      return jr({ success: false, error: friendly, raw: text.slice(0, 600), status: resp.status });
    }
    const report = await resp.json();
    const cols = report.Columns?.Column || [];
    const headers = cols.map((c) => c.ColTitle || c.ColType);
    const rows = report.Rows?.Row || [];
    const sections = ["Expenses", "COGS", "OtherExpenses", "Income"];
    const flat = [];
    for (const sec of sections) {
      const node = findSection(rows, sec);
      if (node?.Rows?.Row) flattenRows(node.Rows.Row, headers, flat, sec);
    }

    const expenses = flat.filter((r) => r.section !== "Income").map((r) => ({ name: r.name, amount: r.values.reduce((a, b) => a + b, 0), section: r.section }));
    const income = flat.filter((r) => r.section === "Income").map((r) => ({ name: r.name, amount: r.values.reduce((a, b) => a + b, 0) }));

    const client = sb();
    const del = await client.from("plan_qbo_pl_cache").delete().eq("period_start", start).eq("period_end", end);
    if (del.error) return jr({ success: false, error: `cache clear failed: ${del.error.message}` });
    const toInsert = [
      ...expenses.map((e) => ({ period_start: start, period_end: end, account_name: e.name, account_type: e.section, amount: e.amount })),
      ...income.map((i) => ({ period_start: start, period_end: end, account_name: i.name, account_type: "Income", amount: i.amount })),
    ];
    if (toInsert.length) {
      const ins = await client.from("plan_qbo_pl_cache").insert(toInsert);
      if (ins.error) {
        return jr({ success: false, error: `cache write failed AFTER clearing ${start}..${end} — cache is empty until a successful re-run: ${ins.error.message}` });
      }
    }

    return jr({
      success: true, granularity: "ltm", period: { start, end },
      expenses, income,
      total_expenses: expenses.reduce((s, e) => s + e.amount, 0),
      total_income: income.reduce((s, i) => s + i.amount, 0),
    });
  } catch (err) {
    return jr({ success: false, error: err.message });
  }
});
