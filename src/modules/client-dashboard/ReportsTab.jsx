import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { FileBarChart, Plus, X, Trash2, Save, GripVertical } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../shell/AppShell';
import { money, OUTFIT, cardStyle, inputStyle } from './dashboardData';
import { GRAINS, BASES, VIEWS, buildBuckets, aggregate, seriesFor, windowLabel, monthKeyOfDate } from './overviewGrain';
import { Segmented, LoadingCard } from './DashboardUI';
import { BucketChart, LineChart } from './DashboardCharts';
import { buildKpiModel, formatKpi, FINANCIAL_KEYS } from './kpiEngine';

/*
  Custom reports.

  Once KPIs exist a report turns out to be a thin idea: a named list of rows —
  financial categories and KPIs together — at a grain and a basis, with an
  optional chart. A saved view. All the arithmetic already belongs to
  overviewGrain and kpiEngine; this only remembers what somebody chose and
  renders it.

  Scope follows KPI definitions so there is one idea to learn: a report belongs
  to this client, to its sector (every nursery gets it), or to nobody in
  particular (available everywhere). The last two need the pack permission,
  because they show up on other people's clients.
*/

const FIN_ROWS = FINANCIAL_KEYS;

export default function ReportsTab({
  entityId, clientName, detail, bs, config, kpi, fyIdx, currency, sectorId, canManagePacks,
}) {
  const { profile } = useAuth();
  const [reports, setReports] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(null);

  const load = useCallback(async () => {
    if (!entityId) return;
    setLoading(true);
    try {
      const { data, error: e } = await supabase.rpc('dashboard_reports_for_entity', { p_entity_id: entityId });
      if (e) throw e;
      setReports(data || []);
      setActiveId((cur) => (data || []).some((r) => r.id === cur) ? cur : (data?.[0]?.id || null));
    } catch (e) { setError(String(e.message || e)); }
    setLoading(false);
  }, [entityId]);

  useEffect(() => { load(); }, [load]);

  const active = reports.find((r) => r.id === activeId) || null;

  const save = async (draft) => {
    setBusy(true);
    setError(null);
    try {
      const row = {
        name: draft.name.trim() || 'Untitled report',
        description: draft.description?.trim() || null,
        grain: draft.grain, basis: draft.basis, view: draft.view,
        periods: Number(draft.periods) || 12,
        rows: draft.rows,
        chart: draft.chart,
        entity_id: draft.scope === 'client' ? entityId : null,
        sector_id: draft.scope === 'sector' ? sectorId : null,
        updated_at: new Date().toISOString(),
      };
      const { data, error: e } = draft.id
        ? await supabase.from('dashboard_report').update(row).eq('id', draft.id).select().single()
        : await supabase.from('dashboard_report').insert({ ...row, created_by: profile?.id || null }).select().single();
      if (e) throw e;
      setEditing(null);
      await load();
      setActiveId(data.id);
    } catch (e) { setError(String(e.message || e)); }
    setBusy(false);
  };

  const remove = async (r) => {
    if (!window.confirm(`Delete "${r.name}"?`)) return;
    setBusy(true);
    try {
      await supabase.from('dashboard_report').delete().eq('id', r.id);
      await load();
    } catch (e) { setError(String(e.message || e)); }
    setBusy(false);
  };

  if (loading) return <LoadingCard label="reports" />;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      {error && (
        <div style={{ fontFamily: OUTFIT, fontSize: '12.5px', color: '#b91c1c', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: '10px', padding: '10px 14px' }}>
          {error}
        </div>
      )}

      <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
        {reports.length > 0 && (
          <Segmented
            value={activeId} onChange={setActiveId}
            options={reports.map((r) => ({ key: r.id, label: r.name }))}
          />
        )}
        <button onClick={() => setEditing(blankReport())} style={{ ...primaryBtn, marginLeft: 'auto' }}>
          <Plus size={14} /> New report
        </button>
        {active && (
          <>
            <button onClick={() => setEditing({ ...active, scope: active.entity_id ? 'client' : active.sector_id ? 'sector' : 'global' })} style={smallBtn}>
              Edit
            </button>
            <button onClick={() => remove(active)} disabled={busy} style={{ ...smallBtn, color: '#b91c1c', borderColor: '#fecaca' }}>
              <Trash2 size={12} />
            </button>
          </>
        )}
      </div>

      {reports.length === 0 && (
        <div style={{ ...cardStyle, textAlign: 'center', padding: '48px 24px' }}>
          <FileBarChart size={28} style={{ color: '#cbd5e1', marginBottom: '10px' }} />
          <div style={{ fontFamily: OUTFIT, fontSize: '16px', fontWeight: 700, color: '#0f172a', marginBottom: '6px' }}>
            No saved reports
          </div>
          <p style={{ fontFamily: OUTFIT, fontSize: '13px', color: '#64748b', maxWidth: '480px', margin: '0 auto 18px', lineHeight: 1.6 }}>
            A report is a set of rows you care about — turnover, profit, occupancy, whatever matters
            for this client — at a grain you choose. Build it once and it is there every month.
            Save it against the sector and every client in that sector gets it too.
          </p>
          <button onClick={() => setEditing(blankReport())} style={primaryBtn}>
            <Plus size={15} /> Build one
          </button>
        </div>
      )}

      {active && (
        <ReportView
          report={active} detail={detail} bs={bs} config={config} kpi={kpi}
          fyIdx={fyIdx} currency={currency} clientName={clientName}
        />
      )}

      {editing && (
        <ReportEditor
          draft={editing} setDraft={setEditing} kpi={kpi} busy={busy}
          canScopeWide={canManagePacks} hasSector={!!sectorId}
          onClose={() => setEditing(null)} onSave={save}
        />
      )}
    </div>
  );
}

const blankReport = () => ({
  name: '', description: '', grain: 'month', basis: 'fiscal', view: 'reported',
  periods: 12, rows: [], chart: 'bars_line', scope: 'client',
});

/* ─── Rendering a report ───────────────────────────────────────── */
function ReportView({ report, detail, bs, config, kpi, fyIdx, currency, clientName }) {
  const model = useMemo(() => {
    // The report carries its own grain, basis and length, so it looks the same
    // every month regardless of where the Overview happens to be pointed.
    const anchor = detail?.month_keys?.length
      ? detail.month_keys[detail.month_keys.length - 1]
      : monthKeyOfDate(new Date());
    const { buckets, prior } = buildBuckets({
      grain: report.grain, basis: report.basis, anchorKey: anchor, fyIdx, count: report.periods,
    });

    const fin = detail
      ? aggregate(detail, [prior, ...buckets], {
        ownerAccountIds: config?.ownerAccountIds,
        accountsById: config?.accountsById,
        oneoffs: config?.oneoffs,
      }).slice(1)
      : buckets.map(() => null);

    const financials = (bi, key) => {
      const r = fin[bi];
      if (!r) return null;
      if (key === 'cash') return bs?.cash ?? null;
      if (key === 'debtors') return bs?.debtors ?? null;
      if (key === 'creditors') return bs?.accounts_payable ?? bs?.creditors_within_1yr ?? null;
      const s = seriesFor(r, report.view);
      if (key === 'income') return s.income;
      if (key === 'net_income') return s.net_income;
      return r[key] ?? null;
    };

    const kpiModel = buildKpiModel({
      definitions: kpi.definitions, dimensionValues: kpi.dimensionValues,
      values: kpi.values, buckets, financials,
    });

    return { buckets, fin, financials, kpiModel };
  }, [report, detail, bs, config, kpi, fyIdx]);

  const { buckets, financials, kpiModel } = model;

  const rows = (report.rows || []).map((r) => {
    if (r.source === 'financial') {
      const meta = FIN_ROWS.find((f) => f.key === r.key);
      return {
        key: `fin-${r.key}`,
        label: r.label || meta?.label || r.key,
        unit: 'money', decimals: 0,
        values: buckets.map((_, bi) => financials(bi, r.key)),
      };
    }
    const k = kpiModel.byKey[r.key];
    if (!k) return { key: `kpi-${r.key}`, label: r.label || r.key, unit: 'number', decimals: 0, values: buckets.map(() => null), missing: true };
    return {
      key: `kpi-${r.key}`,
      label: r.label || k.definition.label,
      unit: k.definition.unit, decimals: k.definition.decimals,
      values: k.total,
    };
  });

  const chartRow = rows[0];

  return (
    <>
      <div style={cardStyle}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '10px', flexWrap: 'wrap' }}>
          <span style={{ fontFamily: OUTFIT, fontSize: '16px', fontWeight: 700, color: '#0f172a' }}>{report.name}</span>
          <span style={{ fontFamily: OUTFIT, fontSize: '11.5px', color: '#94a3b8' }}>
            {clientName} · {windowLabel(report.grain, report.basis, buckets)}
            {report.view === 'underlying' && ' · underlying'}
            {!report.entity_id && (report.sector_id ? ' · sector report' : ' · practice-wide report')}
          </span>
        </div>
        {report.description && (
          <p style={{ fontFamily: OUTFIT, fontSize: '12.5px', color: '#64748b', margin: '6px 0 0' }}>{report.description}</p>
        )}
      </div>

      {report.chart !== 'none' && chartRow && (
        <div style={cardStyle}>
          <div style={{ fontFamily: OUTFIT, fontSize: '14px', fontWeight: 700, color: '#0f172a', marginBottom: '8px' }}>
            {chartRow.label}
          </div>
          {report.chart === 'bars_line' && rows.length > 1 ? (
            <BucketChart
              points={buckets.map((b, i) => ({ label: b.label, income: chartRow.values[i], net: rows[1].values[i] }))}
              currency={currency}
              incomeLabel={chartRow.label} netLabel={rows[1].label}
            />
          ) : (
            <LineChart
              points={buckets.map((b, i) => ({ label: b.label, value: chartRow.values[i] }))}
              currency={currency}
            />
          )}
        </div>
      )}

      <div style={{ ...cardStyle, padding: '16px 0 6px' }}>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: `${240 + buckets.length * 92}px` }}>
            <thead>
              <tr>
                <th style={{ ...th, textAlign: 'left', position: 'sticky', left: 0, backgroundColor: '#fff', minWidth: '210px' }} />
                {buckets.map((b) => <th key={b.key} style={th}>{b.label}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr><td colSpan={buckets.length + 1} style={{ ...td, textAlign: 'left', paddingLeft: '20px', color: '#94a3b8' }}>
                  This report has no rows yet.
                </td></tr>
              )}
              {rows.map((r) => (
                <tr key={r.key}>
                  <td style={{ ...td, textAlign: 'left', position: 'sticky', left: 0, backgroundColor: '#fff', fontWeight: 600, color: r.missing ? '#b45309' : '#0f172a', paddingLeft: '20px' }}>
                    {r.label}
                    {r.missing && <span style={{ fontWeight: 400, fontSize: '11px' }}> · no longer exists on this client</span>}
                  </td>
                  {r.values.map((v, i) => (
                    <td key={i} style={td}>
                      {r.unit === 'money' ? money(v, currency) : formatKpi(v, r.unit, r.decimals, currency)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

/* ─── Editor ───────────────────────────────────────────────────── */
function ReportEditor({ draft, setDraft, kpi, busy, canScopeWide, hasSector, onClose, onSave }) {
  const set = (patch) => setDraft((d) => ({ ...d, ...patch }));
  const rows = draft.rows || [];

  const addRow = (source, key, label) => {
    if (rows.some((r) => r.source === source && r.key === key)) return;
    set({ rows: [...rows, { source, key, label }] });
  };
  const removeRow = (i) => set({ rows: rows.filter((_, x) => x !== i) });
  const moveRow = (i, dir) => {
    const next = [...rows];
    const j = i + dir;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j], next[i]];
    set({ rows: next });
  };

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, backgroundColor: 'rgba(15,23,42,0.45)', zIndex: 70,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        backgroundColor: '#fff', borderRadius: 16, width: '100%', maxWidth: 700,
        maxHeight: '88vh', overflowY: 'auto', fontFamily: OUTFIT,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '18px 22px', borderBottom: '1px solid #e5e7eb' }}>
          <FileBarChart size={17} style={{ color: '#38bdf8' }} />
          <span style={{ fontSize: 15.5, fontWeight: 700, color: '#0f172a' }}>
            {draft.id ? 'Edit report' : 'New report'}
          </span>
          <button onClick={onClose} style={{ marginLeft: 'auto', border: 'none', background: 'none', cursor: 'pointer', padding: 0 }}>
            <X size={18} style={{ color: '#94a3b8' }} />
          </button>
        </div>

        <div style={{ padding: '18px 22px', display: 'flex', flexDirection: 'column', gap: 15 }}>
          <label style={lbl}>
            Name
            <input value={draft.name} onChange={(e) => set({ name: e.target.value })}
              placeholder="Monthly board pack" style={inputStyle} />
          </label>

          <label style={lbl}>
            Description (optional)
            <input value={draft.description || ''} onChange={(e) => set({ description: e.target.value })}
              placeholder="What this is for" style={inputStyle} />
          </label>

          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
            <Segmented label="By" value={draft.grain} onChange={(v) => set({ grain: v })} options={GRAINS} size="sm" />
            <Segmented label="Year" value={draft.basis} onChange={(v) => set({ basis: v })} options={BASES} size="sm" />
            <Segmented label="View" value={draft.view} onChange={(v) => set({ view: v })} options={VIEWS} size="sm" />
          </div>

          <div style={{ display: 'flex', gap: 12 }}>
            <label style={{ ...lbl, width: 130 }}>
              How many periods
              <input type="number" min="2" max="60" value={draft.periods}
                onChange={(e) => set({ periods: e.target.value })} style={inputStyle} />
            </label>
            <label style={{ ...lbl, flex: 1 }}>
              Chart
              <select value={draft.chart} onChange={(e) => set({ chart: e.target.value })} style={inputStyle}>
                <option value="none">No chart</option>
                <option value="bars_line">Bars and a line — first two rows</option>
                <option value="line">Line — first row</option>
              </select>
            </label>
            <label style={{ ...lbl, flex: 1 }}>
              Available to
              <select value={draft.scope} onChange={(e) => set({ scope: e.target.value })} style={inputStyle}
                disabled={!canScopeWide}>
                <option value="client">This client only</option>
                <option value="sector" disabled={!hasSector}>Every client in this sector</option>
                <option value="global">Every client</option>
              </select>
              {!canScopeWide && (
                <span style={hint}>Sharing beyond this client needs the KPI packs permission.</span>
              )}
            </label>
          </div>

          {/* Rows */}
          <div>
            <div style={lblText}>Rows, in order</div>
            <div style={{ marginTop: 6 }}>
              {rows.length === 0 && (
                <div style={{ fontSize: 12.5, color: '#94a3b8', padding: '8px 0' }}>
                  Nothing chosen yet — pick from below.
                </div>
              )}
              {rows.map((r, i) => (
                <div key={`${r.source}-${r.key}`} style={{
                  display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0',
                  borderBottom: '1px solid #f1f5f9',
                }}>
                  <GripVertical size={13} style={{ color: '#cbd5e1' }} />
                  <span style={{ fontSize: 13, color: '#0f172a' }}>{r.label || r.key}</span>
                  <span style={{ ...chip, marginLeft: 6 }}>{r.source === 'kpi' ? 'KPI' : 'accounts'}</span>
                  <div style={{ marginLeft: 'auto', display: 'flex', gap: 3 }}>
                    <button onClick={() => moveRow(i, -1)} disabled={i === 0} style={tinyBtn}>↑</button>
                    <button onClick={() => moveRow(i, 1)} disabled={i === rows.length - 1} style={tinyBtn}>↓</button>
                    <button onClick={() => removeRow(i)} style={{ ...tinyBtn, color: '#b91c1c' }}><X size={12} /></button>
                  </div>
                </div>
              ))}
            </div>

            <div style={{ marginTop: 12 }}>
              <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 4 }}>From the accounts</div>
              <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginBottom: 10 }}>
                {FIN_ROWS.map((f) => (
                  <button key={f.key} onClick={() => addRow('financial', f.key, f.label)} style={pill}>
                    {f.label}
                  </button>
                ))}
              </div>
              <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 4 }}>KPIs</div>
              <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                {kpi.definitions.length === 0 && <span style={{ fontSize: 11.5, color: '#cbd5e1' }}>none on this client</span>}
                {kpi.definitions.map((d) => (
                  <button key={d.id} onClick={() => addRow('kpi', d.key, d.label)} style={pill}>
                    {d.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', padding: '14px 22px', borderTop: '1px solid #e5e7eb' }}>
          <button onClick={onClose} style={smallBtn}>Cancel</button>
          <button onClick={() => onSave(draft)} disabled={busy || !draft.name.trim()}
            style={{ ...primaryBtn, backgroundColor: draft.name.trim() && !busy ? '#0f172a' : '#cbd5e1' }}>
            <Save size={14} /> {busy ? 'Saving…' : 'Save report'}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ─── Styles ───────────────────────────────────────────────────── */
const th = {
  fontFamily: OUTFIT, fontSize: '11px', color: '#94a3b8', fontWeight: 700,
  textAlign: 'right', padding: '7px 14px', whiteSpace: 'nowrap', borderBottom: '1px solid #e5e7eb',
};
const td = {
  fontFamily: OUTFIT, fontSize: '12.5px', textAlign: 'right', padding: '7px 14px',
  whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums', borderBottom: '1px solid #f8fafc',
};
const lbl = { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, fontWeight: 600, color: '#475569' };
const lblText = { fontSize: 12, fontWeight: 600, color: '#475569' };
const hint = { fontSize: 11.5, fontWeight: 400, color: '#94a3b8', lineHeight: 1.5 };
const chip = {
  fontSize: 10.5, fontWeight: 600, padding: '2px 7px', borderRadius: 999,
  border: '1px solid #e5e7eb', backgroundColor: '#f8fafc', color: '#64748b',
};
const pill = {
  fontSize: 11.5, padding: '4px 10px', borderRadius: 999, border: '1px solid #e5e7eb',
  backgroundColor: '#f8fafc', color: '#334155', cursor: 'pointer', fontFamily: OUTFIT,
};
const tinyBtn = {
  border: '1px solid #e5e7eb', borderRadius: 6, padding: '2px 6px', background: '#fff',
  color: '#64748b', fontSize: 11, cursor: 'pointer', fontFamily: OUTFIT, lineHeight: 1.4,
};
const smallBtn = {
  display: 'inline-flex', alignItems: 'center', gap: 5, border: '1px solid #e5e7eb',
  borderRadius: 8, padding: '7px 13px', background: '#fff', color: '#475569',
  fontFamily: OUTFIT, fontSize: 12.5, fontWeight: 600, cursor: 'pointer',
};
const primaryBtn = {
  display: 'inline-flex', alignItems: 'center', gap: 6, padding: '9px 17px',
  border: 'none', borderRadius: 10, backgroundColor: '#0f172a', color: '#fff',
  fontFamily: OUTFIT, fontSize: 13, fontWeight: 700, cursor: 'pointer',
};
