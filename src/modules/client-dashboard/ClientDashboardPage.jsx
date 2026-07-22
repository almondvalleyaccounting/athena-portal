import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  RefreshCw, AlertCircle, CheckCircle, Loader, ShieldCheck,
  ShieldAlert, Link2Off, Plus, X, Star, ChevronDown, ChevronRight,
  CloudOff, ArrowDownRight, ArrowUpRight,
} from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { getReportsAuthUrl } from '../../lib/qboApi';
import { useAuth } from '../../shell/AppShell';
import {
  money, moneyCompact, timeAgo, shortDate, shortMonth,
  latestByMetric, parseReportTree,
  RATIOS, formatRatio,
  PERIOD_PRESETS, ASAT_PRESETS, computePeriod, computeAsAt, fyStartMonthIndex,
  OUTFIT, PLAYFAIR, cardStyle, inputStyle, HEALTH_COLORS,
} from './dashboardData';
import { TrendChart } from './DashboardCharts';
import UnderlyingPerformanceTab from './UnderlyingPerformanceTab';

/*
  Client Dashboard v2 — multi-tab reporting tool over the client's QuickBooks.

  Two independent date filters live in the left rail, contextual to the active
  tab (see FilterRail):
    • PERIOD  → Overview + P&L. A date range (default: last full 12 months).
      Overview tiles, ratios and the 12-month trend chart all follow it; the
      chart is always the 12 months ending in the selected period-end month.
    • AS-AT   → Balance Sheet + Debtors & Creditors. A single point in time
      (default: last month end).

  Filtered figures come from dashboard-qbo-pull's windowed mode (live pull;
  presets cached by date range, custom ranges never stored). The default full
  pull (load) still runs to keep company/file-health, the reconnect banner and
  the Portfolio/Home shared cache fresh.
*/

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'pnl', label: 'P&L' },
  { id: 'underlying', label: 'Underlying Performance' },
  { id: 'balance', label: 'Balance Sheet' },
  { id: 'debtors', label: 'Debtors' },
  { id: 'creditors', label: 'Creditors' },
  { id: 'health', label: 'Bookkeeping Health' },
];
const PERIOD_TABS = new Set(['overview', 'pnl', 'underlying']);
const ASAT_TABS = new Set(['balance', 'debtors', 'creditors']);

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

  // Windowed (filtered) data.
  const [periodData, setPeriodData] = useState(null); // { pl_range, pl_range_prior, pnl_chart, bs_period }
  const [asAtData, setAsAtData] = useState(null);      // { bs_asat, ar_asat, ap_asat }
  const [periodLoading, setPeriodLoading] = useState(false);
  const [asAtLoading, setAsAtLoading] = useState(false);
  const asAtLoadedRef = useRef(null);

  const loadClients = async () => {
    try {
      const { data, error } = await supabase
        .from('qbo_report_connections')
        .select('realm_id, company_name, entity_id')
        .eq('status', 'active')
        .order('company_name');
      if (!error && data) setClients(data);
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

  // ?realm=…&tab=… deep link (portfolio cards + the home-screen Practice Pulse).
  useEffect(() => {
    if (clientsLoading) return;
    const r = searchParams.get('realm');
    const t = searchParams.get('tab');
    if (r && clients.some((c) => c.realm_id === r)) {
      searchParams.delete('realm');
      searchParams.delete('tab');
      setSearchParams(searchParams, { replace: true });
      onSelect(r);
      if (t && TABS.some((x) => x.id === t)) setTab(t);
    }
  }, [clientsLoading]);

  const handleConnect = () => {
    window.location.href = getReportsAuthUrl(profile?.id || '', '/client-dashboard');
  };

  // Default full pull — company + file-health for this page, and the shared
  // cache the Portfolio/Home read. Best effort: dead tokens fail per-metric and
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
        .in('metric_key', ['company', 'file_health', 'pl_fytd', 'pl_summary', 'balances', 'pnl_monthly', 'aged_receivables'])
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
  const fileHealth = latest.file_health?.data || null;
  const fyIdx = useMemo(() => fyStartMonthIndex(company?.fiscal_year_start_month), [company]);

  const period = useMemo(
    () => computePeriod(periodKey, today, fyIdx, customPeriod),
    [periodKey, today, fyIdx, customPeriod],
  );
  const asAt = useMemo(
    () => computeAsAt(asAtKey, today, fyIdx, customAsAt),
    [asAtKey, today, fyIdx, customAsAt],
  );

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
              chartStart: period.chartStart, chartEnd: period.chartEnd,
            },
          },
        },
      });
      if (!fnErr) setPeriodData(payload?.metrics || null);
    } catch { /* the reconnect banner is driven by the default pull */ }
    setPeriodLoading(false);
  }, [realmId, periodKey, period.plStart, period.plEnd, period.priorStart, period.priorEnd, period.chartStart, period.chartEnd]);

  const fetchAsAt = useCallback(async (refresh = false) => {
    if (!realmId) return;
    setAsAtLoading(true);
    try {
      const { data: payload, error: fnErr } = await supabase.functions.invoke('dashboard-qbo-pull', {
        body: {
          realmId, refresh,
          window: { kind: asAtKey === 'custom' ? 'custom' : 'preset', asat: { date: asAt.date } },
        },
      });
      if (!fnErr) { setAsAtData(payload?.metrics || null); asAtLoadedRef.current = asAt.date; }
    } catch { /* reconnect banner via the default pull */ }
    setAsAtLoading(false);
  }, [realmId, asAtKey, asAt.date]);

  // Period data: fetch on select and whenever the period window changes.
  useEffect(() => { if (realmId) fetchPeriod(false); }, [fetchPeriod]);
  // As-at data: fetch lazily on first visit to a balance/aged tab, and when the
  // as-at window changes while one of those tabs is open.
  useEffect(() => {
    if (realmId && ASAT_TABS.has(tab) && asAtLoadedRef.current !== asAt.date) fetchAsAt(false);
  }, [realmId, tab, asAt.date, fetchAsAt]);

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
                  data={periodData} meta={period} currency={periodCurrency}
                  loading={periodLoading} empty={emptyProps} goTab={setTab}
                />
              )}
              {tab === 'pnl' && (
                <PnlTab pnlMonthly={periodData?.pl_range} currency={periodCurrency} loading={periodLoading} empty={emptyProps} />
              )}
              {tab === 'underlying' && (
                <UnderlyingPerformanceTab
                  realmId={realmId} data={periodData} meta={period}
                  currency={periodCurrency} loading={periodLoading} empty={emptyProps}
                />
              )}
              {tab === 'balance' && (
                <BalanceSheetTab balanceSheet={asAtData?.bs_asat} currency={asAtCurrency} loading={asAtLoading} empty={emptyProps} />
              )}
              {tab === 'debtors' && (
                <AgedTab data={asAtData?.ar_asat} title="Aged debtors (receivables)" sameLabel="Same debtors"
                  label="aged debtors" currency={asAtCurrency} loading={asAtLoading} empty={emptyProps} />
              )}
              {tab === 'creditors' && (
                <AgedTab data={asAtData?.ap_asat} title="Aged creditors (payables)" sameLabel="Same suppliers"
                  label="aged creditors" currency={asAtCurrency} loading={asAtLoading} empty={emptyProps} />
              )}
              {tab === 'health' && <HealthTab health={fileHealth} currency={periodCurrency} empty={emptyProps} />}

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
          Bookkeeping health reflects the current state of the file.
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
          : `${shortDate(period.plStart)} → ${shortDate(period.plEnd)}. Chart ends ${shortDate(period.chartEnd)}.`}
      </div>
      {freshness}
    </div>
  );
}

/* ─── Shared bits ──────────────────────────────────────────────── */

function LoadingCard({ label }) {
  return (
    <div style={{ ...cardStyle, textAlign: 'center', padding: '48px 24px' }}>
      <Loader size={22} style={{ color: '#7dd3fc', marginBottom: '10px', animation: 'spin 1s linear infinite' }} />
      <div style={{ fontFamily: OUTFIT, fontSize: '13px', color: '#64748b' }}>Loading {label}…</div>
    </div>
  );
}

function EmptyState({ label, needsReconnect, selectedName, onPull, loading }) {
  return (
    <div style={{ ...cardStyle, textAlign: 'center', padding: '48px 24px' }}>
      <CloudOff size={26} style={{ color: '#cbd5e1', marginBottom: '10px' }} />
      <div style={{ fontFamily: OUTFIT, fontSize: '15px', fontWeight: 700, color: '#0f172a', marginBottom: '6px' }}>
        No {label} for this client yet
      </div>
      <div style={{ fontFamily: OUTFIT, fontSize: '13px', color: '#64748b', maxWidth: '460px', margin: '0 auto 16px' }}>
        {needsReconnect
          ? `${selectedName || 'This client'}'s QuickBooks connection has no usable access tokens, so nothing can be pulled. Reconnect them from Reports → Connect, then pull again.`
          : 'Pull from QuickBooks to fetch this report. If the pull fails, the client’s QuickBooks needs (re)connecting from the Reports module.'}
      </div>
      <button
        onClick={onPull}
        disabled={loading}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '9px 18px',
          border: '1px solid #e5e7eb', borderRadius: '10px', backgroundColor: '#ffffff',
          cursor: loading ? 'not-allowed' : 'pointer', fontFamily: OUTFIT, fontSize: '13px',
          fontWeight: 600, color: '#38bdf8',
        }}
      >
        <RefreshCw size={14} style={loading ? { animation: 'spin 1s linear infinite' } : {}} />
        Pull from QuickBooks
      </button>
    </div>
  );
}

// "vs …" change indicator. upIsGood flips the colouring for figures where an
// increase is unwelcome (creditors, aged debt).
function Delta({ now, prev, currency, upIsGood = true, label = 'vs last month' }) {
  if (now === null || now === undefined || prev === null || prev === undefined) return null;
  const diff = now - prev;
  if (Math.abs(diff) < 0.005) {
    return <span style={{ fontFamily: OUTFIT, fontSize: '11.5px', color: '#94a3b8' }}>unchanged {label}</span>;
  }
  const up = diff > 0;
  const good = up === upIsGood;
  const color = good ? '#166534' : '#991b1b';
  const Icon = up ? ArrowUpRight : ArrowDownRight;
  return (
    <span style={{ fontFamily: OUTFIT, fontSize: '11.5px', fontWeight: 600, color, display: 'inline-flex', alignItems: 'center', gap: '2px' }}>
      <Icon size={12} /> {money(Math.abs(diff), currency)} {label}
    </span>
  );
}

function MetricTile({ label, value, currency, sub, delta, onClick }) {
  return (
    <div
      onClick={onClick}
      title={onClick ? 'Open the full report' : undefined}
      style={{
        backgroundColor: '#ffffff', border: '1px solid #e5e7eb', borderRadius: '12px', padding: '14px 16px',
        cursor: onClick ? 'pointer' : 'default', transition: 'all 0.15s ease',
      }}
      onMouseEnter={(e) => { if (onClick) { e.currentTarget.style.borderColor = '#7dd3fc'; e.currentTarget.style.boxShadow = '0 4px 14px rgba(56,189,248,0.08)'; } }}
      onMouseLeave={(e) => { e.currentTarget.style.borderColor = '#e5e7eb'; e.currentTarget.style.boxShadow = 'none'; }}
    >
      <div style={{ fontFamily: OUTFIT, fontSize: '12px', color: '#94a3b8', marginBottom: '4px' }}>{label}</div>
      <div style={{ fontFamily: OUTFIT, fontSize: '22px', fontWeight: 700, color: (value ?? 0) < 0 ? '#991b1b' : '#0f172a' }}>
        {money(value, currency)}
      </div>
      <div style={{ minHeight: '16px', marginTop: '2px', display: 'flex', gap: '8px', alignItems: 'baseline', flexWrap: 'wrap' }}>
        {delta}
        {sub && <span style={{ fontFamily: OUTFIT, fontSize: '11.5px', color: '#94a3b8' }}>{sub}</span>}
      </div>
    </div>
  );
}

/* ─── Overview tab ─────────────────────────────────────────────── */
function OverviewTab({ data, meta, currency, loading, empty, goTab }) {
  const plRange = data?.pl_range;
  const plPrior = data?.pl_range_prior;
  const pnlChart = data?.pnl_chart;
  const bs = data?.bs_period;
  const hasAnything = plRange || bs || pnlChart;
  if (!hasAnything) return loading ? <LoadingCard label="overview figures" /> : <EmptyState label="overview figures" {...empty} />;

  const deltaLabel = meta?.deltaLabel || 'vs prior period';
  const asAtLabel = bs?.period?.end ? `as at ${shortDate(bs.period.end)}` : null;
  const creditors = bs?.accounts_payable ?? bs?.creditors_within_1yr;
  const creditorsPrev = bs?.prev?.accounts_payable ?? bs?.prev?.creditors_within_1yr;

  const ratioVals = RATIOS.map((r) => ({ ...r, value: r.compute({ plRange, pnlChart, bs }) }));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      {/* Headline tiles */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '12px' }}>
        <MetricTile
          label={`Revenue — ${meta?.label || 'period'}`} value={plRange?.income} currency={currency}
          delta={<Delta now={plRange?.income} prev={plPrior?.income} currency={currency} label={deltaLabel} />}
          onClick={goTab ? () => goTab('pnl') : undefined}
        />
        <MetricTile
          label={`Net profit — ${meta?.label || 'period'}`} value={plRange?.net_income} currency={currency}
          delta={<Delta now={plRange?.net_income} prev={plPrior?.net_income} currency={currency} label={deltaLabel} />}
          onClick={goTab ? () => goTab('pnl') : undefined}
        />
        <MetricTile
          label="Cash at bank" value={bs?.cash} currency={currency} sub={asAtLabel}
          delta={<Delta now={bs?.cash} prev={bs?.prev?.cash} currency={currency} />}
          onClick={goTab ? () => goTab('balance') : undefined}
        />
        <MetricTile
          label="Debtors" value={bs?.debtors} currency={currency} sub={asAtLabel}
          delta={<Delta now={bs?.debtors} prev={bs?.prev?.debtors} currency={currency} upIsGood={false} />}
          onClick={goTab ? () => goTab('aged') : undefined}
        />
        <MetricTile
          label="Creditors" value={creditors} currency={currency} sub={asAtLabel}
          delta={<Delta now={creditors} prev={creditorsPrev} currency={currency} upIsGood={false} />}
          onClick={goTab ? () => goTab('aged') : undefined}
        />
      </div>

      {/* 12-month trend (always ends at the selected period-end month) */}
      {pnlChart?.months?.length > 0 && (
        <div style={cardStyle}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '10px', marginBottom: '10px' }}>
            <span style={{ fontFamily: OUTFIT, fontSize: '15px', fontWeight: 700, color: '#0f172a' }}>
              Revenue &amp; net profit — 12 months to {shortMonth(pnlChart.months[pnlChart.months.length - 1])}
            </span>
            <span style={{ fontFamily: OUTFIT, fontSize: '11.5px', color: '#94a3b8', marginLeft: 'auto' }}>
              <span style={{ display: 'inline-block', width: '10px', height: '10px', backgroundColor: '#bae6fd', borderRadius: '2px', marginRight: '4px', verticalAlign: '-1px' }} />
              revenue
              <span style={{ display: 'inline-block', width: '10px', height: '2px', backgroundColor: '#0f172a', margin: '0 4px 0 12px', verticalAlign: '3px' }} />
              net profit
            </span>
          </div>
          <TrendChart
            months={pnlChart.months}
            income={pnlChart.series?.income || []}
            net={pnlChart.series?.net_income || []}
            currency={currency}
          />
        </div>
      )}

      {/* Ratios */}
      <div style={cardStyle}>
        <div style={{ fontFamily: OUTFIT, fontSize: '15px', fontWeight: 700, color: '#0f172a', marginBottom: '12px' }}>
          Key ratios
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '10px' }}>
          {ratioVals.map((r) => (
            <div key={r.key} title={r.hint} style={{ backgroundColor: '#f8fafc', borderRadius: '10px', padding: '12px 14px' }}>
              <div style={{ fontFamily: OUTFIT, fontSize: '11.5px', color: '#94a3b8', marginBottom: '3px' }}>{r.label}</div>
              <div style={{ fontFamily: OUTFIT, fontSize: '19px', fontWeight: 700, color: r.value === null ? '#cbd5e1' : '#0f172a' }}>
                {formatRatio(r.value, r.format)}
              </div>
            </div>
          ))}
        </div>
        <p style={{ fontFamily: OUTFIT, fontSize: '11px', color: '#94a3b8', marginTop: '10px', marginBottom: 0 }}>
          Margins use the selected period; debtor/creditor days annualise over the rolling 12 months; current ratio uses the balance sheet at the period end. Hover a tile for the formula.
        </p>
      </div>
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
function PnlTab({ pnlMonthly, currency, loading, empty }) {
  const parsed = useMemo(
    () => (pnlMonthly?.report ? parseReportTree(pnlMonthly.report) : null),
    [pnlMonthly],
  );
  if (!parsed) return loading ? <LoadingCard label="monthly P&L" /> : <EmptyState label="monthly P&L" {...empty} />;
  return (
    <div style={cardStyle}>
      <div style={{ display: 'flex', alignItems: 'baseline', marginBottom: '12px' }}>
        <span style={{ fontFamily: OUTFIT, fontSize: '15px', fontWeight: 700, color: '#0f172a' }}>
          Profit &amp; Loss by month
        </span>
        {pnlMonthly.period && (
          <span style={{ fontFamily: OUTFIT, fontSize: '12px', color: '#94a3b8', marginLeft: 'auto' }}>
            {shortDate(pnlMonthly.period.start)} → {shortDate(pnlMonthly.period.end)} · {currency}
          </span>
        )}
      </div>
      <p style={{ fontFamily: OUTFIT, fontSize: '12px', color: '#94a3b8', marginTop: 0, marginBottom: '10px' }}>
        Click a summary line (Income, Cost of Sales, Expenses…) to expand it to account level.
      </p>
      <ReportTable columns={parsed.columns} rows={parsed.rows} />
    </div>
  );
}

/* ─── Balance Sheet tab ────────────────────────────────────────── */
function BalanceSheetTab({ balanceSheet, currency, loading, empty }) {
  const parsed = useMemo(
    () => (balanceSheet?.report ? parseReportTree(balanceSheet.report) : null),
    [balanceSheet],
  );
  if (!balanceSheet) return loading ? <LoadingCard label="balance sheet" /> : <EmptyState label="balance sheet" {...empty} />;
  const bs = balanceSheet;
  const within = bs.creditors_within_1yr;
  const after = bs.creditors_after_1yr;
  const liabSub = (within != null || after != null)
    ? `${money(within || 0, currency)} < 1yr · ${money(after || 0, currency)} > 1yr`
    : null;
  const comp = bs.comparatives;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '12px' }}>
        <MetricTile label="Total assets" value={bs.total_assets} currency={currency}
          sub={bs.period?.end ? `as at ${shortDate(bs.period.end)}` : null} />
        <MetricTile label="Total liabilities" value={bs.total_liabilities} currency={currency}
          sub={liabSub} />
        <MetricTile label="Net assets" value={bs.net_assets ?? bs.equity} currency={currency} />
      </div>

      {/* Comparatives — this month vs last month / 3 months / 12 months ago */}
      {comp?.columns?.length > 0 && (
        <div style={cardStyle}>
          <div style={{ fontFamily: OUTFIT, fontSize: '15px', fontWeight: 700, color: '#0f172a', marginBottom: '4px' }}>
            Comparatives
          </div>
          <p style={{ fontFamily: OUTFIT, fontSize: '12px', color: '#94a3b8', marginTop: 0, marginBottom: '12px' }}>
            Month-end balances. Total liabilities = creditors falling due within one year plus after more than one year.
          </p>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: `${200 + comp.columns.length * 96}px` }}>
              <thead>
                <tr style={{ borderBottom: '1px solid #e5e7eb' }}>
                  <th style={{ ...compTh, textAlign: 'left' }} />
                  {comp.columns.map((c) => (
                    <th key={c.key} style={compTh}>
                      <div style={{ color: '#334155', fontWeight: 700 }}>{c.label}</div>
                      <div style={{ color: '#94a3b8', fontWeight: 500, fontSize: '10.5px' }}>{shortMonth(c.date)}</div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {comp.rows.map((r) => {
                  const bold = /total liabilities|net assets/i.test(r.label);
                  return (
                    <tr key={r.label} style={{ borderBottom: '1px solid #f1f5f9' }}>
                      <td style={{ ...compTd, textAlign: 'left', color: '#0f172a', fontWeight: bold ? 700 : 500 }}>{r.label}</td>
                      {r.values.map((v, i) => (
                        <td key={i} style={{ ...compTd, fontWeight: bold ? 700 : 400, color: v != null && v < 0 ? '#991b1b' : '#475569' }}>
                          {v === null || v === undefined ? '—' : moneyCompact(v, currency)}
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {parsed && (
        <div style={cardStyle}>
          <div style={{ fontFamily: OUTFIT, fontSize: '15px', fontWeight: 700, color: '#0f172a', marginBottom: '10px' }}>
            Balance sheet detail
          </div>
          <p style={{ fontFamily: OUTFIT, fontSize: '12px', color: '#94a3b8', marginTop: 0, marginBottom: '10px' }}>
            Click a section to expand it to account level. As at {shortDate(bs.period?.end)}.
          </p>
          <ReportTable columns={parsed.columns} rows={parsed.rows} monthLabels={false} />
        </div>
      )}
    </div>
  );
}
const compTh = { fontFamily: OUTFIT, fontSize: '11.5px', color: '#94a3b8', fontWeight: 600, textAlign: 'right', padding: '6px 12px', whiteSpace: 'nowrap' };
const compTd = { fontFamily: OUTFIT, fontSize: '13px', textAlign: 'right', padding: '8px 12px', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' };

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

/* ─── Bookkeeping Health tab ────────────────────────────────────── */
function HealthTab({ health, currency, empty }) {
  if (!health) return <EmptyState label="bookkeeping health" {...empty} />;
  const c = HEALTH_COLORS[health.score] || HEALTH_COLORS.amber;
  const rows = [
    ['Uncategorised', health.uncategorised_total],
    ['Undeposited funds', health.undeposited_funds],
    ['Opening balance equity', health.opening_balance_equity],
    ['Ask My Accountant', health.ask_my_accountant],
    ['Reconciliation discrepancies', health.reconciliation_discrepancies],
  ];
  return (
    <div style={cardStyle}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '14px' }}>
        {health.score === 'green'
          ? <ShieldCheck size={20} style={{ color: c.dot, flexShrink: 0 }} />
          : <ShieldAlert size={20} style={{ color: c.dot, flexShrink: 0 }} />}
        <span style={{ fontFamily: OUTFIT, fontSize: '15px', fontWeight: 700, color: '#0f172a' }}>
          Bookkeeping health
        </span>
        <span style={{
          marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: '6px',
          fontFamily: OUTFIT, fontSize: '12px', fontWeight: 600, color: c.text,
          backgroundColor: c.bg, border: `1px solid ${c.border}`, borderRadius: '999px', padding: '3px 10px',
        }}>
          <span style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: c.dot }} />
          {c.label}
        </span>
      </div>

      {health.flags?.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '14px' }}>
          {health.flags.map((f) => (
            <span key={f} style={{
              fontFamily: OUTFIT, fontSize: '12px', fontWeight: 600, color: '#475569',
              backgroundColor: '#f8fafc', border: '1px solid #e5e7eb', borderRadius: '8px', padding: '3px 10px',
            }}>{f}</span>
          ))}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '10px' }}>
        {typeof health.unreconciled_count === 'number' && (
          <div style={{ backgroundColor: '#f8fafc', borderRadius: '10px', padding: '10px 12px' }}>
            <div style={{ fontFamily: OUTFIT, fontSize: '11px', color: '#94a3b8', marginBottom: '2px' }}>Unreconciled bank items</div>
            <div style={{ fontFamily: OUTFIT, fontSize: '16px', fontWeight: 700, color: health.unreconciled_count > 0 ? c.text : '#0f172a' }}>
              {health.unreconciled_count}
              {health.unreconciled_count > 0 && (
                <span style={{ fontSize: '12px', fontWeight: 500, color: '#64748b' }}> · {money(health.unreconciled_total, currency)}</span>
              )}
            </div>
          </div>
        )}
        {rows.map(([label, val]) => (
          <div key={label} style={{ backgroundColor: '#f8fafc', borderRadius: '10px', padding: '10px 12px' }}>
            <div style={{ fontFamily: OUTFIT, fontSize: '11px', color: '#94a3b8', marginBottom: '2px' }}>{label}</div>
            <div style={{ fontFamily: OUTFIT, fontSize: '16px', fontWeight: 700, color: Math.abs(val || 0) > 0.005 ? c.text : '#0f172a' }}>
              {money(val, currency)}
            </div>
          </div>
        ))}
      </div>

      <p style={{ fontFamily: OUTFIT, fontSize: '11px', color: '#94a3b8', marginTop: '12px', marginBottom: 0 }}>
        Note: transactions still sitting in QuickBooks' bank-feed “For Review” queue aren't counted — QuickBooks doesn't expose that queue to the API. This reflects what's posted to the books.
      </p>
    </div>
  );
}
