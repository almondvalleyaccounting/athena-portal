// Supabase queries for the forecast engine.

import { supabase } from '../../../lib/supabase';

export async function listForecasts() {
  const { data, error } = await supabase
    .from('fc_forecast')
    .select('*')
    .order('updated_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function createForecast({ name, client_name, group_client_name, client_entity_id, vertical_pack, horizon_months = 60, opening_period }) {
  const { data: forecast, error } = await supabase
    .from('fc_forecast')
    .insert({
      name, vertical_pack, horizon_months, opening_period,
      client_name: client_name || null,
      group_client_name: group_client_name || null,
      client_entity_id: client_entity_id || null,
    })
    .select().single();
  if (error) throw error;

  // Create the first version + base scenario in one go. Versions are
  // user-facing ("v1", "Budget", "Rolling Forecast", …) and renameable.
  const { data: version, error: vErr } = await supabase
    .from('fc_version')
    .insert({ forecast_id: forecast.id, name: 'v1', kind: 'working' })
    .select().single();
  if (vErr) throw vErr;

  const { data: scenario, error: sErr } = await supabase
    .from('fc_scenario')
    .insert({ version_id: version.id, name: 'Base', kind: 'base' })
    .select().single();
  if (sErr) throw sErr;

  return { forecast, version, scenario };
}

export async function getForecast(id) {
  const { data, error } = await supabase
    .from('fc_forecast').select('*').eq('id', id).single();
  if (error) throw error;
  return data;
}

export async function updateForecast(id, patch) {
  // Allowed editable fields. Horizon shrinking is permitted but stale
  // outputs/findings beyond the new horizon are cleaned up first.
  const next = {};
  if (patch.name !== undefined) next.name = patch.name;
  if (patch.client_name !== undefined) next.client_name = patch.client_name || null;
  if (patch.group_client_name !== undefined) next.group_client_name = patch.group_client_name || null;
  if (patch.client_entity_id !== undefined) next.client_entity_id = patch.client_entity_id || null;
  if (patch.horizon_months !== undefined) next.horizon_months = Number(patch.horizon_months);
  if (patch.opening_period !== undefined) next.opening_period = patch.opening_period;

  if (next.horizon_months != null) {
    // Drop outputs / findings beyond the new horizon (period >= horizon).
    // Get the version+scenario list for this forecast first.
    const { data: versions } = await supabase.from('fc_version').select('id').eq('forecast_id', id);
    const vids = (versions || []).map(v => v.id);
    if (vids.length > 0) {
      const { data: scenarios } = await supabase.from('fc_scenario').select('id').in('version_id', vids);
      const sids = (scenarios || []).map(s => s.id);
      if (sids.length > 0) {
        await supabase.from('fc_output').delete().in('scenario_id', sids).gte('period', next.horizon_months);
        await supabase.from('fc_finding').delete().in('scenario_id', sids).gte('period', next.horizon_months);
      }
    }
  }

  const { data, error } = await supabase
    .from('fc_forecast').update(next).eq('id', id).select().single();
  if (error) throw error;
  return data;
}

export async function listVersions(forecast_id) {
  const { data, error } = await supabase
    .from('fc_version').select('*')
    .eq('forecast_id', forecast_id)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function listScenarios(version_id) {
  const { data, error } = await supabase
    .from('fc_scenario').select('*')
    .eq('version_id', version_id)
    .order('kind').order('name');
  if (error) throw error;
  return data || [];
}

/**
 * Search the practice's client list (Athena `entities` table) by name —
 * used to link a forecast to a real client record.
 */
export async function searchClients(q) {
  const term = (q || '').trim();
  if (term.length < 2) return [];
  const { data, error } = await supabase
    .from('entities').select('id, name')
    .ilike('name', `%${term}%`)
    .order('name')
    .limit(15);
  if (error) throw error;
  return data || [];
}

export async function renameVersion(version_id, name) {
  const { data, error } = await supabase
    .from('fc_version').update({ name }).eq('id', version_id).select().single();
  if (error) throw error;
  return data;
}

/**
 * Delete a version and everything under it. fc_scenario cascades from
 * the version FK, and drivers/values/loans/outputs/findings cascade
 * from the scenario — so one delete removes the whole subtree. Versions
 * created FROM this one keep working: their parent link is detached
 * first (the self-FK doesn't cascade).
 */
export async function deleteVersion(version_id) {
  const { error: eDetach } = await supabase
    .from('fc_version').update({ parent_version_id: null }).eq('parent_version_id', version_id);
  if (eDetach) throw eDetach;
  const { error } = await supabase.from('fc_version').delete().eq('id', version_id);
  if (error) throw error;
}

/**
 * Create a new named version by duplicating an existing one — scenarios,
 * drivers, driver values and loans are copied; entities/groups are
 * forecast-level and shared across versions. Outputs are NOT copied:
 * recompute the new version after switching to it.
 */
export async function createVersionFrom({ forecast_id, source_version_id, name }) {
  const { data: newVersion, error: eV } = await supabase
    .from('fc_version')
    .insert({ forecast_id, name, kind: 'working', parent_version_id: source_version_id || null })
    .select().single();
  if (eV) throw eV;

  if (!source_version_id) return newVersion;

  // Scenarios
  const { data: srcScenarios, error: eS } = await supabase
    .from('fc_scenario').select('*').eq('version_id', source_version_id);
  if (eS) throw eS;
  const scenarioIdMap = new Map();
  for (const s of srcScenarios || []) {
    const { data: ns, error } = await supabase
      .from('fc_scenario')
      .insert({ version_id: newVersion.id, name: s.name, kind: s.kind, notes: s.notes })
      .select().single();
    if (error) throw error;
    scenarioIdMap.set(s.id, ns.id);
  }
  const oldScenarioIds = Array.from(scenarioIdMap.keys());
  if (oldScenarioIds.length === 0) return newVersion;

  // Drivers — entity ids are shared across versions, so they copy verbatim.
  const { data: srcDrivers, error: eD } = await supabase
    .from('fc_driver').select('*').in('scenario_id', oldScenarioIds);
  if (eD) throw eD;
  const driverIdMap = new Map();
  const CHUNK = 400;
  for (let i = 0; i < (srcDrivers || []).length; i += CHUNK) {
    const slice = srcDrivers.slice(i, i + CHUNK);
    const rows = slice.map(d => ({
      scenario_id: scenarioIdMap.get(d.scenario_id),
      entity_id: d.entity_id,
      module_key: d.module_key, driver_key: d.driver_key,
      label: d.label, unit: d.unit, kind: d.kind,
      expression: d.expression,
    }));
    const { data: ins, error } = await supabase.from('fc_driver').insert(rows).select();
    if (error) throw error;
    for (let k = 0; k < slice.length; k++) {
      if (ins[k]) driverIdMap.set(slice[k].id, ins[k].id);
    }
  }

  // Driver values
  const oldDriverIds = Array.from(driverIdMap.keys());
  const PAGE = 800;
  for (let i = 0; i < oldDriverIds.length; i += PAGE) {
    const slice = oldDriverIds.slice(i, i + PAGE);
    const { data: oldVals, error } = await supabase
      .from('fc_driver_value').select('driver_id, period, value').in('driver_id', slice);
    if (error) throw error;
    const insertVals = (oldVals || []).map(v => ({
      driver_id: driverIdMap.get(v.driver_id), period: v.period, value: v.value,
    })).filter(v => v.driver_id != null);
    for (let j = 0; j < insertVals.length; j += 500) {
      const { error: eIns } = await supabase.from('fc_driver_value').insert(insertVals.slice(j, j + 500));
      if (eIns) throw eIns;
    }
  }

  // Loans
  const { data: srcLoans, error: eL } = await supabase
    .from('fc_loan').select('*').in('scenario_id', oldScenarioIds);
  if (eL) throw eL;
  if ((srcLoans || []).length > 0) {
    const rows = srcLoans.map(l => {
      const { id, created_at, updated_at, ...rest } = l;
      return { ...rest, scenario_id: scenarioIdMap.get(l.scenario_id) };
    });
    const { error } = await supabase.from('fc_loan').insert(rows);
    if (error) throw error;
  }

  return newVersion;
}

export async function listEntities(forecast_id) {
  const { data, error } = await supabase
    .from('fc_entity').select('*')
    .eq('forecast_id', forecast_id)
    .order('sort_order').order('label');
  if (error) throw error;
  return data || [];
}

export async function upsertEntity(row) {
  const { data, error } = await supabase
    .from('fc_entity').upsert(row, { onConflict: 'forecast_id,key' })
    .select().single();
  if (error) throw error;
  return data;
}

/**
 * Load drivers and values for a scenario, with fallback to the base
 * scenario for any (entity_id, module_key, driver_key) not overridden.
 */
export async function loadDriversWithFallback(version_id, scenario_id, base_scenario_id) {
  const ids = scenario_id === base_scenario_id ? [base_scenario_id] : [scenario_id, base_scenario_id];
  const { data: drivers, error } = await supabase
    .from('fc_driver').select('*')
    .in('scenario_id', ids);
  if (error) throw error;

  // Override resolution: prefer scenario_id row over base_scenario_id row for the same triple
  const triple = (d) => `${d.entity_id || ''}::${d.module_key}::${d.driver_key}`;
  const map = new Map();
  for (const d of drivers || []) {
    const t = triple(d);
    const existing = map.get(t);
    if (!existing) map.set(t, d);
    else if (existing.scenario_id !== scenario_id && d.scenario_id === scenario_id) map.set(t, d);
  }
  const merged = Array.from(map.values());

  const driverIds = merged.map(d => d.id);
  let values = [];
  if (driverIds.length > 0) {
    const { data: vs, error: vErr } = await supabase
      .from('fc_driver_value').select('*').in('driver_id', driverIds);
    if (vErr) throw vErr;
    values = vs || [];
  }
  return { drivers: merged, values };
}

export async function upsertDriver(row) {
  const { data, error } = await supabase
    .from('fc_driver')
    .upsert(row, { onConflict: 'scenario_id,entity_id,module_key,driver_key' })
    .select().single();
  if (error) throw error;
  return data;
}

export async function setDriverValue(driver_id, period, value) {
  const { error } = await supabase
    .from('fc_driver_value')
    .upsert({ driver_id, period: period ?? -1, value }, { onConflict: 'driver_id,period' });
  if (error) throw error;
}

/**
 * Per-version registered places: { [entity_id]: { [band]: value } }.
 * Only rows with a value are returned, so a missing band means "use the
 * location default" (see lib/capacity.js).
 */
export async function loadCapacityOverrides(scenario_id) {
  if (!scenario_id) return {};
  const { data, error } = await supabase
    .from('fc_driver')
    .select('id, entity_id, driver_key, fc_driver_value(period, value)')
    .eq('scenario_id', scenario_id)
    .like('driver_key', 'capacity.places.%');
  if (error) throw error;
  const out = {};
  for (const d of data || []) {
    if (!d.entity_id) continue;
    const hit = (d.fc_driver_value || []).find(v => v.period === -1);
    if (hit == null || hit.value == null || hit.value === '') continue;
    const band = d.driver_key.slice('capacity.places.'.length);
    (out[d.entity_id] ||= {})[band] = Number(hit.value);
  }
  return out;
}

/**
 * Write the current version's registered-places override for one location.
 * `places` is { band: number }. Values are always written explicitly so the
 * version is pinned against later edits to the location default.
 */
export async function saveCapacityOverride({ scenario_id, entity_id, places }) {
  for (const [band, value] of Object.entries(places || {})) {
    const driver = await upsertDriver({
      scenario_id, entity_id,
      module_key: 'locations',
      driver_key: `capacity.places.${band}`,
      label: `Registered places — ${band} (blank = location default)`,
      unit: 'count', kind: 'scalar', expression: null,
    });
    await setDriverValue(driver.id, -1, Number(value) || 0);
  }
}

/**
 * Remove a driver's value row — returns a blank-by-default driver (e.g.
 * the ramp/capacity overrides) to "use the default" state.
 */
export async function clearDriverValue(driver_id, period = -1) {
  const { error } = await supabase
    .from('fc_driver_value')
    .delete().eq('driver_id', driver_id).eq('period', period);
  if (error) throw error;
}

/**
 * Delete a driver (and any associated values). Used for custom drivers
 * the user added via the +Add driver UI and now wants to remove.
 *
 * If the DB has ON DELETE CASCADE on fc_driver_value.driver_id, the
 * values disappear with the driver row. We delete values explicitly
 * first as a defensive measure in case the constraint isn't there.
 */
export async function deleteDriver(driver_id) {
  await supabase.from('fc_driver_value').delete().eq('driver_id', driver_id);
  const { error } = await supabase.from('fc_driver').delete().eq('id', driver_id);
  if (error) throw error;
}

/**
 * Update a driver's metadata (label / kind / unit). Doesn't touch values.
 */
export async function updateDriver(driver_id, patch) {
  const allowed = {};
  if (patch.label !== undefined) allowed.label = patch.label;
  if (patch.unit !== undefined)  allowed.unit  = patch.unit;
  if (patch.kind !== undefined)  allowed.kind  = patch.kind;
  const { data, error } = await supabase
    .from('fc_driver').update(allowed).eq('id', driver_id).select().single();
  if (error) throw error;
  return data;
}

/** Replace materialised outputs for a scenario. */
export async function persistOutputs(scenario_id, outputs) {
  // INSERT-then-clean, stamped with a run id — deliberately NOT
  // delete-then-insert.
  //
  // Deleting first is unsafe without a transaction: two overlapping
  // recomputes interleave as delete / delete / insert / insert and leave two
  // complete sets of outputs, silently doubling every figure in the model.
  // That happened once in anger (sql/169). Inserting first and then removing
  // rows carrying any other run id means concurrent runs resolve to whichever
  // cleans up last — one complete set either way, and no window where the
  // scenario has no outputs.
  const run_id = (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`);

  if (outputs.length > 0) {
    const rows = outputs.map(o => ({
      scenario_id,
      entity_id: o.entity_id || null,
      period: o.period,
      module_key: o.module_key,
      nominal_type: o.nominal_type,
      line_label: o.line_label,
      amount_p: o.amount_p,
      tags: o.tags || null,
      run_id,
    }));

    // Chunk to avoid hitting row-size limits on big forecasts
    const CHUNK = 500;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const { error } = await supabase.from('fc_output').insert(rows.slice(i, i + CHUNK));
      if (error) throw error;
    }
  }

  // Drop the previous run (and anything from a concurrent one).
  const { error: delErr } = await supabase
    .from('fc_output').delete()
    .eq('scenario_id', scenario_id)
    .or(`run_id.is.null,run_id.neq.${run_id}`);
  if (delErr) throw delErr;
}

export async function persistFindings(scenario_id, findings) {
  const { error: delErr } = await supabase
    .from('fc_finding').delete().eq('scenario_id', scenario_id);
  if (delErr) throw delErr;
  if (findings.length === 0) return;
  const rows = findings.map(f => ({
    scenario_id,
    entity_id: f.entity_id || null,
    period: f.period ?? null,
    severity: f.severity,
    code: f.code,
    message: f.message,
  }));
  const { error } = await supabase.from('fc_finding').insert(rows);
  if (error) throw error;
}

export async function loadOutputs(scenario_id) {
  // Supabase JS defaults to a 1000-row response cap. Forecast output
  // tables routinely exceed this (e.g. 84mo × 10 modules ≈ 5k rows),
  // so paginate via .range() until exhausted.
  const PAGE = 1000;
  const all = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from('fc_output').select('*').eq('scenario_id', scenario_id)
      .order('period').order('nominal_type')
      .range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

export async function loadFindings(scenario_id) {
  const { data, error } = await supabase
    .from('fc_finding').select('*').eq('scenario_id', scenario_id)
    .order('severity');
  if (error) throw error;
  return data || [];
}

export async function listLaCouncils() {
  const { data, error } = await supabase
    .from('fc_la_council').select('*').order('name');
  if (error) throw error;
  return data || [];
}

/**
 * Load LA reference data (NDR, top-up, funded rates) for a given year.
 * Returns one row per council with embedded rate breakdown.
 */
export async function listLaReference(period_year = 2026) {
  const [councilRes, ndrRes, topupRes, rateRes] = await Promise.all([
    supabase.from('fc_la_council').select('*').order('name'),
    supabase.from('fc_la_ndr').select('*').eq('period_year', period_year),
    supabase.from('fc_la_topup').select('*'),
    supabase.from('fc_la_funded_rate').select('*').eq('period_year', period_year),
  ]);
  if (councilRes.error) throw councilRes.error;
  if (ndrRes.error) throw ndrRes.error;
  if (topupRes.error) throw topupRes.error;
  if (rateRes.error) throw rateRes.error;
  const ndrByLa = Object.fromEntries((ndrRes.data || []).map(r => [r.la_council_id, r]));
  const topupByLa = Object.fromEntries((topupRes.data || []).map(r => [r.la_council_id, r]));
  const ratesByLa = {};
  for (const r of (rateRes.data || [])) {
    (ratesByLa[r.la_council_id] ||= {})[r.age_band] = r;
  }
  return (councilRes.data || []).map(c => ({
    council: c,
    ndr: ndrByLa[c.id] || null,
    topup: topupByLa[c.id] || null,
    rates: ratesByLa[c.id] || {},
  }));
}

export async function upsertLaNdr({ la_council_id, period_year, poundage, small_business_relief_pct }) {
  const { error } = await supabase.from('fc_la_ndr')
    .upsert({ la_council_id, period_year, poundage, small_business_relief_pct }, { onConflict: 'la_council_id,period_year' });
  if (error) throw error;
}

export async function upsertLaTopup({ la_council_id, topup_allowed, notes }) {
  const { error } = await supabase.from('fc_la_topup')
    .upsert({ la_council_id, topup_allowed, notes: notes ?? null }, { onConflict: 'la_council_id' });
  if (error) throw error;
}

export async function upsertLaFundedRate({ la_council_id, period_year, age_band, hourly_rate_p }) {
  const { error } = await supabase.from('fc_la_funded_rate')
    .upsert({ la_council_id, period_year, age_band, hourly_rate_p },
      { onConflict: 'la_council_id,period_year,age_band' });
  if (error) throw error;
}

/**
 * Drivers + values for a particular (scenario, module, entity) context.
 * If `entity_id` is given, returns BOTH that entity's drivers AND any
 * group-scope drivers (entity_id IS NULL) for the same module — because
 * the compute fn typically reads both.
 */
export async function loadDriversForContext({ scenario_id, module_key, entity_id }) {
  // Always include the locations module's drivers alongside: the
  // occupancy ramp (capacity.opening_pct.* etc.) lives there and the
  // services / staff explainers need it to reproduce the curve.
  const moduleKeys = module_key === 'locations' ? ['locations'] : [module_key, 'locations'];
  let q = supabase.from('fc_driver').select('*')
    .eq('scenario_id', scenario_id).in('module_key', moduleKeys);
  if (entity_id) {
    // Either match this entity OR group-scope (NULL).
    q = q.or(`entity_id.eq.${entity_id},entity_id.is.null`);
  } else {
    q = q.is('entity_id', null);
  }
  const { data: drivers, error } = await q.order('driver_key');
  if (error) throw error;
  const ids = (drivers || []).map(d => d.id);
  let values = [];
  if (ids.length > 0) {
    const { data, error: vErr } = await supabase
      .from('fc_driver_value').select('*').in('driver_id', ids);
    if (vErr) throw vErr;
    values = data || [];
  }
  return { drivers: drivers || [], values };
}

// ── Loans ───────────────────────────────────────────────────────

export async function listLoans(scenario_id) {
  const { data, error } = await supabase
    .from('fc_loan').select('*').eq('scenario_id', scenario_id)
    .order('sort_order').order('created_at');
  if (error) throw error;
  return data || [];
}

export async function upsertLoan(row) {
  const op = row.id
    ? supabase.from('fc_loan').update(row).eq('id', row.id).select().single()
    : supabase.from('fc_loan').insert(row).select().single();
  const { data, error } = await op;
  if (error) throw error;
  return data;
}

export async function deleteLoan(id) {
  const { error } = await supabase.from('fc_loan').delete().eq('id', id);
  if (error) throw error;
}

// ── Groups (using the generic dimension/dimension_value system) ─────

const GROUP_DIM_KEY = 'group';

/**
 * Ensure the "Group" dimension exists for this forecast and return it.
 * Idempotent — creates only if missing.
 */
export async function ensureGroupDimension(forecast_id) {
  const { data: existing } = await supabase
    .from('fc_dimension').select('*')
    .eq('forecast_id', forecast_id).eq('key', GROUP_DIM_KEY).maybeSingle();
  if (existing) return existing;
  const { data, error } = await supabase
    .from('fc_dimension')
    .insert({ forecast_id, key: GROUP_DIM_KEY, label: 'Group' })
    .select().single();
  if (error) throw error;
  return data;
}

export async function listGroups(forecast_id) {
  const dim = await ensureGroupDimension(forecast_id);
  const { data, error } = await supabase
    .from('fc_dimension_value').select('*').eq('dimension_id', dim.id).order('label');
  if (error) throw error;
  return { dimension: dim, groups: data || [] };
}

export async function createGroup(forecast_id, label) {
  const dim = await ensureGroupDimension(forecast_id);
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  const { data, error } = await supabase
    .from('fc_dimension_value')
    .insert({ dimension_id: dim.id, key: slug || 'group_' + Date.now().toString(36).slice(-4), label })
    .select().single();
  if (error) throw error;
  return data;
}

export async function deleteGroup(group_id) {
  const { error } = await supabase.from('fc_dimension_value').delete().eq('id', group_id);
  if (error) throw error;
}

export async function listEntityGroupAssignments(forecast_id) {
  // Returns rows: { entity_id, dimension_value_id }
  const { data, error } = await supabase
    .from('fc_entity_tag')
    .select('entity_id, dimension_value_id, fc_dimension_value!inner(dimension_id, fc_dimension!inner(forecast_id, key))')
    .eq('fc_dimension_value.fc_dimension.forecast_id', forecast_id)
    .eq('fc_dimension_value.fc_dimension.key', GROUP_DIM_KEY);
  if (error) throw error;
  return (data || []).map(r => ({ entity_id: r.entity_id, dimension_value_id: r.dimension_value_id }));
}

export async function assignEntityToGroup(entity_id, group_value_id) {
  // Remove any existing group tag for this entity (one group per entity), then insert.
  // Find all dimension_value_ids in the "group" dimension for THIS entity's forecast.
  const { data: ent, error: e1 } = await supabase
    .from('fc_entity').select('forecast_id').eq('id', entity_id).single();
  if (e1) throw e1;
  const dim = await ensureGroupDimension(ent.forecast_id);
  const { data: vals, error: e2 } = await supabase
    .from('fc_dimension_value').select('id').eq('dimension_id', dim.id);
  if (e2) throw e2;
  const ids = (vals || []).map(v => v.id);
  if (ids.length > 0) {
    await supabase.from('fc_entity_tag')
      .delete().eq('entity_id', entity_id).in('dimension_value_id', ids);
  }
  if (group_value_id) {
    const { error } = await supabase.from('fc_entity_tag')
      .insert({ entity_id, dimension_value_id: group_value_id });
    if (error) throw error;
  }
}

export async function deleteEntity(id) {
  const { error } = await supabase.from('fc_entity').delete().eq('id', id);
  if (error) throw error;
}

/**
 * Duplicate a location (entity) and all its entity-scoped driver values.
 * The new location gets a fresh key + label suffix, and any group-tag
 * assignments are NOT carried over (cleaner default — caller can re-tag).
 *
 * Returns the new entity row.
 */
export async function copyEntity(source_entity_id, { label_suffix = ' (copy)' } = {}) {
  // 1. Load source entity
  const { data: src, error: e1 } = await supabase
    .from('fc_entity').select('*').eq('id', source_entity_id).single();
  if (e1) throw e1;

  // 2. New unique key — append a short suffix; collision-safe under the
  //    forecast_id+key unique constraint via `_<random>`.
  const newKey = `${src.key}_copy_${Date.now().toString(36).slice(-4)}`;
  const newLabel = `${src.label}${label_suffix}`;

  const { data: newEnt, error: e2 } = await supabase
    .from('fc_entity').insert({
      forecast_id: src.forecast_id,
      key: newKey,
      label: newLabel,
      type: src.type,
      config: src.config,
      sort_order: src.sort_order,
    }).select().single();
  if (e2) throw e2;

  // 3. Pull every entity-scoped driver pointing at the source entity
  //    across ALL scenarios in this forecast. Duplicate each one for
  //    the new entity, keeping the same scenario_id / module_key /
  //    driver_key / unit / kind / label / expression.
  const { data: srcDrivers, error: e3 } = await supabase
    .from('fc_driver').select('*').eq('entity_id', source_entity_id);
  if (e3) throw e3;

  if ((srcDrivers || []).length > 0) {
    const insertRows = srcDrivers.map(d => ({
      scenario_id: d.scenario_id,
      entity_id: newEnt.id,
      module_key: d.module_key,
      driver_key: d.driver_key,
      label: d.label,
      unit: d.unit,
      kind: d.kind,
      expression: d.expression,
    }));
    const { data: newDrivers, error: e4 } = await supabase
      .from('fc_driver').insert(insertRows).select();
    if (e4) throw e4;

    // 4. Map old driver id → new driver id by (scenario_id, module_key, driver_key)
    const newByTriple = new Map();
    for (const d of newDrivers || []) {
      newByTriple.set(`${d.scenario_id}::${d.module_key}::${d.driver_key}`, d.id);
    }
    const idMap = new Map();
    for (const d of srcDrivers) {
      const k = `${d.scenario_id}::${d.module_key}::${d.driver_key}`;
      const newId = newByTriple.get(k);
      if (newId) idMap.set(d.id, newId);
    }

    // 5. Copy values — paginate to avoid the 1000-row IN limit
    const oldIds = Array.from(idMap.keys());
    const PAGE = 800;
    for (let i = 0; i < oldIds.length; i += PAGE) {
      const slice = oldIds.slice(i, i + PAGE);
      const { data: oldVals, error: e5 } = await supabase
        .from('fc_driver_value').select('driver_id, period, value').in('driver_id', slice);
      if (e5) throw e5;
      if ((oldVals || []).length === 0) continue;
      const insertVals = oldVals.map(v => ({
        driver_id: idMap.get(v.driver_id),
        period: v.period, value: v.value,
      })).filter(v => v.driver_id);
      if (insertVals.length === 0) continue;
      const { error: e6 } = await supabase.from('fc_driver_value').insert(insertVals);
      if (e6) throw e6;
    }
  }

  return newEnt;
}

/**
 * Duplicate an entire forecast — versions, scenarios, entities, drivers,
 * driver values, loans, group dimensions/values/tags. Outputs and findings
 * are NOT copied (caller should Recompute to regenerate). The new forecast
 * gets a name suffix so it sits next to the original in the picker.
 *
 * Returns the new forecast row.
 */
export async function copyForecast(source_forecast_id, { name_suffix = ' (copy)' } = {}) {
  // 1. Source forecast
  const { data: srcForecast, error: e1 } = await supabase
    .from('fc_forecast').select('*').eq('id', source_forecast_id).single();
  if (e1) throw e1;

  const { data: newForecast, error: e2 } = await supabase
    .from('fc_forecast').insert({
      name: `${srcForecast.name}${name_suffix}`,
      client_name: srcForecast.client_name,
      group_client_name: srcForecast.group_client_name,
      client_entity_id: srcForecast.client_entity_id,
      vertical_pack: srcForecast.vertical_pack,
      horizon_months: srcForecast.horizon_months,
      opening_period: srcForecast.opening_period,
    }).select().single();
  if (e2) throw e2;

  try {
    // 2. Versions
    const { data: srcVersions, error: e3 } = await supabase
      .from('fc_version').select('*').eq('forecast_id', source_forecast_id);
    if (e3) throw e3;
    const versionIdMap = new Map();
    for (const v of srcVersions || []) {
      const { data: nv, error: ev } = await supabase
        .from('fc_version').insert({
          forecast_id: newForecast.id,
          name: v.name, kind: v.kind,
        }).select().single();
      if (ev) throw ev;
      versionIdMap.set(v.id, nv.id);
    }

    // 3. Scenarios
    const oldVersionIds = Array.from(versionIdMap.keys());
    const scenarioIdMap = new Map();
    if (oldVersionIds.length > 0) {
      const { data: srcScenarios, error: e4 } = await supabase
        .from('fc_scenario').select('*').in('version_id', oldVersionIds);
      if (e4) throw e4;
      for (const s of srcScenarios || []) {
        const { data: ns, error: es } = await supabase
          .from('fc_scenario').insert({
            version_id: versionIdMap.get(s.version_id),
            name: s.name, kind: s.kind,
          }).select().single();
        if (es) throw es;
        scenarioIdMap.set(s.id, ns.id);
      }
    }

    // 4. Entities
    const { data: srcEntities, error: e5 } = await supabase
      .from('fc_entity').select('*').eq('forecast_id', source_forecast_id);
    if (e5) throw e5;
    const entityIdMap = new Map();
    for (const e of srcEntities || []) {
      // Same label / key — these are unique within the new forecast scope
      const { data: ne, error: ee } = await supabase
        .from('fc_entity').insert({
          forecast_id: newForecast.id,
          key: e.key, label: e.label, type: e.type,
          config: e.config, sort_order: e.sort_order,
        }).select().single();
      if (ee) throw ee;
      entityIdMap.set(e.id, ne.id);
    }

    // 5. Drivers — load all under the source's scenarios, remap.
    const oldScenarioIds = Array.from(scenarioIdMap.keys());
    const driverIdMap = new Map();
    if (oldScenarioIds.length > 0) {
      const { data: srcDrivers, error: e6 } = await supabase
        .from('fc_driver').select('*').in('scenario_id', oldScenarioIds);
      if (e6) throw e6;
      if ((srcDrivers || []).length > 0) {
        // Insert in chunks
        const CHUNK = 400;
        for (let i = 0; i < srcDrivers.length; i += CHUNK) {
          const slice = srcDrivers.slice(i, i + CHUNK);
          const rows = slice.map(d => ({
            scenario_id: scenarioIdMap.get(d.scenario_id),
            entity_id: d.entity_id ? entityIdMap.get(d.entity_id) : null,
            module_key: d.module_key, driver_key: d.driver_key,
            label: d.label, unit: d.unit, kind: d.kind,
            expression: d.expression,
          }));
          const { data: ins, error: e7 } = await supabase
            .from('fc_driver').insert(rows).select();
          if (e7) throw e7;
          // Map old → new by (new_scenario_id, entity_id, module_key, driver_key)
          // We rely on insert order matching: ins[k] corresponds to slice[k]
          for (let k = 0; k < slice.length; k++) {
            if (ins[k]) driverIdMap.set(slice[k].id, ins[k].id);
          }
        }
      }
    }

    // 6. Driver values — paginate IN()
    const oldDriverIds = Array.from(driverIdMap.keys());
    const PAGE = 800;
    for (let i = 0; i < oldDriverIds.length; i += PAGE) {
      const slice = oldDriverIds.slice(i, i + PAGE);
      const { data: oldVals, error: e8 } = await supabase
        .from('fc_driver_value').select('driver_id, period, value').in('driver_id', slice);
      if (e8) throw e8;
      if ((oldVals || []).length === 0) continue;
      const insertVals = oldVals.map(v => ({
        driver_id: driverIdMap.get(v.driver_id),
        period: v.period, value: v.value,
      })).filter(v => v.driver_id != null);
      if (insertVals.length === 0) continue;
      const VALCHUNK = 500;
      for (let j = 0; j < insertVals.length; j += VALCHUNK) {
        const { error: e9 } = await supabase.from('fc_driver_value').insert(insertVals.slice(j, j + VALCHUNK));
        if (e9) throw e9;
      }
    }

    // 7. Loans
    if (oldScenarioIds.length > 0) {
      const { data: srcLoans, error: e10 } = await supabase
        .from('fc_loan').select('*').in('scenario_id', oldScenarioIds);
      if (e10) throw e10;
      if ((srcLoans || []).length > 0) {
        const rows = srcLoans.map(l => {
          const { id, created_at, updated_at, ...rest } = l;
          return { ...rest, scenario_id: scenarioIdMap.get(l.scenario_id) };
        });
        const { error: e11 } = await supabase.from('fc_loan').insert(rows);
        if (e11) throw e11;
      }
    }

    // 8. Group dimensions / values / entity tags. Source forecast's "Group"
    //    dimension(s) are duplicated, then each dimension_value is copied,
    //    then entity_tag rows are recreated using the mapped entity/value ids.
    const { data: srcDims, error: e12 } = await supabase
      .from('fc_dimension').select('*').eq('forecast_id', source_forecast_id);
    if (e12) throw e12;
    const dimIdMap = new Map();
    const dimValueIdMap = new Map();
    for (const d of srcDims || []) {
      const { data: nd, error: ed } = await supabase
        .from('fc_dimension').insert({
          forecast_id: newForecast.id,
          key: d.key, label: d.label,
        }).select().single();
      if (ed) throw ed;
      dimIdMap.set(d.id, nd.id);

      const { data: srcDvs, error: e13 } = await supabase
        .from('fc_dimension_value').select('*').eq('dimension_id', d.id);
      if (e13) throw e13;
      for (const dv of srcDvs || []) {
        const { data: ndv, error: edv } = await supabase
          .from('fc_dimension_value').insert({
            dimension_id: nd.id,
            key: dv.key, label: dv.label,
          }).select().single();
        if (edv) throw edv;
        dimValueIdMap.set(dv.id, ndv.id);
      }
    }
    if (dimValueIdMap.size > 0) {
      const oldDvIds = Array.from(dimValueIdMap.keys());
      const { data: srcTags, error: e14 } = await supabase
        .from('fc_entity_tag').select('*').in('dimension_value_id', oldDvIds);
      if (e14) throw e14;
      const tagRows = (srcTags || [])
        .map(t => ({
          entity_id: entityIdMap.get(t.entity_id),
          dimension_value_id: dimValueIdMap.get(t.dimension_value_id),
        }))
        .filter(t => t.entity_id && t.dimension_value_id);
      if (tagRows.length > 0) {
        const { error: e15 } = await supabase.from('fc_entity_tag').insert(tagRows);
        if (e15) throw e15;
      }
    }

    return newForecast;
  } catch (err) {
    // Best-effort rollback: delete the new forecast (cascade should clean
    // up child rows under the standard FK constraints).
    try { await supabase.from('fc_forecast').delete().eq('id', newForecast.id); } catch { /* ignore */ }
    throw err;
  }
}

// ── Nursery / pack defaults (localStorage) ─────────────────────
//
// Lets the user pin "what we typically use" as the seed values for
// future scenarios + new locations. Stored client-side keyed by
// vertical_pack so each industry pack has its own template.
//
// Shape:
//   {
//     drivers: { [module_key]: { [driver_key]: scalar_value } },
//     entity_config: { ...partial entity.config used as new-location defaults }
//   }

const NURSERY_DEFAULTS_KEY = (pack) => `forecast_nursery_defaults__${pack || 'default'}`;

export function loadNurseryDefaults(vertical_pack) {
  try {
    const raw = localStorage.getItem(NURSERY_DEFAULTS_KEY(vertical_pack));
    if (!raw) return null;
    return JSON.parse(raw);
  } catch { return null; }
}

export function clearNurseryDefaults(vertical_pack) {
  try { localStorage.removeItem(NURSERY_DEFAULTS_KEY(vertical_pack)); } catch { /* noop */ }
}

/**
 * Capture the current scenario's group-scope driver values + the first
 * entity's config (as a template for new locations) and persist as the
 * nursery defaults for this vertical pack.
 */
export async function saveNurseryDefaults({ scenario_id, vertical_pack, sample_entity_id = null }) {
  const { drivers, values } = await loadScenarioDrivers(scenario_id);
  const valueByDriverId = new Map();
  for (const v of values) {
    if (v.period === -1) valueByDriverId.set(v.driver_id, v.value);
  }

  // Capture group-scope drivers (entity_id IS NULL) keyed by module + driver_key.
  // Entity-scoped drivers are also captured if a sample_entity_id is given,
  // since some "per nursery" assumptions live there (eg pre-opening, fa.* per-site).
  const driversOut = {};
  for (const d of drivers) {
    const isGroup = !d.entity_id;
    const isSample = sample_entity_id && d.entity_id === sample_entity_id;
    if (!isGroup && !isSample) continue;
    if (!valueByDriverId.has(d.id)) continue;
    driversOut[d.module_key] ||= {};
    // Entity-sample values overwrite group only if both exist (rare)
    driversOut[d.module_key][d.driver_key] = valueByDriverId.get(d.id);
  }

  // Capture entity_config from the sample entity if available
  let entity_config = null;
  if (sample_entity_id) {
    const { data: e } = await supabase.from('fc_entity').select('config').eq('id', sample_entity_id).single();
    entity_config = e?.config || null;
  }

  const blob = { drivers: driversOut, entity_config, saved_at: new Date().toISOString() };
  localStorage.setItem(NURSERY_DEFAULTS_KEY(vertical_pack), JSON.stringify(blob));
  return blob;
}

/**
 * Seed pack defaults — fill in MISSING drivers and missing values.
 *
 * Behaviour:
 *   - Driver rows: upserted (idempotent via unique key).
 *   - Driver values: ONLY set if no value row exists yet for that
 *     (driver, period) pair. Existing user-entered values are preserved.
 *
 * For destructive reset to defaults, callers should pass `{ overwrite: true }`.
 *
 * Returns counts of {created drivers, valued, skipped (already had values)}.
 */
export async function seedPackDefaults({ scenario_id, modules, entities, overwrite = false, vertical_pack = null }) {
  // Pull saved nursery defaults if available; these override the
  // hardcoded `defaultValue` from the module declarations.
  const nurseryDefaults = vertical_pack ? loadNurseryDefaults(vertical_pack) : null;
  let created = 0, valued = 0, skipped = 0;

  // Pre-fetch all existing driver_value rows for this scenario so we can
  // check existence without a per-driver round-trip.
  const { data: existingDrivers, error: dErr } = await supabase
    .from('fc_driver').select('id').eq('scenario_id', scenario_id);
  if (dErr) throw dErr;
  const existingIds = (existingDrivers || []).map(d => d.id);

  let existingValueKeys = new Set();
  if (existingIds.length > 0) {
    const PAGE = 1000;
    for (let i = 0; i < existingIds.length; i += PAGE) {
      const slice = existingIds.slice(i, i + PAGE);
      const { data, error } = await supabase
        .from('fc_driver_value').select('driver_id, period').in('driver_id', slice);
      if (error) throw error;
      for (const v of data || []) existingValueKeys.add(`${v.driver_id}::${v.period}`);
    }
  }

  // GROUP-scope capacity.* rows are greenfield defaults only — skip
  // them for forecasts with no greenfield locations. The ENTITY-scoped
  // capacity.* rows are per-band overrides that apply to ANY site type
  // (e.g. 3-5 filling faster than 0-2 on an acquired site), so those
  // always seed (blank).
  const hasGreenfield = (entities || []).some(e =>
    (e.config?.acquisition_type ?? 'greenfield') === 'greenfield');

  for (const mod of modules) {
    for (const def of (mod.drivers || [])) {
      if (!hasGreenfield && def.key.startsWith('capacity.') && def.scope !== 'entity') continue;
      const targets = def.scope === 'entity'
        ? entities.map(e => ({ entity_id: e.id }))
        : [{ entity_id: null }];
      for (const tgt of targets) {
        const row = {
          scenario_id, entity_id: tgt.entity_id,
          module_key: mod.key, driver_key: def.key,
          label: def.label, unit: def.unit, kind: def.kind,
          expression: def.defaultExpression || null,
        };
        const driver = await upsertDriver(row);
        created += 1;

        // Resolve the effective default: nursery override > hardcoded.
        const nurseryVal = nurseryDefaults?.drivers?.[mod.key]?.[def.key];
        const effectiveDefault = nurseryVal != null ? nurseryVal : def.defaultValue;

        if (def.kind === 'scalar' && effectiveDefault != null) {
          const k = `${driver.id}::-1`;
          if (!overwrite && existingValueKeys.has(k)) { skipped += 1; continue; }
          await setDriverValue(driver.id, -1, effectiveDefault);
          existingValueKeys.add(k);
          valued += 1;
        } else if (def.kind === 'timeseries' && Array.isArray(def.defaultValue)) {
          for (let t = 0; t < def.defaultValue.length; t++) {
            const k = `${driver.id}::${t}`;
            if (!overwrite && existingValueKeys.has(k)) { skipped += 1; continue; }
            await setDriverValue(driver.id, t, def.defaultValue[t]);
            existingValueKeys.add(k);
            valued += 1;
          }
        }
      }
    }
  }
  return { created, valued, skipped };
}

/**
 * Load all drivers + values for a scenario into a single shape suitable
 * for the inputs UI. Doesn't merge with base — returns just this scenario's
 * direct rows so the UI can show overrides distinctly later.
 */
export async function loadScenarioDrivers(scenario_id) {
  const { data: drivers, error } = await supabase
    .from('fc_driver').select('*').eq('scenario_id', scenario_id);
  if (error) throw error;
  const ids = (drivers || []).map(d => d.id);
  let values = [];
  if (ids.length > 0) {
    const { data: vs, error: vErr } = await supabase
      .from('fc_driver_value').select('*').in('driver_id', ids);
    if (vErr) throw vErr;
    values = vs || [];
  }
  return { drivers: drivers || [], values };
}
