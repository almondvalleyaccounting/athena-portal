import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Download, ChevronRight, TriangleAlert } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { fmtGbp, fmtGbpDetailed } from '../../lib/money';
import { downloadCSV } from '../../lib/exportUtils';
import SearchInput from '../../components/SearchInput';
import AlphabetFilter, { firstCharBucket } from '../../components/AlphabetFilter';
import { font, Pill, Stat, ErrorBar, shortDate, th, thNum, td, tdNum, card } from './hmrcShared';

// One tax head, on its own tab.
//
// The list ranks clients so you can see where the money is, but the point of this
// module is a SPECIFIC CLIENT: click a row and their own detail for this tax opens
// underneath — the CT periods, the VAT lines, the SA make-up — without leaving the
// tax you are working in. The consolidated picture across all four heads lives on
// the All taxes and Client tabs.
//
// PAYE has its own tab because it carries triage — chase tier, status, notes —
// which these three do not.
//
// The ranking reads one aggregated row per client (sql/222) and the drill-down
// fetches that client's detail on demand. Both are bounded: an earlier version
// pulled every detail row and rolled it up here, which the API silently truncated
// once Corporation Tax passed ~1000 rows, under-reporting the book by £127,377.

const n = (v) => Number(v || 0);

const TAXES = [
  { key: 'corporation-tax', label: 'Corporation Tax', colour: '#7c3aed' },
  { key: 'vat',             label: 'VAT',             colour: '#c2410c' },
  { key: 'self-assessment', label: 'Self Assessment', colour: '#0369a1' },
];

export default function ByTaxView({ tax = 'corporation-tax' }) {
  const navigate = useNavigate();
  const [openClient, setOpenClient] = useState(null);

  // One row per client, aggregated in SQL. It used to fetch every detail row and
  // roll them up here with .limit(5000) — but PostgREST caps rows (~1000) and
  // truncates SILENTLY. That passed review when Corporation Tax had 824 period
  // rows; a later scrape took it to 1,876 and the table quietly reported £351,234
  // owed against a true £478,611. Detail now loads per client on drill-down, so
  // no screen depends on an unbounded fetch. See sql/222.
  const [rows, setRows] = useState([]);
  const [detail, setDetail] = useState({ id: null, rows: [], txns: [], loading: false });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [letter, setLetter] = useState(null);
  const [owingOnly, setOwingOnly] = useState(true);
  const [sort, setSort] = useState('total');

  const VIEW = {
    'corporation-tax': 'v_hmrc_ct_by_client',
    'vat': 'v_hmrc_vat_by_client',
    'self-assessment': 'v_hmrc_sa_by_client',
  }[tax];

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setOpenClient(null);
    setDetail({ id: null, rows: [], txns: [], loading: false });
    supabase.from(VIEW).select('*').limit(2000)
      .then(({ data, error: e }) => {
        if (cancelled) return;
        if (e) setError(e.message); else setError('');
        setRows(data || []);
      })
      .then(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [VIEW]);

  // Detail for the client being opened, fetched on demand and filtered server
  // side, so it stays small however much history a client has.
  const open = (id) => {
    if (openClient === id) { setOpenClient(null); return; }
    setOpenClient(id);
    if (!id) return;
    setDetail({ id, rows: [], txns: [], loading: true });
    const detailView = tax === 'corporation-tax' ? 'v_hmrc_ct_periods'
      : tax === 'vat' ? 'v_hmrc_vat_owed' : 'v_hmrc_sa_position';
    const order = tax === 'corporation-tax' ? 'period_end'
      : tax === 'vat' ? 'period_to' : 'as_at';
    Promise.all([
      supabase.from(detailView).select('*').eq('entity_id', id)
        .order(order, { ascending: false, nullsFirst: false }).limit(2000),
      tax === 'self-assessment'
        ? supabase.from('v_hmrc_sa_transactions').select('*').eq('entity_id', id)
            .order('txn_date', { ascending: false, nullsFirst: false }).limit(2000)
        : Promise.resolve({ data: [] }),
    ]).then(([d, t]) => {
      setDetail({ id, rows: d.data || [], txns: t.data || [], loading: false });
    }).catch(() => setDetail({ id, rows: [], txns: [], loading: false }));
  };

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const out = rows.filter((r) => {
      const name = r.name || '';
      if (letter && letter !== 'All' && firstCharBucket(name) !== letter) return false;
      if (owingOnly && n(r.total) <= 0 && n(r.credit) <= 0) return false;
      if (q && !`${name} ${r.reference || ''}`.toLowerCase().includes(q)) return false;
      return true;
    });
    return sort === 'name'
      ? [...out].sort((a, b) => (a.name || '').localeCompare(b.name || ''))
      : [...out].sort((a, b) => n(b[sort]) - n(a[sort]));
  }, [rows, search, letter, owingOnly, sort]);

  const sum = (k, set = filtered) => set.reduce((s, r) => s + n(r[k]), 0);
  const meta = TAXES.find((t) => t.key === tax);

  // The headline totals what is SHOWN, which is right for a ranking but means the
  // default filter quietly drops clients in credit — and a credit is still part of
  // the book. On Corporation Tax that is 29 clients holding £31,578: the filtered
  // headline reads £510,124 while the practice position is £478,546. Two different
  // numbers for the same words, one of them contradicting the All taxes tab.
  // So whenever the filter is hiding credits, say so and give the net.
  const credits = useMemo(() => {
    const held = rows.filter((r) => n(r.total) < 0);
    return {
      clients: held.length,
      value: held.reduce((s, r) => s + n(r.total), 0),
      net: rows.reduce((s, r) => s + n(r.total), 0),
      all: rows.length,
    };
  }, [rows]);
  const creditsHidden = owingOnly && credits.clients > 0;

  // Rows the scrape returned but that carry no Athena client, so cannot be ranked.
  const orphaned = useMemo(() => {
    const out = rows.filter((r) => !r.entity_id);
    return {
      rows: out.length,
      names: [...new Set(out.map((r) => r.name).filter(Boolean))],
      total: out.reduce((s, r) => s + n(r.total), 0),
    };
  }, [rows]);

  const COLUMNS = {
    'corporation-tax': [
      ['Periods',        (r) => `${r.unpaid_periods}/${r.periods}`, 'c'],
      ['Oldest unpaid',  (r) => shortDate(r.oldest_unpaid), 'c'],
      ['Tax',            (r) => r.tax_amount, 'n'],
      ['Interest',       (r) => r.interest, 'n'],
      ['Penalties',      (r) => r.penalties, 'n'],
      ['Paid',           (r) => r.paid, 'n'],
      ['Repaid/realloc', (r) => r.moved, 'n'],
    ],
    'vat': [
      ['Lines',         (r) => r.lines, 'c'],
      ['Overdue',       (r) => r.overdue_lines || '—', 'c'],
      ['Assessed',      (r) => r.assessed_lines || '—', 'c'],
      ['Assessed value',(r) => r.assessed_value, 'n'],
      ['Oldest unpaid', (r) => shortDate(r.oldest_unpaid), 'c'],
    ],
    'self-assessment': [
      ['Tax',        (r) => r.tax_amount, 'n'],
      ['Surcharges', (r) => r.surcharges, 'n'],
      ['Interest',   (r) => r.interest, 'n'],
      ['Penalties',  (r) => r.penalties, 'n'],
      ['Credit held',(r) => r.credit, 'n'],
      // What actually moved, as against what is owed.
      ['Paid',       (r) => r.paid, 'n'],
      ['Repaid out', (r) => r.repaid, 'n'],
      ['Credit in',  (r) => r.credit_in, 'n'],
      ['Last paid',  (r) => shortDate(r.last_paid), 'c'],
      ['As at',      (r) => shortDate(r.as_at), 'c'],
    ],
  }[tax];

  const exportCsv = () => {
    downloadCSV(
      `hmrc-${tax}-${new Date().toISOString().slice(0, 10)}.csv`,
      ['Client', 'Reference', ...COLUMNS.map(([l]) => l), 'Total owed'],
      filtered.map((r) => [
        r.name || '', r.reference || '',
        ...COLUMNS.map(([, get, kind]) => {
          const v = get(r);
          return kind === 'n' ? n(v).toFixed(2) : String(v ?? '');
        }),
        n(r.total).toFixed(2),
      ]),
    );
  };

  return (
    <div>
      <ErrorBar message={error} />

      <p style={{ fontSize: 13, color: '#64748b', maxWidth: 900, marginTop: 0, marginBottom: 12, lineHeight: 1.55 }}>
        {meta.label} for every client, ranked. <b>Click a client</b> to open their own {meta.label} detail
        underneath — the arrow goes to their full position across all four taxes.
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 14, maxWidth: 820 }}>
        <Stat label={`${meta.label} owed`} value={fmtGbp(sum('total'))} colour="#b91c1c" big
              hint={`${filtered.length} clients shown`} />
        <Stat label="Clients with a balance" value={filtered.filter((r) => n(r.total) > 0).length} colour="#c2410c" />
        {tax === 'corporation-tax' && (
          <>
            <Stat label="Interest" value={fmtGbp(sum('interest'))} colour="#c2410c" />
            <Stat label="Repaid / reallocated" value={fmtGbp(sum('moved'))} colour="#7c3aed"
                  hint="Money HMRC has repaid or moved between periods and taxes" />
          </>
        )}
        {tax === 'vat' && (
          <>
            <Stat label="Assessed, not filed" value={fmtGbp(sum('assessed_value'))} colour="#c2410c"
                  hint="HMRC has estimated the liability because no return was filed — a different problem from late payment" />
            <Stat label="Overdue lines" value={filtered.reduce((s, r) => s + (r.overdue_lines || 0), 0)} colour="#b91c1c" />
          </>
        )}
        {tax === 'self-assessment' && (
          <>
            <Stat label="Credit HMRC holds" value={fmtGbp(sum('credit'))} colour="#0369a1"
                  hint="Available for repayment or reallocation to another tax" />
            <Stat label="Repaid out" value={fmtGbp(sum('repaid'))} colour="#059669"
                  hint="Cash HMRC has sent back to these clients — bank, card or cheque repayment" />
          </>
        )}
      </div>

      {creditsHidden && (
        <div style={{
          fontSize: 12, color: '#0369a1', background: '#f0f9ff', border: '1px solid #bae6fd',
          borderRadius: 6, padding: '7px 10px', marginBottom: 12, maxWidth: 820, lineHeight: 1.55,
        }}>
          The headline totals the clients shown. {credits.clients} other client{credits.clients === 1 ? '' : 's'}
          {' '}hold {fmtGbpDetailed(Math.abs(credits.value))} of credit, hidden by the filter. Net across all
          {' '}{credits.all}: <b>{fmtGbpDetailed(credits.net)}</b> — the figure on the All taxes tab. Untick
          {' '}<i>with a balance only</i> to reconcile the two.
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, marginBottom: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        <SearchInput value={search} onChange={setSearch} placeholder="Client or reference…" style={{ minWidth: 240 }} />
        <label style={{ fontSize: 12, color: '#64748b', fontFamily: font, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <input type="checkbox" checked={owingOnly} onChange={(e) => setOwingOnly(e.target.checked)} />
          With a balance only
        </label>
        <div style={{ flex: 1 }} />
        <select value={sort} onChange={(e) => setSort(e.target.value)}
                style={{ padding: '5px 8px', fontSize: 12, fontFamily: font, border: '1px solid #e5e7eb', borderRadius: 6, background: '#fff' }}>
          <option value="total">Sort: total owed</option>
          {tax === 'corporation-tax' && <option value="interest">Sort: interest</option>}
          {tax === 'corporation-tax' && <option value="moved">Sort: repaid / reallocated</option>}
          {tax === 'vat' && <option value="assessed_value">Sort: assessed value</option>}
          {tax === 'self-assessment' && <option value="credit">Sort: credit held</option>}
          {tax === 'self-assessment' && <option value="paid">Sort: paid to HMRC</option>}
          {tax === 'self-assessment' && <option value="repaid">Sort: repaid out</option>}
          {tax === 'self-assessment' && <option value="credit_in">Sort: credit in from another tax</option>}
          <option value="name">Sort: name</option>
        </select>
        <button onClick={exportCsv} disabled={filtered.length === 0}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 5, padding: '6px 12px',
            fontSize: 12, fontFamily: font, color: '#475569', background: '#fff',
            border: '1px solid #e5e7eb', borderRadius: 8,
            cursor: filtered.length ? 'pointer' : 'default', opacity: filtered.length ? 1 : 0.5,
          }}>
          <Download size={12} /> Export for Excel
        </button>
      </div>

      <AlphabetFilter items={rows} nameKey="name" selected={letter} onChange={setLetter} />

      {loading ? (
        <div style={{ color: '#94a3b8', fontSize: 13, padding: 24 }}>Loading {meta.label}…</div>
      ) : (
        <div style={{ ...card, marginTop: 8 }}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', fontSize: 12.5, borderCollapse: 'collapse', whiteSpace: 'nowrap' }}>
              <thead>
                <tr style={{ background: '#f8fafc', fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.4, color: '#64748b' }}>
                  <th style={th}>Client</th>
                  <th style={th}>Reference</th>
                  {COLUMNS.map(([label, , kind]) => (
                    <th key={label} style={kind === 'n' ? thNum : { ...th, textAlign: 'center' }}>{label}</th>
                  ))}
                  <th style={{ ...thNum, borderLeft: '1px solid #e5e7eb' }}>Total owed</th>
                  <th style={th} />
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 && (
                  <tr><td colSpan={COLUMNS.length + 4} style={{ padding: 30, textAlign: 'center', color: '#94a3b8' }}>
                    No clients match.
                  </td></tr>
                )}
                {filtered.map((r) => (
                  <React.Fragment key={r.entity_id}>
                  <tr style={{ borderTop: '1px solid #f1f5f9' }}>
                    <td style={td}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        {r.unreadable && (
                          <TriangleAlert size={12} style={{ color: '#b45309', flexShrink: 0 }}
                            title="At least one period could not be parsed — treat its figures as unknown, not zero" />
                        )}
                        {/* Opens this client's detail for THIS tax in place. The
                            chevron is the way out to their whole position. */}
                        <button onClick={() => open(r.entity_id)}
                          title={`Show this client's ${meta.label} detail`}
                          style={{
                            background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                            fontFamily: font, fontSize: 12.5, fontWeight: openClient === r.entity_id ? 700 : 500,
                            color: openClient === r.entity_id ? meta.colour : '#0f172a', textAlign: 'left',
                          }}>
                          {r.name}
                        </button>
                        {r.no_statement && (
                          <Pill colour="#b45309" style={{ fontSize: 10 }}
                            title="HMRC would not show the statement, so a zero here is unknown rather than nil">
                            No statement
                          </Pill>
                        )}
                      </div>
                    </td>
                    <td style={{ ...td, fontSize: 11.5, color: '#64748b' }}>{r.reference}</td>
                    {COLUMNS.map(([label, get, kind]) => {
                      const v = get(r);
                      return kind === 'n' ? (
                        <td key={label} style={{ ...tdNum, color: n(v) ? '#0f172a' : '#e2e8f0' }}>
                          {n(v) ? fmtGbpDetailed(v) : '—'}
                        </td>
                      ) : (
                        <td key={label} style={{ ...td, textAlign: 'center', fontSize: 11.5, color: '#64748b' }}>
                          {v ?? '—'}
                        </td>
                      );
                    })}
                    <td style={{ ...tdNum, fontWeight: 700, borderLeft: '1px solid #f1f5f9',
                                 color: n(r.total) > 0 ? '#b91c1c' : n(r.total) < 0 ? '#059669' : '#0f172a' }}>
                      {fmtGbpDetailed(r.total)}
                    </td>
                    <td style={td}>
                      <button onClick={() => navigate(`/hmrc/client?entity=${r.entity_id}`)}
                        title="Open this client's full HMRC position"
                        style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#cbd5e1', padding: 0, lineHeight: 0 }}>
                        <ChevronRight size={14} />
                      </button>
                    </td>
                  </tr>
                  {openClient === r.entity_id && (
                    <tr>
                      <td colSpan={COLUMNS.length + 4} style={{ padding: 0, background: '#f8fafc',
                                                                borderTop: `2px solid ${meta.colour}` }}>
                        <ClientDetail tax={tax} colour={meta.colour}
                                      rows={detail.id === r.entity_id ? detail.rows : []}
                                      txns={detail.id === r.entity_id ? detail.txns : []}
                                      loading={detail.id === r.entity_id && detail.loading}
                                      name={r.name} onClose={() => setOpenClient(null)}
                                      onFullPosition={() => navigate(`/hmrc/client?entity=${r.entity_id}`)} />
                      </td>
                    </tr>
                  )}
                  </React.Fragment>
                ))}
              </tbody>
              {filtered.length > 0 && (
                <tfoot>
                  <tr style={{ borderTop: '2px solid #e5e7eb', background: '#f8fafc', fontWeight: 700 }}>
                    <td style={td} colSpan={2}>{filtered.length} clients</td>
                    {COLUMNS.map(([label, get, kind]) => (
                      <td key={label} style={kind === 'n' ? tdNum : { ...td, textAlign: 'center' }}>
                        {kind === 'n' ? fmtGbpDetailed(filtered.reduce((s, r) => s + n(get(r)), 0)) : ''}
                      </td>
                    ))}
                    <td style={{ ...tdNum, borderLeft: '1px solid #e5e7eb', color: '#b91c1c' }}>
                      {fmtGbpDetailed(sum('total'))}
                    </td>
                    <td />
                  </tr>
                </tfoot>
              )}
            </table>
          </div>

          {orphaned.rows > 0 && (
            <div style={{
              borderTop: '1px solid #fde68a', background: '#fffbeb', padding: '9px 14px',
              fontSize: 12, color: '#78350f', lineHeight: 1.5, whiteSpace: 'normal',
            }}>
              <b>{fmtGbpDetailed(orphaned.total)}</b> is excluded from this table:{' '}
              {orphaned.names.length} HMRC record{orphaned.names.length === 1 ? '' : 's'} could not be matched
              to an Athena client, so there is nobody to rank them against
              {orphaned.names.length <= 4 && <> — {orphaned.names.join(', ')}</>}.
              Usually HMRC has truncated the name; fix it on the Reconciliation tab.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// One client's own detail for the tax being viewed, opened in place under their
// row. Deliberately the same figures as the Client tab shows for this head — the
// difference is you get here without losing the ranking you were reading.
function ClientDetail({ tax, colour, rows, txns = [], loading, name, onClose, onFullPosition }) {
  if (loading) {
    return (
      <div style={{ padding: '12px 16px', fontSize: 12, color: '#94a3b8', fontFamily: font }}>
        Loading {name}…
      </div>
    );
  }
  // A client can have no statement but still have a payment history, so an empty
  // position must not hide the ledger.
  if (rows.length === 0 && txns.length === 0) {
    return (
      <div style={{ padding: '12px 16px', fontSize: 12, color: '#94a3b8', fontFamily: font, whiteSpace: 'normal' }}>
        Nothing scraped for {name} on this tax.
      </div>
    );
  }

  return (
    <div style={{ padding: '11px 14px', fontFamily: font, whiteSpace: 'normal' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: colour }}>{name}</span>
        <span style={{ fontSize: 11, color: '#94a3b8' }}>
          {rows.length} {tax === 'corporation-tax' ? 'period' : tax === 'vat' ? 'line' : 'row'}{rows.length === 1 ? '' : 's'}
        </span>
        <div style={{ flex: 1 }} />
        <button onClick={onFullPosition}
          style={{ fontSize: 11, fontWeight: 600, color: '#0e7fe0', background: 'none', border: 'none', cursor: 'pointer', fontFamily: font }}>
          All four taxes for this client →
        </button>
        <button onClick={onClose}
          style={{ fontSize: 11, color: '#94a3b8', background: 'none', border: 'none', cursor: 'pointer', fontFamily: font }}>
          close
        </button>
      </div>

      {rows.length > 0 && (
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', fontSize: 11.5, borderCollapse: 'collapse', whiteSpace: 'nowrap', background: '#fff' }}>
          <thead>
            <tr style={{ background: '#f1f5f9', fontSize: 9.5, textTransform: 'uppercase', letterSpacing: 0.4, color: '#64748b' }}>
              {DETAIL_COLUMNS[tax].map(([label, , kind]) => (
                <th key={label} style={kind === 'n' ? thNum : th}>{label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((d, i) => (
              <tr key={i} style={{ borderTop: '1px solid #f8fafc' }}>
                {DETAIL_COLUMNS[tax].map(([label, get, kind]) => {
                  const v = get(d);
                  return kind === 'n' ? (
                    <td key={label} style={{ ...tdNum, color: n(v) ? '#0f172a' : '#e2e8f0' }}>
                      {n(v) ? fmtGbpDetailed(v) : '—'}
                    </td>
                  ) : (
                    <td key={label} style={{ ...td, fontSize: 11, color: '#475569' }}>{v ?? '—'}</td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      )}

      {txns.length > 0 && <SaLedger txns={txns} />}
    </div>
  );
}

// Self Assessment payments and credits for one client.
//
// The point of separating cash from credit: HMRC's account shows a "Payment"
// (money that left the client's bank) next to an "Overpayment from return" (a
// credit that arose from the return itself) and a "Repayment supplement"
// (interest HMRC adds). Adding them together would overstate what the client has
// actually paid — which is exactly what the money ledger did until sql/221.
//
// "Credit in from another tax" is the row to look for on a CIS case: credit built
// up on PAYE, moved across to settle Self Assessment.
function SaLedger({ txns }) {
  const total = (m) => txns.filter((t) => t.movement === m)
    .reduce((s, t) => s + n(t.amount), 0);

  const paid = total('paid_by_client');
  const repaid = total('cash_to_client');
  const creditIn = total('from_another_tax');
  const credits = txns.filter((t) => t.movement === 'other')
    .reduce((s, t) => s + n(t.amount), 0);

  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 7, fontSize: 11.5 }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: '#0f172a', textTransform: 'uppercase', letterSpacing: 0.4 }}>
          Payments &amp; credits
        </span>
        <span style={{ color: '#64748b' }}>{txns.length} movement{txns.length === 1 ? '' : 's'}</span>
        <span>Paid <b style={{ color: '#0f172a' }}>{fmtGbpDetailed(paid)}</b></span>
        {repaid > 0 && <span>Repaid out <b style={{ color: '#059669' }}>{fmtGbpDetailed(repaid)}</b></span>}
        {creditIn > 0 && (
          <span>Credit in from another tax <b style={{ color: '#7c3aed' }}>{fmtGbpDetailed(creditIn)}</b></span>
        )}
        {credits > 0 && <span style={{ color: '#64748b' }}>Non-cash credits {fmtGbpDetailed(credits)}</span>}
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', fontSize: 11.5, borderCollapse: 'collapse', whiteSpace: 'nowrap', background: '#fff' }}>
          <thead>
            <tr style={{ background: '#f1f5f9', fontSize: 9.5, textTransform: 'uppercase', letterSpacing: 0.4, color: '#64748b' }}>
              <th style={th}>Date</th>
              <th style={th}>What</th>
              <th style={th}>Year</th>
              <th style={th}>HMRC description</th>
              <th style={thNum}>Amount</th>
            </tr>
          </thead>
          <tbody>
            {txns.map((t, i) => {
              const m = SA_MOVEMENT[t.movement] || SA_MOVEMENT.other;
              return (
                <tr key={i} style={{ borderTop: '1px solid #f8fafc' }}>
                  <td style={{ ...td, fontSize: 11, color: '#475569' }}>{shortDate(t.txn_date)}</td>
                  <td style={td}>
                    <Pill colour={m.colour} bg={m.bg} style={{ fontSize: 9.5 }} title={m.hint}>{t.label}</Pill>
                  </td>
                  <td style={{ ...td, fontSize: 11, color: '#94a3b8' }}>{t.tax_year_ending || '—'}</td>
                  <td style={{ ...td, fontSize: 11, color: '#64748b', whiteSpace: 'normal', maxWidth: 420 }}>
                    {t.description}
                  </td>
                  <td style={{ ...tdNum, color: m.colour, fontWeight: 600 }}>
                    {/* Signed so the direction reads at a glance: out to the client
                        is money leaving HMRC's account. */}
                    {t.movement === 'cash_to_client' ? '−' : ''}{fmtGbpDetailed(t.amount)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const SA_MOVEMENT = {
  paid_by_client:   { colour: '#0f172a', bg: '#f8fafc', hint: 'Money the client actually paid HMRC' },
  cash_to_client:   { colour: '#059669', bg: '#f0fdf4', hint: 'HMRC repaid this to the client' },
  from_another_tax: { colour: '#7c3aed', bg: '#faf5ff', hint: 'Credit moved across from another tax — the CIS pattern' },
  other:            { colour: '#64748b', bg: '#f8fafc', hint: 'A credit on the account rather than cash paid' },
};

// What each tax's detail rows are made of. 'n' is money and right-aligns.
const DETAIL_COLUMNS = {
  'corporation-tax': [
    ['Period end', (d) => shortDate(d.period_end)],
    ['Status', (d) => d.status],
    ['Tax', (d) => d.tax, 'n'],
    ['Interest', (d) => d.interest, 'n'],
    ['Penalties', (d) => d.penalties, 'n'],
    ['Paid', (d) => d.less_paid, 'n'],
    ['Repaid / realloc', (d) => d.repayments_reallocations, 'n'],
    ['Outstanding', (d) => d.total, 'n'],
  ],
  'vat': [
    ['Description', (d) => d.description],
    ['Kind', (d) => d.kind],
    ['Period', (d) => (d.period_from || d.period_to
      ? `${shortDate(d.period_from)} – ${shortDate(d.period_to)}` : null)],
    // Two different problems: late payment, versus HMRC estimating because no
    // return was filed. Worth seeing per line, not just in the header total.
    ['Flags', (d) => [d.overdue ? 'overdue' : null, d.estimated ? 'assessed' : null]
      .filter(Boolean).join(' · ') || null],
    ['Amount', (d) => d.amount, 'n'],
  ],
  'self-assessment': [
    ['As at', (d) => shortDate(d.as_at)],
    ['Tax', (d) => d.tax, 'n'],
    ['Surcharges', (d) => d.surcharges, 'n'],
    ['Interest', (d) => d.interest, 'n'],
    ['Penalties', (d) => d.penalties, 'n'],
    ['Credit held', (d) => d.available_for_repayment, 'n'],
    ['Due', (d) => d.amount_due, 'n'],
  ],
};
