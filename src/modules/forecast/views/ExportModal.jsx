// Export pack modal — picks granularity, anchor year, pages/sheets,
// then generates PDF or Excel.

import React, { useEffect, useMemo, useState } from 'react';
import { btnDark, btnGhost, btnOutline, colors, fontStack, serifStack } from '../components/ui';
import { buildPdfPack, downloadPdfPack } from '../lib/export/exportPdf';
import { buildExcelPack, downloadExcelPack } from '../lib/export/exportXlsx';
import { scopedAggregate, aggregatedAsOutputRows } from '../lib/aggregator';
import { resolveFilterToEntityIds, filterLabel } from '../components/LocationFilter';
import { loadScenarioDrivers } from '../lib/queries';
import { AGE_BANDS_LIST } from '../lib/modules/locations';

const PDF_PAGES = [
  { key: 'cover',           label: 'Cover (title + notes)',           yearAware: false },
  { key: 'exec_summary',    label: 'Executive summary (story + charts)', yearAware: false },
  { key: 'assumptions',     label: 'Key assumptions (by phase)',      yearAware: false },
  { key: 'exec_dashboard',  label: 'Executive dashboard',             yearAware: true  },
  { key: 'road_to_market',  label: 'Road to market (12-mo cashflow)', yearAware: false },
  { key: 'pnl',             label: 'Profit & loss',                   yearAware: false },
  { key: 'bs',              label: 'Balance sheet',                   yearAware: false },
  { key: 'cf',              label: 'Cashflow',                        yearAware: false },
  { key: 'income',          label: 'Income analysis',                 yearAware: true  },
  { key: 'staff',           label: 'Staff detail',                    yearAware: false },
  { key: 'premises',        label: 'Premises & overheads',            yearAware: false },
  { key: 'capacities',      label: 'Capacities',                      yearAware: false },
];

const XL_SHEETS = [
  { key: 'pnl',      label: 'Profit & loss' },
  { key: 'bs',       label: 'Balance sheet' },
  { key: 'cf',       label: 'Cashflow' },
  { key: 'staff',    label: 'Staff detail' },
  { key: 'premises', label: 'Premises & overheads' },
];

export default function ExportModal({
  forecast, scenario, version, periods, outputs,
  entities = [], groups = [], assignments = [], filter,
  onClose,
}) {
  const horizonYears = Math.max(1, Math.ceil((forecast?.horizon_months || 60) / 12));

  const [granularity, setGranularity] = useState('annual');
  const [year, setYear] = useState(Math.min(3, horizonYears));
  const [selectedPages, setSelectedPages] = useState(PDF_PAGES.map(p => p.key));
  const [selectedSheets, setSelectedSheets] = useState(XL_SHEETS.map(s => s.key));
  const [notes, setNotes] = useState('');
  const [preparedFor, setPreparedFor] = useState(forecast?.group_client_name || forecast?.client_name || '');
  const [preparedBy, setPreparedBy] = useState('Almond Valley Accounting');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  // Pre-load services_childcare drivers for income page
  const [serviceDrivers, setServiceDrivers] = useState({ drivers: [], values: [] });
  useEffect(() => {
    let cancelled = false;
    if (!scenario?.id) return;
    (async () => {
      const r = await loadScenarioDrivers(scenario.id);
      if (cancelled) return;
      setServiceDrivers(r);
    })();
    return () => { cancelled = true; };
  }, [scenario?.id]);

  const entityIds = useMemo(() => resolveFilterToEntityIds(filter, entities, assignments),
    [filter, entities, assignments]);
  const scopeLabel = filterLabel(filter, entities, groups);

  // If user filters by location/group, exports use the scoped aggregator
  // so totals match the on-screen view (same logic as StatementView).
  const scopedOutputRows = useMemo(() => {
    if (!entityIds) return null;
    const map = scopedAggregate({
      outputs, periods, entityIds, entities,
      // 'derive' inherits the scenario's inflation + dividend policy and
      // starts cash from the capital attributed to the in-scope locations
      // (central/unallocated pot excluded — see aggregator.js).
      inflationPct: 'derive',
      openingCash: 'derive', openingEquity: 'derive', taxLagMonths: 9,
    });
    return aggregatedAsOutputRows(map);
  }, [entityIds, outputs, periods]);

  // Build incomeContext from drivers, weighted by capacity per band
  const incomeContext = useMemo(() => {
    if (!serviceDrivers.drivers.length) return null;
    const valByDriverId = new Map();
    for (const v of serviceDrivers.values) if (v.period === -1) valByDriverId.set(v.driver_id, v.value);

    const inScopeEntities = entityIds ? entities.filter(e => entityIds.has(e.id)) : entities;
    const resolveByBand = (tpl) => {
      const out = {};
      for (const band of AGE_BANDS_LIST) {
        const key = tpl.replace('{band}', band);
        const matching = serviceDrivers.drivers.filter(d => d.module_key === 'services_childcare' && d.driver_key === key);
        let weightSum = 0, weighted = 0, groupVal = null;
        for (const d of matching) {
          const v = valByDriverId.get(d.id);
          if (v == null) continue;
          if (!d.entity_id) { groupVal = Number(v); continue; }
          const e = entities.find(ee => ee.id === d.entity_id);
          if (!e || (entityIds && !entityIds.has(d.entity_id))) continue;
          const cap = e.config?.capacity_by_age_band?.[band] || 0;
          weightSum += cap; weighted += cap * Number(v);
        }
        out[band] = weightSum > 0 ? weighted / weightSum : groupVal;
      }
      return out;
    };

    const wpyDriver = serviceDrivers.drivers.find(d => d.driver_key === 'weeks_per_year' && d.module_key === 'services_childcare');
    // Per-band capacity ramp lives on the locations module (group scope)
    const resolveLocByBand = (tpl) => {
      const out = {};
      for (const band of AGE_BANDS_LIST) {
        const key = tpl.replace('{band}', band);
        const d = serviceDrivers.drivers.find(d => d.module_key === 'locations' && d.driver_key === key && !d.entity_id);
        out[band] = d ? Number(valByDriverId.get(d.id)) : null;
      }
      return out;
    };
    return {
      weeklyRate:   resolveByBand('weekly_rate_p.{band}'),
      laRate:       resolveByBand('la_funded_rate_p.{band}'),
      eligiblePct:  resolveByBand('eligible_for_funded_pct.{band}'),
      takeupPct:    resolveByBand('funded_hours_take_up_pct.{band}'),
      hoursPerWeek: resolveByBand('operating_hours_per_week.{band}'),
      openingPct:   resolveLocByBand('capacity.opening_pct.{band}'),
      targetPct:    resolveLocByBand('capacity.target_pct.{band}'),
      phaseMonths:  resolveLocByBand('capacity.phase_up_months.{band}'),
      weeksPerYear: wpyDriver ? Number(valByDriverId.get(wpyDriver.id) ?? 51) : 51,
    };
  }, [serviceDrivers, entities, entityIds]);

  const togglePage  = (k) => setSelectedPages(prev => prev.includes(k) ? prev.filter(x => x !== k) : [...prev, k]);
  const toggleSheet = (k) => setSelectedSheets(prev => prev.includes(k) ? prev.filter(x => x !== k) : [...prev, k]);

  // Headline KPIs for the cover (full forecast life, group view)
  const headlineKpis = useMemo(() => {
    const src = scopedOutputRows || outputs;
    const setP = new Set(periods);
    const sumLine = (nt) => {
      let s = 0; for (const r of src) { if (r.nominal_type === nt && setP.has(r.period)) s += r.amount_p; } return s;
    };
    const lastLine = (nt) => {
      let bestT = -1, bestV = null;
      for (const r of src) { if (r.nominal_type === nt && setP.has(r.period) && r.period > bestT) { bestT = r.period; bestV = r.amount_p; } }
      return bestV;
    };
    const yearStart = (year - 1) * 12;
    const yearPeriods = periods.filter(p => p >= yearStart && p < yearStart + 12);
    const setY = new Set(yearPeriods);
    const sumLineY = (nt) => {
      let s = 0; for (const r of src) { if (r.nominal_type === nt && setY.has(r.period)) s += r.amount_p; } return s;
    };

    const fmt = (p) => p == null ? '—' : '£' + (p / 100).toLocaleString('en-GB', { maximumFractionDigits: 0 });
    const fmtPct = (a, b) => (b > 0 ? `${((a / b) * 100).toFixed(1)}%` : '—');

    const revY = sumLineY('pnl.revenue_total');
    const ebitdaY = sumLineY('pnl.ebitda');
    const closingCash = lastLine('bs.closing_cash') ?? lastLine('bs.cash');

    return [
      { label: `Revenue Y${year}`,  value: fmt(revY) },
      { label: `EBITDA Y${year}`,    value: fmt(ebitdaY), hint: fmtPct(ebitdaY, revY) },
      { label: 'Closing cash',       value: fmt(closingCash) },
      { label: 'Horizon',             value: `${horizonYears} years` },
    ];
  }, [scopedOutputRows, outputs, periods, year, horizonYears]);

  const slug = (s) => (s || '').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase();
  const filenameBase = [
    slug(forecast?.client_name || forecast?.group_client_name || 'forecast'),
    slug(forecast?.name),
    slug(version?.name),
    slug(scenario?.name),
  ].filter(Boolean).join('-');

  const onExportPdf = async () => {
    setBusy(true); setError(null);
    try {
      const doc = buildPdfPack({
        forecast, scenario, version, periods, openingPeriod: forecast?.opening_period,
        outputs, scopedOutputs: scopedOutputRows,
        entities, entityIds,
        granularity, year, scopeLabel,
        selectedPages,
        headlineKpis,
        incomeContext,
        notes, preparedFor, preparedBy,
      });
      downloadPdfPack(doc, `${filenameBase}-Y${year}-${granularity}.pdf`);
    } catch (e) { setError(e.message || String(e)); }
    setBusy(false);
  };

  const onExportXlsx = async () => {
    setBusy(true); setError(null);
    try {
      const wb = buildExcelPack({
        forecast, scenario, periods, openingPeriod: forecast?.opening_period,
        outputs, scopedOutputs: scopedOutputRows,
        entities, entityIds,
        granularity,
        selectedSheets,
      });
      downloadExcelPack(wb, `${filenameBase}-${granularity}.xlsx`);
    } catch (e) { setError(e.message || String(e)); }
    setBusy(false);
  };

  return (
    <div onClick={onClose} style={backdrop}>
      <div onClick={(e) => e.stopPropagation()} style={card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14 }}>
          <div>
            <div style={{ fontSize: 11, color: colors.muted, textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 600 }}>
              Export pack
            </div>
            <h2 style={{ fontFamily: serifStack, fontSize: 22, fontWeight: 500, color: colors.ink, margin: '4px 0 0' }}>
              {forecast?.name} <span style={{ color: colors.muted, fontSize: 14 }}>· {scenario?.name}</span>
            </h2>
            <p style={{ margin: '4px 0 0', fontSize: 12, color: colors.muted }}>
              Scope: {scopeLabel}
            </p>
          </div>
          <button onClick={onClose} style={closeBtn}>×</button>
        </div>

        {/* Granularity */}
        <Group label="Granularity">
          <div style={{ display: 'flex', gap: 6 }}>
            {['monthly', 'quarterly', 'annual'].map(g => (
              <button key={g} onClick={() => setGranularity(g)} style={{
                ...btnOutline, padding: '7px 14px', fontSize: 12, textTransform: 'capitalize',
                background: granularity === g ? colors.ink : '#fff',
                color: granularity === g ? '#fff' : colors.ink,
                borderColor: granularity === g ? colors.ink : colors.border,
              }}>{g}</button>
            ))}
          </div>
        </Group>

        {/* Year anchor */}
        <Group label={`Anchor year (used by year-dependent pages)`} hint={`Default Y3`}>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {Array.from({ length: horizonYears }, (_, i) => i + 1).map(y => (
              <button key={y} onClick={() => setYear(y)} style={{
                ...btnOutline, padding: '7px 12px', fontSize: 12,
                background: year === y ? colors.accent : '#fff',
                color: year === y ? '#fff' : colors.ink,
                borderColor: year === y ? colors.accent : colors.border,
              }}>Y{y}</button>
            ))}
          </div>
        </Group>

        {/* Cover-page options (PDF only) */}
        <Group label="Cover page (PDF)" hint="Notes appear under the headline KPIs on the cover">
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
            <label style={{ fontSize: 11, color: colors.muted }}>
              Prepared for
              <input
                value={preparedFor}
                onChange={(e) => setPreparedFor(e.target.value)}
                placeholder="e.g. Marc Kelly"
                style={{ display: 'block', marginTop: 4, width: '100%', padding: '6px 8px', fontSize: 12, border: `1px solid ${colors.border}`, borderRadius: 6, fontFamily: fontStack, boxSizing: 'border-box' }}
              />
            </label>
            <label style={{ fontSize: 11, color: colors.muted }}>
              Prepared by
              <input
                value={preparedBy}
                onChange={(e) => setPreparedBy(e.target.value)}
                placeholder="e.g. Almond Valley Accounting"
                style={{ display: 'block', marginTop: 4, width: '100%', padding: '6px 8px', fontSize: 12, border: `1px solid ${colors.border}`, borderRadius: 6, fontFamily: fontStack, boxSizing: 'border-box' }}
              />
            </label>
          </div>
          <label style={{ fontSize: 11, color: colors.muted }}>
            Notes
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Optional commentary that will appear on the cover page (basis of preparation, key assumptions, what's changed since the last pack, etc.)"
              rows={5}
              style={{
                display: 'block', marginTop: 4, width: '100%',
                padding: '8px 10px', fontSize: 12,
                border: `1px solid ${colors.border}`, borderRadius: 6,
                fontFamily: fontStack, boxSizing: 'border-box',
                resize: 'vertical', minHeight: 80,
              }}
            />
          </label>
          <div style={{ marginTop: 4, fontSize: 10, color: colors.muted, textAlign: 'right' }}>
            {notes.length}/2000 characters
          </div>
        </Group>

        {/* Two columns: PDF pages + Excel sheets */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginTop: 8 }}>
          <Panel title="PDF pack — pages">
            {PDF_PAGES.map(p => (
              <Check key={p.key} checked={selectedPages.includes(p.key)} onChange={() => togglePage(p.key)} label={p.label} hint={p.yearAware ? `Anchored to Y${year}` : null} />
            ))}
            <button onClick={onExportPdf} disabled={busy || selectedPages.length === 0} style={{ ...btnDark, width: '100%', justifyContent: 'center', marginTop: 10 }}>
              {busy ? 'Generating…' : `Download PDF (${selectedPages.length} page${selectedPages.length !== 1 ? 's' : ''})`}
            </button>
          </Panel>

          <Panel title="Excel pack — sheets">
            {XL_SHEETS.map(s => (
              <Check key={s.key} checked={selectedSheets.includes(s.key)} onChange={() => toggleSheet(s.key)} label={s.label} />
            ))}
            <button onClick={onExportXlsx} disabled={busy || selectedSheets.length === 0} style={{ ...btnOutline, width: '100%', justifyContent: 'center', marginTop: 10 }}>
              {busy ? 'Generating…' : `Download Excel (${selectedSheets.length} sheet${selectedSheets.length !== 1 ? 's' : ''})`}
            </button>
          </Panel>
        </div>

        {error && (
          <div style={{ marginTop: 12, padding: 10, background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, color: '#991b1b', fontSize: 12 }}>
            {error}
          </div>
        )}

        <p style={{ fontSize: 11, color: colors.muted, marginTop: 14 }}>
          Numbers tie to the on-screen P&amp;L / BS / CF including any active location filter.
          PDF is A4 landscape with one page per section. Excel uses one sheet per statement with frozen headers.
        </p>
      </div>
    </div>
  );
}

function Group({ label, hint, children }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4, color: colors.muted, marginBottom: 6 }}>
        {label} {hint && <span style={{ fontWeight: 400, marginLeft: 6, textTransform: 'none', letterSpacing: 0 }}>· {hint}</span>}
      </div>
      {children}
    </div>
  );
}

function Panel({ title, children }) {
  return (
    <div style={{ border: `1px solid ${colors.border}`, borderRadius: 10, padding: 14, background: colors.bgSoft }}>
      <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4, color: colors.muted, marginBottom: 8 }}>
        {title}
      </div>
      {children}
    </div>
  );
}

function Check({ checked, onChange, label, hint }) {
  return (
    <label style={{
      display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px',
      borderRadius: 6, background: checked ? '#fff' : 'transparent',
      cursor: 'pointer', fontSize: 12, color: colors.ink, border: `1px solid ${checked ? colors.border : 'transparent'}`,
    }}>
      <input type="checkbox" checked={checked} onChange={onChange} />
      <span>{label}</span>
      {hint && <span style={{ marginLeft: 'auto', fontSize: 10, color: colors.muted }}>{hint}</span>}
    </label>
  );
}

const backdrop = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, fontFamily: fontStack };
const card = { background: '#fff', borderRadius: 16, padding: 24, maxWidth: 720, width: '100%', maxHeight: '90vh', overflowY: 'auto' };
const closeBtn = { background: 'transparent', border: 'none', fontSize: 28, color: colors.muted, cursor: 'pointer', padding: 0, lineHeight: 1, fontFamily: fontStack };
