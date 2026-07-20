import React, { useEffect, useMemo, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { BookOpen } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../shell/AppShell';
import BillingTabs from './BillingTabs';
import SearchInput from '../../components/SearchInput';
import EmptyState from '../../components/EmptyState';
import { fmtGbp } from '../../lib/money';
import { CANONICAL_SERVICES } from './BillingServiceMappingPage';

const font = "'Outfit', sans-serif";

// Standard fees price book (admin-only: can_view_client_fees).
// Each row is a named task mapped to an Athena product with a standard
// net fee. The QBO product column is derived read-only: task → Athena
// product (service_id) → athena_product_qbo_map → qbo_items.
// RLS on standard_fees enforces the same gate at the data layer
// (sql/121), so this page-level redirect is presentation.
export default function StandardFeesPage() {
  const navigate = useNavigate();
  const { profile } = useAuth();

  const [rows, setRows] = useState([]);            // standard_fees rows
  const [serviceIds, setServiceIds] = useState([]); // [{ id, label }] — same union as ProductMappingPage
  const [qboByService, setQboByService] = useState({}); // service_id → qbo_items row
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [showInactive, setShowInactive] = useState(false);

  // New-row form
  const [newTask, setNewTask] = useState({ task_name: '', service_id: '', standard_net: '' });

  const load = async () => {
    setLoading(true);
    const [{ data: fees }, { data: svcMaps }, { data: prodMaps }, { data: items }] = await Promise.all([
      supabase.from('standard_fees').select('*').order('task_name'),
      supabase.from('billing_service_mappings').select('service_id'),
      supabase.from('athena_product_qbo_map').select('service_id, qbo_item_id'),
      supabase.from('qbo_items').select('qbo_item_id, name, unit_price'),
    ]);
    setRows(fees || []);

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

    // service_id → QBO item (via the product map)
    const itemById = new Map((items || []).map((it) => [it.qbo_item_id, it]));
    const byService = {};
    for (const m of prodMaps || []) {
      byService[m.service_id] = itemById.get(m.qbo_item_id) || { name: m.qbo_item_id, unit_price: null };
    }
    setQboByService(byService);
    setLoading(false);
  };
  useEffect(() => { load(); }, []);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    let list = rows;
    if (!showInactive) list = list.filter((r) => r.active !== false);
    if (!q) return list;
    return list.filter((r) =>
      (r.task_name || '').toLowerCase().includes(q) ||
      (r.service_id || '').toLowerCase().includes(q)
    );
  }, [rows, search, showInactive]);

  const serviceLabel = (id) => serviceIds.find((s) => s.id === id)?.label || id;

  // Admin gate — the tab is hidden for non-fee staff, but hitting the
  // URL directly bounces back to the billing dashboard. (Placed after
  // all hooks so the hook order stays stable; RLS is the real gate.)
  if (profile && profile.can_view_client_fees !== true) {
    return <Navigate to="/manage/billing" replace />;
  }

  const addTask = async () => {
    if (!newTask.task_name.trim() || !newTask.service_id) return;
    setSaving(true);
    setError('');
    const { error: err } = await supabase.from('standard_fees').insert({
      task_name: newTask.task_name.trim(),
      service_id: newTask.service_id,
      standard_net: Number(newTask.standard_net) || 0,
      created_by: profile?.id || null,
    });
    if (err) setError(err.message || 'Add failed');
    else setNewTask({ task_name: '', service_id: '', standard_net: '' });
    await load();
    setSaving(false);
  };

  const updateRow = async (id, patch) => {
    setSaving(true);
    setError('');
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
    const { error: err } = await supabase
      .from('standard_fees')
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('id', id);
    if (err) {
      setError(err.message || 'Save failed');
      await load();
    }
    setSaving(false);
  };

  return (
    <div style={{ padding: '20px 28px', fontFamily: font, maxWidth: 1280 }}>
      <h1 style={{ fontFamily: "'Playfair Display', serif", fontSize: 26, fontWeight: 500, color: '#0f172a', marginBottom: 2 }}>
        Standard fees
      </h1>
      <p style={{ fontSize: 13, color: '#64748b', maxWidth: 760, marginBottom: 14 }}>
        The practice price book: each task maps to an Athena product with a standard net fee. The QBO product comes from the Products ↔ QBO mapping. Confidential — visible to fee admins only.
      </p>

      <BillingTabs active="standard-fees" />

      {loading ? (
        <p style={{ fontSize: 13, color: '#94a3b8', padding: 40, textAlign: 'center' }}>Loading…</p>
      ) : (
        <>
          {/* Add-task card */}
          <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 14, marginBottom: 14, display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <Field label="Task">
              <input
                value={newTask.task_name}
                onChange={(e) => setNewTask((t) => ({ ...t, task_name: e.target.value }))}
                placeholder="e.g. Confirmation statement"
                style={{ ...inputStyle, minWidth: 260 }}
              />
            </Field>
            <Field label="Athena product">
              <select
                value={newTask.service_id}
                onChange={(e) => setNewTask((t) => ({ ...t, service_id: e.target.value }))}
                style={{ ...inputStyle, minWidth: 220 }}
              >
                <option value="">— select product —</option>
                {serviceIds.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
              </select>
            </Field>
            <Field label="Standard net £">
              <input
                type="number"
                step="0.01"
                min="0"
                value={newTask.standard_net}
                onChange={(e) => setNewTask((t) => ({ ...t, standard_net: e.target.value }))}
                placeholder="0.00"
                style={{ ...inputStyle, width: 110, textAlign: 'right' }}
              />
            </Field>
            <button
              onClick={addTask}
              disabled={saving || !newTask.task_name.trim() || !newTask.service_id}
              style={{
                padding: '7px 16px', fontSize: 13, fontWeight: 600, fontFamily: font,
                background: (!newTask.task_name.trim() || !newTask.service_id) ? '#e2e8f0' : '#0e7fe0',
                color: (!newTask.task_name.trim() || !newTask.service_id) ? '#94a3b8' : '#fff',
                border: 'none', borderRadius: 8, cursor: (!newTask.task_name.trim() || !newTask.service_id) ? 'default' : 'pointer',
              }}
            >
              Add task
            </button>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
            <div style={{ fontSize: 13, color: '#475569' }}>
              <strong style={{ color: '#0f172a' }}>{rows.filter((r) => r.active !== false).length}</strong> active standard fees
              {saving && <span style={{ marginLeft: 12, fontSize: 11, color: '#94a3b8' }}>Saving…</span>}
              {error && <span style={{ marginLeft: 12, fontSize: 11, color: '#dc2626' }}>{error}</span>}
            </div>
            <label style={{ fontSize: 12, color: '#64748b', display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
              <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
              Show deactivated
            </label>
            <div style={{ flex: 1 }} />
            <SearchInput value={search} onChange={setSearch} placeholder="Search task…" style={{ minWidth: 240 }} />
          </div>

          {visible.length === 0 ? (
            <EmptyState
              icon={<BookOpen size={28} />}
              title="No standard fees yet"
              body={search ? 'No tasks match your search.' : 'Add your first task above to start the price book.'}
              actions={search ? [{ label: 'Clear search', onClick: () => setSearch('') }] : [{ label: 'Back to dashboard', onClick: () => navigate('/manage/billing') }]}
            />
          ) : (
            <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, overflow: 'hidden' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ background: '#f8fafc' }}>
                    <Th>Task</Th>
                    <Th>Athena product</Th>
                    <Th>QBO product</Th>
                    <Th align="right">Standard net £</Th>
                    <Th>Notes</Th>
                    <Th align="right"></Th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((r) => {
                    const qbo = qboByService[r.service_id];
                    const inactive = r.active === false;
                    return (
                      <tr key={r.id} style={{ borderTop: '1px solid #f1f5f9', opacity: inactive ? 0.5 : 1 }}>
                        <Td>
                          <input
                            defaultValue={r.task_name}
                            onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== r.task_name) updateRow(r.id, { task_name: v }); }}
                            disabled={inactive}
                            style={{ ...inputStyle, width: '100%', fontWeight: 500 }}
                          />
                        </Td>
                        <Td>
                          <select
                            value={r.service_id}
                            onChange={(e) => updateRow(r.id, { service_id: e.target.value })}
                            disabled={inactive || saving}
                            style={{ ...inputStyle, width: '100%' }}
                          >
                            {/* keep an orphaned value selectable */}
                            {!serviceIds.some((s) => s.id === r.service_id) && (
                              <option value={r.service_id}>{r.service_id}</option>
                            )}
                            {serviceIds.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
                          </select>
                        </Td>
                        <Td>
                          {qbo ? (
                            <span style={{ color: '#0f172a' }}>
                              {qbo.name}
                              {qbo.unit_price != null && <span style={{ color: '#94a3b8', marginLeft: 6, fontSize: 11 }}>{fmtGbp(Number(qbo.unit_price))}</span>}
                            </span>
                          ) : (
                            <button
                              onClick={() => navigate('/manage/billing/products')}
                              title={`${serviceLabel(r.service_id)} has no QBO product mapped yet`}
                              style={{ background: 'none', border: 'none', padding: 0, fontSize: 12, fontFamily: font, color: '#b45309', cursor: 'pointer', textDecoration: 'underline' }}
                            >
                              not mapped — fix
                            </button>
                          )}
                        </Td>
                        <Td align="right">
                          <input
                            type="number"
                            step="0.01"
                            min="0"
                            defaultValue={r.standard_net}
                            onBlur={(e) => { const v = Number(e.target.value); if (!Number.isNaN(v) && v !== Number(r.standard_net)) updateRow(r.id, { standard_net: v }); }}
                            disabled={inactive}
                            style={{ ...inputStyle, width: 100, textAlign: 'right', fontFamily: 'monospace' }}
                          />
                        </Td>
                        <Td>
                          <input
                            defaultValue={r.notes || ''}
                            onBlur={(e) => { const v = e.target.value; if (v !== (r.notes || '')) updateRow(r.id, { notes: v || null }); }}
                            disabled={inactive}
                            placeholder="—"
                            style={{ ...inputStyle, width: '100%', color: '#64748b' }}
                          />
                        </Td>
                        <Td align="right">
                          <button
                            onClick={() => updateRow(r.id, { active: !inactive ? false : true })}
                            disabled={saving}
                            style={{
                              padding: '4px 10px', fontSize: 11, fontWeight: 600, fontFamily: font,
                              background: 'none', borderRadius: 6, cursor: 'pointer',
                              border: inactive ? '1px solid #0e7fe0' : '1px solid #e5e7eb',
                              color: inactive ? '#0e7fe0' : '#dc2626',
                            }}
                          >
                            {inactive ? 'Reactivate' : 'Deactivate'}
                          </button>
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

const Field = ({ label, children }) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
    <span style={{ fontSize: 11, fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</span>
    {children}
  </div>
);
const Th = ({ children, align }) => <th style={{ textAlign: align || 'left', padding: '8px 12px', fontSize: 11, fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{children}</th>;
const Td = ({ children, align, style }) => <td style={{ padding: '8px 12px', verticalAlign: 'middle', textAlign: align || 'left', ...style }}>{children}</td>;
const inputStyle = { padding: '6px 8px', fontSize: 12, fontFamily: font, border: '1px solid #e5e7eb', borderRadius: 6, background: '#fff', color: '#0f172a', outline: 'none' };
