import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Download } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { fmtGbpDetailed } from '../../lib/money';
import { downloadCSV } from '../../lib/exportUtils';
import SearchInput from '../../components/SearchInput';
import { font, Chip, Pill, ErrorBar, th, thNum, td, tdNum, card } from './hmrcShared';

// The CIS credit pot, and what can actually be done with it.
//
// Everywhere else in Athena a CIS credit is visible only once it has been
// CONSUMED — the EPS lines on a monthly PAYE bill equal the credit allocated to
// that bill, to the penny, so the pot itself never appeared. HMRC does state it,
// on the overdue-payments page, and sql/281 captures it.
//
// WHY THIS TAB DOES NOT SHOW AN "AVAILABLE" COLUMN. Because there isn't one.
// Two rules govern the money and they differ:
//
//   Cash moves freely. An unallocated payment is money the client actually
//   sent; HMRC will put it against any liability, any year, on request.
//
//   Credit does not. A CIS credit offsets the CURRENT tax year's PAYE bills and
//   can go nowhere else — another year, another tax, or back to the client —
//   until 6 April. Credit from a CLOSED year is free.
//
// So the test is the CREDIT's year, not the debt's. That distinction produced
// three different answers to one question on 22 Sep 2026: £25,038.48 clearable,
// then £940.51 reading it against the debt's year, then back again. Hawk Eye's
// £12,648.80 reaches its £7,236.06 of 2024-25 arrears because the CREDIT arose
// in 2024-25 — not because the debt did.
//
// AND THE STATED POT CARRIES NO AGE. HMRC gives a balance with no year on it.
// The only signal is its `Not allocated` rows per tax year, which HMRC RESTATES
// each year, so they double-count: Trefoil's sum to £168,301.11 against a
// stated pot of £46,837.78. v_hmrc_cis_pot_status reads them only when they can
// be trusted, and says "age unknown" when they cannot — £102,086.04 of the book,
// 77% of the credit. That column is the honest one and it is not hidden.

const n = (v) => Number(v || 0);

const BASIS = {
  decomposed:   { label: 'Years tie',   colour: '#059669', hint: 'HMRC’s yearly rows sum to the stated balance, so they are its breakdown' },
  'single year':{ label: 'One year',    colour: '#0369a1', hint: 'Exactly one tax year states the balance, and owns it' },
  'age unknown':{ label: 'Age unknown', colour: '#b45309', hint: 'HMRC restates the running balance each year, so no year can be read off it' },
  'no credit':  { label: 'Cash only',   colour: '#94a3b8', hint: 'Unallocated payments, no credit' },
};

export default function CisCreditView() {
  const navigate = useNavigate();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [view, setView] = useState('all');

  useEffect(() => {
    // The module rule: say out loud how much is expected. PostgREST caps a fetch
    // at around a thousand and truncates SILENTLY.
    supabase.from('v_hmrc_cis_pot_status').select('*').limit(2000)
      .then(({ data, error: e }) => {
        if (e) setError(e.message); else setRows(data || []);
        setLoading(false);
      });
  }, []);

  const taxYear = rows[0]?.current_tax_year || '';

  const groups = useMemo(() => ({
    all:     rows,
    cis:     rows.filter((r) => n(r.credit_cis) > 0),
    movable: rows.filter((r) => n(r.cash_movable) + n(r.credit_movable) > 0),
    locked:  rows.filter((r) => n(r.credit_locked) > 0),
    unknown: rows.filter((r) => n(r.credit_age_unknown) > 0),
  }), [rows]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (groups[view] || rows)
      .filter((r) => !q || (r.hmrc_name || '').toLowerCase().includes(q))
      .sort((a, b) =>
        (n(b.cash_movable) + n(b.credit_movable) + n(b.credit_age_unknown))
        - (n(a.cash_movable) + n(a.credit_movable) + n(a.credit_age_unknown)));
  }, [groups, view, search, rows]);

  const sum = (k, list = filtered) => list.reduce((a, r) => a + n(r[k]), 0);

  const exportCsv = () => {
    downloadCSV(
      `hmrc-cis-credit-${new Date().toISOString().slice(0, 10)}.csv`,
      ['Client', 'PAYE ref', 'Cash movable', 'Credit movable', 'Credit locked',
       'Credit age unknown', 'Credit total', 'of which CIS', 'Basis', 'Credit year'],
      filtered.map((r) => [
        r.hmrc_name || '', r.paye_ref || '',
        n(r.cash_movable).toFixed(2), n(r.credit_movable).toFixed(2),
        n(r.credit_locked).toFixed(2), n(r.credit_age_unknown).toFixed(2),
        n(r.credit_total).toFixed(2), n(r.credit_cis).toFixed(2),
        r.basis || '', r.matched_year || '',
      ]),
    );
  };

  if (loading) {
    return <div style={{ color: '#94a3b8', fontSize: 14, padding: 24 }}>Loading the credit pot…</div>;
  }

  return (
    <div>
      <ErrorBar message={error} />

      <p style={{ fontSize: 14, color: '#64748b', maxWidth: 940, marginTop: 0, marginBottom: 6, lineHeight: 1.55 }}>
        What HMRC is holding on our clients’ PAYE accounts, and what can be done with it{taxYear ? ` in ${taxYear}` : ''}.
        There is deliberately <b>no single “available” figure</b>: cash and credit obey different rules,
        and most credit cannot be dated.
      </p>
      <p style={{ fontSize: 13, color: '#64748b', maxWidth: 940, marginTop: 0, marginBottom: 14, lineHeight: 1.6 }}>
        <b>Cash</b> is money the client actually sent that HMRC has not matched to a bill. It can go against
        any liability, any year, on request. <b>Credit</b> — chiefly CIS suffered — only offsets the current
        year’s PAYE bills until 6 April; credit from a closed year is free to move. The test is the
        <b> credit’s</b> year, not the debt’s.
      </p>

      <div style={{ display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <SearchInput value={search} onChange={setSearch} placeholder="Client name…" style={{ minWidth: 240 }} />
        <Chip value="all"     label="Everyone holding something" count={groups.all.length} active={view} onClick={setView} />
        <Chip value="cis"     label="Holding CIS credit"  count={groups.cis.length}     active={view} onClick={setView} colour="#0369a1" />
        <Chip value="movable" label="Movable now"         count={groups.movable.length} active={view} onClick={setView} colour="#059669" />
        <Chip value="locked"  label="Locked to this year" count={groups.locked.length}  active={view} onClick={setView} colour="#c2410c" />
        <Chip value="unknown" label="Age unknown"         count={groups.unknown.length} active={view} onClick={setView} colour="#b45309" />
        <button onClick={exportCsv} style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6,
          background: '#fff', border: '1px solid #e2e8f0', borderRadius: 6, padding: '6px 11px',
          fontFamily: font, fontSize: 13, color: '#475569', cursor: 'pointer' }}>
          <Download size={13} /> Export
        </button>
      </div>

      <div style={card}>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse', whiteSpace: 'nowrap' }}>
            <thead>
              <tr style={{ background: '#f8fafc', color: '#64748b', fontSize: 11 }}>
                <th style={th}>Client</th>
                <th style={thNum} title="Money the client sent that HMRC has not matched to a bill. No year restriction.">Cash · movable</th>
                <th style={thNum} title="Credit that arose in a closed tax year, so it can be set against another year, another tax, or repaid.">Credit · movable</th>
                <th style={thNum} title="Credit that arose this tax year. It can only offset this year’s PAYE bills until 6 April.">Credit · locked</th>
                <th style={thNum} title="Credit whose tax year cannot be read from HMRC’s restated yearly rows. Not nil, and not available.">Credit · age unknown</th>
                <th style={{ ...thNum, borderLeft: '1px solid #e5e7eb' }}>Credit total</th>
                <th style={thNum}>of which CIS</th>
                <th style={th}>Basis</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => {
                const b = BASIS[r.basis] || BASIS['age unknown'];
                return (
                  <tr key={r.paye_ref} style={{ borderTop: '1px solid #f1f5f9' }}>
                    <td style={td}>
                      {r.entity_id ? (
                        <button
                          onClick={() => navigate(`/hmrc/paye?entity=${r.entity_id}`)}
                          style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                                   fontFamily: font, fontSize: 13, color: '#0f172a',
                                   textDecoration: 'underline', textDecorationStyle: 'dotted',
                                   textDecorationColor: '#cbd5e1' }}
                          title="Open this client’s PAYE account">
                          {r.hmrc_name}
                        </button>
                      ) : (
                        // No entity behind the scheme — the name is all there is,
                        // and it must not look like a dead link.
                        <span title="No Athena client linked to this PAYE scheme">{r.hmrc_name}</span>
                      )}
                    </td>
                    <td style={{ ...tdNum, color: n(r.cash_movable) ? '#0f172a' : '#e2e8f0' }}>
                      {n(r.cash_movable) ? fmtGbpDetailed(r.cash_movable) : '—'}
                    </td>
                    <td style={{ ...tdNum, color: n(r.credit_movable) ? '#059669' : '#e2e8f0', fontWeight: n(r.credit_movable) ? 600 : 400 }}>
                      {n(r.credit_movable) ? fmtGbpDetailed(r.credit_movable) : '—'}
                    </td>
                    <td style={{ ...tdNum, color: n(r.credit_locked) ? '#c2410c' : '#e2e8f0' }}>
                      {n(r.credit_locked) ? fmtGbpDetailed(r.credit_locked) : '—'}
                    </td>
                    <td style={{ ...tdNum, color: n(r.credit_age_unknown) ? '#b45309' : '#e2e8f0' }}>
                      {n(r.credit_age_unknown) ? fmtGbpDetailed(r.credit_age_unknown) : '—'}
                    </td>
                    <td style={{ ...tdNum, borderLeft: '1px solid #f1f5f9' }}>
                      {n(r.credit_total) ? fmtGbpDetailed(r.credit_total) : '—'}
                    </td>
                    <td style={{ ...tdNum, color: '#0369a1' }}>
                      {n(r.credit_cis) ? fmtGbpDetailed(r.credit_cis) : '—'}
                    </td>
                    <td style={td}>
                      <Pill colour={b.colour} title={b.hint} style={{ fontSize: 10.5 }}>{b.label}</Pill>
                      {r.matched_year && (
                        <span style={{ fontSize: 11.5, color: '#94a3b8', marginLeft: 6 }}>{r.matched_year}</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr style={{ borderTop: '2px solid #e5e7eb', background: '#f8fafc', fontWeight: 700 }}>
                <td style={td}>{filtered.length} client{filtered.length === 1 ? '' : 's'}</td>
                <td style={tdNum}>{fmtGbpDetailed(sum('cash_movable'))}</td>
                <td style={{ ...tdNum, color: '#059669' }}>{fmtGbpDetailed(sum('credit_movable'))}</td>
                <td style={{ ...tdNum, color: '#c2410c' }}>{fmtGbpDetailed(sum('credit_locked'))}</td>
                <td style={{ ...tdNum, color: '#b45309' }}>{fmtGbpDetailed(sum('credit_age_unknown'))}</td>
                <td style={{ ...tdNum, borderLeft: '1px solid #e5e7eb' }}>{fmtGbpDetailed(sum('credit_total'))}</td>
                <td style={{ ...tdNum, color: '#0369a1' }}>{fmtGbpDetailed(sum('credit_cis'))}</td>
                <td style={td} />
              </tr>
            </tfoot>
          </table>
        </div>
        <div style={{ padding: '10px 14px', fontSize: 12.5, color: '#94a3b8', lineHeight: 1.6, borderTop: '1px solid #f1f5f9' }}>
          The three credit columns add up to the credit total, so nothing is lost between them.
          <b> Age unknown is not nil and not available</b> — it is credit HMRC holds whose year we cannot
          read, because HMRC restates the running balance in every year’s credits history rather than
          reporting what arose in that year. Cash and credit are never added together: only one of them
          can be moved on request.
        </div>
      </div>
    </div>
  );
}
