import React, { useEffect, useMemo, useState } from 'react';
import { Plus, Trash2, MessageSquare, Check, CircleDot } from 'lucide-react';
import { useAuth } from '../../../shell/AppShell';
import { Card, SectionTitle, Button, Input, Textarea, Select, Pill, EmptyState, FONT, SERIF } from '../components/ui';
import {
  loadOneToOnes, createOneToOne, deleteOneToOne, updateOneToOne,
  loadActions, createAction, updateAction, deleteAction, loadStaff,
  loadOneToOneComments, addOneToOneComment,
} from '../lib/api';

const MOOD_EMOJI = { 1: '😞', 2: '😕', 3: '😐', 4: '🙂', 5: '😄' };

export default function OneToOnesView() {
  const { profile } = useAuth();
  const isAdmin = profile?.can_manage_portal === true || profile?.is_portal_admin === true;
  const [selectedStaffId, setSelectedStaffId] = useState(profile?.id);
  const [meetings, setMeetings] = useState([]);
  const [actions, setActions] = useState([]);
  const [comments, setComments] = useState([]);
  const [staff, setStaff] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [draft, setDraft] = useState(emptyDraft());
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState(null);

  function emptyDraft() {
    return {
      meeting_date: new Date().toISOString().slice(0, 10),
      manager_id: '', duration_mins: 30,
      what_went_well: '', what_didnt: '', blockers: '', notes: '', mood: 4,
      newActions: [{ action: '', due_date: '' }],
    };
  }

  useEffect(() => {
    if (!selectedStaffId) return;
    setLoading(true);
    (async () => {
      try {
        const [m, a, s] = await Promise.all([
          loadOneToOnes(selectedStaffId),
          loadActions(selectedStaffId),
          loadStaff(),
        ]);
        setMeetings(m); setActions(a); setStaff(s);
        setComments(await loadOneToOneComments(m.map((x) => x.id)));
      } catch (e) { console.error(e); }
      setLoading(false);
    })();
  }, [selectedStaffId]);

  const viewingSelf = selectedStaffId === profile?.id;

  const addComment = async (meetingId, body) => {
    if (!body.trim()) return;
    try {
      const saved = await addOneToOneComment({ one_to_one_id: meetingId, author_id: profile.id, body: body.trim() });
      setComments((p) => [...p, saved]);
    } catch (e) { console.error(e); }
  };

  const submit = async () => {
    const row = {
      staff_id: selectedStaffId,
      manager_id: draft.manager_id || null,
      meeting_date: draft.meeting_date,
      duration_mins: Number(draft.duration_mins) || null,
      what_went_well: draft.what_went_well.trim() || null,
      what_didnt: draft.what_didnt.trim() || null,
      blockers: draft.blockers.trim() || null,
      notes: draft.notes.trim() || null,
      mood: Number(draft.mood) || null,
    };
    try {
      const saved = await createOneToOne(row);
      setMeetings((p) => [saved, ...p]);
      const validActions = draft.newActions.filter((a) => a.action.trim());
      const createdActions = await Promise.all(validActions.map((a) => createAction({
        one_to_one_id: saved.id,
        staff_id: selectedStaffId,
        owner_id: selectedStaffId,
        action: a.action.trim(),
        due_date: a.due_date || null,
      })));
      if (createdActions.length) setActions((p) => [...createdActions, ...p]);
      setDraft(emptyDraft()); setShowForm(false);
    } catch (e) { console.error(e); }
  };

  const remove = async (id) => {
    if (!window.confirm('Delete this 1-2-1 record?')) return;
    try {
      await deleteOneToOne(id);
      setMeetings((p) => p.filter((m) => m.id !== id));
      setActions((p) => p.filter((a) => a.one_to_one_id !== id));
    } catch (e) { console.error(e); }
  };

  const toggleAction = async (a) => {
    const next = a.status === 'done' ? 'open' : 'done';
    try {
      const saved = await updateAction(a.id, { status: next, completed_at: next === 'done' ? new Date().toISOString() : null });
      setActions((p) => p.map((x) => x.id === a.id ? saved : x));
    } catch (e) { console.error(e); }
  };

  const removeAction = async (id) => {
    try {
      await deleteAction(id);
      setActions((p) => p.filter((x) => x.id !== id));
    } catch (e) { console.error(e); }
  };

  const openActions = useMemo(() => actions.filter((a) => a.status === 'open'), [actions]);
  const totalMinutes = useMemo(() => meetings.reduce((acc, m) => acc + (m.duration_mins || 0), 0), [meetings]);

  return (
    <div style={{ padding: '32px 32px 80px', maxWidth: 1080, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', flexWrap: 'wrap', gap: 16, marginBottom: 24 }}>
        <SectionTitle
          kicker="1-2-1s"
          title="Meeting notes & actions"
          hint="Capture what was discussed, how you felt, and what you'll do next."
        />
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          {isAdmin && staff.length > 0 && (
            <Select value={selectedStaffId} onChange={(e) => { setSelectedStaffId(e.target.value); setExpandedId(null); setShowForm(false); }} style={{ minWidth: 180 }}>
              {staff.map((s) => <option key={s.id} value={s.id}>{s.name}{s.id === profile?.id ? ' (you)' : ''}</option>)}
            </Select>
          )}
          {!showForm && (
            <Button variant="accent" onClick={() => setShowForm(true)}>
              <Plus size={14} style={{ marginRight: 6, verticalAlign: 'text-bottom' }} />
              New 1-2-1
            </Button>
          )}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 14, marginBottom: 24 }}>
        <Card>
          <div style={kickerStyle}>1-2-1s logged</div>
          <div style={bigNum}>{meetings.length}</div>
        </Card>
        <Card>
          <div style={kickerStyle}>Total minutes</div>
          <div style={bigNum}>{totalMinutes}</div>
        </Card>
        <Card>
          <div style={kickerStyle}>Open actions</div>
          <div style={{ ...bigNum, color: openActions.length > 0 ? '#dc2626' : '#16a34a' }}>{openActions.length}</div>
        </Card>
      </div>

      {/* Open actions sticky panel */}
      {openActions.length > 0 && (
        <Card style={{ marginBottom: 24, borderColor: '#fde68a', background: '#fffbeb' }}>
          <div style={{ fontFamily: SERIF, fontSize: 18, color: '#0f172a', marginBottom: 12 }}>Open actions ({openActions.length})</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {openActions.map((a) => {
              const overdue = a.due_date && new Date(a.due_date) < new Date();
              return (
                <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0' }}>
                  <button onClick={() => toggleAction(a)} title="Mark done" style={{
                    width: 22, height: 22, borderRadius: '50%', border: '2px solid #cbd5e1', background: '#fff',
                    cursor: 'pointer', flexShrink: 0,
                  }} />
                  <span style={{ fontFamily: FONT, fontSize: 13, color: '#0f172a', flex: 1 }}>{a.action}</span>
                  {a.due_date && (
                    <span style={{ fontFamily: FONT, fontSize: 11, color: overdue ? '#dc2626' : '#94a3b8' }}>
                      {new Date(a.due_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                    </span>
                  )}
                  <button onClick={() => removeAction(a.id)} style={iconLink}>
                    <Trash2 size={12} />
                  </button>
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {showForm && (
        <Card style={{ marginBottom: 24 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
            <div>
              <label style={lblStyle}>Date</label>
              <Input type="date" value={draft.meeting_date} onChange={(e) => setDraft({ ...draft, meeting_date: e.target.value })} />
            </div>
            <div>
              <label style={lblStyle}>Manager / partner</label>
              <Select value={draft.manager_id} onChange={(e) => setDraft({ ...draft, manager_id: e.target.value })}>
                <option value="">— select —</option>
                {staff.filter((s) => s.id !== selectedStaffId).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </Select>
            </div>
            <div>
              <label style={lblStyle}>Duration (mins)</label>
              <Input type="number" value={draft.duration_mins} onChange={(e) => setDraft({ ...draft, duration_mins: e.target.value })} />
            </div>

            <div style={{ gridColumn: '1 / -1' }}>
              <label style={lblStyle}>How are you feeling?</label>
              <div style={{ display: 'flex', gap: 8 }}>
                {[1,2,3,4,5].map((v) => (
                  <button
                    key={v}
                    onClick={() => setDraft({ ...draft, mood: v })}
                    style={{
                      width: 48, height: 48, borderRadius: 12, fontSize: 24,
                      background: draft.mood === v ? '#dbeafe' : '#f8fafc',
                      border: draft.mood === v ? '2px solid #38bdf8' : '1px solid #e5e7eb',
                      cursor: 'pointer',
                    }}
                  >{MOOD_EMOJI[v]}</button>
                ))}
              </div>
            </div>

            <div style={{ gridColumn: '1 / -1' }}>
              <label style={lblStyle}>What went well?</label>
              <Textarea value={draft.what_went_well} onChange={(e) => setDraft({ ...draft, what_went_well: e.target.value })} />
            </div>
            <div style={{ gridColumn: '1 / -1' }}>
              <label style={lblStyle}>What didn't go so well?</label>
              <Textarea value={draft.what_didnt} onChange={(e) => setDraft({ ...draft, what_didnt: e.target.value })} />
            </div>
            <div style={{ gridColumn: '1 / -1' }}>
              <label style={lblStyle}>Blockers / where do you need help?</label>
              <Textarea value={draft.blockers} onChange={(e) => setDraft({ ...draft, blockers: e.target.value })} />
            </div>
            <div style={{ gridColumn: '1 / -1' }}>
              <label style={lblStyle}>Other notes</label>
              <Textarea value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} />
            </div>

            <div style={{ gridColumn: '1 / -1' }}>
              <label style={lblStyle}>Actions agreed</label>
              <p style={{ fontFamily: FONT, fontSize: 11, color: '#94a3b8', margin: '-2px 0 8px' }}>
                Each action is also added to the work planner as a Quick Task for the owner.
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {draft.newActions.map((a, idx) => (
                  <div key={idx} style={{ display: 'flex', gap: 8 }}>
                    <Input
                      value={a.action}
                      onChange={(e) => {
                        const next = [...draft.newActions]; next[idx] = { ...next[idx], action: e.target.value };
                        setDraft({ ...draft, newActions: next });
                      }}
                      placeholder="Action…"
                    />
                    <Input type="date" style={{ width: 160 }} value={a.due_date}
                      onChange={(e) => {
                        const next = [...draft.newActions]; next[idx] = { ...next[idx], due_date: e.target.value };
                        setDraft({ ...draft, newActions: next });
                      }}
                    />
                  </div>
                ))}
                <button onClick={() => setDraft({ ...draft, newActions: [...draft.newActions, { action: '', due_date: '' }] })} style={{
                  fontFamily: FONT, fontSize: 12, color: '#0e7fe0', background: 'none', border: 'none', cursor: 'pointer',
                  textAlign: 'left', padding: '4px 0',
                }}>
                  + Add another action
                </button>
              </div>
            </div>
          </div>
          <div style={{ marginTop: 16, display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <Button variant="ghost" onClick={() => { setShowForm(false); setDraft(emptyDraft()); }}>Cancel</Button>
            <Button variant="primary" onClick={submit}>Save 1-2-1</Button>
          </div>
        </Card>
      )}

      {loading ? (
        <p style={{ fontFamily: FONT, color: '#94a3b8', textAlign: 'center', padding: 40 }}>Loading…</p>
      ) : meetings.length === 0 && !showForm ? (
        <EmptyState icon={<MessageSquare size={32} />} title="No 1-2-1s recorded yet" hint="Capture your next one to start the trail." />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {meetings.map((m) => {
            const mgr = staff.find((s) => s.id === m.manager_id);
            const meetingActions = actions.filter((a) => a.one_to_one_id === m.id);
            const expanded = expandedId === m.id;
            return (
              <Card key={m.id} style={{ padding: 16 }}>
                <div onClick={() => setExpandedId(expanded ? null : m.id)} style={{ cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    {m.mood && <span style={{ fontSize: 24 }}>{MOOD_EMOJI[m.mood]}</span>}
                    <div>
                      <div style={{ fontFamily: SERIF, fontSize: 16, color: '#0f172a' }}>
                        {new Date(m.meeting_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}
                      </div>
                      <div style={{ fontFamily: FONT, fontSize: 12, color: '#64748b', marginTop: 2 }}>
                        {mgr ? `with ${mgr.name}` : 'no manager set'}
                        {m.duration_mins && ` · ${m.duration_mins} mins`}
                        {meetingActions.length > 0 && ` · ${meetingActions.length} action${meetingActions.length === 1 ? '' : 's'}`}
                      </div>
                    </div>
                  </div>
                  <button onClick={(e) => { e.stopPropagation(); remove(m.id); }} style={iconLink}>
                    <Trash2 size={14} />
                  </button>
                </div>
                {expanded && (
                  <div style={{ marginTop: 16, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
                    {m.what_went_well && <Field label="What went well" value={m.what_went_well} bg="#dcfce7" />}
                    {m.what_didnt && <Field label="What didn't" value={m.what_didnt} bg="#fee2e2" />}
                    {m.blockers && <Field label="Blockers" value={m.blockers} bg="#fef3c7" />}
                    {m.notes && <Field label="Notes" value={m.notes} bg="#f1f5f9" />}
                    {meetingActions.length > 0 && (
                      <div style={{ gridColumn: '1 / -1' }}>
                        <div style={lblStyle}>Actions</div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                          {meetingActions.map((a) => (
                            <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                              <button onClick={() => toggleAction(a)} style={{
                                width: 18, height: 18, borderRadius: '50%',
                                border: a.status === 'done' ? 'none' : '2px solid #cbd5e1',
                                background: a.status === 'done' ? '#16a34a' : '#fff',
                                cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                                color: '#fff', flexShrink: 0,
                              }}>
                                {a.status === 'done' && <Check size={11} strokeWidth={3} />}
                              </button>
                              <span style={{ fontFamily: FONT, fontSize: 13, color: '#0f172a', textDecoration: a.status === 'done' ? 'line-through' : 'none', opacity: a.status === 'done' ? 0.6 : 1 }}>
                                {a.action}
                              </span>
                              {a.due_date && <span style={{ fontFamily: FONT, fontSize: 11, color: '#94a3b8' }}>{new Date(a.due_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</span>}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    <div style={{ gridColumn: '1 / -1' }}>
                      <CommentThread
                        meeting={m}
                        comments={comments.filter((c) => c.one_to_one_id === m.id)}
                        onAdd={(body) => addComment(m.id, body)}
                      />
                    </div>
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

function CommentThread({ meeting, comments, onAdd }) {
  const [text, setText] = useState('');
  return (
    <div style={{ marginTop: 4, borderTop: '1px solid #f1f5f9', paddingTop: 12 }}>
      <div style={lblStyle}>360° feedback &amp; comments</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 10 }}>
        {comments.length === 0 && <div style={{ fontFamily: FONT, fontSize: 12, color: '#94a3b8' }}>No comments yet — the individual, their manager, or anyone with access can add one.</div>}
        {comments.map((c) => {
          const isSubject = c.author_id === meeting.staff_id;
          return (
            <div key={c.id} style={{
              alignSelf: isSubject ? 'flex-start' : 'flex-end', maxWidth: '82%',
              background: isSubject ? '#f8fafc' : '#eff6ff',
              border: '1px solid ' + (isSubject ? '#e5e7eb' : '#dbeafe'),
              borderRadius: 10, padding: '8px 12px',
            }}>
              <div style={{ fontFamily: FONT, fontSize: 11, fontWeight: 700, color: isSubject ? '#475569' : '#0e7fe0', marginBottom: 2 }}>
                {c.author?.name || 'Someone'}{isSubject ? ' · self' : ''}
                <span style={{ fontWeight: 400, color: '#94a3b8', marginLeft: 6 }}>
                  {new Date(c.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                </span>
              </div>
              <div style={{ fontFamily: FONT, fontSize: 13, color: '#0f172a', lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{c.body}</div>
            </div>
          );
        })}
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="Add a comment…"
          onKeyDown={(e) => { if (e.key === 'Enter' && text.trim()) { onAdd(text); setText(''); } }} />
        <Button variant="primary" onClick={() => { if (text.trim()) { onAdd(text); setText(''); } }}>Post</Button>
      </div>
    </div>
  );
}

function Field({ label, value, bg }) {
  return (
    <div style={{ background: bg, padding: 12, borderRadius: 10 }}>
      <div style={{ fontFamily: FONT, fontSize: 11, fontWeight: 700, color: '#0f172a', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 4 }}>{label}</div>
      <div style={{ fontFamily: FONT, fontSize: 13, color: '#1e293b', lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{value}</div>
    </div>
  );
}

const lblStyle = {
  display: 'block', fontFamily: FONT, fontSize: 11, fontWeight: 600,
  color: '#475569', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.04em',
};
const kickerStyle = {
  fontFamily: FONT, fontSize: 11, fontWeight: 700, letterSpacing: '0.06em',
  textTransform: 'uppercase', color: '#94a3b8', marginBottom: 6,
};
const bigNum = { fontFamily: SERIF, fontSize: 30, fontWeight: 500, color: '#0f172a', lineHeight: 1 };
const iconLink = {
  background: 'none', border: 'none', cursor: 'pointer', color: '#cbd5e1', padding: 4,
};
