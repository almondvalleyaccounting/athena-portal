import React, { useMemo } from 'react';
import { money, OUTFIT } from './dashboardData';
import { buildBuckets, aggregate, seriesFor, windowLabel, monthKeyOfDate } from './overviewGrain';
import { BucketChart, LineChart } from './DashboardCharts';
import { buildKpiModel, formatKpi, FINANCIAL_KEYS } from './kpiEngine';

/*
  One saved custom report, rendered.

  Shared by the staff Reports tab and the client's own dashboard, because a
  report we have published to a client is the same report we read — that is the
  whole point of publishing it. A second renderer would drift, and the drift
  would show up as a client quoting a figure off "the report you sent me" that
  does not appear on ours.

  The report carries its own grain, basis and length, so it looks the same every
  month regardless of where either page's period filter happens to be pointed.
  That is deliberate: a report is a saved view, not a lens over whatever the
  reader last clicked.

  Pure — no supabase, no auth. What differs between the two apps is the palette,
  which is a prop.
*/

const FIN_ROWS = FINANCIAL_KEYS;

export const REPORT_STAFF_PALETTE = {
  font: OUTFIT,
  strong: '#0f172a',
  text: '#64748b',
  faint: '#94a3b8',
  warn: '#b45309',
  border: '#e5e7eb',
  rowBorder: '#f8fafc',
  surface: '#ffffff',
};

export default function ReportView({
  report, detail, bs, config, kpi, fyIdx, currency, clientName,
  palette = null, cardStyle = null,
}) {
  const t = palette ? { ...REPORT_STAFF_PALETTE, ...palette } : REPORT_STAFF_PALETTE;
  const card = cardStyle || undefined;

  const model = useMemo(() => {
    const anchor = detail?.month_keys?.length
      ? detail.month_keys[detail.month_keys.length - 1]
      : monthKeyOfDate(new Date());
    const { buckets, prior } = buildBuckets({
      grain: report.grain, basis: report.basis, anchorKey: anchor, fyIdx, count: report.periods,
    });

    const fin = detail
      ? aggregate(detail, [prior, ...buckets], {
        ownerAccountIds: config?.ownerAccountIds,
        accountsById: config?.accountsById,
        oneoffs: config?.oneoffs,
      }).slice(1)
      : buckets.map(() => null);

    const financials = (bi, key) => {
      const r = fin[bi];
      if (!r) return null;
      if (key === 'cash') return bs?.cash ?? null;
      if (key === 'debtors') return bs?.debtors ?? null;
      if (key === 'creditors') return bs?.accounts_payable ?? bs?.creditors_within_1yr ?? null;
      const s = seriesFor(r, report.view);
      if (key === 'income') return s.income;
      if (key === 'net_income') return s.net_income;
      return r[key] ?? null;
    };

    const kpiModel = buildKpiModel({
      definitions: kpi?.definitions || [], dimensionValues: kpi?.dimensionValues || [],
      values: kpi?.values || [], buckets, financials,
    });

    return { buckets, fin, financials, kpiModel };
  }, [report, detail, bs, config, kpi, fyIdx]);

  const { buckets, financials, kpiModel } = model;

  const rows = (report.rows || []).map((r) => {
    if (r.source === 'financial') {
      const meta = FIN_ROWS.find((f) => f.key === r.key);
      return {
        key: `fin-${r.key}`,
        label: r.label || meta?.label || r.key,
        unit: 'money', decimals: 0,
        values: buckets.map((_, bi) => financials(bi, r.key)),
      };
    }
    const k = kpiModel.byKey[r.key];
    if (!k) return { key: `kpi-${r.key}`, label: r.label || r.key, unit: 'number', decimals: 0, values: buckets.map(() => null), missing: true };
    return {
      key: `kpi-${r.key}`,
      label: r.label || k.definition.label,
      unit: k.definition.unit, decimals: k.definition.decimals,
      values: k.total,
    };
  });

  const chartRow = rows[0];

  const th = {
    fontFamily: t.font, fontSize: '11px', color: t.faint, fontWeight: 700,
    textAlign: 'right', padding: '7px 14px', whiteSpace: 'nowrap', borderBottom: `1px solid ${t.border}`,
  };
  const td = {
    fontFamily: t.font, fontSize: '12.5px', textAlign: 'right', padding: '7px 14px',
    whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums', borderBottom: `1px solid ${t.rowBorder}`,
  };

  return (
    <>
      <div style={card}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '10px', flexWrap: 'wrap' }}>
          <span style={{ fontFamily: t.font, fontSize: '16px', fontWeight: 700, color: t.strong }}>{report.name}</span>
          <span style={{ fontFamily: t.font, fontSize: '11.5px', color: t.faint }}>
            {clientName} · {windowLabel(report.grain, report.basis, buckets)}
            {report.view === 'underlying' && ' · underlying'}
            {!report.entity_id && (report.sector_id ? ' · sector report' : ' · practice-wide report')}
          </span>
        </div>
        {report.description && (
          <p style={{ fontFamily: t.font, fontSize: '12.5px', color: t.text, margin: '6px 0 0' }}>{report.description}</p>
        )}
      </div>

      {report.chart !== 'none' && chartRow && (
        <div style={card}>
          <div style={{ fontFamily: t.font, fontSize: '14px', fontWeight: 700, color: t.strong, marginBottom: '8px' }}>
            {chartRow.label}
          </div>
          {report.chart === 'bars_line' && rows.length > 1 ? (
            <BucketChart
              points={buckets.map((b, i) => ({ label: b.label, income: chartRow.values[i], net: rows[1].values[i] }))}
              currency={currency}
              incomeLabel={chartRow.label} netLabel={rows[1].label}
            />
          ) : (
            <LineChart
              points={buckets.map((b, i) => ({ label: b.label, value: chartRow.values[i] }))}
              currency={currency}
            />
          )}
        </div>
      )}

      <div style={{ ...(card || {}), padding: '16px 0 6px' }}>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: `${240 + buckets.length * 92}px` }}>
            <thead>
              <tr>
                <th style={{ ...th, textAlign: 'left', position: 'sticky', left: 0, backgroundColor: t.surface, minWidth: '210px' }} />
                {buckets.map((b) => <th key={b.key} style={th}>{b.label}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr><td colSpan={buckets.length + 1} style={{ ...td, textAlign: 'left', paddingLeft: '20px', color: t.faint }}>
                  This report has no rows yet.
                </td></tr>
              )}
              {rows.map((r) => (
                <tr key={r.key}>
                  <td style={{ ...td, textAlign: 'left', position: 'sticky', left: 0, backgroundColor: t.surface, fontWeight: 600, color: r.missing ? t.warn : t.strong, paddingLeft: '20px' }}>
                    {r.label}
                    {r.missing && <span style={{ fontWeight: 400, fontSize: '11px' }}> · no longer exists on this client</span>}
                  </td>
                  {r.values.map((v, i) => (
                    <td key={i} style={td}>
                      {r.unit === 'money' ? money(v, currency) : formatKpi(v, r.unit, r.decimals, currency)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
