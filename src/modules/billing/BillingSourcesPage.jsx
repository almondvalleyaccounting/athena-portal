import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { AlertTriangle, FileText, ExternalLink } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import BillingTabs from './BillingTabs';
import SearchInput from '../../components/SearchInput';
import EmptyState from '../../components/EmptyState';
import { fmtGbp } from '../../lib/money';
import { tones } from '../../lib/tokens';

const font = "'Outfit', sans-serif";

// Source-of-billing breakdown. Splits active clients into:
//   - Template-driven   : has qbo_recurring_txn_id (QBO auto-bills)
//   - Manual (monthly)  : monthly billing but no template — this is
//                         the at-risk bucket; QBO is invoicing these
//                         manually each month rather than from a
//                         recurring template.
//   - Other             : no monthly recurring billing (annual-only,
//                         one-offs, or no billing recorded)
export default function BillingSourcesPage() {
  const navigate = useNavigate();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [searchParams, setSearchParams] = useSearchParams();
  const [filter, setFilter] = useState('manual'); // manual | template | other | all
  const bandParam = searchParams.get('band'); // lt250 | 250 | 500 | 750 | 1000 | null

  // Band definitions kept in sync with the dashboard tiles.
  const BANDS = {
    lt250: { label: '<£250',     min: 0,    max: 250  },
    '250': { label: '£250–£499', min: 250,  max: 500  },
    '500': { label: '£500–£749', min: 500,  max: 750  },
    '750': { label: '£750–£999', min: 750,  max: 1000 },
    '1000':{ label: '£1,000+',   min: 1000, max: Infinity },
  };
  const activeBand = bandParam && BANDS[bandParam] ? BANDS[bandParam] : null;

  // When a band is pre-selected from the dashboard, default to "All"
  // source filter so the user sees every client in that band.
  useEffect(() => { if (activeBand) setFilter('all'); }, [bandParam]); // eslint-disable-line react-hooks/exhaustive-deps

  const load = async () => {
    setLoading(true);
    const { data } = await supabase
      .from('live_billing')
      .select('id, qbo_recurring_txn_id, qbo_customer_id, services, entity:entities(id, name, entity_status, qbo_customer_id)')
      .eq('status', 'active');
    setRows((data || []).filter((r) => (r.entity?.entity_status || 'active') !== 'nlac'));
    setLoading(false);
  };
  useEffect(() => { load(); }, []);

  const classified = useMemo(() => rows.map((r) => {
    const services = Array.isArray(r.services) ? r.services : [];
    const monthlyNet = services.reduce((sum, s) => {
      if (s.cadence !== 'monthly') return sum;
      if (s.recurring_status === 'ending') return sum;
      const status = s.approval_status || (r.qbo_recurring_txn_id ? 'approved' : 'suggested');
      if (status !== 'approved') return sum;
      return sum + (Number(s.monthly_amount) || 0);
    }, 0);
    const monthlyCount = services.filter((s) => s.cadence === 'monthly' && s.recurring_status !== 'ending').length;
    let source;
    if (r.qbo_recurring_txn_id) source = 'template';
    else if (monthlyNet > 0)    source = 'manual';
    else                        source = 'other';
    return {
      id: r.id,
      entityId: r.entity?.id,
      entityName: r.entity?.name || 'Unknown',
      qboCustomerId: r.qbo_customer_id || r.entity?.qbo_customer_id,
      qboTxnId: r.qbo_recurring_txn_id,
      monthlyNet: Math.round(monthlyNet * 100) / 100,
      monthlyCount,
      source,
    };
  }).sort((a, b) => a.entityName.localeCompare(b.entityName)), [rows]);

  const counts = useMemo(() => {
    const c = { template: 0, manual: 0, other: 0, all: classified.length };
    let manualAtRisk = 0;
    for (const r of classified) {
      c[r.source]++;
      if (r.source === 'manual') manualAtRisk += r.monthlyNet;
    }
    return { ...c, manualAtRisk: Math.round(manualAtRisk * 100) / 100 };
  }, [classified]);

  const visible = useMemo(() => {
    let out = classified;
    if (filter !== 'all') out = out.filter((r) => r.source === filter);
    if (activeBand) out = out.filter((r) => r.monthlyNet >= activeBand.min && r.monthlyNet < activeBand.max);
    const q = search.trim().toLowerCase();
    if (q) out = out.filter((r) => r.entityName.toLowerCase().includes(q));
    return out;
  }, [classified, filter, search, activeBand]);

  return (
    <div style={{ padding: '20px 28px', fontFamily: font, maxWidth: 1280 }}>
      <h1 style={{ fontFamily: "'Playfair Display', serif", fontSize: 26, fontWeight: 500, color: '#0f172a', marginBottom: 2 }}>
        Billing sources
      </h1>
      <p style={{ fontSize: 13, color: '#64748b', maxWidth: 720, marginBottom: 14 }}>
        See which clients are billed from a QBO recurring template versus billed manually each month. Manual-monthly is a process risk — those clients should have a template.
      </p>

      <BillingTabs active="sources" />

      {loading ? (
        <p style={{ fontSize: 13, color: '#94a3b8', padding: 40, textAlign: 'center' }}>Loading…</p>
      ) : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, marginBottom: 14 }}>
            <Tile
              tone="success"
              label="Template-driven"
              value={counts.template}
              hint="QBO auto-bills these from a recurring template"
              icon={<FileText size={16} />}
              onClick={() => setFilter('template')}
              active={filter === 'template'}
            />
            <Tile
              tone="danger"
              label="Manual monthly (process risk)"
              value={counts.manual}
              hint={`${fmtGbp(counts.manualAtRisk)}/month being invoiced by hand`}
              icon={<AlertTriangle size={16} />}
              onClick={() => setFilter('manual')}
              active={filter === 'manual'}
              alarm
            />
            <Tile
              tone="neutral"
              label="No monthly recurring"
              value={counts.other}
              hint="Annual-only, one-offs, or no billing recorded"
              onClick={() => setFilter('other')}
              active={filter === 'other'}
            />
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
            <Pill label="All" count={counts.all} active={filter === 'all'} onClick={() => setFilter('all')} />
            <Pill label="Template" count={counts.template} active={filter === 'template'} tone="success" onClick={() => setFilter('template')} />
            <Pill label="Manual" count={counts.manual} active={filter === 'manual'} tone="danger" onClick={() => setFilter('manual')} />
            <Pill label="Other" count={counts.other} active={filter === 'other'} tone="neutral" onClick={() => setFilter('other')} />
            {activeBand && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 10px', background: '#dbeafe', color: '#0c4a6e', borderRadius: 999, fontSize: 12, fontWeight: 500 }}>
                Band: <strong>{activeBand.label}</strong>
                <button
                  onClick={() => { searchParams.delete('band'); setSearchParams(searchParams, { replace: true }); }}
                  title="Clear band filter"
                  style={{ background: 'transparent', border: 'none', color: '#0c4a6e', cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: 0 }}
                >×</button>
              </span>
            )}
            <SearchInput
              value={search}
              onChange={setSearch}
              placeholder="Search client…"
              style={{ flex: 1, minWidth: 220, marginLeft: 'auto' }}
            />
          </div>

          {visible.length === 0 ? (
            <EmptyState
              icon="—"
              title="No clients in this view"
              body="Try a different filter or clear the search."
              actions={[{ label: 'Show all', onClick: () => setFilter('all') }]}
            />
          ) : (
            <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ background: '#f8fafc' }}>
                    <Th>Client</Th>
                    <Th>Source</Th>
                    <Th align="right">Monthly £</Th>
                    <Th align="right">Lines</Th>
                    <Th></Th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((r) => (
                    <tr key={r.id} style={{ borderTop: '1px solid #f1f5f9' }}>
                      <Td>
                        <a href={`/clients/${r.entityId}`} onClick={(e) => { e.preventDefault(); navigate(`/clients/${r.entityId}`); }} style={{ color: '#0f172a', textDecoration: 'none', fontWeight: 500 }}>
                          {r.entityName}
                        </a>
                      </Td>
                      <Td>
                        {r.source === 'template' && <SourceChip tone="success" label="QBO Template" title={`Template txn id ${r.qboTxnId}`} />}
                        {r.source === 'manual'   && <SourceChip tone="danger"  label="Manual (no template)" title="Monthly billing without a QBO recurring template — invoiced by hand" />}
                        {r.source === 'other'    && <SourceChip tone="neutral" label="No monthly" />}
                      </Td>
                      <Td align="right" style={{ fontFamily: 'monospace' }}>{fmtGbp(r.monthlyNet)}</Td>
                      <Td align="right" style={{ color: '#64748b' }}>{r.monthlyCount}</Td>
                      <Td align="right">
                        {r.qboCustomerId && (
                          <a
                            href={`https://app.qbo.intuit.com/app/customerdetail?nameId=${r.qboCustomerId}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: '#0e7fe0', textDecoration: 'none' }}
                            title="Open this customer in QuickBooks Online"
                          >
                            Open in QBO <ExternalLink size={11} />
                          </a>
                        )}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Tile({ tone, label, value, hint, icon, onClick, active, alarm }) {
  const t = tones[tone] || tones.neutral;
  return (
    <button
      onClick={onClick}
      style={{
        textAlign: 'left',
        padding: '14px 16px',
        background: active ? t.bg : '#fff',
        border: `1px solid ${active ? t.border : '#e5e7eb'}`,
        borderRadius: 10,
        cursor: 'pointer',
        fontFamily: font,
        boxShadow: alarm && value > 0 ? '0 0 0 3px rgba(185,28,28,0.08)' : 'none',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
        {icon && <span style={{ color: t.fg }}>{icon}</span>}
        <span style={{ fontSize: 11, fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</span>
      </div>
      <div style={{ fontSize: 28, fontWeight: 700, color: t.fg, fontFamily: 'monospace', lineHeight: 1 }}>{value}</div>
      {hint && <div style={{ fontSize: 11, color: '#64748b', marginTop: 6 }}>{hint}</div>}
    </button>
  );
}

function SourceChip({ tone, label, title }) {
  const t = tones[tone];
  return (
    <span title={title} style={{
      display: 'inline-block',
      fontSize: 10, fontWeight: 600, padding: '2px 8px', borderRadius: 4,
      background: t.bg, color: t.fg, textTransform: 'uppercase', letterSpacing: '0.04em',
    }}>{label}</span>
  );
}

function Pill({ label, count, active, tone, onClick }) {
  const t = tones[tone] || tones.neutral;
  const isMaster = !tone;
  return (
    <button onClick={onClick} style={{
      fontSize: 12, fontWeight: active ? 600 : 500,
      padding: '5px 12px', borderRadius: 999,
      background: active ? (isMaster ? '#0f172a' : t.bg) : '#fff',
      color: active && isMaster ? '#fff' : t.fg,
      border: `1px solid ${isMaster && !active ? '#e5e7eb' : t.border}`,
      cursor: 'pointer', fontFamily: font,
    }}>
      {label}{count != null ? ` · ${count}` : ''}
    </button>
  );
}

const Th = ({ children, align }) => <th style={{ textAlign: align || 'left', padding: '8px 12px', fontSize: 11, fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{children}</th>;
const Td = ({ children, align, style }) => <td style={{ padding: '8px 12px', verticalAlign: 'middle', textAlign: align || 'left', ...style }}>{children}</td>;
