import React, { useEffect, useMemo, useState } from 'react';
import { useAuth } from '../../../shell/AppShell';
import { Card, FONT, SERIF, Select } from '../components/ui';
import {
  loadRoleProfiles, loadSkills, loadRoleProfileCategories,
  createRoleProfile, updateRoleProfile, deleteRoleProfile,
  upsertRoleCategory, deleteRoleCategory, createSkill, LEVEL_LABELS,
} from '../lib/api';

export default function RolesView() {
  const { profile } = useAuth();
  const isAdmin = profile?.can_manage_portal === true || profile?.is_portal_admin === true;

  const [roles, setRoles] = useState([]);
  const [skills, setSkills] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [cats, setCats] = useState([]);
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [profileText, setProfileText] = useState('');
  const [editorTab, setEditorTab] = useState('profile');
  const [addCat, setAddCat] = useState('');
  const [addTgt, setAddTgt] = useState(3);
  const [newSkillName, setNewSkillName] = useState('');
  const [newSkillCat, setNewSkillCat] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const allCategories = useMemo(
    () => Array.from(new Set(skills.map((s) => s.category))).sort(),
    [skills],
  );

  async function refreshRoles() {
    const r = await loadRoleProfiles();
    setRoles(r);
    return r;
  }

  useEffect(() => {
    (async () => {
      try {
        const [r, sk] = await Promise.all([loadRoleProfiles(), loadSkills()]);
        setRoles(r); setSkills(sk);
        if (r.length) setSelectedId(r[0].id);
      } catch (e) { console.error(e); }
      setLoading(false);
    })();
  }, []);

  useEffect(() => {
    if (!selectedId) { setCats([]); return; }
    const role = roles.find((r) => r.id === selectedId);
    setName(role?.name || '');
    setDesc(role?.description || '');
    setProfileText(role?.profile_text || '');
    (async () => {
      try { setCats(await loadRoleProfileCategories(selectedId)); }
      catch (e) { console.error(e); }
    })();
  }, [selectedId, roles]);

  if (!isAdmin) {
    return <Msg>Role profiles are managed by portal admins.</Msg>;
  }
  if (loading) return <Msg>Loading roles…</Msg>;

  async function newRole() {
    setBusy(true);
    try {
      const created = await createRoleProfile({ name: 'New role', display_order: 100 });
      await refreshRoles();
      setSelectedId(created.id);
    } catch (e) { alert('Could not create: ' + (e.message || e)); }
    setBusy(false);
  }

  async function saveMeta() {
    if (!selectedId) return;
    setBusy(true);
    try {
      await updateRoleProfile(selectedId, { name: name.trim() || 'Untitled', description: desc.trim() || null, profile_text: profileText || null });
      await refreshRoles();
    } catch (e) { alert('Could not save: ' + (e.message || e)); }
    setBusy(false);
  }

  async function removeRole() {
    if (!selectedId) return;
    if (!confirm(`Delete role "${name}"? Staff assigned to it will be unset.`)) return;
    setBusy(true);
    try {
      await deleteRoleProfile(selectedId);
      const r = await refreshRoles();
      setSelectedId(r[0]?.id || null);
    } catch (e) { alert('Could not delete: ' + (e.message || e)); }
    setBusy(false);
  }

  async function addCategory() {
    if (!addCat) return;
    setBusy(true);
    try {
      const saved = await upsertRoleCategory({
        role_profile_id: selectedId, category: addCat,
        target_level: Number(addTgt), display_order: (cats.length + 1) * 10,
      });
      setCats((prev) => [...prev.filter((c) => c.category !== addCat), saved].sort((a, b) => a.display_order - b.display_order));
      setAddCat('');
    } catch (e) { alert('Could not add: ' + (e.message || e)); }
    setBusy(false);
  }

  async function setTarget(cat, target) {
    setCats((prev) => prev.map((c) => (c.id === cat.id ? { ...c, target_level: target } : c)));
    try {
      await upsertRoleCategory({ role_profile_id: selectedId, category: cat.category, target_level: Number(target), display_order: cat.display_order });
    } catch (e) { alert('Could not update: ' + (e.message || e)); }
  }

  async function removeCategory(cat) {
    setCats((prev) => prev.filter((c) => c.id !== cat.id));
    try { await deleteRoleCategory(cat.id); } catch (e) { alert('Could not remove: ' + (e.message || e)); }
  }

  async function addSkill() {
    if (!newSkillName.trim() || !newSkillCat.trim()) return;
    setBusy(true);
    try {
      await createSkill({ name: newSkillName.trim(), category: newSkillCat.trim() });
      setSkills(await loadSkills());
      setNewSkillName(''); setNewSkillCat('');
    } catch (e) { alert('Could not add skill: ' + (e.message || e)); }
    setBusy(false);
  }

  const usedCats = new Set(cats.map((c) => c.category));
  const availableCats = allCategories.filter((c) => !usedCats.has(c));

  return (
    <div style={{ padding: '28px 32px 80px', maxWidth: 1100, margin: '0 auto', fontFamily: FONT }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 4 }}>
        <h2 style={{ margin: 0, fontFamily: SERIF, fontSize: 22, color: '#0f172a' }}>Role profiles</h2>
        {busy && <span style={{ fontSize: 11, color: '#0e7fe0' }}>Saving…</span>}
      </div>
      <p style={{ fontSize: 13, color: '#64748b', marginTop: 4, marginBottom: 20 }}>
        Build a target skill profile per role. Each role is a set of skill categories with a target level; the Skills graph rolls each category up from the skills underneath.
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: '240px 1fr', gap: 20, alignItems: 'start' }}>
        {/* Role list */}
        <Card>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Roles</div>
            <button onClick={newRole} style={btnPrimarySm}>+ New</button>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {roles.map((r) => (
              <button key={r.id} onClick={() => setSelectedId(r.id)}
                style={{
                  textAlign: 'left', border: '1px solid ' + (selectedId === r.id ? '#0f172a' : '#e5e7eb'),
                  background: selectedId === r.id ? '#0f172a' : '#fff', color: selectedId === r.id ? '#fff' : '#0f172a',
                  borderRadius: 8, padding: '8px 10px', cursor: 'pointer', fontFamily: FONT, fontSize: 13, fontWeight: 500,
                }}>{r.name}</button>
            ))}
            {roles.length === 0 && <div style={{ fontSize: 12, color: '#94a3b8' }}>No roles yet.</div>}
          </div>
        </Card>

        {/* Editor */}
        {selectedId ? (
          <Card>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 16, borderBottom: '1px solid #f1f5f9' }}>
              {[['profile', 'Role profile'], ['skills', 'Skills']].map(([id, label]) => (
                <button key={id} onClick={() => setEditorTab(id)}
                  style={{ border: 'none', background: 'none', cursor: 'pointer', fontFamily: FONT, fontSize: 13, fontWeight: 600,
                    color: editorTab === id ? '#0e7fe0' : '#64748b', padding: '8px 10px',
                    borderBottom: editorTab === id ? '2px solid #0e7fe0' : '2px solid transparent' }}>{label}</button>
              ))}
              <div style={{ flex: 1 }} />
              <button onClick={removeRole} style={btnDanger}>Delete role</button>
            </div>

            {editorTab === 'profile' ? (
              <div>
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 12 }}>
                  <Field label="Role name"><input value={name} onChange={(e) => setName(e.target.value)} style={input} /></Field>
                  <Field label="Short description" grow><input value={desc} onChange={(e) => setDesc(e.target.value)} style={{ ...input, width: '100%' }} /></Field>
                </div>
                <Field label="Role profile (overview, duties, skills, behaviours)">
                  <textarea value={profileText} onChange={(e) => setProfileText(e.target.value)} rows={18}
                    style={{ width: '100%', padding: 12, fontFamily: FONT, fontSize: 13, lineHeight: 1.55, border: '1px solid #cbd5e1', borderRadius: 8, boxSizing: 'border-box', resize: 'vertical' }} />
                </Field>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 12 }}>
                  <span style={{ fontSize: 11, color: '#94a3b8' }}>Use ## for headings and - for bullets.</span>
                  <button onClick={saveMeta} style={btnPrimary}>Save profile</button>
                </div>
              </div>
            ) : (
              <div>
                <div style={{ fontSize: 12, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>Categories &amp; targets</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 14 }}>
                  {cats.map((c) => (
                    <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 10px', border: '1px solid #f1f5f9', borderRadius: 8 }}>
                      <span style={{ flex: 1, fontSize: 13, color: '#0f172a', fontWeight: 500 }}>{c.category}</span>
                      <label style={{ fontSize: 11, color: '#64748b', display: 'flex', alignItems: 'center', gap: 6 }}>
                        Target
                        <Select value={c.target_level} onChange={(e) => setTarget(c, e.target.value)} style={{ minWidth: 120 }}>
                          {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n} — {LEVEL_LABELS[n]}</option>)}
                        </Select>
                      </label>
                      <button onClick={() => removeCategory(c)} style={btnGhost}>Remove</button>
                    </div>
                  ))}
                  {cats.length === 0 && <div style={{ fontSize: 12, color: '#94a3b8' }}>No categories yet — add some below.</div>}
                </div>

                <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap', padding: 12, background: '#f8fafc', borderRadius: 10, marginBottom: 16 }}>
                  <Field label="Add category">
                    <Select value={addCat} onChange={(e) => setAddCat(e.target.value)} style={{ minWidth: 200 }}>
                      <option value="">— Select —</option>
                      {availableCats.map((c) => <option key={c} value={c}>{c}</option>)}
                    </Select>
                  </Field>
                  <Field label="Target">
                    <Select value={addTgt} onChange={(e) => setAddTgt(e.target.value)} style={{ minWidth: 120 }}>
                      {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n} — {LEVEL_LABELS[n]}</option>)}
                    </Select>
                  </Field>
                  <button onClick={addCategory} disabled={!addCat} style={btnPrimary}>Add</button>
                </div>

                <div style={{ fontSize: 12, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>Add a skill (creates a new category if needed)</div>
                <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                  <Field label="Skill name"><input value={newSkillName} onChange={(e) => setNewSkillName(e.target.value)} placeholder="e.g. Chairing client meetings" style={input} /></Field>
                  <Field label="Category">
                    <input value={newSkillCat} onChange={(e) => setNewSkillCat(e.target.value)} placeholder="e.g. Client Meetings" list="pd-cats" style={input} />
                    <datalist id="pd-cats">{allCategories.map((c) => <option key={c} value={c} />)}</datalist>
                  </Field>
                  <button onClick={addSkill} disabled={!newSkillName.trim() || !newSkillCat.trim()} style={btnPrimary}>Add skill</button>
                </div>
              </div>
            )}
          </Card>
        ) : (
          <Card><Msg>Select a role, or create one.</Msg></Card>
        )}
      </div>
    </div>
  );
}

function Field({ label, children, grow }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: grow ? 1 : 'initial' }}>
      <span style={{ fontSize: 11, fontWeight: 600, color: '#64748b', fontFamily: FONT }}>{label}</span>
      {children}
    </label>
  );
}

const input = { padding: '7px 10px', fontSize: 13, fontFamily: FONT, border: '1px solid #cbd5e1', borderRadius: 8, background: '#fff', color: '#0f172a', outline: 'none' };
const btnPrimary = { fontSize: 12, fontWeight: 600, fontFamily: FONT, cursor: 'pointer', padding: '8px 16px', borderRadius: 8, border: '1px solid #0f172a', background: '#0f172a', color: '#fff' };
const btnPrimarySm = { fontSize: 11, fontWeight: 600, fontFamily: FONT, cursor: 'pointer', padding: '5px 10px', borderRadius: 8, border: '1px solid #0f172a', background: '#0f172a', color: '#fff' };
const btnDanger = { fontSize: 12, fontWeight: 600, fontFamily: FONT, cursor: 'pointer', padding: '8px 14px', borderRadius: 8, border: '1px solid #fecaca', background: '#fff', color: '#b91c1c' };
const btnGhost = { fontSize: 11, fontWeight: 600, fontFamily: FONT, cursor: 'pointer', padding: '5px 10px', borderRadius: 8, border: '1px solid #cbd5e1', background: '#fff', color: '#64748b' };

function Msg({ children }) {
  return <div style={{ padding: 24, fontFamily: FONT, color: '#64748b', fontSize: 14, textAlign: 'center' }}>{children}</div>;
}
