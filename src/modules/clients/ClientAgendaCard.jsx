import React, { useCallback, useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, Check, ChevronDown, ChevronRight, Copy, Lock, Printer, RotateCcw, Trash2 } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { Btn } from '../../components/ui';

// Next meeting agenda (sql/301). A running list of things to raise with the
// client, in two buckets: "Next agenda" makes the agenda we hand them, "For
// info only" stays here as a standing note. Each item can carry private notes
// — staff-only, never printed on the client's agenda. Items are archived once
// discussed and can raise a Work Planner action.
//
// Reads are direct (RLS: active staff). Every write goes through the
// client-agenda edge function; the card refetches after each one.

const BUCKETS = [
  { id: 'agenda', label: 'Next agenda', empty: 'Nothing on the agenda yet.' },
  { id: 'info', label: 'For info only', empty: 'No standing notes.' },
];

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const dateLong = (d) => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
const dateShort = (d) => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

export default function ClientAgendaCard({ entity, staffList, profile, defaultAssignee, onActionRaised }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState('');
  const [draftBucket, setDraftBucket] = useState('agenda');
  const [showArchived, setShowArchived] = useState(false);
  const [copied, setCopied] = useState(false);

  const staffName = (sid) => staffList.find((s) => s.id === sid)?.name || null;

  const load = useCallback(async () => {
    const { data, error: err } = await supabase
      .from('client_agenda_items')
      .select('id, body, bucket, sort_order, created_by, created_at, archived_at, archived_by, action_task_id, action_title, action_raised_at, notes:client_agenda_notes(id, author_id, body, created_at)')
      .eq('entity_id', entity.id)
      .order('sort_order')
      .order('created_at');
    if (err) setError(err.message);
    else setItems((data || []).map((it) => ({ ...it, notes: (it.notes || []).sort((a, b) => a.created_at.localeCompare(b.created_at)) })));
    setLoading(false);
  }, [entity.id]);

  useEffect(() => { load(); }, [load]);

  const call = async (payload) => {
    setBusy(true);
    setError(null);
    const { data, error: err } = await supabase.functions.invoke('client-agenda', { body: payload });
    let msg = null;
    if (err || !data?.success) {
      msg = data?.error || 'Could not save';
      // A non-2xx comes back as err with the JSON body still unread.
      try { const j = await err?.context?.json?.(); if (j?.error) msg = j.error; } catch { /* body already read */ }
      setError(msg);
    }
    await load();
    setBusy(false);
    return msg ? null : data;
  };

  const live = items.filter((i) => !i.archived_at);
  const archived = items.filter((i) => i.archived_at).sort((a, b) => b.archived_at.localeCompare(a.archived_at));
  const inBucket = (b) => live.filter((i) => i.bucket === b);
  const agendaItems = inBucket('agenda');

  const addItem = async () => {
    const body = draft.trim();
    if (!body || busy) return;
    if (await call({ action: 'add_item', entity_id: entity.id, bucket: draftBucket, body })) setDraft('');
  };

  const reorder = (bucket, id, dir) => {
    const list = inBucket(bucket).map((i) => i.id);
    const at = list.indexOf(id);
    const to = at + dir;
    if (at < 0 || to < 0 || to >= list.length) return;
    [list[at], list[to]] = [list[to], list[at]];
    call({ action: 'reorder', entity_id: entity.id, bucket, ordered_ids: list });
  };

  // The client's copy: agenda items only, never the private notes.
  const agendaText = () => [
    `Meeting agenda — ${entity.name}`,
    dateLong(new Date()),
    '',
    ...agendaItems.map((it, i) => `${i + 1}. ${it.body}`),
  ].join('\n');

  const copyAgenda = async () => {
    try { await navigator.clipboard.writeText(agendaText()); setCopied(true); setTimeout(() => setCopied(false), 1600); } catch { /* clipboard blocked */ }
  };

  // withNotes=false is the client's agenda. withNotes=true is the briefing
  // sheet for whoever runs the meeting — marked as internal on every page.
  const print = (withNotes) => {
    const w = window.open('', '_blank');
    if (!w) return;
    const rows = agendaItems.map((it) => {
      const notes = withNotes && it.notes.length
        ? `<ul class="notes">${it.notes.map((n) => `<li>${escapeHtml(n.body)}<span> — ${escapeHtml(staffName(n.author_id) || 'Team')}, ${dateShort(n.created_at)}</span></li>`).join('')}</ul>`
        : '';
      return `<li><div class="item">${escapeHtml(it.body)}</div>${notes}</li>`;
    }).join('');
    const info = withNotes && inBucket('info').length
      ? `<h2>For info only</h2><ul class="info">${inBucket('info').map((it) => `<li>${escapeHtml(it.body)}${it.notes.length ? `<ul class="notes">${it.notes.map((n) => `<li>${escapeHtml(n.body)}</li>`).join('')}</ul>` : ''}</li>`).join('')}</ul>`
      : '';
    w.document.write(`<!doctype html><html><head><title>${escapeHtml(withNotes ? 'Meeting briefing' : 'Meeting agenda')} — ${escapeHtml(entity.name)}</title>
<style>
  body { font-family: 'Outfit', Arial, sans-serif; color: #0f172a; max-width: 720px; margin: 40px auto; padding: 0 24px; }
  h1 { font-size: 22px; margin: 0 0 4px; } .sub { color: #64748b; margin: 0 0 24px; }
  .banner { background: #fef3c7; color: #92400e; border: 1px solid #fcd34d; padding: 8px 12px; border-radius: 6px; font-weight: 700; margin-bottom: 20px; }
  ol > li { margin: 0 0 14px; font-size: 15px; } .item { font-weight: 500; }
  .notes { margin: 6px 0 0; padding-left: 18px; color: #475569; font-size: 13.5px; } .notes span { color: #94a3b8; }
  h2 { font-size: 15px; margin: 28px 0 8px; color: #475569; } .info li { margin-bottom: 8px; }
</style></head><body>
${withNotes ? '<div class="banner">Internal briefing — contains private notes. Do not share with the client.</div>' : ''}
<h1>Meeting agenda</h1><p class="sub">${escapeHtml(entity.name)} · ${dateLong(new Date())}</p>
${agendaItems.length ? `<ol>${rows}</ol>` : '<p>No agenda items.</p>'}
${info}
</body></html>`);
    w.document.close();
    w.focus();
    w.print();
  };

  return (
    <div style={cardStyle}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 6 }}>
        <h3 style={{ ...sectionTitle, marginBottom: 0 }}>Next meeting agenda ({agendaItems.length})</h3>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <SmallBtn onClick={copyAgenda} disabled={!agendaItems.length} title="Copy the agenda (no private notes) to paste into an email">
            {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? 'Copied' : 'Copy agenda'}
          </SmallBtn>
          <SmallBtn onClick={() => print(false)} disabled={!agendaItems.length} title="Print the client's agenda — no private notes">
            <Printer size={14} /> Agenda
          </SmallBtn>
          <SmallBtn onClick={() => print(true)} disabled={!agendaItems.length && !inBucket('info').length} title="Print a briefing for the meeting, with the private notes">
            <Lock size={13} /> Briefing
          </SmallBtn>
        </div>
      </div>
      <p style={{ fontSize: 13, color: '#64748b', margin: '0 0 12px' }}>
        Next agenda items make the client's agenda. For info only items stay here as notes. Private notes are for the team and never go on the agenda.
      </p>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 14 }}>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') addItem(); }}
          placeholder="Something to talk to the client about…"
          disabled={busy}
          style={{ ...inputStyle, flex: 1, minWidth: 220 }}
        />
        <select value={draftBucket} onChange={(e) => setDraftBucket(e.target.value)} aria-label="Add to" style={selectStyle}>
          {BUCKETS.map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}
        </select>
        <Btn onClick={addItem} disabled={!draft.trim() || busy}>Add</Btn>
      </div>

      {error && <div style={{ fontSize: 13, color: '#b91c1c', marginBottom: 10 }}>{error}</div>}
      {loading && <p style={emptyStyle}>Loading…</p>}

      {!loading && BUCKETS.map((b) => {
        const list = inBucket(b.id);
        return (
          <div key={b.id} style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: 0.3, textTransform: 'uppercase', color: b.id === 'agenda' ? '#1E4560' : '#64748b', margin: '4px 0 6px' }}>
              {b.label} · {list.length}
            </div>
            {list.length === 0 && <p style={{ ...emptyStyle, fontSize: 13 }}>{b.empty}</p>}
            {list.map((it, idx) => (
              <AgendaItem
                key={it.id}
                item={it}
                index={b.id === 'agenda' ? idx + 1 : null}
                first={idx === 0}
                last={idx === list.length - 1}
                busy={busy}
                call={call}
                onMove={(dir) => reorder(b.id, it.id, dir)}
                staffList={staffList}
                staffName={staffName}
                profile={profile}
                defaultAssignee={defaultAssignee}
                onActionRaised={onActionRaised}
              />
            ))}
          </div>
        );
      })}

      {!loading && archived.length > 0 && (
        <div style={{ borderTop: '1px solid #f1f5f9', paddingTop: 10 }}>
          <button onClick={() => setShowArchived((v) => !v)} style={linkBtn}>
            {showArchived ? <ChevronDown size={14} /> : <ChevronRight size={14} />} Discussed · {archived.length}
          </button>
          {showArchived && archived.map((it) => (
            <div key={it.id} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '7px 0', borderBottom: '1px solid #f8fafc' }}>
              <div style={{ flex: 1, minWidth: 0, fontSize: 13.5, color: '#64748b' }}>
                {it.body}
                <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 2 }}>
                  {it.bucket === 'agenda' ? 'Agenda' : 'Info'} · archived {dateShort(it.archived_at)}{staffName(it.archived_by) ? ` by ${staffName(it.archived_by)}` : ''}
                  {it.notes.length > 0 && ` · ${it.notes.length} private note${it.notes.length === 1 ? '' : 's'}`}
                  {it.action_title && ' · action raised'}
                </div>
              </div>
              <SmallBtn onClick={() => call({ action: 'restore', item_id: it.id })} disabled={busy} title="Put it back on the list">
                <RotateCcw size={13} /> Restore
              </SmallBtn>
              <SmallBtn onClick={() => { if (window.confirm('Delete this item permanently, with its private notes?')) call({ action: 'delete_item', item_id: it.id }); }} disabled={busy} title="Delete permanently">
                <Trash2 size={13} />
              </SmallBtn>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function AgendaItem({ item, index, first, last, busy, call, onMove, staffList, staffName, profile, defaultAssignee, onActionRaised }) {
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(item.body);
  const [notesOpen, setNotesOpen] = useState(false);
  const [noteDraft, setNoteDraft] = useState('');
  const [raising, setRaising] = useState(false);
  const [assignee, setAssignee] = useState(defaultAssignee || profile?.id || '');

  const saveEdit = async () => {
    const next = body.trim();
    setEditing(false);
    if (!next || next === item.body) { setBody(item.body); return; }
    await call({ action: 'edit_item', item_id: item.id, body: next });
  };
  const addNote = async () => {
    const b = noteDraft.trim();
    if (!b) return;
    if (await call({ action: 'add_note', item_id: item.id, body: b })) setNoteDraft('');
  };
  const raise = async () => {
    const res = await call({ action: 'raise_action', item_id: item.id, assignee_id: assignee || null });
    if (res) { setRaising(false); onActionRaised?.(); }
  };
  const remove = () => {
    const notes = item.notes.length ? ` Its ${item.notes.length} private note${item.notes.length === 1 ? '' : 's'} will go too.` : '';
    if (window.confirm(`Delete this item permanently?${notes}

If it was discussed, use Discussed instead to keep a record.`)) {
      call({ action: 'delete_item', item_id: item.id });
    }
  };
  const other = item.bucket === 'agenda' ? 'info' : 'agenda';

  return (
    <div style={{ border: '1px solid #f1f5f9', borderRadius: 10, padding: '9px 12px', marginBottom: 6, background: item.bucket === 'agenda' ? '#fff' : '#fafafa' }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
        {index != null && <span style={{ fontSize: 13.5, fontWeight: 700, color: '#1E4560', minWidth: 18, paddingTop: 1 }}>{index}.</span>}
        <div style={{ flex: 1, minWidth: 0 }}>
          {editing ? (
            <textarea
              autoFocus value={body} rows={2}
              onChange={(e) => setBody(e.target.value)}
              onBlur={saveEdit}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveEdit(); } if (e.key === 'Escape') { setBody(item.body); setEditing(false); } }}
              style={{ ...inputStyle, width: '100%', boxSizing: 'border-box', resize: 'vertical' }}
            />
          ) : (
            <div onClick={() => { setBody(item.body); setEditing(true); }} title="Click to edit" style={{ fontSize: 14, color: '#0f172a', cursor: 'text', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
              {item.body}
            </div>
          )}
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginTop: 4, fontSize: 12 }}>
            <span style={{ color: '#94a3b8' }}>{staffName(item.created_by) || 'Team'} · {dateShort(item.created_at)}</span>
            <button onClick={() => setNotesOpen((v) => !v)} style={{ ...linkBtn, fontSize: 12, color: item.notes.length ? '#92400e' : '#64748b' }}>
              <Lock size={11} /> {item.notes.length ? `${item.notes.length} private note${item.notes.length === 1 ? '' : 's'}` : 'Add private note'}
            </button>
            {item.action_title && (
              <span style={{ color: '#059669' }} title={item.action_title}>
                ✓ Action raised {item.action_raised_at ? dateShort(item.action_raised_at) : ''}{!item.action_task_id ? ' (done)' : ''}
              </span>
            )}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 2, alignItems: 'center', flexShrink: 0 }}>
          <IconBtn onClick={() => onMove(-1)} disabled={busy || first} title="Move up"><ArrowUp size={14} /></IconBtn>
          <IconBtn onClick={() => onMove(1)} disabled={busy || last} title="Move down"><ArrowDown size={14} /></IconBtn>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8, paddingLeft: index != null ? 28 : 0 }}>
        <SmallBtn onClick={() => call({ action: 'move', item_id: item.id, bucket: other })} disabled={busy}>
          {other === 'info' ? 'Move to info only' : 'Move to agenda'}
        </SmallBtn>
        <SmallBtn onClick={() => setRaising((v) => !v)} disabled={busy}>Create action</SmallBtn>
        <SmallBtn onClick={() => call({ action: 'archive', item_id: item.id })} disabled={busy} title="Discussed — take it off the list (kept under Discussed)">
          <Check size={13} /> Discussed
        </SmallBtn>
        <SmallBtn onClick={remove} disabled={busy} title="Delete — for a mistake or a test. Use Discussed to keep a record.">
          <Trash2 size={13} /> Delete
        </SmallBtn>
      </div>

      {raising && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 8, paddingLeft: index != null ? 28 : 0 }}>
          <span style={{ fontSize: 12.5, color: '#64748b' }}>Work Planner task, due in five days, for</span>
          <select value={assignee} onChange={(e) => setAssignee(e.target.value)} style={selectStyle}>
            {staffList.filter((s) => s.is_active !== false).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <Btn onClick={raise} disabled={busy}>Raise</Btn>
        </div>
      )}

      {notesOpen && (
        <div style={{ marginTop: 8, marginLeft: index != null ? 28 : 0, background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8, padding: '8px 10px' }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#92400e', letterSpacing: 0.3, textTransform: 'uppercase', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 4 }}>
            <Lock size={11} /> Private — team only, not on the agenda
          </div>
          {item.notes.map((n) => (
            <div key={n.id} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '4px 0', borderBottom: '1px solid #fef3c7' }}>
              <div style={{ flex: 1, minWidth: 0, fontSize: 13.5, color: '#422006', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                {n.body}
                <div style={{ fontSize: 11.5, color: '#a16207', marginTop: 1 }}>{staffName(n.author_id) || 'Team'} · {dateShort(n.created_at)}</div>
              </div>
              {n.author_id === profile?.id && (
                <IconBtn onClick={() => { if (window.confirm('Delete this private note?')) call({ action: 'delete_note', note_id: n.id }); }} disabled={busy} title="Delete your note">
                  <Trash2 size={13} />
                </IconBtn>
              )}
            </div>
          ))}
          <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
            <input
              value={noteDraft}
              onChange={(e) => setNoteDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') addNote(); }}
              placeholder="Private note for the meeting…"
              disabled={busy}
              style={{ ...inputStyle, flex: 1, fontSize: 13.5, padding: '6px 10px', background: '#fff' }}
            />
            <Btn variant="secondary" onClick={addNote} disabled={!noteDraft.trim() || busy}>Add note</Btn>
          </div>
        </div>
      )}
    </div>
  );
}

function SmallBtn({ children, ...rest }) {
  return (
    <button {...rest} style={{
      display: 'inline-flex', alignItems: 'center', gap: 5, padding: '4px 10px', fontSize: 12.5, fontWeight: 600,
      border: '1px solid #e5e7eb', borderRadius: 7, background: '#fff', color: '#1E4560',
      cursor: rest.disabled ? 'default' : 'pointer', opacity: rest.disabled ? 0.5 : 1, fontFamily: "'Outfit', sans-serif",
    }}>{children}</button>
  );
}

function IconBtn({ children, ...rest }) {
  return (
    <button {...rest} aria-label={rest.title} style={{
      display: 'inline-flex', padding: 4, border: 'none', background: 'none', borderRadius: 6,
      color: '#94a3b8', cursor: rest.disabled ? 'default' : 'pointer', opacity: rest.disabled ? 0.35 : 1,
    }}>{children}</button>
  );
}

const cardStyle = { background: '#fff', borderRadius: 12, border: '1px solid #e5e7eb', padding: '18px 22px' };
const sectionTitle = { fontFamily: "'Outfit', sans-serif", fontSize: 13, fontWeight: 600, color: '#94a3b8', marginBottom: 12, marginTop: 0 };
const emptyStyle = { fontSize: 14, color: '#94a3b8', margin: 0 };
const inputStyle = { padding: '9px 14px', fontSize: 14, border: '1px solid #e5e7eb', borderRadius: 10, outline: 'none', fontFamily: "'Outfit', sans-serif" };
const selectStyle = { padding: '8px 10px', fontSize: 13.5, border: '1px solid #e5e7eb', borderRadius: 8, outline: 'none', fontFamily: "'Outfit', sans-serif", background: '#fff' };
const linkBtn = { display: 'inline-flex', alignItems: 'center', gap: 4, background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: 13, fontWeight: 600, color: '#1E4560', fontFamily: "'Outfit', sans-serif" };
