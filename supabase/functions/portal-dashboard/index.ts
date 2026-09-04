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
//   3. Bounds WHEN. The caller may now name a date range, and every date it
//      sends is clamped here. It still cannot name another company, a realm id
//      or a metric.
//
// WHY (3) CHANGED. The first version of this function chose the dates itself and
// took only a grain and a basis, on the reasoning that a client naming its own
// window was one more thing to defend. That turned out to defend the wrong
// thing. The window was never what kept a client inside their own books — the
// realm is resolved from the GRANT, and always was — so all the fixed window
// actually achieved was a client who could not ask "what did last April look
// like?" about their own company. What matters is that a range is bounded, so
// nobody can ask QuickBooks for forty years by the month, and that is a clamp,
// not a prohibition: see `clampRange`.
//
// The figures themselves come from dashboard-qbo-pull, called server-side with
// the service key, so there is exactly one implementation of every QuickBooks
// report and a client can never be shown a number derived differently from the
// one staff read.
//
// WHAT GOES OUT. Statement REPORT TREES do now, which they did not before: the
// client's P&L and balance sheet expand to account level on their own dashboard,
// the same as ours, and that needs the tree. The tree is the client's own
// nominal ledger, so this is their data reaching them. What stays in are our
// working notes ABOUT their file — the bookkeeping-drift scores, the file-health
// signals, the owner-cost tagging (unless `show_underlying` is granted, which is
// the flag that says "they know we classify some of their spending as personal")
// and any custom report nobody has marked client-visible. Every field that
// leaves is named explicitly below rather than spread from the pull, so a metric
// added to dashboard-qbo-pull tomorrow does not reach a client by default.
//
// Practice books are refused outright, twice: here by is_practice, and again in
// dashboard-qbo-pull, where a service caller has no staff profile and so never
// clears the practice-financials guard.
//
// One extra caller: staff holding can_manage_portal may pass `previewEmail` to
// resolve somebody ELSE'S grant and get back the payload that person would get.
// That is how the Client access tab shows what a client will see before the
// access is issued. It runs the same path with the same redactions, so the
// preview cannot drift from the real page; it grants no data that flag did not
// already imply; and it does not stamp last_viewed_at, because that field has
// to mean the client looked.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// How stale a cached figure may be before the client's page triggers a live
// pull. Twelve hours: a client looking twice in a morning gets the cache, and
// nobody's bookkeeping moves fast enough for that to mislead.
const MAX_AGE_MIN = 12 * 60;

// The furthest back a client may look, and the longest range they may ask for,
// both in months. Five years covers every statutory comparative anybody needs
// and bounds the QuickBooks work: a monthly P&L over the maximum span is 62
// columns, which is one report.
const MAX_MONTHS_BACK = 62;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function jr(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...cors } });
}

/* ── Bucket maths (mirror of src/modules/client-dashboard/overviewGrain.js) ──
   The Overview's columns are still derived here rather than taken from the
   caller, because they are counted BACK from the period end by a rule (a
   fiscal year END month is the month before the QBO fiscal-year START month,
   quarters close on the year end and every third month back from it, and only
   COMPLETE buckets are ever returned) and the two implementations have to
   agree about what "Q3" means. */
const GRAIN_MONTHS: Record<string, number> = { month: 1, quarter: 3, year: 12 };
const GRAIN_COUNT: Record<string, number> = { month: 12, quarter: 8, year: 5 };

const absOf = (key: string) => {
  const [y, m] = key.split("-").map(Number);
  return y * 12 + (m - 1);
};
const keyOf = (abs: number) => `${Math.floor(abs / 12)}-${String((abs % 12) + 1).padStart(2, "0")}`;
const monthIdx = (abs: number) => abs % 12;
const firstDay = (key: string) => `${key}-01`;
const daysIn = (key: string) => {
  const [y, m] = key.split("-").map(Number);
  return new Date(y, m, 0).getDate();
};
const lastDay = (key: string) => `${key}-${String(daysIn(key)).padStart(2, "0")}`;

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const isoAbs = (d: string) => absOf(d.slice(0, 7));

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
    latestEndKey: keyOf(lastEnd),
  };
}

// Today, in the server's UTC reckoning. Nothing may be dated later: a client
// asking for next quarter's P&L would get an empty report and read it as a
// collapse in trade.
const todayIso = () => new Date().toISOString().slice(0, 10);

/*
  Shift a yyyy-mm-dd back `n` months — mirror of dashboardData.shiftMonthsBack.

  A date sitting on the LAST day of its month stays on the last day of the month
  it lands in: 31 Aug back six months is 28 Feb, not a "31 Feb" that rolls into
  March. Anything else keeps its day number, clamped to the target month.
*/
function shiftMonthsBack(isoDate: string, n: number): string {
  if (!ISO.test(isoDate) || !n) return isoDate;
  const key = isoDate.slice(0, 7);
  const day = Number(isoDate.slice(8, 10));
  const target = keyOf(absOf(key) - n);
  const len = daysIn(target);
  const onMonthEnd = day === daysIn(key);
  return `${target}-${String(onMonthEnd ? len : Math.min(day, len)).padStart(2, "0")}`;
}

/*
  clampRange / clampDate — the whole of what "the caller may name dates" means.

  A range is refused only by being narrowed. Anything unparseable falls back to
  the caller-independent default the first version of this function computed,
  so a malformed body shows a dashboard rather than an error.
*/
function clampDate(v: unknown, fallback: string): string {
  if (typeof v !== "string" || !ISO.test(v)) return fallback;
  const today = todayIso();
  if (v > today) return today;
  const floor = shiftMonthsBack(today, MAX_MONTHS_BACK);
  return v < floor ? floor : v;
}

function clampRange(rawStart: unknown, rawEnd: unknown, fallback: { start: string; end: string }) {
  const end = clampDate(rawEnd, fallback.end);
  let start = clampDate(rawStart, fallback.start);
  if (start > end) start = end;
  // Cap the SPAN as well as the reach: a range inside the five-year floor can
  // still be five years long, and that is fine, but it cannot be longer.
  if (isoAbs(end) - isoAbs(start) > MAX_MONTHS_BACK) {
    start = firstDay(keyOf(isoAbs(end) - MAX_MONTHS_BACK));
  }
  return { start, end };
}

// Comparative offsets. Mirror of dashboardData.COMPARATIVES — `trend` is not a
// comparative at all but the period-by-period table, so it has no offset.
const CMP_MONTHS: Record<string, number | null> = {
  m1: 1, m3: 3, m6: 6, m12: 12, trend: null,
};
const cmpMonthsFor = (v: unknown) => {
  const k = String(v ?? "m12");
  return k in CMP_MONTHS ? CMP_MONTHS[k] : 12;
};

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

    /*
      PREVIEW. Staff who administer portal access need to see exactly what they
      are about to give somebody, before they give it. `previewEmail` resolves
      THAT person's grant instead of the caller's and returns the identical
      payload — same filtering, same section flags, same redactions — so the
      preview cannot drift from the real thing the way a mock would.

      It grants no new data: can_manage_portal already implies full sight of the
      client. The check is deliberately strict (active staff AND the flag), the
      resolved grant is still the CLIENT'S, and the response is marked so the UI
      can never present a preview as though it were the staff's own view.
    */
    const previewEmail = typeof body.previewEmail === "string" ? body.previewEmail.trim() : "";
    let grantEmail = user.email;
    if (previewEmail) {
      const { data: staff } = await sb
        .from("staff_profiles")
        .select("is_active, can_manage_portal")
        .eq("id", user.id)
        .maybeSingle();
      if (!staff?.is_active || !staff?.can_manage_portal) {
        return jr({ success: false, error: "Not authorised" }, 403);
      }
      grantEmail = previewEmail;
    }

    // 2. WHAT. The grant is the whole authority — an entity_memberships row (the
    //    onboarding portal's link) grants nothing here.
    const { data: grant } = await sb
      .from("client_dashboard_access")
      .select("*")
      .eq("entity_id", entityId)
      .ilike("email", grantEmail)
      .is("revoked_at", null)
      .maybeSingle();
    if (!grant) return jr({ success: false, error: "Not authorised" }, 403);

    const { data: conn } = await sb
      .from("qbo_report_connections")
      .select("realm_id, company_name, is_practice, status, fiscal_year_end_month")
      .eq("entity_id", entityId)
      .eq("status", "active")
      .maybeSingle();
    if (!conn?.realm_id) return jr({ success: false, error: "No live QuickBooks connection for this client" }, 404);
    if (conn.is_practice) return jr({ success: false, error: "Not authorised" }, 403);
    const realmId = conn.realm_id;

    // The fiscal year end — never from the caller. Staff override, then
    // BrightManager's own year end, then QuickBooks' setting, then the flagged
    // fallback. Same order as the staff dashboard's resolveFiscalYear, because
    // a client and their accountant reading "Q3" have to mean the same three
    // months. v_client_year_end (sql/247) resolves the first two.
    const { data: companyRow } = await sb
      .from("qbo_dashboard_cache")
      .select("data")
      .eq("realm_id", realmId).eq("metric_key", "company")
      .order("pulled_at", { ascending: false }).limit(1).maybeSingle();

    const { data: yearEnd } = await sb
      .from("v_client_year_end")
      .select("month")
      .eq("realm_id", realmId)
      .maybeSingle();

    const resolvedEnd = Number(yearEnd?.month ?? conn.fiscal_year_end_month);
    const fyIdx = (resolvedEnd >= 1 && resolvedEnd <= 12)
      ? resolvedEnd % 12                       // year ends month N ⇒ starts N+1
      : fyStartMonthIndex(companyRow?.data?.fiscal_year_start_month);

    // 3. WHEN. Grain and basis still decide the Overview's columns; the period
    //    and the as-at date now come from the caller, clamped.
    const grain = ["month", "quarter", "year"].includes(body.grain) ? body.grain : "month";
    const basis = body.basis === "calendar" ? "calendar" : "fiscal";

    // The default period, used when the caller sends none and as the fallback
    // for anything it sends that will not parse: the last twelve complete
    // months, which is what the first version of this function always returned.
    const lastCompleteKey = keyOf(absOf(todayIso().slice(0, 7)) - 1);
    const defaultPeriod = {
      start: firstDay(keyOf(absOf(lastCompleteKey) - 11)),
      end: lastDay(lastCompleteKey),
    };
    const period = clampRange(body.period?.start, body.period?.end, defaultPeriod);

    // The prior period — the same LENGTH of time immediately before, which is
    // what the Overview's vs-previous deltas compare against.
    const periodMonths = Math.max(1, isoAbs(period.end) - isoAbs(period.start) + 1);
    const prior = {
      start: shiftMonthsBack(period.start, periodMonths),
      end: shiftMonthsBack(period.end, periodMonths),
    };

    // The as-at date for the balance sheet and the aged ledgers. Its own
    // control, because a position and a flow are chosen separately.
    const asAtDate = clampDate(body.asAt?.date, lastDay(lastCompleteKey));

    // The Overview's bucket columns, counted back from the period end.
    const win = buildWindow(grain, basis, fyIdx, period.end.slice(0, 7));

    // Comparatives. A P&L is a FLOW, so its comparative is the same length of
    // time ending earlier; a balance sheet is a POSITION, so its comparative is
    // the same date earlier. Keeping that distinction in one place is what stops
    // a year of closing cash being added up, or a single day being set against
    // a year, and reaching a column heading.
    const plCmp = cmpMonthsFor(body.plCompare);
    const bsCmp = cmpMonthsFor(body.bsCompare);
    const plCmpRange = plCmp
      ? { start: shiftMonthsBack(period.start, plCmp), end: shiftMonthsBack(period.end, plCmp) }
      : null;
    const bsCmpDate = bsCmp ? shiftMonthsBack(asAtDate, bsCmp) : null;

    // A custom range is pulled live and never cached, the same rule the staff
    // dashboard follows: a cache keyed on one person's ad-hoc window fills up
    // with rows nobody asks for twice.
    const isPreset = body.period?.preset !== false;

    // Which as-at reports are worth a QuickBooks call at all.
    const wantsBs = !!grant.show_balance || !!grant.show_overview;
    const wantsAr = !!grant.show_debtors;
    const wantsAp = !!grant.show_creditors;

    const pullBody: Record<string, unknown> = {
      window: {
        kind: isPreset ? "preset" : "custom",
        period: {
          plStart: period.start, plEnd: period.end,
          priorStart: prior.start, priorEnd: prior.end,
          chartStart: win.chartStart, chartEnd: win.chartEnd,
          chartDetail: true,
          bsAsAt: asAtDate,
          ...(plCmpRange ? { cmpStart: plCmpRange.start, cmpEnd: plCmpRange.end } : {}),
        },
        ...(wantsBs || wantsAr || wantsAp
          ? {
              asat: {
                date: asAtDate,
                ...(grant.show_balance && !bsCmp ? { gridStart: win.chartStart } : {}),
                ...(grant.show_balance && bsCmpDate ? { cmpDate: bsCmpDate } : {}),
              },
            }
          : {}),
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

    /* 4. What goes out. Every field is named. */
    const m = pulled?.metrics || {};

    const detail = m.pnl_chart_detail
      ? {
          period: m.pnl_chart_detail.period,
          currency: m.pnl_chart_detail.currency,
          months: m.pnl_chart_detail.months,
          month_keys: m.pnl_chart_detail.month_keys,
          series: m.pnl_chart_detail.series,
          // Account rows only where the underlying view is switched on — they
          // are what makes owner-cost stripping possible, and stripping is the
          // thing that flag is about.
          rows: grant.show_underlying ? m.pnl_chart_detail.rows : undefined,
        }
      : null;

    // A statement, as the client's own dashboard renders it: the headline
    // figures plus the report tree the rows expand from.
    const statement = (s: any) => (s
      ? {
          period: s.period,
          currency: s.currency,
          income: s.income, cogs: s.cogs, gross_profit: s.gross_profit,
          expenses: s.expenses, net_income: s.net_income,
          months: s.months, series: s.series,
          report: s.report || null,
        }
      : null);

    const balanceFigures = (s: any) => (s
      ? {
          period: s.period,
          currency: s.currency,
          cash: s.cash,
          debtors: s.debtors,
          accounts_payable: s.accounts_payable,
          creditors_within_1yr: s.creditors_within_1yr,
          creditors_after_1yr: s.creditors_after_1yr,
          current_assets: s.current_assets,
          current_liabilities: s.current_liabilities,
          fixed_assets: s.fixed_assets,
          total_assets: s.total_assets,
          total_liabilities: s.total_liabilities,
          net_assets: s.net_assets,
          equity: s.equity,
          prev: s.prev
            ? {
                cash: s.prev.cash, debtors: s.prev.debtors,
                accounts_payable: s.prev.accounts_payable,
                creditors_within_1yr: s.prev.creditors_within_1yr,
              }
            : null,
        }
      : null);

    const aged = (s: any) => (s
      ? {
          period: s.period,
          currency: s.currency,
          buckets: s.buckets,
          top: s.top,
          same_clients: s.same_clients,
        }
      : null);

    const metrics: Record<string, unknown> = {
      detail,
      // Overview tiles read the same as-at position the statements do.
      bs: balanceFigures(m.bs_period),
    };

    if (grant.show_pl) {
      metrics.pl_range = statement(m.pl_range);
      if (m.pl_compare) metrics.pl_compare = statement(m.pl_compare);
    }
    if (grant.show_balance) {
      const bsa = m.bs_asat || m.bs_period;
      metrics.bs_asat = bsa
        ? { ...balanceFigures(bsa), comparatives: bsa.comparatives, report: bsa.report || null }
        : null;
      if (m.bs_compare) {
        metrics.bs_compare = { ...balanceFigures(m.bs_compare), report: m.bs_compare.report || null };
      }
      if (m.bs_grid) metrics.bs_grid = m.bs_grid;
    }
    if (wantsAr) metrics.ar_asat = aged(m.ar_asat);
    if (wantsAp) metrics.ap_asat = aged(m.ap_asat);

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

    /*
      KPIs. The definitions come from kpi_definitions_for_entity, which is the
      only place that resolves "sector pack + bespoke − hidden" — the portal
      does not re-implement that rule any more than the staff tab does. The
      figures are small (one client, a handful of KPIs, a few years of months),
      but the ceiling is explicit because PostgREST silently caps a select at
      about a thousand rows and a truncated KPI history would look like a
      business that stopped measuring.

      What is NOT sent: the hidden-override list (a staff concept — the point of
      a hidden KPI is that it is absent) and the sector catalogue.
    */
    let kpis: Record<string, unknown> | null = null;
    if (grant.show_kpis) {
      const [{ data: defs }, { data: dims }, { data: vals }] = await Promise.all([
        sb.rpc("kpi_definitions_for_entity", { p_entity_id: entityId }),
        sb.from("kpi_dimension_value").select("*").eq("entity_id", entityId).order("sort_order"),
        sb.from("kpi_value").select("*").eq("entity_id", entityId).limit(20000),
      ]);
      kpis = {
        definitions: defs || [],
        dimension_values: dims || [],
        values: vals || [],
      };
    }

    /*
      Custom reports. TWO flags have to agree: `show_reports` on the grant says
      this person may see custom reports at all, and `is_client_visible` on the
      report says this one is finished enough to be seen. Most reports start as
      a staff working paper, so building one must never publish it.
    */
    let reports: unknown[] = [];
    if (grant.show_reports) {
      const { data: rs } = await sb
        .from("dashboard_report")
        .select("id, name, description, layout, sector_id, entity_id, sort_order")
        .eq("is_client_visible", true)
        .or(`entity_id.eq.${entityId},entity_id.is.null`)
        .order("sort_order");
      reports = rs || [];
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
    // A staff preview does NOT stamp it: "last viewed" has to mean the client
    // looked, or it is worse than not recording it at all.
    if (!previewEmail) {
      sb.from("client_dashboard_access")
        .update({ last_viewed_at: new Date().toISOString() })
        .eq("id", grant.id)
        .then(() => {}, () => {});
    }

    return jr({
      success: true,
      preview: !!previewEmail,
      preview_email: previewEmail || undefined,
      entity_id: entityId,
      company_name: conn.company_name,
      grain, basis,
      period,
      prior,
      as_at: { date: asAtDate },
      pl_compare: body.plCompare ?? "m12",
      bs_compare: body.bsCompare ?? "m12",
      pl_compare_range: plCmpRange,
      bs_compare_date: bsCmpDate,
      // The Overview's bucket window, and how far back a client may ask.
      window: { start: win.chartStart, end: win.chartEnd, latest_end: win.latestEndKey },
      limits: { max_months_back: MAX_MONTHS_BACK, earliest: shiftMonthsBack(todayIso(), MAX_MONTHS_BACK), latest: todayIso() },
      fiscal_year_start_month: fyIdx + 1,
      sections: {
        overview: grant.show_overview,
        pl: grant.show_pl,
        balance: grant.show_balance,
        underlying: grant.show_underlying,
        projection: grant.show_projection,
        debtors: grant.show_debtors,
        creditors: grant.show_creditors,
        kpis: grant.show_kpis,
        reports: grant.show_reports,
      },
      metrics,
      kpis,
      reports,
      owner_account_ids: ownerAccountIds,
      oneoffs,
      accounts,
      projection,
      pulled_at: pulled?.pulled_at || null,
      errors: pulled?.errors || undefined,
    });
  } catch (err) {
    return jr({ success: false, error: (err as Error).message }, 500);
  }
});
