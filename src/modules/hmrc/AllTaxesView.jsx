import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Download, TriangleAlert } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { fmtGbpDetailed } from '../../lib/money';
import { downloadCSV } from '../../lib/exportUtils';
import SearchInput from '../../components/SearchInput';
import AlphabetFilter, { firstCharBucket } from '../../components/AlphabetFilter';
import { font, Chip, Pill, ErrorBar, th, thNum, td, tdNum, card, TAX_META } from './hmrcShared';

// Level 0: every client, one HMRC position. The gateway to the module.
//
// This used to pivot four heads into four columns and total them. HMRC does not
// work that way — it is one account that happens to be reported in four places,
// and money moves between them on request. A column-per-head table with a "total
// owed" that summed only the debts made Hawk Eye a debtor for £7,865 while HMRC
// sat on £12,648 of their CIS credit. Across the book that overstated the
// position by £273,997.
//
// So the position leads and the heads sit behind it:
//
//   Owed         what HMRC says is due, across all four heads
//   Held         everything HMRC is sitting on — cash, CIS credit, overpaid CT
//   Net          owed less held. The true economic position.
//   Payable now  owed less only what can actually be MOVED today.
//
// NET AND PAYABLE ARE BOTH TRUE AND THEY DIFFER BY £109,821. Netting assumes the
// credit can be applied; current-year CIS credit cannot be, since it offsets
// this year's PAYE bills and moves nowhere else until 6 April. Showing one
// number would have meant picking which truth to hide. See
// docs/hmrc-timing-and-cis-rules.md.
//
// EVERY FIGURE IS STILL A DOOR. A head opens that tax for that client; Net opens
// Breakdown. There is no other way down and no other route in, which is what
// keeps the module one thing rather than nine tabs that each start from scratch.

const n = (v) => Number(v || 0);

// The per-head columns, kept behind the position rather than framing the page.
const HEADS = [
  { key: 'owed_paye', tax: 'paye' },
  { key: 'owed_ct',   tax: 'corporation-tax' },
  { key: 'owed_vat',  tax: 'vat' },
  { key: 'owed_sa',   tax: 'self-assessment' },
];

export default function AllTaxesView({ clients = [], error = '' }) {
  const navigate = useNavigate();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [search, setSearch] = useState('');
  const [letter, setLetter] = useState(null);
  const [view, setView] = useState('net_owing');
  const [sort, setSort] = useState('net_position');

  useEffect(() => {
    // 326 rows today. The explicit limit is the module rule rather than a guess:
    // PostgREST caps a fetch at around a thousand and truncates SILENTLY.
    supabase.from('v_hmrc_client_position').select('*').limit(2000)
      .then(({ data, error: e }) => {
        if (e) setLoadError(e.message); else setRows(data || []);
        setLoading(false);
      });
  }, []);

  // Repaid-to-client and the head count still come from the totals view the
  // module already loads for the selector, so this costs no extra request.
  const extra = useMemo(() => {
    const by = new Map();
    for (const c of clients) by.set(c.entity_id, c);
    return by;
  }, [clients]);

  const groups = useMemo(() => ({
    net_owing:  rows.filter((r) => n(r.net_position) > 0),
    payable:    rows.filter((r) => n(r.payable_now) > 0),
    in_credit:  rows.filter((r) => n(r.net_position) < 0),
    holding:    rows.filter((r) => n(r.held_total) > 0),
    multi:      rows.filter((r) => (r.taxes_owing || 0) > 1),
    all:        rows,
  }), [rows]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const out = (groups[view] || rows).filter((r) => {
      const name = r.entity_name || '';
      if (letter && letter !== 'All' && firstCharBucket(name) !== letter) return false;
      if (q && !name.toLowerCase().includes(q)) return false;
      return true;
    });
    return sort === 'name'
      ? [...out].sort((a, b) => (a.entity_name || '').localeCompare(b.entity_name || ''))
      : [...out].sort((a, b) => n(b[sort]) - n(a[sort]));
  }, [groups, view, rows, search, letter, sort]);

  const sum = (k, set = filtered) => set.reduce((s, r) => s + n(r[k]), 0);

  const exportCsv = () => {
    downloadCSV(
      `hmrc-position-${new Date().toISOString().slice(0, 10)}.csv`,
      ['Client', 'Owed', 'Held', 'Net position', 'Payable now',
       'PAYE', 'Corporation Tax', 'VAT', 'Self Assessment',
       'Held: cash', 'Held: CIS credit movable', 'Held: credit locked',
       'Held: credit age unknown', 'Held: other heads', 'Held: SA',
       'Taxes owing', 'VAT position unknown', 'Last scraped'],
      filtered.map((r) => [
        r.entity_name || '',
        n(r.owed_total).toFixed(2), n(r.held_total).toFixed(2),
        n(r.net_position).toFixed(2), n(r.payable_now).toFixed(2),
        n(r.owed_paye).toFixed(2), n(r.owed_ct).toFixed(2),
        n(r.owed_vat).toFixed(2), n(r.owed_sa).toFixed(2),
        n(r.held_paye_cash).toFixed(2), n(r.held_paye_credit_movable).toFixed(2),
        n(r.held_paye_credit_locked).toFixed(2), n(r.held_paye_credit_unknown).toFixed(2),
        n(r.held_other_heads).toFixed(2), n(r.held_sa).toFixed(2),
        r.taxes_owing ?? 0, r.vat_credit_not_captured ? 'yes' : '',
        r.last_scraped || '',
      ]),
    );
  };

  const openTax = (taxKey, r) => navigate(`/hmrc/${taxKey}?entity=${r.entity_id}`);

  const heldHint = (r) => {
    const bits = [];
    if (n(r.held_paye_cash)) bits.push(`${fmtGbpDetailed(r.held_paye_cash)} cash on PAYE`);
    if (n(r.held_paye_credit_movable)) bits.push(`${fmtGbpDetailed(r.held_paye_credit_movable)} credit, movable`);
    if (n(r.held_paye_credit_locked)) bits.push(`${fmtGbpDetailed(r.held_paye_credit_locked)} credit, locked to this tax year`);
    if (n(r.held_paye_credit_unknown)) bits.push(`${fmtGbpDetailed(r.held_paye_credit_unknown)} credit, tax year unknown`);
    if (n(r.held_other_heads)) bits.push(`${fmtGbpDetailed(r.held_other_heads)} overpaid on another head`);
    if (n(r.held_sa)) bits.push(`${fmtGbpDetailed(r.held_sa)} Self Assessment repayment`);
    return bits.length ? bits.join(' · ') : 'HMRC is holding nothing';
  };

  return (
    <div>
      <ErrorBar message={error || loadError} />

      <p style={{ fontSize: 14, color: '#64748b', maxWidth: 940, marginTop: 0, marginBottom: 6, lineHeight: 1.55 }}>
        One HMRC position per client. <b>Net</b> is what they owe once everything HMRC is holding is counted
        against it — cash, CIS credit, overpaid Corporation Tax. <b>Click any figure</b> to open it; the
        client stays selected on every other tab.
      </p>
      <p style={{ fontSize: 13, color: '#64748b', maxWidth: 940, marginTop: 0, marginBottom: 14, lineHeight: 1.6 }}>
        <b>Payable now</b> is lower confidence than it looks smaller. Net assumes every credit can be applied;
        current-year CIS credit cannot be moved until 6 April, and some credit cannot be dated at all. Where
        the two columns differ, that difference is the credit that is stuck.
      </p>

      <div style={{ display: 'flex', gap: 6, marginBottom: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        <SearchInput value={search} onChange={setSearch} placeholder="Client name…" style={{ minWidth: 220 }} />
        <Chip value="net_owing" label="Net owing"      count={groups.net_owing.length} active={view} onClick={setView} colour="#b91c1c" />
        <Chip value="payable"   label="Payable now"    count={groups.payable.length}   active={view} onClick={setView} colour="#c2410c" />
        <Chip value="in_credit" label="Net in credit"  count={groups.in_credit.length} active={view} onClick={setView} colour="#059669" />
        <Chip value="holding"   label="HMRC holding"   count={groups.holding.length}   active={view} onClick={setView} colour="#0369a1" />
        <Chip value="multi"     label="On 2+ taxes"    count={groups.multi.length}     active={view} onClick={setView} colour="#c2410c" />
        <Chip value="all"       label="Every client"   count={groups.all.length}       active={view} onClick={setView} />
        <select value={sort} onChange={(e) => setSort(e.target.value)}
          style={{ padding: '5px 8px', fontSize: 13, fontFamily: font, color: '#475569',
                   background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8 }}>
          <option value="net_position">Sort: net position</option>
          <option value="payable_now">Sort: payable now</option>
          <option value="owed_total">Sort: owed</option>
          <option value="held_total">Sort: held</option>
          <option value="name">Sort: name</option>
        </select>
        <button onClick={exportCsv} disabled={filtered.length === 0}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '6px 12px',
                   fontSize: 13, fontFamily: font, color: '#475569', background: '#fff',
                   border: '1px solid #e5e7eb', borderRadius: 8,
                   cursor: filtered.length ? 'pointer' : 'default', opacity: filtered.length ? 1 : 0.5 }}>
          <Download size={12} /> Export for Excel
        </button>
      </div>

      <AlphabetFilter items={rows} nameKey="entity_name" selected={letter} onChange={setLetter} />

      {loading ? (
        <div style={{ color: '#94a3b8', fontSize: 14, padding: 24 }}>Loading every tax head…</div>
      ) : (
        <div style={{ ...card, marginTop: 8 }}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', fontSize: 13.5, borderCollapse: 'collapse', whiteSpace: 'nowrap' }}>
              <thead>
                <tr style={{ background: '#f8fafc', fontSize: 11, color: '#64748b' }}>
                  <th style={th}>Client</th>
                  <th style={thNum} title="What HMRC says is due, across all four heads">Owed</th>
                  <th style={thNum} title="Everything HMRC is sitting on — hover a figure for the make-up">Held</th>
                  <th style={{ ...thNum, borderLeft: '1px solid #e5e7eb' }} title="Owed less held. The true economic position.">Net</th>
                  <th style={thNum} title="Owed less only the credit that can be moved today. Excludes current-year CIS credit and credit whose year cannot be read.">Payable now</th>
                  <th style={{ ...th, borderLeft: '1px solid #e5e7eb', fontSize: 10.5, color: '#94a3b8' }} colSpan={4}>Owed, by head</th>
                  <th style={{ ...th, textAlign: 'center' }}>Taxes</th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 && (
                  <tr><td colSpan={10} style={{ padding: 30, textAlign: 'center', color: '#94a3b8' }}>
                    No clients match.
                  </td></tr>
                )}
                {filtered.map((r) => {
                  const net = n(r.net_position);
                  const stuck = n(r.payable_now) - net;
                  return (
                    <tr key={r.entity_id} style={{ borderTop: '1px solid #f1f5f9' }}>
                      <td style={td}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          {(r.taxes_owing || 0) > 1 && (
                            <TriangleAlert size={12} style={{ color: '#c2410c', flexShrink: 0 }}
                              title={`Owing on ${r.taxes_owing} tax heads`} />
                          )}
                          <button onClick={() => navigate(`/hmrc/breakdown?entity=${r.entity_id}`)}
                            title={`${r.entity_name} — every tax head, and what each balance is made of`}
                            style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                                     fontFamily: font, fontSize: 13.5, fontWeight: 500, color: '#0f172a', textAlign: 'left' }}>
                            {r.entity_name}
                          </button>
                          {r.vat_credit_not_captured && (
                            <Pill colour="#b45309" style={{ fontSize: 10 }}
                              title="Registered for VAT but HMRC lists nothing owed. A VAT repayment position is not scraped, so we cannot tell a nil position from a repayment due.">
                              VAT ?
                            </Pill>
                          )}
                        </div>
                      </td>
                      <td style={{ ...tdNum, color: n(r.owed_total) ? '#b91c1c' : '#e2e8f0' }}>
                        {n(r.owed_total) ? fmtGbpDetailed(r.owed_total) : '—'}
                      </td>
                      <td style={{ ...tdNum, color: n(r.held_total) ? '#0369a1' : '#e2e8f0' }} title={heldHint(r)}>
                        {n(r.held_total) ? fmtGbpDetailed(r.held_total) : '—'}
                      </td>
                      <td style={{ ...tdNum, borderLeft: '1px solid #f1f5f9' }}>
                        <button
                          onClick={() => navigate(`/hmrc/breakdown?entity=${r.entity_id}`)}
                          title={`${r.entity_name} — owed ${fmtGbpDetailed(r.owed_total)}, held ${fmtGbpDetailed(r.held_total)}`}
                          style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                                   fontFamily: font, fontSize: 13.5, fontWeight: 700,
                                   fontVariantNumeric: 'tabular-nums',
                                   color: net > 0 ? '#b91c1c' : net < 0 ? '#059669' : '#0f172a',
                                   textDecoration: 'underline', textDecorationStyle: 'dotted',
                                   textDecorationColor: '#cbd5e1' }}>
                          {fmtGbpDetailed(net)}
                        </button>
                      </td>
                      <td style={{ ...tdNum, color: n(r.payable_now) > 0 ? '#0f172a' : '#e2e8f0' }}
                          title={stuck > 0
                            ? `${fmtGbpDetailed(stuck)} of credit cannot be moved yet, so it is not netted here`
                            : 'Everything held can be moved today'}>
                        {n(r.payable_now) ? fmtGbpDetailed(r.payable_now) : '—'}
                        {stuck > 0 && <span style={{ color: '#b45309', marginLeft: 4 }} title="Credit stuck">•</span>}
                      </td>
                      {HEADS.map((h, i) => {
                        const v = n(r[h.key]);
                        return (
                          <td key={h.key} style={{ ...tdNum, ...(i === 0 ? { borderLeft: '1px solid #f1f5f9' } : {}) }}>
                            {/* Zero is still a door. A client with nothing owing
                                on VAT may still be the one you want to look at. */}
                            <button onClick={() => openTax(h.tax, r)}
                              title={`${r.entity_name} · ${TAX_META[h.tax].label} — what makes this up`}
                              style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                                       fontFamily: font, fontSize: 12.5, fontVariantNumeric: 'tabular-nums',
                                       color: v > 0 ? '#94a3b8' : '#e2e8f0',
                                       textDecoration: v !== 0 ? 'underline' : 'none',
                                       textDecorationStyle: 'dotted', textDecorationColor: '#e2e8f0' }}>
                              {v !== 0 ? fmtGbpDetailed(v) : '—'}
                            </button>
                          </td>
                        );
                      })}
                      <td style={{ ...td, textAlign: 'center', fontSize: 12.5, color: '#64748b' }}>
                        {r.taxes_owing || 0}
                        <span style={{ color: '#cbd5e1' }}>/{extra.get(r.entity_id)?.taxes_known ?? 0}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              {filtered.length > 0 && (
                <tfoot>
                  <tr style={{ borderTop: '2px solid #e5e7eb', background: '#f8fafc', fontWeight: 700 }}>
                    <td style={td}>{filtered.length} client{filtered.length === 1 ? '' : 's'} shown</td>
                    <td style={{ ...tdNum, color: '#b91c1c' }}>{fmtGbpDetailed(sum('owed_total'))}</td>
                    <td style={{ ...tdNum, color: '#0369a1' }}>{fmtGbpDetailed(sum('held_total'))}</td>
                    <td style={{ ...tdNum, borderLeft: '1px solid #e5e7eb',
                                 color: sum('net_position') > 0 ? '#b91c1c' : '#059669' }}>
                      {fmtGbpDetailed(sum('net_position'))}
                    </td>
                    <td style={tdNum}>{fmtGbpDetailed(sum('payable_now'))}</td>
                    {HEADS.map((h, i) => (
                      <td key={h.key} style={{ ...tdNum, fontSize: 12.5, color: '#94a3b8',
                                               ...(i === 0 ? { borderLeft: '1px solid #e5e7eb' } : {}) }}>
                        {fmtGbpDetailed(sum(h.key))}
                      </td>
                    ))}
                    <td />
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
          <div style={{ padding: '10px 14px', fontSize: 12.5, color: '#94a3b8', lineHeight: 1.6, borderTop: '1px solid #f1f5f9' }}>
            Owed less held is Net. Payable now applies only the credit that can actually be moved today, so
            where it exceeds Net the difference is credit that is stuck — marked with a dot. A
            <b> VAT ?</b> tag means the client is registered for VAT and HMRC lists nothing owed: a VAT
            repayment position is not scraped, so a nil position and a repayment due look identical.
          </div>
        </div>
      )}
    </div>
  );
}
