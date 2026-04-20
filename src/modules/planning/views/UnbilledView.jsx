import React, { useEffect, useState, useMemo } from 'react';
import { AlertTriangle, CheckCircle2, XCircle, ExternalLink } from 'lucide-react';
import { supabase } from '../../../lib/supabase';

// Surfaces QBO customers that are mapped to an Athena entity but have NO active
// live_billing record. These are the "clients who've been invoiced in QBO but
// we haven't set up a recurring fee for" — they drag down our revenue forecast
// accuracy and often indicate pricing work that's been forgotten.
//
// Review statuses:
//   pending    — fresh, needs a look
//   actioned   — recurring fee has since been set up (or will be)
//   dismissed  — one-off only, don't show again
//   not_client — not really ours / misclassified

const STATUSES = [
  { value: 'pending',    label: 'Pending review', colour: '#f59e0b', bg: '#fffbeb' },
  { value: 'actioned',   label: 'Actioned',       colour: '#059669', bg: '#f0fdf4' },
  { value: 'dismissed',  label: 'One-off only',   colour: '#64748b', bg: '#f1f5f9' },
  { value: 'not_client', label: 'Not a client',   colour: '#94a3b8', bg: '#f8fafc' },
];

export default function UnbilledView() {
  const [loading, setLoading] = useState(true);
  const [candidates, setCandidates] = useState([]);
  const [reviews, setReviews] = useState([]);
  const [filter, setFilter] = useState('pending');

  useEffect(() => { load(); }, []);

  async function load() {
    setLoading(true);
    // Customers mapped to entities but without an active live_billing record
    const [{ data: mappings }, { data: billings }, { data: reviewsData }] = await Promise.all([
      supabase.from('qbo_customer_mappings')
        .select('qbo_customer_id, qbo_customer_name, entity_id, role, last_seen')
        .eq('role', 'primary')
        .not('entity_id', 'is', null),
      supabase.from('live_billing').select('qbo_customer_id').eq('status', 'active'),
      supabase.from('plan_unbilled_review').select('*'),
    ]);

    const billedIds = new Set((billings || []).map((b) => b.qbo_customer_id).filter(Boolean));
    const rawCandidates = (mappings || []).filter((m) => !billedIds.has(m.qbo_customer_id));

    // Join entity names
    const entityIds = [...new Set(rawCandidates.map((c) => c.entity_id).filter(Boolean))];
    const { data: ents } = entityIds.length
      ? await supabase.from('entities').select('id, name').in('id', entityIds)
      : { data: [] };
    const entityName = new Map((ents || []).map((e) => [e.id, e.name]));

    setCandidates(rawCandidates.map((c) => ({
      ...c,
      entity_name: entityName.get(c.entity_id) || c.qbo_customer_name,
    })));
    setReviews(reviewsData || []);
    setLoading(false);
  }

  const reviewByQbo = useMemo(() => {
    const m = new Map();
    for (const r of reviews) m.set(r.qbo_customer_id, r);
    return m;
  }, [reviews]);

  const withReview = useMemo(() => candidates.map((c) => {
    const r = reviewByQbo.get(c.qbo_customer_id);
    return { ...c, review: r || null, status: r?.status || 'pending', notes: r?.notes || '' };
  }), [candidates, reviewByQbo]);

  const filtered = useMemo(() => {
    if (filter === 'all') return withReview;
    return withReview.filter((c) => c.status === filter);
  }, [withReview, filter]);

  const counts = useMemo(() => {
    const c = { all: withReview.length };
    for (const s of STATUSES) c[s.value] = withReview.filter((x) => x.status === s.value).length;
    return c;
  }, [withReview]);

  const setStatus = async (c, status) => {
    const payload = {
      qbo_customer_id: c.qbo_customer_id,
      entity_id: c.entity_id,
      status,
      reviewed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    await supabase.from('plan_unbilled_review').upsert(payload, { onConflict: 'qbo_customer_id' });
    await load();
  };

  const setNotes = async (c, notes) => {
    const payload = {
      qbo_customer_id: c.qbo_customer_id,
      entity_id: c.entity_id,
      status: c.status,
      notes,
      updated_at: new Date().toISOString(),
    };
    await supabase.from('plan_unbilled_review').upsert(payload, { onConflict: 'qbo_customer_id' });
    await load();
  };

  if (loading) return <div style={{ color: '#94a3b8', fontSize: 13, padding: 24 }}>Loading unbilled QBO customers…</div>;

  return (
    <div>
      <div style={card}>
        <h3 style={h3}>Unbilled QBO customers</h3>
        <p style={help}>
          These QBO customers are mapped to an Athena entity but have <b>no active recurring billing</b> set up.
          They often indicate clients where a monthly fee hasn't been agreed, or fees that slipped through
          the cracks. Work through the list to either set up a recurring bill or mark as one-off / not a client.
        </p>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 10, marginBottom: 12 }}>
          <Stat label="Total unbilled" value={counts.all} colour="#0e7fe0" big />
          <Stat label="Pending" value={counts.pending} colour="#f59e0b" />
          <Stat label="Actioned" value={counts.actioned} colour="#059669" />
          <Stat label="One-off" value={counts.dismissed} colour="#64748b" />
          <Stat label="Not a client" value={counts.not_client} colour="#94a3b8" />
        </div>

        <div style={{ display: 'flex', gap: 2, borderBottom: '1px solid #e5e7eb' }}>
          <FilterTab value="pending" label="Pending" count={counts.pending} active={filter} onClick={setFilter} />
          <FilterTab value="all" label="All" count={counts.all} active={filter} onClick={setFilter} />
          {STATUSES.filter((s) => s.value !== 'pending').map((s) => (
            <FilterTab key={s.value} value={s.value} label={s.label} count={counts[s.value]} active={filter} onClick={setFilter} />
          ))}
        </div>
      </div>

      {/* Table */}
      <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, overflow: 'hidden', marginTop: 16 }}>
        <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ background: '#f8fafc', fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5, color: '#64748b' }}>
              <th style={th}>Customer</th>
              <th style={th}>QBO name</th>
              <th style={th}>Last seen</th>
              <th style={th}>Status</th>
              <th style={th}>Notes</th>
              <th style={th}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr><td colSpan={6} style={{ padding: 30, textAlign: 'center', color: '#94a3b8' }}>
                {filter === 'pending' ? 'Nothing pending — every unbilled QBO customer has been reviewed.' : 'No customers match.'}
              </td></tr>
            )}
            {filtered.map((c) => {
              const st = STATUSES.find((s) => s.value === c.status) || STATUSES[0];
              return (
                <tr key={c.qbo_customer_id} style={{ borderTop: '1px solid #f1f5f9' }}>
                  <td style={td}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      {c.status === 'pending' && <AlertTriangle size={12} style={{ color: '#f59e0b' }} />}
                      <span style={{ fontWeight: 500, color: '#0f172a' }}>{c.entity_name}</span>
                    </div>
                  </td>
                  <td style={{ ...td, color: '#64748b', fontSize: 12 }}>{c.qbo_customer_name}</td>
                  <td style={{ ...td, color: '#64748b', fontSize: 12 }}>
                    {c.last_seen ? new Date(c.last_seen).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'}
                  </td>
                  <td style={td}>
                    <select value={c.status} onChange={(e) => setStatus(c, e.target.value)}
                      style={{ ...inputStyle, color: st.colour, fontWeight: 500, background: st.bg, border: `1px solid ${st.colour}33` }}>
                      {STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                    </select>
                  </td>
                  <td style={{ ...td, minWidth: 180 }}>
                    <BlurInput value={c.notes} onChange={(v) => setNotes(c, v)} placeholder="Notes…" />
                  </td>
                  <td style={td}>
                    <a href={`/manage/clients/${c.entity_id}`} target="_blank" rel="noreferrer"
                      style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, color: '#0e7fe0', textDecoration: 'none' }}>
                      Open client <ExternalLink size={11} />
                    </a>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function BlurInput({ value, onChange, placeholder }) {
  const [v, setV] = useState(value || '');
  React.useEffect(() => setV(value || ''), [value]);
  return <input value={v} placeholder={placeholder}
    onChange={(e) => setV(e.target.value)}
    onBlur={() => { if (v !== (value || '')) onChange(v); }}
    style={inputStyle} />;
}

function FilterTab({ value, label, count, active, onClick }) {
  const isActive = active === value;
  return (
    <button onClick={() => onClick(value)} style={{
      padding: '7px 12px', fontSize: 12, fontWeight: isActive ? 600 : 400,
      color: isActive ? '#0f172a' : '#94a3b8',
      background: 'none', border: 'none',
      borderBottom: isActive ? '2px solid #0e7fe0' : '2px solid transparent',
      cursor: 'pointer', fontFamily: "'Outfit', sans-serif",
    }}>
      {label} <span style={{ color: isActive ? '#0e7fe0' : '#cbd5e1', fontSize: 10, marginLeft: 3 }}>{count}</span>
    </button>
  );
}

function Stat({ label, value, colour, big }) {
  return (
    <div style={{ background: '#f8fafc', borderRadius: 8, padding: '10px 12px', borderLeft: `3px solid ${colour}` }}>
      <div style={{ fontSize: 10, fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase' }}>{label}</div>
      <div style={{ fontSize: big ? 22 : 18, fontWeight: 700, color: '#0f172a', marginTop: 2 }}>{value}</div>
    </div>
  );
}

const card = { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 20 };
const h3 = { fontFamily: "'Playfair Display', serif", fontSize: 16, fontWeight: 500, color: '#0f172a', margin: '0 0 4px' };
const help = { fontSize: 12, color: '#94a3b8', marginBottom: 14, lineHeight: 1.55 };
const th = { padding: '10px 12px', textAlign: 'left', fontWeight: 600 };
const td = { padding: '8px 12px', color: '#0f172a', verticalAlign: 'middle' };
const inputStyle = { width: '100%', padding: '7px 10px', fontSize: 13, border: '1px solid #e5e7eb', borderRadius: 6, fontFamily: "'Outfit', sans-serif", boxSizing: 'border-box', background: '#fff' };
