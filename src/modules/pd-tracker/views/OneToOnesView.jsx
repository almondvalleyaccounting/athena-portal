import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Trash2, MessageSquare, Check, CircleDot, Lock, NotebookPen, Pencil } from 'lucide-react';
import { useAuth } from '../../../shell/AppShell';
import { Card, SectionTitle, Button, Input, Textarea, Select, Pill, EmptyState, FONT, SERIF } from '../components/ui';
import {
  loadOneToOnes, createOneToOne, deleteOneToOne, updateOneToOne,
  loadActions, createAction, updateAction, deleteAction, loadStaff,
  loadOneToOneComments, addOneToOneComment, loadGrantsToMe,
  loadPrepNotes, markPrepNotesDiscussed, PREP_KINDS,
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
  const [editingId, setEditingId] = useState(null);
  const [draft, setDraft] = useState(emptyDraft());
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState(null);
  const [grantsToMe, setGrantsToMe] = useState([]);
  // My private prep notes for whoever is selected (never shown to them).
  const [prepNotes, setPrepNotes] = useState([]);
  const [agendaIds, setAgendaIds] = useState([]);

  useEffect(() => {
    if (!profile?.id) return;
    loadGrantsToMe(profile.id).then(setGrantsToMe).catch((e) => console.error(e));
  }, [profile?.id]);

  const accessibleStaff = useMemo(() => {
    if (isAdmin) return staff;
    const owners = new Set(grantsToMe.map((g) => g.owner_id));
    return staff.filter((s) => s.id === profile?.id || owners.has(s.id));
  }, [isAdmin, staff, grantsToMe, profile?.id]);

  function emptyDraft() {
    return {
      meeting_date: new Date().toISOString().slice(0, 10),
      manager_id: '', duration_mins: 30,
      what_went_well: '', what_didnt: '', blockers: '', notes: '', mood: 4,
      newActions: [{ action: '', due_date: '' }],
      // Only populated when editing a saved 1-2-1: the actions already on it.
      existingActions: [],
      removedActionIds: [],
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

  useEffect(() => {
    if (!selectedStaffId || !profile?.id) { setPrepNotes([]); return; }
    loadPrepNotes(profile.id, selectedStaffId)
      .then((rows) => setPrepNotes(rows.filter((n) => n.status === 'open')))
      .catch((e) => console.error(e));
  }, [selectedStaffId, profile?.id]);

  const viewingSelf = selectedStaffId === profile?.id;

  const addComment = async (meetingId, body) => {
    if (!body.trim()) return;
    try {
      const saved = await addOneToOneComment({ one_to_one_id: meetingId, author_id: profile.id, body: body.trim() });
      setComments((p) => [...p, saved]);
    } catch (e) { console.error(e); }
  };

  const closeForm = () => {
    setShowForm(false); setEditingId(null); setDraft(emptyDraft()); setAgendaIds([]);
  };

  const startEdit = (m) => {
    setEditingId(m.id);
    setExpandedId(null);
    setAgendaIds([]);
    setDraft({
      meeting_date: (m.meeting_date || '').slice(0, 10),
      manager_id: m.manager_id || '',
      duration_mins: m.duration_mins ?? '',
      what_went_well: m.what_went_well || '',
      what_didnt: m.what_didnt || '',
      blockers: m.blockers || '',
      notes: m.notes || '',
      mood: m.mood || 4,
      newActions: [{ action: '', due_date: '' }],
      existingActions: actions
        .filter((a) => a.one_to_one_id === m.id)
        .map((a) => ({ id: a.id, action: a.action || '', due_date: (a.due_date || '').slice(0, 10) })),
      removedActionIds: [],
    });
    setShowForm(true);
    window.scrollTo({ top: 0, behavior: 'smooth' });
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
    setSaving(true);
    try {
      let saved;
      if (editingId) {
        saved = await updateOneToOne(editingId, row);
        setMeetings((p) => p.map((m) => m.id === editingId ? saved : m)
          .sort((a, b) => (a.meeting_date < b.meeting_date ? 1 : -1)));

        // Actions removed in the form go for real (and take their quick task).
        for (const id of draft.removedActionIds) {
          try {
            await deleteAction(id);
            setActions((p) => p.filter((x) => x.id !== id));
          } catch (e) { console.error(e); }
        }
        // Wording / due date changes on the ones that stayed.
        for (const a of draft.existingActions) {
          const before = actions.find((x) => x.id === a.id);
          if (!before) continue;
          const text = a.action.trim();
          const due = a.due_date || null;
          if (!text || (text === before.action && due === (before.due_date || null))) continue;
          try {
            const updated = await updateAction(a.id, { action: text, due_date: due });
            setActions((p) => p.map((x) => x.id === a.id ? updated : x));
          } catch (e) { console.error(e); }
        }
      } else {
        saved = await createOneToOne(row);
        setMeetings((p) => [saved, ...p]);
      }

      const validActions = draft.newActions.filter((a) => a.action.trim());
      const createdActions = await Promise.all(validActions.map((a) => createAction({
        one_to_one_id: saved.id,
        staff_id: selectedStaffId,
        owner_id: selectedStaffId,
        action: a.action.trim(),
        due_date: a.due_date || null,
      })));
      if (createdActions.length) setActions((p) => [...createdActions, ...p]);
      // Prep notes ticked off as covered stop being agenda and get pinned to
      // this meeting. They stay private — nothing is copied into the record.
      if (agendaIds.length) {
        try {
          await markPrepNotesDiscussed(agendaIds, saved.id);
          setPrepNotes((p) => p.filter((n) => !agendaIds.includes(n.id)));
          setAgendaIds([]);
        } catch (e) { console.error(e); }
      }
      closeForm();
    } catch (e) { console.error(e); }
    setSaving(false);
  };

  const remove = async (id) => {
    if (!window.confirm('Delete this 1-2-1 record?')) return;
    try {
      await deleteOneToOne(id);
      setMeetings((p) => p.filter((m) => m.id !== id));
      setActions((p) => p.filter((a) => a.one_to_one_id !== id));
      if (editingId === id) closeForm();
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
          {accessibleStaff.length > 1 && (
            <Select value={selectedStaffId} onChange={(e) => { setSelectedStaffId(e.target.value); setExpandedId(null); closeForm(); }} style={{ minWidth: 180 }}>
              {accessibleStaff.map((s) => <option key={s.id} value={s.id}>{s.name}{s.id === profile?.id ? ' (you)' : ''}</option>)}
            </Select>
          )}
          <Link
            to="/team/pd/prep"
            title="Private notes only you can see"
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6, textDecoration: 'none',
              fontFamily: FONT, fontSize: 12.5, fontWeight: 600,
              color: prepNotes.length ? '#0e7fe0' : '#64748b',
              border: '1px solid ' + (prepNotes.length ? '#bfdbfe' : '#e5e7eb'),
              background: prepNotes.length ? '#eff6ff' : '#fff',
              borderRadius: 10, padding: '9px 14px',
            }}
          >
            <NotebookPen size={13} />
            {prepNotes.length ? `${prepNotes.length} prep note${prepNotes.length === 1 ? '' : 's'}` : 'My prep notes'}
          </Link>
          {!showForm && (
            <Button variant="accent" onClick={() => setShowForm(true)} style={{ whiteSpace: 'nowrap' }}>
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

      {showForm && prepNotes.length > 0 && (
        <Card style={{ marginBottom: 12, borderColor: '#e0e7ff', background: '#f8fafc' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <Lock size={13} color="#475569" />
            <div style={{ fontFamily: SERIF, fontSize: 17, color: '#0f172a' }}>Your private agenda ({prepNotes.length})</div>
          </div>
          <p style={{ fontFamily: FONT, fontSize: 12, color: '#64748b', margin: '0 0 12px' }}>
            Prep notes only you can see. Tick the ones you cover — they move to &ldquo;discussed&rdquo; against this meeting.
            Nothing here is copied into the shared record.
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {prepNotes.map((n) => {
              const ticked = agendaIds.includes(n.id);
              const kind = PREP_KINDS.find((k) => k.key === n.kind);
              return (
                <label key={n.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={ticked}
                    onChange={() => setAgendaIds((p) => ticked ? p.filter((x) => x !== n.id) : [...p, n.id])}
                    style={{ marginTop: 3, width: 15, height: 15, cursor: 'pointer', accentColor: '#0e7fe0' }}
                  />
                  <span style={{ flex: 1 }}>
                    <Pill bg={n.kind === 'work' ? '#eff6ff' : '#f5f3ff'} fg={n.kind === 'work' ? '#0e7fe0' : '#7c3aed'}>
                      {kind?.label || n.kind}
                    </Pill>
                    <span style={{ fontFamily: FONT, fontSize: 13, color: '#0f172a', marginLeft: 8, whiteSpace: 'pre-wrap' }}>{n.body}</span>
                    {n.link_label && (
                      <span style={{ fontFamily: FONT, fontSize: 11.5, color: '#94a3b8', display: 'block', marginTop: 2 }}>
                        re: {n.link_label}
                      </span>
                    )}
                  </span>
                </label>
              );
            })}
          </div>
        </Card>
      )}

      {showForm && (
        <Card style={{ marginBottom: 24 }}>
          <div style={{ fontFamily: SERIF, fontSize: 18, color: '#0f172a', marginBottom: 14 }}>
            {editingId ? 'Edit 1-2-1' : 'New 1-2-1'}
          </div>
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
                {draft.existingActions.map((a, idx) => (
                  <div key={a.id} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <Input
                      value={a.action}
                      onChange={(e) => {
                        const next = [...draft.existingActions]; next[idx] = { ...next[idx], action: e.target.value };
                        setDraft({ ...draft, existingActions: next });
                      }}
                    />
                    <Input type="date" style={{ width: 160 }} value={a.due_date}
                      onChange={(e) => {
                        const next = [...draft.existingActions]; next[idx] = { ...next[idx], due_date: e.target.value };
                        setDraft({ ...draft, existingActions: next });
                      }}
                    />
                    <button
                      title="Remove this action"
                      onClick={() => setDraft({
                        ...draft,
                        existingActions: draft.existingActions.filter((x) => x.id !== a.id),
                        removedActionIds: [...draft.removedActionIds, a.id],
                      })}
                      style={iconLink}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                ))}
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
                    {draft.existingActions.length > 0 && <span style={{ width: 21, flexShrink: 0 }} />}
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
            <Button variant="ghost" onClick={closeForm}>Cancel</Button>
            <Button variant="primary" onClick={submit} disabled={saving}>
              {saving ? 'Saving…' : editingId ? 'Save changes' : 'Save 1-2-1'}
            </Button>
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
                  <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                    <button title="Edit this 1-2-1" onClick={(e) => { e.stopPropagation(); startEdit(m); }} style={iconLink}>
                      <Pencil size={14} />
                    </button>
                    <button title="Delete this 1-2-1" onClick={(e) => { e.stopPropagation(); remove(m.id); }} style={iconLink}>
                      <Trash2 size={14} />
                    </button>
                  </div>
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
