import React, { useEffect, useMemo, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { AlertTriangle, FilePlus2 } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { fetchAllRows } from '../../lib/fetchAllRows';
import { useAuth } from '../../shell/AppShell';
import DataTable from '../../components/DataTable';
import BillingTabs from './BillingTabs';

const font = "'Outfit', sans-serif";

// Fee-engine gaps — active clients with live BrightManager work but NO active
// live_billing fee (see sql/144 v_fee_engine_gaps). This is the surface for
// the leak the home dashboard now flags: work being done that was never
// mapped to a recurring fee. Confidential — fee admins only (reads
// live_billing via the view; the tab is hidden for non-fee staff and the URL
// bounces).
//
// Each row is triaged into fee_engine_gap_reviews:
//   pending    — not looked at yet
//   actioned   — a fee is (being) set up
//   dismissed  — one-off work, no recurring fee needed
//   not_client — misclassified / not really ours (e.g. the practice itself)

const STATUSES = [
  { value: 'pending',    label: 'Pending',      colour: '#f59e0b', bg: '#fffbeb' },
  { value: 'actioned',   label: 'Fee set up',   colour: '#059669', bg: '#f0fdf4' },
  { value: 'dismissed',  label: 'One-off only', colour: '#64748b', bg: '#f1f5f9' },
  { value: 'not_client', label: 'Not a client', colour: '#94a3b8', bg: '#f8fafc' },
];

const TIER_META = {
  1: { label: 'Recurring service', colour: '#b91c1c', bg: '#fef2f2', hint: 'VAT / bookkeeping / payroll / pensions with no fee — almost always a leak' },
  2: { label: 'Company work',      colour: '#c2410c', bg: '#fff7ed', hint: 'Limited-company accounts / CT / confirmation statement with no fee' },
  3: { label: 'Individual',        colour: '#64748b', bg: '#f8fafc', hint: 'Self Assessment / personal tax — often a director bundled into a company fee' },
};

const TYPE_LABEL = {
  limited_company: 'Ltd', sole_trader: 'Sole trader', partnership: 'Partnership',
  llp: 'LLP',
};

function shortDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

export default function FeeEngineGapsPage() {
  const navigate = useNavigate();
  const { profile } = useAuth();

  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState([]);
  const [statusFilter, setStatusFilter] = useState('pending');
  const [tierFilter, setTierFilter] = useState('priority'); // 'priority' | 'individuals' | 'all'
  const [error, setError] = useState('');
  // Controlled paging: a status change (which can drop the row out of the
  // current filter) keeps you on the page you were working, clamped by the
  // table. A change of filter goes back to page 1.
  const [page, setPage] = useState(1);
  useEffect(() => { setPage(1); }, [statusFilter, tierFilter]);

  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  async function load() {
    setLoading(true);
    // fetchAllRows: PostgREST caps a response at 1000 rows silently; entity_id
    // is the unique tiebreak so range paging is stable.
    let data = [];
    try {
      data = await fetchAllRows(() => supabase
        .from('v_fee_engine_gaps')
        .select('*')
        .order('tier', { ascending: true })
        .order('overdue_tasks', { ascending: false })
        .order('next_deadline', { ascending: true, nullsFirst: false })
        .order('entity_id', { ascending: true }));
    } catch (err) {
      setError(err.message || 'Load failed');
    }
    setRows(data || []);
    setLoading(false);
  }

  // Gate after hooks so hook order stays stable; RLS is the real gate.
  if (profile && profile.can_view_client_fees !== true) {
    return <Navigate to="/manage/billing" replace />;
  }

  const setStatus = async (row, status) => {
    setError('');
    // optimistic
    setRows((prev) => prev.map((r) => (r.entity_id === row.entity_id ? { ...r, review_status: status } : r)));
    const { error: err } = await supabase.from('fee_engine_gap_reviews').upsert(
      {
        entity_id: row.entity_id,
        status,
        reviewed_at: new Date().toISOString(),
        reviewed_by: profile?.id || null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'entity_id' },
    );
    if (err) { setError(err.message || 'Save failed'); await load(); }
  };

  const setNotes = async (row, notes) => {
    setError('');
    const { error: err } = await supabase.from('fee_engine_gap_reviews').upsert(
      {
        entity_id: row.entity_id,
        status: row.review_status || 'pending',
        notes,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'entity_id' },
    );
    if (err) { setError(err.message || 'Save failed'); await load(); }
  };

  const inTier = (r) =>
    tierFilter === 'all' ? true : tierFilter === 'priority' ? r.tier <= 2 : r.tier === 3;

  const filtered = useMemo(
    () => rows.filter((r) => inTier(r) && (statusFilter === 'all' || (r.review_status || 'pending') === statusFilter)),
    [rows, statusFilter, tierFilter],
  );

  // Headline counts (pending only) for the tiles.
  const pend = rows.filter((r) => (r.review_status || 'pending') === 'pending');
  const stats = {
    priority: pend.filter((r) => r.tier <= 2).length,
    individuals: pend.filter((r) => r.tier === 3).length,
    actioned: rows.filter((r) => r.review_status === 'actioned').length,
    resolved: rows.filter((r) => ['dismissed', 'not_client'].includes(r.review_status)).length,
  };

  // No default sort: rows keep the server's order (tier, most overdue, soonest
  // deadline) until a heading is clicked — as before.
  const columns = [
    {
      key: 'client', label: 'Client', sortValue: (r) => r.entity_name,
      render: (r) => {
        const tm = TIER_META[r.tier] || TIER_META[3];
        return (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
            {r.tier <= 2 && (r.review_status || 'pending') === 'pending' && (
              <AlertTriangle size={12} style={{ color: tm.colour, flexShrink: 0 }} />
            )}
            {/* The name is the link to the record (it replaced a separate
                "Client ↗" link) and, like that link, opens in a new tab so the
                filtered list stays where it was. */}
            <a href={`/clients/${r.entity_id}`} target="_blank" rel="noreferrer" title={`Open ${r.entity_name} in a new tab`}
              style={{ fontWeight: 500, color: '#1E4560', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textDecoration: 'underline', textDecorationColor: '#cbd5e1', textUnderlineOffset: 3 }}>
              {r.entity_name}
            </a>
            <span style={{ fontSize: 11, color: '#94a3b8', flexShrink: 0 }}>{TYPE_LABEL[r.entity_type] || r.entity_type}</span>
          </div>
        );
      },
    },
    {
      key: 'tier', label: 'Tier', width: 160, sortValue: (r) => r.tier,
      render: (r) => {
        const tm = TIER_META[r.tier] || TIER_META[3];
        return (
          <span title={tm.hint} style={{ fontSize: 12, fontWeight: 600, color: tm.colour, background: tm.bg, border: `1px solid ${tm.colour}22`, borderRadius: 999, padding: '2px 8px', whiteSpace: 'nowrap' }}>
            {tm.label}
          </span>
        );
      },
    },
    {
      key: 'services', label: 'Services', width: 240, wrap: true,
      sortValue: (r) => (Array.isArray(r.services) ? r.services.join(', ') : ''),
      render: (r) => {
        const services = Array.isArray(r.services) ? r.services : [];
        return <span style={{ color: '#475569', fontSize: 13 }}>{services.join(', ') || '—'}</span>;
      },
    },
    {
      key: 'work', label: 'Work', width: 130, align: 'center', firstDir: 'desc', sortValue: (r) => r.planned_tasks,
      render: (r) => (
        <span style={{ fontSize: 13, color: '#64748b' }}>
          {r.planned_tasks} job{r.planned_tasks === 1 ? '' : 's'}
          {r.overdue_tasks > 0 && (
            <span style={{ color: '#b91c1c', fontWeight: 600 }}> · {r.overdue_tasks} late</span>
          )}
        </span>
      ),
    },
    {
      key: 'next_deadline', label: 'Next due', width: 120, firstDir: 'desc', sortValue: (r) => r.next_deadline,
      render: (r) => <span style={{ color: '#64748b', fontSize: 13 }}>{shortDate(r.next_deadline)}</span>,
    },
    {
      key: 'status', label: 'Status', width: 150,
      sortValue: (r) => (STATUSES.find((s) => s.value === (r.review_status || 'pending')) || STATUSES[0]).label,
      render: (r) => {
        const st = STATUSES.find((s) => s.value === (r.review_status || 'pending')) || STATUSES[0];
        return (
          <select
            value={r.review_status || 'pending'}
            onChange={(e) => setStatus(r, e.target.value)}
            style={{ ...inputStyle, color: st.colour, fontWeight: 500, background: st.bg, border: `1px solid ${st.colour}33`, width: 'auto' }}
          >
            {STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
        );
      },
    },
    {
      // Notes save on blur and are not written back into `rows`, so sorting by
      // notes never moves a row while it is being typed in.
      key: 'notes', label: 'Notes', width: 200, sortValue: (r) => r.review_notes,
      render: (r) => <BlurInput value={r.review_notes} onChange={(v) => setNotes(r, v)} placeholder="Notes…" />,
    },
    {
      key: 'actions', label: '', width: 140, align: 'right', sortable: false,
      // One main action per row (UI audit, Sprint 4): a pending gap's next
      // step is to set up a fee, so it gets the one button; resolved rows
      // just say so. The status dropdown and notes stay as they are.
      render: (r) => {
        const status = r.review_status || 'pending';
        if (status === 'pending') {
          return (
            <a href={`/manage/quotes/new?entity=${r.entity_id}`}
              onClick={(e) => { if (e.ctrlKey || e.metaKey || e.button !== 0) return; e.preventDefault(); navigate(`/manage/quotes/new?entity=${r.entity_id}`); }}
              title="Set up a fee — raise a quote for this client"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 12px', fontSize: 13, fontWeight: 600, borderRadius: 8, background: '#1E4560', color: '#fff', textDecoration: 'none', whiteSpace: 'nowrap' }}>
              <FilePlus2 size={13} /> Raise quote
            </a>
          );
        }
        return <span style={{ fontSize: 12.5, color: '#94a3b8' }}>{status === 'actioned' ? 'Done' : 'Cleared'}</span>;
      },
    },
  ];

  return (
    <div style={{ padding: '20px 28px', fontFamily: font }}>
      <h1 style={{ fontFamily: "'Playfair Display', serif", fontSize: 26, fontWeight: 500, color: '#0f172a', marginBottom: 2 }}>
        Work without a fee
      </h1>
      <p style={{ fontSize: 14, color: '#64748b', maxWidth: 820, marginBottom: 14, lineHeight: 1.55 }}>
        Clients with BrightManager work but no fee. Raise a quote or mark one-off.
        <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 600, color: '#475569', background: '#f1f5f9', border: '1px solid #e2e8f0', borderRadius: 999, padding: '1px 8px', whiteSpace: 'nowrap' }}>Fee admins only</span>
      </p>

      <BillingTabs active="gaps" />

      {error && (
        <div style={{ background: '#fef2f2', border: '1px solid #fecaca', color: '#b91c1c', borderRadius: 8, padding: '8px 12px', fontSize: 13, marginBottom: 12 }}>
          {error}
        </div>
      )}

      {/* Summary tiles */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 14 }}>
        <Stat label="Priority gaps" value={stats.priority} colour="#b91c1c" big hint="Companies + recurring services, pending" />
        <Stat label="Individuals" value={stats.individuals} colour="#64748b" hint="SA / personal tax, pending" />
        <Stat label="Fee set up" value={stats.actioned} colour="#059669" />
        <Stat label="Cleared" value={stats.resolved} colour="#94a3b8" hint="One-off / not a client" />
      </div>

      {/* Tier filter */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
        <TierTab value="priority" label="Priority (companies + recurring)" active={tierFilter} onClick={setTierFilter} />
        <TierTab value="individuals" label="Individuals (SA / personal tax)" active={tierFilter} onClick={setTierFilter} />
        <TierTab value="all" label="All" active={tierFilter} onClick={setTierFilter} />
      </div>

      {/* Status filter */}
      <div style={{ display: 'flex', gap: 2, borderBottom: '1px solid #e5e7eb', marginBottom: 14 }}>
        {[{ value: 'pending', label: 'Pending' }, ...STATUSES.filter((s) => s.value !== 'pending'), { value: 'all', label: 'All' }].map((s) => (
          <FilterTab key={s.value} value={s.value} label={s.label} active={statusFilter} onClick={setStatusFilter} />
        ))}
      </div>

      {loading ? (
        <div style={{ color: '#94a3b8', fontSize: 14, padding: 24 }}>Loading fee-engine gaps…</div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <div style={{ minWidth: 1180 }}>
            <DataTable
              columns={columns}
              rows={filtered}
              rowKey={(r) => r.entity_id}
              page={page}
              onPage={setPage}
              empty={statusFilter === 'pending' ? 'Nothing pending in this view — every gap here has been triaged.' : 'No clients match.'}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function BlurInput({ value, onChange, placeholder }) {
  const [v, setV] = useState(value || '');
  useEffect(() => setV(value || ''), [value]);
  return (
    <input
      value={v}
      placeholder={placeholder}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => { if (v !== (value || '')) onChange(v); }}
      style={inputStyle}
    />
  );
}

function TierTab({ value, label, active, onClick }) {
  const isActive = active === value;
  return (
    <button onClick={() => onClick(value)} style={{
      padding: '6px 12px', fontSize: 13, fontWeight: isActive ? 600 : 500,
      color: isActive ? '#0f172a' : '#64748b',
      background: isActive ? '#f1f5f9' : '#fff',
      border: `1px solid ${isActive ? '#cbd5e1' : '#e5e7eb'}`, borderRadius: 999,
      cursor: 'pointer', fontFamily: font,
    }}>{label}</button>
  );
}

function FilterTab({ value, label, active, onClick }) {
  const isActive = active === value;
  return (
    <button onClick={() => onClick(value)} style={{
      padding: '7px 14px', fontSize: 13, fontWeight: isActive ? 600 : 400,
      color: isActive ? '#0f172a' : '#94a3b8',
      background: 'none', border: 'none',
      borderBottom: isActive ? '2px solid #0e7fe0' : '2px solid transparent',
      marginBottom: -1, cursor: 'pointer', fontFamily: font,
    }}>{label}</button>
  );
}

function Stat({ label, value, colour, big, hint }) {
  return (
    <div style={{ background: '#f8fafc', borderRadius: 8, padding: '10px 12px', borderLeft: `3px solid ${colour}` }} title={hint || ''}>
      <div style={{ fontSize: 11, fontWeight: 600, color: '#94a3b8' }}>{label}</div>
      <div style={{ fontSize: big ? 24 : 18, fontWeight: 700, color: '#0f172a', marginTop: 2 }}>{value}</div>
      {hint && <div style={{ fontSize: 11, color: '#cbd5e1', marginTop: 2 }}>{hint}</div>}
    </div>
  );
}

const inputStyle = { width: '100%', padding: '6px 9px', fontSize: 13, border: '1px solid #e5e7eb', borderRadius: 6, fontFamily: font, boxSizing: 'border-box', background: '#fff' };
