import React, { useEffect, useMemo, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { fmtGbp } from '../../lib/money';

const font = "'Outfit', sans-serif";

// Compute and render revenue per fee earner.
//
// Resolution for each (entity, service) line:
//   1. billing_service_mappings.default_fee_earner_id — hard override
//   2. v_inferred_allocations[entity, mapping.canonical_service_id] —
//      capacity-planner assignee
//   3. v_inferred_allocations[entity, 'accounts_submission'] — the
//      catch-all per user instruction
//   4. "Unassigned" — only when nothing above resolves
//
// Pulls everything in one batch and joins client-side. The data
// volume is small (~200 billing rows × ~30 staff).
export default function RevenueByFeeEarner() {
  const [rows, setRows] = useState([]); // computed per fee earner
  const [loading, setLoading] = useState(true);
  const [unmappedSample, setUnmappedSample] = useState([]); // first few unmapped service_ids for the hint banner

  useEffect(() => {
    const load = async () => {
      const [{ data: billing }, { data: maps }, { data: alloc }, { data: staff }] = await Promise.all([
        supabase.from('live_billing').select('entity_id, services, entity:entities(id, name, entity_status)').eq('status', 'active'),
        supabase.from('billing_service_mappings').select('service_id, canonical_service_id, default_fee_earner_id'),
        supabase.from('v_inferred_allocations').select('entity_id, canonical_service_id, assignee_id'),
        supabase.from('staff_profiles').select('id, name').order('name'),
      ]);

      const mapByService = new Map();
      for (const m of maps || []) mapByService.set(m.service_id, m);

      // alloc lookup: `${entity_id}::${canonical_service}` → assignee_id
      const allocLookup = new Map();
      for (const a of alloc || []) allocLookup.set(`${a.entity_id}::${a.canonical_service_id}`, a.assignee_id);

      const staffById = new Map();
      for (const s of staff || []) staffById.set(s.id, s);

      const byFeeEarner = new Map(); // assignee_id|'unassigned' → { id, name, monthly, annual }
      const unmappedSet = new Set();

      for (const r of billing || []) {
        if (r.entity?.entity_status === 'nlac') continue;
        const services = Array.isArray(r.services) ? r.services : [];
        for (const s of services) {
          const status = s.approval_status || 'suggested';
          if (status !== 'approved') continue;
          if (s.recurring_status === 'ending') continue;

          const monthly = s.cadence === 'monthly' ? (Number(s.monthly_amount) || 0) : 0;
          const annual  = s.cadence === 'annual'  ? (Number(s.annual_amount)  || 0) : 0;
          if (monthly === 0 && annual === 0) continue;

          const sid = s.service_id || s.description || '';
          const mapping = mapByService.get(sid);
          let assignee = null;
          if (mapping?.default_fee_earner_id) {
            assignee = mapping.default_fee_earner_id;
          } else if (mapping?.canonical_service_id) {
            assignee = allocLookup.get(`${r.entity_id}::${mapping.canonical_service_id}`) || null;
          }
          if (!assignee) assignee = allocLookup.get(`${r.entity_id}::accounts_submission`) || null;
          if (!assignee && sid) unmappedSet.add(sid);

          const key = assignee || 'unassigned';
          const entry = byFeeEarner.get(key) || {
            id: key,
            name: assignee ? (staffById.get(assignee)?.name || 'Unknown staff') : 'Unassigned',
            monthly: 0,
            annual: 0,
          };
          entry.monthly += monthly;
          entry.annual  += annual;
          byFeeEarner.set(key, entry);
        }
      }

      const out = Array.from(byFeeEarner.values()).map((e) => ({
        ...e,
        monthly: Math.round(e.monthly * 100) / 100,
        annual: Math.round(e.annual * 100) / 100,
        totalAnnual: Math.round((e.monthly * 12 + e.annual) * 100) / 100,
      })).sort((a, b) => b.totalAnnual - a.totalAnnual);

      setRows(out);
      setUnmappedSample(Array.from(unmappedSet).slice(0, 5));
      setLoading(false);
    };
    load();
  }, []);

  const totals = useMemo(() => {
    const m = rows.reduce((s, r) => s + r.monthly, 0);
    const a = rows.reduce((s, r) => s + r.annual, 0);
    return { monthly: m, annual: a, totalAnnual: m * 12 + a };
  }, [rows]);

  if (loading) return <p style={{ fontSize: 12, color: '#94a3b8', padding: 12 }}>Loading fee-earner revenue…</p>;
  if (rows.length === 0) return null;

  const unassignedRow = rows.find((r) => r.id === 'unassigned');

  return (
    <div style={{ marginBottom: 16, fontFamily: font }}>
      <h3 style={{ fontSize: 14, fontWeight: 700, color: '#0c4a6e', margin: '0 0 8px 0' }}>Revenue by fee earner</h3>
      {unassignedRow && unassignedRow.totalAnnual > 0 && (
        <div style={{ fontSize: 11, color: '#92400e', background: '#fef3c7', border: '1px solid #fcd34d', borderRadius: 8, padding: '6px 10px', marginBottom: 8 }}>
          <strong>{fmtGbp(unassignedRow.totalAnnual)}/year</strong> couldn't be assigned to a fee earner.
          {unmappedSample.length > 0 && (
            <span> Unmapped services: {unmappedSample.join(', ')}{unmappedSample.length === 5 ? '…' : ''}. Configure them on the Mapping tab.</span>
          )}
        </div>
      )}
      <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr', padding: '8px 14px', background: '#f8fafc', fontSize: 10, fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          <span>Fee earner</span>
          <span style={{ textAlign: 'right' }}>Monthly £</span>
          <span style={{ textAlign: 'right' }}>Annual £</span>
          <span style={{ textAlign: 'right' }}>Annualised total</span>
        </div>
        {rows.map((r) => (
          <div key={r.id} style={{
            display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr',
            padding: '8px 14px', borderTop: '1px solid #f1f5f9',
            fontSize: 13, color: '#0f172a',
            background: r.id === 'unassigned' ? '#fffbeb' : '#fff',
          }}>
            <span style={{ fontWeight: 500, color: r.id === 'unassigned' ? '#92400e' : '#0f172a' }}>{r.name}</span>
            <span style={{ textAlign: 'right', fontFamily: 'monospace', color: '#0e7fe0' }}>{fmtGbp(r.monthly)}</span>
            <span style={{ textAlign: 'right', fontFamily: 'monospace', color: '#0f766e' }}>{fmtGbp(r.annual)}</span>
            <span style={{ textAlign: 'right', fontFamily: 'monospace', fontWeight: 600 }}>{fmtGbp(r.totalAnnual)}</span>
          </div>
        ))}
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr', padding: '8px 14px', borderTop: '2px solid #e5e7eb', fontSize: 13, color: '#0f172a', background: '#f8fafc' }}>
          <span style={{ fontWeight: 700 }}>Total</span>
          <span style={{ textAlign: 'right', fontFamily: 'monospace', fontWeight: 700, color: '#0e7fe0' }}>{fmtGbp(totals.monthly)}</span>
          <span style={{ textAlign: 'right', fontFamily: 'monospace', fontWeight: 700, color: '#0f766e' }}>{fmtGbp(totals.annual)}</span>
          <span style={{ textAlign: 'right', fontFamily: 'monospace', fontWeight: 700 }}>{fmtGbp(totals.totalAnnual)}</span>
        </div>
      </div>
    </div>
  );
}
