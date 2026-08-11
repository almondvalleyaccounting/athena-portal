import React, { useEffect, useMemo, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { fetchAllRows } from '../../lib/fetchAllRows';
import { fmtGbp } from '../../lib/money';

const font = "'Outfit', sans-serif";

// Compute and render revenue per fee earner.
//
// Resolution for each (entity, service) line — the DELIBERATE allocation
// leads, so this block agrees with the Fee Earner Book instead of running
// a competing engine:
//   1. client_service_allocations[entity, service].fee_earner_id — the
//      human-edited allocation (same source as the Fee Earner Book)
//   2. Inference fallback, counted separately and labelled "inferred":
//      a. billing_service_mappings.default_fee_earner_id
//      b. v_inferred_allocations[entity, mapping.canonical_service_id]
//      c. v_inferred_allocations[entity, 'accounts_submission']
//   3. "Unassigned" — only when nothing above resolves
//
// Pulls everything in one batch and joins client-side. The data
// volume is small (~200 billing rows × ~30 staff).
export default function RevenueByFeeEarner() {
  const [rows, setRows] = useState([]); // computed per fee earner
  const [loading, setLoading] = useState(true);
  const [unmappedSample, setUnmappedSample] = useState([]); // first few unmapped service_ids for the hint banner

  useEffect(() => {
    const load = async () => {
      // `alloc` comes back as a plain array (fetchAllRows), the rest as { data }.
      const [{ data: billing }, { data: allocations }, { data: maps }, alloc, { data: staff }] = await Promise.all([
        supabase.from('live_billing').select('entity_id, services, entity:entities(id, name, entity_status)').eq('status', 'active'),
        supabase.from('client_service_allocations').select('entity_id, service_id, fee_earner_id'),
        supabase.from('billing_service_mappings').select('service_id, canonical_service_id, default_fee_earner_id'),
        // Paged: 909 rows against a 1000-row cap, and this drives revenue split
        // by fee earner — a truncated read moves money to the wrong person.
        fetchAllRows(() => supabase.from('v_inferred_allocations')
          .select('entity_id, canonical_service_id, assignee_id')
          .order('entity_id').order('canonical_service_id')),
        supabase.from('staff_profiles').select('id, name').order('name'),
      ]);

      // The deliberate source: `${entity_id}::${service_id}` → fee_earner_id
      const chosenLookup = new Map();
      for (const a of allocations || []) {
        if (a.fee_earner_id) chosenLookup.set(`${a.entity_id}::${a.service_id}`, a.fee_earner_id);
      }

      const mapByService = new Map();
      for (const m of maps || []) mapByService.set(m.service_id, m);

      // inference lookup: `${entity_id}::${canonical_service}` → assignee_id
      const allocLookup = new Map();
      for (const a of alloc || []) allocLookup.set(`${a.entity_id}::${a.canonical_service_id}`, a.assignee_id);

      const staffById = new Map();
      for (const s of staff || []) staffById.set(s.id, s);

      const byFeeEarner = new Map(); // assignee_id|'unassigned' → { id, name, monthly, annual, inferredAnnualised }
      const unmappedSet = new Set();

      for (const r of billing || []) {
        if (r.entity?.entity_status === 'nlac') continue;
        const services = Array.isArray(r.services) ? r.services : [];
        for (const s of services) {
          const status = s.approval_status || 'suggested';
          if (status !== 'approved') continue;
          if (s.recurring_status === 'ending') continue;

          // House convention (see feeRollup.js): monthly_amount is the
          // per-cycle charge for BOTH cadences — for annual lines it IS the
          // yearly fee, and the stored annual_amount is ×12-inflated. This
          // block previously summed annual_amount and overstated annual-
          // cadence revenue twelvefold.
          const monthly = s.cadence === 'monthly' ? (Number(s.monthly_amount) || 0) : 0;
          const annual  = s.cadence === 'annual'  ? (Number(s.monthly_amount) || 0) : 0;
          if (monthly === 0 && annual === 0) continue;

          const sid = s.service_id || s.description || '';

          // 1. Deliberate allocation first.
          let assignee = chosenLookup.get(`${r.entity_id}::${sid}`) || null;
          let inferred = false;

          // 2. Inference fallback — labelled, never silently equal.
          if (!assignee) {
            const mapping = mapByService.get(sid);
            if (mapping?.default_fee_earner_id) {
              assignee = mapping.default_fee_earner_id;
            } else if (mapping?.canonical_service_id) {
              assignee = allocLookup.get(`${r.entity_id}::${mapping.canonical_service_id}`) || null;
            }
            if (!assignee) assignee = allocLookup.get(`${r.entity_id}::accounts_submission`) || null;
            if (assignee) inferred = true;
          }
          if (!assignee && sid) unmappedSet.add(sid);

          const key = assignee || 'unassigned';
          const entry = byFeeEarner.get(key) || {
            id: key,
            name: assignee ? (staffById.get(assignee)?.name || 'Unknown staff') : 'Unassigned',
            monthly: 0,
            annual: 0,
            inferredAnnualised: 0,
          };
          entry.monthly += monthly;
          entry.annual  += annual;
          if (inferred) entry.inferredAnnualised += monthly * 12 + annual;
          byFeeEarner.set(key, entry);
        }
      }

      const out = Array.from(byFeeEarner.values()).map((e) => ({
        ...e,
        monthly: Math.round(e.monthly * 100) / 100,
        annual: Math.round(e.annual * 100) / 100,
        inferredAnnualised: Math.round(e.inferredAnnualised * 100) / 100,
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
      <h3 style={{ fontSize: 14, fontWeight: 700, color: '#0c4a6e', margin: '0 0 4px 0' }}>Revenue by fee earner</h3>
      <p style={{ fontSize: 11, color: '#94a3b8', margin: '0 0 8px 0' }}>
        Follows your fee-earner allocations (same source as the Fee Earner Book). Lines with no
        allocation fall back to capacity-planner inference and are counted as “inferred”.
      </p>
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
            <span style={{ fontWeight: 500, color: r.id === 'unassigned' ? '#92400e' : '#0f172a' }}>
              {r.name}
              {r.inferredAnnualised > 0 && r.id !== 'unassigned' && (
                <span
                  style={{ marginLeft: 6, fontSize: 10, fontWeight: 600, color: '#92400e', background: '#fef3c7', border: '1px solid #fcd34d', borderRadius: 4, padding: '1px 5px' }}
                  title={`${fmtGbp(r.inferredAnnualised)}/yr of this attribution is inferred (no allocation set) — set allocations on the client page to make it deliberate`}
                >
                  {fmtGbp(r.inferredAnnualised)}/yr inferred
                </span>
              )}
            </span>
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
