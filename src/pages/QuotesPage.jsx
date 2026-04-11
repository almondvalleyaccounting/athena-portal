import React, { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';
import { fmt, StatusBadge } from '../components/ui';

export default function QuotesPage({ onEdit }) {
  const [quotes, setQuotes] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const { data } = await supabase
          .from('quotes')
          .select('*')
          .order('created_at', { ascending: false });
        setQuotes(data || []);
      } catch {}
      setLoading(false);
    })();
  }, []);

  return (
    <div className="p-6 max-w-3xl">
      <h2 className="text-lg font-bold text-ocean-700 mb-4">Quotes</h2>
      {loading ? (
        <p className="text-sm text-gray-400">Loading...</p>
      ) : quotes.length === 0 ? (
        <div className="bg-white rounded-lg border border-gray-200 p-6 text-center">
          <p className="text-sm text-gray-400">No quotes yet.</p>
        </div>
      ) : (
        <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
          {quotes.map((q) => (
            <div
              key={q.id}
              onClick={() => onEdit(q)}
              className="flex items-center justify-between px-4 py-3 border-b border-gray-50 last:border-0 hover:bg-gray-50 cursor-pointer"
            >
              <div>
                <p className="text-sm font-medium text-gray-700">{q.quote_ref}</p>
                <p className="text-xs text-gray-400">
                  {new Date(q.created_at).toLocaleDateString('en-GB')}
                  {q.defaults_version && ` · v${q.defaults_version}`}
                </p>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-sm font-mono text-ocean-600">{fmt(q.monthly_gross)}/mo</span>
                <StatusBadge status={q.status} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
