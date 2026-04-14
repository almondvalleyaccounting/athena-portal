import React, { useState, useEffect } from 'react';
import { ThumbsUp, Plus, Lightbulb } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../shell/AppShell';

/* ─── Ideas module ─────────────────────────────────────────────── */
export default function IdeasPage() {
  const { profile } = useAuth();
  const [ideas, setIdeas] = useState([]);
  const [newIdea, setNewIdea] = useState('');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [editText, setEditText] = useState('');

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
                <p
                  style={{
                    fontFamily: "'Outfit', sans-serif",
                    fontSize: '12px',
                    color: '#94a3b8',
                  }}
                >
                  {idea.submitted_by_name || 'Unknown'} &middot;{' '}
                  {new Date(idea.created_at).toLocaleDateString('en-GB', {
                    day: 'numeric',
                    month: 'short',
                  })}
                </p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
