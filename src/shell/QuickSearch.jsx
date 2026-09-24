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
  const runSearch = useCallback(async (raw) => {
    // Commas and brackets would break the PostgREST or() filter.
    const q = (raw || '').replace(/[,()*]/g, ' ').trim();
    if (!q || q.length < 2) { setResults({ clients: [], tasks: [], quotes: [] }); setLoading(false); return; }
    setLoading(true);
    try {
      // Identifiers are stored without spaces; people type "38890 25012" or
      // "GB 488 0176 63". Match those on a compacted copy.
      const compact = q.replace(/\s+/g, '');
      const vat = compact.replace(/^GB/i, '');
      const idFilters = compact.length >= 3
        ? [`company_number.ilike.%${compact}%`, `utr.ilike.%${compact}%`, `vat_number.ilike.%${vat}%`,
           `paye_ref.ilike.%${compact}%`, `bm_client_id.ilike.%${compact}%`,
           `billing_email.ilike.%${compact}%`, `prospect_email.ilike.%${compact}%`]
        : [];
      const [{ data: clientRows }, { data: emailRows }, { data: tasks }, { data: quotes }] = await Promise.all([
        supabase.from('entities')
          .select('id, name, type, company_number, utr, vat_number, paye_ref, bm_client_id, billing_email, prospect_email')
          .or([`name.ilike.%${q}%`, ...idFilters].join(','))
          .order('name').limit(8),
        // BrightManager contact emails aren't on entities.
        compact.length >= 3
          ? supabase.from('v_email_reconciliation').select('entity_id, name, bm_contact_email')
              .ilike('bm_contact_email', `%${compact}%`).limit(5)
          : Promise.resolve({ data: [] }),
        supabase.from('quick_tasks').select('id, title, service').ilike('title', `%${q}%`).limit(5),
        supabase.from('quotes').select('id, quote_ref, relationship_group, status')
          .or(`quote_ref.ilike.%${q}%,relationship_group.ilike.%${q}%`).limit(5),
      ]);
      const clients = (clientRows || []).map((c) => ({ ...c, matched: matchedOn(c, q, compact, vat) }));
      for (const e of emailRows || []) {
        if (!clients.some((c) => c.id === e.entity_id)) {
          clients.push({ id: e.entity_id, name: e.name, matched: `Email ${e.bm_contact_email}` });
        }
      }
      setResults({ clients: clients.slice(0, 8), tasks: tasks || [], quotes: quotes || [] });
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
          placeholder="Search name, company no., UTR, VAT, email…"
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
                  <span style={{ fontSize: 11, color: '#94a3b8' }}>{c.matched || c.type?.replace('_', ' ')}</span>
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

// Which identifier a client matched on, so a hit on "SC824366" says why it's
// there. Nothing when the name matched — the name is already on the row.
function matchedOn(c, q, compact, vat) {
  const has = (v, needle) => v && needle && String(v).toLowerCase().includes(needle.toLowerCase());
  if (has(c.name, q)) return null;
  if (has(c.company_number, compact)) return `Company no. ${c.company_number}`;
  if (has(c.utr, compact)) return `UTR ${c.utr}`;
  if (has(c.vat_number, vat)) return `VAT ${c.vat_number}`;
  if (has(c.paye_ref, compact)) return `PAYE ${c.paye_ref}`;
  if (has(c.bm_client_id, compact)) return `BrightManager ${c.bm_client_id}`;
  if (has(c.billing_email, compact)) return `Email ${c.billing_email}`;
  if (has(c.prospect_email, compact)) return `Email ${c.prospect_email}`;
  return null;
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
