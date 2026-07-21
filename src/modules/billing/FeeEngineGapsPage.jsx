import React, { useEffect, useMemo, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { AlertTriangle, ExternalLink, FilePlus2 } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../shell/AppShell';
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

  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  async function load() {
    setLoading(true);
    const { data, error: err } = await supabase
      .from('v_fee_engine_gaps')
      .select('*')
      .order('tier', { ascending: true })
      .order('overdue_tasks', { ascending: false })
      .order('next_deadline', { ascending: true, nullsFirst: false });
    if (err) setError(err.message || 'Load failed');
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

  return (
    <div style={{ padding: '20px 28px', fontFamily: font, maxWidth: 1320 }}>
      <h1 style={{ fontFamily: "'Playfair Display', serif", fontSize: 26, fontWeight: 500, color: '#0f172a', marginBottom: 2 }}>
        Fee engine gaps
      </h1>
      <p style={{ fontSize: 13, color: '#64748b', maxWidth: 820, marginBottom: 14, lineHeight: 1.55 }}>
        Active clients with live work scheduled in BrightManager but <b>no fee mapped in the fee engine</b>.
        These are the jobs being done that were never set up as a recurring fee. Work each one: set up a
        fee (raise a quote), or mark it one-off / not a client to clear it from the list. Confidential —
        visible to fee admins only.
      </p>

      <BillingTabs active="gaps" />

      {error && (
        <div style={{ background: '#fef2f2', border: '1px solid #fecaca', color: '#b91c1c', borderRadius: 8, padding: '8px 12px', fontSize: 12, marginBottom: 12 }}>
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
        <div style={{ color: '#94a3b8', fontSize: 13, padding: 24 }}>Loading fee-engine gaps…</div>
      ) : (
        <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, overflow: 'hidden' }}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: '#f8fafc', fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5, color: '#64748b' }}>
                  <th style={th}>Client</th>
                  <th style={th}>Tier</th>
                  <th style={th}>Services</th>
                  <th style={{ ...th, textAlign: 'center' }}>Work</th>
                  <th style={th}>Next due</th>
                  <th style={th}>Status</th>
                  <th style={th}>Notes</th>
                  <th style={th}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 && (
                  <tr><td colSpan={8} style={{ padding: 30, textAlign: 'center', color: '#94a3b8' }}>
                    {statusFilter === 'pending' ? 'Nothing pending in this view — every gap here has been triaged.' : 'No clients match.'}
                  </td></tr>
                )}
                {filtered.map((r) => {
                  const st = STATUSES.find((s) => s.value === (r.review_status || 'pending')) || STATUSES[0];
                  const tm = TIER_META[r.tier] || TIER_META[3];
                  const services = Array.isArray(r.services) ? r.services : [];
                  return (
                    <tr key={r.entity_id} style={{ borderTop: '1px solid #f1f5f9' }}>
                      <td style={td}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          {r.tier <= 2 && (r.review_status || 'pending') === 'pending' && (
                            <AlertTriangle size={12} style={{ color: tm.colour, flexShrink: 0 }} />
                          )}
                          <span style={{ fontWeight: 500, color: '#0f172a' }}>{r.entity_name}</span>
                          <span style={{ fontSize: 10, color: '#94a3b8' }}>{TYPE_LABEL[r.entity_type] || r.entity_type}</span>
                        </div>
                      </td>
                      <td style={td}>
                        <span title={tm.hint} style={{ fontSize: 11, fontWeight: 600, color: tm.colour, background: tm.bg, border: `1px solid ${tm.colour}22`, borderRadius: 999, padding: '2px 8px', whiteSpace: 'nowrap' }}>
                          {tm.label}
                        </span>
                      </td>
                      <td style={{ ...td, color: '#475569', fontSize: 12, maxWidth: 260 }}>
                        {services.join(', ') || '—'}
                      </td>
                      <td style={{ ...td, textAlign: 'center', fontSize: 12, color: '#64748b', whiteSpace: 'nowrap' }}>
                        {r.planned_tasks} job{r.planned_tasks === 1 ? '' : 's'}
                        {r.overdue_tasks > 0 && (
                          <span style={{ color: '#b91c1c', fontWeight: 600 }}> · {r.overdue_tasks} late</span>
                        )}
                      </td>
                      <td style={{ ...td, color: '#64748b', fontSize: 12, whiteSpace: 'nowrap' }}>{shortDate(r.next_deadline)}</td>
                      <td style={td}>
                        <select
                          value={r.review_status || 'pending'}
                          onChange={(e) => setStatus(r, e.target.value)}
                          style={{ ...inputStyle, color: st.colour, fontWeight: 500, background: st.bg, border: `1px solid ${st.colour}33`, width: 'auto' }}
                        >
                          {STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                        </select>
                      </td>
                      <td style={{ ...td, minWidth: 160 }}>
                        <BlurInput value={r.review_notes} onChange={(v) => setNotes(r, v)} placeholder="Notes…" />
                      </td>
                      <td style={{ ...td, whiteSpace: 'nowrap' }}>
                        <div style={{ display: 'flex', gap: 10 }}>
                          <a href={`/manage/quotes/new?entity=${r.entity_id}`}
                            style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, color: '#0e7fe0', textDecoration: 'none' }}
                            title="Set up a fee — raise a quote for this client">
                            <FilePlus2 size={12} /> Quote
                          </a>
                          <a href={`/clients/${r.entity_id}`} target="_blank" rel="noreferrer"
                            style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, color: '#64748b', textDecoration: 'none' }}>
                            Client <ExternalLink size={11} />
                          </a>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
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
      padding: '6px 12px', fontSize: 12, fontWeight: isActive ? 600 : 500,
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
      padding: '7px 14px', fontSize: 12, fontWeight: isActive ? 600 : 400,
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
      <div style={{ fontSize: 10, fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase' }}>{label}</div>
      <div style={{ fontSize: big ? 24 : 18, fontWeight: 700, color: '#0f172a', marginTop: 2 }}>{value}</div>
      {hint && <div style={{ fontSize: 10, color: '#cbd5e1', marginTop: 2 }}>{hint}</div>}
    </div>
  );
}

const th = { padding: '10px 12px', textAlign: 'left', fontWeight: 600, whiteSpace: 'nowrap' };
const td = { padding: '8px 12px', color: '#0f172a', verticalAlign: 'middle' };
const inputStyle = { width: '100%', padding: '6px 9px', fontSize: 12, border: '1px solid #e5e7eb', borderRadius: 6, fontFamily: font, boxSizing: 'border-box', background: '#fff' };
