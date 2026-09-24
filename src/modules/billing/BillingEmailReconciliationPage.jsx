import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import BillingTabs from './BillingTabs';
import SearchInput from '../../components/SearchInput';
import DataTable from '../../components/DataTable';
import { fetchAllRows } from '../../lib/fetchAllRows';

const font = "'Outfit', sans-serif";

// Reconciliation between the BrightManager contact email (1:1, source of
// truth for the contact) and the QuickBooks billing email(s) (1:many, source
// of truth for billing). Athena's job is to surface gaps and differences.
// Reads the v_email_reconciliation view.

const STATUS_META = {
  mismatch: { label: 'Mismatch', bg: '#fef3c7', fg: '#92400e', desc: 'BM contact email not in the QBO billing list' },
  gap_qbo:  { label: 'No QBO billing email', bg: '#fee2e2', fg: '#b91c1c', desc: 'BM has a contact email; QBO has none' },
  gap_bm:   { label: 'No BM contact', bg: '#e0e7ff', fg: '#3730a3', desc: 'QBO has billing email(s); no BM contact on file' },
  gap_both: { label: 'No email either side', bg: '#f1f5f9', fg: '#475569', desc: 'Neither side has an email' },
  ok:       { label: 'OK', bg: '#dcfce7', fg: '#15803d', desc: 'BM contact email is present in QBO billing' },
};

// Status sorts in the order the statuses are listed above, worst first.
const STATUS_RANK = Object.keys(STATUS_META);

const mono = { fontFamily: 'monospace', fontSize: 13 };

const COLUMNS = [
  { key: 'name', label: 'Client', render: (r) => <span style={{ color: '#0f172a', fontWeight: 500 }}>{r.name}</span> },
  {
    key: 'status', label: 'Status', width: 190,
    sortValue: (r) => { const i = STATUS_RANK.indexOf(r.status); return i < 0 ? STATUS_RANK.length : i; },
    render: (r) => {
      const meta = STATUS_META[r.status] || STATUS_META.gap_both;
      return (
        <span title={meta.desc} style={{ fontSize: 12, fontWeight: 600, padding: '2px 8px', borderRadius: 999, background: meta.bg, color: meta.fg }}>
          {meta.label}
        </span>
      );
    },
  },
  {
    key: 'bm_contact_email', label: 'BM contact email', wrap: true,
    render: (r) => <span style={{ ...mono, color: r.bm_contact_email ? '#1e293b' : '#cbd5e1' }}>{r.bm_contact_email || '—'}</span>,
  },
  {
    key: 'qbo_billing_emails', label: 'QBO billing email(s)', wrap: true,
    sortValue: (r) => (r.qbo_billing_emails || []).join(', '),
    render: (r) => {
      const list = r.qbo_billing_emails || [];
      return <span style={{ ...mono, color: list.length ? '#1e293b' : '#cbd5e1' }}>{list.length ? list.join(', ') : '—'}</span>;
    },
  },
];

const FILTERS = [
  { id: 'issues', label: 'All issues', statuses: ['mismatch', 'gap_qbo', 'gap_bm', 'gap_both'] },
  { id: 'mismatch', label: 'Mismatch', statuses: ['mismatch'] },
  { id: 'gap_qbo', label: 'No QBO email', statuses: ['gap_qbo'] },
  { id: 'gap_bm', label: 'No BM contact', statuses: ['gap_bm'] },
  { id: 'ok', label: 'OK', statuses: ['ok'] },
  { id: 'all', label: 'All', statuses: ['mismatch', 'gap_qbo', 'gap_bm', 'gap_both', 'ok'] },
];

export default function BillingEmailReconciliationPage() {
  const navigate = useNavigate();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('issues');
  const [search, setSearch] = useState('');

  useEffect(() => {
    (async () => {
      setLoading(true);
      // Every row: PostgREST stops at 1000 without saying so.
      try {
        const data = await fetchAllRows(() => supabase
          .from('v_email_reconciliation')
          .select('*')
          .order('name')
          .order('entity_id'));
        setRows(data);
      } catch {
        setRows([]);
      }
      setLoading(false);
    })();
  }, []);

  const counts = useMemo(() => {
    const c = {};
    for (const r of rows) c[r.status] = (c[r.status] || 0) + 1;
    return c;
  }, [rows]);

  const visible = useMemo(() => {
    const allowed = FILTERS.find((f) => f.id === filter)?.statuses || [];
    const s = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (!allowed.includes(r.status)) return false;
      if (!s) return true;
      const hay = [r.name, r.bm_contact_email, ...(r.qbo_billing_emails || [])].join(' ').toLowerCase();
      return hay.includes(s);
    });
  }, [rows, filter, search]);

  return (
    <div style={{ padding: '20px 28px', fontFamily: font }}>
      <h1 style={{ fontFamily: "'Playfair Display', serif", fontSize: 26, fontWeight: 500, color: '#0f172a', marginBottom: 2 }}>
        Email reconciliation
      </h1>
      <p style={{ fontSize: 14, color: '#64748b', maxWidth: 820, marginBottom: 14 }}>
        BrightManager owns the <strong>contact email</strong> (one per client); QuickBooks owns the <strong>billing email(s)</strong> (a client can have several). Athena flags where the BM contact email isn't present in QBO billing, or where either side is missing.
      </p>

      <BillingTabs active="emails" />

      {loading ? (
        <p style={{ fontSize: 14, color: '#94a3b8', padding: 40, textAlign: 'center' }}>Loading…</p>
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
            {FILTERS.map((f) => {
              const n = f.statuses.reduce((sum, st) => sum + (counts[st] || 0), 0);
              const isActive = filter === f.id;
              return (
                <button
                  key={f.id}
                  onClick={() => setFilter(f.id)}
                  style={{
                    fontSize: 13, padding: '5px 12px', borderRadius: 999, cursor: 'pointer',
                    border: isActive ? '1px solid #0f172a' : '1px solid #e5e7eb',
                    background: isActive ? '#1E4560' : '#fff',
                    color: isActive ? '#fff' : '#475569', fontFamily: font,
                  }}
                >
                  {f.label} <span style={{ opacity: 0.7 }}>({n})</span>
                </button>
              );
            })}
            <div style={{ flex: 1 }} />
            <SearchInput value={search} onChange={setSearch} placeholder="Search client or email…" style={{ minWidth: 240 }} />
          </div>

          <DataTable
            columns={COLUMNS}
            rows={visible}
            rowKey={(r) => r.entity_id}
            defaultSort={{ key: 'name', dir: 'asc' }}
            rowHref={(r) => `/clients/${r.entity_id}`}
            onOpen={(href) => navigate(href)}
            empty="No clients match."
          />
        </>
      )}
    </div>
  );
}
