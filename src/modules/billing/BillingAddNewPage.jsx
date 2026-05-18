import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, X } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../shell/AppShell';
import BillingTabs from './BillingTabs';
import SearchInput from '../../components/SearchInput';
import EmptyState from '../../components/EmptyState';
import { fmtGbp } from '../../lib/money';
import { tones } from '../../lib/tokens';

const font = "'Outfit', sans-serif";

// "Add New" — surface BrightManager entities that have services
// switched on in the capacity planner but no QBO customer yet (and
// therefore no live_billing row). Lets staff set up billing locally
// in Athena. A QBO customer can be created later via Manage Mapping.
//
// Source: entities (source='brightmanager', no qbo_customer_id) ⨯
//         v_inferred_allocations (canonical services per entity)
const CANONICAL_SERVICES = [
  { id: 'bookkeeping',          label: 'Bookkeeping',          cadence: 'monthly', defaultAmount: 75 },
  { id: 'vat_review',           label: 'VAT Reviews',          cadence: 'monthly', defaultAmount: 25 },
  { id: 'accounts_preparation', label: 'Accounts Preparation', cadence: 'annual',  defaultAmount: 450 },
  { id: 'accounts_submission',  label: 'Accounts Submission',  cadence: 'annual',  defaultAmount: 200 },
  { id: 'self_assessment',      label: 'Self Assessment',      cadence: 'annual',  defaultAmount: 250 },
];
const SERVICE_BY_ID = Object.fromEntries(CANONICAL_SERVICES.map((s) => [s.id, s]));

export default function BillingAddNewPage() {
  const navigate = useNavigate();
  const { profile } = useAuth();

  const [candidates, setCandidates] = useState([]);
  const [qboItems, setQboItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('all'); // all | sole_trader | limited_company
  const [adding, setAdding] = useState(null); // candidate row being set up

  const load = async () => {
    setLoading(true);
    const [{ data: ents }, { data: allocs }, { data: items }] = await Promise.all([
      supabase
        .from('entities')
        .select('id, name, type, bm_client_id')
        .eq('entity_status', 'active')
        .eq('source', 'brightmanager')
        .is('qbo_customer_id', null)
        .order('name', { ascending: true }),
      supabase
        .from('v_inferred_allocations')
        .select('entity_id, canonical_service_id'),
      supabase
        .from('qbo_items')
        .select('qbo_item_id, name, description, type, unit_price, active')
        .eq('active', true)
        .order('name', { ascending: true }),
    ]);
    setQboItems(items || []);

    const servicesByEntity = new Map();
    for (const a of allocs || []) {
      const set = servicesByEntity.get(a.entity_id) || new Set();
      set.add(a.canonical_service_id);
      servicesByEntity.set(a.entity_id, set);
    }

    setCandidates((ents || [])
      .map((e) => ({ ...e, services: Array.from(servicesByEntity.get(e.id) || []).sort() }))
      .filter((e) => e.services.length > 0));
    setLoading(false);
  };
  useEffect(() => { load(); }, []);

  const visible = useMemo(() => {
    let out = candidates;
    if (typeFilter !== 'all') out = out.filter((c) => c.type === typeFilter);
    const q = search.trim().toLowerCase();
    if (q) out = out.filter((c) => (c.name || '').toLowerCase().includes(q) || (c.bm_client_id || '').toLowerCase().includes(q));
    return out;
  }, [candidates, search, typeFilter]);

  const typeCounts = useMemo(() => {
    const c = { all: candidates.length, sole_trader: 0, limited_company: 0, other: 0 };
    for (const x of candidates) {
      if (x.type === 'sole_trader') c.sole_trader++;
      else if (x.type === 'limited_company') c.limited_company++;
      else c.other++;
    }
    return c;
  }, [candidates]);

  const addBilling = async ({ entityId, lines }) => {
    if (!entityId || lines.length === 0) return;
    setSaving(true);
    const now = new Date().toISOString();
    const services = lines.map((l) => {
      const monthly = l.cadence === 'monthly' ? Number(l.amount) || 0 : 0;
      const annual = l.cadence === 'annual' ? Number(l.amount) || 0 : monthly * 12;
      return {
        service_id: l.serviceId,
        qbo_item_id: l.qboItemId || null,
        description: l.description || SERVICE_BY_ID[l.serviceId]?.label || l.serviceId,
        cadence: l.cadence,
        cadence_months: l.cadence === 'monthly' ? 1 : l.cadence === 'annual' ? 12 : 0,
        monthly_amount: l.cadence === 'annual' ? Math.round(annual / 12 * 100) / 100 : monthly,
        annual_amount: annual,
        approval_status: 'approved',
        approved_by: profile?.id || null,
        approved_at: now,
        billing_type: l.cadence === 'monthly' ? 'recurring' : l.cadence,
      };
    });
    const rowMonthlyNet = services.reduce((s, sv) => sv.cadence === 'monthly' ? s + (Number(sv.monthly_amount) || 0) : s, 0);
    const rowAnnualTotal = services.reduce((s, sv) => s + (Number(sv.annual_amount) || 0), 0);

    const { error } = await supabase.from('live_billing').insert({
      entity_id: entityId,
      billing_type: rowMonthlyNet > 0 ? 'recurring' : 'annual',
      monthly_net: Math.round(rowMonthlyNet * 100) / 100,
      monthly_vat: Math.round(rowMonthlyNet * 0.2 * 100) / 100,
      monthly_gross: Math.round(rowMonthlyNet * 1.2 * 100) / 100,
      annual_total: Math.round(rowAnnualTotal * 100) / 100,
      services,
      status: 'active',
    });
    setSaving(false);
    if (error) {
      alert('Failed to add billing: ' + error.message);
      return;
    }
    setAdding(null);
    await load();
  };

  return (
    <div style={{ padding: '20px 28px', fontFamily: font, maxWidth: 1280 }}>
      <h1 style={{ fontFamily: "'Playfair Display', serif", fontSize: 26, fontWeight: 500, color: '#0f172a', marginBottom: 2 }}>
        Add new
      </h1>
      <p style={{ fontSize: 13, color: '#64748b', maxWidth: 760, marginBottom: 14 }}>
        BrightManager clients with services switched on but no QuickBooks customer (and therefore no billing in Athena). Pick a client, set fee amounts per service, and add them to the billing book.
      </p>

      <BillingTabs active="addnew" />

      {loading ? (
        <p style={{ fontSize: 13, color: '#94a3b8', padding: 40, textAlign: 'center' }}>Loading…</p>
      ) : candidates.length === 0 ? (
        <EmptyState
          icon="✓"
          title="No clients to add"
          body="Every active BrightManager client with services switched on already has billing in Athena (or a QBO customer)."
          actions={[{ label: 'Back to Dashboard', onClick: () => navigate('/manage/billing'), primary: true }]}
        />
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
            <Pill label="All" count={typeCounts.all} active={typeFilter === 'all'} onClick={() => setTypeFilter('all')} />
            <Pill label="Sole trader" count={typeCounts.sole_trader} active={typeFilter === 'sole_trader'} tone="info" onClick={() => setTypeFilter('sole_trader')} />
            <Pill label="Limited company" count={typeCounts.limited_company} active={typeFilter === 'limited_company'} tone="success" onClick={() => setTypeFilter('limited_company')} />
            <SearchInput
              value={search}
              onChange={setSearch}
              placeholder="Search client or BM ref…"
              style={{ flex: 1, minWidth: 240, marginLeft: 'auto' }}
            />
          </div>

          {visible.length === 0 ? (
            <EmptyState
              icon="—"
              title="No matches"
              body="Try a different filter or clear the search."
              actions={[{ label: 'Show all', onClick: () => { setTypeFilter('all'); setSearch(''); } }]}
            />
          ) : (
            <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ background: '#f8fafc' }}>
                    <Th>Client</Th>
                    <Th>Type</Th>
                    <Th>BM Ref</Th>
                    <Th>Services switched on</Th>
                    <Th></Th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((c) => (
                    <tr key={c.id} style={{ borderTop: '1px solid #f1f5f9' }}>
                      <Td>
                        <a href={`/clients/${c.id}`} onClick={(e) => { e.preventDefault(); navigate(`/clients/${c.id}`); }} style={{ color: '#0f172a', textDecoration: 'none', fontWeight: 500 }}>
                          {c.name}
                        </a>
                      </Td>
                      <Td style={{ color: '#64748b', textTransform: 'capitalize' }}>{c.type?.replace('_', ' ')}</Td>
                      <Td style={{ color: '#64748b', fontFamily: 'monospace', fontSize: 11 }}>{c.bm_client_id || '—'}</Td>
                      <Td>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                          {c.services.map((sid) => (
                            <span key={sid} style={{ fontSize: 10, fontWeight: 600, padding: '2px 6px', borderRadius: 4, background: '#f1f5f9', color: '#475569' }}>
                              {SERVICE_BY_ID[sid]?.label || sid}
                            </span>
                          ))}
                        </div>
                      </Td>
                      <Td align="right">
                        <button
                          onClick={() => setAdding(c)}
                          disabled={saving}
                          style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 600, padding: '5px 10px', background: '#0f172a', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontFamily: font }}
                        >
                          <Plus size={12} /> Add billing
                        </button>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {adding && (
        <AddBillingModal
          candidate={adding}
          qboItems={qboItems}
          onClose={() => setAdding(null)}
          onApply={(payload) => addBilling({ entityId: adding.id, lines: payload })}
          saving={saving}
        />
      )}
    </div>
  );
}

function AddBillingModal({ candidate, qboItems, onClose, onApply, saving }) {
  // Heuristic — try to match a BM canonical service to a QBO item by
  // a fuzzy name overlap (e.g. 'bookkeeping' canonical → QBO Item with
  // 'Bookkeeping' in its name). Falls back to no QBO link.
  const findQboItem = (canonicalServiceId) => {
    const label = (SERVICE_BY_ID[canonicalServiceId]?.label || '').toLowerCase();
    if (!label) return null;
    const tokens = label.split(/\s+/).filter(Boolean);
    return qboItems.find((it) => {
      const n = (it.name || '').toLowerCase();
      return tokens.every((t) => n.includes(t));
    }) || qboItems.find((it) => (it.name || '').toLowerCase().includes(tokens[0])) || null;
  };

  // Seed one row per service the BM allocation says they have, with
  // the canonical cadence + a sensible default amount. Each line also
  // attempts to pre-match a QBO item so the dropdown lands on the
  // right line item ready for the future push to a recurring template.
  const [lines, setLines] = useState(
    candidate.services.map((sid) => {
      const def = SERVICE_BY_ID[sid] || { cadence: 'monthly', defaultAmount: 0, label: sid };
      const item = findQboItem(sid);
      return {
        qboItemId: item?.qbo_item_id || '',
        serviceId: item?.name || def.label || sid,
        description: item?.description || def.label,
        cadence: def.cadence,
        amount: (item?.unit_price && item.unit_price > 0) ? Number(item.unit_price) : def.defaultAmount,
      };
    }),
  );

  const totals = lines.reduce(
    (acc, l) => {
      const amt = Number(l.amount) || 0;
      if (l.cadence === 'monthly') acc.monthly += amt;
      else if (l.cadence === 'annual') acc.annual += amt;
      return acc;
    },
    { monthly: 0, annual: 0 },
  );
  const annualised = totals.monthly * 12 + totals.annual;

  const updateLine = (idx, patch) => setLines((prev) => prev.map((l, i) => i === idx ? { ...l, ...patch } : l));
  const addLine = () => setLines((prev) => [...prev, { qboItemId: '', serviceId: '', description: '', cadence: 'monthly', amount: 0 }]);
  const removeLine = (idx) => setLines((prev) => prev.filter((_, i) => i !== idx));
  const pickQboItem = (idx, qboItemId) => {
    const item = qboItems.find((i) => i.qbo_item_id === qboItemId);
    if (!item) {
      updateLine(idx, { qboItemId: '', serviceId: '', description: '' });
      return;
    }
    updateLine(idx, {
      qboItemId: item.qbo_item_id,
      serviceId: item.name,
      description: item.description || item.name,
      // Default amount from the item's UnitPrice if we have it AND
      // the user hasn't already typed one.
      ...(item.unit_price && (!lines[idx] || Number(lines[idx].amount) === 0) ? { amount: Number(item.unit_price) } : {}),
    });
  };

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={modalStyle} onClick={(e) => e.stopPropagation()}>
        <div style={{ padding: '14px 18px', borderBottom: '1px solid #e5e7eb', display: 'flex', alignItems: 'center' }}>
          <h2 style={{ fontFamily: "'Playfair Display', serif", fontSize: 18, fontWeight: 500, color: '#0f172a', margin: 0 }}>
            Add billing — {candidate.name}
          </h2>
          <div style={{ flex: 1 }} />
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#64748b', fontSize: 18 }}>×</button>
        </div>
        <div style={{ padding: 18 }}>
          <div style={{ fontSize: 11, color: '#64748b', marginBottom: 10 }}>
            {candidate.type?.replace('_', ' ')} · BM Ref {candidate.bm_client_id || '—'}. Services pre-populated from the capacity planner — edit or remove any line.
          </div>

          <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: '#f8fafc' }}>
                <Th>Service</Th>
                <Th>Cadence</Th>
                <Th align="right">Amount £</Th>
                <Th></Th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l, idx) => (
                <tr key={idx} style={{ borderTop: '1px solid #f1f5f9' }}>
                  <Td>
                    <select
                      value={l.qboItemId}
                      onChange={(e) => pickQboItem(idx, e.target.value)}
                      style={inlineInput}
                      title={l.description || ''}
                    >
                      <option value="">— pick QBO item —</option>
                      {qboItems.map((it) => (
                        <option key={it.qbo_item_id} value={it.qbo_item_id}>{it.name}</option>
                      ))}
                    </select>
                  </Td>
                  <Td>
                    <select value={l.cadence} onChange={(e) => updateLine(idx, { cadence: e.target.value })} style={inlineInput}>
                      <option value="monthly">Monthly</option>
                      <option value="annual">Annual</option>
                      <option value="one_off">One-off</option>
                    </select>
                  </Td>
                  <Td align="right">
                    <input
                      type="number"
                      step="0.01"
                      value={l.amount}
                      onChange={(e) => updateLine(idx, { amount: e.target.value })}
                      style={{ ...inlineInput, textAlign: 'right', width: 100 }}
                    />
                  </Td>
                  <Td align="right">
                    <button onClick={() => removeLine(idx)} title="Remove line" style={iconBtnSmall}>
                      <X size={12} />
                    </button>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>

          <button onClick={addLine} style={{ marginTop: 8, fontSize: 11, fontWeight: 500, color: '#0e7fe0', background: 'none', border: 'none', cursor: 'pointer', fontFamily: font, padding: 0 }}>
            + add another line
          </button>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, marginTop: 16, padding: 12, background: '#f8fafc', borderRadius: 8 }}>
            <Stat label="Monthly" value={fmtGbp(totals.monthly)} />
            <Stat label="Annual fees" value={fmtGbp(totals.annual)} tone="success" />
            <Stat label="Annualised total" value={fmtGbp(annualised)} tone="info" />
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
            <button onClick={onClose} disabled={saving} style={modalBtnGhost}>Cancel</button>
            <button
              onClick={() => onApply(lines.filter((l) => l.qboItemId && Number(l.amount) > 0))}
              disabled={saving || lines.every((l) => !l.qboItemId || Number(l.amount) <= 0)}
              style={modalBtnPrimary}
            >
              {saving ? 'Adding…' : 'Add to billing book'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, tone }) {
  const t = tones[tone] || tones.neutral;
  return (
    <div>
      <div style={{ fontSize: 10, fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 700, color: t.fg, fontFamily: 'monospace', marginTop: 2 }}>{value}</div>
    </div>
  );
}

function Pill({ label, count, active, tone, onClick }) {
  const t = tones[tone] || tones.neutral;
  const isMaster = !tone;
  return (
    <button onClick={onClick} style={{
      fontSize: 12, fontWeight: active ? 600 : 500,
      padding: '5px 12px', borderRadius: 999,
      background: active ? (isMaster ? '#0f172a' : t.bg) : '#fff',
      color: active && isMaster ? '#fff' : t.fg,
      border: `1px solid ${isMaster && !active ? '#e5e7eb' : t.border}`,
      cursor: 'pointer', fontFamily: font,
    }}>
      {label}{count != null ? ` · ${count}` : ''}
    </button>
  );
}

const Th = ({ children, align }) => <th style={{ textAlign: align || 'left', padding: '8px 12px', fontSize: 11, fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{children}</th>;
const Td = ({ children, align, style }) => <td style={{ padding: '8px 12px', verticalAlign: 'middle', textAlign: align || 'left', ...style }}>{children}</td>;

const overlayStyle = { position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100, fontFamily: font };
const modalStyle = { background: '#fff', borderRadius: 12, width: 720, maxWidth: '95vw', maxHeight: '90vh', overflow: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,0.3)' };
const inlineInput = { padding: '4px 8px', fontSize: 12, fontFamily: font, border: '1px solid #e5e7eb', borderRadius: 6, background: '#fff', color: '#0f172a', outline: 'none', width: '100%', boxSizing: 'border-box' };
const modalBtnPrimary = { padding: '8px 16px', fontSize: 13, fontWeight: 600, background: '#0f172a', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontFamily: font };
const modalBtnGhost = { padding: '8px 14px', fontSize: 13, fontWeight: 500, background: '#fff', color: '#475569', border: '1px solid #e5e7eb', borderRadius: 6, cursor: 'pointer', fontFamily: font };
const iconBtnSmall = { width: 22, height: 22, padding: 0, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 4, color: '#b91c1c', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' };
