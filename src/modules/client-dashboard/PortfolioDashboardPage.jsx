import React, { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Star, Loader, AlertTriangle, Link2Off, ArrowRight, RefreshCw, CheckCircle2, Clock } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../shell/AppShell';
import {
  money, moneyCompact, timeAgo, shortDate, shortMonth,
  OUTFIT, PLAYFAIR, cardStyle,
} from './dashboardData';
import {
  buildPortfolioFigures, portfolioFlags, attentionScore, PORTFOLIO_METRICS,
} from './portfolioSignals';

/*
  Portfolio Dashboard — the logged-in user's starred clients at a glance, read
  as a CFO would: every figure against a comparator, and a line of flags that
  says which clients need looking at.

  Stars live in staff_client_favourites (RLS: own rows). Figures come from
  qbo_dashboard_cache_latest (one row per realm+metric, sql/293) — no live pulls
  on load, so the page stays instant. The nightly job in sql/293 keeps starred
  realms current; "Refresh all" re-pulls on demand through dashboard-qbo-pull.
  All the arithmetic is in portfolioSignals.js.
*/

const BAD_CH_STATUS = /(strike|liquidat|administrat|insolven|dissolv|receiver)/i;

const C = {
  ink: '#0f172a', sub: '#64748b', faint: '#94a3b8', rule: '#f1f5f9',
  good: '#15803d', bad: '#b91c1c', accent: '#38bdf8',
  redBg: '#fef2f2', redBd: '#fecaca', redFg: '#991b1b',
  ambBg: '#fffbeb', ambBd: '#fde68a', ambFg: '#92400e',
};

export default function PortfolioDashboardPage() {
  const { profile } = useAuth();
  const navigate = useNavigate();
  const [cards, setCards] = useState([]);
  const [loading, setLoading] = useState(true);
  const [sortBy, setSortBy] = useState('attention');
  const [refreshing, setRefreshing] = useState(null); // { done, total, failed: [] }

  const load = async () => {
    if (!profile?.id) return;
    setLoading(true);
    try {
      // 1. My starred clients (realm-keyed; CH status via the optional entity link)
      const { data: favs } = await supabase
        .from('staff_client_favourites')
        .select('realm_id, entity_id, created_at, entity:entities(id, name, company_status, company_status_detail)')
        .eq('staff_id', profile.id)
        .order('created_at', { ascending: true });
      const favourites = (favs || []).filter((f) => f.realm_id);
      if (!favourites.length) { setCards([]); setLoading(false); return; }

      // 2. QBO report connections for those realms
      const realmIds = favourites.map((f) => f.realm_id);
      const { data: conns } = await supabase
        .from('qbo_report_connections')
        .select('realm_id, company_name, entity_id, status')
        .in('realm_id', realmIds);
      const connByRealm = {};
      for (const c of conns || []) connByRealm[c.realm_id] = c;

      // 3. Latest snapshot per headline metric, plus ~2 months of aged-debtor
      //    buckets (just the buckets) so the tile can say whether 90+ is rising.
      const since = new Date(Date.now() - 70 * 86400000).toISOString().slice(0, 10);
      const [{ data: latestRows }, { data: agedRows }] = await Promise.all([
        supabase.from('qbo_dashboard_cache_latest')
          .select('realm_id, metric_key, period_end, data, pulled_at')
          .in('realm_id', realmIds)
          .in('metric_key', PORTFOLIO_METRICS),
        supabase.from('qbo_dashboard_cache')
          .select('realm_id, metric_key, period_end, pulled_at, buckets:data->buckets')
          .in('realm_id', realmIds)
          .eq('metric_key', 'aged_receivables')
          .gte('period_end', since)
          .order('pulled_at', { ascending: false }),
      ]);
      const rowsByRealm = {};
      for (const r of latestRows || []) (rowsByRealm[r.realm_id] ||= []).push(r);
      for (const r of agedRows || []) {
        (rowsByRealm[r.realm_id] ||= []).push({ ...r, data: { buckets: r.buckets } });
      }
      for (const k of Object.keys(rowsByRealm)) {
        rowsByRealm[k].sort((a, b) => String(b.pulled_at).localeCompare(String(a.pulled_at)));
      }

      setCards(favourites.map((f, i) => {
        const conn = connByRealm[f.realm_id] || null;
        const chStatus = f.entity?.company_status || null;
        const chDetail = f.entity?.company_status_detail || null;
        const chBad = !!(chStatus && chStatus !== 'active');
        const chLabel = chStatus
          ? `${chStatus.replace(/-/g, ' ')}${chDetail ? ` (${chDetail.replace(/-/g, ' ')})` : ''}` : '';
        const chSevere = BAD_CH_STATUS.test(chLabel);
        const figures = buildPortfolioFigures(rowsByRealm[f.realm_id] || []);
        const flags = portfolioFlags(figures, { chBad, chSevere, chLabel });
        return {
          order: i,
          realmKey: f.realm_id,
          realmId: f.realm_id,
          connected: !!conn,
          name: conn?.company_name || f.entity?.name || 'Unknown client',
          figures, flags, score: attentionScore(flags),
        };
      }));
    } catch { setCards([]); }
    setLoading(false);
  };

  useEffect(() => { load(); }, [profile?.id]);

  const sorted = useMemo(() => {
    const list = [...cards];
    if (sortBy === 'attention') list.sort((a, b) => b.score - a.score || a.order - b.order);
    else if (sortBy === 'name') list.sort((a, b) => a.name.localeCompare(b.name));
    else if (sortBy === 'revenue') list.sort((a, b) => (b.figures.revenue ?? -Infinity) - (a.figures.revenue ?? -Infinity));
    return list;
  }, [cards, sortBy]);

  const unstar = async (realmId) => {
    setCards((prev) => prev.filter((c) => c.realmKey !== realmId));
    try {
      await supabase.from('staff_client_favourites').delete()
        .eq('staff_id', profile.id).eq('realm_id', realmId);
    } catch { load(); }
  };

  // Re-pull every starred, connected realm — two at a time, so a long list
  // doesn't fan out a burst of QuickBooks calls at once.
  const refreshAll = async () => {
    const targets = cards.filter((c) => c.connected);
    if (!targets.length) return;
    const state = { done: 0, total: targets.length, failed: [] };
    setRefreshing({ ...state });
    const queue = [...targets];
    const worker = async () => {
      while (queue.length) {
        const c = queue.shift();
        try {
          const { data, error } = await supabase.functions.invoke('dashboard-qbo-pull', {
            body: { realmId: c.realmId, refresh: true, metrics: PORTFOLIO_METRICS },
          });
          if (error || !data?.success) state.failed.push(c.name);
        } catch { state.failed.push(c.name); }
        state.done += 1;
        setRefreshing({ ...state });
      }
    };
    await Promise.all([worker(), worker()]);
    await load();
    setRefreshing(state.failed.length ? { ...state, finished: true } : null);
  };

  const flaggedCount = cards.filter((c) => c.flags.some((f) => f.level === 'red')).length;

  return (
    <div style={{ maxWidth: '1180px', margin: '0 auto', padding: '40px 24px' }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: '16px', flexWrap: 'wrap', marginBottom: '24px' }}>
        <div style={{ flex: 1, minWidth: '260px' }}>
          <h1 style={{ fontFamily: PLAYFAIR, fontSize: '28px', fontWeight: 500, color: C.ink, marginBottom: '8px' }}>
            Portfolio
          </h1>
          <p style={{ fontFamily: OUTFIT, fontSize: '14px', color: C.sub, margin: 0 }}>
            Your starred clients, each figure against last year or last month. Refreshed from QuickBooks every morning.
            {!loading && cards.length > 0 && flaggedCount > 0 && (
              <span style={{ color: C.redFg, fontWeight: 600 }}> {flaggedCount} need{flaggedCount === 1 ? 's' : ''} attention.</span>
            )}
          </p>
        </div>
        {!loading && cards.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value)}
              style={{ fontFamily: OUTFIT, fontSize: '13px', padding: '8px 10px', border: '1px solid #e5e7eb', borderRadius: '10px', background: '#fff', color: C.ink }}
            >
              <option value="attention">Needs attention first</option>
              <option value="starred">Order starred</option>
              <option value="revenue">Revenue YTD</option>
              <option value="name">Name</option>
            </select>
            <button
              onClick={refreshAll}
              disabled={!!refreshing && !refreshing.finished}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '8px 14px',
                border: '1px solid #e5e7eb', borderRadius: '10px', backgroundColor: '#fff',
                cursor: refreshing && !refreshing.finished ? 'default' : 'pointer',
                fontFamily: OUTFIT, fontSize: '13px', fontWeight: 600, color: '#0369a1',
              }}
            >
              <RefreshCw size={14} style={refreshing && !refreshing.finished ? { animation: 'spin 1s linear infinite' } : undefined} />
              {refreshing && !refreshing.finished ? `Refreshing ${refreshing.done}/${refreshing.total}…` : 'Refresh all'}
            </button>
          </div>
        )}
      </div>

      {refreshing?.finished && refreshing.failed.length > 0 && (
        <div style={{ ...cardStyle, padding: '10px 14px', marginBottom: '16px', fontFamily: OUTFIT, fontSize: '13px', color: C.ambFg, backgroundColor: C.ambBg, border: `1px solid ${C.ambBd}` }}>
          Couldn't refresh {refreshing.failed.join(', ')} — open the dashboard to see why (usually an expired QuickBooks connection).
          <button onClick={() => setRefreshing(null)} style={{ marginLeft: '10px', background: 'none', border: 'none', cursor: 'pointer', color: C.ambFg, fontWeight: 600, fontFamily: OUTFIT }}>Dismiss</button>
        </div>
      )}

      {loading && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', color: '#0369a1', fontFamily: OUTFIT, fontSize: '14px', fontWeight: 600 }}>
          <Loader size={16} style={{ animation: 'spin 1s linear infinite' }} /> Loading your portfolio…
        </div>
      )}

      {!loading && cards.length === 0 && (
        <div style={{ ...cardStyle, textAlign: 'center', padding: '56px 24px' }}>
          <Star size={28} style={{ color: '#f59e0b', marginBottom: '12px' }} />
          <div style={{ fontFamily: OUTFIT, fontSize: '16px', fontWeight: 700, color: C.ink, marginBottom: '6px' }}>
            No starred clients yet
          </div>
          <div style={{ fontFamily: OUTFIT, fontSize: '13px', color: C.sub, maxWidth: '440px', margin: '0 auto 18px' }}>
            Open the Client Dashboard, pick a client and click the star next to their name.
            Starred clients appear here with their key metrics, so you can watch your portfolio at a glance.
          </div>
          <button
            onClick={() => navigate('/client-dashboard')}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '9px 18px',
              border: '1px solid #e5e7eb', borderRadius: '10px', backgroundColor: '#ffffff',
              cursor: 'pointer', fontFamily: OUTFIT, fontSize: '13px', fontWeight: 600, color: C.accent,
            }}
          >
            Open Client Dashboard <ArrowRight size={14} />
          </button>
        </div>
      )}

      {!loading && cards.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(520px, 100%), 1fr))', gap: '16px' }}>
          {sorted.map((c) => <PortfolioCard key={c.realmKey} card={c} navigate={navigate} unstar={unstar} />)}
        </div>
      )}

      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

/* ─── Card ─────────────────────────────────────────────────────── */

function PortfolioCard({ card, navigate, unstar }) {
  const f = card.figures;
  const cur = f.currency;
  const openDash = () => { if (card.realmId) navigate(`/client-dashboard?realm=${encodeURIComponent(card.realmId)}`); };
  const shownFlags = card.flags.slice(0, 4);
  const moreFlags = card.flags.length - shownFlags.length;

  return (
    <div style={{ ...cardStyle, padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '8px' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            onClick={openDash}
            title={card.realmId ? 'Open dashboard' : undefined}
            style={{
              fontFamily: OUTFIT, fontSize: '16px', fontWeight: 700, color: C.ink,
              cursor: card.realmId ? 'pointer' : 'default', overflow: 'hidden',
              textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}
          >
            {card.name}
          </div>
          {f.ytdPeriod?.start && (
            <div style={{ fontFamily: OUTFIT, fontSize: '11.5px', color: C.faint, marginTop: '2px' }}>
              Year to date {shortDate(f.ytdPeriod.start)} – {shortDate(f.ytdPeriod.end)}, against the same dates last year
            </div>
          )}
        </div>
        {f.oldestPulledAt && <FreshnessChip f={f} />}
        <button
          onClick={() => unstar(card.realmKey)}
          title="Remove from Portfolio"
          style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '2px', flexShrink: 0 }}
        >
          <Star size={16} style={{ color: '#f59e0b', fill: '#f59e0b' }} />
        </button>
      </div>

      {!card.connected ? (
        <div style={{ fontFamily: OUTFIT, fontSize: '12.5px', color: C.faint, display: 'flex', alignItems: 'center', gap: '6px' }}>
          <Link2Off size={14} /> No QuickBooks reports connection for this client.
        </div>
      ) : !f.hasFigures ? (
        <div style={{ fontFamily: OUTFIT, fontSize: '12.5px', color: C.faint }}>
          No cached figures yet — use Refresh all, or open the dashboard to pull from QuickBooks
          (reconnect them if the pull fails).
        </div>
      ) : (
        <>
          {/* Verdict */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
            {shownFlags.length === 0 ? (
              <span style={chip('good')}><CheckCircle2 size={11} /> Nothing flagged</span>
            ) : shownFlags.map((fl) => (
              <span key={fl.text} style={chip(fl.level)}>
                <AlertTriangle size={11} /> {fl.text}
              </span>
            ))}
            {moreFlags > 0 && (
              <span title={card.flags.slice(4).map((x) => x.text).join('\n')} style={{ ...chip('amber'), cursor: 'help' }}>
                +{moreFlags} more
              </span>
            )}
          </div>

          {/* Three columns */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '14px 18px' }}>
            <Column title="Performance">
              <Metric
                label="Revenue YTD"
                value={money(f.revenue, cur)}
                delta={f.revenueChange != null ? { text: fmtPct(f.revenueChange), good: f.revenueChange >= 0 } : null}
                note={f.revenuePrior != null ? `${moneyCompact(f.revenuePrior, cur)} last year` : 'no prior year'}
              />
              <Metric
                label="Net profit YTD"
                value={money(f.profit, cur)}
                negative={f.profit < 0}
                delta={f.profitDelta != null ? { text: fmtMoneyDelta(f.profitDelta, cur), good: f.profitDelta >= 0 } : null}
                note={f.profitPrior != null ? `${moneyCompact(f.profitPrior, cur)} last year` : null}
              />
              <Metric
                label="Net margin"
                value={f.margin != null ? `${(f.margin * 100).toFixed(1)}%` : '—'}
                negative={f.margin < 0}
                delta={f.marginDeltaPts != null ? { text: `${f.marginDeltaPts >= 0 ? '+' : '−'}${Math.abs(f.marginDeltaPts).toFixed(1)} pts`, good: f.marginDeltaPts >= 0 } : null}
                note={f.marginPrior != null ? `${(f.marginPrior * 100).toFixed(1)}% last year` : null}
              />
            </Column>

            <Column title="Cash & liquidity">
              <Metric
                label="Cash"
                value={money(f.cash, cur)}
                negative={f.cash < 0}
                delta={f.cashDeltaM1 != null ? { text: `${fmtMoneyDelta(f.cashDeltaM1, cur)} on last month`, good: f.cashDeltaM1 >= 0 } : null}
                note={f.cashDeltaM12 != null ? `${fmtMoneyDelta(f.cashDeltaM12, cur)} on a year ago` : null}
              />
              <Metric
                label="Cash cover"
                value={f.cashCover != null ? `${f.cashCover.toFixed(1)} months` : '—'}
                tone={f.cashCover == null ? null : f.cashCover < 1 ? 'bad' : f.cashCover < 2 ? 'warn' : null}
                note={f.avgCosts != null ? `costs avg ${moneyCompact(f.avgCosts, cur)}/mo` : null}
              />
              <Metric
                label="Working capital"
                value={money(f.workingCapital, cur)}
                negative={f.workingCapital < 0}
                note={f.workingCapitalM12 != null ? `${moneyCompact(f.workingCapitalM12, cur)} a year ago` : 'current assets less current liabilities'}
              />
            </Column>

            <Column title="Debtors & creditors">
              <Metric
                label="Debtors"
                value={money(f.debtors, cur)}
                note={f.debtorDays != null ? `${Math.round(f.debtorDays)} debtor days` : null}
              />
              {f.ar && <AgeingBar aged={f.ar} previous={f.arPrev} currency={cur} />}
              <Metric
                label="Creditors"
                value={money(f.ap?.total ?? null, cur)}
                note={f.ap ? `${Math.round(f.ap.over90Share * 100)}% over 90 days` : null}
              />
            </Column>
          </div>

          {f.monthly.length > 1 && <TrendChart months={f.monthly} currency={cur} />}
        </>
      )}

      {/* Footer */}
      <div style={{ display: 'flex', alignItems: 'center', marginTop: 'auto', paddingTop: '2px' }}>
        {card.connected && (
          <button
            onClick={openDash}
            style={{
              marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: '4px',
              background: 'none', border: 'none', cursor: 'pointer', padding: 0,
              fontFamily: OUTFIT, fontSize: '12px', fontWeight: 600, color: C.accent,
            }}
          >
            Open dashboard <ArrowRight size={13} />
          </button>
        )}
      </div>
    </div>
  );
}

/* ─── Pieces ───────────────────────────────────────────────────── */

function chip(level) {
  const s = level === 'red' ? [C.redFg, C.redBg, C.redBd]
    : level === 'amber' ? [C.ambFg, C.ambBg, C.ambBd]
    : ['#166534', '#f0fdf4', '#bbf7d0'];
  return {
    display: 'inline-flex', alignItems: 'center', gap: '4px',
    fontFamily: OUTFIT, fontSize: '11.5px', fontWeight: 600, padding: '3px 9px', borderRadius: '7px',
    color: s[0], backgroundColor: s[1], border: `1px solid ${s[2]}`,
  };
}

function FreshnessChip({ f }) {
  const label = f.oldestPulledAt === f.newestPulledAt || !f.newestPulledAt
    ? timeAgo(f.oldestPulledAt) : `${timeAgo(f.newestPulledAt)} – ${timeAgo(f.oldestPulledAt)}`;
  return (
    <span
      title={`Oldest figure on this card pulled ${new Date(f.oldestPulledAt).toLocaleString('en-GB')}`}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: '4px', flexShrink: 0, marginTop: '2px',
        fontFamily: OUTFIT, fontSize: '11px', fontWeight: f.stale ? 600 : 400,
        color: f.stale ? C.ambFg : '#cbd5e1',
        ...(f.stale ? { backgroundColor: C.ambBg, border: `1px solid ${C.ambBd}`, borderRadius: '7px', padding: '2px 7px' } : {}),
      }}
    >
      <Clock size={11} /> {label}
    </span>
  );
}

function Column({ title, children }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', minWidth: 0 }}>
      <div style={{ fontFamily: OUTFIT, fontSize: '10.5px', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: C.faint, borderBottom: `1px solid ${C.rule}`, paddingBottom: '4px' }}>
        {title}
      </div>
      {children}
    </div>
  );
}

function Metric({ label, value, delta, note, negative, tone }) {
  const colour = negative || tone === 'bad' ? C.redFg : tone === 'warn' ? C.ambFg : C.ink;
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontFamily: OUTFIT, fontSize: '11px', color: C.faint }}>{label}</div>
      <div style={{ fontFamily: OUTFIT, fontSize: '16px', fontWeight: 700, color: colour, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {value}
      </div>
      {delta && (
        <div style={{ fontFamily: OUTFIT, fontSize: '11.5px', fontWeight: 600, color: delta.good ? C.good : C.bad }}>
          {delta.good ? '▲' : '▼'} {delta.text}
        </div>
      )}
      {note && <div style={{ fontFamily: OUTFIT, fontSize: '11px', color: C.faint }}>{note}</div>}
    </div>
  );
}

const AGE_BANDS = [
  ['current', 'Current', '#bae6fd'],
  ['b1_30', '1–30', '#7dd3fc'],
  ['b31_60', '31–60', '#fcd34d'],
  ['b61_90', '61–90', '#fb923c'],
  ['b91_plus', '90+', '#dc2626'],
];

function AgeingBar({ aged, previous, currency }) {
  const tip = AGE_BANDS.map(([k, l]) => `${l}: ${money(aged.buckets[k], currency)}`).join('\n');
  const prevShare = previous ? previous.over90Share : null;
  const prevDate = previous?.asAt ? new Date(previous.asAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : null;
  return (
    <div title={tip}>
      <div style={{ display: 'flex', height: '8px', borderRadius: '4px', overflow: 'hidden', backgroundColor: C.rule, gap: '1px' }}>
        {AGE_BANDS.map(([k, , colour]) => {
          const w = aged.total > 0 ? Math.max(0, aged.buckets[k]) / aged.total : 0;
          return w > 0 ? <div key={k} style={{ width: `${w * 100}%`, backgroundColor: colour }} /> : null;
        })}
      </div>
      <div style={{ fontFamily: OUTFIT, fontSize: '11px', color: aged.over90Share >= 0.25 ? C.redFg : C.faint, marginTop: '3px', fontWeight: aged.over90Share >= 0.25 ? 600 : 400 }}>
        {Math.round(aged.over90Share * 100)}% over 90 days
        {prevShare != null && (
          <span style={{ fontWeight: 400, color: C.faint }}> · {Math.round(prevShare * 100)}% on {prevDate}</span>
        )}
      </div>
    </div>
  );
}

// 12 months: revenue as bars, net profit as a line, one shared scale with a
// zero line so losses sit visibly below it. A part-month is drawn hatched.
function TrendChart({ months, currency }) {
  const W = 560, H = 96, P = { l: 4, r: 4, t: 8, b: 16 };
  const vals = months.flatMap((m) => [m.income, m.net]);
  const max = Math.max(...vals, 0);
  const min = Math.min(...vals, 0);
  const span = max - min || 1;
  const iw = (W - P.l - P.r) / months.length;
  const y = (v) => P.t + (1 - (v - min) / span) * (H - P.t - P.b);
  const cx = (i) => P.l + iw * i + iw / 2;
  const line = months.map((m, i) => `${cx(i).toFixed(1)},${y(m.net).toFixed(1)}`).join(' ');

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '12px', fontFamily: OUTFIT, fontSize: '11px', color: C.faint, marginBottom: '4px' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
          <span style={{ width: '9px', height: '9px', backgroundColor: '#bae6fd', borderRadius: '2px' }} /> Revenue
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
          <span style={{ width: '12px', height: '2px', backgroundColor: '#0f766e' }} /> Net profit
        </span>
        <span style={{ marginLeft: 'auto' }}>last 12 months · peak {moneyCompact(max, currency)}</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }} role="img"
        aria-label="Monthly revenue and net profit, last 12 months">
        <defs>
          <pattern id="pf-hatch" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width="4" height="4" fill="#e0f2fe" /><line x1="0" y1="0" x2="0" y2="4" stroke="#bae6fd" strokeWidth="2" />
          </pattern>
        </defs>
        {months.map((m, i) => {
          const top = y(Math.max(m.income, 0));
          const h = Math.abs(y(m.income) - y(0));
          return (
            <rect key={i} x={P.l + iw * i + iw * 0.15} y={m.income >= 0 ? top : y(0)} width={iw * 0.7} height={Math.max(h, 0.5)}
              fill={m.partial ? 'url(#pf-hatch)' : '#bae6fd'} rx="1.5">
              <title>{`${m.label}${m.partial ? ' (to date)' : ''}: revenue ${money(m.income, currency)}, net profit ${money(m.net, currency)}`}</title>
            </rect>
          );
        })}
        <line x1={P.l} x2={W - P.r} y1={y(0)} y2={y(0)} stroke="#cbd5e1" strokeWidth="1" />
        <polyline points={line} fill="none" stroke="#0f766e" strokeWidth="2" strokeLinejoin="round" />
        {months.map((m, i) => (
          <circle key={i} cx={cx(i)} cy={y(m.net)} r="2.2" fill={m.net < 0 ? C.bad : '#0f766e'} />
        ))}
      </svg>
      <div style={{ display: 'flex', fontFamily: OUTFIT, fontSize: '10px', color: '#cbd5e1' }}>
        {months.map((m, i) => (
          <span key={i} style={{ flex: 1, textAlign: 'center' }}>{i % 2 === 0 || months.length <= 6 ? shortMonth(m.label).split(' ')[0] : ''}</span>
        ))}
      </div>
    </div>
  );
}

/* ─── Formatting ───────────────────────────────────────────────── */

function fmtPct(v) {
  const p = Math.abs(v * 100);
  return `${p >= 10 ? Math.round(p) : p.toFixed(1)}% vs last year`;
}

function fmtMoneyDelta(v, currency) {
  return `${v >= 0 ? '+' : '−'}${moneyCompact(Math.abs(v), currency)}`;
}
