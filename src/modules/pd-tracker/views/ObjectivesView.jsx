import React, { useEffect, useState } from 'react';
import { Plus, Target, Check, Trash2 } from 'lucide-react';
import { useAuth } from '../../../shell/AppShell';
import { Card, SectionTitle, Button, Input, Textarea, Select, Pill, ProgressBar, EmptyState, FONT, SERIF } from '../components/ui';
import { loadObjectives, createObjective, updateObjective, deleteObjective, loadSkills } from '../lib/api';

const STATUS_META = {
  open:        { label: 'Open',         bg: '#f1f5f9', fg: '#475569' },
  in_progress: { label: 'In progress',  bg: '#dbeafe', fg: '#1e40af' },
  complete:    { label: 'Complete',     bg: '#dcfce7', fg: '#166534' },
  abandoned:   { label: 'Abandoned',    bg: '#fee2e2', fg: '#991b1b' },
};
const PRIORITY_META = {
  low:    { label: 'Low',    bg: '#f1f5f9', fg: '#475569' },
  medium: { label: 'Medium', bg: '#fef3c7', fg: '#92400e' },
  high:   { label: 'High',   bg: '#fee2e2', fg: '#991b1b' },
};

export default function ObjectivesView() {
  const { profile } = useAuth();
  const [items, setItems] = useState([]);
  const [skills, setSkills] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [draft, setDraft] = useState(emptyDraft());
  const [loading, setLoading] = useState(true);

  function emptyDraft() {
    return { title: '', description: '', priority: 'medium', target_date: '', linked_skill_id: '' };
  }

  useEffect(() => {
    if (!profile?.id) return;
    (async () => {
      try {
        const [obj, sk] = await Promise.all([loadObjectives(profile.id), loadSkills()]);
        setItems(obj); setSkills(sk);
      } catch (e) { console.error(e); }
      setLoading(false);
    })();
  }, [profile?.id]);

  const submit = async () => {
    if (!draft.title.trim()) return;
    const row = {
      staff_id: profile.id,
      title: draft.title.trim(),
      description: draft.description.trim() || null,
      priority: draft.priority,
      target_date: draft.target_date || null,
      linked_skill_id: draft.linked_skill_id || null,
      status: 'open',
      progress_pct: 0,
    };
    try {
      const saved = await createObjective(row);
      setItems((p) => [saved, ...p]);
      setDraft(emptyDraft()); setShowForm(false);
    } catch (e) { console.error(e); }
  };

  const patch = async (id, p) => {
    try {
      const saved = await updateObjective(id, p);
      setItems((prev) => prev.map((i) => i.id === id ? saved : i));
    } catch (e) { console.error(e); }
  };

  const remove = async (id) => {
    if (!window.confirm('Delete this objective?')) return;
    try {
      await deleteObjective(id);
      setItems((prev) => prev.filter((i) => i.id !== id));
    } catch (e) { console.error(e); }
  };

  const open = items.filter((i) => i.status !== 'complete' && i.status !== 'abandoned');
  const closed = items.filter((i) => i.status === 'complete' || i.status === 'abandoned');

  return (
    <div style={{ padding: '32px 32px 80px', maxWidth: 980, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', flexWrap: 'wrap', gap: 16, marginBottom: 24 }}>
        <SectionTitle
          kicker="Objectives"
          title="What are you working towards?"
          hint="Set 3-5 objectives at a time. Make them specific and time-bound."
        />
        {!showForm && (
          <Button variant="accent" onClick={() => setShowForm(true)}>
            <Plus size={14} style={{ marginRight: 6, verticalAlign: 'text-bottom' }} />
            New objective
          </Button>
        )}
      </div>

      {showForm && (
        <Card style={{ marginBottom: 24 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div style={{ gridColumn: '1 / -1' }}>
              <label style={lblStyle}>Title</label>
              <Input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} placeholder="e.g. Lead 3 client onboarding meetings end-to-end" />
            </div>
            <div style={{ gridColumn: '1 / -1' }}>
              <label style={lblStyle}>Why does this matter?</label>
              <Textarea value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} placeholder="What does success look like?" />
            </div>
            <div>
              <label style={lblStyle}>Priority</label>
              <Select value={draft.priority} onChange={(e) => setDraft({ ...draft, priority: e.target.value })}>
                {Object.entries(PRIORITY_META).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
              </Select>
            </div>
            <div>
              <label style={lblStyle}>Target date</label>
              <Input type="date" value={draft.target_date} onChange={(e) => setDraft({ ...draft, target_date: e.target.value })} />
            </div>
            <div style={{ gridColumn: '1 / -1' }}>
              <label style={lblStyle}>Linked skill (optional)</label>
              <Select value={draft.linked_skill_id} onChange={(e) => setDraft({ ...draft, linked_skill_id: e.target.value })}>
                <option value="">— none —</option>
                {skills.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </Select>
            </div>
          </div>
          <div style={{ marginTop: 16, display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <Button variant="ghost" onClick={() => { setShowForm(false); setDraft(emptyDraft()); }}>Cancel</Button>
            <Button variant="primary" onClick={submit} disabled={!draft.title.trim()}>Save objective</Button>
          </div>
        </Card>
      )}

      {loading ? (
        <p style={{ fontFamily: FONT, color: '#94a3b8', textAlign: 'center', padding: 40 }}>Loading…</p>
      ) : items.length === 0 && !showForm ? (
        <EmptyState
          icon={<Target size={32} />}
          title="No objectives yet"
          hint="Click 'New objective' to set your first one."
        />
      ) : (
        <>
          {open.length > 0 && (
            <div style={{ marginBottom: 32 }}>
              <h3 style={{ fontFamily: FONT, fontSize: 12, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.08em', margin: '0 0 12px' }}>Active ({open.length})</h3>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {open.map((o) => (
                  <ObjectiveCard key={o.id} obj={o} skills={skills} onPatch={patch} onDelete={remove} />
                ))}
              </div>
            </div>
          )}
          {closed.length > 0 && (
            <div>
              <h3 style={{ fontFamily: FONT, fontSize: 12, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.08em', margin: '0 0 12px' }}>Closed ({closed.length})</h3>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {closed.map((o) => (
                  <ObjectiveCard key={o.id} obj={o} skills={skills} onPatch={patch} onDelete={remove} compact />
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

const lblStyle = {
  display: 'block', fontFamily: FONT, fontSize: 11, fontWeight: 600,
  color: '#475569', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.04em',
};

function ObjectiveCard({ obj, skills, onPatch, onDelete, compact }) {
  const meta = STATUS_META[obj.status];
  const pmeta = PRIORITY_META[obj.priority];
  const skill = skills.find((s) => s.id === obj.linked_skill_id);
  const days = obj.target_date
    ? Math.ceil((new Date(obj.target_date) - new Date()) / 86400000)
    : null;

  return (
    <Card style={{ padding: compact ? 14 : 18, opacity: compact ? 0.78 : 1 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 14 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontFamily: SERIF, fontSize: compact ? 15 : 17, fontWeight: 500, color: '#0f172a', marginBottom: 4 }}>
            {obj.title}
          </div>
          {obj.description && !compact && (
            <p style={{ fontFamily: FONT, fontSize: 13, color: '#64748b', margin: '4px 0 8px', lineHeight: 1.5 }}>
              {obj.description}
            </p>
          )}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 6 }}>
            <Pill bg={meta.bg} fg={meta.fg}>{meta.label}</Pill>
            <Pill bg={pmeta.bg} fg={pmeta.fg}>{pmeta.label} priority</Pill>
            {skill && <Pill bg="#ede9fe" fg="#5b21b6">{skill.name}</Pill>}
            {obj.target_date && (
              <span style={{ fontFamily: FONT, fontSize: 12, color: days != null && days < 0 ? '#dc2626' : '#64748b' }}>
                {new Date(obj.target_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                {days != null && obj.status !== 'complete' && (
                  <> &middot; {days >= 0 ? `${days}d to go` : `${-days}d overdue`}</>
                )}
              </span>
            )}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
          {obj.status !== 'complete' && (
            <button
              title="Mark complete"
              onClick={() => onPatch(obj.id, { status: 'complete', progress_pct: 100 })}
              style={iconBtn('#dcfce7', '#166534')}
            ><Check size={14} /></button>
          )}
          <button title="Delete" onClick={() => onDelete(obj.id)} style={iconBtn('#fee2e2', '#dc2626')}>
            <Trash2 size={14} />
          </button>
        </div>
      </div>

      {!compact && obj.status !== 'complete' && obj.status !== 'abandoned' && (
        <div style={{ marginTop: 14 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6, fontFamily: FONT, fontSize: 12, color: '#475569' }}>
            <span>Progress</span>
            <span style={{ fontWeight: 600 }}>{obj.progress_pct}%</span>
          </div>
          <ProgressBar value={obj.progress_pct} />
          <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
            {[0, 25, 50, 75, 100].map((v) => (
              <button
                key={v}
                onClick={() => onPatch(obj.id, { progress_pct: v, status: v === 100 ? 'complete' : v > 0 ? 'in_progress' : 'open' })}
                style={{
                  fontFamily: FONT, fontSize: 11, fontWeight: 600,
                  background: obj.progress_pct === v ? '#0f172a' : '#f1f5f9',
                  color: obj.progress_pct === v ? '#fff' : '#475569',
                  border: 'none', borderRadius: 999, padding: '4px 10px', cursor: 'pointer',
                }}
              >{v}%</button>
            ))}
          </div>
        </div>
      )}
    </Card>
  );
}

const iconBtn = (bg, fg) => ({
  background: bg, color: fg, border: 'none', borderRadius: 8, width: 30, height: 30,
  display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
});
