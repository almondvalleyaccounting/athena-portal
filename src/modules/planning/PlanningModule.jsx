import React, { useState, useEffect, useMemo, createContext, useContext } from 'react';
import { Routes, Route, Navigate, NavLink, useNavigate } from 'react-router-dom';
import {
  listScenarios, createScenario, updateScenario, setActiveScenario, deleteScenario,
  loadStaffLines, upsertStaffLine, deleteStaffLine,
  loadOverheadLines, upsertOverheadLine, deleteOverheadLine,
  loadBaseMonthlyRevenue, loadStaffProfiles, pullQboPL, seedScenarioFromCurrent, loadCachedPL,
} from './lib/queries';
import { buildProjection, fmtGBP, fmtPct } from './lib/projection';
import DashboardView from './views/DashboardView';
import StaffView from './views/StaffView';
import OverheadsView from './views/OverheadsView';
import AssumptionsView from './views/AssumptionsView';

const PlanningCtx = createContext(null);
export const usePlanning = () => useContext(PlanningCtx);

export default function PlanningModule() {
  const [scenarios, setScenarios] = useState([]);
  const [scenarioId, setScenarioId] = useState(null);
  const [staffLines, setStaffLines] = useState([]);
  const [overheadLines, setOverheadLines] = useState([]);
  const [baseRevenue, setBaseRevenue] = useState({ monthly: 0, count: 0 });
  const [staffProfiles, setStaffProfiles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);

  const scenario = scenarios.find((s) => s.id === scenarioId) || null;

  useEffect(() => { bootstrap(); }, []);

  async function bootstrap() {
    setLoading(true);
    try {
      const [scs, base, staff] = await Promise.all([
        listScenarios(),
        loadBaseMonthlyRevenue(),
        loadStaffProfiles(),
      ]);
      setBaseRevenue(base);
      setStaffProfiles(staff);

      let list = scs;
      let active = list.find((s) => s.is_active) || list[0];
      if (!active) {
        active = await createScenario('Baseline');
        list = await listScenarios();
        await seedScenarioFromCurrent(active.id);
      }
      setScenarios(list);
      setScenarioId(active.id);
    } catch (e) {
      console.error('[Planning] bootstrap error:', e);
      setErr(e.message);
    }
    setLoading(false);
  }

  useEffect(() => {
    if (!scenarioId) return;
    (async () => {
      try {
        const [s, o] = await Promise.all([loadStaffLines(scenarioId), loadOverheadLines(scenarioId)]);
        setStaffLines(s);
        setOverheadLines(o);
      } catch (e) { console.error(e); }
    })();
  }, [scenarioId]);

  const projection = useMemo(() => {
    if (!scenario) return { months: [], totals: {} };
    return buildProjection({
      scenario,
      staffLines,
      overheadLines,
      baseMonthlyRevenue: baseRevenue.monthly,
      horizonMonths: 24,
    });
  }, [scenario, staffLines, overheadLines, baseRevenue.monthly]);

  const refreshStaff = async () => setStaffLines(await loadStaffLines(scenarioId));
  const refreshOverheads = async () => setOverheadLines(await loadOverheadLines(scenarioId));
  const refreshScenarios = async () => setScenarios(await listScenarios());

  const ctxValue = {
    scenarios, scenario, scenarioId, setScenarioId,
    staffLines, overheadLines, baseRevenue, staffProfiles, projection,
    refreshStaff, refreshOverheads, refreshScenarios,
    // Actions
    createScenario: async (name) => {
      const s = await createScenario(name);
      await seedScenarioFromCurrent(s.id);
      await refreshScenarios();
      setScenarioId(s.id);
      setStaffLines(await loadStaffLines(s.id));
      setOverheadLines(await loadOverheadLines(s.id));
    },
    updateScenario: async (patch) => {
      await updateScenario(scenarioId, patch);
      await refreshScenarios();
    },
    setActive: async (id) => { await setActiveScenario(id); await refreshScenarios(); setScenarioId(id); },
    removeScenario: async (id) => { await deleteScenario(id); await refreshScenarios(); },
    upsertStaff: async (line) => { await upsertStaffLine({ ...line, scenario_id: scenarioId }); await refreshStaff(); },
    removeStaff: async (id) => { await deleteStaffLine(id); await refreshStaff(); },
    upsertOverhead: async (line) => { await upsertOverheadLine({ ...line, scenario_id: scenarioId }); await refreshOverheads(); },
    removeOverhead: async (id) => { await deleteOverheadLine(id); await refreshOverheads(); },
    pullQboPL, loadCachedPL,
  };

  if (loading) return <div style={{ padding: 40, textAlign: 'center', color: '#94a3b8', fontFamily: "'Outfit', sans-serif" }}>Loading planning…</div>;
  if (err) return <div style={{ padding: 40, color: '#dc2626', fontFamily: "'Outfit', sans-serif" }}>Error: {err}</div>;

  return (
    <PlanningCtx.Provider value={ctxValue}>
      <div style={{ maxWidth: 1200, margin: '0 auto', padding: '28px 24px', fontFamily: "'Outfit', sans-serif" }}>
        <Header />
        <Tabs />
        <Routes>
          <Route index element={<DashboardView />} />
          <Route path="staff" element={<StaffView />} />
          <Route path="overheads" element={<OverheadsView />} />
          <Route path="assumptions" element={<AssumptionsView />} />
          <Route path="*" element={<Navigate to="." replace />} />
        </Routes>
      </div>
    </PlanningCtx.Provider>
  );
}

function Header() {
  const { scenarios, scenario, setActive, createScenario, projection, baseRevenue } = usePlanning();
  const [showNew, setShowNew] = useState(false);
  const [newName, setNewName] = useState('');

  const year1 = projection.months.slice(0, 12).reduce((acc, m) => {
    acc.revenue += m.revenue; acc.staffCost += m.staffCost; acc.overheads += m.overheads; acc.profit += m.profit;
    return acc;
  }, { revenue: 0, staffCost: 0, overheads: 0, profit: 0 });

  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20, gap: 20, flexWrap: 'wrap' }}>
      <div>
        <h1 style={{ fontFamily: "'Playfair Display', serif", fontSize: 28, fontWeight: 500, color: '#0f172a', margin: 0 }}>
          Practice Planning
        </h1>
        <p style={{ fontSize: 13, color: '#64748b', margin: '4px 0 0' }}>
          Live recurring fees · {fmtGBP(baseRevenue.monthly * 12)}/yr from {baseRevenue.count} clients
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
        <button
          onClick={() => setShowNew(true)}
          style={{ padding: '8px 12px', fontSize: 13, fontWeight: 600, background: '#0f172a', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontFamily: "'Outfit', sans-serif" }}
        >
          + New scenario
        </button>
      </div>

      {/* Year 1 strip */}
      <div style={{ width: '100%', display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginTop: 4 }}>
        <Stat label="Year 1 revenue" value={fmtGBP(year1.revenue)} colour="#0e7fe0" />
        <Stat label="Year 1 staff cost" value={fmtGBP(year1.staffCost)} colour="#7c3aed" />
        <Stat label="Year 1 overheads" value={fmtGBP(year1.overheads)} colour="#f59e0b" />
        <Stat label="Year 1 profit" value={fmtGBP(year1.profit)} sub={fmtPct(year1.revenue > 0 ? year1.profit / year1.revenue : 0) + ' margin'} colour={year1.profit >= 0 ? '#059669' : '#dc2626'} />
      </div>

      {showNew && (
        <div onClick={() => setShowNew(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: '#fff', borderRadius: 16, padding: 28, maxWidth: 440, width: '100%' }}>
            <h2 style={{ fontFamily: "'Playfair Display', serif", fontSize: 20, fontWeight: 500, color: '#0f172a', margin: '0 0 12px' }}>New scenario</h2>
            <p style={{ fontSize: 13, color: '#64748b', marginBottom: 14 }}>Starts as a copy of current staff list + QBO overheads. Change levers to model different futures.</p>
            <input
              autoFocus value={newName} onChange={(e) => setNewName(e.target.value)}
              placeholder="e.g. Ambitious hiring plan"
              style={{ width: '100%', padding: '10px 12px', fontSize: 14, border: '1px solid #e5e7eb', borderRadius: 8, marginBottom: 14, boxSizing: 'border-box', fontFamily: "'Outfit', sans-serif" }}
            />
            <div style={{ display: 'flex', gap: 10 }}>
              <button onClick={() => setShowNew(false)} style={{ flex: 1, padding: '10px', fontSize: 13, fontWeight: 600, background: '#fff', color: '#0f172a', border: '1px solid #e5e7eb', borderRadius: 8, cursor: 'pointer', fontFamily: "'Outfit', sans-serif" }}>Cancel</button>
              <button
                onClick={async () => {
                  if (!newName.trim()) return;
                  await createScenario(newName.trim());
                  setNewName('');
                  setShowNew(false);
                }}
                style={{ flex: 1, padding: '10px', fontSize: 13, fontWeight: 600, background: '#0f172a', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontFamily: "'Outfit', sans-serif" }}
              >
                Create
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, sub, colour }) {
  return (
    <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: '14px 16px', borderLeft: `3px solid ${colour}` }}>
      <div style={{ fontSize: 10, fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 700, color: '#0f172a', marginTop: 2 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function Tabs() {
  const tabs = [
    { to: '', label: 'Dashboard', end: true },
    { to: 'staff', label: 'Staff' },
    { to: 'overheads', label: 'Overheads' },
    { to: 'assumptions', label: 'Assumptions' },
  ];
  return (
    <div style={{ display: 'flex', gap: 2, borderBottom: '1px solid #e5e7eb', marginBottom: 20 }}>
      {tabs.map((t) => (
        <NavLink
          key={t.to}
          to={t.to}
          end={t.end}
          style={({ isActive }) => ({
            padding: '10px 16px', fontSize: 13, fontWeight: isActive ? 600 : 400,
            color: isActive ? '#0f172a' : '#94a3b8',
            borderBottom: isActive ? '2px solid #38bdf8' : '2px solid transparent',
            textDecoration: 'none', fontFamily: "'Outfit', sans-serif",
          })}
        >
          {t.label}
        </NavLink>
      ))}
    </div>
  );
}
