import React, { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { fmt, StatusBadge, Btn } from '../components/ui';

const ACTIVE_STATUSES = ['draft', 'pending_approval', 'approved', 'sent', 'accepted'];

const TIME_FILTERS = [
  { label: 'All Time', value: 'all' },
  { label: 'This Month', value: 'this_month' },
  { label: 'Last 3 Months', value: 'last_3' },
  { label: 'Last 6 Months', value: 'last_6' },
  { label: 'This Year', value: 'this_year' },
];

function getDateRange(filter) {
  if (filter === 'all') return null;
  const now = new Date();
  let from;
  if (filter === 'this_month') {
    from = new Date(now.getFullYear(), now.getMonth(), 1);
  } else if (filter === 'last_3') {
    from = new Date(now.getFullYear(), now.getMonth() - 3, now.getDate());
  } else if (filter === 'last_6') {
    from = new Date(now.getFullYear(), now.getMonth() - 6, now.getDate());
  } else if (filter === 'this_year') {
    from = new Date(now.getFullYear(), 0, 1);
  }
  return from ? from.toISOString() : null;
}

export default function DashboardPage() {
  const navigate = useNavigate();
  const [entities, setEntities] = useState([]);
  const [quotes, setQuotes] = useState([]);
  const [lineItems, setLineItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [timePeriod, setTimePeriod] = useState('all');
  const [selectedServices, setSelectedServices] = useState([]);

  useEffect(() => {
    (async () => {
      try {
        const [{ data: ents }, { data: quots }, { data: items }] = await Promise.all([
          supabase.from('entities').select('id,created_at'),
          supabase
            .from('quotes')
            .select('id,quote_ref,entity_id,status,monthly_gross,annual_total,created_at,valid_until')
            .order('created_at', { ascending: false }),
          supabase
            .from('quote_line_items')
            .select('id,quote_id,service_id,description,annual_amount'),
        ]);
        setEntities(ents || []);
        setQuotes(quots || []);
        setLineItems(items || []);
      } catch (e) {
        console.error('Dashboard fetch error:', e);
      }
      setLoading(false);
    })();
  }, []);

  // Derived filtered data
  const filtered = useMemo(() => {
    const dateFrom = getDateRange(timePeriod);

    const filteredQuotes = quotes.filter((q) => {
      if (dateFrom && q.created_at < dateFrom) return false;
      return true;
    });

    const activeQuotes = filteredQuotes.filter(
      (q) => q.status !== 'deleted' && ACTIVE_STATUSES.includes(q.status)
    );

    const nonDeletedQuotes = filteredQuotes.filter(
      (q) => q.status !== 'deleted' && q.status !== 'expired' && q.status !== 'declined'
    );

    const filteredEntities = entities.filter((e) => {
      if (dateFrom && e.created_at < dateFrom) return false;
      return true;
    });

    // Summary stats
    const totalClients = filteredEntities.length;
    const activeQuoteCount = activeQuotes.length;
    const totalAnnual = activeQuotes.reduce((sum, q) => sum + (parseFloat(q.annual_total) || 0), 0);
    const totalMonthlyDD = activeQuotes.reduce((sum, q) => sum + (parseFloat(q.monthly_gross) || 0), 0);

    // Status breakdown across all non-deleted filtered quotes
    const statusCounts = {};
    filteredQuotes
      .filter((q) => q.status !== 'deleted')
      .forEach((q) => {
        const s = q.status || 'draft';
        statusCounts[s] = (statusCounts[s] || 0) + 1;
      });

    // Revenue by service
    const activeQuoteIds = new Set(activeQuotes.map((q) => q.id));
    const serviceMap = {};
    lineItems.forEach((li) => {
      if (!activeQuoteIds.has(li.quote_id)) return;
      const key = li.description || li.service_id || 'Unknown';
      if (!serviceMap[key]) serviceMap[key] = { service: key, totalAnnual: 0, quoteIds: new Set() };
      serviceMap[key].totalAnnual += parseFloat(li.annual_amount) || 0;
      serviceMap[key].quoteIds.add(li.quote_id);
    });
    const revenueByService = Object.values(serviceMap)
      .map((s) => ({ ...s, quoteCount: s.quoteIds.size }))
      .sort((a, b) => b.totalAnnual - a.totalAnnual);

    // Recent quotes (non-deleted, non-expired, non-declined)
    const recentQuotes = nonDeletedQuotes.slice(0, 8);

    // All unique services for filter
    const allServices = [...new Set(lineItems.map(li => li.description || li.service_id).filter(Boolean))].sort();

    // 12-month trend data
    const months = [];
    const now = new Date();
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      months.push({ key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`, label: d.toLocaleDateString('en-GB', { month: 'short', year: '2-digit' }) });
    }

    // Filter quotes by selected services
    const serviceFilteredQuotes = (selectedServices.length === 0)
      ? filteredQuotes.filter(q => q.status !== 'deleted')
      : filteredQuotes.filter(q => {
          if (q.status === 'deleted') return false;
          const qLineItems = lineItems.filter(li => li.quote_id === q.id);
          return qLineItems.some(li => selectedServices.includes(li.description || li.service_id));
        });

    // Build trend: { month -> { status -> { value, count } } }
    const trendValue = {};
    const trendVolume = {};
    months.forEach(m => { trendValue[m.key] = {}; trendVolume[m.key] = {}; });

    serviceFilteredQuotes.forEach(q => {
      const d = new Date(q.created_at);
      const mKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      if (!trendValue[mKey]) return;
      const s = q.status || 'draft';

      // If services are selected, sum only those line items' annual values
      let annual = parseFloat(q.annual_total) || 0;
      if (selectedServices.length > 0) {
        const qLines = lineItems.filter(li => li.quote_id === q.id && selectedServices.includes(li.description || li.service_id));
        annual = qLines.reduce((sum, li) => sum + (parseFloat(li.annual_amount) || 0), 0);
      }

      trendValue[mKey][s] = (trendValue[mKey][s] || 0) + annual;
      trendVolume[mKey][s] = (trendVolume[mKey][s] || 0) + 1;
    });

    return {
      totalClients,
      activeQuoteCount,
      totalAnnual,
      totalMonthlyDD,
      statusCounts,
      revenueByService,
      recentQuotes,
      allServices,
      months,
      trendValue,
      trendVolume,
    };
  }, [quotes, entities, lineItems, timePeriod, selectedServices]);

  const STATUS_ORDER = ['draft', 'pending_approval', 'approved', 'sent', 'accepted', 'declined', 'expired'];
  const STATUS_LABELS = {
    draft: 'Draft',
    pending_approval: 'Pending',
    approved: 'Approved',
    sent: 'Sent',
    accepted: 'Accepted',
    declined: 'Declined',
    expired: 'Expired',
  };

  return (
    <div className="p-6 max-w-4xl">
      {/* Header row with title + time filter */}
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-bold text-ocean-700">Dashboard</h2>
        <select
          value={timePeriod}
          onChange={(e) => setTimePeriod(e.target.value)}
          className="text-sm border border-gray-200 rounded-lg px-3 py-1.5 text-gray-600 bg-white focus:outline-none focus:border-ocean-300"
        >
          {TIME_FILTERS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
      </div>

      {loading ? (
        <p className="text-sm text-gray-400">Loading...</p>
      ) : (
        <>
          {/* Summary cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
            {[
              { label: 'Total Clients', value: filtered.totalClients, action: () => navigate('/manage/clients') },
              { label: 'Active Quotes', value: filtered.activeQuoteCount, action: () => navigate('/manage/quotes') },
              { label: 'Total Annual Value', value: fmt(filtered.totalAnnual), isMoney: true },
              { label: 'Monthly Direct Debit', value: fmt(filtered.totalMonthlyDD), isMoney: true },
            ].map((s, i) => (
              <div
                key={i}
                onClick={s.action}
                className={`bg-white rounded-lg border border-gray-200 p-4 ${s.action ? 'cursor-pointer hover:border-ocean-300' : ''}`}
              >
                <p className="text-xs text-gray-400 mb-1">{s.label}</p>
                <p className={`text-xl font-bold font-mono ${s.isMoney ? 'text-green-700' : 'text-ocean-700'}`}>
                  {s.value}
                </p>
              </div>
            ))}
          </div>

          {/* Quotes by status breakdown */}
          {Object.keys(filtered.statusCounts).length > 0 && (
            <div className="bg-white rounded-lg border border-gray-200 p-4 mb-6">
              <h3 className="text-sm font-semibold text-gray-700 mb-3">Quotes by Status</h3>
              <div className="flex flex-wrap gap-2">
                {STATUS_ORDER.filter((s) => filtered.statusCounts[s]).map((s) => (
                  <div key={s} className="flex items-center gap-1.5">
                    <span className="text-sm font-mono font-semibold text-gray-700">{filtered.statusCounts[s]}</span>
                    <StatusBadge status={s} />
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Revenue by Service */}
          {filtered.revenueByService.length > 0 && (
            <div className="bg-white rounded-lg border border-gray-200 p-4 mb-6">
              <h3 className="text-sm font-semibold text-gray-700 mb-3">Revenue by Service</h3>
              <div className="grid gap-0 text-xs">
                {/* Header */}
                <div
                  className="grid gap-2 items-center text-gray-400 font-medium border-b border-gray-200 pb-1.5 mb-1"
                  style={{ gridTemplateColumns: '2fr 1fr 1fr' }}
                >
                  <span>Service</span>
                  <span className="text-right">Total Annual</span>
                  <span className="text-right">Quotes</span>
                </div>
                {/* Rows */}
                {filtered.revenueByService.map((row, i) => (
                  <div
                    key={i}
                    className="grid gap-2 items-center text-gray-700 py-1 border-b border-gray-50 last:border-0"
                    style={{ gridTemplateColumns: '2fr 1fr 1fr' }}
                  >
                    <span className="truncate">{row.service}</span>
                    <span className="text-right font-mono">{fmt(row.totalAnnual)}</span>
                    <span className="text-right font-mono">{row.quoteCount}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Service Filter */}
          {filtered.allServices.length > 0 && (
            <div className="bg-white rounded-lg border border-gray-200 p-4 mb-6">
              <h3 className="text-sm font-semibold text-gray-700 mb-2">Filter by Service</h3>
              <p className="text-xs text-gray-400 mb-2">Select services to filter trend tables. Numbers will total across selected services.</p>
              <div className="flex flex-wrap gap-1.5">
                {filtered.allServices.map(s => (
                  <button
                    key={s}
                    onClick={() => setSelectedServices(prev => prev.includes(s) ? prev.filter(x => x !== s) : [...prev, s])}
                    className={`text-xs px-2.5 py-1 rounded-full border transition-all ${
                      selectedServices.includes(s)
                        ? 'bg-ocean-600 text-white border-ocean-600'
                        : 'bg-white text-gray-500 border-gray-200 hover:border-ocean-300'
                    }`}
                  >
                    {s}
                  </button>
                ))}
                {selectedServices.length > 0 && (
                  <button onClick={() => setSelectedServices([])} className="text-xs text-gray-400 hover:text-gray-600 px-2">Clear all</button>
                )}
              </div>
            </div>
          )}

          {/* 12-Month Trend: Annual Values */}
          {filtered.months.length > 0 && (
            <div className="bg-white rounded-lg border border-gray-200 p-4 mb-6 overflow-x-auto">
              <h3 className="text-sm font-semibold text-gray-700 mb-3">
                12-Month Trend: Annual Values
                {selectedServices.length > 0 && <span className="text-xs text-ocean-500 font-normal ml-2">({selectedServices.length} services selected)</span>}
              </h3>
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-gray-200">
                    <th className="text-left py-1.5 pr-2 text-gray-400 font-medium">Status</th>
                    {filtered.months.map(m => <th key={m.key} className="text-right py-1.5 px-1 text-gray-400 font-medium min-w-[60px]">{m.label}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {STATUS_ORDER.filter(s => s !== 'deleted').map(s => {
                    const hasData = filtered.months.some(m => filtered.trendValue[m.key]?.[s]);
                    if (!hasData) return null;
                    return (
                      <tr key={s} className="border-b border-gray-50">
                        <td className="py-1.5 pr-2"><StatusBadge status={s} /></td>
                        {filtered.months.map(m => (
                          <td key={m.key} className="text-right py-1.5 px-1 font-mono text-gray-600">
                            {filtered.trendValue[m.key]?.[s] ? fmt(filtered.trendValue[m.key][s]) : <span className="text-gray-200">-</span>}
                          </td>
                        ))}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* 12-Month Trend: Volumes */}
          {filtered.months.length > 0 && (
            <div className="bg-white rounded-lg border border-gray-200 p-4 mb-6 overflow-x-auto">
              <h3 className="text-sm font-semibold text-gray-700 mb-3">
                12-Month Trend: Quote Volumes
                {selectedServices.length > 0 && <span className="text-xs text-ocean-500 font-normal ml-2">({selectedServices.length} services selected)</span>}
              </h3>
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-gray-200">
                    <th className="text-left py-1.5 pr-2 text-gray-400 font-medium">Status</th>
                    {filtered.months.map(m => <th key={m.key} className="text-right py-1.5 px-1 text-gray-400 font-medium min-w-[60px]">{m.label}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {STATUS_ORDER.filter(s => s !== 'deleted').map(s => {
                    const hasData = filtered.months.some(m => filtered.trendVolume[m.key]?.[s]);
                    if (!hasData) return null;
                    return (
                      <tr key={s} className="border-b border-gray-50">
                        <td className="py-1.5 pr-2"><StatusBadge status={s} /></td>
                        {filtered.months.map(m => (
                          <td key={m.key} className="text-right py-1.5 px-1 font-mono text-gray-600">
                            {filtered.trendVolume[m.key]?.[s] || <span className="text-gray-200">-</span>}
                          </td>
                        ))}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* Recent Quotes */}
          {filtered.recentQuotes.length > 0 && (
            <div className="bg-white rounded-lg border border-gray-200 p-4 mb-6">
              <h3 className="text-sm font-semibold text-gray-700 mb-3">Recent Quotes</h3>
              {filtered.recentQuotes.map((q) => (
                <div
                  key={q.id}
                  onClick={() => navigate('/manage/quotes/' + q.id)}
                  className="flex items-center justify-between py-2 border-b border-gray-50 last:border-0 cursor-pointer hover:bg-gray-50 rounded px-1 -mx-1"
                >
                  <div>
                    <p className="text-sm text-gray-700">{q.quote_ref}</p>
                    <p className="text-xs text-gray-400">
                      {new Date(q.created_at).toLocaleDateString('en-GB')}
                      {q.valid_until && (
                        <span className="ml-2 text-gray-300">
                          Valid until {new Date(q.valid_until).toLocaleDateString('en-GB')}
                        </span>
                      )}
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    {q.monthly_gross != null && (
                      <span className="text-sm font-mono text-ocean-600">{fmt(q.monthly_gross)}/mo</span>
                    )}
                    <StatusBadge status={q.status} />
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="mt-2">
            <Btn onClick={() => navigate('/manage/quotes/new')}>New Quote</Btn>
          </div>
        </>
      )}
    </div>
  );
}
