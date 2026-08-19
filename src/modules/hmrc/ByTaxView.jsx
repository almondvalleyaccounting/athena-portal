import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Download, TriangleAlert } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { fmtGbpDetailed } from '../../lib/money';
import { downloadCSV } from '../../lib/exportUtils';
import SearchInput from '../../components/SearchInput';
import AlphabetFilter, { firstCharBucket } from '../../components/AlphabetFilter';
import {
  font, Pill, ErrorBar, shortDate, th, thNum, td, tdNum, card,
  LevelTrail, TAX_META,
} from './hmrcShared';

// One tax head — Corporation Tax, VAT or Self Assessment — at whichever level
// you are working.
//
//   no client chosen   every client ranked on this head. Pick one and you go
//                      down a level rather than expanding a row in place.
//   client chosen      LEVEL 1: what their balance on this head is made of —
//                      accounting periods, VAT periods, or the Self Assessment
//                      statement and its years.
//   a figure clicked   LEVEL 2: the transactions behind it. Cash paid, money
//                      repaid, credit moved in from another tax.
//
// The client comes from the selector above the tabs, so it survives a move to
// another tax head. That is the whole reason this stopped being an expand-in-
// place row: an inline panel cannot be carried to the next tab.
//
// PAYE is not here. It has three surfaces of its own — statement, payments and
// triage — and none of the other heads carry any of that.
//
// EVERY QUERY IS BOUNDED. The ranking reads one aggregated row per client
// (sql/222) and the detail is fetched for one client at a time. An earlier
// version pulled every detail row and rolled it up in the browser, which
// PostgREST silently truncated once Corporation Tax passed ~1,000 rows,
// under-reporting the book by £127,377.

const n = (v) => Number(v || 0);

export default function ByTaxView({ tax = 'corporation-tax', clients = [] }) {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const entityId = params.get('entity') || '';
  const [drill, setDrill] = useState(null);

  // Changing client or tax always starts you back at level 1.
  useEffect(() => { setDrill(null); }, [entityId, tax]);

  const chosen = clients.find((c) => c.entity_id === entityId);

  const pick = (id) => {
    const next = new URLSearchParams(params);
    if (id) next.set('entity', id); else next.delete('entity');
    setParams(next, { replace: false });
  };

  return (
    <div>
      <LevelTrail
        level={entityId ? (drill ? 2 : 1) : 0}
        taxKey={tax}
        clientName={chosen?.entity_name}
        onLevel0={() => navigate('/hmrc/all')}
        onLevel1={() => setDrill(null)}
        onClearClient={entityId ? () => pick('') : null}
      />

      {entityId
        ? <ClientTaxDetail tax={tax} entityId={entityId} name={chosen?.entity_name}
                           drill={drill} setDrill={setDrill} />
        : <RankedList tax={tax} onPick={pick} />}
    </div>
  );
}

// ── level 0-and-a-half: every client on this head ──────────────────
function RankedList({ tax, onPick }) {
  const [rows, setRows] = useState([]);
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
    supabase.from(VIEW).select('*').limit(2000)
      .then(({ data, error: e }) => {
        if (cancelled) return;
        if (e) setError(e.message); else setError('');
        setRows(data || []);
      })
      .then(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [VIEW]);

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
  const meta = TAX_META[tax];

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
        {meta.label} for every client, ranked. <b>Click a client</b> to open their own {meta.label} detail —
        they stay selected as you move between tax tabs. The practice-wide make-up of this figure is on
        the Breakdown tab.
      </p>

      {creditsHidden && (
        <div style={{
          fontSize: 12, color: '#0369a1', background: '#f0f9ff', border: '1px solid #bae6fd',
          borderRadius: 6, padding: '7px 10px', marginBottom: 12, maxWidth: 820, lineHeight: 1.55,
        }}>
          The total below counts the clients shown. {credits.clients} other client{credits.clients === 1 ? '' : 's'}
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
        <span style={{ fontSize: 12, color: '#64748b' }}>
          {filtered.length} shown · <b style={{ color: '#b91c1c' }}>{fmtGbpDetailed(sum('total'))}</b>
        </span>
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
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 && (
                  <tr><td colSpan={COLUMNS.length + 3} style={{ padding: 30, textAlign: 'center', color: '#94a3b8' }}>
                    No clients match.
                  </td></tr>
                )}
                {filtered.map((r) => (
                  <tr key={r.entity_id || r.reference} style={{ borderTop: '1px solid #f1f5f9' }}>
                    <td style={td}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        {r.unreadable && (
                          <TriangleAlert size={12} style={{ color: '#b45309', flexShrink: 0 }}
                            title="At least one period could not be parsed — treat its figures as unknown, not zero" />
                        )}
                        <button onClick={() => r.entity_id && onPick(r.entity_id)}
                          disabled={!r.entity_id}
                          title={r.entity_id
                            ? `Open ${r.name}'s ${meta.label} — what this figure is made of`
                            : 'Not matched to an Athena client, so there is nothing to open'}
                          style={{
                            background: 'none', border: 'none', padding: 0,
                            cursor: r.entity_id ? 'pointer' : 'default',
                            fontFamily: font, fontSize: 12.5, fontWeight: 500,
                            color: r.entity_id ? '#0f172a' : '#94a3b8', textAlign: 'left',
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

// ── level 1 and 2: one client, one tax ─────────────────────────────
function ClientTaxDetail({ tax, entityId, name, drill, setDrill }) {
  const [rows, setRows] = useState([]);
  const [moves, setMoves] = useState([]);
  const [txns, setTxns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const meta = TAX_META[tax];

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const detailView = tax === 'corporation-tax' ? 'v_hmrc_ct_periods'
      : tax === 'vat' ? 'v_hmrc_vat_owed' : 'v_hmrc_sa_position';
    const order = tax === 'corporation-tax' ? 'period_end'
      : tax === 'vat' ? 'period_to' : 'as_at';
    Promise.all([
      supabase.from(detailView).select('*').eq('entity_id', entityId)
        .order(order, { ascending: false, nullsFirst: false }).limit(2000),
      // The cash side of this head: what was paid, repaid, or moved in from
      // another tax. This is what level 2 shows.
      supabase.from('v_hmrc_money_movements').select('*')
        .eq('entity_id', entityId).eq('tax', tax)
        .order('txn_date', { ascending: false, nullsFirst: false }).limit(2000),
      tax === 'self-assessment'
        ? supabase.from('v_hmrc_sa_transactions').select('*').eq('entity_id', entityId)
            .order('txn_date', { ascending: false, nullsFirst: false }).limit(2000)
        : Promise.resolve({ data: [] }),
    ]).then(([d, m, t]) => {
      if (cancelled) return;
      const bad = [d, m, t].find((r) => r.error);
      setError(bad ? bad.error.message : '');
      setRows(d.data || []); setMoves(m.data || []); setTxns(t.data || []);
      setLoading(false);
    }).catch((e) => {
      if (cancelled) return;
      setError(e.message || 'Could not load this client');
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [tax, entityId]);

  if (loading) {
    return <div style={{ color: '#94a3b8', fontSize: 13, padding: 24 }}>Loading {name}&rsquo;s {meta.label}…</div>;
  }

  // A client can have no outstanding position and still have a payment history,
  // so an empty balance must not hide the ledger.
  if (rows.length === 0 && moves.length === 0 && txns.length === 0) {
    return (
      <>
        <ErrorBar message={error} />
        <div style={{ ...card, padding: 30, textAlign: 'center', color: '#94a3b8', fontSize: 13 }}>
          Nothing scraped for {name} on {meta.label}. Either they are not registered for it, or the scrape
          has not reached them — the banner above says when each head was last run.
        </div>
      </>
    );
  }

  const shared = { name, meta, moves, drill, setDrill };
  return (
    <>
      <ErrorBar message={error} />
      {tax === 'corporation-tax' && <CtDetail rows={rows} {...shared} />}
      {tax === 'vat' && <VatDetail rows={rows} {...shared} />}
      {tax === 'self-assessment' && <SaDetail rows={rows} txns={txns} {...shared} />}
    </>
  );
}

// A figure at level 1 that opens level 2 underneath it.
function Cell({ value, colour, bold, onClick, active, title, dashZero = true }) {
  const v = n(value);
  if (v === 0 && dashZero) return <span style={{ color: '#e2e8f0' }}>—</span>;
  return (
    <button
      onClick={onClick}
      title={title || ''}
      style={{
        background: active ? '#e0edfb' : 'none', border: 'none',
        padding: active ? '1px 5px' : '1px 0', borderRadius: 4,
        cursor: onClick ? 'pointer' : 'default', fontFamily: font, fontSize: 12,
        fontWeight: bold ? 700 : 400, color: colour || '#0f172a',
        fontVariantNumeric: 'tabular-nums',
        textDecoration: onClick ? 'underline' : 'none',
        textDecorationStyle: 'dotted', textDecorationColor: '#cbd5e1',
      }}
    >
      {fmtGbpDetailed(v)}
    </button>
  );
}

// ── Corporation Tax: one row per accounting period ─────────────────
function CtDetail({ rows, name, meta, moves, drill, setDrill }) {
  const total = (k) => rows.reduce((s, r) => s + n(r[k]), 0);

  return (
    <div style={card}>
      <Head title={`${name} — Corporation Tax by accounting period`}
            sub={`${rows.length} period${rows.length === 1 ? '' : 's'}, newest first · click a figure for the payments and reallocations behind it`} />
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse', whiteSpace: 'nowrap' }}>
          <thead>
            <tr style={{ background: '#f8fafc', color: '#64748b', fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.4 }}>
              <th style={th}>Period end</th><th style={th}>Status</th>
              <th style={thNum}>Tax</th><th style={thNum}>Interest</th><th style={thNum}>Penalties</th>
              <th style={thNum}>Paid</th><th style={thNum}>Repaid / realloc</th>
              <th style={thNum}>Adjustments</th>
              <th style={{ ...thNum, borderLeft: '1px solid #e5e7eb' }}>Outstanding</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p, i) => {
              const key = `${p.period_end}-${i}`;
              const open = drill?.key === key;
              const hit = () => setDrill(open ? null : { key, period: p.period_end, label: shortDate(p.period_end) });
              return (
                <React.Fragment key={key}>
                  <tr style={{ borderTop: '1px solid #f1f5f9', background: p.unreadable ? '#fffbeb' : undefined }}>
                    <td style={td}>
                      {shortDate(p.period_end)}
                      {p.unreadable && <span style={{ fontSize: 10, color: '#b45309', fontWeight: 600, marginLeft: 5 }}>unreadable</span>}
                    </td>
                    <td style={{ ...td, color: '#64748b', fontSize: 11.5 }}>{p.status || '—'}</td>
                    <td style={tdNum}><Cell value={p.tax} onClick={hit} active={open} title="The transactions on this period" /></td>
                    <td style={tdNum}><Cell value={p.interest} colour="#c2410c" onClick={hit} active={open} /></td>
                    <td style={tdNum}><Cell value={p.penalties} colour="#b91c1c" onClick={hit} active={open} /></td>
                    <td style={tdNum}><Cell value={p.less_paid} colour="#059669" onClick={hit} active={open} /></td>
                    <td style={tdNum}><Cell value={p.repayments_reallocations} colour="#7c3aed" onClick={hit} active={open} /></td>
                    <td style={tdNum}><Cell value={p.adjustments} colour="#64748b" onClick={hit} active={open} /></td>
                    <td style={{ ...tdNum, borderLeft: '1px solid #f1f5f9' }}>
                      <Cell value={p.total} bold dashZero={false} onClick={hit} active={open}
                            colour={n(p.total) > 0 ? '#b91c1c' : '#0f172a'} />
                    </td>
                  </tr>
                  {open && (
                    <tr style={{ background: '#f8fafc' }}>
                      <td colSpan={9} style={{ padding: '10px 14px' }}>
                        <Movements moves={moves} match={(m) => m.period === p.period_end}
                                   label={`Corporation Tax · accounting period to ${shortDate(p.period_end)}`}
                                   onClose={() => setDrill(null)} />
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
          <tfoot>
            <tr style={{ borderTop: '2px solid #e5e7eb', background: '#f8fafc', fontWeight: 700 }}>
              <td style={td} colSpan={2}>{rows.length} periods</td>
              {['tax', 'interest', 'penalties', 'less_paid', 'repayments_reallocations', 'adjustments'].map((k) => (
                <td key={k} style={tdNum}>{fmtGbpDetailed(total(k))}</td>
              ))}
              <td style={{ ...tdNum, borderLeft: '1px solid #e5e7eb', color: total('total') > 0 ? '#b91c1c' : '#0f172a' }}>
                {fmtGbpDetailed(total('total'))}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
      <Foot>
        Outstanding is HMRC&rsquo;s own figure for the period, not tax less paid — HMRC applies adjustments of
        its own, and they are shown in their own column rather than absorbed.
      </Foot>
    </div>
  );
}

// ── VAT: one row per period, lines and cash underneath ─────────────
function VatDetail({ rows, name, meta, moves, drill, setDrill }) {
  // HMRC gives us a line per outstanding item. A period is the unit anyone
  // actually thinks in — a return, its assessment, its surcharge — so group to
  // it and keep the lines for the level below.
  const periods = useMemo(() => {
    const by = new Map();
    for (const l of rows) {
      const key = l.period_from && l.period_to ? `${l.period_from} to ${l.period_to}` : 'No period given';
      if (!by.has(key)) {
        by.set(key, { key, from: l.period_from, to: l.period_to, lines: [], amount: 0, overdue: 0, assessed: 0 });
      }
      const p = by.get(key);
      p.lines.push(l);
      p.amount += n(l.amount);
      if (l.overdue) p.overdue += 1;
      if (l.estimated) p.assessed += 1;
    }
    return [...by.values()].sort((a, b) => String(b.to || '').localeCompare(String(a.to || '')));
  }, [rows]);

  const grand = periods.reduce((s, p) => s + p.amount, 0);

  return (
    <div style={card}>
      <Head title={`${name} — VAT by period`}
            sub={`${periods.length} period${periods.length === 1 ? '' : 's'} outstanding, ${rows.length} line${rows.length === 1 ? '' : 's'} · click an amount for the lines and the cash behind it`} />
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse', whiteSpace: 'nowrap' }}>
          <thead>
            <tr style={{ background: '#f8fafc', color: '#64748b', fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.4 }}>
              <th style={th}>Period</th>
              <th style={{ ...th, textAlign: 'center' }}>Lines</th>
              <th style={th}>Flags</th>
              <th style={{ ...thNum, borderLeft: '1px solid #e5e7eb' }}>Outstanding</th>
            </tr>
          </thead>
          <tbody>
            {periods.map((p) => {
              const open = drill?.key === p.key;
              const hit = () => setDrill(open ? null : { key: p.key, label: p.key });
              return (
                <React.Fragment key={p.key}>
                  <tr style={{ borderTop: '1px solid #f1f5f9', background: p.overdue ? '#fffbfa' : undefined }}>
                    <td style={td}>
                      {p.from ? `${shortDate(p.from)} – ${shortDate(p.to)}` : 'No period given'}
                    </td>
                    <td style={{ ...td, textAlign: 'center', color: '#64748b' }}>{p.lines.length}</td>
                    <td style={td}>
                      <div style={{ display: 'flex', gap: 4 }}>
                        {p.overdue > 0 && <Pill colour="#b91c1c" style={{ fontSize: 10 }}>{p.overdue} overdue</Pill>}
                        {p.assessed > 0 && (
                          <Pill colour="#c2410c" style={{ fontSize: 10 }}
                                title="HMRC has estimated this because no return was filed. Paying it does not file the return">
                            {p.assessed} assessed
                          </Pill>
                        )}
                      </div>
                    </td>
                    <td style={{ ...tdNum, borderLeft: '1px solid #f1f5f9' }}>
                      <Cell value={p.amount} bold dashZero={false} onClick={hit} active={open}
                            colour={p.amount > 0 ? '#b91c1c' : '#059669'}
                            title="The lines HMRC raised, and every payment or repayment on this period" />
                    </td>
                  </tr>
                  {open && (
                    <tr style={{ background: '#f8fafc' }}>
                      <td colSpan={4} style={{ padding: '10px 14px' }}>
                        <div style={{ fontSize: 11, fontWeight: 700, color: '#0f172a', textTransform: 'uppercase',
                                      letterSpacing: 0.4, marginBottom: 6 }}>
                          What HMRC raised
                        </div>
                        <table style={{ fontSize: 11.5, borderCollapse: 'collapse', minWidth: 520, background: '#fff' }}>
                          <thead>
                            <tr style={{ color: '#94a3b8', fontSize: 9.5, textTransform: 'uppercase' }}>
                              <th style={{ ...th, padding: '3px 12px 3px 0' }}>Description</th>
                              <th style={{ ...th, padding: '3px 12px' }}>Kind</th>
                              <th style={{ ...th, padding: '3px 12px' }}>Flags</th>
                              <th style={{ ...thNum, padding: '3px 0 3px 12px' }}>Amount</th>
                            </tr>
                          </thead>
                          <tbody>
                            {p.lines.map((l, i) => (
                              <tr key={i} style={{ borderTop: '1px solid #eef2f6' }}>
                                <td style={{ padding: '3px 12px 3px 0', color: '#475569', whiteSpace: 'normal', maxWidth: 420 }}>
                                  {l.description}
                                </td>
                                <td style={{ padding: '3px 12px', color: '#94a3b8' }}>{l.kind || '—'}</td>
                                <td style={{ padding: '3px 12px', color: '#94a3b8' }}>
                                  {[l.overdue ? 'overdue' : null, l.estimated ? 'assessed' : null].filter(Boolean).join(' · ') || '—'}
                                </td>
                                <td style={{ padding: '3px 0 3px 12px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                                  {fmtGbpDetailed(l.amount)}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        <div style={{ marginTop: 12 }}>
                          <Movements moves={moves} match={(m) => m.period === p.key}
                                     label={`VAT · ${p.from ? `${shortDate(p.from)} – ${shortDate(p.to)}` : 'no period'}`}
                                     onClose={() => setDrill(null)} />
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
          <tfoot>
            <tr style={{ borderTop: '2px solid #e5e7eb', background: '#f8fafc', fontWeight: 700 }}>
              <td style={td} colSpan={3}>{periods.length} periods</td>
              <td style={{ ...tdNum, borderLeft: '1px solid #e5e7eb', color: grand > 0 ? '#b91c1c' : '#059669' }}>
                {fmtGbpDetailed(grand)}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
      <Foot>
        An assessment and an unpaid return are different problems. An assessment means no return was filed and
        HMRC has estimated it — paying it settles the money but leaves the return outstanding.
      </Foot>
    </div>
  );
}

// ── Self Assessment: the statement, then the years ─────────────────
function SaDetail({ rows, txns, name, meta, moves, drill, setDrill }) {
  const p = rows[0];

  // HMRC's SA statement is a single position, so the level below it is the tax
  // years its transactions belong to — which is where a CIS case is legible:
  // credit built on PAYE, moved across, year by year.
  const years = useMemo(() => {
    const by = new Map();
    for (const t of txns) {
      const key = t.tax_year_ending || 'Unattributed';
      if (!by.has(key)) by.set(key, { key, paid: 0, repaid: 0, creditIn: 0, other: 0, count: 0 });
      const y = by.get(key);
      y.count += 1;
      if (t.movement === 'paid_by_client') y.paid += n(t.amount);
      else if (t.movement === 'cash_to_client') y.repaid += n(t.amount);
      else if (t.movement === 'from_another_tax') y.creditIn += n(t.amount);
      else y.other += n(t.amount);
    }
    return [...by.values()].sort((a, b) => String(b.key).localeCompare(String(a.key)));
  }, [txns]);

  return (
    <>
      <div style={{ ...card, marginBottom: 12 }}>
        <Head title={`${name} — Self Assessment statement`}
              sub={p?.as_at ? `as at ${shortDate(p.as_at)}` : 'HMRC gave no statement date'} />
        {!p ? (
          <div style={{ padding: '14px', fontSize: 12, color: '#94a3b8' }}>
            No statement held — the years below are built from the transactions HMRC does show.
          </div>
        ) : (
          <div style={{ padding: '10px 14px' }}>
            <table style={{ fontSize: 12.5, borderCollapse: 'collapse', minWidth: 400 }}>
              <tbody>
                {[['Tax', p.tax], ['Surcharges', p.surcharges], ['Interest', p.interest],
                  ['Penalties', p.penalties], ['Total', p.total], ['Amount due', p.amount_due],
                  ['Available for repayment', p.available_for_repayment]].map(([label, v]) => (
                  <tr key={label} style={{ borderTop: '1px solid #f1f5f9' }}>
                    <td style={{ padding: '4px 14px 4px 0', color: label === 'Amount due' ? '#0f172a' : '#64748b',
                                 fontWeight: label === 'Amount due' ? 600 : 400 }}>{label}</td>
                    <td style={{ padding: '4px 0', textAlign: 'right', fontVariantNumeric: 'tabular-nums',
                                 fontWeight: label === 'Amount due' ? 700 : 400,
                                 color: label === 'Available for repayment' && n(v) > 0 ? '#0369a1'
                                      : n(v) > 0 && label === 'Amount due' ? '#b91c1c' : '#0f172a' }}>
                      {fmtGbpDetailed(v)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {p.statement_available === false && (
              <div style={{ fontSize: 11.5, color: '#b45309', marginTop: 8 }}>
                HMRC would not show the statement, so a zero here is unknown rather than nil.
              </div>
            )}
          </div>
        )}
      </div>

      <div style={card}>
        <Head title="By tax year"
              sub="click a figure for the individual payments and credits" />
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse', whiteSpace: 'nowrap' }}>
            <thead>
              <tr style={{ background: '#f8fafc', color: '#64748b', fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.4 }}>
                <th style={th}>Tax year ending</th>
                <th style={{ ...th, textAlign: 'center' }}>Movements</th>
                <th style={thNum}>Paid by client</th>
                <th style={thNum}>Repaid out</th>
                <th style={thNum}>Credit in from another tax</th>
                <th style={thNum}>Other credits</th>
              </tr>
            </thead>
            <tbody>
              {years.length === 0 && (
                <tr><td colSpan={6} style={{ padding: 24, textAlign: 'center', color: '#94a3b8' }}>
                  No Self Assessment transactions held for this client.
                </td></tr>
              )}
              {years.map((y) => {
                const open = drill?.key === y.key;
                const hit = () => setDrill(open ? null : { key: y.key, label: y.key });
                return (
                  <React.Fragment key={y.key}>
                    <tr style={{ borderTop: '1px solid #f1f5f9' }}>
                      <td style={{ ...td, fontWeight: 600 }}>{y.key}</td>
                      <td style={{ ...td, textAlign: 'center', color: '#64748b' }}>{y.count}</td>
                      <td style={tdNum}><Cell value={y.paid} onClick={hit} active={open} /></td>
                      <td style={tdNum}><Cell value={y.repaid} colour="#059669" onClick={hit} active={open} /></td>
                      <td style={tdNum}><Cell value={y.creditIn} colour="#7c3aed" onClick={hit} active={open}
                                              title="The CIS pattern: credit built on PAYE, moved across to settle Self Assessment" /></td>
                      <td style={tdNum}><Cell value={y.other} colour="#64748b" onClick={hit} active={open} /></td>
                    </tr>
                    {open && (
                      <tr style={{ background: '#f8fafc' }}>
                        <td colSpan={6} style={{ padding: '10px 14px' }}>
                          <SaLedger txns={txns.filter((t) => (t.tax_year_ending || 'Unattributed') === y.key)}
                                    label={`Self Assessment · ${y.key}`} onClose={() => setDrill(null)} />
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
        <Foot>
          Cash and credit are kept apart on purpose. A &ldquo;Payment&rdquo; left the client&rsquo;s bank; an
          &ldquo;Overpayment from return&rdquo; is a credit that arose from the return itself. Adding them
          together would overstate what the client has actually paid.
        </Foot>
      </div>
    </>
  );
}

// ── level 2: the money ─────────────────────────────────────────────
const MOVEMENT_META = {
  paid_by_client:   { label: 'Paid by client',      colour: '#0f172a', hint: 'Money the client actually paid HMRC' },
  cash_to_client:   { label: 'Repaid to client',    colour: '#059669', hint: 'HMRC repaid this to the client' },
  from_another_tax: { label: 'In from another tax', colour: '#7c3aed', hint: 'Credit moved across from another tax head' },
  to_another_tax:   { label: 'Out to another tax',  colour: '#c2410c', hint: 'Credit moved away to another tax head' },
  internal_ct:      { label: 'Between CT periods',  colour: '#64748b', hint: 'Moved between accounting periods of the same tax' },
  other:            { label: 'Other',               colour: '#94a3b8' },
  unclear:          { label: 'Unclear',             colour: '#94a3b8' },
};

function Movements({ moves, match, label, onClose }) {
  const mine = moves.filter(match);
  return (
    <>
      <DrillHead title={label} sub={`${mine.length} movement${mine.length === 1 ? '' : 's'}`} onClose={onClose} />
      {mine.length === 0 ? (
        <div style={{ fontSize: 12, color: '#94a3b8', lineHeight: 1.5, maxWidth: 640 }}>
          HMRC records no payment or reallocation against this period. For an unpaid period that is the
          point; for a settled one it means HMRC has not itemised how it was cleared.
        </div>
      ) : (
        <table style={{ fontSize: 11.5, borderCollapse: 'collapse', minWidth: 560, background: '#fff' }}>
          <thead>
            <tr style={{ color: '#94a3b8', fontSize: 9.5, textTransform: 'uppercase' }}>
              <th style={{ ...th, padding: '3px 12px 3px 0' }}>Date</th>
              <th style={{ ...th, padding: '3px 12px' }}>What</th>
              <th style={{ ...th, padding: '3px 12px' }}>HMRC description</th>
              <th style={{ ...thNum, padding: '3px 0 3px 12px' }}>Amount</th>
            </tr>
          </thead>
          <tbody>
            {mine.map((m, i) => {
              const mm = MOVEMENT_META[m.movement] || MOVEMENT_META.other;
              return (
                <tr key={i} style={{ borderTop: '1px solid #eef2f6' }}>
                  <td style={{ padding: '3px 12px 3px 0', color: '#475569', whiteSpace: 'nowrap' }}>{shortDate(m.txn_date)}</td>
                  <td style={{ padding: '3px 12px' }}>
                    <Pill colour={mm.colour} style={{ fontSize: 9.5 }} title={mm.hint}>{mm.label}</Pill>
                  </td>
                  <td style={{ padding: '3px 12px', color: '#64748b', whiteSpace: 'normal', maxWidth: 420 }}>{m.description}</td>
                  <td style={{ padding: '3px 0 3px 12px', textAlign: 'right', fontVariantNumeric: 'tabular-nums',
                               color: mm.colour, fontWeight: 600 }}>
                    {fmtGbpDetailed(m.amount)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </>
  );
}

function SaLedger({ txns, label, onClose }) {
  return (
    <>
      <DrillHead title={label} sub={`${txns.length} movement${txns.length === 1 ? '' : 's'}`} onClose={onClose} />
      <table style={{ fontSize: 11.5, borderCollapse: 'collapse', minWidth: 560, background: '#fff' }}>
        <thead>
          <tr style={{ color: '#94a3b8', fontSize: 9.5, textTransform: 'uppercase' }}>
            <th style={{ ...th, padding: '3px 12px 3px 0' }}>Date</th>
            <th style={{ ...th, padding: '3px 12px' }}>What</th>
            <th style={{ ...th, padding: '3px 12px' }}>HMRC description</th>
            <th style={{ ...thNum, padding: '3px 0 3px 12px' }}>Amount</th>
          </tr>
        </thead>
        <tbody>
          {txns.map((t, i) => {
            const mm = MOVEMENT_META[t.movement] || MOVEMENT_META.other;
            return (
              <tr key={i} style={{ borderTop: '1px solid #eef2f6' }}>
                <td style={{ padding: '3px 12px 3px 0', color: '#475569', whiteSpace: 'nowrap' }}>{shortDate(t.txn_date)}</td>
                <td style={{ padding: '3px 12px' }}>
                  <Pill colour={mm.colour} style={{ fontSize: 9.5 }} title={mm.hint}>{t.label || mm.label}</Pill>
                </td>
                <td style={{ padding: '3px 12px', color: '#64748b', whiteSpace: 'normal', maxWidth: 420 }}>{t.description}</td>
                <td style={{ padding: '3px 0 3px 12px', textAlign: 'right', fontVariantNumeric: 'tabular-nums',
                             color: mm.colour, fontWeight: 600 }}>
                  {/* Signed so the direction reads at a glance: out to the client
                      is money leaving HMRC's account. */}
                  {t.movement === 'cash_to_client' ? '−' : ''}{fmtGbpDetailed(t.amount)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}

function Head({ title, sub }) {
  return (
    <div style={{ padding: '11px 14px', borderBottom: '1px solid #f1f5f9', display: 'flex',
                  alignItems: 'baseline', gap: 9, flexWrap: 'wrap' }}>
      <span style={{ fontSize: 13, fontWeight: 700, color: '#0f172a' }}>{title}</span>
      {sub && <span style={{ fontSize: 11.5, color: '#94a3b8' }}>{sub}</span>}
    </div>
  );
}

function DrillHead({ title, sub, onClose }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
      <span style={{ fontSize: 12, fontWeight: 700, color: '#0f172a' }}>{title}</span>
      {sub && <span style={{ fontSize: 11, color: '#94a3b8' }}>{sub}</span>}
      <button onClick={onClose} style={{
        marginLeft: 'auto', fontSize: 11, color: '#64748b', background: 'none',
        border: 'none', cursor: 'pointer', fontFamily: font,
      }}>close</button>
    </div>
  );
}

function Foot({ children }) {
  return (
    <div style={{ padding: '9px 14px', borderTop: '1px solid #f1f5f9', background: '#f8fafc',
                  fontSize: 11.5, color: '#64748b', lineHeight: 1.5 }}>
      {children}
    </div>
  );
}
