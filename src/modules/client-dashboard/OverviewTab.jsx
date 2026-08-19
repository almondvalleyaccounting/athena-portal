import React, { useMemo } from 'react';
import { Info } from 'lucide-react';
import {
  money, shortDate, formatRatio, OUTFIT, cardStyle, inputStyle,
} from './dashboardData';
import {
  GRAINS, BASES, VIEWS, aggregate, seriesFor,
  rolling12Months, windowLabel, yearEndMonthIndex, MONTH_NAMES,
} from './overviewGrain';
import { BucketChart } from './DashboardCharts';
import { LoadingCard, EmptyState, Delta, MetricTile, Segmented } from './DashboardUI';

/*
  Overview tab.

  Everything on this tab follows three toggles rather than the raw QBO columns:

    VIEW   Reported | Underlying   — Underlying strips the owner-cost nominal
           codes tagged on the Underlying Performance tab, plus the one-off
           items dated in the bucket. Same configuration, same arithmetic, so
           the two tabs always agree.
    GRAIN  Months | Quarters | Years
    BASIS  Fiscal | Calendar       — Fiscal aligns to the client's own year end
           (a 31 July year end gets Q4 ending in July); Calendar lands years on
           December and quarters on Mar / Jun / Sep / Dec.

  The period picker in the left rail no longer sets the width of anything here
  — it sets the END POINT. Buckets are then counted back from the last one that
  CLOSES on or before it, so a part-finished quarter never sits next to four
  full ones pretending to be a collapse in trade.

  Tiles compare the latest bucket with the one before it. Balance-sheet figures
  are as at the latest bucket's end date, not the raw period end, so the P&L and
  the balance sheet on this tab are always talking about the same moment.

  All of it comes from ONE metric — `pnl_chart_detail`, a single QBO monthly
  P&L carrying both group summaries and each leaf account's monthly amounts.
  That per-account grain is what makes an underlying view possible per bucket
  rather than only over one flat range, and it means flipping any toggle other
  than grain/basis costs no refetch at all.
*/


export default function OverviewTab({
  detail, bs, buckets, prior, currency, loading, empty, goTab,
  grain, setGrain, basis, setBasis, view, setView,
  fyIdx, config, fiscalYear, onFiscalYearEndChange,
}) {
  const isU = view === 'underlying';

  // Reported and underlying are both computed for every bucket; the toggle only
  // decides which pair is read. Prior sits at index 0 so the tiles get their
  // comparator without a second pull.
  const rows = useMemo(() => {
    if (!detail || !buckets?.length) return [];
    return aggregate(detail, [prior, ...buckets], {
      ownerAccountIds: config?.ownerAccountIds,
      accountsById: config?.accountsById,
      oneoffs: config?.oneoffs,
    });
  }, [detail, buckets, prior, config?.ownerAccountIds, config?.accountsById, config?.oneoffs]);

  const chartRows = rows.slice(1);
  const latest = chartRows[chartRows.length - 1] || null;
  const previous = rows[rows.length - 2] || null;

  // Rolling 12 months to the latest bucket end — the annualised base for
  // debtor / creditor days, whatever grain is on screen.
  const rolling = useMemo(() => {
    if (!detail || !chartRows.length) return null;
    const months = rolling12Months(chartRows);
    const [r12] = aggregate(detail, [{
      key: 'r12', label: 'r12', months,
      start: `${months[0]}-01`, end: chartRows[chartRows.length - 1].end,
      startKey: months[0], endKey: months[months.length - 1],
    }], {
      ownerAccountIds: config?.ownerAccountIds,
      accountsById: config?.accountsById,
      oneoffs: config?.oneoffs,
    });
    return r12;
  }, [detail, chartRows, config?.ownerAccountIds, config?.accountsById, config?.oneoffs]);

  const hasAnything = detail || bs;
  if (!hasAnything) {
    return loading ? <LoadingCard label="overview figures" /> : <EmptyState label="overview figures" {...empty} />;
  }

  const cur = seriesFor(latest, view);
  const prv = seriesFor(previous, view);
  const deltaLabel = `vs ${previous?.label || 'prior'}`;
  const bucketLabel = latest?.label || 'latest';
  const asAtLabel = bs?.period?.end ? `as at ${shortDate(bs.period.end)}` : null;
  const creditors = bs?.accounts_payable ?? bs?.creditors_within_1yr;
  const creditorsPrev = bs?.prev?.accounts_payable ?? bs?.prev?.creditors_within_1yr;

  // Ratios follow the toggles: margins over the latest bucket on the selected
  // view; days annualised over the rolling 12 months on the same view; the
  // current ratio is a balance-sheet fact and is view-independent.
  const grossProfit = latest == null ? null
    : (isU
      // Underlying gross profit = reported gross profit less any tagged income,
      // plus tagged costs sitting above the gross-profit line. The report does
      // not split the add-back by line, so we adjust income only — the honest
      // approximation, and the same one the Underlying tab makes.
      ? (latest.gross_profit == null ? null : latest.gross_profit - latest.owner_income_tagged - latest.oneoff_income)
      : latest.gross_profit);

  const r12 = rolling ? seriesFor(rolling, view) : null;
  const r12Costs = rolling
    ? (isU
      ? ((rolling.cogs || 0) + (rolling.expenses || 0) - Math.max(0, rolling.owner_add_back) - rolling.oneoff_cost)
      : ((rolling.cogs || 0) + (rolling.expenses || 0)))
    : null;

  const ratios = [
    {
      key: 'gross_margin', label: 'Gross margin', format: 'pct',
      hint: `Gross profit ÷ income over ${bucketLabel}`,
      value: (grossProfit == null || !cur.income) ? null : (grossProfit / cur.income) * 100,
    },
    {
      key: 'net_margin', label: 'Net margin', format: 'pct',
      hint: `Net profit ÷ income over ${bucketLabel}`,
      value: (cur.net_income == null || !cur.income) ? null : (cur.net_income / cur.income) * 100,
    },
    {
      key: 'debtor_days', label: 'Debtor days', format: 'days',
      hint: 'Debtors at the bucket end ÷ rolling-12-month income × 365',
      value: (bs?.debtors == null || !r12?.income) ? null : (bs.debtors / r12.income) * 365,
    },
    {
      key: 'creditor_days', label: 'Creditor days', format: 'days',
      hint: 'Creditors at the bucket end ÷ rolling-12-month costs × 365',
      value: (creditors == null || !r12Costs) ? null : (creditors / r12Costs) * 365,
    },
    {
      key: 'current_ratio', label: 'Current ratio', format: 'ratio',
      hint: 'Current assets ÷ current liabilities at the bucket end',
      value: (bs?.current_assets == null || !bs?.current_liabilities) ? null : bs.current_assets / bs.current_liabilities,
    },
  ];

  const yearEndName = MONTH_NAMES[yearEndMonthIndex('fiscal', fyIdx)];
  const chartPoints = chartRows.map((r) => {
    const s = seriesFor(r, view);
    return { label: r.label, income: s.income, net: s.net_income };
  });

  const adjustment = latest
    ? latest.owner_add_back + latest.oneoff_cost - latest.oneoff_income
    : 0;
  const nothingTagged = !config?.ownerAccountIds?.size && !(config?.oneoffs || []).length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      {/* ── Toggles ── */}
      <div style={{
        display: 'flex', gap: '18px', alignItems: 'center', flexWrap: 'wrap',
        padding: '12px 16px', backgroundColor: '#f8fafc', border: '1px solid #e5e7eb', borderRadius: '12px',
      }}>
        <Segmented
          label="View" value={view} onChange={setView}
          options={VIEWS.map((v) => ({
            ...v,
            hint: v.key === 'underlying'
              ? 'Owner costs and one-off items removed — the same codes tagged on the Underlying Performance tab'
              : 'Straight from QuickBooks, nothing removed',
          }))}
        />
        <Segmented label="By" value={grain} onChange={setGrain} options={GRAINS} />
        <Segmented
          label="Year" value={basis} onChange={setBasis}
          options={BASES.map((b) => ({
            ...b,
            hint: b.key === 'fiscal'
              ? `Aligned to this client's year end (${yearEndName})`
              : 'Years to December, quarters to Mar / Jun / Sep / Dec',
          }))}
        />

        {/* The year end itself. Only shown on the fiscal basis, because that is
            the only place it changes a number — and shown at all because
            QuickBooks often has no year end recorded, in which case every
            fiscal quarter on this page would otherwise be the practice's own,
            silently. */}
        {basis === 'fiscal' && (
          <label style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span style={{ fontFamily: OUTFIT, fontSize: '11px', fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: '#94a3b8' }}>
              Ends
            </span>
            <select
              value={fiscalYear?.endMonth != null ? fiscalYear.endMonth + 1 : ''}
              onChange={(e) => onFiscalYearEndChange?.(e.target.value)}
              disabled={!onFiscalYearEndChange}
              title={
                fiscalYear?.source === 'override' ? 'Set here for this client'
                  : fiscalYear?.source === 'quickbooks' ? "From the client's QuickBooks settings"
                    : "QuickBooks has no year end recorded for this client — this is a fallback, not their actual year end"
              }
              style={{
                ...inputStyle, padding: '6px 9px', fontSize: '12.5px',
                borderColor: fiscalYear?.source === 'fallback' ? '#fde68a' : '#e5e7eb',
                backgroundColor: fiscalYear?.source === 'fallback' ? '#fffbeb' : '#ffffff',
              }}
            >
              {MONTH_NAMES.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
            </select>
            {fiscalYear?.source === 'fallback' && (
              <span title="QuickBooks has no year end for this client. Pick the right month — until you do, these are not their quarters."
                style={{ fontFamily: OUTFIT, fontSize: '11px', fontWeight: 600, color: '#b45309' }}>
                not confirmed
              </span>
            )}
          </label>
        )}

        <span style={{ fontFamily: OUTFIT, fontSize: '11.5px', color: '#94a3b8', marginLeft: 'auto' }}>
          {windowLabel(grain, basis, chartRows)}
        </span>
      </div>

      {isU && nothingTagged && (
        <div style={{
          display: 'flex', gap: '8px', alignItems: 'flex-start', padding: '10px 14px',
          backgroundColor: '#fffbeb', border: '1px solid #fde68a', borderRadius: '10px',
        }}>
          <Info size={15} style={{ color: '#b45309', flexShrink: 0, marginTop: '1px' }} />
          <span style={{ fontFamily: OUTFIT, fontSize: '12.5px', color: '#92400e' }}>
            Nothing is tagged as an owner cost for this client yet, so underlying and reported are identical.
            Tag the codes on the{' '}
            <button
              onClick={() => goTab && goTab('underlying')}
              style={{ border: 'none', background: 'none', padding: 0, color: '#92400e', fontFamily: OUTFIT, fontSize: '12.5px', fontWeight: 700, textDecoration: 'underline', cursor: 'pointer' }}
            >
              Underlying Performance
            </button>{' '}
            tab.
          </span>
        </div>
      )}

      {/* ── Headline tiles ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '12px' }}>
        <MetricTile
          label={`Revenue — ${bucketLabel}`} value={cur.income} currency={currency} accent={isU}
          delta={<Delta now={cur.income} prev={prv.income} currency={currency} label={deltaLabel} />}
          onClick={goTab ? () => goTab('pnl') : undefined}
        />
        <MetricTile
          label={`${isU ? 'Underlying' : 'Net'} profit — ${bucketLabel}`} value={cur.net_income} currency={currency} accent={isU}
          delta={<Delta now={cur.net_income} prev={prv.net_income} currency={currency} label={deltaLabel} />}
          onClick={goTab ? () => goTab(isU ? 'underlying' : 'pnl') : undefined}
        />
        <MetricTile
          label="Cash at bank" value={bs?.cash} currency={currency} sub={asAtLabel}
          delta={<Delta now={bs?.cash} prev={bs?.prev?.cash} currency={currency} />}
          onClick={goTab ? () => goTab('balance') : undefined}
        />
        <MetricTile
          label="Debtors" value={bs?.debtors} currency={currency} sub={asAtLabel}
          delta={<Delta now={bs?.debtors} prev={bs?.prev?.debtors} currency={currency} upIsGood={false} />}
          onClick={goTab ? () => goTab('debtors') : undefined}
        />
        <MetricTile
          label="Creditors" value={creditors} currency={currency} sub={asAtLabel}
          delta={<Delta now={creditors} prev={creditorsPrev} currency={currency} upIsGood={false} />}
          onClick={goTab ? () => goTab('creditors') : undefined}
        />
      </div>

      {/* ── Trend ── */}
      {chartPoints.length > 0 && (
        <div style={cardStyle}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '10px', marginBottom: '10px', flexWrap: 'wrap' }}>
            <span style={{ fontFamily: OUTFIT, fontSize: '15px', fontWeight: 700, color: '#0f172a' }}>
              Revenue &amp; {isU ? 'underlying' : 'net'} profit — {windowLabel(grain, basis, chartRows)}
            </span>
            <span style={{ fontFamily: OUTFIT, fontSize: '11.5px', color: '#94a3b8', marginLeft: 'auto' }}>
              <span style={{ display: 'inline-block', width: '10px', height: '10px', backgroundColor: '#bae6fd', borderRadius: '2px', marginRight: '4px', verticalAlign: '-1px' }} />
              revenue
              <span style={{ display: 'inline-block', width: '10px', height: '2px', backgroundColor: '#0f172a', margin: '0 4px 0 12px', verticalAlign: '3px' }} />
              {isU ? 'underlying' : 'net'} profit
            </span>
          </div>
          <BucketChart
            points={chartPoints}
            currency={currency}
            netLabel={isU ? 'underlying profit' : 'net profit'}
          />
        </div>
      )}

      {/* ── Reported → underlying bridge, when it moves anything ── */}
      {isU && latest && Math.abs(adjustment) > 0.005 && (
        <div style={{
          display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap',
          padding: '12px 16px', backgroundColor: '#f0f9ff', border: '1px solid #bae6fd', borderRadius: '12px',
        }}>
          <span style={{ fontFamily: OUTFIT, fontSize: '12.5px', color: '#0369a1' }}>
            {bucketLabel}: reported {money(latest.net_income, currency)}
            {latest.owner_add_back ? ` · owner costs ${money(latest.owner_add_back, currency)}` : ''}
            {latest.oneoff_cost ? ` · one-off costs ${money(latest.oneoff_cost, currency)}` : ''}
            {latest.oneoff_income ? ` · less one-off income ${money(latest.oneoff_income, currency)}` : ''}
            {' → underlying '}
            <strong>{money(latest.u_net_income, currency)}</strong>
          </span>
          <button
            onClick={() => goTab && goTab('underlying')}
            style={{ marginLeft: 'auto', border: 'none', background: 'none', padding: 0, color: '#0369a1', fontFamily: OUTFIT, fontSize: '12px', fontWeight: 700, textDecoration: 'underline', cursor: 'pointer' }}
          >
            See the full bridge
          </button>
        </div>
      )}

      {/* ── Ratios ── */}
      <div style={cardStyle}>
        <div style={{ fontFamily: OUTFIT, fontSize: '15px', fontWeight: 700, color: '#0f172a', marginBottom: '12px' }}>
          Key ratios — {bucketLabel}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '10px' }}>
          {ratios.map((r) => (
            <div key={r.key} title={r.hint} style={{ backgroundColor: '#f8fafc', borderRadius: '10px', padding: '12px 14px' }}>
              <div style={{ fontFamily: OUTFIT, fontSize: '11.5px', color: '#94a3b8', marginBottom: '3px' }}>{r.label}</div>
              <div style={{ fontFamily: OUTFIT, fontSize: '19px', fontWeight: 700, color: r.value === null ? '#cbd5e1' : '#0f172a' }}>
                {formatRatio(r.value, r.format)}
              </div>
            </div>
          ))}
        </div>
        <p style={{ fontFamily: OUTFIT, fontSize: '11px', color: '#94a3b8', marginTop: '10px', marginBottom: 0 }}>
          Margins use {bucketLabel} on the {isU ? 'underlying' : 'reported'} view; debtor and creditor days annualise
          over the rolling 12 months to {latest ? shortDate(latest.end) : 'the period end'}; the current ratio is the
          balance sheet at that date. Hover a tile for the formula.
        </p>
      </div>
    </div>
  );
}

