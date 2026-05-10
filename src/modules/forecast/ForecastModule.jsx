import React, { useEffect, useMemo, useState } from 'react';
import {
  listForecasts, createForecast, updateForecast, listVersions, listScenarios,
  loadOutputs, loadFindings, listEntities, listGroups, listEntityGroupAssignments,
  copyForecast,
} from './lib/queries';
import { recomputeScenario } from './lib/recompute';
import { PACKS } from './lib/packs';
import { btnDark, btnOutline, colors, fontStack, inputStyle, KPI, Pill, selectStyle, serifStack } from './components/ui';

import InputsView from './views/InputsView';
import StatementView from './views/StatementView';
import { PNL_LINES, BS_LINES, CF_LINES } from './views/statementLines';
import DealView from './views/DealView';
import DashboardView from './views/DashboardView';
import InsightsView from './views/InsightsView';
import FindingsView from './views/FindingsView';
import LaSettingsView from './views/LaSettingsView';
import StaffCostsView from './views/StaffCostsView';
import PremisesOverheadsView from './views/PremisesOverheadsView';
import KpisTrendView from './views/KpisTrendView';
import CapacitiesView from './views/CapacitiesView';
import IncomeView from './views/IncomeView';
import ExportModal from './views/ExportModal';

const TABS = [
  { key: 'dashboard', label: 'Dashboard' },
  { key: 'inputs',    label: 'Inputs' },
  { key: 'pnl',       label: 'P&L' },
  { key: 'bs',        label: 'Balance sheet' },
  { key: 'cf',        label: 'Cashflow' },
  { key: 'income',    label: 'Income' },
  { key: 'staff',     label: 'Staff detail' },
  { key: 'premises',  label: 'Premises & overheads' },
  { key: 'capacities',label: 'Capacities' },
  { key: 'trends',    label: 'KPI trends' },
  { key: 'deal',      label: 'Deal view' },
  { key: 'insights',  label: 'AI insights' },
  { key: 'findings',  label: 'Findings' },
  { key: 'la',        label: 'LA settings' },
];

export default function ForecastModule() {
  const [forecasts, setForecasts] = useState([]);
  const [forecastId, setForecastId] = useState(null);
  const [forecast, setForecast] = useState(null);
  const [version, setVersion] = useState(null);
  const [scenario, setScenario] = useState(null);

  const [outputs, setOutputs] = useState([]);
  const [findings, setFindings] = useState([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [tab, setTab] = useState('dashboard');
  const [showCreate, setShowCreate] = useState(false);
  const [showEdit, setShowEdit] = useState(false);
  const [showExport, setShowExport] = useState(false);

  const [entities, setEntities] = useState([]);
  const [groups, setGroups] = useState([]);
  const [assignments, setAssignments] = useState([]);
  const [filter, setFilter] = useState({ kind: 'all' });

  const periods = useMemo(() => {
    const n = forecast?.horizon_months || 60;
    return Array.from({ length: n }, (_, i) => i);
  }, [forecast?.horizon_months]);

  useEffect(() => { (async () => {
    try { setForecasts(await listForecasts()); } catch (e) { setErr(e.message); }
  })(); }, []);

  useEffect(() => {
    if (!forecastId) {
      setForecast(null); setVersion(null); setScenario(null);
      setOutputs([]); setFindings([]); return;
    }
    (async () => {
      try {
        const f = forecasts.find(x => x.id === forecastId);
        setForecast(f);
        const [versions, ents, gs, asgn] = await Promise.all([
          listVersions(forecastId),
          listEntities(forecastId),
          listGroups(forecastId).then(r => r.groups).catch(() => []),
          listEntityGroupAssignments(forecastId).catch(() => []),
        ]);
        setEntities(ents);
        setGroups(gs);
        setAssignments(asgn);
        const working = versions.find(v => v.kind === 'working') || versions[0];
        setVersion(working);
        const scenarios = working ? await listScenarios(working.id) : [];
        const base = scenarios.find(s => s.kind === 'base') || scenarios[0];
        setScenario(base);
        if (base) {
          setOutputs(await loadOutputs(base.id));
          setFindings(await loadFindings(base.id));
        }
      } catch (e) { setErr(e.message); }
    })();
  }, [forecastId, forecasts]);

  const reloadGroups = async () => {
    if (!forecastId) return;
    try {
      const [gs, asgn] = await Promise.all([
        listGroups(forecastId).then(r => r.groups).catch(() => []),
        listEntityGroupAssignments(forecastId).catch(() => []),
      ]);
      setGroups(gs); setAssignments(asgn);
    } catch (e) { setErr(e.message); }
  };

  const reloadEntities = async () => {
    if (!forecastId) return;
    try { setEntities(await listEntities(forecastId)); } catch (e) { setErr(e.message); }
  };

  const onEdit = async (form) => {
    if (!forecastId) return;
    setBusy(true);
    try {
      await updateForecast(forecastId, form);
      const list = await listForecasts();
      setForecasts(list);
      setForecast(list.find(f => f.id === forecastId) || null);
      setShowEdit(false);
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };

  const onCreate = async (form) => {
    if (!form?.name) return;
    setBusy(true);
    try {
      // Modal supplies opening_period as YYYY-MM-01; fall back to current
      // month if missing (defensive — modal validates).
      const today = new Date();
      const fallback = new Date(today.getFullYear(), today.getMonth(), 1).toISOString().slice(0, 10);
      const opening = form.opening_period || fallback;
      const { forecast: f } = await createForecast({
        name: form.name, client_name: form.client_name || null,
        vertical_pack: form.vertical_pack, horizon_months: form.horizon_months || 84,
        opening_period: opening,
      });
      const list = await listForecasts();
      setForecasts(list);
      setForecastId(f.id);
      setShowCreate(false);
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };

  const onCopyForecast = async () => {
    if (!forecast) return;
    const suggested = forecast.name?.match(/(.*?)( v\d+)?$/);
    const stem = (suggested && suggested[1]) || forecast.name || 'Forecast';
    const nextName = prompt(
      'Name for the copy?\n\nThis duplicates the entire forecast (entities, assumptions, drivers, loans, groups). Outputs and findings are NOT copied — Recompute the new forecast after the copy completes.',
      `${stem} v2`
    );
    if (nextName == null) return;
    const trimmed = nextName.trim();
    if (!trimmed) return;
    setBusy(true); setErr(null);
    try {
      // We pass the desired name as a suffix relative to the source name.
      // The helper appends as `<srcName><suffix>`, so derive suffix.
      const suffix = trimmed.startsWith(forecast.name)
        ? trimmed.slice(forecast.name.length)
        : ` — ${trimmed}`;
      const f = await copyForecast(forecast.id, { name_suffix: suffix });
      // If the suffix substitution above didn't yield exactly the user's
      // requested name, rename the new forecast directly.
      if (f.name !== trimmed) {
        await updateForecast(f.id, { name: trimmed });
      }
      const list = await listForecasts();
      setForecasts(list);
      setForecastId(f.id);
    } catch (e) { setErr(`Copy failed: ${e.message}`); }
    setBusy(false);
  };

  const onRecompute = async () => {
    if (!scenario || !version || !forecastId) return;
    setBusy(true); setErr(null);
    try {
      await recomputeScenario({
        forecast_id: forecastId, version_id: version.id, scenario_id: scenario.id,
      });
      setOutputs(await loadOutputs(scenario.id));
      setFindings(await loadFindings(scenario.id));
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };

  const integrity = useMemo(() => {
    const errs = findings.filter(f => f.severity === 'error');
    if (errs.length === 0) return { state: 'ok', label: 'Model ties' };
    return { state: 'error', label: `${errs.length} error${errs.length !== 1 ? 's' : ''}` };
  }, [findings]);

  return (
    <div style={{ maxWidth: 1280, margin: '0 auto', padding: '24px 24px 60px', fontFamily: fontStack }}>
      <Header onExport={forecast ? () => setShowExport(true) : null}
        forecast={forecast} forecasts={forecasts}
        forecastId={forecastId} onSelect={setForecastId}
        onCreate={() => setShowCreate(true)}
        onEdit={forecast ? () => setShowEdit(true) : null}
        onCopy={forecast ? onCopyForecast : null}
        onRecompute={forecast ? onRecompute : null}
        busy={busy}
        integrity={integrity}
      />
      {showCreate && (
        <CreateForecastModal
          onClose={() => setShowCreate(false)}
          onCreate={onCreate}
          existingClients={[...new Set(forecasts.map(f => f.client_name).filter(Boolean))]}
          busy={busy}
        />
      )}
      {showExport && forecast && scenario && (
        <ExportModal
          forecast={forecast} scenario={scenario}
          periods={periods} outputs={outputs}
          entities={entities} groups={groups} assignments={assignments}
          filter={filter}
          onClose={() => setShowExport(false)}
        />
      )}
      {showEdit && forecast && (
        <EditForecastModal
          forecast={forecast}
          onClose={() => setShowEdit(false)}
          onSave={onEdit}
          existingClients={[...new Set(forecasts.map(f => f.client_name).filter(Boolean))]}
          busy={busy}
        />
      )}

      {err && (
        <div style={{ padding: 12, background: '#fef2f2', color: colors.red, borderRadius: 8, marginBottom: 12, fontSize: 13 }}>
          {err}
        </div>
      )}

      {!forecast && (
        <div style={{ padding: '60px 24px', textAlign: 'center', color: colors.muted, fontSize: 14 }}>
          Pick a forecast or create a new one to get started.
        </div>
      )}

      {forecast && version && scenario && (
        <>
          <Tabs tab={tab} setTab={setTab} />

          <div style={{ marginTop: 18 }}>
            {tab === 'dashboard' && (
              <DashboardView outputs={outputs} forecast={forecast} periods={periods}
                entities={entities} groups={groups} assignments={assignments}
                filter={filter} onFilterChange={setFilter} />
            )}
            {tab === 'la' && (
              <LaSettingsView />
            )}
            {tab === 'inputs' && (
              <InputsView forecast={forecast} scenario={scenario}
                entities={entities} groups={groups} assignments={assignments}
                onEntitiesChanged={reloadEntities} onGroupsChanged={reloadGroups}
                onChanged={onRecompute} />
            )}
            {tab === 'income' && (
              <IncomeView outputs={outputs} forecast={forecast} periods={periods}
                scenarioId={scenario.id}
                entities={entities} groups={groups} assignments={assignments}
                filter={filter} onFilterChange={setFilter} />
            )}
            {tab === 'pnl' && (
              <StatementView title="Profit & Loss" variant="pnl" lines={PNL_LINES} outputs={outputs}
                forecast={forecast} periods={periods} openingPeriod={forecast.opening_period}
                scenarioId={scenario.id}
                entities={entities} groups={groups} assignments={assignments}
                filter={filter} onFilterChange={setFilter} />
            )}
            {tab === 'bs' && (
              <StatementView title="Balance sheet" variant="bs" lines={BS_LINES} outputs={outputs}
                forecast={forecast} periods={periods} openingPeriod={forecast.opening_period}
                scenarioId={scenario.id}
                entities={entities} groups={groups} assignments={assignments}
                filter={filter} onFilterChange={setFilter} />
            )}
            {tab === 'cf' && (
              <StatementView title="Cashflow" variant="cf" lines={CF_LINES} outputs={outputs}
                forecast={forecast} periods={periods} openingPeriod={forecast.opening_period}
                scenarioId={scenario.id}
                entities={entities} groups={groups} assignments={assignments}
                filter={filter} onFilterChange={setFilter} />
            )}
            {tab === 'staff' && (
              <StaffCostsView outputs={outputs} forecast={forecast} periods={periods}
                scenarioId={scenario.id}
                entities={entities} groups={groups} assignments={assignments}
                filter={filter} onFilterChange={setFilter} />
            )}
            {tab === 'premises' && (
              <PremisesOverheadsView outputs={outputs} forecast={forecast} periods={periods}
                scenarioId={scenario.id}
                entities={entities} groups={groups} assignments={assignments}
                filter={filter} onFilterChange={setFilter} />
            )}
            {tab === 'capacities' && (
              <CapacitiesView outputs={outputs} forecast={forecast} periods={periods}
                entities={entities} groups={groups} assignments={assignments}
                filter={filter} onFilterChange={setFilter} />
            )}
            {tab === 'trends' && (
              <KpisTrendView outputs={outputs} forecast={forecast} periods={periods}
                entities={entities} groups={groups} assignments={assignments}
                filter={filter} onFilterChange={setFilter} />
            )}
            {tab === 'deal' && (
              <DealView outputs={outputs} forecast={forecast} periods={periods}
                entities={entities} groups={groups} assignments={assignments}
                filter={filter} onFilterChange={setFilter} />
            )}
            {tab === 'insights' && (
              <InsightsView outputs={outputs} findings={findings} forecast={forecast} periods={periods} entities={entities} />
            )}
            {tab === 'findings' && (
              <FindingsView findings={findings} outputs={outputs} forecast={forecast} periods={periods} entities={entities} />
            )}
          </div>
        </>
      )}
    </div>
  );
}

function Header({ forecast, forecasts, forecastId, onSelect, onCreate, onEdit, onCopy, onExport, integrity, onRecompute, busy }) {
  const byClient = {};
  for (const f of forecasts) {
    const c = f.client_name || '— no client —';
    (byClient[c] ||= []).push(f);
  }
  const clients = Object.keys(byClient).sort((a, b) => a.localeCompare(b));

  return (
    <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 18, flexWrap: 'wrap', gap: 12 }}>
      <div>
        <h1 style={{ fontFamily: serifStack, fontSize: 30, fontWeight: 500, color: colors.ink, margin: 0 }}>
          Forecast
          {forecast?.client_name && (
            <span style={{ fontSize: 16, fontWeight: 400, color: colors.muted, marginLeft: 12 }}>
              · {forecast.client_name}
            </span>
          )}
        </h1>
        <p style={{ fontSize: 12, color: colors.muted, margin: '4px 0 0' }}>
          {forecast
            ? `${forecast.name} · ${forecast.vertical_pack} · ${forecast.horizon_months} months`
            : 'Multi-location · 3-statement · investor-deck-ready'}
        </p>
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <IntegrityBadge state={integrity.state} label={integrity.label} />
        <select
          value={forecastId || ''}
          onChange={(e) => onSelect(e.target.value || null)}
          style={selectStyle}
        >
          <option value="">— pick a forecast —</option>
          {clients.map(c => (
            <optgroup key={c} label={c}>
              {byClient[c].map(f => (
                <option key={f.id} value={f.id}>{f.name} · {f.vertical_pack}</option>
              ))}
            </optgroup>
          ))}
        </select>
        {onEdit && (
          <button onClick={onEdit} style={btnOutline} title="Edit client name, forecast name and horizon">Edit</button>
        )}
        <button onClick={onCreate} style={btnDark}>+ New</button>
        {forecast && onCopy && (
          <button onClick={onCopy} disabled={busy} style={btnOutline} title="Duplicate this forecast as a new version (e.g. v2)">Copy</button>
        )}
        {forecast && onExport && (
          <button onClick={onExport} style={btnOutline} title="Export PDF / Excel pack">Export</button>
        )}
        {forecast && onRecompute && (
          <button onClick={onRecompute} disabled={busy} style={btnDark} title="Recompute outputs from current drivers">
            {busy ? 'Computing…' : 'Recompute'}
          </button>
        )}
      </div>
    </header>
  );
}

function CreateForecastModal({ onClose, onCreate, existingClients, busy }) {
  // Default the start month to the current month so a fresh forecast
  // begins now; users override to backdate or push forward.
  const today = new Date();
  const ymThisMonth = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
  const [form, setForm] = useState({
    name: '',
    client_name: '',
    vertical_pack: 'childcare_scotland',
    horizon_months: 84,
    start_month: ymThisMonth,           // YYYY-MM
  });
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const submit = () => {
    if (!form.name.trim()) { alert('Forecast name required'); return; }
    if (!form.start_month || !/^\d{4}-\d{2}$/.test(form.start_month)) {
      alert('Start month is required (YYYY-MM)'); return;
    }
    onCreate({
      ...form,
      name: form.name.trim(), client_name: form.client_name.trim(),
      horizon_months: Number(form.horizon_months),
      opening_period: `${form.start_month}-01`,    // first of month
    });
  };
  return (
    <div onClick={onClose} style={modalBackdrop}>
      <div onClick={(e) => e.stopPropagation()} style={modalCard}>
        <h2 style={{ fontFamily: serifStack, fontSize: 22, fontWeight: 500, color: colors.ink, margin: '0 0 16px' }}>
          New forecast
        </h2>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Field label="Client name">
            <input
              autoFocus
              value={form.client_name}
              onChange={set('client_name')}
              list="fc-existing-clients"
              placeholder="e.g. Acme Childcare Ltd"
              style={inputStyle}
            />
            <datalist id="fc-existing-clients">
              {existingClients.map(c => <option key={c} value={c} />)}
            </datalist>
          </Field>
          <Field label="Forecast name">
            <input
              value={form.name}
              onChange={set('name')}
              placeholder="e.g. Childcare group — Scotland"
              style={inputStyle}
            />
          </Field>
          <Field label="Vertical pack">
            <select value={form.vertical_pack} onChange={set('vertical_pack')} style={{ ...inputStyle, padding: '6px' }}>
              {Object.entries(PACKS).map(([k, p]) => (
                <option key={k} value={k}>{p.label}</option>
              ))}
            </select>
          </Field>
          <Field label="Horizon (months)">
            <input type="number" value={form.horizon_months} onChange={set('horizon_months')} style={inputStyle} />
          </Field>
          <Field label="Start month">
            <input
              type="month"
              value={form.start_month}
              onChange={set('start_month')}
              style={inputStyle}
            />
          </Field>
        </div>
        <p style={{ fontSize: 11, color: colors.muted, margin: '12px 0 0' }}>
          Start month sets period 0 of the model — every "Opens (months from start)"
          on a location is relative to this. Defaults to the current month; pick any
          past or future month to anchor the forecast.
        </p>
        <p style={{ fontSize: 11, color: colors.muted, margin: '6px 0 0' }}>
          Client name groups forecasts in the picker and will support consolidation across multiple businesses for the same client.
        </p>
        <div style={{ display: 'flex', gap: 10, marginTop: 22 }}>
          <button onClick={onClose} style={{ ...btnOutline, flex: 1, justifyContent: 'center' }}>Cancel</button>
          <button onClick={submit} disabled={busy} style={{ ...btnDark, flex: 1, justifyContent: 'center' }}>
            {busy ? 'Creating…' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <label style={{ display: 'block' }}>
      <div style={{ fontSize: 11, color: colors.muted, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 4 }}>{label}</div>
      {children}
    </label>
  );
}

const modalBackdrop = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, fontFamily: fontStack };
const modalCard = { background: '#fff', borderRadius: 16, padding: 28, maxWidth: 540, width: '100%' };

function IntegrityBadge({ state, label }) {
  const bg = state === 'ok' ? '#dcfce7' : '#fee2e2';
  const fg = state === 'ok' ? '#166534' : '#991b1b';
  const title = state === 'ok'
    ? 'Reconciliation OK: balance sheet ties (assets = liabilities + equity), and cashflow movement matches the BS cash delta. The 3-statement model is internally consistent.'
    : 'Reconciliation issue: the 3-statement model has at least one mismatch (BS does not balance, or cashflow does not tie to BS cash movement). Open Findings to see details.';
  return (
    <div title={title} style={{
      padding: '6px 12px', borderRadius: 999, background: bg, color: fg,
      fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4,
      cursor: 'help',
    }}>
      {state === 'ok' ? '✓' : '!'} {state === 'ok' ? 'Reconciles' : label}
    </div>
  );
}

function EditForecastModal({ forecast, onClose, onSave, existingClients, busy }) {
  // Pull the YYYY-MM portion out of the stored opening_period (which is
  // a YYYY-MM-DD string) so the <input type="month"> binds cleanly.
  const startMonthFromForecast = (forecast.opening_period || '').slice(0, 7);
  const [form, setForm] = useState({
    name: forecast.name || '',
    client_name: forecast.client_name || '',
    horizon_months: forecast.horizon_months || 60,
    start_month: startMonthFromForecast,
  });
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const submit = () => {
    if (!form.name.trim()) { alert('Forecast name required'); return; }
    if (!form.horizon_months || form.horizon_months < 1) { alert('Horizon must be at least 1 month'); return; }
    if (!form.start_month || !/^\d{4}-\d{2}$/.test(form.start_month)) {
      alert('Start month is required (YYYY-MM)'); return;
    }
    onSave({
      name: form.name.trim(),
      client_name: form.client_name.trim(),
      horizon_months: Number(form.horizon_months),
      opening_period: `${form.start_month}-01`,
    });
  };
  const horizonShrinking = Number(form.horizon_months) < forecast.horizon_months;
  const startMonthChanging = form.start_month !== startMonthFromForecast;
  return (
    <div onClick={onClose} style={modalBackdrop}>
      <div onClick={(e) => e.stopPropagation()} style={modalCard}>
        <h2 style={{ fontFamily: serifStack, fontSize: 22, fontWeight: 500, color: colors.ink, margin: '0 0 16px' }}>
          Edit forecast
        </h2>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Field label="Client name">
            <input
              autoFocus
              value={form.client_name}
              onChange={set('client_name')}
              list="fc-edit-existing-clients"
              placeholder="e.g. Acme Childcare Ltd"
              style={inputStyle}
            />
            <datalist id="fc-edit-existing-clients">
              {existingClients.map(c => <option key={c} value={c} />)}
            </datalist>
          </Field>
          <Field label="Forecast name">
            <input value={form.name} onChange={set('name')} style={inputStyle} />
          </Field>
          <Field label="Horizon (months)">
            <input type="number" value={form.horizon_months} onChange={set('horizon_months')} style={inputStyle} />
          </Field>
          <Field label="Start month">
            <input type="month" value={form.start_month} onChange={set('start_month')} style={inputStyle} />
          </Field>
          <Field label="Vertical pack">
            <input value={forecast.vertical_pack} disabled style={{ ...inputStyle, color: colors.muted }} />
          </Field>
        </div>
        {horizonShrinking && (
          <p style={{ fontSize: 11, color: colors.amber, margin: '12px 0 0', background: '#fef3c7', padding: 8, borderRadius: 6 }}>
            Shrinking horizon will drop output rows beyond month {form.horizon_months - 1}. Recompute after saving to refresh.
          </p>
        )}
        {startMonthChanging && (
          <p style={{ fontSize: 11, color: colors.amber, margin: '8px 0 0', background: '#fef3c7', padding: 8, borderRadius: 6 }}>
            Changing the start month shifts every period in the forecast. "Opens (months from start)"
            on each location stays in months — but the calendar dates will move. Recompute after saving.
          </p>
        )}
        <p style={{ fontSize: 11, color: colors.muted, margin: '12px 0 0' }}>
          Vertical pack is fixed once a forecast is created.
        </p>
        <div style={{ display: 'flex', gap: 10, marginTop: 22 }}>
          <button onClick={onClose} style={{ ...btnOutline, flex: 1, justifyContent: 'center' }}>Cancel</button>
          <button onClick={submit} disabled={busy} style={{ ...btnDark, flex: 1, justifyContent: 'center' }}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Tabs({ tab, setTab }) {
  return (
    <div style={{ display: 'flex', gap: 4, borderBottom: `1px solid ${colors.border}` }}>
      {TABS.map(t => (
        <button
          key={t.key}
          onClick={() => setTab(t.key)}
          style={{
            padding: '10px 14px', fontSize: 13,
            fontWeight: tab === t.key ? 600 : 400,
            color: tab === t.key ? colors.ink : colors.muted,
            background: 'transparent', border: 'none',
            borderBottom: tab === t.key ? `2px solid ${colors.accent}` : '2px solid transparent',
            cursor: 'pointer', fontFamily: fontStack,
          }}
        >{t.label}</button>
      ))}
    </div>
  );
}
