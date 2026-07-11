import React, { useEffect, useState, useMemo, useRef } from 'react';
import { useAuth } from '../../../shell/AppShell';
import RadarChart from '../components/RadarChart';
import CustomiseTargets from '../components/CustomiseTargets';
import { Card, SectionTitle, Pill, FONT, SERIF, Select } from '../components/ui';
import { Star, GraduationCap } from 'lucide-react';
import {
  loadSkills, loadSkillLevels, upsertSkillLevel, setShowOnRadar,
  loadStaff, loadRoleProfiles, loadRoleProfileCategories, loadStaffCategoryOverrides,
  assignRoleProfile, effectiveRoleCategories, helpMeLearnLinks,
  loadGrantsToMe, LEVEL_LABELS, LEVEL_DESCS,
} from '../lib/api';

export default function SkillsView() {
  const { profile } = useAuth();
  const isAdmin = profile?.can_manage_portal === true || profile?.is_portal_admin === true;

  const [staff, setStaff] = useState([]);
  const [selectedStaffId, setSelectedStaffId] = useState(profile?.id);
  const [skills, setSkills] = useState([]);
  const [levels, setLevels] = useState([]);
  const [roleProfiles, setRoleProfiles] = useState([]);
  const [roleCats, setRoleCats] = useState([]);
  const [overrides, setOverrides] = useState([]);
  const [assignedRoleId, setAssignedRoleId] = useState(profile?.pd_role_profile_id || '');
  const [group, setGroup] = useState('picks'); // 'picks' | role profile id
  const [activeCategory, setActiveCategory] = useState('All');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showCust, setShowCust] = useState(false);
  const [grantsToMe, setGrantsToMe] = useState([]);
  const groupInit = useRef(false);

  // Static loads
  useEffect(() => {
    (async () => {
      try {
        const [sk, rp, st, gm] = await Promise.all([
          loadSkills(), loadRoleProfiles(), loadStaff(), loadGrantsToMe(profile?.id),
        ]);
        setSkills(sk); setRoleProfiles(rp); setStaff(st); setGrantsToMe(gm);
      } catch (e) { console.error(e); }
    })();
  }, [profile?.id]);

  const accessibleStaff = useMemo(() => {
    if (isAdmin) return staff;
    const owners = new Set(grantsToMe.map((g) => g.owner_id));
    return staff.filter((s) => s.id === profile?.id || owners.has(s.id));
  }, [isAdmin, staff, grantsToMe, profile?.id]);

  // Per-staff loads
  useEffect(() => {
    if (!selectedStaffId) return;
    setLoading(true);
    (async () => {
      try {
        const [lv, ov] = await Promise.all([
          loadSkillLevels(selectedStaffId), loadStaffCategoryOverrides(selectedStaffId),
        ]);
        setLevels(lv); setOverrides(ov);
        const roleId = selectedStaffId === profile?.id
          ? (profile?.pd_role_profile_id || '')
          : (staff.find((s) => s.id === selectedStaffId)?.pd_role_profile_id || '');
        setAssignedRoleId(roleId);
        if (!groupInit.current) { setGroup(roleId || 'picks'); groupInit.current = true; }
      } catch (e) { console.error(e); }
      setLoading(false);
    })();
  }, [selectedStaffId, staff]);

  // Load role categories when a role group is selected
  useEffect(() => {
    if (group === 'picks') { setRoleCats([]); return; }
    (async () => {
      try { setRoleCats(await loadRoleProfileCategories(group)); }
      catch (e) { console.error(e); }
    })();
  }, [group]);

  const levelMap = useMemo(() => {
    const m = { current: {}, target: {}, onRadar: {} };
    levels.forEach((l) => {
      m.current[l.skill_id] = l.current_level;
      m.target[l.skill_id]  = l.target_level;
      m.onRadar[l.skill_id] = !!l.show_on_radar;
    });
    return m;
  }, [levels]);

  const isRoleMode = group !== 'picks';
  const canEdit = selectedStaffId === profile?.id || isAdmin || grantsToMe.some((g) => g.owner_id === selectedStaffId);

  // Effective role category axes + targets (role mode)
  const effCats = useMemo(
    () => (isRoleMode ? effectiveRoleCategories(roleCats, overrides) : []),
    [isRoleMode, roleCats, overrides],
  );
  const catTargetMap = useMemo(() => {
    const m = {};
    effCats.forEach((c) => { m[c.category] = c.target_level; });
    return m;
  }, [effCats]);

  // Rollup: category current = average of component current levels in that category
  const categoryAvg = (category) => {
    const inCat = skills.filter((s) => s.category === category);
    if (!inCat.length) return 0;
    return inCat.reduce((a, s) => a + (levelMap.current[s.id] ?? 0), 0) / inCat.length;
  };

  // Radar data
  const radarPicks = useMemo(() => skills.filter((s) => levelMap.onRadar[s.id]), [skills, levelMap]);
  const roleRadar = useMemo(() => {
    const pseudo = effCats.map((c) => ({ id: 'cat:' + c.category, name: c.category, category: c.category }));
    const current = {}, target = {};
    effCats.forEach((c) => { current['cat:' + c.category] = categoryAvg(c.category); target['cat:' + c.category] = c.target_level; });
    return { pseudo, current, target };
  }, [effCats, skills, levelMap]);

  const roleCategorySet = useMemo(() => new Set(effCats.map((c) => c.category)), [effCats]);
  const allCategories = useMemo(() => ['All', ...Array.from(new Set(skills.map((s) => s.category)))], [skills]);
  const chipCategories = isRoleMode ? ['All', ...effCats.map((c) => c.category)] : allCategories;

  const scopeSkills = isRoleMode ? skills.filter((s) => roleCategorySet.has(s.category)) : skills;
  const visibleSkills = activeCategory === 'All' ? scopeSkills : scopeSkills.filter((s) => s.category === activeCategory);

  const effTarget = (s) => (isRoleMode ? (catTargetMap[s.category] ?? 0) : (levelMap.target[s.id] ?? 0));

  const setLevel = async (skillId, kind, value) => {
    if (!canEdit) return;
    setSaving(true);
    const existing = levels.find((l) => l.skill_id === skillId);
    const current_level = kind === 'current' ? value : existing?.current_level ?? 0;
    const target_level  = kind === 'target'  ? value : existing?.target_level ?? 0;
    try {
      const saved = await upsertSkillLevel({ staffId: selectedStaffId, skillId, current_level, target_level, notes: existing?.notes });
      setLevels((prev) => {
        const idx = prev.findIndex((l) => l.skill_id === skillId);
        if (idx === -1) return [...prev, saved];
        const next = [...prev]; next[idx] = saved; return next;
      });
    } catch (e) { console.error(e); }
    setSaving(false);
  };

  const toggleRadar = async (skill) => {
    if (!canEdit) return;
    setSaving(true);
    const existing = levels.find((l) => l.skill_id === skill.id);
    const next = !levelMap.onRadar[skill.id];
    try {
      const saved = await setShowOnRadar({ staffId: selectedStaffId, skillId: skill.id, value: next, existing });
      setLevels((prev) => {
        const idx = prev.findIndex((l) => l.skill_id === skill.id);
        if (idx === -1) return [...prev, saved];
        const n = [...prev]; n[idx] = saved; return n;
      });
    } catch (e) { console.error(e); }
    setSaving(false);
  };

  const changeRole = async (roleId) => {
    setAssignedRoleId(roleId);
    try {
      await assignRoleProfile(selectedStaffId, roleId);
      setStaff((prev) => prev.map((s) => (s.id === selectedStaffId ? { ...s, pd_role_profile_id: roleId || null } : s)));
      if (roleId) setGroup(roleId);
    } catch (e) { alert('Could not set role: ' + (e.message || e)); }
  };

  return (
    <div style={{ padding: '32px 32px 80px', maxWidth: 1280, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', flexWrap: 'wrap', gap: 16, marginBottom: 20 }}>
        <SectionTitle kicker="Skill matrix" title="Where am I, where am I heading?"
          hint="Pick a role to see the target profile, or your own starred picks. Score yourself honestly." />
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <label style={{ fontFamily: FONT, fontSize: 12, color: '#64748b', display: 'flex', alignItems: 'center', gap: 6 }}>
            View
            <Select value={group} onChange={(e) => { setGroup(e.target.value); setActiveCategory('All'); }} style={{ minWidth: 190 }}>
              <option value="picks">My picks (starred)</option>
              {roleProfiles.map((r) => (
                <option key={r.id} value={r.id}>{r.name}{r.id === assignedRoleId ? ' — assigned' : ''}</option>
              ))}
            </Select>
          </label>
          {isRoleMode && canEdit && (
            <button onClick={() => setShowCust((v) => !v)}
              style={{ fontFamily: FONT, fontSize: 12, fontWeight: 600, cursor: 'pointer', padding: '7px 12px', borderRadius: 8, border: '1px solid ' + (showCust ? '#0f172a' : '#cbd5e1'), background: showCust ? '#0f172a' : '#fff', color: showCust ? '#fff' : '#475569' }}>
              Customise
            </button>
          )}
          {accessibleStaff.length > 1 && (
            <Select value={selectedStaffId} onChange={(e) => { setSelectedStaffId(e.target.value); }} style={{ minWidth: 180 }}>
              {accessibleStaff.map((s) => (
                <option key={s.id} value={s.id}>{s.name}{s.id === profile?.id ? ' (you)' : ''}</option>
              ))}
            </Select>
          )}
          {isAdmin && (
            <label style={{ fontFamily: FONT, fontSize: 12, color: '#64748b', display: 'flex', alignItems: 'center', gap: 6 }}>
              Role
              <Select value={assignedRoleId} onChange={(e) => changeRole(e.target.value)} style={{ minWidth: 150 }}>
                <option value="">— None —</option>
                {roleProfiles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </Select>
            </label>
          )}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.4fr', gap: 24, alignItems: 'start' }}>
        {/* Radar */}
        <Card>
          <div style={{ fontFamily: FONT, fontSize: 12, color: '#94a3b8', marginBottom: 4, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
            {isRoleMode ? 'Role profile' : 'Spider chart'}
          </div>
          <div style={{ fontFamily: SERIF, fontSize: 18, color: '#0f172a', marginBottom: 16 }}>
            {isRoleMode ? (roleProfiles.find((r) => r.id === group)?.name || 'Role') + ' — by category' : 'Skill profile'}
          </div>
          {loading ? (
            <Placeholder>Loading…</Placeholder>
          ) : isRoleMode ? (
            effCats.length < 3 ? (
              <Placeholder>This role needs at least 3 categories to draw the graph.</Placeholder>
            ) : (
              <RadarChart skills={roleRadar.pseudo} current={roleRadar.current} target={roleRadar.target} />
            )
          ) : radarPicks.length < 3 ? (
            <Placeholder>
              Tap the <Star size={12} fill="#f59e0b" color="#f59e0b" style={{ verticalAlign: 'middle' }} /> star next to a skill to add it to your chart. ({radarPicks.length} of 3)
            </Placeholder>
          ) : (
            <RadarChart skills={radarPicks} current={levelMap.current} target={levelMap.target} />
          )}
          <div style={{ marginTop: 16, fontFamily: FONT, fontSize: 12, color: '#64748b', lineHeight: 1.6 }}>
            <strong style={{ color: '#0f172a' }}>How to read it:</strong> the dark shape is where you are now, the dashed sky-blue shape is the target.
            {isRoleMode && ' Each axis is a category — its score is the average of the skills underneath.'}
          </div>
        </Card>

        {/* Matrix */}
        <Card>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
            <div style={{ fontFamily: SERIF, fontSize: 18, color: '#0f172a' }}>Skill matrix</div>
            {saving && <span style={{ fontFamily: FONT, fontSize: 11, color: '#0e7fe0' }}>Saving…</span>}
          </div>

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
            {chipCategories.map((c) => (
              <button key={c} onClick={() => setActiveCategory(c)}
                style={{
                  border: 'none', cursor: 'pointer',
                  background: activeCategory === c ? '#0f172a' : '#f1f5f9',
                  color: activeCategory === c ? '#fff' : '#475569',
                  fontFamily: FONT, fontSize: 12, fontWeight: 600, padding: '6px 12px', borderRadius: 999,
                }}>{c}</button>
            ))}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'auto minmax(0,1fr) auto auto', columnGap: 14, rowGap: 6, alignItems: 'center' }}>
            <div /><div />
            <div style={hdr}>Current</div>
            <div style={hdr}>{isRoleMode ? 'Role tgt' : 'Target'}</div>

            {visibleSkills.map((s) => {
              const cur = levelMap.current[s.id] ?? 0;
              const tgt = effTarget(s);
              const gap = tgt - cur;
              const starred = levelMap.onRadar[s.id];
              return (
                <React.Fragment key={s.id}>
                  <button onClick={() => toggleRadar(s)} title={starred ? 'Remove from chart' : 'Add to chart'}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4, display: 'flex', alignItems: 'center', justifyContent: 'center', borderTop: '1px solid #f1f5f9', alignSelf: 'stretch' }}>
                    <Star size={16} fill={starred ? '#f59e0b' : 'none'} color={starred ? '#f59e0b' : '#cbd5e1'} strokeWidth={1.8} />
                  </button>
                  <div style={{ padding: '10px 0', borderTop: '1px solid #f1f5f9' }}>
                    <div style={{ fontFamily: FONT, fontSize: 13, fontWeight: 500, color: '#0f172a' }}>{s.name}</div>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 2, flexWrap: 'wrap' }}>
                      <span style={{ fontFamily: FONT, fontSize: 11, color: '#94a3b8' }}>{s.category}</span>
                      {gap > 0 && <Pill bg="#fef3c7" fg="#92400e">Gap {gap}</Pill>}
                      {gap === 0 && cur > 0 && <Pill bg="#dcfce7" fg="#166534">On target</Pill>}
                      {gap < 0 && <Pill bg="#dbeafe" fg="#1e40af">Above target</Pill>}
                      {gap > 0 && <HelpMenu skill={s} current={cur} target={tgt} />}
                    </div>
                  </div>
                  <LevelClicker value={cur} onChange={(v) => setLevel(s.id, 'current', v)} kind="current" disabled={!canEdit} />
                  {isRoleMode ? (
                    <div style={{ display: 'flex', gap: 4, padding: '8px 4px', alignItems: 'center' }} title="Target comes from the role profile">
                      {Array.from({ length: 5 }, (_, i) => (
                        <span key={i} style={{ width: 16, height: 16, borderRadius: '50%', background: i < tgt ? '#38bdf8' : '#e5e7eb' }} />
                      ))}
                    </div>
                  ) : (
                    <LevelClicker value={tgt} onChange={(v) => setLevel(s.id, 'target', v)} kind="target" disabled={!canEdit} />
                  )}
                </React.Fragment>
              );
            })}
          </div>

          <div style={{ marginTop: 18, padding: 12, background: '#f8fafc', borderRadius: 10, fontFamily: FONT, fontSize: 12, color: '#475569' }}>
            <strong style={{ color: '#0f172a' }}>Levels:</strong>{' '}
            {LEVEL_LABELS.slice(1).map((l, i) => <span key={l} style={{ marginRight: 12 }}><strong>{i + 1}</strong> {l}</span>)}
          </div>
        </Card>
      </div>

      {isRoleMode && canEdit && showCust && (
        <CustomiseTargets
          staffId={selectedStaffId}
          roleCategories={roleCats}
          overrides={overrides}
          allCategories={allCategories.filter((c) => c !== 'All')}
          canEdit={canEdit}
          onChanged={setOverrides}
        />
      )}
    </div>
  );
}

function HelpMenu({ skill, current, target }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);
  const links = helpMeLearnLinks(skill.name, skill.category, current, target);
  const item = { display: 'block', padding: '7px 12px', fontFamily: FONT, fontSize: 12, color: '#0f172a', textDecoration: 'none', whiteSpace: 'nowrap' };
  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-block' }}>
      <button onClick={() => setOpen((v) => !v)}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 4, border: '1px solid #cbd5e1', background: '#fff', color: '#0e7fe0', cursor: 'pointer', fontFamily: FONT, fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 999 }}>
        <GraduationCap size={12} /> Help me learn
      </button>
      {open && (
        <div style={{ position: 'absolute', top: '100%', left: 0, marginTop: 4, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, boxShadow: '0 8px 24px rgba(0,0,0,0.12)', zIndex: 60, padding: 4, minWidth: 170 }}>
          <a href={links.claude} target="_blank" rel="noopener noreferrer" style={item} onClick={() => setOpen(false)}>Ask Claude ↗</a>
          <a href={links.chatgpt} target="_blank" rel="noopener noreferrer" style={item} onClick={() => setOpen(false)}>Ask ChatGPT ↗</a>
          <a href={links.udemy} target="_blank" rel="noopener noreferrer" style={item} onClick={() => setOpen(false)}>Find Udemy courses ↗</a>
        </div>
      )}
    </div>
  );
}

function LevelClicker({ value, onChange, kind, disabled }) {
  const [hover, setHover] = useState(0);
  const display = hover || value;
  return (
    <div onMouseLeave={() => setHover(0)} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '8px 4px' }} title={LEVEL_DESCS[display] || ''}>
      {Array.from({ length: 5 }, (_, i) => {
        const v = i + 1;
        const filled = v <= display;
        return (
          <button key={v} disabled={disabled}
            onMouseEnter={() => !disabled && setHover(v)}
            onClick={() => !disabled && onChange(v === value ? 0 : v)}
            style={{ width: 16, height: 16, borderRadius: '50%', background: filled ? (kind === 'target' ? '#38bdf8' : '#0f172a') : '#e5e7eb', border: 'none', cursor: disabled ? 'default' : 'pointer', padding: 0 }} />
        );
      })}
    </div>
  );
}

const hdr = { fontFamily: FONT, fontSize: 11, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.06em', textAlign: 'center' };

function Placeholder({ children }) {
  return (
    <div style={{ height: 460, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, textAlign: 'center', padding: 20, fontFamily: FONT, fontSize: 13, color: '#64748b' }}>
      {children}
    </div>
  );
}
