import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { ALLOCATION_SERVICES, fetchEntityPeople, fetchPeople, mergePeople } from '../lib/allocationsQueries';
import { teamColour } from '../lib/helpers';

const font = "'Outfit', sans-serif";

// Modal launched from the group cell. Three sections:
//   1. People in this group (with merge action)
//   2. Members table (current fee earner per service)
//   3. Bulk reallocate (pick a target person → propose draft for every cell)
export default function GroupReallocateModal({
  group,
  focalEntityId,
  entitiesById,
  staffList,
  staffMap,
  inferredMap,
  draftMap,
  onClose,
  onSaveDraft,
  onPersonMerged,
}) {
  const memberIds = group?.member_entity_ids || [focalEntityId];
  const memberEntities = useMemo(
    () => memberIds.map((id) => entitiesById.get(id)).filter(Boolean),
    [memberIds, entitiesById]
  );

  const [bulkTargetId, setBulkTargetId] = useState('');
  const [bulkServices, setBulkServices] = useState(() => new Set(ALLOCATION_SERVICES.map((s) => s.id)));
  const [busy, setBusy] = useState(false);

  // Per-group people
  const [groupPeople, setGroupPeople] = useState([]); // [{ person_id, person_name, roles: [{entity_id, role}] }]
  const [allPeople, setAllPeople] = useState([]);     // for the merge typeahead
  const [mergingFrom, setMergingFrom] = useState(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const [eps, ppl] = await Promise.all([fetchEntityPeople(memberIds), fetchPeople()]);
      if (cancelled) return;
      // Group entity_people rows by person.
      const byPerson = new Map();
      eps.forEach((row) => {
        if (!byPerson.has(row.person_id)) byPerson.set(row.person_id, { person_id: row.person_id, roles: [] });
        byPerson.get(row.person_id).roles.push({ entity_id: row.entity_id, role: row.role });
      });
      const personMap = new Map(ppl.map((p) => [p.id, p]));
      const collated = [...byPerson.values()].map((g) => ({
        ...g,
        person_name: personMap.get(g.person_id)?.name || 'Unknown',
        person: personMap.get(g.person_id),
      })).sort((a, b) => (a.person_name || '').localeCompare(b.person_name || ''));
      setGroupPeople(collated);
      setAllPeople(ppl);
    }
    load();
    return () => { cancelled = true; };
  }, [JSON.stringify(memberIds)]);

  // Resolve effective fee earner for a (entity, service) cell.
  const effectiveFor = useCallback((entityId, serviceId) => {
    const k = `${entityId}__${serviceId}`;
    const draft = draftMap.get(k);
    if (draft) return { feeEarnerId: draft.proposed_fee_earner_id, source: 'draft' };
    const inf = inferredMap.get(k);
    if (!inf) return { feeEarnerId: null, source: 'na' };
    if (!inf.assignee_id) return { feeEarnerId: null, source: 'unassigned' };
    return { feeEarnerId: inf.assignee_id, source: 'bm' };
  }, [draftMap, inferredMap]);

  // Cells affected by bulk reallocate: every selected service × member where
  // status ≠ na and current fee earner ≠ target.
  const affectedCells = useMemo(() => {
    if (!bulkTargetId) return [];
    const cells = [];
    for (const e of memberEntities) {
      for (const s of ALLOCATION_SERVICES) {
        if (!bulkServices.has(s.id)) continue;
        const { feeEarnerId, source } = effectiveFor(e.id, s.id);
        if (source === 'na') continue;
        if (feeEarnerId === bulkTargetId) continue;
        cells.push({ entityId: e.id, serviceId: s.id, currentId: feeEarnerId, status: source });
      }
    }
    return cells;
  }, [bulkTargetId, bulkServices, memberEntities, effectiveFor]);

  async function applyBulk() {
    if (!affectedCells.length || !bulkTargetId) return;
    setBusy(true);
    try {
      for (const c of affectedCells) {
        await onSaveDraft({ entityId: c.entityId, serviceId: c.serviceId, feeEarnerId: bulkTargetId });
      }
      onClose();
    } finally {
      setBusy(false);
    }
  }

  async function handleMergeConfirm(targetPersonId) {
    if (!mergingFrom || !targetPersonId || mergingFrom.person_id === targetPersonId) return;
    setBusy(true);
    try {
      await mergePeople(mergingFrom.person_id, targetPersonId);
      setMergingFrom(null);
      onPersonMerged?.();
      onClose();
    } catch (err) {
      alert(`Merge failed: ${err.message || err}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 1000, fontFamily: font,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: '#fff', borderRadius: 12, padding: 0,
          width: 'min(960px, 92vw)', maxHeight: '88vh',
          display: 'flex', flexDirection: 'column',
          boxShadow: '0 20px 60px rgba(0,0,0,0.25)',
        }}
      >
        {/* Header */}
        <div style={{
          padding: '18px 24px', borderBottom: '1px solid #e5e7eb',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <div>
            <div style={{ fontSize: 11, fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: 0.5 }}>
              Group
            </div>
            <h2 style={{ fontFamily: "'Playfair Display', serif", fontSize: 22, fontWeight: 500, color: '#0f172a', margin: '2px 0 0' }}>
              {group?.label_person_name || 'Ungrouped'}
            </h2>
            <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>
              {memberEntities.length} member{memberEntities.length === 1 ? '' : 's'} ·{' '}
              {groupPeople.length} {groupPeople.length === 1 ? 'person' : 'people'}
            </div>
          </div>
          <button onClick={onClose} style={iconBtnStyle()} title="Close (Esc)">×</button>
        </div>

        {/* Scrollable body */}
        <div style={{ overflow: 'auto', padding: 24, display: 'flex', flexDirection: 'column', gap: 28 }}>

          {/* People section */}
          <Section title="People">
            {groupPeople.length === 0 ? (
              <Empty>No linked people. Run the Companies House sync (Data Import → Companies House).</Empty>
            ) : (
              <table style={tableStyle}>
                <thead>
                  <tr>
                    <th style={thStyle}>Person</th>
                    <th style={thStyle}>Roles</th>
                    <th style={{ ...thStyle, width: 110 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {groupPeople.map((p) => (
                    <tr key={p.person_id} style={{ borderBottom: '1px solid #f1f5f9' }}>
                      <td style={tdStyle}>
                        <div style={{ fontWeight: 500, color: '#0f172a' }}>{p.person_name}</div>
                        <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2 }}>
                          {p.person?.source?.replace(/_/g, ' ') || ''}
                          {p.person?.dob_year ? ` · ${p.person.dob_month ?? '?'}/${p.person.dob_year}` : ''}
                        </div>
                      </td>
                      <td style={tdStyle}>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                          {p.roles.map((r, i) => (
                            <div key={i} style={{ fontSize: 12 }}>
                              <span style={{
                                fontSize: 10, fontWeight: 600, padding: '1px 5px', borderRadius: 3,
                                background: '#e2e8f0', color: '#475569', marginRight: 6,
                              }}>{r.role.replace(/_/g, ' ')}</span>
                              {entitiesById.get(r.entity_id)?.name || r.entity_id.slice(0, 8)}
                            </div>
                          ))}
                        </div>
                      </td>
                      <td style={{ ...tdStyle, textAlign: 'right' }}>
                        <button
                          onClick={() => setMergingFrom(p)}
                          disabled={busy}
                          style={smallBtn('ghost')}
                          title="Merge this person into another (e.g. fix duplicate)"
                        >
                          Merge…
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Section>

          {/* Members table */}
          <Section title="Current allocations across the group">
            <div style={{ overflowX: 'auto' }}>
              <table style={tableStyle}>
                <thead>
                  <tr>
                    <th style={thStyle}>Client</th>
                    {ALLOCATION_SERVICES.map((s) => (
                      <th key={s.id} style={{ ...thStyle, textAlign: 'center', minWidth: 120 }}>
                        {s.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {memberEntities.map((e) => (
                    <tr key={e.id} style={{ borderBottom: '1px solid #f1f5f9' }}>
                      <td style={{ ...tdStyle, fontWeight: 500 }}>{e.name}</td>
                      {ALLOCATION_SERVICES.map((s) => {
                        const eff = effectiveFor(e.id, s.id);
                        if (eff.source === 'na') {
                          return <td key={s.id} style={{ ...tdStyle, textAlign: 'center', color: '#cbd5e1', fontStyle: 'italic' }}>n/a</td>;
                        }
                        if (!eff.feeEarnerId) {
                          return <td key={s.id} style={{ ...tdStyle, textAlign: 'center', color: '#94a3b8' }}>—</td>;
                        }
                        const colour = staffMap[eff.feeEarnerId]?.colour || teamColour(eff.feeEarnerId);
                        return (
                          <td key={s.id} style={{ ...tdStyle, textAlign: 'center' }}>
                            <span style={{
                              display: 'inline-block', padding: '2px 8px', borderRadius: 10,
                              background: colour, color: '#fff', fontSize: 11, fontWeight: 600,
                              fontStyle: eff.source === 'bm' ? 'italic' : 'normal',
                              outline: eff.source === 'draft' ? '2px solid #f59e0b' : 'none',
                            }}>
                              {staffMap[eff.feeEarnerId]?.name || eff.feeEarnerId.slice(0, 6)}
                            </span>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>

          {/* Bulk reallocate */}
          <Section title="Bulk reallocate this group">
            <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
              <label style={{ fontSize: 13, color: '#475569' }}>Assign all selected services to:</label>
              <select
                value={bulkTargetId}
                onChange={(e) => setBulkTargetId(e.target.value)}
                style={selectStyle}
              >
                <option value="">— pick a person —</option>
                {staffList.filter((s) => s.is_active !== false).map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </div>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
              {ALLOCATION_SERVICES.map((s) => (
                <label key={s.id} style={{ fontSize: 12, color: '#475569', display: 'flex', alignItems: 'center', gap: 4 }}>
                  <input
                    type="checkbox"
                    checked={bulkServices.has(s.id)}
                    onChange={(ev) => {
                      setBulkServices((prev) => {
                        const next = new Set(prev);
                        if (ev.target.checked) next.add(s.id); else next.delete(s.id);
                        return next;
                      });
                    }}
                  />
                  {s.label}
                </label>
              ))}
            </div>
            <div style={{ fontSize: 12, color: '#64748b', marginBottom: 12 }}>
              {bulkTargetId
                ? <>Will create <strong>{affectedCells.length}</strong> reallocation proposal{affectedCells.length === 1 ? '' : 's'}{' '}
                   (skips n/a cells and cells already assigned to {staffMap[bulkTargetId]?.name}).</>
                : 'Pick a person above to preview affected cells.'}
            </div>
            <button
              onClick={applyBulk}
              disabled={busy || !bulkTargetId || affectedCells.length === 0}
              style={smallBtn(busy || !bulkTargetId || affectedCells.length === 0 ? 'disabled' : 'primary')}
            >
              {busy ? 'Applying…' : `Propose ${affectedCells.length || ''} reallocation${affectedCells.length === 1 ? '' : 's'}`}
            </button>
          </Section>
        </div>

        {/* Merge confirm overlay */}
        {mergingFrom && (
          <MergePicker
            from={mergingFrom}
            people={allPeople}
            onCancel={() => setMergingFrom(null)}
            onConfirm={handleMergeConfirm}
            busy={busy}
          />
        )}
      </div>
    </div>
  );
}

// ── Sub-components ──

function MergePicker({ from, people, onCancel, onConfirm, busy }) {
  const [query, setQuery] = useState('');
  const [target, setTarget] = useState(null);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return people
      .filter((p) => p.id !== from.person_id)
      .filter((p) => (p.name || '').toLowerCase().includes(q))
      .slice(0, 30);
  }, [query, people, from.person_id]);

  return (
    <div style={{
      position: 'absolute', inset: 0, background: 'rgba(15,23,42,0.55)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2,
    }}>
      <div style={{
        background: '#fff', borderRadius: 10, padding: 20, width: 480,
        boxShadow: '0 20px 60px rgba(0,0,0,0.25)',
      }}>
        <h3 style={{ fontFamily: "'Playfair Display', serif", fontSize: 18, fontWeight: 500, margin: '0 0 6px', color: '#0f172a' }}>
          Merge person
        </h3>
        <p style={{ fontSize: 13, color: '#475569', margin: '0 0 14px' }}>
          Move all of <strong>{from.person_name}</strong>'s links onto another person record, then delete this one. Used to fix duplicates (e.g. sole-trader Graeme + CH-derived Graeme).
        </p>
        <input
          type="text"
          autoFocus
          value={query}
          placeholder="Search people…"
          onChange={(e) => { setQuery(e.target.value); setTarget(null); }}
          style={{
            width: '100%', padding: '8px 10px', fontSize: 13, fontFamily: font,
            border: '1px solid #cbd5e1', borderRadius: 6, marginBottom: 10,
          }}
        />
        {filtered.length > 0 && !target && (
          <div style={{
            border: '1px solid #e5e7eb', borderRadius: 6,
            maxHeight: 220, overflow: 'auto',
          }}>
            {filtered.map((p) => (
              <button
                key={p.id}
                onClick={() => setTarget(p)}
                style={{
                  display: 'block', width: '100%', textAlign: 'left',
                  padding: '8px 10px', border: 'none', background: '#fff',
                  borderBottom: '1px solid #f1f5f9', cursor: 'pointer',
                  fontFamily: font, fontSize: 13,
                }}
              >
                <div style={{ color: '#0f172a' }}>{p.name}</div>
                <div style={{ fontSize: 10, color: '#94a3b8' }}>
                  {p.source?.replace(/_/g, ' ')}{p.dob_year ? ` · ${p.dob_month ?? '?'}/${p.dob_year}` : ''}
                </div>
              </button>
            ))}
          </div>
        )}
        {target && (
          <div style={{
            background: '#fef3c7', border: '1px solid #fde68a',
            borderRadius: 6, padding: '10px 12px', fontSize: 13, color: '#92400e',
          }}>
            Merge <strong>{from.person_name}</strong> → <strong>{target.name}</strong>?
            This is permanent.
          </div>
        )}
        <div style={{ marginTop: 14, display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button onClick={onCancel} style={smallBtn('ghost')}>Cancel</button>
          <button
            onClick={() => onConfirm(target?.id)}
            disabled={!target || busy}
            style={smallBtn(target && !busy ? 'primary' : 'disabled')}
          >
            {busy ? 'Merging…' : 'Merge'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div>
      <div style={{
        fontSize: 11, fontWeight: 600, color: '#64748b',
        textTransform: 'uppercase', letterSpacing: 0.5,
        marginBottom: 10,
      }}>{title}</div>
      {children}
    </div>
  );
}

function Empty({ children }) {
  return <div style={{ fontSize: 13, color: '#94a3b8', fontStyle: 'italic' }}>{children}</div>;
}

const tableStyle = { width: '100%', borderCollapse: 'collapse', fontSize: 13 };
const thStyle = {
  textAlign: 'left', padding: '8px 10px', fontSize: 11,
  fontWeight: 600, color: '#64748b',
  textTransform: 'uppercase', letterSpacing: 0.5,
  borderBottom: '1px solid #e5e7eb',
};
const tdStyle = { padding: '8px 10px', verticalAlign: 'top' };
const selectStyle = {
  padding: '6px 10px', fontSize: 13, fontFamily: font,
  border: '1px solid #cbd5e1', borderRadius: 6, background: '#fff',
};

function smallBtn(variant) {
  const base = {
    padding: '6px 14px', fontSize: 12, fontWeight: 500,
    fontFamily: font, borderRadius: 6, cursor: 'pointer',
  };
  if (variant === 'primary') return { ...base, background: '#0f172a', color: '#fff', border: '1px solid #0f172a' };
  if (variant === 'disabled') return { ...base, background: '#e2e8f0', color: '#94a3b8', border: '1px solid #e2e8f0', cursor: 'not-allowed' };
  return { ...base, background: '#fff', color: '#64748b', border: '1px solid #cbd5e1' };
}

function iconBtnStyle() {
  return {
    border: 'none', background: 'none', cursor: 'pointer',
    fontSize: 24, color: '#94a3b8', padding: '0 8px',
    fontFamily: font,
  };
}
