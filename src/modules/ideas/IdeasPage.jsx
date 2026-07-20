import React, { useState, useEffect } from 'react';
import { ThumbsUp, Plus, Lightbulb } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../shell/AppShell';

const STATUS_OPTIONS = [
  { key: 'new',         label: 'New',          bg: '#f1f5f9', fg: '#475569' },
  { key: 'planned',     label: 'Planned',      bg: '#dbeafe', fg: '#1e40af' },
  { key: 'in_progress', label: 'In progress',  bg: '#fef3c7', fg: '#78350f' },
  { key: 'more_info',   label: 'Needs info',   bg: '#ede9fe', fg: '#5b21b6' },
  { key: 'implemented', label: 'Implemented',  bg: '#cffafe', fg: '#155e75' },
  { key: 'completed',   label: 'Completed',    bg: '#dcfce7', fg: '#166534' },
  { key: 'rejected',    label: 'Rejected',     bg: '#fee2e2', fg: '#991b1b' },
  // Legacy values kept so pre-existing rows still render with a sensible label.
  { key: 'done',        label: 'Completed',    bg: '#dcfce7', fg: '#166534', legacy: true },
  { key: 'wont_do',     label: 'Rejected',     bg: '#fee2e2', fg: '#991b1b', legacy: true },
];
const STATUS_MAP = Object.fromEntries(STATUS_OPTIONS.map((s) => [s.key, s]));

// Statuses that require the admin to attach a comment before saving.
const COMMENT_STATUSES = {
  rejected:  { label: 'Rejection reason', placeholder: 'Why is this being rejected? (visible to the submitter)' },
  more_info: { label: 'Question for the submitter', placeholder: 'What do you need to know before deciding?' },
};

/* ─── Ideas module ─────────────────────────────────────────────── */
export default function IdeasPage() {
  const { profile } = useAuth();
  const [ideas, setIdeas] = useState([]);
  const [newIdea, setNewIdea] = useState('');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [editText, setEditText] = useState('');
  // Comment-required status change in progress: { ideaId, status }
  const [pendingComment, setPendingComment] = useState(null);
  const [commentText, setCommentText] = useState('');
  const [savingComment, setSavingComment] = useState(false);
  // Submitter replying to a "needs info" request
  const [replyForId, setReplyForId] = useState(null);
  const [replyText, setReplyText] = useState('');
  const [savingReply, setSavingReply] = useState(false);

  // ── Load ideas ──
  useEffect(() => {
    loadIdeas();
  }, []);

  const loadIdeas = async () => {
    try {
      const { data, error } = await supabase
        .from('ideas')
        .select('*')
        .order('votes', { ascending: false })
        .order('created_at', { ascending: false });

      if (!error && data) {
        setIdeas(data);
      }
    } catch {
      // Silently fail — table may not exist yet
    }
    setLoading(false);
  };

  // ── Submit new idea ──
  const handleSubmit = async () => {
    if (!newIdea.trim() || submitting) return;
    setSubmitting(true);

    try {
      const { error } = await supabase.from('ideas').insert({
        text: newIdea.trim(),
        submitted_by: profile?.id,
        submitted_by_name: profile?.full_name || profile?.name || profile?.email || 'Unknown',
        votes: 0,
      });

      if (!error) {
        setNewIdea('');
        await loadIdeas();
      }
    } catch {
      // Silent
    }
    setSubmitting(false);
  };

  // ── Vote tracking (one vote per user per idea) ──
  const getVotedKey = (ideaId) => `athena_idea_vote_${profile?.id}_${ideaId}`;
  const hasVoted = (ideaId) => localStorage.getItem(getVotedKey(ideaId)) === '1';

  const handleVote = async (idea) => {
    if (hasVoted(idea.id)) return; // already voted
    try {
      const { error } = await supabase
        .from('ideas')
        .update({ votes: (idea.votes || 0) + 1 })
        .eq('id', idea.id);

      if (!error) {
        localStorage.setItem(getVotedKey(idea.id), '1');
        setIdeas((prev) =>
          prev
            .map((i) =>
              i.id === idea.id ? { ...i, votes: (i.votes || 0) + 1 } : i
            )
            .sort((a, b) => (b.votes || 0) - (a.votes || 0))
        );
      }
    } catch {
      // Silent
    }
  };

  // ── Delete idea ──
  const handleDelete = async (idea) => {
    if (!window.confirm(`Delete idea "${idea.text.slice(0, 50)}..."?`)) return;
    try {
      const { error } = await supabase.from('ideas').delete().eq('id', idea.id);
      if (!error) setIdeas((prev) => prev.filter((i) => i.id !== idea.id));
    } catch { /* silent */ }
  };

  // ── Change status ──
  const canManageStatus = profile?.can_manage_portal === true || profile?.is_portal_admin === true;
  const adminName = profile?.full_name || profile?.name || profile?.email || 'Admin';

  const handleStatusChange = async (idea, newStatus) => {
    // Rejection / info-request need a comment — open the inline editor first.
    if (COMMENT_STATUSES[newStatus]) {
      setPendingComment({ ideaId: idea.id, status: newStatus });
      setCommentText(idea.admin_comment || '');
      return;
    }
    try {
      const { error } = await supabase
        .from('ideas')
        .update({ status: newStatus })
        .eq('id', idea.id);
      if (!error) {
        setIdeas((prev) => prev.map((i) => i.id === idea.id ? { ...i, status: newStatus } : i));
      }
    } catch { /* silent */ }
  };

  // Save a rejection reason / info request together with the status change.
  const handleSaveComment = async (idea) => {
    if (!pendingComment || !commentText.trim() || savingComment) return;
    setSavingComment(true);
    const nowIso = new Date().toISOString();
    const patch = {
      status: pendingComment.status,
      admin_comment: commentText.trim(),
      admin_comment_by: adminName,
      admin_comment_at: nowIso,
    };
    try {
      const { error } = await supabase.from('ideas').update(patch).eq('id', idea.id);
      if (!error) {
        // Tell the submitter — a question they never see is a dead idea.
        if (idea.submitted_by) {
          const label = pendingComment.status === 'rejected' ? 'was declined' : 'has a question for you';
          supabase.rpc('notify_staff', {
            p_recipient: idea.submitted_by, p_kind: 'idea_reply',
            p_title: `Your idea ${label}: ${(idea.text || '').slice(0, 80)}`, p_link: '/ideas',
          }).then(({ error: nErr }) => { if (nErr) console.error('[Ideas] notify', nErr); });
        }
        setIdeas((prev) => prev.map((i) => i.id === idea.id ? { ...i, ...patch } : i));
        setPendingComment(null);
        setCommentText('');
      }
    } catch { /* silent */ }
    setSavingComment(false);
  };

  // Submitter's reply to an information request.
  const handleSaveReply = async (idea) => {
    if (!replyText.trim() || savingReply) return;
    setSavingReply(true);
    const nowIso = new Date().toISOString();
    const patch = { submitter_response: replyText.trim(), submitter_response_at: nowIso };
    try {
      const { error } = await supabase.from('ideas').update(patch).eq('id', idea.id);
      if (!error) {
        // admin_comment_by is a name, not an id — notify the admins group.
        supabase.from('staff_profiles').select('id')
          .or('can_manage_portal.eq.true,is_portal_admin.eq.true')
          .then(({ data: admins }) => {
            for (const a of admins || []) {
              supabase.rpc('notify_staff', {
                p_recipient: a.id, p_kind: 'idea_reply',
                p_title: `${idea.submitted_by_name || 'A submitter'} replied on an idea: ${(idea.text || '').slice(0, 80)}`,
                p_link: '/ideas',
              }).then(({ error: nErr }) => { if (nErr) console.error('[Ideas] notify', nErr); });
            }
          });
        setIdeas((prev) => prev.map((i) => i.id === idea.id ? { ...i, ...patch } : i));
        setReplyForId(null);
        setReplyText('');
      }
    } catch { /* silent */ }
    setSavingReply(false);
  };

  // ── Edit idea ──
  const handleEdit = async (idea) => {
    if (!editText.trim() || editText.trim() === idea.text) { setEditingId(null); return; }
    try {
      const { error } = await supabase
        .from('ideas')
        .update({ text: editText.trim() })
        .eq('id', idea.id);
      if (!error) {
        setIdeas((prev) => prev.map((i) => i.id === idea.id ? { ...i, text: editText.trim() } : i));
      }
    } catch { /* silent */ }
    setEditingId(null);
  };

  return (
    <div style={{ maxWidth: '720px', margin: '0 auto', padding: '40px 24px' }}>
      {/* Header */}
      <div style={{ marginBottom: '32px' }}>
        <h1
          style={{
            fontFamily: "'Playfair Display', serif",
            fontSize: '28px',
            fontWeight: 500,
            color: '#0f172a',
            marginBottom: '8px',
          }}
        >
          Ideas
        </h1>
        <p
          style={{
            fontFamily: "'Outfit', sans-serif",
            fontSize: '14px',
            color: '#64748b',
          }}
        >
          Suggest improvements, new features, or anything that would make our
          work better. Vote on ideas you like.
        </p>
      </div>

      {/* Submit new idea */}
      <div
        style={{
          display: 'flex',
          gap: '12px',
          marginBottom: '32px',
        }}
      >
        <input
          value={newIdea}
          onChange={(e) => setNewIdea(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
          placeholder="I think we should..."
          disabled={submitting}
          style={{
            flex: 1,
            border: '1px solid #e5e7eb',
            borderRadius: '10px',
            padding: '12px 16px',
            fontSize: '14px',
            fontFamily: "'Outfit', sans-serif",
            outline: 'none',
            transition: 'border-color 0.2s ease',
          }}
          onFocus={(e) => (e.target.style.borderColor = '#38bdf8')}
          onBlur={(e) => (e.target.style.borderColor = '#e5e7eb')}
        />
        <button
          onClick={handleSubmit}
          disabled={!newIdea.trim() || submitting}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            backgroundColor:
              !newIdea.trim() || submitting ? '#e5e7eb' : '#0f172a',
            color: !newIdea.trim() || submitting ? '#94a3b8' : '#ffffff',
            fontFamily: "'Outfit', sans-serif",
            fontSize: '13px',
            fontWeight: 600,
            border: 'none',
            borderRadius: '10px',
            padding: '12px 20px',
            cursor: !newIdea.trim() || submitting ? 'not-allowed' : 'pointer',
            transition: 'all 0.2s ease',
            flexShrink: 0,
          }}
        >
          <Plus size={16} />
          Add
        </button>
      </div>

      {/* Ideas list */}
      {loading ? (
        <p
          style={{
            fontFamily: "'Outfit', sans-serif",
            fontSize: '13px',
            color: '#94a3b8',
            textAlign: 'center',
            padding: '40px 0',
          }}
        >
          Loading ideas...
        </p>
      ) : ideas.length === 0 ? (
        <div
          style={{
            textAlign: 'center',
            padding: '60px 0',
          }}
        >
          <Lightbulb
            size={36}
            style={{ color: '#e5e7eb', marginBottom: '16px', margin: '0 auto 16px' }}
          />
          <p
            style={{
              fontFamily: "'Outfit', sans-serif",
              fontSize: '15px',
              fontWeight: 500,
              color: '#94a3b8',
              marginBottom: '4px',
            }}
          >
            No ideas yet
          </p>
          <p
            style={{
              fontFamily: "'Outfit', sans-serif",
              fontSize: '13px',
              color: '#cbd5e1',
            }}
          >
            Be the first to suggest something.
          </p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {ideas.map((idea) => (
            <div
              key={idea.id}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: '16px',
                backgroundColor: '#ffffff',
                borderRadius: '12px',
                border: '1px solid #e5e7eb',
                padding: '16px 20px',
                transition: 'all 0.2s ease',
              }}
            >
              {/* Vote button */}
              <button
                onClick={() => handleVote(idea)}
                disabled={hasVoted(idea.id)}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: '4px',
                  background: hasVoted(idea.id) ? '#f0f9ff' : 'none',
                  border: 'none',
                  cursor: hasVoted(idea.id) ? 'default' : 'pointer',
                  padding: '4px 8px',
                  borderRadius: '8px',
                  transition: 'all 0.2s ease',
                  flexShrink: 0,
                  opacity: hasVoted(idea.id) ? 0.6 : 1,
                }}
                onMouseEnter={(e) => {
                  if (!hasVoted(idea.id)) e.currentTarget.style.backgroundColor = '#f0f9ff';
                }}
                onMouseLeave={(e) => {
                  if (!hasVoted(idea.id)) e.currentTarget.style.backgroundColor = 'transparent';
                }
                }
                title={hasVoted(idea.id) ? 'You already voted' : 'Vote for this idea'}
              >
                <ThumbsUp size={16} style={{ color: '#38bdf8' }} />
                <span
                  style={{
                    fontFamily: "'Outfit', sans-serif",
                    fontSize: '13px',
                    fontWeight: 700,
                    color: '#0f172a',
                  }}
                >
                  {idea.votes || 0}
                </span>
              </button>

              {/* Idea content */}
              <div style={{ flex: 1, minWidth: 0 }}>
                {editingId === idea.id ? (
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
                    <input
                      value={editText}
                      onChange={(e) => setEditText(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') handleEdit(idea); if (e.key === 'Escape') setEditingId(null); }}
                      autoFocus
                      style={{
                        flex: 1, padding: '6px 10px', fontSize: 14, fontFamily: "'Outfit', sans-serif",
                        border: '1px solid #38bdf8', borderRadius: 8, outline: 'none',
                      }}
                    />
                    <button onClick={() => handleEdit(idea)} style={{ fontSize: 12, fontWeight: 600, color: '#0e7fe0', background: 'none', border: 'none', cursor: 'pointer', fontFamily: "'Outfit', sans-serif" }}>Save</button>
                    <button onClick={() => setEditingId(null)} style={{ fontSize: 12, color: '#94a3b8', background: 'none', border: 'none', cursor: 'pointer', fontFamily: "'Outfit', sans-serif" }}>Cancel</button>
                  </div>
                ) : (
                  <p
                    onClick={() => { setEditingId(idea.id); setEditText(idea.text); }}
                    style={{
                      fontFamily: "'Outfit', sans-serif",
                      fontSize: '14px',
                      fontWeight: 500,
                      color: '#0f172a',
                      lineHeight: '1.5',
                      marginBottom: '6px',
                      cursor: 'pointer',
                    }}
                    title="Click to edit"
                  >
                    {idea.text}
                  </p>
                )}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <p style={{ fontFamily: "'Outfit', sans-serif", fontSize: 12, color: '#94a3b8' }}>
                    {idea.submitted_by_name || 'Unknown'} &middot;{' '}
                    {new Date(idea.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                  </p>
                  <StatusPill
                    idea={idea}
                    canEdit={canManageStatus}
                    onChange={(next) => handleStatusChange(idea, next)}
                  />
                </div>

                {/* Admin comment editor — shown while rejecting / requesting info */}
                {canManageStatus && pendingComment?.ideaId === idea.id && (
                  <div style={{ marginTop: 10 }}>
                    <label style={{ display: 'block', fontFamily: "'Outfit', sans-serif", fontSize: 11, fontWeight: 600, color: '#475569', marginBottom: 4 }}>
                      {COMMENT_STATUSES[pendingComment.status].label}
                    </label>
                    <textarea
                      value={commentText}
                      onChange={(e) => setCommentText(e.target.value)}
                      autoFocus
                      rows={3}
                      placeholder={COMMENT_STATUSES[pendingComment.status].placeholder}
                      style={{
                        width: '100%', boxSizing: 'border-box', padding: '8px 10px', fontSize: 13,
                        fontFamily: "'Outfit', sans-serif", border: '1px solid #c4b5fd', borderRadius: 8,
                        outline: 'none', resize: 'vertical',
                      }}
                    />
                    <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                      <button
                        onClick={() => handleSaveComment(idea)}
                        disabled={!commentText.trim() || savingComment}
                        style={{
                          fontFamily: "'Outfit', sans-serif", fontSize: 12, fontWeight: 600,
                          color: '#ffffff', background: !commentText.trim() || savingComment ? '#c7d2fe' : '#4f46e5',
                          border: 'none', borderRadius: 8, padding: '6px 14px',
                          cursor: !commentText.trim() || savingComment ? 'not-allowed' : 'pointer',
                        }}
                      >
                        {savingComment ? 'Saving…' : pendingComment.status === 'rejected' ? 'Reject with comment' : 'Send request'}
                      </button>
                      <button
                        onClick={() => { setPendingComment(null); setCommentText(''); }}
                        style={{ fontFamily: "'Outfit', sans-serif", fontSize: 12, color: '#94a3b8', background: 'none', border: 'none', cursor: 'pointer' }}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}

                {/* Saved admin comment (rejection reason / info request) */}
                {idea.admin_comment && !(pendingComment?.ideaId === idea.id) && (
                  <div style={{
                    marginTop: 10, padding: '8px 12px', borderRadius: 8,
                    background: idea.status === 'rejected' ? '#fef2f2' : idea.status === 'more_info' ? '#f5f3ff' : '#f8fafc',
                    border: `1px solid ${idea.status === 'rejected' ? '#fecaca' : idea.status === 'more_info' ? '#ddd6fe' : '#e5e7eb'}`,
                  }}>
                    <div style={{ fontFamily: "'Outfit', sans-serif", fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: idea.status === 'rejected' ? '#991b1b' : idea.status === 'more_info' ? '#5b21b6' : '#475569', marginBottom: 3 }}>
                      {idea.status === 'rejected' ? 'Rejection reason' : idea.status === 'more_info' ? 'Question for submitter' : 'Note'}
                    </div>
                    <p style={{ fontFamily: "'Outfit', sans-serif", fontSize: 13, color: '#0f172a', lineHeight: 1.5, margin: 0, whiteSpace: 'pre-wrap' }}>{idea.admin_comment}</p>
                    {idea.admin_comment_by && (
                      <p style={{ fontFamily: "'Outfit', sans-serif", fontSize: 11, color: '#94a3b8', marginTop: 4 }}>
                        — {idea.admin_comment_by}{idea.admin_comment_at ? ` · ${new Date(idea.admin_comment_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}` : ''}
                      </p>
                    )}
                  </div>
                )}

                {/* Submitter's reply to an info request */}
                {idea.submitter_response && (
                  <div style={{ marginTop: 8, padding: '8px 12px', borderRadius: 8, background: '#f0f9ff', border: '1px solid #bae6fd' }}>
                    <div style={{ fontFamily: "'Outfit', sans-serif", fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: '#0369a1', marginBottom: 3 }}>
                      Submitter's reply
                    </div>
                    <p style={{ fontFamily: "'Outfit', sans-serif", fontSize: 13, color: '#0f172a', lineHeight: 1.5, margin: 0, whiteSpace: 'pre-wrap' }}>{idea.submitter_response}</p>
                    {idea.submitter_response_at && (
                      <p style={{ fontFamily: "'Outfit', sans-serif", fontSize: 11, color: '#94a3b8', marginTop: 4 }}>
                        {new Date(idea.submitter_response_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                      </p>
                    )}
                  </div>
                )}

                {/* Reply affordance — only the submitter, only while info is being requested */}
                {idea.status === 'more_info' && profile?.id === idea.submitted_by && (
                  replyForId === idea.id ? (
                    <div style={{ marginTop: 8 }}>
                      <textarea
                        value={replyText}
                        onChange={(e) => setReplyText(e.target.value)}
                        autoFocus
                        rows={3}
                        placeholder="Answer the question above…"
                        style={{
                          width: '100%', boxSizing: 'border-box', padding: '8px 10px', fontSize: 13,
                          fontFamily: "'Outfit', sans-serif", border: '1px solid #7dd3fc', borderRadius: 8,
                          outline: 'none', resize: 'vertical',
                        }}
                      />
                      <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                        <button
                          onClick={() => handleSaveReply(idea)}
                          disabled={!replyText.trim() || savingReply}
                          style={{
                            fontFamily: "'Outfit', sans-serif", fontSize: 12, fontWeight: 600, color: '#ffffff',
                            background: !replyText.trim() || savingReply ? '#bae6fd' : '#0284c7',
                            border: 'none', borderRadius: 8, padding: '6px 14px',
                            cursor: !replyText.trim() || savingReply ? 'not-allowed' : 'pointer',
                          }}
                        >
                          {savingReply ? 'Sending…' : 'Send reply'}
                        </button>
                        <button
                          onClick={() => { setReplyForId(null); setReplyText(''); }}
                          style={{ fontFamily: "'Outfit', sans-serif", fontSize: 12, color: '#94a3b8', background: 'none', border: 'none', cursor: 'pointer' }}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      onClick={() => { setReplyForId(idea.id); setReplyText(idea.submitter_response || ''); }}
                      style={{
                        marginTop: 8, fontFamily: "'Outfit', sans-serif", fontSize: 12, fontWeight: 600,
                        color: '#0369a1', background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                      }}
                    >
                      {idea.submitter_response ? 'Edit your reply' : 'Reply to this request'}
                    </button>
                  )
                )}
              </div>

              {/* Delete button */}
              <button
                onClick={() => handleDelete(idea)}
                title="Delete idea"
                style={{
                  background: 'none', border: 'none', cursor: 'pointer',
                  padding: 4, opacity: 0.3, transition: 'opacity 0.15s', flexShrink: 0, alignSelf: 'center',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.opacity = '1'; }}
                onMouseLeave={(e) => { e.currentTarget.style.opacity = '0.3'; }}
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                  <path d="M2 4h10M5 4V3a1 1 0 011-1h2a1 1 0 011 1v1M11 4v7a1 1 0 01-1 1H4a1 1 0 01-1-1V4" stroke="#ef4444" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function StatusPill({ idea, canEdit, onChange }) {
  const current = STATUS_MAP[idea.status] || STATUS_MAP.new;
  if (!canEdit) {
    return (
      <span style={{
        fontSize: 10, fontWeight: 600, padding: '2px 8px', borderRadius: 999,
        background: current.bg, color: current.fg, textTransform: 'uppercase', letterSpacing: '0.04em',
      }}>{current.label}</span>
    );
  }
  return (
    <select
      value={idea.status || 'new'}
      onChange={(e) => onChange(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      style={{
        fontSize: 10, fontWeight: 600, padding: '2px 18px 2px 8px', borderRadius: 999,
        background: current.bg, color: current.fg,
        border: 'none', outline: 'none', cursor: 'pointer',
        fontFamily: "'Outfit', sans-serif",
        textTransform: 'uppercase', letterSpacing: '0.04em',
        appearance: 'none', WebkitAppearance: 'none',
      }}
    >
      {STATUS_OPTIONS.filter((s) => !s.legacy).map((s) => (
        <option key={s.key} value={s.key}>{s.label}</option>
      ))}
    </select>
  );
}
