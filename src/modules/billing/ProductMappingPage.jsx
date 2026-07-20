import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Package } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../shell/AppShell';
import BillingTabs from './BillingTabs';
import SearchInput from '../../components/SearchInput';
import EmptyState from '../../components/EmptyState';
import { fmtGbp } from '../../lib/money';
import { CANONICAL_SERVICES } from './BillingServiceMappingPage';

const font = "'Outfit', sans-serif";

// Athena product → QuickBooks product mapping. Every service_id Athena
// bills under (union of the canonical capacity-planner services and any
// service_id already present in billing_service_mappings) gets mapped
// to a QBO Item from the qbo_items catalog mirror, so invoices raised
// from Athena reference the true QBO ItemRef rather than resolving by
// name at push time.
export default function ProductMappingPage() {
  const navigate = useNavigate();
  const { profile } = useAuth();

  const [serviceIds, setServiceIds] = useState([]); // [{ id, label }]
  const [mappings, setMappings] = useState({});     // service_id → { qbo_item_id, notes }
  const [qboItems, setQboItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');

  const load = async () => {
    setLoading(true);
    const [{ data: svcMaps }, { data: prodMaps }, { data: items }] = await Promise.all([
      supabase.from('billing_service_mappings').select('service_id'),
      supabase.from('athena_product_qbo_map').select('*'),
      supabase.from('qbo_items').select('qbo_item_id, name, fully_qualified_name, unit_price, active, type').eq('active', true).order('name'),
    ]);

    // Union: canonical services first (with friendly labels), then any
    // extra service_ids Athena already bills under.
    const seen = new Set();
    const list = [];
    for (const c of CANONICAL_SERVICES) {
      seen.add(c.id);
      list.push({ id: c.id, label: c.label });
    }
    const extras = [];
    for (const r of svcMaps || []) {
      if (!r.service_id || seen.has(r.service_id)) continue;
      seen.add(r.service_id);
      extras.push({ id: r.service_id, label: r.service_id });
    }
    extras.sort((a, b) => a.id.localeCompare(b.id));
    setServiceIds([...list, ...extras]);

    const map = {};
    for (const m of prodMaps || []) {
      map[m.service_id] = { qbo_item_id: m.qbo_item_id || '', notes: m.notes || '' };
    }
    setMappings(map);
    setQboItems(items || []);
    setLoading(false);
  };
  useEffect(() => { load(); }, []);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return serviceIds;
    return serviceIds.filter((s) => s.id.toLowerCase().includes(q) || s.label.toLowerCase().includes(q));
  }, [serviceIds, search]);

  const itemById = useMemo(() => {
    const m = new Map();
    for (const it of qboItems) m.set(it.qbo_item_id, it);
    return m;
  }, [qboItems]);

  const updateMapping = async (serviceId, qboItemId) => {
    setSaving(true);
    setError('');
    const prev = mappings[serviceId];
    setMappings((m) => ({ ...m, [serviceId]: { ...(m[serviceId] || { notes: '' }), qbo_item_id: qboItemId } }));

    let err = null;
    if (!qboItemId) {
      // Cleared — qbo_item_id is NOT NULL, so remove the row entirely.
      ({ error: err } = await supabase.from('athena_product_qbo_map').delete().eq('service_id', serviceId));
    } else {
      ({ error: err } = await supabase.from('athena_product_qbo_map').upsert({
        service_id: serviceId,
        qbo_item_id: qboItemId,
        updated_at: new Date().toISOString(),
        updated_by: profile?.id || null,
      }, { onConflict: 'service_id' }));
    }
    if (err) {
      setError(err.message || 'Save failed');
      setMappings((m) => ({ ...m, [serviceId]: prev || { qbo_item_id: '', notes: '' } }));
    }
    setSaving(false);
  };

  const stats = useMemo(() => {
    let mapped = 0;
    for (const s of serviceIds) {
      if (mappings[s.id]?.qbo_item_id) mapped++;
    }
    return { mapped, total: serviceIds.length, unmapped: serviceIds.length - mapped };
  }, [serviceIds, mappings]);

  return (
    <div style={{ padding: '20px 28px', fontFamily: font, maxWidth: 1280 }}>
      <h1 style={{ fontFamily: "'Playfair Display', serif", fontSize: 26, fontWeight: 500, color: '#0f172a', marginBottom: 2 }}>
        Athena products → QuickBooks products
      </h1>
      <p style={{ fontSize: 13, color: '#64748b', maxWidth: 760, marginBottom: 14 }}>
        Map each Athena service/product to the QuickBooks Item it should invoice under. The QBO catalog below is the qbo_items mirror kept fresh by the QBO pull.
      </p>

      <BillingTabs active="products" />

      {loading ? (
        <p style={{ fontSize: 13, color: '#94a3b8', padding: 40, textAlign: 'center' }}>Loading…</p>
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
            <div style={{ fontSize: 13, color: '#475569' }}>
              <strong style={{ color: '#0f172a' }}>{stats.mapped}</strong> of <strong style={{ color: '#0f172a' }}>{stats.total}</strong> products mapped
              {stats.unmapped > 0 && (
                <span style={{ marginLeft: 10, fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 999, background: '#fef3c7', color: '#92400e' }}>
                  {stats.unmapped} unmapped
                </span>
              )}
              {saving && <span style={{ marginLeft: 12, fontSize: 11, color: '#94a3b8' }}>Saving…</span>}
              {error && <span style={{ marginLeft: 12, fontSize: 11, color: '#dc2626' }}>{error}</span>}
            </div>
            <div style={{ flex: 1 }} />
            <SearchInput value={search} onChange={setSearch} placeholder="Search product…" style={{ minWidth: 240 }} />
          </div>

          {visible.length === 0 ? (
            <EmptyState
              icon={<Package size={28} />}
              title="No products to map"
              body={search ? 'No products match your search.' : 'No Athena services found yet — approve some billing services first.'}
              actions={search ? [{ label: 'Clear search', onClick: () => setSearch('') }] : [{ label: 'Back to dashboard', onClick: () => navigate('/manage/billing') }]}
            />
          ) : (
            <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, overflow: 'hidden' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ background: '#f8fafc' }}>
                    <Th>Athena product</Th>
                    <Th>QuickBooks product</Th>
                    <Th align="right">QBO unit price</Th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((s) => {
                    const m = mappings[s.id] || { qbo_item_id: '' };
                    const item = m.qbo_item_id ? itemById.get(m.qbo_item_id) : null;
                    return (
                      <tr key={s.id} style={{ borderTop: '1px solid #f1f5f9' }}>
                        <Td>
                          <div style={{ fontWeight: 500, color: '#0f172a' }}>{s.label}</div>
                          {s.label !== s.id && <div style={{ fontSize: 11, color: '#94a3b8' }}>{s.id}</div>}
                        </Td>
                        <Td>
                          <select
                            value={m.qbo_item_id}
                            onChange={(e) => updateMapping(s.id, e.target.value)}
                            disabled={saving}
                            style={{ ...selectStyle, borderColor: m.qbo_item_id ? '#e5e7eb' : '#fbbf24' }}
                          >
                            <option value="">— not mapped —</option>
                            {qboItems.map((it) => (
                              <option key={it.qbo_item_id} value={it.qbo_item_id}>
                                {it.name}{it.unit_price != null ? ` — ${fmtGbp(Number(it.unit_price))}` : ''}
                              </option>
                            ))}
                            {/* Keep a stale selection visible if the item went inactive */}
                            {m.qbo_item_id && !itemById.has(m.qbo_item_id) && (
                              <option value={m.qbo_item_id}>{m.qbo_item_id} (inactive in QBO)</option>
                            )}
                          </select>
                        </Td>
                        <Td align="right" style={{ fontFamily: 'monospace', color: '#0e7fe0' }}>
                          {item && item.unit_price != null ? fmtGbp(Number(item.unit_price)) : '—'}
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
const selectStyle = { width: '100%', maxWidth: 420, padding: '5px 8px', fontSize: 12, fontFamily: font, border: '1px solid #e5e7eb', borderRadius: 6, background: '#fff', color: '#0f172a', outline: 'none' };
