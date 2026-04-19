import React, { useState, useEffect, useMemo } from 'react';
import { supabase } from '../../lib/supabase';
import ClientTypeAhead from '../work-planner/components/ClientTypeAhead';

const font = "'Outfit', sans-serif";

const ROLES = [
  { value: 'primary', label: 'Primary' },
  { value: 'billing_initiator', label: 'Billing initiator' },
  { value: 'legacy', label: 'Legacy' },
  { value: 'not_a_client', label: 'Not a client' },
];

export default function QboMappingPage() {
  const [rows, setRows] = useState([]);
  const [entities, setEntities] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(null);
  const [filter, setFilter] = useState('all'); // all | unmapped | mapped | by role
  const [search, setSearch] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [newId, setNewId] = useState('');
  const [newName, setNewName] = useState('');

  const load = async () => {
    setLoading(true);
    const [{ data: maps }, { data: ents }] = await Promise.all([
      supabase.from('qbo_customer_mappings').select('*').order('qbo_customer_name'),
      supabase.from('entities').select('id, name').order('name'),
    ]);
    setRows(maps || []);
    setEntities(ents || []);
    setLoading(false);
  };
  useEffect(() => { load(); }, []);

  const entityMap = useMemo(() => {
    const m = {};
    for (const e of entities) m[e.id] = e.name;
    return m;
  }, [entities]);

  const filtered = useMemo(() => {
    let out = rows;
    if (filter === 'unmapped') out = out.filter((r) => !r.entity_id);
    else if (filter === 'mapped') out = out.filter((r) => r.entity_id);
    else if (filter.startsWith('role:')) {
      const role = filter.slice(5);
      out = out.filter((r) => r.role === role);
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      out = out.filter((r) =>
        (r.qbo_customer_name || '').toLowerCase().includes(q) ||
        (r.qbo_customer_id || '').toLowerCase().includes(q) ||
        (entityMap[r.entity_id] || '').toLowerCase().includes(q)
      );
    }
    return out;
  }, [rows, filter, search, entityMap]);

  const unmapped = rows.filter((r) => !r.entity_id).length;

  const patch = async (qboId, fields) => {
    setSaving(qboId);
    const { error } = await supabase
      .from('qbo_customer_mappings')
      .update(fields)
      .eq('qbo_customer_id', qboId);
    if (error) alert('Save failed: ' + error.message);
    await load();
    setSaving(null);
  };

  const addManual = async () => {
    if (!newId.trim()) return;
    const { error } = await supabase
      .from('qbo_customer_mappings')
      .insert({
        qbo_customer_id: newId.trim(),
        qbo_customer_name: newName.trim() || null,
        role: 'primary',
      });
    if (error) { alert('Add failed: ' + error.message); return; }
    setShowAdd(false); setNewId(''); setNewName('');
    await load();
  };

  const remove = async (qboId) => {
    if (!window.confirm(`Remove QBO customer ${qboId} from the mapping table?`)) return;
    const { error } = await supabase
      .from('qbo_customer_mappings')
      .delete()
      .eq('qbo_customer_id', qboId);
    if (error) { alert('Delete failed: ' + error.message); return; }
    await load();
  };

  return (
    <div style={{ padding: '24px 28px', fontFamily: font, maxWidth: 1200 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 16 }}>
        <div>
          <h1 style={{ fontFamily: "'Playfair Display', serif", fontSize: 26, fontWeight: 500, color: '#0f172a', marginBottom: 4 }}>
            QuickBooks ↔ Athena mapping
          </h1>
          <p style={{ fontSize: 13, color: '#64748b' }}>
            {rows.length} QBO customer(s) tracked · {unmapped > 0 ? (
              <span style={{ color: '#b45309', fontWeight: 500 }}>{unmapped} unmapped</span>
            ) : 'all mapped'}
          </p>
        </div>
        <button onClick={() => setShowAdd(true)} style={btnPrimary}>+ Add QBO customer</button>
      </div>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 14, flexWrap: 'wrap' }}>
        <select value={filter} onChange={(e) => setFilter(e.target.value)} style={selectStyle}>
          <option value="all">All</option>
          <option value="unmapped">Unmapped only</option>
          <option value="mapped">Mapped only</option>
          <option value="role:primary">Role: Primary</option>
          <option value="role:billing_initiator">Role: Billing initiator</option>
          <option value="role:legacy">Role: Legacy</option>
          <option value="role:not_a_client">Role: Not a client</option>
        </select>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search QBO name, QBO id, or Athena entity..."
          style={{ ...selectStyle, flex: 1, minWidth: 240 }}
        />
      </div>

      {showAdd && (
        <div style={{
          background: '#f8fafc', border: '1px solid #e5e7eb', borderRadius: 10,
          padding: 14, marginBottom: 14, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap',
        }}>
          <input
            value={newId}
            onChange={(e) => setNewId(e.target.value)}
            placeholder="QBO customer ID (required)"
            style={selectStyle}
          />
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="QBO name (optional)"
            style={selectStyle}
          />
          <button onClick={addManual} style={btnPrimary}>Add</button>
          <button onClick={() => { setShowAdd(false); setNewId(''); setNewName(''); }} style={btnSecondary}>Cancel</button>
        </div>
      )}

      {loading ? (
        <p style={{ fontSize: 13, color: '#94a3b8', padding: 40, textAlign: 'center' }}>Loading…</p>
      ) : filtered.length === 0 ? (
        <div style={{ padding: 60, textAlign: 'center' }}>
          <p style={{ fontSize: 15, fontWeight: 500, color: '#94a3b8', marginBottom: 4 }}>
            {rows.length === 0 ? 'No QBO customers tracked yet' : 'No matches'}
          </p>
          <p style={{ fontSize: 13, color: '#cbd5e1' }}>
            {rows.length === 0
              ? 'QBO customers appear here once the next qbo-pull runs, or add one manually.'
              : 'Adjust filters to see more.'}
          </p>
        </div>
      ) : (
        <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: '#f8fafc' }}>
                <Th>QBO customer</Th>
                <Th>QBO ID</Th>
                <Th>Athena entity</Th>
                <Th>Role</Th>
                <Th>Last seen</Th>
                <Th></Th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => {
                const isUnmapped = !r.entity_id;
                return (
                  <tr key={r.qbo_customer_id}
                    style={{ borderTop: '1px solid #f1f5f9', background: isUnmapped ? '#fefce8' : 'transparent' }}>
                    <Td>{r.qbo_customer_name || <span style={{ color: '#cbd5e1' }}>—</span>}</Td>
                    <Td style={{ fontFamily: 'monospace', color: '#64748b', fontSize: 11 }}>{r.qbo_customer_id}</Td>
                    <Td>
                      <ClientTypeAhead
                        entityList={entities}
                        value={r.entity_id || ''}
                        onChange={(id) => patch(r.qbo_customer_id, { entity_id: id || null })}
                        onAddNew={() => null}
                        size="small"
                      />
                    </Td>
                    <Td>
                      <select
                        value={r.role}
                        onChange={(e) => patch(r.qbo_customer_id, { role: e.target.value })}
                        disabled={saving === r.qbo_customer_id}
                        style={{ ...selectStyle, padding: '3px 8px', fontSize: 11 }}
                      >
                        {ROLES.map((rl) => <option key={rl.value} value={rl.value}>{rl.label}</option>)}
                      </select>
                    </Td>
                    <Td style={{ color: '#94a3b8', fontSize: 11 }}>
                      {r.last_seen ? new Date(r.last_seen).toLocaleDateString('en-GB') : '—'}
                    </Td>
                    <Td>
                      <button
                        onClick={() => remove(r.qbo_customer_id)}
                        title="Remove mapping"
                        style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#94a3b8', fontSize: 14 }}
                        onMouseEnter={(e) => { e.currentTarget.style.color = '#991b1b'; }}
                        onMouseLeave={(e) => { e.currentTarget.style.color = '#94a3b8'; }}
                      >
                        ✕
                      </button>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const Th = ({ children }) => (
  <th style={{ textAlign: 'left', padding: '10px 14px', fontSize: 11, fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
    {children}
  </th>
);
const Td = ({ children, style }) => <td style={{ padding: '10px 14px', verticalAlign: 'middle', ...style }}>{children}</td>;

const selectStyle = { padding: '6px 10px', fontSize: 13, fontFamily: font, border: '1px solid #e5e7eb', borderRadius: 6, background: '#fff', color: '#1e293b', outline: 'none' };
const btnPrimary = { padding: '8px 14px', fontSize: 13, fontWeight: 600, background: '#0f172a', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontFamily: font };
const btnSecondary = { padding: '8px 14px', fontSize: 13, fontWeight: 500, background: '#fff', color: '#1e293b', border: '1px solid #e5e7eb', borderRadius: 8, cursor: 'pointer', fontFamily: font };
