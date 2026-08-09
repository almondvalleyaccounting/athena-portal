// qbo-journal-recon
// Independent control check on the BrightPay payroll journal run.
//
// Reads what actually LANDED in a client's QuickBooks and compares it to what
// the BrightPay runner recorded in payroll.task. The runner posts; this checks.
// It never writes to QuickBooks and never reverses anything — it raises
// findings for a human to adjudicate.
//
// See docs/qbo-portfolio-sweep-plan.md (Phase 0) and, in the runner repo,
// CONTROL-CHECK-HANDOVER.md for the division of duties.
//
// Modes:
//   probe  — raw shape of JournalEntry objects for one realm/window.
//   recon  — one realm: match QBO journals against payroll.task, return findings.
//   batch  — many realms: same, persisted to journal_recon_findings.
//
// VERIFIED against live QuickBooks, 9 Aug 2026 (AATT Ltd, Apr–Jul):
//   • BrightPay creates JournalEntry objects.
//   • Every one carries PrivateNote = "Sent from BrightPay" — an explicit
//     source marker, so BrightPay's journals are distinguishable from a
//     client's own manual ones without guessing.
//   • DocNumber is null. There is no per-period reference to match on.
//   • TotalAmt is ZERO on every journal entry. The real figure must be summed
//     from the debit lines — matching on TotalAmt finds nothing.
//   • TxnDate is the period end, and it is not always month-end (May 2026
//     posted as the 29th), so periods must be matched on year-month.
//   • Line Description carries the employee name.
//
// Auth: verify_jwt=true at the gateway. Inside, EITHER a service-role JWT (how
// the cron calls it) OR a staff user with can_view_reports. Portal clients
// share auth.users, so a valid JWT alone is NOT sufficient.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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

// Role claim from an already-verified JWT. verify_jwt=true at the gateway means
// the signature has been checked before this runs, so the payload can be
// trusted. More robust than string-matching the service key: Vault holds a
// different but equally valid service-role JWT for this project.
function roleFromJwt(bearer: string): string | null {
  try {
    const payload = bearer.split(".")[1];
    if (!payload) return null;
    const pad = payload.replace(/-/g, "+").replace(/_/g, "/");
    const json = JSON.parse(atob(pad + "=".repeat((4 - pad.length % 4) % 4)));
    return json?.role ?? null;
  } catch { return null; }
}

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

/* ── Journal fetch ────────────────────────────────────────────────── */

const PAGE = 200;

async function fetchJournals(sb: any, realmId: string, start: string, end: string): Promise<any[]> {
  const out: any[] = [];
  let pos = 1;
  for (let page = 0; page < 25; page++) { // bounded: no runaway on an odd response
    const q = `select * from JournalEntry where TxnDate >= '${start}' and TxnDate <= '${end}'`
      + ` startposition ${pos} maxresults ${PAGE}`;
    const json = await qboQuery(sb, realmId, q);
    const batch = json?.QueryResponse?.JournalEntry ?? [];
    out.push(...batch);
    if (batch.length < PAGE) break;
    pos += PAGE;
  }
  return out;
}

/* ── Shape ────────────────────────────────────────────────────────── */

function round2(n: number) { return Math.round(n * 100) / 100; }

function lineSummary(je: any) {
  const lines = je?.Line ?? [];
  let debit = 0, credit = 0;
  const accounts: string[] = [];
  for (const l of lines) {
    const d = l?.JournalEntryLineDetail;
    const amt = Number(l?.Amount ?? 0);
    if (d?.PostingType === "Debit") debit += amt;
    else if (d?.PostingType === "Credit") credit += amt;
    const nm = d?.AccountRef?.name;
    if (nm && !accounts.includes(nm)) accounts.push(nm);
  }
  return { line_count: lines.length, debit_total: round2(debit), credit_total: round2(credit), accounts };
}

// The source marker BrightPay stamps on every journal it sends. Note this
// identifies BrightPay-vs-manual, NOT which automation drove BrightPay — the
// previous (Cowork) automation drove the same wizard and left the same note.
// CreateTime is the discriminator between the two eras.
function isBrightPay(je: any) { return /brightpay/i.test(String(je?.PrivateNote ?? "")); }

function probeEntry(je: any) {
  return {
    id: je?.Id,
    doc_number: je?.DocNumber ?? null,
    txn_date: je?.TxnDate ?? null,
    total_amt: je?.TotalAmt ?? null,
    private_note: je?.PrivateNote ?? null,
    source: isBrightPay(je) ? "brightpay" : "other",
    adjustment: je?.Adjustment ?? null,
    create_time: je?.MetaData?.CreateTime ?? null,
    last_updated: je?.MetaData?.LastUpdatedTime ?? null,
    ...lineSummary(je),
    sample_lines: (je?.Line ?? []).slice(0, 4).map((l: any) => ({
      amount: l?.Amount ?? null,
      posting: l?.JournalEntryLineDetail?.PostingType ?? null,
      account: l?.JournalEntryLineDetail?.AccountRef?.name ?? null,
      description: l?.Description ?? null,
    })),
    top_level_keys: Object.keys(je ?? {}).sort(),
  };
}

/* ── Recon ────────────────────────────────────────────────────────── */

const PENCE_TOLERANCE = 0.02;
function monthKey(d: string) { return (d || "").slice(0, 7); }
const UNCATEGORISED = /uncategori[sz]ed/i;

/**
 * Match BrightPay journals to payroll.task rows for one employer.
 *
 * Only journals carrying BrightPay's source marker are considered. A client's
 * own manual journals are none of this check's business and are never flagged.
 *
 * The period model matters and is not obvious — both of these are REAL,
 * observed on live data (9 Aug 2026), and a naive one-journal-per-month
 * assumption produces false positives on both:
 *
 *   1. BrightPay posts the payroll journal and the Employment Allowance
 *      adjustment as SEPARATE journals. payroll.task.amount is their SUM.
 *      Verified: MAC Recruit July = 31,845.98 + 3,331.24 = 35,177.22.
 *   2. A task period is not always one month. Catch-up tasks span several
 *      (CLF Scotland has one covering 2026-04-01 to 2026-06-30), and weekly
 *      payrolls produce several journals inside one monthly period.
 *
 * So: journals are matched to a task by DATE RANGE, and the comparison is
 * against the SUM of the debits in that range.
 *
 * Duplicate detection is therefore independent of the task amount — two
 * journals sharing a date AND a total is the signal, since that is what a
 * re-send produces and what a weekly payroll does not.
 *
 * Deliberately conservative: anything ambiguous becomes a finding for a human,
 * never an automatic conclusion. Nothing here writes to QuickBooks.
 */
function reconcile(tasks: any[], allJournals: any[]) {
  const findings: any[] = [];
  const journals = allJournals.filter((j) => j.source === "brightpay");
  const claimed = new Set<string>();

  // 1. Duplicates: same transaction date, same total. Independent of any task.
  const byDateAmount: Record<string, any[]> = {};
  for (const j of journals) {
    if (!(Number(j.debit_total) > 0)) continue;
    const k = `${j.txn_date}|${Number(j.debit_total).toFixed(2)}`;
    (byDateAmount[k] ||= []).push(j);
  }
  for (const [k, group] of Object.entries(byDateAmount)) {
    if (group.length < 2) continue;
    const [date, amt] = k.split("|");
    findings.push({
      kind: "duplicate", severity: "high", period: monthKey(date),
      detail: `${group.length} identical BrightPay journals on ${date}, each totalling ${amt}.`,
      data: { journals: group.map((j) => ({ id: j.id, create_time: j.create_time })) },
    });
  }

  // 2. Each task against the journals inside its period.
  for (const t of tasks) {
    const period = monthKey(t.period_start);
    const inRange = journals.filter((j) => j.txn_date >= t.period_start && j.txn_date <= t.period_end);
    inRange.forEach((j) => claimed.add(j.id));
    const sum = round2(inRange.reduce((a, j) => a + Number(j.debit_total), 0));
    const expected = t.amount != null ? Number(t.amount) : null;

    if (inRange.length === 0) {
      findings.push({
        kind: "missing", severity: "high", task_id: t.id, period,
        detail: `Task says posted for ${t.period_start}..${t.period_end} but no BrightPay journal exists in QuickBooks in that period.`,
        data: { expected },
      });
      continue;
    }

    if (expected == null) {
      // The runner asserts a journal exists but recorded no figure to check it
      // against. Existence is confirmed; agreement cannot be.
      findings.push({
        kind: "unverifiable_amount", severity: "low", task_id: t.id, period,
        detail: `${inRange.length} BrightPay journal(s) in ${t.period_start}..${t.period_end} totalling ${sum.toFixed(2)}, but the task recorded no amount — existence confirmed, agreement not.`,
        data: { total: sum, journals: inRange.map((j) => ({ id: j.id, date: j.txn_date, total: j.debit_total })) },
      });
      continue;
    }

    if (Math.abs(sum - expected) > PENCE_TOLERANCE) {
      findings.push({
        kind: "amount_mismatch", severity: "high", task_id: t.id, period,
        detail: `Task records ${expected.toFixed(2)} for ${t.period_start}..${t.period_end}; QuickBooks holds ${sum.toFixed(2)} across ${inRange.length} journal(s). Difference ${(sum - expected).toFixed(2)}.`,
        data: { expected, actual: sum, journals: inRange.map((j) => ({ id: j.id, date: j.txn_date, total: j.debit_total })) },
      });
    }

    for (const j of inRange) {
      if (Math.abs(Number(j.debit_total) - Number(j.credit_total)) > PENCE_TOLERANCE) {
        findings.push({
          kind: "unbalanced", severity: "high", task_id: t.id, period,
          detail: `Journal ${j.id} debits ${j.debit_total} vs credits ${j.credit_total}.`,
        });
      }
    }
  }

  // 3. BrightPay journals no task claims — the previous automation, or a
  //    hand-driven send.
  for (const j of journals) {
    if (claimed.has(j.id)) continue;
    findings.push({
      kind: "orphan", severity: "medium", period: monthKey(j.txn_date),
      detail: `BrightPay journal ${j.id} (${j.txn_date}, ${Number(j.debit_total).toFixed(2)}) falls in no recorded task period.`,
      data: { journal_id: j.id, date: j.txn_date, total: j.debit_total, create_time: j.create_time, accounts: j.accounts },
    });
  }

  // 4. Quality: a payroll journal landing in an uncategorised account.
  for (const j of journals) {
    const bad = (j.accounts || []).filter((a: string) => UNCATEGORISED.test(a));
    if (!bad.length) continue;
    findings.push({
      kind: "uncategorised_account", severity: "medium", period: monthKey(j.txn_date),
      detail: `Journal ${j.id} (${j.txn_date}) posts to ${bad.join(", ")} — the nominal mapping needs attention.`,
      data: { journal_id: j.id, accounts: bad },
    });
  }

  return findings;
}

/* ── Per-realm run ────────────────────────────────────────────────── */

async function reconRealm(sb: any, realmId: string, start: string, end: string, employers: any[]) {
  const { data: conn } = await sb.from("qbo_report_connections")
    .select("realm_id, company_name, is_practice").eq("realm_id", realmId).maybeSingle();

  const raw = await fetchJournals(sb, realmId, start, end);
  const journals = raw.map(probeEntry);

  const norm = (s: string | null) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const target = norm(conn?.company_name ?? "");
  const matched = (employers || []).filter((e: any) => {
    if (e.destination_realm) return e.destination_realm === realmId;
    const keys = [e.destination_company, e.brightpay_name, e.sheet_name].map(norm);
    return keys.some((k) => k && (k === target || k + "ltd" === target || k + "limited" === target
      || target + "ltd" === k || target + "limited" === k));
  });

  const base = {
    realm_id: realmId,
    company_name: conn?.company_name ?? null,
    journal_count: journals.length,
    brightpay_count: journals.filter((j) => j.source === "brightpay").length,
  };

  if (matched.length === 0) {
    return { ...base, employer: null, task_count: 0, findings: [{
      kind: "unmatched_employer", severity: "medium",
      detail: `No payroll employer maps to realm ${realmId} (${conn?.company_name ?? "unknown"}). Record destination_realm on the employer, or link it by hand.`,
    }] };
  }
  if (matched.length > 1) {
    return { ...base, employer: null, task_count: 0, findings: [{
      kind: "ambiguous_employer", severity: "high",
      detail: `${matched.length} employers match realm ${realmId}. Refusing to reconcile against an ambiguous mapping.`,
      data: { employers: matched.map((e: any) => e.sheet_name) },
    }] };
  }

  const employer = matched[0];

  const { data: tasks, error: taskErr } = await sb.rpc("payroll_recon_tasks", {
    p_employer_id: employer.id, p_start: start, p_end: end,
  });
  if (taskErr) throw new Error(`payroll_recon_tasks: ${taskErr.message}`);

  const posted = (tasks || []).filter((t: any) => t.state === "posted" || t.state === "verified");

  // Nothing from BrightPay in this ledger at all, yet tasks claim postings.
  // Reporting one "missing" per task would be noise and would not say which of
  // the two very different causes it is, so look further back and name it:
  //
  //   journals before the window, none in it  -> BrightPay has STOPPED reaching
  //     this QuickBooks company (KEM: fine to February, nothing since)
  //   none ever                               -> this client almost certainly
  //     posts somewhere else (MTG posts to Xero)
  //
  // This is evidence rather than the employer.destination field, which is
  // seeded from posting history in the Journal Log and defaults to
  // 'quickbooks' on a miss — so it cannot be trusted to answer this.
  if (posted.length > 0 && base.brightpay_count === 0) {
    const back = new Date(start);
    back.setUTCFullYear(back.getUTCFullYear() - 1);
    const lookback = back.toISOString().slice(0, 10);
    const hist = (await fetchJournals(sb, realmId, lookback, start))
      .map(probeEntry).filter((j) => j.source === "brightpay");

    const f = hist.length
      ? {
          kind: "stopped_posting", severity: "high",
          detail: `No BrightPay journals between ${start} and ${end}, but ${hist.length} before it — the last dated ${hist.map((j) => j.txn_date).sort().pop()}. ${posted.length} task(s) record a posting that is not in this ledger.`,
          data: { last_seen: hist.map((j) => j.txn_date).sort().pop(), tasks: posted.length },
        }
      : {
          kind: "no_brightpay_journals", severity: "medium",
          detail: `No BrightPay journals in this QuickBooks company at all, checked back to ${lookback}. This client most likely posts to a different system — check before treating it as missing.`,
          data: { checked_from: lookback, tasks: posted.length },
        };
    return { ...base, employer: employer.sheet_name, task_count: posted.length, findings: [f] };
  }

  const findings = reconcile(posted, journals);

  for (const t of (tasks || [])) {
    if (t.ea_status === "not_mapped" && Number(t.ea_amount ?? 0) > 0) {
      findings.push({
        kind: "ea_not_posted", severity: "high", task_id: t.id,
        period: monthKey(t.period_start),
        detail: `Employment Allowance ${Number(t.ea_amount).toFixed(2)} was not posted — no nominal mapping.`,
      });
    }
  }

  return {
    ...base,
    employer: employer.sheet_name,
    matched_on: employer.destination_realm ? "realm" : "name",
    task_count: posted.length,
    findings,
  };
}

/* ── Handler ──────────────────────────────────────────────────────── */

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    const sb = svc();

    const authHeader = req.headers.get("Authorization") || "";
    const bearer = authHeader.replace(/^Bearer\s+/i, "").trim();
    const isService = bearer.length > 0
      && (bearer === SUPABASE_SERVICE_ROLE_KEY || roleFromJwt(bearer) === "service_role");

    let staff: any = null;
    if (!isService) {
      const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { headers: { Authorization: authHeader } } });
      const { data: { user } } = await anon.auth.getUser();
      if (!user) return jr({ error: "Invalid token" }, 401);
      const { data: profile } = await sb.from("staff_profiles")
        .select("id, can_view_reports, can_view_practice_financials").eq("id", user.id).maybeSingle();
      if (!profile?.can_view_reports) return jr({ error: "Not authorised" }, 403);
      staff = profile;
    }

    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const mode: string = body.mode || "recon";
    const start: string = body.start || "2026-04-01";
    const end: string = body.end || "2026-07-31";

    const { data: employers, error: empErr } = await sb.rpc("payroll_recon_employers");
    if (empErr) throw new Error(`payroll_recon_employers: ${empErr.message}`);

    /* --- probe / single-realm recon --- */
    if (mode === "probe" || mode === "recon") {
      const realmId: string | undefined = body.realm_id;
      if (!realmId) return jr({ error: "realm_id is required" }, 400);

      const { data: conn } = await sb.from("qbo_report_connections")
        .select("is_practice").eq("realm_id", realmId).maybeSingle();
      if (staff && conn?.is_practice && !staff.can_view_practice_financials) {
        return jr({ error: "Not authorised for practice financials" }, 403);
      }

      if (mode === "probe") {
        const raw = await fetchJournals(sb, realmId, start, end);
        const journals = raw.map(probeEntry);
        return jr({ mode: "probe", realm_id: realmId, window: { start, end },
          journal_count: journals.length, journals: journals.slice(0, Number(body.limit ?? 10)) });
      }

      const r = await reconRealm(sb, realmId, start, end, employers || []);
      return jr({ mode: "recon", window: { start, end }, clean: r.findings.length === 0, ...r });
    }

    /* --- batch: many realms, persisted --- */
    if (mode === "batch") {
      if (!isService && !staff) return jr({ error: "Not authorised" }, 403);

      // Realms worth checking: a live token, not the practice books, and a
      // payroll employer that maps to them.
      const { data: conns } = await sb.from("qbo_report_connections")
        .select("realm_id, company_name, is_practice").eq("is_practice", false);
      const { data: toks } = await sb.from("qbo_report_tokens").select("realm_id").eq("status", "active");
      const haveToken = new Set((toks || []).map((t: any) => t.realm_id));

      const norm = (s: string | null) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
      // Deliberately NOT filtered on employer.destination — that field is
      // seeded from posting history and defaults to 'quickbooks' on a miss, so
      // it would both exclude real QBO clients and admit non-QBO ones. The
      // no-journals-at-all branch in reconRealm answers the question properly.
      const empKeys = (employers || []).flatMap((e: any) =>
        [e.destination_company, e.brightpay_name, e.sheet_name].map(norm).filter(Boolean));
      const realmSet = new Set(empKeys);

      let candidates = (conns || []).filter((c: any) => {
        if (!haveToken.has(c.realm_id)) return false;
        if ((employers || []).some((e: any) => e.destination_realm === c.realm_id)) return true;
        const k = norm(c.company_name);
        return realmSet.has(k) || realmSet.has(k + "ltd") || realmSet.has(k + "limited")
          || [...realmSet].some((ek) => ek + "ltd" === k || ek + "limited" === k);
      });

      if (Array.isArray(body.realms) && body.realms.length) {
        candidates = candidates.filter((c: any) => body.realms.includes(c.realm_id));
      }
      const offset = Number(body.offset ?? 0);
      const limit = Number(body.limit ?? 15);
      const slice = candidates.slice(offset, offset + limit);

      let runId: number | null = body.run_id ?? null;
      if (!runId) {
        const { data: run } = await sb.from("journal_recon_runs")
          .insert({ window_start: start, window_end: end, trigger: body.trigger ?? "manual" })
          .select("id").single();
        runId = run?.id ?? null;
      }

      let checked = 0, errored = 0, found = 0;
      const rows: any[] = [];
      const errors: any[] = [];

      for (const c of slice) {
        try {
          const r = await reconRealm(sb, c.realm_id, start, end, employers || []);
          checked++;
          for (const f of r.findings) {
            found++;
            rows.push({
              run_id: runId, realm_id: r.realm_id, company_name: r.company_name,
              employer: r.employer, task_id: f.task_id ?? null, kind: f.kind,
              severity: f.severity, period: f.period ?? null, detail: f.detail,
              data: f.data ?? null,
            });
          }
        } catch (e) {
          errored++;
          errors.push({ realm_id: c.realm_id, company_name: c.company_name, error: String((e as Error)?.message ?? e) });
          rows.push({
            run_id: runId, realm_id: c.realm_id, company_name: c.company_name,
            kind: "check_failed", severity: "medium",
            detail: `Could not check this client: ${String((e as Error)?.message ?? e)}`.slice(0, 500),
          });
          found++;
        }
      }

      if (rows.length) await sb.from("journal_recon_findings").insert(rows);

      const done = offset + limit >= candidates.length;
      if (runId) {
        const { data: prev } = await sb.from("journal_recon_runs")
          .select("realms_checked, realms_error, findings_count").eq("id", runId).single();
        await sb.from("journal_recon_runs").update({
          realms_checked: (prev?.realms_checked ?? 0) + checked,
          realms_error: (prev?.realms_error ?? 0) + errored,
          findings_count: (prev?.findings_count ?? 0) + found,
          finished_at: done ? new Date().toISOString() : null,
        }).eq("id", runId);
      }

      return jr({
        mode: "batch", run_id: runId, window: { start, end },
        candidates: candidates.length, offset, limit,
        checked, errored, findings: found, done,
        next_offset: done ? null : offset + limit,
        errors: errors.slice(0, 10),
      });
    }

    return jr({ error: `Unknown mode: ${mode}` }, 400);
  } catch (err) {
    return jr({ error: String((err as Error)?.message ?? err) }, 500);
  }
});
