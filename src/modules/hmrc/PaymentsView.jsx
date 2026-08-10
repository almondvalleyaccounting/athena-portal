import React, { useEffect, useMemo, useState } from 'react';
import { Download, TriangleAlert } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { fmtGbp, fmtGbpDetailed } from '../../lib/money';
import { downloadCSV } from '../../lib/exportUtils';
import SearchInput from '../../components/SearchInput';
import AlphabetFilter, { firstCharBucket } from '../../components/AlphabetFilter';
import { font, Stat, Chip, ErrorBar, th, thNum, td, tdNum, card, inputStyle } from './hmrcShared';

// Every payment HMRC has recorded, and what it was set against.
//
// The statement shows a month's payments total; this is the ledger behind it.
// The column that earns the tab is "Allocated to": a payment HMRC has not
// allocated is money sitting on the scheme reducing nothing, which is a
// conversation with HMRC rather than with the client.

const MONTH_NAMES = ['', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar'];
const n = (v) => Number(v || 0);
const iso = (d) => d.toISOString().slice(0, 10);

export default function PaymentsView() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [letter, setLetter] = useState(null);
  const [view, setView] = useState('all'); // 'all' | 'unallocated'
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  useEffect(() => {
    supabase
      .from('v_hmrc_paye_payment_detail')
      .select('*')
      .order('received_on', { ascending: false, nullsFirst: false })
      .then(({ data, error: e }) => {
        if (e) setError(e.message); else setRows(data || []);
        setLoading(false);
      });
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      const name = r.entity_name || '';
      if (letter && letter !== 'All' && firstCharBucket(name) !== letter) return false;
      if (view === 'unallocated' && !r.unallocated) return false;
      // Rows with an unreadable date have no received_on; a date filter cannot
      // judge them, so they only show when no range is set.
      if (from && (!r.received_on || r.received_on < from)) return false;
      if (to && (!r.received_on || r.received_on > to)) return false;
      if (!q) return true;
      return `${name} ${r.paye_ref} ${r.allocated_to || ''}`.toLowerCase().includes(q);
    });
  }, [rows, search, letter, view, from, to]);

  const total = filtered.reduce((s, r) => s + n(r.amount), 0);
  const unallocated = rows.filter((r) => r.unallocated);
  const unallocatedTotal = unallocated.reduce((s, r) => s + n(r.amount), 0);

  const exportCsv = () => {
    downloadCSV(
      `hmrc-paye-payments-${iso(new Date())}.csv`,
      ['Client', 'PAYE ref', 'Received', 'Allocated to', 'Allocated tax year', 'Allocated month', 'Unallocated', 'Amount'],
      filtered.map((r) => [
        r.entity_name || '', r.paye_ref, r.received_on_text || '',
        r.allocated_to || '', r.allocated_year || '', r.allocated_month ?? '',
        r.unallocated ? 'Yes' : 'No', n(r.amount).toFixed(2),
      ]),
    );
  };

  return (
    <div>
      <ErrorBar message={error} />

      <p style={{ fontSize: 13, color: '#64748b', maxWidth: 900, marginTop: 0, marginBottom: 14, lineHeight: 1.55 }}>
        Every payment HMRC has recorded against a client's PAYE scheme, when it arrived and which tax month it
        was set against. A payment HMRC has not allocated is money sitting on the scheme reducing nothing.
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 16, maxWidth: 800 }}>
        <Stat label="Payments shown" value={filtered.length} colour="#0f172a" big />
        <Stat label="Value shown" value={fmtGbp(total)} colour="#059669" />
        <Stat label="Unallocated" value={unallocated.length} colour={unallocated.length ? '#c2410c' : '#059669'}
              hint="HMRC has not set these against a month" />
        <Stat label="Unallocated value" value={fmtGbp(unallocatedTotal)} colour={unallocatedTotal ? '#c2410c' : '#059669'} />
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 6 }}>
        <SearchInput value={search} onChange={setSearch} placeholder="Client, PAYE ref or allocation…" style={{ minWidth: 280 }} />
        <Chip value="all" label="All payments" count={rows.length} active={view} onClick={setView} />
        <Chip value="unallocated" label="Unallocated only" count={unallocated.length} active={view} onClick={setView} colour="#c2410c" />
        <label style={lbl}>From
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={{ ...inputStyle, width: 'auto', marginLeft: 6 }} />
        </label>
        <label style={lbl}>To
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} style={{ ...inputStyle, width: 'auto', marginLeft: 6 }} />
        </label>
        <div style={{ flex: 1 }} />
        <button
          onClick={exportCsv}
          disabled={filtered.length === 0}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 5, padding: '6px 12px',
            fontSize: 12, fontFamily: font, color: '#475569', background: '#fff',
            border: '1px solid #e5e7eb', borderRadius: 8,
            cursor: filtered.length ? 'pointer' : 'default', opacity: filtered.length ? 1 : 0.5,
          }}
        >
          <Download size={12} /> Export for Excel
        </button>
      </div>

      <AlphabetFilter items={rows} nameKey="entity_name" selected={letter} onChange={setLetter} />

      {loading ? (
        <div style={{ color: '#94a3b8', fontSize: 13, padding: 24 }}>Loading payments…</div>
      ) : (
        <div style={{ ...card, marginTop: 8 }}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', fontSize: 12.5, borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: '#f8fafc', fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5, color: '#64748b' }}>
                  <th style={th}>Client</th>
                  <th style={th}>PAYE ref</th>
                  <th style={th}>Received</th>
                  <th style={th}>Allocated to</th>
                  <th style={thNum}>Amount</th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 && (
                  <tr><td colSpan={5} style={{ padding: 30, textAlign: 'center', color: '#94a3b8' }}>
                    No payments match.
                  </td></tr>
                )}
                {filtered.map((r) => (
                  <tr key={r.id} style={{ borderTop: '1px solid #f1f5f9', background: r.unallocated ? '#fff7ed' : undefined }}>
                    <td style={{ ...td, fontWeight: 500 }}>{r.entity_name}</td>
                    <td style={{ ...td, fontSize: 11.5, color: '#64748b', whiteSpace: 'nowrap' }}>{r.paye_ref}</td>
                    <td style={{ ...td, whiteSpace: 'nowrap' }}>{r.received_on_text}</td>
                    <td style={{ ...td, color: '#475569', maxWidth: 380 }}>
                      {r.unallocated ? (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: '#c2410c', fontWeight: 600 }}>
                          <TriangleAlert size={12} /> Unallocated
                        </span>
                      ) : (
                        <>
                          {r.allocated_to}
                          {r.allocated_month && (
                            <span style={{ fontSize: 10.5, color: '#94a3b8', marginLeft: 6 }}>
                              {MONTH_NAMES[r.allocated_month]} · m{r.allocated_month} {r.allocated_year}
                            </span>
                          )}
                        </>
                      )}
                    </td>
                    <td style={{ ...tdNum, fontWeight: 600 }}>{fmtGbpDetailed(r.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

const lbl = { fontSize: 12, color: '#64748b', fontFamily: font, display: 'inline-flex', alignItems: 'center' };
