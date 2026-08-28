// qbo-drift-sweep
// Measures how far forward each client's books actually reach.
//
// The problem this works around: QuickBooks can only tell you what HAS been
// posted. What matters is invisible by construction — the receipts nobody
// entered, the month nobody reconciled. So rather than looking for what's
// missing, this measures FRONTIERS (how far forward the file is complete to)
// and leaves the comparison against expectation to the scoring view.
//
// Four frontiers, per client:
//   posted_to      max TxnDate                      — how far the data reaches
//   reconciled_to  max TxnDate of a Reconciled item,
//                  taken as the MINIMUM across bank accounts
//                                                   — the hard one
//   touched_at     max MetaData.LastUpdatedTime     — has anyone opened it
//   (signed_off_to comes from the work schedule, not from QuickBooks)
//
// reconciled_to is a minimum on purpose. A file is only reconciled as far as
// its laggiest account, and a single dead card feed hides behind three healthy
// ones. Same for posted_to, which is why bank_accounts carries per-account
// dates rather than one number for the file.
//
// Plus the soft signals, which are the only way to infer the unseen: volume
// against the client's own 13-month baseline (a big shortfall means somebody
// stopped entering things), the longest zero-transaction run against that
// file's normal gap (a broken feed), and hygiene balances read as a trend
// rather than a level.
//
// LIMIT, stated plainly: the bank-feed "For Review" queue is not exposed by the
// QuickBooks API at all. Transactions sitting there unadded cannot be counted
// here by any means. The volume and gap proxies exist precisely because of that
// blind spot, and the UI says so.
//
// A realm that errors is written as status='error'. It must never read as
// green — a silently expired token showing healthy is the failure mode that
// kills this kind of tool.
//
// Modes:
//   probe — one realm, computed and returned, nothing persisted.
//   sweep — a slice of realms, persisted to bk_drift_snapshots. Chunked in the
//           shape of qbo-journal-recon: Intuit throttles per realm and edge
//           functions time out.
//
// Auth: verify_jwt=true at the gateway. Inside, either a service-role JWT (how
// the cron calls it) or a staff user with can_view_reports.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { failureUpdate, refreshWithRetry } from "../_shared/oauth-refresh.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const QBO_CLIENT_ID = Deno.env.get("QBO_CLIENT_ID")!;
const QBO_CLIENT_SECRET = Deno.env.get("QBO_CLIENT_SECRET")!;
const QBO_API_BASE = Deno.env.get("QBO_API_BASE") || "https://quickbooks.api.intuit.com";
const QBO_TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
function jr(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...cors } });
}
function svc() { return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY); }

function roleFromJwt(bearer: string): string | null {
  try {
    const payload = bearer.split(".")[1];
    if (!payload) return null;
    const pad = payload.replace(/-/g, "+").replace(/_/g, "/");
    const json = JSON.parse(atob(pad + "=".repeat((4 - pad.length % 4) % 4)));
    return json?.role ?? null;
  } catch { return null; }
}

/* ── Dates ────────────────────────────────────────────────────────── */

const fmt = (d: Date) => d.toISOString().slice(0, 10);
const daysAgo = (n: number) => { const d = new Date(); d.setDate(d.getDate() - n); return d; };
const dayDiff = (a: string, b: string) =>
  Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86400000);

/* ── Token resolution + QBO fetch (per realm) ─────────────────────── */
// Same shape as qbo-journal-recon. Report tokens first — that's where the
// client-authorised estate lives; fall back to the practice's own connection.

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
  const refreshExpiresAt = tokens.x_refresh_token_expires_in
    ? new Date(Date.now() + tokens.x_refresh_token_expires_in * 1000) : null;
  await sb.from(src.table).update({
    access_token: tokens.access_token, refresh_token: tokens.refresh_token,
    token_expires_at: expiresAt.toISOString(),
    refresh_token_expires_at: refreshExpiresAt?.toISOString() || src.conn.refresh_token_expires_at,
    last_refreshed_at: new Date().toISOString(), status: "active", error_message: null,
    updated_at: new Date().toISOString(),
  }).eq(src.keyCol, keyVal);
  return tokens.access_token as string;
}

async function tokenFor(sb: any, realmId: string): Promise<string> {
  const src = await resolveSource(sb, realmId);
  const expiresAt = new Date(src.conn.token_expires_at);
  if (expiresAt.getTime() - Date.now() < 5 * 60 * 1000) return await refreshToken(sb, src);
  return src.conn.access_token;
}

let apiCalls = 0;
async function qboFetch(sb: any, realmId: string, path: string): Promise<Response> {
  apiCalls++;
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

async function qboQuery(sb: any, realmId: string, query: string) {
  const resp = await qboFetch(sb, realmId, `query?query=${encodeURIComponent(query)}&minorversion=75`);
  if (!resp.ok) throw new Error(`QBO query ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  return await resp.json();
}

/* ── TransactionList parsing ──────────────────────────────────────── */
// The report's column set varies by company (and by filter), so every index is
// resolved by title rather than assumed. The existing dashboard pull learned
// this the hard way; same defensive read here.

type TxnRow = { date: string; account: string; amount: number };

function parseTransactionList(report: any): { rows: TxnRow[]; columns: string[] } {
  const cols = report?.Columns?.Column || [];
  const columns = cols.map((c: any) => c.ColTitle || c.ColType || "");
  const idxOf = (re: RegExp, colType?: string) => {
    let i = cols.findIndex((c: any) => re.test(c.ColTitle || ""));
    if (i < 0 && colType) i = cols.findIndex((c: any) => c.ColType === colType);
    return i;
  };
  const dateIdx = Math.max(0, idxOf(/date/i, "tx_date"));
  const acctIdx = idxOf(/account/i, "account_name");
  let amtIdx = idxOf(/amount/i, "Money");
  if (amtIdx < 0) amtIdx = cols.length - 1;

  const rows: TxnRow[] = [];
  const walk = (rs: any[]) => {
    for (const r of rs || []) {
      if (r.ColData && Array.isArray(r.ColData) && r.type !== "Section") {
        const date = r.ColData[dateIdx]?.value || "";
        if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
          const amt = parseFloat(r.ColData[amtIdx]?.value || "0");
          rows.push({
            date,
            account: acctIdx >= 0 ? (r.ColData[acctIdx]?.value || "") : "",
            amount: isNaN(amt) ? 0 : amt,
          });
        }
      }
      if (r.Rows?.Row) walk(r.Rows.Row);
    }
  };
  walk(report?.Rows?.Row);
  return { rows, columns };
}

async function transactionList(
  sb: any, realmId: string, start: string, end: string,
  opts: { cleared?: string; accountIds?: string[] } = {},
): Promise<{ rows: TxnRow[]; columns: string[] }> {
  let path = `reports/TransactionList?start_date=${start}&end_date=${end}&minorversion=75`;
  if (opts.cleared) path += `&cleared=${opts.cleared}`;
  if (opts.accountIds?.length) path += `&account=${opts.accountIds.join(",")}`;
  const resp = await qboFetch(sb, realmId, path);
  if (!resp.ok) throw new Error(`TransactionList ${resp.status}: ${(await resp.text()).slice(0, 160)}`);
  return parseTransactionList(await resp.json());
}

/* ── The measurement ──────────────────────────────────────────────── */

const CDC_ENTITIES = "Purchase,Deposit,Invoice,Bill,JournalEntry,Payment,SalesReceipt,Transfer,BillPayment";

// Longest run of consecutive days with no bank transaction, inside the window.
// A broken feed on one account shows up here long before anyone notices the
// balance is wrong.
function longestGapDays(dates: string[], windowStart: string, windowEnd: string): number {
  if (!dates.length) return dayDiff(windowStart, windowEnd);
  const sorted = [...new Set(dates)].sort();
  let worst = Math.max(dayDiff(windowStart, sorted[0]), dayDiff(sorted[sorted.length - 1], windowEnd));
  for (let i = 1; i < sorted.length; i++) {
    const g = dayDiff(sorted[i - 1], sorted[i]);
    if (g > worst) worst = g;
  }
  return worst;
}

function median(nums: number[]): number {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// The 13-month baseline: what "normal" looks like for THIS client. Recomputed
// monthly, not nightly — it's the one heavy call in the sweep.
async function computeBaseline(sb: any, realmId: string, bankIds: string[]) {
  const end = fmt(new Date());
  const start = fmt(daysAgo(400));
  const { rows } = await transactionList(sb, realmId, start, end, { accountIds: bankIds });

  const byMonth: Record<string, number> = {};
  for (const r of rows) {
    const m = r.date.slice(0, 7);
    byMonth[m] = (byMonth[m] || 0) + 1;
  }
  // Exclude the current (incomplete) month from the median — including it drags
  // the baseline down every time the sweep runs early in a month.
  const thisMonth = end.slice(0, 7);
  const complete = Object.entries(byMonth).filter(([m]) => m !== thisMonth);
  const counts = complete.map(([, n]) => n);

  // Counterparties seen in most of the last 6 months. Their absence this month
  // is the closest thing to seeing an unposted transaction.
  const recentMonths = new Set(
    Array.from({ length: 6 }, (_, i) => {
      const d = new Date(); d.setMonth(d.getMonth() - (i + 1)); return d.toISOString().slice(0, 7);
    }),
  );
  const vendorMonths: Record<string, Set<string>> = {};
  for (const r of rows) {
    const m = r.date.slice(0, 7);
    if (!recentMonths.has(m) || !r.account) continue;
    (vendorMonths[r.account] ||= new Set()).add(m);
  }
  const recurring = Object.entries(vendorMonths)
    .filter(([, ms]) => ms.size >= 5)
    .map(([name]) => name);

  return {
    months: byMonth,
    median_monthly: median(counts),
    months_observed: counts.length,
    normal_gap_days: longestGapDays(
      rows.filter((r) => r.date < `${thisMonth}-01`).map((r) => r.date),
      start, `${thisMonth}-01`,
    ),
    recurring_accounts: recurring,
  };
}

async function measureRealm(sb: any, realmId: string, opts: { baseline?: any; accounts?: any[] } = {}) {
  const today = fmt(new Date());
  const notes: string[] = [];

  /* 1 — accounts: hygiene balances and the bank/CC list. Passed in by the
        caller, which needed the bank list to build the baseline — pulling the
        chart of accounts twice per realm is 130 wasted calls a night. */
  const accounts: any[] = opts.accounts
    || (await qboQuery(sb, realmId, "SELECT * FROM Account MAXRESULTS 1000"))?.QueryResponse?.Account
    || [];

  const bal = (a: any) => Number(a.CurrentBalance || 0);
  const sum = (arr: any[]) => arr.reduce((s, a) => s + bal(a), 0);
  const byName = (re: RegExp) => accounts.filter((a) => re.test(a.Name || ""));

  const bankAccounts = accounts.filter(
    (a) => (a.AccountType === "Bank" || a.AccountType === "Credit Card") && a.Active !== false,
  );
  const bankIds = bankAccounts.map((a) => String(a.Id));

  // TransactionList labels accounts with the nominal code in front ("1201 Acc
  // to use RBS current") while Account.Name has no code. Matching the two
  // literally fails on every coded account — which silently pinned the
  // reconciliation frontier to null for almost every client, i.e. rendered the
  // whole estate maximally red. Strip a leading code before comparing.
  const normAcct = (s: string) => (s || "").replace(/^\d+[\s\-:.]+/, "").trim().toLowerCase();
  const acctByNorm: Record<string, any> = {};
  for (const a of bankAccounts) acctByNorm[normAcct(a.Name)] = a;
  const resolveAcct = (label: string) => acctByNorm[normAcct(label)] || null;

  const hygiene = {
    uncategorised_asset: Math.abs(sum(accounts.filter(
      (a) => /uncategori[sz]ed/i.test(a.Name || "") && a.Classification === "Asset"))),
    undeposited_funds: sum(accounts.filter((a) => a.AccountSubType === "UndepositedFunds")),
    opening_balance_equity: sum(accounts.filter(
      (a) => a.AccountSubType === "OpeningBalanceEquity" || /opening balance equity/i.test(a.Name || ""))),
    ask_my_accountant: sum(byName(/ask my accountant/i)),
    reconciliation_discrepancies: sum(byName(/reconciliation discrepanc/i)),
    bank_account_count: bankAccounts.length,
  };

  /* 2 — recent activity: 120 days is enough to date the frontier and to see
        the current month's volume, without dragging a year of rows over. */
  const recentStart = fmt(daysAgo(120));
  const { rows: recent } = await transactionList(sb, realmId, recentStart, today, { accountIds: bankIds });

  const lastById: Record<string, string> = {};
  for (const r of recent) {
    const a = resolveAcct(r.account);
    if (!a) continue;
    const id = String(a.Id);
    if (!lastById[id] || r.date > lastById[id]) lastById[id] = r.date;
  }

  // Which accounts the frontier is allowed to depend on.
  //
  // "Live" (recent movement, or a balance to be wrong about) is too broad: a
  // dormant Petty Cash that nobody has ever reconciled would pin every file's
  // frontier to null, and nothing would ever be green. "Active" — moved in the
  // last 90 days — is the set that genuinely has to be kept reconciled.
  //
  // A dormant account that has never been reconciled is still worth saying out
  // loud, but it's a structural finding ("Petty Cash has never been
  // reconciled"), not evidence that this quarter's books are behind. Those are
  // different jobs and they get reported separately.
  const isLive = (a: any) => !!lastById[String(a.Id)] || Math.abs(Number(a.CurrentBalance || 0)) > 0.005;
  const isActive = (a: any) => {
    const d = lastById[String(a.Id)];
    return !!d && dayDiff(d, today) <= 90;
  };
  const liveBank = bankAccounts.filter(isLive);
  const activeBank = bankAccounts.filter(isActive);
  const postedTo = recent.length ? recent.reduce((m, r) => (r.date > m ? r.date : m), recent[0].date) : null;

  const thisMonth = today.slice(0, 7);
  const txnThisMonth = recent.filter((r) => r.date.slice(0, 7) === thisMonth).length;
  const txn30 = recent.filter((r) => r.date >= fmt(daysAgo(30))).length;
  const txn90 = recent.filter((r) => r.date >= fmt(daysAgo(90))).length;
  const gap90 = longestGapDays(
    recent.filter((r) => r.date >= fmt(daysAgo(90))).map((r) => r.date), fmt(daysAgo(90)), today,
  );

  /* 3 — reconciliation frontier, per bank account.
        Six months in one call rather than a month-by-month walk: cheaper, and
        a file with nothing reconciled in six months is already as red as the
        scale goes, so the exact date stops mattering past that point. */
  let reconciledTo: string | null = null;
  const reconciledById: Record<string, string> = {};
  let reconciledWithin6m = false;
  try {
    const { rows: rec } = await transactionList(
      sb, realmId, fmt(daysAgo(190)), today, { cleared: "Reconciled", accountIds: bankIds },
    );
    for (const r of rec) {
      const a = resolveAcct(r.account);
      if (!a) continue;
      const id = String(a.Id);
      if (!reconciledById[id] || r.date > reconciledById[id]) reconciledById[id] = r.date;
    }
    reconciledWithin6m = rec.length > 0;

    // The file is reconciled only as far as its laggiest ACTIVE bank account.
    // An account that is still moving but has nothing reconciled in six months
    // means real trading activity is unreconciled — that pins the frontier to
    // null, the worst bucket, and names itself in the notes.
    const activeMissing = activeBank.filter((a) => !reconciledById[String(a.Id)]);
    if (!activeBank.length) {
      reconciledTo = null;
      notes.push("No bank or credit card account has moved in 90 days");
    } else if (activeMissing.length) {
      reconciledTo = null;
      notes.push(
        `Still trading but nothing reconciled in 6 months: ${activeMissing.map((a) => a.Name).join(", ")}`,
      );
    } else {
      reconciledTo = activeBank
        .map((a) => reconciledById[String(a.Id)])
        .sort()[0];
    }

    // Dormant accounts nobody has ever reconciled: a real finding, but not
    // evidence that this quarter is behind.
    const dormantMissing = liveBank.filter((a) => !isActive(a) && !reconciledById[String(a.Id)]);
    if (dormantMissing.length) {
      notes.push(`Dormant and never reconciled: ${dormantMissing.map((a) => a.Name).join(", ")}`);
    }
  } catch (e) {
    // A file that refuses the Reconciled filter must not read as reconciled.
    notes.push(`Reconciliation frontier unavailable: ${(e as Error).message}`);
    reconciledTo = null;
  }

  /* 4 — uncleared backlog: count, value and the age of the oldest item */
  let unclearedCount = 0, unclearedTotal = 0;
  let oldestUncleared: string | null = null;
  try {
    const { rows: unc } = await transactionList(
      sb, realmId, "2018-01-01", today, { cleared: "Uncleared", accountIds: bankIds },
    );
    unclearedCount = unc.length;
    unclearedTotal = unc.reduce((s, r) => s + r.amount, 0);
    oldestUncleared = unc.length ? unc.reduce((m, r) => (r.date < m ? r.date : m), unc[0].date) : null;
  } catch (e) {
    notes.push(`Uncleared list unavailable: ${(e as Error).message}`);
  }

  /* 5 — has anyone actually touched the file. CDC looks back 30 days at most,
        so "null" means nobody has posted or edited anything in a month. */
  let touchedAt: string | null = null;
  try {
    const since = daysAgo(29).toISOString();
    const resp = await qboFetch(
      sb, realmId,
      `cdc?entities=${CDC_ENTITIES}&changedSince=${encodeURIComponent(since)}&minorversion=75`,
    );
    if (resp.ok) {
      const cdc = await resp.json();
      const walk = (o: any) => {
        if (!o || typeof o !== "object") return;
        if (Array.isArray(o)) { o.forEach(walk); return; }
        const t = o?.MetaData?.LastUpdatedTime;
        if (typeof t === "string" && (!touchedAt || t > touchedAt)) touchedAt = t;
        Object.values(o).forEach(walk);
      };
      walk(cdc?.CDCResponse);
    } else {
      notes.push(`Change feed unavailable (${resp.status})`);
    }
  } catch (e) {
    notes.push(`Change feed unavailable: ${(e as Error).message}`);
  }

  /* 6 — baseline comparison */
  const baseline = opts.baseline || null;
  let volumeRatio: number | null = null;
  let missingRecurring: string[] = [];
  if (baseline?.median_monthly > 0 && baseline.months_observed >= 6) {
    // Annualise the month to date so a sweep on the 3rd isn't a 90% shortfall
    // by arithmetic alone.
    const now = new Date();
    const dayOfMonth = now.getDate();
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const projected = txnThisMonth * (daysInMonth / Math.max(1, dayOfMonth));
    volumeRatio = Number((projected / baseline.median_monthly).toFixed(2));

    const seenThisMonth = new Set(
      recent.filter((r) => r.date.slice(0, 7) === thisMonth).map((r) => r.account),
    );
    missingRecurring = (baseline.recurring_accounts || []).filter((a: string) => !seenThisMonth.has(a));
  }

  const bank_accounts = bankAccounts.map((a) => ({
    id: String(a.Id),
    name: a.Name,
    type: a.AccountType,
    balance: bal(a),
    live: isLive(a),
    active: isActive(a),
    last_txn: lastById[String(a.Id)] || null,
    last_reconciled: reconciledById[String(a.Id)] || null,
    days_since_txn: lastById[String(a.Id)] ? dayDiff(lastById[String(a.Id)], today) : null,
  }));

  return {
    snapshot_date: today,
    posted_to: postedTo,
    reconciled_to: reconciledTo,
    reconciled_within_6m: reconciledWithin6m,
    touched_at: touchedAt,
    oldest_uncleared: oldestUncleared,
    uncleared_count: unclearedCount,
    uncleared_total: Number(unclearedTotal.toFixed(2)),
    txn_this_month: txnThisMonth,
    txn_30d: txn30,
    txn_90d: txn90,
    longest_gap_90d: gap90,
    volume_ratio: volumeRatio,
    missing_recurring: missingRecurring,
    bank_accounts,
    hygiene,
    notes,
    api_calls: apiCalls,
  };
}

/* ── Persistence ──────────────────────────────────────────────────── */

async function baselineFor(sb: any, realmId: string, bankIds: string[]) {
  const { data: existing } = await sb.from("bk_drift_baselines")
    .select("*").eq("realm_id", realmId).maybeSingle();
  const stale = !existing || dayDiff(String(existing.computed_at).slice(0, 10), fmt(new Date())) > 25;
  if (!stale) return existing.data;

  const data = await computeBaseline(sb, realmId, bankIds);
  await sb.from("bk_drift_baselines").upsert({
    realm_id: realmId, data, computed_at: new Date().toISOString(),
  }, { onConflict: "realm_id" });
  return data;
}

async function sweepRealm(sb: any, conn: any, runId: number | null) {
  apiCalls = 0;
  const base = {
    run_id: runId, realm_id: conn.realm_id, entity_id: conn.entity_id,
    company_name: conn.company_name, snapshot_date: fmt(new Date()),
  };
  try {
    // The bank list is needed before the baseline, so the chart of accounts is
    // pulled once here and handed to the measurement.
    const accJson = await qboQuery(sb, conn.realm_id, "SELECT * FROM Account MAXRESULTS 1000");
    const accounts = accJson?.QueryResponse?.Account || [];
    const bankIds = accounts
      .filter((a: any) => (a.AccountType === "Bank" || a.AccountType === "Credit Card") && a.Active !== false)
      .map((a: any) => String(a.Id));

    const baseline = await baselineFor(sb, conn.realm_id, bankIds);
    const m = await measureRealm(sb, conn.realm_id, { baseline, accounts });

    await sb.from("bk_drift_snapshots").upsert({
      ...base,
      status: "ok",
      posted_to: m.posted_to,
      reconciled_to: m.reconciled_to,
      reconciled_within_6m: m.reconciled_within_6m,
      touched_at: m.touched_at,
      oldest_uncleared: m.oldest_uncleared,
      uncleared_count: m.uncleared_count,
      uncleared_total: m.uncleared_total,
      txn_this_month: m.txn_this_month,
      txn_30d: m.txn_30d,
      txn_90d: m.txn_90d,
      longest_gap_90d: m.longest_gap_90d,
      normal_gap_days: baseline?.normal_gap_days ?? null,
      baseline_monthly: baseline?.median_monthly ?? null,
      volume_ratio: m.volume_ratio,
      missing_recurring: m.missing_recurring,
      bank_accounts: m.bank_accounts,
      hygiene: m.hygiene,
      notes: m.notes,
      api_calls: m.api_calls,
      error: null,
      pulled_at: new Date().toISOString(),
    }, { onConflict: "realm_id,snapshot_date" });
    return { ok: true };
  } catch (e) {
    // Errors are recorded, not swallowed. status='error' renders as "unknown"
    // downstream — never as a healthy file.
    await sb.from("bk_drift_snapshots").upsert({
      ...base, status: "error", error: (e as Error).message.slice(0, 400),
      api_calls: apiCalls, pulled_at: new Date().toISOString(),
    }, { onConflict: "realm_id,snapshot_date" });
    return { ok: false, error: (e as Error).message };
  }
}

/* ── Handler ──────────────────────────────────────────────────────── */

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const authHeader = req.headers.get("Authorization") || "";
  const bearer = authHeader.replace("Bearer ", "");
  const isService = roleFromJwt(bearer) === "service_role";

  let staff = false;
  if (!isService) {
    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user } } = await userClient.auth.getUser();
    if (user) {
      const { data: prof } = await userClient.from("staff_profiles")
        .select("can_view_reports").eq("id", user.id).maybeSingle();
      staff = prof?.can_view_reports === true;
    }
  }
  if (!isService && !staff) return jr({ error: "Not authorised" }, 403);

  const sb = svc();
  let body: any = {};
  try { body = await req.json(); } catch { /* GET or empty body */ }
  const mode = body.mode || "probe";

  try {
    if (mode === "probe") {
      if (!body.realm_id) return jr({ error: "realm_id required" }, 400);
      apiCalls = 0;
      const accJson = await qboQuery(sb, body.realm_id, "SELECT * FROM Account MAXRESULTS 1000");
      const accounts = accJson?.QueryResponse?.Account || [];
      const bankIds = accounts
        .filter((a: any) => (a.AccountType === "Bank" || a.AccountType === "Credit Card") && a.Active !== false)
        .map((a: any) => String(a.Id));
      const baseline = body.skip_baseline ? null : await baselineFor(sb, body.realm_id, bankIds);
      const m = await measureRealm(sb, body.realm_id, { baseline, accounts });
      return jr({ realm_id: body.realm_id, baseline, ...m });
    }

    if (mode === "sweep") {
      // Only linked, client-authorised, non-practice files with a live token —
      // and only clients someone has actually put under watch.
      const { data: conns } = await sb.from("qbo_report_connections")
        .select("realm_id, company_name, entity_id")
        .eq("status", "active").eq("is_practice", false)
        .not("entity_id", "is", null)
        .order("company_name");
      const { data: toks } = await sb.from("qbo_report_tokens").select("realm_id").eq("status", "active");
      const { data: watched } = await sb.from("bk_watch_config")
        .select("entity_id").eq("watch_enabled", true);

      const haveToken = new Set((toks || []).map((t: any) => t.realm_id));
      const inWatch = new Set((watched || []).map((w: any) => w.entity_id));
      let candidates = (conns || []).filter((c: any) => haveToken.has(c.realm_id) && inWatch.has(c.entity_id));

      if (Array.isArray(body.realms) && body.realms.length) {
        candidates = candidates.filter((c: any) => body.realms.includes(c.realm_id));
      }

      const offset = Number(body.offset ?? 0);
      const limit = Number(body.limit ?? 12);
      const slice = candidates.slice(offset, offset + limit);

      let runId: number | null = body.run_id ?? null;
      if (!runId) {
        const { data: run } = await sb.from("bk_drift_runs")
          .insert({ trigger: body.trigger ?? "manual", realms_total: candidates.length })
          .select("id").single();
        runId = run?.id ?? null;
      }

      let ok = 0, failed = 0;
      const errors: any[] = [];
      for (const c of slice) {
        const r = await sweepRealm(sb, c, runId);
        if (r.ok) ok++; else { failed++; errors.push({ realm: c.company_name, error: r.error }); }
      }

      const done = offset + slice.length;
      const finished = done >= candidates.length;
      if (runId) {
        const { data: cur } = await sb.from("bk_drift_runs")
          .select("realms_checked, realms_error").eq("id", runId).maybeSingle();
        await sb.from("bk_drift_runs").update({
          realms_checked: (cur?.realms_checked || 0) + ok,
          realms_error: (cur?.realms_error || 0) + failed,
          finished_at: finished ? new Date().toISOString() : null,
        }).eq("id", runId);
      }

      return jr({ run_id: runId, total: candidates.length, offset, checked: ok, errored: failed, finished, errors });
    }

    return jr({ error: `Unknown mode ${mode}` }, 400);
  } catch (e) {
    return jr({ error: (e as Error).message }, 500);
  }
});
