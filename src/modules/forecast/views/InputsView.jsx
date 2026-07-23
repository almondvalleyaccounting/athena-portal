import React, { useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '../../../lib/supabase';
import {
  listEntities, upsertEntity, deleteEntity, listLaCouncils,
  loadScenarioDrivers, upsertDriver, setDriverValue, deleteDriver, updateDriver,
  copyEntity,
  seedPackDefaults,
  createGroup, deleteGroup, assignEntityToGroup,
  saveNurseryDefaults, loadNurseryDefaults, clearNurseryDefaults,
} from '../lib/queries';
import { modulesFor } from '../lib/packs';
import { btnDark, btnGhost, btnOutline, colors, fontStack, H2, inputStyle, Pill, Section, selectStyle, serifStack } from '../components/ui';
import LoansPanel from './LoansPanel';

// Display label override for module-driver tabs. The module's `key` is used
// internally; this map keeps the UI human-readable.
const MODULE_LABELS = {
  locations: 'Pipeline',
  services_childcare: 'Services',
  staff: 'Staff',
  premises: 'Premises',
  overheads: 'Overheads',
  pre_opening: 'Pre-opening',
  fixed_assets: 'Fixed assets',
  loans: 'Loans',
  working_capital: 'Working capital',
  tax_simple: 'Tax',
  financial_core: 'Financials core',
  exit_valuation: 'Exit valuation',
};

// Per-tab semantic filters. Each spec: { label, options: [{ value, label }], match(value) -> driver-predicate }
const TAB_FILTERS = {
  services_childcare: {
    label: 'Age band',
    options: [
      { value: 'all', label: 'All bands' },
      { value: 'babies', label: '0-2' },
      { value: 'twos', label: '2-3' },
      { value: 'three_to_five', label: '3-5' },
      { value: 'after_school', label: 'After-school' },
    ],
    match: (band) => (d) => d.driver_key.endsWith('.' + band),
  },
  staff: {
    label: 'Driver group',
    options: [
      { value: 'all', label: 'All' },
      { value: 'ratios', label: 'Statutory ratios' },
      { value: 'mix', label: 'Direct mix + age-band split' },
      { value: 'salaries', label: 'Salaries' },
      { value: 'headcount', label: 'Headcount' },
      { value: 'on_costs', label: 'On-costs (NI / pension)' },
      { value: 'workforce', label: 'Workforce / cover' },
      { value: 'inclusion', label: 'Ratio inclusion flags' },
    ],
    match: (g) => (d) => {
      if (g === 'ratios')    return d.driver_key.startsWith('ratio.') && !d.driver_key.startsWith('ratio_inclusion.');
      if (g === 'mix')       return d.driver_key.startsWith('direct_mix.') || d.driver_key.startsWith('nmw_mix.');
      if (g === 'salaries')  return d.driver_key.startsWith('base_salary_p.') || d.driver_key === 'real_living_wage_hourly_p';
      if (g === 'headcount') return d.driver_key.startsWith('headcount.');
      if (g === 'on_costs')  return d.driver_key === 'employer_ni_pct' || d.driver_key === 'employer_pension_pct' || d.driver_key === 'employment_allowance_p';
      if (g === 'workforce') return d.driver_key === 'vacancy_rate_pct' || d.driver_key === 'agency_premium_pct' || d.driver_key === 'standard_hours_per_year';
      if (g === 'inclusion') return d.driver_key.startsWith('ratio_inclusion.');
      return true;
    },
  },
  premises: {
    label: 'Mode',
    options: [
      { value: 'all', label: 'All premises drivers' },
      { value: 'lease', label: 'Lease (rent / service charge)' },
      { value: 'buy', label: 'Buy (purchase / mortgage / NDR)' },
    ],
    match: (m) => (d) => {
      const leaseKeys = ['premises.rent_monthly_p', 'premises.service_charge_monthly_p'];
      if (m === 'lease') return leaseKeys.includes(d.driver_key);
      if (m === 'buy') return !leaseKeys.includes(d.driver_key);
      return true;
    },
  },
  pre_opening: {
    label: 'Cost type',
    options: [
      { value: 'all', label: 'All pre-opening' },
      { value: 'overhead', label: 'Overhead' },
      { value: 'staffing', label: 'Staffing' },
      { value: 'marketing', label: 'Marketing' },
    ],
    match: (k) => (d) => {
      if (k === 'overhead') return d.driver_key.includes('monthly_overhead') || d.driver_key.includes('registration_lead');
      if (k === 'staffing') return d.driver_key.includes('staffing');
      if (k === 'marketing') return d.driver_key.includes('marketing');
      return true;
    },
  },
  overheads: {
    label: 'Scope',
    options: [
      { value: 'all', label: 'All overheads' },
      { value: 'site', label: 'Site-level (per location)' },
      { value: 'central', label: 'Central / group' },
    ],
    match: (s) => (d) => s === 'central' ? !d.entity_id : !!d.entity_id,
  },
};

export default function InputsView({
  forecast, scenario,
  entities = [], groups = [], assignments = [],
  onEntitiesChanged, onGroupsChanged,
  onChanged,
}) {
  const [councils, setCouncils] = useState([]);
  const [drivers, setDrivers] = useState([]);
  const [values, setValues] = useState([]);
  const [busy, setBusy] = useState(false);
  const [editingEntity, setEditingEntity] = useState(null);
  const [activeModuleKey, setActiveModuleKey] = useState(null);

  const modules = useMemo(() => {
    // Hide modules that declare no drivers (e.g. locations, whose
    // assumptions live in entity.config and are edited above).
    return modulesFor(forecast.vertical_pack).filter(m => (m.drivers || []).length > 0);
  }, [forecast.vertical_pack]);

  useEffect(() => { reload(); }, [forecast?.id, scenario?.id]);

  async function reload() {
    if (!forecast?.id || !scenario?.id) return;
    const [cs, dv] = await Promise.all([
      listLaCouncils(),
      loadScenarioDrivers(scenario.id),
    ]);
    setCouncils(cs);
    setDrivers(dv.drivers); setValues(dv.values);
    if (!activeModuleKey && modules[0]) setActiveModuleKey(modules[0].key);
  }

  const onSeedDefaults = async () => {
    setBusy(true);
    try {
      const r = await seedPackDefaults({ scenario_id: scenario.id, modules, entities, vertical_pack: forecast.vertical_pack });
      await reload();
      onChanged?.();
      if (r.valued === 0 && r.skipped > 0) {
        alert(`No new values needed — all ${r.skipped} existing assumptions kept.`);
      } else if (r.valued > 0) {
        alert(`Filled ${r.valued} missing default${r.valued !== 1 ? 's' : ''}; preserved ${r.skipped} existing value${r.skipped !== 1 ? 's' : ''}.`);
      }
    } catch (e) { alert(e.message); }
    setBusy(false);
  };

  const onSaveNurseryDefaults = async () => {
    if (entities.length === 0) {
      alert('Add at least one location first; the first location\'s settings are saved as the new-nursery template.');
      return;
    }
    if (!confirm('Save the current scenario\'s assumptions as the default for new nurseries?\n\nGroup-level driver values + the first location\'s config will be remembered (in this browser) and applied when seeding new scenarios or new locations.')) return;
    setBusy(true);
    try {
      await saveNurseryDefaults({
        scenario_id: scenario.id,
        vertical_pack: forecast.vertical_pack,
        sample_entity_id: entities[0].id,
      });
      alert('Saved. Future "Fill missing defaults" runs and new locations will use these values.');
    } catch (e) { alert(e.message); }
    setBusy(false);
  };

  const onClearNurseryDefaults = () => {
    if (!confirm('Clear saved nursery defaults? Future seeds will fall back to the built-in pack defaults.')) return;
    clearNurseryDefaults(forecast.vertical_pack);
    alert('Cleared.');
  };

  const hasNurseryDefaults = !!loadNurseryDefaults(forecast.vertical_pack);

  const onResetDefaults = async () => {
    if (!confirm('Reset ALL drivers in this scenario to their pack defaults? Your existing assumptions will be overwritten.')) return;
    setBusy(true);
    try {
      const r = await seedPackDefaults({ scenario_id: scenario.id, modules, entities, overwrite: true, vertical_pack: forecast.vertical_pack });
      await reload();
      onChanged?.();
      alert(`Reset ${r.valued} value${r.valued !== 1 ? 's' : ''} to defaults.`);
    } catch (e) { alert(e.message); }
    setBusy(false);
  };

  const onAddGroup = async () => {
    const label = prompt('Group name? (e.g. Confirmed, In progress, Possible)');
    if (!label?.trim()) return;
    try {
      await createGroup(forecast.id, label.trim());
      onGroupsChanged?.();
    } catch (e) { alert(e.message); }
  };

  const onDeleteGroup = async (id) => {
    if (!confirm('Delete this group? Locations assigned to it will be unassigned.')) return;
    try {
      await deleteGroup(id);
      onGroupsChanged?.();
    } catch (e) { alert(e.message); }
  };

  const onSetEntityGroup = async (entity_id, group_value_id) => {
    try {
      await assignEntityToGroup(entity_id, group_value_id || null);
      onGroupsChanged?.();
    } catch (e) { alert(e.message); }
  };

  const groupForEntity = (entity_id) => {
    const a = assignments.find(x => x.entity_id === entity_id);
    return a?.dimension_value_id || '';
  };

  // Money is stored as integer pence in the DB; display + edit in pounds.
  const isMoneyUnit = (u) => u === 'gbp_p';
  const toDisplay = (v, unit) => {
    if (v == null || v === '') return '';
    return isMoneyUnit(unit) ? (Number(v) / 100) : v;
  };
  const fromDisplay = (raw, unit) => {
    if (raw === '' || raw == null) return null;
    const num = Number(raw);
    if (Number.isNaN(num)) return null;
    return isMoneyUnit(unit) ? Math.round(num * 100) : num;
  };

  const valueOf = (driverId, period = -1) => {
    const v = values.find(v => v.driver_id === driverId && v.period === period);
    return v?.value ?? '';
  };

  const onChangeValue = async (driverId, period, raw, unit) => {
    const num = fromDisplay(raw, unit);
    if (num == null) return;
    await setDriverValue(driverId, period, num);
    setValues(prev => {
      const i = prev.findIndex(v => v.driver_id === driverId && v.period === period);
      if (i >= 0) { const c = [...prev]; c[i] = { ...c[i], value: num }; return c; }
      return [...prev, { driver_id: driverId, period, value: num }];
    });
  };

  const [filterEntity, setFilterEntity] = useState('all');         // 'all' | 'group' | entity_id
  const [filterUnit, setFilterUnit] = useState('all');
  const [filterSearch, setFilterSearch] = useState('');
  // Locations section starts expanded and stays that way unless the user
  // hits "Hide" — no auto-collapse / auto-expand.
  const [locationsExpanded, setLocationsExpanded] = useState(true);
  const [addingDriver, setAddingDriver] = useState(false);
  const [compact, setCompact] = useState(true);
  const [tabFilter, setTabFilter] = useState({});                   // per-module: { module_key: 'value' }
  const driversAnchorRef = useRef(null);
  const initialModuleSetRef = useRef(false);

  // Smooth-scroll the Drivers section into view ONLY when the user actively
  // switches between driver tabs — not on initial mount. Landing on Inputs
  // should leave the user at the top of the page (Locations section).
  useEffect(() => {
    if (!activeModuleKey) return;
    if (!initialModuleSetRef.current) {
      // First module assignment after load — skip the scroll.
      initialModuleSetRef.current = true;
      return;
    }
    if (driversAnchorRef.current) {
      driversAnchorRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [activeModuleKey]);

  const tabFilterSpec = TAB_FILTERS[activeModuleKey] || null;
  const tabFilterValue = tabFilter[activeModuleKey] || 'all';

  // Set of driver keys declared by the active module, so we can tell
  // user-added custom drivers apart and offer rename / delete on them.
  const declaredKeys = useMemo(() => {
    const m = modules.find(x => x.key === activeModuleKey);
    return new Set((m?.drivers || []).map(d => d.key));
  }, [modules, activeModuleKey]);

  const onDeleteDriver = async (driver) => {
    if (!confirm(`Delete driver "${driver.label}"?\n\nThis removes the driver row and any value(s) you've set. Re-add it via "+ Add driver" if you change your mind.`)) return;
    try {
      await deleteDriver(driver.id);
      await reload();
      onChanged?.();
    } catch (e) { alert(e.message); }
  };

  const onRenameDriver = async (driver) => {
    const next = prompt('Rename driver', driver.label || '');
    if (next == null) return;
    const trimmed = next.trim();
    if (!trimmed || trimmed === driver.label) return;
    try {
      await updateDriver(driver.id, { label: trimmed });
      await reload();
    } catch (e) { alert(e.message); }
  };

  const moduleDrivers = useMemo(() => {
    if (!activeModuleKey) return [];
    const q = filterSearch.trim().toLowerCase();
    const spec = TAB_FILTERS[activeModuleKey];
    const tabFilterFn = spec && tabFilterValue !== 'all'
      ? spec.match(tabFilterValue)
      : () => true;

    // Use the active module's `drivers` declaration order so the user's
    // requested role-grouped layout (exec → … → apprentice <19) is honoured.
    const activeMod = modules.find(m => m.key === activeModuleKey);
    const orderByKey = new Map();
    (activeMod?.drivers || []).forEach((d, i) => orderByKey.set(d.key, i));

    return drivers.filter(d => {
      if (d.module_key !== activeModuleKey) return false;
      // Hide orphan drivers (DB rows for keys no longer declared by the module).
      // Custom user-added drivers won't have a declared key, but they live in
      // their own module declarations or are intentional one-offs — to allow
      // them, only hide orphans that are *not* in the declared list AND share
      // a prefix with retired keys we know about. Simpler: show all declared
      // keys; for non-declared keys keep them visible too so custom drivers work.
      // (To explicitly retire: call out in the deprecated set below.)
      const RETIRED_KEYS = new Set([
        'launch.greenfield_influx_pct', 'launch.ramp_months',
        // Opening equity is derived from opening cash (financial_core);
        // editing it separately could only unbalance the BS.
        'bs.opening_equity_p',
      ]);
      if (RETIRED_KEYS.has(d.driver_key)) return false;
      if (filterEntity === 'group' && d.entity_id) return false;
      if (filterEntity !== 'all' && filterEntity !== 'group' && d.entity_id !== filterEntity) return false;
      if (filterUnit !== 'all' && d.unit !== filterUnit) return false;
      if (q && !(d.label?.toLowerCase().includes(q) || d.driver_key.toLowerCase().includes(q))) return false;
      if (!tabFilterFn(d)) return false;
      return true;
    }).sort((a, b) => {
      const oa = orderByKey.has(a.driver_key) ? orderByKey.get(a.driver_key) : 9999;
      const ob = orderByKey.has(b.driver_key) ? orderByKey.get(b.driver_key) : 9999;
      if (oa !== ob) return oa - ob;
      // Within same driver key, group entities together
      return (a.entity_id || '').localeCompare(b.entity_id || '');
    });
  }, [drivers, activeModuleKey, filterEntity, filterUnit, filterSearch, tabFilterValue, modules]);

  // Distinct units present in the active module
  const unitOptions = useMemo(() => {
    const s = new Set();
    for (const d of drivers) if (d.module_key === activeModuleKey) s.add(d.unit);
    return Array.from(s).sort();
  }, [drivers, activeModuleKey]);

  return (
    <div>
      <Section
        title={
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
            Locations
            {entities.length > 0 && (
              <span style={{ fontSize: 12, fontWeight: 400, color: colors.muted, fontFamily: fontStack }}>
                · {entities.length} location{entities.length !== 1 ? 's' : ''}
                {entities.length <= 4 && (
                  <span> ({entities.map(e => e.label).join(', ')})</span>
                )}
              </span>
            )}
          </span>
        }
        right={
          <div style={{ display: 'flex', gap: 8 }}>
            {entities.length > 0 && (
              <button onClick={() => setLocationsExpanded(x => !x)} style={btnGhost}>
                {locationsExpanded ? 'Hide' : 'Manage'}
              </button>
            )}
            {(entities.length === 0 || locationsExpanded) && (
              <>
                <button onClick={() => setEditingEntity({})} style={btnDark}>+ Add location</button>
                <button onClick={onSeedDefaults} disabled={busy} style={btnOutline} title="Adds drivers for new locations and fills any missing defaults; preserves your existing values.">
                  {busy ? '…' : 'Fill missing defaults'}
                </button>
                {entities.length > 0 && (
                  <button
                    onClick={onSaveNurseryDefaults}
                    disabled={busy}
                    style={btnOutline}
                    title="Save the current scenario's group assumptions + the first location's config as the template for new nurseries."
                  >
                    {hasNurseryDefaults ? 'Save as defaults ✓' : 'Save as defaults'}
                  </button>
                )}
                {hasNurseryDefaults && (
                  <button
                    onClick={onClearNurseryDefaults}
                    disabled={busy}
                    style={{ ...btnGhost, color: colors.muted }}
                    title="Forget the saved nursery defaults."
                  >
                    Clear defaults
                  </button>
                )}
                {entities.length > 0 && (
                  <button onClick={onResetDefaults} disabled={busy} style={{ ...btnOutline, color: colors.red, borderColor: '#fecaca' }} title="Destructive: overwrites every driver value with the pack default.">
                    Reset all
                  </button>
                )}
              </>
            )}
          </div>
        }
      >
        {entities.length === 0 ? (
          <p style={{ fontSize: 13, color: colors.muted }}>No locations yet. Add one to start populating drivers.</p>
        ) : !locationsExpanded ? null : (
          <div>
          <GroupsPanel groups={groups} onAdd={onAddGroup} onDelete={onDeleteGroup} />
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={th}>Label</th><th style={th}>Group</th><th style={th}>LA</th><th style={th}>Mode</th>
                <th style={th}>Capacity</th><th style={th}>Opens (mo)</th>
                <th style={th}>Acquisition</th><th></th>
              </tr>
            </thead>
            <tbody>
              {entities.map(e => {
                const cap = e.config?.capacity_by_age_band || {};
                const total = (cap.babies || 0) + (cap.twos || 0) + (cap.three_to_five || 0) + (cap.after_school || 0);
                const la = councils.find(c => c.id === e.config?.la_council_id);
                return (
                  <tr key={e.id} style={{ borderBottom: `1px solid ${colors.borderSoft}` }}>
                    <td style={td}><strong>{e.label}</strong></td>
                    <td style={td}>
                      <select
                        value={groupForEntity(e.id)}
                        onChange={(ev) => onSetEntityGroup(e.id, ev.target.value)}
                        style={{ padding: '4px 8px', fontSize: 12, border: `1px solid ${colors.border}`, borderRadius: 6, background: '#fff', fontFamily: fontStack }}
                      >
                        <option value="">—</option>
                        {groups.map(g => <option key={g.id} value={g.id}>{g.label}</option>)}
                      </select>
                    </td>
                    <td style={td}>{la?.name || '—'}</td>
                    <td style={td}><Pill>{e.config?.lease_or_buy || '—'}</Pill></td>
                    <td style={td}>{total}</td>
                    <td style={td}>{e.config?.opening_month_offset ?? 0}</td>
                    <td style={td}>{e.config?.acquisition_type || '—'}</td>
                    <td style={td}>
                      <button onClick={() => setEditingEntity(e)} style={btnGhost}>Edit</button>
                      <button
                        onClick={async () => {
                          if (!confirm(`Copy "${e.label}" as a new location? All assumptions and per-site driver values will be duplicated as a starting point.`)) return;
                          try {
                            await copyEntity(e.id);
                            onEntitiesChanged?.();
                            onChanged?.();
                          } catch (err) { alert(err.message); }
                        }}
                        title="Duplicate this location and all its assumptions"
                        style={{ ...btnGhost, marginLeft: 6 }}
                      >Copy</button>
                      <button onClick={async () => { if (confirm('Delete location?')) { await deleteEntity(e.id); onEntitiesChanged?.(); } }} style={{ ...btnGhost, marginLeft: 6, color: colors.red }}>×</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        )}
      </Section>

      <LoansPanel scenarioId={scenario.id} onChanged={onChanged} />

      <Section
        title={<span ref={driversAnchorRef} style={{ scrollMarginTop: 16 }}>Drivers</span>}
        right={
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button
              onClick={() => setCompact(c => !c)}
              style={compact
                ? { ...btnDark, background: '#475569', padding: '6px 12px', fontSize: 12 }
                : { ...btnOutline, padding: '6px 12px', fontSize: 12 }}
              title="Toggle compact / comfortable density"
            >
              {compact ? 'Compact ✓' : 'Compact'}
            </button>
            {activeModuleKey && (
              <button onClick={() => setAddingDriver(true)} style={btnDark}>+ Add driver</button>
            )}
          </div>
        }
      >
        <div style={{ display: 'flex', gap: 4, borderBottom: `1px solid ${colors.border}`, marginBottom: 12, overflowX: 'auto', flexWrap: 'wrap' }}>
          {modules.map(m => (
            <button
              key={m.key}
              onClick={() => setActiveModuleKey(m.key)}
              style={{
                padding: '8px 12px', fontSize: 12, fontWeight: activeModuleKey === m.key ? 600 : 400,
                color: activeModuleKey === m.key ? colors.ink : colors.muted,
                background: 'transparent', border: 'none', borderBottom: `2px solid ${activeModuleKey === m.key ? colors.accent : 'transparent'}`,
                cursor: 'pointer', fontFamily: fontStack, whiteSpace: 'nowrap',
              }}
            >
              {MODULE_LABELS[m.key] || m.key}
            </button>
          ))}
        </div>

        <DriverFilters
          entities={entities}
          unitOptions={unitOptions}
          filterEntity={filterEntity} setFilterEntity={setFilterEntity}
          filterUnit={filterUnit} setFilterUnit={setFilterUnit}
          filterSearch={filterSearch} setFilterSearch={setFilterSearch}
          tabFilterSpec={tabFilterSpec}
          tabFilterValue={tabFilterValue}
          setTabFilterValue={(v) => setTabFilter(prev => ({ ...prev, [activeModuleKey]: v }))}
        />

        {moduleDrivers.length === 0 ? (
          <p style={{ fontSize: 13, color: colors.muted }}>No drivers match the current filter for {activeModuleKey}. Clear filters or click "Fill missing defaults" above.</p>
        ) : (
          <table style={{ ...tableStyle, fontSize: compact ? 11 : 12 }}>
            <thead>
              <tr>
                <th style={compact ? thCompact : th}>Driver</th>
                <th style={compact ? thCompact : th}>Entity</th>
                {!compact && <th style={th}>Unit</th>}
                {!compact && <th style={th}>Kind</th>}
                <th style={{ ...(compact ? thCompact : th), textAlign: 'right' }}>Value</th>
                <th style={{ ...(compact ? thCompact : th), textAlign: 'right', width: 70 }}></th>
              </tr>
            </thead>
            <tbody>
              {moduleDrivers.map((d, idx) => {
                const ent = entities.find(e => e.id === d.entity_id);
                const cellTd = compact ? tdCompact : td;
                // Light leader lines: alternate row background so the eye can
                // run from the assumption label (left) to the entry box (right).
                const zebra = idx % 2 === 1 ? '#fafbfc' : '#ffffff';
                return (
                  <tr key={d.id} style={{ borderBottom: `1px dotted ${colors.borderSoft}`, background: zebra }}>
                    <td style={cellTd}>
                      <strong>{d.label}</strong>
                      {compact && (
                        <span style={{ marginLeft: 6, fontSize: 10, color: colors.muted }}>
                          <Pill>{prettyUnit(d.unit)}</Pill>
                        </span>
                      )}
                    </td>
                    <td style={cellTd}>
                      {ent?.label || <span style={{ color: colors.muted }}>group</span>}
                    </td>
                    {!compact && <td style={cellTd}><Pill>{prettyUnit(d.unit)}</Pill></td>}
                    {!compact && <td style={cellTd}><Pill>{d.kind}</Pill></td>}
                    <td style={{ ...cellTd, textAlign: 'right' }}>
                      {d.kind === 'scalar' ? (
                        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                          {isMoneyUnit(d.unit) && <span style={{ fontSize: compact ? 11 : 12, color: colors.muted }}>£</span>}
                          <input
                            defaultValue={toDisplay(valueOf(d.id, -1), d.unit)}
                            onBlur={(e) => onChangeValue(d.id, -1, e.target.value, d.unit)}
                            style={{ ...inputStyle, width: compact ? 100 : 140, textAlign: 'right', padding: compact ? '3px 6px' : '6px 8px' }}
                          />
                          {d.unit === 'pct' && <span style={{ fontSize: compact ? 11 : 12, color: colors.muted }}>%</span>}
                        </div>
                      ) : d.kind === 'timeseries' ? (
                        <span style={{ fontSize: 11, color: colors.muted }}>(timeseries)</span>
                      ) : (
                        <code style={{ fontSize: 10 }}>{d.expression || '—'}</code>
                      )}
                    </td>
                    <td style={{ ...cellTd, textAlign: 'right', whiteSpace: 'nowrap' }}>
                      {!declaredKeys.has(d.driver_key) ? (
                        <span style={{ display: 'inline-flex', gap: 2 }}>
                          <button
                            onClick={() => onRenameDriver(d)}
                            title="Rename custom driver"
                            style={iconBtn}
                          >✎</button>
                          <button
                            onClick={() => onDeleteDriver(d)}
                            title="Delete custom driver"
                            style={{ ...iconBtn, color: colors.red }}
                          >×</button>
                        </span>
                      ) : (
                        <span style={{ fontSize: 9, color: colors.muted, fontStyle: 'italic' }}>built-in</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Section>

      {editingEntity && (
        <EntityModal
          forecast={forecast}
          entity={editingEntity}
          councils={councils}
          scenarioId={scenario?.id}
          modules={modules}
          onClose={() => setEditingEntity(null)}
          onSaved={() => { setEditingEntity(null); onEntitiesChanged?.(); onChanged?.(); }}
        />
      )}

      {addingDriver && (
        <CustomDriverModal
          scenarioId={scenario.id}
          moduleKey={activeModuleKey}
          entities={entities}
          onClose={() => setAddingDriver(false)}
          onSaved={() => { setAddingDriver(false); reload(); }}
        />
      )}
    </div>
  );
}

function GroupsPanel({ groups, onAdd, onDelete }) {
  return (
    <div style={{ padding: '10px 12px', background: colors.bgSoft, borderRadius: 8, marginBottom: 12, border: `1px solid ${colors.border}` }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
        <span style={{ fontSize: 11, color: colors.muted, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4 }}>Groups</span>
        <button onClick={onAdd} style={btnGhost}>+ Group</button>
      </div>
      {groups.length === 0 ? (
        <p style={{ fontSize: 12, color: colors.muted, margin: 0 }}>
          No groups yet. Create groups (e.g. <em>Confirmed</em>, <em>In progress</em>, <em>Possible</em>) and assign each location below.
        </p>
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {groups.map(g => (
            <span key={g.id} style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              padding: '4px 10px', fontSize: 12, color: colors.ink,
              background: '#fff', borderRadius: 999, border: `1px solid ${colors.border}`,
            }}>
              {g.label}
              <button onClick={() => onDelete(g.id)} style={{ background: 'transparent', border: 'none', color: colors.muted, cursor: 'pointer', padding: 0, fontSize: 14, lineHeight: 1 }}>×</button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function CustomDriverModal({ scenarioId, moduleKey, entities, onClose, onSaved }) {
  const [form, setForm] = useState({
    label: '',
    driver_key: '',
    unit: 'gbp_p',
    kind: 'scalar',
    scope: 'group',
    entity_id: '',
    value: '',
  });
  const [busy, setBusy] = useState(false);

  // Default driver_key from label
  const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

  const onSave = async () => {
    if (!form.label.trim()) { alert('Label is required'); return; }
    setBusy(true);
    try {
      const driverKey = (form.driver_key || slug(form.label)).trim();
      if (!driverKey) { alert('Could not derive a driver key'); setBusy(false); return; }

      const targets = form.scope === 'group'
        ? [{ entity_id: null }]
        : (form.scope === 'all_entities'
            ? entities.map(e => ({ entity_id: e.id }))
            : [{ entity_id: form.entity_id || null }]);

      for (const tgt of targets) {
        const driver = await upsertDriver({
          scenario_id: scenarioId,
          entity_id: tgt.entity_id,
          module_key: moduleKey,
          driver_key: driverKey,
          label: form.label.trim(),
          unit: form.unit,
          kind: form.kind,
          expression: null,
        });
        if (form.kind === 'scalar' && form.value !== '' && form.value != null) {
          const num = form.unit === 'gbp_p' ? Math.round(Number(form.value) * 100) : Number(form.value);
          if (!Number.isNaN(num)) await setDriverValue(driver.id, -1, num);
        }
      }
      onSaved();
    } catch (e) { alert(e.message); }
    setBusy(false);
  };

  return (
    <div onClick={onClose} style={modalBackdrop}>
      <div onClick={(e) => e.stopPropagation()} style={{ ...modalCard, maxWidth: 540 }}>
        <h2 style={{ fontFamily: serifStack, fontSize: 20, fontWeight: 500, color: colors.ink, margin: '0 0 6px' }}>
          Add custom driver
        </h2>
        <p style={{ fontSize: 12, color: colors.muted, margin: '0 0 16px' }}>
          Module: <strong>{moduleKey}</strong>
        </p>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Field label="Label">
            <input
              autoFocus
              value={form.label}
              placeholder="e.g. Staff training"
              onChange={(e) => setForm({ ...form, label: e.target.value })}
              style={inputStyle}
            />
          </Field>
          <Field label="Driver key (optional)">
            <input
              value={form.driver_key}
              placeholder={slug(form.label) || 'auto-derived'}
              onChange={(e) => setForm({ ...form, driver_key: e.target.value })}
              style={{ ...inputStyle, fontFamily: 'ui-monospace, monospace' }}
            />
          </Field>
          <Field label="Unit">
            <select value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })} style={{ ...inputStyle, padding: '6px' }}>
              <option value="gbp_p">£ (pounds)</option>
              <option value="pct">%</option>
              <option value="count"># count</option>
              <option value="hours">hours</option>
              <option value="ratio">ratio</option>
              <option value="sqft">sq ft</option>
            </select>
          </Field>
          <Field label="Kind">
            <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })} style={{ ...inputStyle, padding: '6px' }}>
              <option value="scalar">Scalar</option>
              <option value="timeseries">Timeseries (no default value)</option>
            </select>
          </Field>
          <Field label="Scope">
            <select value={form.scope} onChange={(e) => setForm({ ...form, scope: e.target.value })} style={{ ...inputStyle, padding: '6px' }}>
              <option value="group">Group (one shared)</option>
              <option value="all_entities">Per location (one each)</option>
              <option value="single_entity">Single location</option>
            </select>
          </Field>
          {form.scope === 'single_entity' && (
            <Field label="Location">
              <select value={form.entity_id} onChange={(e) => setForm({ ...form, entity_id: e.target.value })} style={{ ...inputStyle, padding: '6px' }}>
                <option value="">— pick —</option>
                {entities.map(e => <option key={e.id} value={e.id}>{e.label}</option>)}
              </select>
            </Field>
          )}
          {form.kind === 'scalar' && (
            <Field label={`Value (${form.unit === 'gbp_p' ? '£' : form.unit})`}>
              <input
                value={form.value}
                onChange={(e) => setForm({ ...form, value: e.target.value })}
                style={inputStyle}
                placeholder={form.unit === 'gbp_p' ? 'e.g. 5000' : ''}
                inputMode="decimal"
              />
            </Field>
          )}
        </div>

        <div style={{ display: 'flex', gap: 10, marginTop: 22 }}>
          <button onClick={onClose} style={{ ...btnOutline, flex: 1, justifyContent: 'center' }}>Cancel</button>
          <button onClick={onSave} disabled={busy} style={{ ...btnDark, flex: 1, justifyContent: 'center' }}>
            {busy ? 'Saving…' : 'Add driver'}
          </button>
        </div>
        <p style={{ fontSize: 11, color: colors.muted, margin: '14px 0 0' }}>
          Custom drivers persist alongside seeded ones. They'll be picked up by the engine if any module's compute() reads them by key — otherwise they stay as data without affecting outputs.
        </p>
      </div>
    </div>
  );
}

function EntityModal({ forecast, entity, councils, scenarioId, modules, onClose, onSaved }) {
  // For NEW locations, fall back to saved nursery defaults (first location's
  // config, captured via "Save as defaults"). For edits, only use the row's
  // own config so we don't silently drift other locations' settings.
  const isNew = !entity.id;
  const nurseryDefaults = isNew ? loadNurseryDefaults(forecast.vertical_pack) : null;
  const tplCfg = nurseryDefaults?.entity_config || {};
  const cfg = entity.config || {};
  const pick = (k, fallback) => cfg[k] ?? tplCfg[k] ?? fallback;
  const tplCap = tplCfg.capacity_by_age_band || {};
  const cap = cfg.capacity_by_age_band || {};

  const [form, setForm] = useState(() => ({
    id: entity.id,
    key: entity.key || `site_${Date.now().toString(36).slice(-5)}`,
    label: entity.label || '',
    la_council_id: pick('la_council_id', councils[0]?.id || ''),
    sq_ft: pick('sq_ft', 4000),
    opening_month_offset: pick('opening_month_offset', 6),
    acquisition_type: pick('acquisition_type', 'greenfield'),
    lease_or_buy: pick('lease_or_buy', 'lease'),
    ramp_to_target_months: pick('ramp_to_target_months', 6),
    target_occupancy_pct: pick('target_occupancy_pct', 85),
    // Default 40% reflects pre-launch marketing influx for a greenfield;
    // going-concern acquisitions usually inherit ~70%.
    starting_occupancy_pct: cfg.starting_occupancy_pct ?? tplCfg.starting_occupancy_pct ??
      ((cfg.acquisition_type ?? tplCfg.acquisition_type) === 'acquired_going_concern' ? 70 : 40),
    cap_babies: cap.babies ?? tplCap.babies ?? 12,
    cap_twos: cap.twos ?? tplCap.twos ?? 16,
    cap_three_to_five: cap.three_to_five ?? tplCap.three_to_five ?? 32,
    cap_after_school: cap.after_school ?? tplCap.after_school ?? 0,
    concession_stages: cfg.premises_concession_stages || tplCfg.premises_concession_stages || [],
    svc_concession_stages: cfg.premises_svc_concession_stages || tplCfg.premises_svc_concession_stages || [],
  }));
  const [busy, setBusy] = useState(false);

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const setNum = (k) => (e) => setForm({ ...form, [k]: e.target.value === '' ? '' : Number(e.target.value) });

  const onSave = async () => {
    setBusy(true);
    try {
      const config = {
        la_council_id: form.la_council_id,
        sq_ft: Number(form.sq_ft) || 0,
        capacity_by_age_band: {
          babies: Number(form.cap_babies) || 0,
          twos: Number(form.cap_twos) || 0,
          three_to_five: Number(form.cap_three_to_five) || 0,
          after_school: Number(form.cap_after_school) || 0,
        },
        opening_month_offset: Number(form.opening_month_offset) || 0,
        acquisition_type: form.acquisition_type,
        lease_or_buy: form.lease_or_buy,
        ramp_to_target_months: Number(form.ramp_to_target_months) || 0,
        target_occupancy_pct: Number(form.target_occupancy_pct) || 0,
        starting_occupancy_pct: Number(form.starting_occupancy_pct) || 0,
        premises_concession_stages: form.lease_or_buy === 'lease'
          ? (form.concession_stages || []).filter(s => Number(s?.months) > 0)
          : [],
        premises_svc_concession_stages: form.lease_or_buy === 'lease'
          ? (form.svc_concession_stages || []).filter(s => Number(s?.months) > 0)
          : [],
      };
      const wasNew = !form.id;
      const saved = await upsertEntity({
        id: form.id || undefined,
        forecast_id: forecast.id,
        key: form.key, label: form.label, type: 'location', config,
      });

      // Auto-seed entity-scoped drivers for brand-new locations so
      // their per-site costs (rent, fit-out, weekly rates, utilities,
      // insurance, fixed-asset purchases, pre-opening overhead/staffing,
      // etc.) flow through to the P&L / cashflow / reports immediately
      // — instead of needing the user to remember to click "Fill
      // missing defaults" first.
      if (wasNew && scenarioId && modules?.length && saved?.id) {
        try {
          await seedPackDefaults({
            scenario_id: scenarioId,
            modules,
            entities: [saved],
            vertical_pack: forecast.vertical_pack,
          });
        } catch (seedErr) {
          // Don't block save if seeding fails — surface a soft warning.
          console.warn('Auto-seed of entity drivers failed:', seedErr);
        }
      }

      onSaved();
    } catch (e) { alert(e.message); }
    setBusy(false);
  };

  return (
    <div onClick={onClose} style={modalBackdrop}>
      <div onClick={(e) => e.stopPropagation()} style={modalCard}>
        <h2 style={{ fontFamily: serifStack, fontSize: 22, fontWeight: 500, color: colors.ink, margin: '0 0 16px' }}>
          {form.id ? 'Edit location' : 'New location'}
          {isNew && nurseryDefaults && (
            <span style={{ marginLeft: 10, fontSize: 12, fontWeight: 400, color: colors.muted, fontFamily: fontStack }}>
              · prefilled from saved nursery defaults
            </span>
          )}
        </h2>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Field label="Label"><input value={form.label} onChange={set('label')} style={inputStyle} /></Field>
          <Field label="Key (slug)"><input value={form.key} onChange={set('key')} style={inputStyle} /></Field>
          <Field label="Council">
            <select value={form.la_council_id} onChange={set('la_council_id')} style={{ ...inputStyle, padding: '6px' }}>
              {councils.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Field>
          <Field label="Sq ft"><input type="number" value={form.sq_ft} onChange={setNum('sq_ft')} style={inputStyle} /></Field>
          <Field label="Acquisition type">
            <select value={form.acquisition_type} onChange={set('acquisition_type')} style={{ ...inputStyle, padding: '6px' }}>
              <option value="greenfield">Greenfield</option>
              <option value="acquired_going_concern">Acquired (going concern)</option>
              <option value="acquired_empty">Acquired (empty)</option>
            </select>
          </Field>
          <Field label="Lease or buy">
            <select value={form.lease_or_buy} onChange={set('lease_or_buy')} style={{ ...inputStyle, padding: '6px' }}>
              <option value="lease">Lease</option>
              <option value="buy">Buy</option>
            </select>
          </Field>
          <Field label="Opens (months from start)"><input type="number" value={form.opening_month_offset} onChange={setNum('opening_month_offset')} style={inputStyle} /></Field>
          <Field label="Ramp to target (months)"><input type="number" value={form.ramp_to_target_months} onChange={setNum('ramp_to_target_months')} style={inputStyle} /></Field>
          <Field label="Target occupancy %"><input type="number" value={form.target_occupancy_pct} onChange={setNum('target_occupancy_pct')} style={inputStyle} /></Field>
          <Field label="Launch occupancy % (day-1 marketing influx)"><input type="number" value={form.starting_occupancy_pct} onChange={setNum('starting_occupancy_pct')} style={inputStyle} /></Field>
        </div>

        <h3 style={{ fontFamily: serifStack, fontSize: 16, color: colors.ink, margin: '20px 0 10px' }}>Capacity by age band</h3>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 12 }}>
          <Field label="0-2"><input type="number" value={form.cap_babies} onChange={setNum('cap_babies')} style={inputStyle} /></Field>
          <Field label="2-3"><input type="number" value={form.cap_twos} onChange={setNum('cap_twos')} style={inputStyle} /></Field>
          <Field label="3-5"><input type="number" value={form.cap_three_to_five} onChange={setNum('cap_three_to_five')} style={inputStyle} /></Field>
          <Field label="After-school"><input type="number" value={form.cap_after_school} onChange={setNum('cap_after_school')} style={inputStyle} /></Field>
        </div>

        {form.lease_or_buy === 'lease' && (
          <>
            <h3 style={{ fontFamily: serifStack, fontSize: 16, color: colors.ink, margin: '20px 0 6px' }}>
              Rent concession stages
            </h3>
            <p style={{ fontSize: 11, color: colors.muted, margin: '0 0 10px' }}>
              Sequential stages from the location's opening month. Months × Factor (100% = full rent, 50% = half price, 0% = free).
              Once stages are exhausted, full rent applies. Leave empty for no concession.
            </p>
            <ConcessionEditor
              stages={form.concession_stages}
              onChange={(s) => setForm({ ...form, concession_stages: s })}
            />

            <h3 style={{ fontFamily: serifStack, fontSize: 16, color: colors.ink, margin: '20px 0 6px' }}>
              Service charge concession stages
            </h3>
            <p style={{ fontSize: 11, color: colors.muted, margin: '0 0 10px' }}>
              Independent of the rent schedule — a rent-free period rarely extends to the service charge,
              which is usually payable in full from day one. Leave empty for no concession.
            </p>
            <ConcessionEditor
              stages={form.svc_concession_stages}
              onChange={(s) => setForm({ ...form, svc_concession_stages: s })}
            />
          </>
        )}

        <div style={{ display: 'flex', gap: 10, marginTop: 22 }}>
          <button onClick={onClose} style={{ ...btnOutline, flex: 1, justifyContent: 'center' }}>Cancel</button>
          <button onClick={onSave} disabled={busy} style={{ ...btnDark, flex: 1, justifyContent: 'center' }}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

function ConcessionEditor({ stages, onChange }) {
  const update = (i, patch) => {
    const next = stages.map((s, idx) => idx === i ? { ...s, ...patch } : s);
    onChange(next);
  };
  const remove = (i) => onChange(stages.filter((_, idx) => idx !== i));
  const add = () => onChange([...stages, { months: 3, factor: 0 }]);
  let cursor = 0;
  return (
    <div>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, fontFamily: fontStack }}>
        <thead>
          <tr style={{ background: colors.bgSoft }}>
            <th style={{ padding: '6px 10px', textAlign: 'left', fontWeight: 600, color: colors.muted }}>Stage</th>
            <th style={{ padding: '6px 10px', textAlign: 'left', fontWeight: 600, color: colors.muted }}>Months</th>
            <th style={{ padding: '6px 10px', textAlign: 'left', fontWeight: 600, color: colors.muted }}>% of full rent</th>
            <th style={{ padding: '6px 10px', textAlign: 'left', fontWeight: 600, color: colors.muted }}>Window</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {stages.length === 0 && (
            <tr><td colSpan={5} style={{ padding: 12, color: colors.muted, fontStyle: 'italic' }}>No concession — full rent from opening month.</td></tr>
          )}
          {stages.map((s, i) => {
            const months = Number(s.months) || 0;
            const from = cursor;
            const to = cursor + months - 1;
            cursor += months;
            return (
              <tr key={i} style={{ borderBottom: `1px solid ${colors.borderSoft}` }}>
                <td style={{ padding: '6px 10px' }}>{i + 1}</td>
                <td style={{ padding: '6px 10px' }}>
                  <input
                    type="number" value={s.months ?? ''}
                    onChange={(e) => update(i, { months: e.target.value === '' ? '' : Number(e.target.value) })}
                    style={{ ...inputStyle, width: 80 }}
                  />
                </td>
                <td style={{ padding: '6px 10px' }}>
                  <input
                    type="number" step="1" min="0" max="100"
                    value={s.factor != null ? Math.round((Number(s.factor) || 0) * 100) : ''}
                    onChange={(e) => update(i, { factor: e.target.value === '' ? 0 : Number(e.target.value) / 100 })}
                    style={{ ...inputStyle, width: 80 }}
                  />
                  <span style={{ marginLeft: 4, color: colors.muted, fontSize: 11 }}>%</span>
                </td>
                <td style={{ padding: '6px 10px', color: colors.muted, fontSize: 11 }}>
                  {months > 0 ? `m${from}–m${to}` : '—'}
                </td>
                <td style={{ padding: '6px 10px', textAlign: 'right' }}>
                  <button onClick={() => remove(i)} style={{ ...btnGhost, color: colors.red }}>×</button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <button onClick={add} style={{ ...btnGhost, marginTop: 6 }}>+ Add stage</button>
      {stages.length > 0 && (
        <p style={{ fontSize: 11, color: colors.muted, margin: '6px 0 0' }}>
          Full rent from month {cursor} onward.
        </p>
      )}
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

function DriverFilters({ entities, unitOptions, filterEntity, setFilterEntity, filterUnit, setFilterUnit, filterSearch, setFilterSearch, tabFilterSpec, tabFilterValue, setTabFilterValue }) {
  const anyFilterActive = filterEntity !== 'all' || filterUnit !== 'all' || filterSearch || (tabFilterSpec && tabFilterValue !== 'all');
  return (
    <div style={{ display: 'flex', gap: 8, marginBottom: 12, alignItems: 'center', flexWrap: 'wrap' }}>
      <select value={filterEntity} onChange={(e) => setFilterEntity(e.target.value)} style={filterSel}>
        <option value="all">All entities</option>
        <option value="group">— Group only —</option>
        {entities.map(e => <option key={e.id} value={e.id}>{e.label}</option>)}
      </select>
      <select value={filterUnit} onChange={(e) => setFilterUnit(e.target.value)} style={filterSel}>
        <option value="all">All units</option>
        {unitOptions.map(u => <option key={u} value={u}>{prettyUnit(u)} ({u})</option>)}
      </select>
      {tabFilterSpec && (
        <select
          value={tabFilterValue}
          onChange={(e) => setTabFilterValue(e.target.value)}
          style={{ ...filterSel, borderColor: tabFilterValue !== 'all' ? colors.accent : colors.border }}
          title={tabFilterSpec.label}
        >
          {tabFilterSpec.options.map(o => (
            <option key={o.value} value={o.value}>{o.value === 'all' ? o.label : `${tabFilterSpec.label}: ${o.label}`}</option>
          ))}
        </select>
      )}
      <input
        value={filterSearch}
        onChange={(e) => setFilterSearch(e.target.value)}
        placeholder="Search drivers…"
        style={{ ...inputStyle, width: 220, padding: '7px 10px', fontFamily: fontStack }}
      />
      {anyFilterActive && (
        <button
          onClick={() => {
            setFilterEntity('all'); setFilterUnit('all'); setFilterSearch('');
            if (tabFilterSpec && setTabFilterValue) setTabFilterValue('all');
          }}
          style={{ ...btnGhost, color: colors.muted }}
        >clear</button>
      )}
    </div>
  );
}

const filterSel = { padding: '7px 10px', borderRadius: 8, border: `1px solid ${colors.border}`, fontSize: 12, fontFamily: fontStack, background: '#fff' };

function prettyUnit(u) {
  switch (u) {
    case 'gbp_p': return '£';
    case 'pct': return '%';
    case 'count': return '#';
    case 'hours': return 'hrs';
    case 'sqft': return 'sq ft';
    case 'ratio': return ':1';
    default: return u;
  }
}

const iconBtn = {
  background: 'transparent', border: `1px solid ${colors.border}`, borderRadius: 5,
  padding: '2px 7px', fontSize: 12, lineHeight: 1, cursor: 'pointer',
  color: colors.muted, fontFamily: fontStack,
};
const tableStyle = { width: '100%', borderCollapse: 'collapse', fontSize: 12, fontFamily: fontStack };
const th = { padding: '8px 10px', textAlign: 'left', fontWeight: 600, color: colors.muted, borderBottom: `1px solid ${colors.border}`, background: colors.bgSoft };
const td = { padding: '8px 10px', color: colors.ink, verticalAlign: 'top' };
const thCompact = { padding: '4px 8px', textAlign: 'left', fontWeight: 600, color: colors.muted, borderBottom: `1px solid ${colors.border}`, background: colors.bgSoft, fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.4 };
const tdCompact = { padding: '4px 8px', color: colors.ink, verticalAlign: 'middle' };
const modalBackdrop = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, fontFamily: fontStack };
const modalCard = { background: '#fff', borderRadius: 16, padding: 28, maxWidth: 720, width: '100%', maxHeight: '90vh', overflowY: 'auto' };
