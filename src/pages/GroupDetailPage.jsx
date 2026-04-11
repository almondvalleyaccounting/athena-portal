import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { fmt, StatusBadge, Btn, Inp } from '../components/ui';
import ConsolidationTable from '../components/ConsolidationTable';

export default function GroupDetailPage({ profile, defaults }) {
  const { groupId } = useParams();
  const navigate = useNavigate();
  const [group, setGroup] = useState(null);
  const [quotes, setQuotes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [discounts, setDiscounts] = useState({});

  useEffect(() => { loadGroup(); }, [groupId]);

  const loadGroup = async () => {
    setLoading(true);
    try {
      const [{ data: bg }, { data: gQuotes }] = await Promise.all([
        supabase.from('billing_groups').select('*').eq('id', groupId).single(),
        supabase.from('quotes').select('*, line_items:quote_line_items(*)').eq('group_id', groupId).order('created_at'),
      ]);
      setGroup(bg);
      setQuotes(gQuotes || []);
    } catch {}
    setLoading(false);
  };

  if (loading) return <div className="p-6"><p className="text-sm text-gray-400">Loading group...</p></div>;
  if (!group) return <div className="p-6"><p className="text-sm text-red-500">Group not found.</p></div>;

  // Build entity data for consolidation table
  const entities = quotes.map(q => ({
    id: q.entity_id || q.id, // use entity_id if available, else quote id
    name: q.relationship_group || q.quote_ref,
    quoteId: q.id,
    company_number: '',
  }));

  const entityTotals = {};
  quotes.forEach(q => {
    const key = q.entity_id || q.id;
    const recurring = (q.line_items || []).filter(l => l.is_recurring);
    const swLines = recurring.filter(l => l.service_id?.startsWith('software'));
    const serviceLines = recurring.filter(l => !l.service_id?.startsWith('software'));

    entityTotals[key] = {
      lines: recurring.map(l => ({
        id: l.service_id,
        name: l.description,
        annual: Number(l.annual_amount),
      })),
      annualServices: serviceLines.reduce((s, l) => s + Number(l.annual_amount), 0),
      swAnnual: swLines.reduce((s, l) => s + Number(l.annual_amount), 0),
      annualTotal: Number(q.annual_total) || 0,
      monthlyGross: Number(q.monthly_gross) || 0,
    };
  });

  // Group totals
  const groupAnnual = quotes.reduce((s, q) => {
    const key = q.entity_id || q.id;
    const disc = discounts[key] || 0;
    return s + ((Number(q.annual_total) || 0) * (1 - disc / 100));
  }, 0);
  const groupMonthlyNet = Math.round((groupAnnual / 12) * 100) / 100;
  const groupMonthlyVat = Math.round(groupMonthlyNet * 0.2 * 100) / 100;
  const groupMonthlyDD = Math.round((groupMonthlyNet + groupMonthlyVat) * 100) / 100;

  return (
    <div className="p-6 max-w-4xl">
      <div className="flex justify-between items-start mb-4">
        <div>
          <h2 className="text-lg font-bold text-ocean-700">{group.name}</h2>
          <p className="text-xs text-gray-400">{quotes.length} entities \u00B7 Group quote</p>
        </div>
        <Btn onClick={() => navigate('/manage/quotes')} variant="ghost">Back</Btn>
      </div>

      {/* Consolidation Table */}
      <div className="mb-4">
        <ConsolidationTable
          entities={entities}
          entityTotals={entityTotals}
          discounts={discounts}
          onDiscountChange={(eid, pct) => setDiscounts(prev => ({ ...prev, [eid]: pct }))}
        />
      </div>

      {/* Individual quote cards */}
      <h3 className="text-xs font-semibold text-gray-500 uppercase mb-2">Individual Quotes</h3>
      <div className="space-y-2 mb-4">
        {quotes.map(q => (
          <div
            key={q.id}
            onClick={() => navigate('/manage/quotes/' + q.id)}
            className="bg-white rounded-lg border border-gray-200 p-3 cursor-pointer hover:border-ocean-300 transition-all"
          >
            <div className="flex justify-between items-center">
              <div>
                <p className="text-sm font-medium text-gray-700">{q.relationship_group || q.quote_ref}</p>
                <p className="text-xs text-gray-400">{q.quote_ref} \u00B7 {new Date(q.created_at).toLocaleDateString('en-GB')}</p>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-sm font-mono text-ocean-600">{fmt(q.monthly_gross)}/mo</span>
                <StatusBadge status={q.status} />
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Actions */}
      <div className="flex gap-2">
        <Btn onClick={() => navigate('/manage/quotes/new?group=' + groupId)}>Add Entity</Btn>
        <Btn onClick={() => navigate('/manage/quotes')} variant="secondary">Back to Quotes</Btn>
      </div>
    </div>
  );
}
