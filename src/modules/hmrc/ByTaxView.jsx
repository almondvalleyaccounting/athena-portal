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
// Aggregated in the browser from the per-tax detail views rather than three more
// SQL roll-ups. CT is 824 period rows and VAT 708 lines, so the whole thing is
// one request per tax, there is no second definition of "total owed" to drift from
// v_hmrc_client_tax_summary, and the per-client drill-down is a filter over rows
// already in memory rather than another round trip.

const n = (v) => Number(v || 0);

const TAXES = [
  { key: 'corporation-tax', label: 'Corporation Tax', colour: '#7c3aed' },
  { key: 'vat',             label: 'VAT',             colour: '#c2410c' },
  { key: 'self-assessment', label: 'Self Assessment', colour: '#0369a1' },
];

export default function ByTaxView({ tax = 'corporation-tax' }) {
  const navigate = useNavigate();
  const [openClient, setOpenClient] = useState(null);

  const [ct, setCt] = useState([]);
  const [vat, setVat] = useState([]);
  const [sa, setSa] = useState([]);
  // Self Assessment is the only head where the money moved and the balance owed
  // are separate datasets: sa_position is the balance, sa_transaction is what was
  // actually paid, repaid and transferred in.
  const [saTxn, setSaTxn] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [letter, setLetter] = useState(null);
  const [owingOnly, setOwingOnly] = useState(true);
  const [sort, setSort] = useState('total');

  useEffect(() => {
    Promise.all([
      supabase.from('v_hmrc_ct_periods').select('*').limit(5000),
      supabase.from('v_hmrc_vat_owed').select('*').limit(5000),
      supabase.from('v_hmrc_sa_position').select('*').limit(5000),
      // 1,333 rows after run-scoping. Raw hmrc.sa_transaction holds 3,999 across
      // three runs, which is why this reads the scoped view and not the table.
      supabase.from('v_hmrc_sa_transactions').select('*')
        .order('txn_date', { ascending: false, nullsFirst: false }).limit(5000),
    ])
      .then(([a, b, c, d]) => {
        const bad = [a, b, c, d].find((r) => r.error);
        if (bad) setError(bad.error.message);
        setCt(a.data || []); setVat(b.data || []); setSa(c.data || []);
        setSaTxn(d.data || []);
      })
      .catch((e) => setError(e.message || 'Could not load'))
      .finally(() => setLoading(false));
  }, []);

  // Roll the detail up to one row per client, per tax.
  const rows = useMemo(() => {
    const group = (src, keyOf, build) => {
      const m = new Map();
      for (const r of src) {
        // No entity means no client to rank. All 222 CT clients resolve today,
        // but HMRC truncates names and a future one could fall out — the excluded
        // total is reported below the table so it can never hide. It was £13,667
        // before the prefix fallback landed.
        if (!r.entity_id) continue;
        const k = keyOf(r);
        if (!m.has(k)) m.set(k, []);
        m.get(k).push(r);
      }
      return [...m.values()].map(build);
    };

    if (tax === 'corporation-tax') {
      return group(ct, (r) => r.entity_id, (rs) => ({
        entity_id: rs[0].entity_id,
        name: rs[0].hmrc_name,
        reference: rs[0].utr,
        periods: rs.length,
        unpaid_periods: rs.filter((r) => n(r.total) > 0).length,
        oldest_unpaid: rs.filter((r) => n(r.total) > 0)
          .map((r) => r.period_end).sort()[0] || null,
        tax_amount: rs.reduce((s, r) => s + n(r.tax), 0),
        interest: rs.reduce((s, r) => s + n(r.interest), 0),
        penalties: rs.reduce((s, r) => s + n(r.penalties), 0),
        paid: rs.reduce((s, r) => s + n(r.less_paid), 0),
        moved: rs.reduce((s, r) => s + n(r.repayments_reallocations), 0),
        total: rs.reduce((s, r) => s + n(r.total), 0),
        unreadable: rs.some((r) => r.unreadable),
      }));
    }
    if (tax === 'vat') {
      return group(vat, (r) => r.entity_id, (rs) => ({
        entity_id: rs[0].entity_id,
        name: rs[0].hmrc_name,
        reference: rs[0].vrn,
        lines: rs.length,
        overdue_lines: rs.filter((r) => r.overdue).length,
        assessed_lines: rs.filter((r) => r.estimated).length,
        oldest_unpaid: rs.filter((r) => n(r.amount) > 0)
          .map((r) => r.period_to).filter(Boolean).sort()[0] || null,
        assessed_value: rs.filter((r) => r.estimated).reduce((s, r) => s + n(r.amount), 0),
        total: rs.reduce((s, r) => s + n(r.amount), 0),
      }));
    }
    // SA carries the balance (sa_position) and the money movements
    // (sa_transaction) as two datasets, so the row is the balance plus what has
    // actually flowed either way.
    const money = new Map();
    for (const t of saTxn) {
      if (!t.entity_id) continue;
      const m = money.get(t.entity_id)
        || { paid: 0, repaid: 0, credit_in: 0, last_paid: null, txns: 0 };
      m.txns += 1;
      if (t.movement === 'paid_by_client') {
        m.paid += n(t.amount);
        // Rows arrive newest first, so the first payment seen is the latest.
        if (!m.last_paid) m.last_paid = t.txn_date;
      } else if (t.movement === 'cash_to_client') m.repaid += n(t.amount);
      else if (t.movement === 'from_another_tax') m.credit_in += n(t.amount);
      money.set(t.entity_id, m);
    }

    return sa.filter((r) => r.entity_id).map((r) => {
      const m = money.get(r.entity_id) || {};
      return {
        entity_id: r.entity_id,
        name: r.hmrc_name,
        reference: r.utr,
        tax_amount: n(r.tax),
        surcharges: n(r.surcharges),
        interest: n(r.interest),
        penalties: n(r.penalties),
        credit: n(r.available_for_repayment),
        as_at: r.as_at,
        no_statement: r.statement_available === false,
        total: n(r.amount_due),
        paid: n(m.paid),
        repaid: n(m.repaid),
        credit_in: n(m.credit_in),
        last_paid: m.last_paid || null,
        txns: m.txns || 0,
      };
    });
  }, [tax, ct, vat, sa, saTxn]);

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

  // The drill-down reads the rows already fetched for the table, so opening a
  // client costs nothing.
  const detailFor = (id) => (tax === 'corporation-tax' ? ct : tax === 'vat' ? vat : sa)
    .filter((d) => d.entity_id === id);

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
    const src = tax === 'corporation-tax' ? ct : tax === 'vat' ? vat : sa;
    const rowsOut = src.filter((r) => !r.entity_id);
    const amountOf = (r) => (tax === 'vat' ? n(r.amount)
      : tax === 'self-assessment' ? n(r.amount_due) : n(r.total));
    return {
      rows: rowsOut.length,
      names: [...new Set(rowsOut.map((r) => r.hmrc_name).filter(Boolean))],
      total: rowsOut.reduce((s, r) => s + amountOf(r), 0),
    };
  }, [tax, ct, vat, sa]);

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
                        <button onClick={() => setOpenClient(openClient === r.entity_id ? null : r.entity_id)}
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
                        <ClientDetail tax={tax} colour={meta.colour} rows={detailFor(r.entity_id)}
                                      txns={tax === 'self-assessment'
                                        ? saTxn.filter((t) => t.entity_id === r.entity_id) : []}
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
function ClientDetail({ tax, colour, rows, txns = [], name, onClose, onFullPosition }) {
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
