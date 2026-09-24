import React, { useState } from 'react';
import { Star, AlertTriangle, Link2Off, ArrowRight, CheckCircle2, Clock, RefreshCw, ChevronDown, ChevronRight } from 'lucide-react';
import { money, moneyCompact, timeAgo, shortDate, shortMonth, OUTFIT, cardStyle } from './dashboardData';

/*
  The Portfolio's three presentations of the same card model (see
  PortfolioDashboardPage): an expanded tile, a compact tile, and a list row
  that opens into the expanded tile. All figures come in pre-computed from
  portfolioSignals.js — nothing here does arithmetic beyond formatting.
*/

export const C = {
  ink: '#0f172a', sub: '#64748b', faint: '#94a3b8', rule: '#f1f5f9',
  good: '#15803d', bad: '#b91c1c', accent: '#38bdf8',
  redBg: '#fef2f2', redBd: '#fecaca', redFg: '#991b1b',
  ambBg: '#fffbeb', ambBd: '#fde68a', ambFg: '#92400e',
  bar: '#bae6fd', profit: '#0f766e', lastYear: '#64748b',
};

/* ─── Shared bits ──────────────────────────────────────────────── */

export function chip(level) {
  const s = level === 'red' ? [C.redFg, C.redBg, C.redBd]
    : level === 'amber' ? [C.ambFg, C.ambBg, C.ambBd]
    : ['#166534', '#f0fdf4', '#bbf7d0'];
  return {
    display: 'inline-flex', alignItems: 'center', gap: '4px',
    fontFamily: OUTFIT, fontSize: '12.5px', fontWeight: 600, padding: '3px 9px', borderRadius: '7px',
    color: s[0], backgroundColor: s[1], border: `1px solid ${s[2]}`, whiteSpace: 'nowrap',
  };
}

function Flags({ flags, max }) {
  const shown = flags.slice(0, max);
  const more = flags.length - shown.length;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
      {shown.length === 0 ? (
        <span style={chip('good')}><CheckCircle2 size={11} /> Nothing flagged</span>
      ) : shown.map((fl) => (
        <span key={fl.text} style={chip(fl.level)}><AlertTriangle size={11} /> {fl.text}</span>
      ))}
      {more > 0 && (
        <span title={flags.slice(max).map((x) => x.text).join('\n')} style={{ ...chip('amber'), cursor: 'help' }}>
          +{more} more
        </span>
      )}
    </div>
  );
}

function FreshnessChip({ f }) {
  if (!f.oldestPulledAt) return null;
  const label = f.oldestPulledAt === f.newestPulledAt || !f.newestPulledAt
    ? timeAgo(f.oldestPulledAt) : `${timeAgo(f.newestPulledAt)} – ${timeAgo(f.oldestPulledAt)}`;
  return (
    <span
      title={`Oldest figure on this card pulled ${new Date(f.oldestPulledAt).toLocaleString('en-GB')}`}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: '4px', flexShrink: 0, marginTop: '2px',
        fontFamily: OUTFIT, fontSize: '12px', fontWeight: f.stale ? 600 : 400,
        color: f.stale ? C.ambFg : '#cbd5e1', whiteSpace: 'nowrap',
        ...(f.stale ? { backgroundColor: C.ambBg, border: `1px solid ${C.ambBd}`, borderRadius: '7px', padding: '2px 7px' } : {}),
      }}
    >
      <Clock size={11} /> {label}
    </span>
  );
}

function StarButton({ onClick }) {
  return (
    <button onClick={onClick} title="Remove from Portfolio"
      style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '2px', flexShrink: 0 }}>
      <Star size={16} style={{ color: '#f59e0b', fill: '#f59e0b' }} />
    </button>
  );
}

function PeriodLine({ w }) {
  if (!w) return null;
  return (
    <div style={{ fontFamily: OUTFIT, fontSize: '12.5px', color: C.faint, marginTop: '2px' }}>
      {shortDate(w.plStart)} – {shortDate(w.plEnd)}, against the same dates last year
    </div>
  );
}

// "No figures for this period yet" with a one-client pull.
function NotPulled({ card, onPull, compact }) {
  return (
    <div style={{ fontFamily: OUTFIT, fontSize: '13.5px', color: C.faint, display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
      {card.pulling ? 'Pulling from QuickBooks…'
        : card.pullError ? <span style={{ color: C.ambFg }}>{card.pullError}</span>
        : compact ? 'Not pulled for this period.' : 'Not pulled from QuickBooks for this period yet.'}
      {!card.pulling && (
        <button onClick={onPull} style={linkBtn}>
          <RefreshCw size={12} /> Pull now
        </button>
      )}
    </div>
  );
}

const linkBtn = {
  display: 'inline-flex', alignItems: 'center', gap: '4px', background: 'none', border: 'none',
  cursor: 'pointer', padding: 0, fontFamily: OUTFIT, fontSize: '13px', fontWeight: 600, color: C.accent,
};

export const fmtPct = (v) => {
  const p = Math.abs(v * 100);
  return `${p >= 10 ? Math.round(p) : p.toFixed(1)}%`;
};
export const fmtMoneyDelta = (v, currency) => `${v >= 0 ? '+' : '−'}${moneyCompact(Math.abs(v), currency)}`;
export const fmtPts = (v) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)} pts`;

function Metric({ label, value, delta, note, negative, tone, big = true }) {
  const colour = negative || tone === 'bad' ? C.redFg : tone === 'warn' ? C.ambFg : C.ink;
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontFamily: OUTFIT, fontSize: '12px', color: C.faint }}>{label}</div>
      <div style={{ fontFamily: OUTFIT, fontSize: big ? '16px' : '15px', fontWeight: 700, color: colour, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {value}
      </div>
      {delta && (
        <div style={{ fontFamily: OUTFIT, fontSize: '12.5px', fontWeight: 600, color: delta.good ? C.good : C.bad, whiteSpace: 'nowrap' }}>
          {delta.good ? '▲' : '▼'} {delta.text}
        </div>
      )}
      {note && <div style={{ fontFamily: OUTFIT, fontSize: '12px', color: C.faint }}>{note}</div>}
    </div>
  );
}

function Column({ title, children }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', minWidth: 0 }}>
      <div style={{ fontFamily: OUTFIT, fontSize: '11.5px', fontWeight: 700, color: C.faint, borderBottom: `1px solid ${C.rule}`, paddingBottom: '4px' }}>
        {title}
      </div>
      {children}
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
  const prevDate = previous?.asAt
    ? new Date(`${previous.asAt}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : null;
  return (
    <div title={tip}>
      <div style={{ display: 'flex', height: '8px', borderRadius: '4px', overflow: 'hidden', backgroundColor: C.rule, gap: '1px' }}>
        {AGE_BANDS.map(([k, , colour]) => {
          const w = aged.total > 0 ? Math.max(0, aged.buckets[k]) / aged.total : 0;
          return w > 0 ? <div key={k} style={{ width: `${w * 100}%`, backgroundColor: colour }} /> : null;
        })}
      </div>
      <div style={{ fontFamily: OUTFIT, fontSize: '12px', color: aged.over90Share >= 0.25 ? C.redFg : C.faint, marginTop: '3px', fontWeight: aged.over90Share >= 0.25 ? 600 : 400 }}>
        {Math.round(aged.over90Share * 100)}% over 90 days
        {previous && prevDate && (
          <span style={{ fontWeight: 400, color: C.faint }}> · {Math.round(previous.over90Share * 100)}% at {prevDate}</span>
        )}
      </div>
    </div>
  );
}

/*
  12 months: revenue bars, net profit line, and — when 24 months are cached —
  last year's revenue as a dashed line over the bars, month for month. One
  shared scale with a zero line, so losses sit visibly below it. A part-month
  is drawn hatched.
*/
export function TrendChart({ months, currency, compact = false, id }) {
  const W = compact ? 280 : 560;
  const H = compact ? 56 : 104;
  const P = { l: 4, r: 4, t: 6, b: compact ? 4 : 14 };
  const hasLY = months.some((m) => m.incomeLY != null);
  const vals = months.flatMap((m) => [m.income, compact ? 0 : m.net, m.incomeLY ?? 0]);
  const max = Math.max(...vals, 0);
  const min = Math.min(...vals, 0);
  const span = max - min || 1;
  const iw = (W - P.l - P.r) / months.length;
  const y = (v) => P.t + (1 - (v - min) / span) * (H - P.t - P.b);
  const cx = (i) => P.l + iw * i + iw / 2;
  const path = (key) => months.map((m, i) => `${cx(i).toFixed(1)},${y(m[key] ?? 0).toFixed(1)}`).join(' ');
  const hatch = `pf-hatch-${id}`;

  return (
    <div>
      {!compact && (
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '12px', flexWrap: 'wrap', fontFamily: OUTFIT, fontSize: '12px', color: C.faint, marginBottom: '4px' }}>
          <Legend swatch={<span style={{ width: '9px', height: '9px', backgroundColor: C.bar, borderRadius: '2px' }} />} text="Revenue" />
          {hasLY && <Legend swatch={<span style={{ width: '12px', borderTop: `2px dashed ${C.lastYear}` }} />} text="Revenue last year" />}
          <Legend swatch={<span style={{ width: '12px', height: '2px', backgroundColor: C.profit }} />} text="Net profit" />
          <span style={{ marginLeft: 'auto' }}>12 months · peak {moneyCompact(max, currency)}</span>
        </div>
      )}
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }} role="img"
        aria-label={`Monthly revenue${hasLY ? ' against last year' : ''} and net profit, 12 months`}>
        <defs>
          <pattern id={hatch} width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width="4" height="4" fill="#e0f2fe" /><line x1="0" y1="0" x2="0" y2="4" stroke={C.bar} strokeWidth="2" />
          </pattern>
        </defs>
        {months.map((m, i) => {
          const h = Math.abs(y(m.income) - y(0));
          return (
            <rect key={i} x={P.l + iw * i + iw * 0.15} y={m.income >= 0 ? y(m.income) : y(0)} width={iw * 0.7} height={Math.max(h, 0.5)}
              fill={m.partial ? `url(#${hatch})` : C.bar} rx="1.5">
              <title>{`${m.label}${m.partial ? ' (to date)' : ''}: revenue ${money(m.income, currency)}`
                + `${m.incomeLY != null ? ` (last year ${money(m.incomeLY, currency)})` : ''}, net profit ${money(m.net, currency)}`}</title>
            </rect>
          );
        })}
        <line x1={P.l} x2={W - P.r} y1={y(0)} y2={y(0)} stroke="#cbd5e1" strokeWidth="1" />
        {hasLY && (
          <polyline points={path('incomeLY')} fill="none" stroke={C.lastYear} strokeWidth={compact ? 1.4 : 1.6}
            strokeDasharray="4 3" strokeLinejoin="round" opacity="0.8" />
        )}
        {!compact && (
          <>
            <polyline points={path('net')} fill="none" stroke={C.profit} strokeWidth="2" strokeLinejoin="round" />
            {months.map((m, i) => (
              <circle key={i} cx={cx(i)} cy={y(m.net)} r="2.2" fill={m.net < 0 ? C.bad : C.profit} />
            ))}
          </>
        )}
      </svg>
      {!compact && (
        <div style={{ display: 'flex', fontFamily: OUTFIT, fontSize: '11px', color: '#cbd5e1' }}>
          {months.map((m, i) => (
            <span key={i} style={{ flex: 1, textAlign: 'center' }}>{i % 2 === 0 ? shortMonth(m.label).split(' ')[0] : ''}</span>
          ))}
        </div>
      )}
    </div>
  );
}

function Legend({ swatch, text }) {
  return <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>{swatch} {text}</span>;
}

/* ─── Expanded tile ────────────────────────────────────────────── */

export function ExpandedTile({ card, onOpen, onUnstar, onPull, bare = false }) {
  const f = card.figures;
  const cur = f.currency;
  return (
    <div style={bare ? { display: 'flex', flexDirection: 'column', gap: '14px' } : { ...cardStyle, padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
      {!bare && (
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: '8px' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <Name card={card} onOpen={onOpen} size="16px" />
            <PeriodLine w={card.window} />
          </div>
          <FreshnessChip f={f} />
          <StarButton onClick={onUnstar} />
        </div>
      )}

      <Body card={card} onPull={onPull}>
        <Flags flags={card.flags} max={4} />

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '14px 18px' }}>
          <Column title="Performance">
            <Metric label="Revenue" value={money(f.revenue, cur)}
              delta={f.revenueChange != null ? { text: `${fmtPct(f.revenueChange)} vs last year`, good: f.revenueChange >= 0 } : null}
              note={f.revenuePrior != null ? `${moneyCompact(f.revenuePrior, cur)} last year` : 'no prior year'} />
            <Metric label="Net profit" value={money(f.profit, cur)} negative={f.profit < 0}
              delta={f.profitDelta != null ? { text: fmtMoneyDelta(f.profitDelta, cur), good: f.profitDelta >= 0 } : null}
              note={f.profitPrior != null ? `${moneyCompact(f.profitPrior, cur)} last year` : null} />
            <Metric label="Net margin" value={f.margin != null ? `${(f.margin * 100).toFixed(1)}%` : '—'} negative={f.margin < 0}
              delta={f.marginDeltaPts != null ? { text: fmtPts(f.marginDeltaPts), good: f.marginDeltaPts >= 0 } : null}
              note={f.marginPrior != null ? `${(f.marginPrior * 100).toFixed(1)}% last year` : null} />
          </Column>

          <Column title={`Cash & liquidity${card.window ? ` · ${shortDate(card.window.asAt)}` : ''}`}>
            <Metric label="Cash" value={money(f.cash, cur)} negative={f.cash < 0}
              delta={f.cashDeltaM1 != null ? { text: `${fmtMoneyDelta(f.cashDeltaM1, cur)} on prior month`, good: f.cashDeltaM1 >= 0 } : null}
              note={f.cashDeltaM12 != null ? `${fmtMoneyDelta(f.cashDeltaM12, cur)} on a year earlier` : null} />
            <Metric label="Cash cover" value={f.cashCover != null ? `${f.cashCover.toFixed(1)} months` : '—'}
              tone={f.cashCover == null ? null : f.cashCover < 1 ? 'bad' : f.cashCover < 2 ? 'warn' : null}
              note={f.avgCosts != null ? `costs avg ${moneyCompact(f.avgCosts, cur)}/mo` : null} />
            <Metric label="Working capital" value={money(f.workingCapital, cur)} negative={f.workingCapital < 0}
              note={f.workingCapitalM12 != null ? `${moneyCompact(f.workingCapitalM12, cur)} a year earlier` : 'current assets less current liabilities'} />
          </Column>

          <Column title="Debtors & creditors">
            <Metric label="Debtors" value={money(f.debtors, cur)}
              note={f.debtorDays != null ? `${Math.round(f.debtorDays)} debtor days` : null} />
            {f.ar && <AgeingBar aged={f.ar} previous={f.arPrev} currency={cur} />}
            <Metric label="Creditors" value={money(f.ap?.total ?? null, cur)}
              note={f.ap ? `${Math.round(f.ap.over90Share * 100)}% over 90 days` : null} />
          </Column>
        </div>

        {f.monthly.length > 1 && <TrendChart months={f.monthly} currency={cur} id={`x${card.realmKey}`} />}
      </Body>

      {!bare && card.connected && (
        <div style={{ display: 'flex', marginTop: 'auto' }}>
          <button onClick={onOpen} style={{ ...linkBtn, marginLeft: 'auto' }}>Open dashboard <ArrowRight size={13} /></button>
        </div>
      )}
    </div>
  );
}

/* ─── Compact tile ─────────────────────────────────────────────── */

export function CompactTile({ card, onOpen, onUnstar, onPull }) {
  const f = card.figures;
  const cur = f.currency;
  const worst = card.flags[0]?.level;
  return (
    <div style={{
      ...cardStyle, padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: '10px',
      borderLeft: `3px solid ${worst === 'red' ? '#ef4444' : worst === 'amber' ? '#f59e0b' : '#22c55e'}`,
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '6px' }}>
        <div style={{ flex: 1, minWidth: 0 }}><Name card={card} onOpen={onOpen} size="14.5px" /></div>
        <FreshnessChip f={f} />
        <StarButton onClick={onUnstar} />
      </div>
      <Body card={card} onPull={onPull} compact>
        <Flags flags={card.flags} max={2} />
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 12px' }}>
          <Metric big={false} label="Revenue" value={moneyCompact(f.revenue, cur)}
            delta={f.revenueChange != null ? { text: fmtPct(f.revenueChange), good: f.revenueChange >= 0 } : null} />
          <Metric big={false} label="Net profit" value={moneyCompact(f.profit, cur)} negative={f.profit < 0}
            delta={f.marginDeltaPts != null ? { text: `margin ${fmtPts(f.marginDeltaPts)}`, good: f.marginDeltaPts >= 0 } : null} />
          <Metric big={false} label="Cash" value={moneyCompact(f.cash, cur)} negative={f.cash < 0}
            delta={f.cashDeltaM1 != null ? { text: `${fmtMoneyDelta(f.cashDeltaM1, cur)} m/m`, good: f.cashDeltaM1 >= 0 } : null} />
          <Metric big={false} label="Debtors" value={moneyCompact(f.debtors, cur)}
            tone={f.ar?.over90Share >= 0.25 ? 'bad' : null}
            note={f.ar ? `${Math.round(f.ar.over90Share * 100)}% over 90 days` : null} />
        </div>
        {f.monthly.length > 1 && <TrendChart months={f.monthly} currency={cur} compact id={`c${card.realmKey}`} />}
      </Body>
    </div>
  );
}

function Name({ card, onOpen, size }) {
  return (
    <div onClick={onOpen} title={card.connected ? 'Open dashboard' : undefined}
      style={{
        fontFamily: OUTFIT, fontSize: size, fontWeight: 700, color: C.ink,
        cursor: card.connected ? 'pointer' : 'default', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>
      {card.name}
    </div>
  );
}

// The states every presentation shares before it has figures to show.
function Body({ card, onPull, compact, children }) {
  if (!card.connected) {
    return (
      <div style={{ fontFamily: OUTFIT, fontSize: '13.5px', color: C.faint, display: 'flex', alignItems: 'center', gap: '6px' }}>
        <Link2Off size={14} /> No QuickBooks reports connection for this client.
      </div>
    );
  }
  if (!card.figures.hasFigures) return <NotPulled card={card} onPull={onPull} compact={compact} />;
  return <>{children}</>;
}

/* ─── List view ────────────────────────────────────────────────── */

const LIST_COLS = [
  { key: 'name', label: 'Client', align: 'left', sort: (c) => c.name.toLowerCase() },
  { key: 'flags', label: 'Flags', align: 'left', sort: (c) => -c.score },
  { key: 'revenue', label: 'Revenue', sort: (c) => c.figures.revenue },
  { key: 'revenueChange', label: 'vs LY', sort: (c) => c.figures.revenueChange },
  { key: 'profit', label: 'Net profit', sort: (c) => c.figures.profit },
  { key: 'margin', label: 'Margin', sort: (c) => c.figures.margin },
  { key: 'cash', label: 'Cash', sort: (c) => c.figures.cash },
  { key: 'cashCover', label: 'Cover', sort: (c) => c.figures.cashCover },
  { key: 'debtors', label: 'Debtors', sort: (c) => c.figures.debtors },
  { key: 'over90', label: '90+', sort: (c) => c.figures.ar?.over90Share },
  { key: 'debtorDays', label: 'Days', sort: (c) => c.figures.debtorDays },
  { key: 'age', label: 'Pulled', sort: (c) => c.figures.ageDays },
];

export function ListView({ cards, onOpen, onUnstar, onPull }) {
  const [sort, setSort] = useState({ key: 'flags', dir: 1 });
  const [open, setOpen] = useState(() => new Set());
  const col = LIST_COLS.find((c) => c.key === sort.key) || LIST_COLS[1];
  const sorted = [...cards].sort((a, b) => {
    const va = col.sort(a); const vb = col.sort(b);
    if (va == null && vb == null) return a.order - b.order;
    if (va == null) return 1;
    if (vb == null) return -1;
    const cmp = typeof va === 'string' ? va.localeCompare(vb) : va - vb;
    // Numbers read biggest-first by default; names A→Z; flags worst-first.
    return (typeof va === 'string' || col.key === 'flags' ? cmp : -cmp) * sort.dir || a.order - b.order;
  });
  const toggle = (k) => setOpen((prev) => { const n = new Set(prev); n.has(k) ? n.delete(k) : n.add(k); return n; });

  const th = (c) => (
    <th key={c.key} onClick={() => setSort((s) => ({ key: c.key, dir: s.key === c.key ? -s.dir : 1 }))}
      style={{
        textAlign: c.align || 'right', padding: '9px 10px', fontFamily: OUTFIT, fontSize: '12px', fontWeight: 700,
        color: sort.key === c.key ? '#0369a1' : C.faint, cursor: 'pointer', whiteSpace: 'nowrap', borderBottom: '1px solid #e5e7eb', userSelect: 'none',
      }}>
      {c.label}{sort.key === c.key ? (sort.dir === 1 ? ' ▾' : ' ▴') : ''}
    </th>
  );
  const td = { padding: '9px 10px', fontFamily: OUTFIT, fontSize: '14px', color: C.ink, textAlign: 'right', whiteSpace: 'nowrap', borderBottom: `1px solid ${C.rule}` };
  const deltaCell = (v, text) => (v == null ? '—' : <span style={{ color: v >= 0 ? C.good : C.bad, fontWeight: 600 }}>{v >= 0 ? '▲' : '▼'} {text}</span>);

  return (
    <div style={{ ...cardStyle, padding: 0, overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: '980px' }}>
        <thead><tr><th style={{ width: '28px', borderBottom: '1px solid #e5e7eb' }} />{LIST_COLS.map(th)}<th style={{ width: '28px', borderBottom: '1px solid #e5e7eb' }} /></tr></thead>
        <tbody>
          {sorted.map((c) => {
            const f = c.figures;
            const cur = f.currency;
            const isOpen = open.has(c.realmKey);
            const has = c.connected && f.hasFigures;
            return (
              <React.Fragment key={c.realmKey}>
                <tr onClick={() => toggle(c.realmKey)} style={{ cursor: 'pointer', backgroundColor: isOpen ? '#f8fafc' : undefined }}>
                  <td style={{ ...td, textAlign: 'center', color: C.faint, paddingRight: 0 }}>
                    {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  </td>
                  <td style={{ ...td, textAlign: 'left', fontWeight: 700, maxWidth: '220px', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {c.name}
                    {c.window && <div style={{ fontWeight: 400, fontSize: '12px', color: C.faint }}>{shortDate(c.window.plStart)} – {shortDate(c.window.plEnd)}</div>}
                  </td>
                  <td style={{ ...td, textAlign: 'left' }}>
                    {!has ? <span style={{ color: C.faint }}>{c.connected ? 'not pulled' : 'no connection'}</span>
                      : c.flags.length === 0 ? <span style={chip('good')}>OK</span>
                      : (
                        <span title={c.flags.map((x) => x.text).join('\n')} style={{ display: 'inline-flex', gap: '4px', alignItems: 'center' }}>
                          <span style={chip(c.flags[0].level)}>{c.flags[0].text}</span>
                          {c.flags.length > 1 && <span style={{ fontSize: '12.5px', color: C.faint }}>+{c.flags.length - 1}</span>}
                        </span>
                      )}
                  </td>
                  <td style={td}>{has ? money(f.revenue, cur) : ''}</td>
                  <td style={td}>{has ? deltaCell(f.revenueChange, f.revenueChange != null ? fmtPct(f.revenueChange) : '') : ''}</td>
                  <td style={{ ...td, color: f.profit < 0 ? C.redFg : C.ink }}>{has ? money(f.profit, cur) : ''}</td>
                  <td style={td}>
                    {has && f.margin != null ? `${(f.margin * 100).toFixed(1)}%` : ''}
                    {has && f.marginDeltaPts != null && (
                      <div style={{ fontSize: '12px', color: f.marginDeltaPts >= 0 ? C.good : C.bad }}>{fmtPts(f.marginDeltaPts)}</div>
                    )}
                  </td>
                  <td style={{ ...td, color: f.cash < 0 ? C.redFg : C.ink }}>{has ? money(f.cash, cur) : ''}</td>
                  <td style={{ ...td, color: f.cashCover != null && f.cashCover < 2 ? (f.cashCover < 1 ? C.redFg : C.ambFg) : C.ink }}>
                    {has && f.cashCover != null ? `${f.cashCover.toFixed(1)} mo` : ''}
                  </td>
                  <td style={td}>{has ? money(f.debtors, cur) : ''}</td>
                  <td style={{ ...td, color: f.ar?.over90Share >= 0.25 ? C.redFg : C.ink, fontWeight: f.ar?.over90Share >= 0.25 ? 600 : 400 }}>
                    {has && f.ar ? `${Math.round(f.ar.over90Share * 100)}%` : ''}
                  </td>
                  <td style={td}>{has && f.debtorDays != null ? Math.round(f.debtorDays) : ''}</td>
                  <td style={{ ...td, color: f.stale ? C.ambFg : C.faint, fontSize: '13px' }}>{f.oldestPulledAt ? timeAgo(f.oldestPulledAt) : ''}</td>
                  <td style={{ ...td, textAlign: 'center', padding: '4px' }} onClick={(e) => e.stopPropagation()}>
                    <StarButton onClick={() => onUnstar(c)} />
                  </td>
                </tr>
                {isOpen && (
                  <tr>
                    <td colSpan={LIST_COLS.length + 2} style={{ padding: '14px 20px 18px', borderBottom: '1px solid #e5e7eb', backgroundColor: '#f8fafc', whiteSpace: 'normal' }}>
                      <div style={{ maxWidth: '900px' }}>
                        <ExpandedTile card={c} bare onPull={() => onPull(c)} />
                        {c.connected && (
                          <button onClick={() => onOpen(c)} style={{ ...linkBtn, marginTop: '10px' }}>Open dashboard <ArrowRight size={13} /></button>
                        )}
                      </div>
                    </td>
                  </tr>
                )}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
