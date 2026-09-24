import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Download, TriangleAlert } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { fetchAllRows } from '../../lib/fetchAllRows';
import { fmtGbpDetailed } from '../../lib/money';
import { downloadCSV } from '../../lib/exportUtils';
import SearchInput from '../../components/SearchInput';
import AlphabetFilter, { firstCharBucket } from '../../components/AlphabetFilter';
import DataTable from '../../components/DataTable';
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

// The order DataTable puts rows in, so the export matches the screen.
function sortLike(list, columns, sort) {
  const col = columns.find((c) => c.key === sort?.key);
  if (!col) return list;
  const get = col.sortValue || ((r) => r[col.key]);
  const dir = sort.dir === 'desc' ? -1 : 1;
  return [...list].sort((a, b) => {
    const va = get(a); const vb = get(b);
    const ea = va == null || va === ''; const eb = vb == null || vb === '';
    if (ea || eb) return ea === eb ? 0 : ea ? 1 : -1;
    if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir;
    return String(va).localeCompare(String(vb), 'en-GB', { numeric: true, sensitivity: 'base' }) * dir;
  });
}

// ── level 0-and-a-half: every client on this head ──────────────────
function RankedList({ tax, onPick }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [letter, setLetter] = useState(null);
  const [owingOnly, setOwingOnly] = useState(true);
  // Sorting is on the column headings. Total owed, largest first, is the
  // default it always was.
  const [sort, setSort] = useState({ key: 'total', dir: 'desc' });
  const [page, setPage] = useState(1);

  const onSearch = (v) => { setSearch(v); setPage(1); };
  const onLetter = (v) => { setLetter(v); setPage(1); };

  const VIEW = {
    'corporation-tax': 'v_hmrc_ct_by_client',
    'vat': 'v_hmrc_vat_by_client',
    'self-assessment': 'v_hmrc_sa_by_client',
  }[tax];

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    // A new head has different columns, so start again from its default.
    setSort({ key: 'total', dir: 'desc' });
    setPage(1);
    // One row per client per tax (sql/222), but PostgREST still caps a fetch at
    // 1000 and truncates SILENTLY — `.limit(2000)` does not raise it — so page
    // through the lot. Unmatched rows have no entity_id, hence the tie-breakers.
    fetchAllRows(() => supabase.from(VIEW).select('*')
      .order('entity_id', { nullsFirst: false }).order('reference').order('name'))
      .then((data) => { if (!cancelled) { setError(''); setRows(data); } })
      .catch((e) => { if (!cancelled) { setError(e.message || 'Could not load this tax'); setRows([]); } })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [VIEW]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    // The table does the sorting, from the column headings.
    return rows.filter((r) => {
      const name = r.name || '';
      if (letter && letter !== 'All' && firstCharBucket(name) !== letter) return false;
      if (owingOnly && n(r.total) <= 0 && n(r.credit) <= 0) return false;
      if (q && !`${name} ${r.reference || ''}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [rows, search, letter, owingOnly]);

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

  // Per-head columns. `get` is what is shown and exported; `sort` is what the
  // heading sorts on where that differs (dates, and "3/5" period counts).
  // Every option the old sort menu offered is one of these headings.
  const COLUMNS = {
    'corporation-tax': [
      { key: 'periods',       label: 'Periods',        get: (r) => `${r.unpaid_periods}/${r.periods}`, kind: 'c', sort: (r) => n(r.unpaid_periods) },
      { key: 'oldest_unpaid', label: 'Oldest unpaid',  get: (r) => shortDate(r.oldest_unpaid), kind: 'c', sort: (r) => r.oldest_unpaid },
      { key: 'tax_amount',    label: 'Tax',            get: (r) => r.tax_amount, kind: 'n' },
      { key: 'interest',      label: 'Interest',       get: (r) => r.interest, kind: 'n' },
      { key: 'penalties',     label: 'Penalties',      get: (r) => r.penalties, kind: 'n' },
      { key: 'paid',          label: 'Paid',           get: (r) => r.paid, kind: 'n' },
      { key: 'moved',         label: 'Repaid/realloc', get: (r) => r.moved, kind: 'n' },
    ],
    'vat': [
      { key: 'lines',          label: 'Lines',          get: (r) => r.lines, kind: 'c', sort: (r) => n(r.lines) },
      { key: 'overdue_lines',  label: 'Overdue',        get: (r) => r.overdue_lines || '—', kind: 'c', sort: (r) => n(r.overdue_lines) },
      { key: 'assessed_lines', label: 'Assessed',       get: (r) => r.assessed_lines || '—', kind: 'c', sort: (r) => n(r.assessed_lines) },
      { key: 'assessed_value', label: 'Assessed value', get: (r) => r.assessed_value, kind: 'n' },
      { key: 'oldest_unpaid',  label: 'Oldest unpaid',  get: (r) => shortDate(r.oldest_unpaid), kind: 'c', sort: (r) => r.oldest_unpaid },
    ],
    'self-assessment': [
      { key: 'tax_amount', label: 'Tax',         get: (r) => r.tax_amount, kind: 'n' },
      { key: 'surcharges', label: 'Surcharges',  get: (r) => r.surcharges, kind: 'n' },
      { key: 'interest',   label: 'Interest',    get: (r) => r.interest, kind: 'n' },
      { key: 'penalties',  label: 'Penalties',   get: (r) => r.penalties, kind: 'n' },
      { key: 'credit',     label: 'Credit held', get: (r) => r.credit, kind: 'n' },
      { key: 'paid',       label: 'Paid',        get: (r) => r.paid, kind: 'n' },
      { key: 'repaid',     label: 'Repaid out',  get: (r) => r.repaid, kind: 'n' },
      { key: 'credit_in',  label: 'Credit in',   get: (r) => r.credit_in, kind: 'n' },
      { key: 'last_paid',  label: 'Last paid',   get: (r) => shortDate(r.last_paid), kind: 'c', sort: (r) => r.last_paid },
      { key: 'as_at',      label: 'As at',       get: (r) => shortDate(r.as_at), kind: 'c', sort: (r) => r.as_at },
    ],
  }[tax];

  const columns = [
    {
      key: 'name', label: 'Client',
      sortValue: (r) => r.name || '',
      render: (r) => (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
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
              fontFamily: font, fontSize: 13.5, fontWeight: 500,
              color: r.entity_id ? '#0f172a' : '#94a3b8', textAlign: 'left',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0,
            }}>
            {r.name}
          </button>
          {r.no_statement && (
            <Pill colour="#b45309" style={{ fontSize: 11, flexShrink: 0 }}
              title="HMRC would not show the statement, so a zero here is unknown rather than nil">
              No statement
            </Pill>
          )}
        </div>
      ),
    },
    {
      key: 'reference', label: 'Reference', width: 140,
      render: (r) => <span style={{ fontSize: 12.5, color: '#64748b' }}>{r.reference}</span>,
    },
    ...COLUMNS.map((c) => (c.kind === 'n' ? {
      key: c.key, label: c.label, align: 'right', width: 120,
      sortValue: (r) => n(c.get(r)),
      render: (r) => {
        const v = c.get(r);
        return (
          <span style={{ color: n(v) ? '#0f172a' : '#e2e8f0', fontVariantNumeric: 'tabular-nums' }}>
            {n(v) ? fmtGbpDetailed(v) : '—'}
          </span>
        );
      },
    } : {
      key: c.key, label: c.label, align: 'center', width: 115,
      sortValue: c.sort,
      render: (r) => <span style={{ fontSize: 12.5, color: '#64748b' }}>{c.get(r) ?? '—'}</span>,
    })),
    {
      key: 'total', label: 'Total owed', align: 'right', width: 130,
      sortValue: (r) => n(r.total),
      render: (r) => (
        <span style={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums',
                       color: n(r.total) > 0 ? '#b91c1c' : n(r.total) < 0 ? '#059669' : '#0f172a' }}>
          {fmtGbpDetailed(r.total)}
        </span>
      ),
    },
  ];

  // Totals over every filtered row, not just the page on screen.
  const footer = (set) => ({
    name: `${set.length} clients`,
    ...Object.fromEntries(COLUMNS.filter((c) => c.kind === 'n').map((c) => [
      c.key, fmtGbpDetailed(set.reduce((s, r) => s + n(c.get(r)), 0)),
    ])),
    total: <span style={{ color: '#b91c1c' }}>{fmtGbpDetailed(sum('total', set))}</span>,
  });

  // Enough room for every column before the table scrolls sideways.
  const minWidth = 280 + 140 + 130 + COLUMNS.reduce((s, c) => s + (c.kind === 'n' ? 120 : 115), 0);

  const exportCsv = () => {
    downloadCSV(
      `hmrc-${tax}-${new Date().toISOString().slice(0, 10)}.csv`,
      ['Client', 'Reference', ...COLUMNS.map((c) => c.label), 'Total owed'],
      sortLike(filtered, columns, sort).map((r) => [
        r.name || '', r.reference || '',
        ...COLUMNS.map((c) => {
          const v = c.get(r);
          return c.kind === 'n' ? n(v).toFixed(2) : String(v ?? '');
        }),
        n(r.total).toFixed(2),
      ]),
    );
  };

  return (
    <div>
      <ErrorBar message={error} />

      <p style={{ fontSize: 14, color: '#64748b', maxWidth: 900, marginTop: 0, marginBottom: 12, lineHeight: 1.55 }}>
        {meta.label} for every client, ranked. <b>Click a client</b> to open their own {meta.label} detail —
        they stay selected as you move between tax tabs. The practice-wide make-up of this figure is on
        the Breakdown tab.
      </p>

      {creditsHidden && (
        <div style={{
          fontSize: 13, color: '#0369a1', background: '#f0f9ff', border: '1px solid #bae6fd',
          borderRadius: 6, padding: '7px 10px', marginBottom: 12, maxWidth: 820, lineHeight: 1.55,
        }}>
          The total below counts the clients shown. {credits.clients} other client{credits.clients === 1 ? '' : 's'}
          {' '}hold {fmtGbpDetailed(Math.abs(credits.value))} of credit, hidden by the filter. Net across all
          {' '}{credits.all}: <b>{fmtGbpDetailed(credits.net)}</b> — the figure on the All taxes tab. Untick
          {' '}<i>with a balance only</i> to reconcile the two.
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, marginBottom: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        <SearchInput value={search} onChange={onSearch} placeholder="Client or reference…" style={{ minWidth: 240 }} />
        <label style={{ fontSize: 13, color: '#64748b', fontFamily: font, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <input type="checkbox" checked={owingOnly} onChange={(e) => { setOwingOnly(e.target.checked); setPage(1); }} />
          With a balance only
        </label>
        <span style={{ fontSize: 13, color: '#64748b' }}>
          {filtered.length} shown · <b style={{ color: '#b91c1c' }}>{fmtGbpDetailed(sum('total'))}</b>
        </span>
        <div style={{ flex: 1 }} />
        <button onClick={exportCsv} disabled={filtered.length === 0}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 5, padding: '6px 12px',
            fontSize: 13, fontFamily: font, color: '#475569', background: '#fff',
            border: '1px solid #e5e7eb', borderRadius: 8,
            cursor: filtered.length ? 'pointer' : 'default', opacity: filtered.length ? 1 : 0.5,
          }}>
          <Download size={12} /> Export for Excel
        </button>
      </div>

      <AlphabetFilter items={rows} nameKey="name" selected={letter} onChange={onLetter} />

      {loading ? (
        <div style={{ color: '#94a3b8', fontSize: 14, padding: 24 }}>Loading {meta.label}…</div>
      ) : (
        <div style={{ marginTop: 8 }}>
          <div style={{ overflowX: 'auto' }}>
            <div style={{ minWidth }}>
              <DataTable
                columns={columns}
                rows={filtered}
                rowKey={(r) => r.entity_id || r.reference}
                sort={sort}
                onSort={(s) => { setSort(s); setPage(1); }}
                page={page}
                onPage={setPage}
                footer={footer}
                empty="No clients match."
              />
            </div>
          </div>

          {orphaned.rows > 0 && (
            <div style={{
              border: '1px solid #fde68a', borderRadius: 8, background: '#fffbeb', padding: '9px 14px',
              marginTop: 10, fontSize: 13, color: '#78350f', lineHeight: 1.5, whiteSpace: 'normal',
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
    return <div style={{ color: '#94a3b8', fontSize: 14, padding: 24 }}>Loading {name}&rsquo;s {meta.label}…</div>;
  }

  // A client can have no outstanding position and still have a payment history,
  // so an empty balance must not hide the ledger.
  if (rows.length === 0 && moves.length === 0 && txns.length === 0) {
    return (
      <>
        <ErrorBar message={error} />
        <div style={{ ...card, padding: 30, textAlign: 'center', color: '#94a3b8', fontSize: 14 }}>
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
        cursor: onClick ? 'pointer' : 'default', fontFamily: font, fontSize: 13,
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
        <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse', whiteSpace: 'nowrap' }}>
          <thead>
            <tr style={{ background: '#f8fafc', color: '#64748b', fontSize: 11 }}>
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
                      {p.unreadable && <span style={{ fontSize: 11, color: '#b45309', fontWeight: 600, marginLeft: 5 }}>unreadable</span>}
                    </td>
                    <td style={{ ...td, color: '#64748b', fontSize: 12.5 }}>{p.status || '—'}</td>
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
        <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse', whiteSpace: 'nowrap' }}>
          <thead>
            <tr style={{ background: '#f8fafc', color: '#64748b', fontSize: 11 }}>
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
                        {p.overdue > 0 && <Pill colour="#b91c1c" style={{ fontSize: 11 }}>{p.overdue} overdue</Pill>}
                        {p.assessed > 0 && (
                          <Pill colour="#c2410c" style={{ fontSize: 11 }}
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
                        <div style={{ fontSize: 12, fontWeight: 700, color: '#0f172a', marginBottom: 6 }}>
                          What HMRC raised
                        </div>
                        <table style={{ fontSize: 12.5, borderCollapse: 'collapse', minWidth: 520, background: '#fff' }}>
                          <thead>
                            <tr style={{ color: '#94a3b8', fontSize: 10.5 }}>
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
          <div style={{ padding: '14px', fontSize: 13, color: '#94a3b8' }}>
            No statement held — the years below are built from the transactions HMRC does show.
          </div>
        ) : (
          <div style={{ padding: '10px 14px' }}>
            <table style={{ fontSize: 13.5, borderCollapse: 'collapse', minWidth: 400 }}>
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
              <div style={{ fontSize: 12.5, color: '#b45309', marginTop: 8 }}>
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
          <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse', whiteSpace: 'nowrap' }}>
            <thead>
              <tr style={{ background: '#f8fafc', color: '#64748b', fontSize: 11 }}>
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

// `paymentsHeld` says whether the scrape holds this head's payments, because the
// empty state means opposite things either way. Every head now does, so nothing
// passes false — Corporation Tax was the exception for a year, because the
// scrape read HMRC's Tax and Repayments/Reallocations breakdowns and never the
// Less paid one. LJM Gas Glasgow's period to 31 Dec 2023 showed 8 movements
// against HMRC's 23. The flag stays because the distinction is real and the next
// head we add may arrive half-fed: an empty panel that means "HMRC itemised
// nothing" and one that means "we did not fetch it" must not read the same.
function Movements({ moves, match, label, onClose, paymentsHeld = true }) {
  const mine = moves.filter(match);
  return (
    <>
      <DrillHead title={label} sub={`${mine.length} movement${mine.length === 1 ? '' : 's'}`} onClose={onClose} />
      {!paymentsHeld && (
        <div style={{ fontSize: 12.5, color: '#b45309', background: '#fffbeb', border: '1px solid #fde68a',
                      borderRadius: 4, padding: '6px 10px', marginBottom: 8, lineHeight: 1.45, maxWidth: 640 }}>
          Reallocations only. The scrape does not yet read HMRC&rsquo;s &ldquo;Less paid&rdquo; breakdown, so
          payments against this period are missing here even though the Paid column above counts them.
        </div>
      )}
      {mine.length === 0 ? (
        <div style={{ fontSize: 13, color: '#94a3b8', lineHeight: 1.5, maxWidth: 640 }}>
          {paymentsHeld
            ? `HMRC records no payment or reallocation against this period. For an unpaid period that is the
               point; for a settled one it means HMRC has not itemised how it was cleared.`
            : `HMRC records no reallocation against this period. If it was settled, it was settled by payments —
               see the note above.`}
        </div>
      ) : (
        <table style={{ fontSize: 12.5, borderCollapse: 'collapse', minWidth: 560, background: '#fff' }}>
          <thead>
            <tr style={{ color: '#94a3b8', fontSize: 10.5 }}>
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
                    <Pill colour={mm.colour} style={{ fontSize: 10.5 }} title={mm.hint}>{mm.label}</Pill>
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
      <table style={{ fontSize: 12.5, borderCollapse: 'collapse', minWidth: 560, background: '#fff' }}>
        <thead>
          <tr style={{ color: '#94a3b8', fontSize: 10.5 }}>
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
                  <Pill colour={mm.colour} style={{ fontSize: 10.5 }} title={mm.hint}>{t.label || mm.label}</Pill>
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
      <span style={{ fontSize: 14, fontWeight: 700, color: '#0f172a' }}>{title}</span>
      {sub && <span style={{ fontSize: 12.5, color: '#94a3b8' }}>{sub}</span>}
    </div>
  );
}

function DrillHead({ title, sub, onClose }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
      <span style={{ fontSize: 13, fontWeight: 700, color: '#0f172a' }}>{title}</span>
      {sub && <span style={{ fontSize: 12, color: '#94a3b8' }}>{sub}</span>}
      <button onClick={onClose} style={{
        marginLeft: 'auto', fontSize: 12, color: '#64748b', background: 'none',
        border: 'none', cursor: 'pointer', fontFamily: font,
      }}>close</button>
    </div>
  );
}

function Foot({ children }) {
  return (
    <div style={{ padding: '9px 14px', borderTop: '1px solid #f1f5f9', background: '#f8fafc',
                  fontSize: 12.5, color: '#64748b', lineHeight: 1.5 }}>
      {children}
    </div>
  );
}
