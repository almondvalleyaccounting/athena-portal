// journal-month-coverage
// Per-client, per-month evidence of what is actually in each client's
// QuickBooks — including the months with nothing in them.
//
// Separate from qbo-journal-recon on purpose. That function records
// DISCREPANCIES: it compares QuickBooks against payroll.task and raises what
// disagrees. It cannot answer "which clients have no journal for May", because
// a month nobody ever claimed produces no discrepancy to raise. The BrightPay
// runner cannot answer it either — every Apr/May/Jun record it holds was
// imported from the previous automation's log, and that log is known to be
// incomplete (a journal posted by hand and never written to the sheet looks
// identical to one that never happened).
//
// So this reads the ledgers directly and reports PRESENCE:
//   • one row per client per month in the window, INCLUDING zero months
//   • an explicit row for every client that could not be reached
//
// A client absent from the output means the report never looked at it, never
// that it is clean. That distinction is the whole point of the table.
//
// Read-only. Writes nothing to any ledger.
//
// Auth: verify_jwt=true. Service-role JWT, or staff with can_view_reports.
// Body: { start, end, offset?, limit?, report_id? }

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { failureUpdate, refreshWithRetry } from "../_shared/oauth-refresh.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const QBO_CLIENT_ID = Deno.env.get("QBO_CLIENT_ID")!;
const QBO_CLIENT_SECRET = Deno.env.get("QBO_CLIENT_SECRET")!;
const QBO_API_BASE = Deno.env.get("QBO_API_BASE") || "https://quickbooks.api.intuit.com";
const QBO_TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";

function jr(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}
function round2(n: number) { return Math.round(n * 100) / 100; }
function monthKey(d: string) { return (d || "").slice(0, 7); }
const norm = (s: string | null) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
const stem = (k: string) => k.replace(/(limited|ltd|llp|plc)$/, "");
function nameMatches(a: string, b: string) {
  const x = stem(a || ""), y = stem(b || "");
  return !!x && !!y && x === y;
}
function roleFromJwt(bearer: string): string | null {
  try {
    const p = bearer.split(".")[1];
    if (!p) return null;
    const pad = p.replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(pad + "=".repeat((4 - pad.length % 4) % 4)))?.role ?? null;
  } catch { return null; }
}

/* ── Token resolution (mirrors qbo-journal-recon) ─────────────────── */

async function resolveSource(sb: any, realmId: string) {
  const { data: rt } = await sb.from("qbo_report_tokens").select("*").eq("realm_id", realmId).maybeSingle();
  if (rt && rt.refresh_token) return { table: "qbo_report_tokens", keyCol: "realm_id", conn: rt };
  const { data: bc } = await sb.from("qbo_connections").select("*").eq("realm_id", realmId).eq("status", "active").maybeSingle();
  if (bc) return { table: "qbo_connections", keyCol: "id", conn: bc };
  throw new Error(`No stored QBO tokens for realm ${realmId}`);
}

async function refreshToken(sb: any, src: any) {
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
  const t = outcome.tokens as Record<string, any>;
  await sb.from(src.table).update({
    access_token: t.access_token, refresh_token: t.refresh_token,
    token_expires_at: new Date(Date.now() + t.expires_in * 1000).toISOString(),
    refresh_token_expires_at: t.x_refresh_token_expires_in
      ? new Date(Date.now() + t.x_refresh_token_expires_in * 1000).toISOString()
      : src.conn.refresh_token_expires_at,
    last_refreshed_at: new Date().toISOString(), status: "active", error_message: null,
    updated_at: new Date().toISOString(),
  }).eq(src.keyCol, keyVal);
  return t.access_token as string;
}

async function tokenFor(sb: any, realmId: string): Promise<string> {
  const src = await resolveSource(sb, realmId);
  if (new Date(src.conn.token_expires_at).getTime() - Date.now() < 5 * 60 * 1000) return await refreshToken(sb, src);
  return src.conn.access_token;
}

async function fetchJournals(sb: any, realmId: string, start: string, end: string): Promise<any[]> {
  const out: any[] = [];
  let pos = 1;
  for (let page = 0; page < 25; page++) {
    const q = `select * from JournalEntry where TxnDate >= '${start}' and TxnDate <= '${end}'`
      + ` startposition ${pos} maxresults 200`;
    let token = await tokenFor(sb, realmId);
    const url = `${QBO_API_BASE}/v3/company/${realmId}/query?query=${encodeURIComponent(q)}&minorversion=75`;
    let resp = await fetch(url, { headers: { "Authorization": `Bearer ${token}`, "Accept": "application/json" } });
    if (resp.status === 401) {
      token = await refreshToken(sb, await resolveSource(sb, realmId));
      resp = await fetch(url, { headers: { "Authorization": `Bearer ${token}`, "Accept": "application/json" } });
    }
    if (!resp.ok) throw new Error(`QBO query failed: ${resp.status} ${(await resp.text()).slice(0, 200)}`);
    const json = await resp.json();
    const batch = json?.QueryResponse?.JournalEntry ?? [];
    out.push(...batch);
    if (batch.length < 200) break;
    pos += 200;
  }
  return out;
}

// Debit total, summed from the lines. QBO reports TotalAmt as 0 on every
// journal entry, so the header figure is useless here.
function summarise(je: any) {
  let debit = 0;
  for (const l of (je?.Line ?? [])) {
    if (l?.JournalEntryLineDetail?.PostingType === "Debit") debit += Number(l?.Amount ?? 0);
  }
  return {
    txn_date: je?.TxnDate ?? null,
    debit: round2(debit),
    brightpay: /brightpay/i.test(String(je?.PrivateNote ?? "")),
  };
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
    const start: string = body.start || "2026-04-01";
    const end: string = body.end || "2026-06-30";
    const offset = Number(body.offset ?? 0);
    const limit = Number(body.limit ?? 25);

    // Months in the window, so an empty month still gets a row.
    const months: string[] = [];
    {
      const d = new Date(start + "T00:00:00Z");
      const last = end.slice(0, 7);
      for (let i = 0; i < 36; i++) {
        const k = d.toISOString().slice(0, 7);
        months.push(k);
        if (k >= last) break;
        d.setUTCMonth(d.getUTCMonth() + 1);
      }
    }

    const { data: employers, error: empErr } = await sb.rpc("payroll_recon_employers");
    if (empErr) throw new Error(`payroll_recon_employers: ${empErr.message}`);

    // Expected population is every employer set to post journals — NOT only
    // those with a task on file. A month that was never posted has no task, so
    // keying off tasks would hide exactly what this report is looking for.
    //
    // Explicit non-QuickBooks destinations are excluded, or Xero and FreeAgent
    // clients show up as unreachable gaps every month forever. The test is
    // deliberately one-sided: it trusts 'xero'/'freeagent' but never treats
    // 'quickbooks' as meaningful, because that is the value the runner's seed
    // falls back to when it cannot tell — so a real QBO client and an
    // unknown-destination client look identical. Excluding on a positive
    // non-QBO value is safe; including on 'quickbooks' would be a guess.
    const NON_QBO = new Set(["xero", "freeagent", "sage"]);
    const expected = (employers || []).filter((e: any) =>
      e.post_journals && !NON_QBO.has(String(e.destination || "").toLowerCase()));

    const { data: conns } = await sb.from("qbo_report_connections")
      .select("realm_id, company_name, is_practice").eq("is_practice", false);
    const { data: toks } = await sb.from("qbo_report_tokens").select("realm_id").eq("status", "active");
    const haveToken = new Set((toks || []).map((t: any) => t.realm_id));

    const pairs: any[] = [];
    for (const c of (conns || [])) {
      if (!haveToken.has(c.realm_id)) continue;
      const k = norm(c.company_name);
      const emp = expected.find((e: any) => e.destination_realm === c.realm_id)
        || expected.find((e: any) => [e.destination_company, e.brightpay_name, e.sheet_name]
            .map(norm).some((ek: string) => nameMatches(ek, k)));
      if (emp) pairs.push({ conn: c, emp });
    }

    let reportId: number | null = body.report_id ?? null;
    if (!reportId) {
      const { data: run } = await sb.from("journal_recon_runs")
        .insert({ window_start: start, window_end: end, trigger: "coverage" })
        .select("id").single();
      reportId = run?.id ?? null;
    }

    const slice = pairs.slice(offset, offset + limit);
    const rows: any[] = [];
    let checked = 0, errored = 0;

    for (const { conn, emp } of slice) {
      try {
        const js = (await fetchJournals(sb, conn.realm_id, start, end)).map(summarise);
        checked++;
        for (const m of months) {
          const inM = js.filter((j) => monthKey(j.txn_date) === m);
          const bp = inM.filter((j) => j.brightpay);
          const ot = inM.filter((j) => !j.brightpay);
          rows.push({
            report_id: reportId, realm_id: conn.realm_id, company_name: conn.company_name,
            employer: emp.sheet_name, period: m, status: "checked",
            brightpay_journals: bp.length,
            brightpay_total: round2(bp.reduce((a, j) => a + j.debit, 0)),
            other_journals: ot.length,
            other_total: round2(ot.reduce((a, j) => a + j.debit, 0)),
          });
        }
      } catch (_e) {
        errored++;
        rows.push({
          report_id: reportId, realm_id: conn.realm_id, company_name: conn.company_name,
          employer: emp.sheet_name, period: null, status: "check_failed",
          brightpay_journals: 0, brightpay_total: 0, other_journals: 0, other_total: 0,
        });
      }
    }

    const done = offset + limit >= pairs.length;
    if (done) {
      // Every client we could not reach, named. Silence must never read as clean.
      const reached = new Set(pairs.map((p) => String(p.emp.id)));
      for (const e of expected) {
        if (reached.has(String(e.id))) continue;
        rows.push({
          report_id: reportId, realm_id: null,
          company_name: e.destination_company || e.sheet_name,
          employer: e.sheet_name, period: null, status: "no_connection",
          brightpay_journals: 0, brightpay_total: 0, other_journals: 0, other_total: 0,
        });
      }
    }

    // EVERY row must carry the same keys. PostgREST rejects a bulk insert whose
    // objects differ in shape, and it does so silently as far as the caller is
    // concerned unless the error is read - which is how the first run wrote 50
    // clients and dropped the other 16 plus every no-connection row.
    if (rows.length) {
      const { error: insErr } = await sb.from("journal_month_coverage").insert(rows);
      // Never swallow this. A silently failed insert is indistinguishable from
      // "nothing to report" - which is the exact failure mode this table was
      // built to eliminate.
      if (insErr) throw new Error(`coverage insert failed (${rows.length} rows): ${insErr.message}`);
    }
    if (reportId && done) {
      await sb.from("journal_recon_runs").update({ finished_at: new Date().toISOString() }).eq("id", reportId);
    }

    return jr({
      report_id: reportId, window: { start, end }, months,
      clients_expected: expected.length, clients_reachable: pairs.length,
      offset, limit, checked, errored, done,
      next_offset: done ? null : offset + limit,
    });
  } catch (err) {
    return jr({ error: String((err as Error)?.message ?? err) }, 500);
  }
});
