import React, { useEffect, useState } from 'react';
import { callJobPlan } from '../plan/planQueries';

// Which director a personal item on a company's records request is for
// (sql/351). Each tagged item becomes an "other income" line on that
// director's next self assessment, and the return waits until it's ticked
// received. Shown only for the "personal" group and only when the company has
// directors who are clients in their own right.

export function useDirectors(entityId) {
  const [directors, setDirectors] = useState([]);
  useEffect(() => {
    if (!entityId) { setDirectors([]); return undefined; }
    let cancelled = false;
    callJobPlan({ action: 'company_directors', entity_id: entityId })
      .then((r) => { if (!cancelled) setDirectors((r.directors || []).filter((d) => d.period_end)); })
      .catch(() => { if (!cancelled) setDirectors([]); });
    return () => { cancelled = true; };
  }, [entityId]);
  return directors;
}

/** The picker's ticks, with `for` on personal items (default: every director). */
export function pickedWithDirectors(picker, directors) {
  const all = directors.map((d) => d.entity_id);
  return (picker || []).filter((i) => i.ticked).map((i) => {
    const base = i.key ? { key: i.key } : { text: i.label };
    if (i.grp !== 'personal' || !all.length) return base;
    const forIds = Array.isArray(i.for) ? i.for : all;
    return forIds.length ? { ...base, for: forIds } : base;
  });
}

export default function DirectorTags({ item, directors, onChange }) {
  if (item.grp !== 'personal' || !item.ticked || !directors.length) return null;
  const chosen = Array.isArray(item.for) ? item.for : directors.map((d) => d.entity_id);
  const toggle = (id) => onChange(chosen.includes(id) ? chosen.filter((x) => x !== id) : [...chosen, id]);
  return (
    <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap', marginLeft: 22, marginTop: 2 }}>
      <span style={{ fontSize: 11, color: '#94a3b8' }}>for</span>
      {directors.map((d) => {
        const on = chosen.includes(d.entity_id);
        return (
          <button key={d.entity_id} type="button" onClick={(e) => { e.preventDefault(); toggle(d.entity_id); }}
            title={on ? 'Goes on this director\'s self assessment as outstanding other income' : 'Not for this director'}
            style={{ fontSize: 11, padding: '0 7px', borderRadius: 10, cursor: 'pointer', lineHeight: '18px', fontFamily: 'inherit', border: `1px solid ${on ? '#0e7fe0' : '#cbd5e1'}`, background: on ? '#dbeafe' : '#fff', color: on ? '#0e7fe0' : '#94a3b8' }}>
            {String(d.name || '').split(' ')[0]}
          </button>
        );
      })}
    </span>
  );
}
