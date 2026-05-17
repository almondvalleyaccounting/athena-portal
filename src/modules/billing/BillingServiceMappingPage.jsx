import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Settings } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../shell/AppShell';
import BillingTabs from './BillingTabs';
import SearchInput from '../../components/SearchInput';
import EmptyState from '../../components/EmptyState';
import { fmtGbp } from '../../lib/money';

const font = "'Outfit', sans-serif";

// Map every billing service_id to either a capacity-planner canonical
// service (resolved per-client to a fee earner via v_inferred_
// allocations) or to a default fee earner that always handles it
// (e.g. Payroll → Stephanie). Unmapped services fall back to the
// accounts_submission assignee for that client.
const CANONICAL_SERVICES = [
  { id: 'bookkeeping',          label: 'Bookkeeping' },
  { id: 'vat_review',           label: 'VAT Reviews' },
  { id: 'accounts_preparation', label: 'Accounts Preparation' },
  { id: 'accounts_submission',  label: 'Accounts Submission' },
  { id: 'self_assessment',      label: 'Self Assessment' },
];

export default function BillingServiceMappingPage() {
  const navigate = useNavigate();
  const { profile } = useAuth();

  const [serviceUsage, setServiceUsage] = useState([]); // [{ service_id, monthly, annual, count }]
  const [mappings, setMappings] = useState({}); // service_id → { canonical_service_id, default_fee_earner_id }
  const [staff, setStaff] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState('');

  const load = async () => {
    setLoading(true);
    const [{ data: billing }, { data: maps }, { data: people }] = await Promise.all([
      supabase.from('live_billing').select('services').eq('status', 'active'),
      supabase.from('billing_service_mappings').select('*'),
      supabase.from('staff_profiles').select('id, name, email').order('name'),
    ]);

    // Aggregate usage: how much revenue is tied to each service_id.
    const usage = new Map();
    for (const r of billing || []) {
      const services = Array.isArray(r.services) ? r.services : [];
      for (const s of services) {
        const status = s.approval_status || 'suggested';
        if (status !== 'approved') continue;
        const sid = s.service_id || s.description || 'Unknown';
        const entry = usage.get(sid) || { service_id: sid, monthly: 0, annual: 0, count: 0 };
        if (s.cadence === 'monthly') entry.monthly += Number(s.monthly_amount) || 0;
        else if (s.cadence === 'annual') entry.annual += Number(s.annual_amount) || 0;
        entry.count += 1;
        usage.set(sid, entry);
      }
    }
    setServiceUsage(Array.from(usage.values()).sort((a, b) => (b.monthly + b.annual / 12) - (a.monthly + a.annual / 12)));

    const map = {};
    for (const m of maps || []) {
      map[m.service_id] = {
        canonical_service_id: m.canonical_service_id || '',
        default_fee_earner_id: m.default_fee_earner_id || '',
        notes: m.notes || '',
      };
    }
    setMappings(map);
    setStaff(people || []);
    setLoading(false);
  };
  useEffect(() => { load(); }, []);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return serviceUsage;
    return serviceUsage.filter((s) => s.service_id.toLowerCase().includes(q));
  }, [serviceUsage, search]);

  const updateMapping = async (serviceId, patch) => {
    setSaving(true);
    const existing = mappings[serviceId] || { canonical_service_id: '', default_fee_earner_id: '', notes: '' };
    const merged = { ...existing, ...patch };
    setMappings((prev) => ({ ...prev, [serviceId]: merged }));

    const row = {
      service_id: serviceId,
      canonical_service_id: merged.canonical_service_id || null,
      default_fee_earner_id: merged.default_fee_earner_id || null,
      notes: merged.notes || null,
      updated_at: new Date().toISOString(),
      updated_by: profile?.id || null,
    };
    await supabase.from('billing_service_mappings').upsert(row, { onConflict: 'service_id' });
    setSaving(false);
  };

  const stats = useMemo(() => {
    let mapped = 0;
    for (const s of serviceUsage) {
      const m = mappings[s.service_id];
      if (m && (m.canonical_service_id || m.default_fee_earner_id)) mapped++;
    }
    return { mapped, total: serviceUsage.length };
  }, [serviceUsage, mappings]);

  return (
    <div style={{ padding: '20px 28px', fontFamily: font, maxWidth: 1280 }}>
      <h1 style={{ fontFamily: "'Playfair Display', serif", fontSize: 26, fontWeight: 500, color: '#0f172a', marginBottom: 2 }}>
        Service → fee earner mapping
      </h1>
      <p style={{ fontSize: 13, color: '#64748b', maxWidth: 760, marginBottom: 14 }}>
        Tell Athena who earns the revenue from each billing service. Map to a capacity-planner service (resolved per-client) or pin to a specific fee earner. Anything unmapped falls back to the Accounts Submission assignee for that client.
      </p>

      <BillingTabs active="mapping" />

      {loading ? (
        <p style={{ fontSize: 13, color: '#94a3b8', padding: 40, textAlign: 'center' }}>Loading…</p>
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
            <div style={{ fontSize: 13, color: '#475569' }}>
              <strong style={{ color: '#0f172a' }}>{stats.mapped}</strong> of <strong style={{ color: '#0f172a' }}>{stats.total}</strong> services mapped
              {saving && <span style={{ marginLeft: 12, fontSize: 11, color: '#94a3b8' }}>Saving…</span>}
            </div>
            <div style={{ flex: 1 }} />
            <SearchInput value={search} onChange={setSearch} placeholder="Search service…" style={{ minWidth: 240 }} />
          </div>

          {visible.length === 0 ? (
            <EmptyState
              icon={<Settings size={28} />}
              title="No services to map"
              body={search ? 'No services match your search.' : 'Run a QBO pull to import billing services first.'}
              actions={search ? [{ label: 'Clear search', onClick: () => setSearch('') }] : [{ label: 'Back to dashboard', onClick: () => navigate('/manage/billing') }]}
            />
          ) : (
            <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ background: '#f8fafc' }}>
                    <Th>Service</Th>
                    <Th align="right">Monthly £</Th>
                    <Th align="right">Annual £</Th>
                    <Th align="right">Clients</Th>
                    <Th>Maps to canonical service</Th>
                    <Th>Or default fee earner</Th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((s) => {
                    const m = mappings[s.service_id] || { canonical_service_id: '', default_fee_earner_id: '' };
                    return (
                      <tr key={s.service_id} style={{ borderTop: '1px solid #f1f5f9' }}>
                        <Td>
                          <div style={{ fontWeight: 500, color: '#0f172a' }}>{s.service_id}</div>
                        </Td>
                        <Td align="right" style={{ fontFamily: 'monospace' }}>{fmtGbp(s.monthly)}</Td>
                        <Td align="right" style={{ fontFamily: 'monospace' }}>{fmtGbp(s.annual)}</Td>
                        <Td align="right" style={{ color: '#64748b' }}>{s.count}</Td>
                        <Td>
                          <select
                            value={m.canonical_service_id}
                            onChange={(e) => updateMapping(s.service_id, { canonical_service_id: e.target.value })}
                            disabled={saving}
                            style={selectStyle}
                          >
                            <option value="">— none —</option>
                            {CANONICAL_SERVICES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
                          </select>
                        </Td>
                        <Td>
                          <select
                            value={m.default_fee_earner_id}
                            onChange={(e) => updateMapping(s.service_id, { default_fee_earner_id: e.target.value })}
                            disabled={saving}
                            style={selectStyle}
                          >
                            <option value="">— resolve from canonical —</option>
                            {staff.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                          </select>
                        </Td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

const Th = ({ children, align }) => <th style={{ textAlign: align || 'left', padding: '8px 12px', fontSize: 11, fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{children}</th>;
const Td = ({ children, align, style }) => <td style={{ padding: '8px 12px', verticalAlign: 'middle', textAlign: align || 'left', ...style }}>{children}</td>;
const selectStyle = { width: '100%', padding: '5px 8px', fontSize: 12, fontFamily: font, border: '1px solid #e5e7eb', borderRadius: 6, background: '#fff', color: '#0f172a', outline: 'none' };
