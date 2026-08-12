// Cash dashboard for the GENERAL CASHFLOW lens — the one screen that answers
// "does this business run out of money, and when".
//
// Deliberately small: bank balance over time, the low point, and the month-by
// -month bridge. No occupancy, capacity or age bands.

import React, { useMemo } from 'react';
import { colors, fmtP, KPI, periodLabel, Section, serifStack } from '../components/ui';

const seriesOf = (outputs, nominal) => {
  const m = new Map();
  for (const o of outputs) {
    if (o.nominal_type !== nominal) continue;
    m.set(o.period, (m.get(o.period) || 0) + Number(o.amount_p || 0));
  }
  return m;
};

export default function CashDashboardView({ outputs, forecast, periods }) {
  const data = useMemo(() => {
    const closing = seriesOf(outputs, 'cf.closing_cash');
    const cashIn = seriesOf(outputs, 'cf.in_total');
    const cashOut = seriesOf(outputs, 'cf.out_total');
    const revenue = seriesOf(outputs, 'pnl.revenue_total');
    const npat = seriesOf(outputs, 'pnl.npat');
    const vat = seriesOf(outputs, 'cf.out.vat');
    const ct = seriesOf(outputs, 'cf.out.corp_tax');

    const rows = periods.map(t => ({
      t,
      revenue: revenue.get(t) || 0,
      npat: npat.get(t) || 0,
      in: cashIn.get(t) || 0,
      out: Math.abs(cashOut.get(t) || 0),
      closing: closing.get(t) || 0,
      vat: Math.abs(vat.get(t) || 0),
      ct: Math.abs(ct.get(t) || 0),
    }));

    const withCash = rows.filter(r => closing.has(r.t));
    const low = withCash.length
      ? withCash.reduce((a, b) => (b.closing < a.closing ? b : a), withCash[0])
      : null;
    const last = withCash.length ? withCash[withCash.length - 1] : null;
    const year1 = rows.slice(0, 12);

    return {
      rows, low, last,
      salesY1: year1.reduce((s, r) => s + r.revenue, 0),
      profitY1: year1.reduce((s, r) => s + r.npat, 0),
      nextVat: rows.find(r => r.vat > 0) || null,
      nextCt: rows.find(r => r.ct > 0) || null,
    };
  }, [outputs, periods]);

  if (!data.last) {
    return (
      <div style={{ fontSize: 13, color: colors.muted }}>
        No outputs yet — add or seed some lines on the Lines &amp; assumptions tab, then recompute.
      </div>
    );
  }

  const negative = data.low && data.low.closing < 0;

  const openingLabel = forecast.opening_period
    ? new Date(forecast.opening_period).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })
    : null;

  return (
    <div>
      {openingLabel && (
        <div style={{
          display: 'inline-flex', alignItems: 'center', gap: 8, marginBottom: 14,
          padding: '6px 12px', borderRadius: 999, background: '#eff6ff',
          border: `1px solid #bfdbfe`, fontSize: 12, color: colors.accent, fontWeight: 600,
        }}>
          Forecast from {openingLabel} — every figure below is projected, opening from the last actual balance sheet
        </div>
      )}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 20 }}>
        <KPI label="Closing bank" value={fmtP(data.last.closing)}
          hint={periodLabel(data.last.t, forecast.opening_period)}
          color={data.last.closing < 0 ? colors.red : colors.ink} />
        <KPI label="Lowest bank" value={fmtP(data.low.closing)}
          hint={periodLabel(data.low.t, forecast.opening_period)}
          color={negative ? colors.red : colors.green} />
        <KPI label="Sales — year 1" value={fmtP(data.salesY1)} />
        <KPI label="Profit after tax — year 1" value={fmtP(data.profitY1)}
          color={data.profitY1 < 0 ? colors.red : colors.ink} />
        {data.nextVat && (
          <KPI label="First VAT payment" value={fmtP(data.nextVat.vat)}
            hint={periodLabel(data.nextVat.t, forecast.opening_period)} />
        )}
        {data.nextCt && (
          <KPI label="First CT payment" value={fmtP(data.nextCt.ct)}
            hint={periodLabel(data.nextCt.t, forecast.opening_period)} />
        )}
      </div>

      <Section title="Bank balance">
        <BankChart rows={data.rows} openingPeriod={forecast.opening_period} />
      </Section>

      <Section title="Month by month">
        <div style={{ overflowX: 'auto', background: '#fff', border: `1px solid ${colors.border}`, borderRadius: 12 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ background: colors.bgSoft }}>
                {['Month', 'Sales', 'Cash in', 'Cash out', 'Net', 'Closing bank'].map((h, i) => (
                  <th key={h} style={{
                    textAlign: i === 0 ? 'left' : 'right', padding: '8px 12px', fontSize: 11,
                    fontWeight: 700, color: colors.muted, borderBottom: `1px solid ${colors.border}`,
                  }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.rows.map(r => (
                <tr key={r.t}>
                  <Cell align="left">{periodLabel(r.t, forecast.opening_period)}</Cell>
                  <Cell>{fmtP(r.revenue)}</Cell>
                  <Cell>{fmtP(r.in)}</Cell>
                  <Cell>{fmtP(-r.out)}</Cell>
                  <Cell color={r.in - r.out < 0 ? colors.red : colors.ink}>{fmtP(r.in - r.out)}</Cell>
                  <Cell color={r.closing < 0 ? colors.red : colors.ink} bold>{fmtP(r.closing)}</Cell>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
    </div>
  );
}

function Cell({ children, align = 'right', color, bold }) {
  return (
    <td style={{
      textAlign: align, padding: '5px 12px', borderBottom: `1px solid ${colors.borderSoft}`,
      fontFamily: align === 'right' ? 'ui-monospace, SFMono-Regular, Menlo, monospace' : 'inherit',
      color: color || colors.ink, fontWeight: bold ? 600 : 400, whiteSpace: 'nowrap',
    }}>{children}</td>
  );
}

/** Closing-bank line with a zero rule — the shortfall should be unmissable. */
function BankChart({ rows, openingPeriod }) {
  const W = 900, H = 220, padL = 60, padR = 12, padT = 12, padB = 26;
  const values = rows.map(r => r.closing);
  const max = Math.max(...values, 0);
  const min = Math.min(...values, 0);
  const span = max - min || 1;
  const x = (i) => padL + (i / Math.max(1, rows.length - 1)) * (W - padL - padR);
  const y = (v) => padT + (1 - (v - min) / span) * (H - padT - padB);

  const path = rows.map((r, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(r.closing).toFixed(1)}`).join(' ');
  const zeroY = y(0);
  const ticks = rows.filter((_, i) => i % Math.ceil(rows.length / 12) === 0);

  return (
    <div style={{ background: '#fff', border: `1px solid ${colors.border}`, borderRadius: 12, padding: 12, overflowX: 'auto' }}>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', minWidth: 600, height: H }}>
        <line x1={padL} y1={zeroY} x2={W - padR} y2={zeroY} stroke={colors.border} strokeWidth="1" />
        <text x={padL - 8} y={zeroY + 4} textAnchor="end" fontSize="10" fill={colors.muted}>£0</text>
        <text x={padL - 8} y={y(max) + 4} textAnchor="end" fontSize="10" fill={colors.muted}>{fmtP(max, { compact: true })}</text>
        {min < 0 && (
          <text x={padL - 8} y={y(min) + 4} textAnchor="end" fontSize="10" fill={colors.red}>{fmtP(min, { compact: true })}</text>
        )}
        {min < 0 && (
          <rect x={padL} y={zeroY} width={W - padL - padR} height={Math.max(0, y(min) - zeroY)}
            fill={colors.red} opacity="0.06" />
        )}
        <path d={path} fill="none" stroke={colors.accent} strokeWidth="2" />
        {rows.map((r, i) => (
          <circle key={r.t} cx={x(i)} cy={y(r.closing)} r="2.5"
            fill={r.closing < 0 ? colors.red : colors.accent}>
            <title>{`${periodLabel(r.t, openingPeriod)}: ${fmtP(r.closing)}`}</title>
          </circle>
        ))}
        {ticks.map((r) => (
          <text key={r.t} x={x(rows.indexOf(r))} y={H - 8} textAnchor="middle" fontSize="10" fill={colors.muted}>
            {periodLabel(r.t, openingPeriod)}
          </text>
        ))}
      </svg>
      <div style={{ fontFamily: serifStack, fontSize: 12, color: colors.muted, marginTop: 4 }}>
        Closing bank balance by month
      </div>
    </div>
  );
}
