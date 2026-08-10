import React, { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Download, ChevronRight, TriangleAlert } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { fmtGbpDetailed } from '../../lib/money';
import { downloadCSV } from '../../lib/exportUtils';
import SearchInput from '../../components/SearchInput';
import AlphabetFilter, { firstCharBucket } from '../../components/AlphabetFilter';
import { font, ErrorBar, th, thNum, td, tdNum, card, inputStyle } from './hmrcShared';

// One client's PAYE account, as a statement.
//
// Months down the side; opening, the charges that made it up, the credits that
// relieved it, what was paid and what was left across the top. Periods carry
// real dates so a range can cross a tax year — which is the point, because a
// year end is rarely 5 April and this is where the PAYE creditor for a set of
// accounts comes from.
//
// Deliberately one client at a time. A practice-wide aggregate answers "how bad
// is it overall", which the Debt tab already does; it cannot answer "what do I
// put in these accounts".

const MONTH_NAMES = ['', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar'];

// Order matters — this is the order they appear across the statement.
const CHARGE_COLS = [
  ['charge_income_tax', 'Income tax'],
  ['charge_employer_ni', "Employer's NI"],
  ['charge_employees_ni', "Employees' NI"],
  ['charge_student_loan', 'Student loan'],
  ['charge_apprenticeship_levy', 'Levy'],
  ['charge_cis_withheld', 'CIS withheld'],
  ['charge_interest', 'Interest'],
  ['charge_penalties', 'Penalties'],
  ['charge_other', 'Other'],
];
const CREDIT_COLS = [
  ['credit_employment_allowance', 'Empl. Allowance'],
  ['credit_cis_suffered', 'CIS suffered'],
  ['credit_statutory_payments', 'Statutory pay'],
  ['credit_other', 'Other'],
];

const n = (v) => Number(v || 0);
const iso = (d) => d.toISOString().slice(0, 10);

// 6 April of the tax year containing `d` — the default "this tax year" start.
function taxYearStart(d = new Date()) {
  const y = d.getFullYear();
  const boundary = new Date(Date.UTC(y, 3, 6));
  return iso(d >= boundary ? boundary : new Date(Date.UTC(y - 1, 3, 6)));
}

function shiftYears(isoDate, n) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() + n);
  return iso(d);
}

function shiftDays(isoDate, n) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return iso(d);
}

const prettyDate = (isoDate) => (isoDate
  ? new Date(`${isoDate}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
  : '—');

export default function ClientStatementView() {
  const [params, setParams] = useSearchParams();
  const [clients, setClients] = useState([]);
  const [rows, setRows] = useState([]);
  const [payments, setPayments] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const [letter, setLetter] = useState(null);
  const [search, setSearch] = useState('');
  const [showDetail, setShowDetail] = useState(true);
  // Which number is drilled into: { key: '2026-27-3', kind, category }. The
  // statement is a summary, so every figure on it opens the rows behind it.
  const [drill, setDrill] = useState(null);
  const [lines, setLines] = useState([]);

  const [from, setFrom] = useState(taxYearStart());
  const [to, setTo] = useState(iso(new Date()));
  const [yearEnd, setYearEnd] = useState(null);
  const [proof, setProof] = useState(null);

  const payeRef = params.get('scheme') || '';

  useEffect(() => {
    supabase
      .from('v_hmrc_paye_clients')
      .select('paye_ref, entity_name, hmrc_name, total_debt')
      .order('entity_name', { ascending: true, nullsFirst: false })
      .then(({ data, error: e }) => {
        if (e) setError(e.message);
        else setClients(data || []);
      });
  }, []);

  // The company accounting year, for the preset. Parsed from BrightManager task
  // names because Athena holds no year-end column (sql/210).
  useEffect(() => {
    if (!payeRef) { setYearEnd(null); return; }
    supabase.from('v_hmrc_client_year_end').select('*').eq('paye_ref', payeRef).maybeSingle()
      .then(({ data }) => setYearEnd(data || null));
  }, [payeRef]);

  useEffect(() => {
    if (!payeRef) { setRows([]); setPayments([]); setProof(null); setLines([]); return; }
    setDrill(null);
    setLoading(true);
    Promise.all([
      // Filtered on period_END, the same rule the balance proof uses. Selecting
      // by period_start disagreed with it at a boundary: at a 31 May cut-off the
      // table showed tax month 2 (6 May to 5 Jun) and a payment received 17 June
      // against it, while the proof excluded the month and said nothing had been
      // paid since. A period that has not ended is not yet a liability.
      supabase.from('v_hmrc_paye_client_statement').select('*')
        .eq('paye_ref', payeRef)
        .gte('period_end', from).lte('period_end', to)
        .order('period_start', { ascending: true }),
      supabase.from('v_hmrc_paye_payment_detail').select('*')
        .eq('paye_ref', payeRef)
        .order('received_on', { ascending: true, nullsFirst: false }),
      // The balance AT the end of the range — a different number from the
      // statement's closing, which is only what is still unpaid today.
      supabase.rpc('hmrc_paye_balance_at', { p_paye_ref: payeRef, p_as_at: to }),
      // The individual charge/credit lines behind every monthly figure. A few
      // hundred rows per client, so fetched once rather than per drill-down.
      supabase.from('v_hmrc_paye_charge_lines').select('*')
        .eq('paye_ref', payeRef)
        .order('tax_year', { ascending: true })
        .order('tax_month', { ascending: true }),
    ])
      .then(([s, p, b, l]) => {
        if (s.error || p.error) { setError((s.error || p.error).message); return; }
        setRows(s.data || []);
        setPayments(p.data || []);
        setProof(b.error ? null : (b.data || [])[0] || null);
        setLines(l.error ? [] : (l.data || []));
        setError('');
      })
      .catch((e) => setError(e.message || 'Could not load the statement'))
      .finally(() => setLoading(false));
  }, [payeRef, from, to]);

  const selectClient = (ref) => {
    const next = new URLSearchParams(params);
    if (ref) next.set('scheme', ref); else next.delete('scheme');
    setParams(next, { replace: false });
    setOpenMonth(null);
  };

  const visibleClients = useMemo(() => {
    const q = search.trim().toLowerCase();
    return clients.filter((c) => {
      const name = c.entity_name || c.hmrc_name || '';
      if (letter && letter !== 'All' && firstCharBucket(name) !== letter) return false;
      if (!q) return true;
      return `${name} ${c.hmrc_name || ''} ${c.paye_ref}`.toLowerCase().includes(q);
    });
  }, [clients, search, letter]);

  const selected = clients.find((c) => c.paye_ref === payeRef);

  // Only show a detail column if it carries a figure in the range shown —
  // otherwise the statement is twenty columns of zeros.
  const usedCharge = CHARGE_COLS.filter(([k]) => rows.some((r) => n(r[k]) !== 0));
  const usedCredit = CREDIT_COLS.filter(([k]) => rows.some((r) => n(r[k]) !== 0));

  const opening = rows.length ? n(rows[0].opening) : 0;
  const closing = rows.length ? n(rows[rows.length - 1].closing) : 0;
  const totals = rows.reduce((t, r) => ({
    charges: t.charges + n(r.charges),
    credits: t.credits + n(r.credits),
    payments: t.payments + n(r.payments),
  }), { charges: 0, credits: 0, payments: 0 });

  const unallocated = payments.filter((p) => p.unallocated);
  const anyDetailBroken = rows.some((r) => r.detail_reconciles === false);

  const exportCsv = () => {
    const cols = [
      ['Period', (r) => `${MONTH_NAMES[r.tax_month]} ${r.tax_year}`],
      ['Month', (r) => r.tax_month],
      ['Period start', (r) => r.period_start],
      ['Period end', (r) => r.period_end],
      ['Due', (r) => r.due_date],
      ['Opening', (r) => n(r.opening).toFixed(2)],
      ...usedCharge.map(([k, label]) => [label, (r) => n(r[k]).toFixed(2)]),
      ['Charges', (r) => n(r.charges).toFixed(2)],
      ...usedCredit.map(([k, label]) => [`Credit: ${label}`, (r) => n(r[k]).toFixed(2)]),
      ['Credits', (r) => n(r.credits).toFixed(2)],
      ['Payments', (r) => n(r.payments).toFixed(2)],
      ['Closing', (r) => n(r.closing).toFixed(2)],
    ];
    const name = (selected?.entity_name || payeRef).replace(/[^a-z0-9]+/gi, '-').toLowerCase();
    downloadCSV(
      `hmrc-paye-statement-${name}-${from}-to-${to}.csv`,
      cols.map(([label]) => label),
      rows.map((r) => cols.map(([, get]) => get(r))),
    );
  };

  return (
    <div>
      <ErrorBar message={error} />

      <p style={{ fontSize: 13, color: '#64748b', maxWidth: 900, marginTop: 0, marginBottom: 12, lineHeight: 1.55 }}>
        One client's PAYE account. Months down the side; what HMRC charged, what relieved it, what was paid and
        what was left across the top. Set any date range — it crosses tax years, so a September or December year
        end works as well as 5 April.
      </p>

      {/* Client picker */}
      <div style={{ ...card, padding: '10px 12px', marginBottom: 14 }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 6 }}>
          <SearchInput
            value={search}
            onChange={setSearch}
            placeholder="Search client, HMRC name or PAYE ref…"
            style={{ minWidth: 300 }}
          />
          {selected && (
            <span style={{ fontSize: 12.5, color: '#0f172a' }}>
              <b>{selected.entity_name || selected.hmrc_name}</b>
              <span style={{ color: '#94a3b8', marginLeft: 6 }}>{selected.paye_ref}</span>
              <button
                onClick={() => selectClient('')}
                style={{ marginLeft: 8, fontSize: 11, color: '#b91c1c', background: 'none', border: 'none', cursor: 'pointer', fontFamily: font }}
              >
                change
              </button>
            </span>
          )}
        </div>
        <AlphabetFilter items={clients} nameKey="entity_name" selected={letter} onChange={setLetter} />
        {!payeRef && (
          <div style={{ maxHeight: 230, overflowY: 'auto', marginTop: 6, borderTop: '1px solid #f1f5f9' }}>
            {visibleClients.length === 0 && (
              <div style={{ fontSize: 12, color: '#94a3b8', padding: '10px 2px' }}>No clients match.</div>
            )}
            {visibleClients.map((c) => (
              <button
                key={c.paye_ref}
                onClick={() => selectClient(c.paye_ref)}
                style={{
                  display: 'flex', width: '100%', alignItems: 'center', gap: 8, textAlign: 'left',
                  padding: '6px 4px', background: 'none', border: 'none',
                  borderBottom: '1px solid #f8fafc', cursor: 'pointer', fontFamily: font, fontSize: 12.5,
                }}
              >
                <ChevronRight size={12} style={{ color: '#cbd5e1', flexShrink: 0 }} />
                <span style={{ fontWeight: 500, color: '#0f172a' }}>{c.entity_name || c.hmrc_name}</span>
                <span style={{ color: '#94a3b8', fontSize: 11 }}>{c.paye_ref}</span>
                <span style={{ flex: 1 }} />
                {n(c.total_debt) > 0 && (
                  <span style={{ color: '#b91c1c', fontWeight: 600, fontSize: 12 }}>{fmtGbpDetailed(c.total_debt)}</span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Period + options */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 14 }}>
        <label style={lbl}>From
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={{ ...inputStyle, width: 'auto', marginLeft: 6 }} />
        </label>
        <label style={lbl}>To
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} style={{ ...inputStyle, width: 'auto', marginLeft: 6 }} />
        </label>
        <Preset label="This tax year" onClick={() => { setFrom(taxYearStart()); setTo(iso(new Date())); }} />
        <Preset label="Last tax year" onClick={() => {
          const start = taxYearStart();
          setFrom(shiftYears(start, -1));
          setTo(shiftDays(start, -1));   // 5 April
        }} />
        {/* Only offered when we can resolve one — a button that silently does
            nothing is worse than no button. */}
        <Preset
          label={yearEnd?.year_end ? `Company year (to ${prettyDate(yearEnd.year_end)})` : 'Company year'}
          disabled={!yearEnd?.year_end}
          title={yearEnd?.year_end
            ? `${prettyDate(yearEnd.year_start)} to ${prettyDate(yearEnd.year_end)}, from BrightManager`
            : 'No year end found for this client in BrightManager'}
          onClick={() => { setFrom(yearEnd.year_start); setTo(yearEnd.year_end); }}
        />
        <Preset label="Last 12 months" onClick={() => {
          const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - 1);
          setFrom(iso(d)); setTo(iso(new Date()));
        }} />
        <Preset label="Everything" onClick={() => { setFrom('2015-04-06'); setTo('2099-04-05'); }} />

        <label style={{ ...lbl, marginLeft: 4 }}>
          <input type="checkbox" checked={showDetail} onChange={(e) => setShowDetail(e.target.checked)} style={{ marginRight: 5 }} />
          Charge / credit detail
        </label>

        <div style={{ flex: 1 }} />
        <button
          onClick={exportCsv}
          disabled={rows.length === 0}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 5, padding: '6px 12px',
            fontSize: 12, fontFamily: font, color: '#475569', background: '#fff',
            border: '1px solid #e5e7eb', borderRadius: 8,
            cursor: rows.length ? 'pointer' : 'default', opacity: rows.length ? 1 : 0.5,
          }}
        >
          <Download size={12} /> Export for Excel
        </button>
      </div>

      {anyDetailBroken && (
        <div style={{
          display: 'flex', gap: 9, alignItems: 'flex-start', background: '#fffbeb',
          border: '1px solid #fde68a', borderRadius: 10, padding: '9px 12px',
          marginBottom: 12, fontSize: 12.5, color: '#78350f', lineHeight: 1.5,
        }}>
          <TriangleAlert size={15} style={{ color: '#d97706', flexShrink: 0, marginTop: 1 }} />
          <div>
            On at least one month the line detail does not add up to HMRC's charge total. The
            <b> Charges</b> column is HMRC's figure and is the one to trust; the breakdown is incomplete there.
          </div>
        </div>
      )}

      {!payeRef ? (
        <div style={{ ...card, padding: 30, textAlign: 'center', color: '#94a3b8', fontSize: 13 }}>
          Pick a client above to see their PAYE account.
        </div>
      ) : loading ? (
        <div style={{ color: '#94a3b8', fontSize: 13, padding: 24 }}>Loading statement…</div>
      ) : rows.length === 0 ? (
        <div style={{ ...card, padding: 30, textAlign: 'center', color: '#94a3b8', fontSize: 13 }}>
          Nothing scraped for this client between {from} and {to}.
        </div>
      ) : (
        <div style={card}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', fontSize: 12.5, borderCollapse: 'collapse', whiteSpace: 'nowrap' }}>
              <thead>
                <tr style={headRow}>
                  <th style={th}>Period</th>
                  <th style={th}>Due</th>
                  <th style={thNum}>Opening</th>
                  {showDetail && usedCharge.map(([k, label]) => <th key={k} style={thNum}>{label}</th>)}
                  <th style={{ ...thNum, borderLeft: '1px solid #e5e7eb' }}>Charges</th>
                  {showDetail && usedCredit.map(([k, label]) => <th key={k} style={thNum}>{label}</th>)}
                  <th style={{ ...thNum, borderLeft: '1px solid #e5e7eb' }}>Credits</th>
                  <th style={thNum}>Payments</th>
                  <th style={{ ...thNum, borderLeft: '1px solid #e5e7eb' }}>Closing</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, idx) => {
                  const key = `${r.tax_year}-${r.tax_month}`;
                  const cols = 3 + (showDetail ? usedCharge.length + usedCredit.length : 0) + 4;
                  const open = drill && drill.key === key;
                  const cell = (kind, category) => ({
                    active: open && drill.kind === kind && drill.category === category,
                    onClick: () => setDrill(
                      open && drill.kind === kind && drill.category === category
                        ? null : { key, kind, category },
                    ),
                  });
                  return (
                    <React.Fragment key={key}>
                      <tr style={{ borderTop: '1px solid #f1f5f9', background: r.overdue ? '#fffbfa' : undefined }}>
                        <td style={td}>
                          <span style={{ fontWeight: 600, color: '#0f172a' }}>
                            {MONTH_NAMES[r.tax_month]} {String(r.period_start).slice(0, 4)}
                          </span>
                          <span style={{ fontSize: 10, color: '#94a3b8', marginLeft: 5 }}>
                            m{r.tax_month} · {r.tax_year}
                          </span>
                        </td>
                        <td style={{ ...td, fontSize: 11.5, color: '#64748b' }}>{r.due_date}</td>
                        <td style={tdNum}>
                          <DrillCell value={r.opening} colour="#64748b" {...cell('opening')}
                            hint="What was still owed going into this month — click for the months that make it up" />
                        </td>
                        {showDetail && usedCharge.map(([k, label]) => (
                          <td key={k} style={tdNum}>
                            <DrillCell value={r[k]} {...cell('charge', label)}
                              hint={`${label} charged this month — click for HMRC's own lines`} />
                          </td>
                        ))}
                        <td style={{ ...tdNum, borderLeft: '1px solid #f1f5f9' }}>
                          <DrillCell value={r.charges} bold {...cell('charges')}
                            hint="Everything HMRC charged this month — click for the breakdown" />
                        </td>
                        {showDetail && usedCredit.map(([k, label]) => (
                          <td key={k} style={tdNum}>
                            <DrillCell value={r[k]} colour="#059669" {...cell('credit', label)}
                              hint={`${label} — click for HMRC's own lines`} />
                          </td>
                        ))}
                        <td style={{ ...tdNum, borderLeft: '1px solid #f1f5f9' }}>
                          <DrillCell value={r.credits} colour="#059669" negate {...cell('credits')}
                            hint="Everything that relieved this month's charge — click for the breakdown" />
                        </td>
                        <td style={tdNum}>
                          <DrillCell value={r.payments} colour="#059669" negate {...cell('payments')}
                            hint="Click to see each payment, its date, and everything else the same payment was set against" />
                        </td>
                        <td style={{ ...tdNum, borderLeft: '1px solid #f1f5f9' }}>
                          <DrillCell value={r.closing} bold zeroDash={false}
                            colour={n(r.closing) > 0 ? '#b91c1c' : '#0f172a'} {...cell('closing')}
                            hint="Still owed at the end of this month — click for the months it is made of" />
                        </td>
                      </tr>
                      {open && (
                        <tr style={{ background: '#f8fafc' }}>
                          <td colSpan={cols} style={{ padding: '10px 14px' }}>
                            <DrillContent
                              row={r}
                              rows={rows}
                              idx={idx}
                              drill={drill}
                              lines={lines}
                              payments={payments}
                              onClose={() => setDrill(null)}
                            />
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
              <tfoot>
                <tr style={{ borderTop: '2px solid #e5e7eb', background: '#f8fafc', fontWeight: 700 }}>
                  <td style={td} colSpan={2}>Period total</td>
                  <td style={{ ...tdNum, color: '#64748b' }}>{fmtGbpDetailed(opening)}</td>
                  {showDetail && usedCharge.map(([k]) => (
                    <td key={k} style={tdNum}>
                      {fmtGbpDetailed(rows.reduce((s, r) => s + n(r[k]), 0))}
                    </td>
                  ))}
                  <td style={{ ...tdNum, borderLeft: '1px solid #e5e7eb' }}>{fmtGbpDetailed(totals.charges)}</td>
                  {showDetail && usedCredit.map(([k]) => (
                    <td key={k} style={{ ...tdNum, color: '#059669' }}>
                      {fmtGbpDetailed(rows.reduce((s, r) => s + n(r[k]), 0))}
                    </td>
                  ))}
                  <td style={{ ...tdNum, color: '#059669', borderLeft: '1px solid #e5e7eb' }}>-{fmtGbpDetailed(totals.credits)}</td>
                  <td style={{ ...tdNum, color: '#059669' }}>-{fmtGbpDetailed(totals.payments)}</td>
                  <td style={{ ...tdNum, borderLeft: '1px solid #e5e7eb', color: closing > 0 ? '#b91c1c' : '#0f172a' }}>
                    {fmtGbpDetailed(closing)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>

          {/* The statement's closing figure is the residue still unpaid TODAY.
              For a set of accounts you need what was open ON the date, and the
              difference is the money paid since. Puddleduck at 31 May 2026:
              £249.01 still unpaid today, but £8,061.54 paid after that date, so
              the creditor at the year end was £8,310.55 — 33x the figure the
              closing column shows. Stating closing as "the PAYE creditor" was
              wrong, so this replaces it with the worked proof. */}
          <BalanceProof proof={proof} to={to} unallocated={unallocated} />

          {unallocated.length > 0 && (
            <div style={{ padding: '8px 14px', borderTop: '1px solid #f1f5f9', fontSize: 12, color: '#78350f', background: '#fffbeb', whiteSpace: 'normal', lineHeight: 1.5 }}>
              {unallocated.length} payment{unallocated.length === 1 ? '' : 's'} totalling{' '}
              <b>{fmtGbpDetailed(unallocated.reduce((s, p) => s + n(p.amount), 0))}</b> are sitting unallocated
              on this scheme, reducing nothing — see the Payments tab.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// A figure on the statement that opens the rows behind it. Zero renders as a
// dash and stays inert — there is nothing under it to look at.
function DrillCell({ value, colour, bold, negate, active, onClick, hint, zeroDash = true }) {
  const v = n(value);
  if (v === 0 && zeroDash) return <span style={{ color: '#e2e8f0' }}>—</span>;
  const text = negate && v !== 0 ? `-${fmtGbpDetailed(v)}` : fmtGbpDetailed(v);
  return (
    <button
      onClick={onClick}
      title={hint || ''}
      style={{
        background: active ? '#e0edfb' : 'none', border: 'none',
        padding: active ? '1px 5px' : '1px 0', margin: 0, borderRadius: 4,
        cursor: 'pointer', fontFamily: font, fontSize: 12.5,
        fontWeight: bold ? 600 : 400,
        color: colour || '#0f172a',
        fontVariantNumeric: 'tabular-nums',
        textDecoration: 'underline', textDecorationStyle: 'dotted',
        textDecorationColor: '#cbd5e1',
      }}
    >
      {text}
    </button>
  );
}

// What sits under a clicked figure. Charges and credits resolve to HMRC's own
// charge lines; payments resolve to the whole bank payment, including the parts
// allocated to OTHER months — that one-to-many is why a payment on the client's
// bank statement rarely equals any single month's figure.
function DrillContent({ row, rows, idx, drill, lines, payments, onClose }) {
  const forMonth = lines.filter(
    (l) => l.tax_year === row.tax_year && l.tax_month === row.tax_month,
  );

  const header = (title, sub) => (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
      <span style={{ fontSize: 12.5, fontWeight: 600, color: '#0f172a' }}>{title}</span>
      {sub && <span style={{ fontSize: 11, color: '#94a3b8' }}>{sub}</span>}
      <button onClick={onClose} style={{
        marginLeft: 'auto', fontSize: 11, color: '#64748b', background: 'none',
        border: 'none', cursor: 'pointer', fontFamily: font,
      }}>close</button>
    </div>
  );

  const lineTable = (rowsIn) => (
    <table style={{ fontSize: 12, borderCollapse: 'collapse', minWidth: 460 }}>
      <thead>
        <tr style={{ color: '#94a3b8', fontSize: 10, textTransform: 'uppercase' }}>
          <th style={{ ...th, padding: '3px 12px 3px 0' }}>HMRC line</th>
          <th style={{ ...th, padding: '3px 12px' }}>Category</th>
          <th style={{ ...thNum, padding: '3px 0 3px 12px' }}>Amount</th>
        </tr>
      </thead>
      <tbody>
        {rowsIn.map((l) => (
          <tr key={l.id} style={{ borderTop: '1px solid #eef2f6' }}>
            <td style={{ padding: '3px 12px 3px 0', color: '#475569' }}>{l.line_type}</td>
            <td style={{ padding: '3px 12px', color: '#94a3b8' }}>{l.category}</td>
            <td style={{ padding: '3px 0 3px 12px', textAlign: 'right', fontVariantNumeric: 'tabular-nums',
                         color: l.kind === 'credit' ? '#059669' : '#0f172a' }}>
              {fmtGbpDetailed(l.amount)}
            </td>
          </tr>
        ))}
        <tr style={{ borderTop: '1px solid #cbd5e1', fontWeight: 600 }}>
          <td style={{ padding: '4px 12px 3px 0' }}>Total</td>
          <td />
          <td style={{ padding: '4px 0 3px 12px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
            {fmtGbpDetailed(rowsIn.reduce((s, l) => s + n(l.amount), 0))}
          </td>
        </tr>
      </tbody>
    </table>
  );

  const noDetail = (what) => (
    <div style={{ fontSize: 12, color: '#94a3b8' }}>
      HMRC gives no line detail for {what} in this month — only the monthly total shown above.
    </div>
  );

  if (drill.kind === 'charges' || drill.kind === 'charge') {
    const sel = drill.category
      ? forMonth.filter((l) => l.kind === 'charge' && l.category === drill.category)
      : forMonth.filter((l) => l.kind === 'charge');
    return (
      <>
        {header(
          drill.category ? `${drill.category} — ${MONTH_NAMES[row.tax_month]} ${row.tax_year}`
                         : `Charges — ${MONTH_NAMES[row.tax_month]} ${row.tax_year}`,
          `period ${row.period_start} to ${row.period_end}, due ${row.due_date}`,
        )}
        {sel.length ? lineTable(sel) : noDetail(drill.category || 'charges')}
      </>
    );
  }

  if (drill.kind === 'credits' || drill.kind === 'credit') {
    const sel = drill.category
      ? forMonth.filter((l) => l.kind === 'credit' && l.category === drill.category)
      : forMonth.filter((l) => l.kind === 'credit');
    return (
      <>
        {header(
          drill.category ? `${drill.category} — ${MONTH_NAMES[row.tax_month]} ${row.tax_year}`
                         : `Credits — ${MONTH_NAMES[row.tax_month]} ${row.tax_year}`,
          'what relieved this month’s charge',
        )}
        {sel.length ? lineTable(sel) : noDetail(drill.category || 'credits')}
      </>
    );
  }

  if (drill.kind === 'payments') {
    const mine = payments.filter(
      (p) => p.allocated_year === row.tax_year && p.allocated_month === row.tax_month,
    );
    // One bank payment can be split across several PAYE months. Show the whole
    // payment, marking which line belongs to the month you clicked, so the
    // figure can be tied to the client's bank statement.
    const dates = [...new Set(mine.map((p) => p.received_on_text))];
    const siblings = payments.filter((p) => dates.includes(p.received_on_text));
    if (mine.length === 0) {
      return (
        <>
          {header(`Payments — ${MONTH_NAMES[row.tax_month]} ${row.tax_year}`)}
          <div style={{ fontSize: 12, color: '#94a3b8' }}>
            HMRC shows {fmtGbpDetailed(row.payments)} against this month but no individual payment allocated
            to it — it was probably applied as part of a larger payment HMRC has not itemised here.
          </div>
        </>
      );
    }
    return (
      <>
        {header(
          `Payments received for ${MONTH_NAMES[row.tax_month]} ${row.tax_year}`,
          dates.length === 1
            ? `everything received on ${dates[0]}`
            : `everything received on ${dates.length} dates`,
        )}
        <table style={{ fontSize: 12, borderCollapse: 'collapse', minWidth: 520 }}>
          <thead>
            <tr style={{ color: '#94a3b8', fontSize: 10, textTransform: 'uppercase' }}>
              <th style={{ ...th, padding: '3px 12px 3px 0' }}>Received</th>
              <th style={{ ...th, padding: '3px 12px' }}>HMRC allocated it to</th>
              <th style={{ ...thNum, padding: '3px 0 3px 12px' }}>Amount</th>
            </tr>
          </thead>
          <tbody>
            {dates.map((d) => {
              const onDate = siblings.filter((p) => p.received_on_text === d);
              const total = onDate.reduce((s, p) => s + n(p.amount), 0);
              return (
                <React.Fragment key={d}>
                  {onDate.map((p) => {
                    const isThisMonth = p.allocated_year === row.tax_year
                      && p.allocated_month === row.tax_month;
                    return (
                      <tr key={p.id} style={{
                        borderTop: '1px solid #eef2f6',
                        background: isThisMonth ? '#eef7ff' : undefined,
                      }}>
                        <td style={{ padding: '3px 12px 3px 0', fontWeight: 500 }}>{p.received_on_text}</td>
                        <td style={{ padding: '3px 12px', color: '#475569' }}>
                          {p.unallocated
                            ? <span style={{ color: '#c2410c', fontWeight: 600 }}>Unallocated</span>
                            : p.allocated_to}
                          {isThisMonth && (
                            <span style={{ fontSize: 10, color: '#0e7fe0', fontWeight: 600, marginLeft: 6 }}>
                              this month
                            </span>
                          )}
                        </td>
                        <td style={{ padding: '3px 0 3px 12px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                          {fmtGbpDetailed(p.amount)}
                        </td>
                      </tr>
                    );
                  })}
                  {onDate.length > 1 && (
                    <tr style={{ fontWeight: 600 }}>
                      <td style={{ padding: '3px 12px 6px 0', color: '#64748b', fontSize: 11 }}>
                        Received on {d}
                      </td>
                      <td style={{ padding: '3px 12px 6px', color: '#94a3b8', fontSize: 11 }}>
                        {onDate.length} allocations
                      </td>
                      <td style={{ padding: '3px 0 6px 12px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                        {fmtGbpDetailed(total)}
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
        <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 6, maxWidth: 640, lineHeight: 1.5 }}>
          Rows without the blue mark are the same money set against other months. HMRC does not give us a
          reliable payment reference, so these are grouped by the date received — usually one bank payment,
          but two payments on the same day would appear together.
        </div>
      </>
    );
  }

  // Opening and closing: which months the balance is actually made of.
  const upto = drill.kind === 'closing' ? rows.slice(0, idx + 1) : rows.slice(0, idx);
  const contributing = upto.filter((x) => n(x.movement) !== 0);
  return (
    <>
      {header(
        drill.kind === 'closing'
          ? `Closing balance at ${row.period_end}`
          : `Opening balance at ${row.period_start}`,
        'the months inside this range that are still unpaid',
      )}
      {contributing.length === 0 ? (
        <div style={{ fontSize: 12, color: '#94a3b8' }}>
          Nothing in the range shown is unpaid. Any balance here was brought forward from before{' '}
          {rows[0]?.period_start} — widen the date range to see it.
        </div>
      ) : (
        <table style={{ fontSize: 12, borderCollapse: 'collapse', minWidth: 420 }}>
          <thead>
            <tr style={{ color: '#94a3b8', fontSize: 10, textTransform: 'uppercase' }}>
              <th style={{ ...th, padding: '3px 12px 3px 0' }}>Month</th>
              <th style={{ ...th, padding: '3px 12px' }}>Due</th>
              <th style={{ ...thNum, padding: '3px 0 3px 12px' }}>Still unpaid</th>
            </tr>
          </thead>
          <tbody>
            {contributing.map((x) => (
              <tr key={`${x.tax_year}-${x.tax_month}`} style={{ borderTop: '1px solid #eef2f6' }}>
                <td style={{ padding: '3px 12px 3px 0' }}>
                  {MONTH_NAMES[x.tax_month]} {String(x.period_start).slice(0, 4)}
                  <span style={{ color: '#94a3b8', marginLeft: 5 }}>m{x.tax_month} · {x.tax_year}</span>
                </td>
                <td style={{ padding: '3px 12px', color: '#64748b' }}>{x.due_date}</td>
                <td style={{ padding: '3px 0 3px 12px', textAlign: 'right', fontVariantNumeric: 'tabular-nums',
                             color: n(x.movement) > 0 ? '#b91c1c' : '#059669' }}>
                  {fmtGbpDetailed(x.movement)}
                </td>
              </tr>
            ))}
            <tr style={{ borderTop: '1px solid #cbd5e1', fontWeight: 600 }}>
              <td style={{ padding: '4px 12px 3px 0' }}>Total from the months shown</td>
              <td />
              <td style={{ padding: '4px 0 3px 12px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                {fmtGbpDetailed(contributing.reduce((s, x) => s + n(x.movement), 0))}
              </td>
            </tr>
          </tbody>
        </table>
      )}
    </>
  );
}

// The balance owed AT a date, shown as a working paper rather than a number.
// Every line is evidenced: net charges from HMRC's monthly figures, payments
// from its payment history with dates. The identity is
//   balance at date = still unpaid today + paid after the date
// which is what makes it arguable with a client or a reviewer.
function BalanceProof({ proof, to, unallocated }) {
  if (!proof) return null;
  const isMinimum = proof.basis === 'minimum';
  const paidAfter = n(proof.paid_after);

  return (
    <div style={{ borderTop: '1px solid #e5e7eb', padding: '12px 14px', background: '#f8fafc' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: '#0f172a' }}>
          Owed to HMRC at {prettyDate(to)}
        </span>
        <span style={{
          fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4,
          padding: '2px 7px', borderRadius: 999,
          color: isMinimum ? '#92400e' : '#166534',
          background: isMinimum ? '#fef3c7' : '#dcfce7',
          border: `1px solid ${isMinimum ? '#fcd34d' : '#86efac'}`,
        }}>
          {isMinimum ? 'Minimum' : 'Proven'}
        </span>
      </div>

      <table style={{ fontSize: 12.5, borderCollapse: 'collapse', minWidth: 420 }}>
        <tbody>
          {/* The derived opening balance — the plug that makes the walk tie to
              HMRC's own overdue figure. Zero for most clients, which is itself
              the evidence that starting from nothing is right for them. */}
          {n(proof.opening_balance) !== 0 && (
            <ProofRow
              label="Opening balance brought forward (derived)"
              value={proof.opening_balance}
              hint="The balancing figure needed to tie to HMRC's debt — charges before our data, or items outside the monthly grid"
            />
          )}
          <ProofRow label={`Charged to ${prettyDate(to)} — ${proof.periods_counted} tax months`} value={proof.charges} />
          <ProofRow label="Less credits" value={-n(proof.credits)} green />
          <ProofRow label="Net charged" value={proof.net_charged} rule />
          <ProofRow label="Less paid against those months (to date)" value={-n(proof.payments_ever_allocated)} green />
          <ProofRow label="Still unpaid today" value={proof.still_unpaid_today} rule />
          <ProofRow
            label={`Add back paid AFTER ${prettyDate(to)}${proof.paid_after_count ? ` — ${proof.paid_after_count} payment${proof.paid_after_count === 1 ? '' : 's'}` : ''}`}
            value={paidAfter}
            hint="Money that makes today's position look settled but was still outstanding on the date"
          />
          {/* Kept off the opening balance deliberately: HMRC writing a debt down
              under time-to-pay is a later adjustment, not pre-history. */}
          {n(proof.restatement) !== 0 && (
            <ProofRow
              label="HMRC restatement — time-to-pay arrangement"
              value={proof.restatement}
              green={n(proof.restatement) < 0}
              hint="HMRC has restated the debt under a payment plan while the monthly charges stay unpaid in the grid"
            />
          )}
          <tr style={{ borderTop: '2px solid #cbd5e1' }}>
            <td style={{ padding: '6px 14px 2px 0', fontWeight: 700, color: '#0f172a' }}>
              Owed at {prettyDate(to)}
            </td>
            <td style={{ padding: '6px 0 2px 14px', textAlign: 'right', fontWeight: 700, fontSize: 14,
                         color: n(proof.balance_at) > 0 ? '#b91c1c' : '#059669',
                         fontVariantNumeric: 'tabular-nums' }}>
              {fmtGbpDetailed(proof.balance_at)}
            </td>
          </tr>
        </tbody>
      </table>

      {/* Charged but not payable yet is never debt — HMRC's own figure counts
          only what is overdue. Practice-wide this was £100,623 sitting inside
          closing balances as though it were owed. */}
      {n(proof.not_yet_due) !== 0 && (
        <div style={{ fontSize: 11.5, color: '#0369a1', marginTop: 8, maxWidth: 720, lineHeight: 1.5 }}>
          A further <b>{fmtGbpDetailed(proof.not_yet_due)}</b> has been charged but is not yet due, so it is
          not part of this balance and HMRC does not count it as debt either.
        </div>
      )}

      {n(proof.balance_at) === n(proof.stated_debt_today) && (
        <div style={{ fontSize: 11.5, color: '#166534', marginTop: 6, maxWidth: 720, lineHeight: 1.5 }}>
          Ties to HMRC's own stated debt of {fmtGbpDetailed(proof.stated_debt_today)}.
        </div>
      )}

      <div style={{ fontSize: 11.5, color: isMinimum ? '#78350f' : '#64748b', marginTop: 8, maxWidth: 720, lineHeight: 1.5 }}>
        {isMinimum ? (
          <>
            <b>At least</b> this much was outstanding. HMRC only returns payment dates for the current tax
            year, so we hold none before {prettyDate(proof.earliest_payment_held)} — a payment made between{' '}
            {prettyDate(to)} and then is invisible to us, which can only make the real figure higher. Treat it
            as a floor, not a proven balance.
          </>
        ) : paidAfter > 0 ? (
          <>Proven from dated payment records. {fmtGbpDetailed(paidAfter)} of what looks settled today was
            actually paid after {prettyDate(to)}, so it belongs in the creditor at that date.</>
        ) : (
          <>Proven from dated payment records. Nothing has been paid since {prettyDate(to)} against those
            months, so today's position and the position then are the same.</>
        )}
      </div>
    </div>
  );
}

function ProofRow({ label, value, green, rule, hint }) {
  return (
    <tr style={rule ? { borderTop: '1px solid #cbd5e1' } : undefined}>
      <td style={{ padding: '3px 14px 3px 0', color: rule ? '#0f172a' : '#64748b', fontWeight: rule ? 600 : 400 }} title={hint || ''}>
        {label}
      </td>
      <td style={{
        padding: '3px 0 3px 14px', textAlign: 'right', fontVariantNumeric: 'tabular-nums',
        fontWeight: rule ? 600 : 400, color: green ? '#059669' : '#0f172a',
      }}>
        {fmtGbpDetailed(value)}
      </td>
    </tr>
  );
}

function Preset({ label, onClick, disabled, title }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title || ''}
      style={{
        padding: '5px 10px', fontSize: 11.5, fontFamily: font,
        color: disabled ? '#cbd5e1' : '#475569',
        background: '#fff', border: '1px solid #e5e7eb', borderRadius: 999,
        cursor: disabled ? 'default' : 'pointer',
      }}
    >
      {label}
    </button>
  );
}

const lbl = { fontSize: 12, color: '#64748b', fontFamily: font, display: 'inline-flex', alignItems: 'center' };
const headRow = {
  background: '#f8fafc', fontSize: 9.5, textTransform: 'uppercase',
  letterSpacing: 0.4, color: '#64748b',
};
