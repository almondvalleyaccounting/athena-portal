import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Download, ChevronRight, TriangleAlert } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { fmtGbp, fmtGbpDetailed } from '../../lib/money';
import { downloadCSV } from '../../lib/exportUtils';
import SearchInput from '../../components/SearchInput';
import AlphabetFilter, { firstCharBucket } from '../../components/AlphabetFilter';
import { font, Pill, Stat, Chip, ErrorBar, shortDate, th, thNum, td, tdNum, card } from './hmrcShared';

// Practice-wide league table for one tax head at a time.
//
// PAYE has its own tab because it carries triage — chase tier, status, notes —
// which the other heads do not. These three are read-only rankings: who owes the
// most, and what it is made of.
//
// Aggregated in the browser from the per-tax detail views rather than three more
// SQL roll-ups. CT is 824 period rows and VAT 708 lines, so the whole thing is
// one request per tax, and there is no second definition of "total owed" to drift
// from v_hmrc_client_tax_summary.

const n = (v) => Number(v || 0);

const TAXES = [
  { key: 'corporation-tax', label: 'Corporation Tax', colour: '#7c3aed' },
  { key: 'vat',             label: 'VAT',             colour: '#c2410c' },
  { key: 'self-assessment', label: 'Self Assessment', colour: '#0369a1' },
];

export default function ByTaxView() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const tax = TAXES.some((t) => t.key === params.get('tax')) ? params.get('tax') : 'corporation-tax';

  const [ct, setCt] = useState([]);
  const [vat, setVat] = useState([]);
  const [sa, setSa] = useState([]);
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
    ])
      .then(([a, b, c]) => {
        const bad = [a, b, c].find((r) => r.error);
        if (bad) setError(bad.error.message);
        setCt(a.data || []); setVat(b.data || []); setSa(c.data || []);
      })
      .catch((e) => setError(e.message || 'Could not load'))
      .finally(() => setLoading(false));
  }, []);

  const setTax = (key) => {
    const next = new URLSearchParams(params);
    next.set('tax', key);
    setParams(next, { replace: true });
    setSort('total');
  };

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
    return sa.filter((r) => r.entity_id).map((r) => ({
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
    }));
  }, [tax, ct, vat, sa]);

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
        One tax head at a time, ranked. PAYE has its own tab because it carries the chase status and notes;
        these three are the rankings and what each balance is made of. Click a client for their full position
        across everything.
      </p>

      <div style={{ display: 'flex', gap: 6, marginBottom: 14, flexWrap: 'wrap' }}>
        {TAXES.map((t) => (
          <Chip key={t.key} value={t.key} label={t.label} active={tax} onClick={setTax} colour={t.colour} />
        ))}
      </div>

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
            <Stat label="Penalties" value={fmtGbp(sum('penalties'))} colour="#b91c1c" />
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
          {tax === 'self-assessment' && <option value="penalties">Sort: penalties</option>}
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
                  <tr key={r.entity_id} style={{ borderTop: '1px solid #f1f5f9' }}>
                    <td style={td}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        {r.unreadable && (
                          <TriangleAlert size={12} style={{ color: '#b45309', flexShrink: 0 }}
                            title="At least one period could not be parsed — treat its figures as unknown, not zero" />
                        )}
                        <button onClick={() => navigate(`/hmrc/client?entity=${r.entity_id}`)}
                          style={{
                            background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                            fontFamily: font, fontSize: 12.5, fontWeight: 500, color: '#0f172a', textAlign: 'left',
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
