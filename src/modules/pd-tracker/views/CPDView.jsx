import React, { useEffect, useMemo, useState } from 'react';
import { Plus, Trash2, BookOpen, ExternalLink } from 'lucide-react';
import { useAuth } from '../../../shell/AppShell';
import { Card, SectionTitle, Button, Input, Textarea, Select, Pill, EmptyState, FONT, SERIF, Stat } from '../components/ui';
import { loadCpd, createCpd, deleteCpd, loadSkills } from '../lib/api';

const TYPE_META = {
  course:      { label: 'Course',      bg: '#dbeafe', fg: '#1e40af', emoji: '🎓' },
  reading:     { label: 'Reading',     bg: '#fef3c7', fg: '#92400e', emoji: '📚' },
  webinar:     { label: 'Webinar',     bg: '#ede9fe', fg: '#5b21b6', emoji: '💻' },
  conference:  { label: 'Conference',  bg: '#fce7f3', fg: '#9d174d', emoji: '🎤' },
  on_the_job:  { label: 'On the job',  bg: '#dcfce7', fg: '#166534', emoji: '🛠️' },
  mentoring:   { label: 'Mentoring',   bg: '#ffedd5', fg: '#9a3412', emoji: '🤝' },
  other:       { label: 'Other',       bg: '#f1f5f9', fg: '#475569', emoji: '✨' },
};

const ANNUAL_TARGET_HOURS = 40; // typical CPD target — purely informational

export default function CPDView() {
  const { profile } = useAuth();
  const [items, setItems] = useState([]);
  const [skills, setSkills] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [draft, setDraft] = useState(emptyDraft());
  const [loading, setLoading] = useState(true);

  function emptyDraft() {
    return {
      entry_date: new Date().toISOString().slice(0, 10),
      title: '', provider: '', type: 'course',
      hours: '', reflection: '', evidence_url: '', linked_skill_id: '',
    };
  }

  useEffect(() => {
    if (!profile?.id) return;
    (async () => {
      try {
        const [c, s] = await Promise.all([loadCpd(profile.id), loadSkills()]);
        setItems(c); setSkills(s);
      } catch (e) { console.error(e); }
      setLoading(false);
    })();
  }, [profile?.id]);

  const ytdHours = useMemo(() => {
    const yr = new Date().getFullYear();
    return items
      .filter((i) => new Date(i.entry_date).getFullYear() === yr)
      .reduce((acc, i) => acc + Number(i.hours || 0), 0);
  }, [items]);

  const last30Hours = useMemo(() => {
    const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 30);
    return items
      .filter((i) => new Date(i.entry_date) >= cutoff)
      .reduce((acc, i) => acc + Number(i.hours || 0), 0);
  }, [items]);

  const byType = useMemo(() => {
    const map = {};
    items.forEach((i) => { map[i.type] = (map[i.type] || 0) + Number(i.hours || 0); });
    return map;
  }, [items]);

  const last12Months = useMemo(() => {
    const months = [];
    const now = new Date();
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      months.push({ key: `${d.getFullYear()}-${d.getMonth()}`, label: d.toLocaleDateString('en-GB', { month: 'short' }), hours: 0 });
    }
    items.forEach((i) => {
      const d = new Date(i.entry_date);
      const key = `${d.getFullYear()}-${d.getMonth()}`;
      const m = months.find((x) => x.key === key);
      if (m) m.hours += Number(i.hours || 0);
    });
    return months;
  }, [items]);

  const submit = async () => {
    if (!draft.title.trim() || !Number(draft.hours)) return;
    const row = {
      staff_id: profile.id,
      entry_date: draft.entry_date,
      title: draft.title.trim(),
      provider: draft.provider.trim() || null,
      type: draft.type,
      hours: Number(draft.hours),
      reflection: draft.reflection.trim() || null,
      evidence_url: draft.evidence_url.trim() || null,
      linked_skill_id: draft.linked_skill_id || null,
    };
    try {
      const saved = await createCpd(row);
      setItems((p) => [saved, ...p]);
      setDraft(emptyDraft()); setShowForm(false);
    } catch (e) { console.error(e); }
  };

  const remove = async (id) => {
    if (!window.confirm('Delete this CPD entry?')) return;
    try {
      await deleteCpd(id);
      setItems((p) => p.filter((i) => i.id !== id));
    } catch (e) { console.error(e); }
  };

  return (
    <div style={{ padding: '32px 32px 80px', maxWidth: 1100, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', flexWrap: 'wrap', gap: 16, marginBottom: 24 }}>
        <SectionTitle
          kicker="CPD log"
          title="Continuous Professional Development"
          hint="Log courses, reading, webinars, mentoring — anything that grew you. Don't underestimate on-the-job learning."
        />
        {!showForm && (
          <Button variant="accent" onClick={() => setShowForm(true)}>
            <Plus size={14} style={{ marginRight: 6, verticalAlign: 'text-bottom' }} />
            Log CPD
          </Button>
        )}
      </div>

      {/* stats row */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 14, marginBottom: 24 }}>
        <Stat label="YTD hours" value={ytdHours.toFixed(1)} sub={`Target ${ANNUAL_TARGET_HOURS}h`} accent="#0e7fe0" />
        <Stat label="Last 30 days" value={last30Hours.toFixed(1)} sub="hours logged" />
        <Stat label="Entries" value={items.length} sub="all-time" />
        <Stat label="On track" value={`${Math.min(100, Math.round((ytdHours / ANNUAL_TARGET_HOURS) * 100))}%`} sub="of annual target" accent="#16a34a" />
      </div>

      {/* monthly bar chart */}
      <Card style={{ marginBottom: 24 }}>
        <div style={{ fontFamily: SERIF, fontSize: 18, color: '#0f172a', marginBottom: 14 }}>Last 12 months</div>
        <BarChart months={last12Months} />
      </Card>

      {showForm && (
        <Card style={{ marginBottom: 24 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
            <div style={{ gridColumn: '1 / -1' }}>
              <label style={lblStyle}>What did you do?</label>
              <Input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} placeholder="e.g. ICAS R&D tax webinar" />
            </div>
            <div>
              <label style={lblStyle}>Date</label>
              <Input type="date" value={draft.entry_date} onChange={(e) => setDraft({ ...draft, entry_date: e.target.value })} />
            </div>
            <div>
              <label style={lblStyle}>Type</label>
              <Select value={draft.type} onChange={(e) => setDraft({ ...draft, type: e.target.value })}>
                {Object.entries(TYPE_META).map(([k, v]) => <option key={k} value={k}>{v.emoji} {v.label}</option>)}
              </Select>
            </div>
            <div>
              <label style={lblStyle}>Hours</label>
              <Input type="number" step="0.25" value={draft.hours} onChange={(e) => setDraft({ ...draft, hours: e.target.value })} placeholder="1.5" />
            </div>
            <div>
              <label style={lblStyle}>Provider</label>
              <Input value={draft.provider} onChange={(e) => setDraft({ ...draft, provider: e.target.value })} placeholder="ICAEW, Xero, etc." />
            </div>
            <div>
              <label style={lblStyle}>Linked skill (optional)</label>
              <Select value={draft.linked_skill_id} onChange={(e) => setDraft({ ...draft, linked_skill_id: e.target.value })}>
                <option value="">— none —</option>
                {skills.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </Select>
            </div>
            <div>
              <label style={lblStyle}>Evidence URL</label>
              <Input value={draft.evidence_url} onChange={(e) => setDraft({ ...draft, evidence_url: e.target.value })} placeholder="https://..." />
            </div>
            <div style={{ gridColumn: '1 / -1' }}>
              <label style={lblStyle}>Reflection — what will you do differently?</label>
              <Textarea value={draft.reflection} onChange={(e) => setDraft({ ...draft, reflection: e.target.value })} />
            </div>
          </div>
          <div style={{ marginTop: 16, display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <Button variant="ghost" onClick={() => { setShowForm(false); setDraft(emptyDraft()); }}>Cancel</Button>
            <Button variant="primary" onClick={submit} disabled={!draft.title.trim() || !Number(draft.hours)}>Save entry</Button>
          </div>
        </Card>
      )}

      {loading ? (
        <p style={{ fontFamily: FONT, color: '#94a3b8', textAlign: 'center', padding: 40 }}>Loading…</p>
      ) : items.length === 0 ? (
        <EmptyState icon={<BookOpen size={32} />} title="No CPD logged yet" hint="Start by logging your most recent learning." />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {items.map((i) => {
            const meta = TYPE_META[i.type];
            const skill = skills.find((s) => s.id === i.linked_skill_id);
            return (
              <Card key={i.id} style={{ padding: 16 }}>
                <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
                  <div style={{
                    width: 44, height: 44, borderRadius: 12, background: meta.bg,
                    display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20, flexShrink: 0,
                  }}>{meta.emoji}</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
                      <div style={{ fontFamily: SERIF, fontSize: 16, fontWeight: 500, color: '#0f172a' }}>{i.title}</div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                        <span style={{ fontFamily: FONT, fontSize: 13, fontWeight: 700, color: '#0e7fe0' }}>{Number(i.hours).toFixed(1)}h</span>
                        <button onClick={() => remove(i.id)} style={{
                          background: 'none', border: 'none', cursor: 'pointer', color: '#cbd5e1', padding: 4,
                        }} onMouseEnter={(e) => e.currentTarget.style.color = '#dc2626'} onMouseLeave={(e) => e.currentTarget.style.color = '#cbd5e1'}>
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 8, marginTop: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                      <Pill bg={meta.bg} fg={meta.fg}>{meta.label}</Pill>
                      {skill && <Pill bg="#ede9fe" fg="#5b21b6">{skill.name}</Pill>}
                      <span style={{ fontFamily: FONT, fontSize: 12, color: '#94a3b8' }}>
                        {new Date(i.entry_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                        {i.provider && <> &middot; {i.provider}</>}
                      </span>
                      {i.evidence_url && (
                        <a href={i.evidence_url} target="_blank" rel="noreferrer" style={{
                          display: 'inline-flex', alignItems: 'center', gap: 4,
                          fontFamily: FONT, fontSize: 12, color: '#0e7fe0', textDecoration: 'none',
                        }}>Evidence <ExternalLink size={11} /></a>
                      )}
                    </div>
                    {i.reflection && (
                      <p style={{ fontFamily: FONT, fontSize: 13, color: '#475569', margin: '8px 0 0', lineHeight: 1.5, fontStyle: 'italic' }}>
                        "{i.reflection}"
                      </p>
                    )}
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

const lblStyle = {
  display: 'block', fontFamily: FONT, fontSize: 11, fontWeight: 600,
  color: '#475569', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.04em',
};

function BarChart({ months }) {
  const max = Math.max(1, ...months.map((m) => m.hours));
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, height: 140, paddingBottom: 22, position: 'relative' }}>
      {months.map((m) => {
        const h = (m.hours / max) * 110;
        return (
          <div key={m.key} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', position: 'relative' }}>
            <div style={{ position: 'absolute', top: -16, fontFamily: FONT, fontSize: 10, fontWeight: 600, color: m.hours > 0 ? '#0f172a' : '#cbd5e1' }}>
              {m.hours > 0 ? m.hours.toFixed(1) : ''}
            </div>
            <div style={{
              width: '70%', height: Math.max(2, h),
              background: m.hours > 0 ? 'linear-gradient(180deg, #38bdf8, #0e7fe0)' : '#f1f5f9',
              borderRadius: 6, transition: 'height 0.3s',
            }} />
            <div style={{ position: 'absolute', bottom: -22, fontFamily: FONT, fontSize: 11, color: '#64748b' }}>{m.label}</div>
          </div>
        );
      })}
    </div>
  );
}
