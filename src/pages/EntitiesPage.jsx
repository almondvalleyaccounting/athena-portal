import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { Btn, fmt, StatusBadge } from '../components/ui';

export default function EntitiesPage() {
  const navigate = useNavigate();
  const [entities, setEntities] = useState([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        // Fetch entities with their latest quote
        const { data: ents } = await supabase
          .from('entities')
          .select('*')
          .order('name');

        if (ents?.length) {
          // Fetch latest quote per entity
          const { data: quotes } = await supabase
            .from('quotes')
            .select('entity_id, status, monthly_gross, quote_ref, created_at')
            .in('entity_id', ents.map(e => e.id))
            .order('created_at', { ascending: false });

          // Attach latest quote to each entity
          const enriched = ents.map(e => {
            const latestQuote = quotes?.find(q => q.entity_id === e.id);
            return { ...e, latestQuote };
          });
          setEntities(enriched);
        } else {
          setEntities([]);
        }
      } catch {}
      setLoading(false);
    })();
  }, []);

  const filtered = entities.filter(
    (e) => !search || e.name?.toLowerCase().includes(search.toLowerCase()) || e.company_number?.includes(search)
  );

  return (
    <div className="p-6 max-w-3xl">
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-lg font-bold text-ocean-700">Clients</h2>
        <Btn onClick={() => navigate('/manage/quotes/new')}>New Quote</Btn>
      </div>
      <input
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search by name or company number..."
        className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 mb-4"
      />
      {loading ? (
        <p className="text-sm text-gray-400">Loading...</p>
      ) : filtered.length === 0 ? (
        <div className="bg-white rounded-lg border border-gray-200 p-6 text-center">
          <p className="text-sm text-gray-400 mb-1">
            {entities.length === 0
              ? 'No clients yet. Clients are created automatically when you build a quote.'
              : 'No matches.'}
          </p>
          {entities.length === 0 && (
            <p className="text-xs text-gray-300 mb-3">Create your first quote and the client will appear here.</p>
          )}
        </div>
      ) : (
        <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
          {filtered.map((e) => (
            <div key={e.id} className="flex items-center justify-between px-4 py-3 border-b border-gray-50 last:border-0 hover:bg-gray-50">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-gray-700">{e.name}</p>
                <p className="text-xs text-gray-400">
                  {e.type?.replace('_', ' ')} {e.company_number ? `\u00B7 ${e.company_number}` : ''}
                </p>
              </div>
              <div className="flex items-center gap-3 shrink-0">
                {e.latestQuote ? (
                  <>
                    <span className="text-xs font-mono text-ocean-600">{fmt(e.latestQuote.monthly_gross)}/mo</span>
                    <StatusBadge status={e.latestQuote.status} />
                  </>
                ) : (
                  <span className="text-xs text-gray-300">No quotes</span>
                )}
                <Btn onClick={() => navigate('/manage/quotes/new?entity=' + e.id)} variant="secondary" className="text-xs py-1 px-3">
                  Quote
                </Btn>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
