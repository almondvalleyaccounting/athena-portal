import React, { useState, useEffect, useMemo } from 'react';
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
  latestByMetric, priorMonthSnapshot, parseReportTree,
  RATIOS, formatRatio,
  OUTFIT, PLAYFAIR, cardStyle, inputStyle, HEALTH_COLORS,
} from './dashboardData';
import { TrendChart } from './DashboardCharts';

/*
  Client Dashboard v2 — multi-tab reporting tool over the client's QuickBooks.

  Data model: dashboard-qbo-pull caches SNAPSHOTS in qbo_dashboard_cache, one
  row per (realm, metric, period_end). The page invokes the function (best
  effort — it fails cleanly when the client's tokens are gone) and then always
  renders from the cache table directly, so a dead connection still shows the
  last good figures with a reconnect banner.

  Tabs: Overview | P&L | Balance Sheet | Debtors & Creditors | Bookkeeping
  Health. Tab bodies are pure components fed parsed data via props, so a
  simplified client-safe portal view can later reuse a subset of them.
*/

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'pnl', label: 'P&L' },
  { id: 'balance', label: 'Balance Sheet' },
  { id: 'aged', label: 'Debtors & Creditors' },
  { id: 'health', label: 'Bookkeeping Health' },
];

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
        .select('entity_id')
        .eq('staff_id', profile.id);
      setFavourites(new Set((data || []).map((r) => r.entity_id)));
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

  // ?realm=… deep link (portfolio cards land here pre-selected).
  useEffect(() => {
    if (clientsLoading) return;
    const r = searchParams.get('realm');
    if (r && clients.some((c) => c.realm_id === r)) {
      searchParams.delete('realm');
      setSearchParams(searchParams, { replace: true });
      onSelect(r);
    }
  }, [clientsLoading]);

  const handleConnect = () => {
    window.location.href = getReportsAuthUrl(profile?.id || '', '/client-dashboard');
  };

  const load = async (realm, refresh = false) => {
    if (!realm) return;
    setLoading(true);
    setError(null);
    setFnErrors(null);
    // Best-effort live pull — refreshes stale metrics into the cache. A realm
    // with no usable tokens fails per-metric; we still render from cache.
    try {
      const { data: payload, error: fnErr } = await supabase.functions.invoke('dashboard-qbo-pull', {
        body: { realmId: realm, refresh },
      });
      if (fnErr) setError(fnErr.message || 'Request failed');
      else setFnErrors(payload?.errors || null);
    } catch (e) {
      setError(e.message || 'Request failed');
    }
    // Always read the snapshot cache — it's the page's source of truth.
    try {
      const { data: rows } = await supabase
        .from('qbo_dashboard_cache')
        .select('metric_key, period_start, period_end, data, pulled_at')
        .eq('realm_id', realm)
        .order('pulled_at', { ascending: false })
        .limit(500);
      setCacheRows(rows || []);
    } catch {
      setCacheRows([]);
    }
    setLoading(false);
  };

  const onSelect = (realm) => {
    setRealmId(realm);
    setCacheRows([]);
    setError(null);
    setFnErrors(null);
    setTab('overview');
    if (realm) load(realm, false);
  };

  const selected = clients.find((c) => c.realm_id === realmId);
  const selectedName = selected?.company_name || '';
  const entityId = selected?.entity_id || null;
  const isFavourite = entityId ? favourites.has(entityId) : false;

  const toggleFavourite = async () => {
    if (!entityId || !profile?.id) return;
    const next = new Set(favourites);
    try {
      if (isFavourite) {
        next.delete(entityId);
        setFavourites(next);
        await supabase.from('staff_client_favourites').delete()
          .eq('staff_id', profile.id).eq('entity_id', entityId);
      } else {
        next.add(entityId);
        setFavourites(next);
        await supabase.from('staff_client_favourites')
          .insert({ staff_id: profile.id, entity_id: entityId });
      }
    } catch { loadFavourites(); }
  };

  /* Derived data ------------------------------------------------- */
  const latest = useMemo(() => latestByMetric(cacheRows), [cacheRows]);
  const ctx = useMemo(() => ({
    company: latest.company?.data,
    plFytd: latest.pl_fytd?.data,
    plFytdPrior: latest.pl_fytd_prior?.data,
    plSummary: latest.pl_summary?.data,
    balances: latest.balances?.data,
    balancesPrior: priorMonthSnapshot(cacheRows, 'balances')?.data,
    agedAR: latest.aged_receivables?.data,
    agedAP: latest.aged_payables?.data,
    agedARPriorRow: priorMonthSnapshot(cacheRows, 'aged_receivables'),
    agedAPPriorRow: priorMonthSnapshot(cacheRows, 'aged_payables'),
    pnlMonthly: latest.pnl_monthly?.data,
    balanceSheet: latest.balance_sheet?.data,
    fileHealth: latest.file_health?.data,
  }), [cacheRows, latest]);

  const currency = ctx.pnlMonthly?.currency || ctx.plFytd?.currency || ctx.plSummary?.currency || 'GBP';
  const lastPulled = cacheRows.length ? cacheRows[0].pulled_at : null;

  // A realm with no stored tokens → every metric errors with the same reconnect message.
  const errVals = fnErrors ? Object.values(fnErrors) : [];
  const needsReconnect = errVals.length > 0 && errVals.every((e) => /reconnect/i.test(e));
  const partialErrors = fnErrors && !needsReconnect ? fnErrors : null;
  const hasCache = cacheRows.length > 0;

  const pull = () => load(realmId, true);
  const emptyProps = { needsReconnect, selectedName, onPull: pull, loading };

  return (
    <div style={{ maxWidth: '1060px', margin: '0 auto', padding: '40px 24px' }}>
      <h1 style={{ fontFamily: PLAYFAIR, fontSize: '28px', fontWeight: 500, color: '#0f172a', marginBottom: '8px' }}>
        Client Dashboard
      </h1>
      <p style={{ fontFamily: OUTFIT, fontSize: '14px', color: '#64748b', marginBottom: '28px' }}>
        Live figures, trends and bookkeeping health pulled from the client's QuickBooks.
        Star a client to pin them to your <a href="/portfolio" style={{ color: '#38bdf8', textDecoration: 'none', fontWeight: 600 }}>Portfolio</a>.
      </p>

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

      {/* Client selector + star + refresh + connect */}
      <div style={{ display: 'flex', gap: '8px', marginBottom: '20px' }}>
        <select
          value={realmId}
          onChange={(e) => onSelect(e.target.value)}
          disabled={clientsLoading}
          style={{ ...inputStyle, flex: 1, appearance: 'auto' }}
        >
          <option value="">{clientsLoading ? 'Loading clients…' : 'Select a client…'}</option>
          {clients.map((c) => (
            <option key={c.realm_id} value={c.realm_id}>{c.company_name}</option>
          ))}
        </select>
        {realmId && (
          <button
            onClick={toggleFavourite}
            disabled={!entityId}
            title={!entityId
              ? 'This connection is not linked to a client record yet'
              : isFavourite ? 'Remove from your Portfolio' : 'Star — add to your Portfolio'}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center', width: '42px',
              border: '1px solid #e5e7eb', borderRadius: '10px', backgroundColor: '#ffffff',
              cursor: entityId ? 'pointer' : 'not-allowed', flexShrink: 0,
            }}
          >
            <Star size={17} style={{ color: isFavourite ? '#f59e0b' : '#cbd5e1', fill: isFavourite ? '#f59e0b' : 'none' }} />
          </button>
        )}
        {realmId && (
          <button
            onClick={pull}
            disabled={loading}
            title="Refresh from QuickBooks"
            style={{
              display: 'flex', alignItems: 'center', gap: '6px', padding: '0 16px',
              border: '1px solid #e5e7eb', borderRadius: '10px', backgroundColor: '#ffffff',
              cursor: loading ? 'not-allowed' : 'pointer', fontFamily: OUTFIT,
              fontSize: '13px', fontWeight: 600, color: '#38bdf8', flexShrink: 0, whiteSpace: 'nowrap',
            }}
          >
            <RefreshCw size={14} style={loading ? { animation: 'spin 1s linear infinite' } : {}} />
            Refresh
          </button>
        )}
        <button
          onClick={handleConnect}
          title="Connect a QuickBooks client"
          style={{
            display: 'flex', alignItems: 'center', gap: '6px', padding: '0 16px',
            border: '1px solid #e5e7eb', borderRadius: '10px', backgroundColor: '#ffffff',
            cursor: 'pointer', fontFamily: OUTFIT, fontSize: '13px',
            fontWeight: 600, color: '#38bdf8', flexShrink: 0, whiteSpace: 'nowrap',
          }}
        >
          <Plus size={14} /> Connect
        </button>
      </div>

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
            Select a connected client above to see their dashboard, or connect a new QuickBooks file.
          </div>
        </div>
      )}

      {realmId && (
        <>
          {/* Company line + freshness */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '14px' }}>
            <div style={{ fontFamily: PLAYFAIR, fontSize: '20px', color: '#0f172a' }}>
              {ctx.company?.name || selectedName}
              {ctx.company?.country && (
                <span style={{ fontFamily: OUTFIT, fontSize: '12px', color: '#94a3b8', marginLeft: '8px' }}>
                  {ctx.company.country}
                </span>
              )}
            </div>
            <span style={{ fontFamily: OUTFIT, fontSize: '12px', color: '#94a3b8', display: 'flex', alignItems: 'center', gap: '6px' }}>
              {loading && <Loader size={12} style={{ animation: 'spin 1s linear infinite' }} />}
              {lastPulled ? `Last pulled ${timeAgo(lastPulled)}` : loading ? 'Pulling from QuickBooks…' : 'No cached data yet'}
            </span>
          </div>

          {/* Tabs */}
          <div style={{ display: 'flex', gap: '2px', borderBottom: '1px solid #e5e7eb', marginBottom: '20px' }}>
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
          {tab === 'overview' && <OverviewTab ctx={ctx} currency={currency} empty={emptyProps} />}
          {tab === 'pnl' && <PnlTab pnlMonthly={ctx.pnlMonthly} currency={currency} empty={emptyProps} />}
          {tab === 'balance' && <BalanceSheetTab balanceSheet={ctx.balanceSheet} currency={currency} empty={emptyProps} />}
          {tab === 'aged' && <AgedTab ctx={ctx} currency={currency} empty={emptyProps} />}
          {tab === 'health' && <HealthTab health={ctx.fileHealth} currency={currency} empty={emptyProps} />}

          {/* Per-metric errors (partial pull) */}
          {partialErrors && (
            <div style={{ fontFamily: OUTFIT, fontSize: '12px', color: '#b45309', marginTop: '14px' }}>
              Some figures couldn't be pulled: {Object.entries(partialErrors).map(([k, v]) => `${k} (${v})`).join('; ')}
            </div>
          )}
        </>
      )}

      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

/* ─── Shared bits ──────────────────────────────────────────────── */

function EmptyState({ label, needsReconnect, selectedName, onPull, loading }) {
  return (
    <div style={{ ...cardStyle, textAlign: 'center', padding: '48px 24px' }}>
      <CloudOff size={26} style={{ color: '#cbd5e1', marginBottom: '10px' }} />
      <div style={{ fontFamily: OUTFIT, fontSize: '15px', fontWeight: 700, color: '#0f172a', marginBottom: '6px' }}>
        No {label} cached for this client yet
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

function MetricTile({ label, value, currency, sub, delta }) {
  return (
    <div style={{ backgroundColor: '#ffffff', border: '1px solid #e5e7eb', borderRadius: '12px', padding: '14px 16px' }}>
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
function OverviewTab({ ctx, currency, empty }) {
  const { plFytd, plFytdPrior, balances, balancesPrior, agedAR, agedAP, pnlMonthly } = ctx;
  const hasAnything = plFytd || balances || pnlMonthly || agedAR || agedAP;
  if (!hasAnything) return <EmptyState label="overview figures" {...empty} />;

  // Debtors/creditors prefer the aged reports; deltas compare like with like
  // (aged snapshot vs prior aged snapshot, else balances vs prior balances).
  const debtors = agedAR?.buckets?.total ?? balances?.debtors;
  const debtorsPrev = agedAR ? ctx.agedARPriorRow?.data?.buckets?.total : balancesPrior?.debtors;
  const creditors = agedAP?.buckets?.total ?? balances?.creditors;
  const creditorsPrev = agedAP ? ctx.agedAPPriorRow?.data?.buckets?.total : balancesPrior?.creditors;

  const ratioVals = RATIOS.map((r) => ({ ...r, value: r.compute(ctx) }));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      {/* Headline tiles */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '12px' }}>
        <MetricTile
          label="Revenue — fiscal YTD" value={plFytd?.income} currency={currency}
          sub={plFytd?.period?.end ? `to ${shortDate(plFytd.period.end)}` : null}
          delta={<Delta now={plFytd?.income} prev={plFytdPrior?.income} currency={currency} label="vs last FYTD" />}
        />
        <MetricTile
          label="Net profit — fiscal YTD" value={plFytd?.net_income} currency={currency}
          delta={<Delta now={plFytd?.net_income} prev={plFytdPrior?.net_income} currency={currency} label="vs last FYTD" />}
        />
        <MetricTile
          label="Cash at bank" value={balances?.cash} currency={currency}
          delta={<Delta now={balances?.cash} prev={balancesPrior?.cash} currency={currency} />}
        />
        <MetricTile
          label="Debtors" value={debtors} currency={currency}
          delta={<Delta now={debtors} prev={debtorsPrev} currency={currency} upIsGood={false} />}
        />
        <MetricTile
          label="Creditors" value={creditors} currency={currency}
          delta={<Delta now={creditors} prev={creditorsPrev} currency={currency} upIsGood={false} />}
        />
      </div>

      {/* 12-month trend */}
      {pnlMonthly?.months?.length > 0 && (
        <div style={cardStyle}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '10px', marginBottom: '10px' }}>
            <span style={{ fontFamily: OUTFIT, fontSize: '15px', fontWeight: 700, color: '#0f172a' }}>
              Revenue &amp; net profit — last 12 months
            </span>
            <span style={{ fontFamily: OUTFIT, fontSize: '11.5px', color: '#94a3b8', marginLeft: 'auto' }}>
              <span style={{ display: 'inline-block', width: '10px', height: '10px', backgroundColor: '#bae6fd', borderRadius: '2px', marginRight: '4px', verticalAlign: '-1px' }} />
              revenue
              <span style={{ display: 'inline-block', width: '10px', height: '2px', backgroundColor: '#0f172a', margin: '0 4px 0 12px', verticalAlign: '3px' }} />
              net profit
            </span>
          </div>
          <TrendChart
            months={pnlMonthly.months}
            income={pnlMonthly.series?.income || []}
            net={pnlMonthly.series?.net_income || []}
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
          Margins use fiscal-YTD figures; debtor/creditor days use the last 12 months; current ratio uses today's balance sheet. Hover a tile for the formula.
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

  // Flatten the tree into visible rows.
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
function PnlTab({ pnlMonthly, currency, empty }) {
  const parsed = useMemo(
    () => (pnlMonthly?.report ? parseReportTree(pnlMonthly.report) : null),
    [pnlMonthly],
  );
  if (!parsed) return <EmptyState label="monthly P&L" {...empty} />;
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
function BalanceSheetTab({ balanceSheet, currency, empty }) {
  const parsed = useMemo(
    () => (balanceSheet?.report ? parseReportTree(balanceSheet.report) : null),
    [balanceSheet],
  );
  if (!balanceSheet) return <EmptyState label="balance sheet" {...empty} />;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '12px' }}>
        <MetricTile label="Total assets" value={balanceSheet.total_assets} currency={currency}
          sub={balanceSheet.period?.end ? `as at ${shortDate(balanceSheet.period.end)}` : null} />
        <MetricTile label="Total liabilities" value={balanceSheet.total_liabilities} currency={currency}
          sub={balanceSheet.current_liabilities != null ? `${money(balanceSheet.current_liabilities, currency)} current` : null} />
        <MetricTile label="Reserves / equity" value={balanceSheet.equity} currency={currency} />
      </div>
      {parsed && (
        <div style={cardStyle}>
          <div style={{ fontFamily: OUTFIT, fontSize: '15px', fontWeight: 700, color: '#0f172a', marginBottom: '10px' }}>
            Balance sheet detail
          </div>
          <p style={{ fontFamily: OUTFIT, fontSize: '12px', color: '#94a3b8', marginTop: 0, marginBottom: '10px' }}>
            Click a section to expand it to account level.
          </p>
          <ReportTable columns={parsed.columns} rows={parsed.rows} monthLabels={false} />
        </div>
      )}
    </div>
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

function AgedSection({ title, data, priorRow, currency }) {
  if (!data) return null;
  const prior = priorRow?.data;
  const priorDate = priorRow ? (priorRow.period_end || priorRow.pulled_at) : null;
  const top = (data.top || []).slice(0, 10);
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
          {priorDate ? ` · compared with ${shortDate(priorDate)}` : ' · no earlier snapshot yet for month-on-month change'}
        </span>
        <span style={{ marginLeft: 'auto' }}>
          <Delta now={data.buckets?.total} prev={prior?.buckets?.total} currency={currency} upIsGood={false} />
        </span>
      </div>

      {/* Ageing buckets */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: '10px', marginBottom: '16px' }}>
        {BUCKET_DEFS.map(([key, label]) => (
          <div key={key} style={{ backgroundColor: '#f8fafc', borderRadius: '10px', padding: '10px 12px' }}>
            <div style={{ fontFamily: OUTFIT, fontSize: '11px', color: '#94a3b8', marginBottom: '2px' }}>{label}</div>
            <div style={{ fontFamily: OUTFIT, fontSize: '16px', fontWeight: 700, color: key === 'b91_plus' && Math.abs(data.buckets?.[key] || 0) > 0.005 ? '#991b1b' : '#0f172a' }}>
              {money(data.buckets?.[key], currency)}
            </div>
            <div style={{ minHeight: '14px' }}>
              <Delta now={data.buckets?.[key]} prev={prior?.buckets?.[key]} currency={currency} upIsGood={false} />
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

function AgedTab({ ctx, currency, empty }) {
  const { agedAR, agedAP, agedARPriorRow, agedAPPriorRow } = ctx;
  if (!agedAR && !agedAP) return <EmptyState label="aged debtors / creditors" {...empty} />;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <AgedSection title="Aged debtors (receivables)" data={agedAR} priorRow={agedARPriorRow} currency={currency} />
      <AgedSection title="Aged creditors (payables)" data={agedAP} priorRow={agedAPPriorRow} currency={currency} />
    </div>
  );
}

/* ─── Bookkeeping Health tab (collapsible, collapsed by default) ── */
function HealthTab({ health, currency, empty }) {
  const [open, setOpen] = useState(false);
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
    <div style={{ ...cardStyle, backgroundColor: c.bg, border: `1px solid ${c.border}`, padding: 0 }}>
      {/* Always-visible header — click to expand */}
      <button
        onClick={() => setOpen(!open)}
        style={{
          display: 'flex', alignItems: 'center', gap: '10px', width: '100%',
          padding: '16px 24px', background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left',
        }}
      >
        {health.score === 'green'
          ? <ShieldCheck size={20} style={{ color: c.dot, flexShrink: 0 }} />
          : <ShieldAlert size={20} style={{ color: c.dot, flexShrink: 0 }} />}
        <span style={{ fontFamily: OUTFIT, fontSize: '15px', fontWeight: 700, color: c.text }}>
          Bookkeeping health — {c.label}
        </span>
        {!open && health.flags?.length > 0 && (
          <span style={{ fontFamily: OUTFIT, fontSize: '12px', color: c.text, opacity: 0.85 }}>
            {health.flags.length} flag{health.flags.length === 1 ? '' : 's'}
          </span>
        )}
        <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ width: '10px', height: '10px', borderRadius: '50%', backgroundColor: c.dot }} />
          {open ? <ChevronDown size={16} style={{ color: c.text }} /> : <ChevronRight size={16} style={{ color: c.text }} />}
        </span>
      </button>

      {open && (
        <div style={{ padding: '0 24px 20px' }}>
          {health.flags?.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '14px' }}>
              {health.flags.map((f) => (
                <span key={f} style={{
                  fontFamily: OUTFIT, fontSize: '12px', fontWeight: 600, color: c.text,
                  backgroundColor: '#ffffff', border: `1px solid ${c.border}`, borderRadius: '8px', padding: '3px 10px',
                }}>{f}</span>
              ))}
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '10px' }}>
            {typeof health.unreconciled_count === 'number' && (
              <div style={{ backgroundColor: '#ffffff', borderRadius: '10px', padding: '10px 12px', border: '1px solid rgba(0,0,0,0.04)' }}>
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
              <div key={label} style={{ backgroundColor: '#ffffff', borderRadius: '10px', padding: '10px 12px', border: '1px solid rgba(0,0,0,0.04)' }}>
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
      )}
    </div>
  );
}
