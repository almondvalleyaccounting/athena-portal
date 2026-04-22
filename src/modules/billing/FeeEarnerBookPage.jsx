import React, { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { supabase } from '../../lib/supabase';

const font = "'Outfit', sans-serif";
const fmt = (n) => new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP', maximumFractionDigits: 0 }).format(n || 0);

// Fee Earner Book — practice-wide attribution of live billing and
// accepted-quote pipeline, grouped either by fee earner or by the fee
// earner's manager. Source of truth is `client_service_allocations`
// joined to `live_billing.services` (for £) and to `quotes` (pipeline).
//
// Intentionally read-only — this is a reporting surface. Allocations
// are edited at commit time or on the client detail page.
export default function FeeEarnerBookPage() {
  const navigate = useNavigate();
  const [mode, setMode] = useState('fee_earner'); // 'fee_earner' | 'manager'
  const [loading, setLoading] = useState(true);
  const [allocations, setAllocations] = useState([]);
  const [billing, setBilling] = useState([]);
  const [quotes, setQuotes] = useState([]);
  const [staff, setStaff] = useState([]);
  const [expanded, setExpanded] = useState(null);

  useEffect(() => {
    (async () => {
      const results = await Promise.allSettled([
        supabase.from('client_service_allocations').select('*'),
        supabase.from('live_billing').select('entity_id, services, billing_type, status, entity:entities(id, name)').eq('status', 'active'),
        supabase.from('quotes').select('id, entity_id, primary_entity_id, quote_ref, status, monthly_gross, annual_total, accepted_at, committed_at, relationship_group').in('status', ['accepted']),
        supabase.from('staff_profiles').select('id, name, email').order('name'),
      ]);
      setAllocations(results[0].value?.data || []);
      setBilling(results[1].value?.data || []);
      setQuotes(results[2].value?.data || []);
      setStaff((results[3].value?.data || []).map((s) => ({ ...s, name: s.name || s.email })));
      setLoading(false);
    })();
  }, []);

  // Per (entity_id, service_id) £ rollups from live_billing.services.
  // Cadence splits the £ bucket so a mix of monthly + annual + one-off
  // reconciles cleanly against the dashboard headlines.
  const billingByKey = useMemo(() => {
    const m = new Map();
    for (const b of billing) {
      const services = Array.isArray(b.services) ? b.services : [];
      for (const s of services) {
        const sid = s.service_id || s.description;
        if (!sid) continue;
        const approved = (s.approval_status || 'approved') === 'approved';
        if (!approved) continue;
        const key = `${b.entity_id}::${sid}`;
        if (!m.has(key)) {
          m.set(key, {
            entity_id: b.entity_id,
            entity_name: b.entity?.name || 'Unknown',
            service_id: sid,
            monthly_annualised: 0,
            annual: 0,
            one_off: 0,
          });
        }
        const entry = m.get(key);
        const amt = Number(s.annual_amount) || 0;
        const cadence = s.cadence || (s.billing_type === 'one_off' ? 'one_off' : s.billing_type === 'annual' ? 'annual' : 'monthly');
        if (cadence === 'annual') entry.annual += amt;
        else if (cadence === 'one_off') entry.one_off += amt;
        else entry.monthly_annualised += amt;
      }
    }
    return m;
  }, [billing]);

  const staffMap = useMemo(() => {
    const m = {};
    for (const s of staff) m[s.id] = s.name;
    return m;
  }, [staff]);

  // Pipeline = accepted, not-yet-committed quotes. Attributed to the
  // client (whole-quote monthly_gross) — per-service attribution isn't
  // known until commit-time allocation, so this is deliberately coarse.
  const pipelineByEntity = useMemo(() => {
    const m = new Map();
    for (const q of quotes) {
      if (q.committed_at) continue;
      const eid = q.entity_id || q.primary_entity_id;
      if (!eid) continue;
      const cur = m.get(eid) || { monthly: 0, annual: 0, count: 0 };
      cur.monthly += Number(q.monthly_gross) || 0;
      cur.annual += Number(q.annual_total) || 0;
      cur.count += 1;
      m.set(eid, cur);
    }
    return m;
  }, [quotes]);

  // Roll up by chosen grouping key (fee_earner_id | fee_earner_manager_id).
  const rollup = useMemo(() => {
    const groupKey = mode === 'fee_earner' ? 'fee_earner_id' : 'fee_earner_manager_id';
    const out = new Map();

    for (const a of allocations) {
      const gid = a[groupKey];
      if (!gid) continue;
      if (!out.has(gid)) {
        out.set(gid, {
          staff_id: gid,
          staff_name: staffMap[gid] || '(unknown)',
          monthly_annualised: 0,
          annual: 0,
          one_off: 0,
          pipeline_monthly: 0,
          clients: new Set(),
          rows: [],
        });
      }
      const entry = out.get(gid);
      const bill = billingByKey.get(`${a.entity_id}::${a.service_id}`);
      const monthly = bill?.monthly_annualised || 0;
      const annual = bill?.annual || 0;
      const oneOff = bill?.one_off || 0;
      entry.monthly_annualised += monthly;
      entry.annual += annual;
      entry.one_off += oneOff;
      entry.clients.add(a.entity_id);
      entry.rows.push({
        entity_id: a.entity_id,
        entity_name: bill?.entity_name || '(no live billing)',
        service_id: a.service_id,
        monthly_annualised: monthly,
        annual: annual,
        one_off: oneOff,
        other_party_id: mode === 'fee_earner' ? a.fee_earner_manager_id : a.fee_earner_id,
      });
    }

    // Fold pipeline onto the fee earner that owns the client's biggest
    // billed service — a soft attribution rule for unallocated quotes.
    // Good enough for the headline; the drill-in shows the detail.
    for (const [eid, pipe] of pipelineByEntity.entries()) {
      // Find any allocation for this entity in the current grouping.
      const match = allocations.find((a) => a.entity_id === eid && a[groupKey]);
      if (!match) continue;
      const gid = match[groupKey];
      const entry = out.get(gid);
      if (entry) entry.pipeline_monthly += pipe.monthly;
    }

    return [...out.values()]
      .map((e) => ({ ...e, client_count: e.clients.size }))
      .sort((a, b) => (b.monthly_annualised + b.annual + b.one_off) - (a.monthly_annualised + a.annual + a.one_off));
  }, [allocations, billingByKey, pipelineByEntity, staffMap, mode]);

  const totals = useMemo(() => {
    return rollup.reduce((t, r) => ({
      monthly_annualised: t.monthly_annualised + r.monthly_annualised,
      annual: t.annual + r.annual,
      one_off: t.one_off + r.one_off,
      pipeline: t.pipeline + r.pipeline_monthly,
      clients: t.clients + r.client_count,
    }), { monthly_annualised: 0, annual: 0, one_off: 0, pipeline: 0, clients: 0 });
  }, [rollup]);

  // Unallocated sanity check — any live billing that has no allocation?
  const unallocatedCount = useMemo(() => {
    const allocKeys = new Set(allocations.map((a) => `${a.entity_id}::${a.service_id}`));
    let n = 0;
    for (const key of billingByKey.keys()) {
      if (!allocKeys.has(key)) n += 1;
    }
    return n;
  }, [allocations, billingByKey]);

  return (
    <div style={{ padding: '20px 28px', fontFamily: font, maxWidth: 1280 }}>
      <button onClick={() => navigate('/manage/billing')} style={backLinkStyle}>
        <ArrowLeft size={14} /> Back to Fee Billing
      </button>

      <div style={{ marginBottom: 16 }}>
        <h1 style={{ fontFamily: "'Playfair Display', serif", fontSize: 26, fontWeight: 500, color: '#0f172a', marginBottom: 2 }}>
          Fee Earner Book
        </h1>
        <p style={{ fontSize: 13, color: '#64748b' }}>
          Practice-wide attribution of live billing and accepted-quote pipeline by fee earner or manager.
        </p>
      </div>

      {/* Mode toggle */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 16 }}>
        <TogglePill active={mode === 'fee_earner'} onClick={() => setMode('fee_earner')}>By fee earner</TogglePill>
        <TogglePill active={mode === 'manager'} onClick={() => setMode('manager')}>By fee earner manager</TogglePill>
      </div>

      {/* Unallocated warning */}
      {unallocatedCount > 0 && (
        <div style={{ padding: '10px 14px', background: '#fef3c7', border: '1px solid #fcd34d', borderRadius: 8, marginBottom: 14, fontSize: 12, color: '#78350f' }}>
          <b>{unallocatedCount}</b> live billing line{unallocatedCount === 1 ? '' : 's'} have no allocation yet — their £ is not counted below. Set allocations on each client's page.
        </div>
      )}

      {loading ? (
        <p style={{ fontSize: 13, color: '#94a3b8', padding: 40, textAlign: 'center' }}>Loading…</p>
      ) : rollup.length === 0 ? (
        <EmptyState />
      ) : (
        <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden' }}>
          <div style={headerRowStyle}>
            <span>{mode === 'fee_earner' ? 'Fee earner' : 'Fee earner manager'}</span>
            <span style={{ textAlign: 'right' }}>Monthly × 12</span>
            <span style={{ textAlign: 'right' }}>Annual</span>
            <span style={{ textAlign: 'right' }}>One-off</span>
            <span style={{ textAlign: 'right' }}>Pipeline (mo)</span>
            <span style={{ textAlign: 'right' }}>Clients</span>
            <span style={{ textAlign: 'right' }}>Total book</span>
          </div>
          {rollup.map((r) => {
            const total = r.monthly_annualised + r.annual + r.one_off;
            const isOpen = expanded === r.staff_id;
            return (
              <React.Fragment key={r.staff_id}>
                <div
                  style={{ ...dataRowStyle, cursor: 'pointer', background: isOpen ? '#f8fafc' : 'transparent' }}
                  onClick={() => setExpanded(isOpen ? null : r.staff_id)}
                >
                  <span style={{ fontWeight: 600, color: '#0f172a' }}>
                    <span style={{ display: 'inline-block', width: 14, fontSize: 10, color: '#94a3b8' }}>{isOpen ? '▾' : '▸'}</span>
                    {r.staff_name}
                  </span>
                  <span style={numStyle('#0e7fe0')}>{fmt(r.monthly_annualised)}</span>
                  <span style={numStyle('#0f766e')}>{fmt(r.annual)}</span>
                  <span style={numStyle('#6d28d9')}>{fmt(r.one_off)}</span>
                  <span style={numStyle('#b45309')}>{fmt(r.pipeline_monthly * 12)}</span>
                  <span style={numStyle('#475569')}>{r.client_count}</span>
                  <span style={{ ...numStyle('#0f172a'), fontWeight: 700 }}>{fmt(total)}</span>
                </div>
                {isOpen && (
                  <div style={{ padding: '6px 16px 12px 32px', background: '#f8fafc', borderBottom: '1px solid #f1f5f9' }}>
                    <div style={{ display: 'grid', gridTemplateColumns: '1.6fr 1fr 1fr 1fr 1fr', gap: 8, fontSize: 11, color: '#94a3b8', padding: '4px 0', borderBottom: '1px solid #e5e7eb' }}>
                      <span>Client · service</span>
                      <span>{mode === 'fee_earner' ? 'Manager' : 'Fee earner'}</span>
                      <span style={{ textAlign: 'right' }}>Monthly × 12</span>
                      <span style={{ textAlign: 'right' }}>Annual</span>
                      <span style={{ textAlign: 'right' }}>One-off</span>
                    </div>
                    {r.rows.map((row, idx) => (
                      <div key={idx} style={{ display: 'grid', gridTemplateColumns: '1.6fr 1fr 1fr 1fr 1fr', gap: 8, fontSize: 12, padding: '4px 0', borderBottom: '1px solid #f1f5f9' }}>
                        <span
                          style={{ color: '#0f172a', cursor: 'pointer' }}
                          onClick={(e) => { e.stopPropagation(); navigate(`/clients/${row.entity_id}`); }}
                        >
                          <span style={{ fontWeight: 500 }}>{row.entity_name}</span>
                          <span style={{ color: '#64748b' }}> · {row.service_id}</span>
                        </span>
                        <span style={{ color: '#64748b' }}>{row.other_party_id ? (staffMap[row.other_party_id] || '—') : '—'}</span>
                        <span style={{ textAlign: 'right', fontFamily: 'monospace', color: '#0e7fe0' }}>{fmt(row.monthly_annualised)}</span>
                        <span style={{ textAlign: 'right', fontFamily: 'monospace', color: '#0f766e' }}>{fmt(row.annual)}</span>
                        <span style={{ textAlign: 'right', fontFamily: 'monospace', color: '#6d28d9' }}>{fmt(row.one_off)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </React.Fragment>
            );
          })}
          {/* Totals */}
          <div style={{ ...dataRowStyle, background: '#f8fafc', fontWeight: 700 }}>
            <span style={{ color: '#0f172a' }}>Total</span>
            <span style={numStyle('#0e7fe0')}>{fmt(totals.monthly_annualised)}</span>
            <span style={numStyle('#0f766e')}>{fmt(totals.annual)}</span>
            <span style={numStyle('#6d28d9')}>{fmt(totals.one_off)}</span>
            <span style={numStyle('#b45309')}>{fmt(totals.pipeline * 12)}</span>
            <span style={numStyle('#475569')}>—</span>
            <span style={{ ...numStyle('#0f172a'), fontWeight: 700 }}>{fmt(totals.monthly_annualised + totals.annual + totals.one_off)}</span>
          </div>
        </div>
      )}
    </div>
  );
}

function TogglePill({ active, onClick, children }) {
  return (
    <button onClick={onClick} style={{
      fontSize: 12, fontWeight: active ? 600 : 500,
      padding: '6px 14px', borderRadius: 999,
      background: active ? '#0f172a' : '#fff',
      color: active ? '#fff' : '#475569',
      border: '1px solid ' + (active ? '#0f172a' : '#e5e7eb'),
      cursor: 'pointer', fontFamily: font,
    }}>{children}</button>
  );
}

function EmptyState() {
  return (
    <div style={{ padding: 60, textAlign: 'center' }}>
      <p style={{ fontSize: 15, fontWeight: 500, color: '#94a3b8', marginBottom: 4 }}>No allocations yet</p>
      <p style={{ fontSize: 13, color: '#cbd5e1' }}>
        Allocate fee earners on the client detail page, or when committing a quote to live billing.
      </p>
    </div>
  );
}

const backLinkStyle = {
  display: 'inline-flex', alignItems: 'center', gap: 4,
  fontSize: 12, fontWeight: 500, color: '#64748b',
  background: 'none', border: 'none', cursor: 'pointer',
  marginBottom: 12, padding: 0, fontFamily: font,
};

const headerRowStyle = {
  display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr 1fr 0.6fr 1.1fr',
  gap: 8, padding: '10px 16px', background: '#f8fafc',
  borderBottom: '1px solid #e5e7eb',
  fontSize: 11, fontWeight: 600, color: '#94a3b8',
  textTransform: 'uppercase', letterSpacing: '0.05em',
};
const dataRowStyle = {
  display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr 1fr 0.6fr 1.1fr',
  gap: 8, padding: '10px 16px',
  borderBottom: '1px solid #f1f5f9',
  fontSize: 13, alignItems: 'center',
};
const numStyle = (color) => ({ textAlign: 'right', fontFamily: 'monospace', color });
