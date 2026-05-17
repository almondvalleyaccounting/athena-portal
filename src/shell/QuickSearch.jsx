import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search } from 'lucide-react';
import { supabase } from '../lib/supabase';

/*
  QuickSearch — Cmd+K searchable across clients, tasks, quotes.
  Renders in the TopBar.
*/
export default function QuickSearch() {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState({ clients: [], tasks: [], quotes: [] });
  const [loading, setLoading] = useState(false);
  const inputRef = useRef(null);
  const containerRef = useRef(null);
  const debounceRef = useRef(null);

  // Global Cmd+K / Ctrl+K shortcut
  useEffect(() => {
    function handleKey(e) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        inputRef.current?.focus();
      }
      if (e.key === 'Escape') {
        setOpen(false);
        inputRef.current?.blur();
      }
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, []);

  // Click outside closes
  useEffect(() => {
    function handleClick(e) {
      if (containerRef.current && !containerRef.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  // Debounced search
  const runSearch = useCallback(async (q) => {
    if (!q || q.length < 2) { setResults({ clients: [], tasks: [], quotes: [] }); setLoading(false); return; }
    setLoading(true);
    try {
      const [{ data: clients }, { data: tasks }, { data: quotes }] = await Promise.all([
        supabase.from('entities').select('id, name, type').ilike('name', `%${q}%`).limit(5),
        supabase.from('quick_tasks').select('id, title, service').ilike('title', `%${q}%`).limit(5),
        supabase.from('quotes').select('id, quote_ref, relationship_group, status')
          .or(`quote_ref.ilike.%${q}%,relationship_group.ilike.%${q}%`).limit(5),
      ]);
      setResults({ clients: clients || [], tasks: tasks || [], quotes: quotes || [] });
    } catch (e) {
      console.error('[QuickSearch]', e);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => runSearch(query), 300);
    return () => clearTimeout(debounceRef.current);
  }, [query, runSearch]);

  const hasResults = results.clients.length + results.tasks.length + results.quotes.length > 0;

  const handleSelect = (path) => {
    navigate(path);
    setOpen(false);
    setQuery('');
  };

  return (
    <div ref={containerRef} style={{ position: 'relative', flex: 1, maxWidth: 420 }}>
      <div style={{ position: 'relative' }}>
        <Search size={15} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: '#94a3b8' }} />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
          onFocus={() => { if (query.length >= 2) setOpen(true); }}
          placeholder="Search clients, tasks, quotes..."
          style={{
            width: '100%', padding: '7px 60px 7px 32px', fontSize: 13,
            fontFamily: "'Outfit', sans-serif", border: '1px solid #e5e7eb',
            borderRadius: 10, outline: 'none', background: '#fafafa',
            transition: 'border-color 0.2s, background 0.2s',
            boxSizing: 'border-box',
          }}
          onFocus2={(e) => { e.target.style.borderColor = '#38bdf8'; e.target.style.background = '#fff'; }}
        />
        {query ? (
          <button
            type="button"
            onClick={() => { setQuery(''); setOpen(false); inputRef.current?.focus(); }}
            aria-label="Clear search"
            title="Clear"
            style={{
              position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)',
              width: 20, height: 20, padding: 0,
              background: 'transparent', border: 'none',
              color: '#94a3b8', cursor: 'pointer',
              fontSize: 18, lineHeight: 1,
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            }}
          >
            ×
          </button>
        ) : (
          <span style={{
            position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)',
            fontSize: 10, fontWeight: 600, color: '#94a3b8', background: '#f1f5f9',
            padding: '2px 6px', borderRadius: 4, fontFamily: "'Outfit', sans-serif",
            pointerEvents: 'none',
          }}>
            ⌘K
          </span>
        )}
      </div>

      {open && query.length >= 2 && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, right: 0, marginTop: 6,
          background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12,
          boxShadow: '0 8px 30px rgba(0,0,0,0.12)', maxHeight: 360, overflowY: 'auto',
          zIndex: 200, fontFamily: "'Outfit', sans-serif",
        }}>
          {loading && (
            <div style={{ padding: '12px 16px', fontSize: 12, color: '#94a3b8' }}>Searching...</div>
          )}

          {!loading && !hasResults && (
            <div style={{ padding: '16px', fontSize: 13, color: '#94a3b8', textAlign: 'center' }}>No results found</div>
          )}

          {results.clients.length > 0 && (
            <div>
              <div style={sectionHeader}>Clients</div>
              {results.clients.map((c) => (
                <div key={c.id} onClick={() => handleSelect(`/clients/${c.id}`)} style={resultRow}>
                  <span style={{ fontWeight: 500, color: '#0f172a' }}>{c.name}</span>
                  <span style={{ fontSize: 11, color: '#94a3b8' }}>{c.type?.replace('_', ' ')}</span>
                </div>
              ))}
            </div>
          )}

          {results.tasks.length > 0 && (
            <div>
              <div style={sectionHeader}>Tasks</div>
              {results.tasks.map((t) => (
                <div key={t.id} onClick={() => handleSelect('/planner')} style={resultRow}>
                  <span style={{ fontWeight: 500, color: '#0f172a' }}>{t.title}</span>
                  <span style={{ fontSize: 11, color: '#94a3b8' }}>{t.service}</span>
                </div>
              ))}
            </div>
          )}

          {results.quotes.length > 0 && (
            <div>
              <div style={sectionHeader}>Quotes</div>
              {results.quotes.map((q) => (
                <div key={q.id} onClick={() => handleSelect(`/manage/quotes/${q.id}`)} style={resultRow}>
                  <span style={{ fontWeight: 500, color: '#0f172a' }}>{q.quote_ref}</span>
                  <span style={{ fontSize: 11, color: '#94a3b8' }}>{q.relationship_group} · {q.status}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const sectionHeader = {
  padding: '8px 16px 4px', fontSize: 10, fontWeight: 600, color: '#94a3b8',
  textTransform: 'uppercase', letterSpacing: '0.03em',
  borderBottom: '1px solid #f1f5f9',
};

const resultRow = {
  padding: '8px 16px', cursor: 'pointer', display: 'flex',
  justifyContent: 'space-between', alignItems: 'center',
  transition: 'background 0.1s',
};
