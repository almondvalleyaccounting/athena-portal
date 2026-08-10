import React, { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AlertTriangle, ChevronRight, Download, Search } from 'lucide-react';
// Pennies matter here: the point of the tab is that the parts add up to the
// whole. fmtGbp rounds to whole pounds and would make a correct breakdown look
// like it was out by a few pounds.
import { fmtGbpDetailed as money } from '../../lib/money';
import { downloadCSV } from '../../lib/exportUtils';
import { fetchBalanceByYear, fetchChargeLines } from './hmrcApi';
import {
  font, Stat, Chip, ErrorBar, th, td, thNum, tdNum, card, inputStyle,
} from './hmrcShared';

// Balance Analysis — how a client arrived at the balance HMRC shows today.
//
// The debt tab answers "who owes what". This one answers "why", which is a
// different question and needs different data: the annual statement gives a
// single Charges figure per month, so the make-up comes from the monthly detail
// pages the scraper reads alongside it.
//
// Three levels, each a click apart:
//   practice   what the whole book is made of, by category and by tax year
//   scheme     one client's bridge — brought forward, charged, credited, paid
//   month      the lines HMRC actually assessed
//
// Charges and credits are shown as HMRC groups them, not as we would. Income
// tax, employer's NI and employees' NI arrive on the Full Payment Submission;
// interest and penalties are added afterwards; Employment Allowance, CIS
// suffered and statutory recoveries come back on the Employer Payment Summary.

// Fixed order so the bars and the table read the same way every time, and a
// colour per category kept away from the debt tab's red/amber/green — nothing
// here is a status.
const CHARGE_CATEGORIES = [
  ['Income tax', '#0e7fe0'],
  ["Employer's NI", '#7c3aed'],
  ["Employees' NI", '#0891b2'],
  ['Student loan', '#4f46e5'],
  ['Apprenticeship levy', '#9333ea'],
  ['CIS withheld', '#c2410c'],
  ['Interest', '#b91c1c'],
  ['Penalties', '#991b1b'],
  ['Other', '#94a3b8'],
];

const CREDIT_CATEGORIES = [
  ['Employment Allowance', '#059669'],
  ['CIS suffered', '#0d9488'],
  ['Statutory payments', '#65a30d'],
  ['Other', '#94a3b8'],
];

const colourFor = (category, kind) =>
  ((kind === 'credit' ? CREDIT_CATEGORIES : CHARGE_CATEGORIES).find(([c]) => c === category) || [])[1] || '#94a3b8';

const sum = (rows, key) => rows.reduce((s, r) => s + Number(r[key] || 0), 0);

export default function BalanceView() {
  const [params, setParams] = useSearchParams();
  const [years, setYears] = useState([]);
  const [lines, setLines] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [taxYear, setTaxYear] = useState('all');

  const selected = params.get('scheme');

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  async function load() {
    setLoading(true);
    try {
      const [y, l] = await Promise.all([fetchBalanceByYear(), fetchChargeLines()]);
      setYears(y);
      setLines(l);
      setError('');
    } catch (e) {
      setError(e.message || 'Could not load the balance analysis');
    } finally {
      setLoading(false);
    }
  }

  const taxYears = useMemo(
    () => [...new Set(years.map((r) => r.tax_year))].sort().reverse(),
    [years],
  );

  const inYear = useMemo(
    () => (taxYear === 'all' ? years : years.filter((r) => r.tax_year === taxYear)),
    [years, taxYear],
  );

  // Line detail exists only for the current year — the monthly pages are one
  // request each and are not worth backfilling six years deep. Say so rather
  // than showing an empty breakdown that looks like "nothing was charged".
  const lineYears = useMemo(() => [...new Set(lines.map((l) => l.tax_year))], [lines]);
  const linesInScope = useMemo(
    () => (taxYear === 'all' ? lines : lines.filter((l) => l.tax_year === taxYear)),
    [lines, taxYear],
  );
  const noDetailForYear = taxYear !== 'all' && !lineYears.includes(taxYear);

  const schemes = useMemo(() => {
    const map = new Map();
    for (const r of inYear) {
      const cur = map.get(r.paye_ref) || {
        paye_ref: r.paye_ref, hmrc_name: r.hmrc_name, entity_id: r.entity_id,
        charges: 0, credits: 0, payments: 0, still_due: 0, overdue_months: 0,
        detail_reconciles: true,
      };
      cur.charges += Number(r.charges || 0);
      cur.credits += Number(r.credits || 0);
      cur.payments += Number(r.payments || 0);
      cur.still_due += Number(r.still_due || 0);
      cur.overdue_months += Number(r.overdue_months || 0);
      if (r.detail_reconciles === false) cur.detail_reconciles = false;
      map.set(r.paye_ref, cur);
    }
    const q = search.trim().toLowerCase();
    return [...map.values()]
      .filter((s) => !q || `${s.hmrc_name} ${s.paye_ref}`.toLowerCase().includes(q))
      .sort((a, b) => b.still_due - a.still_due || b.charges - a.charges);
  }, [inYear, search]);

  const byCategory = (kind) => {
    const map = new Map();
    for (const l of linesInScope.filter((x) => x.kind === kind)) {
      map.set(l.category, (map.get(l.category) || 0) + Number(l.amount || 0));
    }
    const order = (kind === 'credit' ? CREDIT_CATEGORIES : CHARGE_CATEGORIES).map(([c]) => c);
    return [...map.entries()]
      .sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]))
      .map(([category, amount]) => ({ category, amount, colour: colourFor(category, kind) }));
  };

  const chargeCats = useMemo(() => byCategory('charge'), [linesInScope]);
  const creditCats = useMemo(() => byCategory('credit'), [linesInScope]);

  const totals = {
    charges: sum(inYear, 'charges'),
    credits: sum(inYear, 'credits'),
    payments: sum(inYear, 'payments'),
    stillDue: sum(inYear, 'still_due'),
  };

  const unreconciled = inYear.filter((r) => r.detail_reconciles === false);

  if (loading) return <div style={{ fontFamily: font, color: '#94a3b8', fontSize: 13 }}>Loading…</div>;

  if (selected) {
    return (
      <SchemeBalance
        payeRef={selected}
        years={years.filter((r) => r.paye_ref === selected)}
        lines={lines.filter((l) => l.paye_ref === selected)}
        onBack={() => { params.delete('scheme'); setParams(params, { replace: true }); }}
      />
    );
  }

  return (
    <div style={{ fontFamily: font }}>
      <ErrorBar message={error} />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10, marginBottom: 16 }}>
        <Stat label="Charged" value={money(totals.charges)} colour="#0e7fe0"
              hint="Everything HMRC assessed" />
        <Stat label="Credits" value={money(totals.credits)} colour="#059669"
              hint="Set against the charges" />
        <Stat label="Net charged" value={money(totals.charges - totals.credits)} colour="#7c3aed"
              hint="What was actually payable" />
        <Stat label="Paid" value={money(totals.payments)} colour="#0891b2" />
        <Stat label="Still due" value={money(totals.stillDue)} colour="#b91c1c" big
              hint="On these statements" />
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 14 }}>
        <Chip value="all" label="All years" active={taxYear} onClick={setTaxYear} count={years.length} />
        {taxYears.map((y) => (
          <Chip key={y} value={y} label={y} active={taxYear} onClick={setTaxYear}
                count={years.filter((r) => r.tax_year === y).length} />
        ))}
        <div style={{ position: 'relative', marginLeft: 'auto', minWidth: 220 }}>
          <Search size={13} style={{ position: 'absolute', left: 9, top: 9, color: '#94a3b8' }} />
          <input value={search} onChange={(e) => setSearch(e.target.value)}
                 placeholder="Client or PAYE reference"
                 style={{ ...inputStyle, paddingLeft: 27 }} />
        </div>
        <button
          onClick={() => downloadCSV(
            `hmrc-balance-${taxYear}.csv`,
            ['Client', 'PAYE reference', 'Charged', 'Credits', 'Net', 'Paid', 'Still due', 'Breakdown complete'],
            schemes.map((s) => [
              s.hmrc_name, s.paye_ref,
              s.charges.toFixed(2), s.credits.toFixed(2), (s.charges - s.credits).toFixed(2),
              s.payments.toFixed(2), s.still_due.toFixed(2),
              s.detail_reconciles === false ? 'no' : 'yes',
            ]),
          )}
          style={exportButton}>
          <Download size={13} /> Export
        </button>
      </div>

      {unreconciled.length > 0 && (
        <div style={{
          display: 'flex', gap: 8, alignItems: 'flex-start',
          background: '#fff7ed', border: '1px solid #fed7aa', color: '#c2410c',
          borderRadius: 8, padding: '9px 12px', fontSize: 12, marginBottom: 14,
        }}>
          <AlertTriangle size={15} style={{ flexShrink: 0, marginTop: 1 }} />
          <span>
            {unreconciled.length} scheme{unreconciled.length === 1 ? '' : 's'} where the assessed lines
            do not sum to the month's charge. In every case seen so far the month carries corrections
            to an earlier period — HMRC assesses those in the month they are found but bills them
            against the period they belong to. The breakdown is what HMRC shows; the balance is right.
          </span>
        </div>
      )}

      {noDetailForYear ? (
        <div style={{ ...card, padding: '14px 16px', fontSize: 12, color: '#64748b', marginBottom: 16 }}>
          No line-level detail held for {taxYear}. The make-up of a charge comes from HMRC's monthly
          pages, which are only read for the current year — the totals above come from the annual
          statement and are complete.
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 12, marginBottom: 16 }}>
          <CategoryCard title="What was charged" subtitle="As HMRC assessed it" rows={chargeCats} />
          <CategoryCard title="What was credited" subtitle="Set against those charges" rows={creditCats} />
        </div>
      )}

      <div style={card}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
          <thead>
            <tr style={{ background: '#f8fafc', color: '#64748b', fontSize: 11, borderBottom: '1px solid #e5e7eb' }}>
              <th style={th}>Client</th>
              <th style={thNum}>Charged</th>
              <th style={thNum}>Credits</th>
              <th style={thNum}>Net</th>
              <th style={thNum}>Paid</th>
              <th style={thNum}>Still due</th>
              <th style={{ ...th, width: 30 }} />
            </tr>
          </thead>
          <tbody>
            {schemes.map((s) => (
              <tr key={s.paye_ref}
                  onClick={() => { params.set('scheme', s.paye_ref); setParams(params); }}
                  style={{ borderBottom: '1px solid #f1f5f9', cursor: 'pointer' }}>
                <td style={td}>
                  <div style={{ fontWeight: 600 }}>{s.hmrc_name}</div>
                  <div style={{ fontSize: 11, color: '#94a3b8' }}>
                    {s.paye_ref}
                    {s.detail_reconciles === false && (
                      <span style={{ color: '#c2410c', marginLeft: 6 }}>· includes prior-period corrections</span>
                    )}
                  </div>
                </td>
                <td style={tdNum}>{money(s.charges)}</td>
                <td style={{ ...tdNum, color: '#059669' }}>{s.credits ? `−${money(s.credits)}` : '—'}</td>
                <td style={tdNum}>{money(s.charges - s.credits)}</td>
                <td style={tdNum}>{money(s.payments)}</td>
                <td style={{ ...tdNum, fontWeight: s.still_due > 0 ? 700 : 400, color: s.still_due > 0 ? '#b91c1c' : '#94a3b8' }}>
                  {s.still_due > 0 ? money(s.still_due) : '—'}
                </td>
                <td style={{ ...td, color: '#cbd5e1' }}><ChevronRight size={14} /></td>
              </tr>
            ))}
            {schemes.length === 0 && (
              <tr><td colSpan={7} style={{ ...td, textAlign: 'center', color: '#94a3b8', padding: 26 }}>
                Nothing matches that search.
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// A category with a proportional bar. The bar is scaled to the largest row
// rather than to the total, so small categories stay visible instead of
// collapsing to a sliver next to income tax.
function CategoryCard({ title, subtitle, rows }) {
  const max = Math.max(1, ...rows.map((r) => Math.abs(r.amount)));
  const total = rows.reduce((s, r) => s + r.amount, 0);

  return (
    <div style={{ ...card, padding: '14px 16px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 12 }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: '#0f172a' }}>{title}</div>
          <div style={{ fontSize: 11, color: '#94a3b8' }}>{subtitle}</div>
        </div>
        <div style={{ fontSize: 15, fontWeight: 700, color: '#0f172a', fontVariantNumeric: 'tabular-nums' }}>
          {money(total)}
        </div>
      </div>

      {rows.length === 0 && <div style={{ fontSize: 12, color: '#94a3b8' }}>Nothing recorded.</div>}

      {rows.map((r) => (
        <div key={r.category} style={{ marginBottom: 9 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 3 }}>
            <span style={{ color: '#334155' }}>{r.category}</span>
            <span style={{ fontVariantNumeric: 'tabular-nums', color: '#0f172a', fontWeight: 600 }}>
              {money(r.amount)}
            </span>
          </div>
          <div style={{ height: 5, background: '#f1f5f9', borderRadius: 999 }}>
            <div style={{
              height: 5, borderRadius: 999, background: r.colour,
              width: `${Math.max(2, (Math.abs(r.amount) / max) * 100)}%`,
            }} />
          </div>
        </div>
      ))}
    </div>
  );
}

// One scheme: the year-by-year bridge, then the lines behind each month.
function SchemeBalance({ payeRef, years, lines, onBack }) {
  const [openYear, setOpenYear] = useState(() => years.at(-1)?.tax_year || null);
  const name = years[0]?.hmrc_name || payeRef;

  const monthsOfYear = useMemo(() => {
    const map = new Map();
    for (const l of lines.filter((x) => x.tax_year === openYear)) {
      const m = map.get(l.tax_month) || { tax_month: l.tax_month, charges: [], credits: [] };
      (l.kind === 'credit' ? m.credits : m.charges).push(l);
      map.set(l.tax_month, m);
    }
    return [...map.values()].sort((a, b) => a.tax_month - b.tax_month);
  }, [lines, openYear]);

  return (
    <div style={{ fontFamily: font }}>
      <button onClick={onBack} style={{ ...exportButton, marginBottom: 14 }}>← All clients</button>

      <h2 style={{ fontSize: 18, fontWeight: 600, color: '#0f172a', marginBottom: 2 }}>{name}</h2>
      <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 16 }}>{payeRef}</div>

      <div style={{ ...card, marginBottom: 16 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
          <thead>
            <tr style={{ background: '#f8fafc', color: '#64748b', fontSize: 11, borderBottom: '1px solid #e5e7eb' }}>
              <th style={th}>Tax year</th>
              <th style={thNum}>Brought forward</th>
              <th style={thNum}>Charged</th>
              <th style={thNum}>Credits</th>
              <th style={thNum}>Paid</th>
              <th style={thNum}>Still due</th>
              <th style={thNum}>Running total</th>
            </tr>
          </thead>
          <tbody>
            {years.map((y) => (
              <tr key={y.tax_year}
                  onClick={() => setOpenYear(y.tax_year === openYear ? null : y.tax_year)}
                  style={{
                    borderBottom: '1px solid #f1f5f9', cursor: 'pointer',
                    background: y.tax_year === openYear ? '#f8fafc' : undefined,
                  }}>
                <td style={{ ...td, fontWeight: 600 }}>{y.tax_year}</td>
                <td style={{ ...tdNum, color: '#94a3b8' }}>{money(y.brought_forward)}</td>
                <td style={tdNum}>{money(y.charges)}</td>
                <td style={{ ...tdNum, color: '#059669' }}>{y.credits ? `−${money(y.credits)}` : '—'}</td>
                <td style={tdNum}>{money(y.payments)}</td>
                <td style={{ ...tdNum, fontWeight: y.still_due > 0 ? 700 : 400, color: y.still_due > 0 ? '#b91c1c' : '#94a3b8' }}>
                  {y.still_due > 0 ? money(y.still_due) : '—'}
                </td>
                <td style={{ ...tdNum, fontWeight: 700 }}>{money(y.cumulative_due)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {openYear && (
        monthsOfYear.length === 0 ? (
          <div style={{ ...card, padding: '14px 16px', fontSize: 12, color: '#64748b' }}>
            No line-level detail held for {openYear}. HMRC's monthly pages are only read for the
            current year; the yearly figures above come from the annual statement.
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 12 }}>
            {monthsOfYear.map((m) => {
              const charged = sum(m.charges, 'amount');
              const credited = sum(m.credits, 'amount');
              return (
                <div key={m.tax_month} style={{ ...card, padding: '13px 15px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 9 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 600 }}>Month {m.tax_month}</div>
                    <div style={{ fontSize: 13, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
                      {money(charged - credited)}
                    </div>
                  </div>
                  {[...m.charges, ...m.credits].map((l) => (
                    <div key={l.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, padding: '3px 0' }}>
                      <span style={{ color: '#475569', display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ width: 6, height: 6, borderRadius: 999, background: colourFor(l.category, l.kind) }} />
                        {l.line_type}
                      </span>
                      <span style={{
                        fontVariantNumeric: 'tabular-nums',
                        color: l.kind === 'credit' ? '#059669' : '#0f172a',
                      }}>
                        {l.kind === 'credit' ? `−${money(l.amount)}` : money(l.amount)}
                      </span>
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        )
      )}
    </div>
  );
}

const exportButton = {
  display: 'inline-flex', alignItems: 'center', gap: 6,
  padding: '6px 12px', fontSize: 12, fontWeight: 500, color: '#334155',
  background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8,
  cursor: 'pointer', fontFamily: font,
};
