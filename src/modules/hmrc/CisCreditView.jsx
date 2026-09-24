import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Download } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { fetchAllRows } from '../../lib/fetchAllRows';
import { fmtGbpDetailed } from '../../lib/money';
import { downloadCSV } from '../../lib/exportUtils';
import SearchInput from '../../components/SearchInput';
import DataTable from '../../components/DataTable';
import { font, Chip, Pill, ErrorBar } from './hmrcShared';
import { BTN } from '../../lib/buttonStyles';

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

// What can be moved or might be: the order this tab has always opened in.
const reachable = (r) => n(r.cash_movable) + n(r.credit_movable) + n(r.credit_age_unknown);

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

const money = (v, colour, bold) => (
  <span style={{ color: n(v) ? colour : '#e2e8f0', fontWeight: bold && n(v) ? 600 : 400, fontVariantNumeric: 'tabular-nums' }}>
    {n(v) ? fmtGbpDetailed(v) : '—'}
  </span>
);

export default function CisCreditView() {
  const navigate = useNavigate();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [view, setView] = useState('all');
  // No heading sort to begin with: the rows arrive in the tab's own order
  // (movable plus age unknown, largest first) and a heading click re-sorts.
  const [sort, setSort] = useState(null);
  const [page, setPage] = useState(1);

  const onView = (v) => { setView(v); setPage(1); };
  const onSearch = (v) => { setSearch(v); setPage(1); };

  useEffect(() => {
    // PostgREST caps a fetch at 1000 and truncates SILENTLY — `.limit(2000)`
    // does not raise it — so page through the lot, one row per PAYE scheme.
    fetchAllRows(() => supabase.from('v_hmrc_cis_pot_status').select('*').order('paye_ref').order('hmrc_name'))
      .then((data) => setRows(data))
      .catch((e) => setError(e.message || 'Could not load the credit pot'))
      .finally(() => setLoading(false));
  }, []);

  const taxYear = rows[0]?.current_tax_year || '';

  const groups = useMemo(() => ({
    all:     rows,
    cis:     rows.filter((r) => n(r.credit_cis) > 0),
    movable: rows.filter((r) => n(r.cash_movable) + n(r.credit_movable) > 0),
    locked:  rows.filter((r) => n(r.credit_locked) > 0),
    unknown: rows.filter((r) => n(r.credit_age_unknown) > 0),
  }), [rows]);

  // Pre-sorted in the default order. DataTable's sort is stable, so this also
  // breaks ties when a heading is clicked.
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (groups[view] || rows)
      .filter((r) => !q || (r.hmrc_name || '').toLowerCase().includes(q))
      .sort((a, b) => reachable(b) - reachable(a));
  }, [groups, view, search, rows]);

  const sum = (k, list = filtered) => list.reduce((a, r) => a + n(r[k]), 0);

  // The column headings already carry their group ("Cash · movable",
  // "Credit · locked"), so nothing is lost to single-level headings.
  const columns = [
    {
      key: 'hmrc_name', label: 'Client',
      sortValue: (r) => r.hmrc_name || '',
      render: (r) => (r.entity_id ? (
        <button
          onClick={() => navigate(`/hmrc/paye?entity=${r.entity_id}`)}
          style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                   fontFamily: font, fontSize: 13, color: '#0f172a', textAlign: 'left',
                   textDecoration: 'underline', textDecorationStyle: 'dotted',
                   textDecorationColor: '#cbd5e1', maxWidth: '100%',
                   overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          title="Open this client’s PAYE account">
          {r.hmrc_name}
        </button>
      ) : (
        // No entity behind the scheme — the name is all there is, and it must
        // not look like a dead link.
        <span title="No Athena client linked to this PAYE scheme">{r.hmrc_name}</span>
      )),
    },
    {
      key: 'cash_movable', align: 'right', width: 135,
      label: <span title="Money the client sent that HMRC has not matched to a bill. No year restriction.">Cash · movable</span>,
      sortValue: (r) => n(r.cash_movable),
      render: (r) => money(r.cash_movable, '#0f172a'),
    },
    {
      key: 'credit_movable', align: 'right', width: 140,
      label: <span title="Credit that arose in a closed tax year, so it can be set against another year, another tax, or repaid.">Credit · movable</span>,
      sortValue: (r) => n(r.credit_movable),
      render: (r) => money(r.credit_movable, '#059669', true),
    },
    {
      key: 'credit_locked', align: 'right', width: 135,
      label: <span title="Credit that arose this tax year. It can only offset this year’s PAYE bills until 6 April.">Credit · locked</span>,
      sortValue: (r) => n(r.credit_locked),
      render: (r) => money(r.credit_locked, '#c2410c'),
    },
    {
      key: 'credit_age_unknown', align: 'right', width: 170,
      label: <span title="Credit whose tax year cannot be read from HMRC’s restated yearly rows. Not nil, and not available.">Credit · age unknown</span>,
      sortValue: (r) => n(r.credit_age_unknown),
      render: (r) => money(r.credit_age_unknown, '#b45309'),
    },
    {
      key: 'credit_total', label: 'Credit total', align: 'right', width: 125,
      sortValue: (r) => n(r.credit_total),
      render: (r) => <span style={{ fontVariantNumeric: 'tabular-nums' }}>{n(r.credit_total) ? fmtGbpDetailed(r.credit_total) : '—'}</span>,
    },
    {
      key: 'credit_cis', label: 'of which CIS', align: 'right', width: 125,
      sortValue: (r) => n(r.credit_cis),
      render: (r) => <span style={{ color: '#0369a1', fontVariantNumeric: 'tabular-nums' }}>{n(r.credit_cis) ? fmtGbpDetailed(r.credit_cis) : '—'}</span>,
    },
    {
      key: 'basis', label: 'Basis', width: 170,
      sortValue: (r) => (BASIS[r.basis] || BASIS['age unknown']).label,
      render: (r) => {
        const b = BASIS[r.basis] || BASIS['age unknown'];
        return (
          <>
            <Pill colour={b.colour} title={b.hint} style={{ fontSize: 10.5 }}>{b.label}</Pill>
            {r.matched_year && (
              <span style={{ fontSize: 11.5, color: '#94a3b8', marginLeft: 6 }}>{r.matched_year}</span>
            )}
          </>
        );
      },
    },
  ];

  // Totals over every filtered row, not just the page on screen.
  const footer = (list) => ({
    hmrc_name: `${list.length} client${list.length === 1 ? '' : 's'}`,
    cash_movable: fmtGbpDetailed(sum('cash_movable', list)),
    credit_movable: <span style={{ color: '#059669' }}>{fmtGbpDetailed(sum('credit_movable', list))}</span>,
    credit_locked: <span style={{ color: '#c2410c' }}>{fmtGbpDetailed(sum('credit_locked', list))}</span>,
    credit_age_unknown: <span style={{ color: '#b45309' }}>{fmtGbpDetailed(sum('credit_age_unknown', list))}</span>,
    credit_total: fmtGbpDetailed(sum('credit_total', list)),
    credit_cis: <span style={{ color: '#0369a1' }}>{fmtGbpDetailed(sum('credit_cis', list))}</span>,
  });

  const exportCsv = () => {
    downloadCSV(
      `hmrc-cis-credit-${new Date().toISOString().slice(0, 10)}.csv`,
      ['Client', 'PAYE ref', 'Cash movable', 'Credit movable', 'Credit locked',
       'Credit age unknown', 'Credit total', 'of which CIS', 'Basis', 'Credit year'],
      sortLike(filtered, columns, sort).map((r) => [
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
        Credit HMRC holds on clients’ PAYE accounts{taxYear ? ` in ${taxYear}` : ''}.
      </p>
      <p style={{ fontSize: 13, color: '#64748b', maxWidth: 940, marginTop: 0, marginBottom: 14, lineHeight: 1.6 }}>
        <b>Cash</b> can be moved any time. <b>Credit</b> from this tax year only offsets this year’s PAYE until 6 April.
      </p>

      <div style={{ display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <SearchInput value={search} onChange={onSearch} placeholder="Client name…" style={{ minWidth: 240 }} />
        <Chip value="all"     label="Everyone holding something" count={groups.all.length} active={view} onClick={onView} />
        <Chip value="cis"     label="Holding CIS credit"  count={groups.cis.length}     active={view} onClick={onView} colour="#0369a1" />
        <Chip value="movable" label="Movable now"         count={groups.movable.length} active={view} onClick={onView} colour="#059669" />
        <Chip value="locked"  label="Locked to this year" count={groups.locked.length}  active={view} onClick={onView} colour="#c2410c" />
        <Chip value="unknown" label="Age unknown"         count={groups.unknown.length} active={view} onClick={onView} colour="#b45309" />
        <button onClick={exportCsv} style={{ ...BTN.secondary.sm, marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
          <Download size={13} /> Export
        </button>
      </div>

      <div style={{ overflowX: 'auto' }}>
        <div style={{ minWidth: 1250 }}>
          <DataTable
            columns={columns}
            rows={filtered}
            rowKey={(r) => r.paye_ref}
            sort={sort}
            onSort={(s) => { setSort(s); setPage(1); }}
            page={page}
            onPage={setPage}
            footer={footer}
            empty="No clients match."
          />
        </div>
      </div>
      <div style={{ padding: '10px 2px', fontSize: 12.5, color: '#94a3b8', lineHeight: 1.6 }}>
        <b>Age unknown</b> isn’t nil and can’t be moved yet.
      </div>
    </div>
  );
}
