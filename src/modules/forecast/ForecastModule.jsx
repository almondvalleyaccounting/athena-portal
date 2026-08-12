import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  listForecasts, createForecast, updateForecast, listVersions, listScenarios,
  loadOutputs, loadFindings, listEntities, listGroups, listEntityGroupAssignments,
  copyForecast, createVersionFrom, renameVersion, deleteVersion, searchClients,
  loadCapacityOverrides,
} from './lib/queries';
import { withEffectiveCapacity } from './lib/capacity';
import { recomputeScenario } from './lib/recompute';
import { PACKS } from './lib/packs';
import { btnDark, btnOutline, colors, fontStack, inputStyle, KPI, Pill, selectStyle, serifStack } from './components/ui';

import { lensFor } from './lenses';
import { CURRENCIES, setActiveCurrency } from './lib/currency';
import InputsView from './views/InputsView';
import LinesView from './views/LinesView';
import LedgerView from './views/LedgerView';
import CashDashboardView from './views/CashDashboardView';
import OverviewView from './views/OverviewView';
import PnlByBandView from './views/PnlByBandView';
import StatementView from './views/StatementView';
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
import CompareView from './views/CompareView';
import ExportModal from './views/ExportModal';

export default function ForecastModule() {
  const [forecasts, setForecasts] = useState([]);
  const [forecastId, setForecastId] = useState(null);
  const [forecast, setForecast] = useState(null);
  const [versions, setVersions] = useState([]);
  const [version, setVersion] = useState(null);
  const [scenario, setScenario] = useState(null);

  const [outputs, setOutputs] = useState([]);
  const [findings, setFindings] = useState([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [tab, setTab] = useState('inputs');
  const [showCreate, setShowCreate] = useState(false);
  const [showEdit, setShowEdit] = useState(false);
  const [showExport, setShowExport] = useState(false);

  const [entitiesRaw, setEntities] = useState([]);
  const [capacityOverrides, setCapacityOverrides] = useState({});
  const recomputingRef = useRef(false);
  const [groups, setGroups] = useState([]);
  const [assignments, setAssignments] = useState([]);
  const [filter, setFilter] = useState({ kind: 'all' });

  const periods = useMemo(() => {
    const n = forecast?.horizon_months || 60;
    return Array.from({ length: n }, (_, i) => i);
  }, [forecast?.horizon_months]);

  // The lens decides which tabs exist and which statement lines they render —
  // a childcare forecast and a general cashflow are the same engine wearing
  // different clothes.
  const lens = useMemo(() => lensFor(forecast?.vertical_pack), [forecast?.vertical_pack]);

  // Every fmtP() in every view reads the active currency, so set it during
  // render — before the children format anything — rather than in an effect,
  // which would paint one frame of "£" over a dollar forecast.
  useMemo(() => setActiveCurrency(forecast?.currency), [forecast?.currency]);

  // Switching to a forecast on a different lens can leave `tab` pointing at a
  // tab that lens does not have (e.g. Capacities on a cashflow forecast).
  useEffect(() => {
    if (!lens.tabs.some(t => t.key === tab)) setTab(lens.tabs[0].key);
  }, [lens, tab]);

  // Registered places are overridable per VERSION, but fc_entity is
  // forecast-level and shared by all of them. Overlay the selected version's
  // override here, once, so every view and export reads the right split off
  // entity.config without having to know the override exists.
  const entities = useMemo(
    () => withEffectiveCapacity(entitiesRaw, capacityOverrides),
    [entitiesRaw, capacityOverrides],
  );

  useEffect(() => { (async () => {
    try { setForecasts(await listForecasts()); } catch (e) { setErr(e.message); }
  })(); }, []);

  // Load a version's base scenario + its outputs/findings.
  const loadVersionData = async (v) => {
    setVersion(v);
    const scenarios = v ? await listScenarios(v.id) : [];
    const base = scenarios.find(s => s.kind === 'base') || scenarios[0];
    setScenario(base || null);
    if (base) {
      const [outs, finds, caps] = await Promise.all([
        loadOutputs(base.id),
        loadFindings(base.id),
        loadCapacityOverrides(base.id).catch(() => ({})),
      ]);
      setOutputs(outs); setFindings(finds); setCapacityOverrides(caps);
    } else {
      setOutputs([]); setFindings([]); setCapacityOverrides({});
    }
  };

  useEffect(() => {
    if (!forecastId) {
      setForecast(null); setVersions([]); setVersion(null); setScenario(null);
      setOutputs([]); setFindings([]); return;
    }
    (async () => {
      try {
        const f = forecasts.find(x => x.id === forecastId);
        setForecast(f);
        const [vs, ents, gs, asgn] = await Promise.all([
          listVersions(forecastId),
          listEntities(forecastId),
          listGroups(forecastId).then(r => r.groups).catch(() => []),
          listEntityGroupAssignments(forecastId).catch(() => []),
        ]);
        setEntities(ents);
        setGroups(gs);
        setAssignments(asgn);
        setVersions(vs);
        // Most recently created version first (listVersions orders desc);
        // fall back to the legacy "working" row.
        const initial = vs[0] || vs.find(v => v.kind === 'working');
        await loadVersionData(initial || null);
      } catch (e) { setErr(e.message); }
    })();
  }, [forecastId, forecasts]);

  const onSelectVersion = async (versionId) => {
    const v = versions.find(x => x.id === versionId);
    if (!v) return;
    setBusy(true); setErr(null);
    try { await loadVersionData(v); } catch (e) { setErr(e.message); }
    setBusy(false);
  };

  const onNewVersion = async () => {
    if (!forecast || !version) return;
    const name = prompt(
      'Name for the new version?\n\nDuplicates the current version (assumptions, drivers, loans) so you can change it independently — e.g. "Budget", "Rolling Forecast", "v2", "2026.07 Scenario 1".',
      `${version.name} copy`
    );
    if (name == null || !name.trim()) return;
    setBusy(true); setErr(null);
    try {
      const nv = await createVersionFrom({
        forecast_id: forecast.id, source_version_id: version.id, name: name.trim(),
      });
      const vs = await listVersions(forecast.id);
      setVersions(vs);
      await loadVersionData(vs.find(v => v.id === nv.id) || nv);
      // Fresh version has no outputs yet — compute them now.
      const scenarios = await listScenarios(nv.id);
      const base = scenarios.find(s => s.kind === 'base') || scenarios[0];
      if (base) {
        await recomputeScenario({ forecast_id: forecast.id, version_id: nv.id, scenario_id: base.id });
        setOutputs(await loadOutputs(base.id));
        setFindings(await loadFindings(base.id));
      }
    } catch (e) { setErr(`New version failed: ${e.message}`); }
    setBusy(false);
  };

  const onRenameVersion = async () => {
    if (!version) return;
    const name = prompt('Rename this version', version.name || '');
    if (name == null || !name.trim() || name.trim() === version.name) return;
    setBusy(true); setErr(null);
    try {
      const updated = await renameVersion(version.id, name.trim());
      setVersions(prev => prev.map(v => (v.id === updated.id ? updated : v)));
      setVersion(updated);
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };

  const onDeleteVersion = async () => {
    if (!version || versions.length < 2) return;   // never delete the last version
    const ok = confirm(
      `Delete version "${version.name}"?\n\nThis permanently removes its scenarios, assumptions (drivers), loans and computed outputs. Locations are shared with other versions and are NOT affected.\n\nThis cannot be undone.`
    );
    if (!ok) return;
    setBusy(true); setErr(null);
    try {
      await deleteVersion(version.id);
      const vs = await listVersions(forecast.id);
      setVersions(vs);
      await loadVersionData(vs[0] || null);
    } catch (e) { setErr(`Delete failed: ${e.message}`); }
    setBusy(false);
  };

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

  // Capacity overrides live on the scenario, so anything that can change a
  // location or re-run the engine must refresh them too — otherwise the
  // engine's outputs move to the new room split while the entity list the
  // views read is still carrying the old one.
  const reloadCapacityOverrides = async () => {
    if (!scenario?.id) return;
    try { setCapacityOverrides(await loadCapacityOverrides(scenario.id)); }
    catch { /* leave the previous overlay in place */ }
  };

  const reloadEntities = async () => {
    if (!forecastId) return;
    try {
      const [ents] = await Promise.all([listEntities(forecastId), reloadCapacityOverrides()]);
      setEntities(ents);
    } catch (e) { setErr(e.message); }
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
        name: form.name,
        client_name: form.client_name || null,
        group_client_name: form.group_client_name || null,
        client_entity_id: form.client_entity_id || null,
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
    // Belt as well as braces: persistOutputs is now safe under concurrency,
    // but a driver edit auto-recomputing while a manual Recompute is still
    // running is just wasted work — and it was how the duplicated-output bug
    // got triggered in the first place.
    if (recomputingRef.current) return;
    recomputingRef.current = true;
    setBusy(true); setErr(null);
    try {
      await recomputeScenario({
        forecast_id: forecastId, version_id: version.id, scenario_id: scenario.id,
      });
      setOutputs(await loadOutputs(scenario.id));
      setFindings(await loadFindings(scenario.id));
      await reloadCapacityOverrides();
    } catch (e) { setErr(e.message); }
    recomputingRef.current = false;
    setBusy(false);
  };

  const integrity = useMemo(() => {
    const errs = findings.filter(f => f.severity === 'error');
    if (errs.length === 0) return { state: 'ok', label: 'Model ties' };
    return { state: 'error', label: `${errs.length} error${errs.length !== 1 ? 's' : ''}` };
  }, [findings]);

  return (
    <div style={{ maxWidth: 1280, margin: '0 auto', padding: '24px 24px 60px', fontFamily: fontStack }}>
      <Header onExport={forecast && lens.exportPack ? () => setShowExport(true) : null}
        forecast={forecast} forecasts={forecasts}
        forecastId={forecastId} onSelect={setForecastId}
        versions={versions} version={version}
        onSelectVersion={onSelectVersion}
        onNewVersion={forecast ? onNewVersion : null}
        onRenameVersion={version ? onRenameVersion : null}
        onDeleteVersion={version && versions.length > 1 ? onDeleteVersion : null}
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
          existingGroupClients={[...new Set(forecasts.map(f => f.group_client_name || f.client_name).filter(Boolean))]}
          busy={busy}
        />
      )}
      {showExport && forecast && scenario && (
        <ExportModal
          forecast={forecast} scenario={scenario} version={version}
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
          existingGroupClients={[...new Set(forecasts.map(f => f.group_client_name || f.client_name).filter(Boolean))]}
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
          <Tabs tab={tab} setTab={setTab} tabs={lens.tabs} />

          <div style={{ marginTop: 18 }}>
            {tab === 'dashboard' && (
              <DashboardView outputs={outputs} forecast={forecast} periods={periods}
                entities={entities} groups={groups} assignments={assignments}
                filter={filter} onFilterChange={setFilter} />
            )}
            {tab === 'overview' && (
              <OverviewView outputs={outputs} forecast={forecast} periods={periods} entities={entities} />
            )}
            {tab === 'pnl_band' && (
              <PnlByBandView outputs={outputs} forecast={forecast} periods={periods}
                entities={entities} groups={groups} assignments={assignments}
                filter={filter} onFilterChange={setFilter} />
            )}
            {tab === 'la' && (
              <LaSettingsView />
            )}
            {tab === 'lines' && (
              <LinesView forecast={forecast} scenario={scenario} onChanged={onRecompute} />
            )}
            {tab === 'cash' && (
              <CashDashboardView outputs={outputs} forecast={forecast} periods={periods} />
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
            {tab === 'pnl' && lens.ledgerStatements && (
              <LedgerView forecast={forecast} scenario={scenario} outputs={outputs}
                periods={periods} variant="pnl" onChanged={onRecompute} />
            )}
            {tab === 'cf' && lens.ledgerStatements && (
              <LedgerView forecast={forecast} scenario={scenario} outputs={outputs}
                periods={periods} variant="cf" onChanged={onRecompute} />
            )}
            {tab === 'pnl' && !lens.ledgerStatements && (
              <StatementView title="Profit & Loss" variant="pnl" lines={lens.statements.pnl} outputs={outputs}
                forecast={forecast} periods={periods} openingPeriod={forecast.opening_period}
                scenarioId={scenario.id}
                entities={entities} groups={groups} assignments={assignments}
                filter={filter} onFilterChange={lens.locations ? setFilter : undefined} />
            )}
            {tab === 'bs' && (
              <StatementView title="Balance sheet" variant="bs" lines={lens.statements.bs} outputs={outputs}
                forecast={forecast} periods={periods} openingPeriod={forecast.opening_period}
                scenarioId={scenario.id}
                entities={entities} groups={groups} assignments={assignments}
                filter={filter} onFilterChange={lens.locations ? setFilter : undefined} />
            )}
            {tab === 'cf' && !lens.ledgerStatements && (
              <StatementView title="Cashflow" variant="cf" lines={lens.statements.cf} outputs={outputs}
                forecast={forecast} periods={periods} openingPeriod={forecast.opening_period}
                scenarioId={scenario.id}
                entities={entities} groups={groups} assignments={assignments}
                filter={filter} onFilterChange={lens.locations ? setFilter : undefined} />
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
            {tab === 'compare' && (
              <CompareView
                forecast={forecast} versions={versions} version={version} scenario={scenario}
                outputs={outputs} periods={periods} openingPeriod={forecast.opening_period}
                entities={entities}
              />
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

function Header({
  forecast, forecasts, forecastId, onSelect,
  versions = [], version, onSelectVersion, onNewVersion, onRenameVersion, onDeleteVersion,
  onCreate, onEdit, onCopy, onExport, integrity, onRecompute, busy,
}) {
  // Group the picker by GROUP CLIENT (e.g. "Marc Kelly"); each option
  // shows client company + forecast name.
  const byGroup = {};
  for (const f of forecasts) {
    const c = f.group_client_name || f.client_name || '— no group client —';
    (byGroup[c] ||= []).push(f);
  }
  const groupsSorted = Object.keys(byGroup).sort((a, b) => a.localeCompare(b));

  // Hierarchy line: Group client · Client · Forecast · Version
  const crumbs = forecast ? [
    forecast.group_client_name,
    forecast.client_name,
    forecast.name,
    version?.name,
  ].filter(Boolean) : [];

  return (
    <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 18, flexWrap: 'wrap', gap: 12 }}>
      <div>
        <h1 style={{ fontFamily: serifStack, fontSize: 30, fontWeight: 500, color: colors.ink, margin: 0 }}>
          Client Forecast
          {(forecast?.client_name || forecast?.group_client_name) && (
            <span style={{ fontSize: 16, fontWeight: 400, color: colors.muted, marginLeft: 12 }}>
              · {forecast.client_name || forecast.group_client_name}
            </span>
          )}
        </h1>
        <p style={{ fontSize: 12, color: colors.muted, margin: '4px 0 0' }}>
          {forecast
            ? `${crumbs.join(' › ')} · ${forecast.vertical_pack} · ${forecast.horizon_months} months`
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
          {groupsSorted.map(c => (
            <optgroup key={c} label={c}>
              {byGroup[c].map(f => (
                <option key={f.id} value={f.id}>
                  {[f.client_name, f.name].filter(Boolean).join(' › ') || f.name}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        {forecast && versions.length > 0 && (
          <>
            <select
              value={version?.id || ''}
              onChange={(e) => onSelectVersion(e.target.value)}
              style={selectStyle}
              title="Forecast version — e.g. Budget, Rolling Forecast, v1, v2"
            >
              {versions.map(v => (
                <option key={v.id} value={v.id}>{v.name}</option>
              ))}
            </select>
            {onRenameVersion && (
              <button onClick={onRenameVersion} disabled={busy} style={btnOutline} title="Rename this version">✎</button>
            )}
            {onDeleteVersion && (
              <button onClick={onDeleteVersion} disabled={busy}
                style={{ ...btnOutline, color: colors.red }}
                title="Delete this version (its assumptions and outputs) — locations and other versions are unaffected">
                🗑
              </button>
            )}
            {onNewVersion && (
              <button onClick={onNewVersion} disabled={busy} style={btnOutline}
                title="Duplicate the current version's assumptions as a new named version (Budget, Rolling Forecast, v2, …)">
                + Version
              </button>
            )}
          </>
        )}
        {onEdit && (
          <button onClick={onEdit} style={btnOutline} title="Edit group client, client link, forecast name and horizon">Edit</button>
        )}
        <button onClick={onCreate} style={btnDark}>+ New</button>
        {forecast && onCopy && (
          <button onClick={onCopy} disabled={busy} style={btnOutline} title="Duplicate the entire forecast as a new forecast">Copy</button>
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

// Searchable picker against the practice's client list (entities table).
// Stores both the linked id and a denormalised label; typing a name that
// isn't picked keeps it as a free-text client label (unlinked).
function ClientPicker({ value, onChange, autoFocus }) {
  const [q, setQ] = useState(value?.client_name || '');
  const [results, setResults] = useState([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const term = q.trim();
    if (term.length < 2) { setResults([]); return; }
    const h = setTimeout(async () => {
      try {
        const r = await searchClients(term);
        if (!cancelled) setResults(r);
      } catch { /* search is best-effort */ }
    }, 250);
    return () => { cancelled = true; clearTimeout(h); };
  }, [q]);

  const pick = (row) => {
    onChange({ client_entity_id: row.id, client_name: row.name });
    setQ(row.name);
    setOpen(false);
  };

  return (
    <div style={{ position: 'relative' }}>
      <input
        autoFocus={autoFocus}
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
          // Free text until a result is picked — clears any stale link.
          onChange({ client_entity_id: null, client_name: e.target.value });
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder="Search Athena clients…"
        style={inputStyle}
      />
      {value?.client_entity_id && (
        <span style={{ position: 'absolute', right: 8, top: 8, fontSize: 10, color: '#166534', background: '#dcfce7', borderRadius: 999, padding: '1px 7px', fontWeight: 700 }}>
          linked
        </span>
      )}
      {open && results.length > 0 && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 20,
          background: '#fff', border: `1px solid ${colors.border}`, borderRadius: 8,
          boxShadow: '0 8px 24px rgba(15,23,42,0.12)', maxHeight: 220, overflowY: 'auto',
        }}>
          {results.map(r => (
            <div key={r.id}
              onMouseDown={(e) => { e.preventDefault(); pick(r); }}
              style={{ padding: '7px 10px', fontSize: 13, cursor: 'pointer', color: colors.ink }}
              onMouseEnter={(e) => e.currentTarget.style.background = '#f0f9ff'}
              onMouseLeave={(e) => e.currentTarget.style.background = ''}
            >
              {r.name}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function CreateForecastModal({ onClose, onCreate, existingGroupClients, busy }) {
  // Default the start month to the current month so a fresh forecast
  // begins now; users override to backdate or push forward.
  const today = new Date();
  const ymThisMonth = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
  const [form, setForm] = useState({
    name: '',
    group_client_name: '',
    client_name: '',
    client_entity_id: null,
    vertical_pack: 'childcare_scotland',
    horizon_months: 84,
    start_month: ymThisMonth,           // YYYY-MM
    currency: 'GBP',
  });
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const submit = () => {
    if (!form.name.trim()) { alert('Forecast name required'); return; }
    if (!form.start_month || !/^\d{4}-\d{2}$/.test(form.start_month)) {
      alert('Start month is required (YYYY-MM)'); return;
    }
    onCreate({
      ...form,
      name: form.name.trim(),
      group_client_name: form.group_client_name.trim(),
      client_name: (form.client_name || '').trim(),
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
          <Field label="Group client">
            <input
              autoFocus
              value={form.group_client_name}
              onChange={set('group_client_name')}
              list="fc-existing-group-clients"
              placeholder="e.g. Marc Kelly"
              style={inputStyle}
            />
            <datalist id="fc-existing-group-clients">
              {existingGroupClients.map(c => <option key={c} value={c} />)}
            </datalist>
          </Field>
          <Field label="Client (Athena record)">
            <ClientPicker
              value={{ client_entity_id: form.client_entity_id, client_name: form.client_name }}
              onChange={(v) => setForm(prev => ({ ...prev, ...v }))}
            />
          </Field>
          <Field label="Forecast name">
            <input
              value={form.name}
              onChange={set('name')}
              placeholder="e.g. Childcare Scotland"
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
          <Field label="Currency">
            <select value={form.currency} onChange={set('currency')} style={{ ...inputStyle, padding: '6px' }}>
              {CURRENCIES.map(c => <option key={c.code} value={c.code}>{c.label}</option>)}
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
          Group client groups forecasts in the picker (the person or group behind the deal, even if
          they're not an Athena client yet). Client links this forecast to the actual Athena client
          record — pick from the search, or type a name to leave it unlinked. A first version named
          "v1" is created automatically; add "Budget" / "Rolling Forecast" versions from the header.
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

function EditForecastModal({ forecast, onClose, onSave, existingGroupClients, busy }) {
  // Pull the YYYY-MM portion out of the stored opening_period (which is
  // a YYYY-MM-DD string) so the <input type="month"> binds cleanly.
  const startMonthFromForecast = (forecast.opening_period || '').slice(0, 7);
  const [form, setForm] = useState({
    name: forecast.name || '',
    group_client_name: forecast.group_client_name || '',
    client_name: forecast.client_name || '',
    client_entity_id: forecast.client_entity_id || null,
    horizon_months: forecast.horizon_months || 60,
    start_month: startMonthFromForecast,
    currency: forecast.currency || 'GBP',
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
      group_client_name: form.group_client_name.trim(),
      client_name: (form.client_name || '').trim(),
      client_entity_id: form.client_entity_id,
      horizon_months: Number(form.horizon_months),
      opening_period: `${form.start_month}-01`,
      currency: form.currency,
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
          <Field label="Group client">
            <input
              autoFocus
              value={form.group_client_name}
              onChange={set('group_client_name')}
              list="fc-edit-existing-group-clients"
              placeholder="e.g. Marc Kelly"
              style={inputStyle}
            />
            <datalist id="fc-edit-existing-group-clients">
              {existingGroupClients.map(c => <option key={c} value={c} />)}
            </datalist>
          </Field>
          <Field label="Client (Athena record)">
            <ClientPicker
              value={{ client_entity_id: form.client_entity_id, client_name: form.client_name }}
              onChange={(v) => setForm(prev => ({ ...prev, ...v }))}
            />
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
          <Field label="Currency">
            <select value={form.currency} onChange={set('currency')} style={{ ...inputStyle, padding: '6px' }}>
              {CURRENCIES.map(c => <option key={c.code} value={c.code}>{c.label}</option>)}
            </select>
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

function Tabs({ tab, setTab, tabs }) {
  return (
    <div style={{ display: 'flex', gap: 4, borderBottom: `1px solid ${colors.border}`, flexWrap: 'wrap' }}>
      {tabs.map(t => (
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
