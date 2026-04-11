import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { fmt, StatusBadge, Btn } from '../components/ui';

export default function DashboardPage() {
  const navigate = useNavigate();
  const [stats, setStats] = useState({ entities: 0, quotes: 0, drafts: 0 });
  const [recent, setRecent] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const [{ data: ents }, { data: quots }] = await Promise.all([
          supabase.from('entities').select('id'),
          supabase.from('quotes').select('id,quote_ref,status,monthly_gross,created_at').order('created_at', { ascending: false }).limit(10),
        ]);
        const q = quots || [];
        setStats({
          entities: ents?.length || 0,
          quotes: q.length,
          drafts: q.filter((x) => x.status === 'draft').length,
        });
        setRecent(q.slice(0, 5));
      } catch {}
      setLoading(false);
    })();
  }, []);

  return (
    <div className="p-6 max-w-3xl">
      <h2 className="text-lg font-bold text-ocean-700 mb-4">Dashboard</h2>
      {loading ? (
        <p className="text-sm text-gray-400">Loading...</p>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-3 mb-6">
            {[
              { label: 'Clients', value: stats.entities, action: () => navigate('/manage/clients') },
              { label: 'Quotes', value: stats.quotes, action: () => navigate('/manage/quotes') },
              { label: 'Drafts', value: stats.drafts },
            ].map((s, i) => (
              <div
                key={i}
                onClick={s.action}
                className={`bg-white rounded-lg border border-gray-200 p-4 ${s.action ? 'cursor-pointer hover:border-ocean-300' : ''}`}
              >
                <p className="text-xs text-gray-400 mb-1">{s.label}</p>
                <p className="text-2xl font-bold text-ocean-700 font-mono">{s.value}</p>
              </div>
            ))}
          </div>

          {recent.length > 0 && (
            <div className="bg-white rounded-lg border border-gray-200 p-4">
              <h3 className="text-sm font-semibold text-gray-700 mb-3">Recent Quotes</h3>
              {recent.map((q) => (
                <div
                  key={q.id}
                  onClick={() => navigate('/manage/quotes/' + q.id)}
                  className="flex items-center justify-between py-2 border-b border-gray-50 last:border-0 cursor-pointer hover:bg-gray-50 rounded px-1 -mx-1"
                >
                  <div>
                    <p className="text-sm text-gray-700">{q.quote_ref}</p>
                    <p className="text-xs text-gray-400">{new Date(q.created_at).toLocaleDateString('en-GB')}</p>
                  </div>
                  <div className="flex items-center gap-3">
                    {q.monthly_gross && <span className="text-sm font-mono text-ocean-600">{fmt(q.monthly_gross)}/mo</span>}
                    <StatusBadge status={q.status} />
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="mt-4">
            <Btn onClick={() => navigate('/manage/quotes/new')}>New Quote</Btn>
          </div>
        </>
      )}
    </div>
  );
}
