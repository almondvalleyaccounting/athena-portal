import React, { useEffect, useRef, useState } from 'react';
import { searchEntities } from '../lib/searchEntities';

// The client-name box on New Quote. Type a name and it doubles as a
// search of existing clients (name, company no., UTR, VAT, email): pick
// one to quote for them, or carry on typing for a new prospect.
//
// `linked` is the entity the quote is attached to, if any; typing a
// different name unlinks it (onUnlink) so a prospect is never saved
// against the client it was first confused with.
export default function ClientNamePicker({ value, onChange, onPick, linked, onUnlink, className = '' }) {
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);
  const boxRef = useRef(null);
  const timer = useRef(null);

  useEffect(() => {
    const close = (e) => { if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  useEffect(() => {
    clearTimeout(timer.current);
    if (!open) return undefined;
    const q = (value || '').trim();
    if (q.length < 2) { setResults([]); return undefined; }
    setLoading(true);
    let live = true;
    timer.current = setTimeout(async () => {
      try {
        const rows = await searchEntities(q, { limit: 8 });
        if (live) { setResults(rows.filter((r) => r.entity_status !== 'nlac')); setActive(0); }
      } finally {
        if (live) setLoading(false);
      }
    }, 250);
    return () => { live = false; clearTimeout(timer.current); };
  }, [value, open]);

  const pick = (row) => {
    setOpen(false);
    onPick(row);
  };

  return (
    <div ref={boxRef} className={`relative ${className}`}>
      <input
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          if (linked && e.target.value.trim().toLowerCase() !== (linked.name || '').trim().toLowerCase()) onUnlink?.();
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (!open || results.length === 0) return;
          if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(results.length - 1, a + 1)); }
          if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
          if (e.key === 'Enter') { e.preventDefault(); pick(results[active]); }
          if (e.key === 'Escape') setOpen(false);
        }}
        placeholder="Client name — or search existing clients"
        className="w-full text-sm border border-gray-200 rounded px-2 py-1.5"
        autoComplete="off"
      />
      {linked && (
        <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[11px] font-medium text-ocean-700 bg-ocean-50 border border-ocean-200 rounded-full px-2 py-0.5 pointer-events-none">
          Existing client
        </span>
      )}
      {open && (value || '').trim().length >= 2 && !linked && (
        <div className="absolute z-30 left-0 right-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg overflow-hidden">
          {loading && results.length === 0 ? (
            <div className="px-3 py-2 text-xs text-gray-400">Searching…</div>
          ) : (
            <>
              {results.map((r, i) => (
                <button
                  key={r.id}
                  type="button"
                  onMouseDown={(e) => { e.preventDefault(); pick(r); }}
                  onMouseEnter={() => setActive(i)}
                  className={`w-full text-left px-3 py-2 flex items-center justify-between gap-3 ${i === active ? 'bg-ocean-50' : 'bg-white'}`}
                >
                  <span className="text-sm text-gray-800 truncate">{r.name}</span>
                  <span className="text-[11px] text-gray-400 whitespace-nowrap">
                    {r.matched || (r.company_number ? `Company no. ${r.company_number}` : '')}
                  </span>
                </button>
              ))}
              <div className="px-3 py-2 text-[11px] text-gray-400 border-t border-gray-100">
                {results.length ? 'Not listed? Keep typing to quote a new prospect.' : 'No existing client matches — this will be a new prospect.'}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
