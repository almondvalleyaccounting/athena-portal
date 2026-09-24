import React, { useEffect, useMemo, useState } from 'react';
import { Download, RefreshCw } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { downloadCSV } from '../../lib/exportUtils';
import SearchInput from '../../components/SearchInput';
import { pullQboBalances } from './api';
import { font, card, th, td, btn, btnQuiet, Pill, ErrorBar, money } from './wpShared';

/*
 * Working Papers → HMRC against the books.
 *
 * The point of the scrape, the nominal map and wp-qbo-ledger, in one table:
 * what HMRC says, what the client's ledger says, and the difference.
 *
 * VARIANCE IS ALWAYS QUICKBOOKS LESS HMRC, so one sign means one thing across
 * every row: POSITIVE means the books carry more than HMRC agrees. On a
 * liability that is an over-accrual or a payment HMRC has not matched; on the
 * CIS asset it is a claim HMRC is not holding.
 *
 * CIS IS AN ASSET AND IS NOT COMPARED TO A LIABILITY. cis_suffered is what the
 * client believes HMRC owes them, so its counterpart is the unallocated credit
 * pot HMRC states on the overdue-payments page — not the PAYE bill. Setting it
 * against PAYE would net a debtor against a creditor and mean nothing.
 *
 * PAYE CANNOT TIE AND IS NOT ASKED TO. HMRC's PAYE figure is total_debt, which
 * is ARREARS, not a creditor — a month accrued in the ledger and not yet due
 * shows as a difference by construction. Those rows are marked "timing" rather
 * than "variance" so nobody spends an afternoon on one. hmrc_paye_balance_at is
 * the comparable figure; it is an RPC per scheme per date and is the honest
 * next step for this screen.
 *
 * THE TWO SIDES ARE AS AT DIFFERENT DATES. HMRC is as at its last scrape;
 * QuickBooks is as at whenever someone last valued the mapped nominals. Both
 * dates are on the row, because a December year-end balance against a September
 * HMRC position answers some questions and none of the others.
 */

const n = (v) => Number(v || 0);

const HEAD_LABEL = {
  paye: 'PAYE', vat: 'VAT', 'corporation-tax': 'Corporation Tax', cis: 'CIS suffered',
};
const STATUS = {
  ties:         { label: 'Ties',       colour: '#15803d' },
  variance:     { label: 'Variance',   colour: '#b91c1c' },
  timing:       { label: 'Timing',     colour: '#b45309' },
  'not valued': { label: 'Not valued', colour: '#94a3b8' },
};

export default function HmrcQboCompare() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [view, setView] = useState('valued');
  const [asAt, setAsAt] = useState(() => new Date().toISOString().slice(0, 10));
  const [valuing, setValuing] = useState('');

  const load = () => {
    setLoading(true);
    // The module rule: say out loud how much is expected. PostgREST caps a fetch
    // at around a thousand and truncates SILENTLY.
    supabase.from('v_wp_hmrc_qbo_compare').select('*').limit(2000)
      .then(({ data, error: e }) => {
        if (e) setError(e.message); else { setRows(data || []); setError(''); }
        setLoading(false);
      });
  };
  useEffect(load, []);

  // Every valuation date present, newest first. The screen shows ONE date at a
  // time: mixing a December year end with a September valuation in one table
  // would put two different questions in one column.
  const dates = useMemo(
    () => [...new Set(rows.map((r) => r.qbo_as_at).filter(Boolean))].sort().reverse(),
    [rows]);

  // Rows for the chosen date, plus the unvalued ones, which belong to no date.
  const atDate = useMemo(
    () => rows.filter((r) => r.qbo_as_at === asAt || r.qbo_as_at == null),
    [rows, asAt]);

  const groups = useMemo(() => ({
    valued:   atDate.filter((r) => r.status !== 'not valued'),
    variance: atDate.filter((r) => r.status === 'variance'),
    timing:   atDate.filter((r) => r.status === 'timing'),
    unvalued: atDate.filter((r) => r.status === 'not valued'),
    all:      atDate,
  }), [atDate]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (groups[view] || atDate)
      .filter((r) => !q || (r.entity_name || '').toLowerCase().includes(q))
      .sort((a, b) => Math.abs(n(b.variance)) - Math.abs(n(a.variance)));
  }, [groups, view, atDate, search]);


  // Value every mapped client at the chosen date.
  //
  // Sequential, deliberately. Each realm costs TWO QuickBooks report calls -- a
  // GeneralLedger from 1990 and a BalanceSheet to check it against -- and the
  // GeneralLedger over a whole file is the heavy one. Firing a hundred of those
  // at Intuit in parallel is how you get rate-limited into a half-valued book,
  // and a half-valued book looks exactly like a reconciled one.
  const valueAll = async () => {
    const targets = [...new Map(
      rows.filter((r) => r.realm_id).map((r) => [r.realm_id, r.entity_name]),
    )];
    if (!targets.length) return;

    let done = 0, failed = 0;
    for (const [realmId, name] of targets) {
      setValuing(`${name} — ${done + failed + 1} of ${targets.length}`);
      try { await pullQboBalances(realmId, asAt); done++; }
      catch { failed++; }   // one dead connection must not stop the rest
    }
    setValuing("");
    // Said out loud. A client whose QuickBooks could not be reached is not
    // valued, and an unvalued client reads as "not valued" rather than as a
    // problem, so the count has to appear somewhere.
    if (failed) {
      setError(`${done} valued, ${failed} could not be reached — those clients need a QuickBooks reconnect.`);
    }
    load();
  };
  const exportCsv = () => {
    downloadCSV(
      `hmrc-vs-quickbooks-${new Date().toISOString().slice(0, 10)}.csv`,
      ['Client', 'Head', 'HMRC', 'QuickBooks', 'Variance', 'Status',
       'Nominals', 'QBO as at', 'HMRC as at'],
      filtered.map((r) => [
        r.entity_name || '', HEAD_LABEL[r.head] || r.head,
        n(r.hmrc_amount).toFixed(2), r.qbo_amount == null ? '' : n(r.qbo_amount).toFixed(2),
        r.qbo_amount == null ? '' : n(r.variance).toFixed(2),
        r.status || '', r.account_names || '', r.qbo_as_at || '', r.hmrc_as_at || '',
      ]),
    );
  };

  const chip = (key, label, colour) => {
    const on = view === key;
    return (
      <button key={key} onClick={() => setView(key)}
        style={{ ...btnQuiet, fontSize: 13,
                 borderColor: on ? (colour || '#0f172a') : '#e5e7eb',
                 color: on ? (colour || '#0f172a') : '#475569',
                 fontWeight: on ? 600 : 400 }}>
        {label} <span style={{ color: '#94a3b8' }}>{(groups[key] || []).length}</span>
      </button>
    );
  };

  return (
    <div>
      <ErrorBar message={error} />

      <p style={{ fontSize: 14, color: '#64748b', maxWidth: 940, marginTop: 0, marginBottom: 6, lineHeight: 1.55 }}>
        What HMRC says, against what the client&rsquo;s ledger says.
        <b> Variance is QuickBooks less HMRC</b> on every row, so positive always means the books are
        carrying more than HMRC agrees.
      </p>
      <p style={{ fontSize: 13, color: '#64748b', maxWidth: 940, marginTop: 0, marginBottom: 14, lineHeight: 1.6 }}>
        <b>PAYE cannot tie and is not asked to.</b> HMRC&rsquo;s PAYE figure is arrears, not a creditor, so a
        month accrued and not yet due reads as a difference by construction — those rows say
        <b> timing</b>, not variance. <b>CIS is an asset</b>, compared to the credit HMRC actually holds
        rather than to a tax bill. And the two sides are as at different dates; both are on the row.
      </p>

      <div style={{ ...card, padding: 12, marginBottom: 12, display: 'flex',
                    alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 13.5, color: '#0f172a' }}>Value the mapped nominals as at</div>
        <input type="date" value={asAt} onChange={(e) => setAsAt(e.target.value)}
          style={{ fontFamily: font, fontSize: 13.5, padding: '5px 8px',
                   border: '1px solid #e5e7eb', borderRadius: 6, color: '#0f172a' }} />
        <button onClick={valueAll} disabled={!!valuing}
          style={{ ...btn, fontSize: 13.5, opacity: valuing ? 0.6 : 1 }}>
          {valuing || 'Value every mapped client'}
        </button>
        {dates.length > 1 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto' }}>
            <span style={{ fontSize: 12.5, color: '#94a3b8' }}>Showing</span>
            <select value={asAt} onChange={(e) => setAsAt(e.target.value)}
              style={{ fontFamily: font, fontSize: 13, padding: '4px 8px',
                       border: '1px solid #e5e7eb', borderRadius: 6, color: '#475569' }}>
              {dates.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </div>
        )}
        <div style={{ fontSize: 12.5, color: '#94a3b8', flexBasis: '100%', lineHeight: 1.5 }}>
          Two QuickBooks reports per client and the ledger one runs from 1990, so this is slow and goes
          one client at a time on purpose. Only nominals somebody has already mapped get valued — map
          them on <b>Map the book</b> first. Re-running a date you have already valued re-prices it
          rather than adding a second figure.
        </div>
      </div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <SearchInput value={search} onChange={setSearch} placeholder="Client name…" style={{ minWidth: 220 }} />
        {chip('valued', 'Compared')}
        {chip('variance', 'Variance', '#b91c1c')}
        {chip('timing', 'Timing', '#b45309')}
        {chip('unvalued', 'Not valued', '#94a3b8')}
        {chip('all', 'Everything')}
        <button onClick={load} style={{ ...btnQuiet, marginLeft: 'auto', fontSize: 13, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <RefreshCw size={12} /> Reload
        </button>
        <button onClick={exportCsv} disabled={!filtered.length}
          style={{ ...btnQuiet, fontSize: 13, display: 'inline-flex', alignItems: 'center', gap: 5,
                   opacity: filtered.length ? 1 : 0.5 }}>
          <Download size={12} /> Export
        </button>
      </div>

      {loading ? (
        <div style={{ color: '#94a3b8', fontSize: 14, padding: 24 }}>Loading the comparison…</div>
      ) : (
        <div style={card}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', fontSize: 13.5, borderCollapse: 'collapse', whiteSpace: 'nowrap' }}>
              <thead>
                <tr style={{ background: '#f8fafc', color: '#64748b', fontSize: 11 }}>
                  <th style={th}>Client</th>
                  <th style={th}>Head</th>
                  <th style={{ ...th, textAlign: 'right' }}>HMRC</th>
                  <th style={{ ...th, textAlign: 'right' }}>QuickBooks</th>
                  <th style={{ ...th, textAlign: 'right', borderLeft: '1px solid #e5e7eb' }}>Variance</th>
                  <th style={th}>Nominal</th>
                  <th style={{ ...th, textAlign: 'center' }}>QBO as at</th>
                  <th style={th} />
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 && (
                  <tr><td colSpan={8} style={{ padding: 30, textAlign: 'center', color: '#94a3b8' }}>
                    Nothing here. Map a client&rsquo;s nominals on <b>Map the book</b>, then value them,
                    and the comparison fills in.
                  </td></tr>
                )}
                {filtered.map((r, i) => {
                  const s = STATUS[r.status] || STATUS['not valued'];
                  const v = n(r.variance);
                  return (
                    <tr key={`${r.entity_id}|${r.head}|${i}`} style={{ borderTop: '1px solid #f1f5f9' }}>
                      <td style={{ ...td, fontWeight: 500 }}>{r.entity_name}</td>
                      <td style={{ ...td, color: '#64748b' }} title={r.what}>{HEAD_LABEL[r.head] || r.head}</td>
                      <td style={{ ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                        {money(r.hmrc_amount)}
                      </td>
                      <td style={{ ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums',
                                   color: r.qbo_amount == null ? '#e2e8f0' : '#0f172a' }}>
                        {r.qbo_amount == null ? '—' : money(r.qbo_amount)}
                      </td>
                      <td style={{ ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums',
                                   borderLeft: '1px solid #f1f5f9', fontWeight: 600,
                                   color: r.qbo_amount == null ? '#e2e8f0'
                                        : r.status === 'ties' ? '#15803d'
                                        : r.status === 'timing' ? '#b45309' : '#b91c1c' }}>
                        {r.qbo_amount == null ? '—' : money(v)}
                      </td>
                      <td style={{ ...td, color: '#94a3b8', fontSize: 12.5, whiteSpace: 'normal', maxWidth: 260 }}>
                        {r.account_names || '—'}
                      </td>
                      <td style={{ ...td, textAlign: 'center', color: '#94a3b8', fontSize: 12.5 }}>
                        {r.qbo_as_at || '—'}
                      </td>
                      <td style={td}>
                        <Pill colour={s.colour}>{s.label}</Pill>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div style={{ padding: '10px 14px', fontSize: 12.5, color: '#94a3b8', lineHeight: 1.6, borderTop: '1px solid #f1f5f9' }}>
            <b>Not valued</b> means the client has no nominal mapped for that head, or the mapped
            nominals have not been priced at a date — not that the two agree. A variance is a question,
            not an error: HMRC and a ledger legitimately differ over a payment in transit or an EPS HMRC
            has not processed yet. What matters is the size, the direction, and anything that does not
            move when it should.
          </div>
        </div>
      )}
    </div>
  );
}
