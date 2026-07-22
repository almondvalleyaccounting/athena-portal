import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { Loader, Plus, X, TrendingUp, Info, ChevronDown, ArrowUpRight, ArrowDownRight } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../shell/AppShell';
import { money, shortDate, OUTFIT, cardStyle, inputStyle } from './dashboardData';

/*
  Underlying Performance tab — custom analysis that normalises reported profit
  to what the business earns for the owner. Follows the PERIOD filter.

  Reported net profit
    + Owner costs removed   (a per-client group of tagged QBO nominal codes —
                             owner/family salaries, owner costs, dividends —
                             summed from the P&L over the period and added back)
    + One-off costs removed (dated {date, amount, nominal} entries in-period)
    − One-off income removed (same, subtracted)
    = Underlying profit for the owner

  Config lives in dashboard_adjustment_accounts (group_key 'owner_costs') and
  dashboard_oneoff_items, keyed on realm_id (RLS: any active staff; AVA's own
  books gated to can_view_practice_financials). Account amounts come from the
  windowed `pl_detail` metric (leaf rows carry the QBO account id).

  Built as a config-driven view (group_key / kinds) so more custom groups and
  KPIs can be layered on later without a rebuild.
*/

const GROUP = 'owner_costs';

const acctLabel = (acct_num, name) => `${acct_num ? `${acct_num} · ` : ''}${name || ''}`.trim();
const isIncomeGroup = (g) => /income/i.test(g || '');

export default function UnderlyingPerformanceTab({ realmId, data, meta, currency, loading, empty }) {
  const { profile } = useAuth();
  const plDetail = data?.pl_detail || null;
  const plRange = data?.pl_range || null;
  const plDetailPrior = data?.pl_detail_prior || null;
  const plRangePrior = data?.pl_range_prior || null;

  const [accounts, setAccounts] = useState([]);
  const [accountsLoading, setAccountsLoading] = useState(false);
  const [ownerRows, setOwnerRows] = useState([]);   // dashboard_adjustment_accounts
  const [oneoffs, setOneoffs] = useState([]);        // dashboard_oneoff_items
  const [cfgLoading, setCfgLoading] = useState(false);
  const [busy, setBusy] = useState(false);

  /* Config + chart-of-accounts loads ------------------------------- */
  const loadConfig = useCallback(async () => {
    if (!realmId) return;
    setCfgLoading(true);
    try {
      const [{ data: oa }, { data: oo }] = await Promise.all([
        supabase.from('dashboard_adjustment_accounts').select('*')
          .eq('realm_id', realmId).eq('group_key', GROUP),
        supabase.from('dashboard_oneoff_items').select('*')
          .eq('realm_id', realmId).order('entry_date', { ascending: false }),
      ]);
      setOwnerRows(oa || []);
      setOneoffs(oo || []);
    } catch { /* silent */ }
    setCfgLoading(false);
  }, [realmId]);

  const loadAccounts = useCallback(async () => {
    if (!realmId) return;
    setAccountsLoading(true);
    try {
      const { data: payload } = await supabase.functions.invoke('dashboard-qbo-pull', {
        body: { realmId, metrics: ['accounts'] },
      });
      setAccounts(payload?.metrics?.accounts?.accounts || []);
    } catch { /* silent */ }
    setAccountsLoading(false);
  }, [realmId]);

  useEffect(() => { setAccounts([]); setOwnerRows([]); setOneoffs([]); }, [realmId]);
  useEffect(() => { loadConfig(); }, [loadConfig]);
  useEffect(() => { loadAccounts(); }, [loadAccounts]);

  const accountsById = useMemo(() => {
    const m = {};
    for (const a of accounts) m[a.id] = a;
    return m;
  }, [accounts]);

  /* Adjustment maths ---------------------------------------------- */
  const calc = useMemo(() => {
    const byId = (rows) => {
      const m = {};
      for (const r of rows || []) if (r.id) m[r.id] = r;
      return m;
    };
    const rowsById = byId(plDetail?.rows);
    const priorById = byId(plDetailPrior?.rows);

    const owner = ownerRows.map((o) => {
      const row = rowsById[o.account_id];
      const acct = accountsById[o.account_id];
      const amount = row?.amount ?? 0;
      const income = acct ? acct.classification === 'Revenue' : isIncomeGroup(row?.group);
      return {
        id: o.id, account_id: o.account_id,
        label: acctLabel(o.acct_num || acct?.acct_num, o.account_name || acct?.name),
        amount, income,
      };
    });
    // Owner add-back = costs added back, less any tagged income removed. Same
    // rule applied to a supplied per-account map (current or prior period).
    const addBackFrom = (map) => ownerRows.reduce((s, o) => {
      const amt = map[o.account_id]?.amount ?? 0;
      const acct = accountsById[o.account_id];
      const income = acct ? acct.classification === 'Revenue' : isIncomeGroup(map[o.account_id]?.group);
      return s + (income ? -amt : amt);
    }, 0);
    const ownerAddBack = addBackFrom(rowsById);
    const priorOwnerAddBack = addBackFrom(priorById);
    const ownerIncomeTaggedFrom = (map) => ownerRows.reduce((s, o) => {
      const acct = accountsById[o.account_id];
      const income = acct ? acct.classification === 'Revenue' : isIncomeGroup(map[o.account_id]?.group);
      return s + (income ? (map[o.account_id]?.amount ?? 0) : 0);
    }, 0);

    // One-offs falling inside a [start,end] window.
    const inRange = (d, s, e) => (!s || d >= s) && (!e || d <= e);
    const oo = oneoffs.map((e) => ({ ...e, in_period: inRange(e.entry_date, meta?.plStart, meta?.plEnd) }));
    const sumOO = (s, e, kind) => oneoffs
      .filter((x) => x.kind === kind && inRange(x.entry_date, s, e))
      .reduce((a, x) => a + Number(x.amount || 0), 0);
    const oneoffCost = sumOO(meta?.plStart, meta?.plEnd, 'cost');
    const oneoffIncome = sumOO(meta?.plStart, meta?.plEnd, 'income');
    const priorOneoffCost = sumOO(meta?.priorStart, meta?.priorEnd, 'cost');
    const priorOneoffIncome = sumOO(meta?.priorStart, meta?.priorEnd, 'income');

    // Current + prior underlying, from reported net + adjustments.
    const build = (reportedNet, reportedRevenue, addBack, incomeTagged, ooCost, ooInc) => {
      if (reportedNet == null) return { reportedNet: null, reportedMargin: null, underlyingNet: null, underlyingMargin: null };
      const underlyingNet = reportedNet + addBack + ooCost - ooInc;
      const reportedMargin = reportedRevenue ? (reportedNet / reportedRevenue) * 100 : null;
      const underlyingRevenue = reportedRevenue == null ? null : reportedRevenue - incomeTagged - ooInc;
      const underlyingMargin = underlyingRevenue ? (underlyingNet / underlyingRevenue) * 100 : null;
      return { reportedNet, reportedMargin, underlyingNet, underlyingMargin };
    };

    const reportedNet = plDetail?.net_income ?? plRange?.net_income ?? null;
    const reportedRevenue = plRange?.income
      ?? (plDetail?.rows || []).filter((r) => isIncomeGroup(r.group)).reduce((s, r) => s + (r.amount || 0), 0);
    const cur = build(reportedNet, reportedRevenue, ownerAddBack, ownerIncomeTaggedFrom(rowsById), oneoffCost, oneoffIncome);

    // Prior only when we actually have the prior-period P&L (else no delta).
    const havePrior = !!(plDetailPrior || plRangePrior);
    const priorReportedNet = havePrior ? (plDetailPrior?.net_income ?? plRangePrior?.net_income ?? null) : null;
    const priorReportedRevenue = plRangePrior?.income ?? null;
    const prior = build(priorReportedNet, priorReportedRevenue, priorOwnerAddBack, ownerIncomeTaggedFrom(priorById), priorOneoffCost, priorOneoffIncome);

    return {
      owner, ownerAddBack, oo, oneoffCost, oneoffIncome,
      ...cur, prior,
    };
  }, [plDetail, plRange, plDetailPrior, plRangePrior, ownerRows, oneoffs, accountsById, meta]);

  /* Mutations ------------------------------------------------------ */
  const addOwnerAccount = async (accountId) => {
    const a = accountsById[accountId];
    if (!a || !realmId) return;
    setBusy(true);
    try {
      await supabase.from('dashboard_adjustment_accounts').insert({
        realm_id: realmId, group_key: GROUP, account_id: a.id,
        acct_num: a.acct_num, account_name: a.name, created_by: profile?.id || null,
      });
      await loadConfig();
    } catch { /* silent */ }
    setBusy(false);
  };
  const removeOwnerAccount = async (id) => {
    setBusy(true);
    try { await supabase.from('dashboard_adjustment_accounts').delete().eq('id', id); await loadConfig(); }
    catch { /* silent */ }
    setBusy(false);
  };
  const addOneoff = async (entry) => {
    if (!realmId) return;
    setBusy(true);
    try {
      const a = entry.account_id ? accountsById[entry.account_id] : null;
      await supabase.from('dashboard_oneoff_items').insert({
        realm_id: realmId, kind: entry.kind, entry_date: entry.entry_date,
        amount: Number(entry.amount), account_id: entry.account_id || null,
        acct_num: a?.acct_num || null, account_name: a?.name || null,
        note: entry.note || null, created_by: profile?.id || null,
      });
      await loadConfig();
    } catch { /* silent */ }
    setBusy(false);
  };
  const removeOneoff = async (id) => {
    setBusy(true);
    try { await supabase.from('dashboard_oneoff_items').delete().eq('id', id); await loadConfig(); }
    catch { /* silent */ }
    setBusy(false);
  };

  if (!plDetail && !plRange) {
    return loading
      ? <div style={{ ...cardStyle, textAlign: 'center', padding: '48px' }}>
          <Loader size={22} style={{ color: '#7dd3fc', animation: 'spin 1s linear infinite' }} />
        </div>
      : <div style={{ ...cardStyle, textAlign: 'center', padding: '48px 24px', fontFamily: OUTFIT, fontSize: '13px', color: '#64748b' }}>
          {empty?.needsReconnect ? `${empty.selectedName || 'This client'} needs to reconnect QuickBooks.` : 'Pull from QuickBooks to build the underlying view.'}
        </div>;
  }

  const ownerIdSet = new Set(ownerRows.map((o) => o.account_id));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      {/* Headline tiles */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: '12px' }}>
        <Tile label={`Reported net profit — ${meta?.label || 'period'}`} value={calc.reportedNet} currency={currency}
          delta={<MoneyDelta now={calc.reportedNet} prev={calc.prior?.reportedNet} currency={currency} label={meta?.deltaLabel} />} />
        <Tile label="Reported margin" text={calc.reportedMargin == null ? '—' : `${calc.reportedMargin.toFixed(1)}%`}
          delta={<PpDelta now={calc.reportedMargin} prev={calc.prior?.reportedMargin} label={meta?.deltaLabel} />} />
        <Tile label="Underlying profit for the owner" value={calc.underlyingNet} currency={currency} accent
          delta={<MoneyDelta now={calc.underlyingNet} prev={calc.prior?.underlyingNet} currency={currency} label={meta?.deltaLabel} />} />
        <Tile label="Underlying margin" text={calc.underlyingMargin == null ? '—' : `${calc.underlyingMargin.toFixed(1)}%`} accent
          delta={<PpDelta now={calc.underlyingMargin} prev={calc.prior?.underlyingMargin} label={meta?.deltaLabel} />} />
      </div>

      {/* Waterfall */}
      <div style={cardStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px' }}>
          <TrendingUp size={18} style={{ color: '#38bdf8' }} />
          <span style={{ fontFamily: OUTFIT, fontSize: '15px', fontWeight: 700, color: '#0f172a' }}>
            From reported to underlying profit
          </span>
          <span style={{ fontFamily: OUTFIT, fontSize: '12px', color: '#94a3b8', marginLeft: 'auto' }}>
            {meta?.plStart && `${shortDate(meta.plStart)} → ${shortDate(meta.plEnd)}`}
          </span>
        </div>
        <WaterfallRow label="Reported net profit" value={calc.reportedNet} currency={currency} kind="base" />
        <WaterfallRow label="Add back: Owner costs removed" value={calc.ownerAddBack} currency={currency} kind="add" />
        <WaterfallRow label="Add back: One-off costs removed" value={calc.oneoffCost} currency={currency} kind="add" />
        <WaterfallRow label="Less: One-off income removed" value={-calc.oneoffIncome} currency={currency} kind="sub" />
        <WaterfallRow label="Underlying profit for the owner" value={calc.underlyingNet} currency={currency} kind="total" />
      </div>

      {/* Owner costs config */}
      <div style={cardStyle}>
        <SectionHead
          title="Owner costs"
          hint="Tagged QBO nominal codes (owner/family salaries, owner costs, dividends). Their P&L amount over the period is added back."
          busy={cfgLoading || busy}
        />
        {calc.owner.length === 0 && (
          <p style={{ fontFamily: OUTFIT, fontSize: '13px', color: '#94a3b8', margin: '6px 0 12px' }}>
            No nominal codes tagged yet. Add owner-related codes below to strip them from the result.
          </p>
        )}
        {calc.owner.length > 0 && (
          <div style={{ marginBottom: '12px' }}>
            {calc.owner.map((o) => (
              <div key={o.id} style={rowStyle}>
                <span style={{ fontFamily: OUTFIT, fontSize: '13px', color: '#0f172a' }}>
                  {o.label}{o.income && <span style={{ color: '#b45309', fontSize: '11px' }}> · income</span>}
                </span>
                <span style={{ marginLeft: 'auto', fontFamily: OUTFIT, fontSize: '13px', fontWeight: 600, color: '#334155', fontVariantNumeric: 'tabular-nums' }}>
                  {money(o.amount, currency)}
                </span>
                <button onClick={() => removeOwnerAccount(o.id)} title="Remove" style={iconBtn}>
                  <X size={14} style={{ color: '#94a3b8' }} />
                </button>
              </div>
            ))}
          </div>
        )}
        <AddAccount accounts={accounts} loading={accountsLoading} exclude={ownerIdSet} onAdd={addOwnerAccount} />
      </div>

      {/* One-off adjustments config */}
      <div style={cardStyle}>
        <SectionHead
          title="One-off adjustments"
          hint="Dated one-off costs (added back) and income (stripped out). Only entries dated inside the selected period affect the result."
          busy={cfgLoading || busy}
        />
        <OneoffList items={calc.oo} currency={currency} onRemove={removeOneoff} />
        <AddOneoff accounts={accounts} onAdd={addOneoff} />
      </div>
    </div>
  );
}

/* ─── Bits ─────────────────────────────────────────────────────── */
const rowStyle = {
  display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 0',
  borderBottom: '1px solid #f1f5f9',
};
const iconBtn = {
  background: 'none', border: 'none', cursor: 'pointer', padding: '4px',
  display: 'inline-flex', alignItems: 'center',
};

function Tile({ label, value, text, currency, accent, delta }) {
  return (
    <div style={{
      backgroundColor: accent ? '#f0f9ff' : '#ffffff',
      border: `1px solid ${accent ? '#7dd3fc' : '#e5e7eb'}`, borderRadius: '12px', padding: '14px 16px',
    }}>
      <div style={{ fontFamily: OUTFIT, fontSize: '12px', color: '#94a3b8', marginBottom: '4px' }}>{label}</div>
      <div style={{ fontFamily: OUTFIT, fontSize: '22px', fontWeight: 700, color: (value ?? 0) < 0 ? '#991b1b' : accent ? '#0369a1' : '#0f172a' }}>
        {text != null ? text : money(value, currency)}
      </div>
      <div style={{ minHeight: '16px', marginTop: '2px' }}>{delta}</div>
    </div>
  );
}

// Money delta (↑/↓ £X vs prior period) — mirrors the Overview tiles.
function MoneyDelta({ now, prev, currency, label = 'vs prior period' }) {
  if (now == null || prev == null) return null;
  const diff = now - prev;
  if (Math.abs(diff) < 0.005) return <span style={{ fontFamily: OUTFIT, fontSize: '11.5px', color: '#94a3b8' }}>unchanged {label}</span>;
  const up = diff > 0;
  const Icon = up ? ArrowUpRight : ArrowDownRight;
  return (
    <span style={{ fontFamily: OUTFIT, fontSize: '11.5px', fontWeight: 600, color: up ? '#166534' : '#991b1b', display: 'inline-flex', alignItems: 'center', gap: '2px' }}>
      <Icon size={12} /> {money(Math.abs(diff), currency)} {label}
    </span>
  );
}

// Margin delta in percentage points.
function PpDelta({ now, prev, label = 'vs prior period' }) {
  if (now == null || prev == null) return null;
  const diff = now - prev;
  if (Math.abs(diff) < 0.05) return <span style={{ fontFamily: OUTFIT, fontSize: '11.5px', color: '#94a3b8' }}>unchanged {label}</span>;
  const up = diff > 0;
  const Icon = up ? ArrowUpRight : ArrowDownRight;
  return (
    <span style={{ fontFamily: OUTFIT, fontSize: '11.5px', fontWeight: 600, color: up ? '#166534' : '#991b1b', display: 'inline-flex', alignItems: 'center', gap: '2px' }}>
      <Icon size={12} /> {Math.abs(diff).toFixed(1)} pp {label}
    </span>
  );
}

function WaterfallRow({ label, value, currency, kind }) {
  const total = kind === 'total';
  const base = kind === 'base';
  const sign = kind === 'add' ? '+' : kind === 'sub' ? '−' : '';
  const color = kind === 'add' ? '#166534' : kind === 'sub' ? '#991b1b' : (value ?? 0) < 0 ? '#991b1b' : '#0f172a';
  return (
    <div style={{
      display: 'flex', alignItems: 'center', padding: total ? '12px 0 2px' : '9px 0',
      borderTop: total ? '2px solid #e5e7eb' : 'none',
      borderBottom: base || total ? 'none' : '1px solid #f8fafc',
    }}>
      <span style={{ fontFamily: OUTFIT, fontSize: total ? '15px' : '13px', fontWeight: total || base ? 700 : 500, color: total ? '#0f172a' : '#475569' }}>
        {label}
      </span>
      <span style={{
        marginLeft: 'auto', fontFamily: OUTFIT, fontSize: total ? '17px' : '13.5px',
        fontWeight: total || base ? 700 : 600, color, fontVariantNumeric: 'tabular-nums',
      }}>
        {sign && Math.abs(value) > 0.005 ? `${sign} ` : ''}{money(Math.abs(kind === 'sub' ? value : value), currency)}
      </span>
    </div>
  );
}

function SectionHead({ title, hint, busy }) {
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <span style={{ fontFamily: OUTFIT, fontSize: '15px', fontWeight: 700, color: '#0f172a' }}>{title}</span>
        {busy && <Loader size={13} style={{ color: '#7dd3fc', animation: 'spin 1s linear infinite' }} />}
      </div>
      <p style={{ fontFamily: OUTFIT, fontSize: '12px', color: '#94a3b8', margin: '4px 0 10px', display: 'flex', gap: '5px', alignItems: 'flex-start' }}>
        <Info size={13} style={{ flexShrink: 0, marginTop: '1px' }} /> {hint}
      </p>
    </div>
  );
}

function AddAccount({ accounts, loading, exclude, onAdd }) {
  const [sel, setSel] = useState('');
  return (
    <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
      <div style={{ flex: '1 1 300px', minWidth: '240px' }}>
        <NominalPicker
          accounts={accounts} value={sel} onChange={setSel} exclude={exclude}
          placeholder={loading ? 'Loading nominal codes…' : 'Search a nominal code to add…'}
        />
      </div>
      <button
        onClick={() => { if (sel) { onAdd(sel); setSel(''); } }}
        disabled={!sel}
        style={{ ...addBtn, opacity: sel ? 1 : 0.5, cursor: sel ? 'pointer' : 'not-allowed' }}
      >
        <Plus size={14} /> Add to Owner costs
      </button>
    </div>
  );
}

/* Searchable, category-grouped nominal-code picker. Options are grouped by P&L
   category (Income → Other income → Cost of sales → Expense → Other expense),
   then ordered by parent nominal code (sub-accounts cluster under their parent),
   then alphabetically. */
const CAT_ORDER = { 'Income': 1, 'Other Income': 2, 'Cost of Goods Sold': 3, 'Expense': 4, 'Other Expense': 5 };
const CAT_LABEL = { 'Income': 'Income', 'Other Income': 'Other income', 'Cost of Goods Sold': 'Cost of sales', 'Expense': 'Expense', 'Other Expense': 'Other expense' };
const catOf = (a) => (CAT_ORDER[a.type] ? a.type : (a.classification === 'Revenue' ? 'Income' : 'Expense'));

function NominalPicker({ accounts, value, onChange, placeholder = 'Search nominal codes…', exclude }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const selected = accounts.find((a) => a.id === value) || null;
  const ql = q.trim().toLowerCase();

  const groups = (() => {
    const list = accounts.filter((a) =>
      !(exclude && exclude.has(a.id)) &&
      (!ql || `${a.acct_num || ''} ${a.name} ${a.parent_name || ''}`.toLowerCase().includes(ql)));
    const byCat = {};
    for (const a of list) (byCat[catOf(a)] ||= []).push(a);
    const cmp = (x, y) => {
      const bx = String(x.parent_num || x.acct_num || '~');
      const by = String(y.parent_num || y.acct_num || '~');
      if (bx !== by) return bx.localeCompare(by, undefined, { numeric: true });
      const sx = x.is_sub ? 1 : 0, sy = y.is_sub ? 1 : 0;
      if (sx !== sy) return sx - sy;
      return x.name.localeCompare(y.name);
    };
    return Object.keys(byCat)
      .sort((a, b) => (CAT_ORDER[a] || 9) - (CAT_ORDER[b] || 9))
      .map((c) => ({ cat: c, label: CAT_LABEL[c] || c, items: byCat[c].sort(cmp) }));
  })();

  const trigger = {
    ...inputStyle, width: '100%', fontSize: '13px', padding: '8px 10px', cursor: 'pointer',
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px',
    color: selected ? '#0f172a' : '#94a3b8', backgroundColor: '#ffffff',
  };

  return (
    <div style={{ position: 'relative' }}>
      <div style={trigger} onClick={() => setOpen((o) => !o)}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {selected ? acctLabel(selected.acct_num, selected.name) : placeholder}
        </span>
        <ChevronDown size={14} style={{ color: '#94a3b8', flexShrink: 0 }} />
      </div>
      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 40 }} />
          <div style={{
            position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, zIndex: 50,
            backgroundColor: '#ffffff', border: '1px solid #e5e7eb', borderRadius: '10px',
            boxShadow: '0 10px 30px rgba(15,23,42,0.12)', overflow: 'hidden',
          }}>
            <div style={{ padding: '8px' }}>
              <input
                autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Type to search…"
                style={{ ...inputStyle, width: '100%', fontSize: '13px', padding: '7px 10px' }}
              />
            </div>
            <div style={{ maxHeight: '280px', overflowY: 'auto', paddingBottom: '6px' }}>
              {groups.length === 0 && (
                <div style={{ fontFamily: OUTFIT, fontSize: '12.5px', color: '#94a3b8', padding: '8px 14px' }}>No matches.</div>
              )}
              {groups.map((g) => (
                <div key={g.cat}>
                  <div style={{
                    fontFamily: OUTFIT, fontSize: '10.5px', fontWeight: 700, letterSpacing: '0.04em',
                    textTransform: 'uppercase', color: '#94a3b8', padding: '8px 14px 4px',
                    position: 'sticky', top: 0, backgroundColor: '#f8fafc',
                  }}>{g.label}</div>
                  {g.items.map((a) => (
                    <button key={a.id}
                      onClick={() => { onChange(a.id); setOpen(false); setQ(''); }}
                      style={{
                        display: 'block', width: '100%', textAlign: 'left', border: 'none',
                        background: a.id === value ? '#f0f9ff' : 'transparent', cursor: 'pointer',
                        fontFamily: OUTFIT, fontSize: '13px', color: '#334155',
                        padding: `7px 14px 7px ${a.is_sub ? '28px' : '14px'}`,
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = '#f1f5f9'; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = a.id === value ? '#f0f9ff' : 'transparent'; }}
                    >
                      {a.acct_num && <span style={{ color: '#94a3b8', marginRight: '6px' }}>{a.acct_num}</span>}
                      {a.name}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function OneoffList({ items, currency, onRemove }) {
  if (!items.length) return (
    <p style={{ fontFamily: OUTFIT, fontSize: '13px', color: '#94a3b8', margin: '6px 0 12px' }}>
      No one-off adjustments yet.
    </p>
  );
  return (
    <div style={{ marginBottom: '12px' }}>
      {items.map((e) => (
        <div key={e.id} style={{ ...rowStyle, opacity: e.in_period ? 1 : 0.5 }}>
          <span style={{
            fontFamily: OUTFIT, fontSize: '11px', fontWeight: 700, padding: '2px 7px', borderRadius: '6px',
            backgroundColor: e.kind === 'cost' ? '#fef2f2' : '#f0fdf4',
            color: e.kind === 'cost' ? '#991b1b' : '#166534',
          }}>{e.kind === 'cost' ? 'Cost' : 'Income'}</span>
          <span style={{ fontFamily: OUTFIT, fontSize: '13px', color: '#0f172a' }}>{shortDate(e.entry_date)}</span>
          <span style={{ fontFamily: OUTFIT, fontSize: '12.5px', color: '#64748b' }}>
            {e.account_name ? acctLabel(e.acct_num, e.account_name) : ''}{e.note ? ` · ${e.note}` : ''}
            {!e.in_period && <span style={{ color: '#b45309' }}> · outside selected period</span>}
          </span>
          <span style={{ marginLeft: 'auto', fontFamily: OUTFIT, fontSize: '13px', fontWeight: 600, color: '#334155', fontVariantNumeric: 'tabular-nums' }}>
            {money(e.amount, currency)}
          </span>
          <button onClick={() => onRemove(e.id)} title="Remove" style={iconBtn}>
            <X size={14} style={{ color: '#94a3b8' }} />
          </button>
        </div>
      ))}
    </div>
  );
}

function AddOneoff({ accounts, onAdd }) {
  const [kind, setKind] = useState('cost');
  const [date, setDate] = useState('');
  const [amount, setAmount] = useState('');
  const [accountId, setAccountId] = useState('');
  const [note, setNote] = useState('');
  const canAdd = date && amount && !isNaN(Number(amount)) && accountId;
  const inp = { ...inputStyle, fontSize: '13px', padding: '8px 10px' };
  return (
    <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
      <select value={kind} onChange={(e) => setKind(e.target.value)} style={{ ...inp, appearance: 'auto', flex: '0 0 110px' }}>
        <option value="cost">Cost</option>
        <option value="income">Income</option>
      </select>
      <input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={{ ...inp, flex: '0 0 150px' }} />
      <input type="number" step="0.01" placeholder="Amount" value={amount} onChange={(e) => setAmount(e.target.value)} style={{ ...inp, flex: '0 0 120px' }} />
      <div style={{ flex: '1 1 220px', minWidth: '200px' }}>
        <NominalPicker accounts={accounts} value={accountId} onChange={setAccountId} placeholder="Nominal code (required)…" />
      </div>
      <input type="text" placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} style={{ ...inp, flex: '1 1 160px' }} />
      <button
        onClick={() => { if (canAdd) { onAdd({ kind, entry_date: date, amount, account_id: accountId, note }); setDate(''); setAmount(''); setAccountId(''); setNote(''); } }}
        disabled={!canAdd}
        style={{ ...addBtn, opacity: canAdd ? 1 : 0.5, cursor: canAdd ? 'pointer' : 'not-allowed' }}
      >
        <Plus size={14} /> Add
      </button>
    </div>
  );
}

const addBtn = {
  display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '8px 14px',
  border: '1px solid #7dd3fc', borderRadius: '10px', backgroundColor: '#f0f9ff',
  fontFamily: OUTFIT, fontSize: '13px', fontWeight: 600, color: '#0369a1',
};
