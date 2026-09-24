import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Download, TriangleAlert } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { fetchAllRows } from '../../lib/fetchAllRows';
import { fmtGbpDetailed } from '../../lib/money';
import { downloadCSV } from '../../lib/exportUtils';
import SearchInput from '../../components/SearchInput';
import AlphabetFilter, { firstCharBucket } from '../../components/AlphabetFilter';
import DataTable from '../../components/DataTable';
import { font, Chip, Pill, ErrorBar, card, TAX_META } from './hmrcShared';

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

const figure = { background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontFamily: font, fontVariantNumeric: 'tabular-nums' };

export default function AllTaxesView({ clients = [], error = '' }) {
  const navigate = useNavigate();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [search, setSearch] = useState('');
  const [letter, setLetter] = useState(null);
  const [view, setViewRaw] = useState('net_owing');
  // Sorting is on the column headings. Net position, largest first, is the
  // default it always was.
  const [sort, setSort] = useState({ key: 'net_position', dir: 'desc' });
  const [page, setPage] = useState(1);

  // Any change to what is shown starts the list again at page 1.
  const setView = (v) => { setViewRaw(v); setPage(1); };
  const onSearch = (v) => { setSearch(v); setPage(1); };
  const onLetter = (v) => { setLetter(v); setPage(1); };

  useEffect(() => {
    // 326 rows today. PostgREST caps a fetch at 1000 and truncates SILENTLY —
    // `.limit(2000)` does not raise it — so page through the lot.
    fetchAllRows(() => supabase.from('v_hmrc_client_position').select('*').order('entity_id'))
      .then((data) => setRows(data))
      .catch((e) => setLoadError(e.message || 'Could not load the HMRC position'))
      .finally(() => setLoading(false));
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
    // The table does the sorting, from the column headings.
    return (groups[view] || rows).filter((r) => {
      const name = r.entity_name || '';
      if (letter && letter !== 'All' && firstCharBucket(name) !== letter) return false;
      if (q && !name.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [groups, view, rows, search, letter]);

  const sum = (k, set = filtered) => set.reduce((s, r) => s + n(r[k]), 0);

  const openTax = (taxKey, r) => navigate(`/hmrc/${taxKey}?entity=${r.entity_id}`);

  const heldHint = (r) => {
    const bits = [];
    if (n(r.held_paye_cash)) bits.push(`${fmtGbpDetailed(r.held_paye_cash)} cash on PAYE`);
    if (n(r.held_paye_credit_movable)) bits.push(`${fmtGbpDetailed(r.held_paye_credit_movable)} credit, movable`);
    if (n(r.held_paye_credit_locked)) bits.push(`${fmtGbpDetailed(r.held_paye_credit_locked)} credit, locked to this tax year`);
    if (n(r.held_paye_credit_unknown)) bits.push(`${fmtGbpDetailed(r.held_paye_credit_unknown)} credit, tax year unknown`);
    if (n(r.held_other_heads)) bits.push(`${fmtGbpDetailed(r.held_other_heads)} overpaid on another tax`);
    if (n(r.held_sa)) bits.push(`${fmtGbpDetailed(r.held_sa)} Self Assessment repayment`);
    return bits.length ? bits.join(' · ') : 'HMRC is holding nothing';
  };

  // Headings are single-level in DataTable, so the "Owed, by head" group is
  // carried into each head's label ("VAT · owed") and its tooltip.
  const columns = [
    {
      key: 'entity_name', label: 'Client',
      sortValue: (r) => r.entity_name || '',
      render: (r) => (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
          {(r.taxes_owing || 0) > 1 && (
            <TriangleAlert size={12} style={{ color: '#c2410c', flexShrink: 0 }}
              title={`Owing on ${r.taxes_owing} taxes`} />
          )}
          <button onClick={() => navigate(`/hmrc/breakdown?entity=${r.entity_id}`)}
            title={`${r.entity_name} — every tax, and what each balance is made of`}
            style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                     fontFamily: font, fontSize: 13.5, fontWeight: 500, color: '#0f172a', textAlign: 'left',
                     overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
            {r.entity_name}
          </button>
          {r.vat_credit_not_captured && (
            <Pill colour="#b45309" style={{ fontSize: 10, flexShrink: 0 }}
              title="VAT registered, nothing owed. Could be nil or a repayment; we can't tell.">
              VAT ?
            </Pill>
          )}
        </div>
      ),
    },
    {
      key: 'owed_total', align: 'right', width: 125,
      label: <span title="What HMRC says is due, across all four taxes">Owed</span>,
      sortValue: (r) => n(r.owed_total),
      render: (r) => (
        <span style={{ color: n(r.owed_total) ? '#b91c1c' : '#e2e8f0', fontVariantNumeric: 'tabular-nums' }}>
          {n(r.owed_total) ? fmtGbpDetailed(r.owed_total) : '—'}
        </span>
      ),
    },
    {
      key: 'held_total', align: 'right', width: 125,
      label: <span title="Everything HMRC is sitting on — hover a figure for the make-up">Held</span>,
      sortValue: (r) => n(r.held_total),
      render: (r) => (
        <span title={heldHint(r)} style={{ color: n(r.held_total) ? '#0369a1' : '#e2e8f0', fontVariantNumeric: 'tabular-nums' }}>
          {n(r.held_total) ? fmtGbpDetailed(r.held_total) : '—'}
        </span>
      ),
    },
    {
      key: 'net_position', align: 'right', width: 130,
      label: <span title="Owed less held. The true economic position.">Net</span>,
      sortValue: (r) => n(r.net_position),
      render: (r) => {
        const net = n(r.net_position);
        return (
          <button
            onClick={() => navigate(`/hmrc/breakdown?entity=${r.entity_id}`)}
            title={`${r.entity_name} — owed ${fmtGbpDetailed(r.owed_total)}, held ${fmtGbpDetailed(r.held_total)}`}
            style={{ ...figure, fontSize: 13.5, fontWeight: 700,
                     color: net > 0 ? '#b91c1c' : net < 0 ? '#059669' : '#0f172a',
                     textDecoration: 'underline', textDecorationStyle: 'dotted',
                     textDecorationColor: '#cbd5e1' }}>
            {fmtGbpDetailed(net)}
          </button>
        );
      },
    },
    {
      key: 'payable_now', align: 'right', width: 135,
      label: <span title="Owed less only the credit that can be moved today. Excludes current-year CIS credit and credit whose year cannot be read.">Payable now</span>,
      sortValue: (r) => n(r.payable_now),
      render: (r) => {
        const stuck = n(r.payable_now) - n(r.net_position);
        return (
          <span
            title={stuck > 0
              ? `${fmtGbpDetailed(stuck)} of credit cannot be moved yet, so it is not netted here`
              : 'Everything held can be moved today'}
            style={{ color: n(r.payable_now) > 0 ? '#0f172a' : '#e2e8f0', fontVariantNumeric: 'tabular-nums' }}>
            {n(r.payable_now) ? fmtGbpDetailed(r.payable_now) : '—'}
            {stuck > 0 && <span style={{ color: '#b45309', marginLeft: 4 }} title="Credit stuck">•</span>}
          </span>
        );
      },
    },
    ...HEADS.map((h) => ({
      key: h.key, align: 'right', width: 125,
      label: (
        <span title={`Owed, by tax — ${TAX_META[h.tax].label}. Click a figure to open that tax for the client.`}
              style={{ color: '#94a3b8' }}>
          {TAX_META[h.tax].short} · owed
        </span>
      ),
      sortValue: (r) => n(r[h.key]),
      render: (r) => {
        const v = n(r[h.key]);
        // Zero is still a door. A client with nothing owing on VAT may still be
        // the one you want to look at.
        return (
          <button onClick={() => openTax(h.tax, r)}
            title={`${r.entity_name} · ${TAX_META[h.tax].label} — what makes this up`}
            style={{ ...figure, fontSize: 12.5,
                     color: v > 0 ? '#94a3b8' : '#e2e8f0',
                     textDecoration: v !== 0 ? 'underline' : 'none',
                     textDecorationStyle: 'dotted', textDecorationColor: '#e2e8f0' }}>
            {v !== 0 ? fmtGbpDetailed(v) : '—'}
          </button>
        );
      },
    })),
    {
      key: 'taxes_owing', label: 'Taxes', align: 'center', width: 80,
      sortValue: (r) => r.taxes_owing || 0,
      render: (r) => (
        <span style={{ fontSize: 12.5, color: '#64748b' }}>
          {r.taxes_owing || 0}
          <span style={{ color: '#cbd5e1' }}>/{extra.get(r.entity_id)?.taxes_known ?? 0}</span>
        </span>
      ),
    },
  ];

  // Totals over every filtered row, not just the page on screen.
  const footer = (set) => {
    const net = sum('net_position', set);
    return {
      entity_name: `${set.length} client${set.length === 1 ? '' : 's'} shown`,
      owed_total: <span style={{ color: '#b91c1c' }}>{fmtGbpDetailed(sum('owed_total', set))}</span>,
      held_total: <span style={{ color: '#0369a1' }}>{fmtGbpDetailed(sum('held_total', set))}</span>,
      net_position: <span style={{ color: net > 0 ? '#b91c1c' : '#059669' }}>{fmtGbpDetailed(net)}</span>,
      payable_now: fmtGbpDetailed(sum('payable_now', set)),
      ...Object.fromEntries(HEADS.map((h) => [
        h.key, <span key={h.key} style={{ fontSize: 12.5, color: '#94a3b8' }}>{fmtGbpDetailed(sum(h.key, set))}</span>,
      ])),
    };
  };

  const exportCsv = () => {
    downloadCSV(
      `hmrc-position-${new Date().toISOString().slice(0, 10)}.csv`,
      ['Client', 'Owed', 'Held', 'Net position', 'Payable now',
       'PAYE', 'Corporation Tax', 'VAT', 'Self Assessment',
       'Held: cash', 'Held: CIS credit movable', 'Held: credit locked',
       'Held: credit age unknown', 'Held: other taxes', 'Held: SA',
       'Taxes owing', 'VAT position unknown', 'Last checked'],
      sortLike(filtered, columns, sort).map((r) => [
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

  return (
    <div>
      <ErrorBar message={error || loadError} />

      <p style={{ fontSize: 14, color: '#64748b', maxWidth: 940, marginTop: 0, marginBottom: 6, lineHeight: 1.55 }}>
        <b>Net</b> is owed less credit HMRC holds. <b>Click a figure</b> to open it.
      </p>
      <p style={{ fontSize: 13, color: '#64748b', maxWidth: 940, marginTop: 0, marginBottom: 14, lineHeight: 1.6 }}>
        <b>Payable now</b> excludes credit that can't be moved yet, such as current-year CIS before 6 April.
      </p>

      <div style={{ display: 'flex', gap: 6, marginBottom: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        <SearchInput value={search} onChange={onSearch} placeholder="Client name…" style={{ minWidth: 220 }} />
        <Chip value="net_owing" label="Net owing"      count={groups.net_owing.length} active={view} onClick={setView} colour="#b91c1c" />
        <Chip value="payable"   label="Payable now"    count={groups.payable.length}   active={view} onClick={setView} colour="#c2410c" />
        <Chip value="in_credit" label="Net in credit"  count={groups.in_credit.length} active={view} onClick={setView} colour="#059669" />
        <Chip value="holding"   label="HMRC holding"   count={groups.holding.length}   active={view} onClick={setView} colour="#0369a1" />
        <Chip value="multi"     label="On 2+ taxes"    count={groups.multi.length}     active={view} onClick={setView} colour="#c2410c" />
        <Chip value="all"       label="Every client"   count={groups.all.length}       active={view} onClick={setView} />
        <button onClick={exportCsv} disabled={filtered.length === 0}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '6px 12px',
                   fontSize: 13, fontFamily: font, color: '#475569', background: '#fff',
                   border: '1px solid #e5e7eb', borderRadius: 8,
                   cursor: filtered.length ? 'pointer' : 'default', opacity: filtered.length ? 1 : 0.5 }}>
          <Download size={12} /> Export for Excel
        </button>
      </div>

      <AlphabetFilter items={rows} nameKey="entity_name" selected={letter} onChange={onLetter} />

      {loading ? (
        <div style={{ color: '#94a3b8', fontSize: 14, padding: 24 }}>Loading every tax…</div>
      ) : (
        <div style={{ marginTop: 8 }}>
          {/* Ten money columns do not fit a narrow screen, so the table keeps a
              minimum width and scrolls sideways rather than squashing figures. */}
          <div style={{ overflowX: 'auto' }}>
            <div style={{ minWidth: 1400 }}>
              <DataTable
                columns={columns}
                rows={filtered}
                rowKey={(r) => r.entity_id}
                sort={sort}
                onSort={(s) => { setSort(s); setPage(1); }}
                page={page}
                onPage={setPage}
                footer={footer}
                empty="No clients match."
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
