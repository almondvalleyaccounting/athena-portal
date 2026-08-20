import React, { useState, useMemo } from 'react';
import { Loader, Plus, X, TrendingUp, Info, ChevronDown, ArrowUpRight, ArrowDownRight, Sparkles, Check } from 'lucide-react';
import { money, shortDate, OUTFIT, cardStyle, inputStyle } from './dashboardData';
import { aggregate } from './overviewGrain';
import { suggestOwnerCosts } from './ownerCostSuggestions';

/*
  Underlying Performance tab — custom analysis that normalises reported profit
  to what the business earns for the owner.

  Reports on the LATEST BUCKET from the view bar, against the one before it, so
  switching to fiscal quarters here means the same three months it means on the
  Overview. It reads the same pnl_chart_detail metric through the same
  aggregate() call the Overview uses: the headline here and the Overview's
  "underlying profit" tile are one number, not two that happen to agree.

  Reported net profit
    + Owner costs removed   (a per-client group of tagged QBO nominal codes —
                             owner/family salaries, owner costs, dividends —
                             summed from the P&L over the period and added back)
    + One-off costs removed (dated {date, amount, nominal} entries in-period)
    − One-off income removed (same, subtracted)
    = Underlying profit for the owner

  Config lives in dashboard_adjustment_accounts (group_key 'owner_costs') and
  dashboard_oneoff_items, keyed on realm_id (RLS: any active staff; AVA's own
  books gated to can_view_practice_financials). It arrives as the `config` prop
  from useUnderlyingConfig, held once by the page — the Overview tab's
  underlying view strips the same codes, and two copies would drift apart the
  moment a code was tagged here. Per-account amounts are summed out of
  pnl_chart_detail over the bucket (leaf rows carry the QBO account id).

  Owner-cost codes can also be SUGGESTED from the nominal hierarchy (dividends,
  director's pay, home office — see ownerCostSuggestions.js). Suggestions never
  move a number by themselves: they render as tick boxes and only count once
  confirmed. A rejected suggestion is stored back on the same table with
  status = 'dismissed' so it stops being offered.

  Built as a config-driven view (group_key / kinds) so more custom groups and
  KPIs can be layered on later without a rebuild.
*/


const acctLabel = (acct_num, name) => `${acct_num ? `${acct_num} · ` : ''}${name || ''}`.trim();
const isIncomeGroup = (g) => /income/i.test(g || '');

export default function UnderlyingPerformanceTab({
  detail, buckets, prior, currency, loading, empty, config, bar,
}) {
  // The owner-cost / one-off configuration is owned by the page (see
  // useUnderlyingConfig) because the Overview tab's underlying view strips the
  // same codes and must not read a second, drifting copy.
  const {
    accounts, accountsById, accountsLoading,
    ownerRows, dismissedRows, oneoffs, cfgLoading, busy, ownerAccountIds,
    addOwnerAccount, removeOwnerAccount,
    confirmSuggestions, dismissSuggestions, restoreDismissed,
    addOneoff, removeOneoff,
  } = config;
  /*
    Adjustment maths — over the LATEST BUCKET from the view bar, with the bucket
    before it as the comparator.

    This runs the very same aggregate() the Overview runs, on the same
    pnl_chart_detail metric. That is deliberate: the two tabs used to reach the
    same conclusion by separate routes (this one over a flat pl_detail range,
    the Overview bucket by bucket), which is a standing invitation for them to
    disagree. Now the Overview's "underlying profit" tile and this tab's
    headline are literally the same number out of the same call.
  */
  const calc = useMemo(() => {
    const empty = {
      owner: [], ownerAddBack: 0, oo: [], oneoffCost: 0, oneoffIncome: 0, rowsById: {},
      reportedNet: null, reportedMargin: null, underlyingNet: null, underlyingMargin: null,
      prior: {}, bucket: null,
    };
    if (!detail || !buckets?.length) return empty;

    const bucket = buckets[buckets.length - 1];
    const [priorAgg, curAgg] = aggregate(detail, [prior, bucket], {
      ownerAccountIds, accountsById, oneoffs,
    });

    // Per-account amounts over the bucket, for the config list and for the
    // suggestion tiles ("what would accepting this move?").
    const rowsById = {};
    const pos = {};
    (detail.month_keys || []).forEach((k, i) => { if (k) pos[k] = i; });
    for (const r of detail.rows || []) {
      if (!r.id) continue;
      let amount = 0;
      for (const m of bucket.months) {
        const i = pos[m];
        if (i !== undefined) amount += Number(r.amounts?.[i]) || 0;
      }
      rowsById[String(r.id)] = { ...r, amount };
    }

    const owner = ownerRows.map((o) => {
      const row = rowsById[String(o.account_id)];
      const acct = accountsById[o.account_id];
      return {
        id: o.id,
        account_id: o.account_id,
        label: acctLabel(o.acct_num || acct?.acct_num, o.account_name || acct?.name),
        amount: row?.amount ?? 0,
        income: acct ? acct.classification === 'Revenue' : isIncomeGroup(row?.group),
      };
    });

    const inRange = (d, s, e) => (!s || d >= s) && (!e || d <= e);
    const oo = oneoffs.map((e) => ({
      ...e, in_period: inRange(e.entry_date, bucket.start, bucket.end),
    }));

    const marginsFor = (agg) => {
      if (!agg || agg.net_income == null) {
        return { reportedNet: null, reportedMargin: null, underlyingNet: null, underlyingMargin: null };
      }
      return {
        reportedNet: agg.net_income,
        reportedMargin: agg.income ? (agg.net_income / agg.income) * 100 : null,
        underlyingNet: agg.u_net_income,
        underlyingMargin: agg.u_income ? (agg.u_net_income / agg.u_income) * 100 : null,
      };
    };

    return {
      owner,
      ownerAddBack: curAgg?.owner_add_back ?? 0,
      oo,
      oneoffCost: curAgg?.oneoff_cost ?? 0,
      oneoffIncome: curAgg?.oneoff_income ?? 0,
      rowsById,
      bucket,
      priorLabel: priorAgg?.label || null,
      ...marginsFor(curAgg),
      prior: marginsFor(priorAgg),
    };
  }, [detail, buckets, prior, ownerRows, ownerAccountIds, oneoffs, accountsById]);
  /* Suggested owner costs — nominal codes that look like director personal items
     but haven't been confirmed or rejected yet. Amounts come from the same
     period P&L the maths uses, so the tile shows what accepting would move. */
  const suggestions = useMemo(() => suggestOwnerCosts(accounts, {
    taggedIds: new Set(ownerRows.map((r) => r.account_id)),
    dismissedIds: new Set(dismissedRows.map((r) => r.account_id)),
    amountFor: (id) => {
      const row = calc.rowsById?.[id];
      const acct = accountsById[id];
      return {
        amount: row?.amount ?? 0,
        income: acct ? acct.classification === 'Revenue' : isIncomeGroup(row?.group),
      };
    },
  }), [accounts, ownerRows, dismissedRows, calc.rowsById, accountsById]);

  if (!detail) {
    return (
      <>
        {bar}
        {loading
          ? <div style={{ ...cardStyle, textAlign: 'center', padding: '48px' }}>
              <Loader size={22} style={{ color: '#7dd3fc', animation: 'spin 1s linear infinite' }} />
            </div>
          : <div style={{ ...cardStyle, textAlign: 'center', padding: '48px 24px', fontFamily: OUTFIT, fontSize: '13px', color: '#64748b' }}>
              {empty?.needsReconnect
                ? `${empty.selectedName || 'This client'} needs to reconnect QuickBooks.`
                : 'Pull from QuickBooks to build the underlying view.'}
            </div>}
      </>
    );
  }

  const ownerIdSet = new Set(ownerRows.map((o) => o.account_id));

  const periodLabel = calc.bucket?.label || 'period';
  const deltaLabel = calc.priorLabel ? `vs ${calc.priorLabel}` : 'vs prior period';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      {bar}

      {/* Headline tiles */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: '12px' }}>
        <Tile label={`Reported net profit — ${periodLabel}`} value={calc.reportedNet} currency={currency}
          delta={<MoneyDelta now={calc.reportedNet} prev={calc.prior?.reportedNet} currency={currency} label={deltaLabel} />} />
        <Tile label="Reported margin" text={calc.reportedMargin == null ? '—' : `${calc.reportedMargin.toFixed(1)}%`}
          delta={<PpDelta now={calc.reportedMargin} prev={calc.prior?.reportedMargin} label={deltaLabel} />} />
        <Tile label="Underlying profit for the owner" value={calc.underlyingNet} currency={currency} accent
          delta={<MoneyDelta now={calc.underlyingNet} prev={calc.prior?.underlyingNet} currency={currency} label={deltaLabel} />} />
        <Tile label="Underlying margin" text={calc.underlyingMargin == null ? '—' : `${calc.underlyingMargin.toFixed(1)}%`} accent
          delta={<PpDelta now={calc.underlyingMargin} prev={calc.prior?.underlyingMargin} label={deltaLabel} />} />
      </div>

      {/* Waterfall */}
      <div style={cardStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px' }}>
          <TrendingUp size={18} style={{ color: '#38bdf8' }} />
          <span style={{ fontFamily: OUTFIT, fontSize: '15px', fontWeight: 700, color: '#0f172a' }}>
            From reported to underlying profit
          </span>
          <span style={{ fontFamily: OUTFIT, fontSize: '12px', color: '#94a3b8', marginLeft: 'auto' }}>
            {calc.bucket && `${shortDate(calc.bucket.start)} → ${shortDate(calc.bucket.end)}`}
          </span>
        </div>
        <WaterfallRow label="Reported net profit" value={calc.reportedNet} currency={currency} kind="base" />
        <WaterfallRow label="Add back: Owner costs removed" value={calc.ownerAddBack} currency={currency} kind="add" />
        <WaterfallRow label="Add back: One-off costs removed" value={calc.oneoffCost} currency={currency} kind="add" />
        <WaterfallRow label="Less: One-off income removed" value={-calc.oneoffIncome} currency={currency} kind="sub" />
        <WaterfallRow label="Underlying profit for the owner" value={calc.underlyingNet} currency={currency} kind="total" />
      </div>

      {/* Suggested owner costs — proposal only, ticks make it real */}
      {suggestions.length > 0 && (
        <SuggestionCard
          suggestions={suggestions} currency={currency} busy={busy}
          onConfirm={confirmSuggestions} onDismiss={dismissSuggestions}
        />
      )}

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
        {dismissedRows.length > 0 && (
          <p style={{ fontFamily: OUTFIT, fontSize: '11.5px', color: '#94a3b8', margin: '10px 0 0' }}>
            {dismissedRows.length} suggested code{dismissedRows.length === 1 ? '' : 's'} marked as not personal.{' '}
            <button onClick={restoreDismissed} disabled={busy} style={linkBtn}>Show them again</button>
          </p>
        )}
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

const linkBtn = {
  background: 'none', border: 'none', padding: 0, cursor: 'pointer',
  fontFamily: OUTFIT, fontSize: 'inherit', fontWeight: 600, color: '#0369a1',
  textDecoration: 'underline',
};

/* Suggested owner costs.

   Codes the nominal hierarchy says look like director personal items. High-
   confidence rules (dividends, director's pay, home office) come pre-ticked so
   confirming is one click; the softer ones start unticked. Nothing here is in
   the maths until "Confirm" is pressed — that's the human in the loop. */
function SuggestionCard({ suggestions, currency, busy, onConfirm, onDismiss }) {
  const [ticked, setTicked] = useState(null);

  // Re-seed the ticks whenever the underlying suggestion set changes (client
  // switch, period change, a code just confirmed), keyed on the ids on show.
  const key = suggestions.map((s) => s.account_id).join(',');
  const seeded = useMemo(
    () => new Set(suggestions.filter((s) => s.preTick).map((s) => s.account_id)),
    [key], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const marks = ticked?.key === key ? ticked.set : seeded;
  const setMarks = (set) => setTicked({ key, set });

  const toggle = (id) => {
    const next = new Set(marks);
    if (next.has(id)) next.delete(id); else next.add(id);
    setMarks(next);
  };
  const picked = suggestions.filter((s) => marks.has(s.account_id));
  const rest = suggestions.filter((s) => !marks.has(s.account_id));
  // What confirming the ticked codes would add back (income tags come off).
  const impact = picked.reduce((s, x) => s + (x.income ? -x.amount : x.amount), 0);

  return (
    <div style={{ ...cardStyle, borderColor: '#fcd34d', backgroundColor: '#fffbeb' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <Sparkles size={17} style={{ color: '#b45309' }} />
        <span style={{ fontFamily: OUTFIT, fontSize: '15px', fontWeight: 700, color: '#0f172a' }}>
          Suggested director personal items
        </span>
        <span style={{ fontFamily: OUTFIT, fontSize: '12px', fontWeight: 600, color: '#b45309', marginLeft: 'auto' }}>
          {suggestions.length} to review
        </span>
      </div>
      <p style={{ fontFamily: OUTFIT, fontSize: '12px', color: '#92400e', margin: '4px 0 10px', display: 'flex', gap: '5px', alignItems: 'flex-start' }}>
        <Info size={13} style={{ flexShrink: 0, marginTop: '1px' }} />
        These nominal codes look like the owner taking money out rather than costs of trading. Nothing is
        adjusted until you confirm — tick what should come out of underlying profit.
      </p>

      <div style={{ marginBottom: '12px' }}>
        {suggestions.map((s) => {
          const on = marks.has(s.account_id);
          return (
            <label key={s.account_id} style={{
              display: 'flex', alignItems: 'flex-start', gap: '10px', padding: '9px 0',
              borderBottom: '1px solid #fef3c7', cursor: 'pointer',
            }}>
              <input
                type="checkbox" checked={on} onChange={() => toggle(s.account_id)}
                style={{ width: '16px', height: '16px', marginTop: '2px', accentColor: '#0369a1', cursor: 'pointer', flexShrink: 0 }}
              />
              <span style={{ minWidth: 0 }}>
                <span style={{ fontFamily: OUTFIT, fontSize: '13px', fontWeight: 600, color: '#0f172a' }}>
                  {acctLabel(s.acct_num, s.account_name)}
                </span>
                <span style={{
                  fontFamily: OUTFIT, fontSize: '10.5px', fontWeight: 700, marginLeft: '8px',
                  padding: '2px 6px', borderRadius: '5px', backgroundColor: '#fef3c7', color: '#92400e',
                  whiteSpace: 'nowrap',
                }}>{s.rule_label}</span>
                {s.income && <span style={{ fontFamily: OUTFIT, fontSize: '11px', color: '#b45309', marginLeft: '6px' }}>· income</span>}
                <span style={{ display: 'block', fontFamily: OUTFIT, fontSize: '12px', color: '#78716c', marginTop: '2px' }}>
                  {s.why}
                </span>
              </span>
              <span style={{
                marginLeft: 'auto', paddingLeft: '10px', fontFamily: OUTFIT, fontSize: '13px', fontWeight: 600,
                color: Math.abs(s.amount) > 0.005 ? '#334155' : '#a8a29e', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap',
              }}>
                {money(s.amount, currency)}
              </span>
            </label>
          );
        })}
      </div>

      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
        <button
          onClick={() => onConfirm(picked)} disabled={!picked.length || busy}
          style={{ ...addBtn, opacity: picked.length && !busy ? 1 : 0.5, cursor: picked.length && !busy ? 'pointer' : 'not-allowed' }}
        >
          <Check size={14} /> Confirm {picked.length} as owner cost{picked.length === 1 ? '' : 's'}
        </button>
        {rest.length > 0 && (
          <button
            onClick={() => onDismiss(rest)} disabled={busy}
            style={{
              ...addBtn, borderColor: '#e7e5e4', backgroundColor: '#ffffff', color: '#78716c',
              opacity: busy ? 0.5 : 1, cursor: busy ? 'not-allowed' : 'pointer',
            }}
          >
            <X size={14} /> {rest.length} unticked {rest.length === 1 ? 'is' : 'are'} not personal
          </button>
        )}
        {picked.length > 0 && (
          <span style={{ fontFamily: OUTFIT, fontSize: '12px', color: '#92400e', marginLeft: 'auto' }}>
            Adds {money(impact, currency)} back to underlying profit
          </span>
        )}
        {busy && <Loader size={14} style={{ color: '#b45309', animation: 'spin 1s linear infinite' }} />}
      </div>
    </div>
  );
}

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
