import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import BillingTabs from './BillingTabs';
import SearchInput from '../../components/SearchInput';

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
      const { data } = await supabase
        .from('v_email_reconciliation')
        .select('*')
        .order('name');
      setRows(data || []);
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
    <div style={{ padding: '20px 28px', fontFamily: font, maxWidth: 1280 }}>
      <h1 style={{ fontFamily: "'Playfair Display', serif", fontSize: 26, fontWeight: 500, color: '#0f172a', marginBottom: 2 }}>
        Email reconciliation
      </h1>
      <p style={{ fontSize: 13, color: '#64748b', maxWidth: 820, marginBottom: 14 }}>
        BrightManager owns the <strong>contact email</strong> (one per client); QuickBooks owns the <strong>billing email(s)</strong> (a client can have several). Athena flags where the BM contact email isn't present in QBO billing, or where either side is missing.
      </p>

      <BillingTabs active="emails" />

      {loading ? (
        <p style={{ fontSize: 13, color: '#94a3b8', padding: 40, textAlign: 'center' }}>Loading…</p>
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
                    fontSize: 12, padding: '5px 12px', borderRadius: 999, cursor: 'pointer',
                    border: isActive ? '1px solid #0f172a' : '1px solid #e5e7eb',
                    background: isActive ? '#0f172a' : '#fff',
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

          {visible.length === 0 ? (
            <p style={{ fontSize: 13, color: '#94a3b8', padding: 40, textAlign: 'center' }}>No clients match.</p>
          ) : (
            <div style={{ border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden' }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 160px 1.4fr 1.6fr', gap: 0, background: '#f8fafc', padding: '8px 14px', fontSize: 11, fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                <span>Client</span>
                <span>Status</span>
                <span>BM contact email</span>
                <span>QBO billing email(s)</span>
              </div>
              {visible.map((r) => {
                const meta = STATUS_META[r.status] || STATUS_META.gap_both;
                return (
                  <div
                    key={r.entity_id}
                    onClick={() => navigate(`/clients/${r.entity_id}`)}
                    style={{ display: 'grid', gridTemplateColumns: '1.4fr 160px 1.4fr 1.6fr', gap: 0, padding: '10px 14px', fontSize: 13, borderTop: '1px solid #f1f5f9', cursor: 'pointer', alignItems: 'center' }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = '#f8fafc'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                  >
                    <span style={{ color: '#0f172a', fontWeight: 500 }}>{r.name}</span>
                    <span>
                      <span title={meta.desc} style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 999, background: meta.bg, color: meta.fg }}>
                        {meta.label}
                      </span>
                    </span>
                    <span style={{ color: r.bm_contact_email ? '#1e293b' : '#cbd5e1', fontFamily: 'monospace', fontSize: 12 }}>
                      {r.bm_contact_email || '—'}
                    </span>
                    <span style={{ color: (r.qbo_billing_emails || []).length ? '#1e293b' : '#cbd5e1', fontFamily: 'monospace', fontSize: 12, wordBreak: 'break-word' }}>
                      {(r.qbo_billing_emails || []).length ? r.qbo_billing_emails.join(', ') : '—'}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}
