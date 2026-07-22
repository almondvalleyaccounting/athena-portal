import React, { useEffect, useState } from 'react';
import { X, Star, Mail, Phone, MapPin, Linkedin, FileText, Send, ExternalLink } from 'lucide-react';
import { listNotes, addNote } from '../api';
import {
  font, iconBtn, input, fieldLabel, btn, backdrop,
  STAGES, EXIT_STAGES, STAGE_MAP, fmtDate, fmtNoteTime,
} from '../recruitmentShared';

// The application drawer — everything about one applicant on one vacancy:
// their details, a stage picker (incl. reject/withdraw), a 0–5 rating,
// assignment, and a running note thread.
export default function ApplicationDrawer({ app, staffMap, staffList, profileId, onClose, onPatch }) {
  const [notes, setNotes] = useState(null);
  const [noteDraft, setNoteDraft] = useState('');
  const [rejectReason, setRejectReason] = useState(app.rejected_reason || '');
  const c = app.candidate;

  useEffect(() => {
    let live = true;
    listNotes(app.id).then((n) => { if (live) setNotes(n); }).catch(() => setNotes([]));
    return () => { live = false; };
  }, [app.id]);

  async function submitNote() {
    const text = noteDraft.trim();
    if (!text) return;
    setNoteDraft('');
    const n = await addNote(app.id, text, profileId);
    if (n) setNotes((prev) => [...(prev || []), n]);
  }

  const stage = STAGE_MAP[app.stage] || STAGES[0];

  return (
    <div onClick={onClose} style={backdrop}>
      <div onClick={(e) => e.stopPropagation()}
        style={{
          position: 'fixed', top: 0, right: 0, bottom: 0, width: 500, maxWidth: '94vw',
          background: '#fff', boxShadow: '-16px 0 48px rgba(15,23,42,0.18)',
          display: 'flex', flexDirection: 'column', fontFamily: font,
        }}>
        <div style={{ padding: '16px 20px', borderBottom: '1px solid #f1f5f9', display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{
            fontSize: 10.5, fontWeight: 700, padding: '2px 9px', borderRadius: 999,
            background: stage.tone.bg, color: stage.tone.fg, border: `1px solid ${stage.tone.border}`,
            textTransform: 'uppercase', letterSpacing: 0.4,
          }}>{stage.label}</span>
          <span style={{ fontSize: 16, fontWeight: 700, color: '#0f172a', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {c?.full_name || 'Candidate (restricted)'}
          </span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer', display: 'flex' }}>
            <X size={17} />
          </button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px' }}>
          {!c && (
            <div style={{ fontSize: 12.5, color: '#b45309', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8, padding: '8px 10px', marginBottom: 14 }}>
              You don't have permission to see this applicant's details.
            </div>
          )}

          {c && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 16 }}>
              {c.email && <ContactRow icon={Mail} href={`mailto:${c.email}`}>{c.email}</ContactRow>}
              {c.phone && <ContactRow icon={Phone} href={`tel:${c.phone}`}>{c.phone}</ContactRow>}
              {c.location && <ContactRow icon={MapPin}>{c.location}</ContactRow>}
              {c.linkedin_url && <ContactRow icon={Linkedin} href={c.linkedin_url} external>LinkedIn profile</ContactRow>}
              {c.cv_url && <ContactRow icon={FileText} href={c.cv_url} external>View CV</ContactRow>}
            </div>
          )}

          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 16 }}>
            <div>
              <label style={fieldLabel}>Rating</label>
              <div style={{ display: 'inline-flex', gap: 2 }}>
                {[1, 2, 3, 4, 5].map((n) => (
                  <button key={n} onClick={() => onPatch({ rating: app.rating === n ? 0 : n })}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 1, display: 'flex' }}>
                    <Star size={18} fill={n <= (app.rating || 0) ? '#f59e0b' : 'none'} color={n <= (app.rating || 0) ? '#f59e0b' : '#cbd5e1'} />
                  </button>
                ))}
              </div>
            </div>
            <div style={{ minWidth: 150 }}>
              <label style={fieldLabel}>Assigned to</label>
              <select value={app.assigned_to || ''} onChange={(e) => onPatch({ assigned_to: e.target.value || null })} style={input}>
                <option value="">Unassigned</option>
                {staffList.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
          </div>

          <label style={fieldLabel}>Stage</label>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 4 }}>
            {STAGES.map((s) => (
              <StageBtn key={s.key} s={s} active={app.stage === s.key} onClick={() => onPatch({ stage: s.key })} />
            ))}
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {EXIT_STAGES.map((s) => (
              <StageBtn key={s.key} s={s} active={app.stage === s.key} onClick={() => onPatch({ stage: s.key })} />
            ))}
          </div>

          {app.stage === 'rejected' && (
            <div style={{ marginTop: 10 }}>
              <label style={fieldLabel}>Reason (optional)</label>
              <input value={rejectReason} onChange={(e) => setRejectReason(e.target.value)}
                onBlur={() => rejectReason !== (app.rejected_reason || '') && onPatch({ rejected_reason: rejectReason || null })}
                style={input} placeholder="Why not progressing" />
            </div>
          )}

          {app.cover_note && (
            <div style={{ marginTop: 16 }}>
              <label style={fieldLabel}>Cover note</label>
              <div style={{ fontSize: 12.5, color: '#334155', whiteSpace: 'pre-wrap', background: '#f8fafc', borderRadius: 8, padding: '8px 10px' }}>{app.cover_note}</div>
            </div>
          )}

          <div style={{ fontSize: 11.5, color: '#94a3b8', marginTop: 14 }}>
            Applied {fmtDate(app.applied_at)}{app.source ? ` · via ${app.source}` : ''}
          </div>

          <div style={{ marginTop: 18 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 8 }}>Notes</div>
            {notes === null && <div style={{ fontSize: 12.5, color: '#94a3b8' }}>Loading…</div>}
            {notes !== null && notes.length === 0 && <div style={{ fontSize: 12.5, color: '#94a3b8' }}>No notes yet.</div>}
            {(notes || []).map((n) => (
              <div key={n.id} style={{ padding: '7px 0', borderBottom: '1px solid #f8fafc', fontSize: 12.5, color: '#334155' }}>
                <div style={{ whiteSpace: 'pre-wrap' }}>{n.body}</div>
                <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2 }}>
                  {n.author_id ? (staffMap[n.author_id] || 'staff') : 'Athena'} · {fmtNoteTime(n.created_at)}
                </div>
              </div>
            ))}
            <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
              <input value={noteDraft} onChange={(e) => setNoteDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') submitNote(); }}
                placeholder="Add a note…" style={{ ...input, flex: 1 }} />
              <button onClick={submitNote} disabled={!noteDraft.trim()} style={{ ...btn('primary'), padding: '7px 12px' }}>
                <Send size={12} />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ContactRow({ icon: Icon, href, external, children }) {
  const inner = (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 13, color: href ? '#0e7fe0' : '#334155' }}>
      <Icon size={13} color="#94a3b8" /> {children}
      {external && <ExternalLink size={11} />}
    </span>
  );
  if (!href) return inner;
  return <a href={href} target={external ? '_blank' : undefined} rel="noreferrer" style={{ textDecoration: 'none' }}>{inner}</a>;
}

function StageBtn({ s, active, onClick }) {
  return (
    <button onClick={onClick}
      style={{
        padding: '6px 11px', fontSize: 12, fontWeight: 600, fontFamily: font, borderRadius: 8, cursor: 'pointer',
        background: active ? s.tone.bg : '#fff',
        color: active ? s.tone.fg : '#64748b',
        border: `1px solid ${active ? s.tone.border : '#e5e7eb'}`,
      }}>{s.label}</button>
  );
}
