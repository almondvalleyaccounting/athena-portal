import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useWorkPlanner } from '../WorkPlannerModule';
import { useAuth } from '../../../shell/AppShell';
import {
  ALLOCATION_SERVICES,
  fetchAllocationDrafts, fetchAllocationEntities,
  fetchInferredAllocations, fetchClientGroups,
  upsertAllocationDraft, discardAllocationDraft,
} from '../lib/allocationsQueries';
import { teamColour } from '../lib/helpers';
import GroupReallocateModal from '../components/GroupReallocateModal';

const SERVICE_COL_W = 200;
const CLIENT_COL_W = 240;
const GROUP_COL_W = 170;
const ROW_H = 36;

export default function AllocationsView() {
  const { staffList, staffMap } = useWorkPlanner();
  const { profile } = useAuth();

  const [entities, setEntities] = useState([]);
  const [inferred, setInferred] = useState([]);
  const [drafts, setDrafts] = useState([]);
  const [groups, setGroups] = useState([]);
  const [groupModalEntityId, setGroupModalEntityId] = useState(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const [editing, setEditing] = useState(null); // { entityId, serviceId }
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState('clients'); // 'clients' | 'staff'
  const [search, setSearch] = useState('');
  const [showOnlyGaps, setShowOnlyGaps] = useState(false);
  const [includeProspects, setIncludeProspects] = useState(false);
  const [typeFilter, setTypeFilter] = useState(''); // '' | 'limited_company' | 'sole_trader' | 'partnership'
  // Per-service-column fee-earner filter. Map<serviceId, '' | '__unassigned' | staffId>.
  const [colFilter, setColFilter] = useState({});
  // Layered sort: ordered list of { serviceId | '_client', dir: 'asc' | 'desc' }.
  // Empty by default — clicks build the priority list. Client name is the
  // implicit final tiebreaker so the list still has a stable order.
  const [sortStack, setSortStack] = useState([]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [e, inf, d, g] = await Promise.all([
          fetchAllocationEntities(),
          fetchInferredAllocations(),
          fetchAllocationDrafts(),
          fetchClientGroups(),
        ]);
        if (!cancelled) {
          setEntities(e);
          setInferred(inf);
          setDrafts(d);
          setGroups(g);
        }
      } catch (err) {
        console.error('[Allocations] load failed:', err);
      }
      if (!cancelled) setLoading(false);
    }
    load();
    return () => { cancelled = true; };
  }, [refreshTick]);

  const draftMap = useMemo(() => {
    const m = new Map();
    drafts.forEach((d) => m.set(`${d.entity_id}__${d.canonical_service_id}`, d));
    return m;
  }, [drafts]);

  const inferredMap = useMemo(() => {
    const m = new Map();
    inferred.forEach((i) => {
      m.set(`${i.entity_id}__${i.canonical_service_id}`, i);
    });
    return m;
  }, [inferred]);

  // Resolves the effective fee earner for a (entity, service) cell.
  // Priority: draft proposal > BM-inferred.
  const effectiveFeeEarner = useCallback((entityId, serviceId) => {
    const k = `${entityId}__${serviceId}`;
    const draft = draftMap.get(k);
    if (draft) return draft.proposed_fee_earner_id || null;
    const inf = inferredMap.get(k);
    return inf?.assignee_id || null;
  }, [draftMap, inferredMap]);

  // Group lookup: entity_id → { label, members[] }
  const groupMap = useMemo(() => {
    const m = new Map();
    groups.forEach((g) => m.set(g.entity_id, g));
    return m;
  }, [groups]);

  // Group fragmentation per entity: how many distinct fee earners look after
  // its group across the 5 services. 1 = good, 2+ = fragmented.
  const groupFragmentation = useCallback((entityId) => {
    const g = groupMap.get(entityId);
    const members = g?.member_entity_ids || [entityId];
    const earners = new Set();
    const services = ALLOCATION_SERVICES.map((s) => s.id);
    for (const m of members) {
      for (const s of services) {
        const k = `${m}__${s}`;
        const draft = draftMap.get(k);
        const fee = draft
          ? draft.proposed_fee_earner_id
          : (inferredMap.get(k)?.assignee_id);
        if (fee) earners.add(fee);
      }
    }
    return { count: earners.size, ids: [...earners], members };
  }, [groupMap, draftMap, inferredMap]);

  // Cell status: 'na' (no BM task) | 'unassigned' (BM task, no assignee)
  // | 'bm' | 'draft'.
  const cellStatus = useCallback((entityId, serviceId) => {
    const k = `${entityId}__${serviceId}`;
    if (draftMap.has(k)) return 'draft';
    const inf = inferredMap.get(k);
    if (!inf) return 'na';
    return inf.assignee_id ? 'bm' : 'unassigned';
  }, [draftMap, inferredMap]);

  const clientEntities = useMemo(() => {
    const term = search.trim().toLowerCase();
    const filtered = entities
      .filter((e) => includeProspects ? true : e.entity_status !== 'prospect')
      .filter((e) => !typeFilter || e.type === typeFilter)
      .filter((e) => !term || (e.name || '').toLowerCase().includes(term))
      .filter((e) => {
        // Per-column fee-earner filter
        for (const sv of ALLOCATION_SERVICES) {
          const want = colFilter[sv.id];
          if (!want) continue;
          const status = cellStatus(e.id, sv.id);
          const got = effectiveFeeEarner(e.id, sv.id);
          if (want === '__unassigned') {
            if (status !== 'unassigned') return false;
          } else if (want === '__na') {
            if (status !== 'na') return false;
          } else {
            if (got !== want) return false;
          }
        }
        return true;
      })
      .filter((e) => {
        if (!showOnlyGaps) return true;
        // A gap = an applicable service (BM task exists) but no assignee.
        return ALLOCATION_SERVICES.some((s) => cellStatus(e.id, s.id) === 'unassigned');
      });

    // Layered sort. Cells without an effective assignee (n/a, unassigned)
    // bucket to the bottom regardless of sort direction so they cluster.
    const sortKeyFor = (e, key) => {
      if (key === '_client') return (e.name || '').toLowerCase();
      if (key === '_group') {
        const label = groupMap.get(e.id)?.label_person_name;
        if (!label) return { _empty: true, val: '' };
        return { _empty: false, val: label.toLowerCase() };
      }
      const status = cellStatus(e.id, key);
      const sid = effectiveFeeEarner(e.id, key);
      if (!sid) return { _empty: true, val: status === 'na' ? '~~na' : '~unassigned' };
      return { _empty: false, val: (staffMap[sid]?.name || '').toLowerCase() };
    };
    const cmp = (a, b) => {
      for (const { key, dir } of sortStack) {
        const av = sortKeyFor(a, key);
        const bv = sortKeyFor(b, key);
        const aEmpty = typeof av === 'object' ? av._empty : false;
        const bEmpty = typeof bv === 'object' ? bv._empty : false;
        // Empties always go to the bottom.
        if (aEmpty !== bEmpty) return aEmpty ? 1 : -1;
        const aVal = typeof av === 'object' ? av.val : av;
        const bVal = typeof bv === 'object' ? bv.val : bv;
        if (aVal < bVal) return dir === 'asc' ? -1 : 1;
        if (aVal > bVal) return dir === 'asc' ?  1 : -1;
      }
      // Final tiebreaker: client name asc.
      return (a.name || '').localeCompare(b.name || '');
    };
    return filtered.sort(cmp);
  }, [entities, search, includeProspects, showOnlyGaps, typeFilter, colFilter, sortStack, effectiveFeeEarner, cellStatus, staffMap, groupMap]);

  const handleSaveDraft = useCallback(async ({ entityId, serviceId, feeEarnerId }) => {
    const saved = await upsertAllocationDraft({
      entity_id: entityId,
      canonical_service_id: serviceId,
      proposed_fee_earner_id: feeEarnerId || null,
      proposed_manager_id: null,
      created_by: profile?.id,
    });
    setDrafts((prev) => {
      const others = prev.filter((d) => !(d.entity_id === entityId && d.canonical_service_id === serviceId));
      return [...others, saved];
    });
    setEditing(null);
  }, [profile]);

  const handleDiscardDraft = useCallback(async (draftId) => {
    await discardAllocationDraft(draftId);
    setDrafts((prev) => prev.filter((d) => d.id !== draftId));
  }, []);

  const handleExportReport = useCallback(() => {
    if (!drafts.length) return;
    const serviceLabel = (id) => ALLOCATION_SERVICES.find((s) => s.id === id)?.label || id;
    const entityName = (id) => entities.find((e) => e.id === id)?.name || id;
    const staffName  = (id) => staffMap[id]?.name || '';
    const rows = drafts.map((d) => {
      const k = `${d.entity_id}__${d.canonical_service_id}`;
      const inf = inferredMap.get(k);
      const fromId = inf?.assignee_id || null;
      return {
        Client: entityName(d.entity_id),
        Service: serviceLabel(d.canonical_service_id),
        From: staffName(fromId) || 'unassigned',
        To: staffName(d.proposed_fee_earner_id) || 'unassigned',
        Source: inf ? (inf.via_fallback ? 'BM (fallback)' : 'BM') : 'gap',
        Note: d.note || '',
      };
    });
    rows.sort((a, b) => a.Client.localeCompare(b.Client) || a.Service.localeCompare(b.Service));
    const headers = ['Client', 'Service', 'From', 'To', 'Source', 'Note'];
    const csv = [
      headers.join(','),
      ...rows.map((r) => headers.map((h) => csvCell(r[h])).join(',')),
    ].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `reallocation-report-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  }, [drafts, entities, staffMap, inferredMap]);

  const handleDiscardAll = useCallback(async () => {
    if (!drafts.length) return;
    if (!confirm(`Discard all ${drafts.length} reallocation proposal${drafts.length === 1 ? '' : 's'}?`)) return;
    await Promise.all(drafts.map((d) => discardAllocationDraft(d.id)));
    setDrafts([]);
  }, [drafts]);

  // Cycle a column through: not-sorted → asc (added at end of stack) → desc → removed.
  const toggleSort = useCallback((key) => {
    setSortStack((prev) => {
      const idx = prev.findIndex((s) => s.key === key);
      if (idx === -1) return [...prev, { key, dir: 'asc' }];
      const cur = prev[idx];
      if (cur.dir === 'asc') {
        const next = [...prev]; next[idx] = { key, dir: 'desc' }; return next;
      }
      return prev.filter((s) => s.key !== key);
    });
  }, []);
  const setColumnFilter = useCallback((sid, value) => {
    setColFilter((prev) => ({ ...prev, [sid]: value || undefined }));
  }, []);
  const clearAllColumnFiltersAndSort = useCallback(() => {
    setColFilter({});
    setSortStack([]);
  }, []);

  if (loading) {
    return <div style={{ padding: 24, color: '#94a3b8', fontSize: 14 }}>Loading allocations…</div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', fontFamily: "'Outfit', sans-serif" }}>
      {/* Toolbar */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12, padding: '10px 16px',
        borderBottom: '1px solid #e5e7eb', background: '#f8fafc',
      }}>
        <div style={{ display: 'flex', gap: 4, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 6, padding: 2 }}>
          <button onClick={() => setView('clients')} style={pillStyle(view === 'clients')}>By client</button>
          <button onClick={() => setView('staff')} style={pillStyle(view === 'staff')}>By team member</button>
        </div>

        <input
          type="text"
          placeholder="Search clients…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{
            padding: '5px 10px', fontSize: 12, border: '1px solid #cbd5e1',
            borderRadius: 6, fontFamily: "'Outfit', sans-serif", width: 180,
          }}
        />

        {view === 'clients' && (
          <>
            <select
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value)}
              style={{
                padding: '5px 8px', fontSize: 12, border: '1px solid #cbd5e1',
                borderRadius: 6, fontFamily: "'Outfit', sans-serif", background: '#fff',
              }}
              title="Filter by client type"
            >
              <option value="">All types</option>
              <option value="limited_company">Limited company</option>
              <option value="sole_trader">Sole trader</option>
              <option value="partnership">Partnership</option>
            </select>
            <label style={{ fontSize: 12, color: '#475569', display: 'flex', alignItems: 'center', gap: 6 }}>
              <input type="checkbox" checked={showOnlyGaps} onChange={(e) => setShowOnlyGaps(e.target.checked)} />
              Only gaps
            </label>
            <label style={{ fontSize: 12, color: '#475569', display: 'flex', alignItems: 'center', gap: 6 }}>
              <input type="checkbox" checked={includeProspects} onChange={(e) => setIncludeProspects(e.target.checked)} />
              Include prospects
            </label>
            {(sortStack.length > 0 || Object.values(colFilter).some(Boolean)) && (
              <button onClick={clearAllColumnFiltersAndSort} style={btnStyle('ghost')} title="Reset column filters and sort">Clear filters/sort</button>
            )}
          </>
        )}

        <div style={{ flex: 1 }} />

        {drafts.length > 0 && (
          <>
            <span style={{
              fontSize: 12, color: '#92400e', background: '#fef3c7',
              border: '1px solid #fde68a', padding: '4px 10px', borderRadius: 12,
            }}>
              {drafts.length} reallocation proposal{drafts.length === 1 ? '' : 's'}
            </span>
            <button onClick={handleDiscardAll} style={btnStyle('ghost')}>Discard all</button>
            <button onClick={handleExportReport} style={btnStyle('primary')}>Export report (CSV)</button>
          </>
        )}
      </div>

      {/* Body */}
      <div style={{ flex: 1, overflow: 'auto', padding: 16 }}>
        {view === 'clients' ? (
          <ClientsMatrix
            entities={clientEntities}
            draftMap={draftMap}
            inferredMap={inferredMap}
            staffList={staffList}
            staffMap={staffMap}
            editing={editing}
            setEditing={setEditing}
            onSaveDraft={handleSaveDraft}
            onDiscardDraft={handleDiscardDraft}
            sortStack={sortStack}
            onToggleSort={toggleSort}
            colFilter={colFilter}
            onSetColFilter={setColumnFilter}
            groupMap={groupMap}
            groupFragmentation={groupFragmentation}
            onOpenGroup={(eId) => setGroupModalEntityId(eId)}
          />
        ) : (
          <StaffMatrix
            entities={clientEntities}
            inferred={inferred}
            drafts={drafts}
            staffList={staffList}
          />
        )}
      </div>

      {groupModalEntityId && (
        <GroupReallocateModal
          group={groupMap.get(groupModalEntityId)}
          focalEntityId={groupModalEntityId}
          entitiesById={new Map(entities.map((e) => [e.id, e]))}
          staffList={staffList}
          staffMap={staffMap}
          inferredMap={inferredMap}
          draftMap={draftMap}
          onClose={() => setGroupModalEntityId(null)}
          onSaveDraft={handleSaveDraft}
          onPersonMerged={() => setRefreshTick((n) => n + 1)}
        />
      )}
    </div>
  );
}

// ── Clients matrix ──

function ClientsMatrix({ entities, draftMap, inferredMap, staffList, staffMap, editing, setEditing, onSaveDraft, onDiscardDraft, sortStack, onToggleSort, colFilter, onSetColFilter, groupMap, groupFragmentation, onOpenGroup }) {
  if (!entities.length) {
    return <div style={{ color: '#94a3b8', fontSize: 13 }}>No clients match your filters.</div>;
  }
  const sortedStaff = staffList
    .filter((s) => s.is_active !== false)
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  return (
    <div style={{ display: 'inline-block', minWidth: '100%' }}>
      {/* Header */}
      <div style={{ display: 'flex', position: 'sticky', top: 0, background: '#fff', zIndex: 2 }}>
        <SortableHeader
          width={GROUP_COL_W}
          align="left"
          label="Group"
          sortKey="_group"
          sortStack={sortStack}
          onToggleSort={onToggleSort}
        />
        <SortableHeader
          width={CLIENT_COL_W}
          align="left"
          label="Client"
          sortKey="_client"
          sortStack={sortStack}
          onToggleSort={onToggleSort}
        />
        {ALLOCATION_SERVICES.map((s) => (
          <SortableServiceHeader
            key={s.id}
            service={s}
            sortStack={sortStack}
            onToggleSort={onToggleSort}
            colFilter={colFilter}
            onSetColFilter={onSetColFilter}
            staffList={sortedStaff}
          />
        ))}
      </div>
      {/* Rows */}
      {entities.map((e) => {
        const group = groupMap.get(e.id);
        const frag = groupFragmentation(e.id);
        const fragColour = frag.count <= 1 ? '#22c55e' : frag.count === 2 ? '#f59e0b' : '#ef4444';
        const memberCount = group?.member_entity_ids?.length ?? 1;
        return (
        <div key={e.id} style={{ display: 'flex', borderBottom: '1px solid #f1f5f9' }}>
          <div
            onClick={group ? () => onOpenGroup(e.id) : undefined}
            title={group ? 'Click to open group details / bulk reallocate' : undefined}
            style={{
              width: GROUP_COL_W, minWidth: GROUP_COL_W, padding: '0 10px',
              display: 'flex', alignItems: 'center', gap: 6, height: ROW_H,
              fontSize: 12, color: '#0f172a',
              borderRight: '1px solid #e5e7eb', background: '#fff',
              position: 'sticky', left: 0, zIndex: 1,
              cursor: group ? 'pointer' : 'default',
            }}
          >
            {group ? (
              <>
                <span style={{
                  flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  fontWeight: 500,
                }}>{group.label_person_name}</span>
                <span style={{
                  fontSize: 10, fontWeight: 700,
                  color: '#fff', background: fragColour,
                  borderRadius: 10, padding: '1px 6px', minWidth: 18, textAlign: 'center',
                }}>{frag.count}</span>
              </>
            ) : (
              <span style={{ color: '#cbd5e1', fontStyle: 'italic' }}>—</span>
            )}
          </div>
          <div style={{
            width: CLIENT_COL_W, minWidth: CLIENT_COL_W, padding: '0 10px',
            display: 'flex', alignItems: 'center', height: ROW_H,
            fontSize: 13, color: '#0f172a', fontWeight: 500,
            borderRight: '1px solid #e5e7eb', background: '#fff',
            position: 'sticky', left: GROUP_COL_W, zIndex: 1,
          }}>
            {e.name}
          </div>
          {ALLOCATION_SERVICES.map((s) => {
            const key = `${e.id}__${s.id}`;
            const draft = draftMap.get(key);
            const inf = inferredMap.get(key);
            const isEditing = editing && editing.entityId === e.id && editing.serviceId === s.id;
            return (
              <Cell
                key={s.id}
                entityId={e.id}
                serviceId={s.id}
                draft={draft}
                inferred={inf}
                staffList={staffList}
                staffMap={staffMap}
                isEditing={isEditing}
                onStartEdit={() => setEditing({ entityId: e.id, serviceId: s.id })}
                onCancelEdit={() => setEditing(null)}
                onSaveDraft={onSaveDraft}
                onDiscardDraft={onDiscardDraft}
              />
            );
          })}
        </div>
      );
      })}
    </div>
  );
}

function Cell({ entityId, serviceId, draft, inferred, staffList, staffMap, isEditing, onStartEdit, onCancelEdit, onSaveDraft, onDiscardDraft }) {
  // Resolution: draft > BM-inferred.
  let source; // 'draft' | 'bm' | 'unassigned' | 'na'
  let effFeeEarner = null;
  if (draft) {
    source = 'draft';
    effFeeEarner = draft.proposed_fee_earner_id;
  } else if (inferred) {
    source = inferred.assignee_id ? 'bm' : 'unassigned';
    effFeeEarner = inferred.assignee_id;
  } else {
    source = 'na';
  }
  const isNa = source === 'na';
  const isUnassigned = source === 'unassigned';
  const isBm = source === 'bm';
  const isDraft = source === 'draft';
  const isFallback = isBm && inferred?.via_fallback;

  // BM proposed change shows the BM source assignee crossed out beneath the proposed name.
  const bmAssignee = inferred?.assignee_id || null;
  const proposedDiffersFromBm = isDraft && bmAssignee && bmAssignee !== effFeeEarner;
  const bmName = bmAssignee && staffMap[bmAssignee]?.name;

  const feeEarnerName = effFeeEarner && staffMap[effFeeEarner]?.name;
  const customColour = effFeeEarner && (staffMap[effFeeEarner]?.colour);
  const bg = effFeeEarner ? (customColour || teamColour(effFeeEarner)) : '#fff';

  if (isEditing) {
    return (
      <CellEditor
        entityId={entityId}
        serviceId={serviceId}
        initialFeeEarnerId={effFeeEarner}
        staffList={staffList}
        onCancel={onCancelEdit}
        onSave={onSaveDraft}
      />
    );
  }

  // n/a → service is not active for this client in BM. Soft-styled cell, not clickable for edit.
  if (isNa) {
    return (
      <div
        title="No BM task for this service — not active for this client"
        style={{
          width: SERVICE_COL_W, minWidth: SERVICE_COL_W, height: ROW_H,
          borderRight: '1px solid #f1f5f9',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          padding: '0 8px', background: '#f8fafc',
          color: '#cbd5e1', fontSize: 11, fontStyle: 'italic',
          cursor: 'default', userSelect: 'none',
        }}
      >
        n/a
      </div>
    );
  }

  const tooltip = isDraft
    ? `Reallocation proposal: ${bmName || 'unassigned'} → ${feeEarnerName || 'unassigned'}`
    : isBm
      ? `BM-inferred${isFallback ? ' (fallback from submitter)' : ''}: ${feeEarnerName}`
      : isUnassigned
        ? 'BM task exists but no assignee'
        : (feeEarnerName || 'No assignment');

  return (
    <div
      onClick={onStartEdit}
      title={tooltip}
      style={{
        width: SERVICE_COL_W, minWidth: SERVICE_COL_W, height: ROW_H,
        borderRight: '1px solid #f1f5f9', cursor: 'pointer',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '0 8px', position: 'relative',
        background: isUnassigned ? '#fff' : bg,
        color: isUnassigned ? '#94a3b8' : '#fff',
        opacity: isBm ? 0.78 : 1,
        outline: isUnassigned ? '2px dashed #fca5a5' : 'none',
        outlineOffset: isUnassigned ? -3 : 0,
        boxShadow: isDraft ? 'inset 0 0 0 2px #f59e0b' : 'none',
      }}
    >
      <span style={{
        fontSize: 12, fontWeight: 600, overflow: 'hidden',
        textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        fontStyle: isBm ? 'italic' : 'normal',
        display: 'flex', flexDirection: 'column', minWidth: 0,
      }}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {feeEarnerName || 'unassigned'}
        </span>
        {proposedDiffersFromBm && (
          <span style={{
            fontSize: 9, fontWeight: 500, fontStyle: 'italic',
            textDecoration: 'line-through', opacity: 0.7,
          }}>
            was: {bmName}
          </span>
        )}
      </span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        {isBm && !isFallback && (
          <span title="BM-inferred" style={{
            fontSize: 8, fontWeight: 700, letterSpacing: 0.4,
            background: 'rgba(255,255,255,0.25)', color: '#fff',
            borderRadius: 3, padding: '1px 3px',
          }}>BM</span>
        )}
        {isBm && isFallback && (
          <span title="Fallback: same as submitter" style={{
            fontSize: 8, fontWeight: 700, letterSpacing: 0.4,
            background: 'rgba(255,255,255,0.25)', color: '#fff',
            borderRadius: 3, padding: '1px 3px',
          }}>BM*</span>
        )}
        {isDraft && (
          <button
            onClick={(e) => { e.stopPropagation(); onDiscardDraft(draft.id); }}
            title="Discard reallocation proposal"
            style={{
              border: 'none', background: '#f59e0b', color: '#fff',
              borderRadius: 3, padding: '0 4px', fontSize: 10, cursor: 'pointer',
              fontFamily: "'Outfit', sans-serif",
            }}
          >×</button>
        )}
      </div>
    </div>
  );
}

function CellEditor({ entityId, serviceId, initialFeeEarnerId, staffList, onCancel, onSave }) {
  const [feeEarnerId, setFeeEarnerId] = useState(initialFeeEarnerId || '');

  return (
    <div style={{
      width: SERVICE_COL_W, minWidth: SERVICE_COL_W, height: ROW_H,
      display: 'flex', alignItems: 'center', gap: 4, padding: '0 4px',
      background: '#fef3c7', borderRight: '1px solid #f1f5f9',
    }}>
      <select
        value={feeEarnerId}
        autoFocus
        onChange={(e) => setFeeEarnerId(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onSave({ entityId, serviceId, feeEarnerId });
          else if (e.key === 'Escape') onCancel();
        }}
        style={{ flex: 1, fontSize: 11, padding: '2px 4px', border: '1px solid #cbd5e1', borderRadius: 4, fontFamily: "'Outfit', sans-serif" }}
      >
        <option value="">— fee earner —</option>
        {staffList.filter((s) => s.is_active !== false).map((s) => (
          <option key={s.id} value={s.id}>{s.name}</option>
        ))}
      </select>
      <button
        onClick={() => onSave({ entityId, serviceId, feeEarnerId })}
        title="Save as reallocation proposal"
        style={{ border: 'none', background: '#0f172a', color: '#fff', borderRadius: 3, padding: '2px 6px', fontSize: 10, cursor: 'pointer', fontFamily: "'Outfit', sans-serif" }}
      >✓</button>
      <button
        onClick={onCancel}
        style={{ border: '1px solid #cbd5e1', background: '#fff', color: '#64748b', borderRadius: 3, padding: '2px 5px', fontSize: 10, cursor: 'pointer', fontFamily: "'Outfit', sans-serif" }}
      >×</button>
    </div>
  );
}

// ── Staff matrix (workload per service per person) ──

function StaffMatrix({ entities, inferred, drafts, staffList }) {
  // Effective allocations: inferred (BM) is the base, drafts overlay on top.
  // Inferred entries with null assignee_id still mark "applicable" — counted as unassigned, not n/a.
  const effective = useMemo(() => {
    const map = new Map();
    inferred.forEach((i) => map.set(`${i.entity_id}__${i.canonical_service_id}`, i.assignee_id ?? '_unassigned'));
    drafts.forEach((d) => map.set(`${d.entity_id}__${d.canonical_service_id}`, d.proposed_fee_earner_id ?? '_unassigned'));
    return map;
  }, [inferred, drafts]);

  const rows = useMemo(() => {
    const entityIds = new Set(entities.map((e) => e.id));
    const counts = {}; // staffId -> { serviceId: count }
    staffList.forEach((s) => { counts[s.id] = {}; ALLOCATION_SERVICES.forEach((sv) => { counts[s.id][sv.id] = 0; }); });
    counts['_unassigned'] = {};
    ALLOCATION_SERVICES.forEach((sv) => { counts['_unassigned'][sv.id] = 0; });

    entityIds.forEach((eId) => {
      ALLOCATION_SERVICES.forEach((sv) => {
        // Skip cells where the service isn't in BM at all (n/a).
        if (!effective.has(`${eId}__${sv.id}`)) return;
        const feeEarnerId = effective.get(`${eId}__${sv.id}`);
        if (counts[feeEarnerId]) counts[feeEarnerId][sv.id] = (counts[feeEarnerId][sv.id] || 0) + 1;
      });
    });
    return counts;
  }, [entities, effective, staffList]);

  const orderedStaff = staffList.filter((s) => s.is_active !== false).sort((a, b) => (a.name || '').localeCompare(b.name || ''));

  return (
    <div style={{ display: 'inline-block', minWidth: '100%' }}>
      <div style={{ display: 'flex' }}>
        <div style={headerCellStyle(CLIENT_COL_W, 'left')}>Team member</div>
        {ALLOCATION_SERVICES.map((s) => (
          <div key={s.id} style={headerCellStyle(SERVICE_COL_W)}>{s.label}</div>
        ))}
        <div style={headerCellStyle(120)}>Total</div>
      </div>
      {orderedStaff.map((s) => {
        const c = rows[s.id] || {};
        const total = ALLOCATION_SERVICES.reduce((acc, sv) => acc + (c[sv.id] || 0), 0);
        const bg = s.colour || teamColour(s.id);
        return (
          <div key={s.id} style={{ display: 'flex', borderBottom: '1px solid #f1f5f9' }}>
            <div style={{
              width: CLIENT_COL_W, minWidth: CLIENT_COL_W, height: ROW_H,
              padding: '0 10px', display: 'flex', alignItems: 'center', gap: 8,
              fontSize: 13, color: '#0f172a', fontWeight: 500,
              borderRight: '1px solid #e5e7eb',
            }}>
              <span style={{
                width: 10, height: 10, borderRadius: '50%', background: bg, display: 'inline-block',
              }} />
              {s.name}
            </div>
            {ALLOCATION_SERVICES.map((sv) => (
              <div key={sv.id} style={{
                width: SERVICE_COL_W, minWidth: SERVICE_COL_W, height: ROW_H,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 13, color: c[sv.id] ? '#0f172a' : '#cbd5e1',
                borderRight: '1px solid #f1f5f9',
              }}>
                {c[sv.id] || 0}
              </div>
            ))}
            <div style={{
              width: 120, minWidth: 120, height: ROW_H,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 13, fontWeight: 600, color: '#0f172a',
            }}>{total}</div>
          </div>
        );
      })}
      {/* Unassigned row */}
      {(() => {
        const c = rows['_unassigned'] || {};
        const total = ALLOCATION_SERVICES.reduce((acc, sv) => acc + (c[sv.id] || 0), 0);
        if (total === 0) return null;
        return (
          <div style={{ display: 'flex', borderTop: '2px solid #fca5a5', background: '#fef2f2' }}>
            <div style={{
              width: CLIENT_COL_W, minWidth: CLIENT_COL_W, height: ROW_H,
              padding: '0 10px', display: 'flex', alignItems: 'center',
              fontSize: 13, color: '#b91c1c', fontWeight: 600,
            }}>Unassigned</div>
            {ALLOCATION_SERVICES.map((sv) => (
              <div key={sv.id} style={{
                width: SERVICE_COL_W, minWidth: SERVICE_COL_W, height: ROW_H,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 13, color: '#b91c1c',
              }}>
                {c[sv.id] || 0}
              </div>
            ))}
            <div style={{
              width: 120, minWidth: 120, height: ROW_H,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 13, fontWeight: 700, color: '#b91c1c',
            }}>{total}</div>
          </div>
        );
      })()}
    </div>
  );
}

// ── Style helpers ──

function headerCellStyle(width, align = 'center') {
  return {
    width, minWidth: width, height: 32,
    display: 'flex', alignItems: 'center', justifyContent: align === 'left' ? 'flex-start' : 'center',
    padding: '0 10px', fontSize: 11, fontWeight: 600,
    color: '#64748b', textTransform: 'uppercase', letterSpacing: 0.5,
    borderBottom: '1px solid #e5e7eb', background: '#f8fafc',
  };
}

function sortIndicator(sortStack, key) {
  const idx = sortStack.findIndex((s) => s.key === key);
  if (idx === -1) return null;
  const { dir } = sortStack[idx];
  return (
    <span title={`Sort priority ${idx + 1} (${dir})`} style={{
      fontSize: 9, fontWeight: 700, marginLeft: 4,
      background: '#0f172a', color: '#fff', borderRadius: 3, padding: '1px 4px',
    }}>
      {idx + 1}{dir === 'asc' ? ' ↑' : ' ↓'}
    </span>
  );
}

function SortableHeader({ width, align = 'center', label, sortKey, sortStack, onToggleSort }) {
  return (
    <div
      onClick={() => onToggleSort(sortKey)}
      title="Click to toggle sort (asc → desc → off)"
      style={{
        ...headerCellStyle(width, align),
        height: 60, cursor: 'pointer', userSelect: 'none',
      }}
    >
      <span>{label}</span>
      {sortIndicator(sortStack, sortKey)}
    </div>
  );
}

function SortableServiceHeader({ service, sortStack, onToggleSort, colFilter, onSetColFilter, staffList }) {
  const filterValue = colFilter[service.id] || '';
  return (
    <div style={{
      width: SERVICE_COL_W, minWidth: SERVICE_COL_W, height: 60,
      display: 'flex', flexDirection: 'column', alignItems: 'stretch',
      borderBottom: '1px solid #e5e7eb', background: '#f8fafc',
    }}>
      <div
        onClick={() => onToggleSort(service.id)}
        title="Click to toggle sort (asc → desc → off)"
        style={{
          flex: 1,
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4,
          padding: '0 6px', fontSize: 11, fontWeight: 600,
          color: '#64748b', textTransform: 'uppercase', letterSpacing: 0.5,
          cursor: 'pointer', userSelect: 'none',
        }}
      >
        <span>{service.label}</span>
        {sortIndicator(sortStack, service.id)}
      </div>
      <select
        value={filterValue}
        onChange={(e) => onSetColFilter(service.id, e.target.value)}
        onClick={(e) => e.stopPropagation()}
        title={`Filter ${service.label} by fee earner`}
        style={{
          margin: '0 6px 4px', padding: '2px 4px',
          fontSize: 11, fontFamily: "'Outfit', sans-serif",
          border: '1px solid #cbd5e1', borderRadius: 4,
          background: filterValue ? '#fef3c7' : '#fff',
        }}
      >
        <option value="">All</option>
        <option value="__unassigned">— Unassigned —</option>
        <option value="__na">— n/a —</option>
        {staffList.map((s) => (
          <option key={s.id} value={s.id}>{s.name}</option>
        ))}
      </select>
    </div>
  );
}

function csvCell(v) {
  const s = String(v ?? '');
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function pillStyle(active) {
  return {
    padding: '4px 10px', fontSize: 12, fontWeight: 500,
    border: 'none', borderRadius: 4,
    background: active ? '#0f172a' : 'transparent',
    color: active ? '#fff' : '#64748b',
    cursor: 'pointer', fontFamily: "'Outfit', sans-serif",
  };
}

function btnStyle(variant) {
  if (variant === 'primary') {
    return {
      padding: '5px 12px', fontSize: 12, fontWeight: 500,
      border: '1px solid #0f172a', borderRadius: 6,
      background: '#0f172a', color: '#fff', cursor: 'pointer',
      fontFamily: "'Outfit', sans-serif",
    };
  }
  return {
    padding: '5px 12px', fontSize: 12, fontWeight: 500,
    border: '1px solid #cbd5e1', borderRadius: 6,
    background: '#fff', color: '#64748b', cursor: 'pointer',
    fontFamily: "'Outfit', sans-serif",
  };
}
