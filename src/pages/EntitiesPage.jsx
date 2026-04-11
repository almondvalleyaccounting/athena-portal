import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { Btn } from '../components/ui';

export default function EntitiesPage() {
  const navigate = useNavigate();
  const [entities, setEntities] = useState([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const { data } = await supabase.from('entities').select('*').order('name');
        setEntities(data || []);
      } catch {}
      setLoading(false);
    })();
  }, []);

  const filtered = entities.filter(
    (e) => !search || e.name?.toLowerCase().includes(search.toLowerCase()) || e.company_number?.includes(search)
  );

  return (
    <div className="p-6 max-w-3xl">
      <h2 className="text-lg font-bold text-ocean-700 mb-4">Clients</h2>
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
          <p className="text-sm text-gray-400">
            {entities.length === 0
              ? 'No entities in the database yet. The BrightManager pipeline populates this table.'
              : 'No matches.'}
          </p>
        </div>
      ) : (
        <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
          {filtered.map((e) => (
            <div key={e.id} className="flex items-center justify-between px-4 py-3 border-b border-gray-50 last:border-0 hover:bg-gray-50">
              <div>
                <p className="text-sm font-medium text-gray-700">{e.name}</p>
                <p className="text-xs text-gray-400">
                  {e.type?.replace('_', ' ')} {e.company_number ? `\u00B7 ${e.company_number}` : ''}
                </p>
              </div>
              <Btn onClick={() => navigate('/manage/quotes/new?entity=' + e.id)} variant="secondary" className="text-xs py-1 px-3">
                Quote
              </Btn>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
