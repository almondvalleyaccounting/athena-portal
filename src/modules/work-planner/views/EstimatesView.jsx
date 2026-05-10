import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useWorkPlanner } from '../WorkPlannerModule';
import { useAuth } from '../../../shell/AppShell';
import {
  ALLOCATION_SERVICES,
  fetchAllocationEntities, fetchInferredAllocations,
  fetchEffortDefaults, fetchEffortOverrides,
  upsertEffortOverride, deleteEffortOverride,
  fetchServiceCadence,
} from '../lib/allocationsQueries';

const SERVICE_COL_W = 200;
const CLIENT_COL_W = 240;
const ROW_H = 36;

const CADENCE_LABEL = { monthly: 'mo', quarterly: 'qtr', annual: 'yr' };

export default function EstimatesView() {
  const { profile } = useAuth();

  const [entities, setEntities] = useState([]);
  const [inferred, setInferred] = useState([]);
  const [defaults, setDefaults] = useState([]);
  const [overrides, setOverrides] = useState([]);
  const [cadence, setCadence] = useState([]);

  const [editing, setEditing] = useState(null); // { entityId, serviceId }
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [includeProspects, setIncludeProspects] = useState(false);
  const [colFilter, setColFilter] = useState({});
  const [sortStack, setSortStack] = useState([]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [e, inf, dfs, ovs, cad] = await Promise.all([
          fetchAllocationEntities(),
          fetchInferredAllocations(),
          fetchEffortDefaults(),
          fetchEffortOverrides(),
          fetchServiceCadence(),
        ]);
        if (!cancelled) {
          setEntities(e);
          setInferred(inf);
          setDefaults(dfs);
          setOverrides(ovs);
          setCadence(cad);
        }
      } catch (err) {
        console.error('[Estimates] load failed:', err);
      }
      if (!cancelled) setLoading(false);
    }
    load();
    return () => { cancelled = true; };
  }, []);

  // Lookups
  const inferredMap = useMemo(() => {
    const m = new Map();
    inferred.forEach((i) => m.set(`${i.entity_id}__${i.canonical_service_id}`, i));
    return m;
  }, [inferred]);

  const overrideMap = useMemo(() => {
    const m = new Map();
    overrides.forEach((o) => m.set(`${o.entity_id}__${o.canonical_service_id}`, o.minutes_per_job));
    return m;
  }, [overrides]);

  const cadenceMap = useMemo(() => {
    const m = new Map();
    cadence.forEach((c) => m.set(`${c.entity_id}__${c.canonical_service_id}`, c.cadence));
    return m;
  }, [cadence]);

  // defaults keyed by `${service}__${cadence}`
  const defaultMap = useMemo(() => {
    const m = new Map();
    defaults.forEach((d) => m.set(`${d.canonical_service_id}__${d.cadence}`, d.minutes_per_job));
    return m;
  }, [defaults]);

  // Resolves the cadence used for a cell, falling back to a sensible default.
  const cadenceFor = useCallback((entityId, serviceId) => {
    const explicit = cadenceMap.get(`${entityId}__${serviceId}`);
    if (explicit) return explicit;
    if (serviceId === 'accounts_preparation' || serviceId === 'accounts_submission' || serviceId === 'self_assessment') return 'annual';
    if (serviceId === 'bookkeeping') return 'quarterly';
    if (serviceId === 'vat_review') return 'quarterly';
    return null;
  }, [cadenceMap]);

  // Effective minutes-per-job for a cell. Returns null when service is n/a
  // (no BM task at all for this client+service).
  const minutesFor = useCallback((entityId, serviceId) => {
    const inf = inferredMap.get(`${entityId}__${serviceId}`);
    if (!inf) return { minutes: null, status: 'na' };
    const ov = overrideMap.get(`${entityId}__${serviceId}`);
    const cad = cadenceFor(entityId, serviceId);
    const def = defaultMap.get(`${serviceId}__${cad}`) ?? null;
    return {
      minutes: ov ?? def,
      status: ov != null ? 'override' : 'default',
      cadence: cad,
    };
  }, [inferredMap, overrideMap, cadenceFor, defaultMap]);

  // Sort + filter
  const clientEntities = useMemo(() => {
    const term = search.trim().toLowerCase();
    const filtered = entities
      .filter((e) => includeProspects ? true : e.entity_status !== 'prospect')
      .filter((e) => !typeFilter || e.type === typeFilter)
      .filter((e) => !term || (e.name || '').toLowerCase().includes(term))
      .filter((e) => {
        for (const sv of ALLOCATION_SERVICES) {
          const want = colFilter[sv.id];
          if (!want) continue;
          const { status, minutes } = minutesFor(e.id, sv.id);
          if (want === '__na') {
            if (status !== 'na') return false;
          } else if (want === '__override') {
            if (status !== 'override') return false;
          } else if (want === '__default') {
            if (status !== 'default') return false;
          }
          // Numeric thresholds: '__lt:N' '__gt:N'
          else if (want.startsWith('__gt:')) {
            const n = Number(want.slice(5));
            if (minutes == null || minutes <= n) return false;
          } else if (want.startsWith('__lt:')) {
            const n = Number(want.slice(5));
            if (minutes == null || minutes >= n) return false;
          }
        }
        return true;
      });

    const sortKey = (e, key) => {
      if (key === '_client') return (e.name || '').toLowerCase();
      const { minutes } = minutesFor(e.id, key);
      if (minutes == null) return { _empty: true, val: 0 };
      return { _empty: false, val: minutes };
    };
    const cmp = (a, b) => {
      for (const { key, dir } of sortStack) {
        const av = sortKey(a, key);
        const bv = sortKey(b, key);
        const aEmpty = typeof av === 'object' ? av._empty : false;
        const bEmpty = typeof bv === 'object' ? bv._empty : false;
        if (aEmpty !== bEmpty) return aEmpty ? 1 : -1;
        const aVal = typeof av === 'object' ? av.val : av;
        const bVal = typeof bv === 'object' ? bv.val : bv;
        if (aVal < bVal) return dir === 'asc' ? -1 : 1;
        if (aVal > bVal) return dir === 'asc' ?  1 : -1;
      }
      return (a.name || '').localeCompare(b.name || '');
    };
    return filtered.sort(cmp);
  }, [entities, search, includeProspects, typeFilter, colFilter, sortStack, minutesFor]);

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

  const clearFiltersAndSort = useCallback(() => {
    setColFilter({});
    setSortStack([]);
  }, []);

  const handleSave = useCallback(async (entityId, serviceId, minutesStr) => {
    const trimmed = String(minutesStr ?? '').trim();
    // Empty input → revert to default by deleting the override.
    if (!trimmed) {
      await deleteEffortOverride({ entity_id: entityId, canonical_service_id: serviceId });
      setOverrides((prev) => prev.filter((o) => !(o.entity_id === entityId && o.canonical_service_id === serviceId)));
      setEditing(null);
      return;
    }
    const n = Number(trimmed);
    if (!Number.isFinite(n) || n < 0) {
      alert('Enter a positive number of minutes (or blank to revert to default).');
      return;
    }
    const saved = await upsertEffortOverride({
      entity_id: entityId,
      canonical_service_id: serviceId,
      minutes_per_job: Math.round(n),
      updated_by: profile?.id,
    });
    setOverrides((prev) => {
      const others = prev.filter((o) => !(o.entity_id === entityId && o.canonical_service_id === serviceId));
      return [...others, saved];
    });
    setEditing(null);
  }, [profile]);

  // Total annualised minutes per cell (minutes_per_job × jobs/yr) — used for column total + roll-up
  const annualMinutes = useCallback((entityId, serviceId) => {
    const { minutes, cadence } = minutesFor(entityId, serviceId);
    if (minutes == null) return 0;
    const factor = cadence === 'monthly' ? 12 : cadence === 'quarterly' ? 4 : 1;
    return minutes * factor;
  }, [minutesFor]);

  if (loading) {
    return <div style={{ padding: 24, color: '#94a3b8', fontSize: 14 }}>Loading estimates…</div>;
  }

  const overrideCount = overrides.length;
  const totalAnnualMins = clientEntities.reduce((acc, e) => acc + ALLOCATION_SERVICES.reduce((a, s) => a + annualMinutes(e.id, s.id), 0), 0);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', fontFamily: "'Outfit', sans-serif" }}>
      {/* Toolbar */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12, padding: '10px 16px',
        borderBottom: '1px solid #e5e7eb', background: '#f8fafc', flexWrap: 'wrap',
      }}>
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
        <select
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
          style={{
            padding: '5px 8px', fontSize: 12, border: '1px solid #cbd5e1',
            borderRadius: 6, fontFamily: "'Outfit', sans-serif", background: '#fff',
          }}
        >
          <option value="">All types</option>
          <option value="limited_company">Limited company</option>
          <option value="sole_trader">Sole trader</option>
          <option value="partnership">Partnership</option>
        </select>
        <label style={{ fontSize: 12, color: '#475569', display: 'flex', alignItems: 'center', gap: 6 }}>
          <input type="checkbox" checked={includeProspects} onChange={(e) => setIncludeProspects(e.target.checked)} />
          Include prospects
        </label>
        {(sortStack.length > 0 || Object.values(colFilter).some(Boolean)) && (
          <button onClick={clearFiltersAndSort} style={btnStyle('ghost')}>Clear filters/sort</button>
        )}
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 12, color: '#475569' }}>
          {clientEntities.length} client{clientEntities.length === 1 ? '' : 's'} · {Math.round(totalAnnualMins / 60)}h estimated/yr
        </span>
        {overrideCount > 0 && (
          <span style={{
            fontSize: 12, color: '#92400e', background: '#fef3c7',
            border: '1px solid #fde68a', padding: '4px 10px', borderRadius: 12,
          }}>
            {overrideCount} override{overrideCount === 1 ? '' : 's'}
          </span>
        )}
      </div>

      {/* Body */}
      <div style={{ flex: 1, overflow: 'auto', padding: 16 }}>
        <div style={{ display: 'inline-block', minWidth: '100%' }}>
          {/* Header */}
          <div style={{ display: 'flex', position: 'sticky', top: 0, background: '#fff', zIndex: 2 }}>
            <SortableHeader
              width={CLIENT_COL_W}
              align="left"
              label="Client"
              sortKey="_client"
              sortStack={sortStack}
              onToggleSort={toggleSort}
            />
            {ALLOCATION_SERVICES.map((s) => (
              <SortableServiceHeader
                key={s.id}
                service={s}
                sortStack={sortStack}
                onToggleSort={toggleSort}
                colFilter={colFilter}
                onSetColFilter={setColumnFilter}
              />
            ))}
            <div style={headerCellStyle(120)}>Annual mins</div>
          </div>

          {clientEntities.length === 0 ? (
            <div style={{ padding: 16, color: '#94a3b8', fontSize: 13 }}>No clients match your filters.</div>
          ) : clientEntities.map((e) => {
            const rowTotal = ALLOCATION_SERVICES.reduce((acc, sv) => acc + annualMinutes(e.id, sv.id), 0);
            return (
              <div key={e.id} style={{ display: 'flex', borderBottom: '1px solid #f1f5f9' }}>
                <div style={{
                  width: CLIENT_COL_W, minWidth: CLIENT_COL_W, padding: '0 10px',
                  display: 'flex', alignItems: 'center', height: ROW_H,
                  fontSize: 13, color: '#0f172a', fontWeight: 500,
                  borderRight: '1px solid #e5e7eb', background: '#fff',
                  position: 'sticky', left: 0, zIndex: 1,
                }}>
                  {e.name}
                </div>
                {ALLOCATION_SERVICES.map((s) => {
                  const isEditing = editing && editing.entityId === e.id && editing.serviceId === s.id;
                  return (
                    <Cell
                      key={s.id}
                      entityId={e.id}
                      serviceId={s.id}
                      info={minutesFor(e.id, s.id)}
                      isEditing={isEditing}
                      onStartEdit={() => setEditing({ entityId: e.id, serviceId: s.id })}
                      onCancelEdit={() => setEditing(null)}
                      onSave={handleSave}
                    />
                  );
                })}
                <div style={{
                  width: 120, minWidth: 120, height: ROW_H,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 12, color: '#0f172a', fontWeight: 600,
                  borderLeft: '1px solid #e5e7eb',
                }}>
                  {rowTotal > 0 ? `${rowTotal} (${(rowTotal / 60).toFixed(1)}h)` : '—'}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ── Cell ──

function Cell({ entityId, serviceId, info, isEditing, onStartEdit, onCancelEdit, onSave }) {
  const { minutes, status, cadence } = info;
  const isNa = status === 'na';
  const isOverride = status === 'override';

  if (isEditing) {
    return (
      <CellEditor
        entityId={entityId}
        serviceId={serviceId}
        initial={minutes ?? ''}
        cadence={cadence}
        onCancel={onCancelEdit}
        onSave={onSave}
      />
    );
  }

  if (isNa) {
    return (
      <div
        title="No BM task — service not active for this client"
        style={{
          width: SERVICE_COL_W, minWidth: SERVICE_COL_W, height: ROW_H,
          borderRight: '1px solid #f1f5f9', background: '#f8fafc',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: '#cbd5e1', fontSize: 11, fontStyle: 'italic',
          cursor: 'default', userSelect: 'none',
        }}
      >
        n/a
      </div>
    );
  }

  return (
    <div
      onClick={onStartEdit}
      title={`${minutes} min/job · ${cadence}${isOverride ? ' (override)' : ' (default)'}`}
      style={{
        width: SERVICE_COL_W, minWidth: SERVICE_COL_W, height: ROW_H,
        borderRight: '1px solid #f1f5f9', cursor: 'pointer',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '0 10px',
        background: isOverride ? '#fef3c7' : '#fff',
        boxShadow: isOverride ? 'inset 0 0 0 2px #f59e0b' : 'none',
        color: '#0f172a',
      }}
    >
      <span style={{
        fontSize: 13, fontWeight: 600,
        fontStyle: isOverride ? 'normal' : 'italic',
        opacity: isOverride ? 1 : 0.78,
      }}>
        {minutes} <span style={{ fontSize: 10, fontWeight: 400, color: '#64748b' }}>min</span>
      </span>
      <span style={{
        fontSize: 9, fontWeight: 600, color: '#94a3b8',
        textTransform: 'uppercase', letterSpacing: 0.5,
      }}>
        / {CADENCE_LABEL[cadence] || cadence}
      </span>
    </div>
  );
}

function CellEditor({ entityId, serviceId, initial, cadence, onCancel, onSave }) {
  const [val, setVal] = useState(String(initial ?? ''));
  return (
    <div style={{
      width: SERVICE_COL_W, minWidth: SERVICE_COL_W, height: ROW_H,
      display: 'flex', alignItems: 'center', gap: 4, padding: '0 6px',
      background: '#fef3c7', borderRight: '1px solid #f1f5f9',
    }}>
      <input
        type="number"
        value={val}
        autoFocus
        onChange={(e) => setVal(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onSave(entityId, serviceId, val);
          else if (e.key === 'Escape') onCancel();
        }}
        placeholder="blank = default"
        style={{
          flex: 1, fontSize: 12, padding: '2px 6px',
          border: '1px solid #cbd5e1', borderRadius: 4,
          fontFamily: "'Outfit', sans-serif",
        }}
      />
      <span style={{ fontSize: 9, color: '#64748b' }}>/ {CADENCE_LABEL[cadence] || cadence}</span>
      <button
        onClick={() => onSave(entityId, serviceId, val)}
        style={{ border: 'none', background: '#0f172a', color: '#fff', borderRadius: 3, padding: '2px 6px', fontSize: 10, cursor: 'pointer', fontFamily: "'Outfit', sans-serif" }}
        title="Save (Enter)"
      >✓</button>
      <button
        onClick={onCancel}
        style={{ border: '1px solid #cbd5e1', background: '#fff', color: '#64748b', borderRadius: 3, padding: '2px 5px', fontSize: 10, cursor: 'pointer', fontFamily: "'Outfit', sans-serif" }}
        title="Cancel (Esc)"
      >×</button>
    </div>
  );
}

// ── Header components ──

function headerCellStyle(width, align = 'center') {
  return {
    width, minWidth: width, height: 60,
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
      style={{ ...headerCellStyle(width, align), cursor: 'pointer', userSelect: 'none' }}
    >
      <span>{label}</span>
      {sortIndicator(sortStack, sortKey)}
    </div>
  );
}

function SortableServiceHeader({ service, sortStack, onToggleSort, colFilter, onSetColFilter }) {
  const filterValue = colFilter[service.id] || '';
  return (
    <div style={{
      width: SERVICE_COL_W, minWidth: SERVICE_COL_W, height: 60,
      display: 'flex', flexDirection: 'column',
      borderBottom: '1px solid #e5e7eb', background: '#f8fafc',
    }}>
      <div
        onClick={() => onToggleSort(service.id)}
        title="Click to toggle sort"
        style={{
          flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4,
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
        title={`Filter ${service.label}`}
        style={{
          margin: '0 6px 4px', padding: '2px 4px', fontSize: 11,
          fontFamily: "'Outfit', sans-serif", border: '1px solid #cbd5e1',
          borderRadius: 4, background: filterValue ? '#fef3c7' : '#fff',
        }}
      >
        <option value="">All</option>
        <option value="__override">— Overrides —</option>
        <option value="__default">— Defaults —</option>
        <option value="__na">— n/a —</option>
      </select>
    </div>
  );
}

// ── Style helpers ──

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
