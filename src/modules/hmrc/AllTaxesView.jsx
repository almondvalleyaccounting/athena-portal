import React, { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Download, TriangleAlert } from 'lucide-react';
import { fmtGbpDetailed } from '../../lib/money';
import { downloadCSV } from '../../lib/exportUtils';
import SearchInput from '../../components/SearchInput';
import AlphabetFilter, { firstCharBucket } from '../../components/AlphabetFilter';
import { font, Chip, ErrorBar, th, thNum, td, tdNum, card, TAX_META, TAX_ORDER } from './hmrcShared';

// Level 0: every client, one figure per tax head. The gateway to the module.
//
// This is the number the PAYE-only dashboard could not give. WMR Contractors
// shows £0 on PAYE and owes £61,388 once Corporation Tax and VAT are counted;
// Gsw Maintenance shows £2,658 on PAYE against £68,252 across three heads. A
// client owing on more than one tax is a different conversation from one behind
// on a single bill, so that count is a filter of its own.
//
// EVERY FIGURE IS A DOOR. Click a client's VAT and you land on the VAT tab with
// that client selected, showing what the VAT number is made of. There is no
// other way down and no other route in, which is what keeps the module one
// thing rather than nine tabs that each start from scratch.
//
// The five headline tiles that used to sit above this are gone. They totalled
// the same columns the table already totals, so they were a second, less
// precise copy of the footer — and they pushed the actual work below the fold.

const n = (v) => Number(v || 0);

export default function AllTaxesView({ clients = [], loading = false, error = '' }) {
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [letter, setLetter] = useState(null);
  const [view, setView] = useState('owing');   // 'owing' | 'multi' | 'credit' | 'all'
  const [sort, setSort] = useState('total');

  const rows = clients;

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const out = rows.filter((r) => {
      const name = r.entity_name || '';
      if (letter && letter !== 'All' && firstCharBucket(name) !== letter) return false;
      if (view === 'owing'  && n(r.total) <= 0) return false;
      if (view === 'multi'  && (r.taxes_owing || 0) < 2) return false;
      if (view === 'credit' && n(r.credit_available) <= 0) return false;
      if (q && !name.toLowerCase().includes(q)) return false;
      return true;
    });
    const key = sort === 'name' ? null : sort;
    return key
      ? [...out].sort((a, b) => n(b[key]) - n(a[key]))
      : [...out].sort((a, b) => (a.entity_name || '').localeCompare(b.entity_name || ''));
  }, [rows, search, letter, view, sort]);

  const sum = (k, set = rows) => set.reduce((s, r) => s + n(r[k]), 0);
  const owing = rows.filter((r) => n(r.total) > 0);
  const multi = rows.filter((r) => (r.taxes_owing || 0) > 1);
  const withCredit = rows.filter((r) => n(r.credit_available) > 0);

  const exportCsv = () => {
    downloadCSV(
      `hmrc-all-taxes-${new Date().toISOString().slice(0, 10)}.csv`,
      ['Client', 'PAYE', 'Corporation Tax', 'VAT', 'Self Assessment', 'Total owed',
       'Credit HMRC holds', 'Repaid to client', 'Credit in from other tax',
       'Credit out to other tax', 'Taxes owing', 'Last scraped'],
      filtered.map((r) => [
        r.entity_name || '',
        n(r.paye).toFixed(2), n(r.corporation_tax).toFixed(2), n(r.vat).toFixed(2),
        n(r.self_assessment).toFixed(2), n(r.total).toFixed(2),
        n(r.credit_available).toFixed(2), n(r.repaid_to_client).toFixed(2),
        n(r.credit_in).toFixed(2), n(r.credit_out).toFixed(2),
        r.taxes_owing ?? 0, r.last_scraped || '',
      ]),
    );
  };

  const openTax = (taxKey, r) => navigate(`/hmrc/${taxKey}?entity=${r.entity_id}`);

  // Where a client's problem actually is. Clicking the name should not need you
  // to have already read the row — and like every figure here, it selects the
  // client, so the tab you land on and every tab after it is about them.
  const biggestTax = (r) => TAX_ORDER
    .reduce((best, k) => (n(r[TAX_META[k].totalsKey]) > n(r[TAX_META[best].totalsKey]) ? k : best), 'paye');

  return (
    <div>
      <ErrorBar message={error} />

      <p style={{ fontSize: 13, color: '#64748b', maxWidth: 900, marginTop: 0, marginBottom: 14, lineHeight: 1.55 }}>
        Everything HMRC says our clients owe, across PAYE, Corporation Tax, VAT and Self Assessment.
        <b> Click any figure</b> to open that tax for that client and see what it is made of — the client
        stays selected on every other tab. The <b>Total</b> goes to Breakdown: all four heads at once.
      </p>

      <div style={{ display: 'flex', gap: 6, marginBottom: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        <SearchInput value={search} onChange={setSearch} placeholder="Client name…" style={{ minWidth: 240 }} />
        <Chip value="owing"  label="Owing" count={owing.length} active={view} onClick={setView} colour="#b91c1c" />
        <Chip value="multi"  label="On 2+ taxes" count={multi.length} active={view} onClick={setView} colour="#c2410c" />
        <Chip value="credit" label="Holding credit" count={withCredit.length} active={view} onClick={setView} colour="#0369a1" />
        <Chip value="all"    label="Every client" count={rows.length} active={view} onClick={setView} />
        <div style={{ flex: 1 }} />
        <select value={sort} onChange={(e) => setSort(e.target.value)}
                style={{ padding: '5px 8px', fontSize: 12, fontFamily: font, border: '1px solid #e5e7eb', borderRadius: 6, background: '#fff' }}>
          <option value="total">Sort: total owed</option>
          <option value="corporation_tax">Sort: Corporation Tax</option>
          <option value="vat">Sort: VAT</option>
          <option value="paye">Sort: PAYE</option>
          <option value="self_assessment">Sort: Self Assessment</option>
          <option value="credit_available">Sort: credit held</option>
          <option value="repaid_to_client">Sort: repaid</option>
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

      <AlphabetFilter items={rows} nameKey="entity_name" selected={letter} onChange={setLetter} />

      {loading ? (
        <div style={{ color: '#94a3b8', fontSize: 13, padding: 24 }}>Loading all tax heads…</div>
      ) : (
        <div style={{ ...card, marginTop: 8 }}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', fontSize: 12.5, borderCollapse: 'collapse', whiteSpace: 'nowrap' }}>
              <thead>
                <tr style={{ background: '#f8fafc', fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.4, color: '#64748b' }}>
                  <th style={th}>Client</th>
                  {TAX_ORDER.map((k) => <th key={k} style={thNum}>{TAX_META[k].short}</th>)}
                  <th style={{ ...thNum, borderLeft: '1px solid #e5e7eb' }}>Total owed</th>
                  <th style={thNum}>Credit held</th>
                  <th style={thNum}>Repaid</th>
                  <th style={{ ...th, textAlign: 'center' }}>Taxes</th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 && (
                  <tr><td colSpan={9} style={{ padding: 30, textAlign: 'center', color: '#94a3b8' }}>
                    No clients match.
                  </td></tr>
                )}
                {filtered.map((r) => (
                  <tr key={r.entity_id} style={{ borderTop: '1px solid #f1f5f9' }}>
                    <td style={td}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        {(r.taxes_owing || 0) > 1 && (
                          <TriangleAlert size={12} style={{ color: '#c2410c', flexShrink: 0 }}
                            title={`Owing on ${r.taxes_owing} tax heads`} />
                        )}
                        <button onClick={() => openTax(biggestTax(r), r)}
                          title={`Open ${r.entity_name} on ${TAX_META[biggestTax(r)].label} — where their largest balance is`}
                          style={{
                            background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                            fontFamily: font, fontSize: 12.5, fontWeight: 500, color: '#0f172a', textAlign: 'left',
                          }}>
                          {r.entity_name}
                        </button>
                      </div>
                    </td>
                    {TAX_ORDER.map((k) => {
                      const v = n(r[TAX_META[k].totalsKey]);
                      return (
                        <td key={k} style={tdNum}>
                          {/* Zero is still a door. A client with nothing owing on
                              VAT may still be the one you want to look at. */}
                          <button
                            onClick={() => openTax(k, r)}
                            title={`${r.entity_name} · ${TAX_META[k].label} — what makes this up`}
                            style={{
                              background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                              fontFamily: font, fontSize: 12.5, fontVariantNumeric: 'tabular-nums',
                              color: v > 0 ? '#b91c1c' : v < 0 ? '#059669' : '#cbd5e1',
                              textDecoration: v !== 0 ? 'underline' : 'none',
                              textDecorationStyle: 'dotted', textDecorationColor: '#cbd5e1',
                            }}
                          >
                            {v !== 0 ? fmtGbpDetailed(v) : '—'}
                          </button>
                        </td>
                      );
                    })}
                    {/* The total is the one figure that is not about a single
                        head, so it goes to Breakdown — the client's whole
                        position, all four heads grouped by tax type. */}
                    <td style={{ ...tdNum, borderLeft: '1px solid #f1f5f9' }}>
                      <button
                        onClick={() => navigate(`/hmrc/breakdown?entity=${r.entity_id}`)}
                        title={`${r.entity_name} — every tax head, and what each balance is made of`}
                        style={{
                          background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                          fontFamily: font, fontSize: 12.5, fontWeight: 700,
                          fontVariantNumeric: 'tabular-nums',
                          color: n(r.total) > 0 ? '#b91c1c' : '#0f172a',
                          textDecoration: 'underline', textDecorationStyle: 'dotted',
                          textDecorationColor: '#cbd5e1',
                        }}
                      >
                        {fmtGbpDetailed(r.total)}
                      </button>
                    </td>
                    <td style={{ ...tdNum, color: n(r.credit_available) > 0 ? '#0369a1' : '#e2e8f0' }}>
                      {n(r.credit_available) > 0 ? fmtGbpDetailed(r.credit_available) : '—'}
                    </td>
                    <td style={{ ...tdNum, color: n(r.repaid_to_client) > 0 ? '#059669' : '#e2e8f0' }}>
                      {n(r.repaid_to_client) > 0 ? fmtGbpDetailed(r.repaid_to_client) : '—'}
                    </td>
                    <td style={{ ...td, textAlign: 'center', fontSize: 11.5, color: '#64748b' }}>
                      {r.taxes_owing || 0}<span style={{ color: '#cbd5e1' }}>/{r.taxes_known || 0}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
              {filtered.length > 0 && (
                <tfoot>
                  <tr style={{ borderTop: '2px solid #e5e7eb', background: '#f8fafc', fontWeight: 700 }}>
                    <td style={td}>{filtered.length} clients shown</td>
                    {TAX_ORDER.map((k) => (
                      <td key={k} style={tdNum}>{fmtGbpDetailed(sum(TAX_META[k].totalsKey, filtered))}</td>
                    ))}
                    <td style={{ ...tdNum, borderLeft: '1px solid #e5e7eb', color: '#b91c1c' }}>
                      {fmtGbpDetailed(sum('total', filtered))}
                    </td>
                    <td style={{ ...tdNum, color: '#0369a1' }}>{fmtGbpDetailed(sum('credit_available', filtered))}</td>
                    <td style={{ ...tdNum, color: '#059669' }}>{fmtGbpDetailed(sum('repaid_to_client', filtered))}</td>
                    <td />
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
