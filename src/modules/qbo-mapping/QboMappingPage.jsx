import React, { useState, useEffect, useMemo } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { ArrowLeft, Check, Zap } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import ClientTypeAhead from '../work-planner/components/ClientTypeAhead';

const font = "'Outfit', sans-serif";

// Threshold above which a suggestion is "confident enough" for the
// auto-accept shortcut. pg_trgm similarity — 0.9+ effectively means
// the names are a variant of each other (spacing, Ltd/Limited).
const AUTO_ACCEPT_THRESHOLD = 0.9;

export default function QboMappingPage() {
  const navigate = useNavigate();
  const location = useLocation();

  const cameFromBilling = location.pathname.startsWith('/billing/');
  const backLabel = cameFromBilling ? 'Back to Fee Billing' : 'Back to Clients';
  const backRoute = cameFromBilling ? '/manage/billing' : '/clients';

  const [rows, setRows] = useState([]);
  const [entities, setEntities] = useState([]);
  const [suggestions, setSuggestions] = useState({}); // qbo_id → [{entity_id, entity_name, score}]
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(null);
  const [bulkRunning, setBulkRunning] = useState(false);
  const [filter, setFilter] = useState('unmapped');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState(new Set()); // qbo_customer_ids
  const [sort, setSort] = useState('name'); // name | score | qbo_id
  const [showAdd, setShowAdd] = useState(false);
  const [newId, setNewId] = useState('');
  const [newName, setNewName] = useState('');

  const load = async () => {
    setLoading(true);
    setSelected(new Set());
    const [{ data: maps }, { data: ents }] = await Promise.all([
      supabase.from('qbo_customer_mappings').select('*').order('qbo_customer_name'),
      supabase.from('entities').select('id, name').order('name'),
    ]);
    setRows(maps || []);
    setEntities(ents || []);

    const unmapped = (maps || []).filter((r) => !r.entity_id && r.role !== 'not_a_client' && r.qbo_customer_name);
    if (unmapped.length > 0) {
      const payload = unmapped.map((r) => ({ qbo_customer_id: r.qbo_customer_id, name: r.qbo_customer_name }));
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
    else if (filter === 'auto') {
      out = out.filter((r) => {
        if (r.entity_id || r.role === 'not_a_client') return false;
        const top = suggestions[r.qbo_customer_id]?.[0];
        return top && top.score >= AUTO_ACCEPT_THRESHOLD;
      });
    }
    else if (filter === 'review') out = out.filter((r) => r.needs_review);
    if (search.trim()) {
      const q = search.toLowerCase();
      out = out.filter((r) =>
        (r.qbo_customer_name || '').toLowerCase().includes(q) ||
        (r.qbo_customer_id || '').toLowerCase().includes(q) ||
        (entityMap[r.entity_id] || '').toLowerCase().includes(q)
      );
    }
    // Sort
    if (sort === 'score') {
      out = [...out].sort((a, b) => {
        const sa = (suggestions[a.qbo_customer_id]?.[0]?.score) ?? -1;
        const sb = (suggestions[b.qbo_customer_id]?.[0]?.score) ?? -1;
        return sb - sa;
      });
    } else if (sort === 'qbo_id') {
      out = [...out].sort((a, b) => (a.qbo_customer_id || '').localeCompare(b.qbo_customer_id || ''));
    }
    return out;
  }, [rows, filter, search, entityMap, sort, suggestions]);

  const counts = useMemo(() => ({
    total: rows.length,
    unmapped: rows.filter((r) => !r.entity_id && r.role !== 'not_a_client').length,
    mapped: rows.filter((r) => r.entity_id).length,
    ignored: rows.filter((r) => r.role === 'not_a_client').length,
    review: rows.filter((r) => r.needs_review).length,
  }), [rows]);

  // How many unmapped rows have a high-confidence top suggestion?
  const autoAcceptable = useMemo(() => {
    return rows.filter((r) => {
      if (r.entity_id || r.role === 'not_a_client') return false;
      const top = suggestions[r.qbo_customer_id]?.[0];
      return top && top.score >= AUTO_ACCEPT_THRESHOLD;
    });
  }, [rows, suggestions]);

  const visibleIds = filtered.map((r) => r.qbo_customer_id);
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));

  // ─── Mutations ───────────────────────────────────────────
  // Optimistic: apply the change to local state immediately, write to
  // the DB in the background, revert on failure. No full reload — at
  // 800+ rows each reload + suggestions RPC is a multi-second stall.
  const patchOptimistic = (qboId, fields) => {
    const prevRows = rows;
    const prevSuggestions = suggestions;
    // Any staff action on a row clears the needs_review flag and the
    // stored previous name — the review has happened.
    const effective = { ...fields, needs_review: false, previous_qbo_customer_name: null };
    setRows((r) => r.map((row) => row.qbo_customer_id === qboId ? { ...row, ...effective } : row));

    // Mapping or ignoring a row removes it from the suggestions map —
    // the "auto-acceptable" count and the suggestions column should
    // reflect the new state instantly.
    if (fields.entity_id !== undefined || fields.role === 'not_a_client') {
      setSuggestions((s) => {
        if (!s[qboId]) return s;
        const { [qboId]: _, ...rest } = s;
        return rest;
      });
    }

    setSaving(qboId);
    supabase.from('qbo_customer_mappings').update(effective).eq('qbo_customer_id', qboId)
      .then(({ error }) => {
        if (error) {
          console.error('[QBO mapping] save failed, rolling back:', error);
          alert('Save failed: ' + error.message);
          setRows(prevRows);
          setSuggestions(prevSuggestions);
        }
        setSaving(null);
      });
  };

  const setEntity = (qboId, entityId) => patchOptimistic(qboId, { entity_id: entityId || null, role: 'primary' });

  const toggleIgnore = (row) => {
    const nextRole = row.role === 'not_a_client' ? 'primary' : 'not_a_client';
    const fields = { role: nextRole };
    if (nextRole === 'not_a_client') fields.entity_id = null;
    patchOptimistic(row.qbo_customer_id, fields);
  };

  const acceptTopSuggestion = (row) => {
    const top = suggestions[row.qbo_customer_id]?.[0];
    if (!top) return;
    setEntity(row.qbo_customer_id, top.entity_id);
  };

  // Bulk ops — do all in one round-trip where possible.
  const bulkIgnore = async (ids) => {
    if (ids.length === 0) return;
    if (!window.confirm(`Ignore ${ids.length} QBO customer(s)? They'll be excluded from billing attribution and filtered out by default.`)) return;
    setBulkRunning(true);
    const { error } = await supabase
      .from('qbo_customer_mappings')
      .update({ role: 'not_a_client', entity_id: null, needs_review: false, previous_qbo_customer_name: null })
      .in('qbo_customer_id', ids);
    if (error) alert('Bulk ignore failed: ' + error.message);
    await load();
    setBulkRunning(false);
  };

  const bulkDelete = async (ids) => {
    if (ids.length === 0) return;
    if (!window.confirm(`Permanently delete ${ids.length} mapping row(s)? They'll reappear on next qbo-pull.`)) return;
    setBulkRunning(true);
    const { error } = await supabase
      .from('qbo_customer_mappings').delete().in('qbo_customer_id', ids);
    if (error) alert('Bulk delete failed: ' + error.message);
    await load();
    setBulkRunning(false);
  };

  const bulkAcceptTop = async (ids, minScore = 0) => {
    const picks = [];
    for (const id of ids) {
      const top = suggestions[id]?.[0];
      if (top && top.score >= minScore) picks.push({ id, entity_id: top.entity_id });
    }
    if (picks.length === 0) return;
    if (!window.confirm(`Accept top suggestion for ${picks.length} row(s)?`)) return;
    setBulkRunning(true);
    // Group by entity_id so each .update().in() is one call per entity.
    const byEntity = {};
    for (const p of picks) (byEntity[p.entity_id] ||= []).push(p.id);
    for (const [entityId, qboIds] of Object.entries(byEntity)) {
      await supabase
        .from('qbo_customer_mappings')
        .update({ entity_id: entityId, role: 'primary', needs_review: false, previous_qbo_customer_name: null })
        .in('qbo_customer_id', qboIds);
    }
    await load();
    setBulkRunning(false);
  };

  const autoAcceptHighConfidence = () => {
    const ids = autoAcceptable.map((r) => r.qbo_customer_id);
    bulkAcceptTop(ids, AUTO_ACCEPT_THRESHOLD);
  };

  const remove = async (qboId) => {
    if (!window.confirm(`Delete this mapping row? It will reappear on next qbo-pull if the customer still exists in QBO.`)) return;
    const prevRows = rows;
    setRows((r) => r.filter((row) => row.qbo_customer_id !== qboId));
    const { error } = await supabase.from('qbo_customer_mappings').delete().eq('qbo_customer_id', qboId);
    if (error) {
      alert('Delete failed: ' + error.message);
      setRows(prevRows);
    }
  };

  const addManual = async () => {
    if (!newId.trim()) return;
    const { error } = await supabase.from('qbo_customer_mappings').insert({
      qbo_customer_id: newId.trim(),
      qbo_customer_name: newName.trim() || null,
      role: 'primary',
    });
    if (error) { alert('Add failed: ' + error.message); return; }
    setShowAdd(false); setNewId(''); setNewName('');
    await load();
  };

  // Selection helpers
  const toggleSel = (id) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const toggleSelAll = () => {
    if (allVisibleSelected) setSelected(new Set());
    else setSelected(new Set(visibleIds));
  };
  const clearSel = () => setSelected(new Set());

  const selectedIds = [...selected];

  return (
    <div style={{ padding: '20px 28px', fontFamily: font, maxWidth: 1280 }}>
      <button onClick={() => navigate(backRoute)} style={backLinkStyle}>
        <ArrowLeft size={14} /> {backLabel}
      </button>

      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 6, gap: 16, flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ fontFamily: "'Playfair Display', serif", fontSize: 26, fontWeight: 500, color: '#0f172a', marginBottom: 2 }}>
            QuickBooks ↔ Athena mapping
          </h1>
          <p style={{ fontSize: 13, color: '#64748b', maxWidth: 720 }}>
            Link each QuickBooks customer to the Athena entity it represents.
            Use <b>Ignore</b> to sweep away QBO noise (internal references, dormant records).
          </p>
        </div>
        <button onClick={() => setShowAdd(true)} style={btnPrimary}>+ Add QBO customer</button>
      </div>

      {/* Auto-accept shortcut */}
      {autoAcceptable.length > 0 && (
        <div style={autoBannerStyle}>
          <Zap size={14} style={{ color: '#0e7fe0' }} />
          <span style={{ fontSize: 13, color: '#0c4a6e', flex: 1 }}>
            <b>{autoAcceptable.length}</b> unmapped QBO customer(s) have a{' '}
            <b>{Math.round(AUTO_ACCEPT_THRESHOLD * 100)}%+</b> name match to an Athena entity.
          </span>
          <button onClick={autoAcceptHighConfidence} disabled={bulkRunning} style={btnAutoAccept}>
            Auto-accept all {autoAcceptable.length}
          </button>
        </div>
      )}

      {/* Filter pills + sort + search */}
      <div style={{ display: 'flex', gap: 8, marginTop: 14, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' }}>
        {counts.review > 0 && (
          <FilterPill
            label="Needs review"
            count={counts.review}
            active={filter === 'review'}
            tone="purple"
            onClick={() => setFilter('review')}
          />
        )}
        <FilterPill label="Unmapped" count={counts.unmapped} active={filter === 'unmapped'} tone="amber" onClick={() => setFilter('unmapped')} />
        {autoAcceptable.length > 0 && (
          <FilterPill
            label={`Auto-acceptable (${Math.round(AUTO_ACCEPT_THRESHOLD * 100)}%+)`}
            count={autoAcceptable.length}
            active={filter === 'auto'}
            tone="blue"
            onClick={() => setFilter('auto')}
          />
        )}
        <FilterPill label="Mapped" count={counts.mapped} active={filter === 'mapped'} tone="green" onClick={() => setFilter('mapped')} />
        <FilterPill label="Ignored" count={counts.ignored} active={filter === 'ignored'} tone="slate" onClick={() => setFilter('ignored')} />
        <FilterPill label={`All (${counts.total})`} count={null} active={filter === 'all'} tone="default" onClick={() => setFilter('all')} />
        <select value={sort} onChange={(e) => setSort(e.target.value)} style={selectStyle} title="Sort">
          <option value="name">Name A-Z</option>
          <option value="score">Best match first</option>
          <option value="qbo_id">QBO ID</option>
        </select>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search QBO name, QBO id, or Athena entity..."
          style={{ ...selectStyle, flex: 1, minWidth: 240, marginLeft: 'auto' }}
        />
      </div>

      {/* Bulk action bar — visible when rows selected */}
      {selectedIds.length > 0 && (
        <div style={bulkBarStyle}>
          <span style={{ fontSize: 13, fontWeight: 500, color: '#0f172a' }}>
            {selectedIds.length} selected
          </span>
          <div style={{ flex: 1 }} />
          <button onClick={() => bulkAcceptTop(selectedIds, 0)} disabled={bulkRunning} style={btnSecondary}>
            Accept top suggestion
          </button>
          <button onClick={() => bulkIgnore(selectedIds)} disabled={bulkRunning} style={{ ...btnSecondary, color: '#991b1b', borderColor: '#fca5a5' }}>
            Ignore selected
          </button>
          <button onClick={() => bulkDelete(selectedIds)} disabled={bulkRunning} style={{ ...btnSecondary, color: '#991b1b', borderColor: '#fca5a5' }}>
            Delete selected
          </button>
          <button onClick={clearSel} disabled={bulkRunning} style={btnGhost}>Clear</button>
        </div>
      )}

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
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, tableLayout: 'fixed' }}>
            <colgroup>
              <col style={{ width: 32 }} />
              <col style={{ width: '30%' }} />
              <col style={{ width: '35%' }} />
              <col style={{ width: '27%' }} />
              <col style={{ width: 110 }} />
            </colgroup>
            <thead>
              <tr style={{ background: '#f8fafc' }}>
                <Th>
                  <input
                    type="checkbox"
                    checked={allVisibleSelected}
                    onChange={toggleSelAll}
                    title="Select all in current view"
                  />
                </Th>
                <Th>QBO customer</Th>
                <Th>Suggested match</Th>
                <Th>Athena entity</Th>
                <Th></Th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => {
                const isUnmapped = !r.entity_id && r.role !== 'not_a_client';
                const isIgnored = r.role === 'not_a_client';
                const rowSuggestions = suggestions[r.qbo_customer_id] || [];
                const top = rowSuggestions[0];
                const isSel = selected.has(r.qbo_customer_id);
                return (
                  <tr key={r.qbo_customer_id} style={{
                    borderTop: '1px solid #f1f5f9',
                    // Minimal theme: rows stay white; state carried by a
                    // 3px inset left accent bar. Review is the one state
                    // that also tints the row, since it's the loudest call.
                    background: isSel ? '#f0f9ff'
                      : r.needs_review ? '#eef2ff'
                      : 'transparent',
                    boxShadow: isSel ? 'inset 3px 0 0 #38bdf8'
                      : r.needs_review ? 'inset 3px 0 0 #818cf8'
                      : isUnmapped ? 'inset 3px 0 0 #fcd34d'
                      : 'none',
                    opacity: isIgnored && !r.needs_review ? 0.55 : 1,
                  }}>
                    <Td>
                      <input
                        type="checkbox"
                        checked={isSel}
                        onChange={() => toggleSel(r.qbo_customer_id)}
                      />
                    </Td>
                    <Td style={{ overflow: 'hidden' }}>
                      <div style={{ fontWeight: 500, color: '#0f172a', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                           title={r.qbo_customer_name || ''}>
                        {r.qbo_customer_name || <span style={{ color: '#cbd5e1' }}>—</span>}
                      </div>
                      {r.needs_review && r.previous_qbo_customer_name && (
                        <div style={{
                          fontSize: 10, color: '#3730a3', marginTop: 2,
                          display: 'inline-block', padding: '1px 6px', borderRadius: 4,
                          background: '#eef2ff', border: '1px solid #c7d2fe',
                        }}
                        title="This QBO customer was Ignored; its name changed in the last pull. Review and re-map if it's now a real client.">
                          renamed — was: {r.previous_qbo_customer_name}
                        </div>
                      )}
                      <div style={{ fontFamily: 'monospace', color: '#94a3b8', fontSize: 10 }}>
                        QBO #{r.qbo_customer_id}
                      </div>
                    </Td>
                    <Td>
                      {isUnmapped && top ? (
                        <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
                          <button
                            onClick={() => acceptTopSuggestion(r)}
                            disabled={saving === r.qbo_customer_id}
                            title={`Accept — ${Math.round(top.score * 100)}% match`}
                            style={suggestionChip(top.score)}
                          >
                            <Check size={10} /> {top.entity_name}
                            <span style={{ color: '#64748b', fontWeight: 400 }}> · {Math.round(top.score * 100)}%</span>
                          </button>
                          {rowSuggestions.length > 1 && (
                            <details style={{ display: 'inline', position: 'relative' }}>
                              <summary style={{
                                fontSize: 10, color: '#64748b', cursor: 'pointer',
                                listStyle: 'none', padding: '2px 4px',
                              }}>+{rowSuggestions.length - 1}</summary>
                              <div style={{
                                position: 'absolute', background: '#fff',
                                border: '1px solid #e5e7eb', borderRadius: 6,
                                padding: 4, marginTop: 2, zIndex: 10,
                                boxShadow: '0 2px 6px rgba(0,0,0,0.08)',
                                display: 'flex', flexDirection: 'column', gap: 3,
                                minWidth: 220,
                              }}>
                                {rowSuggestions.slice(1).map((s) => (
                                  <button key={s.entity_id} onClick={() => setEntity(r.qbo_customer_id, s.entity_id)}
                                    style={{ ...suggestionChip(s.score), justifyContent: 'flex-start' }}>
                                    <Check size={10} /> {s.entity_name}
                                    <span style={{ color: '#64748b', fontWeight: 400 }}> · {Math.round(s.score * 100)}%</span>
                                  </button>
                                ))}
                              </div>
                            </details>
                          )}
                        </div>
                      ) : isUnmapped ? (
                        <span style={{ fontSize: 10, color: '#94a3b8' }}>No close match</span>
                      ) : (
                        <span style={{ fontSize: 11, color: '#cbd5e1' }}>—</span>
                      )}
                    </Td>
                    <Td>
                      <ClientTypeAhead
                        entityList={entities}
                        value={r.entity_id || ''}
                        onChange={(id) => setEntity(r.qbo_customer_id, id)}
                        onAddNew={() => null}
                        size="small"
                      />
                    </Td>
                    <Td>
                      <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
                        <button
                          onClick={() => toggleIgnore(r)}
                          disabled={saving === r.qbo_customer_id}
                          title={isIgnored ? 'Restore' : 'Ignore — exclude from billing'}
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
                        <button onClick={() => remove(r.qbo_customer_id)}
                          title="Delete this mapping row"
                          style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#cbd5e1', fontSize: 14, padding: '0 4px' }}
                          onMouseEnter={(e) => { e.currentTarget.style.color = '#991b1b'; }}
                          onMouseLeave={(e) => { e.currentTarget.style.color = '#cbd5e1'; }}
                        >✕</button>
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
  // Minimal theme: mapped switches from green to blue, review stays as
  // indigo (it's the loud callout). Amber preserved for unmapped since
  // it's the colour of "needs your attention" in the rest of the portal.
  const tones = {
    amber: { active: { bg: '#fef3c7', fg: '#78350f', border: '#fcd34d' }, idle: { bg: '#fff', fg: '#78350f', border: '#fcd34d' } },
    green: { active: { bg: '#dbeafe', fg: '#1e40af', border: '#93c5fd' }, idle: { bg: '#fff', fg: '#1e40af', border: '#93c5fd' } },
    slate: { active: { bg: '#f1f5f9', fg: '#475569', border: '#cbd5e1' }, idle: { bg: '#fff', fg: '#64748b', border: '#cbd5e1' } },
    blue: { active: { bg: '#dbeafe', fg: '#1e40af', border: '#93c5fd' }, idle: { bg: '#fff', fg: '#1e40af', border: '#93c5fd' } },
    purple: { active: { bg: '#eef2ff', fg: '#3730a3', border: '#c7d2fe' }, idle: { bg: '#fff', fg: '#3730a3', border: '#c7d2fe' } },
    default: { active: { bg: '#0f172a', fg: '#fff', border: '#0f172a' }, idle: { bg: '#fff', fg: '#475569', border: '#e5e7eb' } },
  };
  const t = tones[tone] || tones.default;
  const s = active ? t.active : t.idle;
  return (
    <button onClick={onClick} style={{
      fontSize: 12, fontWeight: active ? 600 : 500,
      padding: '5px 12px', borderRadius: 999,
      background: s.bg, color: s.fg, border: `1px solid ${s.border}`,
      cursor: 'pointer', fontFamily: font,
    }}>
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

// ─── Styles ────────────────────────────────────────────────
const Th = ({ children }) => (
  <th style={{ textAlign: 'left', padding: '8px 12px', fontSize: 11, fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
    {children}
  </th>
);
const Td = ({ children, style }) => <td style={{ padding: '8px 12px', verticalAlign: 'middle', ...style }}>{children}</td>;

const selectStyle = { padding: '6px 10px', fontSize: 13, fontFamily: font, border: '1px solid #e5e7eb', borderRadius: 6, background: '#fff', color: '#1e293b', outline: 'none' };
const btnPrimary = { padding: '8px 14px', fontSize: 13, fontWeight: 600, background: '#0f172a', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontFamily: font };
const btnSecondary = { padding: '6px 12px', fontSize: 12, fontWeight: 500, background: '#fff', color: '#1e293b', border: '1px solid #e5e7eb', borderRadius: 6, cursor: 'pointer', fontFamily: font };
const btnGhost = { padding: '6px 12px', fontSize: 12, fontWeight: 500, background: 'none', color: '#64748b', border: 'none', cursor: 'pointer', fontFamily: font };
const btnAutoAccept = { padding: '7px 14px', fontSize: 12, fontWeight: 600, background: '#0e7fe0', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontFamily: font };

const backLinkStyle = {
  display: 'inline-flex', alignItems: 'center', gap: 4,
  fontSize: 12, fontWeight: 500, color: '#64748b',
  background: 'none', border: 'none', cursor: 'pointer',
  marginBottom: 12, padding: 0, fontFamily: font,
};

const autoBannerStyle = {
  display: 'flex', alignItems: 'center', gap: 10,
  padding: '10px 14px', marginTop: 10,
  background: '#f0f9ff', border: '1px solid #bae6fd', borderRadius: 8,
};

const bulkBarStyle = {
  display: 'flex', alignItems: 'center', gap: 8,
  padding: '10px 14px', marginBottom: 10,
  background: '#0f172a', color: '#fff', borderRadius: 8,
  position: 'sticky', top: 0, zIndex: 20,
};

function suggestionChip(score) {
  // Minimal theme: all chips on a neutral base. High-confidence (≥90%)
  // get a brighter blue fill + sky ring so the eye catches them, but
  // there's no green anywhere.
  const strong = score >= AUTO_ACCEPT_THRESHOLD;
  return {
    display: 'inline-flex', alignItems: 'center', gap: 3,
    fontSize: 11, padding: '3px 8px', borderRadius: 999,
    background: strong ? '#e0f2fe' : '#f1f5f9',
    border: '1px solid ' + (strong ? '#38bdf8' : '#e2e8f0'),
    color: '#0c4a6e',
    cursor: 'pointer', fontFamily: font, fontWeight: strong ? 600 : 500,
  };
}
