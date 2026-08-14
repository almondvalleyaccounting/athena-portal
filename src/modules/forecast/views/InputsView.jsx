import React, { useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '../../../lib/supabase';
import {
  listEntities, upsertEntity, deleteEntity, listLaCouncils,
  loadScenarioDrivers, upsertDriver, setDriverValue, clearDriverValue, deleteDriver, updateDriver,
  copyEntity,
  seedPackDefaults,
  createGroup, deleteGroup, assignEntityToGroup,
  saveNurseryDefaults, loadNurseryDefaults, clearNurseryDefaults,
  saveCapacityOverride,
} from '../lib/queries';
import { modulesFor } from '../lib/packs';
import { curveForBand, ACQUIRED_TYPES } from '../lib/occupancy.js';
import { AGE_BANDS, AGE_BAND_LABELS } from '../lib/modules/locations.js';
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

// Grouped sections for the flat driver grid — visible header rows in the
// table, replacing the old per-tab dropdown filters. A driver lands in
// the FIRST section whose match() passes; unmatched drivers fall into a
// trailing "Other" group. Pipeline and Services have their own custom
// panels instead.
const MODULE_SECTIONS = {
  staff: [
    { label: 'Statutory ratios (children per adult)', match: (d) => d.driver_key.startsWith('ratio.') && !d.driver_key.startsWith('ratio_inclusion.') },
    { label: 'Salaries & wage floors', match: (d) => d.driver_key.startsWith('base_salary_p.') || d.driver_key.endsWith('_hourly_p') },
    { label: 'Headcount', match: (d) => d.driver_key.startsWith('headcount.') },
    { label: 'Direct staff mix & age-band split', match: (d) => d.driver_key.startsWith('direct_mix.') || d.driver_key.startsWith('nmw_mix.') },
    { label: 'On-costs (NI / pension)', match: (d) => ['employer_ni_pct', 'employer_pension_pct', 'employment_allowance_p'].includes(d.driver_key) },
    { label: 'The contract (productive hours are derived from these)', match: (d) => ['contracted_hours_per_week', 'holiday_weeks_per_year', 'absence_days_per_year', 'training_days_per_year'].includes(d.driver_key) },
    { label: 'Workforce & cover', match: (d) => ['vacancy_rate_pct', 'agency_premium_pct', 'overstaff_pct', 'enforce_real_living_wage'].includes(d.driver_key) },
    { label: 'Counted in statutory ratios?', match: (d) => d.driver_key.startsWith('ratio_inclusion.') },
  ],
  premises: [
    { label: 'Lease (rent / service charge)', match: (d) => ['premises.rent_monthly_p', 'premises.service_charge_monthly_p'].includes(d.driver_key) },
    { label: 'Buy (purchase / mortgage / NDR) & upkeep', match: () => true },
  ],
  pre_opening: [
    { label: 'Overhead & registration', match: (d) => d.driver_key.includes('monthly_overhead') || d.driver_key.includes('registration_lead') },
    { label: 'Staffing', match: (d) => d.driver_key.includes('staffing') },
    { label: 'Marketing', match: (d) => d.driver_key.includes('marketing') },
  ],
  overheads: [
    { label: 'Site-level (per location)', match: (d) => !!d.entity_id },
    { label: 'Central / group', match: (d) => !d.entity_id },
  ],
};

// Orphan DB driver rows for keys the modules no longer declare — hidden
// everywhere (flat grid + Pipeline panel).
const RETIRED_KEYS = new Set([
  'launch.greenfield_influx_pct', 'launch.ramp_months',
  // Opening equity is derived from opening cash (financial_core);
  // editing it separately could only unbalance the BS.
  'bs.opening_equity_p',
  // Dead inputs removed 2026-07: continuous age-ups are modelled
  // inside the ramp curve (no driver), and the legacy flat
  // practitioner/manager staffing keys pre-date the role mix.
  'cohort.moveup_babies_pct', 'cohort.moveup_twos_pct',
  'base_salary_p.practitioner', 'base_salary_p.lead_practitioner',
  'base_salary_p.manager', 'manager_per_n_practitioners',
  // Productive hours are now DERIVED from the contract (contracted hours
  // less leave / sickness / training) rather than typed in alongside it —
  // entering both let each be read generously and independently.
  'standard_hours_per_year',
]);

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
    const existing = values.find(v => v.driver_id === driverId && v.period === period);

    // Cleared cell → delete the value row (blank-by-default drivers like
    // the ramp / capacity overrides mean "use the default" when blank).
    if (String(raw).trim() === '') {
      if (!existing) return;                       // was already blank
      await clearDriverValue(driverId, period);
      setValues(prev => prev.filter(v => !(v.driver_id === driverId && v.period === period)));
      onChanged?.();                               // assumption changed — recompute
      return;
    }

    const num = fromDisplay(raw, unit);
    if (num == null) return;
    if (existing && Number(existing.value) === num) return;   // no change — no write, no recompute
    await setDriverValue(driverId, period, num);
    setValues(prev => {
      const i = prev.findIndex(v => v.driver_id === driverId && v.period === period);
      if (i >= 0) { const c = [...prev]; c[i] = { ...c[i], value: num }; return c; }
      return [...prev, { driver_id: driverId, period, value: num }];
    });
    // Assumption changed — recompute so every tab (and the Compare view)
    // reflects it immediately, instead of showing stale outputs until a
    // manual Recompute.
    onChanged?.();
  };

  const [filterEntity, setFilterEntity] = useState('all');         // 'all' | 'group' | entity_id
  const [filterUnit, setFilterUnit] = useState('all');
  const [filterSearch, setFilterSearch] = useState('');
  // Locations section starts expanded and stays that way unless the user
  // hits "Hide" — no auto-collapse / auto-expand.
  const [locationsExpanded, setLocationsExpanded] = useState(true);
  const [addingDriver, setAddingDriver] = useState(false);
  const [compact, setCompact] = useState(true);
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

    // Use the active module's `drivers` declaration order so the user's
    // requested role-grouped layout (exec → … → apprentice <19) is honoured.
    const activeMod = modules.find(m => m.key === activeModuleKey);
    const orderByKey = new Map();
    (activeMod?.drivers || []).forEach((d, i) => orderByKey.set(d.key, i));

    return drivers.filter(d => {
      if (d.module_key !== activeModuleKey) return false;
      // Hide orphan drivers (retired keys); custom user-added drivers stay
      // visible even though they're not in the declared list.
      if (RETIRED_KEYS.has(d.driver_key)) return false;
      if (filterEntity === 'group' && d.entity_id) return false;
      if (filterEntity !== 'all' && filterEntity !== 'group' && d.entity_id !== filterEntity) return false;
      if (filterUnit !== 'all' && d.unit !== filterUnit) return false;
      if (q && !(d.label?.toLowerCase().includes(q) || d.driver_key.toLowerCase().includes(q))) return false;
      return true;
    }).sort((a, b) => {
      const oa = orderByKey.has(a.driver_key) ? orderByKey.get(a.driver_key) : 9999;
      const ob = orderByKey.has(b.driver_key) ? orderByKey.get(b.driver_key) : 9999;
      if (oa !== ob) return oa - ob;
      // Within same driver key, group entities together
      return (a.entity_id || '').localeCompare(b.entity_id || '');
    });
  }, [drivers, activeModuleKey, filterEntity, filterUnit, filterSearch, modules]);

  // Rows grouped under visible section headers (spec order preserved
  // within each section); modules without a spec render flat.
  const sectionedRows = useMemo(() => {
    const spec = MODULE_SECTIONS[activeModuleKey];
    if (!spec) return null;
    const buckets = spec.map(s => ({ label: s.label, rows: [] }));
    const other = { label: 'Other', rows: [] };
    for (const d of moduleDrivers) {
      const b = buckets.find((bk, i) => spec[i].match(d));
      (b || other).rows.push(d);
    }
    return [...buckets, other].filter(b => b.rows.length > 0);
  }, [moduleDrivers, activeModuleKey]);

  // Pipeline (locations) and Services tabs render purpose-built grouped
  // panels instead of the flat grid, so they ignore the generic
  // entity/unit/search filters — everything is visible, grouped the way
  // the engine reads it.
  const pipelineDrivers = useMemo(
    () => drivers.filter(d => d.module_key === 'locations' && !RETIRED_KEYS.has(d.driver_key)),
    [drivers]
  );
  const servicesDrivers = useMemo(
    () => drivers.filter(d => d.module_key === 'services_childcare' && !RETIRED_KEYS.has(d.driver_key)),
    [drivers]
  );

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

        {activeModuleKey === 'locations' ? (
          <PipelineDriversPanel
            entities={entities}
            drivers={pipelineDrivers}
            valueOf={valueOf}
            toDisplay={toDisplay}
            onChangeValue={onChangeValue}
            compact={compact}
            declaredKeys={declaredKeys}
            onRenameDriver={onRenameDriver}
            onDeleteDriver={onDeleteDriver}
          />
        ) : activeModuleKey === 'services_childcare' ? (
          <ServicesDriversPanel
            entities={entities}
            drivers={servicesDrivers}
            valueOf={valueOf}
            toDisplay={toDisplay}
            onChangeValue={onChangeValue}
            compact={compact}
            declaredKeys={declaredKeys}
            onRenameDriver={onRenameDriver}
            onDeleteDriver={onDeleteDriver}
          />
        ) : (<>
        <DriverFilters
          entities={entities}
          unitOptions={unitOptions}
          filterEntity={filterEntity} setFilterEntity={setFilterEntity}
          filterUnit={filterUnit} setFilterUnit={setFilterUnit}
          filterSearch={filterSearch} setFilterSearch={setFilterSearch}
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
              {(sectionedRows
                ? sectionedRows.flatMap(sec => [{ __section: sec.label }, ...sec.rows])
                : moduleDrivers
              ).map((d, idx) => {
                if (d.__section) {
                  return (
                    <tr key={`sec-${d.__section}`}>
                      <td colSpan={compact ? 4 : 6} style={{ padding: '14px 8px 4px', fontSize: 10, fontWeight: 700, color: colors.muted, textTransform: 'uppercase', letterSpacing: 0.5, borderBottom: `1px solid ${colors.border}`, background: '#fff' }}>
                        {d.__section}
                      </td>
                    </tr>
                  );
                }
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
        </>)}
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

// ═══ Pipeline (locations) drivers panel ═════════════════════════════════
// The flat grid was unreadable here — ~19 near-identically-labelled rows
// spanning three override layers. This panel groups them the way the
// engine resolves the curve (lib/occupancy.js curveForBand):
//   age-band override → site-wide override → location default / group default.
// Blank cells show the value they'd inherit as a grey placeholder, and
// each band row spells out its effective curve.

function PipelineDriversPanel({ entities, drivers, valueOf, toDisplay, onChangeValue, compact, declaredKeys, onRenameDriver, onDeleteDriver }) {
  const find = (entityId, key) => drivers.find(d => (d.entity_id || null) === entityId && d.driver_key === key);
  const numOf = (d) => {
    if (!d) return null;
    const v = valueOf(d.id, -1);
    if (v === '' || v == null) return null;
    const n = Number(v);
    return Number.isNaN(n) ? null : n;
  };
  const groupCurveFor = (band) => ({
    opening: numOf(find(null, `capacity.opening_pct.${band}`)),
    target:  numOf(find(null, `capacity.target_pct.${band}`)),
    phase:   numOf(find(null, `capacity.phase_up_months.${band}`)),
  });

  const hasGroupBandRows = drivers.some(d => !d.entity_id && d.driver_key.startsWith('capacity.'));
  const COHORT_ORDER = ['cohort.school_leaver_three_to_five_pct', 'cohort.school_to_as_pct', 'cohort.as_leaver_pct', 'cohort.refill_months'];
  const cohortDrivers = drivers
    .filter(d => !d.entity_id && d.driver_key.startsWith('cohort.'))
    .sort((a, b) => {
      const ia = COHORT_ORDER.indexOf(a.driver_key), ib = COHORT_ORDER.indexOf(b.driver_key);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
  const others = drivers.filter(d =>
    !d.driver_key.startsWith('ramp.') && !d.driver_key.startsWith('capacity.') && !d.driver_key.startsWith('cohort.'));

  const cellProps = { valueOf, toDisplay, onChangeValue, compact };

  return (
    <div>
      <p style={{ fontSize: 12, color: colors.muted, margin: '0 0 12px' }}>
        Ramp-up assumptions resolve top-down: an <strong>age-band value</strong> beats the <strong>site-wide override</strong>,
        which beats the location default (set in <em>Edit location</em>) or the group default.
        Leave a cell blank to inherit — the grey number shows what blank means.
      </p>

      {entities.length === 0 && (
        <p style={{ fontSize: 13, color: colors.muted }}>Add a location above to set its ramp-up assumptions.</p>
      )}
      {entities.map(e => (
        <LocationRampCard key={e.id} entity={e} find={find} numOf={numOf} groupCurveFor={groupCurveFor} {...cellProps} />
      ))}

      {hasGroupBandRows && <GroupBandDefaultsCard find={find} {...cellProps} />}

      {cohortDrivers.length > 0 && <CohortCard drivers={cohortDrivers} {...cellProps} />}

      {others.length > 0 && (
        <OtherDriversTable
          drivers={others} entities={entities} declaredKeys={declaredKeys}
          onRenameDriver={onRenameDriver} onDeleteDriver={onDeleteDriver}
          {...cellProps}
        />
      )}
    </div>
  );
}

// ═══ Services drivers panel ═════════════════════════════════════════════
// Same treatment as Pipeline: the per-band pricing drivers become a
// band × metric matrix per location (they're entity-scoped), with a
// derived private £/hr column, and the group billing/calendar knobs sit
// in their own card.

const SERVICE_BAND_PREFIXES = [
  'weekly_rate_p.', 'operating_hours_per_week.',
  'eligible_for_funded_pct.', 'funded_hours_take_up_pct.', 'funded_only_pct.', 'la_funded_rate_p.',
];
const SERVICE_GROUP_KEYS = ['weeks_per_year', 'deposit_weeks', 'advance_billing_weeks'];

function ServicesDriversPanel({ entities, drivers, valueOf, toDisplay, onChangeValue, compact, declaredKeys, onRenameDriver, onDeleteDriver }) {
  const find = (entityId, key) => drivers.find(d => (d.entity_id || null) === entityId && d.driver_key === key);
  const numOf = (d) => {
    if (!d) return null;
    const v = valueOf(d.id, -1);
    if (v === '' || v == null) return null;
    const n = Number(v);
    return Number.isNaN(n) ? null : n;
  };
  const cellProps = { valueOf, toDisplay, onChangeValue, compact };

  const isBandDriver = (d) => SERVICE_BAND_PREFIXES.some(p => d.driver_key.startsWith(p));
  const groupDrivers = drivers.filter(d => !d.entity_id && SERVICE_GROUP_KEYS.includes(d.driver_key))
    .sort((a, b) => SERVICE_GROUP_KEYS.indexOf(a.driver_key) - SERVICE_GROUP_KEYS.indexOf(b.driver_key));
  const others = drivers.filter(d => !isBandDriver(d) && !SERVICE_GROUP_KEYS.includes(d.driver_key));

  return (
    <div>
      <p style={{ fontSize: 12, color: colors.muted, margin: '0 0 12px' }}>
        Pricing and funded-hours assumptions per age band, one card per location.
        LA-funded hours (1140/yr) are billed at the LA rate; remaining hours at the private rate.
        <strong> Funded-only %</strong> is the share of funded take-up made up of part-timers using
        only their 1140 hours (≈2 children per FTE place, so that place bills wholly at the LA rate);
        the balance are full-timers who top up at private rates.
      </p>

      {entities.length === 0 && (
        <p style={{ fontSize: 13, color: colors.muted }}>Add a location above to set its pricing.</p>
      )}
      {entities.map(e => (
        <div key={e.id} style={pipeCard}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: colors.ink }}>{e.label}</span>
            <Pill>pricing & funding by age band</Pill>
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: fontStack }}>
            <thead>
              <tr>
                <th style={pipeTh}>Age band</th>
                <th style={{ ...pipeTh, textAlign: 'right' }}>Weekly rate (£)</th>
                <th style={{ ...pipeTh, textAlign: 'right' }}>Hours / week</th>
                <th style={{ ...pipeTh, textAlign: 'right' }}>Eligible for funded %</th>
                <th style={{ ...pipeTh, textAlign: 'right' }}>Funded take-up %</th>
                <th style={{ ...pipeTh, textAlign: 'right' }}>Funded-only %</th>
                <th style={{ ...pipeTh, textAlign: 'right' }}>LA rate (£/hr)</th>
                <th style={{ ...pipeTh, paddingLeft: 18 }}>Private £/hr</th>
              </tr>
            </thead>
            <tbody>
              {AGE_BANDS.map(band => {
                const dRate  = find(e.id, `weekly_rate_p.${band}`);
                const dHours = find(e.id, `operating_hours_per_week.${band}`);
                const dElig  = find(e.id, `eligible_for_funded_pct.${band}`);
                const dTake  = find(e.id, `funded_hours_take_up_pct.${band}`);
                const dFOnly = find(e.id, `funded_only_pct.${band}`);
                const dLa    = find(e.id, `la_funded_rate_p.${band}`);
                const rate = numOf(dRate), hours = numOf(dHours);
                const perHr = rate != null && hours > 0 ? rate / hours / 100 : null;
                return (
                  <tr key={band} style={{ borderBottom: `1px dotted ${colors.borderSoft}` }}>
                    <td style={pipeTd}>{AGE_BAND_LABELS[band]}</td>
                    <td style={{ ...pipeTd, textAlign: 'right' }}><OverrideCell driver={dRate} {...cellProps} /></td>
                    <td style={{ ...pipeTd, textAlign: 'right' }}><OverrideCell driver={dHours} {...cellProps} /></td>
                    <td style={{ ...pipeTd, textAlign: 'right' }}><OverrideCell driver={dElig} suffix="%" {...cellProps} /></td>
                    <td style={{ ...pipeTd, textAlign: 'right' }}><OverrideCell driver={dTake} suffix="%" {...cellProps} /></td>
                    <td style={{ ...pipeTd, textAlign: 'right' }}><OverrideCell driver={dFOnly} suffix="%" {...cellProps} /></td>
                    <td style={{ ...pipeTd, textAlign: 'right' }}><OverrideCell driver={dLa} {...cellProps} /></td>
                    <td style={{ ...pipeTd, paddingLeft: 18, fontSize: 11, color: colors.muted, whiteSpace: 'nowrap' }}>
                      {perHr == null ? '—' : `£${perHr.toFixed(2)}/hr`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ))}

      {groupDrivers.length > 0 && (
        <div style={pipeCard}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: colors.ink }}>Billing & calendar</span>
            <Pill>group — all locations</Pill>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(260px, max-content) auto', gap: '6px 14px', alignItems: 'center' }}>
            {groupDrivers.map(d => (
              <React.Fragment key={d.id}>
                <span style={{ fontSize: 12, color: colors.ink }}>{d.label}</span>
                <OverrideCell driver={d} suffix="wks" {...cellProps} />
              </React.Fragment>
            ))}
          </div>
        </div>
      )}

      {others.length > 0 && (
        <OtherDriversTable
          drivers={others} entities={entities} declaredKeys={declaredKeys}
          onRenameDriver={onRenameDriver} onDeleteDriver={onDeleteDriver}
          {...cellProps}
        />
      )}
    </div>
  );
}

function LocationRampCard({ entity, find, numOf, groupCurveFor, valueOf, toDisplay, onChangeValue, compact }) {
  const cfg = entity.config || {};
  const acq = cfg.acquisition_type;
  const isAcquired = ACQUIRED_TYPES.has(acq);
  const acqLabel = acq === 'acquired_going_concern' ? 'Acquired — going concern'
    : acq === 'acquired_empty' ? 'Acquired — empty premises'
    : 'Greenfield';

  const dStart  = find(entity.id, 'ramp.starting_occupancy_pct');
  const dTarget = find(entity.id, 'ramp.target_occupancy_pct');
  const dMonths = find(entity.id, 'ramp.months_to_target');
  const siteOverride = { start: numOf(dStart), target: numOf(dTarget), months: numOf(dMonths) };

  // What a blank site-override cell falls back to: the location default
  // from entity config (acquired sites), or the per-band defaults below
  // (greenfield — no single site-level number, so no placeholder).
  const sitePh = isAcquired ? {
    start:  cfg.starting_occupancy_pct ?? (acq === 'acquired_going_concern' ? 70 : 40),
    target: cfg.target_occupancy_pct ?? 85,
    months: cfg.ramp_to_target_months ?? 6,
  } : { start: null, target: null, months: null };

  const cellProps = { valueOf, toDisplay, onChangeValue, compact };
  const r1 = (v) => Math.round(v * 10) / 10;

  return (
    <div style={pipeCard}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 10 }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: colors.ink }}>{entity.label}</span>
        <Pill>{acqLabel}</Pill>
      </div>

      <div style={pipeSectionLabel}>Site-wide ramp override — this version</div>
      <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap', margin: '6px 0 14px' }}>
        <LabelledCell label="Opening occupancy" suffix="%" driver={dStart} placeholder={sitePh.start} {...cellProps} />
        <LabelledCell label="Target occupancy" suffix="%" driver={dTarget} placeholder={sitePh.target} {...cellProps} />
        <LabelledCell label="Months to target" driver={dMonths} placeholder={sitePh.months} {...cellProps} />
        <span style={{ fontSize: 11, color: colors.muted }}>
          {isAcquired ? 'Blank = location default (Edit location).' : 'Blank = per-band defaults.'}
        </span>
      </div>

      <div style={pipeSectionLabel}>Fine-tune by age band — this version</div>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: fontStack, marginTop: 6 }}>
        <thead>
          <tr>
            <th style={pipeTh}>Age band</th>
            <th style={{ ...pipeTh, textAlign: 'right' }}>Opening %</th>
            <th style={{ ...pipeTh, textAlign: 'right' }}>Target %</th>
            <th style={{ ...pipeTh, textAlign: 'right' }}>Months to target</th>
            <th style={{ ...pipeTh, paddingLeft: 18 }}>Effective curve</th>
          </tr>
        </thead>
        <tbody>
          {AGE_BANDS.map(band => {
            const dO = find(entity.id, `capacity.opening_pct.${band}`);
            const dT = find(entity.id, `capacity.target_pct.${band}`);
            const dP = find(entity.id, `capacity.phase_up_months.${band}`);
            const bandOverride = { opening: numOf(dO), target: numOf(dT), phase: numOf(dP) };
            const gc = groupCurveFor(band);
            const inherited = curveForBand(entity, band, gc, siteOverride, null);
            const effective = curveForBand(entity, band, gc, siteOverride, bandOverride);
            const overridden = bandOverride.opening != null || bandOverride.target != null || bandOverride.phase != null;
            return (
              <tr key={band} style={{ borderBottom: `1px dotted ${colors.borderSoft}` }}>
                <td style={pipeTd}>{AGE_BAND_LABELS[band]}</td>
                <td style={{ ...pipeTd, textAlign: 'right' }}><OverrideCell driver={dO} placeholder={r1(inherited.start)} {...cellProps} /></td>
                <td style={{ ...pipeTd, textAlign: 'right' }}><OverrideCell driver={dT} placeholder={r1(inherited.target)} {...cellProps} /></td>
                <td style={{ ...pipeTd, textAlign: 'right' }}><OverrideCell driver={dP} placeholder={r1(inherited.ramp)} {...cellProps} /></td>
                <td style={{ ...pipeTd, paddingLeft: 18, fontSize: 11, color: overridden ? colors.accent : colors.muted, whiteSpace: 'nowrap' }}>
                  {r1(effective.start)}% → {r1(effective.target)}% over {r1(effective.ramp)} mo{overridden ? ' · band override' : ''}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function GroupBandDefaultsCard({ find, valueOf, toDisplay, onChangeValue, compact }) {
  const cellProps = { valueOf, toDisplay, onChangeValue, compact };
  return (
    <div style={pipeCard}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 4 }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: colors.ink }}>Greenfield ramp defaults</span>
        <Pill>group — all locations</Pill>
      </div>
      <p style={{ fontSize: 11, color: colors.muted, margin: '0 0 8px' }}>
        Default per-band curve for greenfield sites. Acquired sites use their own location settings instead.
      </p>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: fontStack }}>
        <thead>
          <tr>
            <th style={pipeTh}>Age band</th>
            <th style={{ ...pipeTh, textAlign: 'right' }}>Opening %</th>
            <th style={{ ...pipeTh, textAlign: 'right' }}>Target %</th>
            <th style={{ ...pipeTh, textAlign: 'right' }}>Months to target</th>
          </tr>
        </thead>
        <tbody>
          {AGE_BANDS.map(band => (
            <tr key={band} style={{ borderBottom: `1px dotted ${colors.borderSoft}` }}>
              <td style={pipeTd}>{AGE_BAND_LABELS[band]}</td>
              <td style={{ ...pipeTd, textAlign: 'right' }}><OverrideCell driver={find(null, `capacity.opening_pct.${band}`)} {...cellProps} /></td>
              <td style={{ ...pipeTd, textAlign: 'right' }}><OverrideCell driver={find(null, `capacity.target_pct.${band}`)} {...cellProps} /></td>
              <td style={{ ...pipeTd, textAlign: 'right' }}><OverrideCell driver={find(null, `capacity.phase_up_months.${band}`)} {...cellProps} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CohortCard({ drivers, valueOf, toDisplay, onChangeValue, compact }) {
  const cellProps = { valueOf, toDisplay, onChangeValue, compact };
  return (
    <div style={pipeCard}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 4 }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: colors.ink }}>August cohort dynamics</span>
        <Pill>group — all locations</Pill>
      </div>
      <p style={{ fontSize: 11, color: colors.muted, margin: '0 0 8px' }}>
        Each August a share of 3-5s leaves for P1 (some staying on in after-school care) and P7
        after-schoolers move up to high school. The occupancy dip refills over the window below.
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(260px, max-content) auto', gap: '6px 14px', alignItems: 'center' }}>
        {drivers.map(d => (
          <React.Fragment key={d.id}>
            <span style={{ fontSize: 12, color: colors.ink }}>{d.label}</span>
            <OverrideCell driver={d} suffix={d.unit === 'pct' ? '%' : d.unit === 'count' ? 'mo' : null} {...cellProps} />
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}

function OtherDriversTable({ drivers, entities, declaredKeys, onRenameDriver, onDeleteDriver, valueOf, toDisplay, onChangeValue, compact }) {
  const cellProps = { valueOf, toDisplay, onChangeValue, compact };
  return (
    <div style={pipeCard}>
      <div style={{ ...pipeSectionLabel, marginBottom: 6 }}>Other drivers</div>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: fontStack }}>
        <tbody>
          {drivers.map(d => {
            const ent = entities.find(e => e.id === d.entity_id);
            return (
              <tr key={d.id} style={{ borderBottom: `1px dotted ${colors.borderSoft}` }}>
                <td style={pipeTd}><strong>{d.label}</strong></td>
                <td style={pipeTd}>{ent?.label || <span style={{ color: colors.muted }}>group</span>}</td>
                <td style={{ ...pipeTd, textAlign: 'right' }}>
                  {d.kind === 'scalar'
                    ? <OverrideCell driver={d} suffix={d.unit === 'pct' ? '%' : null} {...cellProps} />
                    : <span style={{ fontSize: 11, color: colors.muted }}>({d.kind})</span>}
                </td>
                <td style={{ ...pipeTd, textAlign: 'right', whiteSpace: 'nowrap' }}>
                  {!declaredKeys.has(d.driver_key) && (
                    <span style={{ display: 'inline-flex', gap: 2 }}>
                      <button onClick={() => onRenameDriver(d)} title="Rename custom driver" style={iconBtn}>✎</button>
                      <button onClick={() => onDeleteDriver(d)} title="Delete custom driver" style={{ ...iconBtn, color: colors.red }}>×</button>
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function LabelledCell({ label, driver, placeholder, suffix, valueOf, toDisplay, onChangeValue, compact }) {
  return (
    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
      <span style={{ color: colors.muted }}>{label}</span>
      <OverrideCell
        driver={driver} placeholder={placeholder} suffix={suffix}
        valueOf={valueOf} toDisplay={toDisplay} onChangeValue={onChangeValue} compact={compact}
      />
    </label>
  );
}

function OverrideCell({ driver, placeholder, suffix, valueOf, toDisplay, onChangeValue, compact }) {
  if (!driver) {
    return <span style={{ fontSize: 11, color: colors.muted }} title={'Driver row missing — click "Fill missing defaults" above'}>—</span>;
  }
  const ph = placeholder == null ? '' : String(placeholder);
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
      {driver.unit === 'gbp_p' && <span style={{ fontSize: 11, color: colors.muted }}>£</span>}
      <input
        defaultValue={toDisplay(valueOf(driver.id, -1), driver.unit)}
        placeholder={ph}
        title={ph !== '' ? `Blank = ${ph} (inherited)` : undefined}
        onBlur={(e) => onChangeValue(driver.id, -1, e.target.value, driver.unit)}
        style={{ ...inputStyle, width: compact ? 64 : 80, textAlign: 'right', padding: compact ? '3px 6px' : '5px 8px', fontSize: compact ? 11 : 12 }}
      />
      {suffix && <span style={{ fontSize: 11, color: colors.muted }}>{suffix}</span>}
    </span>
  );
}

const pipeCard = { border: `1px solid ${colors.border}`, borderRadius: 10, padding: '12px 14px', marginBottom: 12, background: '#fff' };
const pipeSectionLabel = { fontSize: 10, color: colors.muted, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5 };
const pipeTh = { padding: '4px 8px', textAlign: 'left', fontWeight: 600, color: colors.muted, borderBottom: `1px solid ${colors.border}`, fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.4, background: colors.bgSoft };
const pipeTd = { padding: '5px 8px', color: colors.ink, verticalAlign: 'middle', fontSize: 12 };

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
    // Blank = same as opening. Set it when the lease starts before you trade.
    occupancy_month_offset: cfg.occupancy_month_offset ?? tplCfg.occupancy_month_offset ?? '',
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
      const places = {
        babies: Number(form.cap_babies) || 0,
        twos: Number(form.cap_twos) || 0,
        three_to_five: Number(form.cap_three_to_five) || 0,
        after_school: Number(form.cap_after_school) || 0,
      };
      const config = {
        la_council_id: form.la_council_id,
        sq_ft: Number(form.sq_ft) || 0,
        // On the shared location record this is only the DEFAULT split. New
        // locations set it; edits leave it alone and write a per-version
        // override instead (below), so changing the rooms in one version can
        // no longer rewrite every other version.
        capacity_by_age_band: form.id
          ? (entity.config?.capacity_by_age_band || places)
          : places,
        opening_month_offset: Number(form.opening_month_offset) || 0,
        // Blank means "same as opening" — store nothing so premises.js falls
        // back rather than pinning it to a 0 that would backdate the rent.
        ...(String(form.occupancy_month_offset).trim() === ''
          ? {}
          : { occupancy_month_offset: Number(form.occupancy_month_offset) || 0 }),
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

      // Pin the room split to THIS version. Written explicitly (not left
      // blank to inherit) so a later change to another version's split can't
      // move this one.
      if (scenarioId && saved?.id) {
        await saveCapacityOverride({ scenario_id: scenarioId, entity_id: saved.id, places });
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
          <Field label="Takes occupancy (months from start — blank = same as opening)"><input type="number" placeholder="same as opening" value={form.occupancy_month_offset} onChange={setNum('occupancy_month_offset')} style={inputStyle} /></Field>
          <Field label="Ramp to target (months) — default for all versions"><input type="number" value={form.ramp_to_target_months} onChange={setNum('ramp_to_target_months')} style={inputStyle} /></Field>
          <Field label="Target occupancy %"><input type="number" value={form.target_occupancy_pct} onChange={setNum('target_occupancy_pct')} style={inputStyle} /></Field>
          <Field label="Launch occupancy % (day-1 marketing influx)"><input type="number" value={form.starting_occupancy_pct} onChange={setNum('starting_occupancy_pct')} style={inputStyle} /></Field>
        </div>

        <p style={{ fontSize: 11, color: colors.muted, margin: '10px 0 0' }}>
          Ramp / launch / target occupancy here are the location's <strong>defaults, shared by every version</strong>.
          To vary the ramp per version (e.g. a slower ramp in "Budget"), set the
          "Ramp override" drivers on the Inputs → Drivers → locations tab of that version.
        </p>
        <h3 style={{ fontFamily: serifStack, fontSize: 16, color: colors.ink, margin: '20px 0 4px' }}>Capacity by age band</h3>
        <p style={{ fontSize: 11, color: colors.muted, margin: '0 0 10px' }}>
          Registered places apply to <strong>this version only</strong> — other versions keep their
          own split. Everything else on this form (LA, sq ft, opening month, lease terms) is shared
          by every version of the forecast.
        </p>
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

function DriverFilters({ entities, unitOptions, filterEntity, setFilterEntity, filterUnit, setFilterUnit, filterSearch, setFilterSearch }) {
  const anyFilterActive = filterEntity !== 'all' || filterUnit !== 'all' || filterSearch;
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
      <input
        value={filterSearch}
        onChange={(e) => setFilterSearch(e.target.value)}
        placeholder="Search drivers…"
        style={{ ...inputStyle, width: 220, padding: '7px 10px', fontFamily: fontStack }}
      />
      {anyFilterActive && (
        <button
          onClick={() => { setFilterEntity('all'); setFilterUnit('all'); setFilterSearch(''); }}
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
