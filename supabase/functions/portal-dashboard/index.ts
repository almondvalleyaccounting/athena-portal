// portal-dashboard
//
// The client-portal's only door to a client's own QuickBooks figures.
//
// WHY THIS IS A SEPARATE FUNCTION. dashboard-qbo-pull is staff-only, and it says
// so at the top; bolting a client branch onto it would make that sentence a lie
// and leave the next reader trusting a check that no longer holds. So the client
// path is its own function with its own narrow contract, and it does the three
// things a client-facing endpoint has to do:
//
//   1. Establishes WHO is calling — a real signed-in user, not the anon key,
//      which is a syntactically valid JWT for this project and ships in every
//      frontend bundle.
//   2. Establishes WHAT they may see — an unrevoked client_dashboard_access
//      grant for the entity they asked about, and the section flags on it.
//   3. Decides the DATES itself. The caller sends a grain and a basis, never a
//      date range and never a realm id. A client cannot ask for an arbitrary
//      window, cannot ask about another company, and cannot name a metric.
//
// The realm is resolved here from the grant. The figures themselves come from
// dashboard-qbo-pull, called server-side with the service key, so there is
// exactly one implementation of every QuickBooks report and a client can never
// be shown a number derived differently from the one staff read.
//
// Practice books are refused outright, twice: here by is_practice, and again in
// dashboard-qbo-pull, where a service caller has no staff profile and so never
// clears the practice-financials guard.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// How stale a cached figure may be before the client's page triggers a live
// pull. Twelve hours: a client looking twice in a morning gets the cache, and
// nobody's bookkeeping moves fast enough for that to mislead.
const MAX_AGE_MIN = 12 * 60;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function jr(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...cors } });
}

/* ── Bucket maths (mirror of src/modules/client-dashboard/overviewGrain.js) ──
   Kept server-side because the client must not choose its own date range. The
   two implementations have to agree, so the rules are stated the same way:
   a fiscal year END month is the month before the QBO fiscal-year START month,
   quarters close on the year end and every third month back from it, and only
   COMPLETE buckets are ever returned. */
const GRAIN_MONTHS: Record<string, number> = { month: 1, quarter: 3, year: 12 };
const GRAIN_COUNT: Record<string, number> = { month: 12, quarter: 8, year: 5 };

const absOf = (key: string) => {
  const [y, m] = key.split("-").map(Number);
  return y * 12 + (m - 1);
};
const keyOf = (abs: number) => `${Math.floor(abs / 12)}-${String((abs % 12) + 1).padStart(2, "0")}`;
const monthIdx = (abs: number) => abs % 12;
const firstDay = (key: string) => `${key}-01`;
const lastDay = (key: string) => {
  const [y, m] = key.split("-").map(Number);
  return `${key}-${String(new Date(y, m, 0).getDate()).padStart(2, "0")}`;
};

function fyStartMonthIndex(v: unknown): number {
  const NAMES = ["january", "february", "march", "april", "may", "june",
    "july", "august", "september", "october", "november", "december"];
  if (v == null || v === "") return 9;
  const n = parseInt(String(v), 10);
  if (!isNaN(n) && n >= 1 && n <= 12) return n - 1;
  const i = NAMES.indexOf(String(v).trim().toLowerCase());
  return i >= 0 ? i : 9;
}

function endMonthSet(grain: string, basis: string, fyIdx: number): Set<number> {
  const ye = basis === "calendar" ? 11 : (fyIdx + 11) % 12;
  if (grain === "month") return new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  if (grain === "year") return new Set([ye]);
  return new Set([ye, (ye + 3) % 12, (ye + 6) % 12, (ye + 9) % 12]);
}

function buildWindow(grain: string, basis: string, fyIdx: number, anchorKey: string) {
  const span = GRAIN_MONTHS[grain] ?? 1;
  const count = GRAIN_COUNT[grain] ?? 12;
  const ends = endMonthSet(grain, basis, fyIdx);
  let lastEnd = absOf(anchorKey);
  for (let i = 0; i < 12 && !ends.has(monthIdx(lastEnd)); i++) lastEnd -= 1;
  // One extra bucket on the front so the page can show a vs-previous delta.
  const startAbs = lastEnd - (count * span) - (span - 1);
  return {
    chartStart: firstDay(keyOf(startAbs)),
    chartEnd: lastDay(keyOf(lastEnd)),
    bsAsAt: lastDay(keyOf(lastEnd)),
    latestEndKey: keyOf(lastEnd),
  };
}

// The last COMPLETE calendar month, in the server's UTC reckoning. A client may
// not anchor later than this, and may not go back more than five years — both
// to bound the QuickBooks work and because there is no legitimate reason to.
function clampAnchor(requested: unknown): string {
  const now = new Date();
  const maxAbs = now.getUTCFullYear() * 12 + now.getUTCMonth() - 1;
  const minAbs = maxAbs - 60;
  const raw = typeof requested === "string" && /^\d{4}-\d{2}$/.test(requested) ? requested : null;
  if (!raw) return keyOf(maxAbs);
  const a = absOf(raw);
  if (isNaN(a)) return keyOf(maxAbs);
  return keyOf(Math.min(maxAbs, Math.max(minAbs, a)));
}

/* ── Handler ───────────────────────────────────────────────────────── */
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return jr({ success: false, error: "POST required" }, 405);

  try {
    // 1. WHO. The anon key is a valid JWT for this project, so it is refused by
    //    its own role claim before anything else happens. getUser() then
    //    verifies the signature — a claim alone never grants.
    const authHeader = req.headers.get("Authorization") ?? req.headers.get("authorization");
    const token = authHeader?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || null;
    if (!token) return jr({ success: false, error: "Missing authorization" }, 401);
    try {
      const part = token.split(".")[1];
      const pad = "=".repeat((4 - (part.length % 4)) % 4);
      const role = JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/") + pad))?.role;
      if (role === "anon" || role === "service_role") {
        return jr({ success: false, error: "Not authorised" }, 403);
      }
    } catch { /* not a decodable JWT — getUser will reject it */ }

    const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${token}` } },
    });
    const { data: { user }, error: authErr } = await anon.auth.getUser();
    if (authErr || !user?.email) return jr({ success: false, error: "Invalid token" }, 401);

    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const body = await req.json().catch(() => ({}));
    const entityId = String(body.entityId || "");
    if (!entityId) return jr({ success: false, error: "entityId required" }, 400);

    // 2. WHAT. The grant is the whole authority — an entity_memberships row (the
    //    onboarding portal's link) grants nothing here.
    const { data: grant } = await sb
      .from("client_dashboard_access")
      .select("*")
      .eq("entity_id", entityId)
      .ilike("email", user.email)
      .is("revoked_at", null)
      .maybeSingle();
    if (!grant) return jr({ success: false, error: "Not authorised" }, 403);

    const { data: conn } = await sb
      .from("qbo_report_connections")
      .select("realm_id, company_name, is_practice, status")
      .eq("entity_id", entityId)
      .eq("status", "active")
      .maybeSingle();
    if (!conn?.realm_id) return jr({ success: false, error: "No live QuickBooks connection for this client" }, 404);
    if (conn.is_practice) return jr({ success: false, error: "Not authorised" }, 403);
    const realmId = conn.realm_id;

    // 3. DATES, decided here. The caller supplies a grain and a basis and
    //    nothing else that reaches QuickBooks.
    const grain = ["month", "quarter", "year"].includes(body.grain) ? body.grain : "month";
    const basis = body.basis === "calendar" ? "calendar" : "fiscal";
    const anchorKey = clampAnchor(body.anchor);

    // The fiscal year end comes from the client's own QuickBooks settings, via
    // the cached `company` metric — never from the caller.
    const { data: companyRow } = await sb
      .from("qbo_dashboard_cache")
      .select("data")
      .eq("realm_id", realmId).eq("metric_key", "company")
      .order("pulled_at", { ascending: false }).limit(1).maybeSingle();
    const fyIdx = fyStartMonthIndex(companyRow?.data?.fiscal_year_start_month);

    const win = buildWindow(grain, basis, fyIdx, anchorKey);

    // Delegate the actual QuickBooks work. dashboard-qbo-pull serves its cache
    // when fresh and pulls when not, so this is one call either way.
    const pullBody: Record<string, unknown> = {
      window: {
        kind: "preset",
        period: {
          plStart: win.chartStart, plEnd: win.chartEnd,
          priorStart: win.chartStart, priorEnd: win.chartStart,
          chartStart: win.chartStart, chartEnd: win.chartEnd,
          chartDetail: true,
          bsAsAt: win.bsAsAt,
        },
      },
    };

    const pull = async (payload: Record<string, unknown>) => {
      const r = await fetch(`${SUPABASE_URL}/functions/v1/dashboard-qbo-pull`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ realmId, maxAgeMinutes: MAX_AGE_MIN, ...payload }),
      });
      const j = await r.json().catch(() => ({}));
      return { ok: r.ok, body: j };
    };

    const pullResp = await pull(pullBody);
    const pulled = pullResp.body;
    if (!pullResp.ok) {
      return jr({ success: false, error: "Figures are temporarily unavailable" }, 502);
    }

    // 4. Return only what the grant allows, and only client-safe shapes. The raw
    //    QBO report blobs, file-health signals and bookkeeping-drift scores are
    //    internal working notes about the client's file and never go out.
    const m = pulled?.metrics || {};
    const detail = m.pnl_chart_detail
      ? {
          period: m.pnl_chart_detail.period,
          currency: m.pnl_chart_detail.currency,
          months: m.pnl_chart_detail.months,
          month_keys: m.pnl_chart_detail.month_keys,
          series: m.pnl_chart_detail.series,
          // Account rows only where the underlying view is switched on — they
          // are what makes owner-cost stripping possible, and they name every
          // nominal code, which is more than an overview-only grant implies.
          rows: grant.show_underlying ? m.pnl_chart_detail.rows : undefined,
        }
      : null;

    const bsFull = m.bs_period || null;
    const bs = bsFull
      ? {
          period: bsFull.period,
          currency: bsFull.currency,
          cash: bsFull.cash,
          debtors: bsFull.debtors,
          accounts_payable: bsFull.accounts_payable,
          creditors_within_1yr: bsFull.creditors_within_1yr,
          creditors_after_1yr: bsFull.creditors_after_1yr,
          current_assets: bsFull.current_assets,
          current_liabilities: bsFull.current_liabilities,
          fixed_assets: bsFull.fixed_assets,
          total_assets: bsFull.total_assets,
          total_liabilities: bsFull.total_liabilities,
          net_assets: bsFull.net_assets,
          equity: bsFull.equity,
          prev: bsFull.prev
            ? {
                cash: bsFull.prev.cash, debtors: bsFull.prev.debtors,
                accounts_payable: bsFull.prev.accounts_payable,
                creditors_within_1yr: bsFull.prev.creditors_within_1yr,
              }
            : null,
          // The full expandable account tree is a balance-sheet-grant thing.
          comparatives: grant.show_balance ? bsFull.comparatives : undefined,
        }
      : null;

    // Owner-cost tags, so the portal can compute the underlying view with the
    // same arithmetic staff see. Ids only — no notes, no who-tagged-it.
    let ownerAccountIds: string[] = [];
    let oneoffs: unknown[] = [];
    if (grant.show_underlying) {
      const [{ data: adj }, { data: oo }] = await Promise.all([
        sb.from("dashboard_adjustment_accounts")
          .select("account_id").eq("realm_id", realmId)
          .eq("group_key", "owner_costs").eq("status", "active"),
        sb.from("dashboard_oneoff_items")
          .select("kind, entry_date, amount").eq("realm_id", realmId),
      ]);
      ownerAccountIds = (adj || []).map((r: any) => String(r.account_id));
      oneoffs = oo || [];
    }

    // 5. Projection, only where the grant allows it. The portal runs the SAME
    //    projection engine the staff tab does (both import
    //    src/modules/client-dashboard/projectionEngine.js), so what goes out is
    //    the raw ingredients rather than a second, server-side implementation
    //    of the same arithmetic that could drift away from it.
    let projection: Record<string, unknown> | null = null;
    if (grant.show_projection) {
      const { data: link } = await sb
        .from("dashboard_projections")
        .select("scenario_id, actuals_through")
        .eq("realm_id", realmId)
        .maybeSingle();

      if (link?.scenario_id) {
        const { data: sc } = await sb
          .from("fc_scenario")
          .select("id, name, fc_version(fc_forecast(id, name, opening_period, horizon_months, currency))")
          .eq("id", link.scenario_id)
          .maybeSingle();
        const forecast = (sc as any)?.fc_version?.fc_forecast || null;

        // Page the output. A plain select is silently capped around a thousand
        // rows, which on a five-year scenario would quietly project a fraction
        // of it and look entirely plausible.
        const rows: unknown[] = [];
        const PAGE = 1000;
        for (let from = 0; from < 60000; from += PAGE) {
          const { data: page } = await sb
            .from("fc_output")
            .select("period, nominal_type, amount_p")
            .eq("scenario_id", link.scenario_id)
            .order("period")
            .range(from, from + PAGE - 1);
          rows.push(...(page || []));
          if (!page || page.length < PAGE) break;
        }

        const { data: overrideRows } = await sb
          .from("dashboard_projection_map")
          .select("source, source_key, category")
          .eq("realm_id", realmId);

        // Actuals for the projection's own timeline — three statements by
        // month, up to the cut-off. Separate from the overview window because
        // the projection's clock is the scenario's, not the page filter's.
        // Five years back covers every grain the portal offers; it is one
        // report per statement and dashboard-qbo-pull caches it by range.
        let actuals: Record<string, unknown> | null = null;
        const cutoffKey = String(link.actuals_through || "").slice(0, 7);
        if (/^\d{4}-\d{2}$/.test(cutoffKey)) {
          const startKey = keyOf(absOf(cutoffKey) - 59);
          const pr = await pull({
            window: {
              kind: "preset",
              projection: { start: firstDay(startKey), end: lastDay(cutoffKey) },
            },
          });
          if (pr.ok) {
            actuals = {
              pl: pr.body?.metrics?.proj_pl || null,
              bs: pr.body?.metrics?.proj_bs || null,
              cf: pr.body?.metrics?.proj_cf || null,
            };
          }
        }

        projection = {
          scenario_name: sc?.name || null,
          forecast_name: forecast?.name || null,
          opening_period: forecast?.opening_period || null,
          horizon_months: forecast?.horizon_months || null,
          actuals_through: link.actuals_through,
          rows,
          overrides: overrideRows || [],
          actuals,
        };
      }
    }

    // The chart of accounts, so the portal can map its own P&L lines onto the
    // same statement categories staff see. The client's own nominal codes, and
    // only where a grant implies they should be reading account-level detail.
    let accounts: unknown[] = [];
    if (grant.show_pl || grant.show_underlying || grant.show_projection) {
      const ar = await pull({ metrics: ["accounts"] });
      accounts = (ar.body?.metrics?.accounts?.accounts || []).map((a: any) => ({
        id: a.id, acct_num: a.acct_num, name: a.name, fq_name: a.fq_name,
        type: a.type, classification: a.classification,
      }));
    }

    // Best effort — a failed stamp must never cost the client their figures.
    sb.from("client_dashboard_access")
      .update({ last_viewed_at: new Date().toISOString() })
      .eq("id", grant.id)
      .then(() => {}, () => {});

    return jr({
      success: true,
      entity_id: entityId,
      company_name: conn.company_name,
      grain, basis,
      anchor: anchorKey,
      window: { start: win.chartStart, end: win.chartEnd, latest_end: win.latestEndKey },
      fiscal_year_start_month: fyIdx + 1,
      sections: {
        overview: grant.show_overview,
        pl: grant.show_pl,
        balance: grant.show_balance,
        underlying: grant.show_underlying,
        projection: grant.show_projection,
      },
      metrics: { detail, bs },
      owner_account_ids: ownerAccountIds,
      oneoffs,
      accounts,
      projection,
      pulled_at: pulled?.pulled_at || null,
    });
  } catch (err) {
    return jr({ success: false, error: (err as Error).message }, 500);
  }
});
