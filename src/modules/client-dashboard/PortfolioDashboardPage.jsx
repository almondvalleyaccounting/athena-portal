import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Star, Loader, ArrowRight, RefreshCw, LayoutGrid, List, Rows3, Grid3x3 } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../shell/AppShell';
import { BTN } from '../../lib/buttonStyles';
import { PERIOD_PRESETS, OUTFIT, PLAYFAIR, cardStyle, inputStyle } from './dashboardData';
import { resolveFiscalYear } from './overviewGrain';
import {
  portfolioWindow, buildPortfolioFigures, portfolioFlags, attentionScore,
  DEFAULT_PERIOD, HEADLINE_METRICS, PULL_RESULT_NAMES,
} from './portfolioSignals';
import { C, ExpandedTile, CompactTile, ListView } from './PortfolioViews';

/*
  Portfolio Dashboard — the logged-in user's starred clients, read as a CFO
  would: every figure against a comparator, and a line of flags that says who
  needs looking at.

  Period: the Client Dashboard's own presets (plus its "YTD to last month",
  the default here), resolved per client against THAT client's year end — so
  "last fiscal year" means each client's own. Each figure is the period vs the
  same period a year earlier, and balances are as at the period end.

  Figures come from qbo_dashboard_cache under the dated keys portfolioWindow()
  names; the page never pulls on load. The nightly jobs (sql/293, sql/294) keep
  the headline metrics and the default period current; Refresh all (or a
  tile's Pull now) pulls the selected period through dashboard-qbo-pull.
  A custom range is never cached, so its figures live in page state only.
*/

const BAD_CH_STATUS = /(strike|liquidat|administrat|insolven|dissolv|receiver)/i;
const UI_KEY = 'athena.portfolio.ui';

// Only the fields portfolioSignals reads — the cached reports also carry whole
// QuickBooks report trees that this page has no use for.
const CACHE_COLUMNS = [
  'realm_id', 'metric_key', 'period_end', 'pulled_at',
  'income:data->income', 'net_income:data->net_income', 'currency:data->currency',
  'series:data->series', 'months:data->months', 'month_keys:data->month_keys', 'period:data->period',
  'cash:data->cash', 'debtors:data->debtors', 'current_assets:data->current_assets',
  'current_liabilities:data->current_liabilities', 'comparatives:data->comparatives',
  'buckets:data->buckets',
].join(', ');
const toRow = ({ realm_id, metric_key, period_end, pulled_at, ...data }) => ({ realm_id, metric_key, period_end, pulled_at, data });

function readUi() {
  try { return JSON.parse(localStorage.getItem(UI_KEY) || '{}') || {}; } catch { return {}; }
}
function writeUi(ui) {
  try { localStorage.setItem(UI_KEY, JSON.stringify(ui)); } catch { /* private window */ }
}

export default function PortfolioDashboardPage() {
  const { profile } = useAuth();
  const navigate = useNavigate();
  const saved = useRef(readUi()).current;

  const [clients, setClients] = useState([]);       // favourites + connection + fiscal year
  const [headline, setHeadline] = useState({});     // realm → { company, file_health }
  const [periodRows, setPeriodRows] = useState({}); // realm → { pl, plPrior, … }
  const [live, setLive] = useState({});             // realm → rows from a custom-range pull
  const [pullState, setPullState] = useState({});   // realm → { pulling, error }
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(null);

  const [view, setView] = useState(saved.view === 'list' ? 'list' : 'tiles');
  const [density, setDensity] = useState(saved.density === 'compact' ? 'compact' : 'expanded');
  const [periodKey, setPeriodKey] = useState(
    PERIOD_PRESETS.some((p) => p.key === saved.periodKey) && saved.periodKey !== 'custom' ? saved.periodKey : DEFAULT_PERIOD,
  );
  const [customPeriod, setCustomPeriod] = useState({ start: '', end: '' });
  const [sortBy, setSortBy] = useState(saved.sortBy || 'attention');

  useEffect(() => { writeUi({ view, density, periodKey, sortBy }); }, [view, density, periodKey, sortBy]);

  const today = useMemo(() => new Date(), []);

  /* 1. Who is starred, and each client's year end ------------------ */
  const loadClients = useCallback(async () => {
    if (!profile?.id) return;
    setLoading(true);
    try {
      const { data: favs } = await supabase
        .from('staff_client_favourites')
        .select('realm_id, entity_id, created_at, entity:entities(id, name, company_status, company_status_detail)')
        .eq('staff_id', profile.id)
        .order('created_at', { ascending: true });
      const favourites = (favs || []).filter((f) => f.realm_id);
      if (!favourites.length) { setClients([]); setLoading(false); return; }

      const realmIds = favourites.map((f) => f.realm_id);
      const [{ data: conns }, { data: yearEnds }, { data: latest }] = await Promise.all([
        supabase.from('qbo_report_connections')
          .select('realm_id, company_name, entity_id, status, fiscal_year_end_month')
          .in('realm_id', realmIds),
        supabase.from('v_client_year_end').select('realm_id, month, source').in('realm_id', realmIds),
        supabase.from('qbo_dashboard_cache_latest')
          .select('realm_id, metric_key, pulled_at, data')
          .in('realm_id', realmIds)
          .in('metric_key', HEADLINE_METRICS),
      ]);
      const connBy = Object.fromEntries((conns || []).map((c) => [c.realm_id, c]));
      const yeBy = Object.fromEntries((yearEnds || []).map((y) => [y.realm_id, y]));
      const head = {};
      for (const r of latest || []) (head[r.realm_id] ||= {})[r.metric_key] = r;

      setHeadline(head);
      setClients(favourites.map((f, i) => {
        const conn = connBy[f.realm_id] || null;
        const chStatus = f.entity?.company_status || null;
        const chDetail = f.entity?.company_status_detail || null;
        const chLabel = chStatus
          ? `${chStatus.replace(/-/g, ' ')}${chDetail ? ` (${chDetail.replace(/-/g, ' ')})` : ''}` : '';
        // Same resolution as the Client Dashboard, so "last fiscal year" here
        // is the year that page would show for this client.
        const fy = resolveFiscalYear({
          overrideEndMonth: conn?.fiscal_year_end_month,
          bmEndMonth: yeBy[f.realm_id]?.month,
          bmSource: yeBy[f.realm_id]?.source,
          qboStartMonth: head[f.realm_id]?.company?.data?.fiscal_year_start_month,
        });
        return {
          order: i,
          realmKey: f.realm_id,
          realmId: f.realm_id,
          connected: !!conn && conn.status === 'active',
          name: conn?.company_name || f.entity?.name || 'Unknown client',
          chBad: !!(chStatus && chStatus !== 'active'),
          chSevere: BAD_CH_STATUS.test(chLabel),
          chLabel,
          fyIdx: fy.fyIdx,
        };
      }));
    } catch { setClients([]); }
    setLoading(false);
  }, [profile?.id]);

  useEffect(() => { loadClients(); }, [loadClients]);

  /* 2. Each client's window for the selected period ---------------- */
  const customReady = periodKey !== 'custom'
    || !!(customPeriod.start && customPeriod.end && customPeriod.start <= customPeriod.end);
  const windows = useMemo(() => {
    if (!customReady) return {};
    const out = {};
    for (const c of clients) out[c.realmKey] = portfolioWindow(periodKey, today, c.fyIdx, customPeriod);
    return out;
  }, [clients, periodKey, customPeriod, customReady, today]);

  /* 3. The cached rows those windows name --------------------------- */
  const loadPeriod = useCallback(async () => {
    const stored = Object.keys(windows).filter((r) => windows[r].stored);
    if (!stored.length) { setPeriodRows({}); return; }
    const keys = [...new Set(stored.flatMap((r) => Object.values(windows[r].keys)))];
    try {
      const { data } = await supabase.from('qbo_dashboard_cache')
        .select(CACHE_COLUMNS)
        .in('realm_id', stored)
        .in('metric_key', keys)
        .order('pulled_at', { ascending: false });
      const byRealmKey = {};
      for (const r of data || []) {
        const k = `${r.realm_id}|${r.metric_key}`;
        if (!byRealmKey[k]) byRealmKey[k] = toRow(r);
      }
      const out = {};
      for (const r of stored) {
        out[r] = {};
        for (const [name, key] of Object.entries(windows[r].keys)) out[r][name] = byRealmKey[`${r}|${key}`] || null;
      }
      setPeriodRows(out);
    } catch { setPeriodRows({}); }
  }, [windows]);

  useEffect(() => { loadPeriod(); }, [loadPeriod]);
  // A new custom range invalidates what the last one pulled.
  useEffect(() => { setLive({}); }, [periodKey, customPeriod.start, customPeriod.end]);

  /* 4. Cards ------------------------------------------------------- */
  const cards = useMemo(() => clients.map((c) => {
    const w = windows[c.realmKey] || null;
    const rows = (w && !w.stored ? live[c.realmKey] : periodRows[c.realmKey]) || {};
    const figures = buildPortfolioFigures(rows, { fileHealth: headline[c.realmKey]?.file_health?.data || null });
    const flags = figures.hasFigures ? portfolioFlags(figures, c) : [];
    const ps = pullState[c.realmKey] || {};
    return { ...c, window: w, figures, flags, score: attentionScore(flags), pulling: !!ps.pulling, pullError: ps.error || null };
  }), [clients, windows, periodRows, live, headline, pullState]);

  const sorted = useMemo(() => {
    const list = [...cards];
    if (sortBy === 'attention') list.sort((a, b) => b.score - a.score || a.order - b.order);
    else if (sortBy === 'name') list.sort((a, b) => a.name.localeCompare(b.name));
    else if (sortBy === 'revenue') list.sort((a, b) => (b.figures.revenue ?? -Infinity) - (a.figures.revenue ?? -Infinity));
    return list;
  }, [cards, sortBy]);

  /* 5. Pulling ----------------------------------------------------- */
  // One client: headline metrics, then the period — in sequence, so the two
  // calls never race to refresh the same Intuit token.
  const pullOne = useCallback(async (card) => {
    const w = windows[card.realmKey];
    if (!w || !card.connected) return false;
    setPullState((s) => ({ ...s, [card.realmKey]: { pulling: true } }));
    let ok = true;
    try {
      const { data: h, error: he } = await supabase.functions.invoke('dashboard-qbo-pull', {
        body: { realmId: card.realmId, refresh: true, metrics: HEADLINE_METRICS },
      });
      if (he || !h?.success) ok = false;
      const { data, error } = await supabase.functions.invoke('dashboard-qbo-pull', {
        body: {
          realmId: card.realmId, refresh: true,
          window: {
            kind: w.stored ? 'preset' : 'custom',
            portfolio: {
              plStart: w.plStart, plEnd: w.plEnd, cmpStart: w.cmpStart, cmpEnd: w.cmpEnd,
              chartStart: w.chartStart, chartEnd: w.chartEnd, asAt: w.asAt, arPrevDate: w.arPrevDate,
            },
          },
        },
      });
      if (error || !data?.success) ok = false;
      if (!w.stored && data?.metrics) {
        const at = data.pulled_at || new Date().toISOString();
        const rows = {};
        for (const [resp, name] of Object.entries(PULL_RESULT_NAMES)) {
          const m = data.metrics[resp];
          rows[name] = m ? { data: m, pulled_at: at, period_end: name === 'arPrev' ? w.arPrevDate : w.asAt } : null;
        }
        setLive((prev) => ({ ...prev, [card.realmKey]: rows }));
      }
    } catch { ok = false; }
    setPullState((s) => ({
      ...s,
      [card.realmKey]: { pulling: false, error: ok ? null : 'Pull failed — open the dashboard to see why (often an expired connection).' },
    }));
    return ok;
  }, [windows]);

  const afterPull = useCallback(async () => {
    try {
      const { data: latest } = await supabase.from('qbo_dashboard_cache_latest')
        .select('realm_id, metric_key, pulled_at, data')
        .in('realm_id', clients.map((c) => c.realmKey))
        .in('metric_key', HEADLINE_METRICS);
      const head = {};
      for (const r of latest || []) (head[r.realm_id] ||= {})[r.metric_key] = r;
      setHeadline(head);
    } catch { /* keep what we had */ }
    await loadPeriod();
  }, [clients, loadPeriod]);

  const pullSingle = async (card) => { await pullOne(card); await afterPull(); };

  // Two clients at a time, so a long list doesn't fire a burst of QuickBooks calls.
  const refreshAll = async () => {
    const targets = cards.filter((c) => c.connected);
    if (!targets.length || !customReady) return;
    const state = { done: 0, total: targets.length, failed: [] };
    setRefreshing({ ...state });
    const queue = [...targets];
    const worker = async () => {
      while (queue.length) {
        const c = queue.shift();
        if (!(await pullOne(c))) state.failed.push(c.name);
        state.done += 1;
        setRefreshing({ ...state });
      }
    };
    await Promise.all([worker(), worker()]);
    await afterPull();
    setRefreshing(state.failed.length ? { ...state, finished: true } : null);
  };

  const unstar = async (card) => {
    setClients((prev) => prev.filter((c) => c.realmKey !== card.realmKey));
    try {
      await supabase.from('staff_client_favourites').delete()
        .eq('staff_id', profile.id).eq('realm_id', card.realmKey);
    } catch { loadClients(); }
  };
  const open = (card) => { if (card.connected) navigate(`/client-dashboard?realm=${encodeURIComponent(card.realmId)}`); };

  const pickPeriod = (k) => {
    if (k === 'custom' && !customPeriod.start) {
      const any = Object.values(windows)[0];
      setCustomPeriod({ start: any?.plStart || '', end: any?.plEnd || '' });
    }
    setPeriodKey(k);
  };

  const busy = !!refreshing && !refreshing.finished;
  const flaggedCount = cards.filter((c) => c.flags.some((f) => f.level === 'red')).length;
  const notPulled = cards.filter((c) => c.connected && !c.figures.hasFigures).length;
  const presetLabel = PERIOD_PRESETS.find((p) => p.key === periodKey)?.label || '';

  return (
    <div style={{ margin: '0 auto', padding: '40px 24px' }}>
      <h1 style={{ fontFamily: PLAYFAIR, fontSize: '28px', fontWeight: 500, color: C.ink, marginBottom: '8px' }}>
        Portfolio
      </h1>
      <p style={{ fontFamily: OUTFIT, fontSize: '14.5px', color: C.sub, margin: '0 0 18px' }}>
        Starred clients vs last year.
        {!loading && flaggedCount > 0 && (
          <span style={{ color: C.redFg, fontWeight: 600 }}> {flaggedCount} need{flaggedCount === 1 ? 's' : ''} attention.</span>
        )}
      </p>

      {!loading && clients.length > 0 && (
        <div style={{ ...cardStyle, padding: '12px 14px', marginBottom: '16px', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '10px 14px' }}>
          <Segmented value={view} onChange={setView}
            options={[{ key: 'tiles', label: 'Tiles', icon: LayoutGrid }, { key: 'list', label: 'List', icon: List }]} />
          {view === 'tiles' && (
            <Segmented value={density} onChange={setDensity}
              options={[{ key: 'compact', label: 'Compact', icon: Grid3x3 }, { key: 'expanded', label: 'Expanded', icon: Rows3 }]} />
          )}

          <label style={ctlLabel}>
            Period
            <select value={periodKey} onChange={(e) => pickPeriod(e.target.value)} style={selectStyle}>
              {PERIOD_PRESETS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
            </select>
          </label>
          {periodKey === 'custom' && (
            <>
              <input type="date" value={customPeriod.start} max={customPeriod.end || undefined}
                onChange={(e) => setCustomPeriod((c) => ({ ...c, start: e.target.value }))} style={dateStyle} aria-label="From" />
              <span style={{ fontFamily: OUTFIT, fontSize: '14px', color: C.faint }}>to</span>
              <input type="date" value={customPeriod.end} min={customPeriod.start || undefined}
                onChange={(e) => setCustomPeriod((c) => ({ ...c, end: e.target.value }))} style={dateStyle} aria-label="To" />
            </>
          )}

          {view === 'tiles' && (
            <label style={ctlLabel}>
              Sort
              <select value={sortBy} onChange={(e) => setSortBy(e.target.value)} style={selectStyle}>
                <option value="attention">Needs attention first</option>
                <option value="starred">Order starred</option>
                <option value="revenue">Revenue</option>
                <option value="name">Name</option>
              </select>
            </label>
          )}

          <button onClick={refreshAll} disabled={busy || !customReady}
            title={`Pull "${presetLabel}" from QuickBooks for every starred client`}
            style={{
              ...BTN.secondary.md, marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: '6px',
              cursor: busy || !customReady ? 'default' : 'pointer', opacity: customReady ? 1 : 0.5,
            }}>
            <RefreshCw size={14} style={busy ? { animation: 'spin 1s linear infinite' } : undefined} />
            {busy ? `Refreshing ${refreshing.done}/${refreshing.total}…` : `Refresh all · ${presetLabel}`}
          </button>

          <div style={{ flexBasis: '100%', fontFamily: OUTFIT, fontSize: '13px', color: C.faint }}>
            {periodKey === 'custom'
              ? (customReady ? 'Custom ranges are pulled live and not kept — press Refresh all to load them.' : 'Pick both dates.')
              : periodKey === DEFAULT_PERIOD
                ? 'Refreshed from QuickBooks every morning.'
                : 'Pulled on demand; once pulled, this period stays cached.'}
            {' '}Dates follow each client's own year end — each tile shows its range.
            {notPulled > 0 && customReady && ` ${notPulled} client${notPulled === 1 ? ' has' : 's have'} no figures for this period yet.`}
          </div>
        </div>
      )}

      {refreshing?.finished && refreshing.failed.length > 0 && (
        <div style={{ ...cardStyle, padding: '10px 14px', marginBottom: '16px', fontFamily: OUTFIT, fontSize: '14px', color: C.ambFg, backgroundColor: C.ambBg, border: `1px solid ${C.ambBd}` }}>
          Couldn't refresh {refreshing.failed.join(', ')} — open the dashboard to see why (usually an expired QuickBooks connection).
          <button onClick={() => setRefreshing(null)} style={{ marginLeft: '10px', background: 'none', border: 'none', cursor: 'pointer', color: C.ambFg, fontWeight: 600, fontFamily: OUTFIT }}>Dismiss</button>
        </div>
      )}

      {loading && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', color: '#0369a1', fontFamily: OUTFIT, fontSize: '14.5px', fontWeight: 600 }}>
          <Loader size={16} style={{ animation: 'spin 1s linear infinite' }} /> Loading your portfolio…
        </div>
      )}

      {!loading && clients.length === 0 && (
        <div style={{ ...cardStyle, textAlign: 'center', padding: '56px 24px' }}>
          <Star size={28} style={{ color: '#f59e0b', marginBottom: '12px' }} />
          <div style={{ fontFamily: OUTFIT, fontSize: '16px', fontWeight: 700, color: C.ink, marginBottom: '6px' }}>
            No starred clients yet
          </div>
          <div style={{ fontFamily: OUTFIT, fontSize: '14px', color: C.sub, maxWidth: '440px', margin: '0 auto 18px' }}>
            Open the Client Dashboard, pick a client and click the star next to their name.
          </div>
          <button onClick={() => navigate('/client-dashboard')}
            style={{
              ...BTN.secondary.md, display: 'inline-flex', alignItems: 'center', gap: '6px', cursor: 'pointer',
            }}>
            Open Client Dashboard <ArrowRight size={14} />
          </button>
        </div>
      )}

      {!loading && clients.length > 0 && view === 'list' && (
        <ListView cards={cards} onOpen={open} onUnstar={unstar} onPull={pullSingle} />
      )}

      {!loading && clients.length > 0 && view === 'tiles' && (
        <div style={{
          display: 'grid', gap: density === 'compact' ? '12px' : '16px',
          gridTemplateColumns: `repeat(auto-fill, minmax(min(${density === 'compact' ? 280 : 520}px, 100%), 1fr))`,
        }}>
          {sorted.map((c) => (density === 'compact'
            ? <CompactTile key={c.realmKey} card={c} onOpen={() => open(c)} onUnstar={() => unstar(c)} onPull={() => pullSingle(c)} />
            : <ExpandedTile key={c.realmKey} card={c} onOpen={() => open(c)} onUnstar={() => unstar(c)} onPull={() => pullSingle(c)} />
          ))}
        </div>
      )}

      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

/* ─── Controls ─────────────────────────────────────────────────── */

const ctlLabel = { display: 'inline-flex', alignItems: 'center', gap: '6px', fontFamily: OUTFIT, fontSize: '13px', fontWeight: 600, color: C.faint };
const selectStyle = { fontFamily: OUTFIT, fontSize: '14px', padding: '7px 10px', border: '1px solid #e5e7eb', borderRadius: '10px', background: '#fff', color: C.ink };
const dateStyle = { ...inputStyle, padding: '6px 10px', fontSize: '14px' };

function Segmented({ value, onChange, options }) {
  return (
    <div role="group" style={{ display: 'inline-flex', border: '1px solid #e5e7eb', borderRadius: '10px', overflow: 'hidden' }}>
      {options.map((o, i) => {
        const active = value === o.key;
        const Icon = o.icon;
        return (
          <button key={o.key} onClick={() => onChange(o.key)} aria-pressed={active}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: '5px', padding: '7px 12px',
              border: 'none', borderLeft: i ? '1px solid #e5e7eb' : 'none', cursor: 'pointer',
              backgroundColor: active ? '#f0f9ff' : '#fff', color: active ? '#0369a1' : '#475569',
              fontFamily: OUTFIT, fontSize: '14px', fontWeight: active ? 700 : 500,
            }}>
            <Icon size={14} /> {o.label}
          </button>
        );
      })}
    </div>
  );
}
