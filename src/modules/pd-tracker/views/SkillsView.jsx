import React, { useEffect, useState, useMemo } from 'react';
import { useAuth } from '../../../shell/AppShell';
import RadarChart from '../components/RadarChart';
import { Card, SectionTitle, Pill, FONT, SERIF, LevelDot, Select } from '../components/ui';
import { loadSkills, loadSkillLevels, upsertSkillLevel, LEVEL_LABELS, LEVEL_DESCS, loadStaff } from '../lib/api';

export default function SkillsView() {
  const { profile } = useAuth();
  const isAdmin = profile?.can_manage_portal === true || profile?.is_portal_admin === true;
  const [staff, setStaff] = useState([]);
  const [selectedStaffId, setSelectedStaffId] = useState(profile?.id);
  const [skills, setSkills] = useState([]);
  const [levels, setLevels] = useState([]);
  const [activeCategory, setActiveCategory] = useState('All');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const [sk, st] = await Promise.all([loadSkills(), isAdmin ? loadStaff() : Promise.resolve([])]);
        setSkills(sk);
        setStaff(st);
      } catch (e) { console.error(e); }
    })();
  }, [isAdmin]);

  useEffect(() => {
    if (!selectedStaffId) return;
    setLoading(true);
    (async () => {
      try {
        const lv = await loadSkillLevels(selectedStaffId);
        setLevels(lv);
      } catch (e) { console.error(e); }
      setLoading(false);
    })();
  }, [selectedStaffId]);

  const levelMap = useMemo(() => {
    const m = { current: {}, target: {} };
    levels.forEach((l) => {
      m.current[l.skill_id] = l.current_level;
      m.target[l.skill_id]  = l.target_level;
    });
    return m;
  }, [levels]);

  const categories = useMemo(() => {
    const s = new Set(skills.map((x) => x.category));
    return ['All', ...Array.from(s)];
  }, [skills]);

  const visibleSkills = activeCategory === 'All'
    ? skills
    : skills.filter((s) => s.category === activeCategory);

  const setLevel = async (skillId, kind, value) => {
    if (selectedStaffId !== profile?.id && !isAdmin) return;
    setSaving(true);
    const existing = levels.find((l) => l.skill_id === skillId);
    const current_level = kind === 'current' ? value : existing?.current_level ?? 0;
    const target_level  = kind === 'target'  ? value : existing?.target_level ?? 0;
    try {
      const saved = await upsertSkillLevel({
        staffId: selectedStaffId, skillId,
        current_level, target_level,
        notes: existing?.notes,
      });
      setLevels((prev) => {
        const idx = prev.findIndex((l) => l.skill_id === skillId);
        if (idx === -1) return [...prev, saved];
        const next = [...prev]; next[idx] = saved; return next;
      });
    } catch (e) { console.error(e); }
    setSaving(false);
  };

  // pick top ~10 skills with biggest gap or covered for the radar
  const radarSkills = useMemo(() => {
    const enriched = skills.map((s) => {
      const c = levelMap.current[s.id] ?? 0;
      const t = levelMap.target[s.id] ?? 0;
      return { ...s, _gap: t - c, _hasData: c > 0 || t > 0 };
    });
    const withData = enriched.filter((s) => s._hasData);
    const pool = withData.length >= 5 ? withData : enriched;
    return pool.slice(0, 12);
  }, [skills, levelMap]);

  return (
    <div style={{ padding: '32px 32px 80px', maxWidth: 1280, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', flexWrap: 'wrap', gap: 16, marginBottom: 24 }}>
        <SectionTitle
          kicker="Skill matrix"
          title="Where am I, where am I heading?"
          hint="Score yourself honestly. Set a target for each skill — then we can see the gap."
        />
        {isAdmin && staff.length > 0 && (
          <Select value={selectedStaffId} onChange={(e) => setSelectedStaffId(e.target.value)} style={{ minWidth: 200 }}>
            {staff.map((s) => (
              <option key={s.id} value={s.id}>{s.name}{s.id === profile?.id ? ' (you)' : ''}</option>
            ))}
          </Select>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.4fr', gap: 24, alignItems: 'start' }}>
        {/* Radar */}
        <Card>
          <div style={{ fontFamily: FONT, fontSize: 12, color: '#94a3b8', marginBottom: 4, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
            Spider chart
          </div>
          <div style={{ fontFamily: SERIF, fontSize: 18, color: '#0f172a', marginBottom: 16 }}>
            Skill profile
          </div>
          {loading ? (
            <div style={{ height: 460, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#94a3b8', fontFamily: FONT, fontSize: 13 }}>
              Loading...
            </div>
          ) : (
            <RadarChart
              skills={radarSkills}
              current={levelMap.current}
              target={levelMap.target}
            />
          )}
          <div style={{ marginTop: 16, fontFamily: FONT, fontSize: 12, color: '#64748b', lineHeight: 1.6 }}>
            <strong style={{ color: '#0f172a' }}>How to read it:</strong> the dark shape is where you are now,
            the dashed sky-blue shape is where you want to be. The bigger the gap, the bigger
            the development opportunity.
          </div>
        </Card>

        {/* Matrix */}
        <Card>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
            <div style={{ fontFamily: SERIF, fontSize: 18, color: '#0f172a' }}>Skill matrix</div>
            {saving && <span style={{ fontFamily: FONT, fontSize: 11, color: '#0e7fe0' }}>Saving…</span>}
          </div>

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
            {categories.map((c) => (
              <button
                key={c}
                onClick={() => setActiveCategory(c)}
                style={{
                  border: 'none', cursor: 'pointer',
                  background: activeCategory === c ? '#0f172a' : '#f1f5f9',
                  color: activeCategory === c ? '#fff' : '#475569',
                  fontFamily: FONT, fontSize: 12, fontWeight: 600,
                  padding: '6px 12px', borderRadius: 999,
                }}
              >{c}</button>
            ))}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) auto auto', columnGap: 16, rowGap: 6, alignItems: 'center' }}>
            <div />
            <div style={{ fontFamily: FONT, fontSize: 11, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.06em', textAlign: 'center' }}>Current</div>
            <div style={{ fontFamily: FONT, fontSize: 11, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.06em', textAlign: 'center' }}>Target</div>

            {visibleSkills.map((s) => {
              const cur = levelMap.current[s.id] ?? 0;
              const tgt = levelMap.target[s.id]  ?? 0;
              const gap = tgt - cur;
              return (
                <React.Fragment key={s.id}>
                  <div style={{ padding: '10px 0', borderTop: '1px solid #f1f5f9' }}>
                    <div style={{ fontFamily: FONT, fontSize: 13, fontWeight: 500, color: '#0f172a' }}>{s.name}</div>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 2 }}>
                      <span style={{ fontFamily: FONT, fontSize: 11, color: '#94a3b8' }}>{s.category}</span>
                      {gap > 0 && <Pill bg="#fef3c7" fg="#92400e">Gap {gap}</Pill>}
                      {gap === 0 && cur > 0 && <Pill bg="#dcfce7" fg="#166534">On target</Pill>}
                      {gap < 0 && <Pill bg="#dbeafe" fg="#1e40af">Above target</Pill>}
                    </div>
                  </div>
                  <LevelClicker value={cur} onChange={(v) => setLevel(s.id, 'current', v)} kind="current" />
                  <LevelClicker value={tgt} onChange={(v) => setLevel(s.id, 'target', v)} kind="target" />
                </React.Fragment>
              );
            })}
          </div>

          <div style={{ marginTop: 18, padding: 12, background: '#f8fafc', borderRadius: 10, fontFamily: FONT, fontSize: 12, color: '#475569' }}>
            <strong style={{ color: '#0f172a' }}>Levels:</strong>{' '}
            {LEVEL_LABELS.slice(1).map((l, i) => (
              <span key={l} style={{ marginRight: 12 }}>
                <strong>{i + 1}</strong> {l}
              </span>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}

function LevelClicker({ value, onChange, kind }) {
  const [hover, setHover] = useState(0);
  const max = 5;
  const display = hover || value;
  return (
    <div
      onMouseLeave={() => setHover(0)}
      style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '8px 4px' }}
      title={LEVEL_DESCS[display] || ''}
    >
      {Array.from({ length: max }, (_, i) => {
        const v = i + 1;
        const filled = v <= display;
        const isTarget = kind === 'target';
        return (
          <button
            key={v}
            onMouseEnter={() => setHover(v)}
            onClick={() => onChange(v === value ? 0 : v)}
            style={{
              width: 16, height: 16, borderRadius: '50%',
              background: filled ? (isTarget ? '#38bdf8' : '#0f172a') : '#e5e7eb',
              border: 'none', cursor: 'pointer', padding: 0,
              transition: 'transform 0.1s, background 0.15s',
            }}
          />
        );
      })}
    </div>
  );
}
