import React, { useState, useEffect, useMemo } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { fmt, StatusBadge, Btn } from '../components/ui';
import { downloadCSV, downloadTablePdf } from '../lib/exportUtils';

const STATUS_VIEW_FILTERS = {
  draft: ['draft'],
  awaiting_approval: ['pending_approval'],
  approved: ['approved'],
  pipeline: ['draft', 'pending_approval', 'approved'],
  rejected: ['declined'],
};

const STATUS_VIEW_LABELS = {
  draft: 'Draft',
  awaiting_approval: 'Awaiting Approval',
  approved: 'Approved',
  pipeline: 'Pipeline',
  rejected: 'Rejected',
};

const PERIOD_LABELS = {
  all: 'All Time',
  this_month: 'This Month',
  last_3: 'Last 3 Months',
  last_6: 'Last 6 Months',
  this_year: 'This Year',
  last_12: 'Last 12 Months',
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
  } else if (period === 'last_12') {
    from = new Date(now.getFullYear(), now.getMonth() - 12, now.getDate());
  }
  return from ? from.toISOString() : null;
}

export default function AnalysisPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  const [quotes, setQuotes] = useState([]);
  const [allLineItems, setAllLineItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [sortCol, setSortCol] = useState('created_at');
  const [sortAsc, setSortAsc] = useState(false);

  const metric = searchParams.get('metric');
  const period = searchParams.get('period') || 'all';
  const service = searchParams.get('service');
  const status = searchParams.get('status');
  const statusView = searchParams.get('statusView') || 'pipeline';
  const dateFrom = getDateRange(period);

  // Determine which statuses to filter by
  const effectiveStatuses = useMemo(() => {
    if (status) {
      // Direct status filter (e.g., clicking a specific status)
      return [status];
    }
    // Use statusView from dashboard context
    return STATUS_VIEW_FILTERS[statusView] || STATUS_VIEW_FILTERS.pipeline;
  }, [status, statusView]);

  const effectiveStatusLabel = status
    ? (status.charAt(0).toUpperCase() + status.slice(1)).replace('_', ' ')
    : STATUS_VIEW_LABELS[statusView] || 'Pipeline';

  const periodLabelText = PERIOD_LABELS[period] || 'All Time';

  // Build title
  const title = useMemo(() => {
    if (service) return `${service}: ${effectiveStatusLabel} (${periodLabelText})`;
    if (metric === 'totalAnnual') return `Annual Value: ${effectiveStatusLabel} (${periodLabelText})`;
    if (metric === 'activeQuotes') return `Active Quotes: ${effectiveStatusLabel} (${periodLabelText})`;
    if (metric === 'monthlyDD') return `Monthly Direct Debit: ${effectiveStatusLabel} (${periodLabelText})`;
    if (metric === 'total_clients') return `Total Clients: ${effectiveStatusLabel} (${periodLabelText})`;
    if (status) return `${effectiveStatusLabel} Quotes (${periodLabelText})`;
    return `Analysis: ${effectiveStatusLabel} (${periodLabelText})`;
  }, [metric, service, status, effectiveStatusLabel, periodLabelText]);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        // Always fetch line items for service drill-down
        const { data: items } = await supabase
          .from('quote_line_items')
          .select('id,quote_id,service_id,description,annual_amount');
        setAllLineItems(items || []);

        if (service) {
          // Fetch quotes that contain a specific service via line items
          const matchingQuoteIds = [
            ...new Set(
              (items || [])
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
            .in('status', effectiveStatuses)
            .order('created_at', { ascending: false });

          if (dateFrom) query = query.gte('created_at', dateFrom);

          const { data } = await query;
          setQuotes(data || []);
        } else {
          // Standard query -- filter by metric or status using effectiveStatuses
          let query = supabase
            .from('quotes')
            .select('*')
            .neq('status', 'deleted')
            .in('status', effectiveStatuses)
            .order('created_at', { ascending: false });

          if (dateFrom) query = query.gte('created_at', dateFrom);

          const { data } = await query;
          setQuotes(data || []);
        }
      } catch (e) {
        console.error('Analysis fetch error:', e);
      }
      setLoading(false);
    })();
  }, [metric, period, service, status, statusView, dateFrom, effectiveStatuses]);

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

  // For service drill-down, compute per-quote service amounts
  const serviceAmountByQuote = useMemo(() => {
    if (!service) return {};
    const map = {};
    allLineItems.forEach((li) => {
      if ((li.description || li.service_id) === service) {
        map[li.quote_id] = (map[li.quote_id] || 0) + (parseFloat(li.annual_amount) || 0);
      }
    });
    return map;
  }, [service, allLineItems]);

  const sorted = useMemo(() => {
    const list = [...quotes];

    // If service drill-down, add the service amount as a virtual field for sorting
    if (service) {
      list.forEach((q) => {
        q._serviceAnnual = serviceAmountByQuote[q.id] || 0;
      });
    }

    return list.sort((a, b) => {
      let va = a[sortCol], vb = b[sortCol];
      if (sortCol === '_serviceAnnual') {
        va = a._serviceAnnual || 0;
        vb = b._serviceAnnual || 0;
      }
      if (sortCol === 'created_at') { va = new Date(va); vb = new Date(vb); }
      if (sortCol === 'annual_total' || sortCol === 'monthly_net' || sortCol === 'monthly_gross' || sortCol === '_serviceAnnual') {
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
  }, [quotes, sortCol, sortAsc, service, serviceAmountByQuote]);

  // Summary number
  const summaryValue = useMemo(() => {
    if (metric === 'totalAnnual') return fmt(quotes.reduce((s, q) => s + (parseFloat(q.annual_total) || 0), 0));
    if (metric === 'monthlyDD') return fmt(quotes.reduce((s, q) => s + (parseFloat(q.monthly_gross) || 0), 0));
    if (service) {
      const total = quotes.reduce((s, q) => s + (serviceAmountByQuote[q.id] || 0), 0);
      return fmt(total);
    }
    return String(quotes.length);
  }, [quotes, metric, service, serviceAmountByQuote]);

  const summaryLabel = useMemo(() => {
    if (metric === 'totalAnnual') return 'Total Annual Value';
    if (metric === 'monthlyDD') return 'Total Monthly DD';
    if (service) return `Total Annual for ${service}`;
    return 'Total Quotes';
  }, [metric, service]);

  const isMoneySummary = metric === 'totalAnnual' || metric === 'monthlyDD' || !!service;

  // Export helpers
  const isServiceView = !!service;
  const TABLE_HEADERS = isServiceView
    ? ['Quote Ref', 'Client', 'Status', `${service} Annual`, 'Quote Annual (Net)', 'Monthly (Gross)', 'Created']
    : ['Quote Ref', 'Client', 'Status', 'Annual (Net)', 'Monthly (Net)', 'Monthly (Gross)', 'Created'];

  const buildRows = () =>
    sorted.map((q) => isServiceView
      ? [
          q.quote_ref || '',
          q.relationship_group || '',
          (q.status || 'draft').replace('_', ' '),
          fmt(serviceAmountByQuote[q.id] || 0),
          fmt(q.annual_total),
          fmt(q.monthly_gross),
          new Date(q.created_at).toLocaleDateString('en-GB'),
        ]
      : [
          q.quote_ref || '',
          q.relationship_group || '',
          (q.status || 'draft').replace('_', ' '),
          fmt(q.annual_total),
          fmt(q.monthly_net),
          fmt(q.monthly_gross),
          new Date(q.created_at).toLocaleDateString('en-GB'),
        ]
    );

  const handleExportCSV = () => {
    downloadCSV(title.replace(/[^a-zA-Z0-9 ]/g, '').replace(/\s+/g, '_') + '.csv', TABLE_HEADERS, buildRows());
  };

  const handleExportPDF = () => {
    downloadTablePdf(title, TABLE_HEADERS, buildRows());
  };

  const gridCols = isServiceView
    ? '1.5fr 1.5fr 0.8fr 1fr 1fr 1fr 0.8fr'
    : '1.5fr 1.5fr 0.8fr 1fr 1fr 1fr 0.8fr';

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
        <p className="text-xs text-gray-400 mb-1">{summaryLabel}</p>
        <p className={`text-2xl font-bold font-mono ${isMoneySummary ? 'text-green-700' : 'text-ocean-700'}`}>
          {loading ? '...' : summaryValue}
        </p>
        <p className="text-xs text-gray-400 mt-1">{quotes.length} quote{quotes.length !== 1 ? 's' : ''}</p>
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
            {isServiceView ? (
              <SortHeader col="_serviceAnnual" className="justify-end">{service} Annual</SortHeader>
            ) : (
              <SortHeader col="annual_total" className="justify-end">Annual (Net)</SortHeader>
            )}
            {isServiceView ? (
              <SortHeader col="annual_total" className="justify-end">Quote Annual</SortHeader>
            ) : (
              <span className="text-xs text-gray-400 text-right">Monthly (Net)</span>
            )}
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
              {isServiceView ? (
                <span className="text-right font-mono text-green-700 font-semibold">{fmt(serviceAmountByQuote[q.id] || 0)}</span>
              ) : (
                <span className="text-right font-mono text-gray-600">{fmt(q.annual_total)}</span>
              )}
              {isServiceView ? (
                <span className="text-right font-mono text-gray-500">{fmt(q.annual_total)}</span>
              ) : (
                <span className="text-right font-mono text-gray-500">{fmt(q.monthly_net)}</span>
              )}
              <span className="text-right font-mono text-ocean-600">{fmt(q.monthly_gross)}</span>
              <span className="text-right text-gray-500">{new Date(q.created_at).toLocaleDateString('en-GB')}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
