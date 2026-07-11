import React, { useEffect, useMemo, useState } from 'react';
import { useAuth } from '../../../shell/AppShell';
import { Card, SectionTitle, Button, FONT, SERIF } from '../components/ui';
import { loadRoleProfileById, loadStaffRoleProfile, saveStaffRoleProfile } from '../lib/api';

function parseSections(text) {
  const sections = [];
  let cur = null;
  for (const raw of (text || '').split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.startsWith('## ')) { cur = { heading: line.slice(3).trim(), items: [] }; sections.push(cur); }
    else if (line.startsWith('- ')) {
      if (!cur) { cur = { heading: 'Overview', items: [] }; sections.push(cur); }
      cur.items.push(line.slice(2).trim());
    }
  }
  return sections;
}

export default function MyRoleView() {
  const { profile } = useAuth();
  const roleId = profile?.pd_role_profile_id;

  const [role, setRole] = useState(null);
  const [overlay, setOverlay] = useState(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);

  // edit-local state
  const [removedSet, setRemovedSet] = useState(new Set());
  const [additions, setAdditions] = useState({});
  const [addText, setAddText] = useState({}); // heading -> in-progress input

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (!roleId) { setLoading(false); return; }
        const [r, o] = await Promise.all([loadRoleProfileById(roleId), loadStaffRoleProfile(profile.id, roleId)]);
        if (cancelled) return;
        setRole(r); setOverlay(o);
      } catch (e) { console.error(e); }
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [roleId, profile?.id]);

  const sections = useMemo(() => parseSections(role?.profile_text), [role]);

  function startEdit() {
    setRemovedSet(new Set(overlay?.removed || []));
    setAdditions({ ...(overlay?.additions || {}) });
    setAddText({});
    setEditing(true);
  }
  function cancelEdit() { setEditing(false); }

  async function save() {
    setSaving(true);
    try {
      const saved = await saveStaffRoleProfile({
        staff_id: profile.id, role_profile_id: roleId,
        removed: Array.from(removedSet),
        additions,
      });
      setOverlay(saved);
      setEditing(false);
    } catch (e) { alert('Could not save: ' + (e.message || e)); }
    setSaving(false);
  }

  const toggleRemove = (item) => {
    setRemovedSet((prev) => { const n = new Set(prev); n.has(item) ? n.delete(item) : n.add(item); return n; });
  };
  const addItem = (heading) => {
    const t = (addText[heading] || '').trim();
    if (!t) return;
    setAdditions((prev) => ({ ...prev, [heading]: [...(prev[heading] || []), t] }));
    setAddText((prev) => ({ ...prev, [heading]: '' }));
  };
  const removeAddition = (heading, idx) => {
    setAdditions((prev) => ({ ...prev, [heading]: (prev[heading] || []).filter((_, i) => i !== idx) }));
  };

  if (loading) return <Msg>Loading your role…</Msg>;
  if (!roleId || !role) return <Msg>No role assigned yet. Ask an admin to set your role profile.</Msg>;

  // Active view = overlay applied
  const activeRemoved = editing ? removedSet : new Set(overlay?.removed || []);
  const activeAdditions = editing ? additions : (overlay?.additions || {});
  const removedItems = [];
  sections.forEach((s) => s.items.forEach((it) => { if (activeRemoved.has(it)) removedItems.push({ heading: s.heading, item: it }); }));

  return (
    <div style={{ padding: '32px 32px 80px', maxWidth: 820, margin: '0 auto', fontFamily: FONT }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12, marginBottom: 20 }}>
        <SectionTitle kicker="My role" title={role.name} hint={role.description || 'Your role profile — personalise it to make it yours.'} />
        {!editing ? (
          <Button variant="accent" onClick={startEdit}>Personalise</Button>
        ) : (
          <div style={{ display: 'flex', gap: 8 }}>
            <Button variant="ghost" onClick={cancelEdit}>Cancel</Button>
            <Button variant="primary" onClick={save}>{saving ? 'Saving…' : 'Save'}</Button>
          </div>
        )}
      </div>

      <Card>
        {sections.map((s) => {
          const baseItems = s.items.filter((it) => !activeRemoved.has(it));
          const adds = activeAdditions[s.heading] || [];
          return (
            <div key={s.heading} style={{ marginBottom: 20 }}>
              <div style={{ fontFamily: SERIF, fontSize: 16, color: '#0f172a', marginBottom: 8 }}>{s.heading}</div>
              <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 6 }}>
                {baseItems.map((it) => (
                  <li key={it} style={{ fontSize: 13, color: '#1e293b', lineHeight: 1.5 }}>
                    <span>{it}</span>
                    {editing && <button onClick={() => toggleRemove(it)} title="Remove from my role" style={xBtn}>×</button>}
                  </li>
                ))}
                {adds.map((it, idx) => (
                  <li key={'add-' + idx} style={{ fontSize: 13, color: '#166534', lineHeight: 1.5, listStyle: 'none', marginLeft: -18 }}>
                    <span style={badge}>＋ added</span> {it}
                    {editing && <button onClick={() => removeAddition(s.heading, idx)} title="Remove addition" style={xBtn}>×</button>}
                  </li>
                ))}
              </ul>
              {editing && (
                <div style={{ display: 'flex', gap: 8, marginTop: 8, marginLeft: 18 }}>
                  <input value={addText[s.heading] || ''} onChange={(e) => setAddText((p) => ({ ...p, [s.heading]: e.target.value }))}
                    onKeyDown={(e) => { if (e.key === 'Enter') addItem(s.heading); }}
                    placeholder={`Add to ${s.heading.toLowerCase()}…`}
                    style={{ flex: 1, padding: '6px 10px', fontFamily: FONT, fontSize: 12, border: '1px solid #cbd5e1', borderRadius: 8, outline: 'none' }} />
                  <button onClick={() => addItem(s.heading)} style={addBtn}>Add</button>
                </div>
              )}
            </div>
          );
        })}

        {removedItems.length > 0 && (
          <div style={{ marginTop: 8, paddingTop: 14, borderTop: '1px dashed #e5e7eb' }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>
              Removed from my role
            </div>
            <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {removedItems.map(({ heading, item }) => (
                <li key={item} style={{ fontSize: 12, color: '#94a3b8', lineHeight: 1.5, textDecoration: 'line-through' }}>
                  <span style={{ textDecoration: 'none', color: '#cbd5e1', marginRight: 6 }}>[{heading}]</span>{item}
                  {editing && <button onClick={() => toggleRemove(item)} title="Restore" style={{ ...xBtn, color: '#0e7fe0', textDecoration: 'none' }}>↩</button>}
                </li>
              ))}
            </ul>
          </div>
        )}
      </Card>

      <p style={{ fontSize: 11, color: '#94a3b8', marginTop: 12 }}>
        The base role profile is maintained centrally. Your changes only affect your own copy — removals move to the bottom, additions are marked.
      </p>
    </div>
  );
}

const xBtn = { marginLeft: 8, border: 'none', background: 'none', color: '#cbd5e1', cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: 0 };
const badge = { fontSize: 10, fontWeight: 700, color: '#166534', background: '#dcfce7', borderRadius: 999, padding: '1px 7px', marginRight: 4 };
const addBtn = { fontSize: 12, fontWeight: 600, fontFamily: FONT, cursor: 'pointer', padding: '6px 12px', borderRadius: 8, border: '1px solid #0f172a', background: '#0f172a', color: '#fff' };

function Msg({ children }) { return <div style={{ padding: 40, fontFamily: FONT, color: '#64748b', fontSize: 14, textAlign: 'center' }}>{children}</div>; }
