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
  { label: 'Last 12 Months', value: 'last_12' },
];

function periodLabel(filter) {
  const map = {
    all: 'All Time',
    this_month: 'This Month',
    last_3: 'Last 3 Months',
    last_6: 'Last 6 Months',
    this_year: 'This Year',
    last_12: 'Last 12 Months',
  };
  return map[filter] || 'All Time';
}

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
  } else if (filter === 'last_12') {
    from = new Date(now.getFullYear(), now.getMonth() - 12, now.getDate());
  }
  return from ? from.toISOString() : null;
}

function getPreviousDateRange(filter) {
  if (filter === 'all') return null;
  const now = new Date();
  let from, to;
  if (filter === 'this_month') {
    // Previous period = last month
    from = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    to = new Date(now.getFullYear(), now.getMonth(), 1);
  } else if (filter === 'last_3') {
    from = new Date(now.getFullYear(), now.getMonth() - 6, now.getDate());
    to = new Date(now.getFullYear(), now.getMonth() - 3, now.getDate());
  } else if (filter === 'last_6') {
    from = new Date(now.getFullYear(), now.getMonth() - 12, now.getDate());
    to = new Date(now.getFullYear(), now.getMonth() - 6, now.getDate());
  } else if (filter === 'this_year') {
    from = new Date(now.getFullYear() - 1, 0, 1);
    to = new Date(now.getFullYear(), 0, 1);
  } else if (filter === 'last_12') {
    from = new Date(now.getFullYear(), now.getMonth() - 24, now.getDate());
    to = new Date(now.getFullYear(), now.getMonth() - 12, now.getDate());
  }
  return from && to ? { from: from.toISOString(), to: to.toISOString() } : null;
}

function fmtChange(value) {
  if (value === 0) return { text: '\u00A30.00', color: 'text-gray-400' };
  const prefix = value > 0 ? '+' : '-';
  const abs = Math.abs(value);
  const formatted = abs.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const color = value > 0 ? 'text-green-600' : 'text-red-600';
  return { text: `${prefix}\u00A3${formatted}`, color };
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

    // Revenue by service (current period)
    const activeQuoteIds = new Set(activeQuotes.map((q) => q.id));
    const serviceMap = {};
    lineItems.forEach((li) => {
      if (!activeQuoteIds.has(li.quote_id)) return;
      const key = li.description || li.service_id || 'Unknown';
      if (!serviceMap[key]) serviceMap[key] = { service: key, serviceId: li.service_id || '', totalAnnual: 0, quoteIds: new Set() };
      serviceMap[key].totalAnnual += parseFloat(li.annual_amount) || 0;
      serviceMap[key].quoteIds.add(li.quote_id);
    });

    // Revenue by service (previous period)
    const prevRange = getPreviousDateRange(timePeriod);
    const prevActiveQuotes = prevRange
      ? quotes.filter((q) => {
          if (q.status === 'deleted' || !ACTIVE_STATUSES.includes(q.status)) return false;
          return q.created_at >= prevRange.from && q.created_at < prevRange.to;
        })
      : [];
    const prevActiveQuoteIds = new Set(prevActiveQuotes.map((q) => q.id));
    const prevServiceMap = {};
    if (prevRange) {
      lineItems.forEach((li) => {
        if (!prevActiveQuoteIds.has(li.quote_id)) return;
        const key = li.description || li.service_id || 'Unknown';
        if (!prevServiceMap[key]) prevServiceMap[key] = { totalAnnual: 0 };
        prevServiceMap[key].totalAnnual += parseFloat(li.annual_amount) || 0;
      });
    }

    const revenueByService = Object.values(serviceMap)
      .map((s) => ({
        ...s,
        quoteCount: s.quoteIds.size,
        prevAnnual: prevServiceMap[s.service]?.totalAnnual || 0,
        change: s.totalAnnual - (prevServiceMap[s.service]?.totalAnnual || 0),
      }))
      .sort((a, b) => b.totalAnnual - a.totalAnnual);

    // Split into services vs software
    const softwareRows = revenueByService.filter((r) => r.serviceId && r.serviceId.startsWith('software'));
    const serviceRows = revenueByService.filter((r) => !(r.serviceId && r.serviceId.startsWith('software')));

    const servicesTotalAnnual = serviceRows.reduce((s, r) => s + r.totalAnnual, 0);
    const servicesPrevAnnual = serviceRows.reduce((s, r) => s + r.prevAnnual, 0);
    const softwareTotalAnnual = softwareRows.reduce((s, r) => s + r.totalAnnual, 0);
    const softwarePrevAnnual = softwareRows.reduce((s, r) => s + r.prevAnnual, 0);
    const grandTotalAnnual = servicesTotalAnnual + softwareTotalAnnual;
    const grandPrevAnnual = servicesPrevAnnual + softwarePrevAnnual;

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
      serviceRows,
      softwareRows,
      servicesTotalAnnual,
      servicesPrevAnnual,
      softwareTotalAnnual,
      softwarePrevAnnual,
      grandTotalAnnual,
      grandPrevAnnual,
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

  const pLabel = periodLabel(timePeriod);
  const hasPrevPeriod = timePeriod !== 'all';
  const prevPeriodLabel = {
    this_month: 'Last Month',
    last_3: 'Previous 3 Months',
    last_6: 'Previous 6 Months',
    this_year: 'Last Year',
    last_12: 'Previous 12 Months',
  }[timePeriod] || '';

  const gridCols = hasPrevPeriod
    ? '2fr 1fr 1fr 1fr 1fr'
    : '2fr 1fr 1fr';

  function renderRevenueRow(row, i) {
    const ch = fmtChange(row.change);
    return (
      <div
        key={i}
        className="grid gap-2 items-center text-gray-700 py-1 border-b border-gray-50 last:border-0 cursor-pointer hover:bg-gray-50 rounded px-1 -mx-1"
        style={{ gridTemplateColumns: gridCols }}
        onClick={() => navigate(`/manage/quotes/analysis?service=${encodeURIComponent(row.service)}&period=${timePeriod}`)}
      >
        <span className="truncate">{row.service}</span>
        <span className="text-right font-mono">{fmt(row.totalAnnual)}</span>
        {hasPrevPeriod && (
          <>
            <span className="text-right font-mono text-gray-400">{fmt(row.prevAnnual)}</span>
            <span className={`text-right font-mono ${ch.color}`}>{ch.text}</span>
          </>
        )}
        <span className="text-right font-mono">{row.quoteCount}</span>
      </div>
    );
  }

  function renderSubtotalRow(label, total, prev, change) {
    const ch = fmtChange(change);
    return (
      <div
        className="grid gap-2 items-center text-gray-700 py-1.5 border-t border-gray-300 font-semibold"
        style={{ gridTemplateColumns: gridCols }}
      >
        <span>{label}</span>
        <span className="text-right font-mono">{fmt(total)}</span>
        {hasPrevPeriod && (
          <>
            <span className="text-right font-mono text-gray-400">{fmt(prev)}</span>
            <span className={`text-right font-mono ${ch.color}`}>{ch.text}</span>
          </>
        )}
        <span className="text-right font-mono"></span>
      </div>
    );
  }

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
              {
                label: `Total Clients (${pLabel})`,
                value: filtered.totalClients,
                metric: 'total_clients',
                action: () => navigate('/manage/clients'),
              },
              {
                label: `Active Quotes (${pLabel})`,
                value: filtered.activeQuoteCount,
                metric: 'active_quotes',
                action: () => navigate('/manage/quotes'),
              },
              {
                label: `Annual Value (${pLabel})`,
                value: fmt(filtered.totalAnnual),
                metric: 'total_annual',
                isMoney: true,
              },
              {
                label: `Monthly Direct Debit (${pLabel})`,
                value: fmt(filtered.totalMonthlyDD),
                metric: 'monthly_dd',
                isMoney: true,
              },
            ].map((s, i) => (
              <div
                key={i}
                onClick={s.action || (() => navigate(`/manage/quotes/analysis?metric=${s.metric}&period=${timePeriod}`))}
                className="bg-white rounded-lg border border-gray-200 p-4 cursor-pointer hover:border-ocean-300"
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
              <h3 className="text-sm font-semibold text-gray-700 mb-3">Quotes by Status ({pLabel})</h3>
              <div className="flex flex-wrap gap-2">
                {STATUS_ORDER.filter((s) => filtered.statusCounts[s]).map((s) => (
                  <div
                    key={s}
                    className="flex items-center gap-1.5 cursor-pointer hover:opacity-75"
                    onClick={() => navigate(`/manage/quotes/analysis?status=${s}&period=${timePeriod}`)}
                  >
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
              <h3 className="text-sm font-semibold text-gray-700 mb-3">Revenue by Service ({pLabel})</h3>
              <div className="grid gap-0 text-xs">
                {/* Header */}
                <div
                  className="grid gap-2 items-center text-gray-400 font-medium border-b border-gray-200 pb-1.5 mb-1"
                  style={{ gridTemplateColumns: gridCols }}
                >
                  <span>Service</span>
                  <span className="text-right">Annual (Net)</span>
                  {hasPrevPeriod && (
                    <>
                      <span className="text-right">Previous Period</span>
                      <span className="text-right">Change</span>
                    </>
                  )}
                  <span className="text-right">Quotes</span>
                </div>

                {/* Services section */}
                {filtered.serviceRows.length > 0 && (
                  <>
                    <div className="text-[10px] uppercase tracking-wider text-gray-400 font-semibold pt-2 pb-1">Services</div>
                    {filtered.serviceRows.map((row, i) => renderRevenueRow(row, `svc-${i}`))}
                    {renderSubtotalRow('Services Subtotal', filtered.servicesTotalAnnual, filtered.servicesPrevAnnual, filtered.servicesTotalAnnual - filtered.servicesPrevAnnual)}
                  </>
                )}

                {/* Software section */}
                {filtered.softwareRows.length > 0 && (
                  <>
                    <div className="text-[10px] uppercase tracking-wider text-gray-400 font-semibold pt-3 pb-1">Software</div>
                    {filtered.softwareRows.map((row, i) => renderRevenueRow(row, `sw-${i}`))}
                    {renderSubtotalRow('Software Subtotal', filtered.softwareTotalAnnual, filtered.softwarePrevAnnual, filtered.softwareTotalAnnual - filtered.softwarePrevAnnual)}
                  </>
                )}

                {/* Grand total */}
                {renderSubtotalRow('TOTAL', filtered.grandTotalAnnual, filtered.grandPrevAnnual, filtered.grandTotalAnnual - filtered.grandPrevAnnual)}
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
              <h3 className="text-sm font-semibold text-gray-700 mb-3">Recent Quotes ({pLabel})</h3>
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
