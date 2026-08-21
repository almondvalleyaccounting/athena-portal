import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  RefreshCw, AlertCircle, CheckCircle, Loader,
  Link2Off, Plus, X, Star, ChevronDown, ChevronRight, Eye,
} from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { getReportsAuthUrl } from '../../lib/qboApi';
import { useAuth } from '../../shell/AppShell';
import {
  money, moneyCompact, timeAgo, shortDate, shortMonth,
  latestByMetric, parseReportTree, reportMonthKeys, bucketReportTree,
  PERIOD_PRESETS, ASAT_PRESETS, computePeriod, computeAsAt,
  OUTFIT, PLAYFAIR, cardStyle, inputStyle,
} from './dashboardData';
import { LoadingCard, EmptyState, MetricTile } from './DashboardUI';
import {
  buildBuckets, monthKeyOfDate, resolveFiscalYear, aggregate, seriesFor, windowLabel,
} from './overviewGrain';
import { useUnderlyingConfig } from './useUnderlyingConfig';
import OverviewTab from './OverviewTab';
import UnderlyingPerformanceTab from './UnderlyingPerformanceTab';
import ProjectionTab from './ProjectionTab';
import ClientViewPreview from './ClientViewPreview';
import ViewBar from './ViewBar';
import KpiTab from './KpiTab';
import ReportsTab from './ReportsTab';
import { useKpiData } from './useKpiData';
import { buildKpiModel } from './kpiEngine';

/*
  Client Dashboard v2 — multi-tab reporting tool over the client's QuickBooks.

  Two independent date filters live in the left rail, contextual to the active
  tab (see FilterRail):
    • PERIOD  → Overview + P&L. A date range (default: last full 12 months).
      The P&L tab reports the range itself. The OVERVIEW treats it as an end
      point only: its own grain / basis / view toggles (see OverviewTab and
      overviewGrain.js) decide how wide a bucket is and where the boundaries
      fall, and the buckets are counted back from the last one that closes on
      or before this date.
    • AS-AT   → Balance Sheet + Debtors & Creditors. A single point in time
      (default: last month end).

  The Projection tab sets its own timeline from a linked Client Forecast
  scenario and an actuals cut-off, so neither rail filter applies to it.

  Filtered figures come from dashboard-qbo-pull's windowed mode (live pull;
  presets cached by date range, custom ranges never stored). The default full
  pull (load) still runs to keep the company record, the reconnect banner and
  the Portfolio/Home shared cache fresh.

  Bookkeeping health used to be a tab here. It lives in the Work module now,
  built out far beyond what this page showed, and it is an internal judgement
  about the file rather than a report on the business — which also makes it the
  wrong thing to have sitting next to a view a client can be given.
*/

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'pnl', label: 'P&L' },
  { id: 'underlying', label: 'Underlying Performance' },
  { id: 'balance', label: 'Balance Sheet' },
  { id: 'debtors', label: 'Debtors' },
  { id: 'creditors', label: 'Creditors' },
  { id: 'projection', label: 'Projection' },
  { id: 'kpis', label: 'KPIs' },
  { id: 'reports', label: 'Reports' },
];
const PERIOD_TABS = new Set(['overview', 'pnl', 'underlying', 'kpis', 'reports']);
const ASAT_TABS = new Set(['balance', 'debtors', 'creditors']);

// The Overview toggles are a working preference, not client data — remembering
// them means someone who thinks in fiscal quarters isn't re-picking them on
// every client they open.
const PREF_KEY = 'ava_dash_overview_prefs';
const loadPrefs = () => {
  try { return JSON.parse(localStorage.getItem(PREF_KEY) || '{}') || {}; } catch { return {}; }
};

/* ─── Page ─────────────────────────────────────────────────────── */
export default function ClientDashboardPage() {
  const { profile } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const [clients, setClients] = useState([]);
  const [clientsLoading, setClientsLoading] = useState(true);
  const [realmId, setRealmId] = useState('');
  const [cacheRows, setCacheRows] = useState([]);
  const [fnErrors, setFnErrors] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [flash, setFlash] = useState(null);
  const [tab, setTab] = useState('overview');
  const [favourites, setFavourites] = useState(new Set());

  // Date-filter state.
  const today = useMemo(() => new Date(), []);
  const [periodKey, setPeriodKey] = useState('last12full');
  const [asAtKey, setAsAtKey] = useState('lastMonthEnd');
  const [customPeriod, setCustomPeriod] = useState({ start: '', end: '' });
  const [customAsAt, setCustomAsAt] = useState({ date: '' });

  // Overview grain / basis / view. These drive the whole Overview tab: the
  // period picker above only sets where the buckets END.
  const [grain, setGrain] = useState(() => loadPrefs().grain || 'month');
  const [basis, setBasis] = useState(() => loadPrefs().basis || 'fiscal');
  const [view, setView] = useState(() => loadPrefs().view || 'reported');
  useEffect(() => {
    try { localStorage.setItem(PREF_KEY, JSON.stringify({ grain, basis, view })); } catch { /* private mode */ }
  }, [grain, basis, view]);

  // Windowed (filtered) data.
  const [periodData, setPeriodData] = useState(null); // { pl_range, pl_range_prior, pnl_chart_detail, bs_period }
  const [asAtData, setAsAtData] = useState(null);      // { bs_asat, ar_asat, ap_asat }
  const [periodLoading, setPeriodLoading] = useState(false);
  const [asAtLoading, setAsAtLoading] = useState(false);
  const asAtLoadedRef = useRef(null);

  // Owner-cost / one-off config, held once for the whole page — the Overview
  // and Underlying tabs both read it and must not diverge.
  const underlyingConfig = useUnderlyingConfig(realmId);

  // KPI configuration and figures, likewise held once: the Overview tiles, the
  // KPI tab and any report all read this one copy.
  const selectedEntityId = clients.find((c) => c.realm_id === realmId)?.entity_id || null;
  const kpi = useKpiData(selectedEntityId);

  // Live dashboard grants, so the rail can offer "see this as the client does".
  // The RPC is gated on can_manage_portal; anyone else gets nothing back and
  // simply never sees the button.
  const [grants, setGrants] = useState([]);
  const [previewGrantId, setPreviewGrantId] = useState(null);
  useEffect(() => {
    (async () => {
      try {
        const { data } = await supabase.rpc('list_dashboard_access');
        setGrants((data || []).filter((g) => !g.revoked_at));
      } catch { setGrants([]); }
    })();
  }, []);

  const loadClients = async () => {
    try {
      // v_client_year_end resolves the override and BrightManager's own year end
      // (sql/247). Merged in here so the Overview does not have to ask per
      // client, and so both come from the one place that knows the rule.
      const [{ data, error }, { data: yearEnds }] = await Promise.all([
        supabase
          .from('qbo_report_connections')
          .select('realm_id, company_name, entity_id, fiscal_year_end_month')
          .eq('status', 'active')
          .order('company_name'),
        supabase.from('v_client_year_end').select('realm_id, month, source'),
      ]);
      if (!error && data) {
        const ye = {};
        for (const y of yearEnds || []) ye[y.realm_id] = y;
        setClients(data.map((c) => ({
          ...c,
          derived_year_end_month: ye[c.realm_id]?.month ?? null,
          derived_year_end_source: ye[c.realm_id]?.source ?? null,
        })));
      }
    } catch { /* silent */ }
    setClientsLoading(false);
  };

  const loadFavourites = async () => {
    if (!profile?.id) return;
    try {
      const { data } = await supabase
        .from('staff_client_favourites')
        .select('realm_id')
        .eq('staff_id', profile.id);
      setFavourites(new Set((data || []).map((r) => r.realm_id).filter(Boolean)));
    } catch { /* silent */ }
  };

  useEffect(() => { loadClients(); }, []);
  useEffect(() => { loadFavourites(); }, [profile?.id]);

  // Handle the OAuth return (?qbo=connected|error) after a Connect round-trip.
  useEffect(() => {
    const qbo = searchParams.get('qbo');
    if (qbo === 'connected') {
      setFlash({ type: 'success', message: 'Client connected. Select them to pull live figures.' });
      loadClients();
    } else if (qbo === 'error') {
      setFlash({ type: 'error', message: searchParams.get('message') || 'Connection failed.' });
    }
    if (qbo) {
      searchParams.delete('qbo');
      searchParams.delete('message');
      setSearchParams(searchParams, { replace: true });
    }
  }, []);

  // Deep links. ?realm= from the portfolio cards and the home-screen Practice
  // Pulse; ?entity= from the KPI outstanding list, which thinks in clients
  // rather than QuickBooks realms.
  useEffect(() => {
    if (clientsLoading) return;
    const r = searchParams.get('realm');
    const e = searchParams.get('entity');
    const t = searchParams.get('tab');
    const target = r && clients.some((c) => c.realm_id === r)
      ? r
      : (e ? clients.find((c) => c.entity_id === e)?.realm_id : null);
    if (target) {
      searchParams.delete('realm');
      searchParams.delete('entity');
      searchParams.delete('tab');
      setSearchParams(searchParams, { replace: true });
      onSelect(target);
      if (t && TABS.some((x) => x.id === t)) setTab(t);
    }
  }, [clientsLoading]);

  const handleConnect = async () => {
    // getReportsAuthUrl now round-trips through qbo-auth so the OAuth state is signed
    // against this session, which means it can fail.
    try {
      window.location.href = await getReportsAuthUrl('/client-dashboard');
    } catch (err) {
      alert(err.message || 'Could not start the QuickBooks connection.');
    }
  };

  // Default full pull — the company record for this page, and the shared cache
  // the Portfolio/Home read (which still includes file_health for the portfolio
  // cards, even though this page no longer renders it). Best effort: dead tokens fail per-metric and
  // we still render from cache.
  const load = async (realm, refresh = false) => {
    if (!realm) return;
    setLoading(true);
    setError(null);
    setFnErrors(null);
    try {
      const { data: payload, error: fnErr } = await supabase.functions.invoke('dashboard-qbo-pull', {
        body: { realmId: realm, refresh },
      });
      if (fnErr) setError(fnErr.message || 'Request failed');
      else setFnErrors(payload?.errors || null);
    } catch (e) {
      setError(e.message || 'Request failed');
    }
    try {
      const { data: rows } = await supabase
        .from('qbo_dashboard_cache')
        .select('metric_key, period_start, period_end, data, pulled_at')
        .eq('realm_id', realm)
        .in('metric_key', ['company', 'pl_fytd', 'pl_summary', 'balances', 'pnl_monthly', 'aged_receivables'])
        .order('pulled_at', { ascending: false })
        .limit(200);
      setCacheRows(rows || []);
    } catch {
      setCacheRows([]);
    }
    setLoading(false);
  };

  const onSelect = (realm) => {
    setRealmId(realm);
    setCacheRows([]);
    setPeriodData(null);
    setAsAtData(null);
    asAtLoadedRef.current = null;
    setError(null);
    setFnErrors(null);
    setTab('overview');
    if (realm) load(realm, false);
  };

  const selected = clients.find((c) => c.realm_id === realmId);
  const selectedName = selected?.company_name || '';
  const entityId = selected?.entity_id || null;
  const isFavourite = realmId ? favourites.has(realmId) : false;
  const clientGrants = useMemo(
    () => (entityId ? grants.filter((g) => g.entity_id === entityId) : []),
    [grants, entityId],
  );
  const previewGrant = useMemo(
    () => clientGrants.find((g) => g.id === previewGrantId) || null,
    [clientGrants, previewGrantId],
  );

  const toggleFavourite = async () => {
    if (!realmId || !profile?.id) return;
    const next = new Set(favourites);
    try {
      if (isFavourite) {
        next.delete(realmId);
        setFavourites(next);
        await supabase.from('staff_client_favourites').delete()
          .eq('staff_id', profile.id).eq('realm_id', realmId);
      } else {
        next.add(realmId);
        setFavourites(next);
        await supabase.from('staff_client_favourites')
          .insert({ staff_id: profile.id, realm_id: realmId, entity_id: entityId });
      }
    } catch { loadFavourites(); }
  };

  /* Derived: company / health from the default cache; fiscal year for presets */
  const latest = useMemo(() => latestByMetric(cacheRows), [cacheRows]);
  const company = latest.company?.data || null;
  // Staff override first, then QuickBooks, then a flagged fallback — see
  // resolveFiscalYear. QBO leaves FiscalYearStartMonth unset often enough that
  // trusting it alone would label the practice's own quarters as the client's.
  const fiscalYear = useMemo(
    () => resolveFiscalYear({
      overrideEndMonth: selected?.fiscal_year_end_month,
      bmEndMonth: selected?.derived_year_end_month,
      bmSource: selected?.derived_year_end_source,
      qboStartMonth: company?.fiscal_year_start_month,
    }),
    [selected?.fiscal_year_end_month, selected?.derived_year_end_month, selected?.derived_year_end_source, company],
  );
  const fyIdx = fiscalYear.fyIdx;

  // Saving the year end re-buckets everything, so it writes through to the
  // client list the page is already reading from.
  const setFiscalYearEnd = async (month) => {
    if (!realmId) return;
    const v = month ? Number(month) : null;
    setClients((prev) => prev.map((c) => (c.realm_id === realmId ? { ...c, fiscal_year_end_month: v } : c)));
    try {
      await supabase.from('qbo_report_connections')
        .update({ fiscal_year_end_month: v }).eq('realm_id', realmId);
    } catch { loadClients(); }
  };

  const period = useMemo(
    () => computePeriod(periodKey, today, fyIdx, customPeriod),
    [periodKey, today, fyIdx, customPeriod],
  );
  const asAt = useMemo(
    () => computeAsAt(asAtKey, today, fyIdx, customAsAt),
    [asAtKey, today, fyIdx, customAsAt],
  );

  /* Overview buckets — months / quarters / years, fiscal or calendar, counted
     back from the last one that CLOSES on or before the selected period end.
     The QBO chart window covers them all plus one prior bucket for the tile
     deltas, and the Overview's balance-sheet figures are pulled as at the
     LATEST bucket end rather than the raw period end, so the P&L and balance
     sheet on that tab always describe the same moment. */
  const overview = useMemo(
    () => buildBuckets({ grain, basis, anchorKey: (period.plEnd || '').slice(0, 7) || monthKeyOfDate(today), fyIdx }),
    [grain, basis, period.plEnd, fyIdx, today],
  );
  const chartStart = overview.window.start;
  const chartEnd = overview.window.end;
  const bsAsAt = overview.buckets[overview.buckets.length - 1]?.end || period.plEnd;

  /* The Balance Sheet is an as-at tab, so its comparative columns are counted
     back from the as-at date rather than the period end — but with the same
     grain and basis, so a fiscal quarter means the same thing on every tab. */
  const bsGrid = useMemo(
    () => buildBuckets({ grain, basis, anchorKey: (asAt.date || '').slice(0, 7) || monthKeyOfDate(today), fyIdx }),
    [grain, basis, asAt.date, fyIdx, today],
  );
  const bsGridStart = bsGrid.window.start;
  const windowNote = windowLabel(grain, basis, overview.buckets);

  /* One bar, rendered by whichever tab is open. Every tab that reports over
     time gets the same controls in the same place, and they keep their setting
     when you move between tabs — picking fiscal quarters on the Overview and
     finding the P&L back in calendar months is how a screen loses trust.
     Controls that would not change anything on a given tab are hidden rather
     than shown dead. */
  const viewBar = useCallback((opts = {}) => (
    <ViewBar
      grain={grain} setGrain={setGrain}
      basis={basis} setBasis={setBasis}
      view={view} setView={setView}
      fiscalYear={fiscalYear}
      onFiscalYearEndChange={setFiscalYearEnd}
      {...opts}
    />
  ), [grain, basis, view, fiscalYear, setFiscalYearEnd]);

  /* The financial figures a KPI formula may name (`income / children`), on
     exactly the buckets the Overview is showing. Computed here rather than
     inside each consumer so the tiles, the KPI tab and a report cannot end up
     dividing by three different notions of income. */
  const overviewRows = useMemo(() => {
    if (!periodData?.pnl_chart_detail || !overview.buckets.length) return [];
    return aggregate(periodData.pnl_chart_detail, [overview.prior, ...overview.buckets], {
      ownerAccountIds: underlyingConfig?.ownerAccountIds,
      accountsById: underlyingConfig?.accountsById,
      oneoffs: underlyingConfig?.oneoffs,
    }).slice(1);
  }, [periodData?.pnl_chart_detail, overview.buckets, overview.prior,
    underlyingConfig?.ownerAccountIds, underlyingConfig?.accountsById, underlyingConfig?.oneoffs]);

  const kpiFinancials = useCallback((bi, key) => {
    const bsp = periodData?.bs_period;
    // Balance-sheet figures are a position, not a flow, so they read the same
    // whichever bucket asks — the one as at the latest bucket end.
    if (key === 'cash') return bsp?.cash ?? null;
    if (key === 'debtors') return bsp?.debtors ?? null;
    if (key === 'creditors') return bsp?.accounts_payable ?? bsp?.creditors_within_1yr ?? null;
    const r = overviewRows[bi];
    if (!r) return null;
    const s = seriesFor(r, view);
    if (key === 'income') return s.income;
    if (key === 'net_income') return s.net_income;
    return r[key] ?? null;
  }, [overviewRows, periodData?.bs_period, view]);

  // KPIs flagged for the Overview, rendered as tiles beside revenue and profit.
  const kpiTiles = useMemo(() => {
    if (!kpi.definitions.length || !overview.buckets.length) return [];
    const m = buildKpiModel({
      definitions: kpi.definitions,
      dimensionValues: kpi.dimensionValues,
      values: kpi.values,
      buckets: overview.buckets,
      financials: kpiFinancials,
    });
    return m.rows.filter((r) => r.definition.show_on_overview);
  }, [kpi.definitions, kpi.dimensionValues, kpi.values, overview.buckets, kpiFinancials]);

  /* Windowed pulls ------------------------------------------------ */
  const fetchPeriod = useCallback(async (refresh = false) => {
    if (!realmId) return;
    setPeriodLoading(true);
    try {
      const { data: payload, error: fnErr } = await supabase.functions.invoke('dashboard-qbo-pull', {
        body: {
          realmId, refresh,
          window: {
            kind: periodKey === 'custom' ? 'custom' : 'preset',
            period: {
              plStart: period.plStart, plEnd: period.plEnd,
              priorStart: period.priorStart, priorEnd: period.priorEnd,
              chartStart, chartEnd, chartDetail: true,
              bsAsAt,
            },
          },
        },
      });
      if (!fnErr) setPeriodData(payload?.metrics || null);
    } catch { /* the reconnect banner is driven by the default pull */ }
    setPeriodLoading(false);
  }, [realmId, periodKey, period.plStart, period.plEnd, period.priorStart, period.priorEnd, chartStart, chartEnd, bsAsAt]);

  const fetchAsAt = useCallback(async (refresh = false) => {
    if (!realmId) return;
    setAsAtLoading(true);
    try {
      const { data: payload, error: fnErr } = await supabase.functions.invoke('dashboard-qbo-pull', {
        body: {
          realmId, refresh,
          window: {
            kind: asAtKey === 'custom' ? 'custom' : 'preset',
            asat: { date: asAt.date, gridStart: bsGridStart },
          },
        },
      });
      if (!fnErr) { setAsAtData(payload?.metrics || null); asAtLoadedRef.current = `${asAt.date}|${bsGridStart}`; }
    } catch { /* reconnect banner via the default pull */ }
    setAsAtLoading(false);
  }, [realmId, asAtKey, asAt.date, bsGridStart]);

  // Period data: fetch on select and whenever the period window changes.
  useEffect(() => { if (realmId) fetchPeriod(false); }, [fetchPeriod]);
  // As-at data: fetch lazily on first visit to a balance/aged tab, and when the
  // as-at window changes while one of those tabs is open.
  useEffect(() => {
    // Keyed on the grid window as well as the date: changing grain or basis
    // moves the comparative columns, which needs a different pull.
    const key = `${asAt.date}|${bsGridStart}`;
    if (realmId && ASAT_TABS.has(tab) && asAtLoadedRef.current !== key) fetchAsAt(false);
  }, [realmId, tab, asAt.date, bsGridStart, fetchAsAt]);

  const lastPulled = cacheRows.length ? cacheRows[0].pulled_at : null;
  const winBusy = periodLoading || asAtLoading;

  // A realm with no stored tokens → every metric errors with the same reconnect message.
  const errVals = fnErrors ? Object.values(fnErrors) : [];
  const needsReconnect = errVals.length > 0 && errVals.every((e) => /reconnect/i.test(e));
  const partialErrors = fnErrors && !needsReconnect ? fnErrors : null;
  const hasCache = cacheRows.length > 0;

  const pull = () => {
    load(realmId, true);
    if (PERIOD_TABS.has(tab)) fetchPeriod(true);
    if (ASAT_TABS.has(tab)) { asAtLoadedRef.current = null; fetchAsAt(true); }
  };
  const emptyProps = { needsReconnect, selectedName, onPull: pull, loading: winBusy || loading };

  const btnBase = {
    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px',
    border: '1px solid #e5e7eb', borderRadius: '10px', backgroundColor: '#ffffff',
    fontFamily: OUTFIT, fontSize: '13px', fontWeight: 600, color: '#38bdf8',
  };

  const periodCurrency = periodData?.pl_range?.currency || periodData?.pnl_chart?.currency || periodData?.bs_period?.currency || 'GBP';
  const asAtCurrency = asAtData?.bs_asat?.currency || asAtData?.ar_asat?.currency || asAtData?.ap_asat?.currency || 'GBP';

  return (
    // Fill the available width (laptop → PC → docked/external monitor); a wide
    // cap keeps line lengths sane on 4K without wasting space below it. Mobile
    // is intentionally not catered for.
    <div style={{ width: '100%', maxWidth: '2200px', margin: '0 auto', padding: '28px clamp(20px, 2.4vw, 48px) 40px' }}>
      <div style={{ display: 'flex', gap: 'clamp(24px, 2.4vw, 44px)', alignItems: 'flex-start' }}>
        {/* ── Left rail: title, client picker, actions, filters ── */}
        <div style={{
          width: '250px', flexShrink: 0, position: 'sticky', top: '20px',
          display: 'flex', flexDirection: 'column', gap: '12px',
        }}>
          <div>
            <h1 style={{ fontFamily: PLAYFAIR, fontSize: '22px', fontWeight: 500, color: '#0f172a', margin: '0 0 4px' }}>
              Client Dashboard
            </h1>
            <p style={{ fontFamily: OUTFIT, fontSize: '12px', color: '#64748b', margin: 0, lineHeight: 1.5 }}>
              Live QuickBooks figures. Star a client to pin them to your{' '}
              <a href="/portfolio" style={{ color: '#38bdf8', textDecoration: 'none', fontWeight: 600 }}>Portfolio</a>.
            </p>
          </div>

          <select
            value={realmId}
            onChange={(e) => onSelect(e.target.value)}
            disabled={clientsLoading}
            style={{ ...inputStyle, width: '100%', appearance: 'auto' }}
          >
            <option value="">{clientsLoading ? 'Loading clients…' : 'Select a client…'}</option>
            {clients.map((c) => (
              <option key={c.realm_id} value={c.realm_id}>{c.company_name}</option>
            ))}
          </select>

          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            {realmId && (
              <button
                onClick={toggleFavourite}
                title={isFavourite ? 'Remove from your Portfolio' : 'Star — add to your Portfolio'}
                style={{ ...btnBase, width: '42px', flexShrink: 0, padding: '9px 0' }}
              >
                <Star size={17} style={{ color: isFavourite ? '#f59e0b' : '#cbd5e1', fill: isFavourite ? '#f59e0b' : 'none' }} />
              </button>
            )}
            {realmId && (
              <button
                onClick={pull}
                disabled={loading || winBusy}
                title="Refresh from QuickBooks"
                style={{ ...btnBase, flex: '1 1 auto', padding: '9px 10px', cursor: (loading || winBusy) ? 'not-allowed' : 'pointer' }}
              >
                <RefreshCw size={14} style={(loading || winBusy) ? { animation: 'spin 1s linear infinite' } : {}} />
                Refresh
              </button>
            )}
            <button
              onClick={handleConnect}
              title="Connect a QuickBooks client"
              style={{ ...btnBase, flex: '1 1 auto', padding: '9px 10px', cursor: 'pointer' }}
            >
              <Plus size={14} /> Connect
            </button>
          </div>

          {/* Client view — the same figures as this page, as the client sees
              them. Sitting here rather than only on the admin screen is the
              point: you can read our version and theirs without losing your
              place. Only appears when somebody actually holds a grant. */}
          {clientGrants.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
              {clientGrants.map((g) => (
                <button
                  key={g.id}
                  onClick={() => setPreviewGrantId(g.id)}
                  title={`See exactly what ${g.email} sees`}
                  style={{
                    ...btnBase, padding: '9px 10px', cursor: 'pointer',
                    justifyContent: 'flex-start', color: '#0369a1',
                    backgroundColor: '#f0f9ff', borderColor: '#bae6fd',
                  }}
                >
                  <Eye size={14} />
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    Client view · {g.email}
                  </span>
                </button>
              ))}
            </div>
          )}

          {realmId && (
            <FilterRail
              tab={tab}
              periodKey={periodKey} setPeriodKey={setPeriodKey}
              asAtKey={asAtKey} setAsAtKey={setAsAtKey}
              customPeriod={customPeriod} setCustomPeriod={setCustomPeriod}
              customAsAt={customAsAt} setCustomAsAt={setCustomAsAt}
              period={period} asAt={asAt}
              busy={winBusy}
              lastPulled={lastPulled}
            />
          )}
        </div>

        {/* ── Right content ── */}
        <div style={{ flex: 1, minWidth: 0 }}>
          {/* Flash (OAuth return) */}
          {flash && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 14px',
              borderRadius: '10px', marginBottom: '16px',
              backgroundColor: flash.type === 'success' ? '#f0fdf4' : '#fef2f2',
              border: `1px solid ${flash.type === 'success' ? '#bbf7d0' : '#fecaca'}`,
            }}>
              {flash.type === 'success'
                ? <CheckCircle size={16} style={{ color: '#22c55e' }} />
                : <AlertCircle size={16} style={{ color: '#ef4444' }} />}
              <span style={{ fontFamily: OUTFIT, fontSize: '13px', fontWeight: 500, flex: 1, color: flash.type === 'success' ? '#166534' : '#991b1b' }}>
                {flash.message}
              </span>
              <button onClick={() => setFlash(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '2px' }}>
                <X size={14} style={{ color: '#94a3b8' }} />
              </button>
            </div>
          )}

          {/* Hard error (auth / network) */}
          {error && (
            <div style={{ ...cardStyle, backgroundColor: '#fef2f2', border: '1px solid #fecaca', marginBottom: '16px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: '#991b1b', fontFamily: OUTFIT, fontSize: '13px', fontWeight: 600 }}>
                <AlertCircle size={16} /> {error}
              </div>
            </div>
          )}

          {/* Reconnect banner — cached data (if any) still renders below */}
          {realmId && needsReconnect && (
            <div style={{ ...cardStyle, backgroundColor: '#fffbeb', border: '1px solid #fde68a', marginBottom: '16px', padding: '14px 18px' }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: '10px' }}>
                <Link2Off size={18} style={{ color: '#d97706', flexShrink: 0, marginTop: '1px' }} />
                <div>
                  <div style={{ fontFamily: OUTFIT, fontSize: '14px', fontWeight: 700, color: '#92400e', marginBottom: '2px' }}>
                    {selectedName} needs to reconnect QuickBooks
                  </div>
                  <div style={{ fontFamily: OUTFIT, fontSize: '13px', color: '#92400e' }}>
                    Live pulls are failing because no usable access tokens are stored for this client.
                    Reconnect them (Reports → Connect).
                    {hasCache ? ` Showing cached figures from ${timeAgo(lastPulled)}.` : ''}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* No client selected */}
          {!realmId && !clientsLoading && (
            <div style={{ ...cardStyle, textAlign: 'center', padding: '48px 24px' }}>
              <div style={{ fontFamily: OUTFIT, fontSize: '14px', color: '#64748b' }}>
                Select a connected client on the left to see their dashboard, or connect a new QuickBooks file.
              </div>
            </div>
          )}

          {realmId && (
            <>
              {/* Tabs */}
              <div style={{ display: 'flex', gap: '2px', borderBottom: '1px solid #e5e7eb', marginBottom: '20px', flexWrap: 'wrap' }}>
                {TABS.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => setTab(t.id)}
                    style={{
                      padding: '10px 16px', border: 'none', background: 'none', cursor: 'pointer',
                      fontFamily: OUTFIT, fontSize: '13.5px', fontWeight: tab === t.id ? 700 : 500,
                      color: tab === t.id ? '#0f172a' : '#64748b',
                      borderBottom: tab === t.id ? '2px solid #38bdf8' : '2px solid transparent',
                      marginBottom: '-1px',
                    }}
                  >
                    {t.label}
                  </button>
                ))}
              </div>

              {/* Tab body */}
              {tab === 'overview' && (
                <OverviewTab
                  detail={periodData?.pnl_chart_detail}
                  bs={periodData?.bs_period}
                  buckets={overview.buckets}
                  prior={overview.prior}
                  currency={periodCurrency}
                  loading={periodLoading} empty={emptyProps} goTab={setTab}
                  grain={grain} setGrain={setGrain}
                  basis={basis} setBasis={setBasis}
                  view={view} setView={setView}
                  fyIdx={fyIdx}
                  fiscalYear={fiscalYear}
                  onFiscalYearEndChange={setFiscalYearEnd}
                  config={underlyingConfig}
                  kpiTiles={kpiTiles}
                  goKpis={() => setTab('kpis')}
                  bar={viewBar({ note: windowNote })}
                />
              )}
              {tab === 'pnl' && (
                <PnlTab
                  pnlMonthly={periodData?.pl_range} buckets={overview.buckets}
                  currency={periodCurrency} loading={periodLoading} empty={emptyProps}
                  bar={viewBar({ showView: false, note: 'Underlying is on its own tab, where the bridge from reported is shown.' })}
                />
              )}
              {tab === 'underlying' && (
                <UnderlyingPerformanceTab
                  data={periodData} meta={period}
                  currency={periodCurrency} loading={periodLoading} empty={emptyProps}
                  config={underlyingConfig}
                  buckets={overview.buckets} prior={overview.prior}
                  detail={periodData?.pnl_chart_detail}
                  bar={viewBar({ showView: false, note: 'This tab is the underlying view — the toggle above would say the same thing twice.' })}
                />
              )}
              {tab === 'kpis' && (
                <KpiTab
                  entityId={entityId} clientName={selectedName} kpi={kpi}
                  buckets={overview.buckets} financials={kpiFinancials}
                  currency={periodCurrency}
                  canManagePacks={profile?.can_manage_kpi_packs === true}
                  bar={viewBar({ showView: false })}
                />
              )}
              {tab === 'reports' && (
                <ReportsTab
                  entityId={entityId} clientName={selectedName}
                  detail={periodData?.pnl_chart_detail} bs={periodData?.bs_period}
                  config={underlyingConfig} kpi={kpi} fyIdx={fyIdx}
                  currency={periodCurrency} sectorId={kpi.sectorId}
                  canManagePacks={profile?.can_manage_kpi_packs === true}
                />
              )}
              {tab === 'projection' && (
                <ProjectionTab
                  realmId={realmId} entityId={entityId} clientName={selectedName}
                  currency={periodCurrency} fyIdx={fyIdx}
                  grain={grain} setGrain={setGrain}
                  basis={basis} setBasis={setBasis}
                  config={underlyingConfig}
                  bar={viewBar({ showView: false })}
                />
              )}
              {tab === 'balance' && (
                <BalanceSheetTab
                  balanceSheet={asAtData?.bs_asat} grid={asAtData?.bs_grid}
                  buckets={bsGrid.buckets}
                  currency={asAtCurrency} loading={asAtLoading} empty={emptyProps}
                  bar={viewBar({ showView: false, note: 'Each column is the position at that period end.' })}
                />
              )}
              {tab === 'debtors' && (
                <AgedTab data={asAtData?.ar_asat} title="Aged debtors (receivables)" sameLabel="Same debtors"
                  label="aged debtors" currency={asAtCurrency} loading={asAtLoading} empty={emptyProps} />
              )}
              {tab === 'creditors' && (
                <AgedTab data={asAtData?.ap_asat} title="Aged creditors (payables)" sameLabel="Same suppliers"
                  label="aged creditors" currency={asAtCurrency} loading={asAtLoading} empty={emptyProps} />
              )}
              {/* Per-metric errors (partial pull) */}
              {partialErrors && (
                <div style={{ fontFamily: OUTFIT, fontSize: '12px', color: '#b45309', marginTop: '14px' }}>
                  Some figures couldn't be pulled: {Object.entries(partialErrors).map(([k, v]) => `${k} (${v})`).join('; ')}
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {previewGrant && (
        <ClientViewPreview row={previewGrant} onClose={() => setPreviewGrantId(null)} />
      )}

      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

/* ─── Filter rail (contextual date filters) ────────────────────── */
function FilterRail({
  tab, periodKey, setPeriodKey, asAtKey, setAsAtKey,
  customPeriod, setCustomPeriod, customAsAt, setCustomAsAt,
  period, asAt, busy, lastPulled,
}) {
  const isAsAt = ASAT_TABS.has(tab);
  const isPeriod = PERIOD_TABS.has(tab);

  const freshness = (
    <div style={{ fontFamily: OUTFIT, fontSize: '11px', color: '#94a3b8', display: 'flex', alignItems: 'center', gap: '6px', marginTop: '8px' }}>
      {busy && <Loader size={11} style={{ animation: 'spin 1s linear infinite' }} />}
      {busy ? 'Pulling…' : lastPulled ? `Last pulled ${timeAgo(lastPulled)}` : 'No cached data yet'}
    </div>
  );

  if (!isAsAt && !isPeriod) {
    return (
      <div style={{ borderTop: '1px solid #f1f5f9', paddingTop: '10px' }}>
        <div style={{ fontFamily: OUTFIT, fontSize: '12px', color: '#94a3b8', lineHeight: 1.5 }}>
          {tab === 'projection'
            ? 'The projection sets its own timeline — the linked scenario and the actuals cut-off.'
            : 'Bookkeeping health reflects the current state of the file.'}
        </div>
        {freshness}
      </div>
    );
  }

  const presets = isAsAt ? ASAT_PRESETS : PERIOD_PRESETS;
  const activeKey = isAsAt ? asAtKey : periodKey;
  const railLabel = isAsAt ? 'Balance date' : 'Period';

  const pick = (k) => {
    if (isAsAt) {
      if (k === 'custom' && !customAsAt.date) setCustomAsAt({ date: asAt.date });
      setAsAtKey(k);
    } else {
      if (k === 'custom' && !customPeriod.start) setCustomPeriod({ start: period.plStart, end: period.plEnd });
      setPeriodKey(k);
    }
  };

  const optBtn = (active) => ({
    textAlign: 'left', padding: '7px 10px', borderRadius: '8px', cursor: 'pointer',
    fontFamily: OUTFIT, fontSize: '12.5px', fontWeight: active ? 700 : 500,
    border: `1px solid ${active ? '#7dd3fc' : '#e5e7eb'}`,
    backgroundColor: active ? '#f0f9ff' : '#ffffff',
    color: active ? '#0369a1' : '#475569',
  });
  const dateInput = { ...inputStyle, padding: '7px 10px', fontSize: '12.5px', width: '100%' };

  return (
    <div style={{ borderTop: '1px solid #f1f5f9', paddingTop: '12px' }}>
      <div style={{ fontFamily: OUTFIT, fontSize: '11px', fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: '#94a3b8', marginBottom: '8px' }}>
        {railLabel}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
        {presets.map((p) => (
          <button key={p.key} onClick={() => pick(p.key)} style={optBtn(activeKey === p.key)}>
            {p.label}
          </button>
        ))}
      </div>

      {/* Custom entry */}
      {!isAsAt && periodKey === 'custom' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '8px' }}>
          <label style={{ fontFamily: OUTFIT, fontSize: '11px', color: '#94a3b8' }}>
            From
            <input type="date" value={customPeriod.start} max={customPeriod.end || undefined}
              onChange={(e) => setCustomPeriod((c) => ({ ...c, start: e.target.value }))} style={dateInput} />
          </label>
          <label style={{ fontFamily: OUTFIT, fontSize: '11px', color: '#94a3b8' }}>
            To
            <input type="date" value={customPeriod.end} min={customPeriod.start || undefined}
              onChange={(e) => setCustomPeriod((c) => ({ ...c, end: e.target.value }))} style={dateInput} />
          </label>
        </div>
      )}
      {isAsAt && asAtKey === 'custom' && (
        <div style={{ marginTop: '8px' }}>
          <label style={{ fontFamily: OUTFIT, fontSize: '11px', color: '#94a3b8' }}>
            As at
            <input type="date" value={customAsAt.date}
              onChange={(e) => setCustomAsAt({ date: e.target.value })} style={dateInput} />
          </label>
        </div>
      )}

      {/* Computed window summary */}
      <div style={{ fontFamily: OUTFIT, fontSize: '11px', color: '#64748b', marginTop: '10px', lineHeight: 1.5 }}>
        {isAsAt
          ? `Figures as at ${shortDate(asAt.date)}.`
          : `${shortDate(period.plStart)} → ${shortDate(period.plEnd)}.`}
        {!isAsAt && tab === 'overview' && ' Overview counts its buckets back from this end date.'}
      </div>
      {freshness}
    </div>
  );
}

/* ─── Expandable report table (P&L monthly / balance sheet) ────── */
function ReportTable({ columns, rows, monthLabels = true }) {
  const [expanded, setExpanded] = useState(() => new Set());
  const toggle = (id) => setExpanded((prev) => {
    const n = new Set(prev);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });

  const visible = [];
  const push = (node, depth) => {
    if (node.kind === 'section') {
      const open = expanded.has(node.id);
      const expandable = (node.children || []).length > 0;
      visible.push({ node, depth, open, expandable, kind: 'section' });
      if (open) {
        node.children.forEach((c) => push(c, depth + 1));
        if (node.totals) {
          visible.push({
            node: { id: `${node.id}_total`, label: node.totalLabel || `Total ${node.label}`, values: node.totals },
            depth, kind: 'sectionTotal',
          });
        }
      }
    } else if (node.kind === 'summary') {
      visible.push({ node, depth, kind: 'summary' });
    } else {
      visible.push({ node, depth, kind: 'row' });
    }
  };
  rows.forEach((r) => push(r, 0));

  const cellNum = (v) => (v === null || v === undefined ? '' : moneyCompact(v));
  const numStyle = {
    fontFamily: OUTFIT, fontSize: '12.5px', textAlign: 'right', padding: '7px 10px',
    whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums', color: '#334155',
  };

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: `${220 + columns.length * 78}px` }}>
        <thead>
          <tr style={{ borderBottom: '1px solid #e5e7eb' }}>
            <th style={{ ...numStyle, textAlign: 'left', color: '#94a3b8', fontWeight: 600, position: 'sticky', left: 0, backgroundColor: '#ffffff' }} />
            {columns.map((c, i) => (
              <th key={i} style={{ ...numStyle, color: '#94a3b8', fontWeight: 600 }}>
                {monthLabels ? shortMonth(c) : c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {visible.map(({ node, depth, open, expandable, kind }) => {
            const isBold = kind === 'section' || kind === 'summary' || kind === 'sectionTotal';
            const vals = kind === 'section' ? (open ? null : node.totals) : node.values;
            return (
              <tr
                key={node.id}
                onClick={kind === 'section' && expandable ? () => toggle(node.id) : undefined}
                style={{
                  borderBottom: '1px solid #f1f5f9',
                  cursor: kind === 'section' && expandable ? 'pointer' : 'default',
                  backgroundColor: kind === 'summary' ? '#f8fafc' : 'transparent',
                }}
              >
                <td style={{
                  ...numStyle, textAlign: 'left', paddingLeft: `${10 + depth * 18}px`,
                  fontWeight: isBold ? 700 : 400, color: isBold ? '#0f172a' : '#475569',
                  position: 'sticky', left: 0, backgroundColor: kind === 'summary' ? '#f8fafc' : '#ffffff',
                }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                    {kind === 'section' && expandable && (open
                      ? <ChevronDown size={13} style={{ color: '#94a3b8', flexShrink: 0 }} />
                      : <ChevronRight size={13} style={{ color: '#94a3b8', flexShrink: 0 }} />)}
                    {node.label}
                  </span>
                </td>
                {columns.map((_, i) => (
                  <td key={i} style={{
                    ...numStyle,
                    fontWeight: isBold ? 700 : 400,
                    color: vals && vals[i] !== null && vals[i] < 0 ? '#991b1b' : isBold ? '#0f172a' : '#475569',
                  }}>
                    {vals ? cellNum(vals[i]) : ''}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/* ─── P&L tab ──────────────────────────────────────────────────── */
/*
  P&L by period. The columns follow the grain and basis toggles rather than
  QuickBooks' raw month columns, so fiscal quarters here mean the same three
  months they mean on the Overview.

  No View toggle: this tab is the reported statement. Taking owner costs out of
  a statement without showing the bridge would be a figure nobody could tie
  back, so that lives on the Underlying Performance tab, which shows the
  reconciliation line by line.
*/
function PnlTab({ pnlMonthly, buckets, currency, loading, empty, bar }) {
  const parsed = useMemo(
    () => (pnlMonthly?.report ? parseReportTree(pnlMonthly.report) : null),
    [pnlMonthly],
  );
  const monthKeys = useMemo(
    () => (pnlMonthly?.report ? reportMonthKeys(pnlMonthly.report) : []),
    [pnlMonthly],
  );
  const bucketed = useMemo(() => {
    if (!parsed || !buckets?.length || !monthKeys.some(Boolean)) return null;
    return bucketReportTree(parsed.rows, monthKeys, buckets, 'sum');
  }, [parsed, monthKeys, buckets]);

  if (!parsed) {
    return (
      <>
        {bar}
        {loading ? <LoadingCard label="P&L" /> : <EmptyState label="P&L" {...empty} />}
      </>
    );
  }

  // Fall back to QuickBooks' own columns if the report has no month grain to
  // bucket (a single-period pull), rather than showing nothing.
  const columns = bucketed ? buckets.map((b) => b.label) : parsed.columns;
  const rows = bucketed || parsed.rows;

  return (
    <>
      {bar}
      <div style={cardStyle}>
        <div style={{ display: 'flex', alignItems: 'baseline', marginBottom: '12px' }}>
          <span style={{ fontFamily: OUTFIT, fontSize: '15px', fontWeight: 700, color: '#0f172a' }}>
            Profit &amp; Loss
          </span>
          {pnlMonthly.period && (
            <span style={{ fontFamily: OUTFIT, fontSize: '12px', color: '#94a3b8', marginLeft: 'auto' }}>
              {shortDate(pnlMonthly.period.start)} → {shortDate(pnlMonthly.period.end)} · {currency}
            </span>
          )}
        </div>
        <p style={{ fontFamily: OUTFIT, fontSize: '12px', color: '#94a3b8', marginTop: 0, marginBottom: '10px' }}>
          Click a summary line (Income, Cost of Sales, Expenses…) to expand it to account level.
          {bucketed && ' Columns follow the grain and year basis above.'}
        </p>
        <ReportTable columns={columns} rows={rows} monthLabels={!bucketed} />
      </div>
    </>
  );
}

/* ─── Balance Sheet tab ────────────────────────────────────────── */
/*
  One table, not two.

  This used to show a fixed summary of eight lines across four hard-coded dates,
  and then the same story again underneath as a single-column expandable tree —
  the same information twice, and neither half was the whole thing: you could
  have the comparison or the detail, never both.

  Now the comparative columns and the expandable account tree are the same
  table. Columns follow the grain and basis toggles, so you can read the balance
  sheet by month, by fiscal quarter or by year, and open any section down to
  account level in whichever of those you are looking at.

  Balances are STOCKS, so a bucket takes the position at its END — a quarter's
  cash is the closing balance, never three months added together.
*/
function BalanceSheetTab({ balanceSheet, grid, buckets, currency, loading, empty, bar }) {
  const parsed = useMemo(
    () => (grid?.report ? parseReportTree(grid.report) : null),
    [grid],
  );
  const monthKeys = useMemo(() => grid?.month_keys || [], [grid]);
  const bucketed = useMemo(() => {
    if (!parsed || !buckets?.length || !monthKeys.some(Boolean)) return null;
    return bucketReportTree(parsed.rows, monthKeys, buckets, 'last');
  }, [parsed, monthKeys, buckets]);

  // Falls back to the single-column as-at report while the grid is still
  // loading, or for a client whose monthly pull failed — better a narrower
  // table than an empty tab.
  const fallback = useMemo(
    () => (!bucketed && balanceSheet?.report ? parseReportTree(balanceSheet.report) : null),
    [bucketed, balanceSheet],
  );

  if (!balanceSheet) {
    return (
      <>
        {bar}
        {loading ? <LoadingCard label="balance sheet" /> : <EmptyState label="balance sheet" {...empty} />}
      </>
    );
  }

  const bs = balanceSheet;
  const within = bs.creditors_within_1yr;
  const after = bs.creditors_after_1yr;
  const liabSub = (within != null || after != null)
    ? `${money(within || 0, currency)} < 1yr · ${money(after || 0, currency)} > 1yr`
    : null;

  const columns = bucketed ? buckets.map((b) => b.label) : (fallback?.columns || []);
  const rows = bucketed || fallback?.rows || [];

  return (
    <>
      {bar}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '12px' }}>
          <MetricTile label="Total assets" value={bs.total_assets} currency={currency}
            sub={bs.period?.end ? `as at ${shortDate(bs.period.end)}` : null} />
          <MetricTile label="Total liabilities" value={bs.total_liabilities} currency={currency}
            sub={liabSub} />
          <MetricTile label="Net assets" value={bs.net_assets ?? bs.equity} currency={currency} />
        </div>

        <div style={cardStyle}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '10px', marginBottom: '4px', flexWrap: 'wrap' }}>
            <span style={{ fontFamily: OUTFIT, fontSize: '15px', fontWeight: 700, color: '#0f172a' }}>
              Balance sheet
            </span>
            <span style={{ fontFamily: OUTFIT, fontSize: '12px', color: '#94a3b8', marginLeft: 'auto' }}>
              as at {shortDate(bs.period?.end)} · {currency}
            </span>
          </div>
          <p style={{ fontFamily: OUTFIT, fontSize: '12px', color: '#94a3b8', marginTop: 0, marginBottom: '10px' }}>
            {bucketed
              ? 'Each column is the position at that period end. Click a section to expand it to account level.'
              : 'Click a section to expand it to account level.'}
            {' '}Total liabilities is creditors falling due within one year plus after more than one year.
          </p>
          {rows.length > 0
            ? <ReportTable columns={columns} rows={rows} monthLabels={!bucketed} />
            : <p style={{ fontFamily: OUTFIT, fontSize: '13px', color: '#94a3b8', margin: 0 }}>
                Loading the comparative columns…
              </p>}
        </div>
      </div>
    </>
  );
}


/* ─── Debtors & Creditors tab ──────────────────────────────────── */
const BUCKET_DEFS = [
  ['current', 'Current'],
  ['b1_30', '1–30 days'],
  ['b31_60', '31–60 days'],
  ['b61_90', '61–90 days'],
  ['b91_plus', '91+ days'],
];

function AgedSection({ title, data, currency, sameLabel }) {
  if (!data) return null;
  const top = (data.top || []).slice(0, 10);
  const sc = data.same_clients;
  return (
    <div style={cardStyle}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '10px', marginBottom: '4px' }}>
        <span style={{ fontFamily: OUTFIT, fontSize: '15px', fontWeight: 700, color: '#0f172a' }}>{title}</span>
        <span style={{ fontFamily: OUTFIT, fontSize: '18px', fontWeight: 700, color: '#0f172a', marginLeft: 'auto' }}>
          {money(data.buckets?.total, currency)}
        </span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '14px' }}>
        <span style={{ fontFamily: OUTFIT, fontSize: '11.5px', color: '#94a3b8' }}>
          as at {shortDate(data.period?.end)}
        </span>
      </div>

      {/* Same-client comparison — the CURRENT list's balances back in time */}
      {sc && (sc.last_month?.total != null || sc.three_months?.total != null) && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '10px', marginBottom: '16px' }}>
          {[
            ['Now', sc.current_total, data.period?.end],
            ['Last month', sc.last_month?.total, sc.last_month?.date],
            ['3 months ago', sc.three_months?.total, sc.three_months?.date],
          ].map(([label, val, date]) => (
            <div key={label} style={{ backgroundColor: '#f8fafc', borderRadius: '10px', padding: '10px 12px' }}>
              <div style={{ fontFamily: OUTFIT, fontSize: '11px', color: '#94a3b8', marginBottom: '2px' }}>{label}</div>
              <div style={{ fontFamily: OUTFIT, fontSize: '16px', fontWeight: 700, color: '#0f172a' }}>
                {val == null ? '—' : money(val, currency)}
              </div>
              <div style={{ fontFamily: OUTFIT, fontSize: '10.5px', color: '#cbd5e1' }}>{date ? shortDate(date) : ''}</div>
            </div>
          ))}
          <div style={{ gridColumn: '1 / -1', fontFamily: OUTFIT, fontSize: '11px', color: '#94a3b8', marginTop: '-4px' }}>
            {sameLabel} on the current file ({sc.names}) — their combined balance at each date. Names on the file now only.
          </div>
        </div>
      )}

      {/* Ageing buckets */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: '10px', marginBottom: '16px' }}>
        {BUCKET_DEFS.map(([key, label]) => (
          <div key={key} style={{ backgroundColor: '#f8fafc', borderRadius: '10px', padding: '10px 12px' }}>
            <div style={{ fontFamily: OUTFIT, fontSize: '11px', color: '#94a3b8', marginBottom: '2px' }}>{label}</div>
            <div style={{ fontFamily: OUTFIT, fontSize: '16px', fontWeight: 700, color: key === 'b91_plus' && Math.abs(data.buckets?.[key] || 0) > 0.005 ? '#991b1b' : '#0f172a' }}>
              {money(data.buckets?.[key], currency)}
            </div>
          </div>
        ))}
      </div>

      {/* Top balances */}
      {top.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ borderCollapse: 'collapse', width: '100%' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid #e5e7eb' }}>
                <th style={{ ...agedTh, textAlign: 'left' }}>Largest balances</th>
                {BUCKET_DEFS.map(([k, l]) => <th key={k} style={agedTh}>{l}</th>)}
                <th style={agedTh}>Total</th>
              </tr>
            </thead>
            <tbody>
              {top.map((r, i) => (
                <tr key={i} style={{ borderBottom: '1px solid #f1f5f9' }}>
                  <td style={{ ...agedTd, textAlign: 'left', color: '#0f172a', fontWeight: 500 }}>{r.name}</td>
                  {BUCKET_DEFS.map(([k]) => (
                    <td key={k} style={{ ...agedTd, color: k === 'b91_plus' && Math.abs(r[k] || 0) > 0.005 ? '#991b1b' : '#475569' }}>
                      {Math.abs(r[k] || 0) > 0.005 ? money(r[k], currency) : ''}
                    </td>
                  ))}
                  <td style={{ ...agedTd, fontWeight: 700, color: '#0f172a' }}>{money(r.total, currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
const agedTh = { fontFamily: OUTFIT, fontSize: '11px', color: '#94a3b8', fontWeight: 600, textAlign: 'right', padding: '6px 10px', whiteSpace: 'nowrap' };
const agedTd = { fontFamily: OUTFIT, fontSize: '12.5px', textAlign: 'right', padding: '7px 10px', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' };

function AgedTab({ data, title, sameLabel, label, currency, loading, empty }) {
  if (!data) return loading ? <LoadingCard label={label} /> : <EmptyState label={label} {...empty} />;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <AgedSection title={title} data={data} currency={currency} sameLabel={sameLabel} />
    </div>
  );
}

