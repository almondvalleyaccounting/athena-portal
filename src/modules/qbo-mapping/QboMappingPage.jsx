import React, { useState, useEffect, useMemo } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { ArrowLeft, Check } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import ClientTypeAhead from '../work-planner/components/ClientTypeAhead';

const font = "'Outfit', sans-serif";

export default function QboMappingPage() {
  const navigate = useNavigate();
  const location = useLocation();

  // Figure out the right "back" target based on how we got here.
  const cameFromBilling = location.pathname.startsWith('/billing/');
  const backLabel = cameFromBilling ? 'Back to Fee Billing' : 'Back to Clients';
  const backRoute = cameFromBilling ? '/manage/billing' : '/clients';

  const [rows, setRows] = useState([]);
  const [entities, setEntities] = useState([]);
  const [suggestions, setSuggestions] = useState({}); // qbo_customer_id → [{entity_id, entity_name, score}]
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(null);
  const [filter, setFilter] = useState('unmapped'); // default to the thing that needs action
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

    // Fetch suggestions for every unmapped row (one RPC call).
    const unmapped = (maps || []).filter((r) => !r.entity_id && r.role !== 'not_a_client' && r.qbo_customer_name);
    if (unmapped.length > 0) {
      const payload = unmapped.map((r) => ({
        qbo_customer_id: r.qbo_customer_id,
        name: r.qbo_customer_name,
      }));
      try {
        const { data, error } = await supabase.rpc('suggest_entities_for_qbo', {
          customers: payload, min_score: 0.3, limit_n: 3,
        });
        if (!error && data) {
          const m = {};
          for (const s of data) m[s.qbo_customer_id] = s.suggestions || [];
          setSuggestions(m);
        }
      } catch (e) {
        console.error('[QBO mapping] suggestions error:', e);
      }
    } else {
      setSuggestions({});
    }
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
    if (filter === 'unmapped') out = out.filter((r) => !r.entity_id && r.role !== 'not_a_client');
    else if (filter === 'mapped') out = out.filter((r) => r.entity_id);
    else if (filter === 'ignored') out = out.filter((r) => r.role === 'not_a_client');
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

  const counts = useMemo(() => ({
    total: rows.length,
    unmapped: rows.filter((r) => !r.entity_id && r.role !== 'not_a_client').length,
    mapped: rows.filter((r) => r.entity_id).length,
    ignored: rows.filter((r) => r.role === 'not_a_client').length,
  }), [rows]);

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

  const setEntity = (qboId, entityId) => patch(qboId, { entity_id: entityId || null });
  const toggleIgnore = (row) => {
    const nextRole = row.role === 'not_a_client' ? 'primary' : 'not_a_client';
    const fields = { role: nextRole };
    // Ignoring a mapped row also clears the entity_id, since the point
    // is to tell the system "don't track this customer against any entity".
    if (nextRole === 'not_a_client') fields.entity_id = null;
    patch(row.qbo_customer_id, fields);
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
    <div style={{ padding: '20px 28px', fontFamily: font, maxWidth: 1200 }}>
      {/* Back link */}
      <button
        onClick={() => navigate(backRoute)}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 4,
          fontSize: 12, fontWeight: 500, color: '#64748b',
          background: 'none', border: 'none', cursor: 'pointer',
          marginBottom: 12, padding: 0, fontFamily: font,
        }}
      >
        <ArrowLeft size={14} /> {backLabel}
      </button>

      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 6 }}>
        <div>
          <h1 style={{ fontFamily: "'Playfair Display', serif", fontSize: 26, fontWeight: 500, color: '#0f172a', marginBottom: 2 }}>
            QuickBooks ↔ Athena mapping
          </h1>
          <p style={{ fontSize: 13, color: '#64748b' }}>
            Link each QuickBooks customer to the Athena entity it represents.
            Multiple QBO rows can point at the same entity; irrelevant QBO
            customers can be Ignored.
          </p>
        </div>
        <button onClick={() => setShowAdd(true)} style={btnPrimary}>+ Add QBO customer</button>
      </div>

      {/* Counts / filter pills */}
      <div style={{ display: 'flex', gap: 8, marginTop: 14, marginBottom: 14, flexWrap: 'wrap' }}>
        <FilterPill label="Unmapped" count={counts.unmapped} active={filter === 'unmapped'} tone="amber" onClick={() => setFilter('unmapped')} />
        <FilterPill label="Mapped" count={counts.mapped} active={filter === 'mapped'} tone="green" onClick={() => setFilter('mapped')} />
        <FilterPill label="Ignored" count={counts.ignored} active={filter === 'ignored'} tone="slate" onClick={() => setFilter('ignored')} />
        <FilterPill label={`All (${counts.total})`} count={null} active={filter === 'all'} tone="default" onClick={() => setFilter('all')} />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search QBO name, QBO id, or Athena entity..."
          style={{ ...selectStyle, flex: 1, minWidth: 240, marginLeft: 'auto' }}
        />
      </div>

      {showAdd && (
        <div style={{
          background: '#f8fafc', border: '1px solid #e5e7eb', borderRadius: 10,
          padding: 14, marginBottom: 14, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap',
        }}>
          <input value={newId} onChange={(e) => setNewId(e.target.value)} placeholder="QBO customer ID (required)" style={selectStyle} />
          <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="QBO name (optional)" style={selectStyle} />
          <button onClick={addManual} style={btnPrimary}>Add</button>
          <button onClick={() => { setShowAdd(false); setNewId(''); setNewName(''); }} style={btnSecondary}>Cancel</button>
        </div>
      )}

      {loading ? (
        <p style={{ fontSize: 13, color: '#94a3b8', padding: 40, textAlign: 'center' }}>Loading…</p>
      ) : filtered.length === 0 ? (
        <EmptyState filter={filter} total={rows.length} />
      ) : (
        <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: '#f8fafc' }}>
                <Th>QBO customer</Th>
                <Th>Athena entity</Th>
                <Th>Last seen</Th>
                <Th></Th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => {
                const isUnmapped = !r.entity_id && r.role !== 'not_a_client';
                const isIgnored = r.role === 'not_a_client';
                const rowSuggestions = suggestions[r.qbo_customer_id] || [];
                return (
                  <tr key={r.qbo_customer_id}
                    style={{
                      borderTop: '1px solid #f1f5f9',
                      background: isIgnored ? '#f8fafc' : isUnmapped ? '#fefce8' : 'transparent',
                      opacity: isIgnored ? 0.6 : 1,
                    }}>
                    <Td>
                      <div style={{ fontWeight: 500, color: '#0f172a' }}>
                        {r.qbo_customer_name || <span style={{ color: '#cbd5e1' }}>—</span>}
                      </div>
                      <div style={{ fontFamily: 'monospace', color: '#94a3b8', fontSize: 10 }}>{r.qbo_customer_id}</div>
                    </Td>
                    <Td style={{ minWidth: 240 }}>
                      <ClientTypeAhead
                        entityList={entities}
                        value={r.entity_id || ''}
                        onChange={(id) => setEntity(r.qbo_customer_id, id)}
                        onAddNew={() => null}
                        size="small"
                      />
                      {/* Suggestions — only for unmapped rows */}
                      {isUnmapped && rowSuggestions.length > 0 && (
                        <div style={{ marginTop: 6, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                          <span style={{ fontSize: 10, color: '#94a3b8', marginRight: 2, alignSelf: 'center' }}>
                            Suggested:
                          </span>
                          {rowSuggestions.map((s) => (
                            <button
                              key={s.entity_id}
                              onClick={() => setEntity(r.qbo_customer_id, s.entity_id)}
                              disabled={saving === r.qbo_customer_id}
                              title={`${Math.round(s.score * 100)}% name match · ${s.entity_status || ''}`}
                              style={{
                                display: 'inline-flex', alignItems: 'center', gap: 3,
                                fontSize: 11, padding: '3px 8px', borderRadius: 999,
                                background: '#f0f9ff', border: '1px solid #bae6fd',
                                color: '#0c4a6e', cursor: 'pointer', fontFamily: font,
                              }}
                              onMouseEnter={(e) => { e.currentTarget.style.background = '#e0f2fe'; }}
                              onMouseLeave={(e) => { e.currentTarget.style.background = '#f0f9ff'; }}
                            >
                              <Check size={10} /> {s.entity_name}
                              <span style={{ color: '#64748b' }}> · {Math.round(s.score * 100)}%</span>
                            </button>
                          ))}
                        </div>
                      )}
                      {isUnmapped && rowSuggestions.length === 0 && !loading && (
                        <div style={{ marginTop: 4, fontSize: 10, color: '#94a3b8' }}>
                          No close name matches — pick manually or Ignore.
                        </div>
                      )}
                    </Td>
                    <Td style={{ color: '#94a3b8', fontSize: 11 }}>
                      {r.last_seen ? new Date(r.last_seen).toLocaleDateString('en-GB') : '—'}
                    </Td>
                    <Td>
                      <div style={{ display: 'flex', gap: 6, alignItems: 'center', justifyContent: 'flex-end' }}>
                        <button
                          onClick={() => toggleIgnore(r)}
                          disabled={saving === r.qbo_customer_id}
                          title={isIgnored ? 'Restore — re-include in mapping' : 'Ignore — exclude from billing attribution'}
                          style={{
                            fontSize: 11, padding: '3px 10px', borderRadius: 6,
                            border: '1px solid ' + (isIgnored ? '#cbd5e1' : '#fca5a5'),
                            background: isIgnored ? '#f8fafc' : '#fff',
                            color: isIgnored ? '#475569' : '#991b1b',
                            cursor: 'pointer', fontFamily: font,
                          }}
                        >
                          {isIgnored ? 'Restore' : 'Ignore'}
                        </button>
                        <button
                          onClick={() => remove(r.qbo_customer_id)}
                          title="Delete mapping row"
                          style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#cbd5e1', fontSize: 14 }}
                          onMouseEnter={(e) => { e.currentTarget.style.color = '#991b1b'; }}
                          onMouseLeave={(e) => { e.currentTarget.style.color = '#cbd5e1'; }}
                        >
                          ✕
                        </button>
                      </div>
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

function FilterPill({ label, count, active, tone, onClick }) {
  const tones = {
    amber: { active: { bg: '#fef3c7', fg: '#78350f', border: '#fcd34d' }, idle: { bg: '#fff', fg: '#78350f', border: '#fcd34d' } },
    green: { active: { bg: '#dcfce7', fg: '#166534', border: '#86efac' }, idle: { bg: '#fff', fg: '#166534', border: '#86efac' } },
    slate: { active: { bg: '#f1f5f9', fg: '#475569', border: '#cbd5e1' }, idle: { bg: '#fff', fg: '#64748b', border: '#cbd5e1' } },
    default: { active: { bg: '#0f172a', fg: '#fff', border: '#0f172a' }, idle: { bg: '#fff', fg: '#475569', border: '#e5e7eb' } },
  };
  const t = tones[tone] || tones.default;
  const s = active ? t.active : t.idle;
  return (
    <button
      onClick={onClick}
      style={{
        fontSize: 12, fontWeight: active ? 600 : 500,
        padding: '5px 12px', borderRadius: 999,
        background: s.bg, color: s.fg, border: `1px solid ${s.border}`,
        cursor: 'pointer', fontFamily: font,
      }}
    >
      {label}{count != null ? ` · ${count}` : ''}
    </button>
  );
}

function EmptyState({ filter, total }) {
  return (
    <div style={{ padding: 60, textAlign: 'center' }}>
      <p style={{ fontSize: 15, fontWeight: 500, color: '#94a3b8', marginBottom: 4 }}>
        {total === 0 ? 'No QBO customers tracked yet' : 'Nothing to show here'}
      </p>
      <p style={{ fontSize: 13, color: '#cbd5e1' }}>
        {total === 0
          ? 'QBO customers appear after the next Pull from QBO, or add one manually.'
          : filter === 'unmapped' ? 'All QBO customers are resolved. Nice.'
          : filter === 'mapped' ? 'Nothing mapped yet — resolve some unmapped rows.'
          : filter === 'ignored' ? 'No customers ignored.'
          : 'Adjust filters.'}
      </p>
    </div>
  );
}

const Th = ({ children }) => (
  <th style={{ textAlign: 'left', padding: '10px 14px', fontSize: 11, fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
    {children}
  </th>
);
const Td = ({ children, style }) => <td style={{ padding: '10px 14px', verticalAlign: 'top', ...style }}>{children}</td>;

const selectStyle = { padding: '6px 10px', fontSize: 13, fontFamily: font, border: '1px solid #e5e7eb', borderRadius: 6, background: '#fff', color: '#1e293b', outline: 'none' };
const btnPrimary = { padding: '8px 14px', fontSize: 13, fontWeight: 600, background: '#0f172a', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontFamily: font };
const btnSecondary = { padding: '8px 14px', fontSize: 13, fontWeight: 500, background: '#fff', color: '#1e293b', border: '1px solid #e5e7eb', borderRadius: 8, cursor: 'pointer', fontFamily: font };
