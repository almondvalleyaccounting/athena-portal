import React, { useState, useEffect, useMemo } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { fmt, StatusBadge, Btn } from '../components/ui';
import { downloadCSV, downloadTablePdf } from '../lib/exportUtils';

const ACTIVE_STATUSES = ['draft', 'pending_approval', 'approved', 'sent', 'accepted'];

const PERIOD_LABELS = {
  all: 'All Time',
  this_month: 'This Month',
  last_3: 'Last 3 Months',
  last_6: 'Last 6 Months',
  this_year: 'This Year',
};

function getDateRange(period) {
  if (!period || period === 'all') return null;
  const now = new Date();
  let from;
  if (period === 'this_month') {
    from = new Date(now.getFullYear(), now.getMonth(), 1);
  } else if (period === 'last_3') {
    from = new Date(now.getFullYear(), now.getMonth() - 3, now.getDate());
  } else if (period === 'last_6') {
    from = new Date(now.getFullYear(), now.getMonth() - 6, now.getDate());
  } else if (period === 'this_year') {
    from = new Date(now.getFullYear(), 0, 1);
  }
  return from ? from.toISOString() : null;
}

function buildTitle(params) {
  const period = PERIOD_LABELS[params.get('period')] || 'All Time';

  if (params.get('metric') === 'totalAnnual') return `Annual Value: ${period}`;
  if (params.get('metric') === 'activeQuotes') return `Active Quotes: ${period}`;
  if (params.get('metric') === 'monthlyDD') return `Monthly Direct Debit: ${period}`;
  if (params.get('service')) return `Quotes with ${params.get('service')}: ${period}`;
  if (params.get('status')) {
    const s = params.get('status').replace('_', ' ');
    const label = s.charAt(0).toUpperCase() + s.slice(1);
    return `${label} Quotes: ${period}`;
  }
  return `Analysis: ${period}`;
}

export default function AnalysisPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  const [quotes, setQuotes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [sortCol, setSortCol] = useState('created_at');
  const [sortAsc, setSortAsc] = useState(false);

  const metric = searchParams.get('metric');
  const period = searchParams.get('period') || 'all';
  const service = searchParams.get('service');
  const status = searchParams.get('status');
  const title = buildTitle(searchParams);
  const dateFrom = getDateRange(period);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        if (service) {
          // Fetch quotes that contain a specific service via line items
          const { data: lineItems } = await supabase
            .from('quote_line_items')
            .select('quote_id, description, service_id');

          const matchingQuoteIds = [
            ...new Set(
              (lineItems || [])
                .filter((li) => (li.description || li.service_id) === service)
                .map((li) => li.quote_id)
            ),
          ];

          if (matchingQuoteIds.length === 0) {
            setQuotes([]);
            setLoading(false);
            return;
          }

          let query = supabase
            .from('quotes')
            .select('*')
            .in('id', matchingQuoteIds)
            .neq('status', 'deleted')
            .order('created_at', { ascending: false });

          if (dateFrom) query = query.gte('created_at', dateFrom);

          const { data } = await query;
          setQuotes(data || []);
        } else {
          // Standard query -- filter by metric or status
          let query = supabase
            .from('quotes')
            .select('*')
            .neq('status', 'deleted')
            .order('created_at', { ascending: false });

          if (dateFrom) query = query.gte('created_at', dateFrom);

          if (status) {
            query = query.eq('status', status);
          } else if (metric === 'activeQuotes' || metric === 'totalAnnual' || metric === 'monthlyDD') {
            query = query.in('status', ACTIVE_STATUSES);
          }

          const { data } = await query;
          setQuotes(data || []);
        }
      } catch (e) {
        console.error('Analysis fetch error:', e);
      }
      setLoading(false);
    })();
  }, [metric, period, service, status, dateFrom]);

  // Sorting
  const toggleSort = (col) => {
    if (sortCol === col) setSortAsc(!sortAsc);
    else { setSortCol(col); setSortAsc(true); }
  };

  const SortHeader = ({ col, children, className = '' }) => (
    <button
      onClick={() => toggleSort(col)}
      className={`text-left text-xs text-gray-400 hover:text-gray-600 flex items-center gap-0.5 ${className}`}
    >
      {children}
      {sortCol === col && <span className="text-ocean-500">{sortAsc ? '\u25B2' : '\u25BC'}</span>}
    </button>
  );

  const sorted = useMemo(() => {
    return [...quotes].sort((a, b) => {
      let va = a[sortCol], vb = b[sortCol];
      if (sortCol === 'created_at') { va = new Date(va); vb = new Date(vb); }
      if (sortCol === 'annual_total' || sortCol === 'monthly_net' || sortCol === 'monthly_gross') {
        va = parseFloat(va) || 0;
        vb = parseFloat(vb) || 0;
      }
      if (sortCol === 'quote_ref' || sortCol === 'relationship_group' || sortCol === 'status') {
        va = (va || '').toLowerCase();
        vb = (vb || '').toLowerCase();
      }
      if (va < vb) return sortAsc ? -1 : 1;
      if (va > vb) return sortAsc ? 1 : -1;
      return 0;
    });
  }, [quotes, sortCol, sortAsc]);

  // Summary number
  const summaryValue = useMemo(() => {
    if (metric === 'totalAnnual') return fmt(quotes.reduce((s, q) => s + (parseFloat(q.annual_total) || 0), 0));
    if (metric === 'monthlyDD') return fmt(quotes.reduce((s, q) => s + (parseFloat(q.monthly_gross) || 0), 0));
    return String(quotes.length);
  }, [quotes, metric]);

  // Export helpers
  const TABLE_HEADERS = ['Quote Ref', 'Client', 'Status', 'Annual (Net)', 'Monthly (Net)', 'Monthly (Gross)', 'Created'];

  const buildRows = () =>
    sorted.map((q) => [
      q.quote_ref || '',
      q.relationship_group || '',
      (q.status || 'draft').replace('_', ' '),
      fmt(q.annual_total),
      fmt(q.monthly_net),
      fmt(q.monthly_gross),
      new Date(q.created_at).toLocaleDateString('en-GB'),
    ]);

  const handleExportCSV = () => {
    downloadCSV(title.replace(/[^a-zA-Z0-9 ]/g, '').replace(/\s+/g, '_') + '.csv', TABLE_HEADERS, buildRows());
  };

  const handleExportPDF = () => {
    downloadTablePdf(title, TABLE_HEADERS, buildRows());
  };

  const gridCols = '1.5fr 1.5fr 0.8fr 1fr 1fr 1fr 0.8fr';

  return (
    <div className="p-6 max-w-5xl">
      {/* Back link */}
      <button onClick={() => navigate(-1)} className="text-xs text-ocean-600 hover:text-ocean-700 mb-3 inline-block">
        &larr; Back
      </button>

      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-bold text-ocean-700">{title}</h2>
        <div className="flex gap-2">
          <Btn onClick={handleExportCSV} variant="secondary" className="text-xs py-1.5 px-3">Export to Excel</Btn>
          <Btn onClick={handleExportPDF} variant="secondary" className="text-xs py-1.5 px-3">Export to PDF</Btn>
        </div>
      </div>

      {/* Summary card */}
      <div className="bg-white rounded-lg border border-gray-200 p-4 mb-4 inline-block">
        <p className="text-xs text-gray-400 mb-1">
          {metric === 'totalAnnual' ? 'Total Annual Value' : metric === 'monthlyDD' ? 'Total Monthly DD' : 'Total Quotes'}
        </p>
        <p className={`text-2xl font-bold font-mono ${metric === 'totalAnnual' || metric === 'monthlyDD' ? 'text-green-700' : 'text-ocean-700'}`}>
          {loading ? '...' : summaryValue}
        </p>
      </div>

      {/* Data table */}
      {loading ? (
        <p className="text-sm text-gray-400">Loading...</p>
      ) : sorted.length === 0 ? (
        <div className="bg-white rounded-lg border border-gray-200 p-6 text-center">
          <p className="text-sm text-gray-400">No quotes match this filter.</p>
        </div>
      ) : (
        <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
          {/* Column headers */}
          <div className="grid gap-2 px-4 py-2 border-b border-gray-200 bg-gray-50" style={{ gridTemplateColumns: gridCols }}>
            <SortHeader col="quote_ref">Quote Ref</SortHeader>
            <SortHeader col="relationship_group">Client</SortHeader>
            <SortHeader col="status">Status</SortHeader>
            <SortHeader col="annual_total" className="justify-end">Annual (Net)</SortHeader>
            <span className="text-xs text-gray-400 text-right">Monthly (Net)</span>
            <SortHeader col="monthly_gross" className="justify-end">Monthly (Gross)</SortHeader>
            <SortHeader col="created_at" className="justify-end">Created</SortHeader>
          </div>
          {/* Rows */}
          {sorted.map((q) => (
            <div
              key={q.id}
              onClick={() => navigate('/manage/quotes/' + q.id)}
              className="grid gap-2 px-4 py-2.5 border-b border-gray-50 last:border-0 cursor-pointer items-center text-xs hover:bg-gray-50 transition-all"
              style={{ gridTemplateColumns: gridCols }}
            >
              <span className="font-medium text-gray-700 truncate">{q.quote_ref}</span>
              <span className="text-gray-500 truncate">{q.relationship_group || '\u2014'}</span>
              <span><StatusBadge status={q.status} /></span>
              <span className="text-right font-mono text-gray-600">{fmt(q.annual_total)}</span>
              <span className="text-right font-mono text-gray-500">{fmt(q.monthly_net)}</span>
              <span className="text-right font-mono text-ocean-600">{fmt(q.monthly_gross)}</span>
              <span className="text-right text-gray-500">{new Date(q.created_at).toLocaleDateString('en-GB')}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
