import React, { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { Btn } from './ui';

// Internal notes on a quote (sql/344). Staff-only: never on the PDF, the email
// or the client's accept page. Reads come straight from quote_comments (RLS
// follows the quote); writes go through the quote-comments edge function.
export default function QuoteCommentsPanel({ quoteId, profile }) {
  const [comments, setComments] = useState([]);
  const [names, setNames] = useState({});
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    const { data, error: err } = await supabase
      .from('quote_comments')
      .select('id, author_id, body, created_at')
      .eq('quote_id', quoteId)
      .order('created_at', { ascending: false });
    if (err) { setError(err.message); return; }
    setComments(data || []);
    const ids = [...new Set((data || []).map((c) => c.author_id).filter(Boolean))];
    if (ids.length) {
      const { data: staff } = await supabase.from('staff_profiles').select('id, name').in('id', ids);
      setNames(Object.fromEntries((staff || []).map((s) => [s.id, s.name])));
    }
  }, [quoteId]);

  useEffect(() => { load(); }, [load]);

  const call = async (payload) => {
    const { data, error: err } = await supabase.functions.invoke('quote-comments', { body: payload });
    if (err || !data?.success) throw new Error(data?.error || err?.message || 'Save failed');
    return data;
  };

  const add = async () => {
    const body = draft.trim();
    if (!body) return;
    setSaving(true);
    setError('');
    try {
      await call({ action: 'add', quote_id: quoteId, body });
      setDraft('');
      await load();
    } catch (e) {
      setError(e.message);
    }
    setSaving(false);
  };

  const remove = async (id) => {
    if (!confirm('Delete this comment?')) return;
    setError('');
    try {
      await call({ action: 'delete', comment_id: id });
      setComments((prev) => prev.filter((c) => c.id !== id));
    } catch (e) {
      setError(e.message);
    }
  };

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-3 mb-3">
      <div className="flex items-baseline justify-between mb-2">
        <h3 className="text-xs font-semibold text-gray-500">Comments{comments.length ? ` (${comments.length})` : ''}</h3>
        <span className="text-[11px] text-gray-400">Internal only, never shown to the client</span>
      </div>
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) add(); }}
        placeholder="Add a note about this quote…"
        rows={2}
        maxLength={4000}
        className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:border-ocean-300 resize-y"
      />
      <div className="flex items-center justify-between mt-1.5">
        <span className="text-[11px] text-gray-400">Ctrl+Enter to add</span>
        <Btn size="sm" onClick={add} disabled={saving || !draft.trim()}>{saving ? 'Adding…' : 'Add comment'}</Btn>
      </div>
      {error && <p className="text-xs text-red-600 mt-1.5">{error}</p>}
      {comments.length > 0 && (
        <div className="mt-3 space-y-2.5">
          {comments.map((c) => (
            <div key={c.id} className="border-t border-gray-100 pt-2">
              <div className="flex items-center justify-between text-[11px] text-gray-400">
                <span>
                  <span className="text-gray-600 font-medium">{names[c.author_id] || 'Former team member'}</span>
                  {' · '}
                  {new Date(c.created_at).toLocaleDateString('en-GB')}{' '}
                  {new Date(c.created_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
                </span>
                {c.author_id === profile?.id && (
                  <button onClick={() => remove(c.id)} className="text-gray-400 hover:text-red-600">Delete</button>
                )}
              </div>
              <p className="text-sm text-gray-700 whitespace-pre-wrap mt-0.5">{c.body}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
