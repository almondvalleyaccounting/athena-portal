import React, { useMemo, useState } from 'react';
import { FONT, Select } from './ui';
import {
  upsertStaffCategoryOverride, deleteStaffCategoryOverride,
  loadStaffCategoryOverrides, LEVEL_LABELS,
} from '../lib/api';

// Per-person augmentation of an assigned role profile:
//   - hide / re-include a role category
//   - override a category's target
//   - add an extra category (not in the role)
// Writes to pd_staff_category_overrides; effectiveRoleCategories() applies them.
export default function CustomiseTargets({ staffId, roleCategories, overrides, allCategories, canEdit, onChanged }) {
  const [addCat, setAddCat] = useState('');
  const [addTgt, setAddTgt] = useState(3);

  const ovByCat = useMemo(() => {
    const m = {};
    (overrides || []).forEach((o) => { m[o.category] = o; });
    return m;
  }, [overrides]);

  const baseCats = useMemo(() => roleCategories.map((c) => c.category), [roleCategories]);
  const extraOverrides = useMemo(
    () => (overrides || []).filter((o) => !baseCats.includes(o.category) && o.included !== false),
    [overrides, baseCats],
  );
  const usedCats = new Set([...baseCats, ...extraOverrides.map((o) => o.category)]);
  const availableCats = allCategories.filter((c) => !usedCats.has(c));

  async function refresh() {
    try { onChanged(await loadStaffCategoryOverrides(staffId)); } catch (e) { console.error(e); }
  }

  async function setInclude(category, included) {
    await upsertStaffCategoryOverride({ staff_id: staffId, category, included });
    refresh();
  }
  async function setTarget(category, target_level) {
    await upsertStaffCategoryOverride({ staff_id: staffId, category, target_level: Number(target_level), included: true });
    refresh();
  }
  async function reset(category) {
    await deleteStaffCategoryOverride(staffId, category);
    refresh();
  }
  async function addExtra() {
    if (!addCat) return;
    await upsertStaffCategoryOverride({ staff_id: staffId, category: addCat, target_level: Number(addTgt), included: true });
    setAddCat('');
    refresh();
  }

  const targetSelect = (value, onChange) => (
    <Select value={value} onChange={(e) => onChange(e.target.value)} style={{ minWidth: 120 }} disabled={!canEdit}>
      {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n} — {LEVEL_LABELS[n]}</option>)}
    </Select>
  );

  return (
    <div style={{ marginTop: 16, border: '1px solid #e5e7eb', borderRadius: 12, background: '#fff', padding: 16 }}>
      <div style={{ fontFamily: FONT, fontSize: 12, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 10 }}>
        Customise this role for the individual
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {roleCategories.map((c) => {
          const ov = ovByCat[c.category];
          const included = ov?.included !== false;
          const effTarget = ov?.target_level ?? c.target_level;
          const overridden = ov && (ov.included === false || ov.target_level != null);
          return (
            <div key={c.category} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 10px', border: '1px solid #f1f5f9', borderRadius: 8, opacity: included ? 1 : 0.55 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, fontFamily: FONT, fontSize: 13, color: '#0f172a', fontWeight: 500 }}>
                <input type="checkbox" checked={included} disabled={!canEdit} onChange={(e) => setInclude(c.category, e.target.checked)} />
                {c.category}
                <span style={{ fontSize: 11, color: '#94a3b8' }}>role target {c.target_level}</span>
              </label>
              {included && targetSelect(effTarget, (v) => setTarget(c.category, v))}
              {overridden && canEdit && <button onClick={() => reset(c.category)} style={ghost}>Reset</button>}
            </div>
          );
        })}

        {extraOverrides.map((o) => (
          <div key={o.category} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 10px', border: '1px solid #dbeafe', borderRadius: 8, background: '#f0f7ff' }}>
            <span style={{ flex: 1, fontFamily: FONT, fontSize: 13, color: '#0f172a', fontWeight: 500 }}>
              {o.category} <span style={{ fontSize: 11, color: '#0e7fe0' }}>added</span>
            </span>
            {targetSelect(o.target_level ?? 3, (v) => setTarget(o.category, v))}
            {canEdit && <button onClick={() => reset(o.category)} style={ghost}>Remove</button>}
          </div>
        ))}
      </div>

      {canEdit && availableCats.length > 0 && (
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap', marginTop: 12, padding: 12, background: '#f8fafc', borderRadius: 10 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontFamily: FONT, fontSize: 11, fontWeight: 600, color: '#64748b' }}>Add extra category</span>
            <Select value={addCat} onChange={(e) => setAddCat(e.target.value)} style={{ minWidth: 190 }}>
              <option value="">— Select —</option>
              {availableCats.map((c) => <option key={c} value={c}>{c}</option>)}
            </Select>
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontFamily: FONT, fontSize: 11, fontWeight: 600, color: '#64748b' }}>Target</span>
            {targetSelect(addTgt, setAddTgt)}
          </label>
          <button onClick={addExtra} disabled={!addCat} style={primary}>Add</button>
        </div>
      )}
    </div>
  );
}

const ghost = { fontSize: 11, fontWeight: 600, fontFamily: FONT, cursor: 'pointer', padding: '5px 10px', borderRadius: 8, border: '1px solid #cbd5e1', background: '#fff', color: '#64748b' };
const primary = { fontSize: 12, fontWeight: 600, fontFamily: FONT, cursor: 'pointer', padding: '8px 16px', borderRadius: 8, border: '1px solid #0f172a', background: '#0f172a', color: '#fff' };
