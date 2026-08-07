import React, { useState, useEffect, useMemo, createContext, useContext } from 'react';
import { Routes, Route, Navigate, NavLink } from 'react-router-dom';
import {
  listScenarios, createScenario, duplicateScenario, updateScenario, setActiveScenario, deleteScenario,
  loadStaffLines, upsertStaffLine, deleteStaffLine,
  loadOverheadLines, upsertOverheadLine, deleteOverheadLine,
  loadOwnerCompLines, upsertOwnerCompLine, deleteOwnerCompLine,
  loadClientOverrides, upsertClientOverride, deleteClientOverride,
  loadClientBillings, loadStaffProfiles, pullQboPL, pullQboMonthly, seedScenarioFromCurrent,
  loadTimesheetLTM, loadQuotePipeline, loadMonthlyActuals,
} from './lib/queries';
import { buildProjection, computePipelineContribution, fmtGBP, fmtPct } from './lib/projection';

import BaselineView from './views/BaselineView';
import OverviewView from './views/OverviewView';
import RevenueView from './views/RevenueView';
import StaffView from './views/StaffView';
import OwnerCompView from './views/OwnerCompView';
import OverheadsView from './views/OverheadsView';
import ScenariosView from './views/ScenariosView';
import UnbilledView from './views/UnbilledView';
import ProfitabilityView from './views/ProfitabilityView';

const PlanningCtx = createContext(null);
export const usePlanning = () => useContext(PlanningCtx);

export default function PlanningModule() {
  const [scenarios, setScenarios] = useState([]);
  const [scenarioId, setScenarioId] = useState(null);
  const [staffLines, setStaffLines] = useState([]);
  const [overheadLines, setOverheadLines] = useState([]);
  const [ownerCompLines, setOwnerCompLines] = useState([]);
  const [clientOverrides, setClientOverrides] = useState([]);
  const [clientBillings, setClientBillings] = useState([]);
  const [staffProfiles, setStaffProfiles] = useState([]);
  const [timesheetEntries, setTimesheetEntries] = useState([]);
  const [quotePipeline, setQuotePipeline] = useState([]);
  const [monthlyActuals, setMonthlyActuals] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);

  const scenario = scenarios.find((s) => s.id === scenarioId) || null;

  useEffect(() => { bootstrap(); }, []);

  async function bootstrap() {
    setLoading(true);
    try {
      const [scs, billings, staff, ts, pipeline, actuals] = await Promise.all([
        listScenarios(), loadClientBillings(), loadStaffProfiles(),
        loadTimesheetLTM().catch(() => []),
        loadQuotePipeline().catch(() => []),
        loadMonthlyActuals().catch(() => []),
      ]);
      setClientBillings(billings);
      setStaffProfiles(staff);
      setTimesheetEntries(ts);
      setQuotePipeline(pipeline);
      setMonthlyActuals(actuals);

      let list = scs;
      let active = list.find((s) => s.is_active) || list[0];
      if (!active) {
        // First-time setup: seed three scenarios so the CFO has comparison baked in.
        const base = await createScenario('Base case');
        await seedScenarioFromCurrent(base.id);
        await updateScenario(base.id, {
          fee_uplift_pct: 5, pay_rise_pct: 4, churn_pct_annual: 5, new_mrr_per_month: 1500, ad_hoc_pct_of_recurring: 10,
        });
        const upside = await duplicateScenario(base.id, 'Upside');
        await updateScenario(upside.id, {
          fee_uplift_pct: 10, pay_rise_pct: 4, churn_pct_annual: 3, new_mrr_per_month: 3000, ad_hoc_pct_of_recurring: 15,
        });
        const downside = await duplicateScenario(base.id, 'Downside');
        await updateScenario(downside.id, {
          fee_uplift_pct: 2, pay_rise_pct: 5, churn_pct_annual: 10, new_mrr_per_month: 500, ad_hoc_pct_of_recurring: 7,
        });
        list = await listScenarios();
        active = list.find((s) => s.name === 'Base case') || list[0];
      }

      // Rolling forecast: if active scenario's start_month is in the past, roll it forward
      // to the current month so the forecast always looks 24 months out from today.
      const thisMonth = new Date().toISOString().slice(0, 7) + '-01';
      if (active?.start_month && active.start_month < thisMonth) {
        await updateScenario(active.id, { start_month: thisMonth });
        list = await listScenarios();
        active = list.find((s) => s.id === active.id) || active;
      }

      setScenarios(list);
      setScenarioId(active.id);
    } catch (e) {
      console.error('[Planning] bootstrap error:', e);
      setErr(e.message);
    }
    setLoading(false);
  }

  // Load per-scenario data whenever the active scenario changes.
  // Use a request id to ignore stale loads if user switches scenarios rapidly.
  useEffect(() => {
    if (!scenarioId) return;
    let cancelled = false;
    (async () => {
      try {
        const [s, o, oc, co] = await Promise.all([
          loadStaffLines(scenarioId),
          loadOverheadLines(scenarioId),
          loadOwnerCompLines(scenarioId),
          loadClientOverrides(scenarioId),
        ]);
        if (cancelled) return;
        setStaffLines(s); setOverheadLines(o);
        setOwnerCompLines(oc); setClientOverrides(co);
      } catch (e) { console.error(e); }
    })();
    return () => { cancelled = true; };
  }, [scenarioId]);

  // Base projection without pipeline — used to compute pipeline month alignment
  const monthsScaffold = useMemo(() => buildProjection({
    scenario, staffLines: [], overheadLines: [], ownerCompLines: [], clientBillings: [], clientOverrides: [], horizonMonths: 24,
  }).months, [scenario]);

  const pipelineResult = useMemo(
    () => computePipelineContribution({ quotes: quotePipeline, scenario, months: monthsScaffold }),
    [quotePipeline, scenario, monthsScaffold]
  );
  const pipelineMrrByMonth = useMemo(() => {
    if (!scenario?.pipeline_mrr_override_enabled) return null;
    const m = new Map();
    for (const r of pipelineResult.perMonth) m.set(r.index, r.pipeline_mrr);
    return m;
  }, [pipelineResult, scenario?.pipeline_mrr_override_enabled]);

  const projection = useMemo(() => buildProjection({
    scenario,
    staffLines,
    overheadLines,
    ownerCompLines,
    clientBillings,
    clientOverrides,
    monthlyActuals,
    pipelineMrrByMonth,
    horizonMonths: 24,
  }), [scenario, staffLines, overheadLines, ownerCompLines, clientBillings, clientOverrides, monthlyActuals, pipelineMrrByMonth]);

  // Derived: all scenarios' projections (for scenario comparison)
  const allProjections = useMemo(() => {
    // Shallow — only the active scenario has its full set loaded. For comparison,
    // we compute per-scenario by loading on demand in ScenariosView instead.
    return null;
  }, []);

  const refresh = async () => {
    if (!scenarioId) return;
    const [s, o, oc, co] = await Promise.all([
      loadStaffLines(scenarioId), loadOverheadLines(scenarioId),
      loadOwnerCompLines(scenarioId), loadClientOverrides(scenarioId),
    ]);
    setStaffLines(s); setOverheadLines(o); setOwnerCompLines(oc); setClientOverrides(co);
  };
  const refreshScenarios = async () => setScenarios(await listScenarios());

  const refreshActuals = async () => {
    try { setMonthlyActuals(await loadMonthlyActuals()); } catch (e) { console.error(e); }
  };

  const ctxValue = {
    scenarios, scenario, scenarioId, setScenarioId,
    staffLines, overheadLines, ownerCompLines, clientOverrides, clientBillings,
    staffProfiles, timesheetEntries, quotePipeline, monthlyActuals,
    projection, pipelineResult, allProjections,
    pullQboMonthly: async (n = 12) => { const r = await pullQboMonthly(n); await refreshActuals(); return r; },

    // Scenario actions
    createScenario: async (name) => {
      const s = await createScenario(name);
      await seedScenarioFromCurrent(s.id);
      await refreshScenarios();
      setScenarioId(s.id);
    },
    duplicateScenario: async (sourceId, name) => {
      const s = await duplicateScenario(sourceId, name);
      await refreshScenarios();
      return s.id;
    },
    updateScenario: async (patch) => { await updateScenario(scenarioId, patch); await refreshScenarios(); },
    setActive: async (id) => { await setActiveScenario(id); await refreshScenarios(); setScenarioId(id); },
    removeScenario: async (id) => {
      await deleteScenario(id); await refreshScenarios();
      if (id === scenarioId) {
        const remaining = await listScenarios();
        setScenarioId(remaining[0]?.id || null);
      }
    },

    // Line-item actions
    upsertStaff: async (line) => { await upsertStaffLine({ ...line, scenario_id: scenarioId }); await refresh(); },
    removeStaff: async (id) => { await deleteStaffLine(id); await refresh(); },
    upsertOverhead: async (line) => { await upsertOverheadLine({ ...line, scenario_id: scenarioId }); await refresh(); },
    removeOverhead: async (id) => { await deleteOverheadLine(id); await refresh(); },
    upsertOwnerComp: async (line) => { await upsertOwnerCompLine({ ...line, scenario_id: scenarioId }); await refresh(); },
    removeOwnerComp: async (id) => { await deleteOwnerCompLine(id); await refresh(); },
    upsertClientOverride: async (row) => { await upsertClientOverride({ ...row, scenario_id: scenarioId }); await refresh(); },
    removeClientOverride: async (id) => { await deleteClientOverride(id); await refresh(); },

    pullQboPL,
  };

  if (loading) {
    return <div style={{ padding: 40, textAlign: 'center', color: '#94a3b8', fontFamily: "'Outfit', sans-serif" }}>Loading planning…</div>;
  }
  if (err) {
    return <div style={{ padding: 40, color: '#dc2626', fontFamily: "'Outfit', sans-serif" }}>Error: {err}</div>;
  }

  return (
    <PlanningCtx.Provider value={ctxValue}>
      <div style={{ maxWidth: 1240, margin: '0 auto', padding: '24px 24px 60px', fontFamily: "'Outfit', sans-serif" }}>
        <Header />
        <Tabs />
        <Routes>
          {/* Baseline lands first on purpose: the trust layer decides
              whether the rest of the module is worth reading today. */}
          <Route index element={<BaselineView />} />
          <Route path="overview" element={<OverviewView />} />
          <Route path="revenue" element={<RevenueView />} />
          <Route path="staff" element={<StaffView />} />
          <Route path="owner" element={<OwnerCompView />} />
          <Route path="overheads" element={<OverheadsView />} />
          <Route path="profitability" element={<ProfitabilityView />} />
          <Route path="unbilled" element={<UnbilledView />} />
          <Route path="scenarios" element={<ScenariosView />} />
          <Route path="*" element={<Navigate to="." replace />} />
        </Routes>
      </div>
    </PlanningCtx.Provider>
  );
}

function Header() {
  const { scenarios, scenario, setActive, createScenario, duplicateScenario, setScenarioId, projection } = usePlanning();
  const [showNew, setShowNew] = useState(false);
  const [newName, setNewName] = useState('');
  const [duplicate, setDuplicate] = useState(false);

  const y1 = projection.y1;
  const y2 = projection.y2;

  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ fontFamily: "'Playfair Display', serif", fontSize: 28, fontWeight: 500, color: '#0f172a', margin: 0 }}>
            Practice Planning
          </h1>
          <p style={{ fontSize: 12, color: '#64748b', margin: '4px 0 0' }}>
            24-month forecast · {scenarios.length} scenario{scenarios.length !== 1 ? 's' : ''}
          </p>
        </div>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <label style={{ fontSize: 11, fontWeight: 600, color: '#64748b', textTransform: 'uppercase' }}>Scenario</label>
          <select
            value={scenario?.id || ''}
            onChange={(e) => setActive(e.target.value)}
            style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid #e5e7eb', fontSize: 13, fontFamily: "'Outfit', sans-serif", background: '#fff', minWidth: 200 }}
          >
            {scenarios.map((s) => (
              <option key={s.id} value={s.id}>{s.name}{s.is_active ? ' ★' : ''}</option>
            ))}
          </select>
          <button onClick={() => { setDuplicate(false); setNewName(''); setShowNew(true); }} style={btnDark}>+ New</button>
          <button onClick={() => { setDuplicate(true); setNewName(`${scenario?.name || 'Scenario'} copy`); setShowNew(true); }} style={btnOutline}>Duplicate</button>
        </div>
      </div>

      {showNew && (
        <div onClick={() => setShowNew(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: '#fff', borderRadius: 16, padding: 28, maxWidth: 440, width: '100%' }}>
            <h2 style={{ fontFamily: "'Playfair Display', serif", fontSize: 20, fontWeight: 500, color: '#0f172a', margin: '0 0 10px' }}>
              {duplicate ? 'Duplicate scenario' : 'New scenario'}
            </h2>
            <p style={{ fontSize: 12, color: '#64748b', marginBottom: 14 }}>
              {duplicate
                ? 'Creates a new scenario with all of the current one\'s lines and assumptions. Edit the copy to model a variant.'
                : 'New scenario will be seeded with your current staff list and last-12-months QBO overheads.'}
            </p>
            <input autoFocus value={newName} onChange={(e) => setNewName(e.target.value)}
              placeholder={duplicate ? '' : 'e.g. Aggressive hiring plan'}
              style={modalInput} />
            <div style={{ display: 'flex', gap: 10 }}>
              <button onClick={() => setShowNew(false)} style={{ ...btnOutline, flex: 1, justifyContent: 'center' }}>Cancel</button>
              <button
                onClick={async () => {
                  if (!newName.trim()) return;
                  if (duplicate && scenario) {
                    const newId = await duplicateScenario(scenario.id, newName.trim());
                    setScenarioId(newId);
                  } else {
                    await createScenario(newName.trim());
                  }
                  setShowNew(false);
                }}
                style={{ ...btnDark, flex: 1, justifyContent: 'center' }}
              >
                {duplicate ? 'Duplicate' : 'Create'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Tabs() {
  // Absolute paths — relative paths stack on top of the current URL in v6.
  const tabs = [
    { to: '/planning', label: 'Baseline', end: true },
    { to: '/planning/overview', label: 'Overview' },
    { to: '/planning/revenue', label: 'Revenue & clients' },
    { to: '/planning/staff', label: 'Staff' },
    { to: '/planning/owner', label: 'Owner comp' },
    { to: '/planning/overheads', label: 'Overheads' },
    { to: '/planning/profitability', label: 'Profitability' },
    { to: '/planning/unbilled', label: 'Unbilled QBO' },
    { to: '/planning/scenarios', label: 'Scenarios' },
  ];
  return (
    <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid #e5e7eb', marginBottom: 20, overflowX: 'auto' }}>
      {tabs.map((t) => (
        <NavLink
          key={t.to}
          to={t.to}
          end={t.end}
          style={({ isActive }) => ({
            padding: '10px 14px', fontSize: 13, fontWeight: isActive ? 600 : 400,
            color: isActive ? '#0f172a' : '#94a3b8',
            borderBottom: isActive ? '2px solid #0e7fe0' : '2px solid transparent',
            textDecoration: 'none', fontFamily: "'Outfit', sans-serif",
            whiteSpace: 'nowrap',
          })}
        >
          {t.label}
        </NavLink>
      ))}
    </div>
  );
}

const btnDark = { display: 'inline-flex', alignItems: 'center', gap: 5, padding: '8px 14px', fontSize: 13, fontWeight: 600, background: '#0f172a', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontFamily: "'Outfit', sans-serif" };
const btnOutline = { display: 'inline-flex', alignItems: 'center', gap: 5, padding: '8px 14px', fontSize: 13, fontWeight: 600, background: '#fff', color: '#0f172a', border: '1px solid #e5e7eb', borderRadius: 8, cursor: 'pointer', fontFamily: "'Outfit', sans-serif" };
const modalInput = { width: '100%', padding: '10px 12px', fontSize: 14, border: '1px solid #e5e7eb', borderRadius: 8, marginBottom: 14, boxSizing: 'border-box', fontFamily: "'Outfit', sans-serif" };
