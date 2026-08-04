import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Package, AlertTriangle } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../shell/AppShell';
import BillingTabs from './BillingTabs';
import SearchInput from '../../components/SearchInput';
import EmptyState from '../../components/EmptyState';
import { fmtGbp } from '../../lib/money';
import { candidateServices } from './billingServices';

const font = "'Outfit', sans-serif";

// Athena service → QuickBooks product. This page writes qbo_service_items,
// which is the ONE table the invoice pushes read (qbo-push-billing-items and
// qbo-push both resolve a line's ItemRef through it). Until sql/176 this page
// wrote athena_product_qbo_map, which nothing read — so mapping here had no
// effect on where revenue coded, and unmapped services silently landed on
// whatever QBO item happened to share their name.
//
// Two kinds of service id appear:
//   fee_engine - quote/live-billing service ids (accounts_ct…). One canonical
//                row per QBO item; these drive the quote-vs-live comparison.
//   adhoc      - free-text line labels in the /billing editor. These may
//                point several labels at one QBO item, so they are flagged
//                is_adhoc and excluded from that comparison's reverse map.
export default function ProductMappingPage() {
  const navigate = useNavigate();
  const { profile } = useAuth();

  const [services, setServices] = useState([]);   // [{ id, label, kind }]
  const [mappings, setMappings] = useState({});   // service_id → { qbo_item_id }
  const [qboItems, setQboItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');

  const load = async () => {
    setLoading(true);
    const [{ data: rows }, { data: items }] = await Promise.all([
      supabase.from('qbo_service_items').select('service_id, qbo_item_id, qbo_item_name, label, is_adhoc'),
      supabase.from('qbo_items').select('qbo_item_id, name, unit_price, active, type').eq('active', true).order('name'),
    ]);

    setServices(candidateServices(rows || []));
    const map = {};
    for (const r of rows || []) map[r.service_id] = { qbo_item_id: r.qbo_item_id || '' };
    setMappings(map);
    setQboItems(items || []);
    setLoading(false);
  };
  useEffect(() => { load(); }, []);

  const itemById = useMemo(() => {
    const m = new Map();
    for (const it of qboItems) m.set(it.qbo_item_id, it);
    return m;
  }, [qboItems]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return services;
    return services.filter((s) => s.id.toLowerCase().includes(q) || s.label.toLowerCase().includes(q));
  }, [services, search]);

  const updateMapping = async (svc, qboItemId) => {
    setSaving(true);
    setError('');
    const prev = mappings[svc.id];
    setMappings((m) => ({ ...m, [svc.id]: { qbo_item_id: qboItemId } }));

    let err = null;
    if (!qboItemId) {
      // qbo_item_id is NOT NULL — clearing means removing the row. The
      // service then has no mapping and the editor stops offering it.
      ({ error: err } = await supabase.from('qbo_service_items').delete().eq('service_id', svc.id));
    } else {
      const item = itemById.get(qboItemId);
      ({ error: err } = await supabase.from('qbo_service_items').upsert({
        service_id: svc.id,
        qbo_item_id: qboItemId,
        // Denormalised so the pushes can match on either, and so a row still
        // reads sensibly if the QBO item is later renamed.
        qbo_item_name: item?.name || qboItemId,
        label: svc.label !== svc.id ? svc.label : null,
        is_adhoc: svc.kind === 'adhoc',
        updated_at: new Date().toISOString(),
        updated_by: profile?.id || null,
      }, { onConflict: 'service_id' }));
    }
    if (err) {
      setError(err.message || 'Save failed');
      setMappings((m) => ({ ...m, [svc.id]: prev || { qbo_item_id: '' } }));
    }
    setSaving(false);
  };

  const stats = useMemo(() => {
    let mapped = 0, stale = 0;
    for (const s of services) {
      const id = mappings[s.id]?.qbo_item_id;
      if (!id) continue;
      mapped++;
      if (!itemById.has(id)) stale++;
    }
    return { mapped, total: services.length, unmapped: services.length - mapped, stale };
  }, [services, mappings, itemById]);

  const groups = useMemo(() => ([
    { kind: 'adhoc', title: 'Ad-hoc bill lines', blurb: 'Offered in the /billing line editor. Unmapped labels are not offered at all.' },
    { kind: 'fee_engine', title: 'Fee engine services', blurb: 'Quote and recurring-billing services. One canonical service per QuickBooks product.' },
  ]), []);

  return (
    <div style={{ padding: '20px 28px', fontFamily: font, maxWidth: 1280 }}>
      <h1 style={{ fontFamily: "'Playfair Display', serif", fontSize: 26, fontWeight: 500, color: '#0f172a', marginBottom: 2 }}>
        Athena services → QuickBooks products
      </h1>
      <p style={{ fontSize: 13, color: '#64748b', maxWidth: 800, marginBottom: 14 }}>
        This decides which QuickBooks product — and therefore which income account — each service invoices under.
        An unmapped service cannot be billed: the push refuses it rather than guessing. The product list is the
        qbo_items mirror kept fresh by the QBO pull.
      </p>

      <BillingTabs active="products" />

      {loading ? (
        <p style={{ fontSize: 13, color: '#94a3b8', padding: 40, textAlign: 'center' }}>Loading…</p>
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
            <div style={{ fontSize: 13, color: '#475569' }}>
              <strong style={{ color: '#0f172a' }}>{stats.mapped}</strong> of <strong style={{ color: '#0f172a' }}>{stats.total}</strong> services mapped
              {stats.unmapped > 0 && (
                <span style={{ marginLeft: 10, fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 999, background: '#fef3c7', color: '#92400e' }}>
                  {stats.unmapped} unmapped
                </span>
              )}
              {stats.stale > 0 && (
                <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 999, background: '#fef2f2', color: '#b91c1c' }}>
                  {stats.stale} pointing at an inactive product
                </span>
              )}
              {saving && <span style={{ marginLeft: 12, fontSize: 11, color: '#94a3b8' }}>Saving…</span>}
              {error && <span style={{ marginLeft: 12, fontSize: 11, color: '#dc2626' }}>{error}</span>}
            </div>
            <div style={{ flex: 1 }} />
            <SearchInput value={search} onChange={setSearch} placeholder="Search service…" style={{ minWidth: 240 }} />
          </div>

          {visible.length === 0 ? (
            <EmptyState
              icon={<Package size={28} />}
              title="No services to map"
              body={search ? 'No services match your search.' : 'No billable services found.'}
              actions={search ? [{ label: 'Clear search', onClick: () => setSearch('') }] : [{ label: 'Back to dashboard', onClick: () => navigate('/manage/billing') }]}
            />
          ) : groups.map((g) => {
            const rows = visible.filter((s) => s.kind === g.kind);
            if (rows.length === 0) return null;
            return (
              <div key={g.kind} style={{ marginBottom: 20 }}>
                <div style={{ marginBottom: 6 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: '#0f172a' }}>{g.title}</div>
                  <div style={{ fontSize: 11, color: '#94a3b8' }}>{g.blurb}</div>
                </div>
                <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, overflow: 'hidden' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                    <thead>
                      <tr style={{ background: '#f8fafc' }}>
                        <Th>Athena service</Th>
                        <Th>QuickBooks product</Th>
                        <Th align="right">QBO unit price</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((s) => {
                        const mappedId = mappings[s.id]?.qbo_item_id || '';
                        const item = mappedId ? itemById.get(mappedId) : null;
                        const isStale = !!mappedId && !item;
                        return (
                          <tr key={s.id} style={{ borderTop: '1px solid #f1f5f9' }}>
                            <Td>
                              <div style={{ fontWeight: 500, color: '#0f172a' }}>{s.label}</div>
                              {s.label !== s.id && <div style={{ fontSize: 11, color: '#94a3b8' }}>{s.id}</div>}
                            </Td>
                            <Td>
                              <select
                                value={mappedId}
                                onChange={(e) => updateMapping(s, e.target.value)}
                                disabled={saving}
                                style={{ ...selectStyle, borderColor: isStale ? '#f87171' : mappedId ? '#e5e7eb' : '#fbbf24' }}
                              >
                                <option value="">— not mapped —</option>
                                {qboItems.map((it) => (
                                  <option key={it.qbo_item_id} value={it.qbo_item_id}>
                                    {it.name}{it.unit_price != null ? ` — ${fmtGbp(Number(it.unit_price))}` : ''}
                                  </option>
                                ))}
                                {/* A mapping can outlive its product — QBO items get
                                    deactivated or merged, which renames them "(deleted)".
                                    Keep it selectable so the gap is visible, not silent. */}
                                {isStale && <option value={mappedId}>Item {mappedId} — inactive in QuickBooks</option>}
                              </select>
                              {isStale && (
                                <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 3, fontSize: 11, color: '#b91c1c' }}>
                                  <AlertTriangle size={12} /> This product is no longer active in QuickBooks — pick a live one.
                                </div>
                              )}
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
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}

const Th = ({ children, align }) => <th style={{ textAlign: align || 'left', padding: '8px 12px', fontSize: 11, fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{children}</th>;
const Td = ({ children, align, style }) => <td style={{ padding: '8px 12px', verticalAlign: 'middle', textAlign: align || 'left', ...style }}>{children}</td>;
const selectStyle = { width: '100%', maxWidth: 420, padding: '5px 8px', fontSize: 12, fontFamily: font, border: '1px solid #e5e7eb', borderRadius: 6, background: '#fff', color: '#0f172a', outline: 'none' };
