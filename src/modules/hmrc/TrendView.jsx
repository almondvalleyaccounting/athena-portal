import React, { useEffect, useMemo, useState } from 'react';
import { Download, TriangleAlert } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { fmtGbp, fmtGbpDetailed } from '../../lib/money';
import { downloadCSV } from '../../lib/exportUtils';
import { font, Stat, Chip, ErrorBar, th, thNum, td, tdNum, card } from './hmrcShared';

// How the HMRC position was arrived at — the walk from nothing to what is owed
// today, at three grains.
//
// Aggregation is done here in the browser rather than in three more views:
// v_hmrc_paye_trend_monthly is one row per tax month (75 today, 12 a year
// forever), so the whole series fits in one request and month / tax year /
// total are just different groupings of it. Adding server-side rollups would be
// three more definitions of the same number to keep in step.
//
// The fetches live in this file rather than hmrcApi.js on purpose: that module
// is being edited by a second session right now, and a self-contained component
// cannot be broken by a concurrent rewrite of a shared file.

const MONTH_NAMES = ['', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar'];

async function fetchTrend() {
  const { data, error } = await supabase
    .from('v_hmrc_paye_trend_monthly')
    .select('*')
    .order('tax_year', { ascending: true })
    .order('tax_month', { ascending: true });
  if (error) throw error;
  return data || [];
}

async function fetchStatedDebt() {
  // The Debt tab's number, straight from HMRC's own stated position, so the two
  // can be tied together rather than left to disagree quietly.
  const { data, error } = await supabase
    .from('v_hmrc_paye_clients')
    .select('total_debt');
  if (error) throw error;
  return (data || []).reduce((s, r) => s + Number(r.total_debt || 0), 0);
}

const n = (v) => Number(v || 0);

export default function TrendView() {
  const [rows, setRows] = useState([]);
  const [stated, setStated] = useState(null);
  const [grain, setGrain] = useState('year'); // 'month' | 'year' | 'total'
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([fetchTrend(), fetchStatedDebt()])
      .then(([t, s]) => { setRows(t); setStated(s); setError(''); })
      .catch((e) => setError(e.message || 'Could not load the trend'))
      .finally(() => setLoading(false));
  }, []);

  // Rows arrive oldest-first, which is the order the walk has to be built in:
  // each period's opening is the previous period's closing.
  const periods = useMemo(() => {
    if (rows.length === 0) return [];

    if (grain === 'month') {
      return rows.map((r, i) => ({
        key: `${r.tax_year}-${r.tax_month}`,
        label: `${MONTH_NAMES[r.tax_month] || `M${r.tax_month}`} ${r.tax_year}`,
        sub: `month ${r.tax_month}`,
        opening: i === 0 ? 0 : n(rows[i - 1].cumulative_due),
        charges: n(r.charges),
        credits: n(r.credits),
        payments: n(r.payments),
        movement: n(r.still_due),
        closing: n(r.cumulative_due),
        schemesOwing: r.schemes_owing,
        bpSchemes: r.brightpay_schemes,
        bpLiability: r.bp_liability === null ? null : n(r.bp_liability),
        covered: r.brightpay_covered,
      }));
    }

    if (grain === 'year') {
      const years = [...new Set(rows.map((r) => r.tax_year))].sort();
      return years.map((y) => {
        const inYear = rows.filter((r) => r.tax_year === y);
        const firstIdx = rows.indexOf(inYear[0]);
        const last = inYear[inYear.length - 1];
        return {
          key: y,
          label: y,
          sub: `${inYear.length} month${inYear.length === 1 ? '' : 's'} scraped`,
          opening: firstIdx === 0 ? 0 : n(rows[firstIdx - 1].cumulative_due),
          charges: inYear.reduce((s, r) => s + n(r.charges), 0),
          credits: inYear.reduce((s, r) => s + n(r.credits), 0),
          payments: inYear.reduce((s, r) => s + n(r.payments), 0),
          movement: inYear.reduce((s, r) => s + n(r.still_due), 0),
          closing: n(last.cumulative_due),
          schemesOwing: Math.max(...inYear.map((r) => r.schemes_owing || 0)),
          bpSchemes: Math.max(...inYear.map((r) => r.brightpay_schemes || 0)),
          bpLiability: inYear.some((r) => r.bp_liability !== null)
            ? inYear.reduce((s, r) => s + n(r.bp_liability), 0) : null,
          covered: inYear.some((r) => r.brightpay_covered),
        };
      });
    }

    const last = rows[rows.length - 1];
    return [{
      key: 'all',
      label: 'All time',
      sub: `${rows[0].tax_year} to ${last.tax_year}`,
      opening: 0,
      charges: rows.reduce((s, r) => s + n(r.charges), 0),
      credits: rows.reduce((s, r) => s + n(r.credits), 0),
      payments: rows.reduce((s, r) => s + n(r.payments), 0),
      movement: rows.reduce((s, r) => s + n(r.still_due), 0),
      closing: n(last.cumulative_due),
      schemesOwing: Math.max(...rows.map((r) => r.schemes_owing || 0)),
      bpSchemes: Math.max(...rows.map((r) => r.brightpay_schemes || 0)),
      bpLiability: rows.reduce((s, r) => s + n(r.bp_liability), 0) || null,
      covered: rows.some((r) => r.brightpay_covered),
    }];
  }, [rows, grain]);

  const walkClosing = rows.length ? n(rows[rows.length - 1].cumulative_due) : 0;
  // The walk sums what HMRC charged and never collected. HMRC's stated debt can
  // differ — most of the gap sits on schemes with a time-to-pay arrangement,
  // where HMRC restates the balance while the monthly charges stay unpaid in the
  // grid. Showing the difference is the point; hiding it would make both numbers
  // untrustworthy.
  const difference = stated === null ? null : stated - walkClosing;

  const firstCovered = rows.find((r) => r.brightpay_covered);

  const exportCsv = () => {
    downloadCSV(
      `hmrc-paye-trend-${grain}-${new Date().toISOString().slice(0, 10)}.csv`,
      ['Period', 'Opening', 'Charged', 'Credits', 'Paid', 'Movement', 'Closing', 'Schemes owing', 'BrightPay liability'],
      periods.map((p) => [
        p.label, p.opening.toFixed(2), p.charges.toFixed(2), p.credits.toFixed(2),
        p.payments.toFixed(2), p.movement.toFixed(2), p.closing.toFixed(2),
        p.schemesOwing ?? '', p.bpLiability === null ? '' : p.bpLiability.toFixed(2),
      ]),
    );
  };

  return (
    <div>
      <ErrorBar message={error} />

      <p style={{ fontSize: 13, color: '#64748b', maxWidth: 900, marginTop: 0, marginBottom: 14, lineHeight: 1.55 }}>
        How the HMRC position was arrived at. Each period opens with the balance brought forward, adds what
        HMRC charged, takes off credits and payments, and closes with what was still owed. Roll it up by
        month, by tax year, or in total.
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 10, marginBottom: 16 }}>
        <Stat label="Owed per the walk" value={fmtGbp(walkClosing)} colour="#b91c1c" big
              hint="Charges HMRC never collected, accumulated across every scraped month" />
        <Stat label="HMRC's stated debt" value={stated === null ? '…' : fmtGbp(stated)} colour="#0f172a"
              hint="The figure on the Debt tab, from HMRC's own position" />
        <Stat label="Difference" value={difference === null ? '…' : fmtGbp(difference)}
              colour={difference && Math.abs(difference) > 1 ? '#c2410c' : '#059669'}
              hint="Mostly schemes on a payment plan, where HMRC restates the balance" />
        <Stat label="Charged all-time" value={fmtGbp(periods.length ? rows.reduce((s, r) => s + n(r.charges), 0) : 0)} colour="#64748b" />
        <Stat label="Paid all-time" value={fmtGbp(periods.length ? rows.reduce((s, r) => s + n(r.payments), 0) : 0)} colour="#059669" />
      </div>

      <div style={{ display: 'flex', gap: 6, marginBottom: 14, alignItems: 'center', flexWrap: 'wrap' }}>
        <Chip value="month" label="By month" active={grain} onClick={setGrain} count={rows.length} />
        <Chip value="year" label="By tax year" active={grain} onClick={setGrain}
              count={new Set(rows.map((r) => r.tax_year)).size} />
        <Chip value="total" label="Total" active={grain} onClick={setGrain} />
        <div style={{ flex: 1 }} />
        <button
          onClick={exportCsv}
          disabled={periods.length === 0}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 5, padding: '6px 12px',
            fontSize: 12, fontFamily: font, color: '#475569', background: '#fff',
            border: '1px solid #e5e7eb', borderRadius: 8,
            cursor: periods.length ? 'pointer' : 'default', opacity: periods.length ? 1 : 0.5,
          }}
        >
          <Download size={12} /> Export
        </button>
      </div>

      {/* Where reconciliation can actually start. Everything before this is an
          opening balance we carry rather than one we have verified. */}
      <div style={{
        display: 'flex', gap: 9, alignItems: 'flex-start',
        background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 10,
        padding: '10px 13px', marginBottom: 14, fontSize: 12.5, color: '#78350f', lineHeight: 1.5,
      }}>
        <TriangleAlert size={15} style={{ color: '#d97706', flexShrink: 0, marginTop: 1 }} />
        <div>
          {firstCovered ? (
            <>
              BrightPay figures only exist from <b>{MONTH_NAMES[firstCovered.tax_month]} {firstCovered.tax_year}</b>.
              Everything before that is HMRC's word alone — carry it as an opening balance rather than
              treating it as reconciled.
            </>
          ) : (
            <>
              No month yet has both an HMRC charge and a BrightPay liability, so nothing here is reconciled
              against BrightPay. HMRC's ledger currently ends a month behind BrightPay's records; the two
              meet at the next scrape after HMRC posts the month. Until then this is HMRC's word alone.
            </>
          )}
        </div>
      </div>

      {loading ? (
        <div style={{ color: '#94a3b8', fontSize: 13, padding: 24 }}>Loading the trend…</div>
      ) : (
        <div style={card}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: '#f8fafc', fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5, color: '#64748b' }}>
                  <th style={th}>Period</th>
                  <th style={thNum}>Opening</th>
                  <th style={thNum}>Charged</th>
                  <th style={thNum}>Credits</th>
                  <th style={thNum}>Paid</th>
                  <th style={thNum}>Movement</th>
                  <th style={thNum}>Closing</th>
                  <th style={{ ...th, textAlign: 'center' }}>Owing</th>
                  <th style={thNum}>BrightPay</th>
                </tr>
              </thead>
              <tbody>
                {periods.length === 0 && (
                  <tr><td colSpan={9} style={{ padding: 30, textAlign: 'center', color: '#94a3b8' }}>
                    No scraped months yet.
                  </td></tr>
                )}
                {[...periods].reverse().map((p) => (
                  <tr key={p.key} style={{ borderTop: '1px solid #f1f5f9' }}>
                    <td style={td}>
                      <span style={{ fontWeight: 600, color: '#0f172a' }}>{p.label}</span>
                      <span style={{ fontSize: 10, color: '#94a3b8', marginLeft: 6 }}>{p.sub}</span>
                    </td>
                    <td style={{ ...tdNum, color: '#64748b' }}>{fmtGbpDetailed(p.opening)}</td>
                    <td style={tdNum}>{fmtGbpDetailed(p.charges)}</td>
                    <td style={{ ...tdNum, color: p.credits > 0 ? '#059669' : '#cbd5e1' }}>
                      {p.credits > 0 ? `-${fmtGbpDetailed(p.credits)}` : '—'}
                    </td>
                    <td style={{ ...tdNum, color: '#059669' }}>{`-${fmtGbpDetailed(p.payments)}`}</td>
                    <td style={{ ...tdNum, fontWeight: 600, color: p.movement > 0 ? '#b91c1c' : '#94a3b8' }}>
                      {p.movement > 0 ? `+${fmtGbpDetailed(p.movement)}` : fmtGbpDetailed(p.movement)}
                    </td>
                    <td style={{ ...tdNum, fontWeight: 700, color: '#0f172a' }}>{fmtGbpDetailed(p.closing)}</td>
                    <td style={{ ...td, textAlign: 'center', fontSize: 12, color: '#64748b' }}>{p.schemesOwing || '—'}</td>
                    <td style={{ ...tdNum, fontSize: 12, color: p.covered ? '#0f172a' : '#cbd5e1' }}>
                      {p.bpLiability === null
                        ? <span title="No BrightPay liability recorded for this period">—</span>
                        : <span title={`${p.bpSchemes} scheme(s) with a BrightPay figure`}>{fmtGbpDetailed(p.bpLiability)}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
              {periods.length > 0 && difference !== null && Math.abs(difference) > 1 && (
                <tfoot>
                  <tr style={{ borderTop: '2px solid #e5e7eb', background: '#f8fafc' }}>
                    <td colSpan={6} style={{ ...td, fontSize: 12, color: '#78350f' }}>
                      Difference between the walk and HMRC's stated debt — concentrated in schemes on a
                      payment plan, where HMRC restates the balance
                    </td>
                    <td style={{ ...tdNum, fontWeight: 700, color: '#c2410c' }}>{fmtGbpDetailed(difference)}</td>
                    <td colSpan={2} />
                  </tr>
                  <tr style={{ background: '#f8fafc' }}>
                    <td colSpan={6} style={{ ...td, fontSize: 12, fontWeight: 600, color: '#0f172a' }}>
                      HMRC's stated debt today
                    </td>
                    <td style={{ ...tdNum, fontWeight: 700, color: '#0f172a' }}>{fmtGbpDetailed(stated)}</td>
                    <td colSpan={2} />
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
