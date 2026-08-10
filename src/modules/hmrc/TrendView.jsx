import React, { useEffect, useMemo, useState } from 'react';
import { Download, TriangleAlert } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { fmtGbp, fmtGbpDetailed } from '../../lib/money';
import { downloadCSV } from '../../lib/exportUtils';
import { font, TIERS, Stat, Chip, ErrorBar, th, thNum, td, tdNum, card, inputStyle } from './hmrcShared';

// How the HMRC position was arrived at — the walk from nothing to what is owed
// today, at three grains, filterable, and exportable for year-end work.
//
// Aggregation of the WALK is done here in the browser: hmrc_trend_monthly()
// returns one row per tax month (75 today, 12 a year forever), so month / tax
// year / total are just different groupings of one small result. The FILTERING
// has to happen server-side though — you cannot filter a pre-aggregated total —
// hence the RPC rather than a plain view read.
//
// The fetches live in this file rather than hmrcApi.js on purpose: that module
// is shared with a second session, and a self-contained component cannot be
// broken by a concurrent rewrite of a shared file.

const MONTH_NAMES = ['', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar'];
const n = (v) => Number(v || 0);

const TIER_CHOICES = [
  { value: 'all', label: 'All schemes', tiers: null },
  { value: '1',   label: TIERS[1].label, tiers: [1] },
  { value: '2',   label: TIERS[2].label, tiers: [2] },
  { value: '3',   label: TIERS[3].label, tiers: [3] },
  { value: 'owing', label: 'Owing', tiers: [1, 2, 3] },
];

async function fetchTrend({ entityIds, tiers, standings, managers }) {
  const { data, error } = await supabase.rpc('hmrc_trend_monthly', {
    p_entity_ids: entityIds && entityIds.length ? entityIds : null,
    p_tiers:      tiers && tiers.length ? tiers : null,
    p_standings:  standings && standings.length ? standings : null,
    p_managers:   managers && managers.length ? managers : null,
  });
  if (error) throw error;
  return data || [];
}

async function fetchFilterOptions() {
  const { data, error } = await supabase
    .from('v_hmrc_paye_clients')
    .select('entity_id, entity_name, hmrc_name, paye_ref, standing, chase_tier')
    .order('entity_name', { ascending: true, nullsFirst: false });
  if (error) throw error;
  return data || [];
}

async function fetchHistory() {
  const { data, error } = await supabase
    .from('v_hmrc_paye_debt_history')
    .select('*')
    .order('run_id', { ascending: false });
  if (error) throw error;
  return data || [];
}

export default function TrendView() {
  const [rows, setRows] = useState([]);
  const [schemes, setSchemes] = useState([]);
  const [history, setHistory] = useState([]);
  const [grain, setGrain] = useState('year');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Filters
  const [tierChoice, setTierChoice] = useState('all');
  const [entityId, setEntityId] = useState('');
  const [manager, setManager] = useState('');
  const [standing, setStanding] = useState('');

  useEffect(() => {
    Promise.all([fetchFilterOptions(), fetchHistory()])
      .then(([s, h]) => { setSchemes(s); setHistory(h); })
      .catch((e) => setError(e.message || 'Could not load filters'));
  }, []);

  useEffect(() => {
    setLoading(true);
    const choice = TIER_CHOICES.find((c) => c.value === tierChoice);
    fetchTrend({
      entityIds: entityId ? [entityId] : null,
      tiers: choice?.tiers || null,
      standings: standing ? [standing] : null,
      managers: manager ? [manager] : null,
    })
      .then((t) => { setRows(t); setError(''); })
      .catch((e) => setError(e.message || 'Could not load the trend'))
      .finally(() => setLoading(false));
  }, [tierChoice, entityId, manager, standing]);

  const managers = useMemo(
    () => [...new Set(schemes.map((s) => s.manager).filter(Boolean))].sort(),
    [schemes],
  );

  // Rows arrive oldest-first, which is the order the walk has to be built in:
  // each period's opening is the previous period's closing.
  const periods = useMemo(() => {
    if (rows.length === 0) return [];

    const mk = (r, opening) => ({
      charges: n(r.charges), credits: n(r.credits), payments: n(r.payments),
      movement: n(r.still_due), closing: n(r.cumulative_due), opening,
      schemesOwing: r.schemes_owing, bpSchemes: r.brightpay_schemes,
      bpLiability: r.bp_liability === null ? null : n(r.bp_liability),
      covered: r.brightpay_covered,
    });

    if (grain === 'month') {
      return rows.map((r, i) => ({
        key: `${r.tax_year}-${r.tax_month}`,
        label: `${MONTH_NAMES[r.tax_month] || `M${r.tax_month}`} ${r.tax_year}`,
        sub: `month ${r.tax_month}`,
        ...mk(r, i === 0 ? 0 : n(rows[i - 1].cumulative_due)),
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
          sub: `${inYear.length} month${inYear.length === 1 ? '' : 's'}`,
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
  const charged = rows.reduce((s, r) => s + n(r.charges), 0);
  const paid = rows.reduce((s, r) => s + n(r.payments), 0);
  const firstCovered = rows.find((r) => r.brightpay_covered);
  const filtered = !!(entityId || manager || standing || tierChoice !== 'all');

  // The stated-debt comparison only means anything unfiltered — the observed
  // history is a whole-book figure and cannot be sliced by manager or tier.
  const statedNow = history.length ? n(history[0].total_debt) : null;
  const difference = (!filtered && statedNow !== null) ? statedNow - walkClosing : null;

  const filterLabel = [
    entityId && (schemes.find((s) => s.entity_id === entityId)?.entity_name || 'client'),
    manager && `managed by ${manager}`,
    standing && standing.replace('_', ' '),
    tierChoice !== 'all' && TIER_CHOICES.find((c) => c.value === tierChoice)?.label,
  ].filter(Boolean).join(' · ');

  const exportCsv = () => {
    const stamp = new Date().toISOString().slice(0, 10);
    downloadCSV(
      `hmrc-paye-trend-${grain}-${stamp}.csv`,
      ['Period', 'Opening', 'Charged', 'Credits', 'Paid', 'Movement', 'Closing',
       'Schemes owing', 'BrightPay liability', 'Filter'],
      periods.map((p) => [
        p.label, p.opening.toFixed(2), p.charges.toFixed(2), p.credits.toFixed(2),
        p.payments.toFixed(2), p.movement.toFixed(2), p.closing.toFixed(2),
        p.schemesOwing ?? '', p.bpLiability === null ? '' : p.bpLiability.toFixed(2),
        filterLabel || 'all schemes',
      ]),
    );
  };

  return (
    <div>
      <ErrorBar message={error} />

      <p style={{ fontSize: 13, color: '#64748b', maxWidth: 900, marginTop: 0, marginBottom: 14, lineHeight: 1.55 }}>
        How the HMRC position was arrived at. Each period opens with the balance brought forward, adds what
        HMRC charged, takes off credits and payments, and closes with what was still owed. Slice it by client,
        manager or chase tier, roll it up by month, tax year or total, and export whatever is on screen.
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 10, marginBottom: 16 }}>
        <Stat label="Owed per the walk" value={fmtGbp(walkClosing)} colour="#b91c1c" big
              hint="Charges HMRC never collected, accumulated across every scraped month" />
        <Stat label={filtered ? 'Stated debt (all)' : "HMRC's stated debt"}
              value={statedNow === null ? '…' : fmtGbp(statedNow)} colour="#0f172a"
              hint={filtered
                ? 'Whole-book figure from the last scrape — cannot be filtered'
                : 'From the last scrape, HMRC\'s own position'} />
        <Stat label="Difference" value={difference === null ? '—' : fmtGbp(difference)}
              colour={difference && Math.abs(difference) > 1 ? '#c2410c' : '#059669'}
              hint={filtered
                ? 'Only meaningful with no filters applied'
                : 'Mostly schemes on a payment plan, where HMRC restates the balance'} />
        <Stat label="Charged" value={fmtGbp(charged)} colour="#64748b" hint="Across the periods shown" />
        <Stat label="Paid" value={fmtGbp(paid)} colour="#059669" hint="Across the periods shown" />
      </div>

      {/* Grain */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 8, alignItems: 'center', flexWrap: 'wrap' }}>
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

      {/* Filters */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        <select value={entityId} onChange={(e) => setEntityId(e.target.value)}
                style={{ ...inputStyle, width: 'auto', maxWidth: 260 }}>
          <option value="">Every scheme</option>
          {schemes.filter((s) => s.entity_id).map((s) => (
            <option key={s.entity_id} value={s.entity_id}>
              {s.entity_name || s.hmrc_name} — {s.paye_ref}
            </option>
          ))}
        </select>

        <select value={manager} onChange={(e) => setManager(e.target.value)}
                style={{ ...inputStyle, width: 'auto' }}>
          <option value="">Any manager</option>
          {managers.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>

        <select value={standing} onChange={(e) => setStanding(e.target.value)}
                style={{ ...inputStyle, width: 'auto' }}>
          <option value="">Any standing</option>
          <option value="client">Active clients</option>
          <option value="former_client">Former clients</option>
          <option value="not_a_client">Not in Athena</option>
        </select>

        {TIER_CHOICES.map((c) => (
          <Chip key={c.value} value={c.value} label={c.label} active={tierChoice} onClick={setTierChoice}
                colour={c.tiers?.length === 1 ? TIERS[c.tiers[0]].colour : undefined} />
        ))}

        {filtered && (
          <button
            onClick={() => { setEntityId(''); setManager(''); setStanding(''); setTierChoice('all'); }}
            style={{
              padding: '6px 11px', fontSize: 12, fontFamily: font, color: '#b91c1c',
              background: '#fff', border: '1px solid #fecaca', borderRadius: 999, cursor: 'pointer',
            }}
          >
            Clear filters
          </button>
        )}
      </div>

      {filtered && (
        <div style={{ fontSize: 11.5, color: '#64748b', marginBottom: 12 }}>
          Showing <b>{filterLabel}</b> — {rows.length} month{rows.length === 1 ? '' : 's'}
        </div>
      )}

      {/* Where reconciliation can actually start. */}
      <div style={{
        display: 'flex', gap: 9, alignItems: 'flex-start',
        background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 10,
        padding: '10px 13px', marginBottom: 14, fontSize: 12.5, color: '#78350f', lineHeight: 1.5,
      }}>
        <TriangleAlert size={15} style={{ color: '#d97706', flexShrink: 0, marginTop: 1 }} />
        <div>
          {firstCovered ? (
            <>
              {/* "Jun 2026-27" reads as a date that does not exist. Tax month
                  and tax year are two different things and the label has to say
                  which is which. */}
              BrightPay figures exist from <b>month {firstCovered.tax_month} ({MONTH_NAMES[firstCovered.tax_month]})
              of {firstCovered.tax_year}</b>. Everything before that is HMRC's word alone — carry it as an
              opening balance rather than treating it as reconciled.
            </>
          ) : (
            <>
              No month here has both an HMRC charge and a BrightPay liability, so nothing is reconciled against
              BrightPay yet. HMRC's ledger runs a month behind BrightPay's records; the two meet at the next
              scrape after HMRC posts the month. Until then this is HMRC's word alone, and any year-end figure
              taken from it is an opening balance, not a verified one.
            </>
          )}
        </div>
      </div>

      {loading ? (
        <div style={{ color: '#94a3b8', fontSize: 13, padding: 24 }}>Loading the trend…</div>
      ) : (
        <div style={{ ...card, marginBottom: 22 }}>
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
                    Nothing matches these filters.
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
                      HMRC's stated debt at the last scrape
                    </td>
                    <td style={{ ...tdNum, fontWeight: 700, color: '#0f172a' }}>{fmtGbpDetailed(statedNow)}</td>
                    <td colSpan={2} />
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </div>
      )}

      <ObservedHistory history={history} />
    </div>
  );
}

// One row per scrape. This is the only series that gives a TRUE balance at a
// past date — the walk above says which charges are still unpaid today, which is
// a different thing. hmrc.position keeps every run, so this covers every scrape
// ever taken; it just needs runs to accumulate before it can answer "what did
// they owe at the year end".
function ObservedHistory({ history }) {
  if (history.length === 0) return null;
  const sameDay = new Set(history.map((h) => h.observed_on)).size === 1;

  return (
    <div>
      <div style={{ fontSize: 13, fontWeight: 600, color: '#0f172a' }}>Observed position history</div>
      <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2, marginBottom: 8, maxWidth: 900, lineHeight: 1.5 }}>
        What the whole book owed each time we looked. This is the series a year-end figure should come from —
        the walk above tells you which charges are <i>still</i> unpaid, not what was outstanding on the day.
        {sameDay && ' Every run so far is from the same day, so there is no movement to see yet.'}
      </div>
      <div style={card}>
        <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ background: '#f8fafc', fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5, color: '#64748b' }}>
              <th style={th}>Observed</th>
              <th style={{ ...th, textAlign: 'center' }}>Schemes</th>
              <th style={{ ...th, textAlign: 'center' }}>Owing</th>
              <th style={thNum}>Total debt</th>
              <th style={thNum}>Change</th>
              <th style={thNum}>Interest</th>
              <th style={{ ...th, textAlign: 'center' }}>On plan</th>
              <th style={{ ...th, textAlign: 'center' }}>Run</th>
            </tr>
          </thead>
          <tbody>
            {history.map((h) => (
              <tr key={h.run_id} style={{ borderTop: '1px solid #f1f5f9' }}>
                <td style={td}>
                  <span style={{ fontWeight: 500 }}>
                    {new Date(h.finished_at || h.started_at).toLocaleString('en-GB', {
                      day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
                    })}
                  </span>
                  {h.clients_failed > 0 && (
                    <span style={{ fontSize: 11, color: '#b91c1c', fontWeight: 600, marginLeft: 6 }}>
                      {h.clients_failed} failed
                    </span>
                  )}
                </td>
                <td style={{ ...td, textAlign: 'center', color: '#64748b', fontSize: 12 }}>{h.schemes}</td>
                <td style={{ ...td, textAlign: 'center', color: '#64748b', fontSize: 12 }}>{h.schemes_owing}</td>
                <td style={{ ...tdNum, fontWeight: 600 }}>{fmtGbpDetailed(h.total_debt)}</td>
                <td style={{
                  ...tdNum,
                  color: h.debt_change === null ? '#cbd5e1'
                       : n(h.debt_change) > 0 ? '#b91c1c'
                       : n(h.debt_change) < 0 ? '#059669' : '#94a3b8',
                }}>
                  {h.debt_change === null ? '—'
                    : n(h.debt_change) === 0 ? 'no change'
                    : `${n(h.debt_change) > 0 ? '+' : ''}${fmtGbpDetailed(h.debt_change)}`}
                </td>
                <td style={{ ...tdNum, color: '#c2410c' }}>{fmtGbpDetailed(h.accruing_interest)}</td>
                <td style={{ ...td, textAlign: 'center', color: '#64748b', fontSize: 12 }}>{h.schemes_on_plan}</td>
                <td style={{ ...td, textAlign: 'center', color: '#94a3b8', fontSize: 11 }}>
                  {h.run_minutes ? `${h.run_minutes}m` : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
