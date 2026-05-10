import React from 'react';
import { colors, fontStack } from './ui';

/**
 * Location/group filter dropdown. Single-select.
 *
 * value shape: { kind: 'all' } | { kind: 'group', id } | { kind: 'entity', id }
 */
export default function LocationFilter({ entities, groups, assignments, value, onChange }) {
  const cur = value || { kind: 'all' };
  const handle = (e) => {
    const v = e.target.value;
    if (v === 'all') onChange({ kind: 'all' });
    else if (v.startsWith('group:')) onChange({ kind: 'group', id: v.slice(6) });
    else if (v.startsWith('entity:')) onChange({ kind: 'entity', id: v.slice(7) });
  };
  const sel = cur.kind === 'all' ? 'all'
    : cur.kind === 'group' ? `group:${cur.id}`
    : `entity:${cur.id}`;

  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span style={{ fontSize: 11, color: colors.muted, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.4 }}>Scope</span>
      <select value={sel} onChange={handle} style={{
        padding: '7px 10px', borderRadius: 8, border: `1px solid ${colors.border}`,
        fontSize: 12, fontFamily: fontStack, background: '#fff', minWidth: 200,
      }}>
        <option value="all">All locations</option>
        {groups.length > 0 && <option disabled>──── Groups ────</option>}
        {groups.map(g => {
          const n = assignments.filter(a => a.dimension_value_id === g.id).length;
          return <option key={g.id} value={`group:${g.id}`}>Group: {g.label} ({n})</option>;
        })}
        {entities.length > 0 && <option disabled>──── Locations ────</option>}
        {entities.map(e => <option key={e.id} value={`entity:${e.id}`}>{e.label}</option>)}
      </select>
    </div>
  );
}

/**
 * Resolve a filter value to a Set<entity_id> (or null = all).
 */
export function resolveFilterToEntityIds(value, entities, assignments) {
  if (!value || value.kind === 'all') return null;
  if (value.kind === 'entity') return new Set([value.id]);
  if (value.kind === 'group') {
    const ids = assignments.filter(a => a.dimension_value_id === value.id).map(a => a.entity_id);
    return new Set(ids);
  }
  return null;
}

/**
 * Human label for the active filter (used in headers / drill modal titles).
 */
export function filterLabel(value, entities, groups) {
  if (!value || value.kind === 'all') return 'All locations';
  if (value.kind === 'entity') return entities.find(e => e.id === value.id)?.label || 'Location';
  if (value.kind === 'group') {
    const g = groups.find(g => g.id === value.id);
    return g ? `Group: ${g.label}` : 'Group';
  }
  return '';
}
