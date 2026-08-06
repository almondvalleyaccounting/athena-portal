import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Lock, Plus, Trash2, Pin, PinOff, Check, ChevronDown, ChevronRight,
  Search, ExternalLink, NotebookPen, Archive, RotateCcw,
} from 'lucide-react';
import { useAuth } from '../../../shell/AppShell';
import { Card, SectionTitle, Button, Input, Textarea, Select, Pill, EmptyState, FONT, SERIF } from '../components/ui';
import {
  loadStaff, loadPrepNotes, createPrepNote, updatePrepNote, deletePrepNote,
  loadWorkFeed, PREP_KINDS, WORK_FEED_SOURCES,
} from '../lib/api';

// Private prep space: the notes I build up between 1-2-1s. Nobody else can
// read these — RLS on pd_prep_notes is author_id = auth.uid() (sql/183).
export default function PrepView() {
  const { profile } = useAuth();
  const [staff, setStaff] = useState([]);
  const [subjectId, setSubjectId] = useState('');
  const [notes, setNotes] = useState([]);
  const [feed, setFeed] = useState([]);
  const [loadingNotes, setLoadingNotes] = useState(false);
  const [loadingFeed, setLoadingFeed] = useState(false);
  const [showDiscussed, setShowDiscussed] = useState(false);

  useEffect(() => {
    loadStaff()
      .then((s) => {
        setStaff(s);
        setSubjectId((cur) => cur || s.find((x) => x.id !== profile?.id)?.id || profile?.id || '');
      })
      .catch((e) => console.error(e));
  }, [profile?.id]);

  useEffect(() => {
    if (!subjectId || !profile?.id) return;
    setLoadingNotes(true);
    loadPrepNotes(profile.id, subjectId)
      .then(setNotes)
      .catch((e) => console.error(e))
      .finally(() => setLoadingNotes(false));
  }, [subjectId, profile?.id]);

  useEffect(() => {
    if (!subjectId) return;
    setLoadingFeed(true);
    loadWorkFeed(subjectId)
      .then(setFeed)
      .catch((e) => console.error(e))
      .finally(() => setLoadingFeed(false));
  }, [subjectId]);

  const subject = staff.find((s) => s.id === subjectId);
  const subjectName = subject?.id === profile?.id ? 'yourself' : (subject?.name || '—');

  const add = async (payload) => {
    try {
      const saved = await createPrepNote({
        author_id: profile.id,
        subject_id: subjectId,
        ...payload,
      });
      setNotes((p) => [saved, ...p]);
    } catch (e) { console.error(e); }
  };

  const patch = async (id, p) => {
    try {
      const saved = await updatePrepNote(id, p);
      setNotes((prev) => prev.map((n) => (n.id === id ? saved : n)));
    } catch (e) { console.error(e); }
  };

  const remove = async (id) => {
    if (!window.confirm('Delete this note?')) return;
    try {
      await deletePrepNote(id);
      setNotes((p) => p.filter((n) => n.id !== id));
    } catch (e) { console.error(e); }
  };

  const open = notes.filter((n) => n.status === 'open');
  const parked = notes.filter((n) => n.status === 'parked');
  const discussed = notes.filter((n) => n.status === 'discussed');

  return (
    <div style={{ padding: '32px 32px 80px', maxWidth: 1180, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', flexWrap: 'wrap', gap: 16, marginBottom: 18 }}>
        <SectionTitle
          kicker="1-2-1 prep"
          title="My private notes"
          hint="Build the agenda as the month goes on — work points on one side, development on the other."
        />
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <span style={{ fontFamily: FONT, fontSize: 12, color: '#64748b' }}>Preparing for</span>
          <Select value={subjectId} onChange={(e) => setSubjectId(e.target.value)} style={{ minWidth: 190 }}>
            {staff.map((s) => (
              <option key={s.id} value={s.id}>{s.name}{s.id === profile?.id ? ' (you)' : ''}</option>
            ))}
          </Select>
        </div>
      </div>

      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, marginBottom: 22,
        background: '#f8fafc', border: '1px solid #e5e7eb', borderRadius: 12, padding: '10px 14px',
      }}>
        <Lock size={14} color="#475569" />
        <span style={{ fontFamily: FONT, fontSize: 12.5, color: '#475569' }}>
          <strong style={{ color: '#0f172a' }}>Only you can see these notes.</strong>{' '}
          {subject?.id === profile?.id
            ? 'Notes you keep on yourself are private to you too.'
            : `${subject?.name || 'They'} cannot see them anywhere in Athena — not on their 1-2-1s, not on their dashboard.`}
          {' '}Anything you want to share goes in the 1-2-1 record itself.
        </span>
      </div>

      {/* Two note columns */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 24 }}>
        {PREP_KINDS.map((k) => (
          <NoteColumn
            key={k.key}
            kind={k}
            notes={open.filter((n) => n.kind === k.key)}
            subjectName={subjectName}
            onAdd={(body) => add({ kind: k.key, body })}
            onPatch={patch}
            onDelete={remove}
            loading={loadingNotes}
          />
        ))}
      </div>

      {parked.length > 0 && (
        <Card style={{ marginBottom: 24, background: '#fafafa' }}>
          <div style={{ fontFamily: FONT, fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: '#94a3b8', marginBottom: 10 }}>
            Parked ({parked.length})
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {parked.map((n) => (
              <NoteRow key={n.id} note={n} onPatch={patch} onDelete={remove} />
            ))}
          </div>
        </Card>
      )}

      {discussed.length > 0 && (
        <Card style={{ marginBottom: 24 }}>
          <button
            onClick={() => setShowDiscussed((v) => !v)}
            style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8 }}
          >
            {showDiscussed ? <ChevronDown size={14} color="#94a3b8" /> : <ChevronRight size={14} color="#94a3b8" />}
            <span style={{ fontFamily: FONT, fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: '#94a3b8' }}>
              Already discussed ({discussed.length})
            </span>
          </button>
          {showDiscussed && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
              {discussed.map((n) => (
                <NoteRow key={n.id} note={n} onPatch={patch} onDelete={remove} />
              ))}
            </div>
          )}
        </Card>
      )}

      <WorkFeedPanel
        feed={feed}
        loading={loadingFeed}
        subjectName={subject?.name || ''}
        notes={notes}
        onNote={(item, kind, body) => add({
          kind,
          body,
          link_source: item.source,
          link_ref_id: item.ref_id,
          link_label: [item.client_name, item.title].filter(Boolean).join(' · '),
          link_url: item.url || null,
        })}
      />
    </div>
  );
}

// ── Note capture ───────────────────────────────────────────────────────────

function NoteColumn({ kind, notes, subjectName, onAdd, onPatch, onDelete, loading }) {
  const [text, setText] = useState('');
  const accent = kind.key === 'work' ? '#0e7fe0' : '#7c3aed';
  const tint = kind.key === 'work' ? '#eff6ff' : '#f5f3ff';

  const submit = () => {
    if (!text.trim()) return;
    onAdd(text.trim());
    setText('');
  };

  return (
    <Card style={{ padding: 18, display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 4 }}>
        <div style={{ fontFamily: SERIF, fontSize: 18, color: '#0f172a' }}>{kind.label}</div>
        <Pill bg={tint} fg={accent}>{notes.length} open</Pill>
      </div>
      <p style={{ fontFamily: FONT, fontSize: 12, color: '#94a3b8', margin: '0 0 12px' }}>{kind.hint}</p>

      <Textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={`Note about ${subjectName}…  (⌘/Ctrl + Enter to save)`}
        style={{ minHeight: 62, fontSize: 13 }}
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(); }}
      />
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
        <Button variant="accent" onClick={submit} disabled={!text.trim()} style={{ padding: '7px 14px' }}>
          <Plus size={13} style={{ marginRight: 5, verticalAlign: 'text-bottom' }} />Add
        </Button>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 14 }}>
        {loading && <div style={{ fontFamily: FONT, fontSize: 12, color: '#94a3b8' }}>Loading…</div>}
        {!loading && notes.length === 0 && (
          <div style={{ fontFamily: FONT, fontSize: 12.5, color: '#cbd5e1', padding: '10px 0' }}>
            Nothing noted yet.
          </div>
        )}
        {notes.map((n) => (
          <NoteRow key={n.id} note={n} accent={accent} onPatch={onPatch} onDelete={onDelete} />
        ))}
      </div>
    </Card>
  );
}

function NoteRow({ note, accent = '#0e7fe0', onPatch, onDelete }) {
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(note.body);
  const done = note.status === 'discussed';

  const save = () => {
    const next = body.trim();
    setEditing(false);
    if (next && next !== note.body) onPatch(note.id, { body: next });
    else setBody(note.body);
  };

  return (
    <div style={{
      border: '1px solid ' + (note.pinned ? '#fde68a' : '#f1f5f9'),
      background: note.pinned ? '#fffbeb' : '#fff',
      borderRadius: 10, padding: '10px 12px',
      opacity: done ? 0.65 : 1,
    }}>
      {note.link_label && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
          <Pill bg="#f1f5f9" fg="#64748b">{sourceLabel(note.link_source)}</Pill>
          {note.link_url ? (
            <Link to={note.link_url} style={{ fontFamily: FONT, fontSize: 11.5, color: '#0e7fe0', textDecoration: 'none' }}>
              {note.link_label} <ExternalLink size={10} style={{ verticalAlign: 'baseline' }} />
            </Link>
          ) : (
            <span style={{ fontFamily: FONT, fontSize: 11.5, color: '#64748b' }}>{note.link_label}</span>
          )}
        </div>
      )}

      {editing ? (
        <Textarea
          value={body}
          autoFocus
          onChange={(e) => setBody(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save(); if (e.key === 'Escape') { setBody(note.body); setEditing(false); } }}
          style={{ minHeight: 56, fontSize: 13 }}
        />
      ) : (
        <div
          onClick={() => !done && setEditing(true)}
          style={{
            fontFamily: FONT, fontSize: 13, color: '#0f172a', lineHeight: 1.5,
            whiteSpace: 'pre-wrap', cursor: done ? 'default' : 'text',
            textDecoration: done ? 'line-through' : 'none',
          }}
        >{note.body}</div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 8 }}>
        <span style={{ fontFamily: FONT, fontSize: 10.5, color: '#cbd5e1', flex: 1 }}>
          {new Date(note.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
          {done && note.discussed_at && ` · discussed ${new Date(note.discussed_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`}
        </span>
        {note.status === 'open' && (
          <>
            <IconBtn title={note.pinned ? 'Unpin' : 'Pin to top'} onClick={() => onPatch(note.id, { pinned: !note.pinned })}>
              {note.pinned ? <PinOff size={12} /> : <Pin size={12} />}
            </IconBtn>
            <IconBtn title="Mark discussed" onClick={() => onPatch(note.id, { status: 'discussed', discussed_at: new Date().toISOString() })} colour={accent}>
              <Check size={13} />
            </IconBtn>
            <IconBtn title="Park for later" onClick={() => onPatch(note.id, { status: 'parked' })}>
              <Archive size={12} />
            </IconBtn>
          </>
        )}
        {note.status !== 'open' && (
          <IconBtn title="Move back to open" onClick={() => onPatch(note.id, { status: 'open', discussed_at: null })}>
            <RotateCcw size={12} />
          </IconBtn>
        )}
        <IconBtn title="Delete" onClick={() => onDelete(note.id)}><Trash2 size={12} /></IconBtn>
      </div>
    </div>
  );
}

function IconBtn({ children, onClick, title, colour = '#94a3b8' }) {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{ background: 'none', border: 'none', cursor: 'pointer', color: colour, padding: 4, lineHeight: 0 }}
    >{children}</button>
  );
}

// ── What's on their plate ──────────────────────────────────────────────────

function WorkFeedPanel({ feed, loading, subjectName, notes, onNote }) {
  const [source, setSource] = useState('all');
  const [q, setQ] = useState('');
  const [expandedId, setExpandedId] = useState(null);
  const [onlyOverdue, setOnlyOverdue] = useState(false);

  const counts = useMemo(() => {
    const c = {};
    for (const r of feed) c[r.source] = (c[r.source] || 0) + 1;
    return c;
  }, [feed]);

  // Which feed items I've already written a note against.
  const noted = useMemo(() => {
    const m = {};
    for (const n of notes) {
      if (!n.link_ref_id) continue;
      m[n.link_ref_id] = (m[n.link_ref_id] || 0) + 1;
    }
    return m;
  }, [notes]);

  const today = new Date().toISOString().slice(0, 10);
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return feed.filter((r) => {
      if (source !== 'all' && r.source !== source) return false;
      if (onlyOverdue && !(r.due_date && r.due_date < today)) return false;
      if (!needle) return true;
      return [r.title, r.client_name, r.service, r.status].some((v) => v && String(v).toLowerCase().includes(needle));
    });
  }, [feed, source, q, onlyOverdue, today]);

  const availableSources = WORK_FEED_SOURCES.filter((s) => counts[s.key]);

  return (
    <Card>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12, marginBottom: 14 }}>
        <div>
          <div style={{ fontFamily: SERIF, fontSize: 18, color: '#0f172a' }}>
            What&rsquo;s on {subjectName ? `${subjectName}'s` : 'their'} plate
          </div>
          <p style={{ fontFamily: FONT, fontSize: 12, color: '#94a3b8', margin: '4px 0 0' }}>
            Live from across Athena. Expand a row, then note anything you want to raise — the note stays private and links back here.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <div style={{ position: 'relative' }}>
            <Search size={13} color="#cbd5e1" style={{ position: 'absolute', left: 10, top: 11 }} />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search…" style={{ paddingLeft: 30, width: 200, fontSize: 13 }} />
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 14 }}>
        <FilterChip active={source === 'all'} onClick={() => setSource('all')}>All ({feed.length})</FilterChip>
        {availableSources.map((s) => (
          <FilterChip key={s.key} active={source === s.key} onClick={() => setSource(s.key)}>
            {s.label} ({counts[s.key]})
          </FilterChip>
        ))}
        <FilterChip active={onlyOverdue} onClick={() => setOnlyOverdue((v) => !v)} danger>
          Past deadline
        </FilterChip>
      </div>

      {loading ? (
        <div style={{ fontFamily: FONT, fontSize: 13, color: '#94a3b8', padding: 20, textAlign: 'center' }}>Loading their work…</div>
      ) : rows.length === 0 ? (
        <EmptyState icon={<NotebookPen size={28} />} title="Nothing to show" hint="No live work matches this filter." />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', border: '1px solid #f1f5f9', borderRadius: 10, overflow: 'hidden' }}>
          {rows.slice(0, 300).map((r) => (
            <FeedRow
              key={`${r.source}:${r.ref_id}`}
              row={r}
              today={today}
              noteCount={noted[r.ref_id] || 0}
              expanded={expandedId === `${r.source}:${r.ref_id}`}
              onToggle={() => setExpandedId(expandedId === `${r.source}:${r.ref_id}` ? null : `${r.source}:${r.ref_id}`)}
              onNote={onNote}
            />
          ))}
          {rows.length > 300 && (
            <div style={{ fontFamily: FONT, fontSize: 12, color: '#94a3b8', padding: '10px 14px', background: '#fafafa' }}>
              Showing the first 300 of {rows.length} — narrow it with a filter or search.
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

function FeedRow({ row, today, expanded, onToggle, onNote, noteCount }) {
  const [draft, setDraft] = useState('');
  const [kind, setKind] = useState('work');
  const overdue = row.due_date && row.due_date < today;

  const save = () => {
    if (!draft.trim()) return;
    onNote(row, kind, draft.trim());
    setDraft('');
  };

  return (
    <div style={{ borderBottom: '1px solid #f8fafc' }}>
      <div
        onClick={onToggle}
        style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 14px', cursor: 'pointer', background: expanded ? '#f8fafc' : '#fff' }}
      >
        {expanded ? <ChevronDown size={13} color="#94a3b8" /> : <ChevronRight size={13} color="#cbd5e1" />}
        <span style={{ width: 92, flexShrink: 0 }}>
          <Pill bg="#f1f5f9" fg="#64748b">{row.source_label}</Pill>
        </span>
        <span style={{ fontFamily: FONT, fontSize: 13, color: '#0f172a', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {row.client_name && <strong style={{ fontWeight: 600 }}>{row.client_name} · </strong>}
          {row.title}
        </span>
        {noteCount > 0 && (
          <span title={`${noteCount} note${noteCount === 1 ? '' : 's'}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 3, color: '#0e7fe0', fontFamily: FONT, fontSize: 11, fontWeight: 700 }}>
            <NotebookPen size={11} />{noteCount}
          </span>
        )}
        {row.status && (
          <span style={{ fontFamily: FONT, fontSize: 11.5, color: '#64748b', flexShrink: 0 }}>{row.status}</span>
        )}
        {row.due_date && (
          <span style={{ fontFamily: FONT, fontSize: 11.5, color: overdue ? '#dc2626' : '#94a3b8', width: 70, textAlign: 'right', flexShrink: 0 }}>
            {new Date(row.due_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' })}
          </span>
        )}
      </div>

      {expanded && (
        <div style={{ padding: '4px 14px 14px 40px', background: '#f8fafc' }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, marginBottom: 10 }}>
            {Object.entries(row.detail || {})
              // Drop empties and "no" flags — only the facts worth a glance.
              .filter(([, v]) => v !== null && v !== undefined && v !== '' && v !== false)
              .map(([k, v]) => (
                <div key={k}>
                  <div style={{ fontFamily: FONT, fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: '#94a3b8' }}>
                    {k.replace(/_/g, ' ')}
                  </div>
                  <div style={{ fontFamily: FONT, fontSize: 12.5, color: '#0f172a' }}>{v === true ? 'Yes' : String(v)}</div>
                </div>
              ))}
            {row.url && (
              <Link to={row.url} style={{ fontFamily: FONT, fontSize: 12, color: '#0e7fe0', textDecoration: 'none', alignSelf: 'flex-end' }}>
                Open in Athena <ExternalLink size={11} style={{ verticalAlign: 'baseline' }} />
              </Link>
            )}
          </div>

          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
            <Select value={kind} onChange={(e) => setKind(e.target.value)} style={{ width: 140, fontSize: 13, padding: '8px 10px' }}>
              {PREP_KINDS.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}
            </Select>
            <Input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Private note on this item…"
              style={{ fontSize: 13 }}
              onKeyDown={(e) => { if (e.key === 'Enter') save(); }}
            />
            <Button variant="accent" onClick={save} disabled={!draft.trim()} style={{ padding: '8px 14px', flexShrink: 0 }}>Note</Button>
          </div>
        </div>
      )}
    </div>
  );
}

function FilterChip({ children, active, onClick, danger }) {
  const on = danger ? '#dc2626' : '#0e7fe0';
  return (
    <button
      onClick={onClick}
      style={{
        fontFamily: FONT, fontSize: 12, fontWeight: 600,
        padding: '5px 12px', borderRadius: 999, cursor: 'pointer',
        border: '1px solid ' + (active ? on : '#e5e7eb'),
        background: active ? (danger ? '#fef2f2' : '#eff6ff') : '#fff',
        color: active ? on : '#64748b',
      }}
    >{children}</button>
  );
}

function sourceLabel(key) {
  return WORK_FEED_SOURCES.find((s) => s.key === key)?.label || key;
}
