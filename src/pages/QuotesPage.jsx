import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { fmt, StatusBadge, Btn } from '../components/ui';

export default function QuotesPage() {
  const navigate = useNavigate();
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
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-lg font-bold text-ocean-700">Quotes</h2>
        <Btn onClick={() => navigate('/manage/quotes/new')}>New Quote</Btn>
      </div>
      {loading ? (
        <p className="text-sm text-gray-400">Loading...</p>
      ) : quotes.length === 0 ? (
        <div className="bg-white rounded-lg border border-gray-200 p-6 text-center">
          <p className="text-sm text-gray-400 mb-3">No quotes yet. Create your first quote to get started.</p>
          <Btn onClick={() => navigate('/manage/quotes/new')}>New Quote</Btn>
        </div>
      ) : (
        <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
          {quotes.map((q) => (
            <div
              key={q.id}
              onClick={() => navigate('/manage/quotes/' + q.id)}
              className="flex items-center justify-between px-4 py-3 border-b border-gray-50 last:border-0 hover:bg-gray-50 cursor-pointer"
            >
              <div>
                <p className="text-sm font-medium text-gray-700">{q.quote_ref}</p>
                <p className="text-xs text-gray-400">
                  {new Date(q.created_at).toLocaleDateString('en-GB')}
                  {q.relationship_group && ` \u00B7 ${q.relationship_group}`}
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
