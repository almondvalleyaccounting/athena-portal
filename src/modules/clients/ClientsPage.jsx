import React, { useState, useEffect, useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Plus, X } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../shell/AppShell';
import NewClientModal from '../../components/NewClientModal';
import AlphabetFilter, { firstCharBucket } from '../../components/AlphabetFilter';
import SearchInput from '../../components/SearchInput';
import DataTable from '../../components/DataTable';
import { Btn } from '../../components/ui';
import { fmtGbp } from '../../lib/money';
import { feeTotals } from './feeRollup';

const font = "'Outfit', sans-serif";

const TYPE_LABELS = {
  limited_company: 'Ltd', llp: 'LLP', partnership: 'Partnership', sole_trader: 'Sole trader', personal: 'Personal',
};

// The four views of the list. Former (nlac) and archived clients sit in
// their own view rather than behind a "show" link; third_party etc. are Other.
const VIEWS = [
  { id: 'clients', label: 'Clients', match: (s) => s === 'active' },
  { id: 'prospects', label: 'Prospects', match: (s) => s === 'prospect' },
  { id: 'other', label: 'Other', match: (s) => !['active', 'prospect', 'archived', 'nlac'].includes(s) },
  { id: 'former', label: 'Former', match: (s) => s === 'archived' || s === 'nlac' },
];

const STATUS_STYLES = {
  active: { bg: '#f0fdf4', color: '#15803d', label: 'Active' },
  prospect: { bg: '#eff6ff', color: '#1E4560', label: 'Prospect' },
  archived: { bg: '#f1f5f9', color: '#64748b', label: 'Archived' },
  nlac: { bg: '#fef2f2', color: '#b91c1c', label: 'Former client' },
  third_party: { bg: '#f5f3ff', color: '#6d28d9', label: 'Third party' },
};

const dateLabel = (iso) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

/* ─── Clients list page ────────────────────────────────────── */
// A standard table (UI audit, Sprint 4): search, view, filters, the A–Z row,
// sortable columns and paging. Every choice lives in the URL, so Back returns
// to the same view and a link to it can be shared.
export default function ClientsPage() {
  const navigate = useNavigate();
  const { profile } = useAuth();
  // Client fees are confidential — RLS returns no live_billing rows without
  // the flag, and we hide the column rather than show a misleading "—".
  const canSeeFees = profile?.can_view_client_fees === true;
  const [entities, setEntities] = useState([]);
  const [billingByEntity, setBillingByEntity] = useState({}); // entity_id → { monthly, annual }
  const [summary, setSummary] = useState({}); // entity_id → v_client_list_summary row
  const [loading, setLoading] = useState(true);
  const [showNewClient, setShowNewClient] = useState(false);

  const [params, setParams] = useSearchParams();
  const q = params.get('q') || '';
  const view = VIEWS.some((v) => v.id === params.get('view')) ? params.get('view') : 'clients';
  const manager = params.get('manager') || '';
  const type = params.get('type') || '';
  const overdueOnly = params.get('overdue') === '1';
  const letter = params.get('letter') || null;
  const sort = { key: params.get('sort') || 'name', dir: params.get('dir') === 'desc' ? 'desc' : 'asc' };
  const page = Math.max(1, parseInt(params.get('page') || '1', 10) || 1);

  // Any filter change returns to page 1; typing replaces history rather than
  // adding an entry per keystroke.
  const setParam = (patch, { keepPage = false, replace = false } = {}) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === undefined || v === '' || v === false) next.delete(k);
      else next.set(k, v === true ? '1' : String(v));
    }
    if (!keepPage) next.delete('page');
    setParams(next, { replace });
  };

  const loadEntities = async () => {
    try {
      const [entitiesResp, billingResp, summaryResp] = await Promise.all([
        supabase
          .from('entities')
          .select('id, name, type, entity_status, company_number, utr, manager, prospect_email, source, created_at')
          .order('name', { ascending: true }),
        supabase
          .from('live_billing')
          .select('entity_id, services, qbo_recurring_txn_id')
          .eq('status', 'active'),
        // Totals per client are computed in SQL (sql/297): the open-jobs table
        // is past PostgREST's silent 1,000-row cap, so the browser can't count.
        supabase.from('v_client_list_summary').select('entity_id, next_deadline, next_task, overdue_count, open_actions'),
      ]);
      if (entitiesResp.error) {
        console.error('[Clients] entities load error:', entitiesResp.error.message);
        setEntities([]);
      } else {
        setEntities(entitiesResp.data || []);
      }

      // Aggregate approved fees per entity — shared rules live in feeRollup.js.
      const rowsByEntity = {};
      for (const r of billingResp.data || []) {
        if (!r.entity_id) continue;
        (rowsByEntity[r.entity_id] = rowsByEntity[r.entity_id] || []).push(r);
      }
      const map = {};
      for (const [id, rows] of Object.entries(rowsByEntity)) map[id] = feeTotals(rows);
      setBillingByEntity(map);

      const sm = {};
      for (const r of summaryResp.data || []) sm[r.entity_id] = r;
      setSummary(sm);
    } catch (e) {
      console.error('[Clients] load threw:', e);
      setEntities([]);
    }
    setLoading(false);
  };

  useEffect(() => { loadEntities(); }, []);

  const statusOf = (e) => e.entity_status || 'active';

  // Rows joined with their summary and fees, once.
  const allRows = useMemo(() => entities.map((e) => {
    const s = summary[e.id] || {};
    const f = billingByEntity[e.id] || {};
    return {
      ...e,
      next_deadline: s.next_deadline || null,
      next_task: s.next_task || null,
      overdue_count: s.overdue_count || 0,
      open_actions: s.open_actions || 0,
      monthly: f.monthly || 0,
      annual: f.annual || 0,
    };
  }), [entities, summary, billingByEntity]);

  const viewCounts = useMemo(() => {
    const c = {};
    for (const v of VIEWS) c[v.id] = allRows.filter((r) => v.match(statusOf(r))).length;
    return c;
  }, [allRows]);

  const managers = useMemo(() => [...new Set(entities.map((e) => e.manager).filter(Boolean))].sort(), [entities]);
  const types = useMemo(() => [...new Set(entities.map((e) => e.type).filter(Boolean))].sort(), [entities]);

  // Everything except the letter, so the A–Z row greys out letters with no
  // match under the current search and filters.
  const beforeLetter = useMemo(() => {
    const v = VIEWS.find((x) => x.id === view);
    const needle = q.trim().toLowerCase();
    return allRows.filter((r) => {
      if (!v.match(statusOf(r))) return false;
      if (manager && r.manager !== manager) return false;
      if (type && r.type !== type) return false;
      if (overdueOnly && !r.overdue_count) return false;
      if (!needle) return true;
      return (
        r.name?.toLowerCase().includes(needle) ||
        r.company_number?.toLowerCase().includes(needle) ||
        r.utr?.toLowerCase().includes(needle) ||
        r.manager?.toLowerCase().includes(needle)
      );
    });
  }, [allRows, view, q, manager, type, overdueOnly]);

  const rows = letter ? beforeLetter.filter((r) => firstCharBucket(r.name) === letter) : beforeLetter;

  const handleNewClient = async (fields) => {
    const { data, error } = await supabase
      .from('entities')
      .insert({
        name: fields.name,
        type: fields.type || 'limited_company',
        entity_status: fields.entity_status || fields.status || 'prospect',
        prospect_email: fields.prospect_email || null,
        prospect_phone: fields.prospect_phone || null,
        source: 'athena',
      })
      .select()
      .single();
    if (error) {
      console.error('[Clients] insert error:', error.message);
      throw error;
    }
    await loadEntities();
    return data;
  };

  const muted = { color: '#94a3b8' };
  const columns = [
    {
      key: 'name', label: 'Client', width: '30%',
      sortValue: (r) => r.name,
      render: (r) => (
        <span title={r.name}>
          <span style={{ fontWeight: 600 }}>{r.name}</span>
          <span style={{ ...muted, fontSize: 13, marginLeft: 8 }}>{TYPE_LABELS[r.type] || r.type?.replace('_', ' ')}</span>
          {r.source === 'athena' && <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 600, padding: '1px 6px', borderRadius: 4, background: '#dbeafe', color: '#1E4560' }}>Added in Athena</span>}
        </span>
      ),
    },
    { key: 'company_number', label: 'Company no.', width: '11%', render: (r) => r.company_number || <span style={muted}>—</span> },
    { key: 'manager', label: 'Manager', width: '11%', render: (r) => r.manager || <span style={muted}>—</span> },
    {
      key: 'next_deadline', label: 'Next deadline', width: canSeeFees ? '28%' : '38%',
      // Overdue first, then soonest deadline.
      sortValue: (r) => (r.overdue_count ? `0-${String(999 - Math.min(r.overdue_count, 999)).padStart(3, '0')}` : r.next_deadline ? `1-${r.next_deadline}` : null),
      render: (r) => (
        <span title={r.next_task ? `${r.next_task} · due ${dateLabel(r.next_deadline)}` : undefined}>
          {r.overdue_count > 0 && (
            <span style={{ fontSize: 12, fontWeight: 600, padding: '2px 8px', borderRadius: 999, background: '#fef2f2', color: '#b91c1c', marginRight: 8 }}>
              {r.overdue_count} overdue
            </span>
          )}
          {r.next_deadline
            ? <><span style={{ fontWeight: 500 }}>{dateLabel(r.next_deadline)}</span><span style={{ color: '#64748b' }}> · {r.next_task}</span></>
            : !r.overdue_count && <span style={muted}>—</span>}
        </span>
      ),
    },
    { key: 'open_actions', label: 'Actions', width: '8%', align: 'right', render: (r) => (r.open_actions ? r.open_actions : <span style={muted}>0</span>) },
    ...(canSeeFees ? [{
      key: 'monthly', label: 'Fees /mo', width: '12%', align: 'right',
      sortValue: (r) => (r.monthly || r.annual ? r.monthly : null),
      render: (r) => (r.monthly || r.annual
        ? <span title="Approved fees, ex VAT" style={{ fontFamily: 'monospace' }}>
            {r.monthly > 0 ? fmtGbp(r.monthly) : ''}
            {r.annual > 0 && <span style={{ fontSize: 12, color: '#0f766e' }}>{r.monthly > 0 ? ' + ' : ''}{fmtGbp(r.annual)}/yr</span>}
          </span>
        : <span style={muted}>—</span>),
    }] : []),
    ...(view === 'other' || view === 'former' ? [{
      key: 'entity_status', label: 'Status', width: '10%',
      render: (r) => {
        const st = STATUS_STYLES[statusOf(r)] || { bg: '#f1f5f9', color: '#64748b', label: statusOf(r).replace('_', ' ') };
        return <span style={{ fontSize: 12, fontWeight: 600, padding: '2px 8px', borderRadius: 6, background: st.bg, color: st.color }}>{st.label}</span>;
      },
    }] : []),
  ];

  const chips = [
    manager && { key: 'manager', label: `Manager: ${manager}` },
    type && { key: 'type', label: `Type: ${TYPE_LABELS[type] || type}` },
    overdueOnly && { key: 'overdue', label: 'Overdue only' },
    letter && { key: 'letter', label: `Starts with ${letter}` },
    q && { key: 'q', label: `“${q}”` },
  ].filter(Boolean);

  const selectStyle = { padding: '8px 10px', fontSize: 14, border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff', fontFamily: font, color: '#0f172a', outline: 'none' };

  return (
    <div style={{ margin: '0 auto', padding: '32px 24px', fontFamily: font }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20, gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ fontFamily: "'Playfair Display', serif", fontSize: 26, fontWeight: 500, color: '#0f172a', marginBottom: 4 }}>
            Clients
          </h1>
          <p style={{ fontSize: 14, color: '#64748b', margin: 0 }}>
            {viewCounts.clients || 0} clients · {viewCounts.prospects || 0} prospects
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Btn variant="secondary" onClick={() => navigate('/clients/qbo-mapping')}>QuickBooks mapping</Btn>
          <Btn onClick={() => setShowNewClient(true)}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Plus size={15} /> New client</span>
          </Btn>
        </div>
      </div>

      {/* Toolbar: search, view, filters */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 6 }}>
        <SearchInput
          value={q}
          onChange={(v) => setParam({ q: v }, { replace: true })}
          placeholder="Name, company no., UTR or manager"
          style={{ flex: '1 1 280px', maxWidth: 360 }}
          inputStyle={{ padding: '8px 28px 8px 12px', fontSize: 14, borderRadius: 8 }}
        />
        <div role="tablist" style={{ display: 'inline-flex', border: '1px solid #e5e7eb', borderRadius: 8, overflow: 'hidden', background: '#fff' }}>
          {VIEWS.map((v, i) => {
            const on = v.id === view;
            return (
              <button
                key={v.id}
                role="tab"
                aria-selected={on}
                onClick={() => setParam({ view: v.id === 'clients' ? null : v.id })}
                style={{
                  padding: '8px 14px', fontSize: 14, fontFamily: font, cursor: 'pointer', border: 'none',
                  borderLeft: i ? '1px solid #e5e7eb' : 'none',
                  background: on ? '#1E4560' : '#fff', color: on ? '#fff' : '#334155', fontWeight: on ? 600 : 500,
                }}
              >
                {v.label} <span style={{ opacity: on ? 0.8 : 0.6, fontWeight: 500 }}>{viewCounts[v.id] || 0}</span>
              </button>
            );
          })}
        </div>
        <select aria-label="Manager" value={manager} onChange={(e) => setParam({ manager: e.target.value })} style={selectStyle}>
          <option value="">All managers</option>
          {managers.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        <select aria-label="Type" value={type} onChange={(e) => setParam({ type: e.target.value })} style={selectStyle}>
          <option value="">All types</option>
          {types.map((t) => <option key={t} value={t}>{TYPE_LABELS[t] || t}</option>)}
        </select>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 14, color: '#334155', cursor: 'pointer' }}>
          <input type="checkbox" checked={overdueOnly} onChange={(e) => setParam({ overdue: e.target.checked })} />
          Overdue only
        </label>
      </div>

      <AlphabetFilter items={beforeLetter} selected={letter} onChange={(l) => setParam({ letter: l })} />

      {chips.length > 0 && (
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', margin: '4px 0 10px' }}>
          {chips.map((c) => (
            <button
              key={c.key}
              onClick={() => setParam({ [c.key]: null })}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 13, padding: '3px 10px', borderRadius: 999, border: '1px solid #bfdbfe', background: '#eff6ff', color: '#1E4560', cursor: 'pointer', fontFamily: font }}
            >
              {c.label} <X size={13} />
            </button>
          ))}
          <button
            onClick={() => setParam({ manager: null, type: null, overdue: null, letter: null, q: null })}
            style={{ fontSize: 13, color: '#64748b', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline', fontFamily: font }}
          >
            Clear all
          </button>
        </div>
      )}

      {loading ? (
        <p style={{ textAlign: 'center', color: '#94a3b8', fontSize: 14, padding: 40 }}>Loading clients…</p>
      ) : (
        <DataTable
          columns={columns}
          rows={rows}
          sort={sort}
          onSort={(s) => setParam({ sort: s.key === 'name' ? null : s.key, dir: s.dir === 'asc' ? null : 'desc' }, { keepPage: false })}
          page={page}
          onPage={(p) => setParam({ page: p > 1 ? p : null }, { keepPage: true })}
          rowHref={(r) => `/clients/${r.id}`}
          onOpen={(href) => navigate(href)}
          empty={entities.length === 0 ? 'No clients yet. Add one, or import from BrightManager.' : 'No clients match. Try a different search or clear a filter.'}
        />
      )}

      <NewClientModal
        open={showNewClient}
        onClose={() => setShowNewClient(false)}
        onSave={handleNewClient}
      />
    </div>
  );
}
