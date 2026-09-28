import React, { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { fetchAllRows } from '../lib/fetchAllRows';
import { useAuth } from '../shell/AppShell';
import { fmt, StatusBadge, Btn } from '../components/ui';

// Fee engine dashboard, in four bands:
//   A  the book today      — live_billing (fee-gated: can_view_client_fees)
//   B  needs doing         — uplifts, fee gaps, and quotes waiting on someone
//   C  quote pipeline      — every status tile the old page had, as a funnel,
//                            plus the summary cards, trend, revenue by service
//                            and recent quotes, all driven by the chosen stage
//   D  what the book is made of — service mix + top-10 concentration

const STATUS_VIEW_FILTERS = {
  draft: ['draft'],
  awaiting_approval: ['pending_approval'],
  approved: ['approved'],
  sent: ['sent'],
  accepted: ['accepted'],
  pipeline: ['draft', 'pending_approval', 'approved', 'sent', 'accepted'],
  committed: ['committed'],
  pipeline_committed: ['draft', 'pending_approval', 'approved', 'sent', 'accepted', 'committed'],
  rejected: ['declined'],
  expired: ['expired'],
};

const STATUS_VIEW_LABELS = {
  draft: 'Draft',
  awaiting_approval: 'Awaiting Approval',
  approved: 'Approved',
  sent: 'Sent to Client',
  accepted: 'Accepted',
  pipeline: 'Pipeline',
  committed: 'Committed',
  pipeline_committed: 'Pipeline + Committed',
  rejected: 'Rejected',
  expired: 'Expired',
};

// The funnel runs left to right, with the Pipeline total before Committed;
// Pipeline + Committed, Rejected and Expired sit beneath it.
const FUNNEL_STAGES = ['draft', 'awaiting_approval', 'approved', 'sent', 'accepted', 'pipeline', 'committed'];
const ROLLUP_STAGES = ['pipeline_committed', 'rejected', 'expired'];
// The two roll-up totals get a filled tile, like Total Pipeline on the Quotes list.
const HEADLINE_STAGES = ['pipeline', 'pipeline_committed'];

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
  if (value === 0) return { text: '£0.00', color: 'text-gray-400' };
  const prefix = value > 0 ? '+' : '-';
  const abs = Math.abs(value);
  const formatted = abs.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const color = value > 0 ? 'text-green-600' : 'text-red-600';
  return { text: `${prefix}£${formatted}`, color };
}

// Compact money for tiles: £467.9k, £950.
function fmtK(n) {
  const v = Number(n) || 0;
  if (Math.abs(v) >= 1000) return `£${(v / 1000).toLocaleString('en-GB', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}k`;
  return `£${Math.round(v).toLocaleString('en-GB')}`;
}

function daysSince(iso) {
  if (!iso) return 0;
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
}

// live_billing service_ids are "Category:Item" for the current catalogue, but
// older rows carry a bare legacy name ("Annual Statutory Accounts & Business
// Tax", "Bookkeeping (deleted)"). Fold both into one set of headings.
const SERVICE_GROUPS = [
  ['All inclusive', /all inclusive/i],
  ['Payroll', /payroll/i],
  ['Bookkeeping', /bookkeeping/i],
  ['Advisory', /advisory|management accounts|review meeting/i],
  ['Tax returns', /tax return|self assessment/i],
  ['Company secretarial', /company secretarial|confirmation statement|registered office|company administration/i],
  ['Accounts', /accounts/i],
];
function serviceGroup(serviceId) {
  const raw = String(serviceId || '');
  const head = raw.includes(':') ? raw.split(':')[0] : raw;
  const name = head.replace(/\s*\(deleted\)\s*$/i, '');
  for (const [label, re] of SERVICE_GROUPS) if (re.test(name)) return label;
  return 'Software & other';
}

// Same rule as the Uplift review page: a row has an uplift waiting if a live,
// approved service carries a pending amount.
function hasPendingUplift(row) {
  return Array.isArray(row.services) && row.services.some((s) =>
    s.pending_monthly_amount != null
    && s.recurring_status !== 'ending'
    && (s.approval_status || 'approved') === 'approved');
}

// Bar colours for the trend chart (Tailwind needs literal class names).
const STATUS_ORDER = ['draft', 'pending_approval', 'approved', 'sent', 'accepted', 'committed', 'declined', 'expired'];
const STATUS_LABELS = { draft: 'Draft', pending_approval: 'Awaiting Approval', approved: 'Approved', sent: 'Sent to Client', accepted: 'Accepted', committed: 'Committed', declined: 'Rejected', expired: 'Expired' };
const STATUS_BAR = {
  draft: 'bg-gray-300', pending_approval: 'bg-amber-300', approved: 'bg-sky-300', sent: 'bg-purple-300',
  accepted: 'bg-green-300', committed: 'bg-green-600', declined: 'bg-red-300', expired: 'bg-gray-400',
};

function SectionHead({ title, right }) {
  return (
    <div className="flex items-center justify-between mt-7 mb-2">
      <h3 className="text-sm font-semibold text-gray-700">{title}</h3>
      {right}
    </div>
  );
}

function BookTile({ label, value, suffix, sub }) {
  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <p className="text-xs text-gray-400 mb-1">{label}</p>
      <p className="text-2xl font-bold font-mono text-green-700">
        {value}{suffix && <span className="text-sm font-normal text-gray-400"> {suffix}</span>}
      </p>
      {sub && <p className="text-xs text-gray-400 mt-1">{sub}</p>}
    </div>
  );
}

// tone: 'danger' | 'warn' | null — a coloured left edge where money is at
// risk or something is overdue.
function ActionCard({ label, count, value, note, noteTone, tone, onClick }) {
  const edge = tone === 'danger' ? 'border-l-red-500' : tone === 'warn' ? 'border-l-amber-400' : 'border-l-gray-200';
  const quiet = !count;
  return (
    <button
      type="button"
      onClick={onClick}
      className={`text-left bg-white border border-gray-200 border-l-4 ${quiet ? 'border-l-gray-200' : edge} rounded-r-lg px-3 py-2.5 hover:border-ocean-300 transition-colors`}
    >
      <p className="text-xs text-gray-500">{label}</p>
      <p className={`text-xl font-bold font-mono ${quiet ? 'text-gray-300' : 'text-ocean-700'}`}>
        {count}
        {value > 0 && <span className="text-xs font-normal text-gray-400 ml-1.5">{fmtK(value)}</span>}
      </p>
      <p className={`text-[11px] ${noteTone === 'danger' && !quiet ? 'text-red-600' : 'text-gray-400'}`}>{quiet ? 'Nothing waiting' : note}</p>
    </button>
  );
}

export default function DashboardPage() {
  const navigate = useNavigate();
  const { profile } = useAuth();
  const canViewFees = profile?.can_view_client_fees === true;
  const [entities, setEntities] = useState([]);
  const [quotes, setQuotes] = useState([]);
  const [lineItems, setLineItems] = useState([]);
  const [book, setBook] = useState([]);
  const [gapCounts, setGapCounts] = useState({ tier1: 0, tier2: 0 });
  const [loading, setLoading] = useState(true);
  const [timePeriod, setTimePeriod] = useState('all');
  const [selectedServices, setSelectedServices] = useState([]);
  const [statusView, setStatusView] = useState('pipeline_committed');
  const [trendMode, setTrendMode] = useState('value'); // value | volume

  useEffect(() => {
    (async () => {
      try {
        const [{ data: ents }, { data: quots }, { data: items }] = await Promise.all([
          supabase.from('entities').select('id,created_at,entity_status'),
          supabase
            .from('quotes')
            .select('id,quote_ref,entity_id,status,monthly_gross,annual_total,created_at,valid_until,committed_at')
            .order('created_at', { ascending: false }),
          supabase
            .from('quote_line_items')
            .select('id,quote_id,service_id,description,annual_amount'),
        ]);
        setEntities(ents || []);
        setQuotes(quots || []);
        setLineItems(items || []);

        // The book and the gaps are fee-gated; RLS returns nothing to anyone
        // else, so don't ask.
        if (canViewFees) {
          const [rows, t1, t2] = await Promise.all([
            fetchAllRows(() => supabase
              .from('live_billing')
              .select('id,entity_id,billing_type,monthly_net,annual_total,services,uplift_go_live_date,entity:entities(entity_status)')
              .eq('status', 'active')
              .order('id')),
            supabase.from('v_fee_engine_gaps').select('entity_id', { count: 'exact', head: true }).eq('tier', 1).eq('review_status', 'pending'),
            supabase.from('v_fee_engine_gaps').select('entity_id', { count: 'exact', head: true }).eq('tier', 2).eq('review_status', 'pending'),
          ]);
          // Former clients are excluded at read time (sql/134).
          setBook((rows || []).filter((r) => r.entity?.entity_status !== 'nlac'));
          setGapCounts({ tier1: t1.count || 0, tier2: t2.count || 0 });
        }
      } catch (e) {
        console.error('Dashboard fetch error:', e);
      }
      setLoading(false);
    })();
  }, [canViewFees]);

  // ── A + D: the book ────────────────────────────────────────────────
  const bookStats = useMemo(() => {
    let recurringAnnual = 0, recurringMonthly = 0, recurringLines = 0;
    let annualBilled = 0, annualLines = 0;
    const perClient = {};
    const byGroup = {};
    let upliftsPending = 0, upliftsLiveThisMonth = 0;
    const now = new Date();
    const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    for (const r of book) {
      const annual = parseFloat(r.annual_total) || 0;
      if (r.billing_type === 'recurring') {
        recurringAnnual += annual;
        recurringMonthly += parseFloat(r.monthly_net) || 0;
        recurringLines += 1;
      } else if (r.billing_type === 'annual') {
        annualBilled += annual;
        annualLines += 1;
      }
      if (annual > 0) perClient[r.entity_id] = (perClient[r.entity_id] || 0) + annual;
      for (const s of Array.isArray(r.services) ? r.services : []) {
        const g = serviceGroup(s.service_id || s.description);
        byGroup[g] = (byGroup[g] || 0) + (parseFloat(s.annual_amount) || 0);
      }
      if (hasPendingUplift(r)) upliftsPending += 1;
      if (r.uplift_go_live_date && r.uplift_go_live_date.slice(0, 7) === monthKey) upliftsLiveThisMonth += 1;
    }

    const total = recurringAnnual + annualBilled;
    const clientTotals = Object.values(perClient).sort((a, b) => b - a);
    const clients = clientTotals.length;
    const top10 = clientTotals.slice(0, 10).reduce((s, v) => s + v, 0);
    const mix = Object.entries(byGroup)
      .map(([group, annual]) => ({ group, annual }))
      .filter((m) => m.annual > 0)
      .sort((a, b) => b.annual - a.annual);

    return {
      recurringAnnual, recurringMonthly, recurringLines, annualBilled, annualLines,
      total, clients, top10, mix, upliftsPending, upliftsLiveThisMonth,
    };
  }, [book]);

  // ── B: quotes waiting on someone (all time — a stale quote is stale
  // whatever period the page is showing) ─────────────────────────────
  const waiting = useMemo(() => {
    const by = (st) => quotes.filter((q) => q.status === st);
    const agg = (list) => ({
      count: list.length,
      value: list.reduce((s, q) => s + (parseFloat(q.annual_total) || 0), 0),
      oldest: list.reduce((m, q) => Math.max(m, daysSince(q.created_at)), 0),
    });
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const committedThisMonth = quotes.filter((q) => q.status === 'committed' && q.committed_at && q.committed_at >= monthStart);
    return {
      draft: agg(by('draft')),
      awaiting: agg(by('pending_approval')),
      approved: agg(by('approved')),
      sent: agg(by('sent')),
      accepted: agg(by('accepted')),
      expired: agg(by('expired')),
      committedThisMonth: agg(committedThisMonth),
    };
  }, [quotes]);

  // ── C: status tiles (filtered by time period, not by the chosen stage) ──
  const statusCards = useMemo(() => {
    const dateFrom = getDateRange(timePeriod);
    const timeFiltered = quotes.filter((q) => {
      if (q.status === 'deleted') return false;
      if (dateFrom && q.created_at < dateFrom) return false;
      return true;
    });

    const cards = {};
    Object.keys(STATUS_VIEW_FILTERS).forEach((key) => {
      const statuses = STATUS_VIEW_FILTERS[key];
      const matching = timeFiltered.filter((q) => statuses.includes(q.status));
      cards[key] = {
        volume: matching.length,
        value: matching.reduce((sum, q) => sum + (parseFloat(q.annual_total) || 0), 0),
      };
    });
    return cards;
  }, [quotes, timePeriod]);

  // Everything below the funnel follows the chosen stage + period.
  const filtered = useMemo(() => {
    const dateFrom = getDateRange(timePeriod);
    const allowedStatuses = STATUS_VIEW_FILTERS[statusView] || STATUS_VIEW_FILTERS.pipeline;

    const filteredQuotes = quotes.filter((q) => {
      if (q.status === 'deleted') return false;
      if (!allowedStatuses.includes(q.status)) return false;
      if (dateFrom && q.created_at < dateFrom) return false;
      return true;
    });

    // Current clients and prospects only — former (NLAC) and archived records
    // are not part of the book, and the status view doesn't apply to entities.
    const filteredEntities = entities.filter((e) => {
      if (e.entity_status === 'nlac' || e.entity_status === 'archived') return false;
      if (dateFrom && e.created_at < dateFrom) return false;
      return true;
    });

    const totalClients = filteredEntities.length;
    const activeQuoteCount = filteredQuotes.length;
    const totalAnnual = filteredQuotes.reduce((sum, q) => sum + (parseFloat(q.annual_total) || 0), 0);
    const totalMonthlyDD = filteredQuotes.reduce((sum, q) => sum + (parseFloat(q.monthly_gross) || 0), 0);

    // Quoted revenue by service (current period)
    const quoteIds = new Set(filteredQuotes.map((q) => q.id));
    const serviceMap = {};
    lineItems.forEach((li) => {
      if (!quoteIds.has(li.quote_id)) return;
      const key = li.description || li.service_id || 'Unknown';
      if (!serviceMap[key]) serviceMap[key] = { service: key, serviceId: li.service_id || '', totalAnnual: 0, quoteIds: new Set() };
      serviceMap[key].totalAnnual += parseFloat(li.annual_amount) || 0;
      serviceMap[key].quoteIds.add(li.quote_id);
    });

    // Previous period
    const prevRange = getPreviousDateRange(timePeriod);
    const prevQuoteIds = new Set(prevRange
      ? quotes.filter((q) => q.status !== 'deleted' && allowedStatuses.includes(q.status)
          && q.created_at >= prevRange.from && q.created_at < prevRange.to).map((q) => q.id)
      : []);
    const prevServiceMap = {};
    if (prevRange) {
      lineItems.forEach((li) => {
        if (!prevQuoteIds.has(li.quote_id)) return;
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

    const softwareRows = revenueByService.filter((r) => r.serviceId && r.serviceId.startsWith('software'));
    const serviceRows = revenueByService.filter((r) => !(r.serviceId && r.serviceId.startsWith('software')));
    const servicesTotalAnnual = serviceRows.reduce((s, r) => s + r.totalAnnual, 0);
    const servicesPrevAnnual = serviceRows.reduce((s, r) => s + r.prevAnnual, 0);
    const softwareTotalAnnual = softwareRows.reduce((s, r) => s + r.totalAnnual, 0);
    const softwarePrevAnnual = softwareRows.reduce((s, r) => s + r.prevAnnual, 0);

    const recentQuotes = filteredQuotes.slice(0, 8);
    const allServices = [...new Set(lineItems.map(li => li.description || li.service_id).filter(Boolean))].sort();

    // 12-month trend, stacked by status
    const months = [];
    const now = new Date();
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      months.push({ key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`, label: d.toLocaleDateString('en-GB', { month: 'short' }) });
    }
    const serviceFilteredQuotes = (selectedServices.length === 0)
      ? filteredQuotes
      : filteredQuotes.filter(q => lineItems.some(li => li.quote_id === q.id && selectedServices.includes(li.description || li.service_id)));
    const trendValue = {};
    const trendVolume = {};
    months.forEach(m => { trendValue[m.key] = {}; trendVolume[m.key] = {}; });
    serviceFilteredQuotes.forEach(q => {
      const d = new Date(q.created_at);
      const mKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      if (!trendValue[mKey]) return;
      const s = q.status || 'draft';
      let annual = parseFloat(q.annual_total) || 0;
      if (selectedServices.length > 0) {
        annual = lineItems
          .filter(li => li.quote_id === q.id && selectedServices.includes(li.description || li.service_id))
          .reduce((sum, li) => sum + (parseFloat(li.annual_amount) || 0), 0);
      }
      trendValue[mKey][s] = (trendValue[mKey][s] || 0) + annual;
      trendVolume[mKey][s] = (trendVolume[mKey][s] || 0) + 1;
    });

    return {
      totalClients, activeQuoteCount, totalAnnual, totalMonthlyDD,
      revenueByService, serviceRows, softwareRows,
      servicesTotalAnnual, servicesPrevAnnual, softwareTotalAnnual, softwarePrevAnnual,
      grandTotalAnnual: servicesTotalAnnual + softwareTotalAnnual,
      grandPrevAnnual: servicesPrevAnnual + softwarePrevAnnual,
      recentQuotes, allServices, months, trendValue, trendVolume,
    };
  }, [quotes, entities, lineItems, timePeriod, selectedServices, statusView]);

  const pLabel = periodLabel(timePeriod);
  const svLabel = STATUS_VIEW_LABELS[statusView];
  const hasPrevPeriod = timePeriod !== 'all';
  const gridCols = hasPrevPeriod ? '2fr 1fr 1fr 1fr 1fr' : '2fr 1fr 1fr';

  // Conversion: of quotes that left draft and reached a decision point,
  // how many were committed.
  const sentOrLater = ['sent', 'accepted', 'committed', 'declined', 'expired']
    .reduce((n, s) => n + quotes.filter((q) => q.status === s).length, 0);
  const committedAll = quotes.filter((q) => q.status === 'committed').length;
  const conversion = sentOrLater ? Math.round((committedAll / sentOrLater) * 100) : null;

  function renderRevenueRow(row, i) {
    const ch = fmtChange(row.change);
    return (
      <div
        key={i}
        className="grid gap-2 items-center text-gray-700 py-1 border-b border-gray-50 last:border-0 cursor-pointer hover:bg-gray-50 rounded px-1 -mx-1"
        style={{ gridTemplateColumns: gridCols }}
        onClick={() => navigate(`/manage/quotes/analysis?service=${encodeURIComponent(row.service)}&period=${timePeriod}&statusView=${statusView}`)}
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

  function StageTile({ viewKey, first, last }) {
    const isActive = statusView === viewKey;
    const d = statusCards[viewKey] || { volume: 0, value: 0 };
    const committed = viewKey === 'committed';
    if (HEADLINE_STAGES.includes(viewKey)) {
      return (
        <button
          type="button"
          onClick={() => setStatusView(viewKey)}
          className={`text-left p-2.5 border-2 transition-all ${first ? 'rounded-l-lg' : ''} ${last ? 'rounded-r-lg' : ''} ${
            isActive ? 'border-ocean-900 bg-ocean-700 shadow-sm' : 'border-ocean-600 bg-ocean-600 hover:border-ocean-800'
          }`}
        >
          <p className="text-[11px] font-semibold text-ocean-100">{STATUS_VIEW_LABELS[viewKey]}</p>
          <p className="text-lg font-bold font-mono text-white leading-tight">{d.volume}</p>
          <p className="text-[11px] font-mono font-semibold text-white">{fmt(d.value)}</p>
        </button>
      );
    }
    return (
      <button
        type="button"
        onClick={() => setStatusView(viewKey)}
        className={`text-left p-2.5 border-2 transition-all ${first ? 'rounded-l-lg' : ''} ${last ? 'rounded-r-lg' : ''} ${
          isActive ? 'border-ocean-500 bg-white shadow-sm' : `border-transparent ${committed ? 'bg-green-50' : 'bg-gray-50'} hover:border-ocean-300`
        }`}
      >
        <p className={`text-[11px] font-medium ${isActive ? 'text-ocean-700' : committed ? 'text-green-700' : 'text-gray-500'}`}>{STATUS_VIEW_LABELS[viewKey]}</p>
        <p className="text-lg font-bold font-mono text-ocean-700 leading-tight">{d.volume}</p>
        <p className="text-[11px] font-mono text-green-700">{fmt(d.value)}</p>
      </button>
    );
  }

  const trendData = trendMode === 'value' ? filtered.trendValue : filtered.trendVolume;
  const monthTotals = filtered.months.map((m) => Object.values(trendData[m.key] || {}).reduce((s, v) => s + v, 0));
  const trendMax = Math.max(1, ...monthTotals);
  const trendStatuses = STATUS_ORDER.filter((s) => filtered.months.some((m) => trendData[m.key]?.[s]));
  const mixMax = Math.max(1, ...bookStats.mix.map((m) => m.annual));
  const QUOTES_CARD = { rejected: 'declined', awaiting_approval: 'pending_approval' };

  return (
    <div className="p-6 max-w-6xl">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-lg font-bold text-ocean-700">Dashboard</h2>
        <div className="flex items-center gap-2">
          <select
            value={timePeriod}
            onChange={(e) => setTimePeriod(e.target.value)}
            className="text-sm border border-gray-200 rounded-lg px-3 py-1.5 text-gray-600 bg-white focus:outline-none focus:border-ocean-300"
          >
            {TIME_FILTERS.map((f) => (
              <option key={f.value} value={f.value}>{f.label}</option>
            ))}
          </select>
          <Btn onClick={() => navigate('/manage/quotes/new')}>New Quote</Btn>
        </div>
      </div>

      {loading ? (
        <p className="text-sm text-gray-400">Loading...</p>
      ) : (
        <>
          {/* A — the book today */}
          {canViewFees && (
            <>
              <SectionHead title="The book today" right={
                <button onClick={() => navigate('/manage/billing')} className="text-xs text-ocean-600 hover:text-ocean-700 underline">Open billing →</button>
              } />
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <BookTile label="Recurring (monthly direct debit)" value={fmtK(bookStats.recurringAnnual)} suffix="/yr"
                  sub={`${fmtK(bookStats.recurringMonthly)} a month net · ${bookStats.recurringLines} templates`} />
                <BookTile label="Annual-billed" value={fmtK(bookStats.annualBilled)} suffix="/yr"
                  sub={`${bookStats.annualLines} lines`} />
                <BookTile label="Total book" value={fmtK(bookStats.total)} suffix="/yr"
                  sub={`${bookStats.clients} clients · avg ${fmtK(bookStats.clients ? bookStats.total / bookStats.clients : 0)}`} />
              </div>
              <p className="text-xs text-gray-500 mt-2">
                This month:{' '}
                <span className={waiting.committedThisMonth.count ? 'text-green-700 font-medium' : ''}>
                  {waiting.committedThisMonth.count} quote{waiting.committedThisMonth.count === 1 ? '' : 's'} committed ({fmtK(waiting.committedThisMonth.value)})
                </span>
                {' · '}{bookStats.upliftsLiveThisMonth} uplift{bookStats.upliftsLiveThisMonth === 1 ? '' : 's'} going live
              </p>
            </>
          )}

          {/* B — needs doing */}
          <SectionHead title="Needs doing" />
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            {canViewFees && (
              <>
                <ActionCard label="Uplifts to review" count={bookStats.upliftsPending} tone="warn"
                  note="Open uplift review" onClick={() => navigate('/manage/billing/uplifts')} />
                <ActionCard label="Priority fee gaps" count={gapCounts.tier1 + gapCounts.tier2} tone="danger"
                  note={`${gapCounts.tier1} recurring service · ${gapCounts.tier2} company work`} onClick={() => navigate('/manage/billing/gaps')} />
              </>
            )}
            <ActionCard label="Awaiting approval" count={waiting.awaiting.count} value={waiting.awaiting.value} tone="warn"
              note={`Oldest ${waiting.awaiting.oldest} days`} onClick={() => navigate('/manage/quotes?card=pending_approval')} />
            <ActionCard label="Approved, not sent" count={waiting.approved.count} value={waiting.approved.value} tone="warn"
              note={`Oldest ${waiting.approved.oldest} days`} onClick={() => navigate('/manage/quotes?card=approved')} />
            <ActionCard label="Sent, no reply" count={waiting.sent.count} value={waiting.sent.value}
              tone={waiting.sent.oldest > 30 ? 'danger' : 'warn'} noteTone={waiting.sent.oldest > 30 ? 'danger' : null}
              note={`Oldest ${waiting.sent.oldest} days`} onClick={() => navigate('/manage/quotes?card=sent')} />
            <ActionCard label="Accepted, not committed" count={waiting.accepted.count} value={waiting.accepted.value}
              tone={waiting.accepted.oldest > 14 ? 'danger' : 'warn'} noteTone={waiting.accepted.oldest > 14 ? 'danger' : null}
              note={`Waiting ${waiting.accepted.oldest} days`} onClick={() => navigate('/manage/quotes?card=accepted')} />
            <ActionCard label="Drafts" count={waiting.draft.count} value={waiting.draft.value}
              note={`Oldest ${waiting.draft.oldest} days`} onClick={() => navigate('/manage/quotes?card=draft')} />
            <ActionCard label="Expired, chase or close" count={waiting.expired.count} value={waiting.expired.value}
              note={`Oldest ${waiting.expired.oldest} days`} onClick={() => navigate('/manage/quotes?card=expired')} />
          </div>

          {/* C — quote pipeline */}
          <SectionHead title={`Quote pipeline (${pLabel})`} right={
            conversion != null && <span className="text-xs text-gray-400">{conversion}% of sent quotes committed (all time)</span>
          } />
          <div className="bg-white rounded-lg border border-gray-200 p-4">
            <div className="grid grid-cols-3 md:grid-cols-7 gap-1">
              {FUNNEL_STAGES.map((k, i) => (
                <StageTile key={k} viewKey={k} first={i === 0} last={i === FUNNEL_STAGES.length - 1} />
              ))}
            </div>
            <div className="grid grid-cols-3 md:grid-cols-7 gap-1 mt-1">
              {ROLLUP_STAGES.map((k, i) => (
                <StageTile key={k} viewKey={k} first={i === 0} last={i === ROLLUP_STAGES.length - 1} />
              ))}
            </div>
            <button
              onClick={() => navigate(`/manage/quotes?card=${QUOTES_CARD[statusView] || statusView}`)}
              className="text-xs text-ocean-600 hover:text-ocean-700 underline mt-2"
            >
              View {statusCards[statusView]?.volume || 0} {svLabel.toLowerCase()} quote{(statusCards[statusView]?.volume || 0) === 1 ? '' : 's'} in the Quotes list →
            </button>

            {/* Summary for the chosen stage */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-4">
              {[
                { label: `Clients & prospects (${pLabel})`, value: filtered.totalClients, action: () => navigate('/manage/clients') },
                { label: `Quotes (${svLabel})`, value: filtered.activeQuoteCount, metric: 'active_quotes' },
                { label: `Annual value (${svLabel})`, value: fmt(filtered.totalAnnual), metric: 'totalAnnual', isMoney: true },
                { label: `Monthly direct debit (${svLabel})`, value: fmt(filtered.totalMonthlyDD), metric: 'monthlyDD', isMoney: true },
              ].map((s, i) => (
                <div
                  key={i}
                  onClick={s.action || (() => navigate(`/manage/quotes/analysis?metric=${s.metric}&period=${timePeriod}&statusView=${statusView}`))}
                  className="bg-gray-50 rounded-lg p-3 cursor-pointer hover:bg-ocean-50"
                >
                  <p className="text-[11px] text-gray-400 mb-0.5">{s.label}</p>
                  <p className={`text-lg font-bold font-mono ${s.isMoney ? 'text-green-700' : 'text-ocean-700'}`}>{s.value}</p>
                </div>
              ))}
            </div>

            {/* 12-month trend */}
            <div className="flex items-center justify-between mt-5 mb-2">
              <p className="text-xs font-semibold text-gray-600">
                Last 12 months by month created ({svLabel})
                {selectedServices.length > 0 && <span className="text-ocean-500 font-normal ml-2">({selectedServices.length} service{selectedServices.length === 1 ? '' : 's'})</span>}
              </p>
              <div className="flex rounded-md border border-gray-200 overflow-hidden text-[11px]">
                {['value', 'volume'].map((m) => (
                  <button key={m} onClick={() => setTrendMode(m)}
                    className={`px-2.5 py-1 ${trendMode === m ? 'bg-ocean-600 text-white' : 'bg-white text-gray-500 hover:bg-gray-50'}`}>
                    {m === 'value' ? 'Annual value' : 'Quote count'}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex items-end gap-1.5 h-36 border-b border-gray-200">
              {filtered.months.map((m, i) => {
                const total = monthTotals[i];
                return (
                  <div key={m.key} className="flex-1 flex flex-col items-center justify-end h-full min-w-0">
                    <span className="text-[10px] text-gray-400 font-mono mb-0.5">
                      {total ? (trendMode === 'value' ? fmtK(total) : total) : ''}
                    </span>
                    <div className="w-full max-w-[36px] flex flex-col-reverse" style={{ height: `${(total / trendMax) * 100}%`, minHeight: total ? 2 : 0 }}>
                      {trendStatuses.map((s) => {
                        const v = trendData[m.key]?.[s] || 0;
                        if (!v) return null;
                        return (
                          <div key={s} className={STATUS_BAR[s]} style={{ height: `${(v / total) * 100}%` }}
                            title={`${m.label}: ${STATUS_LABELS[s]} ${trendMode === 'value' ? fmt(v) : v}`} />
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="flex gap-1.5">
              {filtered.months.map((m) => (
                <span key={m.key} className="flex-1 text-center text-[10px] text-gray-400 pt-1">{m.label}</span>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-3 mt-2 text-[11px] text-gray-500">
              {trendStatuses.map((s) => (
                <span key={s} className="inline-flex items-center gap-1"><span className={`w-2.5 h-2.5 rounded-sm ${STATUS_BAR[s]}`} />{STATUS_LABELS[s]}</span>
              ))}
            </div>

            {filtered.allServices.length > 0 && (
              <details className="mt-3">
                <summary className="text-xs text-ocean-600 cursor-pointer select-none">
                  Filter by service{selectedServices.length > 0 ? ` (${selectedServices.length} selected)` : ''}
                </summary>
                <div className="flex flex-wrap gap-1.5 mt-2">
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
              </details>
            )}
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-5 gap-3 mt-3">
            {/* Quoted revenue by service */}
            <div className="bg-white rounded-lg border border-gray-200 p-4 lg:col-span-3">
              <h3 className="text-sm font-semibold text-gray-700 mb-2">Quoted revenue by service ({svLabel}, {pLabel})</h3>
              {filtered.revenueByService.length > 0 ? (
                <div className="grid gap-0 text-xs">
                  <div className="grid gap-2 items-center text-gray-400 font-medium border-b border-gray-200 pb-1.5 mb-1" style={{ gridTemplateColumns: gridCols }}>
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
                  {filtered.serviceRows.length > 0 && (
                    <>
                      <div className="text-[11px] text-gray-400 font-semibold pt-2 pb-1">Services</div>
                      {filtered.serviceRows.map((row, i) => renderRevenueRow(row, `svc-${i}`))}
                      {renderSubtotalRow('Services Subtotal', filtered.servicesTotalAnnual, filtered.servicesPrevAnnual, filtered.servicesTotalAnnual - filtered.servicesPrevAnnual)}
                    </>
                  )}
                  {filtered.softwareRows.length > 0 && (
                    <>
                      <div className="text-[11px] text-gray-400 font-semibold pt-3 pb-1">Software</div>
                      {filtered.softwareRows.map((row, i) => renderRevenueRow(row, `sw-${i}`))}
                      {renderSubtotalRow('Software Subtotal', filtered.softwareTotalAnnual, filtered.softwarePrevAnnual, filtered.softwareTotalAnnual - filtered.softwarePrevAnnual)}
                    </>
                  )}
                  {renderSubtotalRow('TOTAL', filtered.grandTotalAnnual, filtered.grandPrevAnnual, filtered.grandTotalAnnual - filtered.grandPrevAnnual)}
                </div>
              ) : (
                <p className="text-xs text-gray-400 py-4 text-center">No quotes for this stage and period.</p>
              )}
            </div>

            {/* Recent quotes */}
            <div className="bg-white rounded-lg border border-gray-200 p-4 lg:col-span-2">
              <h3 className="text-sm font-semibold text-gray-700 mb-2">Recent quotes ({svLabel})</h3>
              {filtered.recentQuotes.length === 0 && <p className="text-xs text-gray-400 py-4 text-center">None.</p>}
              {filtered.recentQuotes.map((q) => (
                <div
                  key={q.id}
                  onClick={() => navigate('/manage/quotes/' + q.id)}
                  className="flex items-center justify-between py-2 border-b border-gray-50 last:border-0 cursor-pointer hover:bg-gray-50 rounded px-1 -mx-1"
                >
                  <div className="min-w-0">
                    <p className="text-sm text-gray-700 truncate">{q.quote_ref}</p>
                    <p className="text-xs text-gray-400">
                      {new Date(q.created_at).toLocaleDateString('en-GB')}
                      {q.valid_until && (
                        <span className="ml-2 text-gray-300">Valid until {new Date(q.valid_until).toLocaleDateString('en-GB')}</span>
                      )}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <StatusBadge status={q.status} />
                    {q.monthly_gross != null && (
                      <span className="text-xs font-mono text-ocean-600">{fmt(q.monthly_gross)}/mo</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* D — what the book is made of */}
          {canViewFees && bookStats.mix.length > 0 && (
            <>
              <SectionHead title="What the book is made of" />
              <div className="bg-white rounded-lg border border-gray-200 p-4">
                {bookStats.mix.map((m) => (
                  <div key={m.group} className="grid items-center gap-3 text-xs py-1" style={{ gridTemplateColumns: '150px minmax(0,1fr) 70px 44px' }}>
                    <span className="text-gray-600 truncate">{m.group}</span>
                    <div className="h-2.5 bg-gray-100 rounded">
                      <div className="h-2.5 bg-ocean-500 rounded" style={{ width: `${(m.annual / mixMax) * 100}%` }} />
                    </div>
                    <span className="text-right font-mono text-gray-700">{fmtK(m.annual)}</span>
                    <span className="text-right font-mono text-gray-400">{bookStats.total ? Math.round((m.annual / bookStats.total) * 100) : 0}%</span>
                  </div>
                ))}
                <p className="text-xs text-gray-500 border-t border-gray-100 mt-2 pt-2">
                  Top 10 clients: {fmtK(bookStats.top10)}, {bookStats.total ? Math.round((bookStats.top10 / bookStats.total) * 100) : 0}% of the book
                </p>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
