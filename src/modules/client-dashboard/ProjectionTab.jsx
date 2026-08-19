import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  Loader, Plus, Link2, X, ExternalLink, TrendingUp, AlertTriangle, Check,
} from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../shell/AppShell';
import { money, moneyCompact, shortDate, OUTFIT, cardStyle, inputStyle } from './dashboardData';
import { GRAINS, BASES, bucketsBetween, addMonths, monthKeyOfDate } from './overviewGrain';
import { BucketChart, LineChart } from './DashboardCharts';
import { Segmented, LoadingCard } from './DashboardUI';
import { PICKABLE, catLabel } from './projectionMapping';
import {
  forecastByMonth, actualsByMonth, buildStatement, buildCashflow,
  totalRow, netRow, PL_ORDER, BS_ORDER,
} from './projectionEngine';

/*
  Projection tab.

  A projection is one Client Forecast scenario bolted onto the client's own
  QuickBooks history. Actual months up to a chosen cut-off, forecast months
  after it, on one continuous timeline and one set of statement rows — so the
  question "are we on track" can be answered by reading across a line rather
  than by holding two reports side by side.

  The tab starts empty on purpose. Nothing is projected until someone links a
  scenario, because a forecast the client can see is a commitment and it should
  be a deliberate act.

  Three sub-tabs — P&L, Balance Sheet, Cashflow — plus a Mapping sub-tab that
  shows every source line, where it currently lands, and why. The mapping is
  the part that quietly goes wrong, so it is a first-class screen rather than a
  hidden config file: an unrecognised line falls into an "Unmapped …" row that
  is visible in the statement itself, not dropped.

  Grain and basis are shared with the Overview tab — someone who reads that tab
  in fiscal quarters wants this one in fiscal quarters too.
*/

// How much history and how much future to show at each grain.
const SPAN = {
  month: { back: 12, forward: 18 },
  quarter: { back: 24, forward: 36 },
  year: { back: 36, forward: 60 },
};

const SUBS = [
  { key: 'pl', label: 'P&L' },
  { key: 'bs', label: 'Balance Sheet' },
  { key: 'cf', label: 'Cashflow' },
  { key: 'map', label: 'Mapping' },
];

const monthEnd = (key) => {
  const [y, m] = key.split('-').map(Number);
  return `${key}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`;
};

export default function ProjectionTab({
  realmId, entityId, clientName, currency, fyIdx,
  grain, setGrain, basis, setBasis, config,
}) {
  const { profile } = useAuth();
  const [link, setLink] = useState(null);
  const [linkLoading, setLinkLoading] = useState(true);
  const [scenarioMeta, setScenarioMeta] = useState(null);
  const [fcRows, setFcRows] = useState([]);
  const [fcLoading, setFcLoading] = useState(false);
  const [actuals, setActuals] = useState(null);
  const [actualsLoading, setActualsLoading] = useState(false);
  const [overrideRows, setOverrideRows] = useState([]);
  const [sub, setSub] = useState('pl');
  const [picker, setPicker] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  /* ── Link ── */
  const loadLink = useCallback(async () => {
    if (!realmId) { setLink(null); setLinkLoading(false); return; }
    setLinkLoading(true);
    try {
      const { data } = await supabase.from('dashboard_projections')
        .select('*').eq('realm_id', realmId).maybeSingle();
      setLink(data || null);
    } catch { setLink(null); }
    setLinkLoading(false);
  }, [realmId]);

  const loadOverrides = useCallback(async () => {
    if (!realmId) return;
    try {
      const { data } = await supabase.from('dashboard_projection_map')
        .select('*').eq('realm_id', realmId);
      setOverrideRows(data || []);
    } catch { setOverrideRows([]); }
  }, [realmId]);

  useEffect(() => {
    setLink(null); setScenarioMeta(null); setFcRows([]); setActuals(null); setSub('pl');
  }, [realmId]);
  useEffect(() => { loadLink(); }, [loadLink]);
  useEffect(() => { loadOverrides(); }, [loadOverrides]);

  const overrides = useMemo(() => {
    const o = { forecast: {}, actual: {} };
    for (const r of overrideRows) o[r.source][String(r.source_key)] = r.category;
    return o;
  }, [overrideRows]);

  /* ── Scenario output ── */
  useEffect(() => {
    if (!link?.scenario_id) { setScenarioMeta(null); setFcRows([]); return; }
    let cancelled = false;
    (async () => {
      setFcLoading(true);
      setError(null);
      try {
        const { data: sc } = await supabase.from('fc_scenario')
          .select('id, name, kind, version_id, fc_version(id, name, forecast_id, fc_forecast(id, name, opening_period, horizon_months, vertical_pack, currency))')
          .eq('id', link.scenario_id).maybeSingle();
        const forecast = sc?.fc_version?.fc_forecast || null;
        if (!cancelled) setScenarioMeta(forecast ? { scenario: sc, forecast } : null);

        // Output can be several thousand rows; PostgREST silently caps a plain
        // select at ~1000, so page through it explicitly rather than quietly
        // projecting a third of the scenario.
        const all = [];
        const PAGE = 1000;
        for (let from = 0; ; from += PAGE) {
          const { data, error: qErr } = await supabase.from('fc_output')
            .select('period, nominal_type, amount_p')
            .eq('scenario_id', link.scenario_id)
            .order('period')
            .range(from, from + PAGE - 1);
          if (qErr) throw qErr;
          all.push(...(data || []));
          if (!data || data.length < PAGE) break;
          if (from > 60000) break; // hard stop; no scenario is this big
        }
        if (!cancelled) setFcRows(all);
      } catch (e) {
        if (!cancelled) setError(e.message || 'Could not load the scenario output.');
      }
      if (!cancelled) setFcLoading(false);
    })();
    return () => { cancelled = true; };
  }, [link?.scenario_id]);

  /* ── Timeline ── */
  const openingKey = (scenarioMeta?.forecast?.opening_period || '').slice(0, 7);
  const horizon = Number(scenarioMeta?.forecast?.horizon_months || 0);
  const forecastEndKey = openingKey && horizon ? addMonths(openingKey, horizon - 1) : null;

  // Default cut-off: the last full month before today, but never past the point
  // where the forecast begins covering — a projection whose actuals overrun its
  // forecast has nothing left to project.
  const defaultCutoff = useMemo(() => {
    const lastFull = addMonths(monthKeyOfDate(new Date()), -1);
    if (forecastEndKey && lastFull > forecastEndKey) return forecastEndKey;
    return lastFull;
  }, [forecastEndKey]);

  const cutoff = (link?.actuals_through || '').slice(0, 7) || defaultCutoff;
  const span = SPAN[grain] || SPAN.month;

  const timeline = useMemo(() => {
    if (!cutoff) return { buckets: [], startKey: null, endKey: null };
    const startKey = addMonths(cutoff, -(span.back - 1));
    let endKey = addMonths(cutoff, span.forward);
    if (forecastEndKey && endKey > forecastEndKey) endKey = forecastEndKey;
    if (endKey < cutoff) endKey = cutoff;
    return { buckets: bucketsBetween({ grain, basis, startKey, endKey, fyIdx }), startKey, endKey };
  }, [cutoff, span.back, span.forward, forecastEndKey, grain, basis, fyIdx]);

  /* ── Actuals ── */
  const actualsStart = timeline.startKey ? `${timeline.startKey}-01` : null;
  const actualsEnd = cutoff ? monthEnd(cutoff) : null;

  useEffect(() => {
    if (!realmId || !actualsStart || !actualsEnd || !link) return;
    let cancelled = false;
    (async () => {
      setActualsLoading(true);
      try {
        const { data: payload } = await supabase.functions.invoke('dashboard-qbo-pull', {
          body: {
            realmId,
            window: { kind: 'preset', projection: { start: actualsStart, end: actualsEnd } },
          },
        });
        if (!cancelled) {
          setActuals({
            pl: payload?.metrics?.proj_pl || null,
            bs: payload?.metrics?.proj_bs || null,
            cf: payload?.metrics?.proj_cf || null,
            errors: payload?.errors || null,
          });
        }
      } catch { if (!cancelled) setActuals(null); }
      if (!cancelled) setActualsLoading(false);
    })();
    return () => { cancelled = true; };
  }, [realmId, actualsStart, actualsEnd, link?.id]);

  /* ── Compose ── */
  const fc = useMemo(
    () => forecastByMonth(fcRows, scenarioMeta?.forecast?.opening_period, overrides),
    [fcRows, scenarioMeta?.forecast?.opening_period, overrides],
  );
  const act = useMemo(
    () => actualsByMonth(actuals || {}, config?.accountsById || {}, overrides),
    [actuals, config?.accountsById, overrides],
  );

  const pl = useMemo(() => buildStatement({
    buckets: timeline.buckets, actual: act.categories, forecast: fc.categories, cutoff, order: PL_ORDER,
  }), [timeline.buckets, act.categories, fc.categories, cutoff]);

  const bs = useMemo(() => buildStatement({
    buckets: timeline.buckets, actual: act.categories, forecast: fc.categories, cutoff, order: BS_ORDER,
  }), [timeline.buckets, act.categories, fc.categories, cutoff]);

  const cfRows = useMemo(() => buildCashflow({
    buckets: timeline.buckets, actualCf: act.cf, forecastCf: fc.cf, cutoff,
  }), [timeline.buckets, act.cf, fc.cf, cutoff]);

  const forecastFrom = pl.status.findIndex((s) => s !== 'actual');

  /* ── Mutations ── */
  const saveLink = async (patch) => {
    if (!realmId) return;
    setBusy(true);
    try {
      const row = {
        realm_id: realmId, entity_id: entityId || null,
        created_by: profile?.id || null,
        updated_at: new Date().toISOString(),
        ...patch,
      };
      const { error: e } = await supabase.from('dashboard_projections')
        .upsert(row, { onConflict: 'realm_id' });
      if (e) throw e;
      await loadLink();
      setPicker(false);
    } catch (e) { setError(e.message); }
    setBusy(false);
  };

  const unlink = async () => {
    if (!realmId) return;
    setBusy(true);
    try {
      await supabase.from('dashboard_projections').delete().eq('realm_id', realmId);
      setLink(null); setFcRows([]); setScenarioMeta(null);
    } catch (e) { setError(e.message); }
    setBusy(false);
  };

  const setMapping = async (source, key, category) => {
    setBusy(true);
    try {
      await supabase.from('dashboard_projection_map').upsert({
        realm_id: realmId, source, source_key: String(key), category,
        created_by: profile?.id || null,
      }, { onConflict: 'realm_id,source,source_key' });
      await loadOverrides();
    } catch (e) { setError(e.message); }
    setBusy(false);
  };

  const clearMapping = async (source, key) => {
    setBusy(true);
    try {
      await supabase.from('dashboard_projection_map').delete()
        .eq('realm_id', realmId).eq('source', source).eq('source_key', String(key));
      await loadOverrides();
    } catch (e) { setError(e.message); }
    setBusy(false);
  };

  /* ── Render ── */
  if (linkLoading) return <LoadingCard label="the projection" />;

  if (!link) {
    return (
      <>
        <CreateCard clientName={clientName} onStart={() => setPicker(true)} />
        {picker && (
          <ScenarioPicker
            entityId={entityId} clientName={clientName} busy={busy}
            onClose={() => setPicker(false)}
            onPick={(s) => saveLink({
              scenario_id: s.scenario_id, version_id: s.version_id,
              forecast_id: s.forecast_id, actuals_through: monthEnd(defaultCutoff),
            })}
          />
        )}
      </>
    );
  }

  const loading = fcLoading || actualsLoading;
  const noOutput = !fcLoading && fcRows.length === 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      {/* ── Header strip ── */}
      <div style={{
        display: 'flex', gap: '14px', alignItems: 'center', flexWrap: 'wrap',
        padding: '12px 16px', backgroundColor: '#f8fafc', border: '1px solid #e5e7eb', borderRadius: '12px',
      }}>
        <TrendingUp size={17} style={{ color: '#38bdf8', flexShrink: 0 }} />
        <div style={{ minWidth: 0 }}>
          <div style={{ fontFamily: OUTFIT, fontSize: '13.5px', fontWeight: 700, color: '#0f172a' }}>
            {scenarioMeta?.forecast?.name || 'Linked scenario'}
            {scenarioMeta?.scenario?.name && scenarioMeta.scenario.name !== 'Base' && ` · ${scenarioMeta.scenario.name}`}
          </div>
          <div style={{ fontFamily: OUTFIT, fontSize: '11.5px', color: '#94a3b8' }}>
            {scenarioMeta?.forecast
              ? `${scenarioMeta.forecast.vertical_pack} · opens ${shortDate(scenarioMeta.forecast.opening_period)} · ${scenarioMeta.forecast.horizon_months} months`
              : 'Loading scenario…'}
            {loading && ' · pulling…'}
          </div>
        </div>

        <label style={{ fontFamily: OUTFIT, fontSize: '11px', color: '#94a3b8', display: 'flex', flexDirection: 'column', gap: '3px', marginLeft: 'auto' }}>
          Actuals to the end of
          <input
            type="month"
            value={cutoff}
            max={forecastEndKey || undefined}
            onChange={(e) => e.target.value && saveLink({ actuals_through: monthEnd(e.target.value) })}
            style={{ ...inputStyle, padding: '6px 9px', fontSize: '12.5px' }}
          />
        </label>

        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          {scenarioMeta?.forecast?.id && (
            <a
              href={`/forecast?forecast=${scenarioMeta.forecast.id}`}
              style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', fontFamily: OUTFIT, fontSize: '12px', fontWeight: 600, color: '#0369a1', textDecoration: 'none' }}
            >
              <ExternalLink size={13} /> Open in Client Forecast
            </a>
          )}
          <button onClick={() => setPicker(true)} disabled={busy} style={linkBtn}>Change</button>
          <button onClick={unlink} disabled={busy} style={{ ...linkBtn, color: '#b91c1c' }}>Unlink</button>
        </div>
      </div>

      {error && (
        <div style={{ fontFamily: OUTFIT, fontSize: '12.5px', color: '#b91c1c', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: '10px', padding: '10px 14px' }}>
          {error}
        </div>
      )}

      {noOutput && (
        <div style={{
          display: 'flex', gap: '9px', alignItems: 'flex-start', padding: '12px 16px',
          background: '#fffbeb', border: '1px solid #fde68a', borderRadius: '12px',
        }}>
          <AlertTriangle size={16} style={{ color: '#b45309', flexShrink: 0, marginTop: '1px' }} />
          <span style={{ fontFamily: OUTFIT, fontSize: '12.5px', color: '#92400e' }}>
            This scenario has no calculated output yet. Open it in Client Forecast and run a recompute,
            then come back — the forecast columns will fill in.
          </span>
        </div>
      )}

      {/* ── Grain / basis + sub-tabs ── */}
      <div style={{ display: 'flex', gap: '14px', alignItems: 'center', flexWrap: 'wrap' }}>
        <Segmented options={SUBS} value={sub} onChange={setSub} />
        <div style={{ marginLeft: 'auto', display: 'flex', gap: '14px', alignItems: 'center', flexWrap: 'wrap' }}>
          <Segmented label="By" value={grain} onChange={setGrain} options={GRAINS} size="sm" />
          <Segmented label="Year" value={basis} onChange={setBasis} options={BASES} size="sm" />
        </div>
      </div>

      {loading && !timeline.buckets.length && <LoadingCard label="the projection" />}

      {sub === 'pl' && (
        <>
          <div style={cardStyle}>
            <ChartHead
              title={`Revenue & net profit — actual to ${cutoff}, forecast after`}
              cutoff={cutoff}
            />
            <BucketChart
              points={timeline.buckets.map((b, i) => {
                const inc = totalRow(pl.rows, 'i', (r) => r.kind === 'income')?.values[i] ?? null;
                const net = netRow(pl.rows).values[i] ?? null;
                return { label: b.label, income: inc, net };
              })}
              currency={currency}
              forecastFrom={forecastFrom < 0 ? null : forecastFrom}
            />
          </div>
          <StatementTable
            title="Profit & loss"
            buckets={timeline.buckets} status={pl.status} currency={currency}
            groups={[
              { label: 'Income', rows: pl.rows.filter((r) => r.kind === 'income'), total: 'Total income' },
              { label: 'Costs', rows: pl.rows.filter((r) => r.kind === 'cost'), total: 'Total costs' },
            ]}
            grandRow={netRow(pl.rows)}
          />
        </>
      )}

      {sub === 'bs' && (
        <StatementTable
          title="Balance sheet"
          buckets={timeline.buckets} status={bs.status} currency={currency}
          note="Balance-sheet figures are the position at each period end, not a total of the months inside it."
          groups={[
            { label: 'Assets', rows: bs.rows.filter((r) => r.kind === 'asset'), total: 'Total assets' },
            { label: 'Liabilities', rows: bs.rows.filter((r) => r.kind === 'liability'), total: 'Total liabilities' },
            { label: 'Capital & reserves', rows: bs.rows.filter((r) => r.kind === 'capital'), total: null },
          ]}
          grandRow={(() => {
            const a = totalRow(bs.rows, 'a', (r) => r.kind === 'asset');
            const l = totalRow(bs.rows, 'l', (r) => r.kind === 'liability');
            if (!a && !l) return null;
            const n = Math.max(a?.values.length || 0, l?.values.length || 0);
            const values = [];
            for (let i = 0; i < n; i++) {
              const x = a?.values[i]; const y = l?.values[i];
              values.push(x == null && y == null ? null : (x || 0) - (y || 0));
            }
            return { label: 'Net assets', kind: 'total', values };
          })()}
        />
      )}

      {sub === 'cf' && (
        <>
          <div style={cardStyle}>
            <ChartHead title="Closing cash" cutoff={cutoff} />
            <LineChart
              points={timeline.buckets.map((b, i) => ({
                label: b.label,
                value: cfRows.find((r) => r.category === 'closing')?.values[i] ?? null,
              }))}
              currency={currency}
              forecastFrom={forecastFrom < 0 ? null : forecastFrom}
            />
          </div>
          <StatementTable
            title="Cashflow"
            buckets={timeline.buckets} status={pl.status} currency={currency}
            note="Opening and closing cash are balances at the edges of each period; the lines between them are movements within it."
            groups={[{ label: null, rows: cfRows, total: null }]}
          />
        </>
      )}

      {sub === 'map' && (
        <MappingPanel
          forecastLines={fc.lines}
          actualLines={act.lines}
          currency={currency}
          busy={busy}
          onSet={setMapping}
          onClear={clearMapping}
        />
      )}

      {picker && (
        <ScenarioPicker
          entityId={entityId} clientName={clientName} busy={busy}
          currentScenarioId={link.scenario_id}
          onClose={() => setPicker(false)}
          onPick={(s) => saveLink({
            scenario_id: s.scenario_id, version_id: s.version_id,
            forecast_id: s.forecast_id,
            actuals_through: link.actuals_through || monthEnd(defaultCutoff),
          })}
        />
      )}
    </div>
  );
}

/* ─── Empty state ──────────────────────────────────────────────── */
function CreateCard({ clientName, onStart }) {
  return (
    <div style={{ ...cardStyle, textAlign: 'center', padding: '56px 24px' }}>
      <TrendingUp size={30} style={{ color: '#7dd3fc', marginBottom: '12px' }} />
      <div style={{ fontFamily: OUTFIT, fontSize: '18px', fontWeight: 700, color: '#0f172a', marginBottom: '8px' }}>
        No projection for {clientName || 'this client'} yet
      </div>
      <p style={{ fontFamily: OUTFIT, fontSize: '13.5px', color: '#64748b', maxWidth: '520px', margin: '0 auto 20px', lineHeight: 1.6 }}>
        A projection puts this client's QuickBooks actuals and a Client Forecast scenario on one
        timeline — actuals up to a month you choose, forecast from there. Link an existing scenario,
        or start a new one in the Client Forecast module and link it back here.
      </p>
      <button
        onClick={onStart}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: '8px', padding: '12px 24px',
          border: 'none', borderRadius: '11px', backgroundColor: '#0f172a', color: '#ffffff',
          cursor: 'pointer', fontFamily: OUTFIT, fontSize: '14px', fontWeight: 700,
        }}
      >
        <Plus size={16} /> Create projection
      </button>
    </div>
  );
}

/* ─── Scenario picker ──────────────────────────────────────────── */
function ScenarioPicker({ entityId, clientName, currentScenarioId, onClose, onPick, busy }) {
  const [rows, setRows] = useState(null);
  const [all, setAll] = useState(false);
  const [err, setErr] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const { data, error } = await supabase.rpc('dashboard_scenarios_for_entity', {
          p_entity_id: all ? null : (entityId || null),
        });
        if (error) throw error;
        setRows(data || []);
      } catch (e) { setErr(e.message); setRows([]); }
    })();
  }, [entityId, all]);

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, backgroundColor: 'rgba(15,23,42,0.45)', zIndex: 60,
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          backgroundColor: '#ffffff', borderRadius: '16px', width: '100%', maxWidth: '720px',
          maxHeight: '80vh', display: 'flex', flexDirection: 'column', overflow: 'hidden',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '18px 22px', borderBottom: '1px solid #e5e7eb' }}>
          <Link2 size={17} style={{ color: '#38bdf8' }} />
          <span style={{ fontFamily: OUTFIT, fontSize: '15.5px', fontWeight: 700, color: '#0f172a' }}>
            Link a forecast scenario
          </span>
          <button onClick={onClose} style={{ marginLeft: 'auto', border: 'none', background: 'none', cursor: 'pointer', padding: 0 }}>
            <X size={18} style={{ color: '#94a3b8' }} />
          </button>
        </div>

        <div style={{ padding: '14px 22px', overflowY: 'auto', flex: 1 }}>
          {err && <div style={{ fontFamily: OUTFIT, fontSize: '13px', color: '#b91c1c', marginBottom: '10px' }}>{err}</div>}
          {rows === null && <div style={{ fontFamily: OUTFIT, fontSize: '13px', color: '#94a3b8' }}>Loading scenarios…</div>}

          {rows?.length === 0 && (
            <div style={{ fontFamily: OUTFIT, fontSize: '13.5px', color: '#64748b', lineHeight: 1.6 }}>
              {all
                ? 'No forecast scenarios exist yet.'
                : `No forecasts are linked to ${clientName || 'this client'} yet.`}
              {' '}Build one in the Client Forecast module, then come back and link it.
              <div style={{ marginTop: '14px', display: 'flex', gap: '10px' }}>
                <a href="/forecast" style={{
                  display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '9px 16px',
                  border: 'none', borderRadius: '10px', backgroundColor: '#0f172a', color: '#fff',
                  fontFamily: OUTFIT, fontSize: '13px', fontWeight: 700, textDecoration: 'none',
                }}>
                  <ExternalLink size={14} /> Open Client Forecast
                </a>
                {!all && (
                  <button onClick={() => { setRows(null); setAll(true); }} style={linkBtn}>
                    Show every client's forecasts
                  </button>
                )}
              </div>
            </div>
          )}

          {rows?.map((r) => {
            const isCurrent = r.scenario_id === currentScenarioId;
            const empty = Number(r.output_rows || 0) === 0;
            return (
              <button
                key={r.scenario_id}
                disabled={busy}
                onClick={() => onPick(r)}
                style={{
                  display: 'block', width: '100%', textAlign: 'left', marginBottom: '8px',
                  padding: '12px 14px', borderRadius: '11px', cursor: busy ? 'wait' : 'pointer',
                  border: `1px solid ${isCurrent ? '#7dd3fc' : '#e5e7eb'}`,
                  backgroundColor: isCurrent ? '#f0f9ff' : '#ffffff',
                }}
              >
                <div style={{ fontFamily: OUTFIT, fontSize: '13.5px', fontWeight: 700, color: '#0f172a', display: 'flex', alignItems: 'center', gap: '7px' }}>
                  {r.forecast_name}
                  {isCurrent && <Check size={14} style={{ color: '#0284c7' }} />}
                </div>
                <div style={{ fontFamily: OUTFIT, fontSize: '11.5px', color: '#64748b', marginTop: '3px' }}>
                  {r.version_name} · {r.scenario_name} · {r.vertical_pack} · opens {shortDate(r.opening_period)} · {r.horizon_months}m
                  {empty
                    ? <span style={{ color: '#b45309', fontWeight: 600 }}> · no output yet</span>
                    : ` · ${Number(r.output_rows).toLocaleString('en-GB')} output rows`}
                </div>
              </button>
            );
          })}

          {rows?.length > 0 && !all && (
            <button onClick={() => { setRows(null); setAll(true); }} style={{ ...linkBtn, marginTop: '6px' }}>
              Show every client's forecasts
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/* ─── Statement table ──────────────────────────────────────────── */
function ChartHead({ title, cutoff }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: '10px', marginBottom: '10px', flexWrap: 'wrap' }}>
      <span style={{ fontFamily: OUTFIT, fontSize: '15px', fontWeight: 700, color: '#0f172a' }}>{title}</span>
      <span style={{ fontFamily: OUTFIT, fontSize: '11.5px', color: '#94a3b8', marginLeft: 'auto' }}>
        actuals to {cutoff}
      </span>
    </div>
  );
}

const STATUS_BG = { actual: 'transparent', mixed: '#fffdf5', forecast: '#f8fbff' };

function StatementTable({ title, buckets, status = [], groups = [], grandRow, currency, note }) {
  if (!buckets.length) return null;
  return (
    <div style={{ ...cardStyle, padding: '16px 0 6px' }}>
      <div style={{ padding: '0 20px 12px', display: 'flex', alignItems: 'baseline', gap: '10px', flexWrap: 'wrap' }}>
        <span style={{ fontFamily: OUTFIT, fontSize: '15px', fontWeight: 700, color: '#0f172a' }}>{title}</span>
        <span style={{ fontFamily: OUTFIT, fontSize: '11px', color: '#94a3b8', marginLeft: 'auto', display: 'flex', gap: '12px', alignItems: 'center' }}>
          <span><span style={{ display: 'inline-block', width: '9px', height: '9px', border: '1px solid #cbd5e1', backgroundColor: '#ffffff', marginRight: '4px', verticalAlign: '-1px' }} /> actual</span>
          <span><span style={{ display: 'inline-block', width: '9px', height: '9px', border: '1px solid #bae6fd', backgroundColor: STATUS_BG.forecast, marginRight: '4px', verticalAlign: '-1px' }} /> forecast</span>
        </span>
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: `${240 + buckets.length * 96}px` }}>
          <thead>
            <tr>
              <th style={{ ...th, textAlign: 'left', position: 'sticky', left: 0, backgroundColor: '#ffffff', zIndex: 1, minWidth: '210px' }} />
              {buckets.map((b, i) => (
                <th key={b.key} style={{ ...th, backgroundColor: STATUS_BG[status[i]] || 'transparent' }}>
                  {b.label}
                  {b.partial && <span title="Part period" style={{ color: '#cbd5e1' }}> *</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {groups.map((g, gi) => (
              <React.Fragment key={gi}>
                {g.label && (
                  <tr>
                    <td colSpan={buckets.length + 1} style={{
                      fontFamily: OUTFIT, fontSize: '11px', fontWeight: 700, letterSpacing: '0.04em',
                      textTransform: 'uppercase', color: '#94a3b8', padding: '14px 20px 5px',
                    }}>
                      {g.label}
                    </td>
                  </tr>
                )}
                {g.rows.map((r) => (
                  <tr key={r.category || r.label}>
                    <td style={{
                      ...td, textAlign: 'left', position: 'sticky', left: 0, backgroundColor: '#ffffff',
                      color: r.catchAll ? '#b45309' : '#334155',
                      fontWeight: r.kind === 'balance' ? 700 : 500,
                    }}>
                      {r.label}
                    </td>
                    {r.values.map((v, i) => (
                      <td key={i} style={{ ...td, backgroundColor: STATUS_BG[status[i]] || 'transparent' }}>
                        {v == null ? '—' : money(v, currency)}
                      </td>
                    ))}
                  </tr>
                ))}
                {g.total && g.rows.length > 0 && (() => {
                  const t = totalRow(g.rows, g.total);
                  if (!t) return null;
                  return (
                    <tr>
                      <td style={{ ...td, ...totalCell, textAlign: 'left', position: 'sticky', left: 0, backgroundColor: '#ffffff' }}>{g.total}</td>
                      {t.values.map((v, i) => (
                        <td key={i} style={{ ...td, ...totalCell, backgroundColor: STATUS_BG[status[i]] || 'transparent' }}>
                          {v == null ? '—' : money(v, currency)}
                        </td>
                      ))}
                    </tr>
                  );
                })()}
              </React.Fragment>
            ))}

            {grandRow && (
              <tr>
                <td style={{ ...td, ...grandCell, textAlign: 'left', position: 'sticky', left: 0, backgroundColor: '#f8fafc' }}>{grandRow.label}</td>
                {grandRow.values.map((v, i) => (
                  <td key={i} style={{ ...td, ...grandCell, color: (v ?? 0) < 0 ? '#991b1b' : '#0f172a' }}>
                    {v == null ? '—' : money(v, currency)}
                  </td>
                ))}
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {note && (
        <p style={{ fontFamily: OUTFIT, fontSize: '11px', color: '#94a3b8', padding: '10px 20px 6px', margin: 0 }}>
          {note}
        </p>
      )}
    </div>
  );
}

/* ─── Mapping ──────────────────────────────────────────────────── */
function MappingPanel({ forecastLines, actualLines, currency, busy, onSet, onClear }) {
  const [side, setSide] = useState('forecast');
  const [onlyUnmapped, setOnlyUnmapped] = useState(false);
  const lines = side === 'forecast' ? forecastLines : actualLines;
  const shown = onlyUnmapped ? lines.filter((l) => l.category.startsWith('unmapped_')) : lines;
  const unmappedCount = lines.filter((l) => l.category.startsWith('unmapped_')).length;

  return (
    <div style={{ ...cardStyle, padding: '16px 0 10px' }}>
      <div style={{ padding: '0 20px 12px', display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ fontFamily: OUTFIT, fontSize: '15px', fontWeight: 700, color: '#0f172a' }}>
          Where each line lands
        </span>
        <Segmented
          size="sm" value={side} onChange={setSide}
          options={[
            { key: 'forecast', label: `Forecast (${forecastLines.length})` },
            { key: 'actual', label: `QuickBooks (${actualLines.length})` },
          ]}
        />
        {unmappedCount > 0 && (
          <button
            onClick={() => setOnlyUnmapped((x) => !x)}
            style={{ ...linkBtn, color: onlyUnmapped ? '#0369a1' : '#b45309' }}
          >
            {onlyUnmapped ? 'Show all lines' : `${unmappedCount} unmapped`}
          </button>
        )}
      </div>

      <p style={{ fontFamily: OUTFIT, fontSize: '11.5px', color: '#94a3b8', padding: '0 20px 10px', margin: 0, lineHeight: 1.55 }}>
        Every source line and the statement row it feeds. Lines marked <em>default</em> follow the built-in
        rules; change one and the choice is remembered for this client only. Totals the engine derives
        (revenue_total, EBITDA, net assets) are deliberately excluded — the dashboard recomputes those from
        the components, and mapping a total would count its parts twice.
      </p>

      <div style={{ overflowX: 'auto', maxHeight: '620px', overflowY: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={{ ...th, textAlign: 'left', paddingLeft: '20px' }}>Line</th>
              <th style={{ ...th, textAlign: 'right' }}>Total</th>
              <th style={{ ...th, textAlign: 'left' }}>Goes to</th>
              <th style={{ ...th, textAlign: 'left', width: '90px' }} />
            </tr>
          </thead>
          <tbody>
            {shown.map((l) => (
              <tr key={`${l.source}:${l.key}`}>
                <td style={{ ...td, textAlign: 'left', paddingLeft: '20px', fontFamily: side === 'forecast' ? 'ui-monospace, monospace' : OUTFIT, fontSize: '12px' }}>
                  {l.label}
                </td>
                <td style={{ ...td, color: '#64748b' }}>{moneyCompact(l.total, currency)}</td>
                <td style={{ ...td, textAlign: 'left' }}>
                  <select
                    value={l.category}
                    disabled={busy}
                    onChange={(e) => onSet(l.source, l.key, e.target.value)}
                    style={{
                      ...inputStyle, padding: '5px 8px', fontSize: '12px',
                      color: l.category.startsWith('unmapped_') ? '#b45309' : '#334155',
                      borderColor: l.category.startsWith('unmapped_') ? '#fde68a' : '#e5e7eb',
                    }}
                  >
                    {PICKABLE.map((g) => (
                      <optgroup key={g.group} label={g.group}>
                        {g.keys.map((k) => <option key={k} value={k}>{catLabel(k)}</option>)}
                      </optgroup>
                    ))}
                  </select>
                </td>
                <td style={{ ...td, textAlign: 'left' }}>
                  {l.isDefault
                    ? <span style={{ fontFamily: OUTFIT, fontSize: '11px', color: '#cbd5e1' }}>default</span>
                    : <button onClick={() => onClear(l.source, l.key)} disabled={busy} style={linkBtn}>reset</button>}
                </td>
              </tr>
            ))}
            {shown.length === 0 && (
              <tr>
                <td colSpan={4} style={{ ...td, textAlign: 'left', paddingLeft: '20px', color: '#94a3b8' }}>
                  {onlyUnmapped ? 'Nothing is unmapped — every line has a home.' : 'No lines yet.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ─── Styles ───────────────────────────────────────────────────── */
const th = {
  fontFamily: OUTFIT, fontSize: '11px', color: '#94a3b8', fontWeight: 700,
  textAlign: 'right', padding: '7px 14px', whiteSpace: 'nowrap',
  borderBottom: '1px solid #e5e7eb',
};
const td = {
  fontFamily: OUTFIT, fontSize: '12.5px', textAlign: 'right', padding: '7px 14px',
  whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums', borderBottom: '1px solid #f8fafc',
};
const totalCell = { fontWeight: 700, color: '#0f172a', borderTop: '1px solid #e5e7eb' };
const grandCell = { fontWeight: 700, fontSize: '13.5px', borderTop: '2px solid #0f172a', backgroundColor: '#f8fafc' };
const linkBtn = {
  border: 'none', background: 'none', padding: 0, cursor: 'pointer',
  fontFamily: OUTFIT, fontSize: '12px', fontWeight: 600, color: '#0369a1', textDecoration: 'underline',
};
