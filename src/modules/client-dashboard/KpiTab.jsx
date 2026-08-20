import React, { useState, useMemo } from 'react';
import { Info, Plus, X, Eye, EyeOff, Sigma, PencilLine, ExternalLink } from 'lucide-react';
import { OUTFIT, cardStyle, inputStyle, shortDate } from './dashboardData';
import { GRAINS, BASES } from './overviewGrain';
import { Segmented, LoadingCard } from './DashboardUI';
import { BucketChart, LineChart } from './DashboardCharts';
import { buildKpiModel, formatKpi } from './kpiEngine';

/*
  KPI tab.

  Four things, in the order somebody actually needs them:

    1. The figures, at whatever grain the Overview is set to.
    2. The by-dimension breakdown, because "occupancy 79%" is a different
       conversation from "occupancy 79% but the baby room is at 100%".
    3. The entry grid — months across, KPIs down. Entering a year across four
       rooms one field at a time is how data entry dies, so it is a grid you
       tab through, saving on blur.
    4. Configuration: which sector pack this client is on, its dimension values
       (its rooms), and which pack KPIs to hide.

  Everything reads one model from kpiEngine, which owns the arithmetic — in
  particular that a quarter's occupancy is total children over total places, not
  the average of three monthly percentages. See kpiEngine.js.
*/

const MONTH_LABEL = (key) => {
  const [y, m] = key.split('-').map(Number);
  return `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1]} ${String(y).slice(-2)}`;
};

export default function KpiTab({
  entityId, clientName, kpi, buckets, financials, currency,
  grain, setGrain, basis, setBasis, canManagePacks,
}) {
  const [sub, setSub] = useState('figures');

  const model = useMemo(() => buildKpiModel({
    definitions: kpi.definitions,
    dimensionValues: kpi.dimensionValues,
    values: kpi.values,
    buckets,
    financials,
  }), [kpi.definitions, kpi.dimensionValues, kpi.values, buckets, financials]);

  if (!entityId) return null;
  if (kpi.loading && !kpi.definitions.length) return <LoadingCard label="KPIs" />;

  const hasSector = !!kpi.sectorId;
  const nothing = kpi.definitions.length === 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      {kpi.error && (
        <div style={{
          fontFamily: OUTFIT, fontSize: '12.5px', color: '#b91c1c', background: '#fef2f2',
          border: '1px solid #fecaca', borderRadius: '10px', padding: '10px 14px',
          display: 'flex', gap: '10px', alignItems: 'center',
        }}>
          <span style={{ flex: 1 }}>{kpi.error}</span>
          <button onClick={kpi.clearError} style={{ border: 'none', background: 'none', cursor: 'pointer', padding: 0 }}>
            <X size={15} style={{ color: '#b91c1c' }} />
          </button>
        </div>
      )}

      <div style={{ display: 'flex', gap: '14px', alignItems: 'center', flexWrap: 'wrap' }}>
        <Segmented
          value={sub} onChange={setSub}
          options={[
            { key: 'figures', label: 'Figures' },
            { key: 'entry', label: 'Enter figures' },
            { key: 'setup', label: 'Setup' },
          ]}
        />
        {sub === 'figures' && (
          <div style={{ marginLeft: 'auto', display: 'flex', gap: '14px', alignItems: 'center', flexWrap: 'wrap' }}>
            <Segmented label="By" value={grain} onChange={setGrain} options={GRAINS} size="sm" />
            <Segmented label="Year" value={basis} onChange={setBasis} options={BASES} size="sm" />
          </div>
        )}
      </div>

      {nothing && (
        <div style={{ ...cardStyle, textAlign: 'center', padding: '44px 24px' }}>
          <Sigma size={26} style={{ color: '#cbd5e1', marginBottom: '10px' }} />
          <div style={{ fontFamily: OUTFIT, fontSize: '15px', fontWeight: 700, color: '#0f172a', marginBottom: '6px' }}>
            No KPIs for {clientName || 'this client'} yet
          </div>
          <p style={{ fontFamily: OUTFIT, fontSize: '13px', color: '#64748b', maxWidth: '460px', margin: '0 auto 16px', lineHeight: 1.6 }}>
            {hasSector
              ? 'This client is on a sector pack, but the pack has no active KPIs. Add some in KPI Packs.'
              : 'Put this client in a sector to get its pack — a nursery gets children, places and occupancy — or add a KPI just for them.'}
          </p>
          <button onClick={() => setSub('setup')} style={primaryBtn}>Open setup</button>
        </div>
      )}

      {!nothing && sub === 'figures' && (
        <Figures model={model} buckets={buckets} currency={currency} />
      )}
      {!nothing && sub === 'entry' && (
        <EntryGrid kpi={kpi} buckets={buckets} />
      )}
      {sub === 'setup' && (
        <Setup kpi={kpi} model={model} canManagePacks={canManagePacks} />
      )}
    </div>
  );
}

/* ─── Figures ──────────────────────────────────────────────────── */
function Figures({ model, buckets, currency }) {
  const [openRow, setOpenRow] = useState(null);
  if (!buckets.length) return null;

  const latest = buckets.length - 1;
  const tiles = model.rows.filter((r) => r.definition.show_on_overview);

  return (
    <>
      {tiles.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: '12px' }}>
          {tiles.map((r) => (
            <KpiTile key={r.definition.id} row={r} index={latest} bucket={buckets[latest]} currency={currency} />
          ))}
        </div>
      )}

      <div style={{ ...cardStyle, padding: '16px 0 6px' }}>
        <div style={{ padding: '0 20px 12px', display: 'flex', alignItems: 'baseline', gap: '10px', flexWrap: 'wrap' }}>
          <span style={{ fontFamily: OUTFIT, fontSize: '15px', fontWeight: 700, color: '#0f172a' }}>KPIs</span>
          <span style={{ fontFamily: OUTFIT, fontSize: '11.5px', color: '#94a3b8' }}>
            Click a row with a breakdown to open it
          </span>
        </div>

        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: `${260 + buckets.length * 92}px` }}>
            <thead>
              <tr>
                <th style={{ ...th, textAlign: 'left', position: 'sticky', left: 0, backgroundColor: '#fff', minWidth: '230px' }} />
                {buckets.map((b) => <th key={b.key} style={th}>{b.label}</th>)}
              </tr>
            </thead>
            <tbody>
              {model.rows.map((r) => {
                const d = r.definition;
                const open = openRow === d.id;
                const hasDims = r.dimensions.length > 0;
                return (
                  <React.Fragment key={d.id}>
                    <tr
                      onClick={() => hasDims && setOpenRow(open ? null : d.id)}
                      style={{ cursor: hasDims ? 'pointer' : 'default' }}
                    >
                      <td style={{ ...td, textAlign: 'left', position: 'sticky', left: 0, backgroundColor: '#fff', fontWeight: 600, color: '#0f172a' }}>
                        {hasDims && <span style={{ color: '#94a3b8', marginRight: '6px' }}>{open ? '▾' : '▸'}</span>}
                        {d.label}
                        {d.kind === 'calculated' && (
                          <span title={d.formula} style={{ marginLeft: '7px', fontFamily: OUTFIT, fontSize: '10.5px', color: '#0369a1', backgroundColor: '#f0f9ff', border: '1px solid #bae6fd', borderRadius: '999px', padding: '1px 7px' }}>
                            ƒ
                          </span>
                        )}
                        {r.error && (
                          <span title={r.error} style={{ marginLeft: '7px', fontFamily: OUTFIT, fontSize: '10.5px', color: '#b45309' }}>
                            problem
                          </span>
                        )}
                        {d.hint && (
                          <span title={d.hint} style={{ marginLeft: '6px', color: '#cbd5e1' }}>
                            <Info size={11} style={{ verticalAlign: '-1px' }} />
                          </span>
                        )}
                      </td>
                      {r.total.map((v, i) => (
                        <td key={i} style={td}>{formatKpi(v, d.unit, d.decimals, currency)}</td>
                      ))}
                    </tr>
                    {open && r.dimensions.map((dim) => (
                      <tr key={dim.value.id}>
                        <td style={{ ...td, textAlign: 'left', position: 'sticky', left: 0, backgroundColor: '#fff', paddingLeft: '38px', color: '#64748b' }}>
                          {dim.value.label}
                        </td>
                        {dim.cells.map((v, i) => (
                          <td key={i} style={{ ...td, color: '#64748b' }}>
                            {formatKpi(v, d.unit, d.decimals, currency)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* A chart for each KPI flagged for the Overview — the ones somebody has
          said matter enough to watch over time. */}
      {tiles.map((r) => {
        const d = r.definition;
        const points = buckets.map((b, i) => ({ label: b.label, value: r.total[i] }));
        if (!points.some((p) => p.value != null)) return null;
        return (
          <div key={d.id} style={cardStyle}>
            <div style={{ fontFamily: OUTFIT, fontSize: '15px', fontWeight: 700, color: '#0f172a', marginBottom: '2px' }}>
              {d.label}
            </div>
            {d.hint && (
              <div style={{ fontFamily: OUTFIT, fontSize: '11.5px', color: '#94a3b8', marginBottom: '8px' }}>{d.hint}</div>
            )}
            <LineChart points={points} currency={currency} height={180} colour="#0284c7" />
          </div>
        );
      })}
    </>
  );
}

function KpiTile({ row, index, bucket, currency }) {
  const d = row.definition;
  const value = row.total[index];
  const prev = index > 0 ? row.total[index - 1] : null;
  const diff = (value != null && prev != null) ? value - prev : null;
  return (
    <div style={{ backgroundColor: '#f0f9ff', border: '1px solid #bae6fd', borderRadius: '12px', padding: '14px 16px' }} title={d.hint || ''}>
      <div style={{ fontFamily: OUTFIT, fontSize: '12px', color: '#0369a1', marginBottom: '4px' }}>{d.label}</div>
      <div style={{ fontFamily: OUTFIT, fontSize: '22px', fontWeight: 700, color: '#0f172a' }}>
        {formatKpi(value, d.unit, d.decimals, currency)}
      </div>
      <div style={{ minHeight: '16px', marginTop: '2px', fontFamily: OUTFIT, fontSize: '11.5px', color: '#64748b' }}>
        {diff != null && Math.abs(diff) > 0.0005 && (
          <span style={{ fontWeight: 600, color: diff > 0 ? '#166534' : '#991b1b' }}>
            {diff > 0 ? '▲' : '▼'} {formatKpi(Math.abs(diff), d.unit, d.decimals, currency)}{' '}
          </span>
        )}
        {bucket?.label}
      </div>
    </div>
  );
}

/* ─── Entry grid ───────────────────────────────────────────────── */
/*
  Months across, KPIs (and their dimension values) down. Saves on blur rather
  than on a Save button: a grid with a Save button gets half-filled and
  abandoned, and there is nothing here that needs to be atomic.

  Only entry KPIs appear. Calculated ones have no cells to type in — showing
  them greyed would just invite somebody to try.
*/
function EntryGrid({ kpi, buckets }) {
  const [monthsBack, setMonthsBack] = useState(12);

  // Entry is always MONTHLY whatever the figures tab is showing. You do not
  // enter a quarter's headcount; you enter three months and the reader
  // aggregates them the way the KPI says.
  const months = useMemo(() => {
    const end = buckets.length ? buckets[buckets.length - 1].endKey : null;
    const [ey, em] = (end || new Date().toISOString().slice(0, 7)).split('-').map(Number);
    const endAbs = ey * 12 + (em - 1);
    const out = [];
    for (let a = endAbs - (monthsBack - 1); a <= endAbs; a++) {
      out.push(`${Math.floor(a / 12)}-${String((a % 12) + 1).padStart(2, '0')}`);
    }
    return out;
  }, [buckets, monthsBack]);

  const byCell = useMemo(() => {
    const m = {};
    for (const v of kpi.values) {
      m[`${v.definition_id}|${String(v.period).slice(0, 7)}|${v.dimension_value_id || ''}`] = v;
    }
    return m;
  }, [kpi.values]);

  const dimsFor = (dimensionId) => kpi.dimensionValues
    .filter((v) => v.dimension_id === dimensionId && v.is_active !== false)
    .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));

  const rows = [];
  for (const d of kpi.entryDefinitions) {
    const dims = d.dimension_id ? dimsFor(d.dimension_id) : [];
    if (dims.length) {
      rows.push({ kind: 'header', key: `h-${d.id}`, label: d.label, hint: d.hint });
      for (const dv of dims) rows.push({ kind: 'cell', key: `${d.id}-${dv.id}`, def: d, dim: dv, label: dv.label, indent: true });
    } else {
      rows.push({ kind: 'cell', key: `${d.id}`, def: d, dim: null, label: d.label, hint: d.hint });
    }
  }

  if (!kpi.entryDefinitions.length) {
    return (
      <div style={{ ...cardStyle, fontFamily: OUTFIT, fontSize: '13px', color: '#64748b' }}>
        Every KPI on this client is calculated, so there is nothing to type in.
      </div>
    );
  }

  return (
    <div style={{ ...cardStyle, padding: '16px 0 6px' }}>
      <div style={{ padding: '0 20px 12px', display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
        <span style={{ fontFamily: OUTFIT, fontSize: '15px', fontWeight: 700, color: '#0f172a' }}>Enter figures</span>
        <span style={{ fontFamily: OUTFIT, fontSize: '11.5px', color: '#94a3b8' }}>
          Monthly, whatever the Figures tab is showing. Tab across; each cell saves as you leave it.
        </span>
        <select
          value={monthsBack}
          onChange={(e) => setMonthsBack(Number(e.target.value))}
          style={{ ...inputStyle, marginLeft: 'auto', padding: '6px 9px', fontSize: '12.5px' }}
        >
          <option value={6}>Last 6 months</option>
          <option value={12}>Last 12 months</option>
          <option value={24}>Last 24 months</option>
        </select>
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: `${240 + months.length * 78}px` }}>
          <thead>
            <tr>
              <th style={{ ...th, textAlign: 'left', position: 'sticky', left: 0, backgroundColor: '#fff', minWidth: '210px' }} />
              {months.map((m) => <th key={m} style={th}>{MONTH_LABEL(m)}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              if (r.kind === 'header') {
                return (
                  <tr key={r.key}>
                    <td colSpan={months.length + 1} style={{
                      fontFamily: OUTFIT, fontSize: '11px', fontWeight: 700, letterSpacing: '0.04em',
                      textTransform: 'uppercase', color: '#94a3b8', padding: '14px 20px 4px',
                    }} title={r.hint || ''}>
                      {r.label}
                    </td>
                  </tr>
                );
              }
              return (
                <tr key={r.key}>
                  <td
                    title={r.hint || ''}
                    style={{
                      ...td, textAlign: 'left', position: 'sticky', left: 0, backgroundColor: '#fff',
                      paddingLeft: r.indent ? '38px' : '20px', color: r.indent ? '#64748b' : '#0f172a',
                      fontWeight: r.indent ? 500 : 600,
                    }}
                  >
                    {r.label}
                  </td>
                  {months.map((m) => {
                    const cell = byCell[`${r.def.id}|${m}|${r.dim?.id || ''}`];
                    return (
                      <td key={m} style={{ ...td, padding: '3px 4px' }}>
                        <Cell
                          value={cell?.value}
                          automated={cell && cell.source !== 'manual'}
                          overridden={cell?.is_override}
                          onCommit={(v) => kpi.setValue(r.def.id, m, r.dim?.id || null, v)}
                        />
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p style={{ fontFamily: OUTFIT, fontSize: '11px', color: '#94a3b8', padding: '10px 20px 6px', margin: 0 }}>
        Leave a cell blank for "not known" — that is different from zero, and the figures above will
        show "—" rather than pretending it is nil.
      </p>
    </div>
  );
}

// Local state while typing, committed on blur or Enter. Controlled directly
// from props would fight the optimistic update on every keystroke.
function Cell({ value, onCommit, automated, overridden }) {
  const [draft, setDraft] = useState(null);
  const shown = draft !== null ? draft : (value ?? '');
  return (
    <input
      value={shown}
      inputMode="decimal"
      onChange={(e) => setDraft(e.target.value)}
      onFocus={(e) => e.target.select()}
      onBlur={() => {
        if (draft !== null && String(draft) !== String(value ?? '')) onCommit(draft);
        setDraft(null);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') { setDraft(null); e.currentTarget.blur(); }
      }}
      title={automated ? 'Came from an automated feed' : overridden ? 'Typed over an automated figure' : ''}
      style={{
        width: '100%', minWidth: '62px', boxSizing: 'border-box',
        border: `1px solid ${overridden ? '#fde68a' : automated ? '#bae6fd' : '#e5e7eb'}`,
        backgroundColor: overridden ? '#fffbeb' : automated ? '#f0f9ff' : '#ffffff',
        borderRadius: '7px', padding: '6px 8px', textAlign: 'right',
        fontFamily: OUTFIT, fontSize: '12.5px', fontVariantNumeric: 'tabular-nums', outline: 'none',
      }}
    />
  );
}

/* ─── Setup ────────────────────────────────────────────────────── */
function Setup({ kpi, model, canManagePacks }) {
  const [newDim, setNewDim] = useState({});
  const sector = kpi.sectors.find((s) => s.id === kpi.sectorId) || null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      {/* Sector */}
      <div style={cardStyle}>
        <SectionHead title="Sector" hint="Which pack of KPIs this client gets. Change it and the whole list changes." />
        <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap', marginTop: '10px' }}>
          <select
            value={kpi.sectorId || ''}
            onChange={(e) => kpi.setSector(e.target.value || null)}
            disabled={kpi.busy}
            style={{ ...inputStyle, minWidth: '220px' }}
          >
            <option value="">No sector — bespoke KPIs only</option>
            {kpi.sectors.map((s) => (
              <option key={s.id} value={s.id}>{s.label}</option>
            ))}
          </select>
          {sector && (
            <span style={{ fontFamily: OUTFIT, fontSize: '12px', color: '#64748b' }}>
              {sector.definition_count} KPI{sector.definition_count === 1 ? '' : 's'} ·
              {' '}{sector.client_count} client{sector.client_count === 1 ? '' : 's'} on this pack
            </span>
          )}
          {canManagePacks && (
            <a href="/admin/kpi-packs" style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: '5px', fontFamily: OUTFIT, fontSize: '12px', fontWeight: 600, color: '#0369a1', textDecoration: 'none' }}>
              <ExternalLink size={13} /> Edit packs
            </a>
          )}
        </div>
      </div>

      {/* Dimension values — this client's rooms */}
      {kpi.dimensionsInUse.map((dim) => {
        const vals = kpi.dimensionValues.filter((v) => v.dimension_id === dim.id)
          .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
        return (
          <div key={dim.id} style={cardStyle}>
            <SectionHead
              title={dim.label}
              hint={`The pack says these KPIs break down by ${dim.label.toLowerCase()}. These are this client's own.`}
            />
            {vals.length === 0 && (
              <p style={{ fontFamily: OUTFIT, fontSize: '13px', color: '#b45309', margin: '8px 0 12px' }}>
                None yet — the KPIs that break down by {dim.label.toLowerCase()} have nowhere to put a figure until you add at least one.
              </p>
            )}
            {vals.map((v) => (
              <div key={v.id} style={rowStyle}>
                <span style={{ fontFamily: OUTFIT, fontSize: '13px', color: '#0f172a' }}>{v.label}</span>
                <button
                  onClick={() => {
                    if (window.confirm(`Remove ${v.label}? Any figures entered against it go too.`)) kpi.removeDimensionValue(v.id);
                  }}
                  disabled={kpi.busy} title="Remove" style={iconBtn}
                >
                  <X size={14} style={{ color: '#94a3b8' }} />
                </button>
              </div>
            ))}
            <div style={{ display: 'flex', gap: '8px', marginTop: '10px' }}>
              <input
                value={newDim[dim.id] || ''}
                onChange={(e) => setNewDim((n) => ({ ...n, [dim.id]: e.target.value }))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && newDim[dim.id]?.trim()) {
                    kpi.addDimensionValue(dim.id, newDim[dim.id]);
                    setNewDim((n) => ({ ...n, [dim.id]: '' }));
                  }
                }}
                placeholder={`Add a ${dim.label.toLowerCase()}…`}
                style={{ ...inputStyle, flex: 1 }}
              />
              <button
                onClick={() => {
                  if (!newDim[dim.id]?.trim()) return;
                  kpi.addDimensionValue(dim.id, newDim[dim.id]);
                  setNewDim((n) => ({ ...n, [dim.id]: '' }));
                }}
                disabled={kpi.busy} style={addBtn}
              >
                <Plus size={14} /> Add
              </button>
            </div>
          </div>
        );
      })}

      {/* Which KPIs this client shows */}
      <div style={cardStyle}>
        <SectionHead
          title="KPIs on this client"
          hint="Hiding a pack KPI affects this client only — the pack, and every other client on it, is untouched."
        />
        <div style={{ marginTop: '8px' }}>
          {model.rows.map((r) => {
            const d = r.definition;
            return (
              <div key={d.id} style={rowStyle}>
                <span style={{ fontFamily: OUTFIT, fontSize: '13px', color: '#0f172a' }}>
                  {d.label}
                  <span style={{ color: '#94a3b8', fontSize: '11.5px' }}>
                    {' · '}{d.kind === 'calculated' ? d.formula : `${d.aggregation} of the months`}
                    {d.dimension_label ? ` · by ${d.dimension_label.toLowerCase()}` : ''}
                    {d.origin === 'pack' ? ' · from the pack' : ' · just this client'}
                  </span>
                </span>
                <button
                  onClick={() => kpi.setHidden(d.id, true)}
                  disabled={kpi.busy}
                  title="Hide for this client" style={{ ...iconBtn, marginLeft: 'auto' }}
                >
                  <EyeOff size={14} style={{ color: '#94a3b8' }} />
                </button>
              </div>
            );
          })}
        </div>
        {/* Hidden KPIs are, by design, absent from the list above. Without this
            there would be no way to find one again. */}
        {kpi.hiddenOverrides.length > 0 && (
          <div style={{ marginTop: '12px', paddingTop: '10px', borderTop: '1px solid #f1f5f9' }}>
            <div style={{ fontFamily: OUTFIT, fontSize: '11.5px', color: '#94a3b8', marginBottom: '6px' }}>
              Hidden for this client
            </div>
            {kpi.hiddenOverrides.map((h) => (
              <div key={h.definition_id} style={rowStyle}>
                <span style={{ fontFamily: OUTFIT, fontSize: '13px', color: '#94a3b8' }}>{h.label}</span>
                <button
                  onClick={() => kpi.setHidden(h.definition_id, false)}
                  disabled={kpi.busy}
                  title="Show again" style={{ ...iconBtn, marginLeft: 'auto' }}
                >
                  <Eye size={14} style={{ color: '#0369a1' }} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ─── Bits ─────────────────────────────────────────────────────── */
function SectionHead({ title, hint }) {
  return (
    <div>
      <div style={{ fontFamily: OUTFIT, fontSize: '15px', fontWeight: 700, color: '#0f172a' }}>{title}</div>
      {hint && <div style={{ fontFamily: OUTFIT, fontSize: '11.5px', color: '#94a3b8', marginTop: '2px' }}>{hint}</div>}
    </div>
  );
}

const th = {
  fontFamily: OUTFIT, fontSize: '11px', color: '#94a3b8', fontWeight: 700,
  textAlign: 'right', padding: '7px 14px', whiteSpace: 'nowrap', borderBottom: '1px solid #e5e7eb',
};
const td = {
  fontFamily: OUTFIT, fontSize: '12.5px', textAlign: 'right', padding: '7px 14px',
  whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums', borderBottom: '1px solid #f8fafc',
};
const rowStyle = {
  display: 'flex', alignItems: 'center', gap: '10px',
  padding: '7px 0', borderBottom: '1px solid #f1f5f9',
};
const iconBtn = { border: 'none', background: 'none', cursor: 'pointer', padding: '2px', display: 'flex' };
const addBtn = {
  display: 'inline-flex', alignItems: 'center', gap: '5px', border: '1px solid #e5e7eb',
  borderRadius: '10px', padding: '8px 14px', background: '#fff', color: '#0369a1',
  fontFamily: OUTFIT, fontSize: '13px', fontWeight: 600, cursor: 'pointer',
};
const primaryBtn = {
  display: 'inline-flex', alignItems: 'center', gap: '7px', padding: '10px 20px',
  border: 'none', borderRadius: '10px', backgroundColor: '#0f172a', color: '#fff',
  fontFamily: OUTFIT, fontSize: '13.5px', fontWeight: 700, cursor: 'pointer',
};
